import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
    getJoinToCreateConfig, 
    registerTemporaryChannel, 
    unregisterTemporaryChannel,
    getTemporaryChannelInfo,
    formatChannelName
} from '../utils/database.js';
import { sanitizeInput } from '../utils/sanitization.js';
import { logger } from '../utils/logger.js';
import { db } from '../database.js';

const channelCreationCooldown = new Map();
const voiceSessions = new Map();

// الثوابت الخاصة بالرومات المؤقتة
const VOICE_CREATE_COOLDOWN_MS = 2000;
const DEFAULT_VOICE_BITRATE = 64000;
const MAX_VOICE_BITRATE = 384000;
const MIN_VOICE_BITRATE = 8000;
const MAX_CHANNEL_NAME_LENGTH = 100;
const FALLBACK_CHANNEL_NAME = 'Voice Room';
const MAX_TRACKED_COOLDOWNS = 10000;

export default {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        if ((newState.member && newState.member.user.bot) || (oldState.member && oldState.member.user.bot)) return;

        const guildId = newState.guild?.id || oldState.guild?.id;
        const userId = newState.member?.id || oldState.member?.id;
        if (!guildId || !userId) return;

        // ==========================================
        // [1] نظام حساب نقاط الخبرة الصوتية (Voice XP) 
        // ==========================================
        try {
            const now = Date.now();
            
            // نتحقق من حالة الـ Deafen (السماعة) فقط، الميوت العادي يُعامل كطبيعي
            const isDeaf = newState.selfDeaf || newState.serverDeaf;
            const wasDeaf = oldState.selfDeaf || oldState.serverDeaf;

            const joinedVoice = !oldState.channelId && newState.channelId;
            const leftVoice = oldState.channelId && !newState.channelId;
            
            // تحقق ما إذا قام العضو بتشغيل أو إيقاف السماعة (Deafen) وهو لا يزال داخل الروم
            const deafStateChanged = oldState.channelId && newState.channelId && (isDeaf !== wasDeaf);

            // الحالة الأولى: دخل الروم
            if (joinedVoice) {
                voiceSessions.set(userId, { startTime: now, isDeaf: isDeaf });
            }

            // الحالة الثانية: طلع من الروم، أو غيّر حالة السماعة (Deafen)
            if (leftVoice || deafStateChanged) {
                const session = voiceSessions.get(userId);
                
                if (session) {
                    const timeSpentMs = now - session.startTime;
                    const minutesSpent = timeSpentMs / 60000; // تحويل الملي ثانية إلى دقائق
                    
                    // تحديد سرعة النقاط: 32 للـ Deafen و 64 للطبيعي/الميوت
                    const ratePerMinute = session.isDeaf ? 32 : 64;
                    
                    // حساب النقاط المكتسبة
                    const earnedXp = Math.floor(minutesSpent * ratePerMinute);

                    if (earnedXp > 0) {
                        await db.query(`
                            INSERT INTO users_xp (guild_id, user_id, voice_xp, text_xp, valid_message_count) 
                            VALUES ($1, $2, $3, 0, 0) 
                            ON CONFLICT (guild_id, user_id) 
                            DO UPDATE SET voice_xp = users_xp.voice_xp + EXCLUDED.voice_xp;
                        `, [guildId, userId, earnedXp]);
                    }
                    
                    // إذا كان العضو لا يزال بالروم وغير حالته فقط، نبدأ له جلسة جديدة بالحالة الجديدة
                    if (deafStateChanged) {
                        voiceSessions.set(userId, { startTime: now, isDeaf: isDeaf });
                    } else {
                        // إذا خرج من الروم نمسح الجلسة تماماً
                        voiceSessions.delete(userId);
                    }
                } else if (deafStateChanged) {
                     // احتياطياً في حال لم يتم العثور على جلسة سابقة
                     voiceSessions.set(userId, { startTime: now, isDeaf: isDeaf });
                }
            }
        } catch (xpError) {
            logger.error("Error in Voice XP tracking system:", xpError);
        }

        // ==========================================
        // [2] نظام إنشاء الرومات المؤقتة (Join to Create)
        // ==========================================
        const cooldownKey = `${guildId}-${userId}`;
        cleanupCooldownEntries();

        try {
            const config = await getJoinToCreateConfig(client, guildId);
            if (!config || !config.enabled || !config.triggerChannels || config.triggerChannels.length === 0) return;

            if (!oldState.channel && newState.channel) await handleVoiceJoin(client, newState, config);
            if (oldState.channel && !newState.channel) await handleVoiceLeave(client, oldState, config);
            if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
                await handleVoiceMove(client, oldState, newState, config);
            }
        } catch (error) {
            logger.error(`Error in voiceStateUpdate JoinToCreate for guild ${guildId}:`, error);
        }
    }
};

// ==========================================
// --- الدوال الخاصة بالرومات المؤقتة (اتركها كما هي في ملفك ولا تحذفها) ---
// ==========================================

