// dashboard/server.js - لوحة التحكم: تسجيل دخول بحساب ديسكورد + جلسة محفوظة 30 يوم
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('../utils/db.js');
const { isValidRoleId } = require('../utils/helpers.js');
const { refreshShopMessage, refreshNow: refreshShopNow } = require('../utils/shopMessage.js');
const { alertError } = require('../utils/alerts.js');
const { PERMISSION_WHITELIST, COLOR_MODES, sanitizeCustomSettings } = require('../utils/customRoleConfig.js');
const customRoles = require('../utils/customRoles.js');

const ROLE_ID = process.env.DASHBOARD_ROLE_ID || '1458271551907565618'; // الرتبة المسموح لها بالدخول
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || '';
const BASE_URL = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');

// ---------- جلسات موقّعة (بدون تخزين، تنجو من إعادة تشغيل ريندر) ----------
const hmac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${hmac(body)}`;
}
function verify(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(hmac(body)), given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        return data.exp > Date.now() ? data : null;
    } catch { return null; }
}
function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0]));
}

function validateProductInput(body = {}) {
    const type = body.type === 'custom' ? 'custom' : 'fixed';
    const durationRaw = body.duration_days;
    const duration_days = type === 'fixed' && durationRaw !== '' && durationRaw != null ? Number(durationRaw) : null;
    if (duration_days !== null && (!Number.isInteger(duration_days) || duration_days < 1 || duration_days > 3650)) return { error: 'مدة الاشتراك: عدد أيام بين 1 و 3650 (أو اتركها فارغة للدائم)' };
    const role_id = String(body.role_id ?? '').trim();
    const name = String(body.name ?? '').trim();
    const price = Number(body.price);
    const description = String(body.description ?? '').trim();
    const features = String(body.features ?? '').trim();
    if (type === 'fixed' && !isValidRoleId(role_id)) return { error: 'معرف الرتبة غير صالح (أرقام فقط، 17–20 رقم)' };
    if (!name || name.length > 100) return { error: 'اسم المنتج مطلوب (حد أقصى 100 حرف)' };
    if (!Number.isInteger(price) || price <= 0 || price > 2_000_000_000) return { error: 'السعر لازم يكون رقم صحيح موجب' };
    if (description.length > 500) return { error: 'الوصف طويل (حد أقصى 500 حرف)' };
    if (features.length > 1000) return { error: 'المميزات طويلة (حد أقصى 1000 حرف)' };
    return { value: {
        type, role_id: type === 'fixed' ? role_id : null, name, price, description, features, duration_days,
        custom_settings: type === 'custom' ? sanitizeCustomSettings(body.custom_settings) : {},
    } };
}
function validateCouponInput(body = {}) {
    const code = (String(body.code ?? '').trim() || crypto.randomBytes(4).toString('hex')).toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { error: 'الكود: 3–32 حرف إنجليزي أو أرقام أو - _' };
    const percent = Number(body.percent);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return { error: 'نسبة الخصم من 1 إلى 100' };
    const optInt = (v) => (v === '' || v == null ? null : Number(v));
    const max_uses = optInt(body.max_uses), max_uses_per_user = optInt(body.max_uses_per_user);
    for (const n of [max_uses, max_uses_per_user]) if (n !== null && (!Number.isInteger(n) || n < 1)) return { error: 'حدود الاستخدام لازم تكون أرقام صحيحة 1 أو أكثر' };
    let expires_at = null;
    if (body.expires_at) {
        const d = new Date(body.expires_at);
        if (isNaN(d) || d < new Date()) return { error: 'تاريخ الانتهاء لازم يكون في المستقبل' };
        expires_at = d.toISOString();
    }
    return { value: { code, percent, max_uses, max_uses_per_user, expires_at } };
}
const parseId = (raw) => (Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null);

function start(client) {
    const oauthReady = Boolean(process.env.DISCORD_CLIENT_SECRET && BASE_URL && SECRET.length >= 16);
    if (!oauthReady) console.warn('⚠️ الداشبورد مقفل: أضف DISCORD_CLIENT_SECRET و DASHBOARD_URL و SESSION_SECRET (16+ حرف) في .env');

    const app = express();
    const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
    const clientId = () => process.env.DISCORD_CLIENT_ID || client.user.id;
    const redirectUri = `${BASE_URL}/auth/callback`;
    const guild = () => client.guilds.cache.get(process.env.GUILD_ID);

    // يتحقق من الرتبة مباشرة من السيرفر في كل طلب — لو انسحبت منه الرتبة يطلع فورًا
    async function hasAccess(userId) {
        const member = await guild()?.members.fetch(userId).catch(() => null);
        return Boolean(member && member.roles.cache.has(ROLE_ID));
    }
    const cookieOpts = (req, maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });

    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // ---------- تسجيل الدخول ----------
    app.get('/auth/login', (req, res) => {
        if (!oauthReady) return res.redirect('/?error=setup');
        const state = crypto.randomBytes(16).toString('hex');
        res.cookie('echo_oauth', sign({ state, exp: Date.now() + 10 * 60 * 1000 }), cookieOpts(req, 10 * 60 * 1000));
        res.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({
            client_id: clientId(), redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state,
        }));
    });

    app.get('/auth/callback', async (req, res) => {
        const saved = verify(cookies(req).echo_oauth);
        res.clearCookie('echo_oauth', { path: '/' });
        if (!oauthReady || !saved || saved.state !== req.query.state || !req.query.code) return res.redirect('/?error=failed');
        try {
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId(), client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri,
                }),
            });
            const token = await tokenRes.json();
            if (!tokenRes.ok) throw new Error(token.error_description || 'token exchange failed');
            const user = await (await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${token.access_token}` },
            })).json();
            if (!user.id || !(await hasAccess(user.id))) return res.redirect('/?error=forbidden');

            res.cookie('echo_session', sign({
                uid: user.id, name: user.global_name || user.username, avatar: user.avatar, exp: Date.now() + SESSION_MS,
            }), cookieOpts(req, SESSION_MS));
            res.redirect('/');
        } catch (error) {
            console.error('❌ OAuth callback:', error);
            res.redirect('/?error=failed');
        }
    });

    app.post('/auth/logout', (req, res) => {
        res.clearCookie('echo_session', { path: '/' });
        res.json({ success: true });
    });

    // ---------- الهوية العامة (اسم البوت وأفتاره للشعار؛ بدون بيانات حساسة) ----------
    app.get('/brand.json', (req, res) => {
        const u = client.user;
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            name: u?.displayName || u?.username || 'Echo Shop',
            avatar: u?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null,
        });
    });

    // ---------- حماية الـ API ----------
    app.use('/api', async (req, res, next) => {
        if (!oauthReady) return res.status(503).json({ error: 'setup' });
        if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== new URL(BASE_URL).origin) {
            return res.status(403).json({ error: 'origin' });
        }
        const session = verify(cookies(req).echo_session);
        if (!session || !(await hasAccess(session.uid))) return res.status(401).json({ error: 'unauthorized' });
        req.user = session;
        next();
    });

    const handle = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (error) {
            if (error.code !== '23505') console.error('❌ Dashboard error:', error);
            if (error.code !== '23505') alertError('خطأ في الداشبورد', error, { context: `${req.method} ${req.originalUrl} — ${req.user?.name}` });
            if (error.code === '23505') return res.status(409).json({ error: 'هذه القيمة موجودة بالفعل (رتبة أو كود مكرر)' });
            res.status(500).json({ error: 'حدث خطأ في الخادم' });
        }
    };

    app.get('/api/me', (req, res) => res.json({ id: req.user.uid, name: req.user.name, avatar: req.user.avatar }));

    // ---------- المنتجات ----------
    app.get('/api/products', handle(async (req, res) => res.json(await db.getAllProducts())));

    app.post('/api/products', handle(async (req, res) => {
        const { value, error } = validateProductInput(req.body);
        if (error) return res.status(400).json({ error });
        if (value.type === 'fixed') {
            const role = guild()?.roles.cache.get(value.role_id);
            if (!role) return res.status(400).json({ error: 'هذه الرتبة غير موجودة في السيرفر' });
            if (role.managed) return res.status(400).json({ error: 'لا يمكن بيع رتبة بوت/تكامل' });
        }
        const created = await db.addProduct(value);
        refreshShopMessage(client);
        res.json({ success: true, product: created });
    }));

    app.put('/api/products/:id', handle(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف المنتج غير صالح' });
        const { value, error } = validateProductInput(req.body);
        if (error) return res.status(400).json({ error });
        const product = await db.updateProduct(id, value);
        if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
        refreshShopMessage(client);
        res.json({ success: true, product });
    }));

    app.delete('/api/products/:id', handle(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف المنتج غير صالح' });
        await db.deleteProduct(id);
        refreshShopMessage(client);
        res.json({ success: true });
    }));

    app.post('/api/shop/refresh', handle(async (req, res) => {
        if (!(await refreshShopNow(client))) {
            return res.status(404).json({ error: 'لم يُنشر إمبد المتجر بعد (أو انحذفت رسالته) — نفّذ /shopadmin setup في الروم المطلوب' });
        }
        res.json({ success: true });
    }));

    // ---------- الطلبات والإحصائيات ----------
    app.get('/api/orders', handle(async (req, res) => res.json(await db.getOrders(200))));

    app.get('/api/stats', handle(async (req, res) => {
        const [products, orders, subs] = await Promise.all([db.countProducts(), db.getOrders(1000), db.getSubscriptions(500)]);
        const sold = orders.filter(o => o.status === 'completed');
        const DAY = 24 * 60 * 60 * 1000, now = Date.now();
        const sum = (list) => list.reduce((t, o) => t + o.required_amount, 0);
        const active = subs.filter(s => s.status === 'active');
        res.json({
            products,
            completed: sold.length,
            revenue: sum(sold),
            revenueWeek: sum(sold.filter(o => new Date(o.created_at).getTime() > now - 7 * DAY)),
            attention: orders.filter(o => ['role_failed', 'error'].includes(o.status)).length,
            reviews: orders.filter(o => o.status === 'pending_review').length,
            daily: Array.from({ length: 14 }, (_, i) => {
                const day = new Date(now - (13 - i) * DAY).toISOString().slice(0, 10);
                return { day, total: sum(sold.filter(o => o.created_at.slice(0, 10) === day)) };
            }),
            subsActive: active.length,
            subsExpiring: active.filter(s => new Date(s.expires_at).getTime() < now + 3 * DAY).length,
        });
    }));

    // ---------- مراجعة الرتب المخصصة (بدل أزرار الموافقة داخل التذكرة) ----------
    const iconUri = (b64) => (b64 ? `data:image/${b64.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${b64}` : null);
    async function reviewView(o) {
        const d = o.draft || {}, member = await guild()?.members.fetch(o.user_id).catch(() => null);
        return {
            id: o.id, user_id: o.user_id, username: member?.user?.tag || o.username, in_server: Boolean(member),
            avatar: member?.displayAvatarURL?.({ extension: 'png', size: 64 }) || null,
            product_name: o.product_name, edit: o.product_type === 'custom_edit', channel_id: o.channel_id,
            ticket_exists: Boolean(guild()?.channels.cache.get(o.channel_id)),
            waiting_since: o.updated_at || o.created_at,
            name: d.name || '', mode: d.mode, mode_label: COLOR_MODES[d.mode] || d.mode, color1: d.color1 || null, color2: d.color2 || null,
            icon: iconUri(d.icon_b64),
            permissions: (d.settings?.permissions || []).map(k => PERMISSION_WHITELIST[k] || k),
        };
    }
    const pendingReview = async (id) => {
        const o = await db.getOrderById(id);
        return o && o.status === 'pending_review' && ['custom', 'custom_edit'].includes(o.product_type) && o.draft ? o : null;
    };

    app.get('/api/reviews', handle(async (req, res) => {
        const list = (await db.getOrdersByStatus(['pending_review'])).filter(o => o.draft);
        res.json(await Promise.all(list.map(reviewView)));
    }));

    app.post('/api/reviews/:id/approve', handle(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'رقم غير صالح' });
        const order = await pendingReview(id);
        if (!order) return res.status(404).json({ error: 'الطلب غير موجود أو تمت مراجعته بالفعل' });
        const channel = await guild()?.channels.fetch(order.channel_id).catch(() => null);
        if (!channel) return res.status(409).json({ error: 'تذكرة هذا الطلب محذوفة، لا يمكن إنشاء الرتبة. ارفضه لإغلاقه.' });
        const member = await guild().members.fetch(order.user_id).catch(() => null);
        if (!member) return res.status(409).json({ error: 'العميل غادر السيرفر.' });

        await db.updateOrder(order.id, { status: 'paid' }); // يمنع موافقة مكررة/تعارض مع زر قديم داخل التذكرة
        await channel.send({ content: `✅ وافق **${req.user.name}** على رتبتك من لوحة التحكم، جاري الإنشاء...`, allowedMentions: { parse: [] } }).catch(() => {});
        const delivered = await customRoles.finalizeRole({ order: { ...order, status: 'paid' }, channel, member });
        res.json({ success: true, delivered: Boolean(delivered) });
    }));

    app.post('/api/reviews/:id/reject', handle(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'رقم غير صالح' });
        const reason = String(req.body?.reason || '').trim().slice(0, 300);
        const order = await pendingReview(id);
        if (!order) return res.status(404).json({ error: 'الطلب غير موجود أو تمت مراجعته بالفعل' });
        const channel = await guild()?.channels.fetch(order.channel_id).catch(() => null);
        if (!channel) { // التذكرة انحذفت: نغلق الطلب العالق
            await db.updateOrder(order.id, { status: 'cancelled', error: `رُفض من الداشبورد (التذكرة محذوفة) — ${req.user.name}` });
            return res.json({ success: true, closed: true });
        }
        const draft = { ...order.draft, confirmed: false };
        await db.updateOrder(order.id, { status: 'customizing', draft });
        const note = `❌ رفض الستاف رتبتك${reason ? `: **${reason}**` : ' بصيغتها الحالية'}.\nعدّلها واضغط تأكيد من جديد، أو اضغط طلب ستاف للاستفسار.`;
        await channel.send({ content: `<@${order.user_id}>`, ...customRoles.panelPayload({ ...order, status: 'customizing', draft }, note) }).catch(() => {});
        res.json({ success: true });
    }));

    // ---------- الاشتراكات ----------
    app.get('/api/subscriptions', handle(async (req, res) => {
        const [subs, products] = await Promise.all([db.getSubscriptions(300), db.getAllProducts()]);
        const names = Object.fromEntries(products.map(p => [p.id, p.name]));
        res.json(subs.map(s => ({
            ...s,
            username: guild()?.members.cache.get(s.user_id)?.user.tag || null,
            role_name: guild()?.roles.cache.get(s.role_id)?.name || null,
            product_name: names[s.product_id] || null,
        })));
    }));

    app.post('/api/subscriptions/:id/extend', handle(async (req, res) => {
        const id = parseId(req.params.id), days = Number(req.body?.days);
        if (!id || !Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'عدد الأيام بين 1 و 3650' });
        const sub = await db.getSubscriptionById(id);
        if (!sub || sub.status !== 'active') return res.status(404).json({ error: 'الاشتراك غير فعال' });
        const base = Math.max(Date.now(), new Date(sub.expires_at).getTime());
        await db.updateSubscription(id, { expires_at: new Date(base + days * 24 * 60 * 60 * 1000).toISOString() });
        res.json({ success: true });
    }));

    app.post('/api/subscriptions/:id/revoke', handle(async (req, res) => {
        const id = parseId(req.params.id);
        const sub = id ? await db.getSubscriptionById(id) : null;
        if (!sub || sub.status !== 'active') return res.status(404).json({ error: 'الاشتراك غير فعال' });
        const member = await guild()?.members.fetch(sub.user_id).catch(() => null);
        if (member?.roles.cache.has(sub.role_id)) await member.roles.remove(sub.role_id, `Echo Shop — سحب يدوي للاشتراك #${id} (${req.user.name})`);
        await db.updateSubscription(id, { status: 'expired' });
        res.json({ success: true });
    }));

    // ---------- الكوبونات ----------
    app.get('/api/coupons', handle(async (req, res) => {
        const [coupons, usage] = await Promise.all([db.getCoupons(), db.getCouponUsageMap()]);
        res.json(coupons.map(c => ({ ...c, used: usage[c.id] || 0 })));
    }));

    app.post('/api/coupons', handle(async (req, res) => {
        const { value, error } = validateCouponInput(req.body);
        if (error) return res.status(400).json({ error });
        res.json({ success: true, coupon: await db.createCoupon(value) });
    }));

    app.patch('/api/coupons/:id', handle(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id || typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'طلب غير صالح' });
        const coupon = await db.updateCoupon(id, { active: req.body.active });
        if (!coupon) return res.status(404).json({ error: 'الكوبون غير موجود' });
        res.json({ success: true, coupon });
    }));

    app.delete('/api/coupons/:id', handle(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف غير صالح' });
        await db.deleteCoupon(id);
        res.json({ success: true });
    }));

    app.get('/api/custom-config', (req, res) => res.json({ permissions: PERMISSION_WHITELIST, modes: COLOR_MODES }));

    // ---------- الإعدادات ----------
    app.get('/api/settings', handle(async (req, res) => res.json(await db.getSettings())));

    app.put('/api/settings', handle(async (req, res) => {
        const { payment_mode } = req.body || {};
        const tax = Number(req.body?.tax_percent);
        if (!['calculated', 'with_tax'].includes(payment_mode)) return res.status(400).json({ error: 'طريقة الدفع غير صالحة' });
        if (!Number.isFinite(tax) || tax < 0 || tax >= 50) return res.status(400).json({ error: 'نسبة الضريبة لازم تكون بين 0 و 50' });
        const reference = String(req.body?.reference_role_id ?? '').trim();
        if (reference) {
            if (!isValidRoleId(reference)) return res.status(400).json({ error: 'معرف رتبة المرجع غير صالح' });
            const ref = guild()?.roles.cache.get(reference);
            if (!ref) return res.status(400).json({ error: 'رتبة المرجع غير موجودة في السيرفر' });
            if (ref.position >= guild().members.me.roles.highest.position) return res.status(400).json({ error: 'رتبة البوت لازم تكون أعلى من رتبة المرجع' });
        }
        const idleRaw = req.body?.idle_close_hours;
        const idle = idleRaw === '' || idleRaw == null ? 24 : Number(idleRaw);
        if (!Number.isInteger(idle) || idle < 0 || idle > 720) return res.status(400).json({ error: 'ساعات الإغلاق التلقائي: من 0 (معطل) إلى 720' });
        const LABELS = { log_channel_id: 'لوق الستاف', transcript_channel_id: 'نسخ التذاكر', alert_channel_id: 'تنبيهات الأخطاء' };
        const channels = {};
        for (const key of Object.keys(LABELS)) {
            const id = String(req.body?.[key] ?? '').trim();
            if (id) {
                const ch = guild()?.channels.cache.get(id);
                if (!isValidRoleId(id) || !ch?.isTextBased()) return res.status(400).json({ error: `معرف الروم غير صالح (${LABELS[key]}) — لازم روم نصي في السيرفر` });
            }
            channels[key] = id;
        }
        res.json(await db.saveSettings({ payment_mode, tax_percent: tax, reference_role_id: reference, idle_close_hours: idle, ...channels }));
    }));

    app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));
}

module.exports = { start };
