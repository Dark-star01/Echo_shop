// utils/helpers.js - دوال مساعدة

/**
 * تنسيق الأرقام إلى صيغة عملة
 */
function formatCurrency(amount) {
    return amount.toLocaleString();
}

/**
 * حساب المبلغ الإجمالي مع الضريبة
 */
function calculateTotal(price, taxPercent = 5) {
    const tax = Math.round((price * taxPercent) / 100);
    return { price, tax, total: price + tax };
}

/**
 * التحقق من صحة معرف الرتبة
 */
function isValidRoleId(id) {
    return /^\d{17,20}$/.test(id);
}

/**
 * تحويل النص إلى قائمة مميزات (array)
 */
function parseFeatures(text) {
    if (!text) return [];
    return text.split('\n').filter(line => line.trim());
}

module.exports = {
    formatCurrency,
    calculateTotal,
    isValidRoleId,
    parseFeatures,
};