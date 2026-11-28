import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { chat, say, scriptedModel } from './testing'
import type { Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const usage = { inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 12, text: 12, reasoning: undefined } }

/** A model for summaries: answers each call with the next summary, and keeps what it was asked. */
function summarizer(texts: string[]) {
  let i = 0
  return new MockLanguageModelV4({
    modelId: 'summarizer', provider: 'test',
    doGenerate: async () => ({ content: [{ type: 'text', text: texts[i++] ?? '' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }) as never,
  })
}
const promptOf = (m: MockLanguageModelV4, i: number) => JSON.stringify(m.doGenerateCalls[i]!.prompt)

function app(replies: string[], summaries: string[], extra = {}) {
  const storage = memoryStorage()
  const model = scriptedModel(replies.map(say))
  const sum = summarizer(summaries)
  const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, tools: [], models: [model], historyMessages: 4, summary: { model: sum }, ...extra })
  return { teovo, storage, model, sum }
}

describe('summary of older turns', () => {
  it('summarizes messages once they fall out of view, and gives the model the summary from then on', async () => {
    const { teovo, storage, model, sum } = app(['Noted.', 'Okay.', 'Sure.', 'You prefer UPI, Nisha.'], ['Nisha prefers UPI.', 'Nisha prefers UPI and bakes on Sundays.'])
    const t = (await chat(teovo, 'I am Nisha and I prefer UPI')).threadId!
    await chat(teovo, 'we bake on Sundays', { threadId: t })
    expect(sum.doGenerateCalls).toHaveLength(0)   // 4 messages: all still in view
    await chat(teovo, 'ok', { threadId: t })
    // Five messages, four kept: the first and its reply fell out of view (the view starts at a user message), and
    // were summarized after that reply.
    expect(sum.doGenerateCalls).toHaveLength(1)
    expect(promptOf(sum, 0)).toContain('User: I am Nisha and I prefer UPI')
    expect(promptOf(sum, 0)).toContain('Assistant: Noted.')
    const thread = (await storage.getThread('shop', 'nisha', t))!
    const msgs = await storage.listMessages(t)
    expect(thread.summary).toEqual({ text: 'Nisha prefers UPI.', upTo: msgs[1]!.id })
    // The next message: the model gets the summary, and only the last four messages whole.
    expect((await chat(teovo, 'how do I like to be paid?', { threadId: t })).text).toBe('You prefer UPI, Nisha.')
    const last = JSON.stringify(model.doStreamCalls[3]!.prompt)
    expect(last).toContain('Earlier in this conversation (a summary; those messages are no longer shown): Nisha prefers UPI.')
    expect(last).not.toContain('I am Nisha and I prefer UPI')
    // Only the messages since the summary are folded in, on top of it.
    expect(sum.doGenerateCalls).toHaveLength(2)
    expect(promptOf(sum, 1)).toContain('Earlier summary: Nisha prefers UPI.')
    expect(promptOf(sum, 1)).toContain('User: we bake on Sundays')
    expect(promptOf(sum, 1)).not.toContain('Assistant: Noted.')
    expect(promptOf(sum, 1)).not.toContain('I am Nisha and I prefer UPI')
    // Its tokens are counted with the reply's run.
    expect(storage.usageRows.filter((u) => u.model === 'summarizer' && u.unit === 'input_tokens')).toHaveLength(2)
  })

  it('uses no summary once every message is in view again (after an edit removed the rest)', async () => {
    const { teovo, storage, model } = app(['a', 'b', 'c', 'd'], ['About the first question.', 'x'])
    const t = (await chat(teovo, 'first')).threadId!
    await chat(teovo, 'second', { threadId: t })
    await chat(teovo, 'third', { threadId: t })
    expect((await storage.getThread('shop', 'nisha', t))!.summary?.text).toBe('About the first question.')
    // Edit the second message: everything from it goes, including what the summary covered (up to its reply).
    await storage.removeMessagesFrom(t, (await storage.listMessages(t))[1]!.id)
    await chat(teovo, 'again', { threadId: t })
    expect(JSON.stringify(model.doStreamCalls[3]!.prompt)).not.toContain('About the first question.')
  })

  it('what the model sees always starts at a user message, so a reply\'s tool call is never first', async () => {
    const { teovo, model } = app(['a', 'b', 'c'], ['s1', 's2'], { historyMessages: 3 })
    const t = (await chat(teovo, 'one')).threadId!
    await chat(teovo, 'two', { threadId: t })
    await chat(teovo, 'three', { threadId: t })
    // Five messages, three kept: the cut would start at "a"'s reply… moved on to the user's "two".
    const seen = (model.doStreamCalls[2]!.prompt as { role: string }[]).filter((m) => m.role !== 'system').map((m) => m.role)
    expect(seen[0]).toBe('user')
    expect(seen).toEqual(['user', 'assistant', 'user'])
  })

  it('is off unless asked for', async () => {
    const storage = memoryStorage()
    const sum = summarizer(['never'])
    const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: '', storage, tools: [], models: [scriptedModel(['1', '2', '3'].map(say))], historyMessages: 2 })
    const t = (await chat(teovo, 'a')).threadId!
    await chat(teovo, 'b', { threadId: t })
    await chat(teovo, 'c', { threadId: t })
    expect(sum.doGenerateCalls).toHaveLength(0)
    expect((await storage.getThread('shop', 'nisha', t))!.summary).toBeUndefined()
  })
})
