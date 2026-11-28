import { Fragment, useCallback, useEffect, useState } from 'react'
import { useAssistant } from './provider.js'

/** A run as GET …/runs lists it. */
export interface RunSummary {
  id: string; threadId: string; userId: string; model?: string; promptVersion?: string
  status: 'running' | 'done' | 'failed' | 'stopped'; startedAt: string; finishedAt?: string; error?: string
  rating?: 1 | -1 | null; ratingNote?: string
  /** The message it answers; older runs have only the conversation's title. */
  question?: string; title?: string | null
  usage: Partial<Record<'messages' | 'input_tokens' | 'output_tokens' | 'neurons', number>>
}
export interface RunStep {
  seq: number; type: 'tool' | 'check'; name: string; toolCallId?: string
  input?: unknown; output?: unknown; truncated: boolean; error?: string; durationMs: number; at?: string
}
export interface RunDetail extends RunSummary { steps: RunStep[]; question?: string; reply?: string }

export interface RunViewerProps {
  /** Runs per page. Default 30. */
  limit?: number
  /** Language for dates and numbers, e.g. 'en-IN'. Default: the browser's. */
  locale?: string
  /** Show the name the app knows a person by, instead of their user id. */
  userName?: (userId: string) => string
  className?: string
}

type Filter = { status?: RunSummary['status']; rating?: 'up' | 'down' }

const STATUS: Record<RunSummary['status'], string> = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' }

/**
 * For an app's admin screen: every reply the assistant gave in this tenant, newest first, and for each one what it was
 * asked, which tools it ran with their inputs and results, what a done-check refused, what it used, and a trace to
 * download (OpenTelemetry JSON). Needs an admin (the server answers 403 otherwise) and a storage that keeps a run log.
 */
