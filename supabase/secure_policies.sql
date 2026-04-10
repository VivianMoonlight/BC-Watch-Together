-- BC Listen Together secure policy baseline (recommended after MVP).
-- Assumes JWT claim `sub` maps to app user id, and client writes `member_id` as sub.

-- Drop permissive policies from schema.sql before applying these.

alter table public.bclt_rooms enable row level security;
alter table public.bclt_room_states enable row level security;
alter table public.bclt_room_members enable row level security;

-- Rooms
create policy bclt_rooms_select_member on public.bclt_rooms
for select to authenticated
using (
    exists (
        select 1
        from public.bclt_room_members m
        where m.room_id = bclt_rooms.room_id
          and m.member_id = auth.uid()::text
    )
);

create policy bclt_rooms_insert_creator on public.bclt_rooms
for insert to authenticated
with check (created_by = auth.uid()::text);

create policy bclt_rooms_update_host on public.bclt_rooms
for update to authenticated
using (host_member_id = auth.uid()::text)
with check (host_member_id = auth.uid()::text);

-- Room states: readable by members, writable only by host.
create policy bclt_states_select_member on public.bclt_room_states
for select to authenticated
using (
    exists (
        select 1
        from public.bclt_room_members m
        where m.room_id = bclt_room_states.room_id
          and m.member_id = auth.uid()::text
    )
);

create policy bclt_states_insert_host on public.bclt_room_states
for insert to authenticated
with check (host_member_id = auth.uid()::text);

create policy bclt_states_update_host on public.bclt_room_states
for update to authenticated
using (host_member_id = auth.uid()::text)
with check (host_member_id = auth.uid()::text);

-- Members: each member can upsert self row; host can update host flags.
create policy bclt_members_select_member on public.bclt_room_members
for select to authenticated
using (
    exists (
        select 1
        from public.bclt_room_members m
        where m.room_id = bclt_room_members.room_id
          and m.member_id = auth.uid()::text
    )
);

create policy bclt_members_insert_self on public.bclt_room_members
for insert to authenticated
with check (member_id = auth.uid()::text);

create policy bclt_members_update_self_or_host on public.bclt_room_members
for update to authenticated
using (
    member_id = auth.uid()::text
    or exists (
        select 1
        from public.bclt_rooms r
        where r.room_id = bclt_room_members.room_id
          and r.host_member_id = auth.uid()::text
    )
)
with check (
    member_id = auth.uid()::text
    or exists (
        select 1
        from public.bclt_rooms r
        where r.room_id = bclt_room_members.room_id
          and r.host_member_id = auth.uid()::text
    )
);

create policy bclt_members_delete_self_or_host on public.bclt_room_members
for delete to authenticated
using (
    member_id = auth.uid()::text
    or exists (
        select 1
        from public.bclt_rooms r
        where r.room_id = bclt_room_members.room_id
          and r.host_member_id = auth.uid()::text
    )
);

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
