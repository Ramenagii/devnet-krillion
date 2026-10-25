-- Run in Supabase SQL Editor after setup.sql.
-- This moves answer scoring into the authenticated score-answer Edge Function.

revoke all on function public.submit_daily_answer(uuid, integer, text) from public, anon, authenticated;

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
