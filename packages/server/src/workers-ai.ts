/**
 * @teovo/server/workers-ai: Cloudflare Workers AI as a Teovo model, through the Worker's `AI` binding.
 *
 *   models: [google('gemini-2.5-flash'), workersAi(env.AI, '@cf/openai/gpt-oss-20b')]
 *
 * Replies stream word by word (stream: true; pass { stream: false } for one answer at once, the shape scoops ran in
 * production before). Each step
 * reports Cloudflare's own cost unit, neurons, in providerMetadata.workersAi.neurons; Teovo adds them to the usage
 * ledger as the unit 'neurons', so a limit like { tenant: { neurons: 2000 } } keeps a business inside the free
 * allowance. When a model doesn't report neurons, `estimateNeurons` is used and marked as an estimate.
 */
import type {
  LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4Prompt,
  LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput,
} from '@ai-sdk/provider'

/** The part of the Worker's `env.AI` binding Teovo uses. */
export interface WorkersAiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }

export interface WorkersAiOptions {
  /** How hard reasoning models (gpt-oss) think before answering. Default 'low', which scoops measured as cheapest at the same accuracy. */
  reasoning?: 'low' | 'medium' | 'high'
  /** Default max_tokens when the call doesn't set one. Default 1500. */
  maxTokens?: number
  /** Neurons to record for a call whose model doesn't report them. Default 50 (scoops measured 30–60 per image). */
  estimateNeurons?: number
  /** Stream replies word by word (Workers AI's stream: true). Default true; false asks for the whole answer at once. */
  stream?: boolean
}

/** The error Teovo sees when Cloudflare refuses because the account's allowance is used up. */
export class WorkersAiLimitError extends Error {
  constructor(message: string) { super(`Workers AI allowance used up: ${message}`) }
}

type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
  | { role: 'assistant'; content: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const toBase64 = (b: Uint8Array) => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function fileUrl(data: unknown, mediaType: string): string | null {
  const d = data as { type: string; data?: Uint8Array | string; url?: URL; text?: string }
  if (d.type === 'url' && d.url) return d.url.toString()
  if (d.type === 'data' && d.data !== undefined) return `data:${mediaType};base64,${typeof d.data === 'string' ? d.data : toBase64(d.data)}`
  return null
}

function outputText(o: LanguageModelV4ToolResultOutput): string {
  switch (o.type) {
    case 'text': case 'error-text': return o.value
    case 'json': case 'error-json': return JSON.stringify(o.value)
    case 'execution-denied': return `Not run: ${o.reason ?? 'denied'}`
    default: return 'value' in o && Array.isArray(o.value)
      ? (o.value as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : JSON.stringify(o)
  }
}

/** Teovo's prompt in the OpenAI chat shape Workers AI takes. */
export function toWorkersAiMessages(prompt: LanguageModelV4Prompt): Msg[] {
  const out: Msg[] = []
  for (const m of prompt) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content })
    else if (m.role === 'user') {
      const images = m.content.filter((p) => p.type === 'file' && p.mediaType.startsWith('image/'))
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
      if (!images.length) out.push({ role: 'user', content: text })
      else {
        const parts: Extract<Msg, { role: 'user' }>['content'] = text ? [{ type: 'text', text }] : []
        for (const p of images) {
          const url = p.type === 'file' ? fileUrl(p.data, p.mediaType) : null
          if (url) (parts as unknown[]).push({ type: 'image_url', image_url: { url } })
        }
        out.push({ role: 'user', content: parts })
      }
    } else if (m.role === 'assistant') {
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
      const calls = m.content.filter((p) => p.type === 'tool-call').map((p) => {
        const c = p as { toolCallId: string; toolName: string; input: unknown }
        return { id: c.toolCallId, type: 'function' as const, function: { name: c.toolName, arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}) } }
      })
      // Workers AI rejects null content on an assistant message, so it is always a string.
      out.push(calls.length ? { role: 'assistant', content: text, tool_calls: calls } : { role: 'assistant', content: text })
      for (const p of m.content) if (p.type === 'tool-result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: outputText(p.output) })
    } else if (m.role === 'tool') {
      for (const p of m.content) if (p.type === 'tool-result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: outputText(p.output) })
    }
  }
  return out
}

