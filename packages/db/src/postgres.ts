import { periodKey, type CardEvent, type CardPatch, type Miss, type Storage, type StoredCard, type Thread, type Totals, type Unit } from '@teovo/server'
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
  if (r.untrusted_sources) c.untrustedSources = r.untrusted_sources
  if (r.fields) c.fields = r.fields
  if (r.items) c.items = r.items
  if (r.lines) c.lines = r.lines
  if (r.version !== null && r.version !== undefined) c.version = r.version
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
    async listThreads(tenantId, userId, limit) {
      const r = await query(
        `select t.*, coalesce((select max(m.created_at) from tv_messages m where m.thread_id = t.id), t.created_at) as updated_at
         from tv_threads t where t.tenant_id = $1 and t.user_id = $2 and t.archived_at is null
         order by updated_at desc limit $3`, [tenantId, userId, limit])
      return r.rows.map((row) => ({ ...thread(row), updatedAt: new Date(row.updated_at).toISOString() }))
    },
    async setThreadTitle(id, title) {
      await query('update tv_threads set title = $2 where id = $1', [id, title])
    },
    async archiveThread(tenantId, userId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return false
      const r = await query('update tv_threads set archived_at = now() where id = $1 and tenant_id = $2 and user_id = $3 and archived_at is null returning id', [id, tenantId, userId])
      return r.rows.length > 0
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
    async removeMessagesFrom(threadId, messageId) {
      await query(`delete from tv_messages where thread_id = $1 and seq >= (select seq from tv_messages where thread_id = $1 and id = $2)`, [threadId, messageId])
    },
    async saveCard(c: StoredCard) {
      await query(
        `insert into tv_proposals (id, thread_id, run_id, kind, title, before, after, payload, status, untrusted_sources, fields, items, version, lines) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (id) do nothing`,
        [c.id, c.threadId, c.runId, c.kind, c.title, json(c.before), json(c.after), json(c.payload), c.status, json(c.untrustedSources), json(c.fields), json(c.items), c.version ?? null, json(c.lines)])
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
    async tenantSettings(tenantId) {
      const r = await query('select enabled, instructions, glossary, tools_off, formats, privacy, models_off from tv_tenant_settings where tenant_id = $1', [tenantId])
      const row = r.rows[0]
      if (!row) return null
      return {
        enabled: row.enabled,
        ...(row.instructions ? { instructions: row.instructions } : {}),
        ...(row.glossary ? { glossary: row.glossary } : {}),
        ...(row.tools_off ? { toolsOff: row.tools_off } : {}),
        ...(row.formats ? { formats: row.formats } : {}),
        ...(row.privacy ? { privacy: row.privacy } : {}),
        ...(row.models_off ? { modelsOff: row.models_off } : {}),
      }
    },
    async saveTenantSettings(tenantId, s) {
      await query(
        `insert into tv_tenant_settings (tenant_id, enabled, instructions, glossary, tools_off, formats, privacy, models_off) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id) do update set enabled = excluded.enabled, instructions = excluded.instructions, glossary = excluded.glossary, tools_off = excluded.tools_off,
           formats = excluded.formats, privacy = excluded.privacy, models_off = excluded.models_off`,
        [tenantId, s.enabled, s.instructions ?? null, json(s.glossary), json(s.toolsOff), json(s.formats), json(s.privacy), json(s.modelsOff)])
    },
    async startRun(r) {
      await query('insert into tv_runs (id, thread_id, tenant_id, user_id, model, prompt_version) values ($1, $2, $3, $4, $5, $6)',
        [r.id, r.threadId, r.tenantId, r.userId, r.model ?? null, r.promptVersion ?? null])
    },
    async finishRun(id, end) {
      await query('update tv_runs set status = $2, model = coalesce($3, model), error = $4, finished_at = now() where id = $1', [id, end.status, end.model ?? null, end.error ?? null])
    },
    async rateRun(tenantId, userId, runId, rating, note) {
      if (!/^[0-9a-f-]{36}$/i.test(runId)) return false
      const r = await query('update tv_runs set rating = $4, rating_note = $5, rated_at = now() where id = $1 and tenant_id = $2 and user_id = $3 returning id', [runId, tenantId, userId, rating, note ?? null])
      return r.rows.length > 0
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
    async addCardEvent(e) {
      await query('insert into tv_card_events (card_id, thread_id, tenant_id, user_id, kind, title, event) values ($1, $2, $3, $4, $5, $6, $7)',
        [e.cardId, e.threadId, e.tenantId, e.userId, e.kind, e.title, e.event])
    },
    async listCardEvents(tenantId, o) {
      const r = await query(
        `select * from tv_card_events where tenant_id = $1 and ($2::text is null or user_id = $2) and ($3::timestamptz is null or at < $3) order by at desc, id desc limit $4`,
        [tenantId, o.userId ?? null, o.before ?? null, o.limit])
      return r.rows.map((x): CardEvent => ({ cardId: x.card_id, threadId: x.thread_id, tenantId: x.tenant_id, userId: x.user_id, kind: x.kind, title: x.title, event: x.event, at: iso(x.at) }))
    },
    async addMiss(m) {
      await query('insert into tv_misses (tenant_id, user_id, thread_id, run_id, question, reason) values ($1, $2, $3, $4, $5, $6)',
        [m.tenantId, m.userId, m.threadId ?? null, m.runId ?? null, m.question, m.reason])
    },
    async listMisses(tenantId, o) {
      const r = await query(`select * from tv_misses where tenant_id = $1 and ($2::timestamptz is null or at < $2) order by at desc, id desc limit $3`, [tenantId, o.before ?? null, o.limit])
      return r.rows.map((x): Miss => ({ tenantId: x.tenant_id, userId: x.user_id, ...(x.thread_id ? { threadId: x.thread_id } : {}), ...(x.run_id ? { runId: x.run_id } : {}), question: x.question, reason: x.reason, at: iso(x.at) }))
    },
    async wipe(tenantId, userId) {
      const who = userId === undefined ? 'tenant_id = $1' : 'tenant_id = $1 and user_id = $2'
      const args = userId === undefined ? [tenantId] : [tenantId, userId]
      // Threads take their messages, cards, runs (and run steps) and pictures with them (on delete cascade).
      const hasFiles = (await query(`select to_regclass('tv_files') is not null as ok`)).rows[0].ok as boolean
      const files = hasFiles ? (await query(`select count(*)::int as n from tv_files where ${who}`, args)).rows[0].n as number : 0
      const t = await query(`delete from tv_threads where ${who} returning id`, args)
      await query(`delete from tv_runs where ${who}`, args)
      await query(`delete from tv_usage where ${who}`, args)
      await query(`delete from tv_card_events where ${who}`, args)
      await query(`delete from tv_misses where ${who}`, args)
      return { threads: t.rows.length, files }
    },
    async budgets(tenantId, userId) {
      const r = await query(`select user_id, unit, period, "limit"::float8 as "limit" from tv_budgets where tenant_id = $1 and user_id in ($2, '')`, [tenantId, userId])
      return r.rows.map((b) => ({ userId: b.user_id, unit: b.unit, period: b.period, limit: Number(b.limit) }))
    },
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
