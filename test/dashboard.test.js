// اختبار API الداشبورد الحقيقي (server.js) مع جلسة موقّعة وسيرفر ديسكورد محاكى
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installDb, makeWorld, tick, E, REF_ROLE, FIXED_ROLE } = require('./helpers');
const st = installDb();
const W = makeWorld();

const admin = W.makeMember(E.ID_OWNER); // المالك (ID_OWNER)
const outsider = W.makeMember('900000000000000002');
const helper = W.makeMember('900000000000000003'); // مشرف سيُضاف للوايت لست
const textChannel = W.makeChannel('logs'); textChannel.isTextBased = () => true;
W.guild.channels.cache.set(textChannel.id, textChannel);
W.roles.set('790000000000000000', { id: '790000000000000000', name: 'too-high', position: 60, managed: false });
const client = { user: { id: '555555555555555555' }, guilds: { cache: { get: () => W.guild } },
    users: { fetch: async (id) => (['900000000000000003', '900000000000000004'].includes(id) ? { id, username: 'user' + id.slice(-1), globalName: 'User ' + id.slice(-1) } : Promise.reject(new Error('Unknown User'))) } };

const BASE = 'http://localhost:3987';
const cookieFor = (uid, exp = Date.now() + 1e6) => {
    const body = Buffer.from(JSON.stringify({ uid, name: 'Tester', avatar: null, exp })).toString('base64url');
    return `echo_session=${body}.${crypto.createHmac('sha256', E.SESSION_SECRET).update(body).digest('base64url')}`;
};
const call = async (method, path, body, { cookie = cookieFor(admin.id), origin = BASE } = {}) => {
    const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...(origin && { origin }) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
};
const log = (m) => console.log('✔', m);

