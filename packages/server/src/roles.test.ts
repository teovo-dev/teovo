import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import { chat } from './testing'
import { defineTool, type Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } })
const stream = (parts: unknown[]) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) { for (const p of parts) c.enqueue(structuredClone(p) as LanguageModelV4StreamPart); c.close() } }) })
let n = 0
const call = (toolName: string, input: unknown, tokens = 100) => stream([{ type: 'tool-call', toolCallId: `c${++n}`, toolName, input: JSON.stringify(input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usage(tokens, 10) }])
const say = (text: string, tokens = 100) => stream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(tokens, 20) }])
const scripted = (modelId: string, steps: ReturnType<typeof say>[]) => new MockLanguageModelV4({ modelId, provider: 'test', doStream: steps as never })

const tools = [
  defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => [{ no: 4, due: 250 }, { no: 7, due: 900 }] }),
  defineTool({ name: 'list_products', kind: 'read', description: 'Products', input: z.object({}), run: () => [] }),
]

function app(analyst: MockLanguageModelV4, writers: MockLanguageModelV4[], extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  const teovo = createAssistant({
    identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools, models: [analyst],
    roles: { writer: { description: 'writes the final report from what was found', models: writers, instructions: 'Write a short, warm report for the owner.', tools: [] } },
    ...extra,
  })
  return { teovo, storage }
}

describe('roles: a planned model switch inside one reply', () => {
  it('hands over to the writer, which carries on with its own model, instructions and the note', async () => {
    const analyst = scripted('flash-lite', [call('list_orders', {}, 300), call('hand_over', { to: 'writer', note: 'Two orders owe money: 4 (₹250) and 7 (₹900).' }, 200)])
    const writer = scripted('pro', [say('Two customers still owe you ₹1,150 in all.', 900)])
    const { teovo, storage } = app(analyst, [writer])
    const out = await chat(teovo, 'write me a report on who owes money')
    expect(out.text).toBe('Two customers still owe you ₹1,150 in all.')
    expect(out.tools).toEqual(['list_orders', 'hand_over'])
    expect(analyst.doStreamCalls).toHaveLength(2)
    // The first model was told the writing is the writer's job.
    expect(JSON.stringify(analyst.doStreamCalls[0]!.prompt)).toContain('the writer writes the final report from what was found')
    // The writer saw what the analyst found, its own instructions and the note.
    const seen = JSON.stringify(writer.doStreamCalls[0]!.prompt)
    expect(seen).toContain('You are now the writer: Write a short, warm report for the owner.')
    expect(seen).toContain('Two orders owe money: 4 (₹250) and 7 (₹900).')
    expect(seen).toContain('"due":900')
    // Only its own tools (none), plus handing over again and cannot_help.
    expect((writer.doStreamCalls[0]!.tools ?? []).map((t) => t.name).sort()).toEqual(['cannot_help', 'hand_over'])
    // The run log: the hand-over as a step, the model that finished, and usage per model.
    const run = [...storage.runs.values()][0]!
    expect(run.model).toBe('pro')
    expect(storage.steps.find((s) => s.name === 'hand_over')).toMatchObject({ input: { from: null, to: 'writer', note: 'Two orders owe money: 4 (₹250) and 7 (₹900).' } })
    const tokens = (model: string, unit: string) => storage.usageRows.filter((u) => u.model === model && u.unit === unit).reduce((a, u) => a + u.amount, 0)
    expect([tokens('flash-lite', 'input_tokens'), tokens('pro', 'input_tokens')]).toEqual([500, 900])
    expect([tokens('flash-lite', 'output_tokens'), tokens('pro', 'output_tokens')]).toEqual([20, 20])
  })

  it('the app\'s own plan makes a role take over, once, even when the model never hands over', async () => {
    const analyst = scripted('flash-lite', [call('list_orders', {})])
    const writer = scripted('pro', [say('Here is your report: ₹1,150 is owed.')])
    const plans: { text: string; toolCalls: string[]; step: number }[] = []
    const storage = memoryStorage()
    const teovo = createAssistant({
      identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools, models: [analyst],
      roles: { writer: { description: 'writes reports', models: [writer], takesOver: (c) => { plans.push(c); return /report/.test(c.text) && c.toolCalls.length > 0 } } },
    })
    const out = await chat(teovo, 'a report on who owes money')
    expect(out.text).toBe('Here is your report: ₹1,150 is owed.')
    expect(out.tools).toEqual(['list_orders', 'hand_over'])
    expect(plans).toEqual([{ text: 'a report on who owes money', toolCalls: ['list_orders'], step: 1 }])   // asked before step 2 only; once over, not again
    expect(storage.steps.find((x) => x.name === 'hand_over')).toMatchObject({ input: { from: null, to: 'writer', by: 'app' } })
    expect([...storage.runs.values()][0]!.model).toBe('pro')
  })

  it('a role\'s own models fall back too', async () => {
    const analyst = scripted('flash-lite', [call('hand_over', { to: 'writer', note: 'Nothing found.' })])
    const down = new MockLanguageModelV4({ modelId: 'pro', provider: 'test', doStream: async () => { throw new Error('overloaded') } })
    const backup = scripted('flash', [say('All quiet today.')])
    const switched: string[] = []
    const { teovo, storage } = app(analyst, [down, backup], { on: { modelSwitch: (from) => switched.push(from) } })
    expect((await chat(teovo, 'report')).text).toBe('All quiet today.')
    expect(switched).toEqual(['pro'])
    expect([...storage.runs.values()][0]!.model).toBe('flash')
  })

  it('offers no hand_over without roles, and a reply that never hands over stays on its own model', async () => {
    const solo = scripted('flash', [say('Hi.')])
    const storage = memoryStorage()
    const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: '', storage, tools, models: [solo] })
    await chat(teovo, 'hi')
    expect((solo.doStreamCalls[0]!.tools ?? []).map((t) => t.name)).not.toContain('hand_over')
    const analyst = scripted('flash-lite', [say('Nothing to report.')])
    const writer = scripted('pro', [])
    const two = app(analyst, [writer])
    expect((await chat(two.teovo, 'anything?')).text).toBe('Nothing to report.')
    expect(writer.doStreamCalls).toHaveLength(0)
    expect([...two.storage.runs.values()][0]!.model).toBe('flash-lite')
  })
})
