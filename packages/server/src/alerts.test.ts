import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { alertWatch, postAlert, type Alert } from './alerts'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { chat, say, scriptedModel } from './testing'
import type { Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('alerts: one message when trouble starts, one when it is over', () => {
  it('waits for enough replies, alerts once, and says when it is over', async () => {
    const sent: Alert[] = []
    let t = 0
    const w = alertWatch({ send: (a) => { sent.push(a) }, minReplies: 4 }, 'Little Oven', () => t)
    const ok = { failed: false, fellBack: false }
    const back = { failed: false, fellBack: true, model: 'gemini-2.5-flash', error: '503 The model is overloaded' }
    w.record(back); w.record(back); w.record(ok)
    await settle()
    expect(sent).toEqual([])   // 2 of 3, but under 4 replies
    w.record(back)             // 3 of 4
    w.record(back); w.record(back)
    await settle()
    expect(sent).toEqual([{ kind: 'backup', state: 'started', replies: 4, count: 3, model: 'gemini-2.5-flash', error: '503 The model is overloaded', text: 'Little Oven: 3 of 4 replies in the last 15 min fell back to the backup model (gemini-2.5-flash failed: 503 The model is overloaded).' }])
    // Twenty minutes later, the old ones are out of the window: the next good reply ends it.
    t += 20 * 60_000
    w.record(ok)
    await settle()
    expect(sent[1]).toMatchObject({ kind: 'backup', state: 'over', text: 'Little Oven: back on the main model; 0 of 1 replies in the last 15 min used the backup.' })
    expect(sent).toHaveLength(2)
  })

  it('counts failures apart, and a broken send is reported, not thrown', async () => {
    const errors: unknown[] = []
    const sent: Alert[] = []
    const w = alertWatch({ send: (a) => { sent.push(a); throw new Error('channel down') }, minReplies: 2, errors: 0.5 }, 'Teovo', Date.now, (e) => errors.push(e))
    w.record({ failed: true, fellBack: false, model: 'm1', error: 'quota' })
    w.record({ failed: false, fellBack: false })
    await settle()
    expect(sent.map((a) => [a.kind, a.state, a.text])).toEqual([['errors', 'started', 'Teovo: 1 of 2 replies in the last 15 min failed (m1 failed: quota).']])
    expect(errors).toEqual([new Error('channel down')])
  })

  it('postAlert posts the sentence as JSON', async () => {
    const calls: [string, RequestInit][] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response('ok') }) as typeof fetch
    try {
      const a: Alert = { kind: 'errors', state: 'started', text: 'Teovo: 2 of 5 replies failed.', replies: 5, count: 2 }
      await postAlert('https://hooks.example/x')(a)
      await postAlert('https://discord.example/x', { body: (x) => ({ content: x.text }) })(a)
      expect(JSON.parse(calls[0]![1].body as string)).toEqual({ text: 'Teovo: 2 of 5 replies failed.', alert: a })
      expect(JSON.parse(calls[1]![1].body as string)).toEqual({ content: 'Teovo: 2 of 5 replies failed.' })
    } finally { globalThis.fetch = real }
  })

  it('in replies: a failing first model sets it off, with the model and its error', async () => {
    const sent: Alert[] = []
    const down = new MockLanguageModelV4({ modelId: 'main-model', doStream: async () => { throw new Error('503 overloaded') } })
    const teovo = createAssistant({
      identify: () => nisha, asUser: () => null, instructions: 'Help.', storage: memoryStorage(), tools: [], name: 'Little Oven',
      models: [down, scriptedModel([say('One.'), say('Two.')])], alerts: { send: (a) => { sent.push(a) }, minReplies: 2 },
    })
    expect((await chat(teovo, 'hi')).text).toBe('One.')
    expect((await chat(teovo, 'hi again')).text).toBe('Two.')
    await settle()
    expect(sent).toMatchObject([{ kind: 'backup', state: 'started', count: 2, replies: 2, model: 'main-model', error: '503 overloaded' }])
  })
})
