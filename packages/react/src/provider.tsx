import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { readFile } from './input.js'
import type { Action, AllowanceItem, Card, CardDecision, Page, Policy, Suggestions, TeovoMessage, ThreadSummary } from './types.js'

export interface AssistantProviderProps {
  /** Where the app mounted the server handler, e.g. '/api/assistant'. The panel posts to `${endpoint}/chat`. */
  endpoint: string
  /** Continue an earlier conversation. Omitted: the first message starts a new one. */
  threadId?: string
  /** Called when a conversation starts or an earlier one is opened, so the app can remember it (e.g. in the URL). */
  onThread?: (threadId: string) => void
  /** Extra headers on every request (e.g. the app's auth token or tenant id). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /**
   * Replace how Confirm, Skip and Undo reach the app. Default: POST `${endpoint}/cards/:id/:decision`, which
   * runs the appliers given to createAssistant({ cards }). Throw to show the error on the card. Return { reversible: true }
   * when the app can undo it. After it succeeds the decision is recorded on the server (mark the kind { inApp: true }).
   */
  onCard?: (card: Card, decision: CardDecision) => Promise<Partial<Card> | void> | Partial<Card> | void
  /** The user pressed a button the assistant offered (open a screen, run an app action). */
  onAction?: (action: Action) => void
  /** Replace fetch, e.g. in tests or to call the handler in-process. */
  fetch?: typeof fetch
  /**
   * Remember the open conversation in this browser, so a reload continues it: the localStorage key, e.g. one per
   * business ('shop.chat.' + businessId). Default 'teovo:thread'. false: don't. A threadId passed in wins.
   */
  rememberThread?: string | false
  /** Whether the chat starts open, until the person opens or closes it (remembered for the browser tab). Default false. */
  defaultOpen?: boolean
  children: ReactNode
}

/** Read and write browser storage; private mode or blocked storage just means nothing is remembered. */
const store = {
  get: (s: 'local' | 'session', key: string): string | null => { try { return (s === 'local' ? localStorage : sessionStorage).getItem(key) } catch { return null } },
  set: (s: 'local' | 'session', key: string, value: string | null) => {
    try { const st = s === 'local' ? localStorage : sessionStorage; if (value === null) st.removeItem(key); else st.setItem(key, value) } catch { /* not remembered */ }
  },
}

interface AssistantState {
  chat: ReturnType<typeof useChat<TeovoMessage>>
  threadId: string | undefined
  /** Start a fresh conversation: clears the messages; the next message creates a new thread. */
  newChat: () => void
  /** Load an earlier conversation into the panel; the next message continues it. Rejects with the sentence to show. */
  openThread: (id: string) => Promise<void>
  /** Send a form the assistant showed. The server turns it into a card, which appears under the form. */
  submitForm: (messageId: string, viewId: string, values: Record<string, unknown>) => Promise<void>
  /** Calls the handler: path under the endpoint, with the provider's headers and fetch. */
  request: (path: string, init?: RequestInit) => Promise<Response>
  setPage: (page: Page | undefined) => void
  /** Used by useAssistantContext: one screen's page under its key, or undefined to drop it. */
  registerPage: (key: string, page: Page | undefined, fallback?: boolean) => void
  /** The page the assistant is told about with each message (set by useAssistantContext). */
  page: Page | undefined
  /** Chips and hint for now: the screen's when the chat is idle, the follow-ups after a reply. */
  suggestions: Suggestions
  clearSuggestions: () => void
  /** Confirm, skip or undo a card. Resolves to the card as it is now; rejects with the sentence to show. */
  decideCard: (card: Card, decision: CardDecision) => Promise<Partial<Card>>
  /** Thumbs up or down on a reply (its metadata.runId), or null to take it back. */
  rate: (runId: string, value: 'up' | 'down' | null) => Promise<void>
  /** The tenant's notice, if any, and whether pictures may be sent. */
  policy: Policy
  /** True once this person has accepted the current notice (or there is none). */
  noticeAccepted: boolean
  acceptNotice: () => void
  /** Every limit that applies, with how much is used (refreshed after each reply). */
  allowance: AllowanceItem[]
  /** The app's words the message box completes (GET …/completions). */
  words: string[]
  onAction: AssistantProviderProps['onAction']
  /** Run a button the assistant offered: the app's onAction, then (a screen opened on a phone) the chat closes. */
  runAction: (action: Action) => void
  /** Whether the chat is open (AssistantSheet follows this unless the app controls it). */
  open: boolean
  setOpen: (open: boolean) => void
  /** What the panel shows: the conversation, or the list of earlier ones. */
  view: 'chat' | 'history'
  setView: (view: 'chat' | 'history') => void
  /** Open the chat and send this, with pictures if given, e.g. from a button on a screen or a shared screenshot. */
  ask: (text?: string, opts?: { files?: (File | Blob)[] }) => Promise<void>
  /** Stop telling the assistant about the screen the user is on, until they move to another one. */
  leaveOutPage: () => void
  /** True while the user has left the current screen out. */
  pageLeftOut: boolean
  /** Set by AssistantSheet: whether the open chat covers the page (a phone's bottom sheet). */
  setCovering: (covering: boolean) => void
  /** Write a recording down (POST …/transcribe). Rejects with the sentence to show. Needs voice on the server. */
  transcribe: (audio: Blob) => Promise<string>
  /** Run a reader (POST …/read/:name): text, a picture or a recording in, its result out. Rejects with the sentence to show. */
  read: <T = unknown>(name: string, input: ReadInput) => Promise<T>
}

