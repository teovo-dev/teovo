import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { UIMessage } from 'ai'
import { createAssistant, INTERRUPTED, type AssistantConfig } from './assistant'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel, type Step } from './testing'
import { defineTool, type Identity } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'staff' }
const ravi: Identity = { tenantId: 'shop', userId: 'ravi', role: 'staff' }

/** A promise a test opens when it wants: a tool that waits on it is a reply still being written. */
function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => { open = r })
  return { p, open }
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

type Mem = ReturnType<typeof memoryStorage>

/** One server of the app: its own assistant, sharing the storage (the database) with the others. */
function server(storage: Mem, steps: Step[], opts: { slow?: Promise<void>; runs?: AssistantConfig['runs']; who?: { current: Identity } } = {}) {
  const who = opts.who ?? { current: nisha }
  const model = scriptedModel(steps, { modelId: 'gemini-test' })
  const teovo = createAssistant({
    identify: () => who.current, asUser: () => ({ db: 'request' }), instructions: 'Help.', storage, models: [model],
    tools: [
      defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({}), run: () => [{ no: 4, due: 250 }] }),
      defineTool({ name: 'add_up', kind: 'read', description: 'Adds up', input: z.object({}), run: async () => { await opts.slow; return { total: 250 } } }),
    ],
    runs: { heartbeatMs: 10, pollMs: 10, flushMs: 5, asUser: () => ({ db: 'worker' }), ...opts.runs },
  })
  return { teovo, model, who }
}

const send = (teovo: { fetch: (r: Request) => Promise<Response> }, text: string, threadId?: string) => teovo.fetch(new Request('https://a.test/api/assistant/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ threadId, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } }),
}))
const get = (teovo: { fetch: (r: Request) => Promise<Response> }, path: string, method = 'GET') => teovo.fetch(new Request(`https://a.test/api/assistant${path}`, { method }))

/** Reads a reply's stream as the panel does, and keeps every chunk. */
function reader(res: Response) {
  const chunks: { type: string; [k: string]: unknown }[] = []
  let buf = ''
  const body = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  const done = (async () => {
    for (;;) {
      const { done, value } = await body.read()
      if (done) return
      buf += value
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const l of lines) if (l.startsWith('data: ') && l !== 'data: [DONE]') chunks.push(JSON.parse(l.slice(6)))
    }
  })()
  const text = () => chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')
  return { chunks, done, text, cancel: () => body.cancel() }
}

const runOf = (storage: Mem) => [...storage.runs.values()].at(-1)!
const reply = async (storage: Mem, threadId: string) => (await storage.listMessages(threadId)).filter((m) => m.role === 'assistant').at(-1)

