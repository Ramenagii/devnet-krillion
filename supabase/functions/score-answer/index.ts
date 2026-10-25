import { createClient } from 'npm:@supabase/supabase-js@2'
import { getOpenRouterRarity } from '../_shared/openrouter-rarity.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
type RequestBody = { runId?: unknown; questionIndex?: unknown; answer?: unknown }
function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
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
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const authorization = request.headers.get('Authorization')
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = getPublishableKey()
  const secretKey = getSecretKey()
  if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'Sign in to score an answer.' })
  if (!url || !key || !secretKey) return json(503, { error: 'Answer scoring is not configured yet.' })

  let body: RequestBody
  try { body = await request.json() as RequestBody } catch { return json(400, { error: 'Invalid request.' }) }
  const runId = typeof body.runId === 'string' ? body.runId : ''
  const questionIndex = body.questionIndex
  const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
      !Number.isInteger(questionIndex) || (questionIndex as number) < 0 || (questionIndex as number) > 6 || !answer || answer.length > 160) {
    return json(400, { error: 'Check the answer and try again.' })
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json(401, { error: 'Sign in to score an answer.' })
  const { data: run, error: runError } = await admin.from('daily_runs')
    .select('id').eq('id', runId).eq('user_id', user.id).maybeSingle()
  if (runError || !run) return json(404, { error: 'Dive not found.' })
  const { data: previous, error: previousError } = await admin.from('daily_answers')
    .select('id').eq('run_id', runId).eq('question_index', questionIndex as number).eq('is_scored', true).maybeSingle()
  if (previousError) return json(500, { error: 'Could not check this answer.' })
  if (previous) {
    const { data, error } = await supabase.rpc('score_daily_answer_cached', {
      p_run_id: runId, p_question_index: questionIndex as number, p_answer: answer,
    })
    if (error) return json(400, { error: error.message || 'Could not score this answer.' })
    return json(200, data as Record<string, unknown>)
  }
  // Classify uncached rarity with OpenRouter. Provider failures fall back to the DB scorer.
  await getOpenRouterRarity(admin, answer)
  const { data, error } = await supabase.rpc('score_daily_answer_cached', {
    p_run_id: runId, p_question_index: questionIndex as number, p_answer: answer,
  })
  if (error) {
    console.error('Cached daily scoring failed:', error.message)
    return json(400, { error: error.message || 'Could not score this answer.' })
  }
  return json(200, data as Record<string, unknown>)
})
