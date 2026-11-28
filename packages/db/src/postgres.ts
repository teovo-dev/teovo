import { periodKey, type ClaimedRun, type RunState, type CardEvent, type CardPatch, type Miss, type RunSummary, type StepRecord, type Storage, type StoredCard, type Thread, type Totals, type Unit } from '@teovo/server'
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
  if (r.record_version) c.recordVersion = r.record_version
  if (r.untrusted_sources) c.untrustedSources = r.untrusted_sources
  if (r.fields) c.fields = r.fields
  if (r.items) c.items = r.items
  if (r.lines) c.lines = r.lines
  if (r.version !== null && r.version !== undefined) c.version = r.version
  return c
}
const COLUMN: Record<keyof CardPatch, string> = { status: 'status', decidedBy: 'decided_by', decidedAt: 'decided_at', reversible: 'reversible', undo: 'undo', undoneAt: 'undone_at', recordVersion: 'record_version' }

/** A tv_runs row (with title and usage joined in) as the run viewer shows it. */
export const runSummary = (r: any, usage: Totals): RunSummary => ({
  id: r.id, threadId: r.thread_id, tenantId: r.tenant_id, userId: r.user_id, status: r.status, startedAt: iso(r.started_at)!,
  ...(r.model ? { model: r.model } : {}), ...(r.prompt_version ? { promptVersion: r.prompt_version } : {}), ...(r.question ? { question: r.question } : {}),
  ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}), ...(r.error ? { error: r.error } : {}),
  ...(r.rating !== null && r.rating !== undefined ? { rating: Number(r.rating) as 1 | -1 } : {}), ...(r.rating_note ? { ratingNote: r.rating_note } : {}),
  title: r.title ?? null, usage,
})
export const stepRecord = (x: any): StepRecord => ({
  runId: x.run_id, seq: x.seq, type: x.type, name: x.name, truncated: x.truncated, durationMs: x.duration_ms ?? 0, at: iso(x.created_at),
  ...(x.tool_call_id ? { toolCallId: x.tool_call_id } : {}), ...(x.input !== null ? { input: x.input } : {}),
  ...(x.output !== null ? { output: x.output } : {}), ...(x.error ? { error: x.error } : {}),
})

export const claimed = (r: any): ClaimedRun => ({ id: r.id, threadId: r.thread_id, tenantId: r.tenant_id, userId: r.user_id, attempts: r.attempts, job: r.job, stopRequested: Boolean(r.stop_requested_at) })
export const runState = (r: any): RunState => ({ id: r.id, threadId: r.thread_id, tenantId: r.tenant_id, userId: r.user_id, status: r.status, attempts: r.attempts, ...(r.job ? { job: r.job } : {}) })

const thread = (r: any): Thread => ({
  id: r.id, tenantId: r.tenant_id, userId: r.user_id, title: r.title, createdAt: new Date(r.created_at).toISOString(),
  ...(r.summary && r.summary_upto ? { summary: { text: r.summary, upTo: r.summary_upto } } : {}),
})

/**
 * Storage on Postgres through any query function (node-postgres Pool, a Drizzle/pg client, a Cloudflare
 * Hyperdrive client…). Run `migrate` first. Threads are only ever found by tenant and user together.
 */