interface RawCall { id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }
interface RawResult {
  choices?: { message?: { content?: string | null; tool_calls?: RawCall[]; reasoning_content?: string | null }; finish_reason?: string }[]
  response?: unknown
  tool_calls?: RawCall[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number }
}

/** A Workers AI answer as Teovo content, whichever of the two shapes the model uses. */
export function fromWorkersAiResult(raw: unknown): { content: LanguageModelV4Content[]; finish: 'stop' | 'tool-calls' | 'length'; raw?: string } {
  const res = (raw ?? {}) as RawResult
  const choice = res.choices?.[0]
  const text = choice?.message ? (choice.message.content ?? '') : typeof res.response === 'string' ? res.response : res.response != null ? JSON.stringify(res.response) : ''
  const calls = choice?.message?.tool_calls ?? res.tool_calls ?? []
  const content: LanguageModelV4Content[] = []
  const reasoning = choice?.message?.reasoning_content
  if (reasoning) content.push({ type: 'reasoning', text: reasoning })
  if (text.trim()) content.push({ type: 'text', text })
  for (const c of calls) {
    const name = c.function?.name ?? c.name
    if (!name) continue
    const args = c.function?.arguments ?? c.arguments ?? {}
    content.push({ type: 'tool-call', toolCallId: c.id ?? `wai-${crypto.randomUUID()}`, toolName: name, input: typeof args === 'string' ? args : JSON.stringify(args) })
  }
  const r = choice?.finish_reason
  const finish = calls.length ? 'tool-calls' : r === 'length' ? 'length' : 'stop'
  return { content, finish, ...(r ? { raw: r } : {}) }
}

const LIMIT = /neuron|quota|allowance|daily limit|429|capacity/i

function replay(raw: unknown, estimate: number): ReadableStream<LanguageModelV4StreamPart> {
  const { content, finish, raw: rawFinish } = fromWorkersAiResult(raw)
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  for (const c of content) {
    if (c.type === 'text') parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: c.text }, { type: 'text-end', id: 't' })
    else if (c.type === 'reasoning') parts.push({ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: c.text }, { type: 'reasoning-end', id: 'r' })
    else if (c.type === 'tool-call') parts.push(c as LanguageModelV4StreamPart)
  }
  const usage = ((raw ?? {}) as RawResult).usage ?? {}
  const n = Number(usage.neurons)
  parts.push({
    type: 'finish', finishReason: { unified: finish, raw: rawFinish },
    usage: { inputTokens: { total: usage.prompt_tokens, noCache: usage.prompt_tokens, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: usage.completion_tokens, text: usage.completion_tokens, reasoning: undefined } },
    providerMetadata: { workersAi: { neurons: n > 0 ? n : estimate, estimated: !(n > 0) } },
  } as LanguageModelV4StreamPart)
  return new ReadableStream({ start(ctl) { for (const p of parts) ctl.enqueue(p); ctl.close() } })
}

/** Server-sent events → the JSON of each `data:` line (stops at [DONE]). */
function sseLines(): TransformStream<string, unknown> {
  let buf = ''
  const emit = (line: string, ctl: TransformStreamDefaultController<unknown>) => {
    const t = line.trim()
    if (!t.startsWith('data:')) return
    const data = t.slice(5).trim()
    if (!data || data === '[DONE]') return
    try { ctl.enqueue(JSON.parse(data)) } catch { /* a line we can't read is skipped, not fatal */ }
  }
  return new TransformStream({
    transform(chunk, ctl) {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) emit(l, ctl)
    },
    flush(ctl) { if (buf) emit(buf, ctl) },
  })
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
  response?: unknown
  tool_calls?: RawCall[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number }
}

/**
 * Workers AI's stream chunks → Teovo stream parts. Two shapes arrive: OpenAI-style deltas (gpt-oss: content,
 * reasoning_content, tool_calls whose arguments come in pieces) and { response } tokens (Llama-style). The last
 * chunk carries the whole reply's usage, neurons included; if it is missing, the per-chunk neurons are added up.
 */
