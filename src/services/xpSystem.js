import { logger } from '../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData } from './leveling.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { Mutex } from '../utils/mutex.js';
import { getFromDb, setInDb } from '../utils/database.js'; // للتأكد من ربطه بالداتابيز للعدادات

// ==========================================
// خوارزمية ذكية لفلترة الرسائل المفيدة ومنع السبام
// ==========================================
export function isUsefulMessage(message) {
  const content = message.content.trim();

  // 1. منع الرسائل القصيرة جداً (مثل: هههه، ت، هلو، يس، واو)
  if (content.length < 8) return false;

  // 2. منع التكرار العشوائي للحروف (مثال: هههههههههههههه أو هلالالالالا)
  const hasRepeatedChars = /(.)\1{4,}/.test(content); 
  if (hasRepeatedChars) return false;

  // 3. فحص تكرار الكلمات (إذا كان يكرر نفس الكلمة ليطول الرسالة عبثاً)
  const words = content.split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 3 && (uniqueWords.size / words.length) < 0.5) return false;

  return true;
}

// ==========================================
// الدالة الرئيسية لإضافة الـ XP (تتعامل مع التكست والفويس)
// ==========================================
export async function addXp(client, guild, member, xpToAdd) {
  const lockKey = `leveling:${guild.id}:${member.user.id}`;
  return await Mutex.runExclusive(lockKey, async () => {
    try {
      if (!xpToAdd || xpToAdd <= 0) {
        return { success: false, reason: 'Invalid XP amount' };
      }

      const config = await getLevelingConfig(client, guild.id);
      
      if (!config.enabled) {
        return { success: false, reason: 'Leveling is disabled in this server' };
      }
      
      const levelData = await getUserLevelData(client, guild.id, member.user.id);
      
      levelData.xp += xpToAdd;
      levelData.totalXp += xpToAdd;
      levelData.lastMessage = Date.now();
      
      // التعامل مع الارتفاع في المستويات (حتى لو قفز عدة مستويات دفعة واحدة)
      let xpNeededForNextLevel = getXpForLevel(levelData.level);
      let didLevelUp = false;
      const initialLevel = levelData.level;

      while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
        levelData.xp -= xpNeededForNextLevel;
        levelData.level += 1;
        didLevelUp = true;
        xpNeededForNextLevel = getXpForLevel(levelData.level);

        logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

        // إعطاء الرتبة المخصصة للمستوى الحالي إذا كانت موجودة بالإعدادات
        if (config.roleRewards && config.roleRewards[levelData.level]) {
          await awardRoleReward(guild, member, config.roleRewards[levelData.level], levelData.level);
        }
      }

      if (didLevelUp) {
        // إرسال رسالة تبريكات في الروم المخصصة
        if (config.announceLevelUp) {
          await sendLevelUpAnnouncement(guild, member, levelData, config);
        }

        // تسجيل الحدث في نظام اللوج الخاص بك
        try {
          await logEvent({
            client,
            guildId: guild.id,
            eventType: EVENT_TYPES.LEVELING_LEVELUP,
            data: {
              description: `${member.user.tag} reached level ${levelData.level}`,
              userId: member.user.id,
              fields: [
                { name: '👤 Member', value: `${member.user.tag} (${member.user.id})`, inline: true },
                { name: '📊 New Level', value: levelData.level.toString(), inline: true },
                { name: '📈 Levels Gained', value: (levelData.level - initialLevel).toString(), inline: true },
                { name: '✨ Total XP', value: levelData.totalXp.toString(), inline: true }
              ]
            }
          });
        } catch (logError) {
          logger.debug('Failed to log leveling event:', logError.message);
        }
      }
      
      await saveUserLevelData(client, guild.id, member.user.id, levelData);
      
      return {
        success: true,
        level: levelData.level,
        xp: levelData.xp,
        totalXp: levelData.totalXp,
        xpNeeded: getXpForLevel(levelData.level + 1),
        leveledUp: didLevelUp
      };
      
    } catch (error) {
      logger.error('Error adding XP:', error);
      return { success: false, error: error.message };
    }
  });
}

// ==========================================
// كلاس الخدمات لإدارة نظام الفويس وتتبع عداد الرسائل
// ==========================================
export class XpService {
  
