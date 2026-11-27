import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const say = (text: string) => ({ stream: new ReadableStream({ start(c) {
  for (const p of [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]) c.enqueue(p as LanguageModelV4StreamPart)
  c.close()
} }) })

const owner: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const staff: Identity = { tenantId: 'shop-1', userId: 'u2', role: 'staff' }
const read = (name: string) => defineTool({ name, kind: 'read', description: name, input: z.object({}), run: () => 1 })

function setup() {
  const storage = memoryStorage()
  const model = new MockLanguageModelV4({ doStream: async () => say('ok') })
  let who = owner
  const teovo = createAssistant({ identify: () => who, asUser: () => null, tools: [read('get_sales'), read('get_expenses')], models: [model], instructions: 'Help.', storage, suggestions: () => ({ suggestions: ['Hi'] }) })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await teovo.fetch(new Request(`https://a.test/api/assistant/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: res.status, body: await res.text() }
  }
  const chat = () => call('POST', 'chat', { message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] } satisfies UIMessage })
  return { storage, model, call, chat, as: (i: Identity) => { who = i } }
}

describe('tenant settings', () => {
  it('lets an admin read and save them, with the tools listed for the switches', async () => {
    const s = setup()
    const before = JSON.parse((await s.call('GET', 'settings')).body)
    expect(before.settings).toEqual({ enabled: true })
    expect(before.tools.map((t: { name: string }) => t.name)).toEqual(['get_sales', 'get_expenses'])
    const saved = await s.call('PUT', 'settings', { instructions: '  We close on Sundays.  ', glossary: { khata: 'credit account', ' ': 'x' }, toolsOff: ['get_expenses'] })
    expect(JSON.parse(saved.body).settings).toEqual({ enabled: true, instructions: 'We close on Sundays.', glossary: { khata: 'credit account' }, toolsOff: ['get_expenses'] })
    expect(await s.storage.tenantSettings('shop-1')).toEqual(JSON.parse(saved.body).settings)
  })

  it('refuses other roles and bad values with a sentence', async () => {
    const s = setup()
    expect(await s.call('PUT', 'settings', { toolsOff: ['delete_everything'] })).toEqual({ status: 400, body: JSON.stringify({ error: 'Unknown tool: delete_everything.' }) })
    expect(JSON.parse((await s.call('PUT', 'settings', { instructions: 'x'.repeat(2001) })).body).error).toBe('Instructions can be at most 2000 characters.')
    s.as(staff)
    expect((await s.call('GET', 'settings')).status).toBe(403)
    expect((await s.call('PUT', 'settings', { enabled: false })).status).toBe(403)
    expect(await s.storage.tenantSettings('shop-1')).toBeNull()
  })

  it("adds the business's notes and words to the prompt and switches its tools off", async () => {
    const s = setup()
    await s.call('PUT', 'settings', { instructions: 'We close on Sundays.', glossary: { khata: 'credit account' }, toolsOff: ['get_expenses'] })
    await s.chat()
    const call = s.model.doStreamCalls.at(-1)!
    const system = JSON.stringify(call.prompt[0])
    expect(system).toContain('Notes from this business (follow them unless they conflict with anything above):\\nWe close on Sundays.')
    expect(system).toContain('Words this business uses:\\n- khata: credit account')
    expect(system.indexOf('We close on Sundays')).toBeLessThan(system.indexOf('Text between <untrusted'))
    expect((call.tools ?? []).map((t) => t.name)).toEqual(['get_sales'])
  })

  it('turns the assistant off for the whole tenant, chips included', async () => {
    const s = setup()
    await s.call('PUT', 'settings', { enabled: false })
    s.as(staff)
    expect(await s.chat()).toEqual({ status: 403, body: JSON.stringify({ error: 'The assistant is turned off for your team. An admin can turn it on in settings.' }) })
    expect(JSON.parse((await s.call('GET', 'suggestions')).body)).toEqual({ suggestions: [] })
    expect(s.storage.threads.size).toBe(0)
    s.as({ ...owner, tenantId: 'shop-2' })
    expect((await s.chat()).status).toBe(200)
  })
})
