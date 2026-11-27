import { periodKey, type CardPatch, type Storage, type StoredCard, type Thread, type Totals, type Unit } from '@teovo/server'
import type { UIMessage } from 'ai'
import type { Query } from './migrate.js'

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined)
const card = (r: any): StoredCard => {
  const c: StoredCard = { id: r.id, threadId: r.thread_id, runId: r.run_id, kind: r.kind, title: r.title, payload: r.payload, status: r.status, createdAt: iso(r.created_at) }
  if (r.before) c.before = r.before
  if (r.after) c.after = r.after
  if (r.decided_by) c.decidedBy = r.decided_by
  if (r.decided_at) c.decidedAt = iso(r.decided_at)
  if (r.reversible !== null && r.reversible !== undefined) c.reversible = r.reversible
  if (r.undo !== null && r.undo !== undefined) c.undo = r.undo
  if (r.undone_at) c.undoneAt = iso(r.undone_at)
  return c
}
const COLUMN: Record<keyof CardPatch, string> = { status: 'status', decidedBy: 'decided_by', decidedAt: 'decided_at', reversible: 'reversible', undo: 'undo', undoneAt: 'undone_at' }

const thread = (r: any): Thread => ({ id: r.id, tenantId: r.tenant_id, userId: r.user_id, title: r.title, createdAt: new Date(r.created_at).toISOString() })

/**
 * Storage on Postgres through any query function (node-postgres Pool, a Drizzle/pg client, a Cloudflare
 * Hyperdrive client…). Run `migrate` first. Threads are only ever found by tenant and user together.
 */
export function postgresStorage(query: Query): Storage {
  return {
    async getThread(tenantId, userId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const r = await query('select * from tv_threads where id = $1 and tenant_id = $2 and user_id = $3 and archived_at is null', [id, tenantId, userId])
      return r.rows[0] ? thread(r.rows[0]) : null
    },
    async createThread(tenantId, userId) {
      const r = await query('insert into tv_threads (id, tenant_id, user_id) values ($1, $2, $3) returning *', [crypto.randomUUID(), tenantId, userId])
      return thread(r.rows[0])
    },
    async listMessages(threadId) {
      const r = await query('select id, role, parts, metadata from tv_messages where thread_id = $1 order by seq', [threadId])
      return r.rows.map((m) => ({ id: m.id, role: m.role, parts: m.parts, ...(m.metadata ? { metadata: m.metadata } : {}) }) as UIMessage)
    },
    async saveMessages(threadId, messages) {
      for (const m of messages) {
        await query(
          `insert into tv_messages (id, thread_id, role, parts, metadata) values ($1, $2, $3, $4, $5)
           on conflict (thread_id, id) do update set parts = excluded.parts, metadata = excluded.metadata`,
          [m.id, threadId, m.role, JSON.stringify(m.parts), m.metadata === undefined ? null : JSON.stringify(m.metadata)])
      }
    },
    async saveCard(c: StoredCard) {
      await query(
        `insert into tv_proposals (id, thread_id, run_id, kind, title, before, after, payload, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do update set status = excluded.status`,
        [c.id, c.threadId, c.runId, c.kind, c.title, json(c.before), json(c.after), json(c.payload), c.status])
    },
    async getCard(tenantId, userId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const r = await query(
        `select p.* from tv_proposals p join tv_threads t on t.id = p.thread_id where p.id = $1 and t.tenant_id = $2 and t.user_id = $3`, [id, tenantId, userId])
      return r.rows[0] ? card(r.rows[0]) : null
    },
    async listCards(threadId) {
      return (await query('select * from tv_proposals where thread_id = $1 order by created_at', [threadId])).rows.map(card)
    },
    async updateCard(id, from, patch) {
      // One statement: the status check and the change happen together, so two taps can't both win.
      const keys = Object.keys(patch) as (keyof CardPatch)[]
      const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 3}`)
      const values = keys.map((k) => (k === 'undo' ? json(patch.undo) : patch[k] ?? null))
      const r = await query(`update tv_proposals set ${sets.join(', ') || 'status = status'} where id = $1 and status = any($2) returning *`, [id, from, ...values])
      return r.rows[0] ? card(r.rows[0]) : null
    },
    async startRun(r) {
      await query('insert into tv_runs (id, thread_id, tenant_id, user_id, model, prompt_version) values ($1, $2, $3, $4, $5, $6)',
        [r.id, r.threadId, r.tenantId, r.userId, r.model ?? null, r.promptVersion ?? null])
    },
    async finishRun(id, end) {
      await query('update tv_runs set status = $2, model = coalesce($3, model), error = $4, finished_at = now() where id = $1', [id, end.status, end.model ?? null, end.error ?? null])
    },
    async saveStep(s) {
      await query(
        `insert into tv_run_steps (run_id, seq, type, tool_call_id, name, input, output, truncated, error, duration_ms) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [s.runId, s.seq, s.type, s.toolCallId ?? null, s.name, json(s.input), json(s.output), s.truncated, s.error ?? null, s.durationMs])
    },
    async runningRuns(tenantId, userId, since) {
      const r = await query(`select count(*)::int as n from tv_runs where tenant_id = $1 and user_id = $2 and status = 'running' and started_at > $3`, [tenantId, userId, since.toISOString()])
      return r.rows[0].n as number
    },
    async addUsage(rows) {
      const day = periodKey('day')
      for (const u of rows) {
        await query('insert into tv_usage (tenant_id, user_id, run_id, provider, model, unit, amount) values ($1, $2, $3, $4, $5, $6, $7)',
          [u.tenantId, u.userId, u.runId ?? null, u.provider, u.model, u.unit, u.amount])
        // One running total per person and one for the whole tenant (user ''), so limit checks read one row.
        await query(
          `insert into tv_usage_daily (tenant_id, user_id, day, unit, amount) values ($1, $2, $3, $4, $5), ($1, '', $3, $4, $5)
           on conflict (tenant_id, user_id, day, unit) do update set amount = tv_usage_daily.amount + excluded.amount`,
          [u.tenantId, u.userId, day, u.unit, u.amount])
      }
    },
    async usage(tenantId, userId, period) {
      const from = period === 'day' ? periodKey('day') : `${periodKey('month')}-01`
      const r = await query(
        `select user_id, unit, sum(amount)::float8 as amount from tv_usage_daily
         where tenant_id = $1 and user_id in ($2, '') and day >= $3::date group by user_id, unit`, [tenantId, userId, from])
      const user: Totals = {}, tenant: Totals = {}
      for (const row of r.rows) (row.user_id === '' ? tenant : user)[row.unit as Unit] = Number(row.amount)
      return { user, tenant }
    },
    async budgets(tenantId, userId) {
      const r = await query(`select user_id, unit, period, "limit"::float8 as "limit" from tv_budgets where tenant_id = $1 and user_id in ($2, '')`, [tenantId, userId])
      return r.rows.map((b) => ({ userId: b.user_id, unit: b.unit, period: b.period, limit: Number(b.limit) }))
    },
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
