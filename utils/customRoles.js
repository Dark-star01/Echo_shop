// utils/customRoles.js - تخصيص الرتبة بعد الدفع داخل التذكرة (اسم، ألوان، أيقونة، معاينة، إنشاء)
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
} = require('discord.js');
const db = require('./db.js');
const { logOrder } = require('./logger.js');
const { eph, checkTicketAccess, isStaffMember, staffMention, staffActionsRow, ticketButtonsRow, scheduleDelete } = require('./tickets.js');
const { COLOR_MODES, HOLOGRAPHIC, MAX_ICON_BYTES, permissionBits, parseHex } = require('./customRoleConfig.js');

const safe = async (fn) => { try { return await fn(); } catch (e) { console.error('❌ customRoles:', e); return null; } };
const holoHex = () => HOLOGRAPHIC.primaryColor;

// ---------- واجهة اللوحة ----------
function panelPayload(order, note = '') {
    const d = order.draft, s = d.settings;
    const embed = new EmbedBuilder()
        .setColor(d.mode === 'holographic' ? holoHex() : (parseHex(d.color1) ?? 0x5865F2))
        .setTitle(order.product_type === 'custom_edit' ? '🎨 عدّل رتبتك' : '🎨 صمّم رتبتك')
        .setDescription(`${note ? `${note}\n\n` : ''}اضبط رتبتك ثم اضغط **معاينة**، وإذا أعجبتك اضغط **تأكيد**.`)
        .addFields(
            { name: 'الاسم', value: d.name || '— لم يُحدد —', inline: true },
            { name: 'النمط', value: COLOR_MODES[d.mode], inline: true },
            { name: 'الأيقونة', value: s.allow_icon ? (d.icon_b64 ? '✅ جديدة' : (order.product_type === 'custom_edit' ? 'بدون تغيير' : '— لا يوجد —')) : 'غير متاحة', inline: true },
        )
        .setFooter({ text: `طلب #${order.id} | الاسم: حتى ${s.max_name_length} حرف` });
    if (d.mode !== 'holographic') {
        embed.addFields({ name: 'الألوان', value: [d.color1, d.mode === 'gradient' ? d.color2 : null].filter(Boolean).join(' ← ') || '— لم تُحدد —' });
    }

    const rows = [];
    if (s.color_modes.length > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`cust_mode_${order.id}`).setPlaceholder('نمط اللون')
                .addOptions(s.color_modes.map(m => ({ label: COLOR_MODES[m], value: m, default: m === d.mode })))
        ));
    }
    const buttons = [new ButtonBuilder().setCustomId(`cust_edit_${order.id}`).setLabel('✏️ الاسم والألوان').setStyle(ButtonStyle.Primary)];
    if (s.allow_icon) buttons.push(new ButtonBuilder().setCustomId(`cust_icon_${order.id}`).setLabel('🖼️ أيقونة').setStyle(ButtonStyle.Secondary));
    buttons.push(
        new ButtonBuilder().setCustomId(`cust_preview_${order.id}`).setLabel('👁️ معاينة').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`cust_confirm_${order.id}`).setLabel(order.product_type === 'custom_edit' ? '✅ تأكيد التعديل' : '✅ تأكيد الإنشاء').setStyle(ButtonStyle.Success),
    );
    rows.push(new ActionRowBuilder().addComponents(buttons), ticketButtonsRow());
    return { embeds: [embed], components: rows };
}

function previewEmbed(d) {
    const embed = new EmbedBuilder()
        .setColor(d.mode === 'holographic' ? holoHex() : (parseHex(d.color1) ?? 0x99aab5))
        .setTitle(d.name || '—')
        .setDescription(`النمط: **${COLOR_MODES[d.mode]}**` + (d.mode === 'gradient' ? `\n${d.color1} ← ${d.color2}` : d.mode === 'solid' ? `\n${d.color1}` : ''))
        .setFooter({ text: 'معاينة تقريبية — الشكل النهائي يظهر في قائمة الأعضاء' });
    const files = [];
    if (d.icon_b64) {
        files.push(new AttachmentBuilder(Buffer.from(d.icon_b64, 'base64'), { name: 'icon.png' }));
        embed.setThumbnail('attachment://icon.png');
    }
    return { embeds: [embed], files };
}

/** يتحقق من اكتمال المسودة، يرجع نص الخطأ أو null */
function validateDraft(d) {
    if (!d.name) return 'اكتب اسم الرتبة أولاً.';
    if (d.mode !== 'holographic' && parseHex(d.color1) === null) return 'حدد اللون الأول أولاً.';
    if (d.mode === 'gradient' && parseHex(d.color2) === null) return 'حدد اللون الثاني للتدرج.';
    return null;
}

