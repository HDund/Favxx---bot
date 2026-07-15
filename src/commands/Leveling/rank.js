import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../../database.js';

export default {
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('عرض نقاط الخبرة الخاصة بك'),
    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        const result = await db.query(
            'SELECT text_xp, voice_xp FROM users_xp WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );

        const data = result.rows[0] || { text_xp: 0, voice_xp: 0 };

        const embed = new EmbedBuilder()
            .setTitle(`📊 بطاقة الخبرة لـ ${interaction.user.username}`)
            .setColor('#2ecc71')
            .addFields(
                { name: '✍️ نقاط الكتابة', value: `**${Math.floor(data.text_xp)}** XP`, inline: true },
                { name: '🎙️ نقاط الصوت', value: `**${Math.floor(data.voice_xp)}** XP`, inline: true }
            )
            .setFooter({ text: 'Nova bot style' });

        await interaction.reply({ embeds: [embed] });
    }
};
