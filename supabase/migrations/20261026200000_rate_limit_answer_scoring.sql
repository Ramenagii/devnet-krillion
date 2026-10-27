-- Bound authenticated scoring requests so a single account cannot fan out
-- unbounded rarity-provider calls. One row per account keeps this table small.
create table if not exists public.answer_scoring_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null check (request_count >= 1)
);

alter table public.answer_scoring_limits enable row level security;
revoke all on public.answer_scoring_limits from public, anon, authenticated;
grant all on public.answer_scoring_limits to service_role;

create or replace function public.consume_answer_scoring_limit(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
  v_window timestamptz := date_trunc('minute', statement_timestamp());
begin
  if p_user_id is null then return false; end if;

  insert into public.answer_scoring_limits as current_limit (user_id, window_start, request_count)
  values (p_user_id, v_window, 1)
  on conflict (user_id) do update set
    window_start = excluded.window_start,
    request_count = case
      when current_limit.window_start = excluded.window_start then current_limit.request_count + 1
      else 1
    end
  returning request_count into v_count;

  return v_count <= 8;
end;
$$;

revoke all on function public.consume_answer_scoring_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_answer_scoring_limit(uuid) to service_role;
