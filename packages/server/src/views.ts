import { z } from 'zod'
import type { Proposal, ToolContext } from './tools.js'

/**
 * A view the model can show inside its reply: it calls the `show` tool with the view's name and data, the data is
 * checked against `data`, and the panel draws it. The model never writes HTML, and a view never writes: a form's
 * submit becomes a card the user confirms, like any other change.
 */
export interface TeovoView<D = any> {
  name: string
  /** When the model should use it. */
  description: string
  data: z.ZodType<D>
}

export function defineView<D>(view: TeovoView<D>): TeovoView<D> {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(view.name)) throw new Error(`View name "${view.name}" must be lowercase letters, digits and underscores`)
  return view
}

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const choicesView = defineView({
  name: 'choices',
  description: 'Ask the user to pick one option when the request is unclear, e.g. which of two customers named Riya. Their pick comes back as their next message.',
  data: z.object({ question: z.string().max(200), options: z.array(z.object({ label: z.string().max(80) })).min(2).max(6) }),
})

export const tableView = defineView({
  name: 'table',
  description: 'Show rows the user may want to scan or sort, e.g. unpaid orders. Use the keys of each row as column keys.',
  data: z.object({
    title: z.string().max(120).optional(),
    columns: z.array(z.object({ key: z.string(), label: z.string().max(40) })).min(1).max(8),
    rows: z.array(z.record(z.string(), cell)).max(50),
  }),
})

export const recordView = defineView({
  name: 'record',
  description: 'Show one record, e.g. an order with its items, total and status.',
  data: z.object({ title: z.string().max(120), fields: z.array(z.object({ label: z.string().max(40), value: cell })).min(1).max(20) }),
})

export const formView = defineView({
  name: 'form',
  description: 'Show a filled-in form for the user to correct before it becomes a change to confirm, e.g. a new expense. `submit` must be one of the app\'s form kinds.',
  data: z.object({
    title: z.string().max(120),
    fields: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().max(40),
      type: z.enum(['text', 'number', 'date', 'select']).default('text'),
      value: z.union([z.string(), z.number(), z.null()]).optional(),
      options: z.array(z.string().max(60)).max(20).optional(),
      required: z.boolean().optional(),
    })).min(1).max(12),
    submit: z.object({ kind: z.string(), label: z.string().max(30).optional() }),
  }),
})

/** The four views every app gets: `views: builtinViews`, or add your own with `[...builtinViews, myView]`. */
export const builtinViews: readonly TeovoView[] = [choicesView, tableView, recordView, formView]

/** Turns a submitted form into the card the user confirms. Keyed by the form's `submit.kind`. Throw to refuse with a sentence. */
export type FormHandler<DB = any> = (values: Record<string, string | number | null>, ctx: ToolContext<DB>) => Promise<Proposal> | Proposal

export type FormData = z.infer<typeof formView.data>

/** Check submitted values against the form the model showed. Returns cleaned values or a sentence for the user. */
export function checkForm(form: FormData, raw: unknown): { values: Record<string, string | number | null> } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Send the form values.' }
  const given = raw as Record<string, unknown>
  const values: Record<string, string | number | null> = {}
  for (const f of form.fields) {
    const v = given[f.name]
    const empty = v === undefined || v === null || v === ''
    if (empty) {
      if (f.required) return { error: `${f.label} is required.` }
      values[f.name] = null
      continue
    }
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
      if (!Number.isFinite(n)) return { error: `${f.label} must be a number.` }
      values[f.name] = n
    } else if (f.type === 'date') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return { error: `${f.label} must be a date.` }
      values[f.name] = v
    } else if (f.type === 'select') {
      if (typeof v !== 'string' || !(f.options ?? []).includes(v)) return { error: `Pick one of the options for ${f.label}.` }
      values[f.name] = v
    } else {
      if (typeof v !== 'string') return { error: `${f.label} must be text.` }
      values[f.name] = v.slice(0, 500)
    }
  }
  return { values }
}
