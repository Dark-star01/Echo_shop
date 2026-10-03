// utils/helpers.js - دوال مساعدة

function formatCurrency(amount) {
    return Number(amount).toLocaleString();
}

/**
 * المبلغ الذي يجب على العميل تحويله ليصل الصافي المطلوب بعد ضريبة ProBot.
 * (1e-9 لتفادي أخطاء الفاصلة العائمة اللي تزيد المبلغ 1 بالغلط)
 */
function calculateSendAmount(netAmount, taxPercent = 0) {
    const tax = Number(taxPercent) || 0;
    if (tax <= 0) return netAmount;
    if (tax >= 100) throw new Error('PROBOT_TAX_PERCENT يجب أن تكون أقل من 100');
    return Math.ceil(netAmount / (1 - tax / 100) - 1e-9);
}

/**
 * أعلى صافي ممكن يوصل لو العميل حوّل sendAmount (هامش التقريب فقط).
 */
function calculateMaxNet(sendAmount, taxPercent = 0) {
    const tax = Number(taxPercent) || 0;
    if (tax <= 0) return sendAmount;
    return Math.floor(sendAmount * (1 - tax / 100) + 1e-9);
}

function isValidRoleId(id) {
    return /^\d{17,20}$/.test(String(id ?? ''));
}

function parseFeatures(text) {
    if (!text) return [];
    return text.split('\n').filter(line => line.trim());
}

function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes <= 1) return 'دقيقة';
    if (minutes === 2) return 'دقيقتين';
    if (minutes <= 10) return `${minutes} دقائق`;
    return `${minutes} دقيقة`;
}

module.exports = {
    formatCurrency,
    calculateSendAmount,
    calculateMaxNet,
    isValidRoleId,
    parseFeatures,
    formatDuration,
};
