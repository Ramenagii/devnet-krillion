-- Run after setup.sql. Creates date-specific, shared Gemini question sets.

create table if not exists public.daily_question_sets (
  question_date date not null,
  question_index integer not null check (question_index between 0 and 6),
  topic text not null check (char_length(topic) between 1 and 36),
  prompt text not null check (char_length(prompt) between 12 and 160),
  concept text not null check (char_length(concept) between 1 and 80),
  accepted_answers text[] not null check (cardinality(accepted_answers) between 1 and 20),
  hint text not null check (char_length(hint) between 1 and 120),
  generated_at timestamptz not null default now(),
  model text not null default 'gemini-3.8-flash',
  primary key (question_date, question_index)
);

alter table public.daily_question_sets enable row level security;
revoke all on public.daily_question_sets from public, anon, authenticated;
grant all on public.daily_question_sets to service_role;

-- Keep the current daily set playable immediately while Gemini generates tomorrow's.
insert into public.daily_question_sets
  (question_date, question_index, topic, prompt, concept, accepted_answers, hint, model)
select
  (now() at time zone 'Asia/Manila')::date,
  q.question_index,
  q.topic,
  q.prompt,
  q.accepted_answers[1],
  q.accepted_answers,
  q.hint,
  'seeded'
from public.daily_questions q
on conflict (question_date, question_index) do nothing;

create or replace function public.get_daily_question_set(p_question_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_questions jsonb;
  v_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to load today’s questions'; end if;
  if p_question_date is null then raise exception 'Question date is required'; end if;

  select count(*), jsonb_agg(jsonb_build_object(
      'question_index', question_index,
      'topic', topic,
      'prompt', prompt,
      'hint', hint
    ) order by question_index)
    into v_count, v_questions
    from public.daily_question_sets
    where question_date = p_question_date;

  if v_count <> 7 then raise exception 'Today’s questions are still being prepared'; end if;
  return jsonb_build_object('question_date', p_question_date, 'questions', v_questions);
end;
$$;

revoke all on function public.get_daily_question_set(date) from public, anon;
grant execute on function public.get_daily_question_set(date) to authenticated;

alter table public.battle_rooms
  add column if not exists question_date date not null default ((now() at time zone 'Asia/Manila')::date);
