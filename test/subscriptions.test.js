// اختبار سحب الاشتراكات المنتهية + إشعار الخاص (يُتجاهل بصمت لو الخاص مقفول)
const assert = require('node:assert/strict');

const state = { updates: [] };
const dbPath = require.resolve('../utils/db.js');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        getDueSubscriptions: async () => state.due,
        updateSubscription: async (id, patch) => { state.updates.push({ id, ...patch }); },
        getSettings: async () => ({ log_channel_id: '' }),
    },
};
const { runOnce } = require('../utils/subscriptions.js');

const ROLE = '123456789012345678';
function makeGuild({ dmFails }) {
    const removed = [];
    const dms = [];
    const member = { roles: { cache: new Map([[ROLE, {}]]), remove: async (id) => { removed.push(id); } } };
    return {
        removed, dms,
        guild: {
            name: 'Echo Server',
            roles: { cache: new Map([[ROLE, { name: 'VIP' }]]) },
            members: { fetch: async () => member },
            client: { users: { fetch: async () => ({ send: async (msg) => { if (dmFails) throw new Error('Cannot send messages to this user'); dms.push(msg); } }) } },
            channels: { fetch: async () => null },
        },
    };
}

(async () => {
    // الخاص مفتوح: ترسل رسالة وتنسحب الرتبة
    state.due = [{ id: 1, user_id: '111111111111111111', role_id: ROLE, order_id: 5 }];
    let w = makeGuild({ dmFails: false });
    await runOnce(w.guild);
    assert.deepEqual(w.removed, [ROLE]);
    assert.equal(w.dms.length, 1);
    assert.ok(w.dms[0].includes('VIP') && w.dms[0].includes('Echo Server'));
    assert.equal(state.updates.at(-1).status, 'expired');
    console.log('✔ اشتراك منتهي: الرتبة تنسحب + إشعار على الخاص');

    // الخاص مقفول: تنسحب بصمت والاشتراك يُعلَّم منتهيًا بدون أخطاء
    state.updates = [];
    w = makeGuild({ dmFails: true });
    await runOnce(w.guild);
    assert.deepEqual(w.removed, [ROLE]);
    assert.equal(w.dms.length, 0);
    assert.deepEqual(state.updates.map(u => u.status), ['expired'], 'ما صار removal_failed بسبب الخاص');
    console.log('✔ الخاص مقفول: سحب صامت بدون أي فشل');

    console.log('\n✅ اختبارات الاشتراكات نجحت');
})().catch((e) => { console.error('❌ فشل الاختبار:', e); process.exit(1); });
