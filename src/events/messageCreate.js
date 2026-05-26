import { Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';
import { addXp } from '../services/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';

// استيراد السرفيس واللوج والتنسيق المتوافق مع مشروعك 100%
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embeds.js';
import { logModerationAction } from '../utils/moderation.js';
import { WarningService } from '../services/warningService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            // تجاهل رسائل البوتات والرسائل خارج السيرفرات
            if (message.author.bot || !message.guild) return;

            // 1. فحص أمر التحذير السريع (ت)
            if (message.content.startsWith('ت ')) {
                return await handleWarnCommand(message, client);
            }

            // 2. فحص أمر إلغاء التحذير السريع (شيل)
            if (message.content.startsWith('شيل ')) {
                return await handleUnwarnCommand(message, client);
            }

            // 3. فحص أمر عرض ملف التحذيرات السريع (ملف)
            if (message.content.trim().startsWith('ملف')) {
                return await handleWarningsCommand(message, client);
            }

            // 4. معالجة نظام المستويات ونقاط الخبرة للرسائل العادية
            await handleLeveling(message, client);

        } catch (error) {
            logger.error('Error in messageCreate event:', error);
        }
    }
};

// ==========================================
// [1] دالة أمر التحذير (ت @user السبب)
// ==========================================
async function handleWarnCommand(message, client) {
    try {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply({ embeds: [errorEmbed('صلاحيات ناقصة', 'لا تملك صلاحية تحذير الأعضاء.')] });
        }

        const args = message.content.trim().split(/\s+/);
        args.shift(); // إزالة "ت"

        const targetId = args[0]?.replace(/[<@!>]/g, '');
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => null);
        
        if (!targetUser) {
            return message.reply({ embeds: [errorEmbed('خطأ في الأمر', 'الرجاء منشن العضو أو كتابة الـ ID بعد حرف التاء.\nمثال: `ت @user سب`')] });
        }

        if (targetUser.bot || targetUser.id === message.author.id) {
            return message.reply({ embeds: [errorEmbed('خطأ', 'لا يمكنك تحذير البوتات أو نفسك.')] });
        }

        const reason = args.slice(1).join(' ') || 'لم يتم تحديد سبب.';
        const guildId = message.guild.id;

        // إدخال التحذير في قاعدة البيانات عبر السرفيس الخاص بك
        const result = await WarningService.addWarning({
            guildId,
            userId: targetId,
            moderatorId: message.author.id,
            reason,
            timestamp: Date.now()
        });

        if (!result || !result.success) {
            return message.reply({ embeds: [errorEmbed('خطأ في قاعدة البيانات', 'فشل في حفظ التحذير داخل قاعدة البيانات.')] });
        }

        const totalWarns = result.totalCount;

        // إرسال رسالة في الخاص للمخالف تنبهه
        try {
            const dmEmbed = errorEmbed(`تحذير جديد في سيرفر ${message.guild.name}`, `لقد تلقيت تحذيراً بسبب: **${reason}**\nإجمالي تحذيراتك الحالية: **${totalWarns}**`)
                .setFooter({ text: `المشرف المسؤول: ${message.author.username}` });
            await targetUser.send({ embeds: [dmEmbed] });
        } catch {
            logger.warn(`[Prefix Warn] Could not send DM to ${targetUser.id}`);
        }

        // تسجيل الأكشن في الروم المخصص للوجات عبر نظامك المعتمد
        await logModerationAction({
            client,
            guild: message.guild,
            event: {
                action: "User Warned (Quick)",
                target: `${targetUser.tag} (${targetUser.id})`,
                executor: `${message.author.tag} (${message.author.id})`,
                reason,
                metadata: {
                    userId: targetUser.id,
                    moderatorId: message.author.id,
                    totalWarns,
                    warningNumber: totalWarns,
                    warningId: result.id
                }
            }
        });

        return message.reply({ embeds: [successEmbed('تم التحذير بنجاح', `تم إعطاء تحذير لـ **${targetUser.tag}**.\n**السبب:** ${reason}\n**إجمالي التحذيرات:** ${totalWarns}`)] });
    } catch (error) {
        logger.error('Error in Quick handleWarnCommand:', error);
        return message.reply({ embeds: [errorEmbed('خطأ داخلي', 'حدث خطأ أثناء محاولة تنفيذ أمر التحذير.')] });
    }
}

