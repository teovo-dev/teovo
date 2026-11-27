import type { UIMessage } from 'ai'
import type { TenantSettings } from './settings.js'
import type { Proposal } from './tools.js'

export interface Thread { id: string; tenantId: string; userId: string; title: string | null; createdAt: string; updatedAt?: string }

export interface StoredCard extends Proposal {
  id: string
  threadId: string
  runId: string
  status: CardStatus
  createdAt?: string
  decidedBy?: string
  decidedAt?: string
  /** Set when the card was applied and the app can take it back. */
  reversible?: boolean
  /** What the app's undo needs, returned by its apply. Never sent to the browser. */
  undo?: unknown
  undoneAt?: string
  /**
   * Outside text the assistant had read in this run before preparing the card (e.g. 'customer note', 'picture').
   * The panel labels the card so the user checks it before confirming.
   */
  untrustedSources?: string[]
}

export type CardStatus = 'shown' | 'confirmed' | 'skipped' | 'undone' | 'expired' | 'waiting_for_approval'

/** The fields a decision changes. */
export type CardPatch = Partial<Pick<StoredCard, 'status' | 'decidedBy' | 'decidedAt' | 'reversible' | 'undo' | 'undoneAt'>>

/**
 * Where the kit keeps conversations and cards. @teovo/db provides the Postgres version; `memoryStorage` is for
 * tests and local trials. Every call is scoped to one tenant and one user: a thread is only ever found by the
 * person who started it.
 */
export interface Storage {
  getThread(tenantId: string, userId: string, threadId: string): Promise<Thread | null>
  createThread(tenantId: string, userId: string): Promise<Thread>
  /** This person's conversations, most recently active first, archived ones left out. */
  listThreads(tenantId: string, userId: string, limit: number): Promise<Thread[]>
  setThreadTitle(threadId: string, title: string): Promise<void>
  /** Hide a conversation from the list; it can no longer be continued. Returns false if it isn't theirs. */
  archiveThread(tenantId: string, userId: string, threadId: string): Promise<boolean>
  listMessages(threadId: string): Promise<UIMessage[]>
  saveMessages(threadId: string, messages: UIMessage[]): Promise<void>
  saveCard(card: StoredCard): Promise<void>
  /** A card, only if it is in one of this person's threads. */
  getCard(tenantId: string, userId: string, id: string): Promise<StoredCard | null>
  listCards(threadId: string): Promise<StoredCard[]>
  /**
   * Change a card only if its status is still one of `from`; returns the updated card, or null if someone
   * (a second tab, a double tap) got there first. This is what makes Confirm safe to press twice.
   */
  updateCard(id: string, from: CardStatus[], patch: CardPatch): Promise<StoredCard | null>

  /** A tenant's own settings, or null when it never saved any. */
  tenantSettings(tenantId: string): Promise<TenantSettings | null>
  saveTenantSettings(tenantId: string, settings: TenantSettings): Promise<void>

  // Run log and usage ledger.
  startRun(run: RunRecord): Promise<void>
  finishRun(id: string, end: { status: 'done' | 'failed' | 'stopped'; model?: string; error?: string }): Promise<void>
  saveStep(step: StepRecord): Promise<void>
  /** Number of this person's runs still running that started after `since` (older ones count as abandoned). */
  runningRuns(tenantId: string, userId: string, since: Date): Promise<number>
  addUsage(rows: UsageRow[]): Promise<void>
  /** Totals for the current day or month (UTC), for this person and for the whole tenant. */
  usage(tenantId: string, userId: string, period: Period): Promise<{ user: Totals; tenant: Totals }>
  /** Limits a tenant set for itself (user '' = the whole tenant) or for one person; they override the code's. */
  budgets(tenantId: string, userId: string): Promise<Budget[]>
}

/** 'neurons' is Cloudflare Workers AI's own cost unit, reported by @teovo/server/workers-ai. */
export type Unit = 'messages' | 'input_tokens' | 'output_tokens' | 'neurons'
export type Period = 'day' | 'month'
export type Totals = Partial<Record<Unit, number>>
export interface Budget { userId: string; unit: Unit; period: Period; limit: number }
export interface RunRecord { id: string; threadId: string; tenantId: string; userId: string; model?: string; promptVersion?: string }
export interface StepRecord {
  runId: string; seq: number; type: 'tool'; toolCallId?: string; name: string
  input?: unknown; output?: unknown; truncated: boolean; error?: string; durationMs: number
}
export interface UsageRow { tenantId: string; userId: string; runId?: string; provider: string; model: string; unit: Unit; amount: number }

