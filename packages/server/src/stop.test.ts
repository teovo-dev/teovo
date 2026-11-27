import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }

/** A model that writes one word every 20 ms until it is told to stop, and records whether it was. */
function slowModel() {
  const seen = { aborted: false, words: 0 }
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(c) {
          c.enqueue({ type: 'text-start', id: 't' })
          for (let i = 0; i < 100; i++) {
            if (abortSignal?.aborted) { seen.aborted = true; c.error(abortSignal.reason ?? new Error('aborted')); return }
            c.enqueue({ type: 'text-delta', id: 't', delta: `word${i} ` })
            seen.words++
            await new Promise((r) => setTimeout(r, 20))
          }
          c.enqueue({ type: 'text-end', id: 't' })
          c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage })
          c.close()
        },
      }),
    }),
  })
  return { model, seen }
}

describe('stop', () => {
  it('stops the model when the browser hangs up, and saves what was written, marked as stopped', async () => {
    const storage = memoryStorage()
    const { model, seen } = slowModel()
    const teovo = createAssistant({ identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, tools: [], instructions: 'Help.', storage, models: [model] })
    const ac = new AbortController()
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', signal: ac.signal, body: JSON.stringify({ message: { id: 'q', role: 'user', parts: [{ type: 'text', text: 'write a lot' }] } }) }))
    const reader = res.body!.getReader()
    let got = ''
    while (!got.includes('word3')) got += new TextDecoder().decode((await reader.read()).value)
    ac.abort()
    await reader.cancel().catch(() => {})
    await new Promise((r) => setTimeout(r, 150))

    expect(seen.aborted).toBe(true)
    expect(seen.words).toBeLessThan(20)                   // it did not run on to the end
    const thread = res.headers.get('x-teovo-thread')!
    const saved = (await storage.listMessages(thread)).at(-1)!
    expect(saved.role).toBe('assistant')
    expect(saved.metadata).toMatchObject({ stopped: true })
    expect(JSON.stringify(saved.parts)).toContain('word0')
  })
})
