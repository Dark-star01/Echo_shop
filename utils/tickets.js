// utils/tickets.js - أدوات التذاكر (ملكية التذكرة، صلاحيات الأزرار، الحذف المؤجل)
const { PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const db = require('./db.js');
const { logTicket } = require('./logger.js');

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

// صاحب التذكرة يُحفظ في وصف القناة (topic) فيبقى محفوظ حتى بعد إعادة تشغيل البوت
function ticketTopic(userId) {
    return `Echo Shop ticket | owner:${userId}`;
}

function getTicketOwnerId(channel) {
    const match = /owner:(\d{17,20})/.exec(channel?.topic || '');
    return match ? match[1] : null;
}

function staffMention() {
    return process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : 'الستاف';
}

function isStaffMember(member) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    return process.env.STAFF_ROLE_ID ? member.roles.cache.has(process.env.STAFF_ROLE_ID) : false;
}

/**
 * يتحقق أن المتفاعل هو صاحب التذكرة (أو ستاف لو allowStaff).
 * لو لا، يرد برسالة خاصة ويرجع false.
 */
async function checkTicketAccess(interaction, { allowStaff = false } = {}) {
    const ownerId = getTicketOwnerId(interaction.channel);
    // تذاكر قديمة بدون topic: نعتمد على صلاحية العضو المخصصة في القناة
    const isOwner = ownerId
        ? interaction.user.id === ownerId
        : interaction.channel?.permissionOverwrites?.cache?.has(interaction.user.id);
    const allowed = isOwner || (allowStaff && isStaffMember(interaction.member));

    if (!allowed) {
        await interaction.reply(eph('❌ هذا الزر خاص بصاحب التذكرة فقط.')).catch(() => {});
    }
    return Boolean(allowed);
}

function findOpenTicket(category, userId) {
    return category.children.cache.find(ch => getTicketOwnerId(ch) === userId) || null;
}

// 📄 نسخة نصية من المحادثة تُرسل لروم النسخ (إن حُدد في الإعدادات) قبل حذف التذكرة
async function sendTranscript(channel) {
    const { transcript_channel_id } = await db.getSettings();
    if (!transcript_channel_id) return;
    const target = await channel.guild.channels.fetch(transcript_channel_id).catch(() => null);
    if (!target?.isTextBased()) return;

    const all = [];
    let before;
    for (let page = 0; page < 5; page++) { // حتى 500 رسالة
        const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
        if (batch.size === 0) break;
        all.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    const lines = all.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map((m) => {
        const parts = [m.content];
        for (const a of m.attachments.values()) parts.push(`[مرفق: ${a.url}]`);
        for (const e of m.embeds) parts.push(`[embed: ${[e.title, e.description].filter(Boolean).join(' — ').replace(/\n/g, ' ')}]`);
        return `[${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16)}] ${m.author.tag}: ${parts.filter(Boolean).join(' ')}`;
    });
    const ownerId = getTicketOwnerId(channel);
    await target.send({
        content: `📄 نسخة تذكرة **${channel.name}**${ownerId ? ` — صاحبها <@${ownerId}>` : ''}`,
        files: [new AttachmentBuilder(Buffer.from(lines.join('\n') || '(فارغة)', 'utf8'), { name: `${channel.name}.txt` })],
        allowedMentions: { parse: [] },
    });
}

const loggedClosed = new Set(); // تذاكر سُجّل إغلاقها (يمنع التكرار)
const quietDeletes = new Set();  // حذف داخلي بدون لوق (تذكرة فاضية فشل تجهيزها)

/** حذف روم بدون تسجيله في اللوق كإغلاق تذكرة */
function quietDelete(channel) {
    quietDeletes.add(channel.id);
    return channel.delete().catch(() => {});
}

/**
 * يحذف التذكرة بعد مهلة، مع نسخة المحادثة، ويسجّل «تذكرة أُغلقت» في لوق البوت.
 * by: العضو الذي أغلقها (null = تلقائي) | reason: السبب
 */
function scheduleDelete(channel, ms = 5000, { transcript = true, by = null, reason = '' } = {}) {
    setTimeout(async () => {
        if (transcript) await sendTranscript(channel).catch((e) => console.error('❌ فشل حفظ نسخة التذكرة:', e));
        if (!loggedClosed.has(channel.id)) {
            loggedClosed.add(channel.id);
            await logTicket(channel.guild, 'closed', { channel, by, reason });
        }
        channel.delete().catch(() => {});
    }, ms);
}

/** حدث حذف أي روم: لو كانت تذكرة انحذفت يدويًا من ديسكورد (بدون البوت) نسجّلها */
async function handleChannelDelete(channel) {
    if (loggedClosed.delete(channel.id)) return;
    if (quietDeletes.delete(channel.id)) return;
    if (!channel.guild || channel.parentId !== process.env.TICKET_CATEGORY_ID || !getTicketOwnerId(channel)) return;
    await logTicket(channel.guild, 'closed', { channel, reason: 'حُذفت يدويًا من ديسكورد' });
}

function ticketButtonsRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('request_staff').setLabel('🆘 طلب ستاف').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 إغلاق التذكرة').setStyle(ButtonStyle.Secondary),
    );
}

function staffActionsRow(orderId, { accept = false } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`retry_role_${orderId}`)
            .setLabel(accept ? '✅ قبول وتسليم الرتبة' : '🔁 إعادة منح الرتبة').setStyle(accept ? ButtonStyle.Success : ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 إغلاق التذكرة').setStyle(ButtonStyle.Secondary),
    );
}

module.exports = {
    ticketButtonsRow,
    staffActionsRow,
    eph,
    ticketTopic,
    getTicketOwnerId,
    staffMention,
    isStaffMember,
    checkTicketAccess,
    findOpenTicket,
    scheduleDelete,
    quietDelete,
    handleChannelDelete,
};
