import pkg from 'pg';
const { Pool } = pkg;

// إنشاء الاتصال بقاعدة البيانات باستخدام الرابط المحفوظ في متغيرات البيئة
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// تصدير دالة الاستعلام لكي نستخدمها في باقي الملفات
export const db = {
    query: (text, params) => pool.query(text, params),
};
