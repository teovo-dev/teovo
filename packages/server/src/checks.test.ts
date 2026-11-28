import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import { CHECK_FAILED, defineCheck, noClaimedChanges, type DoneCheck } from './checks'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel, type Step } from './testing'
import { defineTool } from './tools'

const payment = defineTool({
  name: 'record_payment', kind: 'propose', description: 'Record a payment', input: z.object({ amount: z.number() }),
  run: ({ amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount}`, payload: { amount } }),
})

function app(steps: Step[], checks: DoneCheck[], extra: Partial<AssistantConfig> = {}) {
  const storage = memoryStorage()
  const model = scriptedModel(steps)
  const refused: { name: string; attempt: number; final: boolean }[] = []
  const teovo = createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, tools: [payment], instructions: 'Help.',
    storage, models: [model], checks, on: { check: ({ name, attempt, final }) => refused.push({ name, attempt, final }) }, ...extra,
  })
  return { teovo, model, storage, refused }
}

const noNumbers = defineCheck({ name: 'no-numbers', check: (r) => (/\d/.test(r.text) ? 'It has a number in it; say it in words.' : null) })

describe('done-checks', () => {
  it('sends a reply that passes, untouched', async () => {
    const { teovo, refused } = app([say('All good today.')], [noNumbers])
    const out = await chat(teovo, 'how is it going?')
    expect(out.text).toBe('All good today.')
    expect(refused).toEqual([])
  })

  it('holds a refused reply back, tells the model why, and sends the second try instead', async () => {
    const { teovo, model, refused, storage } = app([say('You sold 12 tubs.'), say('You sold twelve tubs.')], [noNumbers])
    const out = await chat(teovo, 'how many tubs?')
    expect(out.text).toBe('You sold twelve tubs.')
    expect(out.text).not.toContain('12')
    expect(refused).toEqual([{ name: 'no-numbers', attempt: 0, final: false }])
    // The model was told the reply was refused and why.
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('It has a number in it')
    // Only the passing reply is saved in the conversation.
    const saved = (await storage.listMessages(out.threadId!)).at(-1)!
    expect(JSON.stringify(saved.parts)).not.toContain('12 tubs')
  })

  it('gives a plain sentence when every try is refused', async () => {
    const { teovo, refused } = app([say('1'), say('2')], [noNumbers])
    const out = await chat(teovo, 'count')
    expect(out.text).toBe(CHECK_FAILED)
    expect(refused.map((r) => r.final)).toEqual([false, true])
  })

  it('tries as often as checkRetries says', async () => {
    const { teovo, model } = app([say('1'), say('2'), say('3'), say('three')], [noNumbers], { checkRetries: 3 })
    expect((await chat(teovo, 'count')).text).toBe('three')
    expect(model.doStreamCalls.length).toBe(4)
  })

  it('sees the cards and tool calls of the run; the card stays on screen while only the words are rewritten', async () => {
    const seen: unknown[] = []
    const spy = defineCheck({ name: 'spy', check: (r) => { seen.push({ cards: r.cards, tools: r.toolCalls.map((t) => t.name), q: r.question }); return null } })
    const { teovo, model, refused } = app([callTool('record_payment', { amount: 500 }), say('Payment of ₹500 has been recorded.'), say('Payment of ₹500 is ready for you to confirm.')], [noClaimedChanges, spy])
    const out = await chat(teovo, 'Priya paid 500')
    expect(out.cards.map((c) => c.title)).toEqual(['Payment ₹500'])   // shown once, not prepared again
    expect(out.text).toBe('Payment of ₹500 is ready for you to confirm.')
    expect(refused).toEqual([{ name: 'no-claimed-changes', attempt: 0, final: false }])
    expect(seen).toEqual([{ cards: [{ kind: 'record_payment', title: 'Payment ₹500' }], tools: ['record_payment'], q: 'Priya paid 500' }])
    expect(model.doStreamCalls.length).toBe(3)
  })

  it('counts a check that throws as passed, and reports it', async () => {
    const errors: unknown[] = []
    const broken = defineCheck({ name: 'broken', check: () => { throw new Error('bug in the check') } })
    const { teovo } = app([say('Fine.')], [broken], { on: { error: (e) => errors.push(e) } })
    expect((await chat(teovo, 'hi')).text).toBe('Fine.')
    expect(String(errors[0])).toContain('bug in the check')
  })
})

describe('noClaimedChanges', () => {
  const r = (text: string, cards = [{ kind: 'k', title: 'Payment ₹500' }]) => noClaimedChanges.check({ text, question: '', cards, toolCalls: [], attempt: 0 }, { identity: { tenantId: 't', userId: 'u', role: 'owner' }, db: null })
  it('refuses "recorded" next to a card that only waits for Confirm', () => {
    expect(r('Payment has been recorded.')).toContain('Payment ₹500')
    expect(r('Done! Payment recorded.')).toBeTruthy()
    expect(r('I’ve saved it.')).toBeTruthy()
  })
  it('lets a reply that says it is ready to confirm through, and any reply with no card', () => {
    expect(r('The payment is ready for you to confirm.')).toBeNull()
    expect(r('Once you confirm, it will be recorded and saved in the order.')).toBeNull()
    expect(r('Payment has been recorded.', [])).toBeNull()
  })
})
