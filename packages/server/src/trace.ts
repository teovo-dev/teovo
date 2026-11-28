import type { RunDetail } from './storage.js'

/**
 * A run as an OpenTelemetry trace, in OTLP JSON (what an OTLP/HTTP collector takes at /v1/traces, and what Jaeger,
 * Grafana Tempo, Honeycomb or Langfuse import). One root span for the run and one child span per step, named and
 * tagged after OpenTelemetry's generative-AI conventions (gen_ai.*). The trace id is the run id.
 */
export interface OtlpTrace { resourceSpans: unknown[] }

type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { boolValue: boolean } }
const attrs = (o: Record<string, string | number | boolean | undefined | null>): Attr[] => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(Math.round(v)) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } }))

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`
const hex = (n: number) => n.toString(16).padStart(16, '0')
const text = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v))

/** Status codes: 1 OK, 2 ERROR. */
const status = (error?: string) => (error ? { code: 2, message: error.slice(0, 500) } : { code: 1 })

export function runTrace(run: RunDetail, opts: { service?: string } = {}): OtlpTrace {
  const traceId = run.id.replace(/-/g, '').toLowerCase()
  const start = Date.parse(run.startedAt)
  const lastStep = run.steps.reduce((t, s) => Math.max(t, s.at ? Date.parse(s.at) : 0), 0)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Math.max(start, lastStep)
  const rootId = hex(1)
  const failed = run.status === 'failed' ? run.error ?? 'failed' : undefined
  const root = {
    traceId, spanId: rootId, name: `chat${run.model ? ` ${run.model}` : ''}`, kind: 1,
    startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
    attributes: attrs({
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': run.model, 'gen_ai.response.model': run.model,
      'gen_ai.usage.input_tokens': run.usage.input_tokens, 'gen_ai.usage.output_tokens': run.usage.output_tokens,
      'gen_ai.conversation.id': run.threadId,
      'teovo.run.status': run.status, 'teovo.tenant.id': run.tenantId, 'teovo.user.id': run.userId,
      'teovo.prompt.version': run.promptVersion, 'teovo.rating': run.rating ?? undefined, 'teovo.rating.note': run.ratingNote,
      'teovo.usage.messages': run.usage.messages, 'teovo.usage.neurons': run.usage.neurons,
    }),
    status: status(failed),
  }
  const spans = run.steps.map((s, i) => {
    const stepEnd = s.at ? Date.parse(s.at) : end
    const isCheck = s.type === 'check'
    return {
      traceId, spanId: hex(i + 2), parentSpanId: rootId, kind: 1,
      name: isCheck ? `check ${s.name}` : `execute_tool ${s.name}`,
      startTimeUnixNano: nanos(Math.max(start, stepEnd - s.durationMs)), endTimeUnixNano: nanos(stepEnd),
      attributes: attrs(isCheck
        ? { 'teovo.check.name': s.name, 'teovo.check.refused': text(s.input), 'teovo.check.problem': s.error }
        : {
            'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': s.name, 'gen_ai.tool.call.id': s.toolCallId,
            'gen_ai.tool.call.arguments': text(s.input), 'gen_ai.tool.call.result': text(s.output), 'teovo.step.truncated': s.truncated || undefined,
          }),
      // A refused reply is not an error of the run; a tool that threw is.
      status: isCheck ? { code: 0 } : status(s.error),
    }
  })
  return {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': opts.service ?? 'teovo' }) },
      scopeSpans: [{ scope: { name: '@teovo/server' }, spans: [root, ...spans] }],
    }],
  }
}
