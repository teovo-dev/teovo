import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAssistant } from './assistant'
import { defineCheck } from './checks'
import { memoryStorage, type RunDetail, type RunSummary } from './storage'
import { callTool, chat, say, scriptedModel } from './testing'
import { defineTool, type Identity } from './tools'
import { runTrace } from './trace'

const owner: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const staff: Identity = { tenantId: 'shop', userId: 'ravi', role: 'staff' }
const other: Identity = { tenantId: 'other-shop', userId: 'x', role: 'owner' }

function app() {
  const storage = memoryStorage()
  const who = { current: owner }
  const teovo = createAssistant({
    identify: () => who.current, asUser: () => null, instructions: 'Help.', storage, name: 'Oven Help',
    tools: [defineTool({ name: 'list_orders', kind: 'read', description: 'Orders', input: z.object({ unpaid: z.boolean() }), run: () => [{ no: 4, due: 250 }] })],
    // Refuses the first reply once, so the run log has a refused reply in it.
    checks: [defineCheck({ name: 'first-try', check: (r) => (r.attempt === 0 ? 'Say who it is first.' : null) })],
    models: [scriptedModel([callTool('list_orders', { unpaid: true }), say('Order 4 owes 250.'), say('Riya: order 4 owes 250.'), say('Hello!'), say('Hello again!')], { modelId: 'gemini-test' })],
  })
  const get = async (path: string, as = owner) => { who.current = as; return teovo.fetch(new Request(`https://a.test/api/assistant${path}`)) }
  return { teovo, storage, who, get }
}

