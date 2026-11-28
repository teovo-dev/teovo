import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, StartError, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel, type Step } from './testing'
import { defineTool, type Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }

const tools = [
  defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: (_i, ctx) => [{ no: 4, due: 250, by: (ctx.db as { as?: string }).as }] }),
  defineTool({
    name: 'record_payment', kind: 'propose', description: 'Record a payment', input: z.object({ amount: z.number() }),
    run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, payload: { amount } }),
  }),
]

function app(steps: Step[], extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  const model = scriptedModel(steps)
  const teovo = createAssistant({ identify: () => nisha, asUser: () => ({ as: 'request' }), instructions: 'Help.', storage, tools, models: [model], ...extra })
  return { teovo, storage, model }
}

describe('teovo.start: replies the app starts, with no one at the screen', () => {
  it('runs a reply in the person\'s conversations, marked as the app\'s, and returns it', async () => {
    const { teovo, storage, model } = app([callTool('list_orders', {}), callTool('record_payment', { amount: 250 }), say('Good morning! Order 4 still owes ₹250; a payment card is ready.')])
    const out = await teovo.start({ identity: nisha, text: 'Morning check: what needs doing today?', label: 'Morning check', db: { as: 'cron' } })
    expect(out).toMatchObject({ status: 'done', text: 'Good morning! Order 4 still owes ₹250; a payment card is ready.', cards: [{ kind: 'record_payment', title: 'Payment ₹250' }] })
    // In Nisha's own list, titled by the app's question.
    const threads = await storage.listThreads('shop', 'nisha', 10)
    expect(threads.map((t) => t.id)).toEqual([out.threadId])
    const [asked, answered] = await storage.listMessages(out.threadId)
    expect(asked).toMatchObject({ role: 'user', metadata: { from: 'app', label: 'Morning check' } })
    expect(answered!.metadata).toMatchObject({ runId: out.runId })
    // The tools ran with the db given; the model was told the message was the app's, not hers.
    expect(storage.steps.find((s) => s.name === 'list_orders')!.output).toEqual([{ no: 4, due: 250, by: 'cron' }])
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('Started by the app (Morning check), not typed by the user')
    // The card waits for her: she confirms it later like any other.
    const card = (await storage.listCards(out.threadId))[0]!
    expect(card.status).toBe('shown')
  })

  it('a person cannot pass their own message off as the app\'s', async () => {
    const { teovo } = app([])
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { from: 'app' } } }) }))
    expect(res.status).toBe(400)
  })

  it('continues a conversation when given one, and she can carry on from there', async () => {
    const { teovo, storage } = app([say('Hello Nisha.'), say('Order 4 owes ₹250.'), say('You are welcome.')])
    const first = await chat(teovo, 'hello')
    const out = await teovo.start({ identity: nisha, text: 'Remind her about order 4', threadId: first.threadId!, db: {} })
    expect(out.threadId).toBe(first.threadId)
    expect((await chat(teovo, 'thanks', { threadId: first.threadId! })).text).toBe('You are welcome.')
    expect((await storage.listMessages(first.threadId!)).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  })

  it('needs no notice consent (no person is there), but keeps limits and the switch-off', async () => {
    const { teovo, storage } = app([say('Done.')], { limits: { user: { messages: 1 } } })
    await storage.saveTenantSettings('shop', { enabled: true, privacy: { notice: 'We send your questions to Google.' } })
    expect((await teovo.start({ identity: nisha, text: 'check', db: {} })).status).toBe('done')
    await expect(teovo.start({ identity: nisha, text: 'check again', db: {} })).rejects.toMatchObject({ name: 'StartError', status: 429 })
    await storage.saveTenantSettings('shop', { enabled: false })
    const err = await teovo.start({ identity: nisha, text: 'check', db: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(StartError)
    expect(err.status).toBe(403)
  })

  it('with long runs: runs on the run log, and can return before the reply ends', async () => {
    let open!: () => void
    const slow = new Promise<void>((r) => { open = r })
    const storage = memoryStorage()
    const teovo = createAssistant({
      identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, models: [scriptedModel([callTool('add_up', {}), say('It comes to 250.')])],
      tools: [defineTool({ name: 'add_up', kind: 'read', description: 'Adds up', input: z.object({}), run: async (_i, ctx) => { await slow; return { total: 250, as: ctx.db } } })],
      runs: { heartbeatMs: 10, pollMs: 5, flushMs: 5, asUser: () => 'worker-db' },
    })
    const out = await teovo.start({ identity: nisha, text: 'Nightly total', wait: false })
    expect(out.status).toBe('running')
    expect(out.text).toBeUndefined()
    open()
    for (let i = 0; i < 200 && storage.runs.get(out.runId)!.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(storage.runs.get(out.runId)!.status).toBe('done')
    expect(storage.steps.find((s) => s.name === 'add_up')!.output).toEqual({ total: 250, as: 'worker-db' })   // runs.asUser, as no db was given
    // Waited for: the reply comes back.
    const teovo2 = createAssistant({ identify: () => nisha, asUser: () => null, instructions: '', storage, tools: [], models: [scriptedModel([say('All quiet.')])], runs: { asUser: () => null } })
    expect(await teovo2.start({ identity: nisha, text: 'Heartbeat' })).toMatchObject({ status: 'done', text: 'All quiet.' })
  })

  it('without db or runs.asUser it says what it needs', async () => {
    const { teovo } = app([])
    await expect(teovo.start({ identity: nisha, text: 'check' })).rejects.toThrow('teovo.start needs db, or runs.asUser')
  })
})
