import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
type RequestBody = { roomCode?: unknown; questionIndex?: unknown; answer?: unknown }
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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const authorization = request.headers.get('Authorization')
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = getPublishableKey()
  if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'Sign in to score a battle answer.' })
  if (!url || !key) return json(503, { error: 'Battle scoring is not configured yet.' })

  let body: RequestBody
  try { body = await request.json() as RequestBody } catch { return json(400, { error: 'Invalid request.' }) }
  const roomCode = typeof body.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : ''
  const questionIndex = body.questionIndex
  const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
  if (!/^[A-Z0-9]{6,8}$/.test(roomCode) || !Number.isInteger(questionIndex) ||
      (questionIndex as number) < 0 || (questionIndex as number) > 6 || !answer || answer.length > 160) {
    return json(400, { error: 'Check the room code and answer.' })
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json(401, { error: 'Sign in to score a battle answer.' })
  const { data, error } = await supabase.rpc('score_battle_answer_cached', {
    p_code: roomCode, p_question_index: questionIndex as number, p_answer: answer,
  })
  if (error) {
    console.error('Cached battle scoring failed:', error.message)
    return json(400, { error: error.message || 'Could not score this answer.' })
  }
  return json(200, data as Record<string, unknown>)
})
