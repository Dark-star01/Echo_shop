// اختبارات تكاملية: نحمّل index.js الحقيقي ونمرر له تفاعلات محاكاة (بدون ديسكورد ولا قاعدة حقيقية)
const assert = require('node:assert/strict');
const { installDb, makeWorld, tick, waitFor, E, FIXED_ROLE } = require('./helpers');
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
const { Events } = discord;
const dispatch = (i) => handlers[Events.InteractionCreate][0](i);
const onMessage = (m) => handlers[Events.MessageCreate][0](m);
const W = makeWorld();
const text = (x) => JSON.stringify(x);
const log = (m) => console.log('✔', m);

async function openTicket(member) {
    await dispatch(W.interaction('button', { customId: 'shop_request', member, channel: W.makeChannel('shop') }));
    return [...W.category.children.cache.values()].find(c => c.topic.includes(`owner:${member.id}`));
}
const press = (customId, member, channel, extra = {}) => {
    const kind = extra.values ? 'select' : extra.fields ? 'modal' : 'button';
    const i = W.interaction(kind, { customId, member, channel, ...extra });
    return dispatch(i).then(() => i);
};
const pay = async (ch, member, amount) => {
    await waitFor(() => ch.collector, 'collector');
    assert.ok(W.proBot(ch, `<@${member.id}> has transferred \`$${amount}\` to <@${E.BANK_USER_ID}>`), 'ProBot message accepted');
};

