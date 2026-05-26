import { Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';
import { addXp } from '../services/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';

// استيرادات أمر التحذير
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { logEvent } from '../utils/moderation.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            // تجاهل رسائل البوتات والرسائل خارج السيرفرات
            if (message.author.bot || !message.guild) return;

            // 1. فحص وتنفيذ أمر التحذير (ت)
            if (message.content.startsWith('ت ')) {
                await handleWarnCommand(message, client);
            }

            // 2. معالجة نظام المستويات ونقاط الخبرة
            await handleLeveling(message, client);

        } catch (error) {
            logger.error('Error in messageCreate event:', error);
        }
    }
};

// ==========================================
// دالة أمر التحذير المخصصة
// ==========================================
async function handleWarnCommand(message, client) {
    try {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return message.reply({
                embeds: [errorEmbed('صلاحيات ناقصة', 'لا تملك صلاحية تحذير الأعضاء.')]
            });
        }

        const args = message.content.trim().split(/\s+/);
        args.shift(); // إزالة حرف "ت"

        const targetId = args[0]?.replace(/[<@!>]/g, '');
        const targetUser = message.mentions.users.first() || await client.users.fetch(targetId).catch(() => null);
        
        if (!targetUser) {
            return message.reply({
                embeds: [errorEmbed('خطأ في الأمر', 'الرجاء عمل منشن للعضو أو كتابة المعرف الخاص به بعد حرف التاء.\nمثال: `ت @user سب وشتم`')]
            });
        }

        if (targetUser.bot) return message.reply({ embeds: [errorEmbed('خطأ', 'لا يمكنك تحذير البوتات.')] });
        if (targetUser.id === message.author.id) return message.reply({ embeds: [errorEmbed('خطأ', 'لا يمكنك تحذير نفسك.')] });

        const reason = args.slice(1).join(' ') || 'لم يتم تحديد سبب.';

        try {
            const dmEmbed = errorEmbed(
                `تحذير جديد في سيرفر ${message.guild.name}`,
                `لقد تلقيت تحذيرا بسبب: **${reason}**`
            ).setFooter({ text: `المشرف المسؤول: ${message.author.username}` });

            await targetUser.send({ embeds: [dmEmbed] });
        } catch (dmErr) {
            logger.warn(`[Prefix Warn] Could not send DM to ${targetUser.id} (DMs closed).`);
        }

        await logEvent({
            client: client,
            guild: message.guild,
            event: {
                action: "Member Warned",
                target: `${targetUser.username} (${targetUser.id})`,
                executor: `${message.author.username} (${message.author.id})`,
                reason: reason,
                metadata: {
                    userId: targetUser.id,
                    moderatorId: message.author.id,
                    channelId: message.channel.id
                }
            }
        });

        return message.reply({
            embeds: [
                successEmbed(
                    'تم التحذير بنجاح',
                    `تم إعطاء تحذير لـ **${targetUser.username}** بنجاح.\nالسبب: **${reason}**`
                )
            ]
        });

    } catch (error) {
        logger.error('Error in Arabic Warn command:', error);
        return message.reply({
            embeds: [errorEmbed('خطأ داخلي', 'حدث خطأ غير متوقع أثناء محاولة تنفيذ الأمر.')]
        });
    }
}

// ==========================================
// دالة نظام المستويات (نفس الكود الخاص بك بدون تعديل)
// ==========================================
async function handleLeveling(message, client) {
    try {
        const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
        const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
        if (!canProcess) {
            return;
        }

        const levelingConfig = await getLevelingConfig(client, message.guild.id);
        
        if (!levelingConfig?.enabled) {
            return;
        }

        if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
            return;
        }

        if (levelingConfig.ignoredRoles?.length > 0) {
            const member = await message.guild.members.fetch(message.author.id).catch(() => {
                return null;
            });
            if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
                return;
            }
        }

        if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
            return;
        }

        if (!message.content || message.content.trim().length === 0) {
            return;
        }

        const userData = await getUserLevelData(client, message.guild.id, message.author.id);
        
        const cooldownTime = levelingConfig.xpCooldown || 60;
        const now = Date.now();
        const timeSinceLastMessage = now - (userData.lastMessage || 0);
        
        if (timeSinceLastMessage < cooldownTime * 1000) {
            return;
        }

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
            logger.info(
                `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
            );
        }
    } catch (error) {
        logger.error('Error handling leveling for message:', error);
    }
}
