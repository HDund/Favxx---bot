import { MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// 1. معالج نموذج إنشاء التذكرة (create_ticket_modal)
const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      // تأخير الاستجابة (Defer) لضمان عدم انتهاء وقت التفاعل مع ديسكورد
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      // جلب النص الذي كتبه العضو في خانة سبب فتح التذكرة
      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;
      
      // استدعاء خدمة إنشاء الغرفة بشكل ديناميكي وآمن
      const { createTicket } = await import('../../services/ticket.js');
      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason
      );
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed(
            'Ticket Created',
            `تم إنشاء تذكرتك بنجاح في روم: ${result.channel}`
          )]
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'فشل إنشاء التذكرة، يرجى مراجعة الصلاحيات.')]
        });
      }
    } catch (error) {
      logger.error('Error in create_ticket_modal:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Error', 'حدث خطأ غير متوقع أثناء معالجة إنشاء التذكرة.')]
      });
    }
  }
};

// 2. معالج نموذج إغلاق التذكرة (ticket_close_modal)
const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'تم الإغلاق بواسطة طاقم الإدارة بدون ذكر سبب.';
      
      // استدعاء خدمة إغلاق التذكرة
      const { closeTicket } = await import('../../services/ticket.js');
      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Closed', 'تم إغلاق هذه التذكرة بنجاح وجاري أرشفة المحادثة.')]
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'فشل إغلاق التذكرة.')]
        });
      }
    } catch (error) {
      logger.error('Error in ticket_close_modal:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Error', 'حدث خطأ أثناء محاولة إغلاق التذكرة.')]
      });
    }
  }
};

// التصدير كمصفوفة متطابقة تماماً مع نظام الـ Loader والهندلة الخاص بالبوت
export default [
  createTicketModalHandler,
  closeTicketModalHandler
];
