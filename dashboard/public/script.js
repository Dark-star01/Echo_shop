// dashboard/public/script.js
const API_BASE = '/api';

// ============================================================
//  🔐 الجلسة المؤقتة (بالذاكرة فقط)
//  ملاحظة: هذا المتغيّر يتصفّر تلقائيًا مع أي تحديث/إغلاق للصفحة
//  لأن كل السكربت يعاد تحميله من الصفر — يعني ما فيه "تذكرني"
// ============================================================
let authHeader = null;

function showLogin(errorMsg) {
    authHeader = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    const errBox = document.getElementById('loginError');
    if (errorMsg) {
        errBox.textContent = errorMsg;
        errBox.classList.remove('hidden');
    } else {
        errBox.classList.add('hidden');
    }
    document.getElementById('loginPassword').value = '';
}

function showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
}

// كل نداءات الـ API تمر من هنا عشان نرفق التوثيق ونتعامل مع انتهاء الجلسة
async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: authHeader };
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) {
        showLogin('❌ انتهت الجلسة، الرجاء تسجيل الدخول من جديد');
        throw new Error('Unauthorized');
    }
    return res;
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginBtn');

    btn.disabled = true;
    btn.textContent = 'جاري التحقق...';

    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
            authHeader = 'Basic ' + btoa(`${username}:${password}`);
            showApp();
            initDashboard();
        } else {
            // رسالة دقيقة: لو اليوزر غلط "بيانات الدخول غير صحيحة" (بدون كشف تفاصيل)
            // لو اليوزر صح بس الباسورد غلط: "كلمة المرور غير صحيحة" تحديدًا
            showLogin(`❌ ${data.message || 'بيانات الدخول غير صحيحة'}`);
        }
    } catch (error) {
        showLogin('❌ تعذر الاتصال بالخادم، حاول مرة أخرى');
    } finally {
        btn.disabled = false;
        btn.textContent = 'دخول 🔑';
    }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    showLogin();
});

// ============================================================
//  🔔 نظام تنبيهات (Toast) بدل alert()
// ============================================================
function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// ============================================================
//  🗂️ التبويبات
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`${btn.dataset.tab}-container`).classList.add('active');
    });
});

// ============================================================
//  💎 المنتجات
// ============================================================
let allProducts = [];

async function loadProducts() {
    try {
        const res = await apiFetch('/products');
        if (!res.ok) throw new Error('Failed to fetch products');
        allProducts = await res.json();
        renderProducts(allProducts);
        document.getElementById('productCount').textContent = allProducts.length;
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            document.getElementById('products').innerHTML = '<div class="empty-message">❌ خطأ في تحميل المنتجات</div>';
        }
    }
}

function renderProducts(products) {
    const container = document.getElementById('products');
    if (!products || products.length === 0) {
        container.innerHTML = '<div class="empty-message">📭 لا توجد منتجات حالياً</div>';
        return;
    }

    container.innerHTML = products.map(p => `
        <div class="product" data-id="${p.id}">
            <div class="info">
                <h3>💎 ${escapeHtml(p.name)}</h3>
                <div class="price">${Number(p.price).toLocaleString()} كريديت</div>
                ${p.description ? `<div class="desc">📝 ${escapeHtml(p.description)}</div>` : ''}
                ${p.features ? `<div class="features">✨ ${escapeHtml(p.features)}</div>` : ''}
                <div class="meta">🎭 رتبة: <code>${p.role_id}</code> &nbsp;|&nbsp; #${p.id}</div>
            </div>
            <div class="actions">
                <button class="edit-btn" onclick="openEditModal(${p.id})">✏️ تعديل</button>
                <button class="delete-btn" onclick="deleteProduct(${p.id})">🗑️ حذف</button>
            </div>
        </div>
    `).join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

document.getElementById('productSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = allProducts.filter(p => p.name.toLowerCase().includes(q));
    renderProducts(filtered);
});

