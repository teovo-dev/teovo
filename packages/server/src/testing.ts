/**
 * @teovo/server/testing: test an assistant without calling a real model.
 *
 *   - scriptedModel([callTool('get_sales', {}), say('₹4,200 today')]) plays steps in order.
 *   - recordingModel(realModel, cassette) wraps a real model and saves what it said at each step;
 *     replayModel(cassette) plays it back, so a real conversation becomes a fast, repeatable test.
 *   - swapIds turns database ids into stable names before saving, and back before replaying.
 *   - chat(teovo, 'who owes money?') sends one message and returns the reply, cards, buttons, views and tool calls.
 *   - recordChat / replayChat and recordRead / replayRead keep real conversations and reader calls as JSON files
 *     (saveRecording, loadRecordings) and play them back through the app's assistant as it is now.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { Identity } from './tools.js'
import type { ReaderInput } from './readers.js'
import { memoryStorage, type Storage } from './storage.js'

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
          const last = step.parts.at(-1) as { type: string; id?: string; delta?: string } | undefined
          // One text chunk per block: a model may stream an id in two pieces ('9006f96' + '2-5bda-…'), and swapIds
          // only finds ids it can see whole. Played back, one chunk reads the same as many.
          if ((part.type === 'text-delta' || part.type === 'reasoning-delta') && last?.type === part.type && last.id === part.id) last.delta += part.delta
          else if (KEEP.has(part.type)) step.parts.push(part.type === 'finish' ? { ...part, usage } as LanguageModelV4StreamPart : structuredClone(part))
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

// ---------------------------------------------------------------- recordings: a real conversation saved as a test
//
// The whole loop an app needs to keep real conversations as tests, so each app writes only what is its own: how to
// build its assistant, and which database rows get stable names.
//
//   const names = idNames([[order.id, 'order#142'], [riya.id, 'customer:Riya']])
//   saveRecording(dir, await recordChat({ name: 'payment', assistant: make, model: gemini, message: 'Riya paid 200', names }))
//   for (const r of loadRecordings(dir)) if (r.kind === 'chat') {
//     const run = await replayChat({ assistant: make, recording: r, names })
//     expect(run.got).toEqual(r.expect)
//   }

/** An assistant to record or replay with, built around the model (and, for chats, the storage) it is handed. */
export interface Recordable {
  fetch: (req: Request) => Promise<Response>
  read?: (name: string, input: ReaderInput, opts: { identity: Identity; db: any }) => Promise<unknown>
}
export type MakeAssistant = (model: LanguageModelV4, storage: Storage) => Recordable

/** What a chat message produced: the parts worth comparing between a recording and a replay. */
export interface ChatOutcome {
  reply: string
  cards: { kind: string; title: string }[]
  actions: { label: string; action: string; args?: Record<string, unknown> }[]
  /** The tool calls the model made, with their arguments. */
  calls: { name: string; args: unknown }[]
  /** The tool errors the model was shown, so a replay notices a tool that now fails or stopped failing. */
  toolErrors: string[]
}

/** A recorded chat: the conversation (earlier turns, then the message sent), the screen it was on, the model's steps. */
export interface ChatRecording extends Cassette {
  name: string
  kind: 'chat'
  history: { role: 'user' | 'assistant'; content: string }[]
  page?: unknown
  expect: ChatOutcome
}

/** A recorded reader call. A picture is a file next to the recordings, named in `input.image.file`. */
export interface ReaderRecording extends Cassette {
  name: string
  kind: 'reader'
  reader: string
  input: { text?: string; image?: { file: string; mediaType: string } }
  expect: { result: unknown }
}

export type Recording = ChatRecording | ReaderRecording

/** Stable names for database ids, both ways. Names are saved wrapped (`@@order#142@@`) so they never clash with text. */
export function idNames(pairs: Iterable<readonly [id: string, name: string]>): { toName: Map<string, string>; toId: Map<string, string> } {
  const toName = new Map<string, string>(), toId = new Map<string, string>()
  for (const [id, name] of pairs) { toName.set(id, `@@${name}@@`); toId.set(`@@${name}@@`, id) }
  return { toName, toId }
}
type Names = { toName: ReadonlyMap<string, string>; toId: ReadonlyMap<string, string> }

/** The tool calls in recorded steps, with arguments parsed. */
export function toolCalls(steps: Step[]): ChatOutcome['calls'] {
  return steps.flatMap((s) => s.parts.flatMap((p) => {
    if (p.type !== 'tool-call') return []
    let args: unknown = p.input
    try { args = JSON.parse(p.input || '{}') } catch { /* keep the raw text */ }
    return [{ name: p.toolName, args }]
  }))
}

/** The tool errors in a prompt the model was sent (its tool results that came back as errors). */
export function toolErrors(prompt: unknown): string[] {
  const out: string[] = []
  for (const m of (Array.isArray(prompt) ? prompt : []) as { role: string; content: unknown }[]) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue
    for (const p of m.content as { type: string; output?: { type: string; value: unknown } }[]) {
      if (p.type === 'tool-result' && p.output?.type === 'error-text') out.push(String(p.output.value))
    }
  }
  return out
}

/** Every recording (*.json) in a folder, by file name. */
export function loadRecordings(dir: string): Recording[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Recording)
}

