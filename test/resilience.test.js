// أي فشل أثناء «تأكيد الشراء» لا يترك العميل على «⏳ جاري تجهيز…» بلا أزرار، ولا يترك طلبًا عالقًا بلا مراقبة
const assert = require('node:assert/strict');
const { installDb, makeWorld, tick, E, FIXED_ROLE } = require('./helpers');
const st = installDb();
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
const dispatch = (i) => handlers[discord.Events.InteractionCreate][0](i);
const W = makeWorld();
const db = require('../utils/db.js');
process.env.TICKET_STEP_TIMEOUT_MS = '150';
const log = (m) => console.log('✔', m);
let n = 0;

async function ticketFor() {
    const m = W.makeMember('10000000000000' + String(++n).padStart(4, '0'));
    await dispatch(W.interaction('button', { customId: 'shop_request', member: m, channel: W.makeChannel('shop') }));
    return [m, [...W.category.children.cache.values()].find(c => c.topic.includes(m.id))];
}
async function confirm(m, ch, id, tweak) {
    const i = W.interaction('button', { customId: id, member: m, channel: ch });
    tweak?.(i);
    await dispatch(i);
    await tick(400);
    const edits = i.calls.filter(c => c[0] === 'editReply').map(c => c[1]);
    return { i, last: edits.at(-1), ch };
}
const restored = (r) => r.last?.components?.length > 0 && r.last.embeds?.length > 0;
const payEmbedSent = (ch) => ch.sent.some(p => p.embeds?.[0]?.data?.title?.includes('إتمام'));

(async () => {
    // سليم
    let [m, ch] = await ticketFor();
    let r = await confirm(m, ch, 'confirm_1');
    assert.equal(r.last.embeds[0].data.title.includes('إتمام'), true); assert.ok(ch.collector, 'المراقبة بدأت');
    // ضغطة ثانية أثناء وجود دفع جارٍ فعلًا: ترفض بوضوح وترجع الأزرار
    const dupe = await confirm(m, ch, 'confirm_1');
    assert.ok(dupe.last.content.includes('جارية بالفعل') && restored(dupe));
    log('الحالة السليمة + رفض دفع ثانٍ أثناء وجود دفع جارٍ');

    // F2: فحص حد الكوبون يفشل بعد إنشاء الطلب -> يُلغى الطلب وترجع اللوحة
    [m, ch] = await ticketFor();
    const realCount = db.countCouponUses; let calls = 0;
    db.countCouponUses = async (...a) => { if (++calls >= 2) throw new Error('db down'); return realCount(...a); };
    r = await confirm(m, ch, 'confirm_1_1'); db.countCouponUses = realCount;
    assert.ok(restored(r) && r.last.content.includes('تعذّر التحقق')); assert.equal(st.orders.at(-1).status, 'cancelled'); assert.equal(ch.collector, null);
    log('فشل فحص الكوبون: اللوحة ترجع والطلب يُلغى (لا طلب عالق)');

    // بعدها يقدر العميل يحاول من جديد بنجاح
    r = await confirm(m, ch, 'confirm_1_1');
    assert.ok(ch.collector && st.orders.at(-1).status === 'awaiting_payment');
    log('بعد الفشل: المحاولة التالية تنجح');

    // F3: تعديل رسالة الدفع يفشل -> التعليمات تُرسل كرسالة جديدة والمراقبة تبدأ
    [m, ch] = await ticketFor();
    r = await confirm(m, ch, 'confirm_1', (i) => {
        const orig = i.editReply;
        i.editReply = async (p) => { if (p.embeds?.[0]?.data?.title?.includes('إتمام')) throw new Error('Unknown interaction'); return orig(p); };
    });
    assert.ok(payEmbedSent(ch), 'التعليمات وصلت كرسالة جديدة'); assert.ok(ch.collector, 'المراقبة بدأت'); assert.equal(st.orders.at(-1).status, 'awaiting_payment');
    log('فشل تعديل رسالة الدفع: التعليمات تصل كرسالة جديدة والمراقبة تبدأ');

    // F3ب: كل طرق عرض التعليمات تفشل -> يُلغى الطلب وترجع اللوحة
    [m, ch] = await ticketFor();
    ch.send = async (p) => { if (p.embeds?.[0]?.data?.title?.includes('إتمام')) throw new Error('Missing Access'); ch.sent.push(p); return { id: 'x' }; };
    r = await confirm(m, ch, 'confirm_1', (i) => {
        const orig = i.editReply;
        i.editReply = async (p) => { if (p.embeds?.[0]?.data?.title?.includes('إتمام')) throw new Error('Unknown interaction'); return orig(p); };
    });
    assert.equal(st.orders.at(-1).status, 'cancelled'); assert.equal(ch.collector, null);
    log('فشل كل طرق العرض: يُلغى الطلب (لا طلب بلا مراقبة)');

    // F4: فحص المنتج المخصص يعلق
    [m, ch] = await ticketFor();
    const realRoles = db.getCustomRolesByUser; db.getCustomRolesByUser = () => new Promise(() => {});
    r = await confirm(m, ch, 'confirm_2'); db.getCustomRolesByUser = realRoles;
    assert.ok(restored(r) && r.last.content.includes('تعذّر التحقق من المنتج'));
    log('تعليق فحص المنتج: اللوحة ترجع بدل ⏳');

    // F6: كوبون 100% وتعديل الرد يفشل -> التسليم يتم رغم ذلك
    [m, ch] = await ticketFor();
    r = await confirm(m, ch, 'confirm_1_2', (i) => { i.editReply = async () => { throw new Error('Unknown interaction'); }; });
    assert.ok(m.roles.cache.has(FIXED_ROLE)); assert.equal(st.orders.at(-1).status, 'completed');
    log('كوبون 100% + فشل تعديل الرد: الرتبة تُسلَّم رغم ذلك');

    // طلب يتيم: بانتظار الدفع بدون مراقبة -> يُلغى تلقائيًا ويكمل العميل
    [m, ch] = await ticketFor();
    const orphan = await db.createOrder({ channel_id: ch.id, user_id: m.id, username: 'x', product_id: 1, product_name: 'VIP', role_id: FIXED_ROLE, required_amount: 1000, send_amount: 1053, expires_at: new Date(Date.now() + 1e6).toISOString() });
    r = await confirm(m, ch, 'confirm_1');
    assert.equal(st.orders.find(o => o.id === orphan.id).status, 'cancelled'); assert.ok(ch.collector, 'الطلب الجديد يُراقَب');
    log('طلب يتيم بدون مراقبة: يُلغى تلقائيًا ولا يحجب العميل');

    // قفل: بعد كل التعليقات الضغطة التالية ما تقول «جاري تجهيز»
    const again = W.interaction('button', { customId: 'confirm_1', member: m, channel: ch });
    await dispatch(again); await tick(100);
    assert.ok(!JSON.stringify(again.calls).includes('انتظر لحظة'));
    log('القفل محرَّر بعد كل الحالات');

    console.log('\n✅ اختبارات مقاومة تعليق الدفع نجحت');
    process.exit(0);
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
