import { callTool, say, scriptedModel } from '@teovo/server/testing'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { createAssistant } from './assistant'
import { encodeDataUrl, memoryFiles, type StoredFile } from './files'
import { memoryStorage } from './storage'
import { defineTool, type Identity, type ToolContext } from './tools'

const u1: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const u2: Identity = { tenantId: 'shop-1', userId: 'u2', role: 'owner' }
const png = encodeDataUrl('image/png', new Uint8Array([1, 2, 3]))

/** A shop where "save this bill" prepares an expense card that keeps the bill's picture id. */
function setup() {
  const storage = memoryStorage()
  const files = memoryFiles()
  let who = u1
  const seen: { files?: ToolContext['files']; read?: StoredFile | null; probe?: string; probed?: StoredFile | null } = {}
  const applied: { bytes?: Uint8Array | null; other?: StoredFile | null } = {}
  const tool = defineTool({
    name: 'propose_expense', description: 'Prepare an expense.', kind: 'propose', label: 'Prepared the expense',
    input: z.object({ amount: z.number() }),
    run: async ({ amount }, ctx) => {
      seen.files = ctx.files
      seen.read = ctx.files?.[0] ? await ctx.file!(ctx.files[0].id) : null
      if (seen.probe) seen.probed = await ctx.file!(seen.probe)
      return { kind: 'expense', title: `Expense ₹${amount}`, payload: { amount, receipt: ctx.files?.[0]?.id ?? null } }
    },
  })
  const teovo = createAssistant({
    identify: () => who, asUser: () => null, instructions: 'Help.', storage, attachments: {},
    files: { store: files, keepDays: 30 },
    tools: [tool],
    models: [scriptedModel((_, i) => (i % 2 === 0 ? callTool('propose_expense', { amount: 1100 }) : say('Prepared.')))],
    cards: {
      expense: {
        apply: async (p: { receipt: string | null }, ctx) => {
          applied.bytes = p.receipt ? (await ctx.file!(p.receipt))?.bytes ?? null : null
          applied.other = await ctx.file!('00000000-0000-4000-8000-000000000000')
          return { undo: { id: 'e1' }, note: 'Saved' }
        },
        undo: () => {},
      },
    },
  })
  const send = async (parts: UIMessage['parts']) => {
    const res = await teovo.fetch(new Request('https://a.test/api/assistant/chat', { method: 'POST', body: JSON.stringify({ message: { id: crypto.randomUUID(), role: 'user', parts } }) }))
    const body = await res.text()
    return { thread: res.headers.get('x-teovo-thread')!, body }
  }
  const decide = (id: string, d: string) => teovo.fetch(new Request(`https://a.test/api/assistant/cards/${id}/${d}`, { method: 'POST', body: '{}' }))
  return { storage, files, seen, applied, send, decide, as: (i: Identity) => { who = i } }
}

describe('pictures for tools and cards', () => {
  it("gives a tool the message's pictures, and the card's applier can read the one it kept", async () => {
    const s = setup()
    const { thread } = await s.send([{ type: 'text', text: 'save this bill' }, { type: 'file', mediaType: 'image/png', filename: 'bill.png', url: png }])
    const stored = [...s.files.files.values()][0]!
    expect(s.seen.files).toEqual([{ id: stored.id, mediaType: 'image/png', filename: 'bill.png' }])
    expect(s.seen.read?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    const [card] = await s.storage.listCards(thread)
    expect(card!.payload).toEqual({ amount: 1100, receipt: stored.id })
    expect((await s.decide(card!.id, 'confirm')).status).toBe(200)
    expect(s.applied.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(s.applied.other).toBeNull()
  })

  it('has no pictures when the message has none', async () => {
    const s = setup()
    await s.send([{ type: 'text', text: 'spent 1100 on butter' }])
    expect(s.seen.files).toBeUndefined()
  })

  it("never reads another person's picture, even in the same shop", async () => {
    const s = setup()
    await s.send([{ type: 'text', text: 'save this bill' }, { type: 'file', mediaType: 'image/png', url: png }])
    s.seen.probe = [...s.files.files.keys()][0]!
    s.as(u2)
    await s.send([{ type: 'text', text: 'save that bill again' }])
    expect(s.seen.probed).toBeNull()
    s.as(u1)
    await s.send([{ type: 'text', text: 'save it again' }])
    expect(s.seen.probed?.userId).toBe('u1')
  })

  it("sends the tool's label with its step", async () => {
    const s = setup()
    const { body } = await s.send([{ type: 'text', text: 'spent 1100 on butter' }])
    expect(body).toContain('"label":"Prepared the expense"')
  })
})
