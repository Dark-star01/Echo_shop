require('dotenv').config();

// ============================================================
//  ✅  التحقق من متغيرات البيئة قبل أي شي
// ============================================================
const REQUIRED_ENV = ['DISCORD_TOKEN', 'GUILD_ID', 'BANK_USER_ID', 'TICKET_CATEGORY_ID', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ متغيرات البيئة الناقصة: ${missingEnv.join(', ')}`);
    process.exit(1);
}
if (!process.env.STAFF_ROLE_ID) console.warn('⚠️ STAFF_ROLE_ID غير محدد — الستاف لن يرون التذاكر إلا إذا كانوا أدمن.');

const {
    Client, Events, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ChannelType, PermissionsBitField, StringSelectMenuBuilder, REST, Routes, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('./utils/db.js');
const adminCommand = require('./commands/admin.js');
const { calculateSendAmount, formatDuration } = require('./utils/helpers.js');
const {
    eph, ticketTopic, staffMention, isStaffMember, checkTicketAccess, findOpenTicket, scheduleDelete, ticketButtonsRow,
} = require('./utils/tickets.js');
const customRoles = require('./utils/customRoles.js');
const editRole = require('./utils/editRole.js');
const alerts = require('./utils/alerts.js');
const staffCommands = require('./utils/staffCommands.js');
const { startIdleJob } = require('./utils/idleTickets.js');
const { applyDiscount, couponProblem } = require('./utils/coupons.js');
const { startSubscriptionJob } = require('./utils/subscriptions.js');
const { sanitizeCustomSettings } = require('./utils/customRoleConfig.js');
const { PAYMENT_TIMEOUT_MS, runPaymentFlow, fulfillOrder, recoverOrders } = require('./utils/payments.js');

// ============================================================
//  🤖  البوت
// ============================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection:', reason);
    alerts.alertError('Unhandled rejection', reason);
});
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    // حالة البوت غير مضمونة بعدها: ننبه الستاف ثم نخرج ليعيد ريندر التشغيل (والبوت يكمل الطلبات المعلّقة عند الإقلاع)
    alerts.alertError('Uncaught exception — البوت سيعيد التشغيل', error, { ping: true }).finally(() => setTimeout(() => process.exit(1), 1500));
});
client.on(Events.Error, (error) => {
    console.error('❌ Discord client error:', error);
    alerts.alertError('Discord client error', error);
});

// ============================================================
//  🔒  قفل البوت على السيرفر المحدد فقط
// ============================================================
function isAllowedGuild(guildId) {
    return guildId === process.env.GUILD_ID;
}

async function leaveGuild(guild) {
    console.log(`🚫 سيرفر غير مصرح: ${guild.name} (${guild.id}) — جاري المغادرة...`);
    try {
        await guild.leave();
    } catch (error) {
        console.error('❌ فشل مغادرة السيرفر غير المصرح:', error);
    }
}

client.on(Events.GuildCreate, async (guild) => {
    if (!isAllowedGuild(guild.id)) await leaveGuild(guild);
});

client.once(Events.ClientReady, async () => {
    console.log(`✅ ${client.user.tag} is ready!`);
    alerts.init(client);

    for (const guild of client.guilds.cache.values()) {
        if (!isAllowedGuild(guild.id)) await leaveGuild(guild);
    }
    console.log(`📡 Bot is online with ${client.guilds.cache.size} guild(s)`);

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
            { body: [adminCommand.data.toJSON()] }
        );
        console.log('✅ تم تسجيل أوامر السلاش بنجاح (فوري)');
    } catch (error) {
        console.error('❌ فشل تسجيل أوامر السلاش:', error);
    }

    require('./dashboard/server.js').start(client);

    // 🔄 إكمال أي طلبات كانت معلّقة قبل إيقاف/إعادة تشغيل البوت
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) {
        recoverOrders(guild).catch((e) => console.error('❌ فشل الاستعادة:', e));
        startSubscriptionJob(guild); // يسحب رتب الاشتراكات المنتهية
        startIdleJob(guild);         // يغلق التذاكر الخاملة (حسب الإعدادات)
    }
});

// ============================================================
//  🧩  مكوّنات مشتركة
// ============================================================
const ticketCreationLocks = new Set(); // يمنع فتح تذكرتين بنفس اللحظة لنفس العضو
const confirmLocks = new Set();        // يمنع بدء عمليتي دفع بنفس التذكرة
const staffCallCooldown = new Map();   // channelId -> وقت آخر نداء للستاف
const STAFF_CALL_COOLDOWN_MS = 60_000;

// ============================================================
//  ⚙️  التعامل مع كل التفاعلات
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.guild && !isAllowedGuild(interaction.guild.id)) return;

    try {
        await handleInteraction(interaction);
    } catch (error) {
        console.error('❌ خطأ غير متوقع في التفاعل:', error);
        alerts.alertError('خطأ في تفاعل', error, { context: `${interaction.customId || interaction.commandName} — ${interaction.user?.tag}` });
        const payload = eph('❌ حدث خطأ غير متوقع، حاول مرة أخرى أو اضغط طلب ستاف.');
        try {
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
            else await interaction.reply(payload);
        } catch (_) { /* التفاعل انتهت صلاحيته */ }
    }
});

// يمنع بيع منتج قابل للإنشاء قبل ما يكون جاهز (حتى لا يدفع العميل ثم تفشل الخدمة)
async function customProductBlock(product, userId) {
    if (product.type !== 'custom') return null;
    const { reference_role_id } = await db.getSettings().catch(() => ({}));
    if (!reference_role_id) return '⚠️ هذا المنتج غير متاح حالياً، تواصل مع الستاف.';
    const owned = await db.getCustomRolesByUser(userId).catch(() => []);
    if (owned.some(r => String(r.product_id) === String(product.id))) return '⚠️ لديك رتبة مخصصة من هذا المنتج بالفعل.';
    return null;
}

// 📦 إمبد المنتج وأزراره (مع خصم الكوبون لو موجود)
function productEmbed(product, coupon = null) {
    const price = coupon ? applyDiscount(product.price, coupon.percent) : product.price;
    const priceLine = coupon
        ? `~~${product.price.toLocaleString()}~~ **${price.toLocaleString()}** كريديت — 🎟️ خصم ${coupon.percent}% (\`${coupon.code}\`)`
        : `${product.price.toLocaleString()} كريديت`;
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📦 ${product.name}`)
        .setDescription(`
${product.description || 'لا يوجد وصف'}

**المميزات:**
${product.features || 'لا توجد مميزات محددة'}

**السعر:** ${priceLine}${product.duration_days ? `\n**المدة:** ${product.duration_days} يوم` : ''}
        `)
        .setFooter({ text: `Echo Shop | معرف المنتج: #${product.id}` });
}

function productRows(product, coupon = null) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(coupon ? `confirm_${product.id}_${coupon.id}` : `confirm_${product.id}`).setLabel('✅ تأكيد الشراء').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`coupon_${product.id}`).setLabel(coupon ? '🎟️ تغيير الكوبون' : '🎟️ لدي كوبون').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`cancel_${product.id}`).setLabel('❌ إلغاء').setStyle(ButtonStyle.Danger),
        ),
        ticketButtonsRow(),
    ];
}

