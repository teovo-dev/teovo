import { describe, expect, it } from 'vitest'
import { createAssistant } from './assistant'
import { checkQuery, queryTool, runRows, toSql, type DataQuery, type QueryTable } from './query'
import { memoryStorage } from './storage'
import { callTool, chat, say, scriptedModel } from './testing'
import type { Identity, ToolContext } from './tools'

const nisha: Identity = { tenantId: 'shop', userId: 'nisha', role: 'owner' }
const ctx = { identity: nisha, db: null, untrusted: (t: string) => t } as ToolContext

const lines = [
  { order_no: 1, product: 'Sourdough', qty: 2, amount: 440, date: '2026-11-20', paid: true, note: 'Gate 2', tenant: 'shop', phone: '98450 11223' },
  { order_no: 1, product: 'Croissant', qty: 6, amount: 540, date: '2026-11-20', paid: true, note: null, tenant: 'shop', phone: '98450 11223' },
  { order_no: 2, product: 'Sourdough', qty: 1, amount: 220, date: '2026-11-25', paid: false, note: '', tenant: 'shop', phone: '90080 70060' },
  { order_no: 3, product: 'Truffle cake', qty: 1, amount: 950, date: '2026-11-26', paid: false, note: 'Write "Happy 50"', tenant: 'shop', phone: '90080 70060' },
  { order_no: 9, product: 'Sourdough', qty: 50, amount: 9999, date: '2026-11-26', paid: true, note: null, tenant: 'other', phone: '1' },
]
const tables: Record<string, QueryTable> = {
  order_lines: {
    description: 'One row per product on an order',
    columns: { order_no: 'number', product: 'text', qty: 'number', amount: { type: 'number', description: 'Rupees' }, date: 'date', paid: 'boolean', note: 'text' },
    scope: (c) => ({ tenant: c.identity.tenantId }),
    rows: () => lines,
  },
}
const run = (q: DataQuery, max?: number) => runRows(checkQuery(q, tables, ctx, max), lines)

