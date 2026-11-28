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
    expect(await migrate(query)).toEqual(['0001_core', '0003_tenant_formats', '0007_api_functions', '0009_ratings', '0010_audit_misses', '0011_privacy_switches', '0014_run_viewer', '0015_long_runs'])
    expect(await missingTables(query, { proposals: true })).toEqual(['tv_proposals'])
    expect(await migrate(query, { features: { proposals: true } })).toEqual(['0002_proposals', '0004_proposal_sources', '0006_proposal_fields', '0012_card_items_versions', '0013_card_lines'])
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
    await s.saveCard({ id, threadId: t.id, runId: crypto.randomUUID(), kind: 'pay', title: 'Pay', before: { paid: 0 }, payload: { a: 1 }, status: 'shown', untrustedSources: ['customer note'], lines: ['2 × Belgian', 'Paid by GPay'], recordVersion: '{"paid":0}' })
    expect(await s.getCard('shop-1', 'u2', id)).toBeNull()
    expect(await s.getCard('shop-2', 'u1', id)).toBeNull()
    expect(await s.getCard('shop-1', 'u1', id)).toMatchObject({ id, status: 'shown', before: { paid: 0 }, payload: { a: 1 }, untrustedSources: ['customer note'], lines: ['2 × Belgian', 'Paid by GPay'] })

    const at = new Date().toISOString()
    const both = await Promise.all([s.updateCard(id, ['shown'], { status: 'confirmed', decidedBy: 'u1', decidedAt: at }), s.updateCard(id, ['shown'], { status: 'confirmed', decidedBy: 'u1', decidedAt: at })])
    expect(both.filter(Boolean)).toHaveLength(1)
    expect((await s.getCard('shop-1', 'u1', id))?.recordVersion).toBe('{"paid":0}')
    expect(await s.updateCard(id, ['confirmed'], { reversible: true, undo: { paymentId: 'p9' }, recordVersion: '{"paid":200}' })).toMatchObject({ status: 'confirmed', decidedBy: 'u1', decidedAt: at, reversible: true, undo: { paymentId: 'p9' }, recordVersion: '{"paid":200}' })
    expect(await s.updateCard(id, ['confirmed'], { status: 'shown', decidedBy: undefined, decidedAt: undefined })).not.toHaveProperty('decidedBy')
    expect((await s.listCards(t.id)).map((c) => c.status)).toEqual(['shown'])

    // Saving the same card again (a form sent twice) keeps the first and its decision.
    await s.updateCard(id, ['shown'], { status: 'confirmed', decidedBy: 'u1', decidedAt: at })
    await s.saveCard({ id, threadId: t.id, runId: crypto.randomUUID(), kind: 'pay', title: 'Pay again', payload: {}, status: 'shown' })
    expect(await s.getCard('shop-1', 'u1', id)).toMatchObject({ title: 'Pay', status: 'confirmed' })
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

  it('keeps the audit trail and misses per tenant, and wipe removes a person or a tenant', async () => {
    const { query, client } = await freshSchema()
    await migrate(query, { features: { proposals: true, files: true } })
    const s = postgresStorage(query)
    const t1 = await s.createThread('shop-1', 'u1')
    const t2 = await s.createThread('shop-1', 'u2')
    await s.createThread('shop-2', 'u1')
    const card = crypto.randomUUID()
    await s.addCardEvent({ cardId: card, threadId: t1.id, tenantId: 'shop-1', userId: 'u1', kind: 'pay', title: 'Pay', event: 'proposed' })
    await s.addCardEvent({ cardId: card, threadId: t1.id, tenantId: 'shop-1', userId: 'u1', kind: 'pay', title: 'Pay', event: 'confirmed' })
    await s.addCardEvent({ cardId: crypto.randomUUID(), threadId: t2.id, tenantId: 'shop-1', userId: 'u2', kind: 'pay', title: 'Pay 2', event: 'skipped' })
    expect((await s.listCardEvents('shop-1', { limit: 10 })).map((e) => e.event)).toEqual(['skipped', 'confirmed', 'proposed'])
    expect((await s.listCardEvents('shop-1', { limit: 10, userId: 'u1' })).map((e) => e.event)).toEqual(['confirmed', 'proposed'])
    expect(await s.listCardEvents('shop-2', { limit: 10 })).toEqual([])
    await s.addMiss({ tenantId: 'shop-1', userId: 'u1', threadId: t1.id, question: 'refund?', reason: 'no tool' })
    expect(await s.listMisses('shop-1', { limit: 5 })).toEqual([expect.objectContaining({ question: 'refund?', reason: 'no tool', threadId: t1.id })])

    await query(`insert into tv_files (id, tenant_id, user_id, thread_id, media_type, size, bytes) values ($1, 'shop-1', 'u1', $2, 'image/png', 3, '\\x010203')`, [crypto.randomUUID(), t1.id])
    expect(await s.wipe('shop-1', 'u1')).toEqual({ threads: 1, files: 1 })
    expect((await query('select count(*)::int as n from tv_files')).rows[0].n).toBe(0)
    expect(await s.listThreads('shop-1', 'u1', 10)).toEqual([])
    expect(await s.listThreads('shop-1', 'u2', 10)).toHaveLength(1)
    expect(await s.listMisses('shop-1', { limit: 5 })).toEqual([])
    expect((await s.listCardEvents('shop-1', { limit: 10 })).map((e) => e.userId)).toEqual(['u2'])
    expect(await s.wipe('shop-1')).toEqual({ threads: 1, files: 0 })
    expect(await s.listThreads('shop-2', 'u1', 10)).toHaveLength(1)   // another tenant untouched
    client.release()
  })

  it("saves a tenant's settings and replaces them whole", async () => {
    const { query, client } = await freshSchema()
    await migrate(query)
    const s = postgresStorage(query)
    expect(await s.tenantSettings('shop-1')).toBeNull()
    await s.saveTenantSettings('shop-1', { enabled: true, instructions: 'Closed Sundays', glossary: { khata: 'credit' }, toolsOff: ['get_expenses'], formats: { currency: 'INR' } })
    expect(await s.tenantSettings('shop-1')).toEqual({ enabled: true, instructions: 'Closed Sundays', glossary: { khata: 'credit' }, toolsOff: ['get_expenses'], formats: { currency: 'INR' } })
    await s.saveTenantSettings('shop-1', { enabled: true, privacy: { notice: 'Sent to Gemini.', pictures: false } })
    expect(await s.tenantSettings('shop-1')).toEqual({ enabled: true, privacy: { notice: 'Sent to Gemini.', pictures: false } })
    await s.saveTenantSettings('*', { enabled: true, modelsOff: ['gemini-2.5-flash'] })
    expect(await s.tenantSettings('*')).toEqual({ enabled: true, modelsOff: ['gemini-2.5-flash'] })
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

  it('lists runs for the run viewer with title and usage, filters them, and returns one run with its steps', async () => {
    const { query, client } = await freshSchema()
    await migrate(query)
    const s = postgresStorage(query)
    const t = await s.createThread('shop-1', 'u1')
    await s.setThreadTitle(t.id, 'who owes money?')
    const first = crypto.randomUUID(), second = crypto.randomUUID(), elsewhere = crypto.randomUUID()
    await s.startRun({ id: first, threadId: t.id, tenantId: 'shop-1', userId: 'u1', model: 'gemini', promptVersion: 'v3', question: 'who owes the most?' })
    await s.saveStep({ runId: first, seq: 0, type: 'tool', toolCallId: 'c1', name: 'list_orders', input: { unpaid: true }, output: [{ no: 4 }], truncated: false, durationMs: 40 })
    await s.saveStep({ runId: first, seq: 1, type: 'check', name: 'first-try', input: 'Order 4 owes 250.', truncated: false, error: 'Say who.', durationMs: 0 })
    await s.addUsage([{ tenantId: 'shop-1', userId: 'u1', runId: first, provider: 'google', model: 'gemini', unit: 'messages', amount: 1 }, { tenantId: 'shop-1', userId: 'u1', runId: first, provider: 'google', model: 'gemini', unit: 'input_tokens', amount: 900 }])
    await s.finishRun(first, { status: 'done' })
    await s.rateRun('shop-1', 'u1', first, -1, 'wrong customer')
    await query(`update tv_runs set started_at = now() - interval '1 minute' where id = $1`, [first])
    await s.startRun({ id: second, threadId: t.id, tenantId: 'shop-1', userId: 'u2' })
    const t2 = await s.createThread('shop-2', 'u1')
    await s.startRun({ id: elsewhere, threadId: t2.id, tenantId: 'shop-2', userId: 'u1' })

    const runs = await s.listRuns!('shop-1', { limit: 10 })
    expect(runs.map((r) => r.id)).toEqual([second, first])
    expect(runs[1]).toMatchObject({ status: 'done', model: 'gemini', promptVersion: 'v3', question: 'who owes the most?', title: 'who owes money?', rating: -1, ratingNote: 'wrong customer', usage: { messages: 1, input_tokens: 900 } })
    expect(runs[1]!.finishedAt).toBeTruthy()
    expect(runs[0]).toMatchObject({ status: 'running', usage: {} })
    expect((await s.listRuns!('shop-1', { limit: 10, userId: 'u2' })).map((r) => r.id)).toEqual([second])
    expect((await s.listRuns!('shop-1', { limit: 10, rating: -1 })).map((r) => r.id)).toEqual([first])
    expect((await s.listRuns!('shop-1', { limit: 10, status: 'running' })).map((r) => r.id)).toEqual([second])
    expect((await s.listRuns!('shop-1', { limit: 10, before: runs[0]!.startedAt })).map((r) => r.id)).toEqual([first])

    const run = await s.getRun!('shop-1', first)
    expect(run!.steps.map((x) => [x.type, x.name])).toEqual([['tool', 'list_orders'], ['check', 'first-try']])
    expect(run!.steps[0]).toMatchObject({ toolCallId: 'c1', input: { unpaid: true }, output: [{ no: 4 }], durationMs: 40 })
    expect(run!.steps[1]).toMatchObject({ input: 'Order 4 owes 250.', error: 'Say who.' })
    expect(run!.steps[0]!.at).toBeTruthy()
    expect(await s.getRun!('shop-2', first)).toBeNull()
    expect(await s.getRun!('shop-1', 'not-a-uuid')).toBeNull()
    client.release()
  })

  it('long runs: of many servers claiming at once exactly one wins; lease, stop, hand-back and the stream log', async () => {
    const { query, client } = await freshSchema()
    await migrate(query)
    const s = postgresStorage(query)
    const q = s.queue!
    const t = await s.createThread('shop-1', 'u1')
    const id = crypto.randomUUID()
    await s.startRun({ id, threadId: t.id, tenantId: 'shop-1', userId: 'u1', status: 'queued' })
    expect(await q.waiting(5)).toEqual([])   // no job yet
    expect(await s.runningRuns('shop-1', 'u1', new Date(Date.now() - 60_000))).toBe(1)   // queued ones count
    await q.enqueue(id, { identity: { tenantId: 'shop-1', userId: 'u1', role: 'staff' }, messageId: 'm1', models: ['gemini'] })
    expect(await q.waiting(5)).toEqual([id])
    // Ten servers, each on its own connection, at the same moment.
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 })
    pools.push(pool)
    const got = await Promise.all(Array.from({ length: 10 }, (_, i) => postgresStorage((text, params) => pool.query(text, params as unknown[])).queue!.claim(id, `w${i}`, 60_000)))
    const won = got.filter(Boolean)
    expect(won).toHaveLength(1)
    expect(won[0]).toMatchObject({ id, attempts: 1, threadId: t.id, job: { messageId: 'm1' }, stopRequested: false })
    const holder = `w${got.findIndex(Boolean)}`
    expect(await q.waiting(5)).toEqual([])
    expect(await q.renew(id, 'someone-else', 60_000)).toBeNull()
    expect(await q.renew(id, holder, 60_000)).toEqual({ stop: false })
    expect(await q.state(id)).toMatchObject({ status: 'running', attempts: 1, tenantId: 'shop-1' })
    expect(await q.active(t.id)).toBe(id)
    // The stream log, in order, once per seq.
    await q.addEvents(id, 1, 0, [{ type: 'start' }])
    await q.addEvents(id, 1, 1, [{ type: 'text-delta', delta: 'Hi' }])
    await q.addEvents(id, 1, 1, [{ type: 'ignored' }])
    expect(await q.events(id, 1, -1)).toEqual([{ seq: 0, chunks: [{ type: 'start' }] }, { seq: 1, chunks: [{ type: 'text-delta', delta: 'Hi' }] }])
    expect(await q.events(id, 1, 0)).toHaveLength(1)
    // Stop: only by its tenant (and person); the holder hears it at its next renew.
    expect(await q.requestStop('shop-2', id)).toBe(false)
    expect(await q.requestStop('shop-1', id, 'u2')).toBe(false)
    expect(await q.requestStop('shop-1', id, 'u1')).toBe(true)
    expect(await q.renew(id, holder, 60_000)).toEqual({ stop: true })
    // Handed back: another server can take it at once.
    await q.release(id, holder)
    expect(await q.waiting(5)).toEqual([id])
    expect(await q.claim(id, 'w-next', 60_000)).toMatchObject({ attempts: 2, stopRequested: true })
    // A lease that runs out makes it waiting again.
    await query(`update tv_runs set lease_until = now() - interval '1 second' where id = $1`, [id])
    expect(await q.waiting(5)).toEqual([id])
    await s.finishRun(id, { status: 'stopped' })
    expect(await q.waiting(5)).toEqual([])
    expect(await q.active(t.id)).toBeNull()
    // A queued run that is stopped ends at once.
    const id2 = crypto.randomUUID()
    await s.startRun({ id: id2, threadId: t.id, tenantId: 'shop-1', userId: 'u1', status: 'queued' })
    expect(await q.requestStop('shop-1', id2)).toBe(true)
    expect(await q.state(id2)).toMatchObject({ status: 'stopped' })
    // Wipe takes the stream log with the run.
    await s.wipe('shop-1')
    expect((await query('select count(*)::int as n from tv_run_events')).rows[0].n).toBe(0)
    client.release()
  })

  it('long runs: a reply survives its server, through createAssistant on Postgres', async () => {
    const { query, client } = await freshSchema()
    await migrate(query, { features: { proposals: true } })
    const storage = postgresStorage(query)
    let open!: () => void
    const stuck = new Promise<void>((r) => { open = r })
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
    const step = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close() } }) })
    const call = (name: string) => step([{ type: 'tool-call', toolCallId: `c-${name}`, toolName: name, input: '{}' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }])
    const say = (text: string) => step([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }])
    const scripted = (steps: unknown[]) => { let i = 0; return new MockLanguageModelV4({ modelId: 'gemini', doStream: async () => steps[i++] as never }) }
    const app = (model: MockLanguageModelV4, runs: object) => createAssistant({
      identify: () => ({ tenantId: 'shop-1', userId: 'u1', role: 'staff' }), asUser: () => null, instructions: 'Help.', storage, models: [model],
      tools: [
        defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => [{ no: 4, due: 250 }] }),
        defineTool({ name: 'add_up', kind: 'read', description: 'Adds up', input: z.object({}), run: async () => { await stuck; return {} } }),
      ],
      runs: { pollMs: 10, flushMs: 5, asUser: () => null, ...runs },
    })
    const a = app(scripted([call('list_orders'), call('add_up'), say('late')]), { heartbeatMs: 60_000, leaseMs: 200 })
    const b = app(scripted([say('Order 4 owes 250.')]), {})
    const res = await a.fetch(new Request('https://x.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'who owes?' }] } }) }))
    const threadId = res.headers.get('x-teovo-thread')!
    const q = storage.queue!
    for (let i = 0; i < 300 && !(await q.waiting(5)).length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(await b.work()).toBe(1)
    const reply = (await storage.listMessages(threadId)).filter((m) => m.role === 'assistant')
    expect(reply).toHaveLength(1)
    expect(reply[0]!.parts.filter((p) => p.type.startsWith('tool-')).map((p) => p.type)).toEqual(['tool-list_orders'])
    expect(reply[0]!.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(['Order 4 owes 250.'])
    const run = (await query('select status, attempts from tv_runs')).rows[0]
    expect(run).toEqual({ status: 'done', attempts: 2 })
    open()
    await res.body!.cancel()
    await new Promise((r) => setTimeout(r, 50))
    expect((await query('select status from tv_runs')).rows[0].status).toBe('done')   // the stalled server changed nothing
    client.release()
  })
})
