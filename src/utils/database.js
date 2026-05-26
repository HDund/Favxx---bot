import { pgDb } from './postgresDatabase.js';

import { MemoryStorage } from './memoryStorage.js';

import { logger } from './logger.js';

import { BotConfig } from '../config/bot.js';

import { normalizeGuildConfig, validateGuildConfigOrThrow } from './schemas.js';

import { DEFAULT_GUILD_CONFIG } from './constants.js';



class DatabaseWrapper {

    constructor() {

        this.initialized = false;

        this.db = null;

        this.useFallback = false;

        this.connectionType = 'none';

        this.degradedModeWarningShown = false;

        this.degradedReason = null;

    }



    async initialize() {

        if (this.initialized) {

            return;

        }



        try {

            logger.info('Attempting to connect to PostgreSQL...');

            const pgConnected = await pgDb.connect();

            if (pgConnected) {

                this.db = pgDb;

                this.connectionType = 'postgresql';

                this.degradedReason = null;

                logger.info('✅ PostgreSQL Database initialized - using persistent database');

                this.initialized = true;

                return;

            }



            const pgFailure = pgDb.getLastFailure?.();

            if (pgFailure?.reason === 'SCHEMA_VERSION_MISMATCH') {

                const schemaError = new Error(

                    `Schema version mismatch detected (${pgFailure.message}). Run migrations before startup.`

                );

                schemaError.code = 'SCHEMA_VERSION_MISMATCH';

                throw schemaError;

            }

        } catch (error) {

            logger.warn('PostgreSQL connection failed:', error.message);



            if (error.code === 'SCHEMA_VERSION_MISMATCH') {

                throw error;

            }

        }



        

        this.db = new MemoryStorage();

        this.useFallback = true;

        this.connectionType = 'memory';

        this.degradedReason = 'POSTGRES_UNAVAILABLE';

        logger.warn('⚠️  DATABASE DEGRADED MODE ENABLED - Using in-memory storage (data will be lost on restart)');

        logger.warn('⚠️  Please check PostgreSQL connection and restart the bot when fixed');

        this.initialized = true;

        this.degradedModeWarningShown = true;

    }



    async set(key, value, ttl = null) {

        if (this.useFallback) {

            logger.debug(`[DEGRADED] Writing to memory: ${key}`);

        }



        if (typeof key === 'string' && /^guild:[^:]+:config$/.test(key)) {

            const guildId = key.split(':')[1];

            validateGuildConfigOrThrow(value, {

                guildId,

                errorCode: 'VALIDATION_FAILED'

            });

        }



        return this.db.set(key, value, ttl);

    }



    async get(key, defaultValue = null) {

        return this.db.get(key, defaultValue);

    }



    async delete(key) {

        if (this.useFallback) {

            logger.debug(`[DEGRADED] Deleting from memory: ${key}`);

        }

        return this.db.delete(key);

    }



    async list(prefix) {

        return this.db.list(prefix);

    }



    async exists(key) {

        if (this.db.exists) {

            return this.db.exists(key);

        }

        const value = await this.db.get(key);

        return value !== null;

    }



    async increment(key, amount = 1) {

        if (this.useFallback) {

            logger.debug(`[DEGRADED] Incrementing in memory: ${key}`);

        }

        if (this.db.increment) {

            return this.db.increment(key, amount);

        }

        const current = await this.db.get(key, 0);

        const newValue = current + amount;

        await this.db.set(key, newValue);

        return newValue;

    }



    async decrement(key, amount = 1) {

        if (this.useFallback) {

            logger.debug(`[DEGRADED] Decrementing in memory: ${key}`);

        }

        if (this.db.decrement) {

            return this.db.decrement(key, amount);

        }

        const current = await this.db.get(key, 0);

        const newValue = current - amount;

        await this.db.set(key, newValue);

        return newValue;

    }



    /**

     * Check if database is in degraded mode (memory-only fallback)

     * @returns {boolean} True if using in-memory storage fallback

     */

    isDegraded() {

        return this.useFallback;

    }



    /**

     * Check if database is fully available (PostgreSQL)

     * @returns {boolean} True if connected to PostgreSQL

     */

