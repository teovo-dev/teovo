import type { LanguageModelV4 } from '@ai-sdk/provider'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, tool, toUIMessageStream, type ToolSet, type UIMessage } from 'ai'
import { fallbackModel } from './fallback.js'
import { CardError, cardForModel, decide, publicCard, type CardApplier, type CardRules, type Decision } from './cards.js'
import { checkLimits, limitMessage, type LimitHit, type Limits } from './limits.js'
import type { Storage, StoredCard, UsageRow } from './storage.js'
import { toolsFor, type Action, type Identity, type Proposal, type TeovoTool, type ToolContext } from './tools.js'
import { makeUntrusted, UNTRUSTED_RULE } from './untrusted.js'

export interface Page { path?: string; title?: string }

export interface AssistantConfig<DB = unknown> {
  /** Who is asking, from the request (cookie, token, header). Return null to refuse with 401. Required. */
  identify: (req: Request) => Promise<Identity | null> | Identity | null
  /** A database client acting as this person; every tool receives it as ctx.db. Required. */
  asUser: (identity: Identity, req: Request) => Promise<DB> | DB
  tools: readonly TeovoTool<any, any, DB>[]
  /** Models in order: if one fails before saying anything, the next is tried. */
  models: readonly LanguageModelV4[]
  /** The app's own instructions for the model. */
  instructions: string | ((ctx: { identity: Identity; page?: Page }) => string | Promise<string>)
  storage: Storage
  /** Model calls per message, tool calls included. Default 8. */
  maxSteps?: number
  /** Earlier messages the model sees. Default 30. */
  historyMessages?: number
  /** Give up on a model that sends nothing at first, goes quiet, or runs too long. Milliseconds. */
  timeouts?: { firstChunkMs?: number; chunkMs?: number; totalMs?: number }
  /** Messages and tokens per person and per tenant, checked before every reply. Tenants can set their own in tv_budgets. */
  limits?: Limits
  /** How to apply each kind of card when the user confirms it, keyed by the card's `kind`. */
  cards?: Record<string, CardApplier<any, DB>>
  /** How long a card can be confirmed, and how long after confirming it can be undone. */
  cardRules?: Partial<CardRules>
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
  }
}

const DEFAULT_TIMEOUTS = { firstChunkMs: 30_000, chunkMs: 20_000, totalMs: 120_000 }

