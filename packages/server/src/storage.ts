import type { UIMessage } from 'ai'
import type { Proposal } from './tools'

export interface Thread { id: string; tenantId: string; userId: string; title: string | null; createdAt: string }

export interface StoredCard extends Proposal {
  id: string
  threadId: string
  runId: string
  status: 'shown' | 'confirmed' | 'skipped' | 'undone' | 'expired' | 'waiting_for_approval'
}

/**
 * Where the kit keeps conversations and cards. @teovo/db provides the Postgres version; `memoryStorage` is for
 * tests and local trials. Every call is scoped to one tenant and one user: a thread is only ever found by the
 * person who started it.
 */
export interface Storage {
  getThread(tenantId: string, userId: string, threadId: string): Promise<Thread | null>
  createThread(tenantId: string, userId: string): Promise<Thread>
  listMessages(threadId: string): Promise<UIMessage[]>
  saveMessages(threadId: string, messages: UIMessage[]): Promise<void>
  saveCard(card: StoredCard): Promise<void>
}

export function memoryStorage(): Storage & { threads: Map<string, Thread>; messages: Map<string, UIMessage[]>; cards: Map<string, StoredCard> } {
  const threads = new Map<string, Thread>()
  const messages = new Map<string, UIMessage[]>()
  const cards = new Map<string, StoredCard>()
  return {
    threads, messages, cards,
    async getThread(tenantId, userId, id) {
      const t = threads.get(id)
      return t && t.tenantId === tenantId && t.userId === userId ? t : null
    },
    async createThread(tenantId, userId) {
      const t = { id: crypto.randomUUID(), tenantId, userId, title: null, createdAt: new Date().toISOString() }
      threads.set(t.id, t)
      return t
    },
    async listMessages(id) { return structuredClone(messages.get(id) ?? []) },
    async saveMessages(id, list) {
      const byId = new Map((messages.get(id) ?? []).map((m) => [m.id, m]))
      for (const m of list) byId.set(m.id, structuredClone(m))
      messages.set(id, [...byId.values()])
    },
    async saveCard(card) { cards.set(card.id, structuredClone(card)) },
  }
}
