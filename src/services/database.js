import pkg from 'pg';
const { Pool } = pkg;

// إعداد الاتصال بقاعدة البيانات
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// إضافة مستمع للأخطاء لمنع توقف البوت عند فقدان الاتصال
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});

// تصدير دالة الاستعلام مع تحسينات
export const db = {
    /**
     * تنفيذ استعلام SQL
     * @param {string} text - نص الاستعلام
     * @param {Array} params - المتغيرات
     */
    query: async (text, params) => {
        try {
            return await pool.query(text, params);
        } catch (error) {
            console.error('Database Query Error:', error);
            throw error; // نترك الخطأ ليتم التعامل معه في ملفات الـ events/commands
        }
    },

    // إضافة هذه الدالة اختياري: للتأكد من حالة الاتصال عند تشغيل البوت
    testConnection: async () => {
        try {
            await pool.query('SELECT NOW()');
            console.log('✅ Connected to Database successfully!');
        } catch (err) {
            console.error('❌ Database connection failed:', err);
        }
    }
};
