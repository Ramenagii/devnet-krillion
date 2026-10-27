import { createClient } from 'npm:@supabase/supabase-js@2'
import { readBoundedJson } from '../_shared/bounded-json.ts'
import { getOpenRouterQuestionAssessment, getOpenRouterRarity } from '../_shared/openrouter-rarity.ts'

const allowedOrigins = new Set(['https://devnet-krillion.vercel.app', 'http://localhost:5173', 'http://127.0.0.1:5173'])
function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://devnet-krillion.vercel.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}
type RequestBody = { runId?: unknown; questionIndex?: unknown; answer?: unknown }
function json(request: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } })
}
function getPublishableKey() {
  const value = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (value) {
    try { const keys = JSON.parse(value) as Record<string, string>; if (keys.default) return keys.default } catch { /* Legacy secret fallback. */ }
  }
  return Deno.env.get('SUPABASE_ANON_KEY') ?? ''
}
function getSecretKey() {
  const value = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (value) {
    try { const keys = JSON.parse(value) as Record<string, string>; if (keys.default) return keys.default } catch { /* Legacy secret fallback. */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, 405, { error: 'Method not allowed' })
  const authorization = request.headers.get('Authorization')
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = getPublishableKey()
  const secretKey = getSecretKey()
  if (!authorization?.startsWith('Bearer ')) return json(request, 401, { error: 'Sign in to score an answer.' })
  if (!url || !key || !secretKey) return json(request, 503, { error: 'Answer scoring is not configured yet.' })

  const parsedBody = await readBoundedJson<RequestBody>(request)
  if (!parsedBody.ok) return parsedBody.reason === 'too_large'
    ? json(request, 413, { error: 'Request too large. Keep answers to 150 characters or fewer.' })
    : json(request, 400, { error: 'Invalid request.' })
  const body = parsedBody.value
  const runId = typeof body.runId === 'string' ? body.runId : ''
  const questionIndex = body.questionIndex
  const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
      !Number.isInteger(questionIndex) || (questionIndex as number) < 0 || (questionIndex as number) > 6 || !answer) {
    return json(request, 400, { error: 'Check the answer and try again.' })
  }
  if (answer.length > 150) return json(request, 413, { error: 'Answers must be 150 characters or fewer.' })
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json(request, 401, { error: 'Sign in to score an answer.' })
  const { data: run, error: runError } = await admin.from('daily_runs')
    .select('id, run_date').eq('id', runId).eq('user_id', user.id).maybeSingle()
  if (runError || !run) return json(request, 404, { error: 'Dive not found.' })
  const { data: previous, error: previousError } = await admin.from('daily_answers')
    .select('id').eq('run_id', runId).eq('question_index', questionIndex as number).eq('is_scored', true).maybeSingle()
  if (previousError) return json(request, 500, { error: 'Could not check this answer.' })
  if (previous) {
    const { data, error } = await supabase.rpc('score_daily_answer_cached', {
      p_run_id: runId, p_question_index: questionIndex as number, p_answer: answer,
    })
    if (error) return json(request, 400, { error: error.message || 'Could not score this answer.' })
    return json(request, 200, data as Record<string, unknown>)
  }
  const { data: withinRateLimit, error: rateLimitError } = await admin.rpc('consume_answer_scoring_limit', { p_user_id: user.id })
  if (rateLimitError) {
    console.error('Could not check answer scoring rate limit:', rateLimitError.message)
    return json(request, 503, { error: 'Scoring is temporarily unavailable. Try again shortly.' })
  }
  if (!withinRateLimit) return json(request, 429, { error: 'You’re sending answers too quickly. Try again in a minute.' })
  const { data: question } = await admin.from('daily_question_sets').select('prompt, topic')
    .eq('question_date', run.run_date).eq('question_index', questionIndex as number).maybeSingle()
  // Rarity and semantic fit are distinct model judgments. If the provider is
  // unavailable, the database keeps its deterministic alias-similarity fallback.
  if (question) await getOpenRouterQuestionAssessment(admin, run.run_date, questionIndex as number, answer, question.prompt, question.topic)
  else await getOpenRouterRarity(admin, answer)
  const { data, error } = await supabase.rpc('score_daily_answer_cached', {
    p_run_id: runId, p_question_index: questionIndex as number, p_answer: answer,
  })
  if (error) {
    console.error('Cached daily scoring failed:', error.message)
    return json(request, 400, { error: error.message || 'Could not score this answer.' })
  }
  return json(request, 200, data as Record<string, unknown>)
})
