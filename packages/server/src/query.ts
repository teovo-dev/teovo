// A read tool for questions the app's own tools don't cover ("sales by product last week", "customers with no order
// since August"). The model never writes SQL: it fills in a small structured query (one table, filters, groups,
// totals, order, limit). Teovo checks every table and column against the list the app gives, then either runs it over
// rows the app hands over, or builds one parameterized Postgres SELECT that the app runs through ctx.db, as the user.
import { z } from 'zod'
import { defineTool, type TeovoTool, type ToolContext } from './tools.js'

export type QueryColumnType = 'text' | 'number' | 'date' | 'boolean'

export interface QueryColumn {
  type: QueryColumnType
  /** Told to the model, e.g. 'Rupees still owed on the order'. */
  description?: string
}

export interface QueryTable<DB = any> {
  /** What a row is, told to the model, e.g. 'One row per order'. */
  description: string
  /**
   * The columns the model may see, filter, group and order by. Anything not listed can't be named in a query and is
   * never returned. A type alone ('number') is enough; add a description when the name doesn't say it all.
   */
  columns: Record<string, QueryColumn | QueryColumnType>
  /**
   * With `sql`: the table or view to read, e.g. 'shop.order_lines'. Default: the table's key. A view is the way to
   * offer a join: the model only ever reads one table.
   */
  from?: string
  /**
   * Conditions added to every query on this table, whatever the model asks, e.g.
   * `(ctx) => ({ tenant_id: ctx.identity.tenantId })`. The columns needn't be listed in `columns`. A second guard
   * on top of the database's own row rules, not a replacement for them.
   */
  scope?: (ctx: ToolContext<DB>) => Record<string, string | number | boolean>
  /**
   * Without `sql`: the rows to query, already limited to what this person may see. Teovo filters, groups and
   * totals them in memory, so keep it to a few thousand rows.
   */
  rows?: (ctx: ToolContext<DB>) => Promise<Record<string, unknown>[]> | Record<string, unknown>[]
}

/** A built statement: one SELECT with $1, $2 … parameters. */
export interface QueryStatement { text: string; params: unknown[] }

export interface QueryToolOptions<DB = any> {
  /** Default 'query_data'. */
  name?: string
  /** Default: says what the tool is for; the tables and columns are always added after it. */
  description?: string
  /** What the chat shows while it runs. Default 'Looked through the data'. */
  label?: string
  /** Roles that may use it. Omitted: every role. */
  roles?: readonly string[]
  tables: Record<string, QueryTable<DB>>
  /**
   * Run a built statement and return its rows. Run it through `ctx.db` (acting as the user), in a read-only
   * transaction with a statement timeout, e.g.
   * `(s, ctx) => ctx.db.readOnly((c) => c.query(s.text, s.params)).then((r) => r.rows)`.
   * Omitted: every table needs `rows`.
   */
  sql?: (statement: QueryStatement, ctx: ToolContext<DB>) => Promise<Record<string, unknown>[]>
  /** The most rows one query returns (the model can ask for fewer). Default 100. */
  maxRows?: number
}

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'empty', 'not_empty'] as const
const FNS = ['count', 'sum', 'avg', 'min', 'max'] as const
type Op = (typeof OPS)[number]
type Fn = (typeof FNS)[number]
type Value = string | number | boolean

export interface DataQuery {
  table: string
  columns?: string[]
  where?: { column: string; op: Op; value?: Value | Value[] }[]
  groupBy?: string[]
  totals?: { fn: Fn; column?: string; as?: string }[]
  orderBy?: { by: string; desc?: boolean }[]
  limit?: number
}

/** A query that can't run, with a sentence the model can act on. */
export class QueryError extends Error {
  override name = 'QueryError'
}

/** A query after checking: every name known, every value of the right type. */
export interface CheckedQuery {
  table: string
  where: { column: string; op: Op; value?: Value | Value[] }[]
  scope: [string, Value][]
  /** Plain columns shown (with totals: the group columns). */
  columns: string[]
  groupBy: string[]
  totals: { fn: Fn; column?: string; as: string }[]
  orderBy: { by: string; desc: boolean }[]
  limit: number
}

const NAME = /^[a-z_][a-z0-9_]{0,62}$/i
const FROM = /^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/i
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/

const typeOf = (c: QueryColumn | QueryColumnType) => (typeof c === 'string' ? c : c.type)

