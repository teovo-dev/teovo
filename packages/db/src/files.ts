import type { FileStore, StoredFile } from '@teovo/server'
import type { Query } from './migrate.js'

const row = (r: any): StoredFile => ({
  id: r.id, tenantId: r.tenant_id, userId: r.user_id, threadId: r.thread_id, mediaType: r.media_type,
  ...(r.filename ? { filename: r.filename } : {}), bytes: new Uint8Array(r.bytes), createdAt: new Date(r.created_at).toISOString(),
})

/** Pictures in Postgres (tv_files, feature `files`). Simple and fine for small volumes; use object storage beyond that. */
export function postgresFiles(query: Query): FileStore {
  return {
    async put(f) {
      await query('insert into tv_files (id, tenant_id, user_id, thread_id, media_type, filename, size, bytes) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [f.id, f.tenantId, f.userId, f.threadId, f.mediaType, f.filename ?? null, f.bytes.length, Buffer.from(f.bytes)])
    },
    async get(tenantId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const r = await query('select * from tv_files where id = $1 and tenant_id = $2', [id, tenantId])
      return r.rows[0] ? row(r.rows[0]) : null
    },
    async removeOlderThan(before) {
      return (await query('delete from tv_files where created_at < $1 returning id', [before.toISOString()])).rows.length
    },
  }
}

/** The calls Teovo makes on a Supabase client (supabase-js v2), so this package needn't depend on it. */
export interface SupabaseStorageLike {
  storage: { from(bucket: string): {
    upload(path: string, body: Uint8Array, opts: { contentType: string; upsert?: boolean }): Promise<{ error: { message: string } | null }>
    download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>
    remove?(paths: string[]): Promise<{ error: { message: string } | null }>
  } }
}

/**
 * Pictures in a private Supabase Storage bucket, under <tenant>/<user>/<thread>/<id>. Teovo serves them itself
 * (GET …/files/:id checks the owner), so the bucket stays private. A small metadata row in tv_files (without bytes)
 * is not needed: the path holds the owner. Expire them with a Storage lifecycle rule or your own job.
 */
export function supabaseFiles(client: SupabaseStorageLike, bucket: string, index: {
  put(f: Omit<StoredFile, 'bytes'>): Promise<void>
  get(tenantId: string, id: string): Promise<Omit<StoredFile, 'bytes'> | null>
  /** The owner rows to delete with wipe(); without it, wipe leaves the bucket alone. */
  list?(tenantId: string, userId?: string): Promise<Omit<StoredFile, 'bytes'>[]>
  /** Up to `limit` owner rows older than this, oldest first; with forget, lets removeOldFiles clear the bucket. */
  olderThan?(before: Date, limit: number): Promise<Omit<StoredFile, 'bytes'>[]>
  /** Delete these owner rows, once their files are gone from the bucket. */
  forget?(ids: string[]): Promise<void>
}): FileStore {
  const path = (f: Pick<StoredFile, 'tenantId' | 'userId' | 'threadId' | 'id'>) => `${f.tenantId}/${f.userId}/${f.threadId}/${f.id}`
  return {
    async put(f) {
      const { error } = await client.storage.from(bucket).upload(path(f), f.bytes, { contentType: f.mediaType, upsert: false })
      if (error) throw new Error(`Could not save the picture: ${error.message}`)
      const { bytes: _, ...meta } = f
      await index.put(meta)
    },
    async get(tenantId, id) {
      const meta = await index.get(tenantId, id)
      if (!meta) return null
      const { data, error } = await client.storage.from(bucket).download(path(meta))
      if (error || !data) return null
      return { ...meta, bytes: new Uint8Array(await data.arrayBuffer()) }
    },
    async removeOlderThan(before) {
      if (!index.olderThan || !index.forget || !client.storage.from(bucket).remove) return 0
      let n = 0
      for (;;) {
        const old = await index.olderThan(before, 100)
        if (!old.length) return n
        // The files first, then their rows: a failure leaves rows that the next run tries again.
        const { error } = await client.storage.from(bucket).remove!(old.map(path))
        if (error) throw new Error(`Could not delete the pictures: ${error.message}`)
        await index.forget(old.map((f) => f.id))
        n += old.length
        if (old.length < 100) return n
      }
    },
    async removeFor(tenantId, userId) {
      const remove = client.storage.from(bucket).remove
      if (!index.list || !remove) return 0
      const owned = await index.list(tenantId, userId)
      for (let i = 0; i < owned.length; i += 100) {
        const { error } = await client.storage.from(bucket).remove!(owned.slice(i, i + 100).map(path))
        if (error) throw new Error(`Could not delete the pictures: ${error.message}`)
      }
      return owned.length
    },
  }
}

/** The calls Teovo makes on a Cloudflare R2 bucket binding. */
export interface R2Like {
  put(key: string, value: Uint8Array, opts: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>
  list?(opts: { prefix: string; cursor?: string; include?: ('customMetadata')[] }): Promise<{ objects: { key: string; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string }>
  delete?(keys: string[]): Promise<void>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; uploaded: Date } | null>
}

/** Pictures in a Cloudflare R2 bucket, keyed by tenant and id, with the owner in the object's metadata. */
export function r2Files(bucket: R2Like): FileStore {
  return {
    async put(f) {
      await bucket.put(`${f.tenantId}/${f.id}`, f.bytes, {
        httpMetadata: { contentType: f.mediaType },
        customMetadata: { userId: f.userId, threadId: f.threadId, ...(f.filename ? { filename: f.filename } : {}) },
      })
    },
    async removeFor(tenantId, userId) {
      if (!bucket.list || !bucket.delete) return 0
      let n = 0, cursor: string | undefined
      do {
        const page = await bucket.list({ prefix: `${tenantId}/`, ...(cursor ? { cursor } : {}), include: ['customMetadata'] })
        const keys = page.objects.filter((o) => userId === undefined || o.customMetadata?.userId === userId).map((o) => o.key)
        if (keys.length) { await bucket.delete(keys); n += keys.length }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return n
    },
    async get(tenantId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const o = await bucket.get(`${tenantId}/${id}`)
      if (!o) return null
      const m = o.customMetadata ?? {}
      return {
        id, tenantId, userId: m.userId ?? '', threadId: m.threadId ?? '', mediaType: o.httpMetadata?.contentType ?? 'application/octet-stream',
        ...(m.filename ? { filename: m.filename } : {}), bytes: new Uint8Array(await o.arrayBuffer()), createdAt: o.uploaded.toISOString(),
      }
    },
  }
}
