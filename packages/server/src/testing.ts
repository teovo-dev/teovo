/**
 * @teovo/server/testing: test an assistant without calling a real model.
 *
 *   - scriptedModel([callTool('get_sales', {}), say('₹4,200 today')]) plays steps in order.
 *   - recordingModel(realModel, cassette) wraps a real model and saves what it said at each step;
 *     replayModel(cassette) plays it back, so a real conversation becomes a fast, repeatable test.
 *   - swapIds turns database ids into stable names before saving, and back before replaying.
 *   - chat(teovo, 'who owes money?') sends one message and returns the reply, cards, buttons, views and tool calls.
 */
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

/** One model step: the stream parts it sent. */
export interface Step { parts: LanguageModelV4StreamPart[] }

/** A recorded conversation: the model's steps, in order. Saved as JSON next to the test. */
export interface Cassette { name?: string; steps: Step[] }

const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } }
const finish = (unified: 'stop' | 'tool-calls') => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage }) as LanguageModelV4StreamPart

/** A step where the model writes text and stops. */
export const say = (text: string): Step => ({ parts: [
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finish('stop'),
] as LanguageModelV4StreamPart[] })

let calls = 0
/** A step where the model calls one tool (or several, given an array). */
export const callTool = (name: string, input: unknown, ...more: [string, unknown][]): Step => ({ parts: [
  ...[[name, input] as [string, unknown], ...more].map(([n, i]) => ({ type: 'tool-call', toolCallId: `call-${++calls}`, toolName: n, input: JSON.stringify(i) }) as LanguageModelV4StreamPart),
  finish('tool-calls'),
] })

const streamOf = (parts: LanguageModelV4StreamPart[]) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) { for (const p of parts) c.enqueue(structuredClone(p)); c.close() } }) })

/**
 * A model that plays the given steps in order and fails loudly when asked for one more, so a test notices when the
 * assistant loops more than it used to. Pass a function to choose the step from the prompt instead.
 */
export function scriptedModel(steps: Step[] | ((prompt: unknown, index: number) => Step), opts: { modelId?: string; provider?: string } = {}): MockLanguageModelV4 {
  let i = 0
  return new MockLanguageModelV4({
    modelId: opts.modelId ?? 'scripted', provider: opts.provider ?? 'teovo-test',
    doStream: async ({ prompt }) => {
      const n = i++
      if (typeof steps === 'function') return streamOf(steps(prompt, n).parts) as never
      const step = steps[n]
      if (!step) throw new Error(`The assistant asked the model for step ${n + 1}, but only ${steps.length} were scripted or recorded`)
      return streamOf(step.parts) as never
    },
  })
}

/** Plays a recorded conversation back. */
export const replayModel = (cassette: Cassette, opts?: { modelId?: string }) => scriptedModel(cassette.steps, { modelId: opts?.modelId ?? 'replay' })

// Parts worth keeping: what the model said and did. Timing, ids of the provider's response and raw chunks are dropped
// so a recording is stable and small.
const KEEP = new Set(['text-start', 'text-delta', 'text-end', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'tool-call', 'finish'])

/** Wraps a real model: everything works as usual, and each step it streams is appended to `into.steps`. */
export function recordingModel(real: LanguageModelV4, into: Cassette): LanguageModelV4 {
  return {
    specificationVersion: 'v4', provider: real.provider, modelId: real.modelId, supportedUrls: real.supportedUrls,
    doGenerate: (o) => real.doGenerate(o),
    async doStream(options) {
      const res = await real.doStream(options)
      const step: Step = { parts: [] }
      into.steps.push(step)
      const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, c) {
          if (KEEP.has(part.type)) step.parts.push(part.type === 'finish' ? { ...part, usage } as LanguageModelV4StreamPart : structuredClone(part))
          c.enqueue(part)
        },
      })
      return { ...res, stream: res.stream.pipeThrough(tap) }
    },
  }
}

/**
 * Replace every key of `map` found anywhere in a JSON value with its value, including inside strings (tool inputs
 * are JSON strings). Use it to save ids as names ('8f3c…' → '@@order#142@@') and to turn them back.
 */
export function swapIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (!map.size) return value
  const keys = [...map.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(keys.join('|'), 'g')
  return JSON.parse(JSON.stringify(value).replace(re, (m) => map.get(m)!)) as T
}

/** What one message produced, in a shape easy to assert on. */
export interface ChatResult {
  status: number
  /** The server's sentence when it refused (401, 429, …). */
  error?: string
  threadId: string | null
  text: string
  cards: { id: string; kind: string; title: string; before?: unknown; after?: unknown; payload: unknown; untrustedSources?: string[]; fields?: unknown[]; items?: { label: string; before?: Record<string, unknown>; after?: Record<string, unknown> }[]; version?: number }[]
  actions: { label: string; action: string; args?: Record<string, unknown> }[]
  views: { id: string; view: string; data: unknown }[]
  /** Tools the assistant ran, in order. */
  tools: string[]
  suggestions: string[]
  message?: UIMessage
}

/** Send one message to an assistant (anything with createAssistant's fetch) and read the whole reply. */
export async function chat(teovo: { fetch: (req: Request) => Promise<Response> }, text: string, opts: { threadId?: string; page?: unknown; url?: string; headers?: Record<string, string> } = {}): Promise<ChatResult> {
  const res = await teovo.fetch(new Request(opts.url ?? 'https://teovo.test/chat', {
    method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify({ threadId: opts.threadId, page: opts.page, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } }),
  }))
  const threadId = res.headers.get('x-teovo-thread')
  const empty: ChatResult = { status: res.status, threadId, text: '', cards: [], actions: [], views: [], tools: [], suggestions: [] }
  if (!res.ok) return { ...empty, error: ((await res.json().catch(() => ({}))) as { error?: string }).error }
  const chunks = (await res.text()).split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)) as UIMessageChunk)
  const suggestions = chunks.flatMap((c) => (c.type === 'data-suggestions' ? ((c as { data: { suggestions: string[] } }).data.suggestions) : []))
  const error = chunks.find((c) => c.type === 'error') as { errorText?: string } | undefined
  let last: UIMessage | undefined
  for await (const m of readUIMessageStream({ stream: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } }) })) last = m
  const parts = last?.parts ?? []
  const data = <T>(type: string) => parts.filter((p) => p.type === type).map((p) => ({ ...(p as { data: T }).data, id: (p as { id?: string }).id }))
  return {
    status: res.status, threadId, message: last, suggestions,
    ...(error?.errorText ? { error: error.errorText } : {}),
    text: parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).filter(Boolean).join('\n'),
    // The fields worth asserting on; run and thread ids differ on every run.
    cards: data<ChatResult['cards'][number] & { runId?: string; threadId?: string }>('data-card').map(({ runId: _r, threadId: _t, ...c }) => c),
    actions: parts.filter((p) => p.type === 'data-action').map((p) => (p as { data: ChatResult['actions'][number] }).data),
    views: data<{ view: string; data: unknown }>('data-view') as ChatResult['views'],
    tools: parts.filter((p) => p.type === 'data-step' && (p as { data: { state: string } }).data.state === 'done').map((p) => (p as { data: { name: string } }).data.name),
  }
}
