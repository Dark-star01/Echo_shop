// commands/admin.js - أوامر إدارة المتجر (للمشرفين)
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../utils/db.js');
const { isValidRoleId } = require('../utils/helpers.js');
const { buildShopMessage, refreshShopMessage } = require('../utils/shopMessage.js');

const EPHEMERAL = MessageFlags.Ephemeral;

const roleLabel = (p) => (p.role_id ? `<@&${p.role_id}>` : `**${p.name}** (رتبة قابلة للإنشاء)`);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shopadmin')
        .setDescription('إدارة المتجر')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('إضافة منتج جديد')
            .addStringOption(opt => opt.setName('role_id').setDescription('معرف الرتبة').setRequired(true))
            .addStringOption(opt => opt.setName('name').setDescription('اسم المنتج').setRequired(true).setMaxLength(100))
            .addIntegerOption(opt => opt.setName('price').setDescription('السعر بالكريديت').setRequired(true).setMinValue(1))
            .addStringOption(opt => opt.setName('description').setDescription('وصف المنتج').setMaxLength(500))
            .addStringOption(opt => opt.setName('features').setDescription('المميزات (كل سطر مميزة)').setMaxLength(1000))
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('حذف منتج')
            .addIntegerOption(opt => opt.setName('id').setDescription('معرف المنتج').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('عرض جميع المنتجات')
        )
        .addSubcommand(sub => sub
            .setName('link')
            .setDescription('ربط عضو برتبة خاصة سابقة (قبل نظام الرتب القابلة للإنشاء)')
            .addUserOption(opt => opt.setName('user').setDescription('صاحب الرتبة').setRequired(true))
            .addRoleOption(opt => opt.setName('role').setDescription('رتبته الخاصة').setRequired(true))
            .addIntegerOption(opt => opt.setName('product').setDescription('معرف المنتج القابل للإنشاء (لتطبق عليه إعدادات التعديل)'))
        )
        .addSubcommand(sub => sub
            .setName('unlink')
            .setDescription('فك ربط رتبة مخصصة')
            .addRoleOption(opt => opt.setName('role').setDescription('الرتبة').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('diagnose')
            .setDescription('فحص صحة فتح التذاكر (صلاحيات، فئة، قاعدة بيانات)')
        )
        .addSubcommand(sub => sub
            .setName('setup')
            .setDescription('نشر إمبد المتجر في هذا الروم')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const role_id = interaction.options.getString('role_id').trim();
            const name = interaction.options.getString('name').trim();
            const price = interaction.options.getInteger('price');
            const description = interaction.options.getString('description') || '';
            const features = interaction.options.getString('features') || '';

            if (!isValidRoleId(role_id)) {
                return interaction.reply({ content: '❌ معرف الرتبة غير صالح (لازم أرقام فقط، 17–20 رقم).', flags: EPHEMERAL });
            }

            // نتأكد أن الرتبة موجودة وأن البوت يقدر يعطيها (عشان ما نكتشف المشكلة بعد ما العميل يدفع)
            const guild = interaction.guild;
            const role = guild.roles.cache.get(role_id) ?? await guild.roles.fetch(role_id).catch(() => null);
            if (!role) {
                return interaction.reply({ content: '❌ هذه الرتبة غير موجودة في السيرفر.', flags: EPHEMERAL });
            }
            if (role.managed || role.id === guild.id) {
                return interaction.reply({ content: '❌ لا يمكن بيع هذه الرتبة (رتبة بوت/تكامل أو @everyone).', flags: EPHEMERAL });
            }
            const botCanAssign = guild.members.me && role.position < guild.members.me.roles.highest.position;

            try {
                await db.addProduct({ role_id, name, price, description, features });
                refreshShopMessage(interaction.client);
                const warning = botCanAssign ? '' : '\n⚠️ **تنبيه:** رتبة البوت ليست أعلى من هذه الرتبة — لن يقدر يعطيها! ارفع رتبة البوت قبل البيع.';
                await interaction.reply({ content: `✅ تم إضافة المنتج **${name}** بنجاح!${warning}`, flags: EPHEMERAL });
            } catch (error) {
                const msg = error.code === '23505' ? 'هذه الرتبة مضافة كمنتج بالفعل.' : error.message;
                await interaction.reply({ content: `❌ فشل الإضافة: ${msg}`, flags: EPHEMERAL });
            }
        } else if (sub === 'remove') {
            const id = interaction.options.getInteger('id');
            try {
                const product = await db.getProductById(id);
                if (!product) {
                    return await interaction.reply({ content: '❌ المنتج غير موجود!', flags: EPHEMERAL });
                }
                await db.deleteProduct(id);
                refreshShopMessage(interaction.client);
                await interaction.reply({ content: `✅ تم حذف المنتج **${product.name}** بنجاح!`, flags: EPHEMERAL });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل الحذف: ${error.message}`, flags: EPHEMERAL });
            }
        } else if (sub === 'list') {
            try {
                const products = await db.getAllProducts();
                if (products.length === 0) {
                    return await interaction.reply({ content: '📭 لا توجد منتجات حالياً.', flags: EPHEMERAL });
                }

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📋 قائمة المنتجات — Echo Shop')
                    .setDescription(products.map(p =>
                        `**#${p.id}** ${p.name} - ${p.price.toLocaleString()} كريديت\n` +
                        `  رتبة: ${roleLabel(p)}\n` +
                        `  الوصف: ${p.description || 'لا يوجد'}`
                    ).join('\n\n').slice(0, 4000))
                    .setFooter({ text: `إجمالي ${products.length} منتج` });

                await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل جلب المنتجات: ${error.message}`, flags: EPHEMERAL });
            }
        } else if (sub === 'link') {
            const user = interaction.options.getUser('user');
            const role = interaction.options.getRole('role');
            const productId = interaction.options.getInteger('product');
            if (role.managed || role.id === interaction.guild.id) {
                return interaction.reply({ content: '❌ لا يمكن ربط هذه الرتبة (رتبة بوت/تكامل أو @everyone).', flags: EPHEMERAL });
            }
            try {
                if (productId && !(await db.getProductById(productId))) {
                    return await interaction.reply({ content: '❌ المنتج غير موجود!', flags: EPHEMERAL });
                }
                const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                await db.addCustomRole({ user_id: user.id, role_id: role.id, product_id: productId, name: role.name, source: 'linked' });
                const warn = member && member.roles.cache.has(role.id) ? '' : '\n⚠️ تنبيه: العضو لا يملك هذه الرتبة حالياً.';
                await interaction.reply({ content: `✅ تم ربط ${user} برتبته ${role}.${warn}`, flags: EPHEMERAL });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل الربط: ${error.message}`, flags: EPHEMERAL });
            }
        } else if (sub === 'unlink') {
            const role = interaction.options.getRole('role');
            try {
                await db.deleteCustomRole(role.id);
                await interaction.reply({ content: `✅ تم فك ربط ${role} (الرتبة نفسها لم تُحذف من السيرفر).`, flags: EPHEMERAL });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل فك الربط: ${error.message}`, flags: EPHEMERAL });
            }
        } else if (sub === 'diagnose') {
            await interaction.deferReply({ flags: EPHEMERAL });
            try {
                await interaction.editReply({ embeds: [await require('../utils/diagnose.js').runDiagnostics(interaction.guild)] });
            } catch (error) {
                await interaction.editReply({ content: `❌ فشل التشخيص: ${error.message}` });
            }
        } else if (sub === 'setup') {
            try {
                const products = await db.getAllProducts();

                // نحفظ مكان الرسالة لتتحدث تلقائيًا عند أي تغيير في المنتجات
                const sent = await interaction.channel.send(buildShopMessage(products));
                await db.saveSettings({ shop_message: { channel_id: sent.channelId, message_id: sent.id } });
                await interaction.reply({ content: '✅ تم نشر إمبد المتجر في هذا الروم، وسيتحدث تلقائياً عند أي تغيير في المنتجات.', flags: EPHEMERAL });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل النشر: ${error.message}`, flags: EPHEMERAL });
            }
        }
    }
};
