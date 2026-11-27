import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { builtinViews } from './views'

describe('things sent twice at the same moment', () => {
  it('a form sent twice at once makes one card', async () => {
    const storage = memoryStorage()
    const model = scriptedModel([callTool('show_form', { title: 'New expense', fields: [{ name: 'amount', label: 'Amount', type: 'number', required: true }], submit: { kind: 'expense', label: 'Save' } }), say('Fill it in.')])
    const teovo = createAssistant({
      identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage, models: [model], tools: [], views: builtinViews,
      forms: { expense: { fields: ['amount'], handle: (v) => ({ kind: 'add_expense', title: `Expense ₹${v.amount}`, after: v, payload: v }) } },
    })
    const r = await chat(teovo, 'add an expense')
    const viewId = r.views[0]!.id
    const send = () => teovo.fetch(new Request(`https://a.test/threads/${r.threadId}/views/${viewId}/submit`, { method: 'POST', body: JSON.stringify({ values: { amount: 450 } }) }))
    const [a, b] = await Promise.all([send(), send()])
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([200]))
    expect(await storage.listCards(r.threadId!)).toHaveLength(1)
  })

  it('two messages at once, with room for one reply, get one reply and one "wait" — and no empty conversation', async () => {
    const storage = memoryStorage()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const model = scriptedModel(() => say('ok'))
    const slow = { ...model, doStream: async (o: Parameters<typeof model.doStream>[0]) => { await gate; return model.doStream(o) } }
    const teovo = createAssistant({
      identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage, models: [slow as never], tools: [],
      limits: { maxRunning: 1 },
    })
    const both = Promise.all([chat(teovo, 'one'), chat(teovo, 'two')])
    await new Promise((r) => setTimeout(r, 50))
    release()
    const statuses = (await both).map((r) => r.status).sort()
    expect(statuses).not.toEqual([200, 200])
    expect(statuses).toContain(429)
    expect((await storage.listThreads('t', 'u', 10)).every((t) => t.title)).toBe(true)   // a refused new chat leaves nothing behind
  })
})
