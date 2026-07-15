import { Events, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { db } from '../database.js';
import { WarningService } from '../services/warningService.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embeds.js';
import { logModerationAction } from '../utils/moderation.js';

// استخدام Set بدلاً من Map لتفادي استهلاك الذاكرة (Memory Leak)
const spamCooldown = new Set();

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            // 1. تجاهل البوتات والرسائل الخاصة
            if (message.author.bot || !message.guild) return;

            const content = message.content.trim();
            const guildId = message.guild.id;
            const userId = message.author.id;

            // ==========================================
            // 2. الأوامر الإدارية (ت، شيل، ملف)
            // ==========================================
            if (content.startsWith('ت ')) {
                return await handleWarnCommand(message, client);
            }

            if (content.startsWith('شيل ')) {
                return await handleUnwarnCommand(message, client);
            }

            // التطابق التام أو وجود مسافة لمنع تداخل الكلمات مثل "ملفات"
            if (content === 'ملف' || content.startsWith('ملف ')) {
                return await handleWarningsCommand(message, client);
            }

            // ==========================================
            // 3. أمر لوحة المتصدرين (t أو T)
            // ==========================================
            if (content.toLowerCase() === 't') {
                try {
                    const textQuery = await db.query('SELECT user_id, text_xp FROM users_xp WHERE guild_id = $1 ORDER BY text_xp DESC LIMIT 5', [guildId]);
                    const voiceQuery = await db.query('SELECT user_id, voice_xp FROM users_xp WHERE guild_id = $1 ORDER BY voice_xp DESC LIMIT 5', [guildId]);

                    const textLeaderboard = textQuery.rows.length === 0 
                        ? 'لا يوجد بيانات كافية' 
                        : textQuery.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> - ${Math.floor(row.text_xp)} XP`).join('\n');
                    
                    const voiceLeaderboard = voiceQuery.rows.length === 0 
                        ? 'لا يوجد بيانات كافية' 
                        : voiceQuery.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> - ${Math.floor(row.voice_xp)} XP`).join('\n');

                    const embed = new EmbedBuilder()
                        .setTitle('🏆 قائمة أفضل 5 أعضاء متفاعلين')
                        .setColor('#2b2d31')
                        .addFields(
                            { name: '✍️ الرسائل الكتابية', value: textLeaderboard, inline: true },
                            { name: '🎙️ التفاعل الصوتي', value: voiceLeaderboard, inline: true }
                        )
                        .setTimestamp();

                    return message.reply({ embeds: [embed] });
                } catch (error) {
                    logger.error("Database Error Leaderboard (T Command):", error);
                    return message.reply("❌ حدث خطأ أثناء جلب البيانات من قاعدة البيانات.");
                }
            }

            // ==========================================
            // 4. نظام نقاط الكتابة (Text XP)
            // ==========================================
            
            // الفلتر الأول: الحد الأدنى 3 كلمات
            const wordsCount = content.split(/\s+/).length;
            if (wordsCount < 3) return;

            // الفلتر الثاني: منع السبام (3 ثواني)
            if (spamCooldown.has(userId)) return; // العضو في فترة الانتظار، نتجاهل رسالته
            
            spamCooldown.add(userId);
            setTimeout(() => {
                spamCooldown.delete(userId); // إزالة الكول داون لتفريغ الذاكرة
            }, 3000);

            // الفلتر الثالث: تحديث قاعدة البيانات (استعلام ذكي بخطوة واحدة)
            try {
                await db.query(`
                    INSERT INTO users_xp (guild_id, user_id, valid_message_count, text_xp) 
                    VALUES ($1, $2, 1, 0) 
                    ON CONFLICT (guild_id, user_id) 
                    DO UPDATE SET 
                        valid_message_count = users_xp.valid_message_count + 1,
                        text_xp = CASE 
                            WHEN (users_xp.valid_message_count + 1) % 10 = 0 THEN users_xp.text_xp + 1 
                            ELSE users_xp.text_xp 
                        END;
                `, [guildId, userId]);
            } catch (error) {
                logger.error("Database Error Text XP System:", error);
            }

        } catch (error) {
            logger.error('Error in messageCreate event:', error);
        }
    }
};

// =========================================================================
// الدوال التنفيذية الخاصة بالأوامر الإدارية (معزولة بدقة لمنع التعارض)
// =========================================================================

