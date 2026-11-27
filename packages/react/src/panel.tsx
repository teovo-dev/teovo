import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { readFile, useVoice, type PendingFile } from './input.js'
import { useAssistant } from './provider.js'
import type { Action, Card, CardDecision, Step, TeovoMessage, View } from './types.js'
import { defaultViews, isCurrent, type ViewComponent } from './views.js'

export interface AssistantPanelProps {
  /** Shown before the first message. */
  welcome?: ReactNode
  placeholder?: string
  /** Draw the reply text yourself, e.g. with a Markdown renderer. Default: plain text. */
  renderText?: (text: string) => ReactNode
  /** Draw a card yourself. `decide` sends Confirm, Skip or Undo to the server (or the provider's onCard). */
  renderCard?: (card: Card, decide: (d: CardDecision) => void, state: CardState) => ReactNode
  /** Friendly names for tools while they run, e.g. { get_sales: 'Looking at sales' }. */
  stepLabels?: Record<string, string>
  /** Draw views yourself, by view name: replaces the built-in choices, table, record and form, or adds the app's own. */
  views?: Record<string, ViewComponent>
  /** Let the user attach pictures. Turn it on only when the server has `attachments` set. Default off. */
  attach?: boolean | { accept?: string; maxFiles?: number }
  /** Show a microphone button where the browser can turn speech into text. Default true. */
  voice?: boolean
  /** Language for speech, e.g. 'hi-IN'. Default: the browser's. */
  voiceLang?: string
  /** Show suggestion chips above the input. Default true (they only appear when the server has some). */
  showSuggestions?: boolean
  className?: string
}

export type CardState = { status: 'open' | 'busy' | 'confirmed' | 'skipped' | 'undone' | 'expired'; reversible?: boolean; error?: string }

/** A ready-made chat panel. Unstyled apart from `tv-` class names; import '@teovo/react/styles.css' for defaults. */
export function AssistantPanel(props: AssistantPanelProps) {
  const { chat, newChat, suggestions, clearSuggestions } = useAssistant()
  const [text, setText] = useState('')
  const busy = chat.status === 'submitted' || chat.status === 'streaming'
  const hint = suggestions.placeholder
  const [files, setFiles] = useState<PendingFile[]>([])
  const [fileError, setFileError] = useState<string>()
  const picker = useRef<HTMLInputElement>(null)
  const attach = props.attach ? (props.attach === true ? {} : props.attach) : null
  const voice = useVoice((said) => setText((t) => (t ? `${t} ${said}` : said)), props.voiceLang)

  function ask(t: string) {
    if ((!t.trim() && !files.length) || busy) return
    setText('')
    clearSuggestions()
    const parts = files.map((f) => ({ type: 'file' as const, mediaType: f.mediaType, filename: f.name, url: f.url }))
    setFiles([])
    void chat.sendMessage(parts.length ? { text: t.trim(), files: parts } : { text: t.trim() })
  }
  function send(e: FormEvent) {
    e.preventDefault()
    ask(text)
  }
  async function pick(list: FileList | null) {
    if (!list || !attach) return
    setFileError(undefined)
    const max = attach.maxFiles ?? 4
    const chosen = Array.from(list).slice(0, Math.max(0, max - files.length))
    try {
      const read = await Promise.all(chosen.map(readFile))
      setFiles((f) => [...f, ...read])
    } catch (e) { setFileError(e instanceof Error ? e.message : String(e)) }
    if (picker.current) picker.current.value = ''
  }

  return (
    <section className={`tv-panel ${props.className ?? ''}`} aria-label="Assistant">
      <div className="tv-messages" role="log" aria-live="polite">
        {chat.messages.length === 0 && props.welcome ? <div className="tv-welcome">{props.welcome}</div> : null}
        {chat.messages.map((m) => <Message key={m.id} message={m} ask={ask} {...props} />)}
        {chat.status === 'submitted' ? <div className="tv-thinking">Thinking…</div> : null}
        {chat.error ? <div className="tv-error" role="alert">{errorText(chat.error)}</div> : null}
      </div>
      {props.showSuggestions !== false && !busy && suggestions.suggestions.length ? (
        <div className="tv-chips" role="group" aria-label="Suggestions">
          {suggestions.suggestions.map((s) => <button key={s} type="button" className="tv-chip" onClick={() => ask(s)}>{s}</button>)}
        </div>
      ) : null}
      {files.length ? (
        <ul className="tv-pending" aria-label="Attached">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <img src={f.url} alt={f.name} />
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {fileError || voice.error ? <div className="tv-error" role="alert">{fileError ?? voice.error}</div> : null}
      <form className="tv-input" onSubmit={send}>
        {attach ? (
          <>
            <input ref={picker} type="file" hidden multiple accept={attach.accept ?? 'image/jpeg,image/png,image/webp'} aria-label="Attach pictures"
              onChange={(e) => void pick(e.target.files)} />
            <button type="button" className="tv-attach" aria-label="Attach a picture" onClick={() => picker.current?.click()}>＋</button>
          </>
        ) : null}
        <textarea
          aria-label="Message"
          value={text}
          placeholder={hint ? `${hint}  (Tab)` : (props.placeholder ?? 'Ask anything')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !text && hint) { e.preventDefault(); setText(hint) }   // accept the hint, like autocomplete
            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e)
          }}
          rows={1}
        />
        {busy
          ? <button type="button" onClick={() => void chat.stop()}>Stop</button>
          : <button type="submit" disabled={!text.trim() && !files.length}>Send</button>}
        {props.voice !== false && voice.supported && !busy ? (
          <button type="button" className="tv-mic" aria-pressed={voice.listening} aria-label={voice.listening ? 'Stop listening' : 'Speak'} onClick={voice.toggle}>
            {voice.listening ? '■' : '🎤'}
          </button>
        ) : null}
        {chat.messages.length > 0 && !busy ? <button type="button" className="tv-new" onClick={newChat}>New chat</button> : null}
      </form>
    </section>
  )
}

