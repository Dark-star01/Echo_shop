// اختبار تحويل الأخطاء البرمجية إلى ويب هوك
const assert = require('node:assert/strict');

const dbPath = require.resolve('../utils/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSettings: async () => ({ alert_channel_id: '', log_channel_id: '999' }) } };

const posts = [];
global.fetch = async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; };

(async () => {
    const alerts = require('../utils/alerts.js');
    const URL_OK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_-123';

    // بدون ويب هوك ولا client: لا يرمي خطأ ولا يرسل شي
    await alerts.alertError('a', new Error('x'));
    assert.equal(posts.length, 0);

    // رابط غير صالح يُتجاهل
    process.env.ERROR_WEBHOOK_URL = 'https://evil.example.com/hook';
    await alerts.alertError('b', new Error('x2'));
    assert.equal(posts.length, 0, 'لا يرسل لرابط غير ديسكورد');
    assert.equal(alerts.webhookUrl(), null);

    // ويب هوك صالح
    process.env.ERROR_WEBHOOK_URL = URL_OK;
    await alerts.alertError('فشل تجريبي', new Error('boom'), { context: 'ctx' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, URL_OK);
    const e = posts[0].body.embeds[0];
    assert.ok(e.title.includes('فشل تجريبي') && e.description.includes('boom'));
    assert.equal(e.fields[0].value, 'ctx');
    assert.deepEqual(posts[0].body.allowed_mentions.parse, []);
    console.log('✔ الأخطاء البرمجية تُرسل للويب هوك (ولا تذهب لروم اللوق)');

    // نفس الخطأ لا يتكرر خلال 5 دقائق
    await alerts.alertError('فشل تجريبي', new Error('boom'));
    assert.equal(posts.length, 1);
    console.log('✔ منع تكرار نفس الخطأ');

    // منشن اختياري للأخطاء الحرجة فقط
    process.env.ERROR_WEBHOOK_MENTION = '<@&777777777777777777>';
    await alerts.alertError('حرج', new Error('c1'), { ping: true });
    await alerts.alertError('عادي', new Error('c2'));
    assert.equal(posts[1].body.content, '<@&777777777777777777>');
    assert.deepEqual(posts[1].body.allowed_mentions.parse, ['roles', 'users']);
    assert.equal(posts[2].body.content, undefined);
    console.log('✔ المنشن للحرج فقط');

    // فشل الويب هوك لا يرمي خطأ
    global.fetch = async () => ({ ok: false, status: 404 });
    await alerts.alertError('d', new Error('c3'));
    console.log('✔ فشل الويب هوك لا يكسر البوت');

    console.log('\n✅ اختبارات تنبيه الأخطاء نجحت');
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