function clip(v: unknown, max: number): { value: unknown; truncated: boolean } {
  if (v === undefined) return { value: undefined, truncated: false }
  const text = JSON.stringify(v) ?? ''
  return text.length <= max ? { value: v, truncated: false } : { value: text.slice(0, max), truncated: true }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The request body the panel sends: only the new message; the history stays on the server. */
interface ChatBody { threadId?: string; message?: UIMessage; page?: Page }

export function createAssistant<DB>(config: AssistantConfig<DB>) {
  if (!config.models.length) throw new Error('createAssistant: at least one model is required')

  async function chat(req: Request): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })

    let body: ChatBody
    try { body = (await req.json()) as ChatBody } catch { return json(400, { error: 'The request was not valid JSON.' }) }
    const message = body.message
    if (!message || message.role !== 'user' || !Array.isArray(message.parts) || !message.parts.some((p) => p.type === 'text' && p.text.trim())) {
      return json(400, { error: 'Send one user message with some text.' })
    }

    const { storage } = config
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

    const history = [...(await storage.listMessages(thread.id)), message].slice(-(config.historyMessages ?? 30))
    await storage.saveMessages(thread.id, [message])

    const db = await config.asUser(identity, req)
    const runId = crypto.randomUUID()
    const first = config.models[0]!
    await storage.startRun({ id: runId, threadId: thread.id, tenantId: identity.tenantId, userId: identity.userId, model: first.modelId, promptVersion: config.promptVersion })
    await storage.addUsage([{ tenantId: identity.tenantId, userId: identity.userId, runId, provider: first.provider, model: first.modelId, unit: 'messages', amount: 1 }])
    let seq = 0
    const statuses = new Map((await storage.listCards(thread.id)).map((c) => [c.id, c]))
    const nonce = crypto.randomUUID().slice(0, 8)
    const ctx: ToolContext<DB> = { identity, db, untrusted: makeUntrusted(nonce) }
    const instructions = typeof config.instructions === 'function' ? await config.instructions({ identity, page: body.page }) : config.instructions
    const where = body.page?.path ? `\n\nThe user is on the screen ${body.page.title ? `"${body.page.title}" ` : ''}at ${body.page.path}.` : ''
    const system = `${instructions}\n\n${UNTRUSTED_RULE}${where}`

    const stream = createUIMessageStream<UIMessage<{ runId: string; threadId: string }>>({
      originalMessages: history as UIMessage<{ runId: string; threadId: string }>[],
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageMetadata: { runId, threadId: thread.id } })
        const tools: ToolSet = {}
        for (const t of toolsFor(config.tools, identity)) {
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
                const out = await t.run(input, ctx)
                const result = clip(out, max)
                await storage.saveStep({ ...step, input: logged.value, output: result.value, truncated: logged.truncated || result.truncated, durationMs: Date.now() - started })
                if (t.kind === 'propose') {
                  const p = out as Proposal
                  const card: StoredCard = { ...p, id: crypto.randomUUID(), threadId: thread.id, runId, status: 'shown' }
                  await storage.saveCard(card)
                  config.on?.card?.(card)
                  writer.write({ type: 'data-card', id: card.id, data: publicCard(card) })
                  return `Shown to the user as a card: "${p.title}". Nothing has changed yet; the user confirms or skips it.`
                }
                if (t.kind === 'action') {
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
        // Tools only read, propose or offer buttons; none writes during a run, so switching model is always safe.
        let usedModel = first
        const model = fallbackModel(config.models, () => true, (from, e) => {
          const i = config.models.findIndex((m) => m.modelId === from)
          usedModel = config.models[i + 1] ?? usedModel
          config.on?.modelSwitch?.(from, e)
        })
        let streamError: unknown
        const result = streamText({
          onError: ({ error }) => { streamError ??= error },
          model,
          system,
          messages: await convertToModelMessages(history, {
            // Earlier cards reach the model with their status now, so it knows what the user confirmed or skipped.
            convertDataPart: (p) => {
              if (p.type !== 'data-card') return undefined
              const c = p.data as StoredCard
              return { type: 'text', text: cardForModel(statuses.get(c.id) ?? c) }
            },
          }),
          tools,
          stopWhen: isStepCount(config.maxSteps ?? 8),
          timeout: timeouts,
          maxRetries: 1,
          abortSignal: req.signal,
        })
        writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false }))
        try {
          await result.text
          await finish('done')
        } catch (e) {
          await finish(req.signal.aborted ? 'stopped' : 'failed', streamError ?? e)
          throw e
        }

        async function finish(status: 'done' | 'failed' | 'stopped', error?: unknown) {
          await storage.finishRun(runId, { status, model: usedModel.modelId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) })
          const u = await Promise.resolve(result.totalUsage).catch(() => undefined)
          const base = { tenantId: identity!.tenantId, userId: identity!.userId, runId, provider: usedModel.provider, model: usedModel.modelId }
          const rows: UsageRow[] = []
          if (u?.inputTokens) rows.push({ ...base, unit: 'input_tokens', amount: u.inputTokens })
          if (u?.outputTokens) rows.push({ ...base, unit: 'output_tokens', amount: u.outputTokens })
          if (rows.length) { await storage.addUsage(rows); config.on?.usage?.(rows) }
        }
      },
      onError: (e) => {
        config.on?.error?.(e, { identity, threadId: thread.id })
        return 'The assistant could not finish this reply. Try again.'
      },
      onEnd: async ({ messages }) => {
        const reply = messages.at(-1)
        if (reply && reply.role === 'assistant') await storage.saveMessages(thread.id, [reply])
      },
    })
    return createUIMessageStreamResponse({ stream, headers: { 'x-teovo-thread': thread.id } })
  }

  const rules: CardRules = { ttlMs: 24 * 3600_000, undoMs: 10 * 60_000, ...config.cardRules }

  async function card(req: Request, id: string, decision: Decision): Promise<Response> {
    const identity = await config.identify(req)
    if (!identity) return json(401, { error: 'Sign in to use the assistant.' })
    try {
      const done = await decide({
        storage: config.storage, appliers: config.cards ?? {}, rules, identity, id, decision,
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
    /** Mount under any path, e.g. app.all('/api/assistant/*', teovo.fetch). Handles POST …/chat and POST …/cards/:id/(confirm|skip|undo). */
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path.endsWith('/chat')) return chat(req)
      const m = /\/cards\/([0-9a-f-]{36})\/(confirm|skip|undo)$/i.exec(path)
      if (req.method === 'POST' && m) return card(req, m[1]!.toLowerCase(), m[2] as Decision)
      return json(404, { error: 'Not found.' })
    },
  }
}