/** What a reader is given: text, a picture or recording (File/Blob), or both. */
export type ReadInput = string | File | Blob | { text?: string; file?: File | Blob }

async function dataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(s)}`
}

const Ctx = createContext<AssistantState | null>(null)

export function AssistantProvider(props: AssistantProviderProps) {
  const threadKey = props.rememberThread === false ? null : (props.rememberThread ?? 'teovo:thread')
  const keyRef = useRef(threadKey)
  keyRef.current = threadKey
  const remember = useCallback((id: string | null) => { if (keyRef.current) store.set('local', keyRef.current, id) }, [])
  const [startThread] = useState(() => props.threadId ?? (threadKey ? store.get('local', threadKey) ?? undefined : undefined))
  const [threadId, setThreadId] = useState(startThread)
  const thread = useRef(startThread)
  const [open, setOpenState] = useState(() => { const v = store.get('session', 'teovo:open'); return v === null ? props.defaultOpen === true : v === '1' })
  const setOpen = useCallback((v: boolean) => { setOpenState(v); store.set('session', 'teovo:open', v ? '1' : '0') }, [])
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const covering = useRef(false)
  const setCovering = useCallback((v: boolean) => { covering.current = v }, [])
  const [leftOut, setLeftOut] = useState<string | null>(null)
  const leftOutRef = useRef<string | null>(null)
  leftOutRef.current = leftOut
  const page = useRef<Page | undefined>(undefined)
  const [pageKey, setPageKey] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestions>({ suggestions: [] })
  const latest = useRef(props)
  latest.current = props
  // The tenant's notice (accepted per exact wording, remembered in this browser) and whether pictures are allowed.
  const [policy, setPolicy] = useState<Policy>({ pictures: true })
  const consent = useRef<string | undefined>(undefined)
  const [accepted, setAccepted] = useState(false)
  const [allowanceItems, setAllowance] = useState<AllowanceItem[]>([])
  const [words, setWords] = useState<string[]>([])

  const transport = useMemo(() => new DefaultChatTransport<TeovoMessage>({
    api: `${props.endpoint.replace(/\/$/, '')}/chat`,
    headers: async () => {
      const h = latest.current.headers
      return typeof h === 'function' ? await h() : (h ?? {})
    },
    // Only the new message goes up: the server keeps the history and checks it belongs to this person.
    prepareSendMessagesRequest: ({ messages }) => {
      const pg = page.current && page.current.path === leftOutRef.current ? undefined : page.current
      return { body: { threadId: thread.current, message: messages.at(-1), page: pg, ...(consent.current ? { consent: consent.current } : {}) } }
    },
    fetch: async (input, init) => {
      const res = await (latest.current.fetch ?? fetch)(input, init)
      const id = res.headers.get('x-teovo-thread')
      if (id && id !== thread.current) {
        thread.current = id
        setThreadId(id)
        remember(id)
        latest.current.onThread?.(id)
      }
      return res
    },
  }), [props.endpoint])

  const afterReply = useRef<() => void>(() => {})
  const chat = useChat<TeovoMessage>({
    transport,
    onData: (part) => { if (part.type === 'data-suggestions') setSuggestions(part.data as Suggestions) },
    onFinish: () => afterReply.current(),
    onError: () => afterReply.current(),   // a refused message (a limit) changes what is left too
  })

  // The screen's own suggestions: fetched when the panel opens, when the screen changes (also mid-conversation: the
  // user moved, so the last reply's follow-ups no longer fit), and on New chat.
  const empty = chat.messages.length === 0
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    // Not when a conversation merely starts: the reply brings its own follow-ups.
    if (!empty && shownFor.current === pageKey) return
    shownFor.current = pageKey
    let live = true
    void (async () => {
      const p = latest.current
      const q = new URLSearchParams()
      const pg = page.current
      if (pg?.path) q.set('path', pg.path)
      if (pg?.title) q.set('title', pg.title)
      if (pg?.record) { q.set('recordType', pg.record.type); q.set('recordId', pg.record.id) }
      try {
        const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {})
        const res = await (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}/suggestions?${q}`, { headers: h })
        if (res.ok && live) setSuggestions((await res.json()) as Suggestions)
      } catch { /* chips are a nicety; the panel works without them */ }
    })()
    return () => { live = false }
  }, [empty, pageKey, props.endpoint])

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const p = latest.current
    const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {})
    return (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}${path}`, { ...init, headers: { ...h, ...(init.headers as Record<string, string> | undefined) } })
  }, [])

  const openThread = useCallback(async (id: string) => {
    const res = await request(`/threads/${encodeURIComponent(id)}`)
    const body = (await res.json().catch(() => ({}))) as { messages?: TeovoMessage[]; error?: string }
    if (!res.ok || !body.messages) throw new Error(body.error ?? 'That conversation could not be opened.')
    chat.stop()
    thread.current = id
    setThreadId(id)
    chat.setMessages(body.messages)
    remember(id)
    latest.current.onThread?.(id)   // so the app can remember it, and a reload continues this conversation
  }, [chat, request, remember])

  const submitForm = useCallback(async (messageId: string, viewId: string, values: Record<string, unknown>) => {
    if (!thread.current) throw new Error('Send a message first.')
    const res = await request(`/threads/${thread.current}/views/${encodeURIComponent(viewId)}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }),
    })
    const body = (await res.json().catch(() => ({}))) as { card?: Card; error?: string }
    if (!res.ok || !body.card) throw new Error(body.error ?? 'The form could not be sent.')
    const card = body.card
    chat.setMessages((list) => list.map((m) => (m.id !== messageId ? m : {
      ...m,
      parts: m.parts.flatMap((p) => (p.type === 'data-view' && p.id === viewId
        ? [{ ...p, data: { ...p.data, submitted: card.id, values: values as Record<string, string> } }, { type: 'data-card' as const, id: card.id, data: card }]
        : [p])),
    })))
  }, [chat, request])

  // Continue the conversation the app passed in, e.g. from the URL.
  const initial = useRef(startThread)
  useEffect(() => {
    const id = initial.current
    initial.current = undefined
    // A remembered conversation that is gone (removed, or another person's on a shared browser): start fresh.
    if (id) openThread(id).catch(() => { if (thread.current === id) { thread.current = undefined; setThreadId(undefined) } remember(null) })
  }, [openThread, remember])

  const newChat = useCallback(() => {
    chat.stop()
    thread.current = undefined
    setThreadId(undefined)
    remember(null)
    chat.setMessages([])
    setView('chat')
  }, [chat, remember])

  const setPage = useCallback((p: Page | undefined) => {
    page.current = p
    setPageKey(JSON.stringify(p ?? null))
  }, [])
  // Pages from useAssistantContext calls. The newest one that isn't a fallback wins; a fallback (say, the layout
  // naming every screen) shows only while no screen names itself, whatever order React ran their effects in.
  const pages = useRef(new Map<string, { page: Page; fallback: boolean; seq: number }>())
  const pageSeq = useRef(0)
  const registerPage = useCallback((key: string, p: Page | undefined, fallback = false) => {
    const all = pages.current
    if (p) all.set(key, { page: p, fallback, seq: all.get(key)?.seq ?? ++pageSeq.current })
    else all.delete(key)
    const best = [...all.values()].sort((a, b) => Number(a.fallback) - Number(b.fallback) || b.seq - a.seq)[0]
    setPage(best?.page)
  }, [setPage])
  const clearSuggestions = useCallback(() => setSuggestions({ suggestions: [] }), [])

  useEffect(() => {
    let live = true
    request('/policy').then(async (res) => {
      if (!res.ok || !live) return
      const p = (await res.json()) as Policy
      setPolicy(p)
      const key = p.noticeId ? `teovo-notice:${p.noticeId}` : ''
      let ok = !p.notice
      try { ok ||= Boolean(key && localStorage.getItem(key)) } catch { /* storage off: ask again */ }
      consent.current = ok && p.noticeId ? p.noticeId : undefined
      setAccepted(ok)
    }).catch(() => {})
    return () => { live = false }
  }, [request, props.endpoint])

  // The app's words for completing as people type (customers, products, phrases): loaded once.
  useEffect(() => {
    let live = true
    request('/completions').then(async (res) => { if (res.ok && live) setWords(((await res.json()) as { words?: string[] }).words ?? []) }).catch(() => {})
    return () => { live = false }
  }, [request])

  const acceptNotice = useCallback(() => {
    if (!policy.noticeId) return
    try { localStorage.setItem(`teovo-notice:${policy.noticeId}`, new Date().toISOString()) } catch { /* still accepted for now */ }
    consent.current = policy.noticeId
    setAccepted(true)
  }, [policy.noticeId])

  // How much is left: on open, and after each reply finishes.
  const refreshAllowance = useCallback(() => {
    request('/allowance').then(async (res) => { if (res.ok) setAllowance(((await res.json()) as { allowance?: AllowanceItem[] }).allowance ?? []) }).catch(() => {})
  }, [request])
  useEffect(() => { refreshAllowance() }, [refreshAllowance])
  afterReply.current = refreshAllowance

  const rate = useCallback(async (runId: string, value: 'up' | 'down' | null) => {
    const res = await request(`/runs/${encodeURIComponent(runId)}/rating`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not save that.')
  }, [request])

  const decideCard = useCallback(async (card: Card, decision: CardDecision): Promise<Partial<Card>> => {
    const p = latest.current
    if (p.onCard) {
      const done = (await p.onCard(card, decision)) ?? {}
      // The app applied it; tell the server what happened, so the card keeps its state after a reload and the
      // assistant knows the outcome. Servers that apply cards themselves (no { inApp: true }) refuse this harmlessly.
      const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {})
      await (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}/cards/${card.id}/${decision}`, {
        method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ reversible: done.reversible === true }),
      }).catch(() => undefined)
      return done
    }
    const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {})
    const res = await (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}/cards/${card.id}/${decision}`, { method: 'POST', headers: h })
    const body = (await res.json().catch(() => ({}))) as { card?: Card; error?: string }
    if (!res.ok) throw new Error(body.error ?? 'Something went wrong. Nothing was changed.')
    return body.card ?? {}
  }, [])

  const parsedPage = useMemo(() => (pageKey && pageKey !== 'null' ? JSON.parse(pageKey) as Page : undefined), [pageKey])
  const pageLeftOut = Boolean(parsedPage?.path && parsedPage.path === leftOut)
  const currentPage = pageLeftOut ? undefined : parsedPage
  const leaveOutPage = useCallback(() => setLeftOut(page.current?.path ?? null), [])

  const runAction = useCallback((a: Action) => {
    latest.current.onAction?.(a)
    // On a phone the chat covers the screen it just opened: close it so the user sees that screen.
    if (a.action === 'navigate' && covering.current) setOpen(false)
  }, [setOpen])

  const ask = useCallback(async (text?: string, opts: { files?: (File | Blob)[] } = {}) => {
    setView('chat')
    setOpen(true)
    const files = await Promise.all((opts.files ?? []).map((f) => readFile(f instanceof File ? f : new File([f], 'picture.jpg', { type: f.type || 'image/jpeg' }))))
    const words = text?.trim() ?? ''
    if (!words && !files.length) return
    // Not over a reply that is still coming, and not before the person has accepted the notice: the chat is open for them.
    if (chat.status === 'streaming' || chat.status === 'submitted' || !accepted) return
    await chat.sendMessage({ text: words || 'What is this?', ...(files.length ? { files: files.map((f) => ({ type: 'file' as const, mediaType: f.mediaType, filename: f.name, url: f.url })) } : {}) })
  }, [chat, accepted, setOpen])

  const sentence = async (res: Response, fallback: string) => ((await res.json().catch(() => ({}))) as { error?: string }).error ?? fallback

  const transcribe = useCallback(async (audio: Blob) => {
    const res = await request('/transcribe', { method: 'POST', headers: { 'content-type': audio.type || 'audio/webm' }, body: audio })
    if (!res.ok) throw new Error(await sentence(res, 'Voice isn’t working right now. Type it instead.'))
    return ((await res.json()) as { text: string }).text
  }, [request])

  const read = useCallback(async <T,>(name: string, input: ReadInput): Promise<T> => {
    const given = typeof input === 'string' ? { text: input } : input instanceof Blob ? { file: input } : input
    const body: Record<string, unknown> = {}
    if (given.text?.trim()) body.text = given.text
    if (given.file) {
      const f = given.file
      if (f.type.startsWith('image/')) {
        // Pictures are made smaller first, like in the chat: phones take very large photos.
        const small = await readFile(f instanceof File ? f : new File([f], 'picture.jpg', { type: f.type }))
        body.image = { data: small.url, mediaType: small.mediaType }
      } else if (f.type.startsWith('audio/') || f.type.startsWith('video/')) {
        body.audio = { data: await dataUrl(f), mediaType: f.type.split(';')[0] }
      } else throw new Error('Use a picture or a recording.')
    }
    const res = await request(`/read/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(await sentence(res, 'Could not read that. Try again, or fill it in by hand.'))
    return ((await res.json()) as { result: T }).result
  }, [request])

  const value = useMemo<AssistantState>(() => ({ chat, threadId, newChat, openThread, submitForm, request, setPage, registerPage, page: currentPage, suggestions, clearSuggestions, decideCard, rate, policy, noticeAccepted: accepted, acceptNotice, allowance: allowanceItems, words, onAction: props.onAction,
    runAction, open, setOpen, view, setView, ask, leaveOutPage, pageLeftOut, setCovering, transcribe, read }),
    [chat, threadId, newChat, openThread, submitForm, request, setPage, registerPage, currentPage, suggestions, clearSuggestions, decideCard, rate, policy, accepted, acceptNotice, allowanceItems, words, props.onAction,
      runAction, open, setOpen, view, ask, leaveOutPage, pageLeftOut, setCovering, transcribe, read])
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

/** The assistant's name from the server's config, or undefined (also outside a provider). */
export function useAssistantName(): string | undefined {
  return useContext(Ctx)?.policy.name
}

/**
 * A reader from a screen: read(input) runs it; result, busy and error follow. E.g. "describe a product" fills the
 * form: const r = useReader<Draft>('product'); … await r.read(text).
 */
export function useReader<T = unknown>(name: string) {
  const { read: run } = useAssistant()
  const [result, setResult] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const read = useCallback(async (input: ReadInput): Promise<T | null> => {
    setBusy(true); setError(null)
    try { const r = await run<T>(name, input); setResult(r); return r }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null }
    finally { setBusy(false) }
  }, [run, name])
  const reset = useCallback(() => { setResult(null); setError(null) }, [])
  return { read, result, busy, error, reset }
}

/** The provider's state, or null outside one (for parts that also work on their own, like AssistantSheet). */
export function useOptionalAssistant(): AssistantState | null {
  return useContext(Ctx)
}

/** The conversation: messages, send, stop, status, newChat. For apps that draw their own panel. */
export function useAssistant(): AssistantState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAssistant must be used inside <AssistantProvider>')
  return v
}

/** This person's earlier conversations, newest first. Refreshes when a new conversation starts. */
export function useThreads(limit = 30) {
  const { request, threadId } = useAssistant()
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [error, setError] = useState<string>()
  const refresh = useCallback(async () => {
    try {
      const res = await request(`/threads?limit=${limit}`)
      const body = (await res.json()) as { threads?: ThreadSummary[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Could not load conversations.')
      setThreads(body.threads ?? [])
      setError(undefined)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [request, limit])
  useEffect(() => { void refresh() }, [refresh, threadId])
  const archive = useCallback(async (id: string) => {
    const res = await request(`/threads/${encodeURIComponent(id)}/archive`, { method: 'POST' })
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not remove it.')
    setThreads((t) => t.filter((x) => x.id !== id))
  }, [request])
  return { threads, error, refresh, archive }
}

/**
 * Tell the assistant which screen the user is on. Call it in each screen; the latest mounted screen wins, and leaving
 * the screen clears it. `fallback: true` is for one call high up (e.g. the layout naming every route): it is used
 * only while no screen names itself, so a record screen's "Order #4 · Kavya" always beats the layout's "An order".
 */
export function useAssistantContext(page: Page, opts: { fallback?: boolean } = {}): void {
  const { registerPage } = useAssistant()
  const key = useId()
  const { path, title } = page
  const type = page.record?.type, id = page.record?.id
  const state = page.state ? JSON.stringify(page.state) : ''
  const empty = !path && !title && !(type && id) && !state
  const fallback = opts.fallback === true
  useEffect(() => {
    registerPage(key, empty ? undefined : { path, title, ...(type && id ? { record: { type, id } } : {}), ...(state ? { state: JSON.parse(state) as Page['state'] } : {}) }, fallback)
    return () => registerPage(key, undefined)
  }, [registerPage, key, empty, fallback, path, title, type, id, state])
}
