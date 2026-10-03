// utils/payments.js - تدفق الدفع والتسليم + الاستعادة بعد إعادة تشغيل البوت
//
// دورة حياة الطلب:
//   awaiting_payment -> paid -> completed
//                          \-> role_failed (الدفع تم والتسليم فشل: التذكرة تبقى مفتوحة للستاف)
//   awaiting_payment -> mismatch (مبلغ غير مطابق: التذكرة تبقى مفتوحة للستاف)
//   awaiting_payment -> failed | expired | cancelled | error
const db = require('./db.js');
const { monitorTransferDetailed, findTransferInHistory, evaluateAmount } = require('./transfer.js');
const { calculateMaxNet } = require('./helpers.js');
const { scheduleDelete, staffMention, staffActionsRow } = require('./tickets.js');
const { logOrder } = require('./logger.js');
const { alertError } = require('./alerts.js');
const { startCustomization, finalizeRole } = require('./customRoles.js');

const PAYMENT_TIMEOUT_MS = parseInt(process.env.PAYMENT_TIMEOUT_MS, 10) || 300000; // 5 دقائق افتراضيًا
const DEFAULT_PROBOT_ID = '282859044593598464';

// طلبات قيد المعالجة الآن (يمنع تشغيل مراقبين اثنين لنفس الطلب)
const activeOrders = new Set();

// تنفيذ عملية بدون ما نرمي خطأ (نسجله فقط) — عشان فشل اللوق/القاعدة ما يوقف التسليم
async function safe(label, fn) {
    try {
        return await fn();
    } catch (error) {
        console.error(`❌ ${label}:`, error);
        return null;
    }
}

/**
 * منح الرتبة وإنهاء الطلب. لو فشل المنح: لا نحذف التذكرة، وننبه الستاف.
 * @returns {Promise<boolean>} true لو تم التسليم
 */
async function fulfillOrder({ order, channel, member }) {
    // 🎨 منتج قابل للإنشاء: بعد الدفع يخصص العميل رتبته (أو ننشئها لو التخصيص مكتمل وفشل الإنشاء سابقًا)
    if (order.product_type === 'custom' || order.product_type === 'custom_edit') {
        return order.draft?.confirmed
            ? finalizeRole({ order, channel, member })
            : startCustomization({ order, channel, member });
    }

    try {
        if (!member.roles.cache.has(order.role_id)) {
            await member.roles.add(order.role_id, `Echo Shop — order #${order.id}`);
        }
    } catch (error) {
        console.error(`❌ فشل منح الرتبة للطلب #${order.id}:`, error);
        logOrder(channel.guild, 'failed_delivery', order, String(error.message || error));
        await safe('تحديث الطلب (role_failed)', () => db.updateOrder(order.id, {
            status: 'role_failed',
            error: String(error.message || error).slice(0, 500),
        }));
        await safe('تنبيه الستاف', () => channel.send({
            content: `${staffMention()} ⚠️ ${member} دفع مقابل **${order.product_name}** لكن تعذّر منح الرتبة تلقائيًا.\n`
                + `تأكد أن رتبة البوت **أعلى** من الرتبة المطلوبة وأن عنده صلاحية Manage Roles، ثم اضغط **إعادة منح الرتبة**.\n`
                + `**لا تغلقوا التذكرة قبل تسليم الرتبة.** رقم الطلب: #${order.id}`,
            components: [staffActionsRow(order.id)],
        }));
        return false;
    }

    await safe('تحديث الطلب (completed)', () => db.updateOrder(order.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        error: null,
    }));
    if (order.duration_days) {
        await safe('تسجيل الاشتراك', () => db.addSubscription({
            user_id: member.id, role_id: order.role_id, product_id: order.product_id, order_id: order.id,
            expires_at: new Date(Date.now() + order.duration_days * 24 * 60 * 60 * 1000).toISOString(),
        }));
    }
    logOrder(channel.guild, 'completed', order, order.duration_days ? `اشتراك ${order.duration_days} يوم` : '');
    await safe('رسالة النجاح', () => channel.send({ content: `✅ تم منح الرتبة **${order.product_name}** بنجاح!` }));
    scheduleDelete(channel, 5000, { reason: 'اكتمل الطلب' });
    return true;
}

