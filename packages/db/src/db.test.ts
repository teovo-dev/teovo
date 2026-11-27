// Runs against a real Postgres: set TEOVO_TEST_DATABASE_URL (CI provides one). Each test gets its own schema.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { createAssistant, defineTool } from '@teovo/server'
import { MockLanguageModelV4 } from 'ai/test'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateSql, migrate, missingTables, postgresStorage, type Query } from './index'

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
    expect(await migrate(query)).toEqual(['0001_core'])
    expect(await missingTables(query, { proposals: true })).toEqual(['tv_proposals'])
    expect(await migrate(query, { features: { proposals: true } })).toEqual(['0002_proposals'])
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
    client.release()
  })
})