(async () => {
    require('../dashboard/server.js').start(client);
    await tick(300);

    // ---- الدخول والحماية ----
    assert.equal((await fetch(BASE + '/')).status, 200);
    assert.equal((await call('GET', '/api/me', null, { cookie: null })).status, 401);
    assert.equal((await call('GET', '/api/me', null, { cookie: cookieFor(outsider.id) })).status, 401, 'بدون الرتبة');
    assert.equal((await call('GET', '/api/me', null, { cookie: cookieFor(admin.id, Date.now() - 1) })).status, 401, 'جلسة منتهية');
    assert.equal((await call('GET', '/api/me', null, { cookie: cookieFor(admin.id).slice(0, -3) + 'abc' })).status, 401, 'توقيع مزوّر');
    assert.equal((await call('POST', '/api/products', {}, { origin: 'http://evil.com' })).status, 403, 'origin غريب');
    assert.equal((await call('GET', '/api/me')).data.name, 'Tester');
    assert.equal((await call('GET', '/api/me')).data.isOwner, true);
    log('تسجيل الدخول: جلسة موقّعة، انتهاء، تزوير، origin، غير المسموح مرفوض');

    // ---- 🔐 الوايت لست: المالك فقط يديرها ----
    const asHelper = { cookie: cookieFor(helper.id) };
    assert.equal((await call('GET', '/api/me', null, asHelper)).status, 401, 'غير مضاف = مرفوض');
    assert.equal((await call('POST', '/api/access', { user_id: 'abc' })).status, 400);
    assert.equal((await call('POST', '/api/access', { user_id: E.ID_OWNER })).status, 400, 'المالك لا يُضاف');
    assert.equal((await call('POST', '/api/access', { user_id: '900000000000009999' })).status, 400, 'ID غير موجود في ديسكورد');
    const added = await call('POST', '/api/access', { user_id: helper.id, note: 'مشرف المتجر' });
    assert.equal(added.status, 200); assert.equal(added.data.user.username, 'User 3'); assert.equal(added.data.user.added_by, E.ID_OWNER);
    assert.equal((await call('POST', '/api/access', { user_id: helper.id })).status, 409, 'مضاف مسبقاً');
    const me2 = await call('GET', '/api/me', null, asHelper);
    assert.equal(me2.status, 200); assert.equal(me2.data.isOwner, false, 'المضاف يدخل فورًا');
    assert.equal((await call('GET', '/api/products', null, asHelper)).status, 200);
    assert.equal((await call('GET', '/api/access', null, asHelper)).status, 403, 'المشرف لا يرى القائمة');
    assert.equal((await call('POST', '/api/access', { user_id: '900000000000000004' }, asHelper)).status, 403, 'المشرف لا يضيف غيره');
    assert.equal((await call('GET', '/api/audit', null, asHelper)).status, 403, 'المشرف لا يرى السجل');
    assert.equal((await call('GET', '/api/access')).data.users.length, 1);
    log('الوايت لست: المالك يضيف، المضاف يدخل فورًا، ولا يرى القائمة ولا السجل');

    // ---- الهوية العامة (شعار الداشبورد) ----
    const brand = await call('GET', '/brand.json', null, { cookie: null });
    assert.equal(brand.status, 200, 'متاح بدون تسجيل دخول');
    assert.equal(brand.data.name, 'Echo Shop', 'اسم احتياطي لو البوت ما عنده اسم');
    assert.deepEqual(Object.keys(brand.data).sort(), ['avatar', 'name'], 'لا بيانات حساسة');
    log('الهوية: /brand.json عام ويرجع الاسم والأفتار فقط');

    // ---- المنتجات ----
    const P = (b) => call('POST', '/api/products', { name: 'T', price: 100, ...b });
    assert.equal((await P({ type: 'fixed', role_id: 'abc' })).status, 400);
    assert.equal((await P({ type: 'fixed', role_id: '123456789012345678' })).status, 400, 'رتبة غير موجودة بالسيرفر');
    assert.equal((await P({ type: 'fixed', role_id: FIXED_ROLE, price: -1 })).status, 400);
    const freeP = await P({ type: 'custom', price: 0, name: 'FreeP' });
    assert.equal(freeP.status, 200, 'السعر 0 مسموح (منتج مجاني)');
    await call('DELETE', `/api/products/${freeP.data.product.id}`);
    assert.equal((await P({ type: 'fixed', role_id: FIXED_ROLE, duration_days: 0 })).status, 400);
    const okFixed = await P({ type: 'fixed', role_id: FIXED_ROLE, duration_days: '30' });
    assert.equal(okFixed.status, 200); assert.equal(okFixed.data.product.duration_days, 30);
    const okCustom = await P({ type: 'custom', role_id: 'ignored', duration_days: 5, custom_settings: { color_modes: ['gradient', 'bogus'], permissions: ['ChangeNickname', 'Administrator', 'ManageRoles'], max_name_length: 500, banned_words: 'A, b,,' } });
    const cs = okCustom.data.product.custom_settings;
    assert.equal(okCustom.data.product.role_id, null); assert.equal(okCustom.data.product.duration_days, null);
    assert.deepEqual(cs.permissions, ['ChangeNickname'], 'صلاحيات خطيرة تُحذف'); assert.deepEqual(cs.color_modes, ['gradient']);
    assert.equal(cs.max_name_length, 32); assert.deepEqual(cs.banned_words, ['a', 'b']);
    const put = await call('PUT', `/api/products/${okCustom.data.product.id}`, { type: 'custom', name: 'Renamed', price: 300 });
    assert.equal(put.data.product.name, 'Renamed');
    assert.equal((await call('PUT', '/api/products/99999', { type: 'fixed', role_id: FIXED_ROLE, name: 'x', price: 1 })).status, 404);
    assert.equal((await call('DELETE', '/api/products/abc')).status, 400);
    assert.equal((await call('DELETE', `/api/products/${okFixed.data.product.id}`)).status, 200);
    assert.equal((await call('GET', '/api/products')).data.length, 3);
    log('المنتجات: تحقق، تنظيف الصلاحيات، مدة الاشتراك، تعديل وحذف');

    // ---- الكوبونات ----
    const C = (b) => call('POST', '/api/coupons', b);
    assert.equal((await C({ percent: 0 })).status, 400); assert.equal((await C({ percent: 101 })).status, 400);
    assert.equal((await C({ percent: 10, code: 'a!' })).status, 400);
    assert.equal((await C({ percent: 10, expires_at: '2000-01-01' })).status, 400);
    assert.equal((await C({ percent: 10, max_uses: 0 })).status, 400);
    const c1 = await C({ code: 'summer', percent: 20, max_uses: 5, max_uses_per_user: '', expires_at: new Date(Date.now() + 864e5).toISOString() });
    assert.equal(c1.data.coupon.code, 'SUMMER'); assert.equal(c1.data.coupon.max_uses_per_user, null);
    assert.equal((await C({ code: 'SUMMER', percent: 5 })).status, 409, 'كود مكرر');
    assert.equal((await C({ percent: 15 })).data.coupon.code.length, 8, 'كود تلقائي');
    assert.equal((await call('PATCH', `/api/coupons/${c1.data.coupon.id}`, { active: false })).data.coupon.active, false);
    assert.equal((await call('PATCH', `/api/coupons/${c1.data.coupon.id}`, { active: 'x' })).status, 400);
    assert.ok((await call('GET', '/api/coupons')).data.every(c => typeof c.used === 'number'));
    assert.equal((await call('DELETE', `/api/coupons/${c1.data.coupon.id}`)).status, 200);
    log('الكوبونات: تحقق، تكرار، كود تلقائي، إيقاف، حذف');

    // ---- الإعدادات ----
    const S = (b) => call('PUT', '/api/settings', { payment_mode: 'with_tax', tax_percent: 5, ...b });
    assert.equal((await S({ payment_mode: 'x' })).status, 400); assert.equal((await S({ tax_percent: 80 })).status, 400);
    assert.equal((await S({ reference_role_id: '123' })).status, 400); assert.equal((await S({ reference_role_id: '123456789012345678' })).status, 400);
    assert.equal((await S({ reference_role_id: '790000000000000000' })).status, 400, 'رتبة أعلى من البوت');
    assert.equal((await S({ log_channel_id: '123456789012345678' })).status, 400); assert.equal((await S({ idle_close_hours: 5000 })).status, 400);
    const ok = await S({ reference_role_id: REF_ROLE, log_channel_id: textChannel.id, alert_channel_id: textChannel.id, idle_close_hours: '12' });
    assert.equal(ok.status, 200); assert.equal(st.settings.payment_mode, 'with_tax'); assert.equal(st.settings.idle_close_hours, 12);
    assert.equal(st.settings.log_channel_id, textChannel.id);
    log('الإعدادات: وضع الدفع، رتبة المرجع، الرومات، الإغلاق التلقائي');

    // ---- الإحصائيات والاشتراكات والطلبات ----
    st.orders.push({ id: 50, status: 'completed', required_amount: 700, created_at: new Date().toISOString(), product_name: 'x', user_id: 'u' });
    const sub = await require('../utils/db.js').addSubscription({ user_id: admin.id, role_id: FIXED_ROLE, product_id: 1, order_id: 50, expires_at: new Date(Date.now() + 864e5).toISOString() });
    const stats = (await call('GET', '/api/stats')).data;
    assert.equal(stats.daily.length, 14); assert.equal(stats.revenue, 700); assert.equal(stats.subsActive, 1); assert.equal(stats.subsExpiring, 1);
    assert.equal((await call('GET', '/api/orders')).data.length, 1);
    const list = (await call('GET', '/api/subscriptions')).data;
    assert.equal(list[0].role_name, 'VIP'); assert.equal(list[0].username, admin.user.tag);
    const before = new Date(st.subs[0].expires_at).getTime();
    assert.equal((await call('POST', `/api/subscriptions/${sub.id}/extend`, { days: 0 })).status, 400);
    assert.equal((await call('POST', `/api/subscriptions/${sub.id}/extend`, { days: 30 })).status, 200);
    assert.ok(new Date(st.subs[0].expires_at).getTime() - before >= 30 * 864e5 - 10);
    admin.roles.cache.set(FIXED_ROLE, true);
    assert.equal((await call('POST', `/api/subscriptions/${sub.id}/revoke`)).status, 200);
    assert.equal(st.subs[0].status, 'expired'); assert.ok(!admin.roles.cache.has(FIXED_ROLE), 'الرتبة انسحبت');
    assert.equal((await call('POST', `/api/subscriptions/${sub.id}/revoke`)).status, 404, 'مرتين');
    assert.equal((await call('POST', '/api/shop/refresh')).status, 404, 'لا يوجد إمبد منشور');
    log('الإحصائيات، الطلبات، الاشتراكات (تمديد/سحب)، تحديث الإمبد');

    // ---- مراجعة الرتب المخصصة ----
    const cust = W.makeMember('900000000000000007');
    const mkReview = (channel, extra = {}) => {
        const o = { id: st.nextId++, status: 'pending_review', product_type: 'custom', product_id: 2, product_name: 'Custom', user_id: cust.id, username: cust.user.tag,
            channel_id: channel.id, required_amount: 2000, created_at: new Date().toISOString(), role_id: null,
            draft: { mode: 'gradient', name: 'Royal', color1: '#FF5733', color2: '#3366FF', confirmed: true, icon_b64: Buffer.from('png').toString('base64'),
                settings: { color_modes: ['solid', 'gradient'], allow_icon: true, max_name_length: 20, banned_words: [], permissions: ['ChangeNickname'], require_review: true } }, ...extra };
        st.orders.push(o); return o;
    };
    const tk1 = W.makeChannel('ticket-c1'); W.guild.channels.cache.set(tk1.id, tk1);
    const r1 = mkReview(tk1);
    const rv = (await call('GET', '/api/reviews')).data;
    assert.equal(rv.length, 1); assert.equal(rv[0].name, 'Royal'); assert.equal(rv[0].mode_label, 'ثنائي اللون (تدرج)');
    assert.deepEqual(rv[0].permissions, ['تغيير الاسم المستعار']); assert.ok(rv[0].icon.startsWith('data:image/png;base64,'));
    assert.equal(rv[0].in_server, true); assert.equal(rv[0].ticket_exists, true);
    assert.equal((await call('GET', '/api/stats')).data.reviews, 1);
    assert.equal((await call('POST', '/api/reviews/abc/approve')).status, 400);
    assert.equal((await call('POST', '/api/reviews/99999/approve')).status, 404);
    assert.equal((await call('POST', '/api/reviews/999/reject', { reason: 'x' })).status, 404);

    // رفض مع سبب: يرجع للتخصيص ويصل العميل السبب ولوحة جديدة
    assert.equal((await call('POST', `/api/reviews/${r1.id}/reject`, { reason: 'الاسم غير مناسب' })).status, 200);
    assert.equal(r1.status, 'customizing'); assert.equal(r1.draft.confirmed, false);
    const rej = tk1.sent.at(-1); assert.ok(rej.content.includes(cust.id) && JSON.stringify(rej).includes('الاسم غير مناسب') && rej.components.length >= 2);
    assert.equal((await call('POST', `/api/reviews/${r1.id}/reject`, {})).status, 404, 'مراجعة مكررة');
    assert.equal((await call('GET', '/api/reviews')).data.length, 0);

    // موافقة: تنشأ الرتبة وتُسلَّم وتُسجَّل
    r1.status = 'pending_review'; const rolesBefore = W.guild.roles.createCalls.length;
    const ap = await call('POST', `/api/reviews/${r1.id}/approve`);
    assert.equal(ap.status, 200); assert.equal(ap.data.delivered, true);
    assert.equal(r1.status, 'completed'); assert.equal(W.guild.roles.createCalls.length, rolesBefore + 1);
    assert.equal(W.guild.roles.createCalls.at(-1).name, 'Royal'); assert.ok(st.customRoles.some(c => c.user_id === cust.id));
    assert.ok(tk1.sent.some(m => JSON.stringify(m).includes('وافق')), 'إشعار الموافقة في التذكرة');
    assert.equal((await call('POST', `/api/reviews/${r1.id}/approve`)).status, 404, 'موافقة مكررة');

    // تذكرة محذوفة: الموافقة مرفوضة والرفض يغلق الطلب العالق
    const tk2 = W.makeChannel('ticket-c2'); const r2 = mkReview(tk2); // غير مسجلة = محذوفة
    assert.equal((await call('POST', `/api/reviews/${r2.id}/approve`)).status, 409);
    assert.equal((await call('POST', `/api/reviews/${r2.id}/reject`, {})).data.closed, true); assert.equal(r2.status, 'cancelled');
    // عميل غادر
    const tk3 = W.makeChannel('ticket-c3'); W.guild.channels.cache.set(tk3.id, tk3);
    const r3 = mkReview(tk3, { user_id: '900000000000000099' });
    assert.equal((await call('POST', `/api/reviews/${r3.id}/approve`)).status, 409); assert.equal(r3.status, 'pending_review');
    log('مراجعة الرتب: عرض المدخلات، رفض بسبب، موافقة وتسليم، منع التكرار، تذكرة محذوفة، عميل غادر');

    // ---- 🕵️ سجل المراقبة + الطرد الفوري عند الإزالة ----
    await tick(100);
    const aud = (await call('GET', '/api/audit')).data;
    const find = (a) => aud.find(x => x.action === a);
    assert.ok(find('access.add') && find('access.add').user_id === E.ID_OWNER, 'إضافة مشرف مسجّلة');
    assert.ok(find('product.create') && find('product.create').details.price === 100, 'إنشاء منتج مسجّل مع السعر');
    assert.ok(find('coupon.create') && find('settings.update') && find('product.delete'), 'كوبون/إعدادات/حذف مسجّلة');
    assert.ok(Object.keys(find('settings.update').details.changes).includes('payment_mode'), 'تعديل الإعدادات يسجّل ما تغيّر');
    assert.equal(find('product.update').details.changes.price[1], 300, 'تعديل المنتج يسجّل القيمة قبل/بعد');
    assert.ok(!find('product.update').details.changes.custom_settings, 'لا تغيير كاذب في custom_settings');
    assert.ok(aud.every(a => a.action !== 'product.create' || a.target), 'الهدف مسجّل');
    assert.ok((await call('GET', '/api/audit?category=coupon')).data.every(a => a.action.startsWith('coupon.')), 'فلتر الفئة');
    const auditCount = aud.length;
    await call('GET', '/api/products'); await tick(50);
    assert.equal((await call('GET', '/api/audit')).data.length, auditCount, 'القراءة لا تُسجَّل');
    assert.equal((await call('POST', '/api/products', { name: 'x', price: -1, type: 'fixed', role_id: 'x' })).status, 400); await tick(50);
    assert.equal((await call('GET', '/api/audit')).data.length, auditCount, 'العملية الفاشلة لا تُسجَّل');
    assert.equal((await call('DELETE', `/api/access/${E.ID_OWNER}`)).status, 400, 'المالك لا يُزال');
    assert.equal((await call('DELETE', `/api/access/${helper.id}`)).status, 200);
    assert.equal((await call('GET', '/api/me', null, asHelper)).status, 401, 'الإزالة تطرده فورًا');
    log('سجل المراقبة: من/ماذا/قبل→بعد، القراءة والفاشل لا يُسجَّلان، والإزالة تطرد فورًا');

    // ---- 🎨 منتقي الألوان على الويب ----
    const { makeToken } = require('../utils/colorPicker.js');
    const dbm = require('../utils/db.js');
    const ord = await dbm.createOrder({ channel_id: 'c1', user_id: 'u-pick', username: 'u', product_id: 2, product_name: 'Custom', required_amount: 1, send_amount: 1, expires_at: new Date(Date.now() + 1e6).toISOString(), product_type: 'custom',
        status: 'customizing', draft: { mode: 'gradient', name: 'Cool', color1: '#5865F2', color2: '#EB459E', settings: {}, panel: { channel_id: 'nope', message_id: 'nope' } } });
    const tok = makeToken(ord.id, 'u-pick');
    const PK = (t, method = 'GET', body) => call(method, `/pick-api/${t}`, body, { cookie: null });
    assert.equal((await fetch(`${BASE}/color/${tok}`)).status, 200, 'صفحة المنتقي تُفتح بلا تسجيل دخول');
    const g = await PK(tok); assert.equal(g.status, 200); assert.equal(g.data.mode, 'gradient'); assert.equal(g.data.palette.length, 24);
    assert.equal((await PK('garbage')).status, 410, 'توكن مزوّر');
    assert.equal((await PK(makeToken(ord.id, 'someone-else'))).status, 410, 'توكن لعميل آخر');
    assert.equal((await PK(makeToken(ord.id, 'u-pick', -1000))).status, 410, 'توكن منتهي');
    assert.equal((await PK(tok, 'POST', { color1: 'zzz', color2: '#112233' })).status, 400, 'لون غير صالح');
    assert.equal((await PK(tok, 'POST', { color1: '#112233' })).status, 400, 'التدرج يحتاج لونين');
    assert.equal((await call('POST', `/pick-api/${tok}`, { color1: '#112233', color2: '#445566' }, { cookie: null, origin: 'http://evil.com' })).status, 403);
    const saved = await PK(tok, 'POST', { color1: 'ff5733', color2: '#3366ff' });
    assert.equal(saved.status, 200); assert.equal(saved.data.refreshed, false, 'اللوحة غير موجودة في المحاكاة = لا خطأ');
    const row = await dbm.getOrderById(ord.id);
    assert.deepEqual([row.draft.color1, row.draft.color2, row.draft.name], ['#FF5733', '#3366FF', 'Cool'], 'الألوان تُحفظ والباقي يبقى');
    await dbm.updateOrder(ord.id, { status: 'completed' });
    assert.equal((await PK(tok)).status, 410, 'بعد اكتمال الطلب يتوقف الرابط');
    await dbm.updateOrder(ord.id, { status: 'customizing', draft: { ...row.draft, mode: 'holographic' } });
    assert.equal((await PK(tok, 'POST', { color1: '#112233', color2: '#445566' })).status, 400, 'الهولوغرافيك لا يحتاج ألوان');
    log('منتقي الألوان: صفحة عامة، توكن موقّع/منتهي/لعميل آخر، حفظ الألوان، إيقاف الرابط بعد الاكتمال');

    console.log('\n✅ كل اختبارات الداشبورد نجحت');
    process.exit(0);
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