    isAvailable() {

        return this.db && !this.useFallback;

    }



    







    getStatus() {

        return {

            initialized: this.initialized,

            connectionType: this.connectionType,

            isDegraded: this.useFallback,

            isAvailable: this.isAvailable(),

            degradedReason: this.degradedReason

        };

    }



    getConnectionType() {

        return this.connectionType;

    }

}



export const db = new DatabaseWrapper();



export async function initializeDatabase() {

    try {

        logger.info("Initializing Database (PostgreSQL > Memory fallback)...");

        await db.initialize();

        logger.info("✅ Database initialized");

        return { db };

    } catch (error) {

        logger.error("❌ Database Initialization Error:", error);



        if (error.code === 'SCHEMA_VERSION_MISMATCH') {

            throw error;

        }



        return { db };

    }

}



export async function getFromDb(key, defaultValue = null) {

    try {

        const value = await db.get(key);

        return value === null ? defaultValue : value;

    } catch (error) {

        logger.error(`Error getting value for key ${key}:`, error);

        return defaultValue;

    }

}



export async function setInDb(key, value, ttl = null) {

    try {

        await db.set(key, value, ttl);

        return true;

    } catch (error) {

        logger.error(`Error setting value for key ${key}:`, error);

        return false;

    }

}



export async function deleteFromDb(key) {

    try {

        await db.delete(key);

        return true;

    } catch (error) {

        logger.error(`Error deleting key ${key}:`, error);

        return false;

    }

}



export async function insertVerificationAudit(record) {

    try {

        if (!db.initialized) {

            await db.initialize();

        }



        if (db.isAvailable() && typeof pgDb.insertVerificationAudit === 'function') {

            return await pgDb.insertVerificationAudit(record);

        }



        const key = `verification:audit:${record.guildId}`;

        const existing = await getFromDb(key, []);

        const auditEntries = Array.isArray(existing) ? existing : [];

        const maxInMemoryAuditEntries = BotConfig?.verification?.maxInMemoryAuditEntries ?? 1000;



        auditEntries.push({

            ...record,

            createdAt: record.createdAt || new Date().toISOString()

        });



        if (auditEntries.length > maxInMemoryAuditEntries) {

            auditEntries.splice(0, auditEntries.length - maxInMemoryAuditEntries);

        }



        await setInDb(key, auditEntries);

        return true;

    } catch (error) {

        logger.error('Error storing verification audit:', error);

        return false;

    }

}



/**

 * Extract actual data from database response (for backward compatibility)

 * @param {any} data - Data to unwrap

 * @returns {any} Unwrapped data

 */

export function unwrapReplitData(data) {

    if (

        typeof data === "object" &&

        data !== null &&

        data.ok !== undefined &&

        data.value !== undefined

    ) {

        return unwrapReplitData(data.value);

    }

    return data;

}



export const getGuildConfigKey = (guildId) => `guild:${guildId}:config`;

export const getGuildBirthdaysKey = (guildId) => `guild:${guildId}:birthdays`;



/**

 * Get or initialize guild configuration

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @returns {Promise<Object>} Guild configuration

 */

export async function getGuildConfig(client, guildId, context = {}) {

    try {

        if (!client.db || typeof client.db.get !== "function") {

            return {};

        }



        const configKey = getGuildConfigKey(guildId);

        const rawConfig = await client.db.get(configKey, {});

        const cleanedConfig = unwrapReplitData(rawConfig);



        return normalizeGuildConfig(cleanedConfig, DEFAULT_GUILD_CONFIG);

    } catch (error) {

        logger.error(`Error fetching config for guild ${guildId}`, {

            error,

            traceId: context.traceId,

            guildId,

            userId: context.userId,

            command: context.command

        });

        return {};

    }

}



/**

 * Save guild configuration

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @param {Object} config - Configuration to save

 * @returns {Promise<boolean>} Success status

 */