// ---------- بدء التخصيص بعد الدفع ----------
async function startCustomization({ order, channel, member }) {
    const draft = { ...(order.draft || {}) };
    draft.mode = draft.mode || draft.settings?.color_modes?.[0] || 'solid';
    const updated = { ...order, draft };
    await channel.send({ content: `${member}`, ...panelPayload(updated, order.required_amount > 0 ? '✅ تم استلام الدفع!' : '') });
    await safe(() => db.updateOrder(order.id, { status: 'customizing', draft }));
    return true;
}

// ---------- إنشاء الرتبة فعليًا ----------
async function createCustomRole({ order, channel, member }) {
    const guild = channel.guild, d = order.draft;
    const fail = async (reason, error) => {
        console.error(`❌ فشل إنشاء رتبة مخصصة للطلب #${order.id}:`, error || reason);
        logOrder(guild, 'failed_delivery', order, reason);
        await safe(() => db.updateOrder(order.id, { status: 'role_failed', error: String(reason).slice(0, 500) }));
        await safe(() => channel.send({
            content: `${staffMention()} ⚠️ تعذّر إنشاء الرتبة المخصصة للطلب #${order.id}: **${reason}**\nبعد الإصلاح اضغط **إعادة منح الرتبة**. لا تغلقوا التذكرة.`,
            components: [staffActionsRow(order.id)],
        }));
        return false;
    };

    let role = order.role_id ? await guild.roles.fetch(order.role_id).catch(() => null) : null;
    if (!role) {
        const { reference_role_id } = await db.getSettings();
        if (!reference_role_id) return fail('لم تُحدد رتبة المرجع في لوحة التحكم ← الإعدادات');
        const ref = await guild.roles.fetch(reference_role_id).catch(() => null);
        if (!ref) return fail('رتبة المرجع غير موجودة في السيرفر');
        if (ref.position >= guild.members.me.roles.highest.position) return fail('رتبة البوت لازم تكون أعلى من رتبة المرجع');

        try {
            role = await guild.roles.create({
                name: d.name,
                colors: d.mode === 'holographic' ? HOLOGRAPHIC : {
                    primaryColor: parseHex(d.color1),
                    ...(d.mode === 'gradient' ? { secondaryColor: parseHex(d.color2) } : {}),
                },
                permissions: permissionBits(d.settings.permissions),
                icon: d.icon_b64 ? Buffer.from(d.icon_b64, 'base64') : undefined,
                hoist: false, mentionable: false,
                reason: `Echo Shop — طلب #${order.id} (${member.user.tag})`,
            });
        } catch (error) {
            return fail(`رفض ديسكورد الإنشاء: ${error.message}`, error);
        }
        // الرتبة تنشأ بالأسفل؛ نرفعها لتصير مباشرة تحت المرجع
        await safe(() => role.setPosition(Math.max(ref.position - 1, 1)));
        await safe(() => db.updateOrder(order.id, { role_id: role.id })); // لو فشل ما بعده ما نكرر الإنشاء
    }

    try {
        await member.roles.add(role, `Echo Shop — طلب #${order.id}`);
    } catch (error) {
        return fail(`تعذّر إعطاء الرتبة للعميل: ${error.message}`, error);
    }

    await safe(() => db.addCustomRole({ user_id: member.id, role_id: role.id, product_id: order.product_id, name: role.name, source: 'purchase', last_edited_at: new Date().toISOString() })); // فترة الانتظار تبدأ من الإنشاء
    const slim = { ...d, icon_b64: null }; // نحذف الصورة من القاعدة بعد الإنشاء
    await safe(() => db.updateOrder(order.id, { status: 'completed', role_id: role.id, completed_at: new Date().toISOString(), error: null, draft: slim }));
    logOrder(guild, 'role_created', order, `الرتبة: ${role.name}`);
    await safe(() => channel.send({ content: `✅ تم إنشاء رتبتك ${role} ومنحك إياها! سيُغلق التذكرة خلال ثوانٍ.` }));
    scheduleDelete(channel, 5000, { reason: 'اكتمل الطلب (رتبة مخصصة)' });
    return true;
}