// ⌨️ أوامر الستاف بالبادئة داخل التذاكر ($غلق، $حذف، ...)
client.on(Events.MessageCreate, (message) => {
    staffCommands.handleMessage(message).catch((error) => {
        console.error('❌ أمر ستاف:', error);
        message.reply({ content: '❌ تعذّر تنفيذ الأمر.', allowedMentions: { repliedUser: false } }).catch(() => {});
    });
});

async function handleInteraction(interaction) {
    // ------------------------------------------------------------
    //  أوامر السلاش
    // ------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'shopadmin') await adminCommand.execute(interaction);
        return;
    }

    // ✏️ تعديل الرتبة (زر «تعديل رتبتي» + اختيار الرتبة لو عنده أكثر من واحدة)
    if (interaction.isButton() && interaction.customId === 'shop_edit') return editRole.handleEditButton(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'edit_pick') return editRole.handleEditPick(interaction);

    // 🎨 تخصيص الرتب القابلة للإنشاء (أزرار/قوائم/مودال تبدأ بـ cust_)
    if (interaction.customId?.startsWith('cust_')) return customRoles.handle(interaction);

    // ------------------------------------------------------------
    //  📩  زر "طلب" -> فتح تذكرة شراء
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId === 'shop_request') {
        const guild = interaction.guild;
        const member = interaction.member;

        if (ticketCreationLocks.has(member.id)) {
            return interaction.reply(eph('⏳ جاري فتح تذكرتك، انتظر لحظة.'));
        }
        ticketCreationLocks.add(member.id);

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const category = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);
            if (!category || category.type !== ChannelType.GuildCategory) {
                return interaction.editReply({ content: '❌ فئة التذاكر غير موجودة أو غير صالحة!' });
            }

            const existing = findOpenTicket(category, member.id);
            if (existing) {
                return interaction.editReply({ content: `⚠️ عندك تذكرة مفتوحة بالفعل: ${existing}` });
            }

            let products;
            try {
                products = await db.getAllProducts();
            } catch (error) {
                console.error('❌ فشل جلب المنتجات:', error);
                return interaction.editReply({ content: '❌ حدث خطأ أثناء جلب المنتجات.' });
            }
            if (products.length === 0) {
                return interaction.editReply({ content: '❌ لا توجد منتجات متاحة حالياً.' });
            }

            const Flags = PermissionsBitField.Flags;
            const ticketPerms = [Flags.ViewChannel, Flags.SendMessages, Flags.ReadMessageHistory];
            const overwrites = [
                { id: guild.id, deny: [Flags.ViewChannel] },
                { id: member.id, allow: ticketPerms },
                { id: client.user.id, allow: ticketPerms },
            ];
            if (process.env.STAFF_ROLE_ID) overwrites.push({ id: process.env.STAFF_ROLE_ID, allow: ticketPerms });

            let ticketChannel;
            try {
                ticketChannel = await guild.channels.create({
                    name: `ticket-${member.user.username}`,
                    type: ChannelType.GuildText,
                    parent: category.id,
                    topic: ticketTopic(member.id),
                    permissionOverwrites: overwrites,
                });
            } catch (error) {
                console.error('❌ فشل إنشاء التذكرة:', error);
                return interaction.editReply({ content: '❌ تعذّر إنشاء التذكرة (قد تكون فئة التذاكر ممتلئة). تواصل مع الستاف.' });
            }

            await interaction.editReply({ content: `✅ تم فتح تذكرتك في ${ticketChannel}` });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_role')
                .setPlaceholder('اختر الرتبة التي تريد شراءها')
                .addOptions(
                    products.slice(0, 25).map(p => ({ // حد ديسكورد: 25 خيار بالقائمة
                        label: p.name.slice(0, 100),
                        description: `${p.price.toLocaleString()} كريديت`,
                        value: String(p.id),
                    }))
                );

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🛒 Echo Shop — اختر الرتبة')
                .setDescription('اختر الرتبة التي تريد شراءها من القائمة أدناه.\nإذا احتجت مساعدة بأي وقت، اضغط زر **طلب ستاف**.');

            await ticketChannel.send({
                content: `${member}`,
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(selectMenu), ticketButtonsRow()],
            });
        } finally {
            ticketCreationLocks.delete(member.id);
        }
        return;
    }

    // ------------------------------------------------------------
    //  📋  نسخ أمر التحويل
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('copy_transfer_')) {
        if (!(await checkTicketAccess(interaction))) return;
        const [amount, suffix] = interaction.customId.replace('copy_transfer_', '').split('_');
        const command = `C ${process.env.BANK_USER_ID} ${amount}${suffix === 'tax' ? ' with tax' : ''}`;
        return interaction.reply(eph(`\`${command}\``));
    }

    // ------------------------------------------------------------
    //  🆘  طلب ستاف
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId === 'request_staff') {
        if (!(await checkTicketAccess(interaction))) return;

        const last = staffCallCooldown.get(interaction.channelId) || 0;
        const wait = STAFF_CALL_COOLDOWN_MS - (Date.now() - last);
        if (wait > 0) {
            return interaction.reply(eph(`⏳ تم استدعاء الستاف قبل قليل، انتظر ${Math.ceil(wait / 1000)} ثانية.`));
        }
        staffCallCooldown.set(interaction.channelId, Date.now());

        return interaction.reply({
            content: `${staffMention()} 🆘 العميل ${interaction.member} يحتاج مساعدة في هذه التذكرة.`,
        });
    }

    // ------------------------------------------------------------
    //  🔒  إغلاق التذكرة (صاحبها أو الستاف)
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
        if (!(await checkTicketAccess(interaction, { allowStaff: true }))) return;

        const active = await db.getActiveOrderByChannel(interaction.channelId).catch(() => null);
        const staff = isStaffMember(interaction.member);

        // دفع تم لكن بدون تسليم: بس الستاف يغلق (عشان ما يضيع حق العميل)
        if (active && active.status !== 'awaiting_payment' && !staff) {
            return interaction.reply(eph('⚠️ هناك عملية دفع قيد المعالجة في هذه التذكرة. تواصل مع الستاف لإغلاقها.'));
        }
        if (active && ['paid', 'role_failed', 'customizing', 'pending_review'].includes(active.status)) {
            await db.updateOrder(active.id, { status: 'closed_manually', error: `أغلقها ${interaction.user.tag}` }).catch(() => {});
        }

        await interaction.reply({ content: '🔒 سيتم إغلاق التذكرة خلال 3 ثواني...' });
        scheduleDelete(interaction.channel, 3000);
        return;
    }

    // ------------------------------------------------------------
    //  🔁  إعادة منح الرتبة (ستاف فقط) بعد فشل التسليم
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('retry_role_')) {
        if (!isStaffMember(interaction.member)) {
            return interaction.reply(eph('❌ هذا الزر للستاف فقط.'));
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const orderId = parseInt(interaction.customId.replace('retry_role_', ''), 10);
        const order = await db.getOrderById(orderId).catch(() => null);
        if (!order || !['role_failed', 'error', 'paid'].includes(order.status)) {
            return interaction.editReply({ content: '⚠️ هذا الطلب غير موجود أو تم تسليمه بالفعل.' });
        }
        if (order.channel_id !== interaction.channelId) {
            return interaction.editReply({ content: '⚠️ هذا الطلب يخص تذكرة أخرى.' });
        }

        const member = await interaction.guild.members.fetch(order.user_id).catch(() => null);
        if (!member) {
            return interaction.editReply({ content: '❌ العميل غير موجود في السيرفر.' });
        }

        const ok = await fulfillOrder({ order, channel: interaction.channel, member });
        return interaction.editReply({ content: ok ? '✅ تم منح الرتبة.' : '❌ فشلت المحاولة مرة أخرى، راجع رسالة التنبيه.' });
    }

    // ------------------------------------------------------------
    //  📋  اختيار رتبة من القائمة المنسدلة
    // ------------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_role') {
        if (!(await checkTicketAccess(interaction))) return;

        const productId = parseInt(interaction.values[0], 10);
        let product;
        try {
            product = await db.getProductById(productId);
        } catch (error) {
            console.error('❌ فشل جلب المنتج:', error);
            return interaction.reply(eph('❌ حدث خطأ أثناء جلب المنتج.'));
        }
        if (!product) {
            return interaction.reply(eph('❌ هذا المنتج لم يعد متاحاً.'));
        }
        if (product.role_id && interaction.member.roles.cache.has(product.role_id)) {
            return interaction.reply(eph('⚠️ أنت تملك هذه الرتبة بالفعل!'));
        }
        const blocked = await customProductBlock(product, interaction.user.id);
        if (blocked) return interaction.reply(eph(blocked));

        return interaction.update({ embeds: [productEmbed(product)], components: productRows(product) });
    }

    // ------------------------------------------------------------
    //  🎟️  إدخال كوبون خصم
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('coupon_')) {
        if (!(await checkTicketAccess(interaction))) return;
        const modal = new ModalBuilder()
            .setCustomId(`couponmodal_${interaction.customId.replace('coupon_', '')}`)
            .setTitle('كوبون الخصم')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('code').setLabel('أدخل كود الكوبون').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)
            ));
        return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('couponmodal_')) {
        if (!(await checkTicketAccess(interaction))) return;
        const product = await db.getProductById(parseInt(interaction.customId.replace('couponmodal_', ''), 10)).catch(() => null);
        if (!product) return interaction.reply(eph('❌ هذا المنتج لم يعد متاحاً.'));
        const coupon = await db.getCouponByCode(interaction.fields.getTextInputValue('code')).catch(() => null);
        const problem = await couponProblem(coupon, interaction.user.id);
        if (problem) return interaction.reply(eph(`❌ ${problem}`));
        return interaction.update({ embeds: [productEmbed(product, coupon)], components: productRows(product, coupon) });
    }

    // ------------------------------------------------------------
    //  ❌  إلغاء الشراء (صاحب التذكرة أو الستاف)
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('cancel_')) {
        if (!(await checkTicketAccess(interaction, { allowStaff: true }))) return;
        await interaction.update({ content: '❌ تم إلغاء عملية الشراء.', embeds: [], components: [] });
        scheduleDelete(interaction.channel, 3000);
        return;
    }

    // ------------------------------------------------------------
    //  ✅  تأكيد الشراء -> إنشاء الطلب + تعليمات الدفع + مراقبة التحويل
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('confirm_')) {
        if (!(await checkTicketAccess(interaction))) return;

        const channel = interaction.channel;
        if (confirmLocks.has(channel.id)) {
            return interaction.reply(eph('⏳ جاري تجهيز عملية الدفع.'));
        }
        confirmLocks.add(channel.id);

        try {
            await interaction.deferUpdate();
            const fail = (content) => interaction.followUp(eph(content));

            const active = await db.getActiveOrderByChannel(channel.id).catch(() => null);
            if (active) return fail('⚠️ لديك عملية دفع جارية بالفعل في هذه التذكرة.');

            const [, productIdRaw, couponIdRaw] = interaction.customId.split('_'); // confirm_<product>[_<coupon>]
            const productId = parseInt(productIdRaw, 10);
            let product;
            try {
                product = await db.getProductById(productId);
            } catch (error) {
                console.error('❌ فشل جلب المنتج:', error);
                return fail('❌ حدث خطأ أثناء جلب المنتج.');
            }
            if (!product) return fail('❌ هذا المنتج لم يعد متاحاً.');

            const member = interaction.member;
            if (product.role_id && member.roles.cache.has(product.role_id)) return fail('⚠️ أنت تملك هذه الرتبة بالفعل!');
            const blocked = await customProductBlock(product, member.id);
            if (blocked) return fail(blocked);

            // 🎟️ نعيد التحقق من الكوبون وقت التأكيد (ممكن انتهى أو استُنفد)
            let coupon = null;
            if (couponIdRaw) {
                coupon = await db.getCouponById(parseInt(couponIdRaw, 10)).catch(() => null);
                const problem = await couponProblem(coupon, member.id);
                if (problem) return fail(`❌ ${problem}`);
            }

            // 💰 لا توجد ضريبة متجر — السعر هو الصافي المطلوب، ونطلب من العميل مبلغ أكبر ليغطي ضريبة بروبوت
            const totalAmount = coupon ? applyDiscount(product.price, coupon.percent) : product.price;
            const settings = await db.getSettings().catch(() => ({ payment_mode: 'calculated', tax_percent: parseFloat(process.env.PROBOT_TAX_PERCENT) || 0 }));
            // الوضع with_tax: العميل يكتب السعر + with tax وبروبوت يضيف الضريبة | الوضع calculated: البوت يحسب المبلغ
            const withTax = settings.payment_mode === 'with_tax';
            const sendAmount = totalAmount === 0 ? 0 : (withTax ? totalAmount : calculateSendAmount(totalAmount, settings.tax_percent));
            const transferCommand = `C ${process.env.BANK_USER_ID} ${sendAmount}${withTax ? ' with tax' : ''}`;

            let order;
            try {
                order = await db.createOrder({
                    channel_id: channel.id,
                    user_id: member.id,
                    username: member.user.tag,
                    product_id: product.id,
                    product_name: product.name,
                    role_id: product.role_id,
                    product_type: product.type || 'fixed',
                    draft: product.type === 'custom' ? { settings: sanitizeCustomSettings(product.custom_settings) } : null,
                    required_amount: totalAmount,
                    send_amount: sendAmount,
                    coupon_id: coupon?.id ?? null,
                    discount_percent: coupon?.percent ?? null,
                    original_amount: coupon ? product.price : null,
                    duration_days: product.type === 'fixed' ? product.duration_days : null,
                    status: totalAmount === 0 ? 'paid' : 'awaiting_payment', // خصم 100%: بدون دفع
                    expires_at: new Date(Date.now() + PAYMENT_TIMEOUT_MS).toISOString(),
                });
            } catch (error) {
                console.error('❌ فشل إنشاء الطلب:', error);
                return fail('❌ تعذّر إنشاء الطلب، حاول مرة أخرى.');
            }

            // سباق: شخصان استخدما آخر استخدام بنفس اللحظة — نعيد العدّ بعد إنشاء الطلب
            if (coupon) {
                const overTotal = coupon.max_uses != null && (await db.countCouponUses(coupon.id)) > coupon.max_uses;
                const overUser = coupon.max_uses_per_user != null && (await db.countCouponUses(coupon.id, member.id)) > coupon.max_uses_per_user;
                if (overTotal || overUser) {
                    await db.updateOrder(order.id, { status: 'cancelled', error: 'تجاوز حد استخدام الكوبون' }).catch(() => {});
                    return fail('❌ استُنفد هذا الكوبون للتو. اختر منتجك من جديد بدون كوبون أو بكوبون آخر.');
                }
            }

            if (totalAmount === 0) {
                await interaction.editReply({ content: `🎟️ تم تطبيق الكوبون (خصم ${coupon.percent}%) — جاري تسليم طلبك...`, embeds: [], components: [] });
                fulfillOrder({ order, channel, member }).catch((e) => console.error('❌ fulfillOrder (مجاني):', e));
                return;
            }

            const discountNote = coupon ? `🎟️ كوبون **${coupon.code}**: خصم ${coupon.percent}% (السعر الأصلي ${product.price.toLocaleString()})\n\n` : '';
            const payEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🧾 Echo Shop — إتمام عملية الشراء')
                .setDescription(`
${discountNote}لشراء رتبة **${product.name}**، قم بتحويل المبلغ التالي بالضبط إلى حساب البنك باستخدام الأمر التالي:
\`${transferCommand}\`

سيتم التحقق من التحويل ومنحك الرتبة تلقائياً بعد إتمامه فعليًا.

⚠️ **لا تحوّل أي مبلغ غير المبلغ المذكور أعلاه بالضبط.** أي مبلغ مختلف (أكثر أو أقل) سيؤدي لإغلاق التذكرة تلقائيًا فورًا.
                `)
                .setFooter({ text: `Echo Shop | ⏳ لديك ${formatDuration(PAYMENT_TIMEOUT_MS)} لإتمام التحويل | طلب #${order.id}` });

            const payRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`copy_transfer_${sendAmount}${withTax ? '_tax' : ''}`).setLabel('📋 نسخ أمر التحويل').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('request_staff').setLabel('🆘 طلب ستاف').setStyle(ButtonStyle.Secondary),
            );

            await interaction.editReply({ embeds: [payEmbed], components: [payRow] });

            runPaymentFlow({ channel, order, member }).catch((e) => console.error('❌ runPaymentFlow:', e));
        } finally {
            confirmLocks.delete(channel.id);
        }
        return;
    }
}

// ============================================================
//  🏁  تشغيل البوت
// ============================================================
client.login(process.env.DISCORD_TOKEN);