export function RunViewer(props: RunViewerProps) {
  const { request } = useAssistant()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>({})
  const [open, setOpen] = useState<string>()
  const limit = props.limit ?? 30

  const load = useCallback(async (before?: string) => {
    setLoading(true)
    setError(undefined)
    const q = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.rating ? { rating: filter.rating } : {}) })
    try {
      const res = await request(`/runs?${q}`)
      const body = (await res.json().catch(() => ({}))) as { runs?: RunSummary[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? 'The runs could not be loaded.')
      const page = body.runs ?? []
      setRuns((r) => (before ? [...r, ...page] : page))
      setMore(page.length === limit)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [request, limit, filter])
  useEffect(() => { void load() }, [load])

  const when = (iso: string) => new Intl.DateTimeFormat(props.locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  const who = (id: string) => props.userName?.(id) ?? id

  return (
    <div className={`tv-runs ${props.className ?? ''}`}>
      <div className="tv-runs-filters" role="group" aria-label="Filter runs">
        <select aria-label="Status" value={filter.status ?? ''} onChange={(e) => setFilter((f) => ({ ...f, status: (e.target.value || undefined) as Filter['status'] }))}>
          <option value="">Any status</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Rating" value={filter.rating ?? ''} onChange={(e) => setFilter((f) => ({ ...f, rating: (e.target.value || undefined) as Filter['rating'] }))}>
          <option value="">Any rating</option>
          <option value="down">Thumbs down</option>
          <option value="up">Thumbs up</option>
        </select>
        <button type="button" className="tv-runs-btn" onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>
      {error ? <div className="tv-error" role="alert">{error}</div> : null}
      {!error && !loading && !runs.length ? <div className="tv-runs-empty">No runs yet.</div> : null}
      {runs.length ? (
        <div className="tv-runs-wrap">
          <table className="tv-runs-table">
            <thead><tr><th>When</th><th>Who</th><th>Asked</th><th className="tv-runs-sm">Model</th><th>Status</th><th className="tv-runs-sm">Tokens</th><th aria-label="Rating" /></tr></thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr className={open === r.id ? 'tv-runs-open' : undefined}>
                    <td className="tv-runs-muted">{when(r.startedAt)}</td>
                    <td>{who(r.userId)}</td>
                    <td>
                      <button type="button" className="tv-runs-link" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? undefined : r.id)}>
                        {r.question || r.title || 'Untitled'}
                      </button>
                    </td>
                    <td className="tv-runs-sm tv-runs-muted">{r.model ?? '—'}</td>
                    <td><span className={`tv-runs-status tv-runs-${r.status}`}>{STATUS[r.status]}</span></td>
                    <td className="tv-runs-sm tv-runs-muted">{tokens(r.usage, props.locale)}</td>
                    <td title={r.ratingNote}>{r.rating === 1 ? '👍' : r.rating === -1 ? '👎' : ''}</td>
                  </tr>
                  {open === r.id ? <tr><td colSpan={7} className="tv-runs-detail-cell"><RunDetailView id={r.id} locale={props.locale} /></td></tr> : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {more ? <button type="button" className="tv-runs-btn tv-runs-more" disabled={loading} onClick={() => void load(runs.at(-1)!.startedAt)}>{loading ? 'Loading…' : 'Older runs'}</button> : null}
    </div>
  )
}

function tokens(u: RunSummary['usage'], locale?: string): string {
  const n = (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
  return n ? new Intl.NumberFormat(locale).format(n) : u.neurons ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(u.neurons)} neurons` : '—'
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** One run: question, reply, steps in order, and the trace download. */
function RunDetailView({ id, locale }: { id: string; locale?: string }) {
  const { request } = useAssistant()
  const [run, setRun] = useState<RunDetail>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let live = true
    void request(`/runs/${id}`).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { run?: RunDetail; error?: string }
      if (!live) return
      if (res.ok && body.run) setRun(body.run)
      else setError(body.error ?? 'This run could not be loaded.')
    }).catch(() => { if (live) setError('This run could not be loaded.') })
    return () => { live = false }
  }, [id, request])

  const download = async () => {
    const res = await request(`/runs/${id}/trace`)
    if (!res.ok) { setError('The trace could not be downloaded.'); return }
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `teovo-run-${id}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (error) return <div className="tv-error" role="alert">{error}</div>
  if (!run) return <div className="tv-runs-muted">Loading…</div>
  const ms = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : undefined
  const num = (n: number) => new Intl.NumberFormat(locale).format(n)
  return (
    <div className="tv-runs-detail">
      <dl className="tv-runs-facts">
        {run.question ? <><dt>Asked</dt><dd>{run.question}</dd></> : null}
        {run.reply ? <><dt>Reply</dt><dd className="tv-runs-reply">{run.reply}</dd></> : null}
        {run.error ? <><dt>Error</dt><dd className="tv-error">{run.error}</dd></> : null}
        {run.ratingNote ? <><dt>Feedback</dt><dd>{run.rating === -1 ? '👎 ' : '👍 '}{run.ratingNote}</dd></> : null}
        <dt>Used</dt>
        <dd>
          {[ms !== undefined ? `${(ms / 1000).toFixed(1)} s` : null, run.model, run.usage.input_tokens ? `${num(run.usage.input_tokens)} tokens in` : null,
            run.usage.output_tokens ? `${num(run.usage.output_tokens)} out` : null, run.usage.neurons ? `${num(run.usage.neurons)} neurons` : null,
            run.promptVersion ? `instructions ${run.promptVersion}` : null].filter(Boolean).join(' · ')}
        </dd>
      </dl>
      {run.steps.length ? (
        <ol className="tv-runs-steps" aria-label="Steps">
          {run.steps.map((s) => (
            <li key={s.seq} className={s.type === 'check' ? 'tv-runs-step-check' : s.error ? 'tv-runs-step-failed' : undefined}>
              <details>
                <summary>
                  <span className="tv-runs-step-name">{s.type === 'check' ? `Refused by ${s.name}` : s.name}</span>
                  <span className="tv-runs-muted">{s.type === 'check' ? s.error : s.error ? `Failed: ${s.error}` : `${num(s.durationMs)} ms`}</span>
                </summary>
                {s.input !== undefined ? <><div className="tv-runs-label">{s.type === 'check' ? 'Refused reply' : 'Input'}</div><pre>{show(s.input)}</pre></> : null}
                {s.output !== undefined ? <><div className="tv-runs-label">Result{s.truncated ? ' (cut in the log)' : ''}</div><pre>{show(s.output)}</pre></> : null}
              </details>
            </li>
          ))}
        </ol>
      ) : <div className="tv-runs-muted">No tool steps: the model answered straight away.</div>}
      <button type="button" className="tv-runs-btn" onClick={() => void download()}>Download trace</button>
    </div>
  )
}
