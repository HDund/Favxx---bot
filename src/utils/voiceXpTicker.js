import { XpService } from '../services/xpSystem.js';
import { logger } from './logger.js';

/**
 * دالة تفحص كل الرومات الصوتية في السيرفرات وتكافئ المتواجدين
 */
export function startVoiceXpTicker(client) {
    // 1800000 ميلي ثانية تساوي تماماً 30 دقيقة
    const THIRTY_MINUTES = 30 * 60 * 1000; 

    setInterval(async () => {
        logger.info('⏳ جاري فحص الرومات الصوتية لتوزيع إكسبي الفويس...');
        
        try {
            for (const [guildId, guild] of client.guilds.cache) {
                // جلب حالات الفويس داخل السيرفر
                const voiceStates = guild.voiceStates.cache;

                for (const [userId, voiceState] of voiceStates) {
                    // الشروط: أن يكون العضو داخل روم، ليس بوت، ليس ميوت (Mute) أو ديفن (Deafen) لضمان التفاعل الحقيقي
                    if (
                        voiceState.channelId && 
                        !voiceState.member.user.bot && 
                        !voiceState.selfMute && 
                        !voiceState.selfDeaf
                    ) {
                        // إعطاء 1 إكسبي فويس
                        await XpService.addVoiceXp(guildId, userId);
                    }
                }
            }
        } catch (error) {
            logger.error('Error in voice XP ticker loop:', error);
        }
    }, THIRTY_MINUTES);
}
