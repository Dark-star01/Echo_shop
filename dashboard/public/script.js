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

// ---------- الهوية (اسم البوت وأفتاره) ----------
const LOGO_FALLBACK = '/logo.svg';
async function loadBrand() {
  try {
    const b = await (await fetch('/brand.json')).json();
    if (b.name) {
      document.querySelectorAll('.brandName').forEach((el) => (el.textContent = b.name));
      document.title = `${b.name} — لوحة التحكم`;
    }
    if (b.avatar) {
      document.querySelectorAll('.brandLogo').forEach((img) => { img.onerror = () => { img.onerror = null; img.src = LOGO_FALLBACK; }; img.src = b.avatar; });
      const fav = $('#favicon'); if (fav) fav.href = b.avatar;
    }
  } catch { /* نبقي الشعار الافتراضي */ }
}
loadBrand();

// ---------- أدوات العرض ----------
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const td = (label, html, cls = '') => `<td${cls ? ` class="${cls}"` : ''} data-label="${label}"><div class="v">${html}</div></td>`;
const SKELETON = '<tr><td class="loading"><div class="sk"></div><div class="sk"></div><div class="sk"></div></td></tr>';
const EMPTY_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>';
const emptyRow = (msg) => `<tr><td class="empty">${EMPTY_ICON}${msg}</td></tr>`;

function countUp(el, to) {
  if (reduceMotion || to < 2) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const tick = (t) => {
    const k = Math.min((t - t0) / dur, 1);
    el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// نافذة تأكيد/إدخال بنفس تصميم اللوحة بدل confirm() و prompt()
const askDlg = $('#askDialog'), askInput = $('#askInput');
let askDone = null;
function ask({ title, text = '', yes = 'تأكيد', danger = false, input = null }) {
  $('#askTitle').textContent = title; $('#askMsg').textContent = text; $('#askMsg').hidden = !text;
  const yesBtn = $('#askYes'); yesBtn.textContent = yes; yesBtn.className = `btn ${danger ? 'confirm-danger' : 'primary'}`;
  askInput.hidden = input === null;
  if (input !== null) { askInput.value = input.value ?? ''; askInput.type = input.type || 'text'; askInput.placeholder = input.placeholder || ''; }
  return new Promise((resolve) => {
    askDone = resolve; askDlg.showModal();
    if (input !== null) askInput.select();
  });
}
const askFinish = (v) => { const f = askDone; askDone = null; if (f) f(v); if (askDlg.open) askDlg.close(); };
$('#askForm').onsubmit = (e) => { e.preventDefault(); askFinish(askInput.hidden ? true : askInput.value); };
$('#askNo').onclick = () => askFinish(askInput.hidden ? false : null);
askDlg.addEventListener('cancel', () => askFinish(askInput.hidden ? false : null));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
  } catch (e) {
    // لا تترك الصفحة فارغة إذا فشل /api/me لأي سبب غير 401 (مثل 500/503 أو مشكلة شبكة).
    showLogin();
  }
}

$('#logout').onclick = run(async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; });

// ---------- التنقل ----------
$('#nav').onclick = (e) => { const v = e.target.closest('button')?.dataset.view; if (v) show(v); };

const show = run(async (view) => {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('main.content > section').forEach((s) => {
    s.hidden = s.id !== `v-${view}`;
    s.classList.remove('enter');
    if (!s.hidden) { void s.offsetWidth; s.classList.add('enter'); }
  });
  document.querySelectorAll('.table-wrap table').forEach((t) => (t.innerHTML = SKELETON));
  window.scrollTo({ top: 0 });
  await ({ overview: loadOverview, products: loadProducts, orders: loadOrders, settings: loadSettings, coupons: loadCoupons, subs: loadSubs })[view]();
});

const statusBadge = (s) => { const [label, cls] = STATUS[s] || [s, 'muted']; return `<span class="badge ${cls}">${esc(label)}</span>`; };

function ordersRows(list) {
  if (!list.length) return emptyRow('لا توجد طلبات بعد.');
  return `<thead><tr><th>#</th><th>العميل</th><th>المنتج</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>${
    list.map((o) => `<tr class="${NEEDS_ATTENTION.includes(o.status) ? 'attn' : ''}">
      ${td('#', o.id)}${td('العميل', `${esc(o.username)}<span class="sub">${esc(o.user_id)}</span>`)}
      ${td('المنتج', esc(o.product_name))}${td('المبلغ', fmt(o.required_amount))}
      ${td('الحالة', `${statusBadge(o.status)}${o.error ? `<span class="sub">${esc(o.error)}</span>` : ''}`)}
      ${td('التاريخ', date(o.created_at))}</tr>`).join('')}</tbody>`;
}

