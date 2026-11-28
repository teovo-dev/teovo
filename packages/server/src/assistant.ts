import type { LanguageModelV4 } from '@ai-sdk/provider'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, readUIMessageStream, streamText, tool, toUIMessageStream, type ModelMessage, type ToolSet, type InferUIMessageChunk, type UIMessage } from 'ai'
import { CHECK_FAILED, firstProblem, refusedNote, type DoneCheck } from './checks.js'
import { runTrace } from './trace.js'
import { fallbackModel } from './fallback.js'
import { CardError, cardForModel, decide, publicCard, type CardHandler, type CardRules, type Decision, fingerprint } from './cards.js'
import type { CardEventKind, Miss } from './storage.js'
import { allowance, checkLimits, limitMessage, type LimitHit, type Limits } from './limits.js'
import type { ClaimedRun, Storage, StoredCard, Thread, Totals, UsageRow } from './storage.js'
import { toolsFor, type Action, type Identity, type RecordLink, type Proposal, type TeovoTool, type ToolContext } from './tools.js'
import { makeUntrusted, UNTRUSTED_RULE } from './untrusted.js'

import { makeRedactor, type RedactOptions } from './redact.js'
import { checkForm, formHandler, formsText, missingFields, VIEWS_RULE, type FormData, type FormHandler, type FormSpec, type TeovoView } from './views.js'
import { checkMessage, type AttachmentRules } from './attachments.js'
import { FILE_SCHEME, loadFiles, picturesOnce, storeFiles, type FileRules } from './files.js'
import { checkFormats, DEFAULT_FORMATS, formatsText, todayText, type Formats } from './formats.js'
import { DEFAULT_SETTINGS, noticeId, SettingsError, settingsText, validateSettings, type TenantSettings } from './settings.js'
import { findScreen, readPage, screenPath, screensText, screenText, tidy, type Page, type ScreenFn, type ScreenInfo, type SuggestionsFn } from './screens.js'
import { z } from 'zod'
import { bytesOf, COULD_NOT_HEAR, readWith, ReaderError, transcribeWith, type ReaderDef, type ReaderInput, type Transcriber } from './readers.js'
export type { Page } from './screens.js'

export interface AssistantConfig<DB = unknown> {
  /** Who is asking, from the request (cookie, token, header). Return null to refuse with 401. Required. */
  identify: (req: Request) => Promise<Identity | null> | Identity | null
  /** A database client acting as this person; every tool receives it as ctx.db. Required. */
  asUser: (identity: Identity, req: Request) => Promise<DB> | DB
  tools: readonly TeovoTool<any, any, DB>[]
  /** Models in order: if one fails before saying anything, the next is tried. */
  models: readonly LanguageModelV4[]
  /**
   * Pick the models for one message, e.g. a cheap model for a quick lookup and a stronger one for a hard question.
   * Return undefined (or an empty list) to use `models`. The run log records which model actually answered.
   */
  route?: (ctx: { identity: Identity; page?: Page; text: string; history: number }) => readonly LanguageModelV4[] | undefined | Promise<readonly LanguageModelV4[] | undefined>
  /**
   * What the assistant is called in this app, e.g. 'Teovo' or 'Oven Help'. The model is told it, and the panel shows it
   * (GET …/policy) on its open button ("Ask Teovo") and as the chat's name. Default: none ("Ask", "Assistant").
   */
  name?: string
  /** The app's own instructions for the model. */
  instructions: string | ((ctx: { identity: Identity; page?: Page }) => string | Promise<string>)
  storage: Storage
  /** Model calls per message, tool calls included. Default 8. */
  maxSteps?: number
  /** Earlier messages the model sees. Default 30. */
  historyMessages?: number
  /**
   * Tool results from earlier replies are cut to this many characters (the latest reply's stay whole), so a long
   * conversation doesn't resend every table it ever read. Default 1500.
   */
  historyToolChars?: number
  /** The app's screens. The model is told about them and gets an open_screen tool that only opens these. */
  screens?: readonly ScreenInfo[]
  /** Give up on a model that sends nothing at first, goes quiet, or runs too long. Milliseconds. */
  timeouts?: { firstChunkMs?: number; chunkMs?: number; totalMs?: number }
  /** Messages and tokens per person and per tenant, checked before every reply. Tenants can set their own in tv_budgets. */
  limits?: Limits
  /** Describe the screen and its open record for the model, as the user. See screens.ts. */
  screen?: ScreenFn<DB>
  /** Chips above the input and the hint inside it; also called after each reply for follow-ups. */
  suggestions?: SuggestionsFn<DB>
  /**
   * How to apply each kind of card when the user confirms it, keyed by the card's `kind`: an applier that runs here,
   * or { inApp: true } when the app applies it in the browser (AssistantProvider onCard) and the server only records it.
   */
  cards?: Record<string, CardHandler<DB>>
  /** How long a card can be confirmed, and how long after confirming it can be undone. */
  cardRules?: Partial<CardRules>
  /** How dates and money are written, and which day it is: the app's default. Tenants can override it in settings. */
  formats?: Partial<Formats>
  /** Let users attach pictures (a bill, a screenshot). Off unless given. The model must be able to read images. */
  attachments?: AttachmentRules
  /**
   * Readers: one input (text, a picture or a recording) in, one answer in a fixed shape out, e.g. a WhatsApp order →
   * an order draft, a bill photo → an expense draft. Same models, fallback, limits and usage as the chat; no
   * conversation. POST …/read/:name, useReader(name) in React, teovo.read(…) on the server (webhooks). Default none.
   */
  readers?: readonly ReaderDef<any, any, DB>[]
  /**
   * Voice to text: POST …/transcribe (raw audio body), the VoiceButton and the chat's microphone. Off unless given.
   * Counted like a message in the limits.
   */
  voice?: {
    /** Models that hear audio, tried in order: language models (Gemini) or transcribers (workersAiWhisper). Default: `models`. */
    models?: readonly (LanguageModelV4 | Transcriber)[]
    /** What people usually say, to help with names and spelling, e.g. 'orders for a dessert shop: tubs, brownies, GPay'. */
    hint?: string
    /** Always write it in English, translating Hindi, Hinglish and so on. Default true. */
    english?: boolean
    /** Largest recording, in bytes. Default 15 MB (about 2–3 minutes). */
    maxBytes?: number
  }
  /**
   * Keep attached pictures in a file store instead of inside the conversation. Strongly recommended with
   * attachments: the message keeps only a reference, served to its owner by GET …/files/:id.
   */
  files?: FileRules
  /** The clock, for tests. */
  now?: () => Date
  /** Views the model can show inside a reply (tables, forms, choices, records). Start from builtinViews. */
  views?: readonly TeovoView[]
  /** Turn a submitted form into a card, keyed by the form's submit.kind. A form whose kind isn't here can't be shown. */
  forms?: Record<string, FormHandler<DB> | FormSpec<DB>>
  /** Hide fields and patterns (phones, emails, UPI ids, card numbers) from the model and the run log. See redact.ts. */
  redact?: RedactOptions
  /** Roles that may read and change their tenant's settings (GET/PUT …/settings). Default ['owner', 'admin']. */
  settingsRoles?: readonly string[]
  /**
   * Words and names the message box completes as people type, without asking the model: customers, products,
   * phrases. Called when the panel opens (GET …/completions); up to 500 are used.
   */
  completions?: (ctx: { identity: Identity; db: DB }) => Promise<string[]> | string[]
  /** The cannot_help tool, which logs what people asked for and couldn't get (GET …/misses). Default on; false to leave it out. */
  misses?: boolean
  /**
   * Done-checks: rules every reply must pass before the user sees it. With any set, the reply's words are held until
   * the checks pass (steps, cards and buttons still show as they happen). A refused reply is written again with the
   * problem explained, up to `checkRetries` times; if every try is refused, the user gets a plain sentence instead.
   */
  checks?: readonly DoneCheck<DB>[]
  /** How many times a refused reply is written again. Default 1. */
  checkRetries?: number
  /**
   * Long runs: each reply is queued in the run log and outlives its request. Closing the panel or losing the
   * connection doesn't stop it; Stop works from any server; a reply whose server stopped or crashed is picked up by
   * another from its last finished step; a reload shows the reply still being written. Needs a storage with a queue
   * (all three of Teovo's, after `npx teovo migrate`). See RunsConfig.
   */
  runs?: RunsConfig<DB>
  /**
   * A spend check and hold, for apps that charge for replies (credits, a wallet): before each reply its price is set
   * aside, a tool (ctx.reserve) or the cost so far can raise it, and when the reply ends it is settled. Teovo keeps
   * no balance: the app's own `reserve` and `settle` do. See SpendRules.
   */
  spend?: SpendRules<DB>
  /**
   * Roles a reply can hand over to partway, each on its own models, e.g. an analyst that reads the data and a writer
   * on a stronger model that writes the report. The model gets a hand_over tool listing them; once it calls it, the
   * rest of the reply runs as that role: its models (with fallback), its instructions, and only its tools. The run
   * log records each hand-over, and usage is counted per model that answered.
   */
  roles?: Record<string, RoleSpec>
  /** Saved on each run, so a change in replies can be traced to a change in instructions. */
  promptVersion?: string
  /** Tool inputs and outputs longer than this are cut in the run log (the model still sees all of it). Default 8000 characters. */
  logLimit?: number
  on?: {
    error?: (error: unknown, ctx: { identity: Identity; threadId: string }) => void
    modelSwitch?: (from: string, error: unknown) => void
    card?: (card: StoredCard) => void
    limit?: (hit: LimitHit, identity: Identity) => void
    usage?: (rows: UsageRow[]) => void
    decision?: (card: StoredCard, decision: Decision, identity: Identity) => void
    /** Someone rated a reply (value null: took the rating back). */
    rating?: (r: { runId: string; value: 1 | -1 | null; note?: string }, identity: Identity) => void
    /** The assistant couldn't answer or do something (it called cannot_help). */
    miss?: (miss: Miss) => void
    /** A reader answered (or failed: error set). */
    read?: (r: { name: string; ok: boolean; error?: string; ms: number }, identity: Identity) => void
    /** A done-check refused a reply (attempt 0 is the first try). `final` when no try is left and the user got CHECK_FAILED. */
    check?: (c: { runId: string; name: string; problem: string; attempt: number; final: boolean }, identity: Identity) => void
  }
}

export interface RunsConfig<DB = unknown> {
  /**
   * Run a reply on the server that took the message (default: true), or leave it queued for a worker
   * (teovo.startWorker() in a long-running process, or teovo.work() from a scheduled job).
   */
  inline?: boolean
  /**
   * Act as the person when their reply runs away from their request: on a worker, or picked up after a restart.
   * Required with inline: false. Without it, a reply that loses its server fails with a sentence instead of resuming.
   */
  asUser?: (identity: Identity) => Promise<DB> | DB
  /** A server holds a run this long between heartbeats before another may take it over. Default 30 s. */
  leaseMs?: number
  /** How often a running reply renews its lease and checks for Stop from another server. Default 2 s. */
  heartbeatMs?: number
  /** Tries per reply (a restart mid-reply costs one) before it fails. Default 3. */
  maxAttempts?: number
  /** How often a server sending a reply that runs elsewhere checks the log for more. Default 500 ms. */
  pollMs?: number
  /** How often the reply's stream is written to the log while it runs. Default 300 ms (and at every finished step). */
  flushMs?: number
  /** This server's name in the run log. Default a random one per process. */
  worker?: string
}

export interface RoleSpec {
  /** What the role is for, for the model deciding when to hand over, e.g. 'writes the final report from what was found'. */
  description: string
  /** The models it runs on, in order (the next is tried if one fails). */
  models: readonly LanguageModelV4[]
  /** Said to the model once it is this role. Default: the description. */
  instructions?: string
  /** The only tools it may use (by name). Default: all of them. */
  tools?: readonly string[]
  /**
   * The app's own plan, checked before each step: true makes this role take over from there, whether or not the
   * model hands over, e.g. ({ text, toolCalls }) => /report/i.test(text) && toolCalls.length > 0. Each role takes
   * over once per reply.
   */
  takesOver?: (ctx: { text: string; toolCalls: string[]; step: number }) => boolean
}

export interface SpendRules<DB = unknown> {
  /** What to set aside before a reply, in the app's unit. */
  hold: number | ((ctx: { identity: Identity; text: string; db: DB }) => number | Promise<number>)
  /**
   * Set `amount` aside for this reply: first (before it starts) or more (mid-reply). True when done; false or a
   * sentence for the user when there isn't enough. Key it by runId: a long run that resumes never asks again for the
   * first hold, but a request retried by the network might.
   */
  reserve: (r: { identity: Identity; runId: string; threadId: string; amount: number; first: boolean; reason?: string }) => boolean | string | Promise<boolean | string>
  /**
   * The reply ended: charge it and give the rest back. `status` tells a finished reply from a stopped or failed one
   * (charge those or not, as the app decides); `used` is what it used (messages, tokens, neurons) and `cost` what
   * `cost` made of it. Called once per reply; a long run resumed after a crash reports only the try that finished.
   */
  settle: (s: { identity: Identity; runId: string; threadId: string; status: 'done' | 'failed' | 'stopped'; used: Totals; cost?: number; held: number }) => void | Promise<void>
  /**
   * What the reply has cost so far, from what it used. With it, whenever the cost passes what is held, `step` more is
   * reserved after the step; when that is refused, the reply ends there with a sentence. Without it, only tools raise.
   */
  cost?: (used: Totals) => number
  /** How much more to reserve each time. Default: the first hold. */
  step?: number
}

