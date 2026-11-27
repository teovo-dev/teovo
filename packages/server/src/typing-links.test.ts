import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { tidy } from './screens'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

const orders = [{ no: 142, customer: 'Riya K', phone: '99001 22334', due: 250 }, { no: 143, customer: 'Chand Bakers', phone: '90080 70060', due: 3150 }]

function app() {
  const storage = memoryStorage()
  const model = scriptedModel([callTool('list_orders', {}), say('Two orders are due.')])
  const teovo = createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage, models: [model],
    redact: { fields: ['phone'] },
    tools: [defineTool({
      name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => orders,
      links: (rows: typeof orders) => rows.map((o) => ({ label: `Order #${o.no}`, to: `/orders/${o.no}` })).concat([{ label: 'Bad', to: 'https://evil.test' }]),
    })],
    completions: () => ['Riya K', 'Chand Bakers', 'Chand Bakers', 'x', 'Belgian chocolate 500 ml'],
  })
  return { teovo, storage }
}

describe('record links', () => {
  it('puts links to the records the answer used under it, keeps only the app\'s own paths, and saves them', async () => {
    const s = app()
    const res = await s.teovo.fetch(new Request('https://a.test/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'q', role: 'user', parts: [{ type: 'text', text: 'what is due?' }] } }) }))
    const body = await res.text()
    expect(body).toContain('"type":"data-sources"')
    const saved = (await s.storage.listMessages(res.headers.get('x-teovo-thread')!)).at(-1)!
    const part = saved.parts.find((p) => p.type === 'data-sources') as { data: { links: { label: string; to: string }[] } }
    expect(part.data.links).toEqual([{ label: 'Order #142', to: '/orders/142' }, { label: 'Order #143', to: '/orders/143' }])
  })
})

describe('typing help', () => {
  it('serves the app\'s words for completion, cleaned and without duplicates', async () => {
    const s = app()
    const r = (await (await s.teovo.fetch(new Request('https://a.test/completions'))).json()) as { words: string[] }
    expect(r.words).toEqual(['Riya K', 'Chand Bakers', 'Belgian chocolate 500 ml'])
  })

  it('keeps up to six example questions for the placeholder', () => {
    expect(tidy({ suggestions: [], examples: ['a  b', 'a b', 'c', '', 'd', 'e', 'f', 'g', 'h'] }).examples).toEqual(['a b', 'c', 'd', 'e', 'f', 'g'])
  })
})
