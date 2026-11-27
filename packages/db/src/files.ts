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
  } }
}

/**
 * Pictures in a private Supabase Storage bucket, under <tenant>/<user>/<thread>/<id>. Teovo serves them itself
 * (GET …/files/:id checks the owner), so the bucket stays private. A small metadata row in tv_files (without bytes)
 * is not needed: the path holds the owner. Expire them with a Storage lifecycle rule or your own job.
 */
export function supabaseFiles(client: SupabaseStorageLike, bucket: string, index: { put(f: Omit<StoredFile, 'bytes'>): Promise<void>; get(tenantId: string, id: string): Promise<Omit<StoredFile, 'bytes'> | null> }): FileStore {
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
  }
}

/** The calls Teovo makes on a Cloudflare R2 bucket binding. */
export interface R2Like {
  put(key: string, value: Uint8Array, opts: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>
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
