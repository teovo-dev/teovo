import type { Storage, StoredCard, Thread } from '@teovo/server'
import type { UIMessage } from 'ai'
import type { Query } from './migrate'

const thread = (r: any): Thread => ({ id: r.id, tenantId: r.tenant_id, userId: r.user_id, title: r.title, createdAt: new Date(r.created_at).toISOString() })

/**
 * Storage on Postgres through any query function (node-postgres Pool, a Drizzle/pg client, a Cloudflare
 * Hyperdrive client…). Run `migrate` first. Threads are only ever found by tenant and user together.
 */
export function postgresStorage(query: Query): Storage {
  return {
    async getThread(tenantId, userId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const r = await query('select * from tv_threads where id = $1 and tenant_id = $2 and user_id = $3 and archived_at is null', [id, tenantId, userId])
      return r.rows[0] ? thread(r.rows[0]) : null
    },
    async createThread(tenantId, userId) {
      const r = await query('insert into tv_threads (id, tenant_id, user_id) values ($1, $2, $3) returning *', [crypto.randomUUID(), tenantId, userId])
      return thread(r.rows[0])
    },
    async listMessages(threadId) {
      const r = await query('select id, role, parts, metadata from tv_messages where thread_id = $1 order by seq', [threadId])
      return r.rows.map((m) => ({ id: m.id, role: m.role, parts: m.parts, ...(m.metadata ? { metadata: m.metadata } : {}) }) as UIMessage)
    },
    async saveMessages(threadId, messages) {
      for (const m of messages) {
        await query(
          `insert into tv_messages (id, thread_id, role, parts, metadata) values ($1, $2, $3, $4, $5)
           on conflict (thread_id, id) do update set parts = excluded.parts, metadata = excluded.metadata`,
          [m.id, threadId, m.role, JSON.stringify(m.parts), m.metadata === undefined ? null : JSON.stringify(m.metadata)])
      }
    },
    async saveCard(c: StoredCard) {
      await query(
        `insert into tv_proposals (id, thread_id, run_id, kind, title, before, after, payload, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do update set status = excluded.status`,
        [c.id, c.threadId, c.runId, c.kind, c.title, json(c.before), json(c.after), json(c.payload), c.status])
    },
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
