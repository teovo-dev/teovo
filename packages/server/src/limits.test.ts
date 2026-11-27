import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import { defineTool, type Identity } from './tools'

const usage = { inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 30, text: 30, reasoning: undefined } }
const streamOf = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p as LanguageModelV4StreamPart); c.close() } }) })
const say = (text: string) => streamOf([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }])
const call = (toolName: string, input: unknown) => streamOf([{ type: 'tool-call', toolCallId: `c-${toolName}-${Math.random()}`, toolName, input: JSON.stringify(input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }])
const always = (id = 'm') => new MockLanguageModelV4({ modelId: id, doStream: async () => say('ok') })

const u1: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const u2: Identity = { tenantId: 'shop-1', userId: 'u2', role: 'staff' }
const other: Identity = { tenantId: 'shop-2', userId: 'u9', role: 'owner' }

let gate: Promise<void> | undefined
const tools = [
  defineTool({ name: 'big', kind: 'read', description: 'Big result', input: z.object({}), run: () => ({ rows: 'x'.repeat(500) }) }),
  defineTool({ name: 'broken', kind: 'read', description: 'Fails', input: z.object({}), run: () => { throw new Error('table missing') } }),
  defineTool({ name: 'slow', kind: 'read', description: 'Waits', input: z.object({}), run: async () => { await gate; return 1 } }),
]

function setup(models: LanguageModelV4[], extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  let who = u1
  const teovo = createAssistant({ identify: () => who, asUser: () => null, tools, models, instructions: 'Help.', storage, ...extra })
  const send = async (as: Identity, text = 'hi') => {
    who = as
    const res = await teovo.fetch(new Request('https://app.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } satisfies UIMessage }) }))
    const body = await res.text()
    return { status: res.status, body }
  }
  return { storage, send }
}

describe('limits', () => {
  it('stops one person at their daily message limit and leaves others alone', async () => {
    const { storage, send } = setup([always()], { limits: { user: { messages: 2 } } })
    expect((await send(u1)).status).toBe(200)
    expect((await send(u1)).status).toBe(200)
    const third = await send(u1)
    expect(third.status).toBe(429)
    expect(JSON.parse(third.body).error).toBe('You have reached your assistant limit for this day. It resets tomorrow.')
    expect(storage.threads.size).toBe(2)   // the refused message left nothing behind
    expect((await send(u2)).status).toBe(200)
  })

  it('counts a whole tenant together, and only that tenant', async () => {
    const { send } = setup([always()], { limits: { tenant: { messages: 2 } } })
    await send(u1); await send(u2)
    const r = await send(u1)
    expect(r.status).toBe(429)
    expect(JSON.parse(r.body).error).toMatch(/^Your team has reached/)
    expect((await send(other)).status).toBe(200)
  })

  it('stops on tokens too, counted from what the model reported', async () => {
    const { send } = setup([always()], { limits: { user: { output_tokens: 50 } } })
    expect((await send(u1)).status).toBe(200)   // 30 tokens
    expect((await send(u1)).status).toBe(200)   // 60 tokens
    expect((await send(u1)).status).toBe(429)
  })

  it("lets a tenant's own budget override the code, for one person or for a month", async () => {
    const { storage, send } = setup([always()], { limits: { user: { messages: 1 } } })
    storage.budgetRows.push({ tenantId: 'shop-1', userId: 'u1', unit: 'messages', period: 'day', limit: 3 })
    for (let i = 0; i < 3; i++) expect((await send(u1)).status).toBe(200)
    expect((await send(u1)).status).toBe(429)
    expect((await send(u2)).status).toBe(200)
    expect((await send(u2)).status).toBe(429)   // u2 still has the code's limit of 1

    storage.budgetRows.push({ tenantId: 'shop-2', userId: 'u9', unit: 'messages', period: 'day', limit: 5 })
    storage.budgetRows.push({ tenantId: 'shop-2', userId: '', unit: 'messages', period: 'month', limit: 1 })
    expect((await send(other)).status).toBe(200)
    const r = await send(other)
    expect(r.status).toBe(429)
    expect(JSON.parse(r.body).error).toBe('Your team has reached its assistant limit for this month. It resets next month.')
  })

  it('allows only so many replies at once per person', async () => {
    let open!: () => void
    gate = new Promise((r) => { open = r })
    const m = new MockLanguageModelV4({ doStream: async ({ prompt }) => {
      const p = JSON.stringify(prompt)
      return p.includes('wait') && !p.includes('tool-result') ? call('slow', {}) : say('done')
    } })
    const { send } = setup([m], { limits: { maxRunning: 1 } })
    const first = send(u1, 'wait')
    await new Promise((r) => setTimeout(r, 20))
    const second = await send(u1)
    expect(second.status).toBe(429)
    expect(JSON.parse(second.body).error).toMatch(/still answering your last message/)
    expect((await send(u2)).status).toBe(200)
    open()
    expect((await first).status).toBe(200)
    expect((await send(u1)).status).toBe(200)
    gate = undefined
  })
})

describe('run log and usage', () => {
  it('records the run, each tool step (cut when long, errors kept) and the tokens', async () => {
    const m = new MockLanguageModelV4({ modelId: 'gemini-test', doStream: [call('big', {}), call('broken', {}), say('Sorry, one lookup failed.')] as never })
    const { storage, send } = setup([m], { logLimit: 100, promptVersion: 'v3' })
    await send(u1)
    const [run] = [...storage.runs.values()]
    expect(run).toMatchObject({ status: 'done', model: 'gemini-test', promptVersion: 'v3', tenantId: 'shop-1', userId: 'u1' })
    expect(storage.steps.map((s) => [s.seq, s.name, s.truncated, s.error])).toEqual([[0, 'big', true, undefined], [1, 'broken', false, 'table missing']])
    expect(String(storage.steps[0]!.output).length).toBe(100)
    const units = storage.usageRows.map((r) => [r.unit, r.amount, r.model])
    expect(units).toEqual([['messages', 1, 'gemini-test'], ['input_tokens', 360, 'gemini-test'], ['output_tokens', 90, 'gemini-test']])
  })

  it('puts the tokens on the backup model when the first one failed', async () => {
    const down = new MockLanguageModelV4({ modelId: 'primary', doStream: async () => { throw new Error('down') } })
    const { storage, send } = setup([down, always('backup')])
    await send(u1)
    expect([...storage.runs.values()][0]).toMatchObject({ status: 'done', model: 'backup' })
    expect(storage.usageRows.filter((r) => r.unit !== 'messages').map((r) => r.model)).toEqual(['backup', 'backup'])
  })

  it('marks a run failed when every model fails', async () => {
    const down = new MockLanguageModelV4({ modelId: 'primary', doStream: async () => { throw new Error('down') } })
    const { storage, send } = setup([down])
    const r = await send(u1)
    expect(r.body).toContain('The assistant could not finish this reply')
    expect([...storage.runs.values()][0]).toMatchObject({ status: 'failed', error: 'down' })
  })
})