function workersAiParts(model: string, estimate: number): TransformStream<unknown, LanguageModelV4StreamPart> {
  let text = false, reasoning = false, finish: string | undefined
  let neuronsSum = 0, total: StreamChunk['usage'] | undefined, promptTokens = 0, completionTokens = 0
  const calls = new Map<number, { id: string; name: string; args: string }>()
  return new TransformStream({
    start(ctl) { ctl.enqueue({ type: 'stream-start', warnings: [] }) },
    transform(raw, ctl) {
      const c = raw as StreamChunk
      if (c.usage) {
        const n = Number(c.usage.neurons)
        // The closing chunk ({ response, usage } with no choices) holds the totals.
        if (!c.choices && c.response !== undefined) total = c.usage
        else {
          if (Number.isFinite(n)) neuronsSum += n
          promptTokens += Number(c.usage.prompt_tokens) || 0
          completionTokens += Number(c.usage.completion_tokens) || 0
        }
      }
      const choice = c.choices?.[0]
      const d = choice?.delta
      if (d?.reasoning_content) {
        if (!reasoning) { ctl.enqueue({ type: 'reasoning-start', id: 'r' }); reasoning = true }
        ctl.enqueue({ type: 'reasoning-delta', id: 'r', delta: d.reasoning_content })
      }
      const piece = d?.content ?? (typeof c.response === 'string' ? c.response : undefined)
      if (piece) {
        if (reasoning) { ctl.enqueue({ type: 'reasoning-end', id: 'r' }); reasoning = false }
        if (!text) { ctl.enqueue({ type: 'text-start', id: 't' }); text = true }
        ctl.enqueue({ type: 'text-delta', id: 't', delta: piece })
      }
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0
        const cur = calls.get(i) ?? { id: tc.id ?? `wai-${crypto.randomUUID()}`, name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        calls.set(i, cur)
      }
      for (const tc of c.tool_calls ?? []) {   // Llama-style: whole calls at once
        const name = tc.function?.name ?? tc.name
        if (!name) continue
        const args = tc.function?.arguments ?? tc.arguments ?? {}
        calls.set(calls.size, { id: tc.id ?? `wai-${crypto.randomUUID()}`, name, args: typeof args === 'string' ? args : JSON.stringify(args) })
      }
      if (choice?.finish_reason) finish = choice.finish_reason
    },
    flush(ctl) {
      if (reasoning) ctl.enqueue({ type: 'reasoning-end', id: 'r' })
      if (text) ctl.enqueue({ type: 'text-end', id: 't' })
      for (const call of calls.values()) {
        if (call.name) ctl.enqueue({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.args || '{}' })
      }
      const reported = Number(total?.neurons ?? neuronsSum)
      const neurons = reported > 0 ? reported : estimate
      const inTok = total?.prompt_tokens ?? (promptTokens || undefined)
      const outTok = total?.completion_tokens ?? (completionTokens || undefined)
      ctl.enqueue({
        type: 'finish',
        finishReason: { unified: calls.size ? 'tool-calls' : finish === 'length' ? 'length' : 'stop', raw: finish },
        usage: { inputTokens: { total: inTok, noCache: inTok, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: outTok, text: outTok, reasoning: undefined } },
        providerMetadata: { workersAi: { neurons, estimated: !(reported > 0), model } },
      } as LanguageModelV4StreamPart)
    },
  })
}

