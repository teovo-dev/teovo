import { chat, callTool, recordingModel, replayModel, say, scriptedModel, swapIds, type Cassette } from '@teovo/server/testing'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

/** A tiny shop whose ids change every time it is built, like a fresh test database. */
function shop(model: LanguageModelV4, signedIn = true, orderId: string = crypto.randomUUID()) {
  const teovo = createAssistant({
    identify: () => (signedIn ? { tenantId: 't', userId: 'u', role: 'owner' } : null), asUser: () => null, instructions: 'Help.', storage: memoryStorage(),
    models: [model], suggestions: ({ after }) => ({ suggestions: after ? ['Send a reminder'] : [] }),
    tools: [
      defineTool({ name: 'find_order', kind: 'read', description: 'Find', input: z.object({ no: z.number() }), run: ({ no }) => ({ id: orderId, no, due: 880 }) }),
      defineTool({ name: 'record_payment', kind: 'propose', description: 'Pay', input: z.object({ orderId: z.string(), amount: z.number() }),
        run: ({ orderId: id, amount }) => {
          if (id !== orderId) throw new Error(`No order ${id}`)
          return { kind: 'record_payment', title: `Payment ₹${amount} for order #142`, payload: { orderId: id, amount } }
        } }),
      defineTool({ name: 'open_order', kind: 'action', description: 'Open', input: z.object({}), run: () => ({ label: 'Open order', action: 'navigate', args: { to: '/orders/142' } }) }),
    ],
  })
  return { teovo, orderId }
}

describe('@teovo/server/testing', () => {
  it('records a conversation, saves ids as names, and replays it on a fresh shop with the same result', async () => {
    // "Real" model for the recording: it reads the order, then uses the id it was given.
    let seenId = ''
    const real = scriptedModel((prompt, i) => {
      const p = JSON.stringify(prompt)
      seenId = /"id":"([0-9a-f-]{36})"/.exec(p)?.[1] ?? seenId
      return [callTool('find_order', { no: 142 }), callTool('record_payment', { orderId: seenId, amount: 200 }, ['open_order', {}]), say('Ready to record ₹200.')][i]!
    }, { modelId: 'gemini-real' })
    const cassette: Cassette = { name: 'payment', steps: [] }
    const first = shop(recordingModel(real, cassette))
    const recorded = await chat(first.teovo, 'Riya paid 200 for order 142')
    expect(recorded).toMatchObject({ status: 200, text: 'Ready to record ₹200.', tools: ['find_order', 'record_payment', 'open_order'], suggestions: ['Send a reminder'] })
    expect(recorded.cards).toMatchObject([{ kind: 'record_payment', title: 'Payment ₹200 for order #142', payload: { orderId: first.orderId, amount: 200 } }])
    expect(recorded.actions).toEqual([{ label: 'Open order', action: 'navigate', args: { to: '/orders/142' } }])
    expect(cassette.steps).toHaveLength(3)

    const saved = JSON.parse(JSON.stringify(swapIds(cassette, new Map([[first.orderId, '@@order#142@@']])))) as Cassette
    expect(JSON.stringify(saved)).not.toContain(first.orderId)
    expect(JSON.stringify(saved)).toContain('@@order#142@@')

    const fresh = crypto.randomUUID()   // a newly built shop: same data, new ids
    const replay = shop(replayModel(swapIds(saved, new Map([['@@order#142@@', fresh]]))), true, fresh)
    const replayed = await chat(replay.teovo, 'Riya paid 200 for order 142')
    const strip = (r: typeof recorded) => ({ ...r, threadId: null, message: undefined, cards: r.cards.map(({ id: _, ...c }) => ({ ...c, payload: { ...(c.payload as object), orderId: 'ORDER' } })) })
    expect(strip(replayed)).toEqual(strip(recorded))
    expect(replayed.cards[0]!.payload).toEqual({ orderId: fresh, amount: 200 })
  })

  it('fails loudly when the assistant asks for more steps than were recorded', async () => {
    const r = await chat(shop(replayModel({ steps: [callTool('find_order', { no: 1 })] })).teovo, 'loop')
    expect(r.error).toBe('The assistant could not finish this reply. Try again.')
    const model = replayModel({ steps: [] })
    await expect(model.doStream({ prompt: [] } as never)).rejects.toThrow('asked the model for step 1, but only 0 were scripted or recorded')
  })

  it("returns the server's sentence when it refuses", async () => {
    expect(await chat(shop(scriptedModel([say('x')]), false).teovo, 'hi')).toMatchObject({ status: 401, error: 'Sign in to use the assistant.', text: '' })
  })
})