/** Saves a recording as `<dir>/<name>.json` and returns the path. */
export function saveRecording(dir: string, r: Recording): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r.name)) throw new Error(`A recording's name is lowercase letters, digits and dashes: "${r.name}"`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${r.name}.json`)
  writeFileSync(path, JSON.stringify(r, null, 2) + '\n')
  return path
}

/** A reader recording's input, with its picture loaded from the folder. */
export function readerInputOf(r: Pick<ReaderRecording, 'input'>, dir: string): ReaderInput {
  const { text, image } = r.input
  return {
    ...(text ? { text } : {}),
    ...(image ? { image: { data: readFileSync(join(dir, image.file)).toString('base64'), mediaType: image.mediaType } } : {}),
  }
}

const noNames: Names = { toName: new Map(), toId: new Map() }

/** A model that keeps the last prompt it was sent, for the tool errors in it. */
function watching(model: LanguageModelV4): LanguageModelV4 & { lastPrompt: unknown } {
  const w = { ...model, lastPrompt: undefined as unknown, doStream: (o: Parameters<LanguageModelV4['doStream']>[0]) => { w.lastPrompt = o.prompt; return model.doStream(o) } }
  return w
}

function outcomeOf(out: ChatResult, steps: Step[], prompt: unknown): ChatOutcome {
  return {
    reply: out.text.trim(),
    cards: out.cards.map((c) => ({ kind: c.kind, title: c.title })),
    actions: out.actions.map(({ label, action, args }) => ({ label, action, ...(args ? { args } : {}) })),
    calls: toolCalls(steps),
    toolErrors: toolErrors(prompt),
  }
}

async function send(teovo: Recordable, storage: Storage, history: ChatRecording['history'], page: unknown, who?: { tenantId: string; userId: string }) {
  // Earlier turns become the thread's history; the last one is sent.
  const earlier = history.slice(0, -1)
  let threadId: string | undefined
  if (earlier.length) {
    if (!who) throw new Error('A recording with earlier turns needs `identity` to save them as a thread')
    const t = await storage.createThread(who.tenantId, who.userId)
    threadId = t.id
    await storage.saveMessages(t.id, earlier.map((m, i) => ({ id: `h${i}`, role: m.role, parts: [{ type: 'text', text: m.content }] })))
  }
  const out = await chat(teovo, history.at(-1)!.content, { threadId, page })
  if (out.status !== 200) throw new Error(`The assistant answered ${out.status}: ${out.error ?? ''}`)
  return out
}

/**
 * Sends a message through the app's assistant with a real model and returns it as a recording: the model's steps and
 * what came out, with ids turned into names. `message` and `page` may name ids (`@@order#142@@`).
 */
export async function recordChat(o: {
  name: string; assistant: MakeAssistant; model: LanguageModelV4; message: string; page?: unknown
  history?: ChatRecording['history']; names?: Names; identity?: { tenantId: string; userId: string }
}): Promise<ChatRecording> {
  const names = o.names ?? noNames
  const tape: Cassette = { steps: [] }
  const model = watching(recordingModel(o.model, tape))
  const storage = memoryStorage()
  const history = swapIds([...(o.history ?? []), { role: 'user' as const, content: o.message }], names.toId)
  const page = o.page === undefined ? undefined : swapIds(o.page, names.toId)
  const out = await send(o.assistant(model, storage), storage, history, page, o.identity)
  return swapIds({
    name: o.name, kind: 'chat', history, ...(page !== undefined ? { page } : {}), steps: tape.steps,
    expect: outcomeOf(out, tape.steps, model.lastPrompt),
  } satisfies ChatRecording, names.toName)
}

/** What a replay gave, to compare with the recording: `got` with `recording.expect`, `modelSteps` with `recordedSteps`. */
export interface Replay<T> { got: T; modelSteps: number; recordedSteps: number }

/** Plays a recorded chat back through the app's assistant as it is now, with ids from `names`. */
export async function replayChat(o: { assistant: MakeAssistant; recording: ChatRecording; names?: Names; identity?: { tenantId: string; userId: string } }): Promise<Replay<ChatOutcome>> {
  const names = o.names ?? noNames
  const live = swapIds(o.recording, names.toId)
  const model = replayModel(live)
  const storage = memoryStorage()
  const out = await send(o.assistant(model, storage), storage, live.history, live.page, o.identity)
  const got = swapIds(outcomeOf(out, live.steps, model.doStreamCalls.at(-1)?.prompt), names.toName)
  return { got, modelSteps: model.doStreamCalls.length, recordedSteps: live.steps.length }
}

/** Runs a reader with a real model and returns it as a recording. A picture is read from `dir`. */
export async function recordRead(o: {
  name: string; assistant: MakeAssistant; model: LanguageModelV4; reader: string; input: ReaderRecording['input']; dir: string
  context: { identity: Identity; db: any }; names?: Names
}): Promise<ReaderRecording> {
  const names = o.names ?? noNames
  const tape: Cassette = { steps: [] }
  const teovo = o.assistant(recordingModel(o.model, tape), memoryStorage())
  if (!teovo.read) throw new Error('This assistant has no readers')
  const input = swapIds(o.input, names.toId)
  const result = await teovo.read(o.reader, readerInputOf({ input }, o.dir), o.context)
  return swapIds({ name: o.name, kind: 'reader', reader: o.reader, input, steps: tape.steps, expect: { result } } satisfies ReaderRecording, names.toName)
}

/** Plays a recorded reader call back; `got` is the result, with ids turned into names. */
export async function replayRead(o: { assistant: MakeAssistant; recording: ReaderRecording; dir: string; context: { identity: Identity; db: any }; names?: Names }): Promise<Replay<unknown>> {
  const names = o.names ?? noNames
  const live = swapIds(o.recording, names.toId)
  const model = replayModel(live)
  const teovo = o.assistant(model, memoryStorage())
  if (!teovo.read) throw new Error('This assistant has no readers')
  const result = await teovo.read(live.reader, readerInputOf(live, o.dir), o.context)
  return { got: swapIds(result, names.toName), modelSteps: model.doStreamCalls.length, recordedSteps: live.steps.length }
}