/** Said when a reply can't start, or can't go on, because there isn't enough to spend. */
export const NO_SPEND = 'There is not enough left to spend on the assistant for this. An admin can add more.'

/** What a reply needs, whether it runs in the request that asked or on another server later. */
interface ReplyCtx<DB> {
  identity: Identity; thread: Thread; runId: string; message: UIMessage; history: UIMessage[]; page?: Page
  /** The message as stored: its pictures as references to the file store. */
  saved: UIMessage
  models: readonly LanguageModelV4[]; settings: TenantSettings; db: DB; attempt: number; signal: AbortSignal
  /** What is set aside for this reply (spend). */
  held: number
  end: (e: { status: 'done' | 'failed' | 'stopped'; model?: string; error?: string }) => Promise<void>
  /** A resumed run: what its last try finished, sent again first, and the same as a message for the model. */
  replay?: Chunk[]; partial?: UIMessage
  /** False once another server has taken this run over: then this one neither finishes nor saves it. */
  owns?: () => Promise<boolean>
}

/** Something that keeps a Worker alive after its response (Cloudflare's ExecutionContext). */
export interface WaitUntil { waitUntil?(promise: Promise<unknown>): void }

/** What teovo.start() takes: a reply the app starts, with no person at the screen (a schedule, a heartbeat, a webhook). */
export interface StartOptions<DB = unknown> {
  /** Whose reply it is: it goes in their conversations, runs with their role's tools, and counts against their limits. */
  identity: Identity
  /** What the app asks, in words, e.g. 'Morning check: what needs doing today?'. Saved as the app's message, not theirs. */
  text: string
  /** Shown above the app's message in the panel, e.g. 'Morning check'. */
  label?: string
  /** Add to this conversation (theirs). Default: a new one. */
  threadId?: string
  /** The screen to tell the model about, if any. */
  page?: Page
  /** The database as this person. Default: runs.asUser(identity). */
  db?: DB
  /** Long runs: wait until the reply ends (default true), or return once it is running or queued. */
  wait?: boolean
  /** On Workers, the ExecutionContext, so a reply not waited for goes on after the handler returns. */
  ctx?: WaitUntil
  signal?: AbortSignal
}

export interface StartResult {
  threadId: string
  runId: string
  /** 'queued' or 'running' when not waited for (or left to workers). */
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  /** The reply's words, once it has ended. */
  text?: string
  /** Cards it prepared: they wait in the conversation for the person to confirm. */
  cards: { id: string; kind: string; title: string }[]
}

/** teovo.start() refused before anything was saved: a limit, the assistant switched off, not enough to spend. */
export class StartError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'StartError' }
}

/** Said when a reply can't be finished after its server stopped. */
export const INTERRUPTED = 'This reply was cut off when the server restarted. Try again.'

/**
 * What a resumed run keeps of its last try: everything up to the end of the last step that ran a tool. A step
 * still writing, or one with only words, is written again.
 */
function finishedSteps(chunks: Chunk[]): Chunk[] {
  let keep = 0
  let tool = false
  chunks.forEach((c, i) => {
    if (c.type === 'start-step') tool = false
    if (c.type === 'tool-output-available' || c.type === 'tool-output-error') tool = true
    if (c.type === 'finish-step' && tool) keep = i + 1
  })
  return chunks.slice(0, keep)
}

/** The message a stream of chunks builds, as the panel would show it. */
async function messageOf(chunks: Chunk[]): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined
  const stream = new ReadableStream<Chunk>({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } })
  for await (const m of readUIMessageStream({ stream: stream as ReadableStream<InferUIMessageChunk<UIMessage>> })) last = m
  return last
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const ENDED = new Set(['done', 'failed', 'stopped'])

const FAILED = 'The assistant could not finish this reply. Try again.'

/**
 * Said whenever the model can prepare changes. A model once told a shop owner "Payment recorded" when it had only
 * shown a card; the user must never believe something changed before they confirmed it.
 */
export const CARDS_RULE = 'Tools that prepare a change (cards and forms) change nothing by themselves: the user confirms or skips each card. ' +
  'Say a change is ready to confirm, never that it is done, recorded or saved, unless a later message says the user confirmed it. ' +
  'When you know what to change, prepare the card straight away: never ask "shall I?" or "ready to confirm?" in words, the card is how they confirm.'

/** Said when the misses log is on: so the team learns what people ask for that the assistant can't do. */
export const MISS_RULE = 'Try your tools before saying you cannot do something: many questions are answered by fetching a list and ' +
  'reading it yourself (find a name in it, add the amounts up), even when no tool filters exactly that way. Only when your ' +
  'tools truly cannot answer or do what the user asks (no tool covers it, the data is not there, or it is not allowed), ' +
  'call cannot_help, then tell them plainly.'

/**
 * Said when the app has roles: small models gather the numbers and then write the report themselves unless told,
 * plainly, that the writing is another role's job.
 */
function rolesRule(roles: Record<string, RoleSpec> | undefined): string {
  const names = Object.entries(roles ?? {}).filter(([, r]) => r.models.length)
  if (!names.length) return ''
  return `\n\nOther roles carry on parts of a reply, each on its own model: ${names.map(([n, r]) => `the ${n} ${r.description}`).join('; ')}. ` +
    'When the request is what a role is for, gather what it needs with your tools, then call hand_over with a note of what you found. ' +
    'Do not write that part yourself.'
}

/** A UUID that is always the same for the same text (from its SHA-256). */
async function stableId(text: string): Promise<string> {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].slice(0, 16)
  h[6] = (h[6]! & 0x0f) | 0x50   // version 5-style: name-based
  h[8] = (h[8]! & 0x3f) | 0x80
  const x = h.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

/** Said when the model, asked twice, still gives no answer in words. */
const NO_ANSWER = 'I could not put an answer together for that. Try asking in another way.'

/** The row in the tenant-settings table that holds the switches for every tenant (teovo.setSwitches). */
export const SWITCHES = '*'

const DEFAULT_TIMEOUTS = { firstChunkMs: 30_000, chunkMs: 20_000, totalMs: 120_000 }

function clip(v: unknown, max: number): { value: unknown; truncated: boolean } {
  if (v === undefined) return { value: undefined, truncated: false }
  const text = JSON.stringify(v) ?? ''
  return text.length <= max ? { value: v, truncated: false } : { value: text.slice(0, max), truncated: true }
}

/**
 * The one rule for what the model sees of earlier tool results: whole for the latest assistant reply, cut to `max`
 * characters before that, marked so the model knows to look again if it needs more.
 */
function trimToolResults(messages: UIMessage[], max: number): UIMessage[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant')
  return messages.map((m) => (m.role === 'assistant' ? { ...m, parts: m.parts.filter(finishedTool) } : fromApp(m))).map((m, i) => {
    if (m.role !== 'assistant' || i === lastAssistant) return m
    return { ...m, parts: m.parts.map((p) => {
      if (!p.type.startsWith('tool-') || !('output' in p) || p.output === undefined) return p
      const text = JSON.stringify(p.output) ?? ''
      return text.length <= max ? p : { ...p, output: `${text.slice(0, max)}… [cut: an earlier result; call the tool again for all of it]` }
    }) as UIMessage['parts'] }
  })
}

/**
 * A message the app started a reply with (teovo.start): the model is told it came from the app, not the person, so
 * the reply speaks to them ("Good morning: three orders need baking") instead of answering them.
 */
function fromApp(m: UIMessage): UIMessage {
  const meta = m.metadata as { from?: string; label?: string } | undefined
  if (m.role !== 'user' || meta?.from !== 'app') return m
  const note = `[Started by the app${meta.label ? ` (${meta.label})` : ''}, not typed by the user, who is not at the screen now. Write to them.]`
  return { ...m, parts: [{ type: 'text', text: note }, ...m.parts] }
}

/**
 * A tool call the reply was stopped in the middle of has no result, and models refuse a history with one ("Tool
 * result is missing"): such calls are left out of what the model sees.
 */
function finishedTool(p: UIMessage['parts'][number]): boolean {
  if (!(p.type.startsWith('tool-') || p.type === 'dynamic-tool')) return true
  const state = (p as { state?: string }).state
  return state === 'output-available' || state === 'output-error'
}

/** A conversation's title until something better exists: the start of its first question. */
function titleFrom(m: UIMessage): string {
  const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return 'Picture'
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text
}

/** One piece of a reply's stream, as the panel reads it. */
type Chunk = InferUIMessageChunk<UIMessage<{ runId: string; threadId: string; formats: Formats }>>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The request body the panel sends: only the new message; the history stays on the server. */
interface ChatBody {
  threadId?: string; message?: UIMessage; page?: unknown; consent?: string
  /** 'poll' (long runs only): answer at once with the run's id; the panel then reads the reply with GET …/runs/:id/poll. */
  transport?: 'poll'
}