// ---------- تعديل رتبة موجودة (بعد الدفع إن وُجد سعر) ----------
async function editCustomRole({ order, channel, member }) {
    const d = order.draft;
    const fail = async (reason, error) => {
        console.error(`❌ فشل تعديل الرتبة للطلب #${order.id}:`, error || reason);
        logOrder(channel.guild, 'failed_delivery', order, reason);
        await safe(() => db.updateOrder(order.id, { status: 'role_failed', error: String(reason).slice(0, 500) }));
        await safe(() => channel.send({
            content: `${staffMention()} ⚠️ تعذّر تعديل الرتبة للطلب #${order.id}: **${reason}**\nبعد الإصلاح اضغط **إعادة منح الرتبة**. لا تغلقوا التذكرة.`,
            components: [staffActionsRow(order.id)],
        }));
        return false;
    };

    const role = await channel.guild.roles.fetch(order.role_id).catch(() => null);
    if (!role) return fail('الرتبة المراد تعديلها غير موجودة في السيرفر');
    try {
        await role.edit({
            name: d.name,
            colors: d.mode === 'holographic' ? HOLOGRAPHIC : {
                primaryColor: parseHex(d.color1),
                ...(d.mode === 'gradient' ? { secondaryColor: parseHex(d.color2) } : {}),
            },
            ...(d.icon_b64 ? { icon: Buffer.from(d.icon_b64, 'base64') } : {}), // بدون أيقونة جديدة = تبقى الحالية
            reason: `Echo Shop — تعديل رتبة، طلب #${order.id} (${member.user.tag})`,
        });
    } catch (error) {
        return fail(`رفض ديسكورد التعديل: ${error.message}`, error);
    }

    await safe(() => db.updateCustomRole(role.id, { name: d.name, last_edited_at: new Date().toISOString() }));
    await safe(() => db.updateOrder(order.id, { status: 'completed', completed_at: new Date().toISOString(), error: null, draft: { ...d, icon_b64: null } }));
    logOrder(channel.guild, 'role_edited', order, `الرتبة: ${d.name}`);
    await safe(() => channel.send({ content: `✅ تم تعديل رتبتك ${role}! سيُغلق التذكرة خلال ثوانٍ.` }));
    scheduleDelete(channel, 5000, { reason: 'اكتمل تعديل الرتبة' });
    return true;
}

const finalizeRole = (args) => (args.order.product_type === 'custom_edit' ? editCustomRole(args) : createCustomRole(args));