describe('long runs', () => {
  it('a queued reply streams like any other and ends done in the run log', async () => {
    const storage = memoryStorage()
    const { teovo } = server(storage, [callTool('list_orders', {}), say('Order 4 owes 250.')])
    const out = await chat(teovo, 'who owes money?')
    expect(out.text).toBe('Order 4 owes 250.')
    expect(out.tools).toEqual(['list_orders'])
    expect(runOf(storage)).toMatchObject({ status: 'done', attempts: 1 })
    expect((await reply(storage, out.threadId!))?.parts.some((p) => p.type === 'text')).toBe(true)
  })

  it('goes on after the panel closes, and is saved', async () => {
    const storage = memoryStorage()
    const slow = gate()
    const { teovo } = server(storage, [callTool('add_up', {}), say('It comes to 250.')], { slow: slow.p })
    const res = await send(teovo, 'add it up')
    const threadId = res.headers.get('x-teovo-thread')!
    const r = reader(res)
    await until(() => r.chunks.some((c) => c.type === 'data-step'))
    await r.cancel()   // the panel is closed mid-reply
    slow.open()
    await until(() => runOf(storage).status === 'done')
    const saved = await reply(storage, threadId)
    expect(saved?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(['It comes to 250.'])
  })

  it('is stopped from another server, and saved as stopped', async () => {
    const storage = memoryStorage()
    const slow = gate()
    const a = server(storage, [callTool('add_up', {}), say('never')], { slow: slow.p })
    const b = server(storage, [])
    const res = await send(a.teovo, 'add it up')
    const threadId = res.headers.get('x-teovo-thread')!
    const r = reader(res)
    await until(() => r.chunks.some((c) => c.type === 'data-step'))
    const runId = runOf(storage).id
    // Not someone else's to stop.
    b.who.current = ravi
    expect((await get(b.teovo, `/runs/${runId}/stop`, 'POST')).status).toBe(404)
    b.who.current = nisha
    expect((await get(b.teovo, `/runs/${runId}/stop`, 'POST')).status).toBe(200)
    await until(() => runOf(storage).status === 'stopped')
    await r.done
    expect((await reply(storage, threadId))?.metadata).toMatchObject({ stopped: true })
    slow.open()
  })

  it('after a reply stopped in the middle of a tool, the conversation goes on', async () => {
    const storage = memoryStorage()
    const slow = gate()
    const a = server(storage, [callTool('add_up', {}), say('All fine.')], { slow: slow.p })
    const res = await send(a.teovo, 'add it up')
    const threadId = res.headers.get('x-teovo-thread')!
    const r = reader(res)
    await until(() => r.chunks.some((c) => c.type === 'data-step'))
    await get(a.teovo, `/threads/${threadId}/stop`, 'POST')
    await r.done
    expect(runOf(storage).status).toBe('stopped')
    slow.open()
    // The saved reply has a tool call with no result; the next message must not trip over it.
    expect((await chat(a.teovo, 'anything else?', { threadId, url: 'https://a.test/api/assistant/chat' })).text).toBe('All fine.')
    expect(JSON.stringify(a.model.doStreamCalls[1]!.prompt)).not.toContain('add_up')
  })

  it('a server that stops answering is taken over from its last finished step', async () => {
    const storage = memoryStorage()
    const stuck = gate()
    // Server A runs list_orders, then hangs in add_up and stops renewing its lease (a crash, as far as anyone can tell).
    const a = server(storage, [callTool('list_orders', {}), callTool('add_up', {}), say('A late answer')], { slow: stuck.p, runs: { heartbeatMs: 60_000, leaseMs: 40 } })
    const b = server(storage, [say('Order 4 owes 250.')])
    const res = await send(a.teovo, 'who owes money?')
    const threadId = res.headers.get('x-teovo-thread')!
    const r = reader(res)
    await until(() => r.chunks.filter((c) => c.type === 'data-step').length >= 3)   // list_orders done, add_up running
    await until(async () => (await storage.queue.waiting(5)).length === 1)        // its lease ran out
    expect((await get(b.teovo, `/threads/${threadId}`).then((x) => x.json()) as { running?: string }).running).toBe(runOf(storage).id)
    // A reload, on server B, while nobody holds the run: the reply so far (A's list_orders)…
    const early = reader(await get(b.teovo, `/threads/${threadId}/stream`))
    await until(() => early.chunks.some((c) => c.type === 'tool-output-available'))
    expect(await b.teovo.work()).toBe(1)
    // …until B picks it up: then the panel is told to read it afresh.
    await early.done
    expect(early.chunks.at(-1)).toMatchObject({ type: 'data-resumed' })
    // B's try starts with what A finished, then carries on.
    const kept = (await storage.queue.events(runOf(storage).id, 2, -1)).flatMap((e) => e.chunks as { type: string; delta?: string }[])
    expect(kept.filter((c) => c.type === 'tool-output-available')).toHaveLength(1)
    expect(kept.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe('Order 4 owes 250.')
    expect(kept.some((c) => c.type === 'tool-input-start' && JSON.stringify(c).includes('add_up'))).toBe(false)
    // B's model saw what A had found, and was not asked to run it again.
    expect(JSON.stringify(b.model.doStreamCalls[0]!.prompt)).toContain('"due":250')
    expect(runOf(storage)).toMatchObject({ status: 'done', attempts: 2 })
    const saved = await reply(storage, threadId)
    expect(saved?.parts.filter((p) => p.type.startsWith('tool-')).map((p) => p.type)).toEqual(['tool-list_orders'])
    expect(saved?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(['Order 4 owes 250.'])
    // A wakes up: it finds it no longer holds the run, so it changes nothing, and tells its panel to read the reply afresh.
    stuck.open()
    await r.done
    expect(r.chunks.at(-1)).toMatchObject({ type: 'data-resumed' })
    expect(runOf(storage).status).toBe('done')
    expect((await reply(storage, threadId))?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(['Order 4 owes 250.'])
    expect((await get(b.teovo, `/threads/${threadId}/stream`)).status).toBe(204)
  })

  it('with inline: false, a worker runs it and the request sends it from the log', async () => {
    const storage = memoryStorage()
    const api = server(storage, [], { runs: { inline: false } })
    const w = server(storage, [callTool('list_orders', {}), say('Order 4 owes 250.')])
    const worker = w.teovo.startWorker({ pollMs: 10 })
    try {
      const out = await chat(api.teovo, 'who owes money?')
      expect(out.text).toBe('Order 4 owes 250.')
      expect(out.tools).toEqual(['list_orders'])
      expect(api.model.doStreamCalls).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })

  it('a queued reply that is stopped never starts', async () => {
    const storage = memoryStorage()
    const api = server(storage, [], { runs: { inline: false } })
    const res = await send(api.teovo, 'hi')
    const r = reader(res)
    await until(() => runOf(storage).job !== undefined)
    expect((await get(api.teovo, `/runs/${runOf(storage).id}/stop`, 'POST')).status).toBe(200)
    await r.done
    expect(runOf(storage).status).toBe('stopped')
    expect(await server(storage, []).teovo.work()).toBe(0)
  })

  it('gives up with a sentence after maxAttempts, or when no server can act as the person', async () => {
    for (const runs of [{ maxAttempts: 1 }, { asUser: undefined }]) {
      const storage = memoryStorage()
      const stuck = gate()
      const a = server(storage, [callTool('add_up', {}), say('late')], { slow: stuck.p, runs: { heartbeatMs: 60_000, leaseMs: 30 } })
      const b = server(storage, [], { runs })
      const res = await send(a.teovo, 'add it up')
      const threadId = res.headers.get('x-teovo-thread')!
      await until(async () => (await storage.queue.waiting(5)).length === 1)
      expect(await b.teovo.work()).toBe(1)
      expect(runOf(storage).status).toBe('failed')
      expect((await reply(storage, threadId))?.parts).toEqual([{ type: 'text', text: INTERRUPTED }])
      stuck.open()
      await res.body!.cancel()
    }
  })

  it('a worker that shuts down hands its runs back at once, and another carries them on', async () => {
    const storage = memoryStorage()
    const stuck = gate()
    const api = server(storage, [], { runs: { inline: false } })
    const a = server(storage, [callTool('list_orders', {}), callTool('add_up', {}), say('late')], { slow: stuck.p })
    const b = server(storage, [say('Order 4 owes 250.')])
    const wa = a.teovo.startWorker({ pollMs: 10 })
    const res = await send(api.teovo, 'who owes money?')
    const threadId = res.headers.get('x-teovo-thread')!
    await until(() => storage.steps.some((s) => s.name === 'list_orders'))
    await until(async () => (await storage.queue.events(runOf(storage).id, 1, -1)).some((e) => (e.chunks as { type: string }[]).some((c) => c.type === 'finish-step')))
    const stopping = wa.stop({ waitMs: 20 })
    await until(async () => (await storage.queue.waiting(5)).length === 1)   // handed back, no lease to wait out
    stuck.open()
    await stopping
    expect(await b.teovo.work()).toBe(1)
    expect((await reply(storage, threadId))?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(['Order 4 owes 250.'])
    await res.body!.cancel()
  })

  it('exactly one of many servers claims a run', async () => {
    const storage = memoryStorage()
    await storage.startRun({ id: 'r1', threadId: 't', tenantId: 'shop', userId: 'nisha', status: 'queued' })
    expect(await storage.queue.claim('r1', 'w', 1000)).toBeNull()   // no job yet: not ready to take
    await storage.queue.enqueue('r1', { identity: nisha, messageId: 'm', models: ['x'] })
    const got = await Promise.all(Array.from({ length: 10 }, (_, i) => storage.queue.claim('r1', `w${i}`, 1000)))
    expect(got.filter(Boolean)).toHaveLength(1)
  })

  it('replies without runs work as before: no queue, Stop answers 501', async () => {
    const storage = memoryStorage()
    const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: '', storage, tools: [], models: [scriptedModel([say('Hi.')])] })
    expect((await chat(teovo, 'hi')).text).toBe('Hi.')
    expect(runOf(storage).job).toBeUndefined()
    expect((await get(teovo, `/runs/${runOf(storage).id}/stop`, 'POST')).status).toBe(501)
    expect(((await get(teovo, '/policy').then((r) => r.json())) as { longRuns?: boolean }).longRuns).toBeUndefined()
    const _typed: UIMessage | undefined = undefined
    void _typed
  })
})