export function createAssistant<DB>(config: AssistantConfig<DB>) {
  if (!config.models.length) throw new Error('createAssistant: at least one model is required')
  if (config.screens?.length && config.tools.some((t) => t.name === 'open_screen')) throw new Error('createAssistant: a tool named open_screen clashes with the screens map; drop one')
  const formatProblem = checkFormats(config.formats ?? {})
  if (formatProblem) throw new Error(`createAssistant: ${formatProblem}`)
  for (const v of config.views ?? []) {
    if (config.tools.some((t) => t.name === `show_${v.name}`)) throw new Error(`createAssistant: tool show_${v.name} clashes with the view ${v.name}`)
  }
  /** The fingerprint of the record a new card changes, when its applier says how to read that record (`current`). */
  const recordVersionOf = async (p: Proposal, ctx: ToolContext<DB>): Promise<string | undefined> => {
    const h = config.cards?.[p.kind]
    return h && 'current' in h && h.current ? fingerprint(await h.current(p.payload, ctx)) : undefined
  }

  const redact = makeRedactor(config.redact)

  async function chat(req: Request, ctx?: WaitUntil): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })

    let body: ChatBody
    try { body = (await req.json()) as ChatBody } catch { return json(400, { error: 'The request was not valid JSON.' }) }
    const message = body.message
    if (!message || message.role !== 'user' || !Array.isArray(message.parts)) return json(400, { error: 'Send one user message with some text.' })
    const problem = checkMessage(message, config.attachments)
    if (problem) return json(400, { error: problem })
    if (body.transport === 'poll' && !queue) return json(400, { error: 'Polling for replies needs long runs (createAssistant runs).' })
    // Not marked as the app's: only teovo.start() writes those.
    if ((message.metadata as { from?: unknown } | undefined)?.from === 'app') return json(400, { error: 'Send one user message with some text.' })

    const b = await begin({ identity, message, threadId: body.threadId, page: readPage(body.page), consent: body.consent, db: () => config.asUser(identity, req) })
    if ('refused' in b) return json(b.refused.status, b.refused.body)
    const { rc } = b
    const { storage } = config
    const runId = rc.runId
    const headers = { 'x-teovo-thread': rc.thread.id }
    if (!queue) return createUIMessageStreamResponse({ stream: await reply({ ...rc, signal: req.signal, end: (e) => storage.finishRun(runId, e) }), headers })
    // A long run: queued in the run log, then run here (unless a worker takes them), and sent from the log, so it goes
    // on when this request ends and any server can send it, stop it or pick it up again.
    const running = await launch(rc)
    if (running) keepAlive(running.done, ctx)
    // For hosts that hold back streamed responses: a plain answer now, the reply through short polls.
    if (body.transport === 'poll') return new Response(JSON.stringify({ threadId: rc.thread.id, runId }), { status: 202, headers: { ...headers, 'content-type': 'application/json' } })
    return createUIMessageStreamResponse({ stream: tail(runId), headers })
  }

  /**
   * Long runs: queue a reply that has begun, and run it here unless workers take replies (inline: false). The run
   * comes back in an object: an async function returning the promise itself would wait for the whole reply.
   */
  async function launch(rc: Omit<ReplyCtx<DB>, 'signal' | 'end'>): Promise<{ done: Promise<void> } | null> {
    await queue!.enqueue(rc.runId, { identity: rc.identity, messageId: rc.message.id, ...(rc.page ? { page: rc.page } : {}), models: rc.models.map((m) => m.modelId) })
    if (config.runs?.inline === false) return null
    const claimed = await queue!.claim(rc.runId, worker, leaseMs)
    const { thread, message, saved, history, models, settings, db, held } = rc
    return claimed ? { done: drive(claimed, { thread, message, saved, history, models, settings, db, held }) } : null
  }

  /**
   * Everything before a reply, for a person's message (chat) and the app's own (teovo.start): the tenant's settings,
   * limits, the conversation, the run, the spend hold, and the message saved. A refusal leaves nothing behind.
   */
  async function begin(p: { identity: Identity; message: UIMessage; threadId?: string; page?: Page; consent?: string; fromApp?: boolean; db: () => Promise<DB> | DB }):
    Promise<{ rc: Omit<ReplyCtx<DB>, 'signal' | 'end'> } | { refused: { status: number; body: Record<string, unknown> } }> {
    const { identity, message, page } = p
    const no = (status: number, body: Record<string, unknown>) => ({ refused: { status, body } })
    const { storage } = config
    const { settings, switches } = await settingsOf(identity.tenantId)
    if (switches && !switches.enabled) return no(503, { error: 'The assistant is paused for everyone at the moment. Try again later.' })
    if (!settings.enabled) return no(403, { error: 'The assistant is turned off for your team. An admin can turn it on in settings.' })
    // The tenant's notice must have been accepted, in its current words (by a person: the app's own runs need no
    // consent); and pictures only if the tenant allows them.
    if (!p.fromApp && settings.privacy?.notice && p.consent !== (await noticeId(settings.privacy.notice))) {
      return no(428, { error: 'Read and accept the notice about the assistant first.', notice: settings.privacy.notice })
    }
    if (settings.privacy?.pictures === false && message.parts.some((x) => x.type === 'file')) {
      return no(400, { error: 'Pictures are turned off for your team. Describe it in words instead.' })
    }
    // Before anything is saved, so a refused message leaves no empty thread behind.
    const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts }
    const hit = await checkLimits(storage, identity, config.limits, timeouts.totalMs * 2)
    if (hit) {
      config.on?.limit?.(hit, identity)
      return no(429, { error: limitMessage(hit), limit: hit })
    }

    const thread = p.threadId
      ? await storage.getThread(identity.tenantId, identity.userId, p.threadId)
      : await storage.createThread(identity.tenantId, identity.userId)
    if (!thread) return no(404, { error: 'That conversation was not found.' })   // also when it is someone else's

    let earlier = await storage.listMessages(thread.id)
    // A message the thread already has: the user edited it, or asked for the reply again (same id). Everything from
    // it on is replaced. Only the user's own messages can be sent again.
    const again = earlier.findIndex((m) => m.id === message.id)
    if (again >= 0) {
      if (earlier[again]!.role !== 'user') return no(400, { error: 'Only your own messages can be sent again.' })
      await storage.removeMessagesFrom(thread.id, message.id)
      earlier = earlier.slice(0, again)
    }
    const runId = crypto.randomUUID()
    const text = message.parts.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join(' ')
    const routed = config.route ? await Promise.resolve().then(() => config.route!({ identity, page, text, history: earlier.length })).catch((e) => { config.on?.error?.(e, { identity, threadId: thread.id }); return undefined }) : undefined
    const offModels = new Set(switches?.modelsOff ?? [])
    const models = (routed?.length ? routed : config.models).filter((m) => !offModels.has(m.modelId))
    if (!models.length) return no(503, { error: 'The assistant is paused for everyone at the moment. Try again later.' })
    const first = models[0]!
    await storage.startRun({ id: runId, threadId: thread.id, tenantId: identity.tenantId, userId: identity.userId, model: first.modelId, promptVersion: config.promptVersion, ...(queue ? { status: 'queued' as const } : {}), question: (text.replace(/\s+/g, ' ').trim() || (message.parts.some((x) => x.type === 'file') ? 'Picture' : '')).slice(0, 300) })
    // Count again now that this reply is registered: two messages sent at the same moment both passed the check
    // above, and only now can one see the other. Nothing is saved or paid for yet, so backing off costs nothing.
    const maxRunning = config.limits?.maxRunning ?? 2
    const running = await storage.runningRuns(identity.tenantId, identity.userId, new Date(Date.now() - timeouts.totalMs * 2))
    if (running > maxRunning) {
      await storage.finishRun(runId, { status: 'failed', error: 'Too many replies at once' })
      if (!p.threadId && !earlier.length) await storage.archiveThread(identity.tenantId, identity.userId, thread.id)   // the empty one just made
      const raced: LimitHit = { scope: 'running', limit: maxRunning, used: running }
      config.on?.limit?.(raced, identity)
      return no(429, { error: limitMessage(raced), limit: raced })
    }

    // The price set aside before anything is saved or paid for, so a refusal leaves nothing behind.
    const db = await p.db()
    let held = 0
    if (config.spend) {
      held = await holdFor(identity, text, db)
      const ok = await reserveFor({ identity, runId, threadId: thread.id, amount: held, first: true })
      if (ok !== true) {
        await storage.finishRun(runId, { status: 'failed', error: 'Not enough to spend' })
        if (!p.threadId && !earlier.length) await storage.archiveThread(identity.tenantId, identity.userId, thread.id)
        return no(402, { error: ok })
      }
    }

    if (!earlier.length && !thread.title) await storage.setThreadTitle(thread.id, titleFrom(message))
    // Pictures go to the file store; the saved message keeps a reference. The model still reads this message's
    // pictures in full, and earlier ones only as a note.
    const saved = config.files ? await storeFiles(message, config.files, { tenantId: identity.tenantId, userId: identity.userId, threadId: thread.id }) : message
    const history = trimToolResults(picturesOnce([...earlier, message].slice(-(config.historyMessages ?? 30)), message), config.historyToolChars ?? 1500)
    await storage.saveMessages(thread.id, [saved])

    await storage.addUsage([{ tenantId: identity.tenantId, userId: identity.userId, runId, provider: first.provider, model: first.modelId, unit: 'messages', amount: 1 }])
    return { rc: { identity, thread, runId, message, saved, history, page, models, settings, db, held, attempt: 1 } }
  }

  /** One reply, as the panel's stream: from the screen and instructions to the checked, saved answer. */
  async function reply(rc: ReplyCtx<DB>): Promise<ReadableStream<Chunk>> {
    const { identity, thread, runId, message, saved, history, page, models, settings, db, signal } = rc
    const { storage } = config
    const first = models[0]!
    const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts }
    const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ')
    // Step numbers go on across tries, so a resumed run's steps follow the ones before.
    let seq = (rc.attempt - 1) * 1000
    // Spend: what this reply has used and what is set aside for it; `outOf` ends it after the step that ran out.
    const spend = config.spend
    let held = rc.held
    const used: Totals = { messages: 1 }
    let outOf: string | undefined
    const reserve = async (amount: number, reason?: string, auto = false): Promise<boolean> => {
      if (!spend) return true
      const ok = await reserveFor({ identity, runId, threadId: thread.id, amount, first: false, ...(reason ? { reason } : {}) })
      if (ok === true) { held += amount; return true }
      if (auto) outOf ??= ok
      return false
    }
    // What each model that answered used, for the usage ledger (a reply that hands over runs on several).
    const byModel = new Map<string, { provider: string; model: string; input_tokens: number; output_tokens: number; neurons: number }>()
    let answering: () => LanguageModelV4 = () => models[0]!
    const calledTools: string[] = []   // every tool the reply called so far, for roles' takesOver
    let steps = 0
    const counted = async (st: { usage?: { inputTokens?: number; outputTokens?: number }; providerMetadata?: Record<string, unknown> }) => {
      const m = answering()
      const row = byModel.get(`${m.provider}/${m.modelId}`) ?? { provider: m.provider, model: m.modelId, input_tokens: 0, output_tokens: 0, neurons: 0 }
      row.input_tokens += st.usage?.inputTokens ?? 0
      row.output_tokens += st.usage?.outputTokens ?? 0
      row.neurons += Number((st.providerMetadata?.workersAi as { neurons?: number } | undefined)?.neurons) || 0
      byModel.set(`${m.provider}/${m.modelId}`, row)
      for (const c of (st as { toolCalls?: { toolName: string }[] }).toolCalls ?? []) calledTools.push(c.toolName)
      steps++
      used.input_tokens = (used.input_tokens ?? 0) + (st.usage?.inputTokens ?? 0)
      used.output_tokens = (used.output_tokens ?? 0) + (st.usage?.outputTokens ?? 0)
      const n = Number((st.providerMetadata?.workersAi as { neurons?: number } | undefined)?.neurons) || 0
      if (n) used.neurons = (used.neurons ?? 0) + n
      if (!spend?.cost || outOf) return
      const step = spend.step ?? rc.held
      while (!outOf && spend.cost(used) > held) if (!(step > 0) || !(await reserve(step, 'cost', true))) outOf ??= NO_SPEND
    }
    const statuses = new Map((await storage.listCards(thread.id)).map((c) => [c.id, c]))
    const nonce = crypto.randomUUID().slice(0, 8)
    // Which outside text this run has read: the user's pictures, and whatever tools fenced as untrusted.
    const seen = new Set<string>(message.parts.some((p) => p.type === 'file') ? ['picture'] : [])
    const fence = makeUntrusted(nonce)
    // The pictures on this message, as stored: a card can keep one (e.g. the bill an expense came from).
    const files = saved.parts.flatMap((p) => (p.type === 'file' && p.url.startsWith(FILE_SCHEME)
      ? [{ id: p.url.slice(FILE_SCHEME.length), mediaType: p.mediaType, ...(p.filename ? { filename: p.filename } : {}) }] : []))
    const ctx: ToolContext<DB> = {
      identity, db, untrusted: (text, source) => { seen.add(source.replace(/[^\w .-]/g, '').slice(0, 40) || 'outside text'); return fence(text, source) },
      ...(files.length ? { files } : {}), ...withFile(fileOf(identity)),
      ...(spend ? { reserve: (amount: number, reason?: string) => reserve(amount, reason) } : {}),
    }
    const instructions = typeof config.instructions === 'function' ? await config.instructions({ identity, page }) : config.instructions
    const summary = page && config.screen ? await Promise.resolve().then(() => config.screen!(page, ctx)).catch((e) => { config.on?.error?.(e, { identity, threadId: thread.id }); return null }) : null
    const shownSummary = summary === null ? null : String(redact(summary))
    const formats: Formats = { ...DEFAULT_FORMATS, ...config.formats, ...settings.formats }
    // Tools this user's role can't use: named (without their inputs) so the model says who can, instead of "I can't".
    const otherRoles = config.tools.filter((t) => t.roles && !t.roles.includes(identity.role))
    const rolesText = otherRoles.length
      ? `\n\nNot available to this user (role: ${identity.role}): ${otherRoles.map((t) => `${t.description.replace(/\.$/, '')} (${t.roles!.join(' or ')} only)`).join('; ')}. If they ask for one, say who can do it; never try another way.`
      : ''
    // Ordered from most to least shared, so providers can cache the start: first what is the same for everyone (the
    // app's instructions and Teovo's rules), then what is the same for this tenant and person, then what changes
    // every message (the time, the screen).
    // Screens this person's role may open: the others are never mentioned, and open_screen refuses them.
    const myScreens = (config.screens ?? []).filter((x) => !x.roles || x.roles.includes(identity.role))
    const shared = `${config.name?.trim() ? `Your name is ${config.name.trim()}; you are the assistant built into this app.\n\n` : ''}${instructions}${screensText(myScreens)}${config.views?.length ? `\n\n${VIEWS_RULE}${formsText(config.forms ?? {})}` : ''}${config.tools.some((t) => t.kind === 'propose') || config.views?.some((v) => v.name === 'form') ? `\n\n${CARDS_RULE}` : ''}${rolesRule(config.roles)}\n\n${UNTRUSTED_RULE}`
    const tenantPart = `${formatsText(formats)}${settingsText(settings)}${rolesText}${config.misses !== false && !(settings.toolsOff ?? []).includes('cannot_help') ? `\n\n${MISS_RULE}` : ''}`
    const system = `${shared}${tenantPart}${todayText(formats, config.now?.() ?? new Date())}${screenText(page, shownSummary, fence)}`

    return createUIMessageStream<UIMessage<{ runId: string; threadId: string; formats: Formats }>>({
      originalMessages: history as UIMessage<{ runId: string; threadId: string; formats: Formats }>[],
      execute: async ({ writer }) => {
        // The panel draws numbers and dates in views the same way.
        // A resumed run first sends again what the last try finished, then carries on from there.
        if (rc.replay?.length) for (const c of rc.replay) writer.write(c)
        else writer.write({ type: 'start', messageMetadata: { runId, threadId: thread.id, formats } })
        const tools: ToolSet = {}
        const off = new Set(settings.toolsOff ?? [])
        for (const t of toolsFor(config.tools, identity).filter((x) => !off.has(x.name))) {
          tools[t.name] = tool({
            description: t.description,
            inputSchema: t.input,
            execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
              writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, kind: t.kind, state: 'running', ...(t.label ? { label: t.label } : {}) } })
              const started = Date.now()
              const step = { runId, seq: seq++, type: 'tool' as const, toolCallId, name: t.name }
              const max = config.logLimit ?? 8000
              const logged = clip(input, max)
              let failed: string | undefined
              try {
                const raw = await t.run(input, ctx)
                // What a read tool found is what the model sees, so it is what gets hidden. Cards keep their payload.
                const out = t.kind === 'read' ? redact(raw) : raw
                if (t.kind === 'read' && t.links) {
                  // Links to the records the answer used; computed from the result before anything was hidden from it.
                  const found = await Promise.resolve().then(() => t.links!(raw, input)).catch(() => [] as RecordLink[])
                  for (const l of found ?? []) {
                    if (links.size >= 5 || !l?.label || typeof l.to !== 'string' || !l.to.startsWith('/') || l.to.startsWith('//')) continue
                    if (![...links.values()].some((x) => x.to === l.to)) links.set(l.to, { label: String(l.label).slice(0, 60), to: l.to.slice(0, 300) })
                  }
                }
                const result = clip(out, max)
                await storage.saveStep({ ...step, input: logged.value, output: result.value, truncated: logged.truncated || result.truncated, durationMs: Date.now() - started })
                if (t.kind === 'propose') {
                  const p = out as Proposal
                  const recordVersion = await recordVersionOf(p, ctx)
                  const card: StoredCard = { ...p, ...(t.version ? { version: t.version } : {}), id: crypto.randomUUID(), threadId: thread.id, runId, status: 'shown', ...(seen.size ? { untrustedSources: [...seen] } : {}), ...(recordVersion !== undefined ? { recordVersion } : {}) }
                  await storage.saveCard(card)
                  runCards.push({ kind: card.kind, title: card.title })
                  await logEvent(card, 'proposed', identity!)
                  config.on?.card?.(card)
                  shown = true
                  writer.write({ type: 'data-card', id: card.id, data: publicCard(card) })
                  // Worded for small models too: they lean on the last tool result more than on the system prompt.
                  return `NOT DONE YET. "${p.title}" is shown to the user as a card with Confirm and Skip; nothing has changed. ` +
                    'In your reply, say it is ready for them to confirm. Do not say it is recorded, saved or done.'
                }
                if (t.kind === 'action') {
                  shown = true
                  writer.write({ type: 'data-action', id: toolCallId, data: out as Action })
                  return 'A button is shown under your reply.'
                }
                return out
              } catch (e) {
                failed = e instanceof Error ? e.message : String(e)
                await storage.saveStep({ ...step, input: logged.value, truncated: logged.truncated, error: failed, durationMs: Date.now() - started })
                throw e
              } finally {
                // How long it took and whether it failed, for the steps list under the reply.
                writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, kind: t.kind, state: 'done', ...(t.label ? { label: t.label } : {}), ms: Date.now() - started, ...(failed ? { error: failed.slice(0, 300) } : {}) } })
              }
            },
          })
        }
        for (const v of config.views ?? []) {
          tools[`show_${v.name}`] = tool({
            description: v.description,
            inputSchema: v.data,
            execute: async (data: unknown, { toolCallId }: { toolCallId: string }) => {
              if (v.name === 'form') {
                const kind = (data as FormData).submit.kind
                const spec = config.forms?.[kind]
                if (!spec) throw new Error(`There is no form for "${kind}". Use one of: ${Object.keys(config.forms ?? {}).join(', ') || 'none'}.`)
                const missing = missingFields(spec, data as FormData)
                if (missing) throw new Error(missing)
              }
              shown = true
              writer.write({ type: 'data-view', id: toolCallId, data: { view: v.name, data } })
              await storage.saveStep({ runId, seq: seq++, type: 'tool', toolCallId, name: `show_${v.name}`, input: clip(data, config.logLimit ?? 8000).value, truncated: false, durationMs: 0 })
              return v.name === 'choices' ? 'Shown as buttons. Stop here: their pick arrives as their next message.'
                : v.name === 'form' ? 'Shown as a form. When they submit it, a card is prepared for them to confirm; nothing has changed yet.'
                : `Shown to the user as a ${v.name}. Don't repeat its contents in your reply.`
            },
          })
        }
        if (config.misses !== false && !off.has('cannot_help')) {
          tools.cannot_help = tool({
            description: 'Only after trying your other tools: call this when they truly cannot answer or do what the user asked (no tool covers it, the data is not there, or it is not allowed). It tells the team what people need. Then say so plainly to the user.',
            inputSchema: z.object({ question: z.string().max(500).describe('What the user wanted, in their words'), reason: z.string().max(300).describe('Why you could not, in a few words') }),
            execute: async ({ question, reason }) => {
              const miss = { tenantId: identity!.tenantId, userId: identity!.userId, threadId: thread.id, runId, question, reason }
              await storage.addMiss(miss).catch((e) => config.on?.error?.(e, { identity, threadId: thread.id }))
              config.on?.miss?.(miss)
              return 'Noted for the team. Now tell the user plainly that you cannot do this, and what they could do instead.'
            },
          })
        }
        if (myScreens.length) {
          const screens = myScreens
          tools.open_screen = tool({
            description: 'Offer the user a button that opens one of the app\'s screens. Only the listed screens and filters work.',
            // One plain path, not a pattern plus an object of values: Gemini often failed to call the tool at all with
            // a free-form params object.
            inputSchema: z.object({
              screen: z.string().describe('The screen\'s path from the list with its :params filled in and any filters as a query, e.g. "/orders/142" or "/orders?unpaid=yes"'),
              label: z.string().max(40).describe('What the button does, in the user\'s words, e.g. "Show unpaid orders" or "Open order #142"'),
            }),
            execute: async ({ screen, label }, { toolCallId }) => {
              const to = screenPath(screens, screen)
              if (!to) {
                const s = findScreen(screens, screen)?.screen
                throw new Error(s
                  ? `${s.title} (${s.path}) can't take those values. ${s.filters ? `Its filters are: ${Object.keys(s.filters).join(', ')}.` : 'It has no filters.'} Offer it without the rest, or say the app can't do that.`
                  : `There is no screen "${screen}". Use one of: ${screens.map((x) => x.path).join(', ')}.`)
              }
              shown = true
              writer.write({ type: 'data-action', id: toolCallId, data: { label: label?.trim() || `Open ${to.title}`, action: 'navigate', args: { to: to.path } } })
              return 'A button is shown under your reply.'
            },
          })
        }
        // Tools only read, propose or offer buttons; none writes during a run, so switching model is always safe.
        let usedModel = first
        const model = fallbackModel(models, () => true, (from, e) => {
          const i = models.findIndex((m) => m.modelId === from)
          usedModel = models[i + 1] ?? usedModel
          config.on?.modelSwitch?.(from, e)
        }, timeouts.firstChunkMs)
        // Roles: which one the reply is now (none: its own models), the one it hands over to next, and each role's
        // models behind one fallback, remembering which of them answered.
        const roles = config.roles ?? {}
        let role: string | undefined
        let handOver: { to: string; note: string } | undefined
        let handNote = ''
        const roleModels = new Map<string, { model: LanguageModelV4; used: LanguageModelV4 }>()
        const roleModel = (name: string) => {
          let r = roleModels.get(name)
          if (!r) {
            const list = roles[name]!.models
            const entry = { model: list[0]!, used: list[0]! }
            entry.model = fallbackModel(list, () => true, (from, e) => {
              entry.used = list[list.findIndex((m) => m.modelId === from) + 1] ?? entry.used
              config.on?.modelSwitch?.(from, e)
            }, timeouts.firstChunkMs)
            roleModels.set(name, (r = entry))
          }
          return r
        }
        const current = () => (role ? roleModel(role).model : model)
        answering = () => (role ? roleModel(role).used : usedModel)
        const roleNames = Object.keys(roles).filter((n) => roles[n]!.models.length)
        if (roleNames.length) {
          tools.hand_over = tool({
            description: `Hand the rest of this reply to another role, which carries on with its own model and sees everything so far. ` +
              `Roles: ${roleNames.map((n) => `${n}: ${roles[n]!.description}`).join('; ')}. Hand over when the work turns into what a role is for.`,
            inputSchema: z.object({
              to: z.enum(roleNames as [string, ...string[]]).describe('The role that carries on'),
              note: z.string().max(1000).describe('What it needs to know: what you found and what to make of it'),
            }),
            execute: async ({ to, note }, { toolCallId }) => {
              if (to === role) return `You are already the ${to}. Carry on.`
              handOver = { to, note }
              const label = `Handed over to the ${to}`
              writer.write({ type: 'data-step', id: toolCallId, data: { name: 'hand_over', kind: 'read', state: 'done', ms: 0, label } })
              await storage.saveStep({ runId, seq: seq++, type: 'tool', toolCallId, name: 'hand_over', input: { from: role ?? null, to, note }, truncated: false, durationMs: 0 })
              return `Handed over. From the next step you are the ${to}.`
            },
          })
        }
        const tookOver = new Set<string>()
        /**
         * Before each step: take up a role the last step handed over to, or one the app's plan says takes over now,
         * with its model, instructions and tools.
         */
        const prepareStep = async () => {
          if (!handOver && steps > 0) {
            for (const name of roleNames) {
              const plan = roles[name]!.takesOver
              if (name === role || tookOver.has(name) || !plan) continue
              let now = false
              try { now = plan({ text, toolCalls: [...calledTools], step: steps }) } catch (e) { config.on?.error?.(e, { identity, threadId: thread.id }) }
              if (!now) continue
              handOver = { to: name, note: '' }
              const id = `takes-over-${name}-${runId}`
              writer.write({ type: 'data-step', id, data: { name: 'hand_over', kind: 'read', state: 'done', ms: 0, label: `Handed over to the ${name}` } })
              await storage.saveStep({ runId, seq: seq++, type: 'tool', toolCallId: id, name: 'hand_over', input: { from: role ?? null, to: name, by: 'app' }, truncated: false, durationMs: 0 })
              break
            }
          }
          if (handOver) { role = handOver.to; handNote = handOver.note; handOver = undefined; tookOver.add(role) }
          if (!role) return {}
          const spec = roles[role]!
          const active = spec.tools ? Object.keys(tools).filter((t) => spec.tools!.includes(t) || t === 'hand_over' || t === 'cannot_help') : undefined
          return {
            model: roleModel(role).model,
            instructions: `${system}\n\nYou are now the ${role}: ${spec.instructions ?? spec.description}${handNote ? `\nNote from before the hand-over: ${handNote}` : ''}`,
            ...(active ? { activeTools: active } : {}),
          }
        }
        let streamError: unknown
        let shown = false   // a card, view or button reached the user in this reply
        const links = new Map<string, RecordLink>()   // records the answer came from (read tools' links)
        const runCards: { kind: string; title: string }[] = []
        // With done-checks, the reply's words wait here until they pass; everything else goes out as it happens.
        const checks = config.checks ?? []
        let heldWords: Chunk[] = []
        const reading: Promise<void>[] = []
        const send = (from: ReadableStream<InferUIMessageChunk<UIMessage>>) => {
          const s = from as ReadableStream<Chunk>
          if (!checks.length) { writer.merge(s); return }
          let ended!: () => void
          reading.push(new Promise<void>((r) => { ended = r }))
          writer.merge(s.pipeThrough(new TransformStream<Chunk, Chunk>({
            transform(c, out) { if (c.type === 'text-start' || c.type === 'text-delta' || c.type === 'text-end') heldWords.push(c); else out.enqueue(c) },
            flush() { ended() },
          })))
        }
        const modelMessages = await convertToModelMessages(rc.partial ? [...history, rc.partial] as typeof history : history, {
            // Earlier cards reach the model with their status now, so it knows what the user confirmed or skipped.
            convertDataPart: (p) => {
              if (p.type === 'data-view') {
                const v = p.data as { view: string; data: { title?: string; question?: string }; submitted?: string }
                const what = v.data.title ?? v.data.question
                return { type: 'text', text: `[Shown to the user: ${v.view}${what ? ` "${what}"` : ''}${v.submitted ? ', submitted' : ''}]` }
              }
              if (p.type !== 'data-card') return undefined
              const c = p.data as StoredCard
              return { type: 'text', text: cardForModel(statuses.get(c.id) ?? c) }
            },
          })
        const run = (messages: ModelMessage[]) => {
          const r = streamText({
            onError: ({ error }) => { streamError ??= error },
            model,
            system,
            messages,
            tools,
            stopWhen: [isStepCount(config.maxSteps ?? 8), () => Boolean(outOf)],
            onStepFinish: counted,
            prepareStep,
            // First output is timed by fallbackModel (per model, so a stalled one hands over to the next); the SDK
            // keeps the gaps between chunks and the total.
            timeout: { chunkMs: timeouts.chunkMs, totalMs: timeouts.totalMs },
            maxRetries: 1,
            abortSignal: signal,
          })
          // Our sentence for the user, not the SDK's "An error occurred."; tool errors still reach the model as they are.
          send(toUIMessageStream({ stream: r.stream, sendStart: false, sendFinish: false, onError: () => FAILED, redactToolErrors: false }))
          return r
        }
        const text0 = text   // the user's message, before `text` below starts holding the reply
        let result = run(modelMessages)
        const results = [result]
        try {
          let text = await result.text
          let sofar = [...modelMessages, ...(await result.responseMessages)]
          const said = async () => (await Promise.all(results.map((r) => r.steps))).flat().some((st) => st.text.trim())
          // Gemini sometimes ends a step with nothing at all (no text, no tool call, no output tokens), at the start or
          // right after a tool result. That is a blip, not an answer: carry on once from there with tools still on, so
          // a reply that needs one (a button, a table, a card) can still use it.
          const last = (await result.steps).at(-1)
          if (last && !last.text.trim() && !last.toolCalls.length && !shown && !(await said()) && !signal.aborted && !outOf) {
            result = run(sofar)
            results.push(result)
            text = await result.text
            sofar = [...sofar, ...(await result.responseMessages)]
          }
          // Models sometimes end a turn in silence after a tool call. Never leave the user with an empty reply: ask
          // once more, with tools off, for the answer in words. (Not after a view or card: those are the answer.)
          if (!(await said()) && !shown && !signal.aborted && !outOf) {
            const again = streamText({
              model: current(), system: `${system}\n\nYou have what you need from the tools above. Now answer the user in words; do not call tools.`,
              messages: sofar, tools, toolChoice: 'none', maxRetries: 1, abortSignal: signal, onStepFinish: counted,
              timeout: { chunkMs: timeouts.chunkMs, totalMs: timeouts.totalMs },
            })
            results.push(again)
            send(toUIMessageStream({ stream: again.stream, sendStart: false, sendFinish: false, onError: () => NO_ANSWER, redactToolErrors: false }))
            text = await Promise.resolve(again.text).catch(() => NO_ANSWER)
            // Still nothing (Gemini can end even this one with no words, e.g. UNEXPECTED_TOOL_CALL): a plain sentence,
            // never a blank reply.
            if (!text.trim() && !signal.aborted) {
              const id = `no-answer-${runId}`
              writer.write({ type: 'text-start', id })
              writer.write({ type: 'text-delta', id, delta: NO_ANSWER })
              writer.write({ type: 'text-end', id })
              text = NO_ANSWER
            }
          }
          if (checks.length) {
            const retries = config.checkRetries ?? 1
            for (let attempt = 0; ; attempt++) {
              await Promise.all(reading)   // every held word of this try has arrived
              if (signal.aborted || outOf) { for (const c of heldWords) writer.write(c); break }   // a stopped reply keeps what it had
              const words = heldWords.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('')
              const toolCalls = (await Promise.all(results.map((r) => Promise.resolve(r.steps).catch(() => [])))).flat()
                .flatMap((st) => st.toolCalls.map((tc) => ({ name: tc.toolName, input: tc.input })))
              const found = await firstProblem(checks, { text: words, question: text0, cards: runCards, toolCalls, attempt }, { identity: identity!, db, page }, (e) => config.on?.error?.(e, { identity, threadId: thread.id }))
              if (!found) { for (const c of heldWords) writer.write(c); break }
              const final = attempt >= retries
              config.on?.check?.({ runId, name: found.name, problem: found.problem, attempt, final }, identity!)
              // In the run log too, so the run viewer shows what was refused and why.
              const refused = clip(words, config.logLimit ?? 8000)
              await storage.saveStep({ runId, seq: seq++, type: 'check', name: found.name, input: refused.value, truncated: refused.truncated, error: found.problem, durationMs: 0 })
              heldWords = []
              if (final) {
                const id = `checked-${runId}`
                writer.write({ type: 'text-start', id })
                writer.write({ type: 'text-delta', id, delta: CHECK_FAILED })
                writer.write({ type: 'text-end', id })
                text = CHECK_FAILED
                break
              }
              const note: ModelMessage = { role: 'user', content: refusedNote(found.problem) }
              sofar = [...sofar, note]
              result = run(sofar)
              results.push(result)
              text = await result.text
              sofar = [...sofar, ...(await result.responseMessages)]
            }
          }
          // Out of what it may spend: what it found so far stays, and it says why it stopped.
          if (outOf) {
            const id = `spend-${runId}`
            writer.write({ type: 'text-start', id })
            writer.write({ type: 'text-delta', id, delta: outOf })
            writer.write({ type: 'text-end', id })
          }
          if (links.size) writer.write({ type: 'data-sources', id: `sources-${runId}`, data: { links: [...links.values()] } })
          if (config.suggestions) {
            // Follow-ups ride along as a transient part: shown under this reply, never saved in the history. Before
            // 'finish': a client that stops reading at the end of the reply would never see them after it.
            const s = await Promise.resolve().then(() => config.suggestions!({ identity: identity!, page, after: text, db })).catch(() => null)
            if (s && s.suggestions.length) writer.write({ type: 'data-suggestions', data: tidy(s), transient: true })
          }
          writer.write({ type: 'finish' })
          await finish(outOf ? 'stopped' : 'done', outOf ? new Error(`Spend: ${outOf}`) : undefined)
        } catch (e) {
          await finish(signal.aborted ? 'stopped' : 'failed', streamError ?? e)
          throw e
        }

        async function finish(status: 'done' | 'failed' | 'stopped', error?: unknown) {
          if (await (rc.owns?.() ?? true)) await rc.end({ status, model: answering().modelId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) })
          // Per model that answered (counted step by step); providers with their own cost unit report it per step
          // (Workers AI: neurons).
          const rows: UsageRow[] = []
          for (const m of byModel.values()) {
            const base = { tenantId: identity!.tenantId, userId: identity!.userId, runId, provider: m.provider, model: m.model }
            if (m.input_tokens) rows.push({ ...base, unit: 'input_tokens', amount: m.input_tokens })
            if (m.output_tokens) rows.push({ ...base, unit: 'output_tokens', amount: m.output_tokens })
            if (m.neurons > 0) rows.push({ ...base, unit: 'neurons', amount: m.neurons })
          }
          if (rows.length) { await storage.addUsage(rows); config.on?.usage?.(rows) }
          if (spend && (await (rc.owns?.() ?? true))) {
            await Promise.resolve().then(() => spend.settle({ identity, runId, threadId: thread.id, status, used, ...(spend.cost ? { cost: spend.cost(used) } : {}), held }))
              .catch((e) => config.on?.error?.(e, { identity, threadId: thread.id }))
          }
        }
      },
      onError: (e) => {
        config.on?.error?.(e, { identity, threadId: thread.id })
        return FAILED
      },
      onEnd: async ({ messages }) => {
        if (!(await (rc.owns?.() ?? true))) return   // another server carries this run on, and saves it
        const reply = messages.at(-1)
        // A reply the user stopped keeps what was written so far, marked, so a reload shows it was cut short.
        if (reply && reply.role === 'assistant') {
          await storage.saveMessages(thread.id, [signal.aborted ? { ...reply, metadata: { ...(reply.metadata as object | undefined), stopped: true } } : reply])
        }
      },
    })
  }

  /** Spend: what to set aside for a reply. */
  async function holdFor(identity: Identity, text: string, db: DB): Promise<number> {
    const h = config.spend!.hold
    return typeof h === 'number' ? h : await h({ identity, text, db })
  }
  /** Spend: the app's reserve, with a refusal as a sentence for the user. A reserve that throws counts as a refusal. */
  async function reserveFor(r: Parameters<SpendRules<DB>['reserve']>[0]): Promise<true | string> {
    const ok = await Promise.resolve().then(() => config.spend!.reserve(r)).catch((e) => { config.on?.error?.(e, { identity: r.identity, threadId: r.threadId }); return false })
    return ok === true ? true : typeof ok === 'string' && ok.trim() ? ok.trim() : NO_SPEND
  }

  /** A tenant's settings, with what is switched off for every tenant added in. */
  async function settingsOf(tenantId: string) {
    const [own, switches] = await Promise.all([config.storage.tenantSettings(tenantId), config.storage.tenantSettings(SWITCHES)])
    // A tool switched off for everyone is off for this tenant too.
    const settings: TenantSettings = { ...(own ?? DEFAULT_SETTINGS), toolsOff: [...new Set([...(own?.toolsOff ?? []), ...(switches?.toolsOff ?? [])])] }
    return { settings, switches }
  }

  // ---- Long runs ----
  const queue = config.runs ? config.storage.queue : undefined
  if (config.runs && !queue) throw new Error('createAssistant: runs needs a storage with a queue (memoryStorage, postgresStorage or supabaseStorage)')
  if (config.runs?.inline === false && !config.runs.asUser) throw new Error('createAssistant: runs.inline false needs runs.asUser, so a worker can act as the person')
  const worker = config.runs?.worker ?? `teovo-${crypto.randomUUID().slice(0, 8)}`
  const leaseMs = config.runs?.leaseMs ?? 30_000
  const beatMs = config.runs?.heartbeatMs ?? 2_000
  const maxAttempts = config.runs?.maxAttempts ?? 3
  const pollMs = config.runs?.pollMs ?? 500
  const flushMs = config.runs?.flushMs ?? 300

  /** Runs this server is writing now: their stream so far, for sending it without waiting for the log. */
  interface Local { attempt: number; chunks: Chunk[]; subs: Set<(c: Chunk | null) => void>; ctrl: AbortController; lost: boolean }
  const locals = new Map<string, Local>()
  const resumed = { type: 'data-resumed', data: {}, transient: true } as unknown as Chunk

  function keepAlive(p: Promise<void>, ctx?: WaitUntil) {
    const safe = p.catch((e) => config.on?.error?.(e, { identity: { tenantId: '', userId: '', role: '' }, threadId: '' }))
    ctx?.waitUntil?.(safe)
  }

  /** What a run needs when it is not in the request that asked: read back from the conversation and the job. */
  async function restore(claim: ClaimedRun): Promise<Omit<ReplyCtx<DB>, 'attempt' | 'signal' | 'end' | 'lost'> | { error: string }> {
    const { identity, messageId, page, models: ids } = claim.job
    if (!config.runs?.asUser) return { error: 'runs.asUser is not set, so no other server can carry this reply on' }
    const thread = await config.storage.getThread(identity.tenantId, identity.userId, claim.threadId)
    if (!thread) return { error: 'The conversation was removed' }
    const list = await config.storage.listMessages(thread.id)
    const at = list.findIndex((m) => m.id === messageId)
    if (at < 0) return { error: 'The message was removed' }
    const message = config.files ? await loadFiles(list[at]!, config.files.store, identity.tenantId) : list[at]!
    const earlier = list.slice(0, at)
    const history = trimToolResults(picturesOnce([...earlier, message].slice(-(config.historyMessages ?? 30)), message), config.historyToolChars ?? 1500)
    const { settings, switches } = await settingsOf(identity.tenantId)
    const off = new Set(switches?.modelsOff ?? [])
    const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ')
    const routed = config.route ? await Promise.resolve().then(() => config.route!({ identity, page, text, history: earlier.length })).catch(() => undefined) : undefined
    const known = [...(routed ?? []), ...config.models]
    let models = ids.map((id) => known.find((m) => m.modelId === id)).filter((m): m is LanguageModelV4 => Boolean(m) && !off.has(m!.modelId))
    if (!models.length) models = config.models.filter((m) => !off.has(m.modelId))
    if (!models.length) return { error: 'Every model is switched off' }
    const db = await config.runs.asUser(identity)
    return { identity, thread, runId: claim.id, message, saved: list[at]!, history, page, models, settings, db, held: config.spend ? await holdFor(identity, text, db) : 0 }
  }

  /**
   * Run a claimed reply to the end on this server: the stream goes to the log in batches (and straight to anyone this
   * server is sending it to), a heartbeat keeps the lease and listens for Stop, and the run is finished last.
   */
  async function drive(claim: ClaimedRun, pre?: Pick<ReplyCtx<DB>, 'thread' | 'message' | 'saved' | 'history' | 'models' | 'settings' | 'db' | 'held'>): Promise<void> {
    const q = queue!
    const { identity } = claim.job
    const report = (e: unknown) => config.on?.error?.(e, { identity, threadId: claim.threadId })
    const local: Local = { attempt: claim.attempts, chunks: [], subs: new Set(), ctrl: new AbortController(), lost: false }
    locals.set(claim.id, local)
    let batch: Chunk[] = []
    let seq = 0
    let writes = Promise.resolve()
    const flush = () => {
      if (!batch.length) return
      const chunks = batch
      const n = seq++
      batch = []
      writes = writes.then(() => q.addEvents(claim.id, claim.attempts, n, chunks)).catch(report)
    }
    const emit = (c: Chunk) => {
      local.chunks.push(c)
      batch.push(c)
      for (const s of local.subs) s(c)
      if (c.type === 'finish-step' || c.type === 'finish') flush()
    }
    const ticker = setInterval(flush, flushMs)
    // Asked before finishing and saving: a server that stalled past its lease must not overwrite the one that took over.
    const owns = async () => {
      if (!local.lost && !(await q.renew(claim.id, worker, leaseMs).catch(() => ({ stop: false })))) { local.lost = true; local.ctrl.abort() }
      return !local.lost
    }
    const beat = setInterval(() => {
      q.renew(claim.id, worker, leaseMs).then((r) => {
        if (!r) { local.lost = true; local.ctrl.abort() }
        else if (r.stop) local.ctrl.abort()
      }, report)
    }, beatMs)
    let end: Parameters<ReplyCtx<DB>['end']>[0] | undefined
    let replied = false   // reply() settles spend itself; a run that never got there is settled here
    // A reply that can't go on: one plain sentence, saved, so the conversation shows what happened.
    const giveUp = async (error: string) => {
      const msg = { id: crypto.randomUUID(), role: 'assistant' as const, metadata: { runId: claim.id, threadId: claim.threadId }, parts: [{ type: 'text' as const, text: INTERRUPTED }] }
      for (const c of [{ type: 'start', messageId: msg.id, messageMetadata: msg.metadata }, { type: 'text-start', id: 'x' }, { type: 'text-delta', id: 'x', delta: INTERRUPTED }, { type: 'text-end', id: 'x' }, { type: 'finish' }] as Chunk[]) emit(c)
      await config.storage.saveMessages(claim.threadId, [msg as UIMessage])
      end = { status: 'failed', error }
    }
    try {
      if (claim.stopRequested) { end = { status: 'stopped' }; return }
      if (claim.attempts > maxAttempts) { await giveUp(`Stopped after ${maxAttempts} tries`); return }
      const base = pre ? { identity, runId: claim.id, page: claim.job.page, ...pre } : await restore(claim)
      if ('error' in base) { await giveUp(base.error); return }
      let replay: Chunk[] | undefined
      for (let a = claim.attempts - 1; a >= 1 && !replay?.length; a--) replay = finishedSteps((await q.events(claim.id, a, -1)).flatMap((e) => e.chunks as Chunk[]))
      replied = true
      const stream = await reply({
        ...base, attempt: claim.attempts, signal: local.ctrl.signal, owns,
        end: async (e) => { end = e },
        ...(replay?.length ? { replay, partial: await messageOf(replay) } : {}),
      })
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        emit(value)
      }
    } catch (e) {
      report(e)
      end ??= { status: local.ctrl.signal.aborted ? 'stopped' : 'failed', error: e instanceof Error ? e.message : String(e) }
    } finally {
      clearInterval(ticker)
      clearInterval(beat)
      flush()
      await writes
      // Last, so whoever reads the log has everything once the run shows as ended.
      if (await owns()) {
        const e = end ?? { status: 'failed' as const, error: 'The reply ended without finishing' }
        await config.storage.finishRun(claim.id, e).catch(report)
        if (!replied && config.spend) await Promise.resolve().then(() => config.spend!.settle({ identity, runId: claim.id, threadId: claim.threadId, status: e.status, used: {}, held: 0 })).catch(report)
      }
      locals.delete(claim.id)
      for (const s of local.subs) s(null)
    }
  }

  /**
   * A run's stream for the panel, from its start: from this server's memory while it runs here, otherwise from the
   * log as it grows. If the run is picked up again elsewhere, a data-resumed part tells the panel to read it afresh.
   */
  function tail(runId: string): ReadableStream<Chunk> {
    const q = queue!
    let cancelled = false
    let unsub: (() => void) | undefined
    return new ReadableStream<Chunk>({
      async start(out) {
        let attempt: number | undefined
        let seq = -1
        let sent = 0
        const send = (c: Chunk) => { out.enqueue(c); sent++ }
        try {
          while (!cancelled) {
            const local = locals.get(runId)
            if (local && (attempt === undefined || attempt === local.attempt)) {
              for (const c of local.chunks.slice(sent)) send(c)
              await new Promise<void>((done) => {
                const sub = (c: Chunk | null) => {
                  if (c && !cancelled) { send(c); return }
                  if (!c && local.lost && !cancelled) out.enqueue(resumed)
                  local.subs.delete(sub)
                  done()
                }
                local.subs.add(sub)
                unsub = () => sub(null)
              })
              break
            }
            const st = await q.state(runId)
            if (!st) break
            if (st.attempts > 0 && attempt !== st.attempts) {
              if (sent) { out.enqueue(resumed); break }   // picked up again elsewhere: the panel reads it afresh
              attempt = st.attempts
              seq = -1
            }
            if (attempt !== undefined) {
              for (const e of await q.events(runId, attempt, seq)) { for (const c of e.chunks as Chunk[]) send(c); seq = e.seq }
            }
            if (ENDED.has(st.status)) break
            await sleep(pollMs)
          }
          if (!cancelled) out.close()
        } catch (e) {
          if (!cancelled) out.error(e)
        }
      },
      cancel() { cancelled = true; unsub?.() },
    })
  }

  /** Take waiting runs (queued, or left by a server that stopped) and run them here. */
  async function claimWaiting(room: number, onRun: (p: Promise<void>) => void): Promise<number> {
    let n = 0
    for (const id of await queue!.waiting(room)) {
      const c = await queue!.claim(id, worker, leaseMs)
      if (c) { n++; onRun(drive(c)) }
    }
    return n
  }

  /**
   * POST …/runs/:id/stop, or …/threads/:id/stop for the reply a conversation is waiting for: stop a reply from any
   * server. The person who asked can, and so can an admin (by run).
   */
  async function stopRoute(req: Request, id: string, by: 'run' | 'thread' = 'run'): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!queue) return json(501, { error: 'Replies here stop when their request is closed.' })
    let runId = id
    if (by === 'thread') {
      const thread = await config.storage.getThread(identity.tenantId, identity.userId, id)
      const active = thread ? await queue.active(thread.id) : null
      if (!active) return json(404, { error: 'That reply is not running.' })
      runId = active
    }
    if (!(await queue.requestStop(identity.tenantId, runId, isAdmin(identity) ? undefined : identity.userId))) return json(404, { error: 'That reply is not running.' })
    locals.get(runId)?.ctrl.abort()   // here already: no need to wait for the heartbeat
    // Stopped while still queued (never taken by a server, so ended at once): no server will settle its spend hold.
    const after = config.spend ? await queue.state(runId) : null
    if (after?.status === 'stopped' && after.attempts === 0 && after.job) {
      await Promise.resolve().then(() => config.spend!.settle({ identity: after.job!.identity, runId, threadId: after.threadId, status: 'stopped', used: {}, held: 0 }))
        .catch((e) => config.on?.error?.(e, { identity, threadId: after.threadId }))
    }
    return json(200, { stopping: true })
  }

  /**
   * GET …/runs/:id/poll?attempt=&after=&wait=: the long-poll transport, for hosts that hold back streams. Answers with
   * the reply's next batches as soon as there are any (or after `wait` ms, at most 25 s, with none), `done` once the
   * reply has ended and everything was sent, and `reset` when another server picked it up again (read it afresh).
   */
  async function pollRoute(req: Request, runId: string): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!queue) return json(501, { error: 'Polling for replies needs long runs.' })
    const q = new URL(req.url).searchParams
    const asked = q.has('attempt') ? Number(q.get('attempt')) : undefined
    const after = Number(q.get('after') ?? -1)
    const deadline = Date.now() + Math.min(Math.max(Number(q.get('wait') ?? 20_000) || 0, 0), 25_000)
    for (;;) {
      const st = await queue.state(runId)
      if (!st || st.tenantId !== identity.tenantId || (st.userId !== identity.userId && !isAdmin(identity))) return json(404, { error: 'That reply was not found.' })
      if (asked !== undefined && asked > 0 && st.attempts !== asked) return json(200, { attempt: st.attempts, reset: true, events: [], done: false })
      const attempt = st.attempts
      const ended = ENDED.has(st.status)
      const events = attempt > 0 ? await queue.events(runId, attempt, attempt === asked ? after : -1) : []
      // `ended` was read first, so once it shows, these are the last batches.
      if (events.length || ended || Date.now() >= deadline) return json(200, { attempt, events, done: ended })
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    }
  }

  /** GET …/threads/:id/stream: the reply this conversation is waiting for, from its start; 204 when there is none. */
  async function streamRoute(req: Request, threadId: string): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    const thread = await config.storage.getThread(identity.tenantId, identity.userId, threadId)
    if (!thread) return json(404, { error: 'That conversation was not found.' })
    const id = queue ? await queue.active(thread.id) : null
    if (!id) return new Response(null, { status: 204 })
    return createUIMessageStreamResponse({ stream: tail(id), headers: { 'x-teovo-thread': thread.id } })
  }

  const rules: CardRules = { ttlMs: 24 * 3600_000, undoMs: 10 * 60_000, ...config.cardRules }

  async function suggestions(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!config.suggestions || ((await config.storage.tenantSettings(identity.tenantId)) ?? DEFAULT_SETTINGS).enabled === false) return json(200, { suggestions: [] })
    const q = new URL(req.url).searchParams
    const page = readPage({ path: q.get('path'), title: q.get('title'), record: { type: q.get('recordType'), id: q.get('recordId') } })
    try {
      return json(200, tidy(await config.suggestions({ identity, page, db: await config.asUser(identity, req) })))
    } catch (e) {
      config.on?.error?.(e, { identity, threadId: '' })
      return json(200, { suggestions: [] })
    }
  }

  async function tenantSettings(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!(config.settingsRoles ?? ['owner', 'admin']).includes(identity.role)) return json(403, { error: 'Only an admin can change assistant settings.' })
    const tools = config.tools.map((t) => ({ name: t.name, description: t.description, kind: t.kind }))
    if (req.method === 'PUT') {
      let body: unknown
      try { body = await req.json() } catch { return json(400, { error: 'The request was not valid JSON.' }) }
      try {
        const s = validateSettings(body, config.tools)
        await config.storage.saveTenantSettings(identity.tenantId, s)
        return json(200, { settings: s, tools })
      } catch (e) {
        if (e instanceof SettingsError) return json(400, { error: e.message })
        throw e
      }
    }
    return json(200, { settings: (await config.storage.tenantSettings(identity.tenantId)) ?? DEFAULT_SETTINGS, tools })
  }

  async function threads(req: Request, id?: string, archive = false): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    const { storage } = config
    if (!id) {
      const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get('limit')) || 30, 1), 100)
      const list = await storage.listThreads(identity.tenantId, identity.userId, limit)
      return json(200, { threads: list.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt: updatedAt ?? createdAt })) })
    }
    if (archive) {
      return (await storage.archiveThread(identity.tenantId, identity.userId, id)) ? json(200, { archived: true }) : json(404, { error: 'That conversation was not found.' })
    }
    const thread = await storage.getThread(identity.tenantId, identity.userId, id)
    if (!thread) return json(404, { error: 'That conversation was not found.' })
    // Cards come back as they are now (confirmed, undone…), not as they were when first shown.
    const cards = new Map((await storage.listCards(thread.id)).map((c) => [c.id, publicCard(c)]))
    const messages = (await storage.listMessages(thread.id)).map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === 'data-card' && 'id' in p && p.id && cards.has(p.id) ? { ...p, data: cards.get(p.id) } : p)),
    }))
    // A reply still being written (long runs): the panel reads it with GET …/threads/:id/stream.
    const running = queue ? await queue.active(thread.id) : null
    return json(200, { thread: { id: thread.id, title: thread.title, createdAt: thread.createdAt }, messages, ...(running ? { running } : {}) })
  }

  async function submitForm(req: Request, threadId: string, viewId: string): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    const { storage } = config
    const thread = await storage.getThread(identity.tenantId, identity.userId, threadId)
    if (!thread) return json(404, { error: 'That conversation was not found.' })
    const messages = await storage.listMessages(thread.id)
    const message = messages.find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'data-view' && 'id' in p && p.id === viewId))
    const part = message?.parts.find((p) => p.type === 'data-view' && 'id' in p && p.id === viewId) as { id: string; data: { view: string; data: FormData; submitted?: string } } | undefined
    if (!message || !part || part.data.view !== 'form') return json(404, { error: 'That form was not found.' })
    if (part.data.submitted) return json(409, { error: 'This form was already sent.' })
    let body: { values?: unknown }
    try { body = (await req.json()) as { values?: unknown } } catch { return json(400, { error: 'The request was not valid JSON.' }) }
    const checked = checkForm(part.data.data, body.values)
    if ('error' in checked) return json(400, { error: checked.error })
    const spec = config.forms?.[part.data.data.submit.kind]
    const handler = spec ? formHandler(spec) : undefined
    if (!handler) return json(501, { error: 'This app can’t take this form yet.' })
    const ctx: ToolContext<DB> = { identity, db: await config.asUser(identity, req), untrusted: makeUntrusted(crypto.randomUUID().slice(0, 8)) }
    let proposal: Proposal
    try { proposal = await handler(checked.values, ctx) } catch (e) { return json(422, { error: e instanceof Error ? e.message : String(e) }) }
    const runId = (message.metadata as { runId?: string } | undefined)?.runId ?? crypto.randomUUID()
    // The card shows the form's fields, labels and order, unless the app's handler chose its own.
    const fields = proposal.fields ?? part.data.data.fields.map((f) => ({ key: f.name, label: f.label, format: f.type === 'date' ? 'date' as const : f.type === 'number' ? 'number' as const : 'text' as const }))
    // One card per form: its id comes from the conversation and the form, so a double tap (or two tabs) that both
    // get past the "already sent" check above save the same card, not two.
    const recordVersion = await recordVersionOf(proposal, ctx)
    const card: StoredCard = { ...proposal, fields, id: await stableId(`${thread.id}:${viewId}`), threadId: thread.id, runId, status: 'shown', ...(recordVersion !== undefined ? { recordVersion } : {}) }
    await storage.saveCard(card)
    await logEvent(card, 'proposed', identity)
    config.on?.card?.(card)
    // The card joins the reply right under its form, so a reopened conversation shows both.
    const parts: UIMessage['parts'] = message.parts.flatMap((p): UIMessage['parts'] => (p === (part as unknown)
      ? [{ type: 'data-view', id: part.id, data: { ...part.data, submitted: card.id, values: checked.values } }, { type: 'data-card', id: card.id, data: publicCard(card) }]
      : [p]))
    await storage.saveMessages(thread.id, [{ ...message, parts }])
    return json(200, { card: publicCard(card), messageId: message.id })
  }

  /** Thumbs up or down on one reply: POST …/runs/:runId/rating { value: 'up' | 'down' | null, note? }. */
  async function rate(req: Request, runId: string): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    let body: { value?: unknown; note?: unknown }
    try { body = (await req.json()) as typeof body } catch { return json(400, { error: 'The request was not valid JSON.' }) }
    const value = body.value === 'up' ? 1 : body.value === 'down' ? -1 : body.value === null ? null : undefined
    if (value === undefined) return json(400, { error: 'Send value "up", "down" or null.' })
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || undefined : undefined
    const ok = await config.storage.rateRun(identity.tenantId, identity.userId, runId, value, note)
    if (!ok) return json(404, { error: 'That reply was not found.' })
    config.on?.rating?.({ runId, value, note }, identity)
    return json(200, { ok: true })
  }

  async function file(req: Request, id: string): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!config.files) return json(404, { error: 'That picture was not found.' })
    const f = await config.files.store.get(identity.tenantId, id)
    // Only the person who sent it (it is in their conversation); anyone else gets the same answer as for a missing file.
    if (!f || f.userId !== identity.userId) return json(404, { error: 'That picture was not found. Pictures are removed after a while.' })
    return new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: {
      'content-type': f.mediaType, 'content-length': String(f.bytes.length), 'cache-control': 'private, max-age=86400, immutable',
      'x-content-type-options': 'nosniff', 'content-disposition': `inline${f.filename ? `; filename="${f.filename.replace(/["\\\r\n]/g, '')}"` : ''}`,
    } })
  }

  async function logEvent(c: StoredCard, event: CardEventKind, who: Identity) {
    await config.storage.addCardEvent({ cardId: c.id, threadId: c.threadId, tenantId: who.tenantId, userId: who.userId, kind: c.kind, title: c.title, event })
      .catch((e) => config.on?.error?.(e, { identity: who, threadId: c.threadId }))
  }

  /**
   * GET …/runs (filters: limit, before, userId, status, rating=up|down), GET …/runs/:id (its steps, question and reply)
   * and GET …/runs/:id/trace (an OpenTelemetry trace to download). Admins only: runs hold everyone's questions.
   */
  async function runsRoute(req: Request, id?: string, trace = false): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!isAdmin(identity)) return json(403, { error: 'Only an admin can see this.' })
    const { storage } = config
    if (!storage.listRuns || !storage.getRun) return json(501, { error: 'This storage does not keep a run log to browse.' })
    if (!id) {
      const q = new URL(req.url).searchParams
      const before = q.get('before') && !Number.isNaN(Date.parse(q.get('before')!)) ? new Date(q.get('before')!).toISOString() : undefined
      const status = q.get('status')
      const rating = q.get('rating') === 'up' ? 1 : q.get('rating') === 'down' ? -1 : undefined
      const runs = await storage.listRuns(identity.tenantId, {
        limit: Math.min(200, Math.max(1, Number(q.get('limit')) || 50)),
        ...(before ? { before } : {}), ...(q.get('userId') ? { userId: q.get('userId')! } : {}),
        ...(status === 'running' || status === 'done' || status === 'failed' || status === 'stopped' ? { status } : {}),
        ...(rating ? { rating } : {}),
      })
      return json(200, { runs })
    }
    const run = await storage.getRun(identity.tenantId, id)
    if (!run) return json(404, { error: 'That run was not found.' })
    if (trace) {
      return new Response(JSON.stringify(runTrace(run, { service: config.name?.trim() || 'teovo' }), null, 2), { headers: {
        'content-type': 'application/json', 'content-disposition': `attachment; filename="teovo-run-${run.id}.json"`,
      } })
    }
    // The question it answered and the reply it gave, from the conversation.
    const messages = await storage.listMessages(run.threadId)
    const at = messages.findIndex((m) => m.role === 'assistant' && (m.metadata as { runId?: string } | undefined)?.runId === run.id)
    const words = (m?: UIMessage) => m?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim() || undefined
    const question = at > 0 ? words(messages.slice(0, at).reverse().find((m) => m.role === 'user')) : undefined
    return json(200, { run: { ...run, ...(question ? { question } : {}), ...(at >= 0 && words(messages[at]) ? { reply: words(messages[at]) } : {}) } })
  }

  const isAdmin = (i: Identity) => (config.settingsRoles ?? ['owner', 'admin']).includes(i.role)

  /** GET …/audit and GET …/misses: the tenant's trail of changes and the questions the assistant couldn't answer. Admins only. */
  async function adminList(req: Request, what: 'audit' | 'misses'): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!isAdmin(identity)) return json(403, { error: 'Only an admin can see this.' })
    const q = new URL(req.url).searchParams
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50))
    const before = q.get('before') && !Number.isNaN(Date.parse(q.get('before')!)) ? new Date(q.get('before')!).toISOString() : undefined
    if (what === 'misses') return json(200, { misses: await config.storage.listMisses(identity.tenantId, { limit, ...(before ? { before } : {}) }) })
    const userId = q.get('userId') || undefined
    return json(200, { events: await config.storage.listCardEvents(identity.tenantId, { limit, ...(before ? { before } : {}), ...(userId ? { userId } : {}) }) })
  }

  /** GET …/policy: the assistant's name, what this person must know before chatting (the tenant's notice and its id), and whether pictures are allowed. */
  /** Everything a reader or a recording needs before a model is called: switched on, allowed, within limits. */
  async function readyToRead(identity: Identity): Promise<{ models: readonly LanguageModelV4[] }> {
    const [own, switches] = await Promise.all([config.storage.tenantSettings(identity.tenantId), config.storage.tenantSettings(SWITCHES)])
    if (switches && !switches.enabled) throw new ReaderError(503, 'The assistant is paused for everyone at the moment. Try again later.')
    if (own && !own.enabled) throw new ReaderError(403, 'The assistant is turned off for your team. An admin can turn it on in settings.')
    const hit = await checkLimits(config.storage, identity, config.limits, 120_000)
    if (hit) { config.on?.limit?.(hit, identity); throw new ReaderError(429, limitMessage(hit)) }
    const off = new Set(switches?.modelsOff ?? [])
    const models = config.models.filter((m) => !off.has(m.modelId))
    if (!models.length) throw new ReaderError(503, 'The assistant is paused for everyone at the moment. Try again later.')
    return { models }
  }

  const usageFor = (identity: Identity) => async (rows: UsageRow[]) => {
    if (!rows.length) return
    await config.storage.addUsage(rows)
    config.on?.usage?.(rows)
  }
  const countOne = async (identity: Identity, what: string) =>
    usageFor(identity)([{ tenantId: identity.tenantId, userId: identity.userId, provider: 'teovo', model: what, unit: 'messages', amount: 1 }])

  async function hear(identity: Identity, audio: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<string> {
    const v = config.voice
    if (!v) throw new ReaderError(404, 'Voice is not set up in this app.')
    if (audio.byteLength > (v.maxBytes ?? 15 * 1024 * 1024)) throw new ReaderError(413, 'That recording is too long. Keep it under 2–3 minutes.')
    if (audio.byteLength < 1000) throw new ReaderError(400, 'That was too short. Tap the microphone, speak, then tap Done.')
    const { models } = await readyToRead(identity)
    await countOne(identity, 'transcribe')
    const text = await transcribeWith(audio, mediaType, { hint: v.hint, english: v.english !== false, models: v.models ?? models }, { identity, models, signal, usage: usageFor(identity) })
    if (!text) throw new ReaderError(422, COULD_NOT_HEAR)
    return text
  }

  /** One reader, start to finish. Throws ReaderError with a sentence for the user. */
  async function runReader(name: string, input: ReaderInput, identity: Identity, db: DB, signal?: AbortSignal): Promise<unknown> {
    const def = (config.readers ?? []).find((r) => r.name === name)
    if (!def) throw new ReaderError(404, `There is no reader called "${name}".`)
    if (def.roles && !def.roles.includes(identity.role)) throw new ReaderError(403, 'You don’t have access to this.')
    const accepts = def.accepts ?? ['text']
    const kinds = (['text', 'image', 'audio'] as const).filter((k) => input[k])
    if (!kinds.length) throw new ReaderError(400, 'Nothing to read.')
    const refused = kinds.find((k) => !accepts.includes(k))
    if (refused) throw new ReaderError(400, refused === 'image' ? 'This can’t read pictures.' : refused === 'audio' ? 'This can’t take a recording.' : 'This needs a picture, not text.')
    if (input.image && !/^image\/(png|jpeg|webp|gif)$/.test(input.image.mediaType)) throw new ReaderError(400, 'Use a PNG or JPG picture.')
    const started = Date.now()
    try {
      let text = input.text?.trim() ?? ''
      if (input.audio) text = [text, await hear(identity, bytesOf(input.audio.data), input.audio.mediaType, signal)].filter(Boolean).join('\n')
      const { models } = await readyToRead(identity)
      await countOne(identity, `read:${name}`)
      const ctx: ToolContext<DB> = { identity, db, untrusted: makeUntrusted(crypto.randomUUID().slice(0, 8)) }
      const instructions = typeof def.instructions === 'function' ? await def.instructions(ctx) : def.instructions
      const result = await readWith(def, { text, image: input.image }, `${instructions.trim()}\n\n${todayText({ ...DEFAULT_FORMATS, ...config.formats } as Formats, new Date()).trim()}`, { identity, models, signal, usage: usageFor(identity) })
      const out = def.after ? await def.after(result, ctx, { ...input, ...(text ? { text } : {}) }) : result
      config.on?.read?.({ name, ok: true, ms: Date.now() - started }, identity)
      return out
    } catch (e) {
      config.on?.read?.({ name, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }, identity)
      if (!(e instanceof ReaderError)) config.on?.error?.(e, { identity, threadId: '' })
      throw e
    }
  }

  /** POST …/read/:name with JSON { text?, image?: { data, mediaType }, audio?: { data, mediaType } }. */
  async function readRoute(req: Request, name: string): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (Number(req.headers.get('content-length') ?? 0) > 25 * 1024 * 1024) return json(413, { error: 'That is too large.' })
    const body = (await req.json().catch(() => null)) as ReaderInput | null
    if (!body || typeof body !== 'object') return json(400, { error: 'Nothing to read.' })
    const input: ReaderInput = {
      ...(typeof body.text === 'string' && body.text.trim() ? { text: body.text.slice(0, 20_000) } : {}),
      ...(body.image && typeof body.image.data === 'string' ? { image: { data: body.image.data, mediaType: String(body.image.mediaType) } } : {}),
      ...(body.audio && typeof body.audio.data === 'string' ? { audio: { data: body.audio.data, mediaType: String(body.audio.mediaType) } } : {}),
    }
    try {
      return json(200, { result: await runReader(name, input, identity, await config.asUser(identity, req), req.signal) })
    } catch (e) {
      if (e instanceof ReaderError) return json(e.status, { error: e.message })
      return json(500, { error: 'Something went wrong. Try again.' })
    }
  }

  /** POST …/transcribe with the recording as the body (Content-Type audio/…): { text }. */
  async function transcribeRoute(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    const audio = new Uint8Array(await req.arrayBuffer())
    const mediaType = (req.headers.get('content-type') ?? 'audio/webm').split(';')[0]!.trim()
    try {
      return json(200, { text: await hear(identity, audio, mediaType, req.signal) })
    } catch (e) {
      if (e instanceof ReaderError) return json(e.status, { error: e.message })
      config.on?.error?.(e, { identity, threadId: '' })
      return json(500, { error: 'Something went wrong. Try again.' })
    }
  }

  async function policy(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    const p = (await config.storage.tenantSettings(identity.tenantId))?.privacy ?? {}
    return json(200, {
      pictures: p.pictures !== false && Boolean(config.attachments),
      voice: Boolean(config.voice),
      ...(queue ? { longRuns: true } : {}),
      readers: (config.readers ?? []).filter((r) => !r.roles || r.roles.includes(identity.role)).map((r) => r.name),
      ...(config.name?.trim() ? { name: config.name.trim() } : {}),
      ...(config.formats?.locale ? { locale: config.formats.locale } : {}),
      ...(p.notice ? { notice: p.notice, noticeId: await noticeId(p.notice) } : {}),
    })
  }

  /** GET …/completions: the app's words for completing as people type. */
  async function completionsRoute(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    if (!config.completions) return json(200, { words: [] })
    try {
      const raw = await config.completions({ identity, db: await config.asUser(identity, req) })
      const words = [...new Set((raw ?? []).map((w) => String(w).replace(/\s+/g, ' ').trim()).filter((w) => w.length >= 2 && w.length <= 60))].slice(0, 500)
      return json(200, { words })
    } catch (e) {
      config.on?.error?.(e, { identity, threadId: '' })
      return json(200, { words: [] })
    }
  }

  /** GET …/allowance: every limit that applies to this person, with how much is used. */
  async function allowanceRoute(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    return json(200, { allowance: await allowance(config.storage, identity, config.limits) })
  }

  /** Conversations, pictures and logs of one person, or a whole tenant, gone. */
  async function wipe(tenantId: string, userId?: string): Promise<{ threads: number; files: number }> {
    const elsewhere = await config.files?.store.removeFor?.(tenantId, userId)   // pictures kept outside the tables
    const { threads, files } = await config.storage.wipe(tenantId, userId)
    return { threads, files: elsewhere ?? files ?? 0 }
  }

  /** POST …/wipe { scope: 'me' } for one's own data; { scope: 'user', userId } or { scope: 'tenant' } for admins. */
  async function wipeRoute(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    let body: { scope?: unknown; userId?: unknown }
    try { body = (await req.json()) as typeof body } catch { return json(400, { error: 'The request was not valid JSON.' }) }
    if (body.scope === 'me') return json(200, await wipe(identity.tenantId, identity.userId))
    if (!isAdmin(identity)) return json(403, { error: 'Only an admin can delete other people\'s conversations.' })
    if (body.scope === 'user' && typeof body.userId === 'string' && body.userId) return json(200, await wipe(identity.tenantId, body.userId))
    if (body.scope === 'tenant') return json(200, await wipe(identity.tenantId))
    return json(400, { error: 'Send scope "me", "user" with a userId, or "tenant".' })
  }

  /** Read a picture this person shared (their own, in this tenant), for a tool or a card being applied. */
  function fileOf(identity: Identity): ToolContext<DB>['file'] {
    const files = config.files
    if (!files) return undefined
    return async (id) => {
      const f = await files.store.get(identity.tenantId, id)
      return f && f.userId === identity.userId ? f : null
    }
  }

  async function card(req: Request, id: string, decision: Decision): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    try {
      // An app-applied card reports whether its change can be taken back; nothing else is read from the body.
      const body = (await req.json().catch(() => ({}))) as { reversible?: unknown }
      const done = await decide({
        storage: config.storage, appliers: config.cards ?? {}, rules, identity, id, decision, reversible: body.reversible === true,
        ctx: async () => ({ identity, db: await config.asUser(identity, req), untrusted: makeUntrusted(crypto.randomUUID().slice(0, 8)), ...withFile(fileOf(identity)) }),
      })
      await logEvent(done, ({ confirm: 'confirmed', skip: 'skipped', undo: 'undone' } as const)[decision], identity)
      config.on?.decision?.(done, decision, identity)
      return json(200, { card: publicCard(done) })
    } catch (e) {
      if (e instanceof CardError) {
        // Refused because it was too old or the record changed: the card expired, which belongs in the trail too.
        const now = e.status === 409 || e.status === 410 ? await config.storage.getCard(identity.tenantId, identity.userId, id) : null
        if (now?.status === 'expired') await logEvent(now, 'expired', identity)
        return json(e.status, { error: e.message })
      }
      config.on?.error?.(e, { identity, threadId: '' })
      return json(500, { error: 'Something went wrong. Nothing was changed.' })
    }
  }

  return {
    /** Delete a person's (or with no userId, a whole tenant's) conversations, pictures and logs, e.g. on a privacy request. */
    wipe,
    /**
     * One run as an OpenTelemetry trace (OTLP JSON), e.g. to send to a collector's /v1/traces. Null when the run is not
     * this tenant's, or the storage keeps no run log to read.
     */
    async trace(tenantId: string, runId: string) {
      const run = await config.storage.getRun?.(tenantId, runId)
      return run ? runTrace(run, { service: config.name?.trim() || 'teovo' }) : null
    },
    /**
     * Run a reader from the server, with no signed-in user, e.g. a webhook (a bank SMS → a payment). Counted against
     * that identity's limits. `db` is what the reader's instructions and after get as ctx.db. Throws ReaderError.
     */
    async read<R = unknown>(name: string, input: ReaderInput, opts: { identity: Identity; db: DB }): Promise<R> {
      return (await runReader(name, input, opts.identity, opts.db)) as R
    },
    /**
     * For whoever runs the app, not tenants: pause the assistant for everyone (enabled: false), or take tools or models
     * out of service for every tenant at once, e.g. a tool with a bug or a model that misbehaves. Takes effect on the
     * next message. Pass {} to switch everything back on.
     */
    async setSwitches(sw: { enabled?: boolean; toolsOff?: string[]; modelsOff?: string[] }): Promise<void> {
      await config.storage.saveTenantSettings(SWITCHES, { enabled: sw.enabled !== false, ...(sw.toolsOff?.length ? { toolsOff: sw.toolsOff } : {}), ...(sw.modelsOff?.length ? { modelsOff: sw.modelsOff } : {}) })
    },
    /**
     * Delete pictures older than `files.keepDays`. Call it on a schedule (a cron, a Worker scheduled event).
     * Returns how many were removed; 0 when no keepDays or the store can't list by age.
     */
    async removeOldFiles(now = new Date()): Promise<number> {
      const f = config.files
      if (!f?.keepDays || !f.store.removeOlderThan) return 0
      return f.store.removeOlderThan(new Date(now.getTime() - f.keepDays * 86_400_000))
    },
    /**
     * Long runs: take waiting replies (queued ones, and ones a stopped or crashed server left) and run them here;
     * resolves when they have finished. For a scheduled job, e.g. a Cloudflare cron every minute. Returns how many.
     */
    async work(opts: { max?: number } = {}): Promise<number> {
      if (!queue) return 0
      const running: Promise<void>[] = []
      const n = await claimWaiting(opts.max ?? 4, (p) => running.push(p))
      await Promise.all(running)
      return n
    },
    /**
     * Long runs: keep taking waiting replies in this process (a Node server or worker). stop() stops taking more,
     * gives running ones `waitMs` (default 8 s) to finish, and hands the rest back so another server carries them on.
     */
    startWorker(opts: { pollMs?: number; concurrency?: number } = {}) {
      if (!queue) throw new Error('startWorker needs createAssistant({ runs })')
      const active = new Set<Promise<void>>()
      let on = true
      let wake: () => void = () => {}
      const loop = (async () => {
        while (on) {
          try {
            const room = (opts.concurrency ?? 4) - active.size
            if (room > 0) await claimWaiting(room, (p) => { const t = p.finally(() => active.delete(t)); active.add(t) })
          } catch (e) {
            config.on?.error?.(e, { identity: { tenantId: '', userId: '', role: '' }, threadId: '' })
          }
          await new Promise<void>((r) => { const t = setTimeout(r, opts.pollMs ?? 2000); wake = () => { clearTimeout(t); r() } })
        }
      })()
      return {
        async stop(o: { waitMs?: number } = {}) {
          on = false
          wake()
          await loop
          await Promise.race([Promise.all(active), sleep(o.waitMs ?? 8000)])
          for (const [id, l] of locals) {
            l.lost = true
            l.ctrl.abort()
            await queue.release(id, worker).catch(() => {})
          }
          await Promise.all(active)
        },
      }
    },
    /**
     * Start a reply with no person at the screen: a scheduled or heartbeat run, a webhook, a nightly check. The
     * app's message is saved in the person's conversation, marked as the app's (the panel labels it), and the reply
     * runs with their tools, limits and spend. Cards it prepares wait there for them to confirm. Throws StartError
     * when refused before anything was saved.
     */
    async start(o: StartOptions<DB>): Promise<StartResult> {
      if (!o.text?.trim()) throw new StartError(400, 'teovo.start needs some text.')
      const asUser = config.runs?.asUser
      const db = o.db !== undefined ? () => o.db as DB : asUser ? () => asUser(o.identity) : undefined
      if (!db) throw new Error('teovo.start needs db, or runs.asUser')
      const message: UIMessage = {
        id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: o.text.trim() }],
        metadata: { from: 'app', ...(o.label?.trim() ? { label: o.label.trim().slice(0, 60) } : {}) },
      }
      const b = await begin({ identity: o.identity, message, threadId: o.threadId, page: o.page, fromApp: true, db })
      if ('refused' in b) throw new StartError(b.refused.status, String(b.refused.body.error))
      const { rc } = b
      const { storage } = config
      let status: StartResult['status']
      if (!queue) {
        let ended: StartResult['status'] = 'failed'
        const stream = await reply({ ...rc, signal: o.signal ?? new AbortController().signal, end: async (e) => { ended = e.status; await storage.finishRun(rc.runId, e) } })
        await stream.pipeTo(new WritableStream())
        status = ended
      } else {
        const running = await launch(rc)
        if (running && o.wait !== false) {
          await running.done
          status = ((await queue.state(rc.runId))?.status ?? 'failed') as StartResult['status']
        } else {
          if (running) keepAlive(running.done, o.ctx)
          status = running ? 'running' : 'queued'
        }
      }
      const answer = (await storage.listMessages(rc.thread.id)).find((m) => m.role === 'assistant' && (m.metadata as { runId?: string } | undefined)?.runId === rc.runId)
      const text = answer?.parts.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n').trim()
      const cards = (await storage.listCards(rc.thread.id)).filter((c) => c.runId === rc.runId).map((c) => ({ id: c.id, kind: c.kind, title: c.title }))
      return { threadId: rc.thread.id, runId: rc.runId, status, ...(answer ? { text } : {}), cards }
    },
    /** Mount under any path, e.g. app.all('/api/assistant/*', teovo.fetch). Handles POST …/chat (a message sent again replaces it and what came after), POST …/runs/:id/rating, GET …/threads, GET …/threads/:id, POST …/threads/:id/archive, GET …/suggestions, GET/PUT …/settings and POST …/cards/:id/(confirm|skip|undo). */
    async fetch(req: Request, ctx?: WaitUntil): Promise<Response> {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path.endsWith('/chat')) return chat(req, ctx)
      const ts = /\/threads\/([0-9a-f-]{36})\/stream$/i.exec(path)
      if (req.method === 'GET' && ts) return streamRoute(req, ts[1]!.toLowerCase())
      const rp = /\/runs\/([0-9a-f-]{36})\/poll$/i.exec(path)
      if (req.method === 'GET' && rp) return pollRoute(req, rp[1]!.toLowerCase())
      const rs = /\/(runs|threads)\/([0-9a-f-]{36})\/stop$/i.exec(path)
      if (req.method === 'POST' && rs) return stopRoute(req, rs[2]!.toLowerCase(), rs[1] === 'threads' ? 'thread' : 'run')
      if (req.method === 'GET' && path.endsWith('/suggestions')) return suggestions(req)
      const fm = /\/files\/([0-9a-f-]{36})$/i.exec(path)
      if (req.method === 'GET' && fm) return file(req, fm[1]!.toLowerCase())
      if ((req.method === 'GET' || req.method === 'PUT') && path.endsWith('/settings')) return tenantSettings(req)
      if (req.method === 'GET' && path.endsWith('/threads')) return threads(req)
      const t = /\/threads\/([0-9a-f-]{36})(\/archive)?$/i.exec(path)
      const f = /\/threads\/([0-9a-f-]{36})\/views\/([^/]{1,100})\/submit$/i.exec(path)
      if (req.method === 'POST' && f) return submitForm(req, f[1]!.toLowerCase(), decodeURIComponent(f[2]!))
      if (t && ((req.method === 'GET' && !t[2]) || (req.method === 'POST' && t[2]))) return threads(req, t[1]!.toLowerCase(), Boolean(t[2]))
      const rt = /\/runs\/([0-9a-f-]{36})\/rating$/i.exec(path)
      if (req.method === 'POST' && rt) return rate(req, rt[1]!.toLowerCase())
      if (req.method === 'GET' && path.endsWith('/runs')) return runsRoute(req)
      const rv = /\/runs\/([0-9a-f-]{36})(\/trace)?$/i.exec(path)
      if (req.method === 'GET' && rv) return runsRoute(req, rv[1]!.toLowerCase(), Boolean(rv[2]))
      if (req.method === 'GET' && path.endsWith('/policy')) return policy(req)
      const rd = /\/read\/([\w-]{1,64})$/.exec(path)
      if (req.method === 'POST' && rd) return readRoute(req, rd[1]!)
      if (req.method === 'POST' && path.endsWith('/transcribe')) return transcribeRoute(req)
      if (req.method === 'GET' && path.endsWith('/allowance')) return allowanceRoute(req)
      if (req.method === 'GET' && path.endsWith('/completions')) return completionsRoute(req)
      if (req.method === 'GET' && path.endsWith('/audit')) return adminList(req, 'audit')
      if (req.method === 'GET' && path.endsWith('/misses')) return adminList(req, 'misses')
      if (req.method === 'POST' && path.endsWith('/wipe')) return wipeRoute(req)
      const m = /\/cards\/([0-9a-f-]{36})\/(confirm|skip|undo)$/i.exec(path)
      if (req.method === 'POST' && m) return card(req, m[1]!.toLowerCase(), m[2] as Decision)
      return json(404, { error: 'Not found.' })
    },
  }
}

/** Spread into a ToolContext: adds `file` only when the assistant keeps files. */
function withFile<DB>(file: ToolContext<DB>['file']): Pick<ToolContext<DB>, 'file'> {
  return file ? { file } : {}
}
