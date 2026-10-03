// utils/logger.js - لوق الستاف (روم يُحدد من الداشبورد > الإعدادات). لا يرمي أخطاء أبدًا.
const { EmbedBuilder } = require('discord.js');
const db = require('./db.js');

const KINDS = {
    completed:       ['🛒 شراء مكتمل', 0x3ba55d],
    role_created:    ['🎨 رتبة مخصصة جديدة', 0x3ba55d],
    role_edited:     ['✏️ تعديل رتبة', 0x3ba55d],
    failed_delivery: ['⚠️ فشل التسليم — يحتاج تدخل', 0xf0b232],
    mismatch:        ['❌ تحويل غير مطابق', 0xed4245],
    sub_expired:     ['⌛ انتهى اشتراك', 0x8a91a5],
};

const who = (u) => (u ? `<@${u.id ?? u}>` : '🤖 تلقائي (البوت)');

/**
 * لوق التذاكر في روم لوق البوت (الإعدادات ← لوق الستاف): فتح / إغلاق.
 * kind: 'opened' | 'closed'. لا يرمي أخطاء أبدًا.
 */
async function logTicket(guild, kind, { channel, ownerId = null, by = null, reason = '', ticketKind = 'purchase' } = {}) {
    try {
        const { log_channel_id } = await db.getSettings();
        if (!log_channel_id) return;
        const target = await guild.channels.fetch(log_channel_id).catch(() => null);
        if (!target?.isTextBased()) return;

        const owner = ownerId || /owner:(\d{17,20})/.exec(channel?.topic || '')?.[1] || null;
        const typeLabel = ticketKind === 'edit' || /^edit-/.test(channel?.name || '') ? 'تعديل رتبة' : 'شراء';
        const embed = new EmbedBuilder().setTimestamp();
        if (kind === 'opened') {
            embed.setColor(0x5865F2).setTitle('🎫 تذكرة جديدة')
                .addFields(
                    { name: 'فتحها', value: owner ? `<@${owner}>` : '—', inline: true },
                    { name: 'النوع', value: typeLabel, inline: true },
                    { name: 'التذكرة', value: channel ? `<#${channel.id}>` : '—', inline: true },
                );
        } else {
            embed.setColor(0xed4245).setTitle('🔒 تذكرة أُغلقت')
                .addFields(
                    { name: 'صاحب التذكرة', value: owner ? `<@${owner}>` : '—', inline: true },
                    { name: 'أغلقها', value: who(by), inline: true },
                    { name: 'التذكرة', value: `#${channel?.name || '—'}`, inline: true },
                );
            if (reason) embed.addFields({ name: 'السبب', value: String(reason).slice(0, 500) });
        }
        await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        console.error('❌ logTicket:', error);
    }
}

async function logOrder(guild, kind, order, note = '') {
    try {
        const { log_channel_id } = await db.getSettings();
        if (!log_channel_id) return;
        const channel = await guild.channels.fetch(log_channel_id).catch(() => null);
        if (!channel?.isTextBased()) return;

        const [title, color] = KINDS[kind];
        const price = order.discount_percent
            ? `${Number(order.original_amount).toLocaleString()} ← **${Number(order.required_amount).toLocaleString()}** (خصم ${order.discount_percent}%)`
            : Number(order.required_amount).toLocaleString();
        const embed = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp()
            .addFields(
                { name: 'العميل', value: `<@${order.user_id}>`, inline: true },
                { name: 'المنتج', value: order.product_name || '—', inline: true },
                { name: 'المبلغ', value: price, inline: true },
            )
            .setFooter({ text: `طلب #${order.id}` });
        if (note) embed.addFields({ name: 'ملاحظة', value: String(note).slice(0, 1000) });
        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('❌ logOrder:', error);
    }
}

module.exports = { logOrder, logTicket };