export async function setGuildConfig(client, guildId, config, context = {}) {

    try {

        if (!client.db || typeof client.db.set !== "function") {

            logger.error("Database client is not available for setGuildConfig");

            return false;

        }



        const key = getGuildConfigKey(guildId);

        const validated = validateGuildConfigOrThrow(config, { guildId, ...context });

        await client.db.set(key, validated);

        return true;

    } catch (error) {

        logger.error(`Error saving config for guild ${guildId}`, {

            error,

            traceId: context.traceId,

            guildId,

            userId: context.userId,

            command: context.command

        });

        return false;

    }

}



export { DatabaseWrapper, pgDb };



export const getMessage = (key, replacements = {}) => {

    let message = BotConfig.messages[key] || key;

    for (const [k, v] of Object.entries(replacements)) {

        message = message.replace(new RegExp(`\\{${k}\\}`, "g"), v);

    }

    return message;

};



export const getColor = (path, fallback = "#000000") => {

    const parts = path.split(".");

    let current = BotConfig.embeds.colors;



    for (const part of parts) {

        if (current[part] === undefined) {

            logger.warn(`Color path '${path}' not found in config, using fallback`);

            return fallback;

        }

        current = current[part];

    }



    return typeof current === "string" ? current : fallback;

};



/**

 * Get all birthdays for a guild

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @returns {Promise<Object>} Object mapping user IDs to birthday data

 */

export async function getGuildBirthdays(client, guildId) {

    const key = getGuildBirthdaysKey(guildId);

    try {

        if (!client.db || typeof client.db.get !== "function") {

            logger.error("Database client is not available for getGuildBirthdays.");

            return {};

        }



        const rawData = await client.db.get(key, {});

        return unwrapReplitData(rawData) || {};

    } catch (error) {

        logger.error(`Error retrieving birthdays for guild ${guildId}:`, error);

        return {};

    }

}



/**

 * Set a user's birthday

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @param {string} userId - User ID

 * @param {number} month - Month (1-12)

 * @param {number} day - Day (1-31)

 * @returns {Promise<boolean>} Success status

 */

export async function setBirthday(client, guildId, userId, month, day) {

    try {

        if (!client.db || typeof client.db.set !== "function") {

            logger.error("Database client is not available for setBirthday.");

            return false;

        }



        const key = getGuildBirthdaysKey(guildId);

        const birthdays = await getGuildBirthdays(client, guildId);

        birthdays[userId] = { month, day };

        await client.db.set(key, birthdays);

        return true;

    } catch (error) {

        logger.error(`Error setting birthday for user ${userId} in guild ${guildId}:`, error);

        return false;

    }

}



/**

 * Delete a user's birthday

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @param {string} userId - User ID

 * @returns {Promise<boolean>} Success status

 */

export async function deleteBirthday(client, guildId, userId) {

    try {

        if (!client.db || typeof client.db.set !== "function") {

            logger.error("Database client is not available for deleteBirthday.");

            return false;

        }



        const key = getGuildBirthdaysKey(guildId);

        const birthdays = await getGuildBirthdays(client, guildId);

        if (birthdays[userId]) {

            delete birthdays[userId];

            await client.db.set(key, birthdays);

        }

        return true;

    } catch (error) {

        logger.error(`Error deleting birthday for user ${userId} in guild ${guildId}:`, error);

        return false;

    }

}













export function getMonthName(monthNum) {

    const months = [

        'January', 'February', 'March', 'April', 'May', 'June',

        'July', 'August', 'September', 'October', 'November', 'December'

    ];

    const index = Math.max(0, Math.min(monthNum - 1, 11));

    return monthNum >= 1 && monthNum <= 12 ? months[index] : 'Invalid Month';

}





/**

 * Get all giveaways for a guild

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @returns {Promise<Object>} Object mapping message IDs to giveaway data

 */

export async function getGuildGiveaways(client, guildId) {

    const key = giveawayKey(guildId);

    try {

        if (!client.db || typeof client.db.get !== "function") {

            logger.error("Database client is not available for getGuildGiveaways.");

            return {};

        }



        const giveaways = await client.db.get(key, {});

        return unwrapReplitData(giveaways) || {};

    } catch (error) {

        logger.error(`Error getting giveaways for guild ${guildId}:`, error);

        return {};

    }

}



