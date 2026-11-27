import { callTool, chat, say, scriptedModel } from '@teovo/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import type { CardHandler } from './cards'
import { memoryStorage } from './storage'
import { defineTool } from './tools'

const prices: Record<string, number> = { mango: 350, kulfi: 300, choco: 380 }

function app(handler: CardHandler, toolVersion?: number) {
  const storage = memoryStorage()
  const model = scriptedModel([callTool('raise_prices', { by: 20 }), say('Ready to confirm.')])
  const teovo = createAssistant({
    identify: () => ({ tenantId: 't', userId: 'u', role: 'owner' }), asUser: () => null, instructions: 'Help.', storage, models: [model],
    tools: [defineTool({
      name: 'raise_prices', kind: 'propose', description: 'Raise every price', input: z.object({ by: z.number() }), ...(toolVersion ? { version: toolVersion } : {}),
      run: ({ by }) => ({
        kind: 'raise_prices', title: `Raise ${Object.keys(prices).length} prices by ₹${by}`, payload: { by },
        fields: [{ key: 'price', label: 'Price', format: 'money' as const }],
        items: Object.entries(prices).map(([k, v]) => ({ label: k, before: { price: v }, after: { price: v + by } })),
      }),
    })],
    cards: { raise_prices: handler },
  })
  const decide = (id: string, d: string) => teovo.fetch(new Request(`https://a.test/cards/${id}/${d}`, { method: 'POST' }))
  return { teovo, storage, decide }
}

describe('one card for many records', () => {
  it('shows each record\'s change, applies them together and undoes them together', async () => {
    const before = { ...prices }
    const s = app({ apply: ({ by }: { by: number }) => { for (const k in prices) prices[k]! += by; return { undo: by } }, undo: (by) => { for (const k in prices) prices[k]! -= by as number } })
    const card = (await chat(s.teovo, 'raise all prices by 20')).cards[0]!
    expect(card.items).toEqual([{ label: 'mango', before: { price: 350 }, after: { price: 370 } }, { label: 'kulfi', before: { price: 300 }, after: { price: 320 } }, { label: 'choco', before: { price: 380 }, after: { price: 400 } }])
    expect((await s.decide(card.id, 'confirm')).status).toBe(200)
    expect(prices).toEqual({ mango: 370, kulfi: 320, choco: 400 })
    expect((await s.decide(card.id, 'undo')).status).toBe(200)
    expect(prices).toEqual(before)
  })
})

describe('tool versions', () => {
  it('migrates a card made by an older version of the tool', async () => {
    let applied: unknown
    const s = app({ version: 2, migrate: (p, from) => ({ amount: (p as { by: number }).by, from }), apply: (p: unknown) => { applied = p } }, 1)
    const card = (await chat(s.teovo, 'raise prices')).cards[0]!
    expect(card.version).toBe(1)
    expect((await s.decide(card.id, 'confirm')).status).toBe(200)
    expect(applied).toEqual({ amount: 20, from: 1 })
  })

  it('refuses (and expires) a card from another version when there is no migrate, instead of applying it wrongly', async () => {
    let applied = false
    const s = app({ version: 2, apply: () => { applied = true } })   // the card says version 1 (the tool sets none)
    const card = (await chat(s.teovo, 'raise prices')).cards[0]!
    const res = await s.decide(card.id, 'confirm')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('This card was prepared by an earlier version of the app. Ask again and the assistant will prepare a fresh one.')
    expect(applied).toBe(false)
    expect((await s.storage.getCard('t', 'u', card.id))?.status).toBe('expired')
  })

  it('refuses an app-applied card from another version too', async () => {
    const s = app({ inApp: true, version: 3 }, 2)
    const card = (await chat(s.teovo, 'raise prices')).cards[0]!
    expect((await s.decide(card.id, 'confirm')).status).toBe(409)
  })
})
