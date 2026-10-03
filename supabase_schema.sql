-- شغّل هذا الكود في Supabase Dashboard > SQL Editor > New Query
-- (آمن للتشغيل أكثر من مرة وعلى قاعدة موجودة — ما يحذف شي)

create table if not exists products (
    id bigint generated always as identity primary key,
    role_id text unique not null,
    name text not null,
    price integer not null,
    description text default '',
    features text default '',
    created_at timestamptz default now()
);

-- البوت والداشبورد يتصلون عبر service_role key اللي يتجاوز RLS تلقائيًا
alter table products enable row level security;

-- جدول سجل محاولات الدفع (نجاح / مبلغ خاطئ / انتهت المهلة)
create table if not exists transfer_logs (
    id bigint generated always as identity primary key,
    ticket_name text,
    user_id text not null,
    username text,
    product_id bigint,
    product_name text,
    required_amount integer not null,
    actual_amount integer,
    status text not null, -- 'success' | 'underpaid' | 'overpaid' | 'timeout'
    created_at timestamptz default now()
);

alter table transfer_logs add column if not exists order_id bigint;
alter table transfer_logs enable row level security;

-- ============================================================
--  🧾 جدول الطلبات (orders) — يتتبع كل عملية شراء من الضغط على "تأكيد" حتى التسليم
--  الحالات:
--    awaiting_payment : بانتظار التحويل
--    paid             : تم التحقق من الدفع (والتسليم قيد التنفيذ)
--    completed        : تم منح الرتبة
--    role_failed      : تم الدفع لكن فشل منح الرتبة (يحتاج تدخل ستاف)
--    failed           : مبلغ غير مطابق
--    expired          : انتهت المهلة
--    cancelled        : أُلغي / انحذفت التذكرة
--    error            : خطأ غير متوقع (يحتاج مراجعة ستاف)
--    closed_manually  : أغلقه الستاف يدويًا بعد دفع بدون تسليم
-- ============================================================
create table if not exists orders (
    id bigint generated always as identity primary key,
    channel_id text not null,
    user_id text not null,
    username text,
    product_id bigint,
    product_name text,
    role_id text not null,
    required_amount integer not null,  -- الصافي المطلوب (سعر المنتج)
    send_amount integer not null,      -- المبلغ اللي يحوّله العميل (مع ضريبة ProBot)
    actual_amount integer,
    status text not null default 'awaiting_payment',
    error text,
    expires_at timestamptz not null,
    paid_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create index if not exists orders_status_idx on orders (status);
create index if not exists orders_channel_idx on orders (channel_id);

alter table orders enable row level security;

-- ============================================================
--  ⚙️ جدول الإعدادات (يُعدَّل من الداشبورد)
-- ============================================================
create table if not exists settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz default now()
);

alter table settings enable row level security;

-- ============================================================
--  🎨 المرحلة 3: الرتب القابلة للإنشاء + ربط الرتب القديمة
-- ============================================================
alter table products add column if not exists type text not null default 'fixed';        -- 'fixed' | 'custom'
alter table products add column if not exists custom_settings jsonb not null default '{}';
alter table products alter column role_id drop not null;   -- المنتج القابل للإنشاء ما له رتبة ثابتة

alter table orders add column if not exists product_type text not null default 'fixed';
alter table orders add column if not exists draft jsonb;   -- مسودة تخصيص الرتبة (تنجو من إعادة التشغيل)
alter table orders alter column role_id drop not null;
-- حالات جديدة للطلب: customizing (العميل يخصص رتبته) | pending_review (بانتظار موافقة الستاف)

create table if not exists custom_roles (
    id bigint generated always as identity primary key,
    user_id text not null,
    role_id text unique not null,
    product_id bigint,
    name text,
    source text not null default 'purchase',   -- 'purchase' | 'linked' (ربط يدوي لرتب قديمة)
    last_edited_at timestamptz,
    created_at timestamptz default now()
);
create index if not exists custom_roles_user_idx on custom_roles (user_id);
alter table custom_roles enable row level security;

-- ============================================================
--  🎟️ المرحلة 5: الكوبونات + الاشتراكات + إعدادات اللوق والنسخ
-- ============================================================
create table if not exists coupons (
    id bigint generated always as identity primary key,
    code text unique not null,                 -- يُحفظ بأحرف كبيرة
    percent integer not null check (percent between 1 and 100),
    expires_at timestamptz,                    -- فارغ = بدون انتهاء
    max_uses integer,                          -- فارغ = غير محدود (إجمالي)
    max_uses_per_user integer default 1,       -- فارغ = غير محدود
    active boolean not null default true,
    created_at timestamptz default now()
);
alter table coupons enable row level security;

-- الاستخدام يُحسب من الطلبات (ما عدا failed / expired / cancelled)
alter table orders add column if not exists coupon_id bigint;
alter table orders add column if not exists discount_percent integer;
alter table orders add column if not exists original_amount integer;
create index if not exists orders_coupon_idx on orders (coupon_id);

-- اشتراكات الرتب الجاهزة: duration_days فارغ = دائم
alter table products add column if not exists duration_days integer;
alter table orders add column if not exists duration_days integer;

create table if not exists subscriptions (
    id bigint generated always as identity primary key,
    user_id text not null,
    role_id text not null,
    product_id bigint,
    order_id bigint,
    expires_at timestamptz not null,
    status text not null default 'active',     -- 'active' | 'expired' | 'removal_failed'
    created_at timestamptz default now()
);
create index if not exists subscriptions_due_idx on subscriptions (status, expires_at);
alter table subscriptions enable row level security;