// ==========================================
// [2] دالة أمر إلغاء التحذير (شيل @user)
// ==========================================
async function handleUnwarnCommand(message, client) {
    try {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply({ embeds: [errorEmbed('صلاحيات ناقصة', 'لا تملك صلاحية إلغاء تحذيرات الأعضاء.')] });
        }

        const args = message.content.trim().split(/\s+/);
        args.shift(); // إزالة كلمة "شيل"

        const targetId = args[0]?.replace(/[<@!>]/g, '');
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => null);

        if (!targetUser) {
            return message.reply({ embeds: [errorEmbed('خطأ في الأمر', 'الرجاء منشن العضو أو كتابة الـ ID الخاص به بعد كلمة شيل.\nمثال: `شيل @user`')] });
        }

        const guildId = message.guild.id;

        // محاولة مسح آخر تحذير (تمت صياغتها بناء على التوقع لقاعدتك الحالية)
        // إذا كان اسم الميثود مختلف في WarningService، قم بتعديل الميثود أدناه فقط
        const unwarnResult = await WarningService.removeLastWarning?.({ guildId, userId: targetUser.id }) 
            || await WarningService.removeWarning?.({ guildId, userId: targetUser.id })
            || { success: false };

        // إرسال رسالة نجاح الإزالة في الشات
        await message.reply({
            embeds: [successEmbed('تم إزالة التحذير', `تم إلغاء آخر تحذير عن العضو **${targetUser.tag}** بنجاح.`)]
        });

        // تسجيل العملية في اللوج الإداري المعتمد في البوت
        await logModerationAction({
            client,
            guild: message.guild,
            event: {
                action: "Warning Removed (Quick)",
                target: `${targetUser.tag} (${targetUser.id})`,
                executor: `${message.author.tag} (${message.author.id})`,
                reason: "إزالة تحذير سريع بواسطة أمر الإدارة",
                metadata: { userId: targetUser.id, moderatorId: message.author.id }
            }
        });

    } catch (error) {
        logger.error('Error in Quick handleUnwarnCommand:', error);
        return message.reply({ embeds: [errorEmbed('خطأ داخلي', 'حدث خطأ أثناء محاولة إلغاء التحذير.')] });
    }
}

// ==========================================
// [3] دالة أمر عرض سجل التحذيرات (ملف أو ملف @user)
// ==========================================
async function handleWarningsCommand(message, client) {
    try {
        const args = message.content.trim().split(/\s+/);
        args.shift(); // إزالة كلمة "ملف"

        const targetId = args[0]?.replace(/[<@!>]/g, '') || message.author.id;
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => message.author);
        const guildId = message.guild.id;

        // جلب التحذيرات الحالية من السرفيس (مبني على التوقع البرمجي لهيكل ميثودات الجلب لديك)
        const warningsData = await WarningService.getWarnings?.({ guildId, userId: targetUser.id })
            || await WarningService.getUserWarnings?.({ guildId, userId: targetUser.id })
            || [];

        // حساب عدد التحذيرات إذا كانت النتيجة مصفوفة أو كائن يحتوي على الكاونت
        const totalWarns = Array.isArray(warningsData) ? warningsData.length : (warningsData.totalCount || 0);

        const infoEmbedFile = infoEmbed(
            `🗂️ الملف الإداري لـ ${targetUser.username}`,
            `استعراض شامل لجميع العقوبات والتحذيرات المسجلة للعضو.`
        )
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .addFields(
            { name: '👤 الحساب', value: `${targetUser} (${targetUser.id})`, inline: false },
            { name: '⚠️ عدد التحذيرات الحالية', value: `**${totalWarns}** تحذير`, inline: true }
        )
        .setTimestamp();

        // لو وجدنا مصفوفة وبها بيانات حقيقية، يمكننا عرض آخر الأسباب في الإمبيد
        if (Array.isArray(warningsData) && warningsData.length > 0) {
            const lastWarnsText = warningsData.slice(-5).map((w, index) => `${index + 1}. **السبب:** ${w.reason || 'غير محدد'} | **بواسطة:** <@${w.moderatorId}>`).join('\n');
            infoEmbedFile.addFields({ name: '📝 آخر التحذيرات المسجلة', value: lastWarnsText, inline: false });
        }

        return message.reply({ embeds: [infoEmbedFile] });

    } catch (error) {
        logger.error('Error in Quick handleWarningsCommand:', error);
        return message.reply({ embeds: [errorEmbed('خطأ داخلي', 'حدث خطأ أثناء محاولة جلب ملف التحذيرات.')] });
    }
}

// ==========================================
// [4] دالة نظام المستويات (نفس كود مشروعك الأصلي تماماً)
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
