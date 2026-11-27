import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const say = () => ({ stream: new ReadableStream({ start(c) {
  for (const p of [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'A bill for ₹450.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]) c.enqueue(p as LanguageModelV4StreamPart)
  c.close()
} }) })
const png = `data:image/png;base64,${Buffer.from('fake picture bytes').toString('base64')}`

function setup(attachments?: AssistantConfig['attachments']) {
  const storage = memoryStorage()
  const model = new MockLanguageModelV4({ doStream: async () => say() })
  const teovo = createAssistant({ identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, tools: [], instructions: 'Help.', storage, models: [model], attachments })
  const send = async (parts: UIMessage['parts']) => {
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: crypto.randomUUID(), role: 'user', parts } }) }))
    const text = await res.text()
    return { status: res.status, text, error: res.status === 200 ? undefined : (JSON.parse(text) as { error: string }).error }
  }
  return { storage, model, send }
}
const file = (url: string, mediaType = 'image/png', filename = 'bill.png') => ({ type: 'file' as const, url, mediaType, filename })

describe('attachments', () => {
  it('are refused unless the app turns them on', async () => {
    const s = setup()
    expect((await s.send([{ type: 'text', text: 'what is this?' }, file(png)])).error).toBe('This assistant doesn’t take attachments.')
    expect((await s.send([{ type: 'text', text: ' ' }])).error).toBe('Send one user message with some text.')
  })

  it('pass a picture to the model, even with no text, and title the conversation', async () => {
    const s = setup({})
    const r = await s.send([file(png)])
    expect(r.status).toBe(200)
    expect(r.text).toContain('A bill for ₹450.')
    const prompt = JSON.stringify(s.model.doStreamCalls[0]!.prompt)
    expect(prompt).toContain('"mediaType":"image/png"')
    expect([...s.storage.threads.values()][0]!.title).toBe('Picture')
  })

  it('refuse links, other types, big files and too many files, with a sentence', async () => {
    const s = setup({ maxBytes: 10, maxFiles: 2 })
    expect((await s.send([file('https://evil.test/x.png')])).error).toBe('“bill.png” must be sent with the message, not as a link.')
    expect((await s.send([file('data:application/pdf;base64,AAAA', 'application/pdf', 'a.pdf')])).error).toBe('“a.pdf” isn’t a type this assistant reads (jpeg, png, webp).')
    expect((await s.send([file(png)])).error).toBe('“bill.png” is too big. The limit is 0 MB.')
    const small = 'data:image/png;base64,AAAA'
    expect((await s.send([file(small), file(small), file(small)])).error).toBe('Attach at most 2 files at a time.')
    expect((await s.send([file(small, 'image/jpeg')])).error).toMatch(/isn’t a type/)   // declared type must match the data
    expect(s.model.doStreamCalls).toHaveLength(0)
  })
})
