-- Run this file once in Supabase Dashboard → SQL Editor.
-- Also enable Anonymous Sign-ins under Authentication → Providers.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table if not exists public.daily_questions (
  question_index integer primary key check (question_index between 0 and 6),
  prompt text not null,
  topic text not null,
  accepted_answers text[] not null,
  hint text not null
);
comment on column public.daily_questions.accepted_answers is 'Reference answer phrases used for proximity scoring; responses are always accepted.';

insert into public.daily_questions (question_index, prompt, topic, accepted_answers, hint) values
  (0, 'What keeps apps ready while you use your device?', 'Phones & computers', array['ram','random access memory','memory','system memory','volatile memory','dram','sram','cache','registers'], 'Think about what a device uses while apps are open.'),
  (1, 'What helps your browser find a website?', 'The web', array['dns','domain name system','dns resolver','resolver','nameserver','name server','recursive dns','authoritative dns','hosts file'], 'Think about what happens after you type a website name.'),
  (2, 'What lets a computer learn from examples?', 'AI', array['machine learning','ml','deep learning','neural network','neural nets','training data','learning algorithm','model training','supervised learning','reinforcement learning'], 'Think about how AI improves with examples.'),
  (3, 'What adds an extra step when you sign in?', 'Online safety', array['mfa','multi-factor authentication','2fa','two-factor authentication','passkey','security key','fido2','webauthn','authenticator app','biometrics','one-time password','totp','hardware token'], 'Think about an extra check for your account.'),
  (4, 'What helps a map app find where you are?', 'Phones', array['gps','global positioning system','gnss','assisted gps','a-gps','cell tower triangulation','wifi positioning','wi-fi positioning','location services','satellite navigation'], 'Think about how your phone gets its location.'),
  (5, 'What keeps your photos saved after your phone turns off?', 'Photos & files', array['ssd','solid state drive','hdd','hard drive','hard disk','flash memory','rom','sd card','non-volatile memory','nvme drive','usb drive','storage','internal storage','cloud storage'], 'Think about where saved photos live.'),
  (6, 'What helps games draw detailed images?', 'Games & graphics', array['gpu','graphics processing unit','graphics card','video card','rendering','rasterization','framebuffer','display controller','ray tracing'], 'Think about the part that draws game visuals.')
on conflict (question_index) do update set
  prompt = excluded.prompt,
  topic = excluded.topic,
  accepted_answers = excluded.accepted_answers,
  hint = excluded.hint;

create table if not exists public.daily_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_date date not null default (now() at time zone 'utc')::date,
  score integer not null default 0,
  answered_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, run_date)
);

create table if not exists public.daily_answers (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.daily_runs(id) on delete cascade,
  question_index integer not null references public.daily_questions(question_index),
  answer text not null,
  is_scored boolean not null default true,
  points integer not null default 0,
  closeness real not null default 0,
  rarity_bonus integer not null default 0,
  created_at timestamptz not null default now()
);

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='daily_answers' and column_name='is_correct')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='daily_answers' and column_name='is_scored') then
    alter table public.daily_answers rename column is_correct to is_scored;
  end if;
end $$;
alter table public.daily_answers add column if not exists closeness real not null default 0;
alter table public.daily_answers add column if not exists rarity_bonus integer not null default 0;
drop index if exists public.one_correct_answer_per_question;
create unique index if not exists one_scored_answer_per_question
  on public.daily_answers (run_id, question_index) where is_scored;
create index if not exists daily_answers_question_correct_idx
  on public.daily_answers (question_index, is_scored, created_at);

alter table public.daily_questions enable row level security;
alter table public.daily_runs enable row level security;
alter table public.daily_answers enable row level security;

drop policy if exists "Users can read their own runs" on public.daily_runs;
create policy "Users can read their own runs" on public.daily_runs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users can read their own answers" on public.daily_answers;
create policy "Users can read their own answers" on public.daily_answers
  for select to authenticated using (
    exists (select 1 from public.daily_runs r where r.id = run_id and r.user_id = auth.uid())
  );
-- Questions are read only through the scoring function, so accepted answers stay private.
revoke all on public.daily_questions from anon, authenticated;
revoke all on public.daily_runs from anon, authenticated;
revoke all on public.daily_answers from anon, authenticated;
grant select on public.daily_runs, public.daily_answers to authenticated;

