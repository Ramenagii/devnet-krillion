-- Award points from the answer's rarity score, discounted by how relevant it
-- is to that question. Fully relevant answers earn 1-100 points; unrelated
-- answers earn no points regardless of rarity.
create or replace function public.score_daily_answer_cached(p_run_id uuid, p_question_index integer, p_answer text)
returns jsonb language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
  v_run public.daily_runs%rowtype;
  v_question public.daily_question_sets%rowtype;
  v_existing public.daily_answers%rowtype;
  v_key text;
  v_close real := 0;
  v_rarity integer;
  v_tier text;
  v_points integer;
begin
  if auth.uid() is null then raise exception 'Sign in to score an answer'; end if;
  if p_answer is null or length(trim(p_answer)) = 0 or length(p_answer) > 160 then raise exception 'Enter an answer up to 160 characters'; end if;
  if p_question_index is null or p_question_index not between 0 and 6 then raise exception 'Question not found'; end if;
  select * into v_run from public.daily_runs where id = p_run_id and user_id = auth.uid() for update;
  if not found then raise exception 'Dive not found'; end if;

  select * into v_existing from public.daily_answers
    where run_id = p_run_id and question_index = p_question_index and is_scored;
  if found then
    return jsonb_build_object('points',v_existing.points,'total_score',v_run.score,
      'closeness',v_existing.closeness,'rarity_bonus',v_existing.rarity_bonus,
      'rarity_tier',v_existing.rarity_tier,'rarity_score',v_existing.rarity_score,
      'already_answered',true);
  end if;

  select * into v_question from public.daily_question_sets
    where question_date = v_run.run_date and question_index = p_question_index;
  if not found then raise exception 'Question not found'; end if;
  v_key := public.normalize_tech_answer(p_answer);
  select coalesce(max(greatest(
      extensions.similarity(v_key, public.normalize_tech_answer(a)),
      extensions.similarity(replace(v_key, ' ', ''), replace(public.normalize_tech_answer(a), ' ', ''))
    )),0) into v_close from unnest(v_question.accepted_answers) a;
  select r.rarity_score, r.rarity_tier into v_rarity, v_tier
    from public.resolve_answer_rarity(p_answer, v_close) r;
  v_points := round(v_rarity * v_close)::integer;
  insert into public.daily_answers
    (run_id,question_index,answer,is_scored,points,closeness,rarity_bonus,rarity_tier,rarity_score)
    values (p_run_id,p_question_index,trim(p_answer),true,v_points,v_close,
      v_points,v_tier,v_rarity);
  update public.daily_runs set score = score + v_points, answered_count = answered_count + 1
    where id = p_run_id returning * into v_run;
  return jsonb_build_object('points',v_points,'total_score',v_run.score,'closeness',v_close,
    'rarity_bonus',v_points,'rarity_tier',v_tier,'rarity_score',v_rarity,'already_answered',false);
end;
$$;

create or replace function public.score_battle_answer_cached(p_code text, p_question_index integer, p_answer text)
returns jsonb language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
  v_room public.battle_rooms%rowtype;
  v_player public.battle_players%rowtype;
  v_question public.daily_question_sets%rowtype;
  v_existing public.battle_answers%rowtype;
  v_key text;
  v_close real := 0;
  v_rarity integer;
  v_tier text;
  v_points integer;
begin
  if auth.uid() is null then raise exception 'Sign in to score a battle answer'; end if;
  if p_answer is null or length(trim(p_answer)) = 0 or length(p_answer) > 160 then raise exception 'Enter an answer up to 160 characters'; end if;
  if p_question_index is null or p_question_index not between 0 and 6 then raise exception 'Question not found'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found or v_room.status <> 'active' then raise exception 'This battle is not active'; end if;
  select * into v_player from public.battle_players where room_id = v_room.id and user_id = auth.uid() for update;
  if not found then raise exception 'Join this room before playing'; end if;

  select * into v_existing from public.battle_answers
    where room_id = v_room.id and user_id = auth.uid() and question_index = p_question_index;
  if found then
    return jsonb_build_object('points',v_existing.points,'total_score',v_player.score,
      'closeness',v_existing.closeness,'rarity_bonus',v_existing.rarity_bonus,
      'rarity_tier',v_existing.rarity_tier,'rarity_score',v_existing.rarity_score,
      'already_answered',true);
  end if;

  select * into v_question from public.daily_question_sets
    where question_date = v_room.question_date and question_index = p_question_index;
  if not found then raise exception 'Question not found'; end if;
  v_key := public.normalize_tech_answer(p_answer);
  select coalesce(max(greatest(
      extensions.similarity(v_key, public.normalize_tech_answer(a)),
      extensions.similarity(replace(v_key, ' ', ''), replace(public.normalize_tech_answer(a), ' ', ''))
    )),0) into v_close from unnest(v_question.accepted_answers) a;
  select r.rarity_score, r.rarity_tier into v_rarity, v_tier
    from public.resolve_answer_rarity(p_answer, v_close) r;
  v_points := round(v_rarity * v_close)::integer;
  insert into public.battle_answers
    (room_id,user_id,question_index,answer,points,closeness,rarity_bonus,rarity_tier,rarity_score)
    values (v_room.id,auth.uid(),p_question_index,trim(p_answer),v_points,v_close,
      v_points,v_tier,v_rarity);
  update public.battle_players set score = score + v_points, answered_count = answered_count + 1
    where room_id = v_room.id and user_id = auth.uid() returning * into v_player;
  return jsonb_build_object('points',v_points,'total_score',v_player.score,'closeness',v_close,
    'rarity_bonus',v_points,'rarity_tier',v_tier,'rarity_score',v_rarity,'already_answered',false);
end;
$$;

revoke all on function public.score_daily_answer_cached(uuid, integer, text) from public, anon;
revoke all on function public.score_battle_answer_cached(text, integer, text) from public, anon;
grant execute on function public.score_daily_answer_cached(uuid, integer, text) to authenticated;
grant execute on function public.score_battle_answer_cached(text, integer, text) to authenticated;
