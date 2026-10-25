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
3. Run [`supabase/gemini_scoring.sql`](supabase/gemini_scoring.sql) in the SQL Editor.
4. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
5. Add `GEMINI_API_KEY` to Supabase **Edge Functions → Secrets**. For local function development, use `supabase/functions/.env`.
6. Sign in to the Supabase CLI and deploy the scoring function:

   ```sh
   npx supabase login
   npx supabase functions deploy score-answer --project-ref hhsvuzjxabijhssxfubi
   ```

The browser uses only the Supabase publishable key. Keep Gemini and Supabase secret keys in server-side secrets; never add them to `VITE_` variables. Environment files are excluded by `.gitignore`.

## Game scoring

Every answer is accepted. Gemini rates how closely the answer relates to the intended technology concept; Supabase adds a rarity bonus for less common responses and stores the score.

## Scripts

- `npm run dev` — start the local Vite server
- `npm run build` — type-check and build for production
- `npm run preview` — serve the production build locally
