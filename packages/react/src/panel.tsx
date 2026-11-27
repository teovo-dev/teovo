import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { readFile, useRecorder, useVoice, type PendingFile } from './input.js'
import { Markdown } from './markdown.js'
import { themeStyle, type Theme } from './sheet.js'
import { useAssistant } from './provider.js'
import type { Action, AllowanceItem, Card, CardDecision, Formats, Page, Sources, Step, TeovoMessage, View } from './types.js'
import { defaultViews, formatValue, isCurrent, type CellFormat, type ViewComponent } from './views.js'

export interface AssistantPanelProps {
  /** Shown before the first message. */
  welcome?: ReactNode
  placeholder?: string
  /** Draw the reply text yourself. Default: Teovo's small, HTML-free Markdown for replies, plain text for the user's own. */
  renderText?: (text: string) => ReactNode
  /** Colours, radius and font as CSS variables; see styles.css. */
  theme?: Theme
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
  /**
   * Turn speech into text with the app's own service instead of the browser's: the microphone button records, and
   * the recording is passed here. Return the text to put in the message box; throw to show an error.
   */
  transcribe?: (audio: Blob) => Promise<string>
  /** Draw a button the assistant offered yourself (e.g. a real link, so phones open WhatsApp without a popup block). */
  renderAction?: (action: Action) => ReactNode
  /** Show suggestion chips above the input. Default true (they only appear when the server has some). */
  showSuggestions?: boolean
  /**
   * The line above the message box that says which page the assistant sees, e.g. "On Orders · filter: unpaid".
   * Default on, whenever the app reports a page with useAssistantContext. Pass false to hide it, or a function to word it.
   */
  pageLabel?: false | ((page: Page) => ReactNode)
  /** A quiet line above the message box when little of the allowance is left ("8 messages left today"). Default true. */
  showAllowance?: boolean
  className?: string
}

export type CardState = { status: 'open' | 'busy' | 'confirmed' | 'skipped' | 'undone' | 'expired'; reversible?: boolean; error?: string }

