import { chat, say, scriptedModel } from '@teovo/server/testing'
import { workersAi, WorkersAiLimitError, type WorkersAiBinding } from '@teovo/server/workers-ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

/** A stand-in for env.AI: answers from a script and keeps what it was asked. */
function fakeAI(answers: unknown[] | ((input: Record<string, unknown>) => unknown)) {
  const calls: { model: string; input: Record<string, any> }[] = []
  let i = 0
  const binding: WorkersAiBinding = {
    async run(model, input) {
      calls.push({ model, input: structuredClone(input) })
      const a = typeof answers === 'function' ? answers(input) : answers[i++]
      if (a instanceof Error) throw a
      return a
    },
  }
  return { binding, calls }
}
// The two shapes Workers AI answers in: OpenAI-style choices (gpt-oss) and { response, tool_calls } (Llama-style).
const openai = (content: string | null, toolCalls?: { name: string; args: unknown }[], neurons?: number) => ({
  choices: [{ message: { content, tool_calls: toolCalls?.map((c, k) => ({ id: `call_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 30, ...(neurons ? { neurons } : {}) },
})
const llama = (response: string, toolCalls?: { name: string; arguments: unknown }[]) => ({ response, tool_calls: toolCalls, usage: { prompt_tokens: 50, completion_tokens: 10 } })

function shop(models: AssistantConfig['models'], extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  const teovo = createAssistant({
    identify: () => ({ tenantId: 'shop-1', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help the shop.', storage, models,
    tools: [defineTool({ name: 'get_dues', kind: 'read', description: 'Who owes', input: z.object({ min: z.number().optional() }), run: () => [{ customer: 'Riya', due: 880 }] })],
    ...extra,
  })
  return { teovo, storage }
}

/** A Workers AI stream in the real gpt-oss-20b shape (captured 27 Nov 2026): reasoning, then text or a tool call in pieces. */
function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(text)
  // Split mid-line on purpose: a network chunk can end anywhere.
  return new ReadableStream({ start(ctl) { for (let i = 0; i < bytes.length; i += 37) ctl.enqueue(bytes.slice(i, i + 37)); ctl.close() } })
}
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 1, neurons: 0.027 } })
const totals = (prompt: number, completion: number, neurons: number) => ({ response: '', usage: { prompt_tokens: prompt, completion_tokens: completion, neurons } })
const toolStream = () => sse([
  chunk({ role: 'assistant', content: '' }), chunk({ reasoning_content: 'Need' }), chunk({ reasoning_content: ' the tool.' }),
  chunk({ tool_calls: [{ id: 'chatcmpl-tool-1', type: 'function', index: 0, function: { name: 'get_dues', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"min"' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
  chunk({}, 'tool_calls'), { choices: [], usage: { neurons: 0 } }, totals(121, 27, 2.94),
])
const textStream = (words: string[]) => sse([
  chunk({ role: 'assistant', content: '' }), chunk({ reasoning_content: 'Answer.' }), ...words.map((w) => chunk({ content: w })), chunk({}, 'stop'), totals(150, 20, 1.99),
])

describe('workersAi streaming', () => {
  it('streams text as it comes, puts tool-call arguments together from their pieces, and records the closing neuron total', async () => {
    const asked: Record<string, unknown>[] = []
    const streams = [toolStream(), textStream(['Riya', ' owes', ' ₹880.'])]
    const binding: WorkersAiBinding = { async run(_m, input) { asked.push(input); return streams.shift() } }
    const s = shop([workersAi(binding, '@cf/openai/gpt-oss-20b')])
    const r = await chat(s.teovo, 'who owes?')
    expect(r).toMatchObject({ status: 200, text: 'Riya owes ₹880.', tools: ['get_dues'] })
    expect(asked[0]).toMatchObject({ stream: true, reasoning_effort: 'low' })
    expect(asked[1]!.messages).toEqual(expect.arrayContaining([{ role: 'tool', tool_call_id: 'chatcmpl-tool-1', content: '[{"customer":"Riya","due":880}]' }]))
    const neurons = s.storage.usageRows.filter((u) => u.unit === 'neurons').map((u) => u.amount)
    expect(neurons[0]).toBeCloseTo(2.94 + 1.99, 5)
  })

  it('sends the words one by one, not all at the end', async () => {
    const binding: WorkersAiBinding = { async run() { return textStream(['One', ' two', ' three.']) } }
    const m = workersAi(binding, '@cf/openai/gpt-oss-20b')
    const { stream } = await m.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
    const deltas: string[] = []
    const reader = stream.getReader()
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value.type === 'text-delta') deltas.push(value.delta) }
    expect(deltas).toEqual(['One', ' two', ' three.'])
  })

  it('still falls back when Cloudflare refuses before streaming, and { stream: false } asks for one answer', async () => {
    const asked: Record<string, unknown>[] = []
    const used: WorkersAiBinding = { async run() { throw new Error('4006: daily free allocation of 10,000 neurons used') } }
    const s = shop([workersAi(used, '@cf/openai/gpt-oss-20b'), scriptedModel([say('From the backup.')], { modelId: 'backup' })])
    expect((await chat(s.teovo, 'hi')).text).toBe('From the backup.')
    const whole: WorkersAiBinding = { async run(_m, input) { asked.push(input); return openai('In one go.', undefined, 5) } }
    expect((await chat(shop([workersAi(whole, '@cf/openai/gpt-oss-20b', { stream: false })]).teovo, 'hi')).text).toBe('In one go.')
    expect(asked[0]).not.toHaveProperty('stream')
  })
})

describe('workersAi', () => {
  it('runs a whole tool loop through env.AI in the shape scoops uses, and records neurons', async () => {
    const ai = fakeAI([openai(null, [{ name: 'get_dues', args: { min: 1 } }], 31), openai('Riya owes ₹880.', undefined, 12)])
    const s = shop([workersAi(ai.binding, '@cf/openai/gpt-oss-20b')])
    const r = await chat(s.teovo, 'who owes?')
    expect(r).toMatchObject({ status: 200, text: 'Riya owes ₹880.', tools: ['get_dues'] })

    const first = ai.calls[0]!
    expect(first.model).toBe('@cf/openai/gpt-oss-20b')
    expect(first.input).toMatchObject({ max_tokens: 1500, reasoning_effort: 'low' })
    expect(first.input.messages[0]).toMatchObject({ role: 'system' })
    expect(first.input.messages.at(-1)).toEqual({ role: 'user', content: 'who owes?' })
    expect(first.input.tools[0]).toMatchObject({ type: 'function', function: { name: 'get_dues', description: 'Who owes', parameters: { type: 'object' } } })

    const second = ai.calls[1]!.input.messages
    expect(second.at(-2)).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_dues', arguments: '{"min":1}' } }] })
    expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_0', content: '[{"customer":"Riya","due":880}]' })

    const units = s.storage.usageRows.map((u) => [u.unit, u.amount, u.model])
    expect(units).toEqual(expect.arrayContaining([['neurons', 43, '@cf/openai/gpt-oss-20b'], ['input_tokens', 240, '@cf/openai/gpt-oss-20b'], ['output_tokens', 60, '@cf/openai/gpt-oss-20b']]))
  })

  it('reads the Llama-style answer shape, estimates neurons when none are reported, and sends pictures as image_url', async () => {
    const ai = fakeAI([llama('', [{ name: 'get_dues', arguments: { min: 1 } }]), llama('One customer owes money.')])
    const s = shop([workersAi(ai.binding, '@cf/meta/llama-4-scout-17b-16e-instruct', { estimateNeurons: 40 })], { attachments: {} })
    const res = await s.teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'q', role: 'user', parts: [
      { type: 'text', text: 'what does this bill say?' }, { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }] } }) }))
    expect(await res.text()).toContain('One customer owes money.')
    expect(ai.calls[0]!.input).not.toHaveProperty('reasoning_effort')
    expect(ai.calls[0]!.input.messages.at(-1)).toEqual({ role: 'user', content: [
      { type: 'text', text: 'what does this bill say?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] })
    expect(s.storage.usageRows.filter((u) => u.unit === 'neurons').map((u) => u.amount)).toEqual([80])
  })

  it('falls back to the next model when the allowance is used up, and a neuron limit stops a business', async () => {
    const used = fakeAI([new Error('4006: you have used up your daily free allocation of 10,000 neurons')])
    const s = shop([workersAi(used.binding, '@cf/openai/gpt-oss-20b'), scriptedModel([say('From the backup.')], { modelId: 'backup' })])
    expect((await chat(s.teovo, 'hi')).text).toBe('From the backup.')

    const ai = fakeAI(() => openai('ok', undefined, 60))
    const capped = shop([workersAi(ai.binding, '@cf/openai/gpt-oss-20b')], { limits: { tenant: { neurons: 100 } } })
    expect((await chat(capped.teovo, 'one')).status).toBe(200)
    expect((await chat(capped.teovo, 'two')).status).toBe(200)    // 60, then 120 ≥ 100
    const third = await chat(capped.teovo, 'three')
    expect(third).toMatchObject({ status: 429, error: 'Your team has reached its assistant limit for today. It resets tomorrow.' })
  })

  it('names an allowance error clearly when there is no backup', async () => {
    const used = fakeAI([new Error('Capacity temporarily exceeded (429)')])
    await expect(workersAi(used.binding, '@cf/openai/gpt-oss-20b').doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
      .rejects.toBeInstanceOf(WorkersAiLimitError)
  })
})
