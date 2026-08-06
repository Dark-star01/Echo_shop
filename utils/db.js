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

async function addProduct({ role_id, name, price, description, features }) {
    const { data, error } = await supabase
        .from('products')
        .insert([{ role_id, name, price, description, features }])
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function updateProduct(id, { role_id, name, price, description, features }) {
    const { data, error } = await supabase
        .from('products')
        .update({ role_id, name, price, description, features })
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

async function logTransfer({ ticket_name, user_id, username, product_id, product_name, required_amount, actual_amount, status }) {
    const { data, error } = await supabase
        .from('transfer_logs')
        .insert([{ ticket_name, user_id, username, product_id, product_name, required_amount, actual_amount, status }])
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
};
