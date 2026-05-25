import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import { closeTicket, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../utils/ticketPermissions.js';

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
      const permissionMessage = allowTicketCreator
        ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
        : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';
      return { success: false, error: 'Permission Denied', details: `${permissionMessage}\n\nYou cannot ${actionLabel}.` };
    }
    return { success: true, context };
  } catch (error) {
    if (error.message === 'Timeout') return { success: false, error: 'Request Timeout', details: 'The permission check took too long. Please try again.' };
    return { success: false, error: 'Error', details: `Failed to check permissions: ${error.message}` };
  }
}

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
      const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Reason for closing (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
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
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const reason = interaction.fields.getTextInputValue('reason')?.trim() || 'Closed via ticket button without a specific reason.';
      const result = await closeTicket(interaction.channel, interaction.user, reason);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket Closed', 'This ticket has been closed.')] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to close ticket.')] });
      }
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
    }
  }
};

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
          const staffRoleId = config.ticketStaffRole || config.staffRoleId; 
          if (staffRoleId) {
            await interaction.channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: false });
          }
          await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, SendMessages: true, AttachFiles: true, ReadMessageHistory: true });
          await interaction.channel.send({ embeds: [successEmbed('🎫 تيكت مستلمة', `تم استلام هذه التيكت بواسطة ${interaction.user} ولن يتمكن باقي المشرفين من رؤيتها.`)] });
        } catch (permError) {
          logger.error('Error updating permissions on claim:', permError);
        }
        await interaction.editReply({ embeds: [successEmbed('Ticket Claimed', 'You have successfully claimed this ticket!')] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to claim ticket.')] });
      }
    } catch (error) {
      logger.error('Error claiming ticket:', error);
    }
  }
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'change ticket priority', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const priority = args?.[0];
      if (!priority) {
        await interaction.editReply({ embeds: [errorEmbed('Invalid Priority', 'A priority value is required.')] });
        return;
      }
      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Priority Updated', `Ticket priority set to ${priority}.`)] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to update priority.')] });
      }
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
    }
  }
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'pin tickets', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const channel = interaction.channel;
      const category = channel.parent;
      if (!category) {
        await interaction.editReply({ embeds: [errorEmbed('Error', 'This ticket is not in a category.')] });
        return;
      }
      const hasPingEmoji = channel.name.startsWith('📌');
      if (hasPingEmoji) {
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({ name: newName, position: 999 });
        await interaction.editReply({ embeds: [createEmbed({ title: '📌 Ticket Unpinned', description: 'This ticket has been unpinned.', color: 0x95A5A6 })] });
      } else {
        const newName = `📌 ${channel.name}`;
        await channel.edit({ name: newName, position: 0 });
        await interaction.editReply({ embeds: [createEmbed({ title: '📌 Ticket Pinned', description: 'This ticket has been pinned.', color: 0x3498db })] });
      }
      await logTicketEvent({
        client: interaction.client, guildId: interaction.guildId,
        event: { type: hasPingEmoji ? 'unpin' : 'pin', ticketId: channel.id, ticketNumber: channel.name.replace(/[^0-9]/g, ''), userId: interaction.user.id, executorId: interaction.user.id }
      });
    } catch (error) {
      logger.error('Error pinning/unpinning ticket:', error);
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'unclaim tickets', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      if (result.success) {
        try {
          const config = await getGuildConfig(client, interaction.guildId);
          const staffRoleId = config.ticketStaffRole || config.staffRoleId;
          if (staffRoleId) {
            await interaction.channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: true });
          }
          await interaction.channel.permissionOverwrites.delete(interaction.user.id);
          await interaction.channel.send({ embeds: [createEmbed({ title: '🔓 إلغاء استلام التيكت', description: `قام المشرف ${interaction.user} بإلغاء استلام التيكت.`, color: 0xe67e22 })] });
        } catch (permError) {
          logger.error('Error updating permissions on unclaim:', permError);
        }
        await interaction.editReply({ embeds: [successEmbed('Ticket Unclaimed', 'You have successfully unclaimed this ticket!')] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to unclaim ticket.')] });
      }
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'reopen tickets', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket Reopened', 'You have successfully reopened this ticket!')] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to reopen ticket.')] });
      }
    } catch (error) {
      logger.error('Error reopening ticket:', error);
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'delete tickets', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const { deleteTicket } = await import('../services/ticket.js');
      const result = await deleteTicket(interaction.channel, interaction.member);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket Deleted', 'This ticket will be permanently deleted in 3 seconds.')] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to delete ticket.')] });
      }
    } catch (error) {
      logger.error('Error deleting ticket:', error);
    }
  }
};

export default [
  closeTicketHandler, closeTicketModalHandler, claimTicketHandler,
  priorityTicketHandler, pinTicketHandler, unclaimTicketHandler,
  reopenTicketHandler, deleteTicketHandler
];

