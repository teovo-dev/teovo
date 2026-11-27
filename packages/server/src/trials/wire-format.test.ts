// Trial: can the Vercel AI SDK's UI message stream carry Teovo's cards, steps, views and suggestions?
// Runs a real streamText tool loop against a mock model, sends it over the SSE response the browser would get,
// reads it back the way useChat does, and checks the saved message holds everything Teovo needs.
import { createUIMessageStream, createUIMessageStreamResponse, isStepCount, readUIMessageStream, streamText, tool, toUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

type Card = { id: string; kind: string; title: string; before: Record<string, unknown>; after: Record<string, unknown>; status: 'shown' | 'confirmed' }
type Step = { name: string; state: 'running' | 'done' }
type View = { view: string; data: unknown; source?: { tool: string; input: unknown } }
type TeovoMessage = UIMessage<{ runId: string }, { card: Card; step: Step; view: View; suggestions: string[] }>

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } }
const sse = (chunks: unknown[]) => ({
  stream: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } }),
})

/** Step 1: the model asks for the payment tool. Step 2: it writes a one-line reply. */
const model = () => new MockLanguageModelV4({
  doStream: [
    sse([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'record_payment', input: JSON.stringify({ sale: 142, amount: 200, mode: 'GPay' }) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ]),
    sse([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Prepared for ' },
      { type: 'text-delta', id: 't1', delta: 'your confirmation.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ]),
  ] as never,
})

/** What the Teovo handler would do: run the loop, and write cards, steps, views and suggestions as data parts. */
function teovoStream() {
  return createUIMessageStream<TeovoMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageMetadata: { runId: 'run-1' } })
      const result = streamText({
        model: model(),
        prompt: 'Riya paid 200 by GPay',
        stopWhen: isStepCount(3),
        tools: {
          record_payment: tool({
            description: 'Propose recording a payment',
            inputSchema: z.object({ sale: z.number(), amount: z.number(), mode: z.string() }),
            execute: async (input, { toolCallId }) => {
              writer.write({ type: 'data-step', id: toolCallId, data: { name: 'Reading order 142', state: 'running' } })
              writer.write({ type: 'data-step', id: toolCallId, data: { name: 'Reading order 142', state: 'done' } })   // same id: replaces
              writer.write({ type: 'data-card', id: 'card-1', data: { id: 'card-1', kind: 'record_payment', title: `Payment ₹${input.amount} for order #${input.sale}`, before: { paid: 0 }, after: { paid: input.amount }, status: 'shown' } })
              return 'Shown to the user as a card. Not applied yet.'
            },
          }),
        },
      })
      writer.merge(toUIMessageStream({ stream: result.stream, sendStart: false }))
      await result.text
      writer.write({ type: 'data-view', id: 'view-1', data: { view: 'record-card', data: { sale: 142, owed: 680 }, source: { tool: 'get_order', input: { sale: 142 } } } })
      writer.write({ type: 'data-suggestions', data: ['Send receipt on WhatsApp', 'Who else owes money?'], transient: true })
    },
  })
}

/** Parse an SSE body back into chunks, as the browser transport does. */
async function chunksFromResponse(res: Response): Promise<UIMessageChunk[]> {
  const text = await res.text()
  return text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)))
}

describe('trial: Teovo parts on the Vercel AI SDK UI message stream', () => {
  it('carries cards, steps and views through SSE into the saved message, and suggestions as transient data', async () => {
    const res = createUIMessageStreamResponse({ stream: teovoStream() })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const chunks = await chunksFromResponse(res)

    const transient = chunks.filter((c) => c.type === 'data-suggestions')
    expect(transient).toHaveLength(1)

    let final: TeovoMessage | undefined
    const stream = new ReadableStream<UIMessageChunk>({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } })
    for await (const m of readUIMessageStream<TeovoMessage>({ stream })) final = m
    expect(final).toBeDefined()
    const parts = final!.parts

    expect(final!.metadata).toEqual({ runId: 'run-1' })
    const text = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
    expect(text).toBe('Prepared for your confirmation.')

    const steps = parts.filter((p) => p.type === 'data-step')
    expect(steps).toHaveLength(1)   // reconciled by id: one part, latest state
    expect((steps[0] as { data: Step }).data.state).toBe('done')

    const cards = parts.filter((p) => p.type === 'data-card') as { data: Card }[]
    expect(cards).toHaveLength(1)
    expect(cards[0]!.data).toMatchObject({ kind: 'record_payment', title: 'Payment ₹200 for order #142', before: { paid: 0 }, after: { paid: 200 } })

    const views = parts.filter((p) => p.type === 'data-view') as { data: View }[]
    expect(views[0]!.data.source).toEqual({ tool: 'get_order', input: { sale: 142 } })

    expect(parts.some((p) => p.type === 'data-suggestions')).toBe(false)   // transient: not saved
    expect(parts.some((p) => p.type === 'tool-record_payment')).toBe(true)  // the tool call itself is kept too

    // A saved message round-trips through JSON (what tv_messages.parts stores) unchanged.
    expect(JSON.parse(JSON.stringify(final))).toEqual(final)
  })
})
