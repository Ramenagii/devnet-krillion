-- Run after deploying generate-daily-questions and creating the Vault token.
-- The token name must be daily_question_cron_token.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

select cron.unschedule(jobid)
from cron.job
where jobname = 'generate-daily-tech-questions';

select cron.schedule(
  'generate-daily-tech-questions',
  '5 * * * *',
  $job$
    select net.http_post(
      url := 'https://hhsvuzjxabijhssxfubi.supabase.co/functions/v1/generate-daily-questions',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'daily_question_cron_token')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);