/** A ready-made chat panel. Unstyled apart from `tv-` class names; import '@teovo/react/styles.css' for defaults. */
export function AssistantPanel(props: AssistantPanelProps) {
  const { chat, newChat, suggestions, clearSuggestions, page, policy, noticeAccepted, acceptNotice, allowance, words } = useAssistant()
  const [text, setText] = useState('')
  const busy = chat.status === 'submitted' || chat.status === 'streaming'
  const log = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)   // at the bottom: keep following new text
  const count = chat.messages.length
  const lastUser = chat.messages.map((m) => m.role).lastIndexOf('user')
  useEffect(() => { pinned.current = true }, [lastUser])   // the user just sent something: follow the reply
  useLayoutEffect(() => {
    const el = log.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  // The empty box shows the screen's example questions in turn; Tab takes the one showing.
  const examples = suggestions.examples ?? []
  const [exampleAt, setExampleAt] = useState(0)
  useEffect(() => {
    setExampleAt(0)
    if (examples.length < 2) return
    const t = setInterval(() => setExampleAt((i) => (i + 1) % examples.length), 3500)
    return () => clearInterval(t)
  }, [examples.join('|')])   // eslint-disable-line react-hooks/exhaustive-deps
  const hint = examples.length ? examples[exampleAt % examples.length] : suggestions.placeholder
  const [phrases, setPhrases] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('teovo-phrases') ?? '[]') as string[] } catch { return [] } })
  const completion = complete(text, words, phrases)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [stopped, setStopped] = useState<Set<string>>(() => new Set())
  function stop() {
    const last = chat.messages.at(-1)
    if (last?.role === 'assistant') setStopped((s) => new Set(s).add(last.id))
    void chat.stop()
  }
  const [fileError, setFileError] = useState<string>()
  const picker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {   // grow with the text, up to the CSS max-height
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])
  const attach = props.attach && policy.pictures ? (props.attach === true ? {} : props.attach) : null
  const low = props.showAllowance === false ? null : allowanceNote(allowance)
  const addSaid = (said: string) => setText((t) => (t ? `${t} ${said}` : said))
  const browserVoice = useVoice(addSaid, props.voiceLang)
  const recorded = useRecorder(addSaid, props.transcribe)
  const voice = props.transcribe ? recorded : { ...browserVoice, working: false }

  function ask(t: string) {
    if ((!t.trim() && !files.length) || busy || (policy.notice && !noticeAccepted)) return
    // Remember what this person writes, so it can be completed next time (on this device only).
    const said = t.trim()
    if (said.length >= 6 && said.length <= 80) {
      const next = [said, ...phrases.filter((p) => p !== said)].slice(0, 40)
      setPhrases(next)
      try { localStorage.setItem('teovo-phrases', JSON.stringify(next)) } catch { /* fine without */ }
    }
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
    <section className={`tv-panel ${props.className ?? ''}`} aria-label="Assistant" data-theme={props.theme?.mode} style={themeStyle(props.theme)}>
      <div ref={log} className="tv-messages" role="log" aria-live="polite" data-count={count}
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
        {chat.messages.length === 0 && props.welcome ? <div className="tv-welcome">{props.welcome}</div> : null}
        {chat.messages.map((m, i) => <Message key={m.id} message={m} ask={ask} stopped={stopped.has(m.id) || m.metadata?.stopped === true}
          last={i === chat.messages.length - 1} busy={busy} {...props} />)}
        {busy && !showsSomething(chat.messages.at(-1)) ? <div className="tv-thinking" role="status" aria-label="Thinking"><span /><span /><span /></div> : null}
        {chat.error ? <div className="tv-error" role="alert">{errorText(chat.error)}</div> : null}
      </div>
      {props.showSuggestions !== false && !busy && suggestions.suggestions.length && !(policy.notice && !noticeAccepted) ? (
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
      {policy.notice && !noticeAccepted ? (
        <div className="tv-notice" role="region" aria-label="About this assistant">
          <p>{policy.notice}</p>
          <button type="button" className="tv-btn tv-btn-primary" onClick={acceptNotice}>I understand</button>
        </div>
      ) : null}
      {low ? <div className="tv-allowance" role="status">{low}</div> : null}
      <form className="tv-input" onSubmit={send} aria-disabled={Boolean(policy.notice && !noticeAccepted)}>
        {page && props.pageLabel !== false && (page.title || page.path) ? (
          <div className="tv-page" title="The assistant sees this page and answers about it">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" />
            </svg>
            <span>{props.pageLabel ? props.pageLabel(page) : pageText(page)}</span>
          </div>
        ) : null}
        {completion ? (
          <button type="button" className="tv-complete" onClick={() => { setText(completion.full); box.current?.focus() }}
            aria-label={`Complete: ${completion.word}`} title="Tab">
            <kbd aria-hidden="true">Tab ↹</kbd> {completion.word}
          </button>
        ) : null}
        <div className="tv-composer">
          <textarea
            ref={box}
            aria-label="Message"
            value={text}
            placeholder={hint ? `${hint}  (Tab)` : (props.placeholder ?? 'Ask anything')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && !text && hint) { e.preventDefault(); setText(hint) }   // accept the hint, like autocomplete
              else if (e.key === 'Tab' && completion) { e.preventDefault(); setText(completion.full) }
              else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e)
            }}
            rows={1}
          />
          <div className="tv-composer-bar">
            {attach ? (
              <>
                <input ref={picker} type="file" hidden multiple accept={attach.accept ?? 'image/jpeg,image/png,image/webp'} aria-label="Attach pictures"
                  onChange={(e) => void pick(e.target.files)} />
                <button type="button" className="tv-icon tv-attach" aria-label="Attach a picture" title="Attach a picture" onClick={() => picker.current?.click()}>{icons.attach}</button>
              </>
            ) : null}
            {props.voice !== false && voice.supported && !busy ? (
              <button type="button" className="tv-icon tv-mic" aria-pressed={voice.listening} disabled={voice.working}
                aria-label={voice.working ? 'Writing down what you said' : voice.listening ? 'Stop listening' : 'Speak'}
                title={voice.working ? 'Writing down what you said…' : voice.listening ? 'Stop listening' : 'Speak'} onClick={() => void voice.toggle()}>
                {voice.listening ? icons.stop : icons.mic}
              </button>
            ) : null}
            {chat.messages.length > 0 && !busy ? (
              <button type="button" className="tv-icon tv-new" aria-label="New chat" title="Start a new chat" onClick={newChat}>{icons.plus}<span aria-hidden="true">New chat</span></button>
            ) : null}
            {busy
              ? <button type="button" className="tv-send tv-stop" aria-label="Stop" title="Stop" onClick={stop}>{icons.stop}</button>
              : <button type="submit" className="tv-send" aria-label="Send" title="Send (Enter)" disabled={!text.trim() && !files.length}>{icons.send}</button>}
          </div>
        </div>
      </form>
    </section>
  )
}

