import { MockEmbeddingModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { helpTool, rankByWords, splitHelp, words, type HelpDoc } from './help'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel } from './testing'
import type { Identity, ToolContext } from './tools'

const staff: Identity = { tenantId: 'shop', userId: 'ravi', role: 'staff' }
const owner: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const ctxOf = (identity: Identity) => ({ identity, db: null, untrusted: (t: string) => t }) as ToolContext

const guide: HelpDoc[] = [
  {
    title: 'Payments', path: '/help/payments',
    text: '# Payments\n\nRecord every payment against its order.\n\n## Refunds\n\nRefunds go back the way the customer paid, within 7 days.\n\n### Part refunds\n\nFor a part refund, change the order total first, then record the refund.\n\n```\n# not a heading\n```',
  },
  { title: 'Opening hours', text: 'We open 7 am to 9 pm, and are closed on Mondays.' },
  { title: 'Owner settings', text: '## Staff accounts\n\nAdd or remove staff from Settings › People.', roles: ['owner'] },
]

describe('help search', () => {
  it('splits a page at its headings, keeping the headings above as the title', () => {
    expect(splitHelp(guide[0]!)).toEqual([
      { title: 'Payments', text: 'Record every payment against its order.', path: '/help/payments' },
      { title: 'Payments › Refunds', text: 'Refunds go back the way the customer paid, within 7 days.', path: '/help/payments' },
      { title: 'Payments › Refunds › Part refunds', text: 'For a part refund, change the order total first, then record the refund.\n\n```\n# not a heading\n```', path: '/help/payments' },
    ])
    const long = splitHelp({ title: 'Long', text: Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(80)}`).join('\n\n') })
    expect(long.length).toBeGreaterThan(1)
    expect(long.every((s) => s.text.length <= 1500 && s.title === 'Long')).toBe(true)
  })

  it('matches words whatever their form, and ranks the closest section first', () => {
    expect(words('How do I give refunds to customers?')).toEqual(['give', 'refund', 'customer'])
    const ranked = rankByWords(guide.flatMap(splitHelp), 'part refund')
    expect(ranked[0]!.section.title).toBe('Payments › Refunds › Part refunds')
    expect(rankByWords(guide.flatMap(splitHelp), 'are you open on monday')[0]!.section.title).toBe('Opening hours')
    expect(rankByWords(guide.flatMap(splitHelp), 'gift vouchers')).toEqual([])
  })

  it('as a tool: only the pages this role may read, links to the pages, and a note when nothing matches', async () => {
    const tool = helpTool({ docs: guide })
    const out = await tool.run({ query: 'refunds' }, ctxOf(staff)) as { results: { title: string }[] }
    expect(out.results.map((r) => r.title)).toEqual(expect.arrayContaining(['Payments › Refunds', 'Payments › Refunds › Part refunds']))
    expect(tool.links!(out, { query: 'refunds' })).toEqual([{ label: 'Payments', to: '/help/payments' }])
    expect(await tool.run({ query: 'staff accounts' }, ctxOf(staff))).toEqual({ results: [], note: expect.stringContaining('the help doesn\'t cover it') })
    expect(((await tool.run({ query: 'staff accounts' }, ctxOf(owner))) as { results: { title: string }[] }).results[0]!.title).toBe('Owner settings › Staff accounts')
    // Docs from a function are read for each search.
    let calls = 0
    const live = helpTool({ docs: () => (calls++, guide) })
    await live.run({ query: 'hours' }, ctxOf(staff)); await live.run({ query: 'hours' }, ctxOf(staff))
    expect(calls).toBe(2)
  })

  it('with embeddings, finds by meaning too, embeds each section once, and falls back to words when they fail', async () => {
    // A toy model: [money, time] by the words it sees.
    const vec = (t: string) => [/refund|money|paid|payment/i.test(t) ? 1 : 0, /open|hour|monday|when/i.test(t) ? 1 : 0.01]
    const model = new MockEmbeddingModelV4({ maxEmbeddingsPerCall: 100, doEmbed: async ({ values }) => ({ embeddings: values.map(vec), warnings: [] }) })
    const tool = helpTool({ docs: guide, embeddings: model, results: 1 })
    // No word in common with "Opening hours", but the same meaning.
    expect(rankByWords(guide.flatMap(splitHelp), 'when can I come by')).toEqual([])
    expect(await tool.run({ query: 'when can I come by' }, ctxOf(staff))).toMatchObject({ results: [{ title: 'Opening hours' }] })
    await tool.run({ query: 'money back' }, ctxOf(staff))
    expect(model.doEmbedCalls.map((c) => c.values.length)).toEqual([5, 1])   // 4 sections + the question, then the new question only
    const down = new MockEmbeddingModelV4({ doEmbed: async () => { throw new Error('quota') } })
    expect(await helpTool({ docs: guide, embeddings: down, results: 1 }).run({ query: 'part refund' }, ctxOf(staff))).toMatchObject({ results: [{ title: 'Payments › Refunds › Part refunds' }] })
  })

  it('in a reply: the help found shows as a link under the answer', async () => {
    const storage = memoryStorage()
    const teovo = createAssistant({
      identify: () => staff, asUser: () => null, instructions: 'Help.', storage, tools: [helpTool({ docs: guide })],
      models: [scriptedModel([callTool('search_help', { query: 'refund' }), say('Refunds go back the way the customer paid, within 7 days.')])],
    })
    const out = await chat(teovo, 'how do refunds work?')
    expect(out.text).toBe('Refunds go back the way the customer paid, within 7 days.')
    expect(JSON.stringify(out.message)).toContain('/help/payments')
  })
})
