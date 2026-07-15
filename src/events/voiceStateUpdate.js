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
            const joinedVoice = !oldState.channelId && newState.channelId;
            const leftVoice = oldState.channelId && !newState.channelId;
            
            // عند الدخول للروم
            if (joinedVoice) {
                voiceSessions.set(userId, {
                    joinTime: now,
                    isMuted: newState.selfMute || newState.serverMute
                });
            }

            // عند الخروج من الروم أو تبديل الحالة
            if (leftVoice) {
                const session = voiceSessions.get(userId);
                if (session) {
                    const timeSpentMs = now - session.joinTime;
                    const minutesSpent = timeSpentMs / (1000 * 60); // الحساب بالدقائق
                    
                    // منح نقطة واحدة لكل دقيقة (أو عدل المعدل حسب رغبتك)
                    const earnedXp = Math.floor(minutesSpent * 1); 

                    if (earnedXp > 0) {
                        await db.query(`
                            INSERT INTO users_xp (guild_id, user_id, voice_xp) 
                            VALUES ($1, $2, $3) 
                            ON CONFLICT (guild_id, user_id) 
                            DO UPDATE SET voice_xp = users_xp.voice_xp + EXCLUDED.voice_xp;
                        `, [guildId, userId, earnedXp]);
                    }
                    voiceSessions.delete(userId);
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

        // --- الدوال الخاصة بالرومات المؤقتة (تم إبقاؤها كما هي) ---
        async function handleVoiceJoin(client, state, config) { /* ... نفس دالتك السابقة ... */ }
        async function handleVoiceLeave(client, state, config) { /* ... نفس دالتك السابقة ... */ }
        async function handleVoiceMove(client, oldState, newState, config) { /* ... نفس دالتك السابقة ... */ }
        async function createTemporaryChannel(client, state, config) { /* ... نفس دالتك السابقة ... */ }
        async function deleteTemporaryChannel(client, channel, guildId) { /* ... نفس دالتك السابقة ... */ }
        async function transferChannelOwnership(client, channel, guildId, newOwnerId) { /* ... نفس دالتك السابقة ... */ }
    }
};

// الدوال المساعدة للرومات
function sanitizeVoiceChannelName(inputName) { /* ... */ }
function clampVoiceBitrate(value) { /* ... */ }
function cleanupCooldownEntries() { /* ... */ }
function trimCooldownMapIfNeeded() { /* ... */ }