/** Check a query against the tables, or throw a QueryError saying what to fix. */
export function checkQuery<DB>(q: DataQuery, tables: Record<string, QueryTable<DB>>, ctx: ToolContext<DB>, maxRows = 100): CheckedQuery {
  const spec = Object.hasOwn(tables, q.table) ? tables[q.table] : undefined
  if (!spec) throw new QueryError(`There is no table "${q.table}". Tables: ${Object.keys(tables).join(', ')}.`)
  const cols = spec.columns
  const known = (c: string, what: string) => {
    if (!Object.hasOwn(cols, c)) throw new QueryError(`"${q.table}" has no column "${c}" (in ${what}). Columns: ${Object.keys(cols).join(', ')}.`)
    return typeOf(cols[c]!)
  }
  const valueFor = (c: string, type: QueryColumnType, v: unknown): Value => {
    if (type === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      if (!Number.isFinite(n)) throw new QueryError(`"${c}" is a number; ${JSON.stringify(v)} is not.`)
      return n
    }
    if (type === 'boolean') {
      if (typeof v === 'boolean') return v
      if (v === 'true' || v === 'false') return v === 'true'
      throw new QueryError(`"${c}" is true or false; ${JSON.stringify(v)} is not.`)
    }
    if (type === 'date') {
      if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) throw new QueryError(`"${c}" is a date: write it as YYYY-MM-DD, not ${JSON.stringify(v)}.`)
      return v
    }
    if (typeof v !== 'string' && typeof v !== 'number') throw new QueryError(`"${c}" is text; ${JSON.stringify(v)} is not.`)
    return String(v)
  }

  const where = (q.where ?? []).map(({ column, op, value }) => {
    const type = known(column, 'where')
    if (!OPS.includes(op)) throw new QueryError(`Unknown op "${op}". Ops: ${OPS.join(', ')}.`)
    if (op === 'empty' || op === 'not_empty') return { column, op }
    if (value === undefined || value === null) throw new QueryError(`"${op}" on "${column}" needs a value.`)
    if (op === 'in') {
      const list = Array.isArray(value) ? value : [value]
      if (!list.length || list.length > 100) throw new QueryError(`"in" takes 1 to 100 values.`)
      return { column, op, value: list.map((v) => valueFor(column, type, v)) }
    }
    if (Array.isArray(value)) throw new QueryError(`Only "in" takes a list; "${op}" on "${column}" takes one value.`)
    if (op === 'contains' && type !== 'text') throw new QueryError(`"contains" is for text; "${column}" is ${type}.`)
    if (['lt', 'lte', 'gt', 'gte'].includes(op) && type === 'boolean') throw new QueryError(`"${column}" is true or false: use eq.`)
    return { column, op, value: valueFor(column, type, value) }
  })

  const groupBy = (q.groupBy ?? []).map((c) => (known(c, 'groupBy'), c))
  const totals = (q.totals ?? []).map(({ fn, column, as }) => {
    if (!FNS.includes(fn)) throw new QueryError(`Unknown total "${fn}". Totals: ${FNS.join(', ')}.`)
    if (column === undefined) {
      if (fn !== 'count') throw new QueryError(`"${fn}" needs a column.`)
    } else {
      const type = known(column, 'totals')
      if ((fn === 'sum' || fn === 'avg') && type !== 'number') throw new QueryError(`"${fn}" needs a number column; "${column}" is ${type}.`)
      if ((fn === 'min' || fn === 'max') && type === 'boolean') throw new QueryError(`"${fn}" doesn't work on true/false "${column}".`)
    }
    const name = as ?? (column ? `${fn}_${column}` : 'count')
    if (!NAME.test(name)) throw new QueryError(`"${name}" can't be a name: use letters, digits and _.`)
    return { fn, column, as: name }
  })
  const grouped = groupBy.length > 0 || totals.length > 0
  let columns = (q.columns ?? []).map((c) => (known(c, 'columns'), c))
  if (grouped) {
    const extra = columns.filter((c) => !groupBy.includes(c))
    if (extra.length) throw new QueryError(`With groupBy or totals, only group columns can be shown; add ${extra.join(', ')} to groupBy or drop them.`)
    columns = groupBy
  } else if (!columns.length) columns = Object.keys(cols)
  const names = [...columns, ...totals.map((t) => t.as)]
  if (new Set(names).size !== names.length) throw new QueryError('Two outputs have the same name: give the totals different "as" names.')
  const orderBy = (q.orderBy ?? []).map(({ by, desc }) => {
    if (!names.includes(by)) throw new QueryError(`Can only order by what is shown: ${names.join(', ')}; not "${by}".`)
    return { by, desc: !!desc }
  })
  const limit = Math.max(1, Math.min(Math.floor(q.limit ?? maxRows), maxRows))

  const scope = Object.entries(spec.scope?.(ctx) ?? {})
  for (const [c] of scope) if (!NAME.test(c)) throw new Error(`queryTool: scope column "${c}" of "${q.table}" is not a plain column name`)
  return { table: q.table, where, scope, columns, groupBy, totals, orderBy, limit }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

