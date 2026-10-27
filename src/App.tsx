import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ArrowDown, ArrowRight, Check, Clock3, Copy, DoorOpen, Plus, Swords, Users } from 'lucide-react'

type Question = { prompt: string; topic: string; accepted?: string[]; hint?: string }
type Nav = 'Today' | 'Play' | 'Battle'
type RarityTier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
type Feedback = { kind: 'scored' | 'error'; text: string; rarityTier?: RarityTier; rarityScore?: number }
type BattleRoom = { id: string; code: string; title: string; status: 'waiting' | 'active'; host_user_id: string; is_host: boolean; players: { user_id: string; display_name: string; is_host: boolean; score: number; answered_count: number }[] }

const MAX_ANSWER_LENGTH = 150

const OFFLINE_QUESTIONS: Question[] = [
  { topic: 'Phones & computers', prompt: 'What keeps apps ready while you use your device?', accepted: ['ram', 'random access memory', 'memory', 'system memory', 'volatile memory', 'dram', 'sram', 'cache', 'registers'] },
  { topic: 'The web', prompt: 'What helps your browser find a website?', accepted: ['dns', 'domain name system', 'dns resolver', 'resolver', 'nameserver', 'name server', 'recursive dns', 'authoritative dns', 'hosts file'] },
  { topic: 'AI', prompt: 'What lets a computer learn from examples?', accepted: ['machine learning', 'ml', 'deep learning', 'neural network', 'neural nets', 'training data', 'learning algorithm', 'model training', 'supervised learning', 'reinforcement learning'] },
  { topic: 'Online safety', prompt: 'What adds an extra step when you sign in?', accepted: ['mfa', 'multi-factor authentication', '2fa', 'two-factor authentication', 'passkey', 'security key', 'fido2', 'webauthn', 'authenticator app', 'biometrics', 'one-time password', 'totp', 'hardware token'] },
  { topic: 'Phones', prompt: 'What helps a map app find where you are?', accepted: ['gps', 'global positioning system', 'gnss', 'assisted gps', 'a-gps', 'cell tower triangulation', 'wifi positioning', 'wi-fi positioning', 'location services', 'satellite navigation'] },
  { topic: 'Photos & files', prompt: 'What keeps your photos saved after your phone turns off?', accepted: ['ssd', 'solid state drive', 'hdd', 'hard drive', 'hard disk', 'flash memory', 'rom', 'sd card', 'non-volatile memory', 'nvme drive', 'usb drive', 'storage', 'internal storage', 'cloud storage'] },
  { topic: 'Games & graphics', prompt: 'What helps games draw detailed images?', accepted: ['gpu', 'graphics processing unit', 'graphics card', 'video card', 'rendering', 'rasterization', 'framebuffer', 'display controller', 'ray tracing'] },
]

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
const supabase: SupabaseClient | null = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null
const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

function tierForRarityScore(score: number): RarityTier {
  if (score >= 81) return 'legendary'
  if (score >= 61) return 'epic'
  if (score >= 41) return 'rare'
  if (score >= 21) return 'uncommon'
  return 'common'
}

function answerSimilarity(answer: string, benchmarks: string[]) {
  const grams = (value: string) => {
    const normalized = `  ${value.toLocaleLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()}  `
    return new Set(Array.from({ length: Math.max(0, normalized.length - 2) }, (_, index) => normalized.slice(index, index + 3)))
  }
  const answerGrams = grams(answer)
  return Math.max(0, ...benchmarks.map((benchmark) => {
    const benchmarkGrams = grams(benchmark)
    const overlap = [...answerGrams].filter((gram) => benchmarkGrams.has(gram)).length
    return answerGrams.size + benchmarkGrams.size ? (2 * overlap) / (answerGrams.size + benchmarkGrams.size) : 0
  }))
}