create or replace function public.start_daily_run(p_run_date date default (now() at time zone 'utc')::date)
returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to start a dive'; end if;
  insert into public.daily_runs (user_id, run_date)
  values (auth.uid(), p_run_date)
  on conflict (user_id, run_date) do update set user_id = excluded.user_id
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.submit_daily_answer(p_run_id uuid, p_question_index integer, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_run public.daily_runs%rowtype;
  v_question public.daily_questions%rowtype;
  v_normalized text;
  v_points integer := 0;
  v_closeness real := 0;
  v_rarity_bonus integer := 0;
  v_repeats integer := 0;
begin
  if auth.uid() is null then raise exception 'Sign in to submit an answer'; end if;
  if length(trim(coalesce(p_answer, ''))) = 0 or length(p_answer) > 160 then
    raise exception 'Enter an answer up to 160 characters';
  end if;
  select * into v_run from public.daily_runs
    where id = p_run_id and user_id = auth.uid() for update;
  if not found then raise exception 'Dive not found'; end if;
  if p_question_index < 0 or p_question_index > 6 then raise exception 'Question not found'; end if;
  if exists (select 1 from public.daily_answers where run_id = p_run_id and question_index = p_question_index and is_scored) then
    return jsonb_build_object('points', 0, 'total_score', v_run.score, 'closeness', 0, 'rarity_bonus', 0, 'already_answered', true);
  end if;
  select * into v_question from public.daily_questions where question_index = p_question_index;
  v_normalized := lower(regexp_replace(trim(p_answer), '\s+', ' ', 'g'));
  select coalesce(max(extensions.similarity(v_normalized, lower(regexp_replace(trim(a), '\s+', ' ', 'g')))), 0)
    into v_closeness from unnest(v_question.accepted_answers) a;
  select count(*) into v_repeats from public.daily_answers a
    join public.daily_runs r on r.id = a.run_id
    where a.question_index = p_question_index and r.run_date = v_run.run_date
      and lower(regexp_replace(trim(a.answer), '\s+', ' ', 'g')) = v_normalized;
  v_rarity_bonus := round(greatest(0, 40 - (v_repeats * 10)) * v_closeness)::integer;
  v_points := 10 + round(v_closeness * 90)::integer + v_rarity_bonus;
  insert into public.daily_answers (run_id, question_index, answer, is_scored, points, closeness, rarity_bonus)
    values (p_run_id, p_question_index, trim(p_answer), true, v_points, v_closeness, v_rarity_bonus);
  update public.daily_runs set score = score + v_points,
    answered_count = answered_count + 1
    where id = p_run_id returning * into v_run;
  return jsonb_build_object('points', v_points, 'total_score', v_run.score,
    'closeness', v_closeness, 'rarity_bonus', v_rarity_bonus, 'already_answered', false);
end;
$$;

revoke all on function public.start_daily_run(date) from public, anon;
revoke all on function public.submit_daily_answer(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.start_daily_run(date) to authenticated;

create or replace function public.submit_daily_answer_ai(
  p_user_id uuid,
  p_run_id uuid,
  p_question_index integer,
  p_answer text,
  p_closeness real
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_run public.daily_runs%rowtype;
  v_normalized text;
  v_points integer := 0;
  v_rarity_bonus integer := 0;
  v_repeats integer := 0;
begin
  if p_user_id is null then raise exception 'Player not found'; end if;
  if length(trim(coalesce(p_answer, ''))) = 0 or length(p_answer) > 160 then
    raise exception 'Enter an answer up to 160 characters';
  end if;
  if p_closeness is null or p_closeness < 0 or p_closeness > 1 then
    raise exception 'Gemini returned an invalid score';
  end if;
  if p_question_index is null or p_question_index < 0 or p_question_index > 6 then
    raise exception 'Question not found';
  end if;

  select * into v_run from public.daily_runs
    where id = p_run_id and user_id = p_user_id for update;
  if not found then raise exception 'Dive not found'; end if;

  if exists (select 1 from public.daily_answers
      where run_id = p_run_id and question_index = p_question_index and is_scored) then
    return jsonb_build_object('points', 0, 'total_score', v_run.score,
      'closeness', 0, 'rarity_bonus', 0, 'already_answered', true);
  end if;

  if not exists (select 1 from public.daily_questions where question_index = p_question_index) then
    raise exception 'Question not found';
  end if;

  v_normalized := lower(regexp_replace(trim(p_answer), '\s+', ' ', 'g'));
  select count(*) into v_repeats from public.daily_answers a
    join public.daily_runs r on r.id = a.run_id
    where a.question_index = p_question_index and r.run_date = v_run.run_date
      and lower(regexp_replace(trim(a.answer), '\s+', ' ', 'g')) = v_normalized;

  v_rarity_bonus := round(greatest(0, 40 - (v_repeats * 10)) * p_closeness)::integer;
  v_points := 10 + round(p_closeness * 90)::integer + v_rarity_bonus;
  insert into public.daily_answers (run_id, question_index, answer, is_scored, points, closeness, rarity_bonus)
    values (p_run_id, p_question_index, trim(p_answer), true, v_points, p_closeness, v_rarity_bonus);
  update public.daily_runs set score = score + v_points,
    answered_count = answered_count + 1
    where id = p_run_id returning * into v_run;
  return jsonb_build_object('points', v_points, 'total_score', v_run.score,
    'closeness', p_closeness, 'rarity_bonus', v_rarity_bonus, 'already_answered', false);
end;
$$;

revoke all on function public.submit_daily_answer_ai(uuid, uuid, integer, text, real) from public, anon, authenticated;
grant execute on function public.submit_daily_answer_ai(uuid, uuid, integer, text, real) to service_role;

-- Battle lobbies are created and joined through RPCs so room membership is checked server-side.
create table if not exists public.battle_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  room_title text not null default 'Open lobby',
  host_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'active')),
  created_at timestamptz not null default now()
);
create table if not exists public.battle_players (
  room_id uuid not null references public.battle_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
alter table public.battle_rooms enable row level security;
alter table public.battle_players enable row level security;
revoke all on public.battle_rooms, public.battle_players from anon, authenticated;
grant select on public.battle_rooms, public.battle_players to authenticated;
create or replace function public.is_battle_player(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from public.battle_players where room_id = p_room_id and user_id = auth.uid());
$$;
revoke all on function public.is_battle_player(uuid) from public, anon;
grant execute on function public.is_battle_player(uuid) to authenticated;
drop policy if exists "Room members can view their lobby" on public.battle_rooms;
create policy "Room members can view their lobby" on public.battle_rooms
  for select to authenticated using (public.is_battle_player(id));
drop policy if exists "Room members can view players" on public.battle_players;
create policy "Room members can view players" on public.battle_players
  for select to authenticated using (public.is_battle_player(room_id));

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
    'players', coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'display_name', p.display_name,
      'is_host', p.user_id = v_room.host_user_id) order by p.joined_at), '[]'::jsonb)
  ) into v_result from public.battle_players p where p.room_id = v_room.id;
  return v_result;
