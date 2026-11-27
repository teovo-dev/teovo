import type { LanguageModelV4 } from '@ai-sdk/provider'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, tool, toUIMessageStream, type ToolSet, type UIMessage } from 'ai'
import { fallbackModel } from './fallback.js'
import { CardError, cardForModel, decide, publicCard, type CardHandler, type CardRules, type Decision } from './cards.js'
import { checkLimits, limitMessage, type LimitHit, type Limits } from './limits.js'
import type { Storage, StoredCard, UsageRow } from './storage.js'
import { toolsFor, type Action, type Identity, type Proposal, type TeovoTool, type ToolContext } from './tools.js'
import { makeUntrusted, UNTRUSTED_RULE } from './untrusted.js'

import { makeRedactor, type RedactOptions } from './redact.js'
import { checkForm, formHandler, formsText, missingFields, VIEWS_RULE, type FormData, type FormHandler, type FormSpec, type TeovoView } from './views.js'
import { checkMessage, type AttachmentRules } from './attachments.js'
import { picturesOnce, storeFiles, type FileRules } from './files.js'
import { checkFormats, DEFAULT_FORMATS, formatsText, type Formats } from './formats.js'
import { DEFAULT_SETTINGS, SettingsError, settingsText, validateSettings } from './settings.js'
import { readPage, screenPath, screensText, screenText, tidy, type Page, type ScreenFn, type ScreenInfo, type SuggestionsFn } from './screens.js'
import { z } from 'zod'
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
  }
}

const FAILED = 'The assistant could not finish this reply. Try again.'

/**
 * Said whenever the model can prepare changes. A model once told a shop owner "Payment recorded" when it had only
 * shown a card; the user must never believe something changed before they confirmed it.
 */
export const CARDS_RULE = 'Tools that prepare a change (cards and forms) change nothing by themselves: the user confirms or skips each card. ' +
  'Say a change is ready to confirm, never that it is done, recorded or saved, unless a later message says the user confirmed it.'

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
  return messages.map((m, i) => {
    if (m.role !== 'assistant' || i === lastAssistant) return m
    return { ...m, parts: m.parts.map((p) => {
      if (!p.type.startsWith('tool-') || !('output' in p) || p.output === undefined) return p
      const text = JSON.stringify(p.output) ?? ''
      return text.length <= max ? p : { ...p, output: `${text.slice(0, max)}… [cut: an earlier result; call the tool again for all of it]` }
    }) as UIMessage['parts'] }
  })
}

