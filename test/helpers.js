// أدوات اختبار مشتركة: محاكاة ديسكورد وقاعدة البيانات (ما نحتاج اتصال حقيقي)
const { Collection, ChannelType } = require('discord.js');

Object.assign(process.env, {
    DISCORD_TOKEN: 'x', GUILD_ID: '100000000000000001', BANK_USER_ID: '999999999999999999',
    TICKET_CATEGORY_ID: '200000000000000001', STAFF_ROLE_ID: '888888888888888888',
    SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_KEY: 'x', PROBOT_ID: '282859044593598464', PROBOT_TAX_PERCENT: '5',
    DISCORD_CLIENT_SECRET: 'secret', DASHBOARD_URL: 'http://localhost:3987', SESSION_SECRET: '0123456789abcdef0123456789', PORT: '3987',
});
const E = process.env;
const REF_ROLE = '700000000000000000', FIXED_ROLE = '710000000000000001';
const ACTIVE = ['awaiting_payment', 'paid', 'role_failed', 'customizing', 'pending_review'];
const RELEASED = ['failed', 'expired', 'cancelled'];

const customSettings = {
    color_modes: ['solid', 'gradient', 'holographic'], allow_icon: true, max_name_length: 20, banned_words: ['bad'],
    permissions: ['ChangeNickname', 'UseExternalEmojis'], require_review: false, edit_price: 0, edit_cooldown_days: 7,
};

