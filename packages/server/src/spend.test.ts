import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, NO_SPEND, type SpendRules } from './assistant'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel, type Step } from './testing'
import { defineTool, type Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'staff' }

/** A wallet like scobly's credits: holds per reply, charged or given back at the end. */
function wallet(balance: number) {
  const w = { balance, holds: new Map<string, number>(), log: [] as string[] }
  const rules: Omit<SpendRules, 'hold'> = {
    reserve: ({ runId, amount, first, reason }) => {
      if (first && w.holds.has(runId)) return true   // a retried request never holds twice
      if (amount > w.balance) return first ? 'Not enough credits: 1 needed.' : false
      w.balance -= amount
      w.holds.set(runId, (w.holds.get(runId) ?? 0) + amount)
      w.log.push(`hold ${amount}${reason ? ` (${reason})` : ''}`)
      return true
    },
    settle: ({ runId, status, cost }) => {
      const h = w.holds.get(runId) ?? 0
      const charge = status === 'done' ? Math.min(h, cost ?? h) : 0
      w.balance += h - charge
      w.holds.delete(runId)
      w.log.push(`settle ${status}: charged ${charge}, back ${h - charge}`)
    },
  }
  return { w, rules }
}

function app(steps: Step[], spend: SpendRules, tools = [] as ReturnType<typeof defineTool>[]) {
  const storage = memoryStorage()
  const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools, models: [scriptedModel(steps)], spend })
  return { teovo, storage }
}

describe('spend: a hold before each reply, settled after', () => {
  it('holds the price, then charges a finished reply', async () => {
    const { w, rules } = wallet(10)
    const { teovo } = app([say('Hi.')], { ...rules, hold: 2 })
    expect((await chat(teovo, 'hi')).text).toBe('Hi.')
    expect(w.log).toEqual(['hold 2', 'settle done: charged 2, back 0'])
    expect(w.balance).toBe(8)
  })

  it('refuses before anything is saved when there is not enough, with the app\'s sentence', async () => {
    const { w, rules } = wallet(1)
    const { teovo, storage } = app([], { ...rules, hold: 2 })
    const out = await chat(teovo, 'hi')
    expect(out.status).toBe(402)
    expect(out.error).toBe('Not enough credits: 1 needed.')
    expect([...storage.threads.values()].filter((t) => !(t as { archived?: boolean }).archived)).toHaveLength(0)
    expect(w.balance).toBe(1)
  })

  it('a tool raises the hold before costly work (a report), and the reply is charged for it', async () => {
    const { w, rules } = wallet(10)
    const report = defineTool({
      name: 'make_report', kind: 'read', description: 'A report', input: z.object({}),
      run: async (_i, ctx) => ((await ctx.reserve!(5, 'report')) ? { pages: 3 } : 'Not enough credits for a report; answer without one.'),
    })
    const { teovo } = app([callTool('make_report', {}), say('Here is your report.')], { ...rules, hold: 2 }, [report])
    expect((await chat(teovo, 'report please')).text).toBe('Here is your report.')
    expect(w.log).toEqual(['hold 2', 'hold 5 (report)', 'settle done: charged 7, back 0'])
  })

  it('a tool that is refused gets false and goes on without the costly part', async () => {
    const { w, rules } = wallet(3)
    let got: unknown
    const report = defineTool({ name: 'make_report', kind: 'read', description: 'A report', input: z.object({}), run: async (_i, ctx) => { got = await ctx.reserve!(5); return 'No report' } })
    const { teovo } = app([callTool('make_report', {}), say('No report today.')], { ...rules, hold: 2 }, [report])
    expect((await chat(teovo, 'report please')).text).toBe('No report today.')
    expect(got).toBe(false)
    expect(w.balance).toBe(1)
  })

  it('with cost, raises the hold as the reply uses more, and ends it with a sentence when that is refused', async () => {
    const { w, rules } = wallet(3)
    // Each lookup costs 1.
    let looks = 0
    const lookup = defineTool({ name: 'look', kind: 'read', description: 'Look', input: z.object({}), run: () => { looks++; return { ok: true } } })
    const { teovo, storage } = app([callTool('look', {}), callTool('look', {}), callTool('look', {}), callTool('look', {}), say('never')], {
      ...rules, hold: 1, step: 1, cost: () => looks,
    }, [lookup])
    const out = await chat(teovo, 'dig deep')
    expect(out.text).toBe(NO_SPEND)
    expect(out.tools).toEqual(['look', 'look', 'look', 'look'])   // the step that ran out is finished, and nothing after it
    expect(w.log).toEqual(['hold 1', 'hold 1 (cost)', 'hold 1 (cost)', 'settle stopped: charged 0, back 3'])
    expect([...storage.runs.values()][0]).toMatchObject({ status: 'stopped' })
    expect(w.balance).toBe(3)
  })

  it('a failed reply is settled as failed, so the app can give the hold back', async () => {
    const { w, rules } = wallet(5)
    const { teovo } = app([], { ...rules, hold: 2 })   // no scripted step: the model fails
    await chat(teovo, 'hi')
    expect(w.log).toEqual(['hold 2', 'settle failed: charged 0, back 2'])
    expect(w.balance).toBe(5)
  })

  it('a reserve that throws counts as a refusal', async () => {
    const { teovo } = app([], { hold: 1, reserve: () => { throw new Error('wallet down') }, settle: () => {} })
    const out = await chat(teovo, 'hi')
    expect(out.status).toBe(402)
    expect(out.error).toBe(NO_SPEND)
  })
})

