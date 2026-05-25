import { MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { createTicket } from '../../services/ticket.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;
      
      const result = await createTicket(interaction.guild, interaction.member, categoryId, reason);
      
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket Created', `Your ticket has been created in ${result.channel}!`)] });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Error', result.error || 'Failed to create ticket.')] });
      }
    } catch (error) {
      logger.error('Modal error:', error);
    }
  }
};
