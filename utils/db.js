// utils/db.js - طبقة الاتصال بقاعدة بيانات Supabase
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// ============================================================
//  📦  عمليات المنتجات (products)
// ============================================================

async function getAllProducts() {
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('price', { ascending: true });
    if (error) throw error;
    return data;
}

async function getProductById(id) {
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function addProduct({ role_id, name, price, description, features, type = 'fixed', custom_settings = {}, duration_days = null }) {
    const { data, error } = await supabase
        .from('products')
        .insert([{ role_id, name, price, description, features, type, custom_settings, duration_days }])
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function updateProduct(id, { role_id, name, price, description, features, type = 'fixed', custom_settings = {}, duration_days = null }) {
    const { data, error } = await supabase
        .from('products')
        .update({ role_id, name, price, description, features, type, custom_settings, duration_days })
        .eq('id', id)
        .select()
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function deleteProduct(id) {
    const { data, error } = await supabase
        .from('products')
        .delete()
        .eq('id', id)
        .select()
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function countProducts() {
    const { count, error } = await supabase
        .from('products')
        .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count;
}

// ============================================================
//  🧾  سجل محاولات الدفع (transfer_logs)
// ============================================================

async function logTransfer({ ticket_name, user_id, username, product_id, product_name, required_amount, actual_amount, status, order_id = null }) {
    const { data, error } = await supabase
        .from('transfer_logs')
        .insert([{ ticket_name, user_id, username, product_id, product_name, required_amount, actual_amount, status, order_id }])
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getLogs(limit = 100) {
    const { data, error } = await supabase
        .from('transfer_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data;
}

// ============================================================
//  🛒  الطلبات (orders)
// ============================================================

const ACTIVE_ORDER_STATUSES = ['awaiting_payment', 'paid', 'role_failed', 'customizing', 'pending_review'];

async function createOrder({ channel_id, user_id, username, product_id, product_name, role_id = null, required_amount, send_amount, expires_at, product_type = 'fixed', draft = null, status = 'awaiting_payment', coupon_id = null, discount_percent = null, original_amount = null, duration_days = null }) {
    const { data, error } = await supabase
        .from('orders')
        .insert([{ channel_id, user_id, username, product_id, product_name, role_id, required_amount, send_amount, expires_at, product_type, draft, status, coupon_id, discount_percent, original_amount, duration_days }])
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function updateOrder(id, patch) {
    const { data, error } = await supabase
        .from('orders')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function getOrderById(id) {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function getOrdersByStatus(statuses) {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .in('status', statuses)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
}

async function getActiveOrderByChannel(channelId) {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('channel_id', channelId)
        .in('status', ACTIVE_ORDER_STATUSES)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data;
}

// ============================================================
//  ⚙️  الإعدادات (settings) — تُعدَّل من الداشبورد
//  payment_mode: 'calculated' = البوت يحسب المبلغ مع الضريبة | 'with_tax' = العميل يكتب "with tax"
// ============================================================
let settingsCache = null;
let settingsCacheAt = 0;

async function getSettings() {
    if (settingsCache && Date.now() - settingsCacheAt < 30_000) return settingsCache;
    const { data, error } = await supabase.from('settings').select('key, value');
    if (error) throw error;
    const stored = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    settingsCache = {
        payment_mode: 'calculated',
        reference_role_id: '',
        log_channel_id: '',
        transcript_channel_id: '',
        alert_channel_id: '',
        idle_close_hours: 24, // 0 = إغلاق التذاكر الخاملة معطل
        shop_message: null,
        tax_percent: parseFloat(process.env.PROBOT_TAX_PERCENT) || 0,
        ...stored,
    };
    settingsCacheAt = Date.now();
    return settingsCache;
}

async function saveSettings(patch) {
    const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' });
    if (error) throw error;
    settingsCache = null;
    return getSettings();
}

async function getOrdersByChannel(channelId) {
    const { data, error } = await supabase.from('orders').select('*')
        .eq('channel_id', channelId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
}

async function getOrders(limit = 200) {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data;
}

// ============================================================
//  🎨  الرتب المخصصة (custom_roles)
// ============================================================

async function addCustomRole({ user_id, role_id, product_id = null, name = null, source = 'purchase', last_edited_at = null }) {
    const { data, error } = await supabase
        .from('custom_roles')
        .upsert([{ user_id, role_id, product_id, name, source, last_edited_at }], { onConflict: 'role_id' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getCustomRolesByUser(userId) {
    const { data, error } = await supabase.from('custom_roles').select('*').eq('user_id', userId);
    if (error) throw error;
    return data;
}

async function updateCustomRole(roleId, patch) {
    const { error } = await supabase.from('custom_roles').update(patch).eq('role_id', roleId);
    if (error) throw error;
}

async function deleteCustomRole(roleId) {
    const { error } = await supabase.from('custom_roles').delete().eq('role_id', roleId);
    if (error) throw error;
}

// ============================================================
//  🎟️  الكوبونات
// ============================================================
const RELEASED_STATUSES = '(failed,expired,cancelled)'; // طلبات ما تُحسب كاستخدام

async function createCoupon(c) {
    const { data, error } = await supabase.from('coupons').insert([c]).select().single();
    if (error) throw error;
    return data;
}
async function getCoupons() {
    const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data;
}
async function getCouponById(id) {
    const { data, error } = await supabase.from('coupons').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
}
async function getCouponByCode(code) {
    const { data, error } = await supabase.from('coupons').select('*').eq('code', String(code).trim().toUpperCase()).maybeSingle();
    if (error) throw error;
    return data;
}
async function updateCoupon(id, patch) {
    const { data, error } = await supabase.from('coupons').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data;
}
async function deleteCoupon(id) {
    const { error } = await supabase.from('coupons').delete().eq('id', id);
    if (error) throw error;
}
async function countCouponUses(couponId, userId = null) {
    let query = supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('coupon_id', couponId).not('status', 'in', RELEASED_STATUSES);
    if (userId) query = query.eq('user_id', userId);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
}
async function getCouponUsageMap() {
    const { data, error } = await supabase.from('orders').select('coupon_id')
        .not('coupon_id', 'is', null).not('status', 'in', RELEASED_STATUSES);
    if (error) throw error;
    return data.reduce((map, r) => ({ ...map, [r.coupon_id]: (map[r.coupon_id] || 0) + 1 }), {});
}

// ============================================================
//  ⏳  الاشتراكات (انتهاء الرتبة تلقائيًا)
// ============================================================
async function addSubscription({ user_id, role_id, product_id, order_id, expires_at }) {
    const { data, error } = await supabase.from('subscriptions')
        .insert([{ user_id, role_id, product_id, order_id, expires_at }]).select().single();
    if (error) throw error;
    return data;
}
async function getSubscriptions(limit = 200) {
    const { data, error } = await supabase.from('subscriptions').select('*')
        .order('expires_at', { ascending: true }).limit(limit);
    if (error) throw error;
    return data;
}
async function getSubscriptionById(id) {
    const { data, error } = await supabase.from('subscriptions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
}
async function getDueSubscriptions() {
    const { data, error } = await supabase.from('subscriptions').select('*')
        .eq('status', 'active').lte('expires_at', new Date().toISOString());
    if (error) throw error;
    return data;
}
async function updateSubscription(id, patch) {
    const { error } = await supabase.from('subscriptions').update(patch).eq('id', id);
    if (error) throw error;
}

module.exports = {
    supabase,
    getAllProducts,
    getProductById,
    addProduct,
    updateProduct,
    deleteProduct,
    countProducts,
    logTransfer,
    getLogs,
    createOrder,
    updateOrder,
    getOrderById,
    getOrdersByStatus,
    getActiveOrderByChannel,
    getOrders,
    getOrdersByChannel,
    getSettings,
    saveSettings,
    addCustomRole,
    getCustomRolesByUser,
    updateCustomRole,
    deleteCustomRole,
    createCoupon, getCoupons, getCouponById, getCouponByCode, updateCoupon, deleteCoupon, countCouponUses, getCouponUsageMap,
    addSubscription, getSubscriptions, getSubscriptionById, getDueSubscriptions, updateSubscription,
};
