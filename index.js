require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, StringSelectMenuBuilder, REST, Routes } = require('discord.js');
const db = require('./utils/db.js');

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

const adminCommand = require('./commands/admin.js');

// ============================================================
//  🔒  قفل البوت على السيرفر المحدد فقط
// ============================================================
function isAllowedGuild(guildId) {
    return guildId === process.env.GUILD_ID;
}

client.on('guildCreate', async (guild) => {
    if (!isAllowedGuild(guild.id)) {
        console.log(`🚫 محاولة إضافة البوت لسيرفر غير مصرح: ${guild.name} (${guild.id}) — جاري المغادرة...`);
        try {
            await guild.leave();
        } catch (error) {
            console.error('❌ فشل مغادرة السيرفر غير المصرح:', error);
        }
    }
});

client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} is ready!`);

    // مغادرة أي سيرفر غير مصرح (لو البوت موجود فيه من قبل)
    for (const guild of client.guilds.cache.values()) {
        if (!isAllowedGuild(guild.id)) {
            console.log(`🚫 البوت موجود في سيرفر غير مصرح: ${guild.name} (${guild.id}) — جاري المغادرة...`);
            try {
                await guild.leave();
            } catch (error) {
                console.error('❌ فشل مغادرة السيرفر غير المصرح:', error);
            }
        }
    }

    console.log(`📡 Bot is online with ${client.guilds.cache.size} guild(s)`);

    // تسجيل السلاش كوماند بشكل فوري (على مستوى السيرفر المحدد فقط)
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

    // تشغيل خادم الويب
    require('./dashboard/server.js');
});

// ============================================================
//  ⚙️  التعامل مع كل التفاعلات
// ============================================================
client.on('interactionCreate', async (interaction) => {
    // حماية إضافية: تجاهل أي تفاعل من سيرفر غير مصرح
    if (interaction.guild && !isAllowedGuild(interaction.guild.id)) return;

    // ------------------------------------------------------------
    //  أوامر السلاش
    // ------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'shopadmin') {
            await adminCommand.execute(interaction);
        }
        return;
    }

    // ------------------------------------------------------------
    //  📩  زر "طلب" -> فتح تذكرة شراء
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId === 'shop_request') {
        const guild = interaction.guild;
        const member = interaction.member;

        const category = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);
        if (!category || category.type !== ChannelType.GuildCategory) {
            return interaction.reply({ content: '❌ فئة التذاكر غير موجودة أو غير صالحة!', ephemeral: true });
        }

        let products;
        try {
            products = await db.getAllProducts();
        } catch (error) {
            return interaction.reply({ content: '❌ حدث خطأ أثناء جلب المنتجات.', ephemeral: true });
        }

        if (products.length === 0) {
            return interaction.reply({ content: '❌ لا توجد منتجات متاحة حالياً.', ephemeral: true });
        }

        const ticketChannel = await guild.channels.create({
            name: `ticket-${member.user.username}`,
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                { id: process.env.STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
            ],
        });

        await interaction.reply({ content: `✅ تم فتح تذكرتك في ${ticketChannel}`, ephemeral: true });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_role')
            .setPlaceholder('اختر الرتبة التي تريد شراءها')
            .addOptions(
                products.map(p => ({
                    label: p.name,
                    description: `${p.price.toLocaleString()} كريديت`,
                    value: String(p.id),
                }))
            );

        const selectRow = new ActionRowBuilder().addComponents(selectMenu);
        const staffRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('request_staff')
                .setLabel('🆘 طلب ستاف')
                .setStyle(ButtonStyle.Secondary)
        );

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛒 Echo Shop — اختر الرتبة')
            .setDescription('اختر الرتبة التي تريد شراءها من القائمة أدناه.\nإذا احتجت مساعدة بأي وقت، اضغط زر **طلب ستاف**.');

        await ticketChannel.send({ content: `${member}`, embeds: [embed], components: [selectRow, staffRow] });
        return;
    }

    // ------------------------------------------------------------
    //  📋  نسخ أمر التحويل (رد خاص يحتوي الأمر بصيغة كود منفردة)
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('copy_transfer_')) {
        const amount = interaction.customId.replace('copy_transfer_', '');
        await interaction.reply({
            content: `\`C ${process.env.BANK_USER_ID} ${amount}\``,
            ephemeral: true,
        });
        return;
    }

    // ------------------------------------------------------------
    //  🆘  طلب ستاف (داخل نفس تذكرة الشراء)
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId === 'request_staff') {
        const staffMention = process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : 'الستاف';
        await interaction.reply({
            content: `${staffMention} 🆘 العميل ${interaction.member} يحتاج مساعدة في هذه التذكرة.`,
        });
        return;
    }

    // ------------------------------------------------------------
    //  📋  اختيار رتبة من القائمة المنسدلة
    // ------------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_role') {
        const productId = parseInt(interaction.values[0]);
        let product;
        try {
            product = await db.getProductById(productId);
        } catch (error) {
            return interaction.reply({ content: '❌ حدث خطأ أثناء جلب المنتج.', ephemeral: true });
        }

        if (!product) {
            return interaction.reply({ content: '❌ هذا المنتج لم يعد متاحاً.', ephemeral: true });
        }

        const member = interaction.member;
        if (member.roles.cache.has(product.role_id)) {
            return interaction.reply({ content: '⚠️ أنت تملك هذه الرتبة بالفعل!', ephemeral: true });
        }

        const totalAmount = product.price; // 💰 لا توجد ضريبة متجر — السعر نفسه هو الصافي المطلوب

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📦 ${product.name}`)
            .setDescription(`