/**

 * Save a giveaway

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @param {Object} giveawayData - The giveaway data to save

 * @returns {Promise<boolean>} Success status

 */

export async function saveGiveaway(client, guildId, giveawayData) {

    try {

        if (!client.db || typeof client.db.set !== "function") {

            logger.error("Database client is not available for saveGiveaway.");

            return false;

        }



        const key = giveawayKey(guildId);

        const giveaways = await getGuildGiveaways(client, guildId);

        

        giveaways[giveawayData.messageId] = giveawayData;

        

        await client.db.set(key, giveaways);

        return true;

    } catch (error) {

        logger.error('Error saving giveaway:', error);

        return false;

    }

}



/**

 * Delete a giveaway

 * @param {Object} client - Discord client with database

 * @param {string} guildId - Guild ID

 * @param {string} messageId - The message ID of the giveaway to delete

 * @returns {Promise<boolean>} Success status

 */

export async function deleteGiveaway(client, guildId, messageId) {

    try {

        const key = giveawayKey(guildId);

        const giveaways = await getGuildGiveaways(client, guildId);

        

        if (giveaways[messageId]) {

            delete giveaways[messageId];

            await client.db.set(key, giveaways);

            return true;

        }

        return false;

    } catch (error) {

        logger.error('Error deleting giveaway:', error);

        return false;

    }

}



/**

 * Get all giveaways that have ended (SQL-optimized for PostgreSQL)

 * Uses the giveaways table index on ends_at for efficient querying

 * @param {Object} client - Discord client with database

 * @returns {Promise<Array>} Array of ended giveaway records

 */

export async function getEndedGiveaways(client) {

    try {

        if (!client.db || !client.db.isAvailable()) {

            logger.warn('Database not available for getEndedGiveaways, using fallback');

            return [];

        }



        const { pgDb } = await import('./postgresDatabase.js');

        const { pgConfig } = await import('../config/postgres.js');

        

        if (!pgDb.isAvailable()) {

            return [];

        }



        const result = await pgDb.pool.query(

            `SELECT id, guild_id, message_id, data, ends_at 

             FROM ${pgConfig.tables.giveaways} 

             WHERE ends_at <= NOW() 

             AND (data->>'ended')::boolean = false

             ORDER BY ends_at ASC`

        );



        return result.rows || [];

    } catch (error) {

        logger.error('Error getting ended giveaways:', error);

        return [];

    }

}



/**

 * Mark a giveaway as ended in the database

 * @param {Object} client - Discord client with database

 * @param {number} giveawayId - The giveaway ID from the database

 * @param {Object} endedData - The updated giveaway data to save

 * @returns {Promise<boolean>} Success status

 */

export async function markGiveawayEnded(client, giveawayId, endedData) {

    try {

        if (!client.db || !client.db.isAvailable()) {

            logger.warn('Database not available for markGiveawayEnded');

            return false;

        }



        const { pgDb } = await import('./postgresDatabase.js');

        const { pgConfig } = await import('../config/postgres.js');

        

        if (!pgDb.isAvailable()) {

            return false;

        }



        await pgDb.pool.query(

            `UPDATE ${pgConfig.tables.giveaways} 

             SET data = $1, updated_at = NOW() 

             WHERE id = $2`,

            [endedData, giveawayId]

        );



        return true;

    } catch (error) {

        logger.error('Error marking giveaway as ended:', error);

        return false;

    }

}



/**

 * Generate a consistent key for giveaways in the database

 * @param {string} guildId - The guild ID

 * @returns {string} The formatted key

 */

export function giveawayKey(guildId) {

    return `guild:${guildId}:giveaways`;

}



export const getGiveawaysKey = giveawayKey;



export function getTicketKey(guildId, channelId) {

    return `guild:${guildId}:ticket:${channelId}`;

}



export function getInviteTrackingKey(guildId) {

    return `guild:${guildId}:invites`;

}



export function getMemberInvitesKey(guildId, userId) {

    return `guild:${guildId}:invites:${userId}`;

}



export function getInviteUsesKey(guildId, inviteCode) {

    return `guild:${guildId}:invite_uses:${inviteCode}`;

}



