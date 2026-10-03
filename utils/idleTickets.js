// utils/idleTickets.js - إغلاق التذاكر الخاملة (تحذير أولًا ثم إغلاق بعد ساعة بدون رد)
// لا تُغلق أي تذكرة فيها طلب جارٍ أو مدفوع أو يحتاج ستاف — فقط التذاكر الفاضية من أي طلب.
const { ChannelType } = require('discord.js');
const db = require('./db.js');
const { getTicketOwnerId, scheduleDelete } = require('./tickets.js');
const { alertError } = require('./alerts.js');

const INTERVAL_MS = 10 * 60 * 1000;
const GRACE_MS = 60 * 60 * 1000;
const MARK = '⏰';
const TERMINAL = ['completed', 'failed', 'expired', 'cancelled', 'closed_manually'];

async function checkChannel(guild, channel, hours) {
    const ownerId = getTicketOwnerId(channel);
    if (channel.type !== ChannelType.GuildText || !ownerId) return;

    const orders = await db.getOrdersByChannel(channel.id);
    if (orders.some(o => !TERMINAL.includes(o.status))) return;

    const last = (await channel.messages.fetch({ limit: 1 })).first();
    const lastAt = last ? last.createdTimestamp : channel.createdTimestamp;
    const isWarning = last && last.author.id === guild.client.user.id && last.content.includes(MARK);

    if (isWarning) {
        if (Date.now() - lastAt >= GRACE_MS) {
            await channel.send('🔒 تم إغلاق التذكرة لعدم النشاط.');
            scheduleDelete(channel, 2000);
        }
    } else if (Date.now() - lastAt >= hours * 60 * 60 * 1000) {
        await channel.send(`<@${ownerId}> ${MARK} لا يوجد نشاط في هذه التذكرة. سيتم إغلاقها خلال ساعة، اكتب أي رسالة للإبقاء عليها.`);
    }
}

// 🧹 تذاكر يتيمة: روم أُنشئ لكن لم تصله أي رسالة (فشل الإرسال/انقطاع) — تُحذف بعد دقيقتين من إنشائها
const ORPHAN_AGE_MS = 2 * 60 * 1000;
async function sweepEmptyTickets(guild, { dryRun = false } = {}) {
    const category = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);
    if (!category) return 0;
    let count = 0;
    for (const channel of [...category.children.cache.values()]) {
        try {
            if (channel.type !== ChannelType.GuildText || !getTicketOwnerId(channel)) continue;
            if (!(Date.now() - channel.createdTimestamp >= ORPHAN_AGE_MS)) continue;
            if ((await channel.messages.fetch({ limit: 1 })).size > 0) continue;
            if ((await db.getOrdersByChannel(channel.id)).length > 0) continue;
            count++;
            if (!dryRun) { console.warn(`🧹 حذف تذكرة يتيمة فاضية: ${channel.name}`); await channel.delete('Echo Shop — تذكرة فاضية'); }
        } catch (e) { console.error(`❌ فحص التذكرة اليتيمة ${channel.name}:`, e.message); }
    }
    return count;
}

async function runOnce(guild) {
    await sweepEmptyTickets(guild).catch((e) => console.error('❌ تنظيف التذاكر اليتيمة:', e));
    try {
        const hours = Number((await db.getSettings()).idle_close_hours) || 0;
        const category = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);
        if (hours <= 0 || !category) return;
        for (const channel of category.children.cache.values()) {
            await checkChannel(guild, channel, hours).catch((e) => console.error(`❌ فحص تذكرة خاملة ${channel.name}:`, e));
        }
    } catch (error) {
        console.error('❌ فحص التذاكر الخاملة:', error);
        alertError('فحص التذاكر الخاملة', error);
    }
}

function startIdleJob(guild) {
    setTimeout(() => runOnce(guild), 30_000).unref();
    setInterval(() => runOnce(guild), INTERVAL_MS).unref();
}

module.exports = { startIdleJob, sweepEmptyTickets };
