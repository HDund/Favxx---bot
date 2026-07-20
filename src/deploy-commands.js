import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// لإعداد مسارات الملفات في نظام ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

// قراءة جميع الأوامر من مجلد commands
for (const file of commandFiles) {
    const command = await import(`./commands/${file}`);
    if (command.default && 'data' in command.default && 'execute' in command.default) {
        commands.push(command.default.data.toJSON());
    } else {
        console.log(`[تحذير] الملف ${file} ينقصه data أو execute.`);
    }
}

// استخدام التوكن من إعدادات Render
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log(`⏳ جاري تحديث ${commands.length} من أوامر السلاش (Slash Commands)...`);

        // تحديث الأوامر في ديسكورد (تأكد من وجود CLIENT_ID في متغيرات البيئة)
        const data = await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log(`✅ تم تحديث ${data.length} أوامر بنجاح!`);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء تحديث الأوامر:', error);
    }
})();

