-- pgcrypto is installed in the `extensions` schema on Supabase. The live
-- function's search_path is intentionally restricted, so qualify the call.
create or replace function public.create_battle_room(p_display_name text, p_title text default 'Open lobby')
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v_code text; v_room_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to create a room'; end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 24 then raise exception 'Enter a name (1–24 characters)'; end if;
  loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 8));
    begin
      insert into public.battle_rooms (code, room_title, host_user_id, question_date)
        values (v_code, left(coalesce(nullif(trim(p_title), ''), 'Open lobby'), 48), auth.uid(), (now() at time zone 'Asia/Manila')::date) returning id into v_room_id;
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  insert into public.battle_players (room_id, user_id, display_name) values (v_room_id, auth.uid(), trim(p_display_name));
  return public.get_battle_room(v_code);
end;
$$;
