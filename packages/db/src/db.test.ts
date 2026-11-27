// Runs against a real Postgres: set TEOVO_TEST_DATABASE_URL (CI provides one). Each test gets its own schema.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { createAssistant, defineTool } from '@teovo/server'
import { MockLanguageModelV4 } from 'ai/test'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateSql, migrate, missingTables, postgresFiles, postgresStorage, prune, type Query } from './index'

const url = process.env.TEOVO_TEST_DATABASE_URL
const suite = url ? describe : describe.skip

let admin: pg.Pool
const pools: pg.Pool[] = []
let schema = ''

/** A query function bound to one fresh schema, through one connection so transactions work. */
async function freshSchema(): Promise<{ query: Query; client: pg.PoolClient }> {
  schema = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  await admin.query(`create schema ${schema}`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
  pools.push(pool)
  const client = await pool.connect()
  return { client, query: (text, params) => client.query(text, params as unknown[]) }
}

suite('@teovo/db on Postgres', () => {
  beforeAll(() => { admin = new pg.Pool({ connectionString: url }) })
  afterEach(async () => { if (schema) await admin.query(`drop schema if exists ${schema} cascade`) })
  afterAll(async () => { for (const p of pools) await p.end(); await admin.end() })

  it('creates core tables only, adds a feature later, and never repeats a migration', async () => {
    const { query, client } = await freshSchema()
    expect(await migrate(query)).toEqual(['0001_core', '0003_tenant_formats', '0007_api_functions'])
    expect(await missingTables(query, { proposals: true })).toEqual(['tv_proposals'])
    expect(await migrate(query, { features: { proposals: true } })).toEqual(['0002_proposals', '0004_proposal_sources', '0006_proposal_fields'])
    expect(await migrate(query, { features: { proposals: true } })).toEqual([])
    expect(await missingTables(query, { proposals: true })).toEqual([])
    client.release()
  })

  it('produces the same tables as plain SQL for apps with their own migrations', async () => {
    const { query, client } = await freshSchema()
    await query(generateSql({ features: { proposals: true } }))
    expect(await missingTables(query, { proposals: true })).toEqual([])
    expect(await migrate(query, { features: { proposals: true } })).toEqual([])   // already recorded
    client.release()
  })

  it('stores threads per tenant and user, messages in order, and cards', async () => {
    const { query, client } = await freshSchema()
    await migrate(query, { features: { proposals: true } })
    const s = postgresStorage(query)
    const t = await s.createThread('shop-1', 'u1')
    expect(await s.getThread('shop-1', 'u2', t.id)).toBeNull()
    expect(await s.getThread('shop-2', 'u1', t.id)).toBeNull()
    expect((await s.getThread('shop-1', 'u1', t.id))?.id).toBe(t.id)
    expect(await s.getThread('shop-1', 'u1', 'not-a-uuid')).toBeNull()

    await s.saveMessages(t.id, [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }])
    await s.saveMessages(t.id, [{ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hello' }], metadata: { runId: 'r' } }])
    await s.saveMessages(t.id, [{ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hello!' }], metadata: { runId: 'r' } }])   // update, not a duplicate
    expect((await s.listMessages(t.id)).map((m) => [m.id, (m.parts[0] as { text: string }).text])).toEqual([['m1', 'hi'], ['m2', 'hello!']])

    await s.saveCard({ id: crypto.randomUUID(), threadId: t.id, runId: crypto.randomUUID(), kind: 'record_payment', title: 'Payment ₹200', after: { paid: 200 }, payload: { amount: 200 }, status: 'shown' })
    expect((await query('select title, status, after from tv_proposals')).rows).toEqual([{ title: 'Payment ₹200', status: 'shown', after: { paid: 200 } }])
    client.release()
  })

  it("applies row-level rules from the app's own tenancy", async () => {
    const { query, client } = await freshSchema()
    const role = `teovo_app_${schema}`
    await admin.query(`create role ${role}; grant ${role} to current_user`)
    try {
      await migrate(query, { features: { proposals: true }, rls: { tenant: "current_setting('app.tenant', true)", user: "current_setting('app.user', true)", roles: [role] } })
      await query(`grant usage on schema ${schema} to ${role}; grant select, insert on all tables in schema ${schema} to ${role}`)
      const s = postgresStorage(query)
      const mine = await s.createThread('shop-1', 'u1')
      await s.createThread('shop-1', 'u2')
      await s.createThread('shop-2', 'u1')
      await query('begin')
      await query(`set local role ${role}; select set_config('app.tenant', 'shop-1', true), set_config('app.user', 'u1', true)`)
      const seen = (await query('select id from tv_threads')).rows.map((r) => r.id)
      await query('rollback')
      expect(seen).toEqual([mine.id])
    } finally {
      await admin.query(`drop schema if exists ${schema} cascade; drop role if exists ${role}`)
      client.release()
    }
  })

  it('keeps a whole chat with createAssistant: question, card and reply', async () => {
    const { query, client } = await freshSchema()
    await migrate(query, { features: { proposals: true } })
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
    const s = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
    const model = new MockLanguageModelV4({ doStream: [
      s([{ type: 'tool-call', toolCallId: 'c1', toolName: 'record_payment', input: '{"amount":200}' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]),
      s([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Ready to confirm.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]),
    ] as never })
    const teovo = createAssistant({
      identify: () => ({ tenantId: 'shop-1', userId: 'u1', role: 'owner' }),
      asUser: () => null,
      tools: [defineTool({ name: 'record_payment', kind: 'propose', description: 'pay', input: z.object({ amount: z.number() }), run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, payload: { amount } }) })],
      models: [model], instructions: 'Help.', storage: postgresStorage(query),
    })
    const res = await teovo.fetch(new Request('https://x.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'q1', role: 'user', parts: [{ type: 'text', text: 'paid 200' }] } }) }))
    await res.text()
    const threadId = res.headers.get('x-teovo-thread')
    const msgs = (await query('select role, parts from tv_messages where thread_id = $1 order by seq', [threadId])).rows
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(msgs[1].parts)).toContain('Ready to confirm.')
    expect(JSON.stringify(msgs[1].parts)).toContain('data-card')
    expect((await query('select title from tv_proposals')).rows).toEqual([{ title: 'Payment ₹200' }])
    expect((await query('select status, model from tv_runs')).rows).toEqual([{ status: 'done', model: 'mock-model-id' }])
    expect((await query('select seq, name, output from tv_run_steps')).rows).toEqual([{ seq: 0, name: 'record_payment', output: { kind: 'record_payment', title: 'Payment ₹200', payload: { amount: 200 } } }])
    client.release()
  })

  it('finds cards only for their owner and changes them only from the expected status', async () => {
    const { query, client } = await freshSchema()
    await migrate(query, { features: { proposals: true } })
    const s = postgresStorage(query)
    const t = await s.createThread('shop-1', 'u1')
    const id = crypto.randomUUID()
    await s.saveCard({ id, threadId: t.id, runId: crypto.randomUUID(), kind: 'pay', title: 'Pay', before: { paid: 0 }, payload: { a: 1 }, status: 'shown', untrustedSources: ['customer note'] })
    expect(await s.getCard('shop-1', 'u2', id)).toBeNull()
    expect(await s.getCard('shop-2', 'u1', id)).toBeNull()
    expect(await s.getCard('shop-1', 'u1', id)).toMatchObject({ id, status: 'shown', before: { paid: 0 }, payload: { a: 1 }, untrustedSources: ['customer note'] })

    const at = new Date().toISOString()
    const both = await Promise.all([s.updateCard(id, ['shown'], { status: 'confirmed', decidedBy: 'u1', decidedAt: at }), s.updateCard(id, ['shown'], { status: 'confirmed', decidedBy: 'u1', decidedAt: at })])
    expect(both.filter(Boolean)).toHaveLength(1)
    expect(await s.updateCard(id, ['confirmed'], { reversible: true, undo: { paymentId: 'p9' } })).toMatchObject({ status: 'confirmed', decidedBy: 'u1', decidedAt: at, reversible: true, undo: { paymentId: 'p9' } })
    expect(await s.updateCard(id, ['confirmed'], { status: 'shown', decidedBy: undefined, decidedAt: undefined })).not.toHaveProperty('decidedBy')
    expect((await s.listCards(t.id)).map((c) => c.status)).toEqual(['shown'])
    client.release()
  })

  it('lists threads by latest activity, keeps titles, and archives only for the owner', async () => {
    const { query, client } = await freshSchema()
    await migrate(query)
    const s = postgresStorage(query)
    const a = await s.createThread('shop-1', 'u1')
    const b = await s.createThread('shop-1', 'u1')
    await s.createThread('shop-1', 'u2')
    await s.setThreadTitle(a.id, 'Sales this month')
    await s.saveMessages(b.id, [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'x' }] }])
    await query(`update tv_messages set created_at = now() - interval '1 hour'`)
    await s.saveMessages(a.id, [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'y' }] }])
    const list = await s.listThreads('shop-1', 'u1', 10)
    expect(list.map((t) => [t.id, t.title])).toEqual([[a.id, 'Sales this month'], [b.id, null]])
    expect(await s.archiveThread('shop-1', 'u2', a.id)).toBe(false)
    expect(await s.archiveThread('shop-1', 'u1', a.id)).toBe(true)
    expect(await s.archiveThread('shop-1', 'u1', a.id)).toBe(false)
    expect((await s.listThreads('shop-1', 'u1', 10)).map((t) => t.id)).toEqual([b.id])
    expect(await s.getThread('shop-1', 'u1', a.id)).toBeNull()
    client.release()
  })

  it('stores pictures in tv_files per tenant, and prune removes old ones', async () => {
    const { query, client } = await freshSchema()
    expect(await missingTables(query, { files: true })).toContain('tv_files')
    expect(await migrate(query, { features: { files: true } })).toContain('0005_files')
    const s = postgresStorage(query)
    const t = await s.createThread('shop-1', 'u1')
    const files = postgresFiles(query)
    const id = crypto.randomUUID()
    await files.put({ id, tenantId: 'shop-1', userId: 'u1', threadId: t.id, mediaType: 'image/png', filename: 'bill.png', bytes: new Uint8Array([9, 8, 7]) })
    expect(await files.get('shop-1', id)).toMatchObject({ userId: 'u1', threadId: t.id, mediaType: 'image/png', filename: 'bill.png', bytes: new Uint8Array([9, 8, 7]) })
    expect(await files.get('shop-2', id)).toBeNull()
    expect((await query('select size from tv_files')).rows).toEqual([{ size: 3 }])

    await query(`update tv_files set created_at = now() - interval '40 days'`)
    expect(await prune(query, { days: 365, fileDays: 30, dryRun: true })).toEqual({ threads: 0, usageRows: 0, files: 1 })
    expect(await prune(query, { days: 365, fileDays: 30 })).toMatchObject({ files: 1 })
    expect(await files.get('shop-1', id)).toBeNull()
    await files.put({ id: crypto.randomUUID(), tenantId: 'shop-1', userId: 'u1', threadId: t.id, mediaType: 'image/png', bytes: new Uint8Array([1]) })
    expect(await files.removeOlderThan!(new Date(Date.now() + 1000))).toBe(1)
    client.release()
  })

  it("saves a tenant's settings and replaces them whole", async () => {
    const { query, client } = await freshSchema()
    await migrate(query)
    const s = postgresStorage(query)
    expect(await s.tenantSettings('shop-1')).toBeNull()
    await s.saveTenantSettings('shop-1', { enabled: true, instructions: 'Closed Sundays', glossary: { khata: 'credit' }, toolsOff: ['get_expenses'], formats: { currency: 'INR' } })
    expect(await s.tenantSettings('shop-1')).toEqual({ enabled: true, instructions: 'Closed Sundays', glossary: { khata: 'credit' }, toolsOff: ['get_expenses'], formats: { currency: 'INR' } })
    await s.saveTenantSettings('shop-1', { enabled: false })
    expect(await s.tenantSettings('shop-1')).toEqual({ enabled: false })
    expect(await s.tenantSettings('shop-2')).toBeNull()
    client.release()
  })

  it('keeps usage totals per person and per tenant, reads budgets, and counts running replies', async () => {
    const { query, client } = await freshSchema()
    await migrate(query)
    const s = postgresStorage(query)
    const t = await s.createThread('shop-1', 'u1')
    const base = { tenantId: 'shop-1', provider: 'google', model: 'gemini' }
    await s.addUsage([{ ...base, userId: 'u1', unit: 'messages', amount: 1 }, { ...base, userId: 'u1', unit: 'output_tokens', amount: 30 }])
    await s.addUsage([{ ...base, userId: 'u2', unit: 'messages', amount: 1 }, { ...base, tenantId: 'shop-2', userId: 'u1', unit: 'messages', amount: 1 }])
    expect(await s.usage('shop-1', 'u1', 'day')).toEqual({ user: { messages: 1, output_tokens: 30 }, tenant: { messages: 2, output_tokens: 30 } })
    expect(await s.usage('shop-1', 'u1', 'month')).toEqual({ user: { messages: 1, output_tokens: 30 }, tenant: { messages: 2, output_tokens: 30 } })
    await query(`update tv_usage_daily set day = day - 40`)
    expect(await s.usage('shop-1', 'u1', 'month')).toEqual({ user: {}, tenant: {} })

    await query(`insert into tv_budgets (tenant_id, user_id, unit, period, "limit") values ('shop-1', '', 'messages', 'month', 500), ('shop-1', 'u1', 'messages', 'day', 20), ('shop-1', 'u2', 'messages', 'day', 5)`)
    expect((await s.budgets('shop-1', 'u1')).sort((a, b) => a.limit - b.limit)).toEqual([
      { userId: 'u1', unit: 'messages', period: 'day', limit: 20 }, { userId: '', unit: 'messages', period: 'month', limit: 500 }])

    await s.startRun({ id: crypto.randomUUID(), threadId: t.id, tenantId: 'shop-1', userId: 'u1' })
    const done = crypto.randomUUID()
    await s.startRun({ id: done, threadId: t.id, tenantId: 'shop-1', userId: 'u1' })
    await s.finishRun(done, { status: 'failed', error: 'down' })
    expect(await s.runningRuns('shop-1', 'u1', new Date(Date.now() - 60_000))).toBe(1)
    expect(await s.runningRuns('shop-1', 'u1', new Date(Date.now() + 60_000))).toBe(0)   // older than the cut-off: abandoned
    client.release()
  })
})
