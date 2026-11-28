import { describe, expect, it } from 'vitest'
import { r2Files, supabaseFiles, type R2Like, type SupabaseStorageLike } from './files'

const file = { id: '7e570000-0000-4000-8000-0000000000aa', tenantId: 'shop-1', userId: 'u1', threadId: 't1', mediaType: 'image/jpeg', filename: 'bill.jpg', bytes: new Uint8Array([1, 2, 3]) }

describe('r2Files', () => {
  it('keeps the owner in metadata and finds files only within their tenant', async () => {
    const objects = new Map<string, { body: Uint8Array; opts: Parameters<R2Like['put']>[2] }>()
    const bucket: R2Like = {
      async put(key, value, opts) { objects.set(key, { body: value, opts }) },
      async get(key) {
        const o = objects.get(key)
        return o ? { arrayBuffer: async () => o.body.slice().buffer, httpMetadata: o.opts.httpMetadata, customMetadata: o.opts.customMetadata, uploaded: new Date('2026-11-27') } : null
      },
    }
    const store = r2Files(bucket)
    await store.put(file)
    expect([...objects.keys()]).toEqual([`shop-1/${file.id}`])
    expect(await store.get('shop-1', file.id)).toMatchObject({ userId: 'u1', threadId: 't1', mediaType: 'image/jpeg', filename: 'bill.jpg', bytes: new Uint8Array([1, 2, 3]) })
    expect(await store.get('shop-2', file.id)).toBeNull()
    expect(await store.get('shop-1', '../shop-2/x')).toBeNull()
  })
})

describe('supabaseFiles', () => {
  it('uploads under tenant/user/thread/id to a private bucket and reads it back through the index', async () => {
    const uploads = new Map<string, Uint8Array>()
    const client: SupabaseStorageLike = { storage: { from: (bucket) => ({
      async upload(path, body, opts) { expect([bucket, opts.contentType, opts.upsert]).toEqual(['assistant-files', 'image/jpeg', false]); uploads.set(path, body); return { error: null } },
      async download(path) { const b = uploads.get(path); return b ? { data: new Blob([b as Uint8Array<ArrayBuffer>]), error: null } : { data: null, error: { message: 'not found' } } },
    }) } }
    const meta = new Map<string, Omit<typeof file, 'bytes'>>()
    const store = supabaseFiles(client, 'assistant-files', {
      put: async (m) => { meta.set(m.id, m as Omit<typeof file, 'bytes'>) },
      get: async (tenantId, id) => { const m = meta.get(id); return m && m.tenantId === tenantId ? m : null },
    })
    await store.put(file)
    expect([...uploads.keys()]).toEqual([`shop-1/u1/t1/${file.id}`])
    expect((await store.get('shop-1', file.id))?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(await store.get('shop-2', file.id)).toBeNull()
  })

  it('removes pictures older than a date: the files in the bucket, then their rows', async () => {
    const removed: string[][] = []
    const client: SupabaseStorageLike = { storage: { from: () => ({
      async upload() { return { error: null } },
      async download() { return { data: null, error: null } },
      async remove(paths) { removed.push(paths); return { error: null } },
    }) } }
    const rows = Array.from({ length: 130 }, (_, i) => ({ id: `f${i}`, tenantId: 'shop-1', userId: 'u1', threadId: 't1', mediaType: 'image/png', old: i < 120 }))
    const forgotten: string[] = []
    const store = supabaseFiles(client, 'assistant-files', {
      put: async () => {}, get: async () => null,
      olderThan: async (_before, limit) => rows.filter((r) => r.old && !forgotten.includes(r.id)).slice(0, limit),
      forget: async (ids) => { forgotten.push(...ids) },
    })
    expect(await store.removeOlderThan!(new Date())).toBe(120)
    expect(removed.map((r) => r.length)).toEqual([100, 20])
    expect(removed[0]![0]).toBe('shop-1/u1/t1/f0')
    expect(forgotten).toHaveLength(120)
  })

  it('removes nothing when the index cannot list by age', async () => {
    const client: SupabaseStorageLike = { storage: { from: () => ({
      async upload() { return { error: null } }, async download() { return { data: null, error: null } }, async remove() { return { error: null } },
    }) } }
    expect(await supabaseFiles(client, 'b', { put: async () => {}, get: async () => null }).removeOlderThan!(new Date())).toBe(0)
  })
})
