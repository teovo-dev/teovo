import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel } from './testing'
import { defineTool, type Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const list = async (teovo: ReturnType<typeof createAssistant>, q = '') =>
  ((await (await teovo.fetch(new Request(`https://a.test/threads${q ? `?q=${encodeURIComponent(q)}` : ''}`))).json()) as { threads: { id: string; title: string }[] }).threads

describe('History: automatic titles and search', () => {
  it('names a conversation after its first reply, once, and counts what that used', async () => {
    const storage = memoryStorage()
    const usage = { inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } }
    const namer = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Title: "Money owed by customers."' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }) as never })
    const rows: { unit: string; model: string }[] = []
    const teovo = createAssistant({
      identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools: [], models: [scriptedModel([say('Riya Sharma owes ₹880.'), say('You are welcome.')])],
      titles: { model: namer }, on: { usage: (r) => rows.push(...r) },
    })
    const first = await chat(teovo, 'who still owes me money?')
    expect((await list(teovo))[0]!.title).toBe('Money owed by customers')
    expect(JSON.stringify(namer.doGenerateCalls[0]!.prompt)).toContain('Riya Sharma owes ₹880.')
    expect(rows.filter((r) => r.model === namer.modelId).map((r) => r.unit)).toEqual(['input_tokens', 'output_tokens'])
    await chat(teovo, 'thanks', { threadId: first.threadId! })
    expect(namer.doGenerateCalls).toHaveLength(1)
    expect((await list(teovo))[0]!.title).toBe('Money owed by customers')
  })

  it('without titles, the first words stay the title', async () => {
    const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: 'Help.', storage: memoryStorage(), tools: [], models: [scriptedModel([say('Hi.')])] })
    await chat(teovo, 'hello there')
    expect((await list(teovo))[0]!.title).toBe('hello there')
  })

  it('searches titles and words, not tool data, and only this person\'s', async () => {
    const storage = memoryStorage()
    const tools = [defineTool({ name: 'orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => [{ customer: 'Hotel Lakeview' }] })]
    const teovo = createAssistant({
      identify: (req) => (req.headers.get('x-user') === 'ravi' ? { ...nisha, userId: 'ravi' } : nisha), asUser: () => null, instructions: 'Help.', storage, tools,
      models: [scriptedModel([callTool('orders', {}), say('There is one open order.'), say('Croissants are ₹90.'), say('Ravi asked about croissants too.')])],
    })
    await chat(teovo, 'open orders?')
    await chat(teovo, 'price of a croissant')
    await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', headers: { 'x-user': 'ravi' }, body: JSON.stringify({ message: { id: 'r', role: 'user', parts: [{ type: 'text', text: 'croissant price' }] } }) })).then((r) => r.text())
    expect((await list(teovo, 'CROISSANT')).map((t) => t.title)).toEqual(['price of a croissant'])
    expect((await list(teovo, 'one open order')).map((t) => t.title)).toEqual(['open orders?'])   // the assistant's words
    expect(await list(teovo, 'Lakeview')).toEqual([])                                          // only in a tool result
    expect((await list(teovo)).length).toBe(2)
  })
})
