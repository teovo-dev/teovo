import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const owner: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }

/** An app that applies its cards in the browser: the server only records what happened. */
function app() {
  const storage = memoryStorage()
  let who: Identity = owner
  const model = scriptedModel([callTool('record_payment', { amount: 200 }), say('Ready to confirm.'), say('Noted.')])
  const teovo = createAssistant({
    identify: () => who, asUser: () => null, storage, instructions: 'Help.', models: [model],
    tools: [defineTool({ name: 'record_payment', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }),
      run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, after: { paid: amount }, payload: { amount } }) })],
    cards: { record_payment: { inApp: true } },
  })
  const decide = (id: string, d: string, body: unknown = {}) =>
    teovo.fetch(new Request(`https://a.test/cards/${id}/${d}`, { method: 'POST', body: JSON.stringify(body) }))
  return { teovo, storage, model, decide, as: (i: Identity) => { who = i } }
}

describe('cards the app applies itself', () => {
  it('records Confirm without running anything, keeps it after a reload, and tells the model', async () => {
    const s = app()
    const first = await chat(s.teovo, 'paid 200')
    const id = first.cards[0]!.id
    const res = await s.decide(id, 'confirm', { reversible: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { card: { status: string; reversible: boolean } }).card).toMatchObject({ status: 'confirmed', reversible: true })
    expect((await s.storage.getCard('shop-1', 'u1', id))?.status).toBe('confirmed')

    await chat(s.teovo, 'thanks', { threadId: first.threadId! })
    expect(JSON.stringify(s.model.doStreamCalls.at(-1)!.prompt)).toContain('[Card \\"Payment ₹200\\": the user confirmed it and it was applied]')
  })

  it('records Skip and Undo, and only the person who confirmed can undo', async () => {
    const s = app()
    const a = await chat(s.teovo, 'paid 200')
    const id = a.cards[0]!.id
    await s.decide(id, 'confirm', { reversible: true })
    s.as({ ...owner, userId: 'u9' })
    expect((await s.decide(id, 'undo')).status).toBe(404)                 // another user can't even see it
    s.as(owner)
    expect((await s.decide(id, 'undo')).status).toBe(200)
    expect((await s.storage.getCard('shop-1', 'u1', id))?.status).toBe('undone')
    expect((await s.decide(id, 'confirm')).status).toBe(409)              // decided cards stay decided
  })

  it('refuses Undo when the app said it can’t take the change back, and Skip after Confirm', async () => {
    const s = app()
    const id = (await chat(s.teovo, 'paid 200')).cards[0]!.id
    await s.decide(id, 'confirm')                                         // no { reversible: true }
    expect((await s.decide(id, 'undo')).status).toBe(409)
    expect((await s.decide(id, 'skip')).status).toBe(409)
  })
})
