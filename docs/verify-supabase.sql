-- 成年审核 · 激活码自助申请
-- 在 Supabase SQL Editor 中执行一次。
-- 依赖：docs/account-supabase.sql（activation_codes 表）已执行。

create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  query_code text not null unique,
  contact text not null,
  image_path text,
  status text not null default 'pending',
  activation_code text,
  note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint verification_requests_status_check check (status in ('pending', 'approved', 'rejected'))
);

-- 开启 RLS 且不创建任何 policy：仅 service_role（服务端 API）可读写。
alter table public.verification_requests enable row level security;

create index if not exists verification_requests_status_idx
  on public.verification_requests (status, created_at desc);

-- 私有图片桶（public=false：匿名/客户端不可读，只有服务端能取）
insert into storage.buckets (id, name, public)
values ('verification-images', 'verification-images', false)
on conflict (id) do nothing;
