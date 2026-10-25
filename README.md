# DevNet Krillion

A galaxy-themed technology knowledge game with daily rounds and code-based battle lobbies.

## Stack

- Vite, React, and TypeScript
- Supabase Auth, Postgres, Realtime, and Edge Functions
- Gemini for semantic answer closeness scoring

## Run the app

```sh
npm install
npm run dev
```

## Supabase setup

1. Create a Supabase project and enable **Anonymous Sign-Ins** under Authentication.
2. Run [`supabase/setup.sql`](supabase/setup.sql) in the Supabase SQL Editor.
3. Run [`supabase/daily_question_generation.sql`](supabase/daily_question_generation.sql) to create the date-keyed question store and read RPC.
4. Run [`supabase/gemini_scoring.sql`](supabase/gemini_scoring.sql).
5. Run [`supabase/battle_leaderboard.sql`](supabase/battle_leaderboard.sql) to enable eight-character room codes and per-room scores.
6. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
7. Copy [`supabase/functions/.env.example`](supabase/functions/.env.example) to `supabase/functions/.env`, then add a valid Gemini API key for answer scoring, an OpenRouter API key for daily question generation, and a long random `DAILY_QUESTION_CRON_TOKEN`. Upload them with `npx supabase secrets set --env-file supabase/functions/.env --project-ref hhsvuzjxabijhssxfubi`. In Supabase SQL Editor, store the same cron token plus the publishable key in Vault:

   ```sql
   select vault.create_secret('YOUR_CRON_TOKEN', 'daily_question_cron_token', 'Scheduled question generator');
   select vault.create_secret('YOUR_PUBLISHABLE_KEY', 'daily_question_publishable_key', 'Public key for scheduled function calls');
   ```

   For local function development, keep those values in the ignored `supabase/functions/.env` file.
8. Sign in to the Supabase CLI and deploy the scoring and question-generation functions:

   ```sh
   npx supabase login
   npx supabase functions deploy score-answer --project-ref hhsvuzjxabijhssxfubi
   npx supabase functions deploy score-battle-answer --project-ref hhsvuzjxabijhssxfubi
   npx supabase functions deploy generate-daily-questions --project-ref hhsvuzjxabijhssxfubi
   ```

9. Run [`supabase/daily_question_schedule.sql`](supabase/daily_question_schedule.sql) to schedule generation and retry checks every hour. The function stores one shared set per Manila date; once a complete set exists, later runs skip OpenRouter. It keeps concepts from repeating within the previous three weeks.

The browser uses only the Supabase publishable key. Keep Gemini, OpenRouter, and Supabase secret keys in server-side secrets; never add them to `VITE_` variables. Environment files are excluded by `.gitignore`.

## Game scoring

Every answer is accepted. Supabase estimates concept closeness against the accepted-answer set. Gemini returns a separate rarity score from 1 to 100; thresholds map 1-20 to common, 21-40 to uncommon, 41-60 to rare, 61-80 to epic, and 81-100 to legendary. Supabase combines closeness and rarity for points; Gemini never marks an answer right or wrong. The reward points and rarity score are shown separately.

## Daily questions

OpenRouter's free-model router generates seven surface-level technology clues and answer aliases for the next missing Manila date. Supabase validates and stores the set once, then all players load the same prompts. Accepted aliases stay server-side for scoring. Generation runs from Supabase Cron through a protected Edge Function, with one OpenRouter call per new date and automatic hourly retries if a set is missing. Gemini remains in use for rarity scoring.

## Battle rooms

The host enters a display name and creates a room. Supabase generates an eight-character room code and adds the host to the lobby. Friends join with that code and their own display names. The host starts when at least two players are present. Battle answers save one score per player and question, and update the live lobby leaderboard.

## Scripts

- `npm run dev` — start the local Vite server
- `npm run build` — type-check and build for production
- `npm run preview` — serve the production build locally