// ---------- معالج التفاعلات (cust_<action>_<orderId>) ----------
async function handle(interaction) {
    const [, action, idStr] = interaction.customId.split('_');
    const order = await db.getOrderById(parseInt(idStr, 10)).catch(() => null);
    if (!order || !['custom', 'custom_edit'].includes(order.product_type) || order.channel_id !== interaction.channelId || !order.draft) {
        return interaction.reply(eph('⚠️ هذا الطلب غير صالح أو انتهى.'));
    }
    const staffAction = action === 'approve' || action === 'reject';
    if (staffAction) {
        if (!isStaffMember(interaction.member)) return interaction.reply(eph('❌ هذا الزر للستاف فقط.'));
    } else if (!(await checkTicketAccess(interaction))) return;

    const d = order.draft, s = d.settings;
    const need = staffAction ? 'pending_review' : 'customizing';
    if (order.status !== need) {
        return interaction.reply(eph(order.status === 'pending_review' ? '⏳ رتبتك بانتظار مراجعة الستاف.' : '⚠️ لا يمكن تنفيذ هذا الإجراء الآن.'));
    }
    const save = async (draft) => { order.draft = draft; await db.updateOrder(order.id, { draft }); };

    if (action === 'mode') {
        const mode = interaction.values[0];
        if (!s.color_modes.includes(mode)) return interaction.reply(eph('❌ هذا النمط غير متاح.'));
        await save({ ...d, mode });
        return interaction.update(panelPayload(order));
    }

    if (action === 'edit') {
        const input = (id, label, value, max) => new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setValue(value || ''));
        const modal = new ModalBuilder().setCustomId(`cust_modal_${order.id}`).setTitle('اسم رتبتك وألوانها')
            .addComponents(input('name', `اسم الرتبة (حتى ${s.max_name_length} حرف)`, d.name, s.max_name_length));
        if (d.mode !== 'holographic') modal.addComponents(input('color1', 'اللون الأول (Hex مثل #FF5733)', d.color1, 7));
        if (d.mode === 'gradient') modal.addComponents(input('color2', 'اللون الثاني (Hex مثل #3366FF)', d.color2, 7));
        return interaction.showModal(modal);
    }

    if (action === 'modal') { // إرسال المودال
        const name = interaction.fields.getTextInputValue('name').replace(/\s+/g, ' ').trim();
        const get = (k) => (interaction.fields.fields.has(k) ? interaction.fields.getTextInputValue(k).trim() : null);
        const lowered = name.toLowerCase();
        if (!name || name.length > s.max_name_length) return interaction.reply(eph(`❌ الاسم لازم يكون من 1 إلى ${s.max_name_length} حرف.`));
        if (s.banned_words.some(w => lowered.includes(w))) return interaction.reply(eph('❌ الاسم يحتوي كلمة غير مسموحة، اختر اسمًا آخر.'));
        const next = { ...d, name };
        for (const k of ['color1', 'color2']) {
            const v = get(k);
            if (v === null) continue;
            if (parseHex(v) === null) return interaction.reply(eph(`❌ اللون "${v}" غير صالح. استخدم صيغة Hex مثل #FF5733.`));
            next[k] = '#' + v.replace('#', '').toUpperCase();
        }
        await save(next);
        return interaction.update(panelPayload(order));
    }

    if (action === 'icon') {
        await interaction.reply(eph('🖼️ أرسل الصورة الآن في هذه التذكرة (PNG أو JPG، حتى 252KB). لديك دقيقتين.'));
        const got = await interaction.channel.awaitMessages({
            filter: m => m.author.id === interaction.user.id && m.attachments.size > 0, max: 1, time: 120_000,
        });
        const msg = got.first();
        if (!msg) return interaction.followUp(eph('⌛ انتهى الوقت، اضغط 🖼️ أيقونة للمحاولة مرة أخرى.'));
        const file = msg.attachments.first();
        if (!['image/png', 'image/jpeg'].includes(file.contentType?.split(';')[0])) {
            return interaction.followUp(eph('❌ الصيغة غير مدعومة، استخدم PNG أو JPG.'));
        }
        if (file.size > MAX_ICON_BYTES) {
            return interaction.followUp(eph('❌ حجم الأيقونة أكبر من الحد، الرجاء اختيار أيقونة أخرى أو ضغط الصورة إلى (252KB). إذا واجهت مشكلة يمكنك استدعاء الستاف في أي وقت.'));
        }
        const buffer = Buffer.from(await (await fetch(file.url)).arrayBuffer());
        await save({ ...d, icon_b64: buffer.toString('base64') });
        await safe(() => msg.delete()); // نحذف رسالة العميل (التخزين عندنا فقط حتى ينشأ الرتبة)
        await safe(() => interaction.message.edit(panelPayload(order)));
        return interaction.followUp(eph('✅ تم حفظ الأيقونة.'));
    }

    if (action === 'preview') {
        const error = validateDraft(d);
        return interaction.reply(error ? eph(`⚠️ ${error}`) : { ...previewEmbed(d), flags: eph('').flags });
    }

    if (action === 'confirm') {
        const error = validateDraft(d);
        if (error) return interaction.reply(eph(`⚠️ ${error}`));
        const confirmed = { ...d, confirmed: true };

        if (s.require_review) {
            await save(confirmed);
            await db.updateOrder(order.id, { status: 'pending_review' });
            await interaction.update({ embeds: [], components: [], content: '⏳ تم إرسال رتبتك لمراجعة الستاف، سيتم إنشاؤها فور الموافقة.' });
            // المراجعة تتم من لوحة التحكم ← المراجعات (يرى الستاف كل المدخلات ويوافق أو يرفض من هناك)
            const link = process.env.DASHBOARD_URL ? `\n🔗 ${process.env.DASHBOARD_URL.replace(/\/$/, '')} ← **المراجعات**` : '';
            return interaction.channel.send({
                content: `${staffMention()} 🔎 طلب مراجعة رتبة مخصصة #${order.id} من ${interaction.member}\nراجعوه من لوحة التحكم ثم وافقوا أو ارفضوا.${link}`,
                ...previewEmbed(d),
                allowedMentions: { roles: process.env.STAFF_ROLE_ID ? [process.env.STAFF_ROLE_ID] : [], users: [] },
            });
        }
        await interaction.update({ embeds: [], components: [], content: '⏳ جاري إنشاء رتبتك...' });
        await save(confirmed);
        await db.updateOrder(order.id, { status: 'paid' });
        const member = await interaction.guild.members.fetch(order.user_id).catch(() => null);
        if (!member) return;
        return finalizeRole({ order: { ...order, draft: confirmed }, channel: interaction.channel, member });
    }

    if (action === 'approve') {
        await interaction.update({ components: [] });
        await db.updateOrder(order.id, { status: 'paid' });
        const member = await interaction.guild.members.fetch(order.user_id).catch(() => null);
        if (!member) return interaction.followUp(eph('❌ العميل غير موجود في السيرفر.'));
        return finalizeRole({ order, channel: interaction.channel, member });
    }

    if (action === 'reject') {
        await save({ ...d, confirmed: false });
        await db.updateOrder(order.id, { status: 'customizing' });
        await interaction.update({ components: [] });
        return interaction.channel.send({
            content: `<@${order.user_id}>`,
            ...panelPayload(order, '❌ رفض الستاف رتبتك بصيغتها الحالية. عدّلها واضغط تأكيد من جديد، أو اضغط طلب ستاف لمعرفة السبب.'),
        });
    }
}

module.exports = { startCustomization, createCustomRole, editCustomRole, finalizeRole, handle, panelPayload };
