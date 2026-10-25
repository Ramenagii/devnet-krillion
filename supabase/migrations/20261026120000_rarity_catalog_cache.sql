create table if not exists public.tech_rarity_catalog (
  normalized_answer text primary key,
  canonical_term text not null,
  rarity_score integer not null check (rarity_score between 1 and 100),
  created_at timestamptz not null default now()
);

create table if not exists public.answer_rarity_cache (
  normalized_answer text primary key,
  rarity_score integer not null check (rarity_score between 1 and 100),
  rarity_tier text not null check (rarity_tier in ('common','uncommon','rare','epic','legendary')),
  source text not null check (source in ('catalog','frequency')),
  seen_count integer not null default 1 check (seen_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.tech_rarity_catalog enable row level security;
alter table public.answer_rarity_cache enable row level security;
revoke all on public.tech_rarity_catalog, public.answer_rarity_cache from public, anon, authenticated;
grant all on public.tech_rarity_catalog, public.answer_rarity_cache to service_role;

insert into public.tech_rarity_catalog (normalized_answer, canonical_term, rarity_score) values
('wifi','Wi-Fi',5), ('wi fi','Wi-Fi',5), ('browser','Web browser',5), ('ram','RAM',6), ('memory','Computer memory',6),
('gpu','GPU',8), ('graphics card','GPU',8), ('cpu','CPU',8), ('password','Password',8), ('app','Application',8),
('dns','DNS',25), ('domain name system','DNS',25), ('cache','Cache',22), ('api','API',23), ('vpn','VPN',26),
('firewall','Firewall',27), ('encryption','Encryption',30), ('database','Database',20), ('linux','Linux',24),
('cdn','Content delivery network',42), ('container','Software container',43), ('kernel','Operating system kernel',46),
('kubernetes','Kubernetes',66), ('k8s','Kubernetes',66), ('bgp','Border Gateway Protocol',68),
('webassembly','WebAssembly',64), ('wasm','WebAssembly',64), ('ebpf','eBPF',77), ('merkle tree','Merkle tree',72),
('rpki','Resource Public Key Infrastructure',82), ('zk snark','zk-SNARK',88), ('zksnark','zk-SNARK',88),
('dane','DNS-based Authentication of Named Entities',80), ('quic','QUIC protocol',61), ('spiffe','SPIFFE',79),
('wasm component model','WebAssembly Component Model',84), ('confidential computing','Confidential computing',58),
('homomorphic encryption','Homomorphic encryption',86), ('raft consensus','Raft consensus',63), ('vector clock','Vector clock',60)
on conflict (normalized_answer) do update set canonical_term = excluded.canonical_term, rarity_score = excluded.rarity_score;

create or replace function public.normalize_tech_answer(p_answer text)
returns text language sql immutable parallel safe
set search_path = public
as $$
  select trim(regexp_replace(lower(regexp_replace(coalesce(p_answer, ''), '[^[:alnum:]#+.]+', ' ', 'g')), '\s+', ' ', 'g'))
$$;

create or replace function public.answer_rarity_tier(p_score integer)
returns text language sql immutable parallel safe
as $$ select case when p_score >= 81 then 'legendary' when p_score >= 61 then 'epic' when p_score >= 41 then 'rare' when p_score >= 21 then 'uncommon' else 'common' end $$;

create or replace function public.resolve_answer_rarity(p_answer text, p_closeness real)
returns table(rarity_score integer, rarity_tier text)
language plpgsql security definer set search_path = public, auth
as $$
declare v_key text; v_score integer; v_source text; v_seen integer;
begin
  v_key := public.normalize_tech_answer(p_answer);
  if v_key = '' then return query select 1, 'common'::text; return; end if;
  -- Answers far from the reference concept receive no rarity bonus and cannot inflate the cache.
  if coalesce(p_closeness, 0) < 0.12 then return query select 1, 'common'::text; return; end if;

  select c.rarity_score into v_score from public.tech_rarity_catalog c where c.normalized_answer = v_key;
  if found then
    v_source := 'catalog';
  else
    -- Novel terms start rare and move toward common as the shared cache sees them repeatedly.
    insert into public.answer_rarity_cache as cached (normalized_answer, rarity_score, rarity_tier, source, seen_count, updated_at)
    values (v_key, 76, public.answer_rarity_tier(76), 'frequency', 1, now())
    on conflict (normalized_answer) do update set
      seen_count = cached.seen_count + 1,
      rarity_score = greatest(8, least(76, 76 - ((cached.seen_count / 3) * 5))),
      rarity_tier = public.answer_rarity_tier(greatest(8, least(76, 76 - ((cached.seen_count / 3) * 5)))),
      updated_at = now()
    returning answer_rarity_cache.rarity_score, answer_rarity_cache.source, answer_rarity_cache.seen_count
      into v_score, v_source, v_seen;
    return query select v_score, public.answer_rarity_tier(v_score); return;
  end if;

  insert into public.answer_rarity_cache as cached (normalized_answer, rarity_score, rarity_tier, source, seen_count, updated_at)
  values (v_key, v_score, public.answer_rarity_tier(v_score), v_source, 1, now())
  on conflict (normalized_answer) do update set
    rarity_score = excluded.rarity_score, rarity_tier = excluded.rarity_tier,
    source = excluded.source, seen_count = cached.seen_count + 1, updated_at = now();
  return query select v_score, public.answer_rarity_tier(v_score);
end;
$$;

create or replace function public.score_daily_answer_cached(p_run_id uuid, p_question_index integer, p_answer text)
returns jsonb language plpgsql security definer set search_path = public, auth, extensions
as $$
declare v_run public.daily_runs%rowtype; v_question public.daily_question_sets%rowtype;
  v_key text; v_close real; v_rarity integer; v_tier text; v_bonus integer; v_points integer;
begin
  if auth.uid() is null then raise exception 'Sign in to score an answer'; end if;
  if p_answer is null or length(trim(p_answer)) = 0 or length(p_answer) > 160 then raise exception 'Enter an answer up to 160 characters'; end if;
  if p_question_index is null or p_question_index not between 0 and 6 then raise exception 'Question not found'; end if;
  select * into v_run from public.daily_runs where id = p_run_id and user_id = auth.uid() for update;
  if not found then raise exception 'Dive not found'; end if;
  if exists (select 1 from public.daily_answers where run_id = p_run_id and question_index = p_question_index and is_scored) then
    return jsonb_build_object('points',0,'total_score',v_run.score,'closeness',0,'rarity_bonus',0,'already_answered',true);
  end if;
  select * into v_question from public.daily_question_sets where question_date = v_run.run_date and question_index = p_question_index;
  if not found then raise exception 'Question not found'; end if;
  v_key := public.normalize_tech_answer(p_answer);
  select coalesce(max(extensions.similarity(v_key, public.normalize_tech_answer(a))),0) into v_close from unnest(v_question.accepted_answers) a;
  select r.rarity_score, r.rarity_tier into v_rarity, v_tier from public.resolve_answer_rarity(p_answer, v_close) r;
  v_bonus := case v_tier when 'uncommon' then 25 when 'rare' then 50 when 'epic' then 100 when 'legendary' then 200 else 10 end;
  v_points := 10 + round(v_close * 90)::integer + round(v_bonus * v_close)::integer;
  insert into public.daily_answers (run_id,question_index,answer,is_scored,points,closeness,rarity_bonus,rarity_tier,rarity_score)
    values (p_run_id,p_question_index,trim(p_answer),true,v_points,v_close,round(v_bonus*v_close)::integer,v_tier,v_rarity);
  update public.daily_runs set score = score + v_points, answered_count = answered_count + 1 where id = p_run_id returning * into v_run;
  return jsonb_build_object('points',v_points,'total_score',v_run.score,'closeness',v_close,'rarity_bonus',round(v_bonus*v_close)::integer,'rarity_tier',v_tier,'rarity_score',v_rarity,'already_answered',false);
end;
$$;

create or replace function public.score_battle_answer_cached(p_code text, p_question_index integer, p_answer text)
returns jsonb language plpgsql security definer set search_path = public, auth, extensions
as $$
declare v_room public.battle_rooms%rowtype; v_player public.battle_players%rowtype; v_question public.daily_question_sets%rowtype;
  v_key text; v_close real; v_rarity integer; v_tier text; v_bonus integer; v_points integer;
begin
  if auth.uid() is null then raise exception 'Sign in to score a battle answer'; end if;
  if p_answer is null or length(trim(p_answer)) = 0 or length(p_answer) > 160 then raise exception 'Enter an answer up to 160 characters'; end if;
  if p_question_index is null or p_question_index not between 0 and 6 then raise exception 'Question not found'; end if;
  select * into v_room from public.battle_rooms where code = upper(trim(p_code)) for update;
  if not found or v_room.status <> 'active' then raise exception 'This battle is not active'; end if;
  select * into v_player from public.battle_players where room_id = v_room.id and user_id = auth.uid() for update;
  if not found then raise exception 'Join this room before playing'; end if;
  if exists (select 1 from public.battle_answers where room_id = v_room.id and user_id = auth.uid() and question_index = p_question_index) then
    return jsonb_build_object('points',0,'total_score',v_player.score,'closeness',0,'rarity_bonus',0,'already_answered',true);
  end if;
  select * into v_question from public.daily_question_sets where question_date = v_room.question_date and question_index = p_question_index;
  if not found then raise exception 'Question not found'; end if;
  v_key := public.normalize_tech_answer(p_answer);
  select coalesce(max(extensions.similarity(v_key, public.normalize_tech_answer(a))),0) into v_close from unnest(v_question.accepted_answers) a;
  select r.rarity_score, r.rarity_tier into v_rarity, v_tier from public.resolve_answer_rarity(p_answer, v_close) r;
  v_bonus := case v_tier when 'uncommon' then 25 when 'rare' then 50 when 'epic' then 100 when 'legendary' then 200 else 10 end;
  v_points := 10 + round(v_close * 90)::integer + round(v_bonus * v_close)::integer;
  insert into public.battle_answers (room_id,user_id,question_index,answer,points,closeness,rarity_bonus,rarity_tier,rarity_score)
    values (v_room.id,auth.uid(),p_question_index,trim(p_answer),v_points,v_close,round(v_bonus*v_close)::integer,v_tier,v_rarity);
  update public.battle_players set score = score + v_points, answered_count = answered_count + 1
    where room_id = v_room.id and user_id = auth.uid() returning * into v_player;
  return jsonb_build_object('points',v_points,'total_score',v_player.score,'closeness',v_close,'rarity_bonus',round(v_bonus*v_close)::integer,'rarity_tier',v_tier,'rarity_score',v_rarity,'already_answered',false);
end;
$$;

revoke all on function public.normalize_tech_answer(text) from public, anon, authenticated;
revoke all on function public.answer_rarity_tier(integer) from public, anon, authenticated;
revoke all on function public.resolve_answer_rarity(text, real) from public, anon, authenticated;
revoke all on function public.score_daily_answer_cached(uuid, integer, text) from public, anon;
revoke all on function public.score_battle_answer_cached(text, integer, text) from public, anon;
grant execute on function public.score_daily_answer_cached(uuid, integer, text) to authenticated;
grant execute on function public.score_battle_answer_cached(text, integer, text) to authenticated;