describe('spend with long runs', () => {
  it('a reply taken over by another server is not held again, and is settled once', async () => {
    const { w, rules } = wallet(10)
    const storage = memoryStorage()
    let open!: () => void
    const stuck = new Promise<void>((r) => { open = r })
    const tools = [
      defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => [{ no: 4 }] }),
      defineTool({ name: 'add_up', kind: 'read', description: 'Adds up', input: z.object({}), run: async () => { await stuck; return {} } }),
    ]
    const make = (steps: Step[], runs: object) => createAssistant({
      identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools, models: [scriptedModel(steps)],
      spend: { ...rules, hold: 2 }, runs: { pollMs: 5, flushMs: 5, asUser: () => null, ...runs },
    })
    const a = make([callTool('list_orders', {}), callTool('add_up', {}), say('late')], { heartbeatMs: 60_000, leaseMs: 30 })
    const b = make([say('Order 4.')], {})
    const res = await a.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'orders?' }] } }) }))
    for (let i = 0; i < 300 && !(await storage.queue.waiting(5)).length; i++) await new Promise((r) => setTimeout(r, 5))
    expect(await b.work()).toBe(1)
    open()
    await res.body!.cancel()
    await new Promise((r) => setTimeout(r, 30))
    expect(w.log).toEqual(['hold 2', 'settle done: charged 2, back 0'])
    expect(w.balance).toBe(8)
  })

  it('a queued reply stopped before it starts is settled as stopped', async () => {
    const { w, rules } = wallet(10)
    const storage = memoryStorage()
    const api = createAssistant({
      identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools: [], models: [scriptedModel([])],
      spend: { ...rules, hold: 2 }, runs: { inline: false, pollMs: 5, asUser: () => null },
    })
    const res = await api.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } }) }))
    const threadId = res.headers.get('x-teovo-thread')!
    for (let i = 0; i < 100 && ![...storage.runs.values()][0]?.job; i++) await new Promise((r) => setTimeout(r, 5))
    const id = [...storage.runs.values()][0]!.id
    // Stopped while queued: the run ends at once, and a worker that looks later settles nothing twice.
    expect((await api.fetch(new Request(`https://a.test/threads/${threadId}/stop`, { method: 'POST' }))).status).toBe(200)
    await res.body!.cancel()
    expect(storage.runs.get(id)!.status).toBe('stopped')
    expect(w.log).toEqual(['hold 2', 'settle stopped: charged 0, back 2'])
    expect(w.balance).toBe(10)
  })
})
