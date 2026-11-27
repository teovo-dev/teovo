import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { Formats, TeovoMessage } from './types.js'

type Cell = string | number | boolean | null

export interface ViewPart<D = any> { id: string; view: string; data: D; submitted?: string; values?: Record<string, Cell> }

/** What a view component gets. `ask` sends text as the user's next message; `submit` sends a form. */
export interface ViewProps<D = any> {
  part: ViewPart<D>
  /** False once the conversation has moved on past this reply (e.g. a choice was already made). */
  current: boolean
  ask: (text: string) => void
  submit: (values: Record<string, Cell>) => Promise<void>
  /** The tenant's formats for this reply, when the server sent them. */
  formats?: Formats
}

export type CellFormat = 'text' | 'number' | 'money' | 'date'

/** Write a value the way the tenant does: ₹1,250.00, 27 Nov 2026. Falls back to the value as text. */
export function formatValue(v: Cell | undefined, format: CellFormat | undefined, f: Formats | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const locale = f?.locale
  try {
    if (format === 'money' && typeof v === 'number') return new Intl.NumberFormat(locale, { style: 'currency', currency: f?.currency ?? 'USD' }).format(v)
    if (format === 'number' && typeof v === 'number') return new Intl.NumberFormat(locale).format(v)
    if (format === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      // A bare date is a calendar day, not a moment: draw it in UTC so it never shifts a day.
      const tz = v.length === 10 ? 'UTC' : f?.timeZone
      return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(v.length === 10 ? `${v}T00:00:00Z` : v))
    }
  } catch { /* fall through to plain text */ }
  return String(v)
}

export type ViewComponent<D = any> = (props: ViewProps<D>) => ReactNode

function Choices({ part, current, ask }: ViewProps<{ question: string; options: { label: string }[] }>) {
  return (
    <div className="tv-view tv-choices" role="group" aria-label={part.data.question}>
      <div className="tv-view-title">{part.data.question}</div>
      <div className="tv-choices-options">
        {part.data.options.map((o) => <button key={o.label} type="button" disabled={!current} onClick={() => ask(o.label)}>{o.label}</button>)}
      </div>
    </div>
  )
}

function Table({ part, formats }: ViewProps<{ title?: string; columns: { key: string; label: string; format?: CellFormat }[]; rows: Record<string, Cell>[] }>) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const rows = useMemo(() => {
    if (!sort) return part.data.rows
    return [...part.data.rows].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key]
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))
      return c * sort.dir
    })
  }, [part.data.rows, sort])
  return (
    <div className="tv-view tv-table">
      {part.data.title ? <div className="tv-view-title">{part.data.title}</div> : null}
      <table>
        <thead><tr>{part.data.columns.map((c) => (
          <th key={c.key} scope="col" aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
            <button type="button" onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 1 ? -1 : 1 }))}>{c.label}</button>
          </th>
        ))}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{part.data.columns.map((c) => <td key={c.key} data-format={c.format}>{formatValue(r[c.key], c.format, formats)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function Record({ part, formats }: ViewProps<{ title: string; fields: { label: string; value: Cell; format?: CellFormat }[] }>) {
  return (
    <div className="tv-view tv-record" role="group" aria-label={part.data.title}>
      <div className="tv-view-title">{part.data.title}</div>
      <dl>{part.data.fields.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{formatValue(f.value, f.format, formats)}</dd></div>)}</dl>
    </div>
  )
}

interface FormField { name: string; label: string; type?: 'text' | 'number' | 'date' | 'select'; value?: string | number | null; options?: string[]; required?: boolean }

// The button always says Continue, whatever the model asked for ("Record expense" would claim it is done): sending
// the form only prepares a card, which the user then confirms.
function Form({ part, submit }: ViewProps<{ title: string; fields: FormField[]; submit: { label?: string } }>) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(part.data.fields.map((f) => [f.name, String(part.values?.[f.name] ?? f.value ?? '')])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const sent = Boolean(part.submitted)
  async function send(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try { await submit(values) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  return (
    <form className="tv-view tv-form" aria-label={part.data.title} onSubmit={send}>
      <div className="tv-view-title">{part.data.title}</div>
      {part.data.fields.map((f) => (
        <label key={f.name}>
          <span>{f.label}{f.required ? ' *' : ''}</span>
          {f.type === 'select' ? (
            <select value={values[f.name]} disabled={sent} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
              <option value="">—</option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input type={f.type === 'number' ? 'text' : f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
              value={values[f.name]} disabled={sent} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          )}
        </label>
      ))}
      {error ? <div className="tv-error" role="alert">{error}</div> : null}
      {sent ? <div className="tv-card-done">Sent</div> : <button type="submit" disabled={busy}>Continue</button>}
    </form>
  )
}

/** The panel's own drawing of the four built-in views. Pass `views` to AssistantPanel to replace or add to them. */
export const defaultViews: Record<string, ViewComponent> = { choices: Choices, table: Table, record: Record, form: Form }

/** True when no user message came after this one. */
export const isCurrent = (messages: TeovoMessage[], id: string) => {
  const i = messages.findIndex((m) => m.id === id)
  return i >= 0 && !messages.slice(i + 1).some((m) => m.role === 'user')
}