function Message({ message, ask, stopped, last, busy, ...props }: { message: TeovoMessage; ask: (t: string) => void; stopped?: boolean; last: boolean; busy: boolean } & AssistantPanelProps) {
  const { onAction, submitForm, chat } = useAssistant()
  const [editing, setEditing] = useState<string | null>(null)
  const ownText = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
  if (editing !== null) {
    return (
      <form className="tv-message tv-user tv-editing" onSubmit={(e) => { e.preventDefault(); if (editing.trim()) { setEditing(null); void chat.sendMessage({ text: editing.trim(), messageId: message.id }) } }}>
        <textarea aria-label="Edit your message" value={editing} autoFocus onFocus={(e) => e.currentTarget.select()} rows={Math.min(6, editing.split('\n').length + 1)}
          onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null) }} />
        <div className="tv-edit-buttons">
          <button type="button" className="tv-btn" onClick={() => setEditing(null)}>Cancel</button>
          <button type="submit" className="tv-btn tv-btn-primary" disabled={!editing.trim()}>Send again</button>
        </div>
        <p className="tv-edit-note">The replies after it are replaced.</p>
      </form>
    )
  }
  const steps = message.parts.filter((p) => p.type === 'data-step')
  const running = steps.filter((p) => (p.data as Step).state === 'running')
  return (
    <div className={`tv-message tv-${message.role}`} data-role={message.role}>
      {message.parts.map((p, i) => {
        if (p.type === 'text') {
          if (!p.text) return null
          const drawn = props.renderText ? props.renderText(p.text) : message.role === 'assistant' ? <Markdown text={p.text} /> : p.text
          return <div key={i} className="tv-text">{drawn}</div>
        }
        if (p.type === 'file') {
          return p.mediaType.startsWith('image/')
            ? (p.url.startsWith('teovo-file:')
              ? <StoredPicture key={i} id={p.url.slice('teovo-file:'.length)} alt={p.filename ?? 'Picture'} />
              : <img key={i} className="tv-attachment" src={p.url} alt={p.filename ?? 'Picture'} />)
            : <div key={i} className="tv-attachment">{p.filename ?? 'File'}</div>
        }
        if (p.type === 'data-card') return <CardView key={p.id ?? i} card={p.data as Card} formats={message.metadata?.formats} {...props} />
        if (p.type === 'data-view') {
          const v = p.data as View
          const Draw = props.views?.[v.view] ?? defaultViews[v.view]
          if (!Draw) return null
          const id = p.id ?? String(i)
          return <Draw key={id} part={{ ...v, id }} current={isCurrent(chat.messages, message.id)} ask={ask} formats={message.metadata?.formats}
            submit={(values) => submitForm(message.id, id, values)} />
        }
        if (p.type === 'data-sources') {
          const links = (p.data as Sources).links ?? []
          if (!links.length) return null
          return (
            <div key={p.id ?? i} className="tv-sources">
              <span>From:</span>
              {links.map((l) => (
                <button key={l.to} type="button" className="tv-source" onClick={() => onAction?.({ label: l.label, action: 'navigate', args: { to: l.to } })}>{l.label}</button>
              ))}
            </div>
          )
        }
        if (p.type === 'data-action') {
          const a = p.data as Action
          if (props.renderAction) return <span key={p.id ?? i} className="tv-action-own">{props.renderAction(a)}</span>
          return <button key={p.id ?? i} type="button" className="tv-action" onClick={() => onAction?.(a)}>{a.label}</button>
        }
        return null
      })}
      {running.map((p) => {
        const name = (p.data as Step).name
        return <div key={p.id} className="tv-step">{props.stepLabels?.[name] ?? `Using ${name.replace(/_/g, ' ')}`}…</div>
      })}
      {stopped ? <div className="tv-stopped">Stopped</div> : null}
      {!busy && message.role === 'user' && ownText ? (
        <div className="tv-msg-actions">
          <button type="button" className="tv-icon tv-icon-sm" aria-label="Edit and send again" title="Edit and send again" onClick={() => setEditing(ownText)}>{icons.edit}</button>
        </div>
      ) : null}
      {!(busy && last) && message.role === 'assistant' ? <ReplyActions message={message} last={last} text={ownText} /> : null}
    </div>
  )
}

