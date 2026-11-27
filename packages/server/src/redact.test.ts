import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { makeRedactor } from './redact'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

describe('makeRedactor', () => {
  const r = makeRedactor({ fields: ['Phone', 'address'], patterns: ['email', 'phone', 'upi', 'card'] })

  it('hides named fields at any depth and patterns inside text', () => {
    expect(r({
      name: 'Riya', phone: '98765 43210', total: 880, address: null,
      orders: [{ no: 142, note: 'Call +91 98765-43210 or mail riya.n@gmail.com, pay to riya@okicici' }],
      card: 'Paid with 4111 1111 1111 1111',
    })).toEqual({
      name: 'Riya', phone: '[hidden]', total: 880, address: null,
      orders: [{ no: 142, note: 'Call [phone] or mail [email], pay to [UPI id]' }],
      card: 'Paid with [card number]',
    })
  })

  it('leaves amounts, dates and order numbers alone', () => {
    expect(r('Order #142 on 2026-11-27: ₹1,250.00, 3 items, due in 5 days')).toBe('Order #142 on 2026-11-27: ₹1,250.00, 3 items, due in 5 days')
  })

  it('does nothing without options, and runs the custom step last', () => {
    expect(makeRedactor(undefined)({ phone: '9876543210' })).toEqual({ phone: '9876543210' })
    expect(makeRedactor({ fields: ['phone'], custom: (v) => ({ ...(v as object), checked: true }) })({ phone: '1' })).toEqual({ phone: '[hidden]', checked: true })
  })
})

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const s = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage })

describe('redaction in a chat', () => {
  it('keeps hidden details out of the model, the run log and the screen, but not out of cards', async () => {
    const model = new MockLanguageModelV4({ doStream: [
      s([{ type: 'tool-call', toolCallId: 'a', toolName: 'get_customer', input: '{}' }, finish('tool-calls')]),
      s([{ type: 'tool-call', toolCallId: 'b', toolName: 'remind', input: '{}' }, finish('tool-calls')]),
      s([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Reminder ready.' }, { type: 'text-end', id: 't' }, finish('stop')]),
    ] as never })
    const storage = memoryStorage()
    const teovo = createAssistant({
      identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, models: [model], instructions: 'Help.', storage,
      redact: { fields: ['phone'], patterns: ['email'] },
      screen: () => 'Customer Riya, riya.n@gmail.com',
      tools: [
        defineTool({ name: 'get_customer', kind: 'read', description: 'c', input: z.object({}), run: () => ({ name: 'Riya', phone: '9876543210', email: 'riya.n@gmail.com', owes: 880 }) }),
        defineTool({ name: 'remind', kind: 'propose', description: 'r', input: z.object({}), run: () => ({ kind: 'whatsapp', title: 'Remind Riya', payload: { phone: '9876543210' } }) }),
      ],
    })
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ page: { path: '/c/1' }, message: { id: 'q', role: 'user', parts: [{ type: 'text', text: 'remind Riya' }] } satisfies UIMessage }) }))
    await res.text()
    const everything = JSON.stringify(model.doStreamCalls.map((c) => c.prompt)) + JSON.stringify(storage.steps.filter((x) => x.name === 'get_customer'))
    expect(everything).not.toContain('9876543210')
    expect(everything).not.toContain('riya.n@gmail.com')
    expect(everything).toContain('[hidden]')
    expect(everything).toContain('owes')
    expect([...storage.cards.values()][0]!.payload).toEqual({ phone: '9876543210' })
  })
})
