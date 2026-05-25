import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, createEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { claimTicket, closeTicket, updateTicketPriority } from '../../services/ticket.js';
import { logTicketEvent } from '../../utils/ticketLogging.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticketPermissions.js';

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) return true;
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      embeds: [errorEmbed('Guild Only', 'This action can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  return false;
}

async function checkTicketPermissionWithTimeout(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;
  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs));
    const context = await Promise.race([contextPromise, timeoutPromise]);
    if (!context.ticketData) {
      return { success: false, error: 'Not a Ticket Channel', details: 'This action can only be used in a valid ticket channel.' };
    }
    const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
    if (!allowed) {
      return { success: false, error: 'Permission Denied', details: 'You do not have permission to do this.' };
    }
    return { success: true, context };
  } catch (error) {
    return { success: false, error: 'Error', details: error.message };
  }
}

// 1. زر فتح التذكرة الأساسي من القائمة الرئيسية
const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;
      
      const { getUserTicketCount } = await import('../../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      
      if (currentTicketCount >= maxTicketsPerUser) {
        return await interaction.reply({
          embeds: [errorEmbed('🎫 Ticket Limit Reached', `You have reached the maximum number of open tickets (${maxTicketsPerUser}).`)],
          flags: MessageFlags.Ephemeral
        });
      }
      
      const modal = new ModalBuilder().setCustomId('create_ticket_modal').setTitle('Create a Ticket');
      const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Why are you creating this ticket?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error opening modal:', error);
    }
  }
};

// 2. زر الاستلام الحصري والذكي (حل مشكلة رتبة الإدارة المشتركة)
const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'claim tickets', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const result = await claimTicket(interaction.channel, interaction.user);
      
      if (result.success) {
        try {
          const config = await getGuildConfig(client, interaction.guildId);
          const staffRoleId = config.ticketStaffRole || config.staffRoleId || config.supportRoleId; 

          // إخفاء الروم فوراً عن الرتبة الإدارية المشتركة بالكامل
          if (staffRoleId) {
            await interaction.channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: false });
          }

          // إعطاء صلاحية الرؤية والكتابة حصرية فقط لمن ضغط على الزر عبر الآيدي الخاص به
          await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true, SendMessages: true, AttachFiles: true, ReadMessageHistory: true
          });

          await interaction.channel.send({
            embeds: [successEmbed('🎫 تيكت مستلمة حصرية', `تم استلام التذكرة بواسطة ${interaction.user} الحين.\nتم حجب التيكت بنجاح عن باقي أفراد طاقم الإدارة.`)]
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

// 3. زر قفل التذكرة
const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'close this ticket', { allowTicketCreator: true }, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Close Ticket');
      const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Reason for closing').setStyle(TextInputStyle.Paragraph).setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error(error);
    }
  }
};

// باقي أزرار التحكم الفرعية المعتمدة في السورس لضمان عدم تعطلها
const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const priority = args?.[0];
      if (!priority) return;
      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      if (result.success) await interaction.reply({ embeds: [successEmbed('Priority Updated', `Priority set to ${priority}.`)], flags: MessageFlags.Ephemeral });
    } catch (error) { logger.error(error); }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const { unclaimTicket } = await import('../../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      if (result.success) {
        const config = await getGuildConfig(client, interaction.guildId);
        const staffRoleId = config.ticketStaffRole || config.staffRoleId || config.supportRoleId;
        if (staffRoleId) await interaction.channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: true });
        await interaction.channel.permissionOverwrites.delete(interaction.user.id);
        await interaction.reply({ embeds: [successEmbed('Ticket Unclaimed', 'Returned to help queue.')] });
      }
    } catch (error) { logger.error(error); }
  }
};

export default [
  createTicketHandler, claimTicketHandler, closeTicketHandler, priorityTicketHandler, unclaimTicketHandler
];
