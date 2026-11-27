import { useEffect, useRef, useState } from 'react'

/** A picture waiting to be sent, read into a data: URL the server can check. */
export interface PendingFile { name: string; mediaType: string; url: string }

export function readFile(file: File): Promise<PendingFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ name: file.name, mediaType: file.type, url: String(r.result) })
    r.onerror = () => reject(new Error(`“${file.name}” could not be read.`))
    r.readAsDataURL(file)
  })
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
