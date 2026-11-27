import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { jsonSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

describe('tools written as JSON schemas', () => {
  it('sends the schema to the model as written, descriptions included, and runs the tool', async () => {
    const seen: unknown[] = []
    const model = scriptedModel([callTool('get_sale', { sale_no: 4 }), say('Order #4 is ₹350.')])
    const teovo = createAssistant({
      identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage: memoryStorage(), models: [model],
      tools: [defineTool({
        name: 'get_sale', kind: 'read', description: 'One order by number.',
        input: jsonSchema<{ sale_no?: number }>({ type: 'object', properties: { sale_no: { type: 'integer', description: 'The number shown on the order, e.g. 4' } } }),
        run: (input) => { seen.push(input); return { sale_no: input.sale_no, total: 350 } },
      })],
    })
    expect((await chat(teovo, 'order 4?')).text).toBe('Order #4 is ₹350.')
    expect(seen).toEqual([{ sale_no: 4 }])
    const sent = model.doStreamCalls[0]!.tools![0] as { inputSchema: { properties: { sale_no: { description: string } } } }
    expect(sent.inputSchema.properties.sale_no.description).toBe('The number shown on the order, e.g. 4')
  })
})