end $$;

create or replace function public.create_battle_room(p_display_name text, p_title text default 'Open lobby')
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_code text; v_room_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to create a room'; end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 24 then raise exception 'Nickname must be 1–24 characters'; end if;
  loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 6));
    begin
      insert into public.battle_rooms (code, room_title, host_user_id)
        values (v_code, left(coalesce(nullif(trim(p_title), ''), 'Open lobby'), 48), auth.uid()) returning id into v_room_id;
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
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 24 then raise exception 'Nickname must be 1–24 characters'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room code not found'; end if;
  if v_room.status <> 'waiting' then raise exception 'This room has already started'; end if;
  select count(*) into v_count from public.battle_players where room_id = v_room.id;
  if v_count >= 50 and not exists (select 1 from public.battle_players where room_id = v_room.id and user_id = auth.uid()) then raise exception 'This room is full (50 players maximum)'; end if;
  insert into public.battle_players (room_id, user_id, display_name) values (v_room.id, auth.uid(), trim(p_display_name))
    on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return public.get_battle_room(v_room.code);
end $$;

create or replace function public.start_battle_room(p_code text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_room public.battle_rooms%rowtype; v_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to start a room'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found or v_room.host_user_id <> auth.uid() then raise exception 'Only the host can start this room'; end if;
  select count(*) into v_count from public.battle_players where room_id = v_room.id;
  if v_count < 2 then raise exception 'Invite one more player to start'; end if;
  update public.battle_rooms set status = 'active' where id = v_room.id and status = 'waiting';
end $$;

revoke all on function public.get_battle_room(text) from public, anon;
revoke all on function public.create_battle_room(text, text) from public, anon;
revoke all on function public.join_battle_room(text, text) from public, anon;
revoke all on function public.start_battle_room(text) from public, anon;
grant execute on function public.get_battle_room(text) to authenticated;
grant execute on function public.create_battle_room(text, text) to authenticated;
grant execute on function public.join_battle_room(text, text) to authenticated;
grant execute on function public.start_battle_room(text) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'battle_rooms') then
      alter publication supabase_realtime add table public.battle_rooms;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'battle_players') then
      alter publication supabase_realtime add table public.battle_players;
    end if;
  end if;
end $$;
