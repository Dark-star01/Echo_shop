const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const date = (d) => new Date(d).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' });

const STATUS = {
  completed: ['مكتمل', 'ok'], paid: ['مدفوع', 'ok'], awaiting_payment: ['بانتظار الدفع', 'info'],
  role_failed: ['يحتاج تدخل', 'warn'], error: ['خطأ', 'warn'], failed: ['مبلغ خاطئ', 'bad'],
  expired: ['منتهي', 'muted'], active: ['فعال', 'ok'], removal_failed: ['فشل السحب', 'warn'], cancelled: ['ملغي', 'muted'], closed_manually: ['أُغلق يدوياً', 'muted'],
};
const NEEDS_ATTENTION = ['role_failed', 'error'];

let products = [], orders = [], config = null;

function toast(msg, type = 'ok') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast ${type}`; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'error'); } };

// ---------- الدخول ----------
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
  const err = new URLSearchParams(location.search).get('error');
  const msgs = {
    forbidden: 'حسابك لا يملك الرتبة المطلوبة للدخول.',
    failed: 'فشل تسجيل الدخول، حاول مرة أخرى.',
    setup: 'الداشبورد غير مُعدّ بعد (راجع إعدادات OAuth في ملف .env).',
  };
  if (msgs[err]) { $('#loginError').textContent = msgs[err]; $('#loginError').hidden = false; }
}

async function init() {
  try {
    const me = await api('/api/me');
    $('#login').hidden = true; $('#app').hidden = false;
    $('#userName').textContent = me.name;
    $('#avatar').innerHTML = me.avatar
      ? `<img alt="" src="https://cdn.discordapp.com/avatars/${esc(me.id)}/${esc(me.avatar)}.png?size=64">`
      : esc(me.name.slice(0, 1));
    show('overview');
  } catch { /* showLogin تم استدعاؤها */ }
}

$('#logout').onclick = run(async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; });

// ---------- التنقل ----------
$('#nav').onclick = (e) => { const v = e.target.closest('button')?.dataset.view; if (v) show(v); };

const show = run(async (view) => {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('main.content > section').forEach((s) => (s.hidden = s.id !== `v-${view}`));
  document.querySelectorAll('.table-wrap table').forEach((t) => (t.innerHTML = '<tr><td class="loading">جارِ التحميل…</td></tr>'));
  await ({ overview: loadOverview, products: loadProducts, orders: loadOrders, settings: loadSettings, coupons: loadCoupons, subs: loadSubs })[view]();
});

const statusBadge = (s) => { const [label, cls] = STATUS[s] || [s, 'muted']; return `<span class="badge ${cls}">${esc(label)}</span>`; };

function ordersRows(list) {
  if (!list.length) return '<tr><td class="empty">لا توجد طلبات بعد.</td></tr>';
  return `<thead><tr><th>#</th><th>العميل</th><th>المنتج</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>${
    list.map((o) => `<tr class="${NEEDS_ATTENTION.includes(o.status) ? 'attn' : ''}">
      <td>${o.id}</td><td>${esc(o.username)}<span class="sub">${esc(o.user_id)}</span></td>
      <td>${esc(o.product_name)}</td><td>${fmt(o.required_amount)}</td>
      <td>${statusBadge(o.status)}${o.error ? `<span class="sub">${esc(o.error)}</span>` : ''}</td>
      <td>${date(o.created_at)}</td></tr>`).join('')}</tbody>`;
}

// ---------- نظرة عامة ----------
async function loadOverview() {
  const [stats, list] = await Promise.all([api('/api/stats'), api('/api/orders')]);
  $('#stats').innerHTML = [
    [fmt(stats.revenue), 'إجمالي الإيرادات'], [fmt(stats.revenueWeek), 'إيرادات آخر 7 أيام'],
    [fmt(stats.completed), 'طلبات مكتملة'], [fmt(stats.products), 'منتجات'],
    [fmt(stats.subsActive), 'اشتراكات فعّالة'], [fmt(stats.subsExpiring), 'تنتهي خلال 3 أيام'],
  ].map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('');

  const att = $('#attention'), badge = $('#attBadge');
  att.hidden = badge.hidden = !stats.attention;
  badge.textContent = stats.attention;
  att.innerHTML = `<span>${stats.attention} طلب دُفع ولم تُسلَّم رتبته بعد.</span><button class="btn sm" id="goAttention">عرضها</button>`;
  if (stats.attention) $('#goAttention').onclick = () => { $('#orderFilter').value = 'attention'; show('orders'); };
  const max = Math.max(...stats.daily.map((d) => d.total), 1);
  $('#chart').innerHTML = stats.daily.map((d, i) => `<div class="bar" title="${d.day}: ${fmt(d.total)} كريديت">
    <i style="height:${Math.round((d.total / max) * 100)}%"></i><span>${i % 2 === 0 ? d.day.slice(8) : '&nbsp;'}</span></div>`).join('');
  $('#recent').innerHTML = ordersRows(list.slice(0, 8));
}

// ---------- المنتجات ----------
async function loadProducts() { products = await api('/api/products'); renderProducts(); }

function renderProducts() {
  const q = $('#search').value.trim().toLowerCase();
  const list = products.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.role_id || '').includes(q));
  $('#productsTable').innerHTML = list.length
    ? `<thead><tr><th>المنتج</th><th>الرتبة</th><th>السعر</th><th></th></tr></thead><tbody>${list.map((p) => `<tr>
        <td>${esc(p.name)}${p.duration_days ? ` <span class="badge muted">${p.duration_days} يوم</span>` : ''}<span class="sub">${esc(p.description)}</span></td>
        <td>${p.type === 'custom' ? '<span class="badge info">قابلة للإنشاء</span>' : `<code>${esc(p.role_id)}</code>`}</td><td>${fmt(p.price)}</td>
        <td class="act"><button class="btn sm" data-edit="${p.id}">تعديل</button><button class="btn sm danger" data-del="${p.id}">حذف</button></td></tr>`).join('')}</tbody>`
    : '<tr><td class="empty">لا توجد منتجات. اضغط «منتج جديد» لإضافة أول منتج.</td></tr>';
}

$('#search').oninput = renderProducts;
$('#productsTable').onclick = run(async (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) openDialog(products.find((p) => p.id == edit));
  if (del && confirm('حذف هذا المنتج؟ لا يمكن التراجع.')) {
    await api(`/api/products/${del}`, { method: 'DELETE' });
    toast('تم حذف المنتج'); await loadProducts();
  }
});

const dialog = $('#productDialog'), form = $('#productForm');
const checks = (name, items, picked) => Object.entries(items).map(([k, label]) =>
  `<label class="check"><input type="checkbox" name="${name}" value="${k}" ${picked.includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
const syncType = () => {
  const custom = form.elements.type.value === 'custom';
  $('#customFields').hidden = !custom; $('#roleField').hidden = custom; $('#durationField').hidden = custom;
  form.elements.role_id.required = !custom;
};
form.elements.type.onchange = syncType;

async function openDialog(p) {
  config ||= await api('/api/custom-config');
  form.reset();
  const cs = p?.custom_settings || {};
  $('#dialogTitle').textContent = p ? 'تعديل المنتج' : 'منتج جديد';
  for (const k of ['id', 'role_id', 'name', 'price', 'description', 'features']) form.elements[k].value = p?.[k] ?? '';
  form.elements.type.value = p?.type || 'fixed';
  form.elements.duration_days.value = p?.duration_days ?? '';
  $('#modeChecks').innerHTML = checks('color_modes', config.modes, cs.color_modes || ['solid']);
  $('#permChecks').innerHTML = checks('permissions', config.permissions, cs.permissions || []);
  form.elements.allow_icon.checked = !!cs.allow_icon;
  form.elements.require_review.checked = !!cs.require_review;
  form.elements.max_name_length.value = cs.max_name_length ?? 32;
  form.elements.banned_words.value = (cs.banned_words || []).join(', ');
  form.elements.edit_price.value = cs.edit_price ?? 0;
  form.elements.edit_cooldown_days.value = cs.edit_cooldown_days ?? 7;
  syncType();
  dialog.showModal();
}
$('#addBtn').onclick = run(() => openDialog());
$('#refreshShop').onclick = run(async () => { await api('/api/shop/refresh', { method: 'POST' }); toast('تم تحديث إمبد المتجر'); });
$('#cancelDialog').onclick = () => dialog.close();
form.onsubmit = run(async (e) => {
  e.preventDefault();
  const f = form.elements, picked = (n) => [...form.querySelectorAll(`input[name="${n}"]:checked`)].map((i) => i.value);
  const body = {
    type: f.type.value, duration_days: f.duration_days.value, role_id: f.role_id.value, name: f.name.value, price: f.price.value,
    description: f.description.value, features: f.features.value,
  };
  if (body.type === 'custom') body.custom_settings = {
    color_modes: picked('color_modes'), permissions: picked('permissions'),
    allow_icon: f.allow_icon.checked, require_review: f.require_review.checked,
    max_name_length: f.max_name_length.value, banned_words: f.banned_words.value,
    edit_price: f.edit_price.value, edit_cooldown_days: f.edit_cooldown_days.value,
  };
  const id = f.id.value;
  await api(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', body });
  dialog.close(); toast('تم حفظ المنتج'); await loadProducts();
});

// ---------- الطلبات ----------
async function loadOrders() { orders = await api('/api/orders'); renderOrders(); }
Object.entries(STATUS).forEach(([k, [label]]) => $('#orderFilter').append(new Option(label, k)));
function renderOrders() {
  const f = $('#orderFilter').value, q = $('#orderSearch').value.trim().toLowerCase();
  const list = orders.filter((o) => (f === 'all' || (f === 'attention' ? NEEDS_ATTENTION.includes(o.status) : o.status === f))
    && (!q || `${o.id} ${o.username} ${o.user_id} ${o.product_name}`.toLowerCase().includes(q)));
  $('#ordersTable').innerHTML = ordersRows(list);
}
$('#orderFilter').onchange = renderOrders;
$('#orderSearch').oninput = renderOrders;

// ---------- الاشتراكات ----------
let subs = [];
const rel = (d) => {
  const h = Math.round((new Date(d) - Date.now()) / 36e5), rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
  return Math.abs(h) < 48 ? rtf.format(h, 'hour') : rtf.format(Math.round(h / 24), 'day');
};
async function loadSubs() { subs = await api('/api/subscriptions'); renderSubs(); }
function renderSubs() {
  const list = $('#subFilter').value === 'active' ? subs.filter((s) => s.status === 'active') : subs;
  $('#subsTable').innerHTML = list.length
    ? `<thead><tr><th>العميل</th><th>الرتبة</th><th>ينتهي</th><th>الحالة</th><th></th></tr></thead><tbody>${list.map((s) => `<tr>
        <td>${esc(s.username || s.user_id)}<span class="sub">${esc(s.user_id)}</span></td>
        <td>${esc(s.role_name || s.role_id)}${s.product_name ? `<span class="sub">${esc(s.product_name)}</span>` : ''}</td>
        <td>${date(s.expires_at)}<span class="sub">${rel(s.expires_at)}</span></td>
        <td>${statusBadge(s.status)}</td>
        <td class="act">${s.status === 'active' ? `<button class="btn sm" data-extend="${s.id}">تمديد</button><button class="btn sm danger" data-revoke="${s.id}">سحب الآن</button>` : ''}</td></tr>`).join('')}</tbody>`
    : '<tr><td class="empty">لا توجد اشتراكات. تظهر هنا عند شراء منتج له مدة اشتراك.</td></tr>';
}
$('#subFilter').onchange = renderSubs;
$('#subsTable').onclick = run(async (e) => {
  const ext = e.target.dataset.extend, rev = e.target.dataset.revoke;
  if (ext) {
    const days = parseInt(prompt('عدد أيام التمديد؟', '30'), 10);
    if (!days) return;
    await api(`/api/subscriptions/${ext}/extend`, { method: 'POST', body: { days } });
    toast('تم التمديد'); await loadSubs();
  }
  if (rev && confirm('سحب الرتبة من العميل الآن وإنهاء الاشتراك؟')) {
    await api(`/api/subscriptions/${rev}/revoke`, { method: 'POST' });
    toast('تم سحب الرتبة'); await loadSubs();
  }
});

// ---------- الكوبونات ----------
let coupons = [];
async function loadCoupons() { coupons = await api('/api/coupons'); renderCoupons(); }

function renderCoupons() {
  $('#couponsTable').innerHTML = coupons.length
    ? `<thead><tr><th>الكود</th><th>الخصم</th><th>الاستخدام</th><th>للفرد</th><th>الانتهاء</th><th>الحالة</th><th></th></tr></thead><tbody>${coupons.map((c) => {
        const expired = c.expires_at && new Date(c.expires_at) < new Date();
        const state = !c.active ? ['متوقف', 'muted'] : expired ? ['منتهي', 'bad'] : c.max_uses != null && c.used >= c.max_uses ? ['مستنفد', 'warn'] : ['فعال', 'ok'];
        return `<tr><td><code>${esc(c.code)}</code></td><td>${c.percent}%</td>
          <td>${c.used} / ${c.max_uses ?? '∞'}</td><td>${c.max_uses_per_user ?? '∞'}</td>
          <td>${c.expires_at ? date(c.expires_at) : '—'}</td><td><span class="badge ${state[1]}">${state[0]}</span></td>
          <td class="act"><button class="btn sm" data-toggle="${c.id}">${c.active ? 'إيقاف' : 'تفعيل'}</button><button class="btn sm danger" data-delcoupon="${c.id}">حذف</button></td></tr>`;
      }).join('')}</tbody>`
    : '<tr><td class="empty">لا توجد كوبونات. اضغط «كوبون جديد».</td></tr>';
}

$('#couponsTable').onclick = run(async (e) => {
  const t = e.target.dataset.toggle, d = e.target.dataset.delcoupon;
  if (t) {
    const c = coupons.find((x) => x.id == t);
    await api(`/api/coupons/${t}`, { method: 'PATCH', body: { active: !c.active } });
    await loadCoupons();
  }
  if (d && confirm('حذف هذا الكوبون؟')) { await api(`/api/coupons/${d}`, { method: 'DELETE' }); toast('تم حذف الكوبون'); await loadCoupons(); }
});

const couponDialog = $('#couponDialog'), couponForm = $('#couponForm');
$('#addCoupon').onclick = () => { couponForm.reset(); couponDialog.showModal(); };
$('#cancelCoupon').onclick = () => couponDialog.close();
couponForm.onsubmit = run(async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(couponForm));
  if (body.expires_at) body.expires_at = new Date(body.expires_at).toISOString(); // يتحول من توقيت المتصفح لـ UTC
  await api('/api/coupons', { method: 'POST', body });
  couponDialog.close(); toast('تم إنشاء الكوبون'); await loadCoupons();
});