export function workersAi(binding: WorkersAiBinding, model: string, options: WorkersAiOptions = {}): LanguageModelV4 {
  const reasoningModel = /gpt-oss/i.test(model)

  function inputFor(call: LanguageModelV4CallOptions): Record<string, unknown> {
    const tools = (call.tools ?? []).filter((t) => t.type === 'function').map((t) => {
      const f = t as { name: string; description?: string; inputSchema: unknown }
      return { type: 'function', function: { name: f.name, description: f.description ?? '', parameters: f.inputSchema } }
    })
    const choice = call.toolChoice
    const input: Record<string, unknown> = {
      messages: toWorkersAiMessages(call.prompt),
      max_tokens: call.maxOutputTokens ?? options.maxTokens ?? 1500,
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      ...(tools.length && choice?.type !== 'none' ? { tools } : {}),
      ...(choice?.type === 'required' ? { tool_choice: 'required' } : choice?.type === 'tool' ? { tool_choice: { type: 'function', function: { name: choice.toolName } } } : {}),
      ...(reasoningModel ? { reasoning_effort: options.reasoning ?? 'low' } : {}),
    }
    return input
  }

  /** Cloudflare refusing because the allowance is used up becomes WorkersAiLimitError, so the next model is tried. */
  async function run(input: Record<string, unknown>): Promise<unknown> {
    try {
      return await binding.run(model, input)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw LIMIT.test(msg) ? new WorkersAiLimitError(msg) : e
    }
  }

  async function generate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const raw = await run(inputFor(call))
    const { content, finish, raw: rawFinish } = fromWorkersAiResult(raw)
    const usage = (raw as RawResult | undefined)?.usage ?? {}
    const reported = Number(usage.neurons)
    const neurons = Number.isFinite(reported) && reported > 0 ? reported : (options.estimateNeurons ?? 50)
    return {
      content,
      finishReason: { unified: finish, raw: rawFinish },
      usage: {
        inputTokens: { total: usage.prompt_tokens, noCache: usage.prompt_tokens, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: usage.completion_tokens, text: usage.completion_tokens, reasoning: undefined },
      },
      providerMetadata: { workersAi: { neurons, estimated: !(Number.isFinite(reported) && reported > 0) } },
      warnings: [],
      response: { modelId: model, body: raw },
    } as LanguageModelV4GenerateResult
  }

  return {
    specificationVersion: 'v4',
    provider: 'workers-ai',
    modelId: model,
    supportedUrls: {},
    doGenerate: generate,
    async doStream(call) {
      if (options.stream === false) {
        const r = await generate(call)
        const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }]
        for (const c of r.content) {
          if (c.type === 'text') parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: c.text }, { type: 'text-end', id: 't' })
          else if (c.type === 'reasoning') parts.push({ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: c.text }, { type: 'reasoning-end', id: 'r' })
          else if (c.type === 'tool-call') parts.push(c as LanguageModelV4StreamPart)
        }
        parts.push({ type: 'finish', finishReason: r.finishReason, usage: r.usage, providerMetadata: r.providerMetadata } as LanguageModelV4StreamPart)
        return { stream: new ReadableStream({ start(ctl) { for (const p of parts) ctl.enqueue(p); ctl.close() } }) }
      }
      // Asked before the stream is returned, so an allowance error still lets the next model answer.
      const body = await run({ ...inputFor(call), stream: true })
      if (!(body instanceof ReadableStream)) {
        // A model that answered in one go even so: replay it.
        return { stream: replay(body, options.estimateNeurons ?? 50) }
      }
      return { stream: body.pipeThrough(new TextDecoderStream()).pipeThrough(sseLines()).pipeThrough(workersAiParts(model, options.estimateNeurons ?? 50)) }
    },
  }
}

/**
 * Workers AI Whisper as a Teovo transcriber (voice.models), e.g. the backup after Gemini. With english (the default
 * in voice) it translates Hindi, Hinglish and so on into English text. Reports the neurons it used.
 */
export function workersAiWhisper(binding: WorkersAiBinding, model = '@cf/openai/whisper-large-v3-turbo'): import('./readers.js').Transcriber {
  return {
    modelId: model,
    provider: 'workers-ai',
    async transcribe(audio, opts) {
      let s = ''
      for (let i = 0; i < audio.length; i += 0x8000) s += String.fromCharCode(...audio.subarray(i, i + 0x8000))
      const out = (await binding.run(model, {
        audio: btoa(s), vad_filter: true, task: opts.english ? 'translate' : 'transcribe', ...(opts.hint ? { initial_prompt: opts.hint } : {}),
      })) as { text?: string; usage?: { neurons?: number } }
      return { text: out.text?.trim() ?? '', ...(out.usage?.neurons ? { neurons: out.usage.neurons } : {}) }
    },
  }
}
