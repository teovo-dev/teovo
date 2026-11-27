import { periodKey, type CardPatch, type Storage, type StoredCard, type StoredFile, type Thread, type Totals, type Unit } from '@teovo/server'
import type { UIMessage } from 'ai'

/**
 * The part of a supabase-js client Teovo uses. Pass a client made with the server's own key (service role): Teovo
 * scopes every call to one tenant and one user itself, and the tables are locked against the browser
 * (migrations with rls: 'server-only').
 */
export interface SupabaseLike {
  from(table: string): any
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

const UUID = /^[0-9a-f-]{36}$/i
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
  return c
}
const COLUMN: Record<keyof CardPatch, string> = { status: 'status', decidedBy: 'decided_by', decidedAt: 'decided_at', reversible: 'reversible', undo: 'undo', undoneAt: 'undone_at' }
const thread = (r: any): Thread => ({ id: r.id, tenantId: r.tenant_id, userId: r.user_id, title: r.title, createdAt: new Date(r.created_at).toISOString() })

/** Throws with the API's message; Teovo turns it into "could not finish" for the user and logs it. */
async function ok<T = any>(q: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q
  if (error) throw new Error(`Teovo storage: ${error.message}`)
  return data
}

/**
 * Storage through Supabase's API, for apps whose server has no direct database connection (a Cloudflare Worker
 * using supabase-js). Same tables and behaviour as postgresStorage; run the migrations (npx teovo generate) first.
 */
