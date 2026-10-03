// utils/alerts.js - الأخطاء البرمجية تُرسل إلى ويب هوك (سيرفر آخر) عبر ERROR_WEBHOOK_URL.
// احتياطي: لو الويب هوك غير محدد، تُرسل لروم «تنبيهات الأخطاء» من الداشبورد (ولا تُخلط بروم لوق البوت).
const { EmbedBuilder } = require('discord.js');
const db = require('./db.js');

let client = null;
const recent = new Map(); // نفس الخطأ لا يتكرر خلال 5 دقائق
let hourStart = Date.now(), hourCount = 0; // حد أقصى 20 تنبيه بالساعة

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+(?:\?[\w=&-]*)?$/;
const WEBHOOK_TIMEOUT_MS = 10_000;

const init = (c) => { client = c; };

function webhookUrl() {
    const url = String(process.env.ERROR_WEBHOOK_URL || '').trim();
    return WEBHOOK_RE.test(url) ? url : null;
}

async function postToWebhook(url, { title, error, message, context, ping }) {
    const guild = client?.guilds?.cache?.get(process.env.GUILD_ID);
    const embed = {
        color: 0xed4245,
        title: `🚨 ${title}`.slice(0, 256),
        description: '```' + String(error?.stack || message).replace(/`/g, "'").slice(0, 1800) + '```',
        timestamp: new Date().toISOString(),
        fields: [],
        footer: { text: `${client?.user?.tag || 'Echo Shop'}${guild ? ` • ${guild.name}` : ''}`.slice(0, 200) },
    };
    if (context) embed.fields.push({ name: 'السياق', value: String(context).slice(0, 1000) });

    const mention = String(process.env.ERROR_WEBHOOK_MENTION || '').trim(); // اختياري: <@&roleId> أو <@userId> من سيرفر الويب هوك
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        body: JSON.stringify({
            username: 'Echo Shop — أخطاء',
            content: ping && mention ? mention : undefined,
            embeds: [embed],
            allowed_mentions: { parse: ping && mention ? ['roles', 'users'] : [] },
        }),
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

async function alertError(title, error, { context = '', ping = false } = {}) {
    try {
        const message = String(error?.message || error);
        const key = `${title}|${message}`;
        const now = Date.now();
        if (recent.get(key) > now - 5 * 60 * 1000) return;
        if (recent.size > 200) recent.clear();
        recent.set(key, now);
        if (now - hourStart > 60 * 60 * 1000) { hourStart = now; hourCount = 0; }
        if (++hourCount > 20) return;

        // 1) الويب هوك (سيرفر المطوّر)
        const url = webhookUrl();
        if (url) return await postToWebhook(url, { title, error, message, context, ping });

        // 2) احتياطي: روم التنبيهات داخل السيرفر (فقط لو محدد)
        if (!client) return;
        const { alert_channel_id } = await db.getSettings();
        if (!alert_channel_id) return;
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const channel = await guild?.channels.fetch(alert_channel_id).catch(() => null);
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

module.exports = { init, alertError, webhookUrl };