export function postgresStorage(query: Query): Storage {
  /** What each run used, summed by unit. */
  async function usageOf(ids: string[]): Promise<Map<string, Totals>> {
    const out = new Map<string, Totals>()
    if (!ids.length) return out
    const r = await query('select run_id, unit, sum(amount)::float8 as amount from tv_usage where run_id = any($1::uuid[]) group by run_id, unit', [ids])
    for (const x of r.rows) out.set(x.run_id, { ...out.get(x.run_id), [x.unit as Unit]: Number(x.amount) })
    return out
  }
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
    async searchThreads(tenantId, userId, q, limit) {
      // Words only: text parts of the messages, not their JSON keys or tool data.
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      const r = await query(
        `select t.*, coalesce((select max(m.created_at) from tv_messages m where m.thread_id = t.id), t.created_at) as updated_at
         from tv_threads t where t.tenant_id = $1 and t.user_id = $2 and t.archived_at is null
           and (t.title ilike $3 or exists (select 1 from tv_messages m, jsonb_array_elements(m.parts) p
                where m.thread_id = t.id and p->>'type' = 'text' and p->>'text' ilike $3))
         order by updated_at desc limit $4`, [tenantId, userId, like, limit])
      return r.rows.map((row) => ({ ...thread(row), updatedAt: new Date(row.updated_at).toISOString() }))
    },
    async setThreadTitle(id, title) {
      await query('update tv_threads set title = $2 where id = $1', [id, title])
    },
    async setThreadSummary(id, s) {
      await query('update tv_threads set summary = $2, summary_upto = $3 where id = $1', [id, s.text, s.upTo])
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
        `insert into tv_proposals (id, thread_id, run_id, kind, title, before, after, payload, status, untrusted_sources, fields, items, version, lines, record_version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (id) do nothing`,
        [c.id, c.threadId, c.runId, c.kind, c.title, json(c.before), json(c.after), json(c.payload), c.status, json(c.untrustedSources), json(c.fields), json(c.items), c.version ?? null, json(c.lines), c.recordVersion ?? null])
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
      await query('insert into tv_runs (id, thread_id, tenant_id, user_id, model, prompt_version, question, status) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [r.id, r.threadId, r.tenantId, r.userId, r.model ?? null, r.promptVersion ?? null, r.question ?? null, r.status ?? 'running'])
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
    async listRuns(tenantId, f) {
      const r = await query(
        `select r.*, t.title from tv_runs r left join tv_threads t on t.id = r.thread_id
         where r.tenant_id = $1 and ($2::text is null or r.user_id = $2) and ($3::text is null or r.status = $3)
           and ($4::int is null or r.rating = $4) and ($5::timestamptz is null or r.started_at < $5)
         order by r.started_at desc limit $6`,
        [tenantId, f.userId ?? null, f.status ?? null, f.rating ?? null, f.before ?? null, f.limit])
      const usage = await usageOf(r.rows.map((x) => x.id))
      return r.rows.map((x) => runSummary(x, usage.get(x.id) ?? {}))
    },
    async getRun(tenantId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const r = await query('select r.*, t.title from tv_runs r left join tv_threads t on t.id = r.thread_id where r.id = $1 and r.tenant_id = $2', [id, tenantId])
      if (!r.rows[0]) return null
      const steps = await query('select * from tv_run_steps where run_id = $1 order by seq, id', [id])
      return { ...runSummary(r.rows[0], (await usageOf([id])).get(id) ?? {}), steps: steps.rows.map(stepRecord) }
    },
    async runningRuns(tenantId, userId, since) {
      const r = await query(`select count(*)::int as n from tv_runs where tenant_id = $1 and user_id = $2 and status in ('queued', 'running') and started_at > $3`, [tenantId, userId, since.toISOString()])
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
    queue: {
      async enqueue(id, job) { await query('update tv_runs set job = $2 where id = $1', [id, json(job)]) },
      async waiting(limit) {
        const r = await query(`select id from tv_runs where job is not null and (status = 'queued' or (status = 'running' and lease_until < now())) order by started_at limit $1`, [limit])
        return r.rows.map((x) => x.id as string)
      },
      async claim(id, worker, leaseMs) {
        // One statement, so of many servers claiming at once exactly one changes the row.
        const r = await query(
          `update tv_runs set status = 'running', worker = $2, lease_until = now() + $3 * interval '1 millisecond', attempts = attempts + 1
           where id = $1 and job is not null and (status = 'queued' or (status = 'running' and lease_until < now())) returning *`, [id, worker, leaseMs])
        return r.rows[0] ? claimed(r.rows[0]) : null
      },
      async renew(id, worker, leaseMs) {
        const r = await query(`update tv_runs set lease_until = now() + $3 * interval '1 millisecond' where id = $1 and worker = $2 and status = 'running' returning stop_requested_at`, [id, worker, leaseMs])
        return r.rows[0] ? { stop: Boolean(r.rows[0].stop_requested_at) } : null
      },
      async release(id, worker) {
        await query(`update tv_runs set lease_until = now() - interval '1 second', worker = null where id = $1 and worker = $2 and status = 'running'`, [id, worker])
      },
      async requestStop(tenantId, id, userId) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return false
        const r = await query(
          `update tv_runs set stop_requested_at = now(),
             status = case when status = 'queued' then 'stopped' else status end, finished_at = case when status = 'queued' then now() else finished_at end
           where id = $1 and tenant_id = $2 and ($3::text is null or user_id = $3) and status in ('queued', 'running') returning id`, [id, tenantId, userId ?? null])
        return r.rows.length > 0
      },
      async state(id) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null
        const r = await query('select id, thread_id, tenant_id, user_id, status, attempts, job from tv_runs where id = $1', [id])
        return r.rows[0] ? runState(r.rows[0]) : null
      },
      async active(threadId) {
        const r = await query(`select id from tv_runs where thread_id = $1 and status in ('queued', 'running') order by started_at desc limit 1`, [threadId])
        return (r.rows[0]?.id as string | undefined) ?? null
      },
      async addEvents(runId, attempt, seq, chunks) {
        await query('insert into tv_run_events (run_id, attempt, seq, chunks) values ($1, $2, $3, $4) on conflict do nothing', [runId, attempt, seq, JSON.stringify(chunks)])
      },
      async events(runId, attempt, after) {
        const r = await query('select seq, chunks from tv_run_events where run_id = $1 and attempt = $2 and seq > $3 order by seq', [runId, attempt, after])
        return r.rows.map((x) => ({ seq: x.seq as number, chunks: x.chunks as unknown[] }))
      },
    },
    async budgets(tenantId, userId) {
      const r = await query(`select user_id, unit, period, "limit"::float8 as "limit" from tv_budgets where tenant_id = $1 and user_id in ($2, '')`, [tenantId, userId])
      return r.rows.map((b) => ({ userId: b.user_id, unit: b.unit, period: b.period, limit: Number(b.limit) }))
    },
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