/** The Postgres SELECT for a checked query. Fetches one row past the limit, so the caller can tell there is more. */
export function toSql(q: CheckedQuery, from = q.table): QueryStatement {
  if (!FROM.test(from)) throw new Error(`queryTool: "${from}" is not a plain table name`)
  const params: unknown[] = []
  const p = (v: unknown) => (params.push(v), `$${params.length}`)
  const conds = [
    ...q.scope.map(([c, v]) => `${quote(c)} = ${p(v)}`),
    ...q.where.map(({ column, op, value }) => {
      const c = quote(column)
      switch (op) {
        case 'eq': return `${c} = ${p(value)}`
        case 'ne': return `${c} is distinct from ${p(value)}`
        case 'lt': return `${c} < ${p(value)}`
        case 'lte': return `${c} <= ${p(value)}`
        case 'gt': return `${c} > ${p(value)}`
        case 'gte': return `${c} >= ${p(value)}`
        case 'in': return `${c} = any(${p(value)})`
        case 'contains': return `${c} ilike ${p(`%${String(value).replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`
        case 'empty': return `(${c} is null or ${c}::text = '')`
        case 'not_empty': return `(${c} is not null and ${c}::text <> '')`
      }
    }),
  ]
  const total = (t: CheckedQuery['totals'][number]) =>
    t.fn === 'count' ? `count(${t.column ? quote(t.column) : '*'})::int` : t.fn === 'sum' || t.fn === 'avg' ? `${t.fn}(${quote(t.column!)})::float8` : `${t.fn}(${quote(t.column!)})`
  const shown = [...q.columns.map(quote), ...q.totals.map((t) => `${total(t)} as ${quote(t.as)}`)]
  const text = [
    `select ${shown.join(', ')}`,
    `from ${from.split('.').map(quote).join('.')}`,
    conds.length ? `where ${conds.join(' and ')}` : '',
    q.groupBy.length ? `group by ${q.groupBy.map(quote).join(', ')}` : '',
    q.orderBy.length ? `order by ${q.orderBy.map((o) => `${quote(o.by)} ${o.desc ? 'desc' : 'asc'} nulls last`).join(', ')}` : '',
    `limit ${q.limit + 1}`,
  ].filter(Boolean).join(' ')
  return { text, params }
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''
const isNull = (v: unknown) => v === null || v === undefined
// As Postgres: nulls go last, and '' is a value like any other.
const cmp = (a: unknown, b: unknown) => (isNull(a) ? (isNull(b) ? 0 : 1) : isNull(b) ? -1 : (a as never) < (b as never) ? -1 : (a as never) > (b as never) ? 1 : 0)

/** Run a checked query over rows in memory, the same way the SQL would. Returns up to limit + 1 rows. */
export function runRows(q: CheckedQuery, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const test = (r: Record<string, unknown>) =>
    q.scope.every(([c, v]) => r[c] === v) &&
    q.where.every(({ column, op, value }) => {
      const v = r[column]
      switch (op) {
        case 'eq': return v === value
        case 'ne': return v !== value
        case 'lt': return !isNull(v) && (v as never) < (value as never)
        case 'lte': return !isNull(v) && (v as never) <= (value as never)
        case 'gt': return !isNull(v) && (v as never) > (value as never)
        case 'gte': return !isNull(v) && (v as never) >= (value as never)
        case 'in': return (value as Value[]).includes(v as Value)
        case 'contains': return typeof v === 'string' && v.toLowerCase().includes(String(value).toLowerCase())
        case 'empty': return isEmpty(v)
        case 'not_empty': return !isEmpty(v)
      }
    })
  const kept = rows.filter(test)
  let out: Record<string, unknown>[]
  if (q.groupBy.length || q.totals.length) {
    const groups = new Map<string, Record<string, unknown>[]>()
    for (const r of kept) {
      const key = JSON.stringify(q.groupBy.map((c) => r[c] ?? null))
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    if (!q.groupBy.length && !groups.size) groups.set('[]', [])
    out = [...groups.values()].map((rs) => {
      const row: Record<string, unknown> = {}
      for (const c of q.groupBy) row[c] = rs[0]![c] ?? null
      for (const t of q.totals) {
        const vs = t.column ? rs.map((r) => r[t.column!]).filter((v) => !isNull(v)) : rs
        const nums = vs.map(Number)
        row[t.as] =
          t.fn === 'count' ? vs.length
          : !vs.length ? null
          : t.fn === 'sum' ? nums.reduce((a, b) => a + b, 0)
          : t.fn === 'avg' ? nums.reduce((a, b) => a + b, 0) / nums.length
          : vs.reduce((a, b) => (cmp(a, b) <= 0 ? (t.fn === 'min' ? a : b) : t.fn === 'min' ? b : a))
      }
      return row
    })
  } else out = kept.map((r) => Object.fromEntries(q.columns.map((c) => [c, r[c] ?? null])))
  if (q.orderBy.length) out.sort((a, b) => { for (const o of q.orderBy) { const d = cmp(a[o.by], b[o.by]); if (d) return o.desc && !isNull(a[o.by]) && !isNull(b[o.by]) ? -d : d } return 0 })
  return out.slice(0, q.limit + 1)
}

function describeTables(tables: Record<string, QueryTable>) {
  return Object.entries(tables).map(([name, t]) => {
    const cols = Object.entries(t.columns).map(([c, s]) => `${c} (${typeOf(s)}${typeof s !== 'string' && s.description ? `: ${s.description}` : ''})`)
    return `- ${name}: ${t.description}. Columns: ${cols.join(', ')}.`
  }).join('\n')
}

/**
 * A read tool that answers questions from the app's data by a checked, structured query. Prefer the app's own read
 * tools for common questions; this is for the rest. See QueryToolOptions.
 */
export function queryTool<DB = any>(options: QueryToolOptions<DB>): TeovoTool<'read', DataQuery, DB> {
  const { tables, sql, maxRows = 100 } = options
  const names = Object.keys(tables)
  if (!names.length) throw new Error('queryTool needs at least one table')
  for (const [name, t] of Object.entries(tables)) {
    if (!NAME.test(name)) throw new Error(`queryTool: table name "${name}" must be letters, digits and _`)
    for (const c of Object.keys(t.columns)) if (!NAME.test(c)) throw new Error(`queryTool: column "${c}" of "${name}" must be letters, digits and _`)
    if (!sql && !t.rows) throw new Error(`queryTool: table "${name}" needs rows, or give the tool sql`)
    if (t.from !== undefined && !FROM.test(t.from)) throw new Error(`queryTool: from "${t.from}" of "${name}" is not a plain table name`)
  }
  const value = z.union([z.string(), z.number(), z.boolean()])
  const input = z.object({
    table: z.enum(names as [string, ...string[]]),
    columns: z.array(z.string()).optional().describe('Columns to show. Default: all. With groupBy or totals, the group columns are shown.'),
    where: z.array(z.object({
      column: z.string(),
      op: z.enum(OPS).describe('eq, ne, lt, lte, gt, gte, in (value is a list), contains (text, any case), empty, not_empty'),
      value: z.union([value, z.array(value)]).optional().describe('Dates as YYYY-MM-DD'),
    })).optional().describe('All must hold'),
    groupBy: z.array(z.string()).optional(),
    totals: z.array(z.object({ fn: z.enum(FNS), column: z.string().optional().describe('Needed except for count'), as: z.string().optional() })).optional()
      .describe('Per group, or over all rows when there is no groupBy'),
    orderBy: z.array(z.object({ by: z.string().describe('A shown column or a total\'s name'), desc: z.boolean().optional() })).optional(),
    limit: z.number().int().optional().describe(`At most ${maxRows}`),
  })
  return defineTool<'read', DataQuery, DB>({
    name: options.name ?? 'query_data',
    kind: 'read',
    label: options.label ?? 'Looked through the data',
    roles: options.roles,
    description: `${options.description ?? 'Look up, filter, count and total the data when no other tool answers the question. One table per query; run several for several tables.'}\nTables:\n${describeTables(tables as Record<string, QueryTable>)}`,
    input: input as z.ZodType<DataQuery>,
    run: async (q, ctx) => {
      let checked: CheckedQuery
      try { checked = checkQuery(q, tables, ctx, maxRows) } catch (e) {
        if (e instanceof QueryError) return { error: e.message }
        throw e
      }
      const t = tables[checked.table]!
      const rows = sql && !t.rows ? await sql(toSql(checked, t.from), ctx) : runRows(checked, await t.rows!(ctx))
      const n = checked.limit
      if (rows.length <= n) return { rows }
      const more = n < maxRows ? `More rows match; these are the first ${n}, as asked.` : `Only the first ${n} rows: narrow the query or total it.`
      return { rows: rows.slice(0, n), more }
    },
  })
}
