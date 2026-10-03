// utils/transfer.js - مراقبة تحويلات ProBot Credits
//
// نبني نص بحث موحّد يجمع محتوى الرسالة + كل نصوص أي embed مرفق (ProBot يرسل أحيانًا بالـ embed)،
// ونطابق منشن المستخدم بصيغتين <@id> و <@!id>.

const MENTION_REGEX = /<@!?(\d+)>/g;

function extractSearchableText(message) {
    const parts = [message.content || ''];

    for (const embed of message.embeds || []) {
        if (embed.title) parts.push(embed.title);
        if (embed.description) parts.push(embed.description);
        if (embed.footer?.text) parts.push(embed.footer.text);
        if (embed.author?.name) parts.push(embed.author.name);
        for (const field of embed.fields || []) {
            parts.push(field.name || '');
            parts.push(field.value || '');
        }
    }

    return parts.join('\n');
}

function mentionsUser(text, userId) {
    return text.includes(`<@${userId}>`) || text.includes(`<@!${userId}>`);
}

function extractAmount(text) {
    // 1) أي رقم داخل باكتيك `...` بغض النظر عن مكان علامة $
    const backtickMatches = [...text.matchAll(/`([^`]+)`/g)];
    for (const m of backtickMatches) {
        const digits = m[1].replace(/[^\d]/g, '');
        if (digits.length >= 2) {
            const num = parseInt(digits, 10);
            if (!isNaN(num)) return num;
        }
    }
    // 2) احتياطي: $1000 أو 1000$ أو "1000 كريديت"
    const fallbackPatterns = [
        /\$\s*([\d,]+)/,
        /([\d,]+)\s*\$/,
        /([\d,]{4,})\s*(?:كريديت|credits?)/i,
    ];
    for (const pattern of fallbackPatterns) {
        const match = text.match(pattern);
        if (match) {
            const num = parseInt(match[1].replace(/,/g, ''), 10);
            if (!isNaN(num)) return num;
        }
    }
    return null;
}

/**
 * يقيّم المبلغ الفعلي مقابل المطلوب.
 * success: المبلغ >= المطلوب وضمن هامش التقريب (maxAmount) فقط.
 */
function evaluateAmount(actual, amount, maxAmount = amount) {
    if (actual === null || actual === undefined) return 'timeout';
    if (actual >= amount && actual <= Math.max(maxAmount, amount)) return 'success';
    return actual < amount ? 'underpaid' : 'overpaid';
}

/**
 * هل التحويل يخص صاحب التذكرة؟
 * صيغة رسالة ProBot ما تكون دائمًا بمنشن، فنرفض فقط لو فيه دليل واضح إنها لشخص ثاني:
 *  - منشن لشخص غير صاحب التذكرة وغير البنك
 *  - أو الرسالة رد على رسالة إنسان غير صاحب التذكرة
 */
function isPaymentFromPayer(message, text, payerId, bankUserId) {
    const ids = [...text.matchAll(MENTION_REGEX)].map(m => m[1]);
    if (ids.includes(payerId)) return true;

    const others = ids.filter(id => id !== bankUserId && id !== message.author.id);
    if (others.length > 0) return false;

    const refId = message.reference?.messageId;
    if (refId) {
        const refMsg = message.channel?.messages?.cache?.get(refId);
        if (refMsg && !refMsg.author.bot && refMsg.author.id !== payerId) return false;
    }
    return true;
}

function isCandidateMessage({ message, botId, userId, payerId }) {
    if (message.author.id !== botId) return false;
    const text = extractSearchableText(message);
    return mentionsUser(text, userId)
        && extractAmount(text) !== null
        && isPaymentFromPayer(message, text, payerId, userId);
}

/**
 * يراقب القناة حتى يوصل تحويل ProBot مناسب أو ينتهي الوقت أو تنحذف القناة.
 * @returns {Promise<{status: 'success'|'underpaid'|'overpaid'|'timeout'|'cancelled', actualAmount: number|null}>}
 */
function monitorTransferDetailed({ botId, userId, payerId, amount, maxAmount = amount, timeout, channel }) {
    return new Promise((resolve) => {
        let settled = false;

        // 🔍 لوق تشخيصي اختياري: DEBUG_TRANSFERS=true
        let debugListener = null;
        if (process.env.DEBUG_TRANSFERS === 'true') {
            debugListener = (message) => {
                if (message.channel.id !== channel.id || message.author.id !== botId) return;
                const text = extractSearchableText(message);
                console.log('🔍 [DEBUG] رسالة ProBot:', JSON.stringify({
                    text,
                    mentionsBank: mentionsUser(text, userId),
                    amount: extractAmount(text),
                    fromPayer: isPaymentFromPayer(message, text, payerId, userId),
                }));
            };
            channel.client.on('messageCreate', debugListener);
        }

        const collector = channel.createMessageCollector({
            filter: (message) => isCandidateMessage({ message, botId, userId, payerId }),
            time: timeout,
            max: 1,
        });

        collector.on('collect', (message) => {
            settled = true;
            const actualAmount = extractAmount(extractSearchableText(message));
            resolve({ status: evaluateAmount(actualAmount, amount, maxAmount), actualAmount });
        });

        collector.on('end', (_collected, reason) => {
            if (debugListener) channel.client.off('messageCreate', debugListener);
            if (settled) return;
            settled = true;
            // 'time' = انتهت المهلة، غيرها (مثل channelDelete) = انحذفت القناة/توقف المراقب
            resolve({ status: reason === 'time' ? 'timeout' : 'cancelled', actualAmount: null });
        });
    });
}

/**
 * يفحص آخر رسائل القناة بحثًا عن تحويل وصل أثناء توقف البوت (للاستعادة بعد إعادة التشغيل).
 * @returns {Promise<{actualAmount: number}|null>}
 */
async function findTransferInHistory({ channel, botId, userId, payerId, since, limit = 50 }) {
    const messages = await channel.messages.fetch({ limit });
    const candidates = [...messages.values()]
        .filter(m => m.createdTimestamp >= since && isCandidateMessage({ message: m, botId, userId, payerId }))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    if (candidates.length === 0) return null;
    return { actualAmount: extractAmount(extractSearchableText(candidates[0])) };
}

module.exports = {
    extractSearchableText,
    extractAmount,
    mentionsUser,
    evaluateAmount,
    isPaymentFromPayer,
    isCandidateMessage,
    monitorTransferDetailed,
    findTransferInHistory,
};
