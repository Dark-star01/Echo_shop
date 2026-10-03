// utils/alerts.js - تنبيه الستاف بالأخطاء غير المتوقعة (روم التنبيهات، أو روم اللوق كاحتياط)
const { EmbedBuilder } = require('discord.js');
const db = require('./db.js');

let client = null;
const recent = new Map(); // نفس الخطأ لا يتكرر خلال 5 دقائق
let hourStart = Date.now(), hourCount = 0; // حد أقصى 20 تنبيه بالساعة

const init = (c) => { client = c; };

async function alertError(title, error, { context = '', ping = false } = {}) {
    try {
        if (!client) return;
        const message = String(error?.message || error);
        const key = `${title}|${message}`;
        const now = Date.now();
        if (recent.get(key) > now - 5 * 60 * 1000) return;
        if (recent.size > 200) recent.clear();
        recent.set(key, now);
        if (now - hourStart > 60 * 60 * 1000) { hourStart = now; hourCount = 0; }
        if (++hourCount > 20) return;

        const { alert_channel_id, log_channel_id } = await db.getSettings();
        const channelId = alert_channel_id || log_channel_id;
        if (!channelId) return;
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const channel = await guild?.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return;

        const embed = new EmbedBuilder().setColor(0xed4245).setTitle(`🚨 ${title}`).setTimestamp()
            .setDescription('```' + String(error?.stack || message).replace(/`/g, "'").slice(0, 1500) + '```');
        if (context) embed.addFields({ name: 'السياق', value: String(context).slice(0, 1000) });
        await channel.send({
            content: ping && process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : undefined,
            embeds: [embed],
        });
    } catch (e) {
        console.error('❌ alertError:', e);
    }
}

module.exports = { init, alertError };
