// اختبارات منطق الدفع بدون ديسكورد ولا قاعدة بيانات (كلها محاكاة)
// التشغيل: npm test
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

process.env.BANK_USER_ID = '999999999999999999';
process.env.PROBOT_ID = '282859044593598464';
process.env.PROBOT_TAX_PERCENT = '5';
process.env.STAFF_ROLE_ID = '888888888888888888';

// --- محاكاة طبقة القاعدة ---
const calls = { updates: [], logs: [] };
const dbPath = require.resolve('../utils/db.js');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        updateOrder: async (id, patch) => { calls.updates.push({ id, ...patch }); },
        logTransfer: async (log) => { calls.logs.push(log); },
        getSettings: async () => ({ payment_mode: 'calculated', tax_percent: 5 }),
    },
};

const { runPaymentFlow } = require('../utils/payments.js');
const { extractAmount, evaluateAmount, isPaymentFromPayer } = require('../utils/transfer.js');
const { calculateSendAmount, calculateMaxNet } = require('../utils/helpers.js');

const PAYER = '111111111111111111';
const OTHER = '222222222222222222';
const BANK = process.env.BANK_USER_ID;
const PROBOT = process.env.PROBOT_ID;
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

class FakeCollector extends EventEmitter {}

function makeMember({ failAdd = false } = {}) {
    const roles = new Map();
    return {
        id: PAYER, user: { tag: 'user#0', username: 'user' }, added: [],
        roles: {
            cache: roles,
            add: async function (id) { if (failAdd) throw new Error('Missing Permissions'); roles.set(id, true); },
        },
    };
}

function makeChannel(member, history = []) {
    const channel = {
        id: 'c1', name: 'ticket-user', sent: [], deleted: false, collector: null,
        guild: { members: { fetch: async () => member } },
        messages: { cache: new Map(), fetch: async () => new Map(history.map((m, i) => [String(i), m])) },
        send: async (m) => { channel.sent.push(m); },
        delete: async () => { channel.deleted = true; },
        createMessageCollector: (opts) => { channel.collector = new FakeCollector(); channel.collector.opts = opts; return channel.collector; },
    };
    return channel;
}

function probotMessage(content, extra = {}) {
    return { author: { id: PROBOT, bot: true }, content, embeds: [], createdTimestamp: Date.now(), reference: null, ...extra };
}

// يحاكي سلوك MessageCollector: لو الرسالة تمر الفلتر -> collect ثم end
function deliver(channel, message) {
    if (!channel.collector.opts.filter(message)) return false;
    channel.collector.emit('collect', message);
    channel.collector.emit('end', new Map(), 'limit');
    return true;
}

const newOrder = () => ({
    id: Math.floor(Math.random() * 1e6), user_id: PAYER, product_id: 1, product_name: 'VIP', role_id: '777777777777777777',
    required_amount: 1000, send_amount: calculateSendAmount(1000, 5),
    created_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
});

const statuses = (order) => calls.updates.filter(u => u.id === order.id).map(u => u.status).filter(Boolean);

async function waitForCollector(channel) {
    for (let i = 0; i < 50 && !channel.collector; i++) await tick(5);
    assert.ok(channel.collector, 'المراقب ما انشأ');
}

