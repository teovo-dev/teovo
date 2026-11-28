import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { defineReader } from './readers'
import type { Storage } from './storage'
import {
  callTool, idNames, loadRecordings, readerInputOf, recordChat, recordRead, replayChat, replayRead, saveRecording, say, scriptedModel,
  toolCalls, toolErrors, type ChatRecording, type ReaderRecording,
} from './testing'
import { defineTool, type Identity } from './tools'

const owner: Identity = { tenantId: 'shop', userId: 'u1', role: 'owner' }

/** A shop whose order id is new every time it is built, like a freshly seeded test database. */
function shop() {
  const orderId = crypto.randomUUID()
  const make = (model: LanguageModelV4, storage: Storage) => createAssistant<{ shop: string }>({
    identify: () => owner, asUser: () => ({ shop: 'Little Oven' }), instructions: 'Help.', storage, models: [model],
    tools: [
      defineTool({ name: 'find_order', kind: 'read', description: 'Find', input: z.object({ no: z.number() }),
        run: ({ no }) => { if (no !== 142) throw new Error(`No order ${no}`); return { id: orderId, no, due: 880 } } }),
      defineTool({ name: 'record_payment', kind: 'propose', description: 'Pay', input: z.object({ orderId: z.string(), amount: z.number() }),
        run: ({ orderId: id, amount }) => {
          if (id !== orderId) throw new Error(`No order ${id}`)
          return { kind: 'record_payment', title: `Payment ₹${amount} for order #142`, payload: { orderId: id, amount } }
        } }),
      defineTool({ name: 'open_order', kind: 'action', description: 'Open', input: z.object({}), run: () => ({ label: 'Open order', action: 'navigate', args: { to: `/orders/${orderId}` } }) }),
    ],
    readers: [defineReader({
      name: 'bill', accepts: ['image'], schema: z.object({ amount: z.number() }), instructions: 'Read the bill.',
      after: (r) => ({ ...r, order: orderId }),
    })],
  })
  return { make, orderId, names: idNames([[orderId, 'order#142']]) }
}

/** A "real" model: looks up order 99 (no such order), then 142, then proposes the payment with the id it was given. */
const realModel = () => scriptedModel((prompt, i) => {
  const id = /"id":"([0-9a-f-]{36})"/.exec(JSON.stringify(prompt))?.[1] ?? ''
  return [callTool('find_order', { no: 99 }), callTool('find_order', { no: 142 }), callTool('record_payment', { orderId: id, amount: 200 }, ['open_order', {}]), say('Ready to record ₹200.')][i]!
}, { modelId: 'gemini-real' })

describe('recordings', () => {
  it('records a chat with ids saved as names, saves it, and replays it on a freshly built shop', async () => {
    const first = shop()
    const rec = await recordChat({ name: 'payment', assistant: first.make, model: realModel(), message: 'Riya paid 200 for order 142', page: { path: '/orders/@@order#142@@' }, names: first.names })
    expect(rec.expect).toEqual({
      reply: 'Ready to record ₹200.',
      cards: [{ kind: 'record_payment', title: 'Payment ₹200 for order #142' }],
      actions: [{ label: 'Open order', action: 'navigate', args: { to: '/orders/@@order#142@@' } }],
      calls: [{ name: 'find_order', args: { no: 99 } }, { name: 'find_order', args: { no: 142 } }, { name: 'record_payment', args: { orderId: '@@order#142@@', amount: 200 } }, { name: 'open_order', args: {} }],
      toolErrors: ['Error: No order 99'],
    })
    expect(rec.page).toEqual({ path: '/orders/@@order#142@@' })
    expect(JSON.stringify(rec)).not.toContain(first.orderId)

    const dir = mkdtempSync(join(tmpdir(), 'teovo-rec-'))
    expect(saveRecording(dir, rec)).toBe(join(dir, 'payment.json'))
    const [loaded] = loadRecordings(dir) as ChatRecording[]
    expect(loaded).toEqual(rec)

    const fresh = shop()   // new ids
    const run = await replayChat({ assistant: fresh.make, recording: loaded!, names: fresh.names })
    expect(run.got).toEqual(rec.expect)
    expect(run.modelSteps).toBe(run.recordedSteps)
  })

  it('replays earlier turns as the thread history', async () => {
    const s = shop()
    const rec: ChatRecording = {
      name: 'follow-up', kind: 'chat', history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'Thanks' }],
      steps: [say('You are welcome.')], expect: { reply: 'You are welcome.', cards: [], actions: [], calls: [], toolErrors: [] },
    }
    await expect(replayChat({ assistant: s.make, recording: rec })).rejects.toThrow('needs `identity`')
    let prompt = ''
    const watch = (model: LanguageModelV4, storage: Storage) => s.make({ ...model, doStream: (o) => { prompt = JSON.stringify(o.prompt); return model.doStream(o) } }, storage)
    const run = await replayChat({ assistant: watch, recording: rec, identity: owner })
    expect(run.got).toEqual(rec.expect)
    expect(prompt).toContain('Hello!')
  })

  it('records and replays a reader call with a picture from the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teovo-rec-'))
    writeFileSync(join(dir, 'bill.png'), Buffer.from('not really a png'))
    const first = shop()
    const context = { identity: owner, db: { shop: 'Little Oven' } }
    const rec = await recordRead({ name: 'bill', assistant: first.make, model: scriptedModel([say('{"amount": 450}')]), reader: 'bill', input: { image: { file: 'bill.png', mediaType: 'image/png' } }, dir, context, names: first.names })
    expect(rec).toMatchObject({ kind: 'reader', reader: 'bill', input: { image: { file: 'bill.png' } }, expect: { result: { amount: 450, order: '@@order#142@@' } } })
    expect(readerInputOf(rec, dir).image).toEqual({ data: Buffer.from('not really a png').toString('base64'), mediaType: 'image/png' })

    const fresh = shop()
    const run = await replayRead({ assistant: fresh.make, recording: JSON.parse(JSON.stringify(rec)) as ReaderRecording, dir, context, names: fresh.names })
    expect(run).toEqual({ got: rec.expect.result, modelSteps: 1, recordedSteps: 1 })
  })

  it('reads tool calls and tool errors on their own', () => {
    expect(toolCalls([callTool('a', { x: 1 }, ['b', {}]), say('done')])).toEqual([{ name: 'a', args: { x: 1 } }, { name: 'b', args: {} }])
    expect(toolErrors([{ role: 'tool', content: [{ type: 'tool-result', output: { type: 'error-text', value: 'Nope' } }, { type: 'tool-result', output: { type: 'json', value: 1 } }] }])).toEqual(['Nope'])
    expect(toolErrors(undefined)).toEqual([])
    expect(() => saveRecording(mkdtempSync(join(tmpdir(), 'teovo-rec-')), { name: 'Bad Name', kind: 'reader', reader: 'x', input: {}, steps: [], expect: { result: null } })).toThrow('lowercase')
  })
})