export function supabaseStorage(db: SupabaseLike): Storage {
  return {
    async getThread(tenantId, userId, id) {
      if (!UUID.test(id)) return null
      const rows = await ok(db.from('tv_threads').select('*').eq('id', id).eq('tenant_id', tenantId).eq('user_id', userId).is('archived_at', null).limit(1))
      return rows[0] ? thread(rows[0]) : null
    },
    async createThread(tenantId, userId) {
      const rows = await ok(db.from('tv_threads').insert({ id: crypto.randomUUID(), tenant_id: tenantId, user_id: userId }).select('*'))
      return thread(rows[0])
    },
    async listThreads(tenantId, userId, limit) {
      const rows = (await ok(db.rpc('tv_list_threads', { p_tenant: tenantId, p_user: userId, p_limit: limit }))) as any[]
      return (rows ?? []).map((r) => ({ ...thread(r), updatedAt: new Date(r.updated_at).toISOString() }))
    },
    async setThreadTitle(id, title) {
      await ok(db.from('tv_threads').update({ title }).eq('id', id))
    },
    async archiveThread(tenantId, userId, id) {
      if (!UUID.test(id)) return false
      const rows = await ok(db.from('tv_threads').update({ archived_at: new Date().toISOString() })
        .eq('id', id).eq('tenant_id', tenantId).eq('user_id', userId).is('archived_at', null).select('id'))
      return rows.length > 0
    },
    async listMessages(threadId) {
      const rows = await ok(db.from('tv_messages').select('id, role, parts, metadata').eq('thread_id', threadId).order('seq'))
      return rows.map((m: any) => ({ id: m.id, role: m.role, parts: m.parts, ...(m.metadata ? { metadata: m.metadata } : {}) }) as UIMessage)
    },
    async saveMessages(threadId, messages) {
      // One at a time, in order: the table numbers messages as they arrive (seq), and an update keeps its place.
      for (const m of messages) {
        await ok(db.from('tv_messages').upsert({ id: m.id, thread_id: threadId, role: m.role, parts: m.parts, metadata: m.metadata ?? null }, { onConflict: 'thread_id,id' }))
      }
    },
    async saveCard(c) {
      await ok(db.from('tv_proposals').upsert({
        id: c.id, thread_id: c.threadId, run_id: c.runId, kind: c.kind, title: c.title, before: c.before ?? null, after: c.after ?? null,
        payload: c.payload ?? null, status: c.status, untrusted_sources: c.untrustedSources ?? null, fields: c.fields ?? null,
      }, { onConflict: 'id' }))
    },
    async getCard(tenantId, userId, id) {
      if (!UUID.test(id)) return null
      const rows = await ok(db.from('tv_proposals').select('*, tv_threads!inner(tenant_id, user_id)')
        .eq('id', id).eq('tv_threads.tenant_id', tenantId).eq('tv_threads.user_id', userId).limit(1))
      return rows[0] ? card(rows[0]) : null
    },
    async listCards(threadId) {
      return (await ok(db.from('tv_proposals').select('*').eq('thread_id', threadId).order('created_at'))).map(card)
    },
    async updateCard(id, from, patch) {
      // One request: the status check and the change happen in one statement, so two taps can't both win.
      const set: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(patch)) set[COLUMN[k as keyof CardPatch]] = v === undefined ? null : v
      const rows = await ok(db.from('tv_proposals').update(Object.keys(set).length ? set : { status: from[0] }).eq('id', id).in('status', from).select('*'))
      return rows[0] ? card(rows[0]) : null
    },
    async tenantSettings(tenantId) {
      const rows = await ok(db.from('tv_tenant_settings').select('enabled, instructions, glossary, tools_off, formats').eq('tenant_id', tenantId).limit(1))
      const row = rows[0]
      if (!row) return null
      return {
        enabled: row.enabled,
        ...(row.instructions ? { instructions: row.instructions } : {}),
        ...(row.glossary ? { glossary: row.glossary } : {}),
        ...(row.tools_off ? { toolsOff: row.tools_off } : {}),
        ...(row.formats ? { formats: row.formats } : {}),
      }
    },
    async saveTenantSettings(tenantId, s) {
      await ok(db.from('tv_tenant_settings').upsert({
        tenant_id: tenantId, enabled: s.enabled, instructions: s.instructions ?? null, glossary: s.glossary ?? null, tools_off: s.toolsOff ?? null, formats: s.formats ?? null,
      }, { onConflict: 'tenant_id' }))
    },
    async startRun(r) {
      await ok(db.from('tv_runs').insert({ id: r.id, thread_id: r.threadId, tenant_id: r.tenantId, user_id: r.userId, model: r.model ?? null, prompt_version: r.promptVersion ?? null }))
    },
    async finishRun(id, end) {
      await ok(db.from('tv_runs').update({ status: end.status, ...(end.model ? { model: end.model } : {}), error: end.error ?? null, finished_at: new Date().toISOString() }).eq('id', id))
    },
    async saveStep(s) {
      await ok(db.from('tv_run_steps').insert({
        run_id: s.runId, seq: s.seq, type: s.type, tool_call_id: s.toolCallId ?? null, name: s.name, input: s.input ?? null, output: s.output ?? null,
        truncated: s.truncated, error: s.error ?? null, duration_ms: s.durationMs,
      }))
    },
    async runningRuns(tenantId, userId, since) {
      const { count, error } = await db.from('tv_runs').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('user_id', userId).eq('status', 'running').gt('started_at', since.toISOString())
      if (error) throw new Error(`Teovo storage: ${error.message}`)
      return count ?? 0
    },
    async addUsage(rows) {
      const day = periodKey('day')
      for (const u of rows) {
        await ok(db.from('tv_usage').insert({ tenant_id: u.tenantId, user_id: u.userId, run_id: u.runId ?? null, provider: u.provider, model: u.model, unit: u.unit, amount: u.amount }))
        await ok(db.rpc('tv_add_usage_daily', { p_tenant: u.tenantId, p_user: u.userId, p_day: day, p_unit: u.unit, p_amount: u.amount }))
      }
    },
    async usage(tenantId, userId, period) {
      const from = period === 'day' ? periodKey('day') : `${periodKey('month')}-01`
      const rows = await ok(db.from('tv_usage_daily').select('user_id, unit, amount').eq('tenant_id', tenantId).in('user_id', [userId, '']).gte('day', from))
      const user: Totals = {}, tenant: Totals = {}
      for (const r of rows) {
        const t = r.user_id === '' ? tenant : user
        t[r.unit as Unit] = (t[r.unit as Unit] ?? 0) + Number(r.amount)
      }
      return { user, tenant }
    },
    async budgets(tenantId, userId) {
      const rows = await ok(db.from('tv_budgets').select('user_id, unit, period, limit').eq('tenant_id', tenantId).in('user_id', [userId, '']))
      return rows.map((b: any) => ({ userId: b.user_id, unit: b.unit, period: b.period, limit: Number(b.limit) }))
    },
  }
}

/** The owner rows for pictures kept in Supabase Storage (supabaseFiles' index), in tv_files without the bytes. */
export function supabaseFileIndex(db: SupabaseLike) {
  return {
    async put(f: Omit<StoredFile, 'bytes'>) {
      await ok(db.from('tv_files').insert({ id: f.id, tenant_id: f.tenantId, user_id: f.userId, thread_id: f.threadId, media_type: f.mediaType, filename: f.filename ?? null, size: 0 }))
    },
    async get(tenantId: string, id: string): Promise<Omit<StoredFile, 'bytes'> | null> {
      if (!UUID.test(id)) return null
      const rows = await ok(db.from('tv_files').select('id, tenant_id, user_id, thread_id, media_type, filename, created_at').eq('id', id).eq('tenant_id', tenantId).limit(1))
      const r = rows[0]
      if (!r) return null
      return { id: r.id, tenantId: r.tenant_id, userId: r.user_id, threadId: r.thread_id, mediaType: r.media_type, ...(r.filename ? { filename: r.filename } : {}), createdAt: iso(r.created_at) }
    },
  }
}