describe('queryTool: checked, structured queries instead of SQL', () => {
  it('filters, shows only listed columns and never the other tenant\'s rows', () => {
    expect(run({ table: 'order_lines', columns: ['order_no', 'product'], where: [{ column: 'product', op: 'contains', value: 'sour' }] }))
      .toEqual([{ order_no: 1, product: 'Sourdough' }, { order_no: 2, product: 'Sourdough' }])
    // Every listed column by default; the phone and tenant are not listed, so never come back.
    expect(Object.keys(run({ table: 'order_lines' })[0]!)).toEqual(['order_no', 'product', 'qty', 'amount', 'date', 'paid', 'note'])
    expect(run({ table: 'order_lines', where: [{ column: 'note', op: 'empty' }] }).map((r) => r.product)).toEqual(['Croissant', 'Sourdough'])
    expect(run({ table: 'order_lines', where: [{ column: 'date', op: 'gte', value: '2026-11-25' }, { column: 'paid', op: 'eq', value: 'false' }] }).map((r) => r.order_no)).toEqual([2, 3])
  })

  it('groups and totals, and orders by a total', () => {
    expect(run({ table: 'order_lines', groupBy: ['product'], totals: [{ fn: 'sum', column: 'amount', as: 'sales' }, { fn: 'count' }], orderBy: [{ by: 'sales', desc: true }] }))
      .toEqual([{ product: 'Croissant', sales: 540, count: 1 }, { product: 'Sourdough', sales: 660, count: 2 }, { product: 'Truffle cake', sales: 950, count: 1 }].sort((a, b) => b.sales - a.sales))
    expect(run({ table: 'order_lines', totals: [{ fn: 'sum', column: 'amount' }, { fn: 'max', column: 'date' }, { fn: 'avg', column: 'qty' }] }))
      .toEqual([{ sum_amount: 2150, max_date: '2026-11-26', avg_qty: 2.5 }])
    expect(run({ table: 'order_lines', where: [{ column: 'qty', op: 'gt', value: 100 }], totals: [{ fn: 'count' }, { fn: 'sum', column: 'amount' }] })).toEqual([{ count: 0, sum_amount: null }])
  })

  it('refuses anything not listed, with a sentence the model can act on', () => {
    const bad = (q: Partial<DataQuery>) => { try { checkQuery({ table: 'order_lines', ...q }, tables, ctx); return 'ran' } catch (e) { return (e as Error).message } }
    expect(bad({ table: 'users' })).toBe('There is no table "users". Tables: order_lines.')
    expect(bad({ table: 'constructor' })).toContain('There is no table')
    expect(bad({ columns: ['phone'] })).toContain('"order_lines" has no column "phone" (in columns)')
    expect(bad({ where: [{ column: 'tenant', op: 'eq', value: 'other' }] })).toContain('has no column "tenant"')
    expect(bad({ where: [{ column: 'amount', op: 'gt', value: 'lots' }] })).toBe('"amount" is a number; "lots" is not.')
    expect(bad({ where: [{ column: 'date', op: 'gt', value: 'last week' }] })).toBe('"date" is a date: write it as YYYY-MM-DD, not "last week".')
    expect(bad({ where: [{ column: 'qty', op: 'contains', value: 1 }] })).toContain('"contains" is for text')
    expect(bad({ totals: [{ fn: 'sum', column: 'product' }] })).toContain('needs a number column')
    expect(bad({ columns: ['product'], totals: [{ fn: 'count' }] })).toContain('only group columns can be shown')
    expect(bad({ orderBy: [{ by: 'phone' }] })).toContain('Can only order by what is shown')
    expect(bad({ totals: [{ fn: 'count', as: 'x; drop table' }] })).toContain("can't be a name")
  })

  it('caps rows and says when there are more', async () => {
    const tool = queryTool({ tables, maxRows: 2 })
    expect(await tool.run({ table: 'order_lines', columns: ['order_no'], limit: 50 }, ctx)).toEqual({ rows: [{ order_no: 1 }, { order_no: 1 }], more: 'Only the first 2 rows: narrow the query or total it.' })
    expect(await tool.run({ table: 'order_lines', columns: ['order_no'], limit: 1 }, ctx)).toEqual({ rows: [{ order_no: 1 }], more: 'More rows match; these are the first 1, as asked.' })
    expect(await tool.run({ table: 'order_lines', columns: ['order_no'], where: [{ column: 'order_no', op: 'in', value: [3] }] }, ctx)).toEqual({ rows: [{ order_no: 3 }] })
    expect(await tool.run({ table: 'order_lines', columns: ['phone'] }, ctx)).toEqual({ error: expect.stringContaining('no column "phone"') })
  })

  it('builds one parameterized SELECT: names quoted from the list, every value a parameter', () => {
    const q = checkQuery({
      table: 'order_lines', groupBy: ['product'], totals: [{ fn: 'sum', column: 'amount', as: 'sales' }, { fn: 'count' }],
      where: [{ column: 'note', op: 'contains', value: "50%'; drop table x; --" }, { column: 'order_no', op: 'in', value: [1, '2'] }, { column: 'paid', op: 'ne', value: true }],
      orderBy: [{ by: 'sales', desc: true }], limit: 10,
    }, tables, ctx)
    expect(toSql(q, 'shop.order_lines')).toEqual({
      text: 'select "product", sum("amount")::float8 as "sales", count(*)::int as "count" from "shop"."order_lines" where "tenant" = $1 and "note" ilike $2 and "order_no" = any($3) and "paid" is distinct from $4 group by "product" order by "sales" desc nulls last limit 11',
      params: ['shop', "%50\\%'; drop table x; --%", [1, 2], true],
    })
    expect(() => toSql(q, 'x; drop table y')).toThrow('not a plain table name')
  })

  it('checks the tables when it is made', () => {
    expect(() => queryTool({ tables: {} })).toThrow('at least one table')
    expect(() => queryTool({ tables: { t: { description: '', columns: { 'a b': 'text' }, rows: () => [] } } })).toThrow('column "a b"')
    expect(() => queryTool({ tables: { t: { description: '', columns: { a: 'text' } } } })).toThrow('needs rows, or give the tool sql')
    expect(() => queryTool({ tables: { t: { description: '', columns: { a: 'text' }, from: 'a;b' } }, sql: async () => [] })).toThrow('not a plain table name')
  })

  it('in a reply: the model sees the tables, the result is redacted like any read', async () => {
    const storage = memoryStorage()
    const model = scriptedModel([
      callTool('query_data', { table: 'order_lines', columns: ['order_no', 'note'], where: [{ column: 'order_no', op: 'eq', value: 3 }] }),
      say('Order 3 asks for "Happy 50".'),
    ])
    const teovo = createAssistant({ identify: () => nisha, asUser: () => null, instructions: 'Help.', storage, models: [model], tools: [queryTool({ tables })], redact: { patterns: ['phone'] } })
    expect((await chat(teovo, 'what does order 3 say?')).text).toBe('Order 3 asks for "Happy 50".')
    const tool = (model.doStreamCalls[0]!.tools as { name: string; description?: string }[]).find((t) => t.name === 'query_data')!
    expect(tool.description).toContain('- order_lines: One row per product on an order. Columns: order_no (number), product (text), qty (number), amount (number: Rupees)')
    expect(storage.steps.find((s) => s.name === 'query_data')!.output).toEqual({ rows: [{ order_no: 3, note: 'Write "Happy 50"' }] })
  })
})
