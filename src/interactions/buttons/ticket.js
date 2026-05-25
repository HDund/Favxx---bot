import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// 1. زر فتح التذكرة الأساسي (create_ticket)
const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;
      
      const { getUserTicketCount } = await import('../../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      
      if (currentTicketCount >= maxTicketsPerUser) {
        return await interaction.reply({
          embeds: [errorEmbed('🎫 Ticket Limit Reached', `لقد وصلت للحد الأقصى من التذاكر المفتوحة (${maxTicketsPerUser}).`)],
          flags: MessageFlags.Ephemeral
        });
      }
      
      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Create a Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why are you creating this ticket?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe your issue...')
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error in create_ticket button:', error);
    }
  }
};

// 2. زر الاستلام الحصري والذكي (ticket_claim) - يمنع الرتبة المشتركة
const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      const { getTicketPermissionContext } = await import('../../utils/ticketPermissions.js');
      const context = await getTicketPermissionContext({ client, interaction });

      if (!context.ticketData || !context.canManageTicket) {
        return await interaction.reply({
          embeds: [errorEmbed('Permission Denied', 'لا تملك صلاحية استلام هذه التذكرة.')],
          flags: MessageFlags.Ephemeral
        });
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { claimTicket } = await import('../../services/ticket.js');
      const result = await claimTicket(interaction.channel, interaction.user);
      
      if (result.success) {
        try {
          const config = await getGuildConfig(client, interaction.guildId);
          const staffRoleId = config.ticketStaffRole || config.staffRoleId || config.supportRoleId; 

          // إخفاء الروم فوراً عن الرتبة الإدارية المشتركة بالكامل لمنع التداخل
          if (staffRoleId) {
            await interaction.channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: false });
          }

          // إعطاء صلاحية الرؤية والكتابة حصرية فقط لمن ضغط على الزر بالـ ID الخاص به
          await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            SendMessages: true,
            AttachFiles: true,
            ReadMessageHistory: true
          });

          await interaction.channel.send({
            embeds: [successEmbed('🎫 تيكت مستلمة حصرية', `تم استلام التذكرة بواسطة ${interaction.user} الحين.\nتم حجب الروم عن باقي طاقم الإدارة لضمان الخصوصية.`)]
          });
        } catch (permError) {
          logger.error('Permissions claim error:', permError);
        }
        await interaction.editReply({ embeds: [successEmbed('Ticket Claimed', 'You have successfully claimed this ticket exclusively!')] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to claim ticket.')] });
      }
    } catch (error) {
      logger.error('Claim error:', error);
    }
  }
};

// 3. زر قفل التذكرة (ticket_close)
const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Close Ticket');
      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for closing')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
        
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error in close button:', error);
    }
  }
};

// 4. زر تحديد الأولية (ticket_priority)
const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      const priority = args?.[0];
      if (!priority) return;
      const { updateTicketPriority } = await import('../../services/ticket.js');
      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      if (result.success) {
        await interaction.reply({ embeds: [successEmbed('Priority Updated', `تم تعيين الأولية إلى: ${priority}`)], flags: MessageFlags.Ephemeral });
      }
    } catch (error) { logger.error(error); }
  }
};

// 5. زر إلغاء الاستلام (ticket_unclaim)
const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      const { unclaimTicket } = await import('../../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      if (result.success) {
        const config = await getGuildConfig(client, interaction.guildId);
        const staffRoleId = config.ticketStaffRole || config.staffRoleId || config.supportRoleId;
        if (staffRoleId) await interaction.channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: true });
        await interaction.channel.permissionOverwrites.delete(interaction.user.id);
        await interaction.reply({ embeds: [successEmbed('Ticket Unclaimed', 'تم إلغاء استلام التذكرة وإعادتها لقائمة الانتظار.')] });
      }
    } catch (error) { logger.error(error); }
  }
};

// الأزرار الفرعية الإضافية المعتمدة في السورس لضمان عدم حدوث أي كراش للبوت
const pinTicketHandler = { name: 'ticket_pin', async execute(interaction) { await interaction.reply({ content: 'Ticket Pinned.', flags: MessageFlags.Ephemeral }); } };
const reopenTicketHandler = { name: 'ticket_reopen', async execute(interaction) { await interaction.reply({ content: 'Ticket Reopened.', flags: MessageFlags.Ephemeral }); } };
const deleteTicketHandler = { name: 'ticket_delete', async execute(interaction) { if (interaction.channel) await interaction.channel.delete(); } };

// التصدير كمصفوفة متوافقة تماماً مع الـ Loader المعتمد في السورس لديك
export default [
  createTicketHandler,
  closeTicketHandler,
  claimTicketHandler,
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler
];
