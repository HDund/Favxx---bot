import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { sanitizeMarkdown } from '../../utils/sanitization.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("dm")
        .setDescription("Send a direct message to a user (Staff only)")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("The user to send a DM to")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("message")
                .setDescription("The message to send")
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName("anonymous")
                .setDescription("Send the message anonymously (default: false)")
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setDMPermission(false),
        
    category: "Moderation",

    async execute(interaction, config, client) {
        // 1. جعل الـ Defer مخفياً (Ephemeral) منذ البداية لكي يتوافق مع رسائل الأخطاء ولخصوصية الإدارة
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn(`DM interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'dm'
            });
            return;
        }

        const targetUser = interaction.options.getUser("user");
        const message = interaction.options.getString("message");
        const anonymous = interaction.options.getBoolean("anonymous") || false;

        try {
            // 2. التحقق من طول الرسالة
            if (message.length > 2000) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed("Message Too Long", "Messages must be under 2000 characters.")]
                });
            }

            // 3. منع مراسلة البوتات
            if (targetUser.bot) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed("Cannot DM Bot", "You cannot send DMs to bot accounts.")]
                });
            }

            // 4. معالجة النص والتأكد من أنه لا يخرج فارغاً بعد الـ Sanitize
            let sanitized = sanitizeMarkdown(message).trim();
            if (!sanitized) {
                // إذا مسح الـ Sanitize كل الحروف، نرجع للنص الأصلي لكي لا يظهر الحقل فارغاً ويتعطل الديسكورد
                sanitized = message; 
            }

            // 5. إنشاء خط الخاص وإرسال الرسالة بداخل إمبيد منسق ونظيف
            const dmChannel = await targetUser.createDM();
            
            const senderTitle = anonymous ? "✉️ Message from the Staff Team" : `✉️ Message from ${interaction.user.username}`;
            const userEmbed = successEmbed(senderTitle, sanitized)
                .setFooter({
                    text: `You cannot reply to this message. | Logger ID: ${interaction.id}`
                })
                .setTimestamp();

            await dmChannel.send({ embeds: [userEmbed] });

            // 6. تسجيل العملية في نظام الـ Log الخاص بالبوت
            await logEvent({
                client: interaction.client,
                guild: interaction.guild,
                event: {
                    action: "DM Sent",
                    target: `${targetUser.username} (${targetUser.id})`,
                    executor: `${interaction.user.username} (${interaction.user.id})`,
                    reason: `Anonymous: ${anonymous ? 'Yes' : 'No'}`,
                    metadata: {
                        userId: targetUser.id,
                        moderatorId: interaction.user.id,
                        anonymous,
                        messageLength: sanitized.length
                    }
                }
            });

            // 7. إعلام الإداري بنجاح العملية
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        "DM Sent Successfully",
                        `The message has been delivered to **${targetUser.username}**.`
                    ),
                ],
            });

        } catch (error) {
            logger.error('DM command error:', error);
            
            // 8. التعامل الذكي مع حظر البوت أو إغلاق الخاص
            if (error.code === 50007) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed("Error", `Could not send a DM to **${targetUser.username}**. They may have DMs disabled or blocked the bot.`)],
                });
            }
            
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed("Error", `Failed to send DM: ${error.message}`)],
            });
        }
    }
};