${product.description || 'لا يوجد وصف'}

**المميزات:**
${product.features || 'لا توجد مميزات محددة'}

**السعر:** ${totalAmount.toLocaleString()} كريديت
            `)
            .setFooter({ text: `Echo Shop | معرف المنتج: #${product.id}` });

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`confirm_${product.id}`)
                .setLabel('✅ تأكيد الشراء')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`cancel_${product.id}`)
                .setLabel('❌ إلغاء')
                .setStyle(ButtonStyle.Danger)
        );
        const staffRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('request_staff')
                .setLabel('🆘 طلب ستاف')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [actionRow, staffRow] });
        return;
    }

    // ------------------------------------------------------------
    //  ❌  إلغاء الشراء
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('cancel_')) {
        await interaction.update({ content: '❌ تم إلغاء عملية الشراء.', embeds: [], components: [] });
        setTimeout(async () => {
            try { await interaction.channel.delete(); } catch (e) {}
        }, 3000);
        return;
    }

    // ------------------------------------------------------------
    //  ✅  تأكيد الشراء -> تعليمات الدفع + مراقبة التحويل
    // ------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('confirm_')) {
        const productId = parseInt(interaction.customId.replace('confirm_', ''));
        let product;
        try {
            product = await db.getProductById(productId);
        } catch (error) {
            return interaction.reply({ content: '❌ حدث خطأ أثناء جلب المنتج.', ephemeral: true });
        }

        const member = interaction.member;
        const ticketChannel = interaction.channel;

        if (!product) {
            return interaction.reply({ content: '❌ هذا المنتج لم يعد متاحاً.', ephemeral: true });
        }

        const totalAmount = product.price; // 💰 لا توجد ضريبة متجر — السعر نفسه هو الصافي المطلوب

        // 🏦 بروبوت يقتطع ضريبته الخاصة من أي تحويل بين الأعضاء (نسبة قابلة للتعديل من إعدادات بروبوت)
        // فنطلب من العميل يرسل مبلغ أكبر شوي عشان يوصل الصافي المطلوب فعليًا بعد اقتطاع بروبوت
        const probotTaxPercent = parseFloat(process.env.PROBOT_TAX_PERCENT) || 0;
        const sendAmount = probotTaxPercent > 0
            ? Math.ceil(totalAmount / (1 - probotTaxPercent / 100))
            : totalAmount;

        const payEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🧾 Echo Shop — إتمام عملية الشراء')
            .setDescription(`
لشراء رتبة **${product.name}**، قم بتحويل المبلغ التالي بالضبط إلى حساب البنك باستخدام الأمر التالي:
\`C ${process.env.BANK_USER_ID} ${sendAmount}\`

سيتم التحقق من التحويل ومنحك الرتبة تلقائياً بعد إتمامه فعليًا.

⚠️ **لا تحوّل أي مبلغ غير المبلغ المذكور أعلاه بالضبط.** أي مبلغ مختلف (أكثر أو أقل) سيؤدي لإغلاق التذكرة تلقائيًا فورًا.
            `)
            .setFooter({ text: `Echo Shop | ⏳ لديك دقيقتين لإتمام التحويل | معرف المنتج: #${product.id}` });

        const staffRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`copy_transfer_${sendAmount}`)
                .setLabel('📋 نسخ أمر التحويل')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('request_staff')
                .setLabel('🆘 طلب ستاف')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [payEmbed], components: [staffRow] });

        try {
            const { monitorTransferDetailed } = require('./utils/transfer.js');
            const { status, actualAmount } = await monitorTransferDetailed({
                botId: process.env.PROBOT_ID || '282859044593598464',
                userId: process.env.BANK_USER_ID,
                amount: totalAmount,
                timeout: 120000, // دقيقتين — عشان يتسع وقت لكتابة الأمر وحل كابتشا بروبوت
                channel: ticketChannel,
            });

            const logBase = {
                ticket_name: ticketChannel.name,
                user_id: member.id,
                username: member.user.tag,
                product_id: product.id,
                product_name: product.name,
                required_amount: totalAmount,
                actual_amount: actualAmount,
                status,
            };

            if (status === 'success') {
                await member.roles.add(product.role_id);
                await ticketChannel.send({ content: `✅ تم منح الرتبة **${product.name}** بنجاح!` });
                try { await db.logTransfer(logBase); } catch (e) { console.error('❌ فشل تسجيل اللوق:', e); }
                setTimeout(async () => {
                    try { await ticketChannel.delete(); } catch (e) {}
                }, 5000);
            } else if (status === 'underpaid' || status === 'overpaid') {
                await ticketChannel.send({
                    content: `❌ المبلغ المحوّل **غير مطابق** للمبلغ المطلوب بالضبط. تم إغلاق التذكرة تلقائيًا.\nإذا كنت تعتقد أن هذا خطأ، تواصل مع الستاف.`,
                });
                try { await db.logTransfer(logBase); } catch (e) { console.error('❌ فشل تسجيل اللوق:', e); }
                setTimeout(async () => {
                    try { await ticketChannel.delete(); } catch (e) {}
                }, 5000);
            } else {
                await ticketChannel.send({ content: '❌ لم يتم تأكيد التحويل خلال المهلة المحددة. حاول مرة أخرى لاحقاً، أو اضغط طلب ستاف.' });
                try { await db.logTransfer(logBase); } catch (e) { console.error('❌ فشل تسجيل اللوق:', e); }
                setTimeout(async () => {
                    try { await ticketChannel.delete(); } catch (e) {}
                }, 5000);
            }
        } catch (error) {
            console.error('❌ Error in transfer monitoring:', error);
            await ticketChannel.send({ content: '❌ حدث خطأ أثناء التحقق من التحويل. يرجى الضغط على طلب ستاف.' });
            setTimeout(async () => {
                try { await ticketChannel.delete(); } catch (e) {}
            }, 5000);
        }
        return;
    }
});

// ============================================================
//  🏁  تشغيل البوت
// ============================================================
client.login(process.env.DISCORD_TOKEN);