/**
 * يراقب الدفع لطلب معيّن ثم يسلّم أو يغلق حسب النتيجة.
 * @param {boolean} scanHistory  فحص رسائل القناة أولًا (يستخدم عند الاستعادة بعد إعادة التشغيل)
 */
async function runPaymentFlow({ channel, order, member = null, scanHistory = false }) {
    if (activeOrders.has(order.id)) return;
    activeOrders.add(order.id);

    let paid = false;
    try {
        if (!member) member = await channel.guild.members.fetch(order.user_id).catch(() => null);
        if (!member) {
            await safe('إلغاء الطلب (العضو غير موجود)', () => db.updateOrder(order.id, { status: 'cancelled', error: 'العضو غير موجود في السيرفر' }));
            scheduleDelete(channel, 1000, { reason: 'العضو غير موجود في السيرفر' });
            return;
        }

        const botId = process.env.PROBOT_ID || DEFAULT_PROBOT_ID;
        const settings = await db.getSettings().catch(() => ({ tax_percent: parseFloat(process.env.PROBOT_TAX_PERCENT) || 0 }));
        const taxPercent = Number(settings.tax_percent) || 0;
        const maxAmount = calculateMaxNet(order.send_amount, taxPercent);
        const common = { botId, userId: process.env.BANK_USER_ID, payerId: member.id };

        let result = null;

        if (scanHistory) {
            const found = await safe('فحص سجل القناة', () => findTransferInHistory({
                channel, ...common, since: new Date(order.created_at).getTime(),
            }));
            if (found) {
                result = {
                    status: evaluateAmount(found.actualAmount, order.required_amount, maxAmount),
                    actualAmount: found.actualAmount,
                };
            }
        }

        if (!result) {
            const remaining = new Date(order.expires_at).getTime() - Date.now();
            result = remaining <= 0
                ? { status: 'timeout', actualAmount: null }
                : await monitorTransferDetailed({
                    ...common,
                    amount: order.required_amount,
                    maxAmount,
                    timeout: remaining,
                    channel,
                });
        }

        const { status, actualAmount } = result;

        if (status === 'cancelled') {
            await safe('إلغاء الطلب', () => db.updateOrder(order.id, { status: 'cancelled', error: 'أُغلقت التذكرة قبل الدفع' }));
            return;
        }

        const logBase = {
            ticket_name: channel.name,
            user_id: member.id,
            username: member.user.tag,
            product_id: order.product_id,
            product_name: order.product_name,
            required_amount: order.required_amount,
            actual_amount: actualAmount,
            status,
            order_id: order.id,
        };

        if (status === 'success') {
            paid = true;
            // 💾 نحفظ الدفع أولًا قبل أي محاولة تسليم — لو صار شي بعده الطلب يبقى مسجل كمدفوع
            await safe('تحديث الطلب (paid)', () => db.updateOrder(order.id, {
                status: 'paid',
                actual_amount: actualAmount,
                paid_at: new Date().toISOString(),
            }));
            await safe('تسجيل اللوق', () => db.logTransfer(logBase));
            await fulfillOrder({ order, channel, member });
        } else if (status === 'underpaid' || status === 'overpaid') {
            // ⚠️ العميل حوّل فعلًا: لا نحذف التذكرة. تبقى مفتوحة والستاف يقرر (إرجاع / تكملة / قبول وتسليم)
            const diff = status === 'underpaid' ? 'أقل' : 'أكبر';
            await safe('تحديث الطلب (mismatch)', () => db.updateOrder(order.id, {
                status: 'mismatch',
                actual_amount: actualAmount,
                error: `مبلغ ${diff} من المطلوب (المحوّل ${actualAmount} — المطلوب ${order.required_amount})`,
            }));
            await safe('تسجيل اللوق', () => db.logTransfer(logBase));
            logOrder(channel.guild, 'mismatch', order, `المحوّل: ${actualAmount} — المطلوب: ${order.required_amount}`);
            await safe('رسالة المبلغ', () => channel.send({
                content: `${staffMention()} ⚠️ ${member} حوّل مبلغًا **${diff}** من المطلوب في الطلب #${order.id}.\n`
                    + `المحوّل: **${Number(actualAmount).toLocaleString()}** — المطلوب: **${Number(order.required_amount).toLocaleString()}**\n`
                    + `التذكرة **لن تُغلق تلقائيًا**. يا ${member} لا تحوّل أي مبلغ إضافي قبل ما يرد عليك الستاف.\n`
                    + `الستاف: اضغط **قبول وتسليم** لو المبلغ مقبول، أو عالجوا الأمر يدويًا ثم أغلقوا التذكرة.`,
                components: [staffActionsRow(order.id, { accept: true })],
            }));
        } else {
            await safe('تحديث الطلب (expired)', () => db.updateOrder(order.id, { status: 'expired', error: 'انتهت مهلة الدفع' }));
            await safe('تسجيل اللوق', () => db.logTransfer(logBase));
            await safe('رسالة المهلة', () => channel.send({
                content: '❌ لم يتم تأكيد التحويل خلال المهلة المحددة. حاول مرة أخرى لاحقاً، أو تواصل مع الستاف.',
            }));
            scheduleDelete(channel, 5000, { reason: 'انتهت مهلة الدفع' });
        }
    } catch (error) {
        // ⚠️ خطأ غير متوقع: ما نحذف التذكرة أبدًا (ممكن العميل دفع)، ننبه الستاف فقط
        console.error(`❌ خطأ غير متوقع في تدفق الدفع للطلب #${order.id}:`, error);
        alertError(`خطأ في معالجة الطلب #${order.id}`, error, { ping: true, context: `العميل: <@${order.user_id}> — ${order.product_name}` });
        await safe('تحديث الطلب (error)', () => db.updateOrder(order.id, {
            status: paid ? 'role_failed' : 'error',
            error: String(error.message || error).slice(0, 500),
        }));
        await safe('تنبيه الستاف', () => channel.send({
            content: `${staffMention()} ⚠️ حدث خطأ أثناء معالجة الطلب #${order.id}. الرجاء المراجعة يدويًا قبل إغلاق التذكرة.`,
            components: [staffActionsRow(order.id)],
        }));
    } finally {
        activeOrders.delete(order.id);
    }
}

