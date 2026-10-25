-- Run after setup.sql and gemini_scoring.sql in the Supabase SQL Editor.
-- Gives new rooms longer random codes and stores per-question battle scores.

alter table public.battle_rooms
  drop constraint if exists battle_rooms_code_check;
alter table public.battle_rooms
  add constraint battle_rooms_code_check check (code ~ '^[A-Z0-9]{6,8}$');
alter table public.battle_rooms
  add column if not exists question_date date not null default ((now() at time zone 'Asia/Manila')::date);

alter table public.battle_players
  add column if not exists score integer not null default 0 check (score >= 0),
  add column if not exists answered_count integer not null default 0 check (answered_count between 0 and 7);

create table if not exists public.battle_answers (
  id bigint generated always as identity primary key,
  room_id uuid not null,
  user_id uuid not null,
  question_index integer not null references public.daily_questions(question_index),
  answer text not null check (char_length(answer) between 1 and 160),
  points integer not null default 0,
  closeness real not null check (closeness between 0 and 1),
  rarity_bonus integer not null default 0,
  rarity_score integer not null default 1 check (rarity_score between 1 and 100),
  rarity_tier text not null default 'common' check (rarity_tier in ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  created_at timestamptz not null default now(),
  constraint battle_answers_player_fk foreign key (room_id, user_id)
    references public.battle_players(room_id, user_id) on delete cascade,
  constraint battle_answers_one_per_question unique (room_id, user_id, question_index)
);

alter table public.battle_answers enable row level security;
revoke all on public.battle_answers from public, anon, authenticated;
grant all on public.battle_answers to service_role;

alter table public.battle_answers add column if not exists rarity_score integer not null default 1
  check (rarity_score between 1 and 100);

create or replace function public.get_battle_room(p_code text)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_room public.battle_rooms%rowtype; v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to view a room'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code));
  if not found then raise exception 'Room code not found'; end if;
  if not exists (select 1 from public.battle_players where room_id = v_room.id and user_id = auth.uid()) then
    raise exception 'Join this room to see its lobby';
  end if;
  select jsonb_build_object(
    'id', v_room.id, 'code', v_room.code, 'title', v_room.room_title,
    'host_user_id', v_room.host_user_id, 'is_host', v_room.host_user_id = auth.uid(), 'status', v_room.status,
    'question_date', v_room.question_date,
    'players', coalesce(jsonb_agg(jsonb_build_object(
      'user_id', p.user_id, 'display_name', p.display_name,
      'is_host', p.user_id = v_room.host_user_id, 'score', p.score,
      'answered_count', p.answered_count
    ) order by p.score desc, p.joined_at), '[]'::jsonb)
  ) into v_result from public.battle_players p where p.room_id = v_room.id;
  return v_result;
end $$;

create or replace function public.create_battle_room(p_display_name text, p_title text default 'Open lobby')
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_code text; v_room_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to create a room'; end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 24 then raise exception 'Enter a name (1–24 characters)'; end if;
  loop
    v_code := upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 8));
    begin
      insert into public.battle_rooms (code, room_title, host_user_id, question_date)
        values (v_code, left(coalesce(nullif(trim(p_title), ''), 'Open lobby'), 48), auth.uid(), (now() at time zone 'Asia/Manila')::date) returning id into v_room_id;
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  insert into public.battle_players (room_id, user_id, display_name) values (v_room_id, auth.uid(), trim(p_display_name));
  return public.get_battle_room(v_code);
end $$;

