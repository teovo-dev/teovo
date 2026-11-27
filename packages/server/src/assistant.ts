import type { LanguageModelV4 } from '@ai-sdk/provider'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, tool, toUIMessageStream, type ToolSet, type UIMessage } from 'ai'
import { fallbackModel } from './fallback'
import type { Storage, StoredCard } from './storage'
import { toolsFor, type Action, type Identity, type Proposal, type TeovoTool, type ToolContext } from './tools'
import { makeUntrusted, UNTRUSTED_RULE } from './untrusted'

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
  on?: {
    error?: (error: unknown, ctx: { identity: Identity; threadId: string }) => void
    modelSwitch?: (from: string, error: unknown) => void
    card?: (card: StoredCard) => void
  }
}

const DEFAULT_TIMEOUTS = { firstChunkMs: 30_000, chunkMs: 20_000, totalMs: 120_000 }

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
    const thread = body.threadId
      ? await storage.getThread(identity.tenantId, identity.userId, body.threadId)
      : await storage.createThread(identity.tenantId, identity.userId)
    if (!thread) return json(404, { error: 'That conversation was not found.' })   // also when it is someone else's

    const history = [...(await storage.listMessages(thread.id)), message].slice(-(config.historyMessages ?? 30))
    await storage.saveMessages(thread.id, [message])

    const db = await config.asUser(identity, req)
    const runId = crypto.randomUUID()
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
              try {
                const out = await t.run(input, ctx)
                if (t.kind === 'propose') {
                  const p = out as Proposal
                  const card: StoredCard = { ...p, id: crypto.randomUUID(), threadId: thread.id, runId, status: 'shown' }
                  await storage.saveCard(card)
                  config.on?.card?.(card)
                  writer.write({ type: 'data-card', id: card.id, data: card })
                  return `Shown to the user as a card: "${p.title}". Nothing has changed yet; the user confirms or skips it.`
                }
                if (t.kind === 'action') {
                  writer.write({ type: 'data-action', id: toolCallId, data: out as Action })
                  return 'A button is shown under your reply.'
                }
                return out
              } finally {
                writer.write({ type: 'data-step', id: toolCallId, data: { name: t.name, state: 'done' } })
              }
            },
          })
        }
        // Tools only read, propose or offer buttons; none writes during a run, so switching model is always safe.
        const model = fallbackModel(config.models, () => true, config.on?.modelSwitch)
        const result = streamText({
          model,
          system,
          messages: await convertToModelMessages(history),
          tools,
          stopWhen: isStepCount(config.maxSteps ?? 8),
          timeout: { ...DEFAULT_TIMEOUTS, ...config.timeouts },
          maxRetries: 1,
        })
        writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false }))
        await result.text
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

  return {
    /** Mount under any path, e.g. app.all('/api/assistant/*', teovo.fetch). Handles POST …/chat. */
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path.endsWith('/chat')) return chat(req)
      return json(404, { error: 'Not found.' })
    },
  }
}
