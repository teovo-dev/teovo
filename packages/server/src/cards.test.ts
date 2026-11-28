import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import type { CardApplier } from './cards'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const streamOf = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const say = (text: string) => streamOf([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }])
const call = (toolName: string, input: unknown) => streamOf([{ type: 'tool-call', toolCallId: `c-${Math.random()}`, toolName, input: JSON.stringify(input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }])

const owner: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const staff: Identity = { tenantId: 'shop-1', userId: 'u2', role: 'staff' }

/** A tiny "app": one order whose paid amount the cards change. */
function app(extra: Partial<AssistantConfig<{ as: string }>> = {}, applier: Partial<CardApplier> = {}) {
  const order = { no: 2, paid: 0 }
  const payments: { id: string; amount: number; by: string }[] = []
  const applied = vi.fn()
  const storage = memoryStorage()
  let who: Identity | null = owner
  const model = new MockLanguageModelV4({ doStream: async ({ prompt }) => {
    const p = JSON.stringify(prompt)
    return p.includes('paid 200') && !p.includes('tool-result') && !p.includes('[Card') ? call('record_payment', { amount: 200 }) : say('ok')
  } })
  const teovo = createAssistant({
    identify: () => who, asUser: (id) => ({ as: id.userId }), storage, instructions: 'Help.', models: [model],
    tools: [defineTool({ name: 'record_payment', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }),
      run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, before: { paid: order.paid }, after: { paid: order.paid + amount }, payload: { no: 2, amount } }) })],
    cards: {
      record_payment: {
        current: () => ({ paid: order.paid }),
        apply: async ({ amount }: { amount: number }, ctx) => {
          applied(ctx.db)
          const id = crypto.randomUUID()
          payments.push({ id, amount, by: ctx.identity.userId })
          order.paid += amount
          return { undo: { paymentId: id } }
        },
        undo: ({ paymentId }: any, { amount }: { amount: number }) => {
          payments.splice(payments.findIndex((p) => p.id === paymentId), 1)
          order.paid -= amount
        },
        ...applier,
      },
    },
    ...extra,
  })
  const as = (i: Identity | null) => { who = i }
  const chat = async (text: string, threadId?: string) => {
    const res = await teovo.fetch(new Request('https://a.test/api/assistant/chat', { method: 'POST', body: JSON.stringify({ threadId, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } satisfies UIMessage }) }))
    await res.text()
    return res.headers.get('x-teovo-thread')!
  }
  const decide = async (id: string, d: string) => {
    const res = await teovo.fetch(new Request(`https://a.test/api/assistant/cards/${id}/${d}`, { method: 'POST' }))
    return { status: res.status, body: (await res.json()) as { card?: any; error?: string } }
  }
  const proposed = async () => { const t = await chat('paid 200'); return { thread: t, id: [...storage.cards.values()].at(-1)!.id } }
  return { teovo, storage, order, payments, applied, model, as, chat, decide, proposed }
}

