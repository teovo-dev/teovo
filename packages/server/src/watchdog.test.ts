import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { chat, say, scriptedModel } from '@teovo/server/testing'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'

/** Like Gemini: nothing at all comes back (not even the stream opening) until it is ready, here after `ms`. */
function silentFor(ms: number) {
  const seen = { aborted: false }
  const model = new MockLanguageModelV4({
    modelId: 'slow',
    doStream: ({ abortSignal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
        c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'late' }); c.enqueue({ type: 'text-end', id: 't' })
        c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } }); c.close()
      } }) }), ms)
      abortSignal?.addEventListener('abort', () => { clearTimeout(t); seen.aborted = true; reject(abortSignal.reason) })
    }),
  })
  return { model, seen }
}

function app(models: ConstructorParameters<typeof Object>[0][], firstChunkMs: number) {
  const switched: string[] = []
  const teovo = createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, tools: [], instructions: 'Help.', storage: memoryStorage(),
    models: models as never, timeouts: { firstChunkMs }, on: { modelSwitch: (from, e) => switched.push(`${from}: ${e instanceof Error ? e.message : e}`) },
  })
  return { teovo, switched }
}

describe('first-output timeout', () => {
  it('gives up on a model that stays silent before its stream even opens, and the next model answers', async () => {
    const slow = silentFor(2000)
    const { teovo, switched } = app([slow.model, scriptedModel([say('From the backup.')], { modelId: 'backup' })], 100)
    const started = Date.now()
    const r = await chat(teovo, 'hi')
    expect(r.text).toBe('From the backup.')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(slow.seen.aborted).toBe(true)                 // the stalled call was cancelled, not left running
    expect(switched).toEqual(['slow: slow sent nothing for 0.1 s'])
  })

  it('says the reply could not be finished when every model stalls', async () => {
    const { teovo } = app([silentFor(2000).model], 100)
    const r = await chat(teovo, 'hi')
    expect(r.text).toBe('')
    expect(JSON.stringify(r)).toContain('The assistant could not finish this reply. Try again.')
  })

  it('lets a model that answers in time run as normal', async () => {
    const { teovo, switched } = app([silentFor(20).model], 1000)
    expect((await chat(teovo, 'hi')).text).toBe('late')
    expect(switched).toEqual([])
  })
})
