-- Keep oversized direct RPC submissions from bypassing the scoring endpoints.
-- NOT VALID avoids scanning old rows while enforcing the rule on all new writes.
alter table public.daily_answers
  add constraint daily_answers_answer_max_150 check (char_length(answer) <= 150) not valid;

alter table public.battle_answers
  add constraint battle_answers_answer_max_150 check (char_length(answer) <= 150) not valid;
