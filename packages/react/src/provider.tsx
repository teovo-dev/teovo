import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Action, Card, CardDecision, Page, TeovoMessage } from './types'

export interface AssistantProviderProps {
  /** Where the app mounted the server handler, e.g. '/api/assistant'. The panel posts to `${endpoint}/chat`. */
  endpoint: string
  /** Continue an earlier conversation. Omitted: the first message starts a new one. */
  threadId?: string
  /** Called when the server starts a new conversation, so the app can remember it (e.g. in the URL). */
  onThread?: (threadId: string) => void
  /** Extra headers on every request (e.g. the app's auth token or tenant id). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /**
   * Replace how Confirm, Skip and Undo reach the app. Default: POST `${endpoint}/cards/:id/:decision`, which
   * runs the appliers given to createAssistant({ cards }). Throw to show the error on the card.
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
  setPage: (page: Page | undefined) => void
  /** Confirm, skip or undo a card. Resolves to the card as it is now; rejects with the sentence to show. */
  decideCard: (card: Card, decision: CardDecision) => Promise<Partial<Card>>
  onAction: AssistantProviderProps['onAction']
}

const Ctx = createContext<AssistantState | null>(null)

export function AssistantProvider(props: AssistantProviderProps) {
  const [threadId, setThreadId] = useState(props.threadId)
  const thread = useRef(props.threadId)
  const page = useRef<Page | undefined>(undefined)
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

  const chat = useChat<TeovoMessage>({ transport })

  const newChat = useCallback(() => {
    chat.stop()
    thread.current = undefined
    setThreadId(undefined)
    chat.setMessages([])
  }, [chat])

  const setPage = useCallback((p: Page | undefined) => { page.current = p }, [])

  const decideCard = useCallback(async (card: Card, decision: CardDecision): Promise<Partial<Card>> => {
    const p = latest.current
    if (p.onCard) return (await p.onCard(card, decision)) ?? {}
    const h = typeof p.headers === 'function' ? await p.headers() : (p.headers ?? {})
    const res = await (p.fetch ?? fetch)(`${p.endpoint.replace(/\/$/, '')}/cards/${card.id}/${decision}`, { method: 'POST', headers: h })
    const body = (await res.json().catch(() => ({}))) as { card?: Card; error?: string }
    if (!res.ok) throw new Error(body.error ?? 'Something went wrong. Nothing was changed.')
    return body.card ?? {}
  }, [])

  const value = useMemo<AssistantState>(() => ({ chat, threadId, newChat, setPage, decideCard, onAction: props.onAction }),
    [chat, threadId, newChat, setPage, decideCard, props.onAction])
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

/** The conversation: messages, send, stop, status, newChat. For apps that draw their own panel. */
export function useAssistant(): AssistantState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAssistant must be used inside <AssistantProvider>')
  return v
}

/**
 * Tell the assistant which screen the user is on. Call it in each screen; the latest mounted screen wins,
 * and leaving the screen clears it.
 */
export function useAssistantContext(page: Page): void {
  const { setPage } = useAssistant()
  const { path, title } = page
  useEffect(() => {
    const mine = { path, title }
    setPage(mine)
    return () => setPage(undefined)
  }, [setPage, path, title])
}
