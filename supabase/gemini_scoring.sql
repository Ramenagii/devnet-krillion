-- Run in Supabase SQL Editor after setup.sql.
-- Gemini assigns answer rarity only; PostgreSQL checks concept closeness.

revoke all on function public.submit_daily_answer(uuid, integer, text) from public, anon, authenticated;
drop function if exists public.submit_daily_answer_ai(uuid, uuid, integer, text, real);
drop function if exists public.submit_daily_answer_ai(uuid, uuid, integer, text, text);
alter table public.daily_answers add column if not exists rarity_score integer not null default 1
  check (rarity_score between 1 and 100);
alter table public.daily_answers add column if not exists rarity_tier text not null default 'common'
  check (rarity_tier in ('common', 'uncommon', 'rare', 'epic', 'legendary'));

create or replace function public.submit_daily_answer_ai(
  p_user_id uuid,
  p_run_id uuid,
  p_question_index integer,
  p_answer text,
  p_rarity_score integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_run public.daily_runs%rowtype;
  v_question public.daily_question_sets%rowtype;
  v_normalized text;
  v_closeness real := 0;
  v_rarity_tier text;
  v_points integer := 0;
  v_rarity_bonus integer := 0;
begin
  if p_user_id is null then raise exception 'Player not found'; end if;
  if length(trim(coalesce(p_answer, ''))) = 0 or length(p_answer) > 160 then raise exception 'Enter an answer up to 160 characters'; end if;
  if p_rarity_score is null or p_rarity_score < 1 or p_rarity_score > 100 then raise exception 'Gemini returned an invalid rarity score'; end if;
  if p_question_index is null or p_question_index < 0 or p_question_index > 6 then raise exception 'Question not found'; end if;

  select * into v_run from public.daily_runs where id = p_run_id and user_id = p_user_id for update;
  if not found then raise exception 'Dive not found'; end if;
  v_rarity_tier := case
    when p_rarity_score >= 81 then 'legendary'
    when p_rarity_score >= 61 then 'epic'
    when p_rarity_score >= 41 then 'rare'
    when p_rarity_score >= 21 then 'uncommon'
    else 'common'
  end;
  if exists (select 1 from public.daily_answers where run_id = p_run_id and question_index = p_question_index and is_scored) then
    return jsonb_build_object('points', 0, 'total_score', v_run.score, 'closeness', 0,
      'rarity_bonus', 0, 'rarity_tier', v_rarity_tier, 'rarity_score', p_rarity_score, 'already_answered', true);
  end if;
  select * into v_question from public.daily_question_sets
    where question_date = v_run.run_date and question_index = p_question_index;
  if not found then raise exception 'Question not found'; end if;

  v_normalized := lower(regexp_replace(trim(p_answer), '\s+', ' ', 'g'));
  select coalesce(max(extensions.similarity(v_normalized, lower(regexp_replace(trim(a), '\s+', ' ', 'g')))), 0)
    into v_closeness from unnest(v_question.accepted_answers) a;
  v_points := round(p_rarity_score * v_closeness)::integer;
  v_rarity_bonus := v_points;

  insert into public.daily_answers (run_id, question_index, answer, is_scored, points, closeness, rarity_bonus, rarity_tier, rarity_score)
    values (p_run_id, p_question_index, trim(p_answer), true, v_points, v_closeness, v_rarity_bonus, v_rarity_tier, p_rarity_score);
  update public.daily_runs set score = score + v_points, answered_count = answered_count + 1
    where id = p_run_id returning * into v_run;
  return jsonb_build_object('points', v_points, 'total_score', v_run.score,
    'closeness', v_closeness, 'rarity_bonus', v_rarity_bonus, 'rarity_tier', v_rarity_tier,
    'rarity_score', p_rarity_score, 'already_answered', false);
end;
$$;

revoke all on function public.submit_daily_answer_ai(uuid, uuid, integer, text, integer) from public, anon, authenticated;
grant execute on function public.submit_daily_answer_ai(uuid, uuid, integer, text, integer) to service_role;
