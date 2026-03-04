create extension if not exists pgcrypto;

create table if not exists public.guestbook_messages (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  name text not null,
  message text not null,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  constraint guestbook_messages_name_len check (char_length(name) between 1 and 24),
  constraint guestbook_messages_message_len check (char_length(message) between 1 and 240),
  constraint guestbook_messages_event_len check (char_length(event_id) between 1 and 60)
);

create index if not exists idx_guestbook_messages_event_created
  on public.guestbook_messages (event_id, created_at desc);

alter table public.guestbook_messages enable row level security;

create table if not exists public.admin_accounts (
  email text primary key,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.admin_accounts enable row level security;

create table if not exists public.event_settings (
  event_id text primary key,
  active_pdf_path text null,
  updated_at timestamptz not null default now(),
  updated_by uuid null default auth.uid(),
  constraint event_settings_event_len check (char_length(event_id) between 1 and 60),
  constraint event_settings_pdf_len check (active_pdf_path is null or char_length(active_pdf_path) <= 400)
);

alter table public.event_settings enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_accounts a
    where a.is_active = true
      and lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.touch_event_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_touch_event_settings on public.event_settings;
create trigger trg_touch_event_settings
before update on public.event_settings
for each row
execute function public.touch_event_settings_updated_at();

drop policy if exists "anon can read visible guestbook rows" on public.guestbook_messages;
drop policy if exists "anon can insert guestbook rows" on public.guestbook_messages;
drop policy if exists "admin can read guestbook rows" on public.guestbook_messages;
drop policy if exists "anyone can read visible guestbook rows" on public.guestbook_messages;
drop policy if exists "anyone can insert guestbook rows" on public.guestbook_messages;

create policy "anyone can read visible guestbook rows"
  on public.guestbook_messages
  for select
  to anon, authenticated
  using (is_hidden = false);

create policy "anyone can insert guestbook rows"
  on public.guestbook_messages
  for insert
  to anon, authenticated
  with check (
    is_hidden = false
    and char_length(event_id) between 1 and 60
    and char_length(name) between 1 and 24
    and char_length(message) between 1 and 240
  );

drop policy if exists "admin can read event settings" on public.event_settings;
drop policy if exists "admin can insert event settings" on public.event_settings;
drop policy if exists "admin can update event settings" on public.event_settings;
drop policy if exists "anyone can read event settings" on public.event_settings;

create policy "anyone can read event settings"
  on public.event_settings
  for select
  to anon, authenticated
  using (true);

create policy "admin can insert event settings"
  on public.event_settings
  for insert
  to authenticated
  with check (public.is_admin());

create policy "admin can update event settings"
  on public.event_settings
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-pdfs',
  'event-pdfs',
  true,
  15728640,
  array['application/pdf']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "admin can read pdf objects" on storage.objects;
drop policy if exists "admin can upload pdf objects" on storage.objects;
drop policy if exists "admin can update pdf objects" on storage.objects;
drop policy if exists "admin can delete pdf objects" on storage.objects;

create policy "admin can read pdf objects"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'event-pdfs' and public.is_admin());

create policy "admin can upload pdf objects"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'event-pdfs' and public.is_admin());

create policy "admin can update pdf objects"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'event-pdfs' and public.is_admin())
  with check (bucket_id = 'event-pdfs' and public.is_admin());

create policy "admin can delete pdf objects"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'event-pdfs' and public.is_admin());

-- 아래 이메일을 Supabase Auth 관리자 계정 이메일로 바꿔 등록하세요.
-- insert into public.admin_accounts (email, is_active)
-- values ('your-admin-auth-email@example.com', true)
-- on conflict (email) do update set is_active = true;
