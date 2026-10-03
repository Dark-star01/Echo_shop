// utils/staffCommands.js - أوامر الستاف داخل التذاكر بالبادئة (الافتراضي $): $غلق $حذف $اضافة $ازالة $اسم $اعادة $مساعدة
const db = require('./db.js');
const { getTicketOwnerId, isStaffMember, scheduleDelete } = require('./tickets.js');
const { fulfillOrder } = require('./payments.js');

const PREFIX = process.env.STAFF_PREFIX || '$';
const PAID_STATES = ['paid', 'role_failed', 'customizing', 'pending_review']; // عميل دفع ولم يستلم

// توحيد الكتابة: همزات الألف، التاء المربوطة، الياء المقصورة
const norm = (w) => String(w).toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
const ALIASES = {
    close: 'close', غلق: 'close', اغلاق: 'close',
    delete: 'delete', حذف: 'delete',
    add: 'add', اضافه: 'add',
    remove: 'remove', ازاله: 'remove',
    rename: 'rename', اسم: 'rename',
    retry: 'retry', اعاده: 'retry',
    help: 'help', مساعده: 'help',
};
const isConfirm = (w) => ['تاكيد', 'confirm'].includes(norm(w));

const HELP = [
    `\`${PREFIX}غلق [السبب]\` — إغلاق التذكرة مع حفظ نسخة المحادثة (حذف بعد 3 ثواني)`,
    `\`${PREFIX}حذف\` — حذف التذكرة فورًا بدون نسخة`,
    `\`${PREFIX}اضافة @عضو\` / \`${PREFIX}ازالة @عضو\` — إضافة أو إزالة عضو من التذكرة`,
    `\`${PREFIX}اسم <الاسم الجديد>\` — تغيير اسم التذكرة`,
    `\`${PREFIX}اعادة\` — إعادة محاولة تسليم طلب فشل تسليمه`,
    `إذا كان في التذكرة طلب مدفوع غير مُسلَّم، أضف كلمة **تأكيد** لـ غلق/حذف.`,
].join('\n');

async function handleMessage(message) {
    if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
    if (message.guild.id !== process.env.GUILD_ID) return;
    const ownerId = getTicketOwnerId(message.channel);
    if (!ownerId || !isStaffMember(message.member)) return;

    const [cmdRaw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = ALIASES[norm(cmdRaw)];
    if (!cmd) return;

    const channel = message.channel;
    const reply = (content) => message.reply({ content, allowedMentions: { repliedUser: false } });

    if (cmd === 'help') return reply(HELP);

    if (cmd === 'close' || cmd === 'delete') {
        const orders = await db.getOrdersByChannel(channel.id).catch(() => []);
        const paid = orders.find(o => PAID_STATES.includes(o.status));
        if (paid && !args.some(isConfirm)) {
            return reply(`⚠️ في هذه التذكرة طلب **#${paid.id}** مدفوع ولم يُسلَّم بعد. للمتابعة أعد الأمر هكذا: \`${PREFIX}${cmdRaw} تأكيد\``);
        }
        if (paid) await db.updateOrder(paid.id, { status: 'closed_manually', error: `أغلقها ${message.author.tag}` }).catch(() => {});

        if (cmd === 'delete') return scheduleDelete(channel, 0, { transcript: false });

        const reason = args.filter(a => !isConfirm(a)).join(' ');
        await channel.send(`🔒 أغلق ${message.author} التذكرة${reason ? ` — السبب: ${reason}` : ''}. سيتم حذفها خلال 3 ثواني.`);
        return scheduleDelete(channel, 3000);
    }

    if (cmd === 'add' || cmd === 'remove') {
        const target = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
        if (!target) return reply(`❌ منشن العضو أو اكتب الـ ID. مثال: \`${PREFIX}${cmdRaw} @عضو\``);
        if (cmd === 'add') {
            await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
            return reply(`✅ تمت إضافة ${target} للتذكرة.`);
        }
        if (target.id === ownerId) return reply('❌ لا يمكن إزالة صاحب التذكرة.');
        await channel.permissionOverwrites.delete(target.id);
        return reply(`✅ تمت إزالة ${target} من التذكرة.`);
    }

    if (cmd === 'rename') {
        const name = args.join('-').slice(0, 90);
        if (!name) return reply(`❌ اكتب الاسم الجديد. مثال: \`${PREFIX}${cmdRaw} مشكلة-دفع\``);
        await channel.setName(name);
        return reply('✅ تم تغيير اسم التذكرة.');
    }

    if (cmd === 'retry') {
        const orders = await db.getOrdersByChannel(channel.id).catch(() => []);
        const order = orders.find(o => ['role_failed', 'error', 'paid'].includes(o.status));
        if (!order) return reply('⚠️ ما في طلب بانتظار إعادة التسليم في هذه التذكرة.');
        const member = await message.guild.members.fetch(order.user_id).catch(() => null);
        if (!member) return reply('❌ العميل غير موجود في السيرفر.');
        const ok = await fulfillOrder({ order, channel, member });
        return ok ? undefined : reply('❌ فشلت المحاولة مرة أخرى، راجع رسالة التنبيه.');
    }
}

module.exports = { handleMessage };
