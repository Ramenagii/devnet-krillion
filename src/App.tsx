import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ArrowDown, ArrowRight, Check, Clock3, Copy, DoorOpen, Plus, Swords, Users } from 'lucide-react'

type Question = { prompt: string; topic: string; accepted: string[] }
type Nav = 'Today' | 'Play' | 'Battle'
type Feedback = { kind: 'scored' | 'error'; text: string }
type BattleRoom = { id: string; code: string; title: string; status: 'waiting' | 'active'; host_user_id: string; is_host: boolean; players: { user_id: string; display_name: string; is_host: boolean }[] }

const QUESTIONS: Question[] = [
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
const todayKey = new Intl.DateTimeFormat('en-CA').format(new Date())

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
  const [gameDone, setGameDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [cloudStatus, setCloudStatus] = useState(supabase ? 'Connecting…' : 'Offline')
  const [battleRoom, setBattleRoom] = useState<BattleRoom | null>(null)
  const [roomTitle, setRoomTitle] = useState('')
  const [displayName, setDisplayName] = useState('Explorer')
  const [joinCode, setJoinCode] = useState('')
  const [battleBusy, setBattleBusy] = useState(false)
  const [battleMessage, setBattleMessage] = useState('')
  const [battleMode, setBattleMode] = useState<'create' | 'join'>('create')
  const inputRef = useRef<HTMLInputElement>(null)
  const current = QUESTIONS[questionIndex]
  const progress = gameDone ? 100 : (questionIndex / QUESTIONS.length) * 100
  const answeredQuestions = gameDone ? QUESTIONS.length : questionIndex + (feedback?.kind === 'scored' ? 1 : 0)
  const displayDate = useMemo(() => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()), [])

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
        const { data, error } = await supabase.rpc('start_daily_run', { p_run_date: todayKey })
        if (error) throw error
        if (alive) {
          setRunId(typeof data === 'string' ? data : (data as { id?: string })?.id ?? null)
          setCloudStatus('Synced')
        }
      } catch {
        if (alive) setCloudStatus('Offline')
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
    if (nav !== 'Play' || gameDone || timeLeft === 0 || feedback?.kind === 'scored') return
    const timer = window.setInterval(() => setTimeLeft((value) => {
      if (value <= 1) {
        window.clearInterval(timer)
        setFeedback({ kind: 'error', text: 'Time is up. Try an answer anyway.' })
        return 0
      }
      return value - 1
    }), 1000)
    return () => window.clearInterval(timer)
  }, [nav, questionIndex, gameDone, feedback?.kind, timeLeft])

  useEffect(() => {
    if (nav !== 'Play') return
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [nav])

  const nextQuestion = useCallback(() => {
    if (questionIndex === QUESTIONS.length - 1) {
      setGameDone(true)
      setFeedback(null)
      return
    }
    setQuestionIndex((index) => index + 1)
    setAnswer('')
    setFeedback(null)
    setTimeLeft(30)
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [questionIndex])

  const submitAnswer = async (event: FormEvent) => {
    event.preventDefault()
    const cleaned = answer.trim()
    if (!cleaned || loading || gameDone) return
    setLoading(true)
    const normalized = cleaned.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    let closeness = answerSimilarity(normalized, current.accepted)
    let rarityBonus = supabase && runId ? Math.round(40 * closeness) : 0
    let points = 10 + Math.round(closeness * 90) + rarityBonus
    let total = score + points

    if (supabase && runId) {
      const { data, error } = await supabase.functions.invoke('score-answer', {
        body: { runId, questionIndex, answer: cleaned },
      })
      if (error) {
        setFeedback({ kind: 'error', text: 'Gemini could not score that answer. Try again.' })
        setLoading(false)
        return
      }
      const result = data as { points?: number; total_score?: number; closeness?: number; rarity_bonus?: number }
      closeness = result?.closeness ?? closeness
      rarityBonus = result?.rarity_bonus ?? rarityBonus
      points = result?.points ?? points
      total = result?.total_score ?? (score + points)
    }
    setScore(total)
    setFeedback({ kind: 'scored', text: `+${points} · ${supabase && runId ? rarityBonus >= 30 ? 'rare' : 'shared' : 'local score'}` })
    setLoading(false)
  }

  const resetGame = () => {
    setQuestionIndex(0)
    setAnswer('')
    setFeedback(null)
    setScore(0)
    setTimeLeft(30)
    setGameDone(false)
    setNav('Today')
  }

  const createBattleRoom = async () => {
    if (!supabase) { setBattleMessage('Add Supabase settings to create a shared room.'); return }
    setBattleBusy(true)
    setBattleMessage('')
    const { data, error } = await supabase.rpc('create_battle_room', { p_display_name: displayName.trim() || 'Explorer', p_title: roomTitle.trim() || 'Open lobby' })
    if (error) setBattleMessage(error.message)
    else { const room = data as BattleRoom; setBattleRoom(room); setRoomTitle(room.title) }
    setBattleBusy(false)
  }

  const joinBattleRoom = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase) { setBattleMessage('Add Supabase settings to join a shared room.'); return }
    setBattleBusy(true)
    setBattleMessage('')
    const { data, error } = await supabase.rpc('join_battle_room', { p_code: joinCode.replace(/\s/g, '').toUpperCase(), p_display_name: displayName.trim() || 'Explorer' })
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

        {nav !== 'Battle' && <div className="daily-meta"><div className="today"><div><strong>{displayDate} <span className="meta-divider">/</span> Everyday tech</strong></div></div></div>}

        {nav === 'Today' && <section className="home-dive">
          <div className="today-topic"><span className="micro-label">7 QUESTIONS</span><div className="home-progress" role="progressbar" aria-label="Dive progress" aria-valuemin={0} aria-valuemax={QUESTIONS.length} aria-valuenow={answeredQuestions}><span style={{ transform: `scaleX(${answeredQuestions / QUESTIONS.length})` }} /></div><span className="topic-name">Everyday tech</span></div>
          <button className="primary-button start-button" onClick={() => { setNav('Play'); setTimeLeft(30) }}>Start dive <ArrowRight size={17} /></button>
          <p className="dive-rule">30 sec each · closer, rarer answers score more</p>
          <figure className="campus-banner"><img src="/assets/netconnect-campus-banner.jpg" alt="Cisco NetConnect at Polytechnic University of the Philippines, Sta. Mesa, Manila" /></figure>
        </section>}

        {nav === 'Battle' && <section className="battle-view">
          <div className="battle-heading"><span className="micro-label">DEVNET KRILLION</span><h1>Battle lobby</h1></div>
          {battleRoom ? <article className="room-card">
            <div className="room-header"><div><span className="micro-label">{battleRoom.status === 'active' ? 'ROOM LIVE' : 'WAITING ROOM'}</span><h2>{battleRoom.title || roomTitle || 'Battle room'}</h2></div><Swords size={21} /></div>
            <div className="room-code"><div><span className="micro-label">ROOM CODE</span><strong>{battleRoom.code}</strong></div><button type="button" className="icon-action" aria-label="Copy room code" onClick={() => void copyBattleCode()}><Copy size={17} /></button></div>
            <div className="room-members"><div className="members-label"><span><Users size={15} /> Players</span><span>{battleRoom.players.length} / 18</span></div>{battleRoom.players.map((player) => <div className="player-row" key={player.user_id}><span>{player.display_name}</span><span>{player.is_host ? 'HOST' : 'READY'}</span></div>)}</div>
            {battleRoom.is_host && battleRoom.status === 'waiting' && <button className="primary-button battle-primary" disabled={battleBusy || battleRoom.players.length < 2} onClick={() => void startBattleRoom()}>{battleBusy ? 'Starting…' : 'Start room'} <ArrowRight size={17} /></button>}
            {battleRoom.is_host && battleRoom.status === 'waiting' && battleRoom.players.length < 2 && <p className="battle-notice">Invite one more player to start.</p>}
            {battleRoom.status === 'active' && <p className="battle-notice">Room is live. Share the code with your players.</p>}
            {battleMessage && <p className="battle-message" role="status">{battleMessage}</p>}
          </article> : <div className="battle-panel">
            <label className="battle-field"><span>Nickname</span><input value={displayName} maxLength={24} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <div className="battle-switch" role="group" aria-label="Battle lobby action">
              <button type="button" aria-pressed={battleMode === 'create'} className={battleMode === 'create' ? 'selected' : ''} onClick={() => { setBattleMode('create'); setBattleMessage('') }}><Plus size={15} /> Create room</button>
              <button type="button" aria-pressed={battleMode === 'join'} className={battleMode === 'join' ? 'selected' : ''} onClick={() => { setBattleMode('join'); setBattleMessage('') }}><DoorOpen size={15} /> Join with code</button>
            </div>
            {battleMode === 'create' ? <div className="battle-form"><label className="battle-field"><span>Room name</span><input value={roomTitle} maxLength={48} placeholder="Open lobby" onChange={(event) => setRoomTitle(event.target.value)} /></label><button className="primary-button battle-primary" disabled={battleBusy} onClick={() => void createBattleRoom()}>{battleBusy ? 'Creating…' : 'Create room'} <ArrowRight size={17} /></button></div> : <form className="battle-form" onSubmit={joinBattleRoom}><label className="battle-field"><span>Room code</span><input value={joinCode} maxLength={6} placeholder="ABC123" autoCapitalize="characters" onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())} /></label><button className="primary-button battle-primary" disabled={battleBusy || joinCode.length !== 6}>{battleBusy ? 'Joining…' : 'Join room'} <ArrowRight size={17} /></button></form>}
            {!supabase && <p className="battle-message">Connect Supabase to create and share room codes.</p>}
            {battleMessage && <p className="battle-message" role="status">{battleMessage}</p>}
          </div>}
        </section>}

        {nav === 'Play' && <section className="play-view">
          <div className="play-topline"><span>{gameDone ? 'Complete' : `${questionIndex + 1} / 7`}</span><span className="play-topic">{gameDone ? `${score} points` : current.topic}</span><span className="play-timer"><Clock3 size={14} /> 0:{String(timeLeft).padStart(2, '0')}</span></div>
          <article key={gameDone ? 'complete' : questionIndex} className="question-card">
            {gameDone ? <div className="completion"><h2>Dive complete.</h2><p>{score} points</p><button className="primary-button" onClick={resetGame}>Done</button></div> : <>
              <div className="question-heading"><h2>{current.prompt}</h2></div>
              <form onSubmit={submitAnswer} className="answer-form">
                <label htmlFor="answer-input"><span>Your answer</span><span className="mono key-hint">Enter ↵</span></label>
                <div className={`input-wrap ${feedback?.kind === 'scored' ? 'input-scored' : ''}`}><input ref={inputRef} id="answer-input" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Type anything…" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={feedback?.kind === 'scored'} aria-describedby="answer-feedback" /></div>
                <button className="primary-button" type="submit" disabled={!answer.trim() || loading || feedback?.kind === 'scored'}>{feedback?.kind === 'scored' ? <><Check size={17} /> {feedback.text}</> : loading ? 'Scoring…' : <>Submit <ArrowDown size={17} /></>}</button>
                <div id="answer-feedback" className={`feedback ${feedback ? `feedback-${feedback.kind}` : ''}`} aria-live="polite">{feedback?.kind === 'error' ? feedback.text : null}{feedback?.kind === 'scored' && <button type="button" onClick={nextQuestion}>{questionIndex === 6 ? 'Finish' : 'Next'} <ArrowRight size={13} /></button>}</div>
              </form>
            </>}
          </article>
          {!gameDone && <div className="score-line"><span>Score</span><strong>{score}</strong><div className="game-progress"><span style={{ transform: `scaleX(${progress / 100})` }} /></div></div>}
        </section>}
      </main>

      <div className="mobile-tabs">{(['Today', 'Play', 'Battle'] as Nav[]).map((item) => <button key={item} onClick={() => setNav(item)} aria-current={nav === item ? 'page' : undefined} className={nav === item ? 'mobile-tab current' : 'mobile-tab'}>{item}</button>)}</div>
    </div>
  )
}

export default App
