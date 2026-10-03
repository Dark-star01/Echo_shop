// utils/subscriptions.js - سحب الرتب المنتهية (يعمل عند التشغيل ثم كل 10 دقائق)
// المنطق جاهز للاشتراكات الشهرية؛ المنتج الذي له duration_days يُسجَّل تلقائيًا بعد التسليم.
const db = require('./db.js');
const { logOrder } = require('./logger.js');
const { alertError } = require('./alerts.js');

const INTERVAL_MS = 10 * 60 * 1000;

// 📩 إشعار انتهاء الاشتراك على الخاص — لو الخاص مقفول يُتجاهل بصمت (الرتبة انسحبت أصلًا)
async function notifyExpired(guild, sub) {
    try {
        const user = await guild.client.users.fetch(sub.user_id);
        const roleName = guild.roles.cache.get(sub.role_id)?.name || 'الرتبة';
        await user.send(`⌛ انتهى اشتراكك في رتبة **${roleName}** في سيرفر **${guild.name}** وتم سحبها.\nلو حاب تجدد، افتح تذكرة جديدة من المتجر.`);
        return true;
    } catch (_) {
        return false;
    }
}

async function runOnce(guild) {
    let due;
    try { due = await db.getDueSubscriptions(); } catch (error) { return console.error('❌ فحص الاشتراكات:', error); }

    for (const sub of due) {
        try {
            const member = await guild.members.fetch(sub.user_id).catch(() => null);
            if (member && member.roles.cache.has(sub.role_id)) {
                await member.roles.remove(sub.role_id, `Echo Shop — انتهى الاشتراك #${sub.id}`);
            }
            await db.updateSubscription(sub.id, { status: 'expired' });
            await notifyExpired(guild, sub);
            await logOrder(guild, 'sub_expired', { id: sub.order_id, user_id: sub.user_id, product_name: `رتبة <@&${sub.role_id}>`, required_amount: 0 });
        } catch (error) {
            console.error(`❌ فشل سحب رتبة الاشتراك #${sub.id}:`, error);
            alertError(`فشل سحب رتبة اشتراك #${sub.id}`, error, { context: `العميل: <@${sub.user_id}> — الرتبة: <@&${sub.role_id}>` });
            await db.updateSubscription(sub.id, { status: 'removal_failed' }).catch(() => {});
        }
    }
}

function startSubscriptionJob(guild) {
    runOnce(guild);
    setInterval(() => runOnce(guild), INTERVAL_MS).unref();
}

module.exports = { startSubscriptionJob, runOnce, notifyExpired };