/** Under a finished reply: copy it, rate it, and (the latest one) ask for it again. */
function ReplyActions({ message, last, text }: { message: TeovoMessage; last: boolean; text: string }) {
  const { chat, rate } = useAssistant()
  const [copied, setCopied] = useState(false)
  const [rating, setRating] = useState<'up' | 'down' | null>(null)
  const [error, setError] = useState<string>()
  const runId = message.metadata?.runId
  async function give(v: 'up' | 'down') {
    if (!runId) return
    const next = rating === v ? null : v
    const before = rating
    setRating(next)
    setError(undefined)
    try { await rate(runId, next) } catch (e) { setRating(before); setError(e instanceof Error ? e.message : String(e)) }
  }
  return (
    <div className="tv-msg-actions">
      {text ? (
        <button type="button" className="tv-icon tv-icon-sm" aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}
          onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>
          {copied ? icons.check : icons.copy}
        </button>
      ) : null}
      {runId ? (
        <>
          <button type="button" className="tv-icon tv-icon-sm" aria-label="Good answer" title="Good answer" aria-pressed={rating === 'up'} onClick={() => void give('up')}>{icons.up}</button>
          <button type="button" className="tv-icon tv-icon-sm" aria-label="Bad answer" title="Bad answer" aria-pressed={rating === 'down'} onClick={() => void give('down')}>{icons.down}</button>
        </>
      ) : null}
      {last ? <button type="button" className="tv-icon tv-icon-sm" aria-label="Try again" title="Try again" onClick={() => void chat.regenerate()}>{icons.again}</button> : null}
      {error ? <span className="tv-error" role="alert">{error}</span> : null}
    </div>
  )
}

const FINAL = { confirmed: 'confirmed', skipped: 'skipped', undone: 'undone', expired: 'expired' } as const
const AFTER = { confirm: 'confirmed', skip: 'skipped', undo: 'undone' } as const

/**
 * A picture kept in the server's file store. Fetched with the provider's headers (so header-based sign-in works,
 * which a plain <img src> can't do) and shown from a local blob URL.
 */
function StoredPicture({ id, alt }: { id: string; alt: string }) {
  const { request } = useAssistant()
  const [src, setSrc] = useState<string>()
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let url: string | undefined
    let live = true
    request(`/files/${encodeURIComponent(id)}`).then(async (res) => {
      if (!res.ok) { if (live) setGone(true); return }
      url = URL.createObjectURL(await res.blob())
      if (live) setSrc(url)
    }).catch(() => { if (live) setGone(true) })
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [id, request])
  if (gone) return <div className="tv-attachment tv-attachment-gone">{alt} (no longer kept)</div>
  return src ? <img className="tv-attachment" src={src} alt={alt} /> : <div className="tv-attachment tv-attachment-loading" aria-label={`Loading ${alt}`} />
}

