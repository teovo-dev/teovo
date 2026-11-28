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
  /** Only in the answer to a confirm, never stored: what applying it said, e.g. "Sale #12 saved". */
  note?: string
  /** Only in the answer to a confirm, never stored: where to see the result, e.g. { label: 'Open', to: '/sales/12' }. */
  link?: { label: string; to: string }
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
  /** Remove this message and every one after it (the user edited it, or asked for the reply again). */
  removeMessagesFrom(threadId: string, messageId: string): Promise<void>
  /** Save a new card. Saving one whose id already exists changes nothing: the first save (and its decision) stands. */
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
  /** Thumbs up (1) or down (-1) on a reply, or null to take it back; only by the person it answered. Returns false if not theirs. */
  rateRun(tenantId: string, userId: string, runId: string, rating: 1 | -1 | null, note?: string): Promise<boolean>
  saveStep(step: StepRecord): Promise<void>
  /**
   * A tenant's runs, newest first, for the run viewer (admins only). Optional: storages without it answer 501 there.
   * `before` (an ISO time) pages back.
   */
  listRuns?(tenantId: string, filter: RunFilter): Promise<RunSummary[]>
  /** One run of this tenant with its steps in order, or null. */
  getRun?(tenantId: string, runId: string): Promise<RunDetail | null>
  /** Number of this person's runs still running that started after `since` (older ones count as abandoned). */
  runningRuns(tenantId: string, userId: string, since: Date): Promise<number>
  addUsage(rows: UsageRow[]): Promise<void>
  /** Totals for the current day or month (UTC), for this person and for the whole tenant. */
  usage(tenantId: string, userId: string, period: Period): Promise<{ user: Totals; tenant: Totals }>
  /** Limits a tenant set for itself (user '' = the whole tenant) or for one person; they override the code's. */
  budgets(tenantId: string, userId: string): Promise<Budget[]>

  // Audit trail and miss log.
  addCardEvent(e: CardEvent): Promise<void>
  /** A tenant's card events, newest first; `before` (an ISO time) pages back, `userId` narrows to one person. */
  listCardEvents(tenantId: string, opts: { limit: number; before?: string; userId?: string }): Promise<CardEvent[]>
  addMiss(m: Miss): Promise<void>
  listMisses(tenantId: string, opts: { limit: number; before?: string }): Promise<Miss[]>

  /**
   * Delete a person's (or with no userId, a whole tenant's) conversations, cards, run log, usage detail, card events
   * and misses. Daily usage totals stay, so limits keep counting. Returns how many conversations went, and how many
   * pictures kept in its own tables (tv_files) went with them.
   */
  wipe(tenantId: string, userId?: string): Promise<{ threads: number; files?: number }>
}

export type CardEventKind = 'proposed' | 'confirmed' | 'skipped' | 'undone' | 'expired'
export interface CardEvent { cardId: string; threadId: string; tenantId: string; userId: string; kind: string; title: string; event: CardEventKind; at?: string }
export interface Miss { tenantId: string; userId: string; threadId?: string; runId?: string; question: string; reason: string; at?: string }

/** 'neurons' is Cloudflare Workers AI's own cost unit, reported by @teovo/server/workers-ai. */
export type Unit = 'messages' | 'input_tokens' | 'output_tokens' | 'neurons'
export type Period = 'day' | 'month'
export type Totals = Partial<Record<Unit, number>>
export interface Budget { userId: string; unit: Unit; period: Period; limit: number }
export interface RunRecord { id: string; threadId: string; tenantId: string; userId: string; model?: string; promptVersion?: string; /** The message it answers, cut to 300 characters. */ question?: string }
/**
 * One step of a run in the log: a tool call, or a reply a done-check refused (type 'check': name is the check,
 * input holds the refused words, error the problem).
 */
export interface StepRecord {
  runId: string; seq: number; type: 'tool' | 'check'; toolCallId?: string; name: string
  input?: unknown; output?: unknown; truncated: boolean; error?: string; durationMs: number
  /** When the step ended (set by the storage). */
  at?: string
}
export type RunStatus = 'running' | 'done' | 'failed' | 'stopped'
export interface RunFilter { limit: number; before?: string; userId?: string; status?: RunStatus; rating?: 1 | -1 }
/** A run as the run viewer lists it. */
export interface RunSummary {
  id: string; threadId: string; tenantId: string; userId: string; model?: string; promptVersion?: string
  status: RunStatus; startedAt: string; finishedAt?: string; error?: string
  rating?: 1 | -1 | null; ratingNote?: string
  /** The message it answers (cut to 300 characters); older runs have none. */
  question?: string
  /** The conversation's title. */
  title?: string | null
  /** What the run used, summed by unit. */
  usage: Totals
}
export interface RunDetail extends RunSummary { steps: StepRecord[] }
export interface UsageRow { tenantId: string; userId: string; runId?: string; provider: string; model: string; unit: Unit; amount: number }

/** The UTC day or month a moment falls in, as the key usage is summed under ('2026-11-27' / '2026-11'). */
export const periodKey = (period: Period, at = new Date()) => at.toISOString().slice(0, period === 'day' ? 10 : 7)