create or replace function public.join_battle_room(p_code text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_room public.battle_rooms%rowtype; v_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to join a room'; end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 24 then raise exception 'Enter a name (1–24 characters)'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room code not found'; end if;
  if v_room.status <> 'waiting' then raise exception 'This room has already started'; end if;
  select count(*) into v_count from public.battle_players where room_id = v_room.id;
  if v_count >= 18 and not exists (select 1 from public.battle_players where room_id = v_room.id and user_id = auth.uid()) then raise exception 'This room is full'; end if;
  insert into public.battle_players (room_id, user_id, display_name) values (v_room.id, auth.uid(), trim(p_display_name))
    on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return public.get_battle_room(v_room.code);
end $$;

drop function if exists public.submit_battle_answer_ai(uuid, text, integer, text, text);
create or replace function public.submit_battle_answer_ai(
  p_user_id uuid,
  p_code text,
  p_question_index integer,
  p_answer text,
  p_rarity_score integer
)
returns jsonb language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_room public.battle_rooms%rowtype;
  v_player public.battle_players%rowtype;
  v_question public.daily_question_sets%rowtype;
  v_normalized text;
  v_closeness real := 0;
  v_tier_bonus integer := 10;
  v_rarity_tier text;
  v_points integer := 0;
  v_rarity_bonus integer := 0;
begin
  if p_user_id is null then raise exception 'Player not found'; end if;
  if length(trim(coalesce(p_answer, ''))) = 0 or length(p_answer) > 160 then raise exception 'Enter an answer up to 160 characters'; end if;
  if p_rarity_score is null or p_rarity_score < 1 or p_rarity_score > 100 then raise exception 'Gemini returned an invalid rarity score'; end if;
  if p_question_index is null or p_question_index < 0 or p_question_index > 6 then raise exception 'Question not found'; end if;

  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found or v_room.status <> 'active' then raise exception 'This battle is not active'; end if;
  select * into v_player from public.battle_players where room_id = v_room.id and user_id = p_user_id for update;
  if not found then raise exception 'Join this room before playing'; end if;
  v_rarity_tier := case
    when p_rarity_score >= 81 then 'legendary'
    when p_rarity_score >= 61 then 'epic'
    when p_rarity_score >= 41 then 'rare'
    when p_rarity_score >= 21 then 'uncommon'
    else 'common'
  end;
  if exists (select 1 from public.battle_answers where room_id = v_room.id and user_id = p_user_id and question_index = p_question_index) then
    return jsonb_build_object('points', 0, 'total_score', v_player.score, 'closeness', 0, 'rarity_bonus', 0, 'rarity_tier', v_rarity_tier, 'rarity_score', p_rarity_score, 'already_answered', true);
  end if;
  select * into v_question from public.daily_question_sets
    where question_date = v_room.question_date and question_index = p_question_index;
  if not found then raise exception 'Question not found'; end if;

  v_normalized := lower(regexp_replace(trim(p_answer), '\s+', ' ', 'g'));
  select coalesce(max(extensions.similarity(v_normalized, lower(regexp_replace(trim(a), '\s+', ' ', 'g')))), 0)
    into v_closeness from unnest(v_question.accepted_answers) a;
  v_tier_bonus := case v_rarity_tier when 'uncommon' then 25 when 'rare' then 50 when 'epic' then 100 when 'legendary' then 200 else 10 end;
  v_rarity_bonus := round(v_tier_bonus * v_closeness)::integer;
  v_points := 10 + round(v_closeness * 90)::integer + v_rarity_bonus;

  insert into public.battle_answers (room_id, user_id, question_index, answer, points, closeness, rarity_bonus, rarity_tier, rarity_score)
    values (v_room.id, p_user_id, p_question_index, trim(p_answer), v_points, v_closeness, v_rarity_bonus, v_rarity_tier, p_rarity_score);
  update public.battle_players set score = score + v_points, answered_count = answered_count + 1
    where room_id = v_room.id and user_id = p_user_id returning * into v_player;
  return jsonb_build_object('points', v_points, 'total_score', v_player.score,
    'closeness', v_closeness, 'rarity_bonus', v_rarity_bonus, 'rarity_tier', v_rarity_tier,
    'rarity_score', p_rarity_score, 'already_answered', false);
end $$;

revoke all on function public.get_battle_room(text) from public, anon;
revoke all on function public.create_battle_room(text, text) from public, anon;
revoke all on function public.join_battle_room(text, text) from public, anon;
revoke all on function public.submit_battle_answer_ai(uuid, text, integer, text, integer) from public, anon, authenticated;
grant execute on function public.get_battle_room(text) to authenticated;
grant execute on function public.create_battle_room(text, text) to authenticated;
grant execute on function public.join_battle_room(text, text) to authenticated;
grant execute on function public.submit_battle_answer_ai(uuid, text, integer, text, integer) to service_role;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') and
     not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'battle_players') then
    alter publication supabase_realtime add table public.battle_players;
  end if;
end $$;
