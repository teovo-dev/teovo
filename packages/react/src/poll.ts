import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

/** What the polling transport needs from the provider. */
export interface PollOptions<M extends UIMessage> {
  endpoint: string
  fetch: () => typeof fetch
  headers: () => Promise<Record<string, string>>
  /** The request body for a new message (the same one the streaming transport sends). */
  body: (messages: M[]) => Record<string, unknown>
  /** Every response, so the provider can pick up the thread id. */
  seen: (res: Response) => void
  threadId: () => string | undefined
  /** How long one poll may wait on the server for more. Default 20 s (under most hosts' 30 s limit). */
  waitMs?: number
}

const sentence = async (res: Response) => (await res.text().catch(() => '')) || `The request failed (${res.status}).`

/**
 * The long-poll transport, for hosts that hold back streamed responses (Firebase Hosting, some proxies): the message
 * is sent with a plain request that answers at once with the run's id, and the reply is read in batches with
 * GET …/runs/:id/poll, each a short request that answers as soon as there is more. Needs long runs on the server.
 */
export function pollTransport<M extends UIMessage>(o: PollOptions<M>): ChatTransport<M> {
  const base = () => o.endpoint.replace(/\/$/, '')

  function read(runId: string, signal?: AbortSignal): ReadableStream<UIMessageChunk> {
    return new ReadableStream<UIMessageChunk>({
      async start(c) {
        let attempt: number | undefined
        let after = -1
        try {
          while (!signal?.aborted) {
            const q = new URLSearchParams({ after: String(after), wait: String(o.waitMs ?? 20_000), ...(attempt !== undefined ? { attempt: String(attempt) } : {}) })
            const res = await o.fetch()(`${base()}/runs/${runId}/poll?${q}`, { headers: await o.headers(), signal })
            if (!res.ok) throw new Error(await sentence(res))
            const b = (await res.json()) as { attempt: number; events: { seq: number; chunks: UIMessageChunk[] }[]; done: boolean; reset?: boolean }
            // Picked up again by another server: the panel drops what it has and reads the reply afresh.
            if (b.reset) { c.enqueue({ type: 'data-resumed', data: {}, transient: true } as UIMessageChunk); break }
            if (attempt !== b.attempt) { attempt = b.attempt; after = -1 }
            for (const e of b.events) { for (const chunk of e.chunks) c.enqueue(chunk); after = e.seq }
            if (b.done) break
          }
          c.close()
        } catch (e) {
          if (signal?.aborted) c.close()
          else c.error(e)
        }
      },
    })
  }

  return {
    async sendMessages({ messages, abortSignal }) {
      const res = await o.fetch()(`${base()}/chat`, {
        method: 'POST', signal: abortSignal,
        headers: { 'content-type': 'application/json', ...(await o.headers()) },
        body: JSON.stringify({ ...o.body(messages), transport: 'poll' }),
      })
      o.seen(res)
      if (!res.ok) throw new Error(await sentence(res))
      const { runId } = (await res.json()) as { runId: string }
      return read(runId, abortSignal)
    },
    async reconnectToStream() {
      const id = o.threadId()
      if (!id) return null
      const res = await o.fetch()(`${base()}/threads/${id}`, { headers: await o.headers() })
      if (!res.ok) return null
      const { running } = (await res.json()) as { running?: string }
      return running ? read(running) : null
    },
  }
}
