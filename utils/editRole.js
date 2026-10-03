// utils/editRole.js - زر «تعديل رتبتي»: للمشتري فقط، مع فترة انتظار وسعر تعديل من الداشبورد
const {
    ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');
const db = require('./db.js');
const { eph, ticketTopic, findOpenTicket } = require('./tickets.js');
const { calculateSendAmount, formatDuration } = require('./helpers.js');
const { sanitizeCustomSettings } = require('./customRoleConfig.js');
const { PAYMENT_TIMEOUT_MS, runPaymentFlow } = require('./payments.js');
const { startCustomization } = require('./customRoles.js');

const locks = new Set();
const DAY_MS = 24 * 60 * 60 * 1000;

// رتبة مربوطة يدويًا بدون منتج (أو منتجها انحذف): نستخدم إعدادات أول منتج قابل للإنشاء
async function resolveProduct(row) {
    let product = row.product_id ? await db.getProductById(row.product_id).catch(() => null) : null;
    if (!product || product.type !== 'custom') {
        product = (await db.getAllProducts()).find(p => p.type === 'custom') || null;
    }
    return product;
}

// يعبّي المسودة بمواصفات الرتبة الحالية
function prefill(role, settings) {
    const hex = (n) => '#' + Number(n).toString(16).padStart(6, '0').toUpperCase();
    const c = role.colors || {};
    let mode = c.tertiaryColor ? 'holographic' : c.secondaryColor ? 'gradient' : 'solid';
    if (!settings.color_modes.includes(mode)) mode = settings.color_modes[0];
    const primary = c.primaryColor ?? role.color;
    return {
        mode,
        name: role.name.slice(0, settings.max_name_length),
        color1: primary ? hex(primary) : '#99AAB5',
        color2: c.secondaryColor ? hex(c.secondaryColor) : '',
    };
}

async function handleEditButton(interaction) {
    const rows = await db.getCustomRolesByUser(interaction.user.id);
    if (!rows.length) {
        return interaction.reply(eph('🎨 تعديل الرتبة متاح فقط لمن اشترى رتبة قابلة للإنشاء. لازم تشتري رتبة أولاً من زر **طلب**.'));
    }
    if (rows.length === 1) return startEdit(interaction, rows[0], false);

    const menu = new StringSelectMenuBuilder().setCustomId('edit_pick').setPlaceholder('اختر الرتبة')
        .addOptions(rows.slice(0, 25).map(r => ({ label: String(r.name || r.role_id).slice(0, 100), value: String(r.id) })));
    return interaction.reply({
        content: 'اختر الرتبة التي تريد تعديلها:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleEditPick(interaction) {
    const rows = await db.getCustomRolesByUser(interaction.user.id); // نتأكد أنها رتبته فعلاً
    const row = rows.find(r => String(r.id) === interaction.values[0]);
    if (!row) return interaction.update({ content: '❌ هذه الرتبة غير مرتبطة بحسابك.', components: [] });
    return startEdit(interaction, row, true);
}

async function startEdit(interaction, row, fromPick) {
    if (fromPick) await interaction.update({ content: '⏳ جاري التجهيز...', components: [] });
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const done = (content) => interaction.editReply({ content, components: [] });

    const guild = interaction.guild, member = interaction.member;
    if (locks.has(member.id)) return done('⏳ جاري فتح تذكرتك، انتظر لحظة.');
    locks.add(member.id);

    let channel = null;
    try {
        const category = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);
        if (!category || category.type !== ChannelType.GuildCategory) return done('❌ فئة التذاكر غير موجودة أو غير صالحة!');

        const existing = findOpenTicket(category, member.id);
        if (existing) return done(`⚠️ عندك تذكرة مفتوحة بالفعل: ${existing}`);

        const role = await guild.roles.fetch(row.role_id).catch(() => null);
        if (!role) return done('❌ رتبتك لم تعد موجودة في السيرفر، تواصل مع الستاف.');

        const product = await resolveProduct(row);
        if (!product) return done('⚠️ تعديل الرتب غير متاح حالياً، تواصل مع الستاف.');
        const settings = sanitizeCustomSettings(product.custom_settings);

        // ⏳ فترة الانتظار بين كل تعديل وآخر
        const next = (row.last_edited_at ? new Date(row.last_edited_at).getTime() : 0) + settings.edit_cooldown_days * DAY_MS;
        if (next > Date.now()) {
            const t = Math.floor(next / 1000);
            return done(`⏳ تقدر تعدّل رتبتك مرة أخرى <t:${t}:R> (<t:${t}:f>).`);
        }

        const Flags = PermissionsBitField.Flags;
        const perms = [Flags.ViewChannel, Flags.SendMessages, Flags.ReadMessageHistory];
        const overwrites = [
            { id: guild.id, deny: [Flags.ViewChannel] },
            { id: member.id, allow: perms },
            { id: guild.members.me.id, allow: perms },
        ];
        if (process.env.STAFF_ROLE_ID) overwrites.push({ id: process.env.STAFF_ROLE_ID, allow: perms });

        channel = await guild.channels.create({
            name: `edit-${member.user.username}`, type: ChannelType.GuildText, parent: category.id,
            topic: ticketTopic(member.id), permissionOverwrites: overwrites,
        });

        const price = settings.edit_price;
        const botSettings = await db.getSettings().catch(() => ({ payment_mode: 'calculated', tax_percent: 0 }));
        const withTax = botSettings.payment_mode === 'with_tax';
        const sendAmount = price > 0 ? (withTax ? price : calculateSendAmount(price, botSettings.tax_percent)) : 0;

        const order = await db.createOrder({
            channel_id: channel.id, user_id: member.id, username: member.user.tag,
            product_id: product.id, product_name: `تعديل رتبة: ${role.name}`.slice(0, 100), role_id: role.id,
            required_amount: price, send_amount: sendAmount,
            expires_at: new Date(Date.now() + PAYMENT_TIMEOUT_MS).toISOString(),
            product_type: 'custom_edit',
            draft: { settings, ...prefill(role, settings), confirmed: false },
            status: price > 0 ? 'awaiting_payment' : 'paid', // مجاني: يبدأ التخصيص مباشرة
        });

        await done(`✅ تم فتح تذكرة التعديل: ${channel}`);

        if (price === 0) return startCustomization({ order, channel, member });

        const command = `C ${process.env.BANK_USER_ID} ${sendAmount}${withTax ? ' with tax' : ''}`;
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🧾 Echo Shop — دفع تعديل الرتبة')
            .setDescription(`تعديل رتبة **${role.name}** يكلّف **${price.toLocaleString()}** كريديت.\nحوّل المبلغ بالضبط بالأمر التالي:\n\`${command}\`\n\nبعد التحقق من التحويل تفتح لك لوحة التعديل تلقائياً.\n\n⚠️ **لا تحوّل مبلغاً مختلفاً** — أي مبلغ مختلف يغلق التذكرة.`)
            .setFooter({ text: `Echo Shop | ⏳ لديك ${formatDuration(PAYMENT_TIMEOUT_MS)} | طلب #${order.id}` });
        await channel.send({
            content: `${member}`,
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`copy_transfer_${sendAmount}${withTax ? '_tax' : ''}`).setLabel('📋 نسخ أمر التحويل').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('request_staff').setLabel('🆘 طلب ستاف').setStyle(ButtonStyle.Secondary),
            )],
        });
        runPaymentFlow({ channel, order, member }).catch((e) => console.error('❌ runPaymentFlow (edit):', e));
    } catch (error) {
        console.error('❌ فشل فتح تذكرة التعديل:', error);
        if (channel) channel.delete().catch(() => {}); // ما نترك تذكرة بدون طلب
        await done('❌ حدث خطأ أثناء فتح تذكرة التعديل، حاول مرة أخرى.').catch(() => {});
    } finally {
        locks.delete(member.id);
    }
}

module.exports = { handleEditButton, handleEditPick };
