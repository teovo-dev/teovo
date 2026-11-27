import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'

/** Parts a model may send before any real content; an error after only these still counts as "nothing said yet". */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'ping', 'raw'])

/**
 * One model built from an ordered list: if a model fails before saying anything, the next one is tried.
 * `canSwitch` is asked first; it returns false once a tool has changed something, so a run never continues
 * on a different model after a write.
 */
/** A model that said nothing within the first-output time. */
export class FirstOutputTimeout extends Error {
  constructor(model: string, ms: number) { super(`${model} sent nothing for ${Math.round(ms / 100) / 10} s`) }
}

/**
 * `firstOutputMs` times each model from the moment it is called until its first real content. It has to be timed
 * here: providers such as Gemini send nothing at all until they have words ready, so a timer that starts when the
 * stream opens (the AI SDK's firstChunkMs) never sees the wait.
 */
export function fallbackModel(models: readonly LanguageModelV4[], canSwitch: () => boolean, onSwitch?: (from: string, error: unknown) => void, firstOutputMs?: number): LanguageModelV4 {
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
        // This attempt's own signal: the caller's, plus the first-output timer, so a stalled model is cancelled.
        const attempt = new AbortController()
        const onAbort = () => attempt.abort(options.abortSignal?.reason)
        options.abortSignal?.addEventListener('abort', onAbort, { once: true })
        let timedOut = false
        const timer = firstOutputMs ? setTimeout(() => { timedOut = true; attempt.abort(new FirstOutputTimeout(m.modelId, firstOutputMs)) }, firstOutputMs) : undefined
        try {
          const first = (async () => {
            const res = await m.doStream({ ...options, abortSignal: attempt.signal })
            const reader = res.stream.getReader()
            const held: LanguageModelV4StreamPart[] = []
            for (;;) {   // read until the first real content, so an early error can still fall back
              const { done, value } = await reader.read()
              if (done) break
              if (value.type === 'error') throw value.error
              held.push(value)
              if (!PREAMBLE.has(value.type)) break
            }
            return { res, reader, held }
          })()
          const stalled = new Promise<never>((_, reject) => attempt.signal.addEventListener('abort', () => reject(timedOut ? attempt.signal.reason : (options.abortSignal?.reason ?? attempt.signal.reason)), { once: true }))
          stalled.catch(() => {})   // a later Stop rejects it; nothing waits on it by then
          first.catch(() => {})     // a timeout leaves this attempt to fail on its own
          const { res, reader, held } = await Promise.race([first, stalled])
          clearTimeout(timer)
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
          clearTimeout(timer)
          options.abortSignal?.removeEventListener('abort', onAbort)
          if (options.abortSignal?.aborted) throw e   // the user stopped it: don't try the next model
          last = e
          onSwitch?.(m.modelId, e)
        }
      }
      throw last
    },
  }
}
