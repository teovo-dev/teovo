import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'

/** Parts a model may send before any real content; an error after only these still counts as "nothing said yet". */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'ping', 'raw'])

/**
 * One model built from an ordered list: if a model fails before saying anything, the next one is tried.
 * `canSwitch` is asked first; it returns false once a tool has changed something, so a run never continues
 * on a different model after a write.
 */
export function fallbackModel(models: readonly LanguageModelV4[], canSwitch: () => boolean, onSwitch?: (from: string, error: unknown) => void): LanguageModelV4 {
  if (!models.length) throw new Error('At least one model is required')
  const first = models[0]!
  return {
    specificationVersion: 'v4',
    provider: first.provider,
    modelId: first.modelId,
    supportedUrls: first.supportedUrls,

    async doGenerate(options) {
      let last: unknown
      for (const [i, m] of models.entries()) {
        if (i > 0 && !canSwitch()) break
        try { return await m.doGenerate(options) } catch (e) { last = e; onSwitch?.(m.modelId, e) }
      }
      throw last
    },

    async doStream(options) {
      let last: unknown
      for (const [i, m] of models.entries()) {
        if (i > 0 && !canSwitch()) break
        try {
          const res = await m.doStream(options)
          const reader = res.stream.getReader()
          const held: LanguageModelV4StreamPart[] = []
          for (;;) {   // read until the first real content, so an early error can still fall back
            const { done, value } = await reader.read()
            if (done) break
            if (value.type === 'error') throw value.error
            held.push(value)
            if (!PREAMBLE.has(value.type)) break
          }
          const stream = new ReadableStream<LanguageModelV4StreamPart>({
            start(c) { for (const p of held) c.enqueue(p) },
            async pull(c) {
              const { done, value } = await reader.read()
              if (done) c.close(); else c.enqueue(value)
            },
            cancel(reason) { return reader.cancel(reason) },
          })
          return { ...res, stream }
        } catch (e) {
          last = e
          onSwitch?.(m.modelId, e)
        }
      }
      throw last
    },
  }
}