function CardView({ card, renderCard, formats }: { card: Card; formats?: Formats } & AssistantPanelProps) {
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
  const fields: NonNullable<Card['fields']> = card.fields ?? [...new Set([...Object.keys(card.after ?? {}), ...Object.keys(card.before ?? {})])].map((key) => ({ key }))
  // A new record has nothing before: show its values, not "— → value" on every row.
  const isNew = !card.before || Object.values(card.before).every((v) => v === undefined || v === null || v === '')
  const value = (v: unknown, format?: CellFormat) => {
    if (v === undefined || v === null || v === '') return '—'
    if (typeof v === 'object') return JSON.stringify(v)
    const f = format ?? (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date' : undefined)
    return formatValue(typeof v === 'boolean' ? String(v) : (v as string | number), f, formats)
  }
  return (
    <div className="tv-card" data-status={state.status} role="group" aria-label={card.title}>
      <div className="tv-card-title">{card.title}</div>
      {card.untrustedSources?.length ? (
        <div className="tv-card-untrusted" role="note">
          Prepared after reading {card.untrustedSources.join(', ')}. Check it before you confirm.
        </div>
      ) : null}
      {fields.length ? (
        <table className={`tv-card-diff${isNew ? ' tv-card-new' : ''}`}><tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <th scope="row">{f.label ?? labelFor(f.key)}</th>
              {isNew ? <td>{value(card.after?.[f.key], f.format)}</td>
                : <><td>{value(card.before?.[f.key], f.format)}</td><td aria-label="becomes">→</td><td>{value(card.after?.[f.key], f.format)}</td></>}
            </tr>
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

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)
const icons = {
  attach: svg(<path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />),
  mic: svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  send: svg(<path d="M12 19V5M5 12l7-7 7 7" />),
  stop: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>,
  plus: svg(<path d="M12 5v14M5 12h14" />),
  edit: svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />),
  copy: svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>),
  check: svg(<path d="M5 12l5 5 9-10" />),
  up: svg(<path d="M7 10v11M7 10l4-7a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 17.6 21H7" />),
  down: svg(<path d="M17 14V3M17 14l-4 7a2 2 0 0 1-3-2l1-5H5a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 6.4 3H17" />),
  again: svg(<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5" />),
}

/** True when the reply on screen already shows text, a view, a card, a button or a running step. */
function showsSomething(m: TeovoMessage | undefined): boolean {
  if (!m || m.role !== 'assistant') return false
  return m.parts.some((p) => (p.type === 'text' && p.text.trim() !== '') || p.type === 'data-view' || p.type === 'data-card' || p.type === 'data-action'
    || (p.type === 'data-step' && (p.data as Step).state === 'running'))
}

/**
 * The best completion for what is being typed: a known word or name (or an earlier message) that the last one, two
 * or three words start, e.g. "chand b" → "Chand Bakers". Nothing until at least two letters, and never the same text.
 */
export function complete(text: string, words: readonly string[], phrases: readonly string[] = []): { word: string; full: string } | null {
  if (!text.trim() || /\s$/.test(text)) return null
  // A whole earlier message that this text starts.
  const lower = text.toLowerCase()
  const phrase = phrases.find((p) => p.length > text.length && p.toLowerCase().startsWith(lower) && text.length >= 3)
  if (phrase) return { word: phrase, full: phrase }
  const parts = text.split(/(\s+)/)
  for (let n = 3; n >= 1; n--) {
    const tail = parts.slice(-(n * 2 - 1)).join('')
    if (tail.trim().length < 2 || parts.length < n * 2 - 1) continue
    const t = tail.toLowerCase()
    const hit = words.find((w) => w.length > tail.length && w.toLowerCase().startsWith(t))
    if (hit) return { word: hit, full: text.slice(0, text.length - tail.length) + hit + ' ' }
  }
  return null
}

/** "2 messages left today", or for other units how much of it is used, once little is left. */
function allowanceNote(items: AllowanceItem[]): string | null {
  // Messages: when 20% or 3 or fewer are left (whichever comes first). Other units: 20%.
  const tight = items.map((a) => ({ ...a, left: Math.max(0, a.limit - a.used) }))
    .filter((a) => a.left <= (a.unit === 'messages' ? Math.max(a.limit * 0.2, 3) : a.limit * 0.2))
    .sort((a, b) => a.left / a.limit - b.left / b.limit)[0]
  if (!tight) return null
  const when = tight.period === 'day' ? 'today' : 'this month'
  const whose = tight.scope === 'tenant' ? 'Your team has' : 'You have'
  if (tight.unit === 'messages') return `${whose} ${tight.left} ${tight.left === 1 ? 'message' : 'messages'} left ${when}.`
  return `${whose} used ${Math.min(100, Math.round((tight.used / tight.limit) * 100))}% of the assistant allowance for ${when}.`
}

/** 'amount_due' → 'Amount due', 'customerName' → 'Customer name'. */
const labelFor = (key: string) => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "On Orders · filter: unpaid", from what the app reported. */
export function pageText(page: Page): string {
  const where = page.title || page.path || ''
  const extra = Object.entries(page.state ?? {})
    .filter(([, v]) => v !== null && v !== '' && v !== false)
    .slice(0, 3)
    .map(([k, v]) => (v === true ? k : `${k}: ${String(v)}`))
  return [`On ${where}`, ...extra].join(' · ')
}

const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** Server errors arrive as JSON ({ error }) or plain text; show the sentence, not the JSON. */
function errorText(e: Error): string {
  try { const j = JSON.parse(e.message) as { error?: string }; if (j.error) return j.error } catch { /* not JSON */ }
  return e.message || 'Something went wrong. Try again.'
}
