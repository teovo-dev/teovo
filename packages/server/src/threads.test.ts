import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const s = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const fin = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage })
const u1: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const u2: Identity = { tenantId: 'shop-1', userId: 'u2', role: 'owner' }

function setup() {
  const storage = memoryStorage()
  let who = u1
  const model = new MockLanguageModelV4({ doStream: async ({ prompt }) => {
    const p = JSON.stringify(prompt)
    return p.includes('paid 200') && !p.includes('tool-result') && !p.includes('[Card')
      ? s([{ type: 'tool-call', toolCallId: `c${Math.random()}`, toolName: 'pay', input: '{}' }, fin('tool-calls')])
      : s([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, fin('stop')])
  } })
  const teovo = createAssistant({
    identify: () => who, asUser: () => null, models: [model], instructions: 'Help.', storage,
    tools: [defineTool({ name: 'pay', kind: 'propose', description: 'p', input: z.object({}), run: () => ({ kind: 'pay', title: 'Payment ₹200', payload: {} }) })],
    cards: { pay: { apply: () => ({ undo: { secret: 'row-9' } }), undo: () => {} } },
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await teovo.fetch(new Request(`https://a.test/api/assistant/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const text = await res.text()
    return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text, thread: res.headers.get('x-teovo-thread') }
  }
  const chat = (text: string, threadId?: string) => call('POST', 'chat', { threadId, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } satisfies UIMessage })
  return { storage, call, chat, as: (i: Identity) => { who = i } }
}

describe('threads', () => {
  it("lists only this person's conversations, most recently active first, titled from the first question", async () => {
    const t = setup()
    const a = (await t.chat('How much did we sell this month compared with the same month last year?')).thread!
    await new Promise((r) => setTimeout(r, 5))
    const b = (await t.chat('Who owes money?')).thread!
    await new Promise((r) => setTimeout(r, 5))
    await t.chat('and last month?', a)   // a is now the most recent
    const list = (await t.call('GET', 'threads')).body.threads
    expect(list.map((x: { id: string }) => x.id)).toEqual([a, b])
    expect(list[0].title).toBe('How much did we sell this month compared with the same mo…')
    expect(list[1].title).toBe('Who owes money?')
    t.as(u2)
    expect((await t.call('GET', 'threads')).body.threads).toEqual([])
    expect((await t.call('GET', `threads/${a}`)).status).toBe(404)
  })

  it('loads a conversation with its cards as they are now, never with undo data', async () => {
    const t = setup()
    const id = (await t.chat('paid 200')).thread!
    const cardId = [...t.storage.cards.keys()][0]!
    await t.call('POST', `cards/${cardId}/confirm`)
    const r = await t.call('GET', `threads/${id}`)
    expect(r.status).toBe(200)
    expect(r.body.thread).toMatchObject({ id, title: 'paid 200' })
    expect(r.body.messages.map((m: UIMessage) => m.role)).toEqual(['user', 'assistant'])
    const card = r.body.messages[1].parts.find((p: { type: string }) => p.type === 'data-card')
    expect(card.data).toMatchObject({ id: cardId, status: 'confirmed', reversible: true })
    expect(JSON.stringify(r.body)).not.toContain('row-9')
  })

  it('archives a conversation: gone from the list and closed to new messages', async () => {
    const t = setup()
    const id = (await t.chat('hello')).thread!
    t.as(u2)
    expect((await t.call('POST', `threads/${id}/archive`)).status).toBe(404)
    t.as(u1)
    expect((await t.call('POST', `threads/${id}/archive`)).body).toEqual({ archived: true })
    expect((await t.call('GET', 'threads')).body.threads).toEqual([])
    expect((await t.chat('again', id)).status).toBe(404)
    expect((await t.call('POST', `threads/${id}/archive`)).status).toBe(404)
  })
})
