// يعيد إنتاج أعطال فتح التذاكر: تذكرة فاضية، تعليق عند «جاري فتح تذكرتك»، تذاكر يتيمة
const assert = require('node:assert/strict');
const { installDb, makeWorld, tick, E } = require('./helpers');
const st = installDb();
const dbStub = require('../utils/db.js');

const discord = require('discord.js');
const handlers = {};
discord.Client.prototype.login = async () => 'ok';
for (const m of ['on', 'once']) {
    discord.Client.prototype[m] = function (ev, fn) {
        (handlers[ev] ||= []).push(fn);
        Object.defineProperty(this, 'user', { get: () => ({ id: '555555555555555555', tag: 'bot#0001' }), set() {}, configurable: true });
        return this;
    };
}
require('../index.js');
const { Events } = discord;
const dispatch = (i) => handlers[Events.InteractionCreate][0](i);
const W = makeWorld();
const log = (m) => console.log('✔', m);
const tickets = () => [...W.category.children.cache.values()];
const open = (member) => {
    const i = W.interaction('button', { customId: 'shop_request', member, channel: W.makeChannel('shop') });
    return dispatch(i).then(() => i);
};
const text = (x) => JSON.stringify(x);

(async () => {
    // 1) فشل إرسال لوحة الاختيار داخل التذكرة => لا تبقى تذكرة فاضية، والعضو يقدر يعيد المحاولة
    const A = W.makeMember('111111111111111111');
    const realCreate = W.guild.channels.create;
    W.guild.channels.create = async (o) => { const ch = await realCreate(o); ch.send = async () => { throw new Error('Missing Access'); }; return ch; };
    const i1 = await open(A);
    assert.equal(tickets().length, 0, 'التذكرة الفاضية تُحذف');
    assert.ok(text(i1.last('editReply')).includes('❌'), 'العضو يعرف أن الفتح فشل');
    W.guild.channels.create = realCreate;
    const i1b = await open(A);
    assert.equal(tickets().length, 1, 'إعادة المحاولة تنجح بعد الفشل');
    assert.ok(tickets()[0].sent.length === 1 && text(i1b.last('editReply')).includes('✅'));
    log('فشل إرسال لوحة الاختيار: التذكرة الفاضية تُحذف وإعادة المحاولة تنجح');
    await tickets()[0].delete();

    // 2) فشل editReply (التفاعل انتهى) => التذكرة تبقى كاملة وليست فاضية
    const B = W.makeMember('222222222222222222');
    const i2 = W.interaction('button', { customId: 'shop_request', member: B, channel: W.makeChannel('shop') });
    i2.editReply = async () => { throw new Error('Unknown interaction'); };
    await dispatch(i2);
    const t2 = tickets().find(c => c.topic.includes(B.id));
    assert.ok(t2 && t2.sent.length === 1, 'اللوحة وصلت حتى لو انتهى التفاعل');
    await t2.delete();
    log('انتهاء صلاحية التفاعل: التذكرة تكتمل ولا تبقى فاضية');

    // 3) قاعدة البيانات معلّقة => مهلة بدل تعليق دائم، والقفل يتحرر
    const C = W.makeMember('333333333333333333');
    const realGet = dbStub.getAllProducts;
    dbStub.getAllProducts = () => new Promise(() => {});
    process.env.TICKET_STEP_TIMEOUT_MS = '150';
    const t0 = Date.now();
    const i3 = await open(C);
    assert.ok(Date.now() - t0 < 3000, 'لا تعليق');
    assert.ok(text(i3.last('editReply')).includes('❌'), 'رسالة خطأ واضحة');
    dbStub.getAllProducts = realGet;
    const i3b = await open(C);
    assert.ok(text(i3b.last('editReply')).includes('✅'), 'القفل تحرر وإعادة المحاولة تنجح');
    await tickets().find(c => c.topic.includes(C.id)).delete();
    log('قاعدة بيانات معلّقة: مهلة ورسالة خطأ وتحرر القفل');

    // 4) تعليق في إنشاء القناة نفسها (حدود ديسكورد) => مهلة
    const D = W.makeMember('444444444444444444');
    W.guild.channels.create = () => new Promise(() => {});
    const i4 = await open(D);
    assert.ok(text(i4.last('editReply')).includes('❌'));
    W.guild.channels.create = realCreate;
    log('تعليق إنشاء القناة: مهلة ورسالة خطأ');

    // 5) تنظيف التذاكر اليتيمة الفاضية (بدون أي رسالة) بعد دقيقتين
    const { sweepEmptyTickets } = require('../utils/idleTickets.js');
    const E1 = W.makeMember('555555555555555551');
    const orphan = W.makeChannel('ticket-orphan', { topic: `Echo Shop ticket | owner:${E1.id}` });
    orphan.createdTimestamp = Date.now() - 10 * 60 * 1000;
    W.category.children.cache.set(orphan.id, orphan);
    const fresh = W.makeChannel('ticket-fresh', { topic: `Echo Shop ticket | owner:${E1.id.replace(/1$/, '2')}` });
    fresh.createdTimestamp = Date.now() - 20 * 1000;
    W.category.children.cache.set(fresh.id, fresh);
    const full = W.makeChannel('ticket-full', { topic: `Echo Shop ticket | owner:555555555555555553` });
    full.createdTimestamp = Date.now() - 10 * 60 * 1000;
    full.messages.fetch = async () => new discord.Collection([['1', { id: '1' }]]);
    W.category.children.cache.set(full.id, full);
    const n = await sweepEmptyTickets(W.guild);
    assert.equal(n, 1); assert.ok(orphan.deleted && !fresh.deleted && !full.deleted);
    log('تنظيف التذاكر اليتيمة: الفاضية القديمة فقط');

    // 6) أمر التشخيص
    const { runDiagnostics } = require('../utils/diagnose.js');
    W.category.permissionsFor = () => ({ has: () => true });
    W.guild.members.me.permissions = { has: () => true };
    W.guild.client = { ws: { ping: 40 } }; W.roles.set(E.STAFF_ROLE_ID, { id: E.STAFF_ROLE_ID });
    let d = (await runDiagnostics(W.guild)).data;
    assert.ok(d.description.includes('سوبابيس يستجيب') && d.title.includes('سليم'), d.description);
    W.category.permissionsFor = () => ({ has: (b) => b !== discord.PermissionFlagsBits.ManageChannels });
    st.products.length = 0;
    d = (await runDiagnostics(W.guild)).data;
    assert.ok(d.description.includes('ManageChannels') && d.description.includes('لا توجد منتجات') && d.title.includes('مشاكل'));
    log('أمر التشخيص: يكشف الصلاحيات الناقصة والمنتجات الفارغة');

    console.log('\n✅ اختبارات فتح التذاكر نجحت');
    process.exit(0);
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
