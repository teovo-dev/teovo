import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryFiles } from './files'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const owner: Identity = { tenantId: 'shop', userId: 'owner', role: 'owner' }
const staff: Identity = { tenantId: 'shop', userId: 'staff', role: 'staff' }

function app(model = scriptedModel((_, i) => say(`answer ${i}`))) {
  const storage = memoryStorage()
  const files = memoryFiles()
  let who = owner
  const teovo = createAssistant({
    identify: () => who, asUser: () => null, instructions: 'Help.', storage, models: [model], attachments: {}, files: { store: files },
    tools: [defineTool({ name: 'pay', kind: 'propose', description: 'Pay', input: z.object({ amount: z.number() }), run: ({ amount }) => ({ kind: 'pay', title: `Pay ₹${amount}`, payload: { amount } }) })],
    cards: { pay: { apply: () => ({ undo: 1 }), undo: () => {} } },
  })
  const get = (path: string) => teovo.fetch(new Request(`https://a.test/${path}`))
  const post = (path: string, body: unknown = {}) => teovo.fetch(new Request(`https://a.test/${path}`, { method: 'POST', body: JSON.stringify(body) }))
  return { teovo, storage, files, get, post, as: (i: Identity) => { who = i } }
}

describe('audit trail', () => {
  it('records who proposed, confirmed, undid and skipped each change, newest first, for admins only', async () => {
    const model = scriptedModel([callTool('pay', { amount: 200 }), say('Ready.'), callTool('pay', { amount: 50 }), say('Ready.')])
    const s = app(model)
    const a = (await chat(s.teovo, 'paid 200')).cards[0]!
    await s.post(`cards/${a.id}/confirm`)
    await s.post(`cards/${a.id}/undo`)
    const b = (await chat(s.teovo, 'paid 50')).cards[0]!
    await s.post(`cards/${b.id}/skip`)

    const res = await s.get('audit?limit=10')
    expect(res.status).toBe(200)
    const { events } = (await res.json()) as { events: { title: string; event: string; userId: string }[] }
    expect(events.map((e) => [e.title, e.event]).reverse()).toEqual([
      ['Pay ₹200', 'proposed'], ['Pay ₹200', 'confirmed'], ['Pay ₹200', 'undone'], ['Pay ₹50', 'proposed'], ['Pay ₹50', 'skipped']])
    expect(events.every((e) => e.userId === 'owner')).toBe(true)
    s.as(staff)
    expect((await s.get('audit')).status).toBe(403)
  })
})

describe('miss log', () => {
  it('keeps what the assistant could not answer, with the reason, for admins', async () => {
    const model = scriptedModel([callTool('cannot_help', { question: 'refund order 9 to my card', reason: 'no refund tool' }), say('I can’t issue refunds here.')])
    const s = app(model)
    const r = await chat(s.teovo, 'refund order 9 to my card')
    expect(r.text).toBe('I can’t issue refunds here.')
    const { misses } = (await (await s.get('misses')).json()) as { misses: { question: string; reason: string; threadId: string }[] }
    expect(misses).toEqual([expect.objectContaining({ question: 'refund order 9 to my card', reason: 'no refund tool', threadId: r.threadId })])
  })

  it('can be left out', async () => {
    const model = scriptedModel([say('ok')])
    const storage = memoryStorage()
    const teovo = createAssistant({ identify: () => owner, asUser: () => null, instructions: 'Help.', storage, models: [model], tools: [], misses: false })
    await chat(teovo, 'hi')
    expect((model.doStreamCalls[0]!.tools ?? []).map((t) => t.name)).not.toContain('cannot_help')
  })
})

describe('wipe', () => {
  it('a person deletes their own conversations, pictures and logs; others keep theirs; limits keep counting', async () => {
    const s = app()
    await chat(s.teovo, 'mine')
    await s.teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'p', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }, { type: 'text', text: 'bill' }] } }) })).then((r) => r.text())
    s.as(staff)
    await chat(s.teovo, 'theirs')
    s.as(owner)
    expect(s.files.files.size).toBe(1)
    const usedBefore = (await s.storage.usage('shop', 'owner', 'day')).user.messages

    const res = await s.post('wipe', { scope: 'me' })
    expect(await res.json()).toEqual({ threads: 2, files: 1 })
    expect(await s.storage.listThreads('shop', 'owner', 10)).toEqual([])
    expect([...s.storage.runs.values()].some((r) => r.userId === 'owner')).toBe(false)
    expect(s.files.files.size).toBe(0)
    expect(await s.storage.listThreads('shop', 'staff', 10)).toHaveLength(1)
    expect((await s.storage.usage('shop', 'owner', 'day')).user.messages).toBe(usedBefore)
  })

  it('only an admin can wipe someone else, or the whole team', async () => {
    const s = app()
    s.as(staff)
    await chat(s.teovo, 'theirs')
    expect((await s.post('wipe', { scope: 'user', userId: 'owner' })).status).toBe(403)
    expect((await s.post('wipe', { scope: 'tenant' })).status).toBe(403)
    s.as(owner)
    expect(await (await s.post('wipe', { scope: 'user', userId: 'staff' })).json()).toEqual({ threads: 1, files: 0 })
    await chat(s.teovo, 'mine')
    expect((await s.teovo.wipe('shop')).threads).toBe(1)
    expect((await s.post('wipe', { scope: 'everything' })).status).toBe(400)
  })
})
