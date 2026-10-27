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
type RequestBody = { roomCode?: unknown; questionIndex?: unknown; answer?: unknown }
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
  if (!authorization?.startsWith('Bearer ')) return json(request, 401, { error: 'Sign in to score a battle answer.' })
  if (!url || !key || !secretKey) return json(request, 503, { error: 'Battle scoring is not configured yet.' })

  const parsedBody = await readBoundedJson<RequestBody>(request)
  if (!parsedBody.ok) return parsedBody.reason === 'too_large'
    ? json(request, 413, { error: 'Request too large. Keep answers to 150 characters or fewer.' })
    : json(request, 400, { error: 'Invalid request.' })
  const body = parsedBody.value
  const roomCode = typeof body.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : ''
  const questionIndex = body.questionIndex
  const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
  if (!/^[A-Z0-9]{6,8}$/.test(roomCode) || !Number.isInteger(questionIndex) ||
      (questionIndex as number) < 0 || (questionIndex as number) > 6 || !answer) {
    return json(request, 400, { error: 'Check the room code and answer.' })
  }
  if (answer.length > 150) return json(request, 413, { error: 'Answers must be 150 characters or fewer.' })
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json(request, 401, { error: 'Sign in to score a battle answer.' })
  const { data: room, error: roomError } = await admin.from('battle_rooms')
    .select('id, status, question_date').eq('code', roomCode).maybeSingle()
  if (roomError || !room) return json(request, 404, { error: 'Battle room not found.' })
  if (room.status !== 'active') return json(request, 409, { error: 'The host has not started this battle yet.' })
  const { data: player, error: playerError } = await admin.from('battle_players')
    .select('user_id').eq('room_id', room.id).eq('user_id', user.id).maybeSingle()
  if (playerError || !player) return json(request, 403, { error: 'Join this room before playing.' })
  const { data: previous, error: previousError } = await admin.from('battle_answers')
    .select('id').eq('room_id', room.id).eq('user_id', user.id)
    .eq('question_index', questionIndex as number).maybeSingle()
  if (previousError) return json(request, 500, { error: 'Could not check your battle answer.' })
  if (previous) {
    const { data, error } = await supabase.rpc('score_battle_answer_cached', {
      p_code: roomCode, p_question_index: questionIndex as number, p_answer: answer,
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
    .eq('question_date', room.question_date).eq('question_index', questionIndex as number).maybeSingle()
  // Rarity and semantic fit are distinct model judgments. If the provider is
  // unavailable, the database keeps its deterministic alias-similarity fallback.
  if (question) await getOpenRouterQuestionAssessment(admin, room.question_date, questionIndex as number, answer, question.prompt, question.topic)
  else await getOpenRouterRarity(admin, answer)
  const { data, error } = await supabase.rpc('score_battle_answer_cached', {
    p_code: roomCode, p_question_index: questionIndex as number, p_answer: answer,
  })
  if (error) {
    console.error('Cached battle scoring failed:', error.message)
    return json(request, 400, { error: error.message || 'Could not score this answer.' })
  }
  return json(request, 200, data as Record<string, unknown>)
})
