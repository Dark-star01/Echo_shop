// commands/admin.js - أوامر إدارة المتجر (للمشرفين)
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../utils/db.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shopadmin')
        .setDescription('إدارة المتجر')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('إضافة منتج جديد')
            .addStringOption(opt => opt.setName('role_id').setDescription('معرف الرتبة').setRequired(true))
            .addStringOption(opt => opt.setName('name').setDescription('اسم المنتج').setRequired(true))
            .addIntegerOption(opt => opt.setName('price').setDescription('السعر بالكريديت').setRequired(true))
            .addStringOption(opt => opt.setName('description').setDescription('وصف المنتج'))
            .addStringOption(opt => opt.setName('features').setDescription('المميزات (كل سطر مميزة)'))
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
            .setName('setup')
            .setDescription('نشر إمبد المتجر في هذا الروم')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const role_id = interaction.options.getString('role_id');
            const name = interaction.options.getString('name');
            const price = interaction.options.getInteger('price');
            const description = interaction.options.getString('description') || '';
            const features = interaction.options.getString('features') || '';

            try {
                await db.addProduct({ role_id, name, price, description, features });
                await interaction.reply({ content: `✅ تم إضافة المنتج **${name}** بنجاح!`, ephemeral: true });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل الإضافة: ${error.message}`, ephemeral: true });
            }
        } else if (sub === 'remove') {
            const id = interaction.options.getInteger('id');
            try {
                const product = await db.getProductById(id);
                if (!product) {
                    return await interaction.reply({ content: '❌ المنتج غير موجود!', ephemeral: true });
                }
                await db.deleteProduct(id);
                await interaction.reply({ content: `✅ تم حذف المنتج **${product.name}** بنجاح!`, ephemeral: true });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل الحذف: ${error.message}`, ephemeral: true });
            }
        } else if (sub === 'list') {
            try {
                const products = await db.getAllProducts();
                if (products.length === 0) {
                    return await interaction.reply({ content: '📭 لا توجد منتجات حالياً.', ephemeral: true });
                }

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📋 قائمة المنتجات — Echo Shop')
                    .setDescription(products.map(p =>
                        `**#${p.id}** ${p.name} - ${p.price.toLocaleString()} كريديت\n` +
                        `  رتبة: <@&${p.role_id}>\n` +
                        `  الوصف: ${p.description || 'لا يوجد'}`
                    ).join('\n\n'))
                    .setFooter({ text: `إجمالي ${products.length} منتج` });

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل جلب المنتجات: ${error.message}`, ephemeral: true });
            }
        } else if (sub === 'setup') {
            try {
                const products = await db.getAllProducts();

                const listText = products.length === 0
                    ? 'لا توجد رتب متاحة حالياً.'
                    : products.map(p => `<@&${p.role_id}> — **${p.price.toLocaleString()}** كريديت`).join('\n');

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🛒 Echo Shop')
                    .setDescription(`${listText}\n\nاضغط على زر **طلب** أدناه لفتح تذكرة واختيار الرتبة التي تريدها.`)
                    .setFooter({ text: 'Echo Shop — متجر الرتب الرسمي' });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('shop_request')
                        .setLabel('📩 طلب')
                        .setStyle(ButtonStyle.Primary)
                );

                await interaction.channel.send({ embeds: [embed], components: [row] });
                await interaction.reply({ content: '✅ تم نشر إمبد المتجر في هذا الروم.', ephemeral: true });
            } catch (error) {
                await interaction.reply({ content: `❌ فشل النشر: ${error.message}`, ephemeral: true });
            }
        }
    }
};