// ---------- الإعدادات ----------
const settingsForm = $('#settingsForm');
const syncTaxRow = () => ($('#taxRow').hidden = settingsForm.elements.mode.value !== 'calculated');
settingsForm.onchange = syncTaxRow;

async function loadSettings() {
  const s = await api('/api/settings');
  settingsForm.elements.mode.value = s.payment_mode;
  settingsForm.elements.tax.value = s.tax_percent;
  settingsForm.elements.reference.value = s.reference_role_id || '';
  settingsForm.elements.log_channel.value = s.log_channel_id || '';
  settingsForm.elements.transcript_channel.value = s.transcript_channel_id || '';
  settingsForm.elements.alert_channel.value = s.alert_channel_id || '';
  settingsForm.elements.idle_hours.value = s.idle_close_hours ?? 24;
  syncTaxRow();
}
settingsForm.onsubmit = run(async (e) => {
  e.preventDefault();
  await api('/api/settings', { method: 'PUT', body: {
    payment_mode: settingsForm.elements.mode.value,
    tax_percent: settingsForm.elements.tax.value || 0,
    reference_role_id: settingsForm.elements.reference.value,
    log_channel_id: settingsForm.elements.log_channel.value,
    transcript_channel_id: settingsForm.elements.transcript_channel.value,
    alert_channel_id: settingsForm.elements.alert_channel.value,
    idle_close_hours: settingsForm.elements.idle_hours.value,
  } });
  toast('تم حفظ الإعدادات');
});

init();
