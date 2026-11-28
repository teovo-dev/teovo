import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOptionalAssistant } from './provider.js'

const BARS = 24
const QUIET_SECS = 3
const MAX_SECS = 120

export interface VoiceButtonProps {
  /** What was said, written down (in English when the server's voice.english is on). */
  onText: (text: string) => void
  /** The button's words next to the microphone, e.g. "Speak order". Default: just the microphone. */
  label?: ReactNode
  /** Replace how the recording is written down. Default: the server's POST …/transcribe (needs AssistantProvider). */
  transcribe?: (audio: Blob) => Promise<string>
  className?: string
  /** Shown after it heard something, e.g. to confirm in a toast. Default: nothing. */
  onHeard?: (text: string) => void
}

/**
 * A microphone for the app's own forms ("Speak order", "Say it"): tap, speak, Done. A panel shows a live sound meter
 * and a timer, so people can see it hears them; it says so when it can't. The recording is written down by the server.
 */
export function VoiceButton(props: VoiceButtonProps) {
  const ctx = useOptionalAssistant()
  const transcribe = props.transcribe ?? ctx?.transcribe
  const [state, setState] = useState<'idle' | 'rec' | 'busy' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [secs, setSecs] = useState(0)
  const [quiet, setQuiet] = useState(false)
  const [heard, setHeard] = useState(false)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const cancelled = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const raf = useRef<number | undefined>(undefined)
  const audio = useRef<AudioContext | null>(null)
  const bars = useRef<HTMLDivElement>(null)
  const lastSound = useRef(0)
  const supported = Boolean(transcribe) && typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

  const cleanup = () => {
    window.clearInterval(timer.current)
    if (raf.current) cancelAnimationFrame(raf.current)
    audio.current?.close().catch(() => undefined)
    audio.current = null
    rec.current?.stream.getTracks().forEach((t) => t.stop())
  }
  useEffect(() => cleanup, [])

  const fail = (text: string) => { setMessage(text); setState('error') }

  /** Live level meter: a rolling row of bars that grow with the voice. */
  function meter(stream: MediaStream) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ac = new Ctx()
    audio.current = ac
    const an = ac.createAnalyser()
    an.fftSize = 512
    ac.createMediaStreamSource(stream).connect(an)
    const buf = new Uint8Array(an.fftSize)
    const levels: number[] = Array(BARS).fill(0)
    let frame = 0
    lastSound.current = performance.now()
    const tick = () => {
      an.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6)   // speech ≈ 0.3–1
      if (level > 0.12) { lastSound.current = performance.now(); setHeard(true) }
      setQuiet(performance.now() - lastSound.current > QUIET_SECS * 1000)
      if (++frame % 3 === 0) { levels.shift(); levels.push(level) }
      const el = bars.current
      if (el) for (let i = 0; i < el.children.length; i++) (el.children[i] as HTMLElement).style.height = `${Math.max(8, levels[i]! * 100)}%`
      raf.current = requestAnimationFrame(tick)
    }
    tick()
  }

  async function start() {
    if (!supported || !transcribe) return fail('This browser can’t record audio.')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) } catch { return fail('Allow the microphone to use voice.') }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m))
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    chunks.current = []
    cancelled.current = false
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = async () => {
      cleanup()
      if (cancelled.current) { setState('idle'); return }
      const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })
      if (blob.size < 2000) return fail('Too short. Tap the microphone, speak, then tap Done.')
      setState('busy')
      try {
        const text = (await transcribe(blob)).trim()
        if (!text) return fail('Couldn’t make out any words. Try again a little louder.')
        setState('idle')
        props.onText(text)
        props.onHeard?.(text)
      } catch (e) {
        fail(e instanceof Error ? e.message : 'Voice isn’t working right now. Type it instead.')
      }
    }
    rec.current = r
    r.start()
    setSecs(0); setQuiet(false); setHeard(false)
    timer.current = window.setInterval(() => setSecs((s) => { if (s + 1 >= MAX_SECS) r.stop(); return s + 1 }), 1000)
    setState('rec')
    meter(stream)
  }

  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop() }
  const cancel = () => { cancelled.current = true; stop() }
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

  const panel = state !== 'idle' && typeof document !== 'undefined' ? createPortal(
    <div className="tv-voice" role="dialog" aria-label="Voice recording">
      <div className="tv-voice-box">
        {state === 'rec' ? (
          <>
            <div className="tv-voice-top"><span className="tv-voice-dot" aria-hidden="true" /><b>Recording</b><span className="tv-voice-time">{mmss}</span></div>
            <div ref={bars} className={`tv-voice-bars${quiet ? ' tv-voice-quiet' : ''}`} aria-hidden="true">
              {Array.from({ length: BARS }).map((_, i) => <div key={i} style={{ height: '8%' }} />)}
            </div>
            <p className={`tv-voice-hint${quiet ? ' tv-voice-warn' : ''}`} aria-live="polite">
              {quiet ? (heard ? 'Paused? Keep talking, or tap Done.' : 'Can’t hear you. Speak closer to the microphone.') : heard ? 'Hearing you… tap Done when finished.' : 'Speak now.'}
            </p>
            <div className="tv-voice-buttons">
              <button type="button" onClick={cancel}>Cancel</button>
              <button type="button" className="tv-voice-done" onClick={stop}>Done</button>
            </div>
          </>
        ) : state === 'busy' ? (
          <div className="tv-voice-busy" role="status"><span className="tv-spin" aria-hidden="true" />Writing down what you said…</div>
        ) : (
          <>
            <p className="tv-voice-hint tv-voice-warn" role="alert">{message}</p>
            <div className="tv-voice-buttons"><button type="button" onClick={() => setState('idle')}>OK</button></div>
          </>
        )}
      </div>
    </div>,
    document.body,
  ) : null

  if (!transcribe) return null
  return (
    <>
      <button type="button" className={`tv-voice-btn ${props.className ?? ''}`} onClick={() => void start()} disabled={state === 'busy'}
        aria-label={typeof props.label === 'string' ? props.label : 'Speak'} title="Speak">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
        {props.label ? <span>{props.label}</span> : null}
      </button>
      {panel}
    </>
  )
}
