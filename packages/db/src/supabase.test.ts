// Runs against a real Supabase (local is fine): set TEOVO_TEST_SUPABASE_URL, TEOVO_TEST_SUPABASE_SERVICE_KEY,
// TEOVO_TEST_SUPABASE_ANON_KEY and TEOVO_TEST_SUPABASE_DB_URL. Skipped otherwise (CI has no Supabase).
// The tables go in the public schema (the one Supabase's API serves); each test uses its own tenant.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { createClient } from '@supabase/supabase-js'
import { createAssistant, defineTool, memoryFiles } from '@teovo/server'
import { MockLanguageModelV4 } from 'ai/test'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { migrate, supabaseFileIndex, supabaseStorage } from './index'

const url = process.env.TEOVO_TEST_SUPABASE_URL
const serviceKey = process.env.TEOVO_TEST_SUPABASE_SERVICE_KEY
const anonKey = process.env.TEOVO_TEST_SUPABASE_ANON_KEY
const dbUrl = process.env.TEOVO_TEST_SUPABASE_DB_URL
const suite = url && serviceKey && anonKey && dbUrl ? describe : describe.skip

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const streamOf = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const say = (text: string) => streamOf([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }])
const call = (toolName: string, input: unknown) => streamOf([{ type: 'tool-call', toolCallId: `c-${crypto.randomUUID()}`, toolName, input: JSON.stringify(input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }])

let pool: pg.Pool
const tenant = () => `test-${crypto.randomUUID().slice(0, 8)}`
const opts = { auth: { persistSession: false, autoRefreshToken: false } }

suite('@teovo/db on Supabase (supabaseStorage)', () => {
  const service = () => createClient(url!, serviceKey!, opts)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: dbUrl })
    await migrate((t, p) => pool.query(t, p as unknown[]), { features: { proposals: true, files: true }, rls: 'server-only' })
    await pool.query(`notify pgrst, 'reload schema'`)
    await new Promise((r) => setTimeout(r, 1500))   // the API reloads its view of the tables
  }, 30_000)
  afterAll(async () => { await pool?.end() })

  it('keeps threads per tenant and user, messages in order, and lists by latest activity', async () => {
    const s = supabaseStorage(service())
    const t = tenant()
    const a = await s.createThread(t, 'u1')
    const b = await s.createThread(t, 'u1')
    await s.createThread(t, 'u2')
    expect(await s.getThread(t, 'u2', a.id)).toBeNull()
    expect(await s.getThread(`${t}x`, 'u1', a.id)).toBeNull()
    await s.saveMessages(a.id, [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] }, { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'two' }], metadata: { runId: 'r' } }])
    await s.saveMessages(a.id, [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one, edited' }] }])
    expect((await s.listMessages(a.id)).map((m) => [m.id, (m.parts[0] as { text: string }).text])).toEqual([['m1', 'one, edited'], ['m2', 'two']])
    expect((await s.listMessages(a.id))[1]!.metadata).toEqual({ runId: 'r' })
    await s.setThreadTitle(a.id, 'Payments')
    const list = await s.listThreads(t, 'u1', 10)
    expect(list.map((x) => x.id)).toEqual([a.id, b.id])                 // a has the newest message
    expect(list[0]!.title).toBe('Payments')
    // An edited message: it and everything after it go.
    await s.saveMessages(a.id, [{ id: 'm3', role: 'user', parts: [{ type: 'text', text: 'three' }] }])
    await s.removeMessagesFrom(a.id, 'm2')
    expect((await s.listMessages(a.id)).map((m) => m.id)).toEqual(['m1'])
    expect(await s.archiveThread(t, 'u2', a.id)).toBe(false)
    expect(await s.archiveThread(t, 'u1', a.id)).toBe(true)
    expect((await s.listThreads(t, 'u1', 10)).map((x) => x.id)).toEqual([b.id])
  })

  it('finds cards only for their owner and changes them only from the expected status', async () => {
    const s = supabaseStorage(service())
    const t = tenant()
    const th = await s.createThread(t, 'u1')
    const id = crypto.randomUUID()
    await s.saveCard({ id, threadId: th.id, runId: crypto.randomUUID(), kind: 'pay', title: 'Pay', after: { paid: 200 }, payload: { a: 1 }, status: 'shown', fields: [{ key: 'paid', format: 'money' }] })
    expect(await s.getCard(t, 'u2', id)).toBeNull()
    expect(await s.getCard(t, 'u1', id)).toMatchObject({ id, kind: 'pay', status: 'shown', after: { paid: 200 }, fields: [{ key: 'paid', format: 'money' }] })
    const won = await s.updateCard(id, ['shown'], { status: 'confirmed', decidedBy: 'u1', decidedAt: new Date().toISOString(), reversible: true })
    expect(won).toMatchObject({ status: 'confirmed', reversible: true, decidedBy: 'u1' })
    expect(await s.updateCard(id, ['shown'], { status: 'skipped' })).toBeNull()   // a second tap loses
    expect((await s.listCards(th.id)).map((c) => c.status)).toEqual(['confirmed'])
  })

  it('keeps usage per person and per tenant, reads budgets and settings, and counts running replies', async () => {
    const s = supabaseStorage(service())
    const t = tenant()
    await s.addUsage([{ tenantId: t, userId: 'u1', provider: 'google', model: 'm', unit: 'messages', amount: 1 }, { tenantId: t, userId: 'u2', provider: 'google', model: 'm', unit: 'messages', amount: 2 }])
    await s.addUsage([{ tenantId: t, userId: 'u1', provider: 'google', model: 'm', unit: 'output_tokens', amount: 40 }])
    expect(await s.usage(t, 'u1', 'day')).toEqual({ user: { messages: 1, output_tokens: 40 }, tenant: { messages: 3, output_tokens: 40 } })
    await pool.query(`insert into tv_budgets (tenant_id, user_id, unit, period, "limit") values ($1, '', 'messages', 'day', 50), ($1, 'u1', 'messages', 'day', 5)`, [t])
    expect(await s.budgets(t, 'u1')).toEqual(expect.arrayContaining([{ userId: '', unit: 'messages', period: 'day', limit: 50 }, { userId: 'u1', unit: 'messages', period: 'day', limit: 5 }]))
    await s.saveTenantSettings(t, { enabled: false, instructions: 'Be brief.' })
    expect(await s.tenantSettings(t)).toEqual({ enabled: false, instructions: 'Be brief.' })
    const th = await s.createThread(t, 'u1')
    await s.startRun({ id: crypto.randomUUID(), threadId: th.id, tenantId: t, userId: 'u1' })
    expect(await s.runningRuns(t, 'u1', new Date(Date.now() - 60_000))).toBe(1)
    const runId = (await pool.query('select id from tv_runs where tenant_id = $1', [t])).rows[0].id as string
    expect(await s.rateRun(t, 'u2', runId, 1)).toBe(false)
    expect(await s.rateRun(t, 'u1', runId, -1, 'wrong total')).toBe(true)
    expect((await pool.query('select rating, rating_note from tv_runs where id = $1', [runId])).rows[0]).toEqual({ rating: -1, rating_note: 'wrong total' })
  })

  it('runs a whole chat through createAssistant: question, card, reply, and the run log', async () => {
    const storage = supabaseStorage(service())
    const t = tenant()
    const files = memoryFiles()
    const model = new MockLanguageModelV4({ doStream: async ({ prompt }) => (JSON.stringify(prompt).includes('tool-result') ? say('Ready to confirm.') : call('pay', { amount: 200 })) })
    const teovo = createAssistant({
      identify: () => ({ tenantId: t, userId: 'u1', role: 'owner' }), asUser: () => null, storage, instructions: 'Help.', models: [model],
      tools: [defineTool({ name: 'pay', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }), run: ({ amount }) => ({ kind: 'pay', title: `Pay ₹${amount}`, after: { paid: amount }, payload: { amount } }) })],
      cards: { pay: { apply: () => ({ undo: 1 }), undo: () => {} } }, files: { store: files },
    })
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'q', role: 'user', parts: [{ type: 'text', text: 'paid 200' }] } }) }))
    await res.text()
    const threadId = res.headers.get('x-teovo-thread')!
    const saved = await storage.listMessages(threadId)
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant'])
    const cards = await storage.listCards(threadId)
    expect(cards).toHaveLength(1)
    const decided = await teovo.fetch(new Request(`https://a.test/cards/${cards[0]!.id}/confirm`, { method: 'POST', body: '{"reversible":true}' }))
    expect(decided.status).toBe(200)
    const { rows } = await pool.query('select status from tv_runs where thread_id = $1', [threadId])
    expect(rows.map((r) => r.status)).toEqual(['done'])
    const { rows: steps } = await pool.query('select name from tv_run_steps s join tv_runs r on r.id = s.run_id where r.thread_id = $1', [threadId])
    expect(steps.map((r) => r.name)).toEqual(['pay'])
  })

  it('keeps picture owner rows in tv_files without the bytes', async () => {
    const index = supabaseFileIndex(service())
    const t = tenant()
    const th = await supabaseStorage(service()).createThread(t, 'u1')
    const id = crypto.randomUUID()
    await index.put({ id, tenantId: t, userId: 'u1', threadId: th.id, mediaType: 'image/jpeg', filename: 'bill.jpg' })
    expect(await index.get(t, id)).toMatchObject({ id, tenantId: t, userId: 'u1', threadId: th.id, mediaType: 'image/jpeg', filename: 'bill.jpg' })
    expect(await index.get(`${t}x`, id)).toBeNull()
  })

  it('keeps the audit trail and misses, and wipe removes one person, their pictures included', async () => {
    const svc = service()
    const s = supabaseStorage(svc)
    const t = tenant()
    const th = await s.createThread(t, 'u1')
    await s.createThread(t, 'u2')
    await s.addCardEvent({ cardId: crypto.randomUUID(), threadId: th.id, tenantId: t, userId: 'u1', kind: 'pay', title: 'Pay', event: 'proposed' })
    await s.addMiss({ tenantId: t, userId: 'u1', question: 'refund?', reason: 'no tool' })
    expect((await s.listCardEvents(t, { limit: 5 })).map((e) => e.event)).toEqual(['proposed'])
    expect((await s.listMisses(t, { limit: 5 })).map((m) => m.question)).toEqual(['refund?'])
    const index = supabaseFileIndex(svc)
    const id = crypto.randomUUID()
    await index.put({ id, tenantId: t, userId: 'u1', threadId: th.id, mediaType: 'image/png' })
    expect((await index.list(t, 'u1')).map((f) => f.id)).toEqual([id])
    expect(await s.wipe(t, 'u1')).toEqual({ threads: 1 })
    expect(await s.listThreads(t, 'u2', 5)).toHaveLength(1)
    expect(await s.listCardEvents(t, { limit: 5 })).toEqual([])
    expect(await index.list(t, 'u1')).toEqual([])   // owner rows went with the conversation
  })

  it('locks the tables against the browser: the public key sees and changes nothing', async () => {
    const t = tenant()
    await supabaseStorage(service()).createThread(t, 'u1')
    const browser = createClient(url!, anonKey!, opts)
    const read = await browser.from('tv_threads').select('*').eq('tenant_id', t)
    expect(read.data ?? []).toEqual([])
    const write = await browser.from('tv_usage_daily').insert({ tenant_id: t, user_id: '', day: '2026-11-27', unit: 'messages', amount: -999 })
    expect(write.error).not.toBeNull()
    const fn = await browser.rpc('tv_add_usage_daily', { p_tenant: t, p_user: 'u1', p_day: '2026-11-27', p_unit: 'messages', p_amount: -999 })
    expect(fn.error).not.toBeNull()
  })
})
