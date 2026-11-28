import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { chat, say, scriptedModel } from './testing'

describe('instructions', () => {
  it("get the person's database, so they can describe this tenant's own data", async () => {
    const model = scriptedModel([say('ok')])
    const teovo = createAssistant<{ shop: string }>({
      identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => ({ shop: 'Little Oven' }), storage: memoryStorage(),
      tools: [], models: [model], instructions: async ({ db, identity }) => `You help ${db.shop}; the user is the ${identity.role}.`,
    })
    expect((await chat(teovo, 'hi')).status).toBe(200)
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('You help Little Oven; the user is the owner.')
  })
})
