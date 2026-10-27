create or replace function public.join_battle_room(p_code text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v_room public.battle_rooms%rowtype; v_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to join a room'; end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 24 then raise exception 'Enter a name (1–24 characters)'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room code not found'; end if;
  if v_room.status <> 'waiting' then raise exception 'This room has already started'; end if;
  select count(*) into v_count from public.battle_players where room_id = v_room.id;
  if v_count >= 50 and not exists (select 1 from public.battle_players where room_id = v_room.id and user_id = auth.uid()) then
    raise exception 'This room is full (50 players maximum)';
  end if;
  insert into public.battle_players (room_id, user_id, display_name)
    values (v_room.id, auth.uid(), trim(p_display_name))
    on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return public.get_battle_room(v_room.code);
end;
$$;

grant execute on function public.join_battle_room(text, text) to authenticated;