export interface MemoryRun extends RunRecord { status: RunStatus; startedAt: Date; finishedAt?: Date; error?: string; rating?: 1 | -1 | null; ratingNote?: string }

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
  const cardEvents: CardEvent[] = []
  const misses: Miss[] = []
  const sum = (rows: typeof usageRows) => {
    const t: Totals = {}
    for (const r of rows) t[r.unit] = (t[r.unit] ?? 0) + r.amount
    return t
  }
  const summary = (r: MemoryRun): RunSummary => ({
    id: r.id, threadId: r.threadId, tenantId: r.tenantId, userId: r.userId, status: r.status, startedAt: r.startedAt.toISOString(),
    ...(r.model ? { model: r.model } : {}), ...(r.promptVersion ? { promptVersion: r.promptVersion } : {}), ...(r.question ? { question: r.question } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt.toISOString() } : {}), ...(r.error ? { error: r.error } : {}),
    ...(r.rating !== undefined ? { rating: r.rating } : {}), ...(r.ratingNote ? { ratingNote: r.ratingNote } : {}),
    title: threads.get(r.threadId)?.title ?? null,
    usage: sum(usageRows.filter((u) => u.runId === r.id)),
  })
  const storage: Storage & { threads: typeof threads; messages: typeof messages; cards: typeof cards; runs: typeof runs; steps: typeof steps; usageRows: typeof usageRows; budgetRows: typeof budgetRows; settings: typeof settings; cardEvents: typeof cardEvents; misses: typeof misses } = {
    threads, messages, cards, runs, steps, usageRows, budgetRows, settings, cardEvents, misses,
    async addCardEvent(e) { cardEvents.push({ ...e, at: e.at ?? new Date().toISOString() }) },
    async listCardEvents(tenantId, o) {
      // Newest first; events in the same millisecond keep the order they happened in (as Postgres does by id).
      return cardEvents.map((e, i) => ({ e, i })).filter(({ e }) => e.tenantId === tenantId && (!o.userId || e.userId === o.userId) && (!o.before || e.at! < o.before))
        .sort((a, b) => b.e.at!.localeCompare(a.e.at!) || b.i - a.i).slice(0, o.limit).map(({ e }) => ({ ...e }))
    },
    async addMiss(m) { misses.push({ ...m, at: m.at ?? new Date().toISOString() }) },
    async listMisses(tenantId, o) {
      return misses.map((m, i) => ({ m, i })).filter(({ m }) => m.tenantId === tenantId && (!o.before || m.at! < o.before))
        .sort((a, b) => b.m.at!.localeCompare(a.m.at!) || b.i - a.i).slice(0, o.limit).map(({ m }) => ({ ...m }))
    },
    async wipe(tenantId, userId) {
      const mine = (x: { tenantId: string; userId: string }) => x.tenantId === tenantId && (userId === undefined || x.userId === userId)
      let n = 0
      for (const [id, t] of threads) {
        if (!mine(t)) continue
        threads.delete(id); messages.delete(id); n++
        for (const [cid, c] of cards) if (c.threadId === id) cards.delete(cid)
      }
      for (const [id, r] of runs) if (mine(r)) { runs.delete(id); for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.runId === id) steps.splice(i, 1) }
      // Usage rows are this store's daily totals too, so they stay (limits keep counting), as in Postgres.
      for (let i = cardEvents.length - 1; i >= 0; i--) if (mine(cardEvents[i]!)) cardEvents.splice(i, 1)
      for (let i = misses.length - 1; i >= 0; i--) if (mine(misses[i]!)) misses.splice(i, 1)
      return { threads: n }
    },
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
    async removeMessagesFrom(id, messageId) {
      const list = messages.get(id) ?? []
      const at = list.findIndex((m) => m.id === messageId)
      if (at >= 0) messages.set(id, list.slice(0, at))
    },
    async saveCard(card) { if (!cards.has(card.id)) cards.set(card.id, structuredClone({ createdAt: new Date().toISOString(), ...card })) },
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
      if (r) Object.assign(r, { status: end.status, error: end.error, finishedAt: new Date(), ...(end.model ? { model: end.model } : {}) })
    },
    async saveStep(step) { steps.push(structuredClone({ ...step, at: new Date().toISOString() })) },
    async listRuns(tenantId, f) {
      return [...runs.values()]
        .filter((r) => r.tenantId === tenantId && (!f.userId || r.userId === f.userId) && (!f.status || r.status === f.status) && (!f.rating || r.rating === f.rating) && (!f.before || r.startedAt.toISOString() < f.before))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, f.limit).map(summary)
    },
    async getRun(tenantId, id) {
      const r = runs.get(id)
      if (!r || r.tenantId !== tenantId) return null
      return { ...summary(r), steps: steps.filter((s) => s.runId === id).sort((a, b) => a.seq - b.seq).map((s) => structuredClone(s)) }
    },
    async rateRun(tenantId, userId, runId, rating, note) {
      const r = runs.get(runId)
      if (!r || r.tenantId !== tenantId || r.userId !== userId) return false
      r.rating = rating
      r.ratingNote = note
      return true
    },
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
