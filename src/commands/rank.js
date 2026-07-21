import { EmbedBuilder } from 'discord.js';
import { db } from '../database.js'; // تأكد من مسار ملف قاعدة البيانات
import { logger } from '../utils/logger.js'; // تأكد من مسار ملف اللوجر

export default {
    name: 'rank',
    description: 'عرض الرتبة، نقاط الخبرة (الصوتية والكتابية)، والمستوى الحالي',
    async execute(message, args, client) {
        try {
            // تحديد العضو المطلوب (إذا منشن شخص آخر يجلب بياناته، وإذا لم يمنشن يجلب بياناته هو)
            const targetUser = message.mentions.users.first() || message.author;
            const guildId = message.guild.id;
            const userId = targetUser.id;

            // إذا كان الهدف بوت، نرسل رسالة تنبيه
            if (targetUser.bot) {
                return message.reply("🤖 البوتات لا تمتلك نقاط خبرة!");
            }

            // الاستعلام من قاعدة البيانات لجلب نقاط المستخدم
            const result = await db.query(
                'SELECT text_xp, voice_xp FROM users_xp WHERE guild_id = $1 AND user_id = $2', 
                [guildId, userId]
            );
            
            // تهيئة المتغيرات بصفر في حال لم يكن للعضو أي رسائل أو تفاعل سابق
            let textXp = 0;
            let voiceXp = 0;

            if (result.rows.length > 0) {
                textXp = Math.floor(result.rows[0].text_xp);
                voiceXp = Math.floor(result.rows[0].voice_xp);
            }

            // حساب الإجمالي والمستوى
            const totalXp = textXp + voiceXp;
            
            // معادلة المستوى: كل 500 نقطة (صوت + كتابة) تعطي مستوى جديد
            // يمكنك تغيير الرقم 500 إلى أي رقم تراه مناسباً لصعوبة التلفيل
            const level = Math.floor(totalXp / 500); 

            // تصميم رسالة العرض (Embed)
            const rankEmbed = new EmbedBuilder()
                .setTitle(`📊 الإحصائيات الخاصة بـ ${targetUser.username}`)
                .setColor('#2b2d31') // لون رمادي داكن أنيق (يمكنك تغييره)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 1024 }))
                .addFields(
                    { name: '✨ المستوى الحالي (Level)', value: `**${level}**`, inline: false },
                    { name: '✍️ نقاط الكتابة', value: `\`${textXp}\` XP`, inline: true },
                    { name: '🎙️ نقاط الصوت', value: `\`${voiceXp}\` XP`, inline: true },
                    { name: '🌟 إجمالي النقاط', value: `\`${totalXp}\` XP`, inline: false }
                )
                .setFooter({ text: `Requested by ${message.author.username}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();

            // إرسال الإمبد للروم
            return message.reply({ embeds: [rankEmbed] });

        } catch (error) {
            logger.error('Error executing rank command:', error);
            return message.reply('❌ حدث خطأ غير متوقع أثناء جلب بيانات الرتبة من قاعدة البيانات.');
        }
    }
};

