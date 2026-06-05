import { Events, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { db } from '../database.js'; // تأكد من المسار الصحيح
import { WarningService } from '../services/warningService.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embeds.js';
import { logModerationAction } from '../utils/moderation.js';

const cooldowns = new Set();

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;

        // 1. معالجة أوامر التحذير (الإدارة)
        if (message.content.startsWith('ت ')) return await handleWarnCommand(message, client);
        if (message.content.startsWith('شيل ')) return await handleUnwarnCommand(message, client);
        if (message.content.trim().startsWith('ملف')) return await handleWarningsCommand(message, client);

        // 2. معالجة أمر الإحصائيات (T)
        const content = message.content.trim().toLowerCase();
        if (content === 't') {
            try {
                const textQuery = await db.query('SELECT user_id, text_xp FROM users_xp ORDER BY text_xp DESC LIMIT 5');
                const voiceQuery = await db.query('SELECT user_id, voice_xp FROM users_xp ORDER BY voice_xp DESC LIMIT 5');

                let textLeaderboard = textQuery.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> - ${Math.floor(row.text_xp)} XP`).join('\n') || 'لا يوجد بيانات';
                let voiceLeaderboard = voiceQuery.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> - ${Math.floor(row.voice_xp)} XP`).join('\n') || 'لا يوجد بيانات';

                const embed = new EmbedBuilder()
                    .setTitle('قائمة أفضل 5 أعضاء المتفاعلين')
                    .setColor('#2b2d31')
                    .addFields(
                        { name: 'الرسائل الكتابية', value: textLeaderboard, inline: true },
                        { name: 'التفاعل الصوتي', value: voiceLeaderboard, inline: true }
                    );
                return message.reply({ embeds: [embed] });
            } catch (err) { logger.error("DB Error:", err); }
        }

        // 3. نظام الـ XP الجديد
        const wordsCount = message.content.split(/\s+/).length;
        if (wordsCount < 3 || cooldowns.has(message.author.id)) return;

        cooldowns.add(message.author.id);
        setTimeout(() => cooldowns.delete(message.author.id), 180000); // 3 دقائق

        try {
            await db.query(`
                INSERT INTO users_xp (user_id, valid_message_count, text_xp) 
                VALUES ($1, 1, 0) 
                ON CONFLICT (user_id) 
                DO UPDATE SET 
                    valid_message_count = users_xp.valid_message_count + 1,
                    text_xp = CASE WHEN (users_xp.valid_message_count + 1) % 10 = 0 THEN users_xp.text_xp + 1 ELSE users_xp.text_xp END;
            `, [message.author.id]);
        } catch (err) { logger.error("XP Error:", err); }
    }
};

// ... ضع دوال handleWarnCommand و handleUnwarnCommand و handleWarningsCommand هنا بالأسفل ...
