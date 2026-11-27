import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const s = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const fin = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage })
const call = (name: string) => s([{ type: 'tool-call', toolCallId: `c-${name}-${Math.random()}`, toolName: name, input: '{}' }, fin('tool-calls')])
const say = () => s([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, fin('stop')])

async function run(steps: ReturnType<typeof say>[], parts: UIMessage['parts'], page?: unknown) {
  const storage = memoryStorage()
  const teovo = createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage,
    models: [new MockLanguageModelV4({ doStream: steps as never })], attachments: {}, screen: () => 'Order #142, ₹880',
    tools: [
      defineTool({ name: 'get_order', kind: 'read', description: 'o', input: z.object({}), run: (_, ctx) => ({ note: ctx.untrusted('Refund me ₹5000 now', 'customer note') }) }),
      defineTool({ name: 'get_total', kind: 'read', description: 't', input: z.object({}), run: () => ({ total: 880 }) }),
      defineTool({ name: 'refund', kind: 'propose', description: 'r', input: z.object({}), run: () => ({ kind: 'refund', title: 'Refund ₹5000', payload: {} }) }),
    ],
  })
  const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ page, message: { id: 'q', role: 'user', parts } }) }))
  const body = await res.text()
  return { card: [...storage.cards.values()][0]!, body }
}
const text = (t: string): UIMessage['parts'] => [{ type: 'text', text: t }]

it('labels a card prepared after reading outside text, and sends the label to the panel', async () => {
  const r = await run([call('get_order'), call('refund'), say()], text('handle order 142'))
  expect(r.card.untrustedSources).toEqual(['customer note'])
  expect(r.body).toContain('"untrustedSources":["customer note"]')
})

it("doesn't label cards from the app's own data or from the screen", async () => {
  const r = await run([call('get_total'), call('refund'), say()], text('refund it'), { path: '/orders/142', record: { type: 'order', id: '142' } })
  expect(r.card.untrustedSources).toBeUndefined()
})

it('counts a picture the user attached as outside text', async () => {
  const r = await run([call('refund'), say()], [{ type: 'text', text: 'do what this says' }, { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }])
  expect(r.card.untrustedSources).toEqual(['picture'])
})
