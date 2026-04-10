-- BC Listen Together (MVP) schema for Supabase
-- Run in Supabase SQL Editor.

create table if not exists public.bclt_rooms (
    room_id text primary key,
    room_passcode text not null,
    host_member_id text not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.bclt_room_states (
    room_id text primary key references public.bclt_rooms(room_id) on delete cascade,
    room_passcode text not null,
    host_member_id text not null,
    media_src text,
    media_current_time double precision not null default 0,
    paused boolean not null default true,
    playback_rate double precision not null default 1,
    seq bigint not null default 0,
    updated_at timestamptz not null default now()
);

create table if not exists public.bclt_room_members (
    room_id text not null references public.bclt_rooms(room_id) on delete cascade,
    member_id text not null,
    display_name text not null,
    is_host boolean not null default false,
    last_seen_at timestamptz not null default now(),
    primary key (room_id, member_id)
);

alter table public.bclt_rooms enable row level security;
alter table public.bclt_room_states enable row level security;
alter table public.bclt_room_members enable row level security;

-- WARNING: For MVP convenience we keep policies permissive for authenticated/anon roles.
-- Tighten these before production.

drop policy if exists bclt_rooms_select_all on public.bclt_rooms;
create policy bclt_rooms_select_all on public.bclt_rooms
for select to anon, authenticated
using (true);

drop policy if exists bclt_rooms_insert_all on public.bclt_rooms;
create policy bclt_rooms_insert_all on public.bclt_rooms
for insert to anon, authenticated
with check (true);

drop policy if exists bclt_rooms_update_all on public.bclt_rooms;
create policy bclt_rooms_update_all on public.bclt_rooms
for update to anon, authenticated
using (true)
with check (true);

drop policy if exists bclt_states_select_all on public.bclt_room_states;
create policy bclt_states_select_all on public.bclt_room_states
for select to anon, authenticated
using (true);

drop policy if exists bclt_states_insert_all on public.bclt_room_states;
create policy bclt_states_insert_all on public.bclt_room_states
for insert to anon, authenticated
with check (true);

drop policy if exists bclt_states_update_all on public.bclt_room_states;
create policy bclt_states_update_all on public.bclt_room_states
for update to anon, authenticated
using (true)
with check (true);

drop policy if exists bclt_members_select_all on public.bclt_room_members;
create policy bclt_members_select_all on public.bclt_room_members
for select to anon, authenticated
using (true);

drop policy if exists bclt_members_insert_all on public.bclt_room_members;
create policy bclt_members_insert_all on public.bclt_room_members
for insert to anon, authenticated
with check (true);

drop policy if exists bclt_members_update_all on public.bclt_room_members;
create policy bclt_members_update_all on public.bclt_room_members
for update to anon, authenticated
using (true)
with check (true);

drop policy if exists bclt_members_delete_all on public.bclt_room_members;
create policy bclt_members_delete_all on public.bclt_room_members
for delete to anon, authenticated
using (true);

create or replace function public.bclt_cleanup_empty_room()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if not exists (
        select 1
        from public.bclt_room_members m
        where m.room_id = old.room_id
    ) then
        delete from public.bclt_rooms r
        where r.room_id = old.room_id;
    end if;

    return old;
end;
$$;

drop trigger if exists bclt_room_members_cleanup_empty_room on public.bclt_room_members;
create trigger bclt_room_members_cleanup_empty_room
after delete on public.bclt_room_members
for each row
execute function public.bclt_cleanup_empty_room();

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'bclt_room_states'
    ) then
        alter publication supabase_realtime add table public.bclt_room_states;
    end if;

    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'bclt_room_members'
    ) then
        alter publication supabase_realtime add table public.bclt_room_members;
    end if;
end
$$;