export function getFakeAccountKey(guildId, userId) {

    return `guild:${guildId}:fake_account:${userId}`;

}



export async function getTicketData(guildId, channelId) {

    if (!db.initialized) {

        await db.initialize();

    }



    const key = getTicketKey(guildId, channelId);

    return await db.get(key);

}



export async function getOpenTicketCountForUser(guildId, userId) {

    try {

        if (!db.initialized) {

            await db.initialize();

        }



        if (db.db?.pool && typeof db.db.isAvailable === 'function' && db.db.isAvailable()) {

            const { pgConfig } = await import('../config/postgres.js');

            const result = await db.db.pool.query(

                `SELECT COUNT(*)::int AS count FROM ${pgConfig.tables.tickets}

                 WHERE guild_id = $1

                   AND data->>'userId' = $2

                   AND data->>'status' = 'open'`,

                [guildId, userId]

            );



            return Number(result.rows?.[0]?.count || 0);

        }



        if (typeof db.list === 'function') {

            const ticketKeys = await db.list(`guild:${guildId}:ticket:`);

            let count = 0;



            for (const key of ticketKeys) {

                const ticket = await getFromDb(key, null);

                if (ticket && ticket.userId === userId && ticket.status === 'open') {

                    count += 1;

                }

            }



            return count;

        }



        return 0;

    } catch (error) {

        logger.error(`Error counting open tickets for user ${userId} in guild ${guildId}:`, error);

        return 0;

    }

}



export async function saveTicketData(guildId, channelId, data) {

    if (!db.initialized) {

        await db.initialize();

    }



    const key = getTicketKey(guildId, channelId);

    await db.set(key, data);

}



export async function deleteTicketData(guildId, channelId) {

    if (!db.initialized) {

        await db.initialize();

    }



    const key = getTicketKey(guildId, channelId);

    await db.delete(key);

}



export function getTicketCounterKey(guildId) {

    return `guild:${guildId}:ticket:counter`;

}



export async function getTicketCounter(guildId) {

    if (!db.initialized) {

        await db.initialize();

    }



    const key = getTicketCounterKey(guildId);

    const counter = await db.get(key);

    return counter || 0;

}



export async function incrementTicketCounter(guildId) {

    if (!db.initialized) {

        await db.initialize();

    }



    const key = getTicketCounterKey(guildId);

    const currentCounter = await getTicketCounter(guildId);

    const nextCounter = currentCounter + 1;

    

    await db.set(key, nextCounter);

    

    // Return padded to 3 digits (001, 002, etc.)

    return nextCounter.toString().padStart(3, '0');

}















export function getEconomyKey(guildId, userId) {

    return `guild:${guildId}:economy:${userId}`;

}















export function getAFKKey(guildId, userId) {

    return `guild:${guildId}:afk:${userId}`;

}













export function getWelcomeConfigKey(guildId) {

    return `guild:${guildId}:welcome`;

}



function normalizeWelcomeConfig(raw = {}) {

    const base = typeof raw === "object" && raw !== null ? raw : {};



    const channelId = base.channelId ?? null;

    const goodbyeChannelId = base.goodbyeChannelId ?? null;



    const welcomeMessage = base.welcomeMessage ?? "Welcome {user} to {server}!";

    const leaveMessage = base.leaveMessage ?? "{user.tag} has left the server.";



    const welcomeEmbed = base.welcomeEmbed ?? {

        title: "🎉 Welcome!",

        description: "Welcome {user} to {server}!",

        color: getColor("success"),

        thumbnail: true,

        footer: "Welcome to {server}!"

    };



    const leaveEmbed = base.leaveEmbed ?? {

        title: "👋 Goodbye",

        description: "{user.tag} has left the server.",

        color: getColor("error"),

        thumbnail: true,

        footer: "Goodbye from {server}!"

    };



    const roleIds = Array.isArray(base.roleIds) ? base.roleIds : [];



    return {

        ...base,

        enabled: Boolean(base.enabled),

        channelId,

        welcomeMessage,

        welcomeEmbed,

        welcomePing: Boolean(base.welcomePing),

        welcomeImage: base.welcomeImage ?? null,

        goodbyeEnabled: Boolean(base.goodbyeEnabled),

        goodbyeChannelId,

        leaveMessage,

        leaveEmbed,

        dmMessage: base.dmMessage ?? "",

        goodbyePing: Boolean(base.goodbyePing),

        roleIds,

        autoRoleDelay: base.autoRoleDelay ?? 0,

        joinLogs: base.joinLogs ?? { enabled: false, channelId: null },

        leaveLogs: base.leaveLogs ?? { enabled: false, channelId: null }

    };

}















