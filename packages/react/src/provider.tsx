import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Action, Card, CardDecision, Page, Suggestions, TeovoMessage, ThreadSummary } from './types.js'

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
  children: ReactNode
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
  /** The page the assistant is told about with each message (set by useAssistantContext). */
  page: Page | undefined
  /** Chips and hint for now: the screen's when the chat is idle, the follow-ups after a reply. */
  suggestions: Suggestions
  clearSuggestions: () => void
  /** Confirm, skip or undo a card. Resolves to the card as it is now; rejects with the sentence to show. */
  decideCard: (card: Card, decision: CardDecision) => Promise<Partial<Card>>
  /** Thumbs up or down on a reply (its metadata.runId), or null to take it back. */
  rate: (runId: string, value: 'up' | 'down' | null) => Promise<void>
  onAction: AssistantProviderProps['onAction']
}

const Ctx = createContext<AssistantState | null>(null)

export function AssistantProvider(props: AssistantProviderProps) {
  const [threadId, setThreadId] = useState(props.threadId)
  const thread = useRef(props.threadId)
  const page = useRef<Page | undefined>(undefined)
  const [pageKey, setPageKey] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestions>({ suggestions: [] })
  const latest = useRef(props)
  latest.current = props

  const transport = useMemo(() => new DefaultChatTransport<TeovoMessage>({
    api: `${props.endpoint.replace(/\/$/, '')}/chat`,
    headers: async () => {
      const h = latest.current.headers
      return typeof h === 'function' ? await h() : (h ?? {})
    },
    // Only the new message goes up: the server keeps the history and checks it belongs to this person.
    prepareSendMessagesRequest: ({ messages }) => ({ body: { threadId: thread.current, message: messages.at(-1), page: page.current } }),
    fetch: async (input, init) => {
      const res = await (latest.current.fetch ?? fetch)(input, init)
      const id = res.headers.get('x-teovo-thread')
      if (id && id !== thread.current) {
        thread.current = id
        setThreadId(id)
        latest.current.onThread?.(id)
      }
      return res
    },
  }), [props.endpoint])

  const chat = useChat<TeovoMessage>({
    transport,
    onData: (part) => { if (part.type === 'data-suggestions') setSuggestions(part.data as Suggestions) },
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
    latest.current.onThread?.(id)   // so the app can remember it, and a reload continues this conversation
  }, [chat, request])

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
  const initial = useRef(props.threadId)
  useEffect(() => {
    const id = initial.current
    initial.current = undefined
    if (id) openThread(id).catch(() => { thread.current = undefined; setThreadId(undefined) })
  }, [openThread])

  const newChat = useCallback(() => {
    chat.stop()
    thread.current = undefined
    setThreadId(undefined)
    chat.setMessages([])
  }, [chat])

  const setPage = useCallback((p: Page | undefined) => {
    page.current = p
    setPageKey(JSON.stringify(p ?? null))
  }, [])
  const clearSuggestions = useCallback(() => setSuggestions({ suggestions: [] }), [])

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

  const currentPage = useMemo(() => (pageKey && pageKey !== 'null' ? JSON.parse(pageKey) as Page : undefined), [pageKey])
  const value = useMemo<AssistantState>(() => ({ chat, threadId, newChat, openThread, submitForm, request, setPage, page: currentPage, suggestions, clearSuggestions, decideCard, rate, onAction: props.onAction }),
    [chat, threadId, newChat, openThread, submitForm, request, setPage, currentPage, suggestions, clearSuggestions, decideCard, rate, props.onAction])
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
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
 * Tell the assistant which screen the user is on. Call it in each screen; the latest mounted screen wins,
 * and leaving the screen clears it.
 */
export function useAssistantContext(page: Page): void {
  const { setPage } = useAssistant()
  const { path, title } = page
  const type = page.record?.type, id = page.record?.id
  const state = page.state ? JSON.stringify(page.state) : ''
  useEffect(() => {
    setPage({ path, title, ...(type && id ? { record: { type, id } } : {}), ...(state ? { state: JSON.parse(state) as Page['state'] } : {}) })
    return () => setPage(undefined)
  }, [setPage, path, title, type, id, state])
}
