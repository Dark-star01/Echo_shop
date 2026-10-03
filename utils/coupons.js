// utils/coupons.js - منطق الكوبونات
const db = require('./db.js');

// ceil: الخصم الكامل (100%) فقط يعطي سعر 0
const applyDiscount = (price, percent) => Math.ceil((price * (100 - percent)) / 100);

/** يرجع نص المشكلة أو null لو الكوبون صالح لهذا العضو */
async function couponProblem(coupon, userId) {
    if (!coupon || !coupon.active) return 'الكوبون غير صالح.';
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return 'انتهت صلاحية الكوبون.';
    if (coupon.max_uses != null && (await db.countCouponUses(coupon.id)) >= coupon.max_uses) return 'استُنفد الحد الأقصى لاستخدام هذا الكوبون.';
    if (coupon.max_uses_per_user != null && (await db.countCouponUses(coupon.id, userId)) >= coupon.max_uses_per_user) {
        return 'استخدمت هذا الكوبون بالحد الأقصى المسموح لك.';
    }
    return null;
}

module.exports = { applyDiscount, couponProblem };
