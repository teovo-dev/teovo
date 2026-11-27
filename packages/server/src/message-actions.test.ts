import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const u1: Identity = { tenantId: 't', userId: 'u1', role: 'owner' }

function app() {
  const storage = memoryStorage()
  let who = u1
  const model = scriptedModel((_, i) => say(`answer ${i + 1}`))
  const teovo = createAssistant({ identify: () => who, asUser: () => null, instructions: 'Help.', storage, models: [model], tools: [] })
  const send = async (id: string, text: string, threadId?: string) => {
    const res = await teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ threadId, message: { id, role: 'user', parts: [{ type: 'text', text }] } }) }))
    await res.text()
    return { status: res.status, threadId: res.headers.get('x-teovo-thread')! }
  }
  return { teovo, storage, model, send, as: (i: Identity) => { who = i } }
}

describe('sending a message again', () => {
  it('replaces that message and everything after it (edit), and the model sees only what is left', async () => {
    const s = app()
    const { threadId } = await s.send('q1', 'how much today?')
    await s.send('q2', 'and yesterday?', threadId)
    expect((await s.storage.listMessages(threadId)).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    await s.send('q1', 'how much this week?', threadId)          // edited the first question
    const left = await s.storage.listMessages(threadId)
    expect(left.map((m) => [m.role, (m.parts.find((p) => p.type === 'text') as { text: string }).text])).toEqual([['user', 'how much this week?'], ['assistant', 'answer 3']])
    const seen = JSON.stringify(s.model.doStreamCalls.at(-1)!.prompt)
    expect(seen).toContain('how much this week?')
    expect(seen).not.toContain('yesterday')
  })

  it('asks again for the last reply (same message, same words)', async () => {
    const s = app()
    const { threadId } = await s.send('q1', 'who owes?')
    await s.send('q1', 'who owes?', threadId)
    expect((await s.storage.listMessages(threadId)).map((m) => (m.parts.find((p) => p.type === 'text') as { text: string }).text)).toEqual(['who owes?', 'answer 2'])
  })

  it("won't take a reply's id as a new message", async () => {
    const s = app()
    const { threadId } = await s.send('q1', 'hi')
    const reply = (await s.storage.listMessages(threadId))[1]!
    expect((await s.send(reply.id, 'sneaky', threadId)).status).toBe(400)
  })
})

describe('rating a reply', () => {
  it('saves thumbs up or down on the run, lets the person take it back, and refuses anyone else', async () => {
    const s = app()
    await chat(s.teovo, 'hi')
    const runId = [...s.storage.runs.keys()][0]!
    const rate = (value: unknown) => s.teovo.fetch(new Request(`https://a.test/runs/${runId}/rating`, { method: 'POST', body: JSON.stringify({ value, note: ' too long ' }) }))
    expect((await rate('down')).status).toBe(200)
    expect(s.storage.runs.get(runId)).toMatchObject({ rating: -1, ratingNote: 'too long' })
    expect((await rate(null)).status).toBe(200)
    expect(s.storage.runs.get(runId)!.rating).toBeNull()
    expect((await rate('meh')).status).toBe(400)
    s.as({ ...u1, userId: 'u2' })
    expect((await rate('up')).status).toBe(404)
  })
})

describe('a model that goes quiet after a tool', () => {
  it('is asked once more, with tools off, so the user always gets an answer in words', async () => {
    const storage = memoryStorage()
    const model = scriptedModel([callTool('get_dues', {}), say(''), say('Riya K owes ₹250.')])
    const teovo = createAssistant({
      identify: () => u1, asUser: () => null, instructions: 'Help.', storage, models: [model],
      tools: [defineTool({ name: 'get_dues', kind: 'read', description: 'Dues', input: z.object({}), run: () => [{ customer: 'Riya K', due: 250 }] })],
    })
    const r = await chat(teovo, 'how much does Riya K owe?')
    expect(r.text).toBe('Riya K owes ₹250.')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(model.doStreamCalls[2]!.toolChoice).toEqual({ type: 'none' })
    const saved = (await storage.listMessages(r.threadId!)).at(-1)!
    expect(JSON.stringify(saved.parts)).toContain('Riya K owes ₹250.')
  })
})