/**
 * عند تشغيل البوت: يكمل الطلبات اللي كانت معلّقة (مدفوعة بدون تسليم، أو بانتظار الدفع).
 */
async function recoverOrders(guild) {
    let orders;
    try {
        orders = await db.getOrdersByStatus(['awaiting_payment', 'paid']);
    } catch (error) {
        console.error('❌ فشل جلب الطلبات المعلّقة للاستعادة:', error);
        return;
    }
    if (orders.length === 0) return;
    console.log(`🔄 استعادة ${orders.length} طلب معلّق...`);

    for (const order of orders) {
        const channel = await guild.channels.fetch(order.channel_id).catch(() => null);
        if (!channel) {
            await safe('إلغاء طلب بدون قناة', () => db.updateOrder(order.id, { status: 'cancelled', error: 'التذكرة غير موجودة عند الاستعادة' }));
            continue;
        }

        if (order.status === 'paid') {
            const member = await guild.members.fetch(order.user_id).catch(() => null);
            if (!member) {
                await safe('تحديث الطلب', () => db.updateOrder(order.id, { status: 'role_failed', error: 'العضو غير موجود في السيرفر' }));
                await safe('تنبيه الستاف', () => channel.send({
                    content: `${staffMention()} ⚠️ الطلب #${order.id} مدفوع لكن العضو <@${order.user_id}> غير موجود في السيرفر.`,
                    components: [staffActionsRow(order.id)],
                }));
                continue;
            }
            await fulfillOrder({ order, channel, member });
        } else {
            runPaymentFlow({ channel, order, scanHistory: true }).catch(e => console.error('❌ فشل استعادة طلب:', e));
        }
    }
}

/** هل الطلب قيد المراقبة الآن في هذه العملية؟ (الطلب بانتظار الدفع بدون مراقبة = يتيم) */
const isOrderActive = (orderId) => activeOrders.has(orderId);

module.exports = {
    isOrderActive,
    PAYMENT_TIMEOUT_MS,
    fulfillOrder,
    runPaymentFlow,
    recoverOrders,
};