// ---------- نظرة عامة ----------
async function loadOverview() {
  const [stats, list] = await Promise.all([api('/api/stats'), api('/api/orders')]);
  $('#stats').innerHTML = [
    [stats.revenue, 'إجمالي الإيرادات'], [stats.revenueWeek, 'إيرادات آخر 7 أيام'],
    [stats.completed, 'طلبات مكتملة'], [stats.products, 'منتجات'],
    [stats.subsActive, 'اشتراكات فعّالة'], [stats.subsExpiring, 'تنتهي خلال 3 أيام'],
  ].map(([n, l], i) => `<div style="animation-delay:${i * 60}ms"><b data-n="${n}">0</b><span>${l}</span></div>`).join('');
  document.querySelectorAll('#stats b').forEach((b) => countUp(b, Number(b.dataset.n)));

  const att = $('#attention'), badge = $('#attBadge');
  att.hidden = badge.hidden = !stats.attention;
  badge.textContent = stats.attention;
  att.innerHTML = `<span>${stats.attention} طلب دُفع ولم تُسلَّم رتبته بعد.</span><button class="btn sm" id="goAttention">عرضها</button>`;
  if (stats.attention) $('#goAttention').onclick = () => { $('#orderFilter').value = 'attention'; show('orders'); };
  const max = Math.max(...stats.daily.map((d) => d.total), 1);
  $('#chart').innerHTML = stats.daily.map((d, i) => `<div class="bar" data-tip="${d.day}: ${fmt(d.total)} كريديت">
    <i style="height:${Math.round((d.total / max) * 100)}%;--i:${i}"></i><span>${i % 2 === 0 ? d.day.slice(8) : '&nbsp;'}</span></div>`).join('');
  $('#recent').innerHTML = ordersRows(list.slice(0, 8));
}

// ---------- المنتجات ----------
async function loadProducts() { products = await api('/api/products'); renderProducts(); }

function renderProducts() {
  const q = $('#search').value.trim().toLowerCase();
  const list = products.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.role_id || '').includes(q));
  $('#productsTable').innerHTML = list.length
    ? `<thead><tr><th>المنتج</th><th>الرتبة</th><th>السعر</th><th></th></tr></thead><tbody>${list.map((p) => `<tr>
        ${td('المنتج', `${esc(p.name)}${p.duration_days ? ` <span class="badge muted">${p.duration_days} يوم</span>` : ''}<span class="sub">${esc(p.description)}</span>`)}
        ${td('الرتبة', p.type === 'custom' ? '<span class="badge info">قابلة للإنشاء</span>' : `<code>${esc(p.role_id)}</code>`)}${td('السعر', fmt(p.price))}
        ${td('', `<button class="btn sm" data-edit="${p.id}">تعديل</button><button class="btn sm danger" data-del="${p.id}">حذف</button>`, 'act')}</tr>`).join('')}</tbody>`
    : emptyRow('لا توجد منتجات. اضغط «منتج جديد» لإضافة أول منتج.');
}

$('#search').oninput = renderProducts;
$('#productsTable').onclick = run(async (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) openDialog(products.find((p) => p.id == edit));
  if (del && await ask({ title: 'حذف المنتج', text: 'حذف هذا المنتج؟ لا يمكن التراجع.', yes: 'حذف', danger: true })) {
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
        ${td('العميل', `${esc(s.username || s.user_id)}<span class="sub">${esc(s.user_id)}</span>`)}
        ${td('الرتبة', `${esc(s.role_name || s.role_id)}${s.product_name ? `<span class="sub">${esc(s.product_name)}</span>` : ''}`)}
        ${td('ينتهي', `${date(s.expires_at)}<span class="sub">${rel(s.expires_at)}</span>`)}
        ${td('الحالة', statusBadge(s.status))}
        ${s.status === 'active' ? td('', `<button class="btn sm" data-extend="${s.id}">تمديد</button><button class="btn sm danger" data-revoke="${s.id}">سحب الآن</button>`, 'act') : '<td class="act" data-label=""></td>'}</tr>`).join('')}</tbody>`
    : emptyRow('لا توجد اشتراكات. تظهر هنا عند شراء منتج له مدة اشتراك.');
}
$('#subFilter').onchange = renderSubs;
$('#subsTable').onclick = run(async (e) => {
  const ext = e.target.dataset.extend, rev = e.target.dataset.revoke;
  if (ext) {
    const val = await ask({ title: 'تمديد الاشتراك', text: 'كم يوم تبي تمدد؟', yes: 'تمديد', input: { value: '30', type: 'number' } });
    const days = parseInt(val, 10);
    if (!days) return;
    await api(`/api/subscriptions/${ext}/extend`, { method: 'POST', body: { days } });
    toast('تم التمديد'); await loadSubs();
  }
  if (rev && await ask({ title: 'سحب الرتبة', text: 'سحب الرتبة من العميل الآن وإنهاء الاشتراك؟', yes: 'سحب', danger: true })) {
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
        return `<tr>${td('الكود', `<code>${esc(c.code)}</code>`)}${td('الخصم', `${c.percent}%`)}
          ${td('الاستخدام', `${c.used} / ${c.max_uses ?? '∞'}`)}${td('للفرد', c.max_uses_per_user ?? '∞')}
          ${td('الانتهاء', c.expires_at ? date(c.expires_at) : '—')}${td('الحالة', `<span class="badge ${state[1]}">${state[0]}</span>`)}
          ${td('', `<button class="btn sm" data-toggle="${c.id}">${c.active ? 'إيقاف' : 'تفعيل'}</button><button class="btn sm danger" data-delcoupon="${c.id}">حذف</button>`, 'act')}</tr>`;
      }).join('')}</tbody>`
    : emptyRow('لا توجد كوبونات. اضغط «كوبون جديد».');
}

$('#couponsTable').onclick = run(async (e) => {
  const t = e.target.dataset.toggle, d = e.target.dataset.delcoupon;
  if (t) {
    const c = coupons.find((x) => x.id == t);
    await api(`/api/coupons/${t}`, { method: 'PATCH', body: { active: !c.active } });
    await loadCoupons();
  }
  if (d && await ask({ title: 'حذف الكوبون', text: 'حذف هذا الكوبون؟', yes: 'حذف', danger: true })) { await api(`/api/coupons/${d}`, { method: 'DELETE' }); toast('تم حذف الكوبون'); await loadCoupons(); }
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
