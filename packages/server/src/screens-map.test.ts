import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

const screens = [
  { path: '/orders', title: 'Orders', description: 'all orders, filter by unpaid' },
  { path: '/orders/:id', title: 'Order' },
]

function setup(model: ReturnType<typeof scriptedModel>, extra: Partial<AssistantConfig> = {}) {
  return createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage: memoryStorage(), models: [model],
    tools: [defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => ({ rows: Array.from({ length: 80 }, (_, i) => ({ no: i + 1, due: 100 + i })) }) })],
    ...extra,
  })
}
const system = (m: ReturnType<typeof scriptedModel>, call = -1) => (m.doStreamCalls.at(call)!.prompt[0] as { content: string }).content

describe('screen state', () => {
  it('tells the model what the screen shows, fenced, keeping only small flat values', async () => {
    const m = scriptedModel([say('ok')])
    await chat(setup(m), 'what am I looking at?', { page: { path: '/orders', state: { filter: 'unpaid', selected: 3, 'bad key!': 1, nested: { a: 1 }, long: 'x'.repeat(500) } } })
    const s = system(m)
    expect(s).toContain(`On screen: filter = "unpaid", selected = 3, long = "${'x'.repeat(200)}"`)
    expect(s).not.toContain('nested')
    expect(s).not.toContain('bad key')
    expect(s.indexOf('On screen:')).toBeGreaterThan(s.indexOf('source="screen"'))
  })
})

describe('screens map', () => {
  it('lists the screens and opens only those, with safe values', async () => {
    const m = scriptedModel([callTool('open_screen', { screen: '/orders/:id', params: { id: 142 } }), callTool('open_screen', { screen: '/admin' }), callTool('open_screen', { screen: '/orders/:id', params: { id: '../../admin' } }), say('Here it is.')])
    const r = await chat(setup(m, { screens }), 'open order 142')
    expect(system(m, 0)).toContain('Screens in this app (offer one with open_screen when it helps the user):\n- Orders: /orders (all orders, filter by unpaid)\n- Order: /orders/:id')
    expect(r.actions).toEqual([{ label: 'Open Order', action: 'navigate', args: { to: '/orders/142' } }])
    const later = JSON.stringify(m.doStreamCalls[3]!.prompt)
    expect(later).toContain('There is no screen \\"/admin\\" with those values. Use one of: /orders, /orders/:id.')
    expect(later.match(/There is no screen/g)).toHaveLength(2)
  })

  it('offers no open_screen tool without a map, and refuses a clashing tool name', () => {
    expect(() => setup(scriptedModel([]), { screens, tools: [defineTool({ name: 'open_screen', kind: 'action', description: 'x', input: z.object({}), run: () => ({ label: 'x', action: 'x' }) })] }))
      .toThrow('open_screen clashes')
  })
})

describe('history rule', () => {
  it('cuts tool results from older replies, keeps the latest reply whole', async () => {
    const m = scriptedModel([callTool('list_orders', {}), say('80 orders.'), say('Yes.'), say('Sure.')])
    const teovo = setup(m, { historyToolChars: 100 })
    const first = await chat(teovo, 'list orders')
    await chat(teovo, 'all of them?', { threadId: first.threadId! })
    const second = JSON.stringify(m.doStreamCalls[2]!.prompt)
    expect(second).not.toContain('[cut:')                          // the latest reply's results stay whole
    expect(second).toContain('"due":179')
    await chat(teovo, 'thanks', { threadId: first.threadId! })
    const third = JSON.stringify(m.doStreamCalls[3]!.prompt)
    expect(third).toContain('[cut: an earlier result; call the tool again for all of it]')
    expect(third).not.toContain('"due":179')
  })
})