async function handleWarnCommand(message, client) {
    try {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply({ embeds: [errorEmbed('صلاحيات ناقصة', 'لا تملك صلاحية تحذير الأعضاء.')] });
        }

        const args = message.content.trim().split(/\s+/);
        args.shift(); 

        const targetId = args[0]?.replace(/[<@!>]/g, '');
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => null);
        
        if (!targetUser) {
            return message.reply({ embeds: [errorEmbed('خطأ في الأمر', 'الرجاء منشن العضو أو كتابة الـ ID الخاص به.\nمثال: `ت @user سب وشتم`')] });
        }

        if (targetUser.bot || targetUser.id === message.author.id) {
            return message.reply({ embeds: [errorEmbed('خطأ', 'لا يمكنك تحذير البوتات أو تحذير نفسك.')] });
        }

        const reason = args.slice(1).join(' ') || 'لم يتم تحديد سبب.';
        const guildId = message.guild.id;

        const result = await WarningService.addWarning({
            guildId,
            userId: targetUser.id,
            moderatorId: message.author.id,
            reason,
            timestamp: Date.now()
        });

        if (!result || !result.success) {
            return message.reply({ embeds: [errorEmbed('خطأ', 'فشل حفظ التحذير في قاعدة البيانات.')] });
        }

        const totalWarns = result.totalCount;

        try {
            const dmEmbed = errorEmbed(`⚠️ تحذير جديد في سيرفر ${message.guild.name}`, `لقد تلقيت تحذيراً بسبب: **${reason}**\nإجمالي تحذيراتك الحالية: **${totalWarns}**`)
                .setFooter({ text: `المشرف المسؤول: ${message.author.username}` });
            await targetUser.send({ embeds: [dmEmbed] });
        } catch {
            logger.warn(`[Prefix Warn] Could not send DM to ${targetUser.id} (DMs closed).`);
        }

        await logModerationAction({
            client,
            guild: message.guild,
            event: {
                action: "User Warned (Quick)",
                target: `${targetUser.tag} (${targetUser.id})`,
                executor: `${message.author.tag} (${message.author.id})`,
                reason,
                metadata: { userId: targetUser.id, moderatorId: message.author.id, totalWarns, warningId: result.id }
            }
        });

        return message.reply({ embeds: [successEmbed('تم التحذير بنجاح', `تم إعطاء تحذير لـ **${targetUser.tag}**.\n**السبب:** ${reason}\n**إجمالي التحذيرات:** ${totalWarns}`)] });
    } catch (error) {
        logger.error('Error in handleWarnCommand:', error);
    }
}

async function handleUnwarnCommand(message, client) {
    try {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply({ embeds: [errorEmbed('صلاحيات ناقصة', 'لا تملك صلاحية إلغاء تحذيرات الأعضاء.')] });
        }

        const args = message.content.trim().split(/\s+/);
        args.shift(); 

        const targetId = args[0]?.replace(/[<@!>]/g, '');
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => null);

        if (!targetUser) {
            return message.reply({ embeds: [errorEmbed('خطأ في الأمر', 'الرجاء منشن العضو أو كتابة الـ ID الخاص به لإزالة تحذيره.\nمثال: `شيل @user`')] });
        }

        const guildId = message.guild.id;
        const result = await WarningService.removeLastActiveWarning({ guildId, userId: targetUser.id });

        if (!result.success) {
            return message.reply({ embeds: [errorEmbed('لم يتم الإجراء', 'العضو لا يملك أي تحذيرات نشطة ليتم حذفها.')] });
        }

        await message.reply({
            embeds: [successEmbed('تم إزالة التحذير', `تم إلغاء آخر تحذير عن العضو **${targetUser.tag}** بنجاح.\nالتحذيرات النشطة المتبقية: **${result.remainingCount}**`)]
        });

        await logModerationAction({
            client,
            guild: message.guild,
            event: {
                action: "Warning Removed (Quick)",
                target: `${targetUser.tag} (${targetUser.id})`,
                executor: `${message.author.tag} (${message.author.id})`,
                reason: "إزالة تحذير سريع بواسطة أمر الإدارة",
                metadata: { userId: targetUser.id, moderatorId: message.author.id, remainingWarns: result.remainingCount }
            }
        });

    } catch (error) {
        logger.error('Error in handleUnwarnCommand:', error);
    }
}

async function handleWarningsCommand(message, client) {
    try {
        const args = message.content.trim().split(/\s+/);
        args.shift(); 

        const targetId = args[0]?.replace(/[<@!>]/g, '') || message.author.id;
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => message.author);
        const guildId = message.guild.id;

        const warnings = await WarningService.getWarnings(guildId, targetUser.id);
        const totalWarns = warnings.length;

        const infoEmbedFile = infoEmbed(
            `🗂️ الملف الإداري لـ ${targetUser.username}`,
            `استعراض شامل لجميع العقوبات والتحذيرات المسجلة بملف العضو.`
        )
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .addFields(
            { name: '👤 الحساب', value: `${targetUser} (${targetUser.id})`, inline: false },
            { name: '⚠️ عدد التحذيرات النشطة', value: `**${totalWarns}** تحذير`, inline: true }
        )
        .setTimestamp();

        if (totalWarns > 0) {
            const lastWarnsText = warnings.slice(-5).map((w, index) => {
                const date = new Date(w.timestamp).toLocaleDateString('ar-EG');
                return `${index + 1}. **السبب:** ${w.reason} | **المشرف:** <@${w.moderatorId}> | تاريخ: \`${date}\``;
            }).join('\n');
            infoEmbedFile.addFields({ name: '📝 آخر التحذيرات النشطة', value: lastWarnsText, inline: false });
        } else {
            infoEmbedFile.addFields({ name: '📝 سجل نظيف', value: 'هذا العضو لا يملك أي تحذيرات نشطة حالياً في السيرفر.', inline: false });
        }

        return message.reply({ embeds: [infoEmbedFile] });

    } catch (error) {
        logger.error('Error in handleWarningsCommand:', error);
    }
}
