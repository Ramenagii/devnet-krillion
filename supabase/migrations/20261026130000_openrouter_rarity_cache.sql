alter table public.answer_rarity_cache drop constraint if exists answer_rarity_cache_source_check;
alter table public.answer_rarity_cache add constraint answer_rarity_cache_source_check
  check (source in ('catalog', 'frequency', 'openrouter'));

create or replace function public.resolve_answer_rarity(p_answer text, p_closeness real)
returns table(rarity_score integer, rarity_tier text)
language plpgsql security definer set search_path = public, auth
as $$
declare v_key text; v_score integer; v_source text;
begin
  v_key := public.normalize_tech_answer(p_answer);
  if v_key = '' then return query select 1, 'common'::text; return; end if;
  if coalesce(p_closeness, 0) < 0.12 then return query select 1, 'common'::text; return; end if;

  -- A stored OpenRouter classification is authoritative and shared across future days.
  select c.rarity_score into v_score from public.answer_rarity_cache c
    where c.normalized_answer = v_key and c.source = 'openrouter';
  if found then return query select v_score, public.answer_rarity_tier(v_score); return; end if;

  select c.rarity_score into v_score from public.tech_rarity_catalog c where c.normalized_answer = v_key;
  if found then
    v_source := 'catalog';
  else
    insert into public.answer_rarity_cache as cached
      (normalized_answer, rarity_score, rarity_tier, source, seen_count, updated_at)
    values (v_key, 76, public.answer_rarity_tier(76), 'frequency', 1, now())
    on conflict (normalized_answer) do update set
      seen_count = cached.seen_count + 1,
      rarity_score = greatest(8, least(76, 76 - ((cached.seen_count / 3) * 5))),
      rarity_tier = public.answer_rarity_tier(greatest(8, least(76, 76 - ((cached.seen_count / 3) * 5)))),
      updated_at = now()
    returning cached.rarity_score, cached.source into v_score, v_source;
    return query select v_score, public.answer_rarity_tier(v_score); return;
  end if;

  insert into public.answer_rarity_cache as cached
    (normalized_answer, rarity_score, rarity_tier, source, seen_count, updated_at)
  values (v_key, v_score, public.answer_rarity_tier(v_score), v_source, 1, now())
  on conflict (normalized_answer) do update set
    rarity_score = excluded.rarity_score,
    rarity_tier = excluded.rarity_tier,
    source = excluded.source,
    seen_count = cached.seen_count + 1,
    updated_at = now();
  return query select v_score, public.answer_rarity_tier(v_score);
end;
$$;

revoke all on function public.resolve_answer_rarity(text, real) from public, anon, authenticated;
