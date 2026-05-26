import { Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig } from '../services/leveling.js';
import { checkRateLimit } from '../utils/rateLimiter.js';

// استيراد التنسيقات واللوج والسيرفيس المحدث
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embeds.js';
import { logModerationAction } from '../utils/moderation.js';
import { WarningService } from '../services/warningService.js';
import { XpService } from '../services/xpSystem.js'; // السيرفيس المطور الذي يحتوي على الفلتر والليدربورد

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || !message.guild) return;

            // 1. فحص أمر لوحة الصدارة (t أو T) بشكل مستقل تماماً
            const msgContent = message.content.trim();
            if (msgContent === 't' || msgContent === 'T') {
                return await handleLeaderboardCommand(message, client);
            }

            // 2. فحص أمر التحذير (ت)
            if (message.content.startsWith('ت ')) {
                return await handleWarnCommand(message, client);
            }

            // 3. فحص أمر إلغاء التحذير (شيل)
            if (message.content.startsWith('شيل ')) {
                return await handleUnwarnCommand(message, client);
            }

            // 4. فحص أمر عرض ملف التحذيرات (ملف)
            if (message.content.trim().startsWith('ملف')) {
                return await handleWarningsCommand(message, client);
            }

            // 5. فحص أمر نقل التحذيرات (نقل)
            if (message.content.startsWith('نقل ')) {
                return await handleImportCommand(message, client);
            }

            // 6. معالجة نظام المستويات المطور (الرسائل المفيدة فقط)
            await handleUsefulLeveling(message, client);

        } catch (error) {
            logger.error('Error in messageCreate event:', error);
        }
    }
};

// ==========================================
// [الأمر t / T]: لوحة الصدارة (Leaderboard)
// ==========================================
async function handleLeaderboardCommand(message, client) {
    try {
        const guildId = message.guild.id;
        
        // جلب أعلى 5 في التكست والفويس من السيرفيس المطور
        const { topText, topVoice } = await XpService.getLeaderboard(guildId, client);

        const embed = infoEmbed(
            `🏆 لوحة الصدارة لسيرفر ${message.guild.name}`,
            `استعراض أعلى 5 أعضاء في التفاعل النصي والصوتي المعتمد على التفاعل الحقيقي.`
        ).setTimestamp();

        // بناء قائمة التكست (قراءة الـ totalXp الفعلي)
        let textLeaderboard = topText.length > 0 
            ? topText.map((user, index) => `**#${index + 1}** <@${user.userId}> ➜ \`${user.xp} XP\``).join('\n')
            : 'لا توجد بيانات تفاعل نصي بعد.';

        // بناء قائمة الفويس
        let voiceLeaderboard = topVoice.length > 0 
            ? topVoice.map((user, index) => `**#${index + 1}** <@${user.userId}> ➜ \`${user.xp} XP\``).join('\n')
            : 'لا توجد بيانات تفاعل صوتي بعد.';

        embed.addFields(
            { name: '💬 أعلى 5 في التكست (10 رسائل مفيدة = 1XP)', value: textLeaderboard, inline: false },
            { name: '🎙️ أعلى 5 في الفويس (نصف ساعة متواصلة = 1XP)', value: voiceLeaderboard, inline: false }
        );

        return message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in handleLeaderboardCommand:', error);
    }
}

// ==========================================
// [الأمر ت]: إعطاء تحذير سريع
// ==========================================
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

// ==========================================
// [الأمر شيل]: حذف آخر تحذير نشط تلقائياً
// ==========================================
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

// ==========================================
// [الأمر ملف]: استعراض سجل العضو الإداري
// ==========================================
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

// ==========================================
// [الأمر نقل]: لنقل تحذير من برو بوت يدوياً
// ==========================================
async function handleImportCommand(message, client) {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    
    const args = message.content.trim().split(/\s+/);
    args.shift(); // إزالة كلمة "نقل"
    
    const targetUser = message.mentions.users.first();
    const reason = args.slice(1).join(' ') || 'تحذير منقول من برو بوت';
    
    if (!targetUser) {
        return message.reply({ embeds: [errorEmbed('خطأ', 'الرجاء منشن العضو لنقل التحذير إليه.')] });
    }

    const result = await WarningService.addWarning({
        guildId: message.guild.id,
        userId: targetUser.id,
        moderatorId: message.author.id,
        reason: `[Imported] ${reason}`
    });

    if (result.success) {
        message.reply({ embeds: [successEmbed('تم النقل', `✅ تم نقل التحذير للعضو ${targetUser.tag} بنجاح!\n**السبب:** ${reason}`)] });
    } else {
        message.reply({ embeds: [errorEmbed('خطأ', 'فشل حفظ التحذير في قاعدة البيانات.')] });
    }
}

// ==========================================
// [نظام المستويات الجديد]: حساب وحفظ رسائل التفاعل المفيدة
// ==========================================
async function handleUsefulLeveling(message, client) {
    try {
        // حماية سريعة لمنع السخام وضغط المعالجة العشوائي (رسالة كل ثانيتين لكل مستخدم كحد أقصى)
        const rateLimitKey = `xp-useful:${message.guild.id}:${message.author.id}`;
        const canProcess = await checkRateLimit(rateLimitKey, 1, 2000);
        if (!canProcess) return;

        // التحقق من أن الميزة مفعلة بالسيرفر وقنواتها ليست مسحوب عليها عبر الـ config الأصلي لبوتك
        const levelingConfig = await getLevelingConfig(client, message.guild.id);
        if (!levelingConfig?.enabled) return;
        if (levelingConfig.ignoredChannels?.includes(message.channel.id)) return;

        if (levelingConfig.ignoredRoles?.length > 0) {
            const member = await message.guild.members.fetch(message.author.id).catch(() => null);
            if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) return;
        }

        if (levelingConfig.blacklistedUsers?.includes(message.author.id)) return;
        if (!message.content || message.content.trim().length === 0) return;

        // إرسال البيانات إلى السيرفيس المطور لفحص الفائدة وزيادة عداد الـ 10 رسائل
        await XpService.trackTextMessage(client, message.guild, message.member, message);

    } catch (error) {
        logger.error('Error handling useful leveling for message:', error);
    }
}