(async () => {
    // ===== شراء رتبة جاهزة + كوبون 50% =====
    const A = W.makeMember('111111111111111111');
    const chA = await openTicket(A);
    assert.ok(chA && chA.sent[0].components.length === 2);
    const dup = W.interaction('button', { customId: 'shop_request', member: A, channel: W.makeChannel('shop') });
    await dispatch(dup);
    assert.ok(text(dup.last('editReply')).includes('عندك تذكرة مفتوحة'));
    log('فتح تذكرة + منع التذكرة المكررة');

    const stranger = W.makeMember('555000000000000001');
    const denied = await press('select_role', stranger, chA, { values: ['1'] });
    assert.ok(denied.last('reply').content.includes('خاص بصاحب التذكرة'));
    const sel = await press('select_role', A, chA, { values: ['1'] });
    assert.equal(sel.last('update').embeds[0].data.title, '📦 VIP');
    assert.deepEqual(sel.last('update').components[0].components.map(c => c.data.custom_id), ['confirm_1', 'coupon_1', 'cancel_1']);
    log('اختيار منتج + حماية الأزرار لصاحب التذكرة');

    assert.ok((await press('coupon_1', A, chA)).last('showModal'));
    const cm = await press('couponmodal_1', A, chA, { fields: { code: 'half' } });
    assert.ok(cm.last('update').embeds[0].data.description.includes('HALF'));
    assert.ok(cm.last('update').components[0].components[0].data.custom_id === 'confirm_1_1');
    const bad = await press('couponmodal_1', A, chA, { fields: { code: 'nope' } });
    assert.ok(bad.last('reply').content.includes('❌'));
    log('كوبون: إدخال صحيح وخاطئ');

    await press('confirm_1_1', A, chA);
    const oA = st.orders[0];
    assert.equal(oA.required_amount, 500); assert.equal(oA.discount_percent, 50); assert.equal(oA.original_amount, 1000); assert.equal(oA.send_amount, 527);
    await pay(chA, A, 500);
    await waitFor(() => st.orders[0].status === 'completed', 'order A completed');
    assert.ok(A.roles.cache.has(FIXED_ROLE));
    const again = await press('couponmodal_1', A, chA, { fields: { code: 'HALF' } });
    assert.ok(again.last('reply').content.includes('استخدمت هذا الكوبون'));
    log('دفع بعد الخصم (527 مع الضريبة) -> رتبة + حد الكوبون للفرد');

    // ===== وضع with tax =====
    st.settings.payment_mode = 'with_tax';
    const B = W.makeMember('222222222222222222'); const chB = await openTicket(B);
    await press('select_role', B, chB, { values: ['1'] });
    const cb = await press('confirm_1', B, chB);
    assert.ok(cb.last('editReply').embeds[0].data.description.includes(`C ${E.BANK_USER_ID} 1000 with tax`));
    assert.equal(st.orders.at(-1).send_amount, 1000);
    const copy = await press('copy_transfer_1000_tax', B, chB);
    assert.ok(copy.last('reply').content.includes('1000 with tax'));
    st.settings.payment_mode = 'calculated';
    log('وضع with tax: الأمر والمبلغ وزر النسخ');

    // ===== خصم 100% =====
    const C = W.makeMember('333333333333333333'); const chC = await openTicket(C);
    await press('confirm_1_2', C, chC);
    await waitFor(() => C.roles.cache.has(FIXED_ROLE), 'free role');
    assert.equal(chC.collector, null);
    log('كوبون 100%: تسليم مباشر بدون دفع');

    // ===== رتبة قابلة للإنشاء =====
    const D = W.makeMember('444444444444444444'); const chD = await openTicket(D);
    await press('select_role', D, chD, { values: ['2'] });
    await press('confirm_2', D, chD);
    const oD = st.orders.find(o => o.product_type === 'custom');
    assert.equal(oD.send_amount, 2106);
    await pay(chD, D, 2000);
    await waitFor(() => oD.status === 'customizing', 'customizing');
    const panel = chD.sent.at(-1);
    assert.ok(panel.components[0].components[0].data.custom_id.startsWith('cust_mode_'));
    log('بعد الدفع تظهر لوحة التخصيص');

    const id = oD.id;
    await press(`cust_mode_${id}`, D, chD, { values: ['gradient'] });
    assert.equal(oD.draft.mode, 'gradient');
    assert.equal((await press(`cust_edit_${id}`, D, chD)).last('showModal').components.length, 3);
    assert.ok((await press(`cust_modal_${id}`, D, chD, { fields: { name: 'bad one', color1: '#FF5733', color2: '#3366FF' } })).last('reply').content.includes('غير مسموحة'));
    assert.ok((await press(`cust_modal_${id}`, D, chD, { fields: { name: 'X', color1: 'zzz', color2: '#3366FF' } })).last('reply').content.includes('غير صالح'));
    assert.ok((await press(`cust_confirm_${id}`, D, chD)).last('reply').content.includes('اكتب اسم'));
    await press(`cust_modal_${id}`, D, chD, { fields: { name: 'Cool Role', color1: '#ff5733', color2: '3366ff' } });
    assert.deepEqual([oD.draft.name, oD.draft.color1, oD.draft.color2], ['Cool Role', '#FF5733', '#3366FF']);
    assert.ok((await press(`cust_preview_${id}`, D, chD)).last('reply').embeds[0]);
    const ic = await press(`cust_icon_${id}`, D, chD);
    assert.ok(text(ic.last('followUp')).includes('انتهى الوقت'));
    log('تخصيص: نمط، مودال، كلمات ممنوعة، ألوان خاطئة، معاينة، أيقونة');

    await press(`cust_confirm_${id}`, D, chD);
    await waitFor(() => oD.status === 'completed', 'custom role created');
    const call = W.guild.roles.createCalls[0];
    assert.deepEqual(call.colors, { primaryColor: 0xFF5733, secondaryColor: 0x3366FF });
    assert.equal(call.permissions.length, 2);
    const created = W.roles.get(oD.role_id);
    assert.equal(created.position, 9, 'الرتبة تحت المرجع مباشرة');
    assert.ok(D.roles.cache.has(created.id));
    assert.equal(st.customRoles[0].user_id, D.id); assert.equal(st.customRoles[0].product_id, 2);
    log('إنشاء الرتبة: ألوان، صلاحيات، موضع تحت المرجع، ربط في القاعدة');

    // ===== تعديل الرتبة =====
    await chD.delete();
    const nobody = W.makeMember('666000000000000001');
    assert.ok((await press('shop_edit', nobody, W.makeChannel('shop'))).last('reply').content.includes('لازم تشتري'));
    const cool = await press('shop_edit', D, W.makeChannel('shop'));
    assert.ok(text(cool.last('editReply')).includes('⏳'), 'فترة الانتظار');
    st.customRoles[0].last_edited_at = new Date(Date.now() - 10 * 864e5).toISOString();
    const ed = await press('shop_edit', D, W.makeChannel('shop'));
    assert.ok(text(ed.last('editReply')).includes('تم فتح تذكرة التعديل'));
    const chE = [...W.category.children.cache.values()].find(c => c.name.startsWith('edit-'));
    const oE = st.orders.find(o => o.product_type === 'custom_edit');
    assert.equal(oE.draft.name, 'Cool Role'); assert.equal(oE.draft.mode, 'gradient'); assert.equal(oE.draft.color1, '#FF5733');
    await waitFor(() => chE.sent.length, 'edit panel');
    assert.equal(chE.sent.at(-1).embeds[0].data.title, '🎨 عدّل رتبتك');
    await press(`cust_modal_${oE.id}`, D, chE, { fields: { name: 'Renamed', color1: '#FF5733', color2: '#3366FF' } });
    await press(`cust_confirm_${oE.id}`, D, chE);
    await waitFor(() => oE.status === 'completed', 'edit completed');
    assert.equal(created.name, 'Renamed'); assert.equal(st.customRoles[0].name, 'Renamed');
    assert.ok(Date.now() - new Date(st.customRoles[0].last_edited_at) < 5000);
    log('تعديل الرتبة: مرفوض لغير المشتري، فترة انتظار، ثم تعديل ناجح');

    // ===== إغلاق الأزرار + أوامر الستاف =====
    const F = W.makeMember('777000000000000001'); const chF = await openTicket(F);
    const S = W.makeMember('777000000000000099', { staff: true });
    st.orders.push({ id: 900, channel_id: chF.id, user_id: F.id, status: 'role_failed', product_name: 'VIP', role_id: FIXED_ROLE, product_type: 'fixed', required_amount: 1, created_at: new Date().toISOString() });
    assert.ok((await press('close_ticket', F, chF)).last('reply').content.includes('قيد المعالجة'));
    const msg = (content, member, channel) => ({ author: { bot: false, id: member.id, tag: member.user.tag }, guild: W.guild, content, channel, member, mentions: { members: { first: () => null } }, replies: [], reply: async function (p) { this.replies.push(p); } });
    const m1 = msg('$حذف', F, chF); await onMessage(m1); await tick();
    assert.equal(m1.replies.length, 0); assert.equal(chF.deleted, false);
    const help = msg('$مساعدة', S, chF); await onMessage(help); await tick();
    assert.ok(help.replies[0].content.includes('$غلق'));
    const guard = msg('$حذف', S, chF); await onMessage(guard); await tick();
    assert.ok(guard.replies[0].content.includes('تأكيد')); assert.equal(chF.deleted, false);
    const retry = msg('$اعادة', S, chF); await onMessage(retry); await tick(60);
    assert.ok(F.roles.cache.has(FIXED_ROLE)); assert.equal(st.orders.find(o => o.id === 900).status, 'completed');
    st.orders.find(o => o.id === 900).status = 'role_failed';
    await onMessage(msg('$حذف تأكيد', S, chF)); await tick(80);
    assert.equal(chF.deleted, true); assert.equal(st.orders.find(o => o.id === 900).status, 'closed_manually');
    log('أوامر الستاف: تجاهل غير الستاف، مساعدة، حماية الطلب المدفوع، إعادة تسليم، حذف بتأكيد');

    // ===== متفرقات =====
    const { buildShopMessage } = require('../utils/shopMessage.js');
    assert.ok(buildShopMessage(await require('../utils/db.js').getAllProducts()).embeds[0].data.description.includes('رتبة قابلة للإنشاء'));
    await require('../utils/alerts.js').alertError('x', new Error('y')); // بدون client ما يرمي خطأ
    log('إمبد المتجر + التنبيهات');

    console.log('\n✅ كل الاختبارات التكاملية نجحت');
    process.exit(0);
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
