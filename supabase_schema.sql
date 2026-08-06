-- شغّل هذا الكود في Supabase Dashboard > SQL Editor > New Query

create table if not exists products (
    id bigint generated always as identity primary key,
    role_id text unique not null,
    name text not null,
    price integer not null,
    description text default '',
    features text default '',
    created_at timestamptz default now()
);

-- (اختياري) تفعيل Row Level Security ومنع أي وصول مباشر من العميل
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

alter table transfer_logs enable row level security;
