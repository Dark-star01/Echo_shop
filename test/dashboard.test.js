// اختبار API الداشبورد الحقيقي (server.js) مع جلسة موقّعة وسيرفر ديسكورد محاكى
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installDb, makeWorld, tick, E, REF_ROLE, FIXED_ROLE } = require('./helpers');
const st = installDb();
const W = makeWorld();

const ADMIN_ROLE = '1458271551907565618';
const admin = W.makeMember('900000000000000001'); admin.roles.cache.set(ADMIN_ROLE, true);
const outsider = W.makeMember('900000000000000002');
const textChannel = W.makeChannel('logs'); textChannel.isTextBased = () => true;
W.guild.channels.cache.set(textChannel.id, textChannel);
W.roles.set('790000000000000000', { id: '790000000000000000', name: 'too-high', position: 60, managed: false });
const client = { user: { id: '555555555555555555' }, guilds: { cache: { get: () => W.guild } } };

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
    admin.roles.cache.delete(ADMIN_ROLE);
    assert.equal((await call('GET', '/api/me')).status, 401, 'سحب الرتبة يطرده فورًا');
    admin.roles.cache.set(ADMIN_ROLE, true);
    log('تسجيل الدخول: جلسة موقّعة، انتهاء، تزوير، origin، سحب الرتبة');

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

    console.log('\n✅ كل اختبارات الداشبورد نجحت');
    process.exit(0);
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
