import { say, scriptedModel } from '@teovo/server/testing'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { decodeDataUrl, encodeDataUrl, memoryFiles } from './files'
import { memoryStorage } from './storage'
import type { Identity } from './tools'

const u1: Identity = { tenantId: 'shop-1', userId: 'u1', role: 'owner' }
const bytes = new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 251))
const png = encodeDataUrl('image/png', bytes)

function setup(withStore = true) {
  const storage = memoryStorage()
  const files = memoryFiles()
  const model = scriptedModel((_, i) => say(`answer ${i + 1}`))
  let who = u1
  const teovo = createAssistant({
    identify: () => who, asUser: () => null, tools: [], instructions: 'Help.', storage, models: [model], attachments: {},
    ...(withStore ? { files: { store: files, keepDays: 30 } } : {}),
  })
  const send = async (parts: UIMessage['parts'], threadId?: string) => {
    const res = await teovo.fetch(new Request('https://a.test/api/assistant/chat', { method: 'POST', body: JSON.stringify({ threadId, message: { id: crypto.randomUUID(), role: 'user', parts } }) }))
    await res.text()
    return res.headers.get('x-teovo-thread')!
  }
  const get = (path: string) => teovo.fetch(new Request(`https://a.test/api/assistant/${path}`))
  return { teovo, storage, files, model, send, get, as: (i: Identity) => { who = i } }
}
const picture = (url = png): UIMessage['parts'] => [{ type: 'text', text: 'what is this bill?' }, { type: 'file', mediaType: 'image/png', filename: 'bill.png', url }]
const prompt = (m: ReturnType<typeof scriptedModel>, i: number) => JSON.stringify(m.doStreamCalls[i]!.prompt)

describe('file storage', () => {
  it('stores the picture once and keeps only a reference in the conversation', async () => {
    const s = setup()
    const thread = await s.send(picture())
    expect(s.files.files.size).toBe(1)
    const [stored] = [...s.files.files.values()]
    expect(stored).toMatchObject({ tenantId: 'shop-1', userId: 'u1', threadId: thread, mediaType: 'image/png', filename: 'bill.png' })
    expect(stored!.bytes).toEqual(bytes)
    const saved = JSON.stringify(await s.storage.listMessages(thread))
    expect(saved).toContain(`"url":"teovo-file:${stored!.id}"`)
    expect(saved).not.toContain('base64')
  })

  it('gives the model the picture with its own message only, and a note after that', async () => {
    const s = setup()
    const thread = await s.send(picture())
    expect(prompt(s.model, 0)).toContain('"mediaType":"image/png"')
    await s.send([{ type: 'text', text: 'and the total?' }], thread)
    const second = prompt(s.model, 1)
    expect(second).not.toContain('"mediaType":"image/png"')
    expect(second).toContain('[picture: bill.png, shared earlier]')
    expect(second).not.toContain('teovo-file:')
  })

  it('sends a picture to the model once even without a file store', async () => {
    const s = setup(false)
    const thread = await s.send(picture())
    await s.send([{ type: 'text', text: 'and the total?' }], thread)
    expect(prompt(s.model, 1)).not.toContain('base64')
  })

  it('serves a picture to the person who sent it, and to no one else', async () => {
    const s = setup()
    await s.send(picture())
    const id = [...s.files.files.keys()][0]!
    const res = await s.get(`files/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toContain('private')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)

    s.as({ ...u1, userId: 'u2' })
    expect((await s.get(`files/${id}`)).status).toBe(404)
    s.as({ ...u1, tenantId: 'shop-2' })
    expect((await s.get(`files/${id}`)).status).toBe(404)
    s.as(u1)
    expect((await s.get(`files/${crypto.randomUUID()}`)).status).toBe(404)
  })

  it('removes pictures after keepDays', async () => {
    const s = setup()
    await s.send(picture())
    expect(await s.teovo.removeOldFiles()).toBe(0)
    expect(await s.teovo.removeOldFiles(new Date(Date.now() + 31 * 86_400_000))).toBe(1)
    expect(s.files.files.size).toBe(0)
  })

  it('round-trips data URLs', () => {
    expect(decodeDataUrl(png)).toEqual({ mediaType: 'image/png', bytes })
    expect(decodeDataUrl('https://x/y.png')).toBeNull()
  })
})
