import { callTool, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import type { Identity } from './tools'

const owner: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const staff: Identity = { tenantId: 'shop-1', userId: 'u2', role: 'staff' }

function setup(who: Identity) {
  const model = scriptedModel((_, i) => (i === 0 ? callTool('open_screen', { screen: '/catalog', label: 'Open catalog' }) : say('Here it is.')))
  const teovo = createAssistant({
    identify: () => who, asUser: () => null, tools: [], instructions: 'Help.', storage: memoryStorage(), models: [model],
    screens: [{ path: '/sales', title: 'Sales' }, { path: '/catalog', title: 'Catalog', roles: ['owner'] }],
  })
  const send = async () => (await teovo.fetch(new Request('https://a.test/api/assistant/chat', { method: 'POST', body: JSON.stringify({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'open the catalog' }] } }) }))).text()
  return { model, send }
}

describe('screens only some roles may open', () => {
  it('offers the screen to a role that may open it', async () => {
    const s = setup(owner)
    const body = await s.send()
    expect(JSON.stringify(s.model.doStreamCalls[0]!.prompt)).toContain('Catalog: /catalog')
    expect(body).toContain('"to":"/catalog"')
  })

  it('never mentions it to other roles, and refuses to open it for them', async () => {
    const s = setup(staff)
    const body = await s.send()
    expect(JSON.stringify(s.model.doStreamCalls[0]!.prompt)).not.toContain('/catalog')
    expect(body).not.toContain('"to":"/catalog"')
    expect(body).toContain('There is no screen')
  })
})