function installDb() {
    const st = {
        products: [
            { id: 1, type: 'fixed', role_id: FIXED_ROLE, name: 'VIP', price: 1000, description: '', features: '', duration_days: null, custom_settings: {} },
            { id: 2, type: 'custom', role_id: null, name: 'Custom', price: 2000, description: '', features: '', duration_days: null, custom_settings: customSettings },
        ],
        orders: [], customRoles: [], subs: [], logs: [], saved: [], nextId: 1, nextProd: 3, nextCoupon: 3,
        coupons: [
            { id: 1, code: 'HALF', percent: 50, active: true, expires_at: null, max_uses: null, max_uses_per_user: 1, created_at: new Date().toISOString() },
            { id: 2, code: 'FREE', percent: 100, active: true, expires_at: null, max_uses: null, max_uses_per_user: 1, created_at: new Date().toISOString() },
        ],
        settings: { payment_mode: 'calculated', tax_percent: 5, reference_role_id: REF_ROLE, log_channel_id: '', transcript_channel_id: '', alert_channel_id: '', idle_close_hours: 24, shop_message: null },
    };
    const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
    const stub = {
        getAllProducts: async () => clone(st.products),
        getProductById: async (id) => clone(st.products.find(p => p.id === Number(id))) || null,
        countProducts: async () => st.products.length,
        addProduct: async (v) => { const p = { id: st.nextProd++, ...v }; st.products.push(p); return clone(p); },
        updateProduct: async (id, v) => { const p = st.products.find(x => x.id === Number(id)); if (!p) return null; Object.assign(p, v); return clone(p); },
        deleteProduct: async (id) => { st.products = st.products.filter(p => p.id !== Number(id)); },
        getSettings: async () => clone(st.settings),
        saveSettings: async (patch) => { Object.assign(st.settings, patch); st.saved.push(patch); return clone(st.settings); },
        createOrder: async (o) => { const row = { status: 'awaiting_payment', draft: null, created_at: new Date().toISOString(), ...o, id: st.nextId++ }; st.orders.push(row); return clone(row); },
        updateOrder: async (id, patch) => { const o = st.orders.find(x => x.id === id); Object.assign(o, patch); return clone(o); },
        getOrderById: async (id) => clone(st.orders.find(o => o.id === id)) || null,
        getOrders: async () => clone([...st.orders].reverse()),
        getOrdersByStatus: async (s) => clone(st.orders.filter(o => s.includes(o.status))),
        getOrdersByChannel: async (c) => clone(st.orders.filter(o => o.channel_id === c).reverse()),
        getActiveOrderByChannel: async (c) => clone([...st.orders].reverse().find(o => o.channel_id === c && ACTIVE.includes(o.status))) || null,
        logTransfer: async (l) => { st.logs.push(l); },
        getCouponByCode: async (c) => clone(st.coupons.find(x => x.code === String(c).trim().toUpperCase())) || null,
        getCouponById: async (id) => clone(st.coupons.find(x => x.id === Number(id))) || null,
        getCoupons: async () => clone(st.coupons),
        createCoupon: async (c) => { if (st.coupons.some(x => x.code === c.code)) throw Object.assign(new Error('dup'), { code: '23505' }); const row = { id: st.nextCoupon++, active: true, ...c }; st.coupons.push(row); return clone(row); },
        updateCoupon: async (id, p) => { const c = st.coupons.find(x => x.id === Number(id)); if (!c) return null; Object.assign(c, p); return clone(c); },
        deleteCoupon: async (id) => { st.coupons = st.coupons.filter(c => c.id !== Number(id)); },
        countCouponUses: async (cid, uid = null) => st.orders.filter(o => o.coupon_id === cid && !RELEASED.includes(o.status) && (!uid || o.user_id === uid)).length,
        getCouponUsageMap: async () => st.orders.reduce((m, o) => (o.coupon_id && !RELEASED.includes(o.status) ? { ...m, [o.coupon_id]: (m[o.coupon_id] || 0) + 1 } : m), {}),
        getCustomRolesByUser: async (u) => clone(st.customRoles.filter(r => r.user_id === u)),
        addCustomRole: async (r) => { st.customRoles = st.customRoles.filter(x => x.role_id !== r.role_id); const row = { id: st.customRoles.length + 1, ...r }; st.customRoles.push(row); return clone(row); },
        updateCustomRole: async (rid, p) => { Object.assign(st.customRoles.find(r => r.role_id === rid), p); },
        deleteCustomRole: async (rid) => { st.customRoles = st.customRoles.filter(r => r.role_id !== rid); },
        addSubscription: async (s) => { const row = { id: st.subs.length + 1, status: 'active', created_at: new Date().toISOString(), ...s }; st.subs.push(row); return clone(row); },
        getSubscriptions: async () => clone(st.subs),
        getSubscriptionById: async (id) => clone(st.subs.find(s => s.id === Number(id))) || null,
        getDueSubscriptions: async () => [],
        updateSubscription: async (id, p) => { Object.assign(st.subs.find(s => s.id === Number(id)), p); },
    };
    const path = require.resolve('../utils/db.js');
    require.cache[path] = { id: path, filename: path, loaded: true, exports: stub };
    return st;
}