async function deleteProduct(id) {
    if (!confirm('⚠️ هل أنت متأكد من حذف هذا المنتج؟')) return;
    try {
        const res = await apiFetch(`/products/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete');
        toast('🗑️ تم حذف المنتج بنجاح', 'success');
        await loadProducts();
    } catch (error) {
        if (error.message !== 'Unauthorized') toast('❌ فشل حذف المنتج', 'error');
    }
}

// ------- إضافة منتج -------
document.getElementById('addProductForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = {
        role_id: document.getElementById('role_id').value.trim(),
        name: document.getElementById('name').value.trim(),
        price: parseInt(document.getElementById('price').value),
        description: document.getElementById('description').value.trim(),
        features: document.getElementById('features').value.trim(),
    };

    if (!data.role_id || !data.name || isNaN(data.price) || data.price <= 0) {
        toast('❌ الرجاء ملء جميع الحقول المطلوبة بشكل صحيح', 'error');
        return;
    }

    try {
        const res = await apiFetch('/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Failed to add product');
        document.getElementById('addProductForm').reset();
        toast('✅ تمت إضافة المنتج بنجاح', 'success');
        await loadProducts();
        document.querySelector('.tab-btn[data-tab="products"]').click();
    } catch (error) {
        if (error.message !== 'Unauthorized') toast('❌ فشل إضافة المنتج', 'error');
    }
});

// ------- تعديل منتج -------
function openEditModal(id) {
    const p = allProducts.find(x => x.id === id);
    if (!p) return;
    document.getElementById('edit_id').value = p.id;
    document.getElementById('edit_role_id').value = p.role_id;
    document.getElementById('edit_name').value = p.name;
    document.getElementById('edit_price').value = p.price;
    document.getElementById('edit_description').value = p.description || '';
    document.getElementById('edit_features').value = p.features || '';
    document.getElementById('edit-modal').classList.remove('hidden');
}

document.getElementById('cancelEditBtn').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.add('hidden');
});

document.getElementById('editProductForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit_id').value;
    const data = {
        role_id: document.getElementById('edit_role_id').value.trim(),
        name: document.getElementById('edit_name').value.trim(),
        price: parseInt(document.getElementById('edit_price').value),
        description: document.getElementById('edit_description').value.trim(),
        features: document.getElementById('edit_features').value.trim(),
    };

    try {
        const res = await apiFetch(`/products/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Failed to update');
        toast('✅ تم حفظ التعديلات', 'success');
        document.getElementById('edit-modal').classList.add('hidden');
        await loadProducts();
    } catch (error) {
        if (error.message !== 'Unauthorized') toast('❌ فشل حفظ التعديلات', 'error');
    }
});

// ============================================================
//  🧾 سجل محاولات الدفع
// ============================================================
const STATUS_LABELS = {
    success: '✅ نجاح',
    underpaid: '🔻 مبلغ أقل',
    overpaid: '🔺 مبلغ أكثر',
    timeout: '⏱️ انتهت المهلة',
};

async function loadLogs() {
    try {
        const res = await apiFetch('/logs');
        if (!res.ok) throw new Error('Failed to fetch logs');
        const logs = await res.json();
        renderLogs(logs);
        document.getElementById('successCount').textContent = logs.filter(l => l.status === 'success').length;
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            document.getElementById('logs').innerHTML = '<div class="empty-message">❌ خطأ في تحميل السجل</div>';
        }
    }
}

function renderLogs(logs) {
    const container = document.getElementById('logs');
    if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="empty-message">📭 لا توجد محاولات مسجلة بعد</div>';
        return;
    }

    container.innerHTML = logs.map(l => `
        <div class="product">
            <div class="info">
                <h3><span class="status-badge status-${l.status}">${STATUS_LABELS[l.status] || l.status}</span> &nbsp;${escapeHtml(l.product_name || 'غير معروف')}</h3>
                <div class="desc">👤 ${escapeHtml(l.username || l.user_id)} &nbsp;|&nbsp; 🎫 ${escapeHtml(l.ticket_name || '-')}</div>
                <div class="desc">💰 المطلوب: ${Number(l.required_amount).toLocaleString()} &nbsp;|&nbsp; المحوّل فعليًا: ${l.actual_amount != null ? Number(l.actual_amount).toLocaleString() : 'لا يوجد'}</div>
                <div class="meta">🕒 ${new Date(l.created_at).toLocaleString('ar-SA')}</div>
            </div>
        </div>
    `).join('');
}

document.getElementById('refreshLogsBtn').addEventListener('click', loadLogs);

// ============================================================
//  🚀 تشغيل لوحة التحكم بعد تسجيل الدخول بنجاح
// ============================================================
function initDashboard() {
    loadProducts();
    loadLogs();
}

// عند تحميل الصفحة لأول مرة: تظهر شاشة الدخول دائمًا (لا يوجد تذكرني)
showLogin();
