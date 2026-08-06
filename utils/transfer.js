// utils/transfer.js - مراقبة تحويلات ProBot Credits (نسخة مقاومة لاختلاف الصيغة)
//
// نبني نص بحث موحّد يجمع محتوى الرسالة العادي + كل نصوص أي embed مرفق،
// لأن بعض البوتات (زي ProBot) ترسل التفاصيل داخل embed مو بالنص المباشر.
// وبنطابق منشن المستخدم بصيغتين <@id> و <@!id> لأن ديسكورد يستخدم الاثنين.

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
    // 1) أي رقم داخل باكتيك `...` بغض النظر عن مكان علامة $ (قبل أو بعد الرقم)
    const backtickMatches = [...text.matchAll(/`([^`]+)`/g)];
    for (const m of backtickMatches) {
        const digits = m[1].replace(/[^\d]/g, '');
        if (digits.length >= 2) {
            const num = parseInt(digits, 10);
            if (!isNaN(num)) return num;
        }
    }
    // 2) احتياطي: $1000 أو 1000$ بدون باكتيك، أو "1000 كريديت"
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
 * @param {Object} options
 * @param {string} options.botId - معرف بوت ProBot
 * @param {string} options.userId - معرف حساب البنك (المستلم)
 * @param {number} options.amount - المبلغ المطلوب بالضبط (الصافي)
 * @param {number} options.timeout - مدة الانتظار (مللي ثانية)
 * @param {TextChannel} options.channel - قناة التذكرة
 * @returns {Promise<{status: 'success'|'underpaid'|'overpaid'|'timeout', actualAmount: number|null}>}
 */
async function monitorTransferDetailed({ botId, userId, amount, timeout, channel }) {
    // 🔍 لوق تشخيصي: يسجل أي رسالة توصل من ProBot بالتكت (نص + embed) بغض النظر عن الفلتر
    const debugListener = (message) => {
        if (message.channel.id === channel.id && message.author.id === botId) {
            const text = extractSearchableText(message);
            console.log('🔍 [DEBUG-RAW] رسالة من ProBot بالتكت:');
            console.log('content:', message.content || '(فاضي)');
            console.log('embeds:', JSON.stringify(message.embeds, null, 2));
            console.log('النص الموحّد للبحث:', text);
            console.log(`يحتوي على منشن <@${userId}>؟`, mentionsUser(text, userId));
            console.log(`المبلغ المستخرج:`, extractAmount(text));
            console.log('------------------------------------');
        }
    };
    channel.client.on('messageCreate', debugListener);
    setTimeout(() => channel.client.off('messageCreate', debugListener), timeout + 2000);

    return new Promise((resolve) => {
        const collector = channel.createMessageCollector({
            filter: (message) => {
                if (message.author.id !== botId) return false;
                const text = extractSearchableText(message);
                return mentionsUser(text, userId) && extractAmount(text) !== null;
            },
            time: timeout,
            max: 1,
        });

        collector.on('collect', (message) => {
            const text = extractSearchableText(message);
            const actualAmount = extractAmount(text);

            if (actualAmount === amount) {
                resolve({ status: 'success', actualAmount });
            } else if (actualAmount === null) {
                resolve({ status: 'timeout', actualAmount: null });
            } else if (actualAmount < amount) {
                resolve({ status: 'underpaid', actualAmount });
            } else {
                resolve({ status: 'overpaid', actualAmount });
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                resolve({ status: 'timeout', actualAmount: null });
            }
        });
    });
}

module.exports = { monitorTransferDetailed };