  // 1. تتبع رسائل التكست المفيدة (كل 10 رسائل مفيدة تعطي 1 XP)
  static async trackTextMessage(client, guild, member, message) {
    try {
      // فحص هل الرسالة مفيدة وتخطت الفلتر؟
      if (!isUsefulMessage(message)) return null;

      const counterKey = `xp:text:counter:${guild.id}:${member.user.id}`;
      let usefulMessagesCount = await getFromDb(counterKey, 0);
      usefulMessagesCount += 1;

      // عند الوصول لـ 10 رسائل مفيدة
      if (usefulMessagesCount >= 10) {
        await setInDb(counterKey, 0); // تصفير العداد
        
        // استدعاء دالة إضافة الـ XP الأصلية لرفع مستواه ومنحه الرتب تلقائياً
        return await addXp(client, guild, member, 1);
      }

      await setInDb(counterKey, usefulMessagesCount);
      return { leveledUp: false, count: usefulMessagesCount };
    } catch (error) {
      logger.error('Error tracking text XP:', error);
      return null;
    }
  }

  // 2. إضافة إكسبي الفويس وسحب نقاط مستقلة للفويس
  static async addVoiceXp(guildId, userId) {
    try {
      const key = `xp:voice:${guildId}:${userId}`;
      let currentXp = await getFromDb(key, 0);
      currentXp += 1;
      await setInDb(key, currentXp);
      return currentXp;
    } catch (error) {
      logger.error('Error adding voice XP:', error);
      return 0;
    }
  }

  // 3. دالة جلب لوحة الصدارة (Top 5 فويس وتكست) لحدث الـ Leaderboard
  static async getLeaderboard(guildId, client) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return { topText: [], topVoice: [] };

      const members = await guild.members.fetch();
      const textList = [];
      const voiceList = [];

      for (const [memberId, member] of members) {
        if (member.user.bot) continue;
        
        // جلب إجمالي الـ XP النصي (من الـ levelData الحقيقي لبوتك)
        const levelData = await getUserLevelData(client, guildId, memberId);
        const textXp = levelData?.totalXp || 0;

        // جلب إكسبي الفويس
        const voiceXp = await getFromDb(`xp:voice:${guildId}:${memberId}`, 0);

        if (textXp > 0) textList.push({ userId: memberId, xp: textXp });
        if (voiceXp > 0) voiceList.push({ userId: memberId, xp: voiceXp });
      }

      const topText = textList.sort((a, b) => b.xp - a.xp).slice(0, 5);
      const topVoice = voiceList.sort((a, b) => b.xp - a.xp).slice(0, 5);

      return { topText, topVoice };
    } catch (error) {
      logger.error('Error fetching leaderboard:', error);
      return { topText: [], topVoice: [] };
    }
  }
}

// ==========================================
// الدوال المساعدة الأصلية للبوت (رتب الترقية والإعلانات)
// ==========================================
async function awardRoleReward(guild, member, roleId, level) {
  try {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      logger.warn(`Role ${roleId} not found for level ${level} reward in guild ${guild.id}`);
      return;
    }
    if (member.roles.cache.has(roleId)) return;

    await member.roles.add(role, `Level ${level} reward`);
    logger.info(`✅ Awarded role ${role.name} to ${member.user.tag} for reaching level ${level}`);
  } catch (error) {
    logger.error(`Failed to award role reward to ${member.user.id}:`, error);
  }
}

async function sendLevelUpAnnouncement(guild, member, levelData, config) {
  try {
    const levelUpChannel = config.levelUpChannel 
      ? guild.channels.cache.get(config.levelUpChannel) 
      : guild.systemChannel;
    
    if (!levelUpChannel || !levelUpChannel.isTextBased()) return;

    const permissions = levelUpChannel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions to send levelup message in ${levelUpChannel.id}`);
      return;
    }

    const message = config.levelUpMessage
      .replace(/{user}/g, member.toString())
      .replace(/{level}/g, levelData.level)
      .replace(/{xp}/g, levelData.xp)
      .replace(/{xpNeeded}/g, getXpForLevel(levelData.level + 1));
    
    await levelUpChannel.send(message).catch(error => {
      logger.error(`Failed to send level up message in channel ${levelUpChannel.id}:`, error);
    });
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
  }
}