export async function getWelcomeConfig(client, guildId) {

    if (!client.db) {

        logger.warn('Database not available for getWelcomeConfig');

        return normalizeWelcomeConfig();

    }

    

    const key = getWelcomeConfigKey(guildId);

    try {

        const config = await client.db.get(key, {});

        const unwrapped = unwrapReplitData(config);

        return normalizeWelcomeConfig(unwrapped);

    } catch (error) {

        logger.error(`Error getting welcome config for guild ${guildId}:`, error);

        return normalizeWelcomeConfig();

    }

}

















export async function saveWelcomeConfig(client, guildId, config) {

    const key = getWelcomeConfigKey(guildId);

    try {

        const existingConfig = await getWelcomeConfig(client, guildId);

        const mergedConfig = { ...existingConfig, ...config };

        

        await client.db.set(key, mergedConfig);

        return true;

    } catch (error) {

        logger.error(`Error saving welcome config for guild ${guildId}:`, error);

        return false;

    }

}

















export async function updateWelcomeConfig(client, guildId, updates) {

    try {

        const currentConfig = await getWelcomeConfig(client, guildId);

        const updatedConfig = { ...currentConfig, ...updates };

        

        await saveWelcomeConfig(client, guildId, updatedConfig);

        return updatedConfig;

    } catch (error) {

        logger.error(`Error updating welcome config for guild ${guildId}:`, error);

        throw error;

    }

}















export function getLevelingKey(guildId) {

    return `guild:${guildId}:leveling:config`;

}















export function getUserLevelKey(guildId, userId) {

    return `guild:${guildId}:leveling:users:${userId}`;

}















export async function getLevelingConfig(client, guildId) {

    const key = getLevelingKey(guildId);

    try {

        const config = await getFromDb(key, {

            enabled: false,

            xpPerMessage: 10,

            xpPerMinute: 60,

            cooldownEnabled: true,

            messageLengthMultiplier: true,

            levelUpMessages: true,

            levelUpChannel: null,

            roles: {},

            milestones: {}

        });

        

        return config;

    } catch (error) {

        logger.error('Error getting leveling config:', error);

        return {

            enabled: false,

            xpPerMessage: 10,

            xpPerMinute: 60,

            cooldownEnabled: true,

            messageLengthMultiplier: true,

            levelUpMessages: true,

            levelUpChannel: null,

            roles: {},

            milestones: {}

        };

    }

}

















export async function saveLevelingConfig(client, guildId, config) {

    const key = getLevelingKey(guildId);

    try {

        await setInDb(key, config);

        return true;

    } catch (error) {

        logger.error(`Error saving leveling config for guild ${guildId}:`, error);

        return false;

    }

}

















export async function getUserLevelData(client, guildId, userId) {

    const key = getUserLevelKey(guildId, userId);

    try {

        const data = await getFromDb(key, null);

        if (!data) {

            return {

                xp: 0,

                level: 0,

                totalXp: 0,

                lastMessage: 0,

                rank: 0,

                xpToNextLevel: getXpForLevel(1)

            };

        }

        

        const levelData = {

            xp: data.xp || 0,

            level: data.level || 0,

            totalXp: data.totalXp || 0,

            lastMessage: data.lastMessage || 0,

            rank: data.rank || 0,

            xpToNextLevel: getXpForLevel((data.level || 0) + 1)

        };

        

        return levelData;

    } catch (error) {

        logger.error(`Error getting level data for user ${userId} in guild ${guildId}:`, error);

        return {

            xp: 0,

            level: 0,

            totalXp: 0,

            lastMessage: 0,

            rank: 0,

            xpToNextLevel: getXpForLevel(1)

        };

    }

}



