describe('cards', () => {
  it('applies a confirmed card as the user, once, and never sends undo data to the browser', async () => {
    const decided = vi.fn()
    const a = app({ on: { decision: decided } })
    const { id } = await a.proposed()
    const [r1, r2] = await Promise.all([a.decide(id, 'confirm'), a.decide(id, 'confirm')])   // a double tap
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect(a.order.paid).toBe(200)
    expect(a.applied).toHaveBeenCalledTimes(1)
    expect(a.applied).toHaveBeenCalledWith({ as: 'u1' })
    const ok = r1.status === 200 ? r1 : r2
    expect(ok.body.card).toMatchObject({ status: 'confirmed', decidedBy: 'u1', reversible: true })
    expect(ok.body.card).not.toHaveProperty('undo')
    expect(decided).toHaveBeenCalledWith(expect.objectContaining({ id }), 'confirm', owner)
  })

  it("keeps the card open with the app's sentence when applying fails", async () => {
    let fail = true
    const a = app({}, { apply: () => { if (fail) throw new Error('Order #2 is closed.') } })
    const { id } = await a.proposed()
    expect(await a.decide(id, 'confirm')).toEqual({ status: 422, body: { error: 'Order #2 is closed.' } })
    expect(a.storage.cards.get(id)!.status).toBe('shown')
    fail = false
    expect((await a.decide(id, 'confirm')).status).toBe(200)
  })

  it('refuses a card whose record changed since it was prepared', async () => {
    const a = app()
    const { id } = await a.proposed()
    a.order.paid = 500   // someone else recorded a payment meanwhile
    const r = await a.decide(id, 'confirm')
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/changed since the card was prepared \(paid\)/)
    expect(a.storage.cards.get(id)!.status).toBe('expired')
  })

  it('checks the record even when the card shows no before: Confirm refused if it changed after the card was made', async () => {
    // A card worded as lines, with no before/after table. The applier's current is the whole order, keys in any order.
    let flip = false
    const lines = defineTool({ name: 'record_payment', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }),
      run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, lines: ['Order #2'], payload: { no: 2, amount } }) })
    const a = app({ tools: [lines] }, { current: () => { flip = !flip; return flip ? { no: 2, paid: a.order.paid } : { paid: a.order.paid, no: 2 } } })
    const ok = await a.proposed()
    expect(a.storage.cards.get(ok.id)!.recordVersion).toBe('{"no":2,"paid":0}')
    expect((await a.decide(ok.id, 'confirm')).status).toBe(200)   // same record, keys in another order

    const stale = await a.proposed()
    a.order.paid += 300   // cash taken on the order screen meanwhile
    expect(await a.decide(stale.id, 'confirm')).toEqual({ status: 409, body: { error: 'This changed after the card was made, so nothing was saved. Ask again for a fresh card.' } })
    expect(a.storage.cards.get(stale.id)!.status).toBe('expired')
    expect(a.order.paid).toBe(500)
  })

  it('refuses Undo when the record changed after Confirm, and keeps the fingerprint from the browser', async () => {
    const a = app()
    const { id } = await a.proposed()
    const done = await a.decide(id, 'confirm')
    expect(done.body.card).not.toHaveProperty('recordVersion')
    expect(a.storage.cards.get(id)!.recordVersion).toBe('{"paid":200}')   // what applying left
    a.order.paid += 100   // another payment came in after Confirm
    expect(await a.decide(id, 'undo')).toEqual({ status: 409, body: { error: 'This changed after you confirmed it, so it can’t be undone here. Change it on its own screen instead.' } })
    expect(a.storage.cards.get(id)!.status).toBe('confirmed')
    expect(a.order.paid).toBe(300)
    a.order.paid -= 100   // back as Confirm left it: Undo works again
    expect((await a.decide(id, 'undo')).body.card).toMatchObject({ status: 'undone' })
    expect(a.order.paid).toBe(0)
  })

  it("passes on current's sentence, and skips the Undo check when the record can't be read after applying", async () => {
    let gone = false
    const a = app({}, { current: () => { if (gone) throw new Error('Order #2 was deleted.'); return { paid: a.order.paid } } })
    const c1 = await a.proposed()
    gone = true
    expect(await a.decide(c1.id, 'confirm')).toEqual({ status: 422, body: { error: 'Order #2 was deleted.' } })
    expect(a.storage.cards.get(c1.id)!.status).toBe('shown')

    // Readable before applying, not after (apply removed it): confirmed, and Undo is not blocked by a check it can't make.
    gone = false
    const b = app({}, { current: () => { if (gone) throw new Error('gone'); return { paid: b.order.paid } }, apply: () => { gone = true; return { undo: {} } }, undo: () => { gone = false } })
    const c2 = await b.proposed()
    expect((await b.decide(c2.id, 'confirm')).status).toBe(200)
    expect(b.storage.cards.get(c2.id)!.recordVersion).toBeUndefined()
    expect((await b.decide(c2.id, 'undo')).body.card).toMatchObject({ status: 'undone' })
  })

  it('refuses old cards, other roles, other people, and kinds the app cannot apply', async () => {
    const old = app({ cardRules: { ttlMs: -1 } })
    const c1 = await old.proposed()
    expect((await old.decide(c1.id, 'confirm')).status).toBe(410)

    const roles = app({}, { roles: ['owner'] })
    const c2 = await roles.proposed()
    roles.as(staff)
    expect((await roles.decide(c2.id, 'confirm')).status).toBe(404)   // staff can't even see the owner's card
    roles.as(null)
    expect((await roles.decide(c2.id, 'confirm')).status).toBe(401)
    roles.as(staff)
    const c3 = await roles.proposed()
    expect(await roles.decide(c3.id, 'confirm')).toEqual({ status: 403, body: { error: 'Your role can’t make this change. Ask an owner.' } })

    const none = app({ cards: {} })
    const c4 = await none.proposed()
    expect((await none.decide(c4.id, 'confirm')).status).toBe(501)
    expect(none.order.paid).toBe(0)
  })

  it('skips without changing anything; a skipped card cannot be confirmed', async () => {
    const a = app()
    const { id } = await a.proposed()
    expect((await a.decide(id, 'skip')).body.card.status).toBe('skipped')
    expect((await a.decide(id, 'confirm')).status).toBe(409)
    expect(a.order.paid).toBe(0)
  })

  it('undoes within the window, and not after', async () => {
    const a = app()
    const { id } = await a.proposed()
    await a.decide(id, 'confirm')
    expect((await a.decide(id, 'undo')).body.card).toMatchObject({ status: 'undone' })
    expect(a.order.paid).toBe(0)
    expect(a.payments).toEqual([])
    expect((await a.decide(id, 'undo')).status).toBe(409)

    const late = app({ cardRules: { undoMs: -1 } })
    const c = await late.proposed()
    await late.decide(c.id, 'confirm')
    expect((await late.decide(c.id, 'undo')).status).toBe(410)
    expect(late.order.paid).toBe(200)

    const oneWay = app({}, { undo: undefined })
    const d = await oneWay.proposed()
    expect((await oneWay.decide(d.id, 'confirm')).body.card.reversible).toBe(false)
    expect((await oneWay.decide(d.id, 'undo')).status).toBe(409)
  })

  it('tells the model that preparing a card changes nothing', async () => {
    const a = app()
    await a.proposed()
    const system = (a.model.doStreamCalls[0]!.prompt[0] as { content: string }).content
    expect(system).toContain('Say a change is ready to confirm, never that it is done, recorded or saved')
  })

  it('tells the model in the next message what happened to the card', async () => {
    const a = app()
    const { thread, id } = await a.proposed()
    await a.decide(id, 'confirm')
    await a.chat('thanks', thread)
    const prompt = JSON.stringify(a.model.doStreamCalls.at(-1)!.prompt)
    expect(prompt).toContain('[Card \\"Payment ₹200\\": the user confirmed it and it was applied]')
  })
})
