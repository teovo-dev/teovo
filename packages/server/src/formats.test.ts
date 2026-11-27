import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { formatsText } from './formats'
import { memoryStorage } from './storage'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const say = () => ({ stream: new ReadableStream({ start(c) {
  for (const p of [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]) c.enqueue(p as LanguageModelV4StreamPart)
  c.close()
} }) })
// 27 Nov 2026, 20:30 UTC: already the 28th in India.
const now = () => new Date('2026-11-27T20:30:00Z')

function setup() {
  const storage = memoryStorage()
  const model = new MockLanguageModelV4({ doStream: async () => say() })
  const teovo = createAssistant({
    identify: () => ({ tenantId: 'shop-1', userId: 'u', role: 'owner' }), asUser: () => null, tools: [], instructions: 'Help.', storage, models: [model],
    formats: { locale: 'en-US', currency: 'USD', timeZone: 'America/New_York' }, now,
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await teovo.fetch(new Request(`https://a.test/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: res.status, text: await res.text() }
  }
  const chat = () => call('POST', 'chat', { message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] } satisfies UIMessage })
  const system = () => (JSON.parse(JSON.stringify(model.doStreamCalls.at(-1)!.prompt[0])) as { content: string }).content
  return { call, chat, system }
}

describe('formats', () => {
  it('writes today and money for the place, not the server', () => {
    expect(formatsText({ locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' }, now())).toBe(
      '\n\nToday is Saturday, 28 November 2026, 2:00 am (Asia/Kolkata). Write amounts like ₹1,250.00 and dates like 28 Nov 2026. When a tool needs a date, use YYYY-MM-DD.')
  })

  it("uses the app's default, then the tenant's own, and sends them to the panel", async () => {
    const s = setup()
    const first = await s.chat()
    expect(s.system()).toContain('Today is Friday, November 27, 2026, 3:30 PM (America/New_York). Write amounts like $1,250.00')
    expect(first.text).toContain('"formats":{"locale":"en-US","currency":"USD","timeZone":"America/New_York"}')
    await s.call('PUT', 'settings', { formats: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' } })
    await s.chat()
    expect(s.system()).toContain('Today is Saturday, 28 November 2026, 2:00 am (Asia/Kolkata). Write amounts like ₹1,250.00')
    expect(s.system().indexOf('Today is')).toBeLessThan(s.system().indexOf('Text between <untrusted'))
  })

  it('refuses formats Intl does not know', async () => {
    const s = setup()
    expect(JSON.parse((await s.call('PUT', 'settings', { formats: { currency: 'RUPEES' } })).text).error).toBe('Unknown currency: RUPEES.')
    expect(JSON.parse((await s.call('PUT', 'settings', { formats: { timeZone: 'Mars/Base' } })).text).error).toBe('Unknown time zone: Mars/Base.')
    expect(() => createAssistant({ identify: () => null, asUser: () => null, tools: [], instructions: '', storage: memoryStorage(), models: [new MockLanguageModelV4()], formats: { timeZone: 'Nowhere' } }))
      .toThrow('createAssistant: Unknown time zone: Nowhere.')
  })
})