export async function saveUserLevelData(client, guildId, userId, data) {

    const key = getUserLevelKey(guildId, userId);

    try {

        const levelData = {

            ...data,

            xp: data.xp || 0,

            level: data.level || 0,

            totalXp: data.totalXp || 0,

            lastMessage: data.lastMessage || 0,

            rank: data.rank || 0,

            updatedAt: Date.now()

        };

        

        await setInDb(key, levelData);

        return true;

    } catch (error) {

        logger.error(`Error saving level data for user ${userId} in guild ${guildId}:`, error);

        return false;

    }

}













export function getXpForLevel(level) {

    return 5 * Math.pow(level, 2) + 50 * level + 50;

}

















export async function getLeaderboard(client, guildId, limit = 10) {

    try {

        if (!client.db || typeof client.db.list !== "function") {

            logger.error("Database client is not available for getLeaderboard.");

            return [];

        }



        const prefix = `guild:${guildId}:leveling:users:`;

        let keys = await client.db.list(prefix);

        

        if (!Array.isArray(keys)) {

            if (typeof keys === 'object' && keys !== null) {

                keys = Object.keys(keys).filter(key => key.startsWith(prefix));

            } else {

                return [];

            }

        }

        

        if (keys.length === 0) {

            return [];

        }

        

        const userDataPromises = keys.map(async (key) => {

            try {

                const userId = key.replace(prefix, '');

                const data = await client.db.get(key);

                if (!data) return null;

                

                const unwrapped = unwrapReplitData(data);

                return {

                    userId,

                    xp: unwrapped.xp || 0,

                    level: unwrapped.level || 0,

                    totalXp: unwrapped.totalXp || 0,

rank: 0

                };

            } catch (error) {

                logger.error(`Error processing leaderboard key ${key}:`, error);

                return null;

            }

        });

        

        let userData = (await Promise.all(userDataPromises)).filter(Boolean);

        

        userData.sort((a, b) => (b.totalXp || 0) - (a.totalXp || 0));

        

        userData = userData.map((user, index) => ({

            ...user,

            rank: index + 1

        }));

        

        return userData.slice(0, limit);

    } catch (error) {

        logger.error(`Error getting leaderboard for guild ${guildId}:`, error);

        return [];

    }

}















export function getApplicationRolesKey(guildId) {

    return `guild:${guildId}:applications:roles`;

}















export async function getApplicationRoles(client, guildId) {

    try {

        if (!client.db || typeof client.db.get !== "function") {

            logger.error("Database client is not available for getApplicationRoles.");

            return [];

        }



        const key = getApplicationRolesKey(guildId);

        const roles = await client.db.get(key, []);

        const unwrappedRoles = unwrapReplitData(roles);

        return Array.isArray(unwrappedRoles) ? unwrappedRoles : [];

    } catch (error) {

        logger.error(`Error getting application roles for guild ${guildId}:`, error);

        return [];

    }

}

















export async function saveApplicationRoles(client, guildId, roles) {

    try {

        if (!client.db || typeof client.db.set !== "function") {

            logger.error("Database client is not available for saveApplicationRoles.");

            return false;

        }



        const key = getApplicationRolesKey(guildId);

        await client.db.set(key, roles);

        return true;

    } catch (error) {

        logger.error(`Error saving application roles for guild ${guildId}:`, error);

        return false;

    }

}













export function getApplicationSettingsKey(guildId) {

    return `guild:${guildId}:applications:settings`;

}















export function getUserApplicationsKey(guildId, userId) {

    return `guild:${guildId}:applications:users:${userId}`;

}















export function getApplicationKey(guildId, applicationId) {

    return `guild:${guildId}:applications:${applicationId}`;

}















export async function getApplicationSettings(client, guildId) {

    if (!client.db) {

        logger.warn('Database not available for getApplicationSettings');

        return {

            enabled: false,

            applicationChannelId: null,

            logChannelId: null,

            questions: [

                "Why do you want to join our staff team?",

                "What experience do you have that would make you a good fit?",

                "How much time can you dedicate to this role?"

            ]

        };

    }

    

    const key = getApplicatio 

