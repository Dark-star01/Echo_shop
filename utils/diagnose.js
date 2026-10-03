// utils/diagnose.js - فحص صحة فتح التذاكر (/shopadmin diagnose): صلاحيات، فئة، قاعدة بيانات، تذاكر يتيمة
const { ChannelType, PermissionFlagsBits: P, EmbedBuilder } = require('discord.js');
const db = require('./db.js');
const { getTicketOwnerId } = require('./tickets.js');
const { sweepEmptyTickets } = require('./idleTickets.js');
const { withTimeout } = require('./helpers.js');

const ok = (t) => `✅ ${t}`, warn = (t) => `⚠️ ${t}`, bad = (t) => `❌ ${t}`;

async function runDiagnostics(guild) {
    const lines = [];
    const me = guild.members.me;
    const category = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);

    // 1) الفئة
    if (!category || category.type !== ChannelType.GuildCategory) {
        lines.push(bad('فئة التذاكر (`TICKET_CATEGORY_ID`) غير موجودة أو ليست فئة — هذا يمنع فتح أي تذكرة.'));
    } else {
        const n = category.children.cache.size;
        lines.push(n >= 50 ? bad(`الفئة ممتلئة (${n}/50 روم) — ديسكورد يرفض إنشاء تذاكر جديدة. احذف التذاكر القديمة.`)
            : n >= 40 ? warn(`الفئة شبه ممتلئة (${n}/50).`) : ok(`الفئة موجودة (${n}/50 روم).`));

        // 2) صلاحيات البوت داخل الفئة
        const perms = category.permissionsFor(me);
        const need = { ViewChannel: P.ViewChannel, ManageChannels: P.ManageChannels, SendMessages: P.SendMessages, EmbedLinks: P.EmbedLinks, ReadMessageHistory: P.ReadMessageHistory };
        const missing = Object.entries(need).filter(([, bit]) => !perms?.has(bit)).map(([k]) => k);
        lines.push(missing.length ? bad(`صلاحيات ناقصة للبوت في الفئة: ${missing.join('، ')}`) : ok('صلاحيات البوت في الفئة كاملة.'));
        if (!guild.members.me.permissions.has(P.ManageRoles)) lines.push(bad('البوت ما عنده ManageRoles — التسليم سيفشل.'));

        // 3) تذاكر يتيمة
        const orphans = await sweepEmptyTickets(guild, { dryRun: true }).catch(() => 0);
        lines.push(orphans ? warn(`${orphans} تذكرة فاضية يتيمة (تُحذف تلقائياً كل 10 دقائق).`) : ok('لا توجد تذاكر فاضية يتيمة.'));
        const stale = [...category.children.cache.values()].filter((c) => !getTicketOwnerId(c)).length;
        if (stale) lines.push(warn(`${stale} روم في الفئة بدون صاحب (ليست تذاكر البوت؟) وتستهلك حد الـ 50.`));
    }

    // 4) رتبة الستاف
    if (process.env.STAFF_ROLE_ID) {
        lines.push(guild.roles.cache.has(process.env.STAFF_ROLE_ID) ? ok('رتبة الستاف موجودة.')
            : bad('`STAFF_ROLE_ID` غير موجودة في السيرفر — إنشاء التذكرة سيفشل بسبب صلاحيات رتبة غير صالحة.'));
    } else lines.push(warn('`STAFF_ROLE_ID` غير محدد.'));

    // 5) قاعدة البيانات والمنتجات
    const t0 = Date.now();
    try {
        const products = await withTimeout(db.getAllProducts(), 10_000, 'سوبابيس');
        const ms = Date.now() - t0;
        lines.push(ms > 3000 ? bad(`سوبابيس بطيء جداً (${ms}ms) — هذا يعلّق فتح التذاكر. تحقق من المشروع (قد يكون متوقفاً مؤقتاً).`)
            : ms > 1000 ? warn(`سوبابيس بطيء (${ms}ms).`) : ok(`سوبابيس يستجيب (${ms}ms).`));
        if (!products.length) lines.push(bad('لا توجد منتجات — التذكرة لن تُفتح.'));
        else {
            if (products.length > 25) lines.push(warn(`${products.length} منتج، القائمة تعرض أول 25 فقط.`));
            const broken = products.filter((p) => !p.name || !Number.isFinite(Number(p.price)));
            lines.push(broken.length ? bad(`منتجات ببيانات تالفة (اسم فارغ/سعر غير صالح): #${broken.map((p) => p.id).join(', #')}`) : ok(`${products.length} منتج سليم.`));
        }
    } catch (e) {
        lines.push(bad(`فشل الاتصال بسوبابيس: ${e.message}`));
    }

    // 6) ديسكورد
    const ping = guild.client?.ws?.ping;
    if (Number.isFinite(ping)) lines.push(ping > 800 ? warn(`تأخر الاتصال بديسكورد ${ping}ms.`) : ok(`اتصال ديسكورد ${ping}ms.`));

    const failed = lines.some((l) => l.startsWith('❌'));
    return new EmbedBuilder()
        .setColor(failed ? 0xed4245 : lines.some((l) => l.startsWith('⚠️')) ? 0xfee75c : 0x57f287)
        .setTitle(failed ? '🩺 تشخيص: توجد مشاكل' : '🩺 تشخيص: سليم')
        .setDescription(lines.join('\n').slice(0, 4000));
}

module.exports = { runDiagnostics };