/** The UTC day or month a moment falls in, as the key usage is summed under ('2026-11-27' / '2026-11'). */
export const periodKey = (period: Period, at = new Date()) => at.toISOString().slice(0, period === 'day' ? 10 : 7)

export interface MemoryRun extends RunRecord { status: 'running' | 'done' | 'failed' | 'stopped'; startedAt: Date; error?: string }

const strip = ({ archived: _, ...t }: Thread & { archived?: boolean }): Thread => ({ ...t })

export function memoryStorage() {
  const threads = new Map<string, Thread & { archived?: boolean }>()
  const messages = new Map<string, UIMessage[]>()
  const cards = new Map<string, StoredCard>()
  const runs = new Map<string, MemoryRun>()
  const steps: StepRecord[] = []
  const usageRows: (UsageRow & { at: Date })[] = []
  const budgetRows: (Budget & { tenantId: string })[] = []
  const settings = new Map<string, TenantSettings>()
  const sum = (rows: typeof usageRows) => {
    const t: Totals = {}
    for (const r of rows) t[r.unit] = (t[r.unit] ?? 0) + r.amount
    return t
  }
  const storage: Storage & { threads: typeof threads; messages: typeof messages; cards: typeof cards; runs: typeof runs; steps: typeof steps; usageRows: typeof usageRows; budgetRows: typeof budgetRows; settings: typeof settings } = {
    threads, messages, cards, runs, steps, usageRows, budgetRows, settings,
    async tenantSettings(tenantId) { const s = settings.get(tenantId); return s ? structuredClone(s) : null },
    async saveTenantSettings(tenantId, s) { settings.set(tenantId, structuredClone(s)) },
    async getThread(tenantId, userId, id) {
      const t = threads.get(id)
      return t && t.tenantId === tenantId && t.userId === userId && !t.archived ? strip(t) : null
    },
    async listThreads(tenantId, userId, limit) {
      return [...threads.values()].filter((t) => t.tenantId === tenantId && t.userId === userId && !t.archived)
        .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)).slice(0, limit).map(strip)
    },
    async setThreadTitle(id, title) { const t = threads.get(id); if (t) t.title = title },
    async archiveThread(tenantId, userId, id) {
      const t = threads.get(id)
      if (!t || t.tenantId !== tenantId || t.userId !== userId || t.archived) return false
      t.archived = true
      return true
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
      const t = threads.get(id)
      if (t) t.updatedAt = new Date().toISOString()
    },
    async saveCard(card) { cards.set(card.id, structuredClone({ createdAt: new Date().toISOString(), ...card })) },
    async getCard(tenantId, userId, id) {
      const c = cards.get(id)
      const t = c && threads.get(c.threadId)
      return c && t && t.tenantId === tenantId && t.userId === userId ? structuredClone(c) : null
    },
    async listCards(threadId) { return [...cards.values()].filter((c) => c.threadId === threadId).map((c) => structuredClone(c)) },
    async updateCard(id, from, patch) {
      const c = cards.get(id)
      if (!c || !from.includes(c.status)) return null
      Object.assign(c, structuredClone(patch))
      return structuredClone(c)
    },
    async startRun(run) { runs.set(run.id, { ...run, status: 'running', startedAt: new Date() }) },
    async finishRun(id, end) {
      const r = runs.get(id)
      if (r) Object.assign(r, { status: end.status, error: end.error, ...(end.model ? { model: end.model } : {}) })
    },
    async saveStep(step) { steps.push(structuredClone(step)) },
    async runningRuns(tenantId, userId, since) {
      return [...runs.values()].filter((r) => r.tenantId === tenantId && r.userId === userId && r.status === 'running' && r.startedAt > since).length
    },
    async addUsage(rows) { for (const r of rows) usageRows.push({ ...r, at: new Date() }) },
    async usage(tenantId, userId, period) {
      const key = periodKey(period)
      const now = usageRows.filter((r) => r.tenantId === tenantId && periodKey(period, r.at) === key)
      return { user: sum(now.filter((r) => r.userId === userId)), tenant: sum(now) }
    },
    async budgets(tenantId, userId) {
      return budgetRows.filter((b) => b.tenantId === tenantId && (b.userId === '' || b.userId === userId)).map(({ tenantId: _, ...b }) => b)
    },
  }
  return storage
}