// ---------- عالم ديسكورد المحاكى ----------
let seq = 0;
function makeWorld() {
    const category = { id: E.TICKET_CATEGORY_ID, type: ChannelType.GuildCategory, children: { cache: new Collection() } };
    const roles = new Map();
    const addRole = (id, name, position) => { const r = { id, name, position, managed: false, toString: () => `<@&${id}>` }; roles.set(id, r); return r; };
    addRole(REF_ROLE, 'reference', 10); addRole(FIXED_ROLE, 'VIP', 5);
    const members = new Map();
    const channels = new Collection([[category.id, category]]);

    const guild = {
        id: E.GUILD_ID, roles: { cache: roles, fetch: async (id) => roles.get(id) || null, createCalls: [],
            create: async (opts) => {
                const r = addRole('80000000000000' + String(++seq).padStart(4, '0'), opts.name, 1);
                Object.assign(r, { colors: opts.colors, permissions: opts.permissions, icon: opts.icon, setPosition: async (p) => { r.position = p; }, edit: async (o) => Object.assign(r, o) });
                guild.roles.createCalls.push(opts); return r;
            } },
        members: { me: { id: '555555555555555555', roles: { highest: { position: 50 } } }, cache: members, fetch: async (id) => members.get(id) || null },
        channels: { cache: channels, fetch: async (id) => channels.get(id) || null,
            create: async (opts) => { const ch = makeChannel(opts.name, opts); channels.set(ch.id, ch); category.children.cache.set(ch.id, ch); return ch; } },
    };

    function makeChannel(name, opts = {}) {
        const ch = {
            id: '30000000000000' + String(++seq).padStart(4, '0'), name, topic: opts.topic || '', parentId: opts.parent || null, type: ChannelType.GuildText, guild,
            sent: [], deleted: false, collector: null, client: { on() {}, off() {} },
            permissionOverwrites: { cache: new Collection(), edit: async () => {}, delete: async () => {} },
            messages: { cache: new Collection(), fetch: async () => new Collection() },
            send: async (m) => { ch.sent.push(m); return { id: 'm' + ++seq, channelId: ch.id }; },
            delete: async () => { ch.deleted = true; category.children.cache.delete(ch.id); channels.delete(ch.id); },
            setName: async (n) => { ch.name = n; }, awaitMessages: async () => new Collection(),
            createMessageCollector: (opts2) => { const c = new (require('node:events'))(); c.opts = opts2; ch.collector = c; return c; },
        };
        return ch;
    }

    function makeMember(id, { staff = false } = {}) {
        const cache = new Collection();
        if (staff) cache.set(E.STAFF_ROLE_ID, true);
        const m = { id, user: { id, tag: `${id.slice(-4)}#0`, username: `user${id.slice(-4)}` }, displayName: `user${id.slice(-4)}`,
            permissions: { has: () => false },
            roles: { cache, add: async (r) => { cache.set(typeof r === 'string' ? r : r.id, true); }, remove: async (r) => { cache.delete(typeof r === 'string' ? r : r.id); } } };
        members.set(id, m); return m;
    }

    // محاكاة تفاعل ديسكورد (أزرار/قوائم/مودال/أوامر)
    function interaction(kind, { customId, member, channel, values, fields }) {
        const calls = [];
        const rec = (name) => async (p) => { calls.push([name, p]); if (['reply', 'editReply', 'followUp', 'update', 'showModal'].includes(name)) i.replied = true; if (name === 'deferReply' || name === 'deferUpdate') i.deferred = true; };
        const i = {
            customId, guild, member, user: member.user, channel, channelId: channel?.id, values, calls, deferred: false, replied: false,
            fields: fields && { getTextInputValue: (k) => fields[k], fields: new Map(Object.keys(fields).map(k => [k, 1])) },
            isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button',
            isStringSelectMenu: () => kind === 'select', isModalSubmit: () => kind === 'modal',
            reply: rec('reply'), update: rec('update'), deferReply: rec('deferReply'), deferUpdate: rec('deferUpdate'),
            editReply: rec('editReply'), followUp: rec('followUp'), showModal: rec('showModal'),
            message: { edit: async (p) => calls.push(['message.edit', p]) },
        };
        i.last = (name) => [...calls].reverse().find(c => c[0] === name)?.[1];
        return i;
    }

    // رسالة بروبوت تُمرَّر للمراقب كما يفعل MessageCollector
    function proBot(channel, content) {
        const msg = { author: { id: E.PROBOT_ID, bot: true }, content, embeds: [], createdTimestamp: Date.now(), reference: null, channel };
        if (!channel.collector?.opts.filter(msg)) return false;
        channel.collector.emit('collect', msg); channel.collector.emit('end', new Map(), 'limit'); return true;
    }

    return { guild, category, roles, members, makeChannel, makeMember, interaction, proBot };
}

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, tries = 80) { for (let i = 0; i < tries; i++) { if (fn()) return; await tick(10); } throw new Error('انتظار انتهى: ' + label); }

module.exports = { installDb, makeWorld, tick, waitFor, E, REF_ROLE, FIXED_ROLE, customSettings };
