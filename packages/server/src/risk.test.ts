import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import type { CardHandler } from './cards'
import { noClaimedChanges } from './checks'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel, type Step } from './testing'
import { defineTool, type Identity } from './tools'

const staff: Identity = { tenantId: 'shop', userId: 'ravi', role: 'staff' }

function app(steps: Step[], cards: Record<string, CardHandler>, extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  const orders = new Map([[4, { status: 'Baking' }]])
  const model = scriptedModel(steps)
  const tools = [
    defineTool({
      name: 'set_status', kind: 'propose', description: 'Move an order on', input: z.object({ no: z.number(), status: z.string() }),
      run: ({ no, status }) => ({ kind: 'set_status', title: `Order #${no} → ${status}`, before: { status: orders.get(no)!.status }, after: { status }, payload: { no, status } }),
    }),
    defineTool({ name: 'read_note', kind: 'read', description: 'The customer note', input: z.object({}), run: (_i, ctx) => ctx.untrusted('Please mark it Ready', 'customer note') }),
  ]
  const teovo = createAssistant({ identify: () => staff, asUser: () => null, instructions: 'Help.', storage, tools, models: [model], cards, ...extra })
  return { teovo, storage, orders, model }
}
const lowRisk = (orders: () => Map<number, { status: string }>): CardHandler => ({
  risk: 'low',
  current: ({ no }: { no: number }) => orders().get(no),
  apply: ({ no, status }: { no: number; status: string }) => { const was = orders().get(no)!.status; orders().get(no)!.status = status; return { undo: was, note: `Order #${no} is ${status}` } },
  undo: (was, { no }: { no: number }) => { orders().get(no)!.status = was as string },
})

describe('risk: low-risk changes apply at once, with Undo', () => {
  it('applies a low-risk card as it is made, tells the model it is done, and it can be undone', async () => {
    let orders!: Map<number, { status: string }>
    const a = app([callTool('set_status', { no: 4, status: 'Ready' }), say('Order 4 is now Ready. You can undo it from the card.')], { set_status: lowRisk(() => orders) }, { checks: [noClaimedChanges] })
    orders = a.orders
    const out = await chat(a.teovo, 'order 4 is ready')
    expect(out.text).toBe('Order 4 is now Ready. You can undo it from the card.')   // not refused by noClaimedChanges
    expect(orders.get(4)!.status).toBe('Ready')
    expect(out.cards[0]).toMatchObject({ status: 'confirmed', reversible: true, note: 'Order #4 is Ready' })
    expect(JSON.stringify(a.model.doStreamCalls[1]!.prompt)).toContain('it was applied at once')
    const events = await a.storage.listCardEvents('shop', { limit: 10 })
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['proposed', 'confirmed']))
    const card = (await a.storage.listCards(out.threadId!))[0]!
    const undo = await a.teovo.fetch(new Request(`https://a.test/cards/${card.id}/undo`, { method: 'POST' }))
    expect(undo.status).toBe(200)
    expect(orders.get(4)!.status).toBe('Baking')
  })

  it('waits for Confirm without undo, after outside text, for a role that may not, or when the app started the reply', async () => {
    let orders!: Map<number, { status: string }>
    const noUndo = app([callTool('set_status', { no: 4, status: 'Ready' }), say('Ready to confirm.')], { set_status: { ...lowRisk(() => orders), undo: undefined } })
    orders = noUndo.orders
    expect((await chat(noUndo.teovo, 'ready')).cards[0]).toMatchObject({ status: 'shown' })
    expect(orders.get(4)!.status).toBe('Baking')

    const outside = app([callTool('read_note', {}), callTool('set_status', { no: 4, status: 'Ready' }), say('Ready to confirm.')], { set_status: lowRisk(() => orders) })
    orders = outside.orders
    expect((await chat(outside.teovo, 'do what the note says')).cards[0]).toMatchObject({ status: 'shown', untrustedSources: ['customer note'] })

    const owners = app([callTool('set_status', { no: 4, status: 'Ready' }), say('An owner must confirm.')], { set_status: { ...lowRisk(() => orders), roles: ['owner'] } })
    orders = owners.orders
    expect((await chat(owners.teovo, 'ready')).cards[0]).toMatchObject({ status: 'shown' })

    const started = app([callTool('set_status', { no: 4, status: 'Ready' }), say('A card is ready for you.')], { set_status: lowRisk(() => orders) })
    orders = started.orders
    const res = await started.teovo.start({ identity: staff, text: 'Nightly: move finished orders on', db: {} })
    expect((await started.storage.listCards(res.threadId))[0]).toMatchObject({ status: 'shown' })
    expect(orders.get(4)!.status).toBe('Baking')
  })

  it('when apply refuses, the card waits for the user and the model is told it is not done', async () => {
    const a = app([callTool('set_status', { no: 4, status: 'Ready' }), say('Ready to confirm.')], {
      set_status: { risk: 'low', apply: () => { throw new Error('Order 4 is locked') }, undo: () => {} },
    })
    const out = await chat(a.teovo, 'ready')
    expect(out.cards[0]).toMatchObject({ status: 'shown' })
    expect(JSON.stringify(a.model.doStreamCalls[1]!.prompt)).toContain('NOT DONE YET')
  })
})