function App() {
  const [nav, setNav] = useState<Nav>('Today')
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [score, setScore] = useState(0)
  const [timeLeft, setTimeLeft] = useState(30)
  const questionDeadline = useRef(0)
  const [gameDone, setGameDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [dailyQuestions, setDailyQuestions] = useState<Question[]>(OFFLINE_QUESTIONS)
  const [questionSetState, setQuestionSetState] = useState<'loading' | 'ready' | 'error'>(supabase ? 'loading' : 'ready')
  const [cloudStatus, setCloudStatus] = useState(supabase ? 'Connecting…' : 'Offline')
  const [battleRoom, setBattleRoom] = useState<BattleRoom | null>(null)
  const [roomTitle, setRoomTitle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [battleBusy, setBattleBusy] = useState(false)
  const [battleMessage, setBattleMessage] = useState('')
  const [battleMode, setBattleMode] = useState<'create' | 'join'>('create')
  const inputRef = useRef<HTMLInputElement>(null)
  const current = dailyQuestions[questionIndex]
  const answerScored = feedback?.kind === 'scored'
  const progress = gameDone ? 100 : (questionIndex / dailyQuestions.length) * 100
  const answeredQuestions = gameDone ? dailyQuestions.length : questionIndex + (feedback?.kind === 'scored' ? 1 : 0)
  const rankedPlayers = useMemo(() => [...(battleRoom?.players ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.answered_count ?? 0) - (a.answered_count ?? 0)), [battleRoom?.players])
  const resetQuestionTimer = useCallback(() => {
    questionDeadline.current = Date.now() + 30_000
    setTimeLeft(30)
  }, [])

  useEffect(() => {
    if (!supabase) return
    let alive = true
    void (async () => {
      try {
        const { data: session } = await supabase.auth.getSession()
        if (!session.session) {
          const { error } = await supabase.auth.signInAnonymously()
          if (error) throw error
        }
        const { data: questionSet, error: questionError } = await supabase.rpc('get_daily_question_set', { p_question_date: todayKey })
        if (questionError) throw questionError
        const rows = (questionSet as { questions?: { question_index?: number; prompt?: string; topic?: string; hint?: string }[] } | null)?.questions
        if (!rows || rows.length !== 7 || rows.some((question, index) => question.question_index !== index || !question.prompt || !question.topic)) {
          throw new Error('The daily question set is incomplete.')
        }
        const { data, error } = await supabase.rpc('start_daily_run', { p_run_date: todayKey })
        if (error) throw error
        const activeRunId = typeof data === 'string' ? data : (data as { id?: string })?.id
        if (!activeRunId) throw new Error('Could not open today’s dive.')
        const [runResult, answersResult] = await Promise.all([
          supabase.from('daily_runs').select('score').eq('id', activeRunId).maybeSingle(),
          supabase.from('daily_answers').select('question_index').eq('run_id', activeRunId).eq('is_scored', true),
        ])
        if (runResult.error || answersResult.error) throw runResult.error ?? answersResult.error
        const completed = new Set((answersResult.data ?? []).map((row) => row.question_index))
        const nextQuestion = Array.from({ length: 7 }, (_, index) => index).find((index) => !completed.has(index)) ?? 7
        if (alive) {
          setDailyQuestions(rows.map((question) => ({ prompt: question.prompt!, topic: question.topic!, hint: question.hint })))
          setRunId(activeRunId)
          setScore(runResult.data?.score ?? 0)
          if (nextQuestion === 7) {
            setQuestionIndex(6)
            setGameDone(true)
          } else {
            setQuestionIndex(nextQuestion)
          }
          setCloudStatus('Synced')
          setQuestionSetState('ready')
        }
      } catch {
        if (alive) {
          setCloudStatus('Offline')
          setQuestionSetState('error')
        }
      }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!supabase || !battleRoom) return
    const refreshRoom = async () => {
      const { data, error } = await supabase.rpc('get_battle_room', { p_code: battleRoom.code })
      if (!error && data) setBattleRoom(data as BattleRoom)
    }
    const channel = supabase.channel(`battle-room-${battleRoom.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_players', filter: `room_id=eq.${battleRoom.id}` }, () => { void refreshRoom() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_rooms', filter: `id=eq.${battleRoom.id}` }, () => { void refreshRoom() })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [battleRoom?.id, battleRoom?.code])

  useEffect(() => {
    if (battleRoom?.status !== 'active') return
    setQuestionIndex(0)
    setAnswer('')
    setFeedback(null)
    setScore(0)
    resetQuestionTimer()
    setGameDone(false)
    setNav('Play')
  }, [battleRoom?.status, resetQuestionTimer])

  useEffect(() => {
    if (nav !== 'Play' || gameDone || answerScored) return
    let timer: number | undefined
    const syncTimer = () => {
      const remaining = Math.max(0, Math.ceil((questionDeadline.current - Date.now()) / 1000))
      setTimeLeft((value) => value === remaining ? value : remaining)
      if (remaining === 0) {
        if (timer !== undefined) window.clearInterval(timer)
        setFeedback((value) => value?.kind === 'scored' || value?.text === 'Time is up. Try an answer anyway.'
          ? value
          : { kind: 'error', text: 'Time is up. Try an answer anyway.' })
      }
    }
    timer = window.setInterval(syncTimer, 250)
    document.addEventListener('visibilitychange', syncTimer)
    window.addEventListener('focus', syncTimer)
    window.addEventListener('pageshow', syncTimer)
    syncTimer()
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', syncTimer)
      window.removeEventListener('focus', syncTimer)
      window.removeEventListener('pageshow', syncTimer)
    }
  }, [nav, questionIndex, gameDone, answerScored])

  useEffect(() => {
    if (nav !== 'Play') return
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [nav])

  const nextQuestion = useCallback(() => {
    if (questionIndex === dailyQuestions.length - 1) {
      setGameDone(true)
      setFeedback(null)
      return
    }
    setQuestionIndex((index) => index + 1)
    setAnswer('')
    setFeedback(null)
    resetQuestionTimer()
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [questionIndex, dailyQuestions.length, resetQuestionTimer])

  const submitAnswer = async (event: FormEvent) => {
    event.preventDefault()
    const cleaned = answer.trim()
    if (!cleaned || loading || gameDone) return
    if (cleaned.length > MAX_ANSWER_LENGTH) {
      setFeedback({ kind: 'error', text: `Keep your answer under ${MAX_ANSWER_LENGTH} characters.` })
      return
    }
    setLoading(true)
    const normalized = cleaned.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    let closeness = answerSimilarity(normalized, current.accepted ?? [])
    let rarityTier: RarityTier | undefined
    let rarityScore: number | undefined
    let points = 0
    let total = score

    if (supabase && battleRoom?.status === 'active') {
      const { data, error } = await supabase.functions.invoke('score-battle-answer', {
        body: { roomCode: battleRoom.code, questionIndex, answer: cleaned },
      })
      if (error) {
        setFeedback({ kind: 'error', text: 'Battle scoring failed. Try again.' })
        setLoading(false)
        return
      }
      const result = data as { points?: number; total_score?: number; closeness?: number; rarity_bonus?: number; rarity_tier?: RarityTier; rarity_score?: number }
      rarityScore = result?.rarity_score
      rarityTier = typeof rarityScore === 'number' ? tierForRarityScore(rarityScore) : result?.rarity_tier
      closeness = result?.closeness ?? closeness
      points = result?.points ?? points
      total = result?.total_score ?? (score + points)
    } else if (supabase && runId) {
      const { data, error } = await supabase.functions.invoke('score-answer', {
        body: { runId, questionIndex, answer: cleaned },
      })
      if (error) {
        setFeedback({ kind: 'error', text: 'Could not score that answer. Try again.' })
        setLoading(false)
        return
      }
      const result = data as { points?: number; total_score?: number; closeness?: number; rarity_bonus?: number; rarity_tier?: RarityTier; rarity_score?: number }
      rarityScore = result?.rarity_score
      rarityTier = typeof rarityScore === 'number' ? tierForRarityScore(rarityScore) : result?.rarity_tier
      closeness = result?.closeness ?? closeness
      points = result?.points ?? points
      total = result?.total_score ?? (score + points)
    }
    setScore(total)
    const rating = rarityScore !== undefined
      ? `${rarityTier ?? tierForRarityScore(rarityScore)} · ${rarityScore}/100`
      : rarityTier ?? 'rarity unavailable'
    setFeedback({ kind: 'scored', text: `+${points} pts · ${rating}`, rarityTier, rarityScore })
    setLoading(false)
  }

  const resetGame = () => {
    setQuestionIndex(0)
    setAnswer('')
    setFeedback(null)
    setScore(0)
    resetQuestionTimer()
    setGameDone(false)
    setNav(battleRoom?.status === 'active' ? 'Battle' : 'Today')
  }

  const createBattleRoom = async () => {
    if (!supabase) { setBattleMessage('Add Supabase settings to create a shared room.'); return }
    if (!displayName.trim()) { setBattleMessage('Enter a player name to host a room.'); return }
    setBattleBusy(true)
    setBattleMessage('')
    const { data, error } = await supabase.rpc('create_battle_room', { p_display_name: displayName.trim(), p_title: roomTitle.trim() || 'Open lobby' })
    if (error) setBattleMessage(error.message)
    else { const room = data as BattleRoom; setBattleRoom(room); setRoomTitle(room.title) }
    setBattleBusy(false)
  }

  const joinBattleRoom = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase) { setBattleMessage('Add Supabase settings to join a shared room.'); return }
    if (!displayName.trim()) { setBattleMessage('Enter a player name to join this room.'); return }
    setBattleBusy(true)
    setBattleMessage('')
    const { data, error } = await supabase.rpc('join_battle_room', { p_code: joinCode.replace(/\s/g, '').toUpperCase(), p_display_name: displayName.trim() })
    if (error) setBattleMessage(error.message)
    else { const room = data as BattleRoom; setBattleRoom(room); setRoomTitle(room.title) }
    setBattleBusy(false)
  }

  const startBattleRoom = async () => {
    if (!supabase || !battleRoom) return
    setBattleBusy(true)
    const { error } = await supabase.rpc('start_battle_room', { p_code: battleRoom.code })
    if (error) setBattleMessage(error.message)
    else {
      const { data } = await supabase.rpc('get_battle_room', { p_code: battleRoom.code })
      if (data) setBattleRoom(data as BattleRoom)
    }
    setBattleBusy(false)
  }

  const copyBattleCode = async () => {
    if (!battleRoom) return
    try {
      await navigator.clipboard.writeText(battleRoom.code)
      setBattleMessage('Code copied.')
    } catch {
      setBattleMessage('Select the code to copy it.')
    }
  }

  return (
    <div className="app-shell">
      <div className="starfall-layer" aria-hidden="true">
        <span className="starfall-comet comet-violet" />
        <span className="starfall-comet comet-cyan" />
        <span className="starfall-comet comet-gold" />
        <span className="starfall-comet comet-blue" />
        <img className="space-buddy" src="/assets/space-buddy.png" alt="" />
        <svg className="astronaut-fall" viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="suit" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#fff" /><stop offset="1" stopColor="#c9c6ed" /></linearGradient>
            <linearGradient id="visor" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#9ef1ff" /><stop offset=".55" stopColor="#8175d9" /><stop offset="1" stopColor="#242757" /></linearGradient>
          </defs>
          <g stroke="#8585bd" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3">
            <path d="m34 77-15 17 8 7 19-15m20-9 14 13-7 8-19-13" fill="url(#suit)" />
            <path d="m39 103-3 16 10 2 9-15m5-4 7 14 10-4-5-18" fill="url(#suit)" />
            <path d="m27 43-9 12 9 8m48-20 10 11-9 9" fill="none" stroke="#d5d2f5" strokeWidth="6" />
            <rect x="28" y="62" width="46" height="43" rx="17" fill="url(#suit)" />
            <rect x="68" y="69" width="12" height="28" rx="5" fill="#8885c4" />
            <path d="M39 78h23v13H39z" fill="#7e79b8" stroke="none" />
            <circle cx="50" cy="43" r="27" fill="url(#suit)" />
            <path d="M34 40c0-11 8-19 18-19s17 7 17 17-7 17-18 17S34 49 34 40Z" fill="url(#visor)" stroke="#68659f" />
            <path d="M42 29c4-4 9-5 14-4" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="3" />
            <circle cx="69" cy="48" r="4" fill="#e6d9ff" />
          </g>
          <path d="m27 67-6 7m54-7 6 7" fill="none" stroke="#f3d992" strokeLinecap="round" strokeWidth="3" />
        </svg>
      </div>
      {feedback?.kind === 'scored' && feedback.rarityTier && <div className={`rarity-fullscreen tier-${feedback.rarityTier}`} aria-hidden="true">
        <div className="rarity-fx" />
        <img src={`/assets/rarity/${feedback.rarityTier}.svg`} alt="" />
        <span>{feedback.rarityTier}{feedback.rarityScore !== undefined && ` · ${feedback.rarityScore}/100`}</span>
      </div>}
      <header className="topbar">
        <a className="brand" href="#today" onClick={(event) => { event.preventDefault(); setNav('Today') }} aria-label="Today's Dive">
          <img className="brand-logo" src="/assets/krillion-logo.jpg" alt="" /><span>DEVNET <b>KRILLION</b></span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          {(['Today', 'Play', 'Battle'] as Nav[]).map((item) => <button key={item} className={nav === item ? 'nav-link active' : 'nav-link'} aria-current={nav === item ? 'page' : undefined} onClick={() => setNav(item)}>{item}</button>)}
        </nav>
        <span className="connection-label">{cloudStatus}</span>
      </header>

      <main>
        {nav !== 'Battle' && <section className="hero-banner" aria-label="Galaxy artwork">
          <div className="hero-copy"><h1>Today's <span>Dive</span></h1></div>
          <div className="meteor" aria-hidden="true"><span /></div>
        </section>}

        {nav === 'Today' && <section className="home-dive">
          <div className="today-topic"><span className="micro-label">7 QUESTIONS</span><div className="home-progress" role="progressbar" aria-label="Dive progress" aria-valuemin={0} aria-valuemax={dailyQuestions.length} aria-valuenow={answeredQuestions}><span style={{ transform: `scaleX(${answeredQuestions / dailyQuestions.length})` }} /></div><span className="topic-name">Everyday tech</span></div>
          <button className="primary-button start-button" disabled={questionSetState !== 'ready'} onClick={() => { setNav('Play'); resetQuestionTimer() }}>{questionSetState === 'loading' ? 'Loading questions…' : questionSetState === 'error' ? 'Questions unavailable' : 'Start dive'} {questionSetState === 'ready' && <ArrowRight size={17} />}</button>
          <p className="dive-rule">{questionSetState === 'ready' ? 'Rare answers earn more points.' : questionSetState === 'loading' ? 'Preparing today’s seven tech questions…' : 'Today’s questions could not load. Reload the page to try again.'}</p>
          <figure className="campus-banner"><img src="/assets/netconnect-campus-banner.jpg" alt="Cisco NetConnect at Polytechnic University of the Philippines, Sta. Mesa, Manila" /></figure>
        </section>}

        {nav === 'Battle' && <section className="battle-view">
          <div className="battle-heading"><span className="micro-label">DEVNET KRILLION</span><h1>Battle lobby</h1></div>
          {battleRoom ? <article className="room-card">
            <div className="room-header"><div><span className="micro-label">{battleRoom.status === 'active' ? 'ROOM LIVE' : 'WAITING ROOM'}</span><h2>{battleRoom.title || roomTitle || 'Battle room'}</h2></div><Swords size={21} /></div>
            <div className="room-code"><div><span className="micro-label">ROOM CODE</span><strong>{battleRoom.code}</strong></div><button type="button" className="icon-action" aria-label="Copy room code" onClick={() => void copyBattleCode()}><Copy size={17} /></button></div>
            <div className="room-members"><div className="members-label"><span><Users size={15} /> Players</span><span>{battleRoom.players.length} / 50</span></div></div>
            <div className="lobby-leaderboard"><div className="leaderboard-heading"><span>Leaderboard</span><span>POINTS</span></div>{rankedPlayers.map((player, index) => <div className="leaderboard-row" key={player.user_id}><span className="leaderboard-rank">{String(index + 1).padStart(2, '0')}</span><span className="leaderboard-name">{player.display_name}{player.is_host && <small>HOST</small>}</span><strong>{player.score ?? 0}</strong></div>)}</div>
            {battleRoom.is_host && battleRoom.status === 'waiting' && <button className="primary-button battle-primary" disabled={battleBusy || battleRoom.players.length < 2 || questionSetState !== 'ready'} onClick={() => void startBattleRoom()}>{battleBusy ? 'Starting…' : 'Start room'} <ArrowRight size={17} /></button>}
            {battleRoom.is_host && battleRoom.status === 'waiting' && battleRoom.players.length < 2 && <p className="battle-notice">Invite one more player to start.</p>}
            {battleRoom.status === 'active' && <p className="battle-notice">Room is live. Share the code with your players.</p>}
            {battleMessage && <p className="battle-message" role="status">{battleMessage}</p>}
          </article> : <div className="battle-panel">
            <label className="battle-field"><span>Your name</span><input value={displayName} maxLength={24} placeholder="Name shown in the lobby" autoComplete="nickname" required onChange={(event) => { setDisplayName(event.target.value); setBattleMessage('') }} /></label>
            <div className="battle-switch" role="group" aria-label="Battle lobby action">
              <button type="button" aria-pressed={battleMode === 'create'} className={battleMode === 'create' ? 'selected' : ''} onClick={() => { setBattleMode('create'); setBattleMessage('') }}><Plus size={15} /> Host a room</button>
              <button type="button" aria-pressed={battleMode === 'join'} className={battleMode === 'join' ? 'selected' : ''} onClick={() => { setBattleMode('join'); setBattleMessage('') }}><DoorOpen size={15} /> Join with code</button>
            </div>
            {battleMode === 'create' ? <div className="battle-form"><label className="battle-field"><span>Room name</span><input value={roomTitle} maxLength={48} placeholder="Open lobby" onChange={(event) => setRoomTitle(event.target.value)} /></label><button className="primary-button battle-primary" disabled={battleBusy || !displayName.trim()} onClick={() => void createBattleRoom()}>{battleBusy ? 'Creating…' : 'Host a battle'} <ArrowRight size={17} /></button></div> : <form className="battle-form" onSubmit={joinBattleRoom}><label className="battle-field"><span>Room code</span><input value={joinCode} maxLength={8} placeholder="A1B2C3D4" autoCapitalize="characters" onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())} /></label><button className="primary-button battle-primary" disabled={battleBusy || !displayName.trim() || ![6, 8].includes(joinCode.length)}>{battleBusy ? 'Joining…' : 'Join room'} <ArrowRight size={17} /></button></form>}
            {!supabase && <p className="battle-message">Connect Supabase to create and share room codes.</p>}
            {battleMessage && <p className="battle-message" role="status">{battleMessage}</p>}
          </div>}
        </section>}

        {nav === 'Play' && <section className="play-view">
          <div className="play-topline"><span>{gameDone ? 'Complete' : `${questionIndex + 1} / 7`}</span><span className="play-topic">{gameDone ? `${score} points` : current.topic}</span><span className="play-timer"><Clock3 size={14} /> 0:{String(timeLeft).padStart(2, '0')}</span></div>
          <article key={gameDone ? 'complete' : questionIndex} className="question-card">
            {questionSetState !== 'ready' && supabase ? <div className="completion"><h2>{questionSetState === 'loading' ? 'Loading today’s questions…' : 'Today’s set is unavailable.'}</h2><p>{questionSetState === 'error' ? 'Reload the page to try again.' : 'Seven new questions are on their way.'}</p></div> : gameDone ? <div className="completion"><h2>{battleRoom?.status === 'active' ? 'Battle complete.' : 'Dive complete.'}</h2><p>{score} points</p><button className="primary-button" onClick={resetGame}>{battleRoom?.status === 'active' ? 'Return to lobby' : 'Done'}</button></div> : <>
              <div className="question-heading"><h2>{current.prompt}</h2></div>
              <form onSubmit={submitAnswer} className="answer-form">
                <label htmlFor="answer-input"><span>Your answer</span><span className="mono key-hint">Enter ↵</span></label>
                <div className={`input-wrap ${feedback?.kind === 'scored' ? 'input-scored' : ''}`}><input ref={inputRef} id="answer-input" value={answer} maxLength={MAX_ANSWER_LENGTH} onChange={(event) => setAnswer(event.target.value.slice(0, MAX_ANSWER_LENGTH))} placeholder="Type anything…" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={feedback?.kind === 'scored'} aria-describedby="answer-feedback answer-counter" /></div>
                <div id="answer-counter" className={`answer-counter ${answer.length >= MAX_ANSWER_LENGTH - 15 ? 'answer-counter-near-limit' : ''}`} aria-live="polite">{answer.length}/{MAX_ANSWER_LENGTH}</div>
                <button className="primary-button" type="submit" disabled={!answer.trim() || loading || feedback?.kind === 'scored'}>{feedback?.kind === 'scored' ? <><Check size={17} /> {feedback.text}</> : loading ? 'Scoring…' : <>Submit <ArrowDown size={17} /></>}</button>
                <div id="answer-feedback" className={`feedback ${feedback ? `feedback-${feedback.kind}` : ''}`} aria-live="polite">{feedback?.kind === 'error' ? feedback.text : null}{feedback?.kind === 'scored' && <button type="button" onClick={nextQuestion}>{questionIndex === dailyQuestions.length - 1 ? 'Finish' : 'Next'} <ArrowRight size={13} /></button>}</div>
              </form>
            </>}
          </article>
          {!gameDone && <div className="score-line"><span>Score</span><strong>{score}</strong><div className="game-progress"><span style={{ transform: `scaleX(${progress / 100})` }} /></div></div>}
          {battleRoom?.status === 'active' && <aside className="battle-scoreboard" aria-label="Live battle leaderboard"><div className="leaderboard-heading"><span>{gameDone ? 'Final standings' : 'Live standings'}</span><span>POINTS</span></div>{rankedPlayers.map((player, index) => <div className="leaderboard-row" key={player.user_id}><span className="leaderboard-rank">{String(index + 1).padStart(2, '0')}</span><span className="leaderboard-name">{player.display_name}{player.is_host && <small>HOST</small>}</span><strong>{player.score ?? 0}</strong></div>)}</aside>}
        </section>}
      </main>

      <div className="mobile-tabs">{(['Today', 'Play', 'Battle'] as Nav[]).map((item) => <button key={item} onClick={() => setNav(item)} aria-current={nav === item ? 'page' : undefined} className={nav === item ? 'mobile-tab current' : 'mobile-tab'}>{item}</button>)}</div>
    </div>
  )
}

export default App
