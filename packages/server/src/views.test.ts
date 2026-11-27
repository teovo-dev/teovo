import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import type { Identity } from './tools'
import { builtinViews } from './views'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const s = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const fin = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage })
const show = (view: string, data: unknown) => s([{ type: 'tool-call', toolCallId: `v-${view}`, toolName: `show_${view}`, input: JSON.stringify(data) }, fin('tool-calls')])
const say = (t: string) => s([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' }, fin('stop')])
const u1: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }

const expenseForm = {
  title: 'New expense',
  fields: [
    { name: 'amount', label: 'Amount', type: 'number', value: 450, required: true },
    { name: 'vendor', label: 'Vendor', type: 'text', value: 'Milk depot' },
    { name: 'date', label: 'Date', type: 'date', value: '2026-11-27' },
    { name: 'method', label: 'Paid by', type: 'select', options: ['Cash', 'UPI'], value: 'UPI' },
  ],
  submit: { kind: 'expense', label: 'Prepare' },
}

function setup(steps: ReturnType<typeof say>[], extra: Partial<AssistantConfig<null>> = {}) {
  const storage = memoryStorage()
  let who = u1
  const model = new MockLanguageModelV4({ doStream: steps as never })
  const teovo = createAssistant<null>({
    identify: () => who, asUser: () => null, models: [model], instructions: 'Help.', storage, tools: [], views: builtinViews,
    forms: { expense: (v) => { if (Number(v.amount) > 100000) throw new Error('That is more than any expense so far. Check the amount.'); return { kind: 'add_expense', title: `Expense ₹${v.amount} to ${v.vendor}`, after: v, payload: v } } },
    cards: { add_expense: { apply: () => {} } },
    ...extra,
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await teovo.fetch(new Request(`https://a.test/api/assistant/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const text = await res.text()
    return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text, thread: res.headers.get('x-teovo-thread') }
  }
  const chat = (text: string, threadId?: string) => call('POST', 'chat', { threadId, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } satisfies UIMessage })
  const reply = async (thread: string) => (await storage.listMessages(thread)).at(-1)!
  return { storage, model, call, chat, reply, as: (i: Identity) => { who = i } }
}

describe('views', () => {
  it('shows a checked view, keeps it in the reply, and tells the model about it next turn', async () => {
    const t = setup([show('table', { title: 'Unpaid orders', columns: [{ key: 'no', label: 'Order' }, { key: 'due', label: 'Due' }], rows: [{ no: 142, due: 880 }] }), say('Here they are.'), say('Yes.')])
    const { thread } = await t.chat('unpaid orders?')
    const view = (await t.reply(thread!)).parts.find((p) => p.type === 'data-view') as { data: { view: string; data: { rows: unknown[] } } }
    expect(view.data).toMatchObject({ view: 'table', data: { rows: [{ no: 142, due: 880 }] } })
    expect(JSON.stringify(t.model.doStreamCalls[1]!.prompt)).toContain("Don't repeat its contents in your reply.")
    await t.chat('is that all?', thread!)
    expect(JSON.stringify(t.model.doStreamCalls[2]!.prompt)).toContain('[Shown to the user: table \\"Unpaid orders\\"]')
  })

  it('refuses data that does not fit the view, and forms the app cannot take', async () => {
    const t = setup([show('choices', { question: 'Which Riya?', options: [{ label: 'Riya Sharma' }] }), show('form', { ...expenseForm, submit: { kind: 'refund' } }), say('Sorry.')])
    const { thread } = await t.chat('pay Riya')
    expect((await t.reply(thread!)).parts.some((p) => p.type === 'data-view')).toBe(false)
    const second = JSON.stringify(t.model.doStreamCalls[1]!.prompt)
    expect(second).toMatch(/Invalid input|too_small|at least 2/i)
    expect(JSON.stringify(t.model.doStreamCalls[2]!.prompt)).toContain('There is no form for \\"refund\\". Use one of: expense.')
  })

  it('offers no show tools when the app has no views', async () => {
    const t = setup([say('ok')], { views: undefined })
    await t.chat('hi')
    expect((t.model.doStreamCalls[0]!.tools ?? []).map((x) => x.name)).toEqual([])
  })
})

describe('forms with declared fields', () => {
  it('tells the model the views rule and the form fields, and refuses a form missing one', async () => {
    const bad = { ...expenseForm, fields: expenseForm.fields.filter((f) => f.name !== 'vendor') }
    const t = setup([show('form', bad), show('form', expenseForm), say('Check it.')], {
      forms: { expense: { fields: ['amount', 'vendor'], description: 'a new expense', handle: (v) => ({ kind: 'add_expense', title: `Expense ₹${v.amount} to ${v.vendor}`, payload: v }) } },
    })
    const { thread } = await t.chat('spent 450 on milk')
    const system = (t.model.doStreamCalls[0]!.prompt[0] as { content: string }).content
    expect(system).toContain('do not repeat its contents in your text')
    expect(system).toContain('Forms you can show with show_form (submit.kind, then the field names to use):\n- expense: fields amount, vendor (a new expense)')
    expect(JSON.stringify(t.model.doStreamCalls[1]!.prompt)).toContain('This form must have fields named exactly: amount, vendor. Missing: vendor.')
    const views = (await t.reply(thread!)).parts.filter((p) => p.type === 'data-view')
    expect(views).toHaveLength(1)
    const ok = await t.call('POST', `threads/${thread}/views/v-form/submit`, { values: { amount: 450, vendor: 'Milk depot' } })
    expect(ok.body.card.title).toBe('Expense ₹450 to Milk depot')
  })
})

describe('form submit', () => {
  it('turns a submitted form into a card under it, once, which is then confirmed like any other', async () => {
    const t = setup([show('form', expenseForm), say('Check the details.')])
    const { thread } = await t.chat('spent 450 on milk')
    const viewId = 'v-form'
    expect((await t.call('POST', `threads/${thread}/views/${viewId}/submit`, { values: { amount: '', vendor: 'x' } })).body).toEqual({ error: 'Amount is required.' })
    expect((await t.call('POST', `threads/${thread}/views/${viewId}/submit`, { values: { amount: 450, method: 'Card' } })).body).toEqual({ error: 'Pick one of the options for Paid by.' })
    expect((await t.call('POST', `threads/${thread}/views/${viewId}/submit`, { values: { amount: 900000 } })).status).toBe(422)

    const ok = await t.call('POST', `threads/${thread}/views/${viewId}/submit`, { values: { amount: '1,450', vendor: 'Milk depot', date: '2026-11-27', method: 'Cash' } })
    expect(ok.status).toBe(200)
    expect(ok.body.card).toMatchObject({ title: 'Expense ₹1450 to Milk depot', status: 'shown', payload: { amount: 1450, method: 'Cash' } })
    expect((await t.call('POST', `threads/${thread}/views/${viewId}/submit`, { values: { amount: 1 } })).status).toBe(409)

    const parts = (await t.reply(thread!)).parts
    expect(parts.map((p) => p.type)).toEqual(expect.arrayContaining(['data-view', 'data-card']))
    expect(parts.findIndex((p) => p.type === 'data-card')).toBe(parts.findIndex((p) => p.type === 'data-view') + 1)
    expect((parts.find((p) => p.type === 'data-view') as { data: { submitted: string } }).data.submitted).toBe(ok.body.card.id)

    expect((await t.call('POST', `cards/${ok.body.card.id}/confirm`)).body.card.status).toBe('confirmed')
  })

  it("won't take another person's form or a view that isn't a form", async () => {
    const t = setup([show('form', expenseForm), show('record', { title: 'Order #142', fields: [{ label: 'Total', value: 880 }] }), say('ok')])
    const { thread } = await t.chat('x')
    expect((await t.call('POST', `threads/${thread}/views/v-record/submit`, { values: {} })).status).toBe(404)
    t.as({ ...u1, userId: 'u2' })
    expect((await t.call('POST', `threads/${thread}/views/v-form/submit`, { values: { amount: 1 } })).status).toBe(404)
  })
})