function Message({ message, ask, ...props }: { message: TeovoMessage; ask: (t: string) => void } & AssistantPanelProps) {
  const { onAction, submitForm, chat } = useAssistant()
  const steps = message.parts.filter((p) => p.type === 'data-step')
  const running = steps.filter((p) => (p.data as Step).state === 'running')
  return (
    <div className={`tv-message tv-${message.role}`} data-role={message.role}>
      {message.parts.map((p, i) => {
        if (p.type === 'text') return p.text ? <div key={i} className="tv-text">{props.renderText ? props.renderText(p.text) : p.text}</div> : null
        if (p.type === 'file') {
          return p.mediaType.startsWith('image/')
            ? <img key={i} className="tv-attachment" src={p.url} alt={p.filename ?? 'Picture'} />
            : <div key={i} className="tv-attachment">{p.filename ?? 'File'}</div>
        }
        if (p.type === 'data-card') return <CardView key={p.id ?? i} card={p.data as Card} {...props} />
        if (p.type === 'data-view') {
          const v = p.data as View
          const Draw = props.views?.[v.view] ?? defaultViews[v.view]
          if (!Draw) return null
          const id = p.id ?? String(i)
          return <Draw key={id} part={{ ...v, id }} current={isCurrent(chat.messages, message.id)} ask={ask} formats={message.metadata?.formats}
            submit={(values) => submitForm(message.id, id, values)} />
        }
        if (p.type === 'data-action') {
          const a = p.data as Action
          return <button key={p.id ?? i} type="button" className="tv-action" onClick={() => onAction?.(a)}>{a.label}</button>
        }
        return null
      })}
      {running.map((p) => {
        const name = (p.data as Step).name
        return <div key={p.id} className="tv-step">{props.stepLabels?.[name] ?? `Using ${name.replace(/_/g, ' ')}`}…</div>
      })}
    </div>
  )
}

const FINAL = { confirmed: 'confirmed', skipped: 'skipped', undone: 'undone', expired: 'expired' } as const
const AFTER = { confirm: 'confirmed', skip: 'skipped', undo: 'undone' } as const

function CardView({ card, renderCard }: { card: Card } & AssistantPanelProps) {
  const { decideCard } = useAssistant()
  const [state, setState] = useState<CardState>({ status: FINAL[card.status as keyof typeof FINAL] ?? 'open', reversible: card.reversible })

  async function decide(d: CardDecision) {
    const allowed = d === 'undo' ? state.status === 'confirmed' && state.reversible : state.status === 'open'
    if (!allowed) return
    const before = state
    setState({ ...state, status: 'busy', error: undefined })
    try {
      const now = await decideCard(card, d)
      setState({ status: AFTER[d], reversible: now.reversible })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      setState({ ...before, error })
    }
  }

  if (renderCard) return <>{renderCard(card, (d) => void decide(d), state)}</>
  const keys = [...new Set([...Object.keys(card.before ?? {}), ...Object.keys(card.after ?? {})])]
  return (
    <div className="tv-card" data-status={state.status} role="group" aria-label={card.title}>
      <div className="tv-card-title">{card.title}</div>
      {keys.length ? (
        <table className="tv-card-diff"><tbody>
          {keys.map((k) => (
            <tr key={k}><th scope="row">{k}</th><td>{show(card.before?.[k])}</td><td>→</td><td>{show(card.after?.[k])}</td></tr>
          ))}
        </tbody></table>
      ) : null}
      {state.error ? <div className="tv-error" role="alert">{state.error}</div> : null}
      {state.status === 'confirmed' ? (
        <div className="tv-card-done">Done{state.reversible ? <button type="button" onClick={() => void decide('undo')}>Undo</button> : null}</div>
      ) : state.status === 'skipped' || state.status === 'undone' || state.status === 'expired' ? (
        <div className="tv-card-done">{{ skipped: 'Skipped', undone: 'Undone', expired: 'Expired' }[state.status]}</div>
      ) : (
          <div className="tv-card-buttons">
            <button type="button" disabled={state.status === 'busy'} onClick={() => void decide('confirm')}>Confirm</button>
            <button type="button" disabled={state.status === 'busy'} onClick={() => void decide('skip')}>Skip</button>
          </div>
        )}
    </div>
  )
}

const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** Server errors arrive as JSON ({ error }) or plain text; show the sentence, not the JSON. */
function errorText(e: Error): string {
  try { const j = JSON.parse(e.message) as { error?: string }; if (j.error) return j.error } catch { /* not JSON */ }
  return e.message || 'Something went wrong. Try again.'
}
