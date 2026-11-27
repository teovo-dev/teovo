// Teovo on Cloudflare Workers AI only (no Gemini), inside a real Worker. GET /check runs a few conversations
// and returns what each produced, including the neurons Cloudflare reported.
import { createAssistant, defineTool, memoryStorage } from '@teovo/server'
import { chat } from '@teovo/server/testing'
import { workersAi, type WorkersAiBinding } from '@teovo/server/workers-ai'
import { z } from 'zod'

interface Env { AI: WorkersAiBinding }

const orders = [
  { no: 141, customer: 'Riya Sharma', total: 880, paid: 0 },
  { no: 142, customer: 'Riya K', total: 450, paid: 200 },
  { no: 143, customer: 'Chand Bakers', total: 3150, paid: 0 },
]

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname !== '/check') return new Response('GET /check', { status: 404 })
    const storage = memoryStorage()
    const teovo = createAssistant({
      identify: () => ({ tenantId: 'check', userId: 'u', role: 'owner' }), asUser: () => null, storage,
      models: [workersAi(env.AI, '@cf/openai/gpt-oss-20b')],
      instructions: 'You help a small bakery. Use the tools for every number. Be brief. To change anything, use a propose tool.',
      formats: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' },
      tools: [
        defineTool({ name: 'list_orders', kind: 'read', description: 'Orders with total, paid and due', input: z.object({}),
          run: () => orders.map((o) => ({ ...o, due: o.total - o.paid })) }),
        defineTool({ name: 'record_payment', kind: 'propose', description: 'Prepare recording a payment against an order', input: z.object({ no: z.number(), amount: z.number() }),
          run: ({ no, amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount} for order #${no}`, payload: { no, amount } }) }),
      ],
    })
    const results = []
    for (const q of ['Who owes money?', 'Riya Sharma paid 200 for order 141.', 'Hello, what can you do?']) {
      const started = Date.now()
      const r = await chat(teovo, q)
      results.push({ q, ms: Date.now() - started, status: r.status, error: r.error, tools: r.tools, text: r.text.slice(0, 300), cards: r.cards.map((c) => c.title) })
    }
    const usage = storage.usageRows.reduce<Record<string, number>>((t, u) => ({ ...t, [u.unit]: (t[u.unit] ?? 0) + u.amount }), {})
    const runs = [...storage.runs.values()].map((r) => ({ status: r.status, model: r.model, error: r.error }))
    return Response.json({ results, usage, runs })
  },
}