describe('run viewer', () => {
  it('lists the tenant\'s runs newest first, with title, model, status and usage', async () => {
    const { teovo, get, storage } = app()
    await chat(teovo, 'who owes money?')
    await new Promise((r) => setTimeout(r, 5))
    await chat(teovo, 'hi')
    const res = await get('/runs')
    expect(res.status).toBe(200)
    const { runs } = (await res.json()) as { runs: RunSummary[] }
    expect(runs.map((r) => r.title)).toEqual(['hi', 'who owes money?'])
    expect(runs.map((r) => r.question)).toEqual(['hi', 'who owes money?'])
    expect(runs[1]).toMatchObject({ status: 'done', model: 'gemini-test', userId: 'nisha', usage: { messages: 1 } })
    expect(runs[1]!.finishedAt).toBeTruthy()
    // Filters and paging.
    await storage.rateRun('shop', 'nisha', runs[1]!.id, -1, 'wrong customer')
    const down = (await (await get('/runs?rating=down')).json()) as { runs: RunSummary[] }
    expect(down.runs.map((r) => r.id)).toEqual([runs[1]!.id])
    expect(down.runs[0]).toMatchObject({ rating: -1, ratingNote: 'wrong customer' })
    const older = (await (await get(`/runs?before=${encodeURIComponent(runs[0]!.startedAt)}`)).json()) as { runs: RunSummary[] }
    expect(older.runs.map((r) => r.id)).toEqual([runs[1]!.id])
    expect(((await (await get('/runs?status=failed')).json()) as { runs: RunSummary[] }).runs).toEqual([])
  })

  it('shows one run: question, reply, tool steps and the refused reply, in order', async () => {
    const { teovo, get } = app()
    const out = await chat(teovo, 'who owes money?')
    expect(out.text).toBe('Riya: order 4 owes 250.')
    const { runs } = (await (await get('/runs')).json()) as { runs: RunSummary[] }
    const { run } = (await (await get(`/runs/${runs[0]!.id}`)).json()) as { run: RunDetail & { question: string; reply: string } }
    expect(run.question).toBe('who owes money?')
    expect(run.reply).toBe('Riya: order 4 owes 250.')
    expect(run.steps.map((s) => [s.type, s.name])).toEqual([['tool', 'list_orders'], ['check', 'first-try']])
    expect(run.steps[0]).toMatchObject({ input: { unpaid: true }, output: [{ no: 4, due: 250 }] })
    expect(run.steps[1]).toMatchObject({ input: 'Order 4 owes 250.', error: 'Say who it is first.' })
  })

  it('downloads a run as an OpenTelemetry trace', async () => {
    const { teovo, get } = app()
    await chat(teovo, 'who owes money?')
    const { runs } = (await (await get('/runs')).json()) as { runs: RunSummary[] }
    const res = await get(`/runs/${runs[0]!.id}/trace`)
    expect(res.headers.get('content-disposition')).toContain(`teovo-run-${runs[0]!.id}.json`)
    const trace = (await res.json()) as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] }; scopeSpans: { spans: { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] }
    expect(trace.resourceSpans[0]!.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'Oven Help' } })
    const spans = trace.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(spans.map((s) => s.name)).toEqual(['chat gemini-test', 'execute_tool list_orders', 'check first-try'])
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([runs[0]!.id.replace(/-/g, '')]))
    expect(spans.slice(1).every((s) => s.parentSpanId === spans[0]!.spanId)).toBe(true)
    for (const s of spans) expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true)
    expect(spans[1]!.attributes).toContainEqual({ key: 'gen_ai.tool.call.arguments', value: { stringValue: '{"unpaid":true}' } })
    expect(spans[0]!.attributes).toContainEqual({ key: 'teovo.usage.messages', value: { intValue: '1' } })
    // The same trace from the server, e.g. to send to a collector.
    expect(await teovo.trace('shop', runs[0]!.id)).toEqual(trace)
    expect(await teovo.trace('other-shop', runs[0]!.id)).toBeNull()
  })

  it('is for admins of the same tenant only', async () => {
    const { teovo, get } = app()
    await chat(teovo, 'who owes money?')
    const { runs } = (await (await get('/runs')).json()) as { runs: RunSummary[] }
    expect((await get('/runs', staff)).status).toBe(403)
    expect((await get(`/runs/${runs[0]!.id}/trace`, staff)).status).toBe(403)
    expect(((await (await get('/runs', other)).json()) as { runs: unknown[] }).runs).toEqual([])
    expect((await get(`/runs/${runs[0]!.id}`, other)).status).toBe(404)
  })

  it('answers 501 for a storage that keeps no run log to browse', async () => {
    const { listRuns: _l, getRun: _g, ...rest } = memoryStorage()
    const teovo = createAssistant({ identify: () => owner, asUser: () => null, instructions: '', storage: rest, tools: [], models: [scriptedModel([])] })
    expect((await teovo.fetch(new Request('https://a.test/runs'))).status).toBe(501)
  })
})

describe('runTrace', () => {
  it('marks a failed run and a failed tool as errors; a refused reply is not one', () => {
    const run: RunDetail = {
      id: '11111111-2222-3333-4444-555555555555', threadId: 't', tenantId: 'shop', userId: 'u', status: 'failed', error: 'model down',
      startedAt: '2026-11-28T10:00:00.000Z', finishedAt: '2026-11-28T10:00:03.000Z', usage: {},
      steps: [
        { runId: 'r', seq: 0, type: 'tool', name: 'list_orders', truncated: false, error: 'db timeout', durationMs: 500, at: '2026-11-28T10:00:01.000Z' },
        { runId: 'r', seq: 1, type: 'check', name: 'c', truncated: false, error: 'bad', durationMs: 0, at: '2026-11-28T10:00:02.000Z' },
      ],
    }
    const spans = (runTrace(run).resourceSpans[0] as { scopeSpans: { spans: { status: { code: number; message?: string }; startTimeUnixNano: string }[] }[] }).scopeSpans[0]!.spans
    expect(spans.map((s) => s.status.code)).toEqual([2, 2, 0])
    expect(spans[0]!.status.message).toBe('model down')
    expect(spans[1]!.startTimeUnixNano).toBe(`${Date.parse('2026-11-28T10:00:00.500Z')}000000`)
  })
})
