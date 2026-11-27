import { useEffect, useRef, useState } from 'react'

/** A picture waiting to be sent, read into a data: URL the server can check. */
export interface PendingFile { name: string; mediaType: string; url: string }

/** Pictures larger than this on their long side, or than SHRINK_BYTES, are redrawn smaller before sending. */
export const SHRINK_SIDE = 1600
export const SHRINK_BYTES = 1_000_000

const asDataUrl = (blob: Blob, name: string) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(new Error(`“${name}” could not be read.`))
  r.readAsDataURL(blob)
})

/**
 * Redraw a photo at most SHRINK_SIDE pixels on its long side, as JPEG. A phone photo goes from a few MB to a few
 * hundred KB, which is plenty for reading a bill. Returns the original where the browser can't redraw it.
 */
export async function shrinkPicture(file: Blob): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  try {
    const bmp = await createImageBitmap(file)
    const long = Math.max(bmp.width, bmp.height)
    if (long <= SHRINK_SIDE && file.size <= SHRINK_BYTES) { bmp.close(); return file }
    const scale = Math.min(1, SHRINK_SIDE / long)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) { bmp.close(); return file }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
    return out && out.size < file.size ? out : file
  } catch {
    return file
  }
}

export async function readFile(file: File): Promise<PendingFile> {
  const small = await shrinkPicture(file)
  const name = small === file ? file.name : file.name.replace(/\.\w+$/, '') + '.jpg'
  return { name, mediaType: small.type || file.type, url: await asDataUrl(small, file.name) }
}

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start(): void
  stop(): void
}

function recognitionClass(): (new () => Recognition) | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/**
 * Speech to text in the browser, where it is supported (Chrome, Edge, Safari). Nothing is sent to Teovo's server
 * until the user presses Send, and the text can be corrected first.
 */
export function useVoice(onText: (text: string) => void, lang?: string) {
  const Rec = recognitionClass()
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string>()
  const rec = useRef<Recognition | null>(null)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => rec.current?.stop(), [])

  function toggle() {
    if (!Rec) return
    if (listening) { rec.current?.stop(); return }
    const r = new Rec()
    r.lang = lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US')
    r.interimResults = false
    r.continuous = false
    r.onresult = (e) => {
      const said = Array.from(e.results).filter((x) => x.isFinal).map((x) => x[0]?.transcript ?? '').join(' ').trim()
      if (said) latest.current(said)
    }
    r.onerror = (e) => setError(e.error === 'not-allowed' ? 'Allow the microphone to speak to the assistant.' : 'Couldn’t hear that. Try again.')
    r.onend = () => setListening(false)
    rec.current = r
    setError(undefined)
    setListening(true)
    r.start()
  }
  return { supported: Boolean(Rec), listening, error, toggle }
}

/**
 * Voice through the app's own speech-to-text: records with the microphone, then hands the recording to
 * `transcribe` (say, a server endpoint that turns Hindi or Hinglish into English text). Use it where the browser's
 * own speech recognition is missing or can't do the language.
 */
export function useRecorder(onText: (text: string) => void, transcribe: ((audio: Blob) => Promise<string>) | undefined) {
  const supported = Boolean(transcribe) && typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  const [listening, setListening] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const rec = useRef<MediaRecorder | null>(null)
  const latest = useRef({ onText, transcribe })
  latest.current = { onText, transcribe }
  useEffect(() => () => { if (rec.current?.state === 'recording') rec.current.stop() }, [])

  async function toggle() {
    if (!supported || working) return
    if (listening) { rec.current?.stop(); return }
    setError(undefined)
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { setError('Allow the microphone to speak to the assistant.'); return }
    const chunks: Blob[] = []
    const r = new MediaRecorder(stream)
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    r.onstop = async () => {
      for (const t of stream.getTracks()) t.stop()
      setListening(false)
      if (!chunks.length) return
      setWorking(true)
      try {
        const said = (await latest.current.transcribe!(new Blob(chunks, { type: r.mimeType || 'audio/webm' }))).trim()
        if (said) latest.current.onText(said)
        else setError('Couldn’t hear that. Try again.')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Couldn’t hear that. Try again.')
      } finally { setWorking(false) }
    }
    rec.current = r
    r.start()
    setListening(true)
  }
  return { supported, listening, working, error, toggle }
}