(async () => {
    // ---------- دوال بسيطة ----------
    assert.equal(calculateSendAmount(1000, 5), 1053);
    assert.equal(calculateSendAmount(950, 5), 1000, 'ما يزيد 1 بسبب الفاصلة العائمة');
    assert.equal(calculateSendAmount(500, 0), 500);
    assert.equal(calculateMaxNet(1053, 5), 1000);
    assert.equal(extractAmount('has transferred `$1,000` to'), 1000);
    assert.equal(evaluateAmount(1000, 1000, 1000), 'success');
    assert.equal(evaluateAmount(999, 1000, 1000), 'underpaid');
    assert.equal(evaluateAmount(1001, 1000, 1000), 'overpaid');
    assert.equal(evaluateAmount(1001, 1000, 1001), 'success', 'هامش التقريب');
    console.log('✔ الحسابات واستخراج المبلغ');

    // ---------- نجاح الدفع ----------
    {
        const order = newOrder(), member = makeMember(), channel = makeChannel(member);
        const flow = runPaymentFlow({ channel, order, member });
        await waitForCollector(channel);
        assert.ok(deliver(channel, probotMessage(`💰 | <@${PAYER}>, has transferred \`$1000\` to <@${BANK}>`)));
        await flow;
        assert.deepEqual(statuses(order), ['paid', 'completed']);
        assert.ok(member.roles.cache.has(order.role_id), 'الرتبة انعطت');
        assert.equal(calls.logs.at(-1).status, 'success');
        assert.equal(calls.logs.at(-1).order_id, order.id);
        console.log('✔ دفع ناجح -> paid -> completed + إعطاء الرتبة + لوق');
    }

    // ---------- فشل منح الرتبة بعد الدفع ----------
    {
        const order = newOrder(), member = makeMember({ failAdd: true }), channel = makeChannel(member);
        const flow = runPaymentFlow({ channel, order, member });
        await waitForCollector(channel);
        deliver(channel, probotMessage(`<@${PAYER}> transferred \`$1000\` to <@${BANK}>`));
        await flow;
        await tick(100);
        assert.deepEqual(statuses(order), ['paid', 'role_failed']);
        assert.equal(channel.deleted, false, 'التذكرة لازم ما تنحذف');
        const alert = channel.sent.find(m => m.components?.length);
        assert.ok(alert && alert.content.includes(`<@&${process.env.STAFF_ROLE_ID}>`), 'تنبيه الستاف مع الأزرار');
        console.log('✔ فشل منح الرتبة -> role_failed، التذكرة تبقى مفتوحة، الستاف ينتبه');
    }

    // ---------- مبلغ أقل ----------
    {
        const order = newOrder(), member = makeMember(), channel = makeChannel(member);
        const flow = runPaymentFlow({ channel, order, member });
        await waitForCollector(channel);
        deliver(channel, probotMessage(`<@${PAYER}> transferred \`$900\` to <@${BANK}>`));
        await flow;
        assert.deepEqual(statuses(order), ['failed']);
        assert.equal(calls.logs.at(-1).status, 'underpaid');
        assert.ok(!member.roles.cache.has(order.role_id));
        console.log('✔ مبلغ أقل -> failed بدون رتبة');
    }

    // ---------- تحويل من شخص ثاني يُتجاهل ثم تنتهي المهلة ----------
    {
        const order = newOrder(), member = makeMember(), channel = makeChannel(member);
        const flow = runPaymentFlow({ channel, order, member });
        await waitForCollector(channel);
        const accepted = deliver(channel, probotMessage(`<@${OTHER}> transferred \`$1000\` to <@${BANK}>`));
        assert.equal(accepted, false, 'تحويل شخص ثاني لازم ما يُقبل');
        channel.collector.emit('end', new Map(), 'time');
        await flow;
        assert.deepEqual(statuses(order), ['expired']);
        assert.ok(!member.roles.cache.has(order.role_id));
        console.log('✔ تحويل شخص آخر يُتجاهل، والمهلة تنتهي بـ expired');
    }

    // ---------- رد على رسالة إنسان آخر ----------
    {
        const channel = makeChannel(makeMember());
        channel.messages.cache.set('m1', { author: { id: OTHER, bot: false } });
        const msg = probotMessage(`transferred \`$1000\` to <@${BANK}>`, { reference: { messageId: 'm1' }, channel });
        assert.equal(isPaymentFromPayer(msg, msg.content, PAYER, BANK), false);
        channel.messages.cache.set('m2', { author: { id: PROBOT, bot: true } });
        const msg2 = probotMessage(`transferred \`$1000\` to <@${BANK}>`, { reference: { messageId: 'm2' }, channel });
        assert.equal(isPaymentFromPayer(msg2, msg2.content, PAYER, BANK), true, 'رد على رسالة بوت ما يُرفض');
        console.log('✔ فحص الرد على رسالة شخص آخر');
    }

    // ---------- انحذفت التذكرة قبل الدفع ----------
    {
        const order = newOrder(), member = makeMember(), channel = makeChannel(member);
        const flow = runPaymentFlow({ channel, order, member });
        await waitForCollector(channel);
        channel.collector.emit('end', new Map(), 'channelDelete');
        await flow;
        assert.deepEqual(statuses(order), ['cancelled']);
        console.log('✔ حذف التذكرة قبل الدفع -> cancelled (بدون تعليق)');
    }

    // ---------- استعادة بعد إعادة التشغيل: تحويل وصل والبوت متوقف ----------
    {
        const order = newOrder();
        order.expires_at = new Date(Date.now() - 5000).toISOString(); // المهلة انتهت أثناء التوقف
        const member = makeMember();
        const history = [probotMessage(`<@${PAYER}> transferred \`$1000\` to <@${BANK}>`)];
        const channel = makeChannel(member, history);
        await runPaymentFlow({ channel, order, member, scanHistory: true });
        assert.deepEqual(statuses(order), ['paid', 'completed']);
        assert.ok(member.roles.cache.has(order.role_id));
        console.log('✔ استعادة: تحويل وصل أثناء توقف البوت يُسلَّم تلقائيًا');
    }

    // ---------- استعادة: لا تحويل والمهلة منتهية ----------
    {
        const order = newOrder();
        order.expires_at = new Date(Date.now() - 5000).toISOString();
        const member = makeMember(), channel = makeChannel(member, []);
        await runPaymentFlow({ channel, order, member, scanHistory: true });
        assert.deepEqual(statuses(order), ['expired']);
        console.log('✔ استعادة: لا تحويل + مهلة منتهية -> expired');
    }

    console.log('\n✅ كل الاختبارات نجحت');
    process.exit(0);
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
