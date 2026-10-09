-- Supabase SQL for the global note wall.
-- Run this once in the Supabase SQL editor.

create table if not exists public.note_wall_boards (
  id text primary key,
  title text not null default '便签墙',
  width integer not null default 1600,
  height integer not null default 1200,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.note_wall_notes (
  id uuid primary key default gen_random_uuid(),
  board_id text not null references public.note_wall_boards(id) on delete cascade,

  author_type text not null check (author_type in ('user', 'character')),
  author_id text not null,
  author_name text not null,
  is_anonymous boolean not null default false,

  summary text not null,
  body text not null,

  x integer not null,
  y integer not null,
  width integer not null,
  height integer not null,
  size text not null default 'medium' check (size in ('small', 'medium', 'large')),

  paper text not null default 'plain',
  tape text not null default 'none',
  font text not null default 'default',
  decoration text not null default 'none',

  raw_css text,
  safe_style jsonb not null default '{}'::jsonb,

  created_by text,
  updated_by text,
  deleted_by text,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.note_wall_notes
  add column if not exists is_anonymous boolean not null default false;

create index if not exists note_wall_notes_board_created_idx
  on public.note_wall_notes (board_id, created_at);

create table if not exists public.note_wall_comments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.note_wall_notes(id) on delete cascade,

  author_id text not null,
  author_name text not null,
  body text not null,
  is_anonymous boolean not null default false,

  created_by text,
  deleted_by text,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.note_wall_comments
  add column if not exists is_anonymous boolean not null default false;

create index if not exists note_wall_comments_note_created_idx
  on public.note_wall_comments (note_id, created_at);

insert into public.note_wall_boards (id, title, width, height)
values ('global', '便签墙', 1600, 1200)
on conflict (id) do nothing;

alter table public.note_wall_boards enable row level security;
alter table public.note_wall_notes enable row level security;
alter table public.note_wall_comments enable row level security;

grant select on public.note_wall_boards to anon;
grant select on public.note_wall_notes to anon;
grant select on public.note_wall_comments to anon;

drop policy if exists "note_wall_boards_public_read" on public.note_wall_boards;
create policy "note_wall_boards_public_read"
  on public.note_wall_boards
  for select
  to anon
  using (true);

drop policy if exists "note_wall_notes_public_read" on public.note_wall_notes;
create policy "note_wall_notes_public_read"
  on public.note_wall_notes
  for select
  to anon
  using (deleted_at is null);

drop policy if exists "note_wall_comments_public_read" on public.note_wall_comments;
create policy "note_wall_comments_public_read"
  on public.note_wall_comments
  for select
  to anon
  using (deleted_at is null);

alter table public.note_wall_boards replica identity full;
alter table public.note_wall_notes replica identity full;
alter table public.note_wall_comments replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'note_wall_boards'
  ) then
    alter publication supabase_realtime add table public.note_wall_boards;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'note_wall_notes'
  ) then
    alter publication supabase_realtime add table public.note_wall_notes;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'note_wall_comments'
  ) then
    alter publication supabase_realtime add table public.note_wall_comments;
  end if;
end $$;
