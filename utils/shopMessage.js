// utils/shopMessage.js - إمبد المتجر الرئيسي + تحديثه تلقائيًا عند تغيير المنتجات
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./db.js');

const roleLabel = (p) => (p.role_id ? `<@&${p.role_id}>` : `**${p.name}** (رتبة قابلة للإنشاء)`);

function buildShopMessage(products) {
    const listText = products.length === 0
        ? 'لا توجد رتب متاحة حالياً.'
        : products.map(p => `${roleLabel(p)} — **${p.price.toLocaleString()}** كريديت${p.duration_days ? ` (${p.duration_days} يوم)` : ''}`).join('\n');

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛒 Echo Shop')
        .setDescription(`${listText}\n\nاضغط على زر **طلب** أدناه لفتح تذكرة واختيار الرتبة التي تريدها.`.slice(0, 4000))
        .setFooter({ text: 'Echo Shop — متجر الرتب الرسمي' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_request').setLabel('📩 طلب').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('shop_edit').setLabel('🎨 تعديل رتبتي').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
}

/** يعدّل رسالة المتجر المحفوظة (من /shopadmin setup). يرجع true لو تعدّلت. */
async function refreshNow(client) {
    const { shop_message } = await db.getSettings();
    if (!shop_message?.message_id) return false;
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const channel = await guild?.channels.fetch(shop_message.channel_id).catch(() => null);
    const message = await channel?.messages.fetch(shop_message.message_id).catch(() => null);
    if (!message) return false; // انحذفت الرسالة
    await message.edit(buildShopMessage(await db.getAllProducts()));
    return true;
}

// تأخير 3 ثواني لدمج التعديلات المتتالية في تحديث واحد
let timer = null;
function refreshShopMessage(client) {
    clearTimeout(timer);
    timer = setTimeout(() => refreshNow(client).catch((e) => console.error('❌ تحديث إمبد المتجر:', e)), 3000);
}

module.exports = { buildShopMessage, refreshNow, refreshShopMessage };
