import { Events, PermissionFlagsBits } from 'discord.js';

import { logger } from '../utils/logger.js';

import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';

import { addXp } from '../services/xpSystem.js';

import { checkRateLimit } from '../utils/rateLimiter.js';



// استيراد التنسيقات واللوج والسيرفيس المحدث

import { errorEmbed, successEmbed, infoEmbed } from '../utils/embeds.js';

import { logModerationAction } from '../utils/moderation.js';

import { WarningService } from '../services/warningService.js';



const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;

const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;



export default {

    name: Events.MessageCreate,

    async execute(message, client) {

        try {

            if (message.author.bot || !message.guild) return;



            // 1. فحص أمر التحذير (ت)

            if (message.content.startsWith('ت ')) {

                return await handleWarnCommand(message, client);

            }



            // 2. فحص أمر إلغاء التحذير (شيل)

            if (message.content.startsWith('شيل ')) {

                return await handleUnwarnCommand(message, client);

            }



            // 3. فحص أمر عرض ملف التحذيرات (ملف)

            if (message.content.trim().startsWith('ملف')) {

                return await handleWarningsCommand(message, client);

            }



            // 4. فحص أمر نقل التحذيرات (نقل)

            if (message.content.startsWith('نقل ')) {

                return await handleImportCommand(message, client);

            }



            // 5. معالجة نظام المستويات ونقاط الخبرة للرسائل العادية

            await handleLeveling(message, client);



        } catch (error) {

            logger.error('Error in messageCreate event:', error);

        }

    }

};



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

// [نظام المستويات]: الكود الأصلي الخاص بك

// ==========================================

async function handleLeveling(message, client) {

    try {

        const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;

        const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);

        if (!canProcess) return;



        const levelingConfig = await getLevelingConfig(client, message.guild.id);

        if (!levelingConfig?.enabled) return;

        if (levelingConfig.ignoredChannels?.includes(message.channel.id)) return;



        if (levelingConfig.ignoredRoles?.length > 0) {

            const member = await message.guild.members.fetch(message.author.id).catch(() => null);

            if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) return;

        }



        if (levelingConfig.blacklistedUsers?.includes(message.author.id)) return;

        if (!message.content || message.content.trim().length === 0) return;



        const userData = await getUserLevelData(client, message.guild.id, message.author.id);

        const cooldownTime = levelingConfig.xpCooldown || 60;

        const now = Date.now();

        const timeSinceLastMessage = now - (userData.lastMessage || 0);

        if (timeSinceLastMessage < cooldownTime * 1000) return;



        const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;

        const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

        const safeMinXP = Math.max(1, minXP);

        const safeMaxXP = Math.max(safeMinXP, maxXP);



        const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

        let finalXP = xpToGive;

        if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {

            finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);

        }



        const result = await addXp(client, message.guild, message.member, finalXP);

        if (result.success && result.leveledUp) {

            logger.info(`${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`);

        }

    } catch (error) {

        logger.error('Error handling leveling for message:', error);

    }

} 

import { EmbedBuilder } from 'discord.js';
import { db } from '../database.js';

const cooldowns = new Set();

export default async function messageCreateHandler(message) {
    if (message.author.bot) return;

    const content = message.content.trim().toLowerCase();

    if (content === 't') {
        try {
            const textQuery = await db.query('SELECT user_id, text_xp FROM users_xp ORDER BY text_xp DESC LIMIT 5');
            const voiceQuery = await db.query('SELECT user_id, voice_xp FROM users_xp ORDER BY voice_xp DESC LIMIT 5');

            let textLeaderboard = textQuery.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> - ${Math.floor(row.text_xp)} XP`).join('\n') || 'لا يوجد بيانات كافية';
            let voiceLeaderboard = voiceQuery.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> - ${Math.floor(row.voice_xp)} XP`).join('\n') || 'لا يوجد بيانات كافية';

            const embed = new EmbedBuilder()
                .setTitle('قائمة أفضل 5 أعضاء المتفاعلين')
                .setColor('#2b2d31')
                .addFields(
                    { name: 'الرسائل الكتابية', value: textLeaderboard, inline: true },
                    { name: 'التفاعل الصوتي', value: voiceLeaderboard, inline: true }
                )
                .setTimestamp();

            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error("Database Error Leaderboard:", error);
            return message.reply("حدث خطأ أثناء جلب البيانات.");
        }
    }

    const wordsCount = message.content.split(/\s+/).length;
    if (wordsCount < 3) return;

    if (cooldowns.has(message.author.id)) return;

    cooldowns.add(message.author.id);
    setTimeout(() => {
        cooldowns.delete(message.author.id);
    }, 180000); 

    try {
        await db.query(`
            INSERT INTO users_xp (user_id, valid_message_count, text_xp) 
            VALUES ($1, 1, 0) 
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                valid_message_count = users_xp.valid_message_count + 1,
                text_xp = CASE 
                    WHEN (users_xp.valid_message_count + 1) % 10 = 0 THEN users_xp.text_xp + 1 
                    ELSE users_xp.text_xp 
                END;
        `, [message.author.id]);
    } catch (error) {
        console.error("Database Error Text XP:", error);
    }
}