/** A conversation's title until something better exists: the start of its first question. */
function titleFrom(m: UIMessage): string {
  const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return 'Picture'
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The request body the panel sends: only the new message; the history stays on the server. */
interface ChatBody { threadId?: string; message?: UIMessage; page?: unknown }

export function createAssistant<DB>(config: AssistantConfig<DB>) {
  if (!config.models.length) throw new Error('createAssistant: at least one model is required')
  if (config.screens?.length && config.tools.some((t) => t.name === 'open_screen')) throw new Error('createAssistant: a tool named open_screen clashes with the screens map; drop one')
  const formatProblem = checkFormats(config.formats ?? {})
  if (formatProblem) throw new Error(`createAssistant: ${formatProblem}`)
  for (const v of config.views ?? []) {
    if (config.tools.some((t) => t.name === `show_${v.name}`)) throw new Error(`createAssistant: tool show_${v.name} clashes with the view ${v.name}`)
  }

  const redact = makeRedactor(config.redact)

  async function chat(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })

    let body: ChatBody
    try { body = (await req.json()) as ChatBody } catch { return json(400, { error: 'The request was not valid JSON.' }) }
    const message = body.message
    if (!message || message.role !== 'user' || !Array.isArray(message.parts)) return json(400, { error: 'Send one user message with some text.' })
    const problem = checkMessage(message, config.attachments)
    if (problem) return json(400, { error: problem })

    const { storage } = config
    const settings = (await storage.tenantSettings(identity.tenantId)) ?? DEFAULT_SETTINGS
    if (!settings.enabled) return json(403, { error: 'The assistant is turned off for your team. An admin can turn it on in settings.' })
    // Before anything is saved, so a refused message leaves no empty thread behind.
    const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts }
    const hit = await checkLimits(storage, identity, config.limits, timeouts.totalMs * 2)
    if (hit) {
      config.on?.limit?.(hit, identity)
      return json(429, { error: limitMessage(hit), limit: hit })
    }

    const thread = body.threadId
      ? await storage.getThread(identity.tenantId, identity.userId, body.threadId)
      : await storage.createThread(identity.tenantId, identity.userId)
    if (!thread) return json(404, { error: 'That conversation was not found.' })   // also when it is someone else's

    let earlier = await storage.listMessages(thread.id)
    // A message the thread already has: the user edited it, or asked for the reply again (same id). Everything from
    // it on is replaced. Only the user's own messages can be sent again.
    const again = earlier.findIndex((m) => m.id === message.id)
    if (again >= 0) {
      if (earlier[again]!.role !== 'user') return json(400, { error: 'Only your own messages can be sent again.' })
      await storage.removeMessagesFrom(thread.id, message.id)
      earlier = earlier.slice(0, again)
    }
    const runId = crypto.randomUUID()
    const page = readPage(body.page)
    const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ')
    const routed = config.route ? await Promise.resolve().then(() => config.route!({ identity, page, text, history: earlier.length })).catch((e) => { config.on?.error?.(e, { identity, threadId: thread.id }); return undefined }) : undefined
    const models = routed?.length ? routed : config.models
    const first = models[0]!
    await storage.startRun({ id: runId, threadId: thread.id, tenantId: identity.tenantId, userId: identity.userId, model: first.modelId, promptVersion: config.promptVersion })
    // Count again now that this reply is registered: two messages sent at the same moment both passed the check
    // above, and only now can one see the other. Nothing is saved or paid for yet, so backing off costs nothing.
    const maxRunning = config.limits?.maxRunning ?? 2
    const running = await storage.runningRuns(identity.tenantId, identity.userId, new Date(Date.now() - timeouts.totalMs * 2))
    if (running > maxRunning) {
      await storage.finishRun(runId, { status: 'failed', error: 'Too many replies at once' })
      if (!body.threadId && !earlier.length) await storage.archiveThread(identity.tenantId, identity.userId, thread.id)   // the empty one just made
      const raced: LimitHit = { scope: 'running', limit: maxRunning, used: running }
      config.on?.limit?.(raced, identity)
      return json(429, { error: limitMessage(raced), limit: raced })
    }

    if (!earlier.length && !thread.title) await storage.setThreadTitle(thread.id, titleFrom(message))
    // Pictures go to the file store; the saved message keeps a reference. The model still reads this message's
    // pictures in full, and earlier ones only as a note.
    const saved = config.files ? await storeFiles(message, config.files, { tenantId: identity.tenantId, userId: identity.userId, threadId: thread.id }) : message
    const history = trimToolResults(picturesOnce([...earlier, message].slice(-(config.historyMessages ?? 30)), message), config.historyToolChars ?? 1500)
    await storage.saveMessages(thread.id, [saved])

    const db = await config.asUser(identity, req)
    await storage.addUsage([{ tenantId: identity.tenantId, userId: identity.userId, runId, provider: first.provider, model: first.modelId, unit: 'messages', amount: 1 }])
    let seq = 0
    const statuses = new Map((await storage.listCards(thread.id)).map((c) => [c.id, c]))
    const nonce = crypto.randomUUID().slice(0, 8)
    // Which outside text this run has read: the user's pictures, and whatever tools fenced as untrusted.
    const seen = new Set<string>(message.parts.some((p) => p.type === 'file') ? ['picture'] : [])
    const fence = makeUntrusted(nonce)
    const ctx: ToolContext<DB> = { identity, db, untrusted: (text, source) => { seen.add(source.replace(/[^\w .-]/g, '').slice(0, 40) || 'outside text'); return fence(text, source) } }
    const instructions = typeof config.instructions === 'function' ? await config.instructions({ identity, page }) : config.instructions
    const summary = page && config.screen ? await Promise.resolve().then(() => config.screen!(page, ctx)).catch((e) => { config.on?.error?.(e, { identity, threadId: thread.id }); return null }) : null
    const shownSummary = summary === null ? null : String(redact(summary))
    const formats: Formats = { ...DEFAULT_FORMATS, ...config.formats, ...settings.formats }
    // Tools this user's role can't use: named (without their inputs) so the model says who can, instead of "I can't".
    const otherRoles = config.tools.filter((t) => t.roles && !t.roles.includes(identity.role))
    const rolesText = otherRoles.length
      ? `\n\nNot available to this user (role: ${identity.role}): ${otherRoles.map((t) => `${t.description.replace(/\.$/, '')} (${t.roles!.join(' or ')} only)`).join('; ')}. If they ask for one, say who can do it; never try another way.`
      : ''
    const system = `${instructions}${formatsText(formats, config.now?.() ?? new Date())}${settingsText(settings)}${rolesText}${screensText(config.screens ?? [])}${config.views?.length ? `\n\n${VIEWS_RULE}${formsText(config.forms ?? {})}` : ''}${config.tools.some((t) => t.kind === 'propose') || config.views?.some((v) => v.name === 'form') ? `\n\n${CARDS_RULE}` : ''}\n\n${UNTRUSTED_RULE}${screenText(page, shownSummary, fence)}`

    const stream = createUIMessageStream<UIMessage<{ runId: string; threadId: string; formats: Formats }>>({
      originalMessages: history as UIMessage<{ runId: string; threadId: string; formats: Formats }>[],
      execute: async ({ writer }) => {
        // The panel draws numbers and dates in views the same way.
        writer.write({ type: 'start', messageMetadata: { runId, threadId: thread.id, formats } })
        const tools: ToolSet = {}
        const off = new Set(settings.toolsOff ?? [])
        for (const t of toolsFor(config.tools, identity).filter((x) => !off.has(x.name))) {
          tools[t.name] = tool({
            description: t.description,
            inputSchema: t.input,
            execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
              writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, state: 'running' } })
              const started = Date.now()
              const step = { runId, seq: seq++, type: 'tool' as const, toolCallId, name: t.name }
              const max = config.logLimit ?? 8000
              const logged = clip(input, max)
              try {
                const raw = await t.run(input, ctx)
                // What a read tool found is what the model sees, so it is what gets hidden. Cards keep their payload.
                const out = t.kind === 'read' ? redact(raw) : raw
                const result = clip(out, max)
                await storage.saveStep({ ...step, input: logged.value, output: result.value, truncated: logged.truncated || result.truncated, durationMs: Date.now() - started })
                if (t.kind === 'propose') {
                  const p = out as Proposal
                  const card: StoredCard = { ...p, id: crypto.randomUUID(), threadId: thread.id, runId, status: 'shown', ...(seen.size ? { untrustedSources: [...seen] } : {}) }
                  await storage.saveCard(card)
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
                await storage.saveStep({ ...step, input: logged.value, truncated: logged.truncated, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started })
                throw e
              } finally {
                writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, state: 'done' } })
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
        if (config.screens?.length) {
          const screens = config.screens
          tools.open_screen = tool({
            description: 'Offer the user a button that opens one of the app\'s screens. Give the screen\'s path from the list, and in params the values for its :params and any of its filters. Only the listed filters work.',
            inputSchema: z.object({
              screen: z.string(),
              params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
              label: z.string().max(40).describe('What the button does, in the user\'s words, e.g. "Show unpaid orders" or "Open order #142"'),
            }),
            execute: async ({ screen, params, label }, { toolCallId }) => {
              const to = screenPath(screens, screen, params ?? {})
              if (!to) {
                const s = screens.find((x) => x.path === screen.split('?')[0] || x.title === screen)
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
        let streamError: unknown
        let shown = false   // a card, view or button reached the user in this reply
        const modelMessages = await convertToModelMessages(history, {
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
        const result = streamText({
          onError: ({ error }) => { streamError ??= error },
          model,
          system,
          messages: modelMessages,
          tools,
          stopWhen: isStepCount(config.maxSteps ?? 8),
          // First output is timed by fallbackModel (per model, so a stalled one hands over to the next); the SDK
          // keeps the gaps between chunks and the total.
          timeout: { chunkMs: timeouts.chunkMs, totalMs: timeouts.totalMs },
          maxRetries: 1,
          abortSignal: req.signal,
        })
        // Our sentence for the user, not the SDK's "An error occurred."; tool errors still reach the model as they are.
        writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false, sendFinish: false, onError: () => FAILED, redactToolErrors: false }))
        const results = [result]
        try {
          let text = await result.text
          // Models sometimes end a turn in silence after a tool call. Never leave the user with an empty reply: ask
          // once more, with tools off, for the answer in words. (Not after a view or card: those are the answer.)
          const said = (await result.steps).some((st) => st.text.trim())
          if (!said && !shown && !req.signal.aborted) {
            const again = streamText({
              model, system: `${system}\n\nYou have what you need from the tools above. Now answer the user in words; do not call tools.`,
              messages: [...modelMessages, ...(await result.response).messages], tools, toolChoice: 'none', maxRetries: 1, abortSignal: req.signal,
              timeout: { chunkMs: timeouts.chunkMs, totalMs: timeouts.totalMs },
            })
            results.push(again)
            writer.merge(toUIMessageStream({ stream: again.stream, sendStart: false, sendFinish: false, onError: () => NO_ANSWER, redactToolErrors: false }))
            text = await Promise.resolve(again.text).catch(() => NO_ANSWER)
          }
          writer.write({ type: 'finish' })
          await finish('done')
          if (config.suggestions) {
            // Follow-ups ride along as a transient part: shown under this reply, never saved in the history.
            const s = await Promise.resolve().then(() => config.suggestions!({ identity: identity!, page, after: text, db })).catch(() => null)
            if (s && s.suggestions.length) writer.write({ type: 'data-suggestions', data: tidy(s), transient: true })
          }
        } catch (e) {
          await finish(req.signal.aborted ? 'stopped' : 'failed', streamError ?? e)
          throw e
        }

        async function finish(status: 'done' | 'failed' | 'stopped', error?: unknown) {
          await storage.finishRun(runId, { status, model: usedModel.modelId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) })
          const all = await Promise.all(results.map((r) => Promise.resolve(r.totalUsage).catch(() => undefined)))
          const u = { inputTokens: all.reduce((n, x) => n + (x?.inputTokens ?? 0), 0), outputTokens: all.reduce((n, x) => n + (x?.outputTokens ?? 0), 0) }
          const base = { tenantId: identity!.tenantId, userId: identity!.userId, runId, provider: usedModel.provider, model: usedModel.modelId }
          const rows: UsageRow[] = []
          if (u?.inputTokens) rows.push({ ...base, unit: 'input_tokens', amount: u.inputTokens })
          if (u?.outputTokens) rows.push({ ...base, unit: 'output_tokens', amount: u.outputTokens })
          // Providers with their own cost unit report it per step (Workers AI: neurons).
          const steps = (await Promise.all(results.map((r) => Promise.resolve(r.steps).catch(() => [])))).flat()
          const neurons = steps.reduce((n, s) => n + (Number((s.providerMetadata?.workersAi as { neurons?: number } | undefined)?.neurons) || 0), 0)
          if (neurons > 0) rows.push({ ...base, unit: 'neurons', amount: neurons })
          if (rows.length) { await storage.addUsage(rows); config.on?.usage?.(rows) }
        }
      },
      onError: (e) => {
        config.on?.error?.(e, { identity, threadId: thread.id })
        return FAILED
      },
      onEnd: async ({ messages }) => {
        const reply = messages.at(-1)
        // A reply the user stopped keeps what was written so far, marked, so a reload shows it was cut short.
        if (reply && reply.role === 'assistant') {
          await storage.saveMessages(thread.id, [req.signal.aborted ? { ...reply, metadata: { ...(reply.metadata as object | undefined), stopped: true } } : reply])
        }
      },
    })
    return createUIMessageStreamResponse({ stream, headers: { 'x-teovo-thread': thread.id } })
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
    return json(200, { thread: { id: thread.id, title: thread.title, createdAt: thread.createdAt }, messages })
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
    const card: StoredCard = { ...proposal, fields, id: await stableId(`${thread.id}:${viewId}`), threadId: thread.id, runId, status: 'shown' }
    await storage.saveCard(card)
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

  async function card(req: Request, id: string, decision: Decision): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    try {
      // An app-applied card reports whether its change can be taken back; nothing else is read from the body.
      const body = (await req.json().catch(() => ({}))) as { reversible?: unknown }
      const done = await decide({
        storage: config.storage, appliers: config.cards ?? {}, rules, identity, id, decision, reversible: body.reversible === true,
        ctx: async () => ({ identity, db: await config.asUser(identity, req), untrusted: makeUntrusted(crypto.randomUUID().slice(0, 8)) }),
      })
      config.on?.decision?.(done, decision, identity)
      return json(200, { card: publicCard(done) })
    } catch (e) {
      if (e instanceof CardError) return json(e.status, { error: e.message })
      config.on?.error?.(e, { identity, threadId: '' })
      return json(500, { error: 'Something went wrong. Nothing was changed.' })
    }
  }

  return {
    /**
     * Delete pictures older than `files.keepDays`. Call it on a schedule (a cron, a Worker scheduled event).
     * Returns how many were removed; 0 when no keepDays or the store can't list by age.
     */
    async removeOldFiles(now = new Date()): Promise<number> {
      const f = config.files
      if (!f?.keepDays || !f.store.removeOlderThan) return 0
      return f.store.removeOlderThan(new Date(now.getTime() - f.keepDays * 86_400_000))
    },
    /** Mount under any path, e.g. app.all('/api/assistant/*', teovo.fetch). Handles POST …/chat (a message sent again replaces it and what came after), POST …/runs/:id/rating, GET …/threads, GET …/threads/:id, POST …/threads/:id/archive, GET …/suggestions, GET/PUT …/settings and POST …/cards/:id/(confirm|skip|undo). */
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path.endsWith('/chat')) return chat(req)
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
      const m = /\/cards\/([0-9a-f-]{36})\/(confirm|skip|undo)$/i.exec(path)
      if (req.method === 'POST' && m) return card(req, m[1]!.toLowerCase(), m[2] as Decision)
      return json(404, { error: 'Not found.' })
    },
  }
}
