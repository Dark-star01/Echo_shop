// utils/colorPicker.js - روابط منتقي الألوان (رابط موقّع مؤقت لكل طلب، يفتحه العميل من زر في التذكرة)
const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;
const secret = () => process.env.SESSION_SECRET || '';
const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
const baseUrl = () => (process.env.DASHBOARD_URL || '').replace(/\/$/, '');

/** هل المنتقي مُفعّل؟ يحتاج DASHBOARD_URL و SESSION_SECRET (نفس إعدادات الداشبورد) */
const pickerEnabled = () => Boolean(baseUrl() && secret().length >= 16);

function makeToken(orderId, userId, ttlMs = TTL_MS) {
    const body = Buffer.from(JSON.stringify({ o: orderId, u: userId, e: Date.now() + ttlMs })).toString('base64url');
    return `${body}.${sign(body)}`;
}

/** يرجع { orderId, userId } أو null لو التوقيع خاطئ أو انتهى الرابط */
function readToken(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !pickerEnabled()) return null;
    const expected = Buffer.from(sign(body)), given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        return data.e > Date.now() ? { orderId: data.o, userId: data.u } : null;
    } catch { return null; }
}

const pickerUrl = (orderId, userId) => (pickerEnabled() ? `${baseUrl()}/color/${makeToken(orderId, userId)}` : null);

module.exports = { pickerEnabled, makeToken, readToken, pickerUrl };
