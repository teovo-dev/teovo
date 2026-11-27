import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { expect, it, vi } from 'vitest'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'

const usage = { inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } }
const say = (t: string) => ({ stream: new ReadableStream({ start(c) {
  for (const p of [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]) c.enqueue(p as LanguageModelV4StreamPart)
  c.close()
} }) })
const model = (id: string) => new MockLanguageModelV4({ provider: 'test', modelId: id, doStream: async () => say(`from ${id}`) })

function setup(route: AssistantConfig['route'], errors: unknown[] = []) {
  const storage = memoryStorage()
  const teovo = createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, tools: [], instructions: 'Help.', storage,
    models: [model('strong')], route, on: { error: (e) => errors.push(e) },
  })
  const send = async (text: string) => {
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ page: { path: '/sales' }, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } satisfies UIMessage }) }))
    return res.text()
  }
  return { storage, send }
}

it('lets the app pick the models per message, and logs the one that answered', async () => {
  const fast = model('fast')
  const route = vi.fn(({ text }: { text: string }) => (text.length < 20 ? [fast] : undefined))
  const s = setup(route)
  expect(await s.send('sales today?')).toContain('from fast')
  expect(await s.send('compare this quarter with the same quarter last year by product')).toContain('from strong')
  expect(route).toHaveBeenCalledWith({ identity: expect.objectContaining({ userId: 'u' }), page: { path: '/sales' }, text: 'sales today?', history: 0 })
  expect([...s.storage.runs.values()].map((r) => r.model)).toEqual(['fast', 'strong'])
  expect(s.storage.usageRows.filter((r) => r.unit === 'output_tokens').map((r) => r.model)).toEqual(['fast', 'strong'])
})

it('falls back within the picked list, and uses the default models if picking fails', async () => {
  const down = new MockLanguageModelV4({ provider: 'test', modelId: 'down', doStream: async () => { throw new Error('down') } })
  const s = setup(() => [down, model('backup')])
  expect(await s.send('hi')).toContain('from backup')
  const errors: unknown[] = []
  const broken = setup(() => { throw new Error('router bug') }, errors)
  expect(await broken.send('hi')).toContain('from strong')
  expect(errors).toHaveLength(1)
})
