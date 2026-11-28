// The query tool's SQL against a real Postgres: set TEOVO_TEST_DATABASE_URL. It must give what the in-memory runner gives.
import { checkQuery, queryTool, runRows, toSql, type DataQuery, type QueryTable, type ToolContext } from '@teovo/server'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.TEOVO_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
const ctx = { identity: { tenantId: 'shop', userId: 'nisha', role: 'owner' }, db: null, untrusted: (t: string) => t } as ToolContext

const lines = [
  { order_no: 1, product: 'Sourdough', qty: 2, amount: 440, date: '2026-11-20', paid: true, note: 'Gate 2', tenant: 'shop' },
  { order_no: 1, product: 'Croissant', qty: 6, amount: 540, date: '2026-11-20', paid: true, note: null, tenant: 'shop' },
  { order_no: 2, product: 'Sourdough', qty: 1, amount: 220, date: '2026-11-25', paid: false, note: '', tenant: 'shop' },
  { order_no: 3, product: 'Truffle cake', qty: 1, amount: 950, date: '2026-11-26', paid: false, note: '50% off_today', tenant: 'shop' },
  { order_no: 9, product: 'Sourdough', qty: 50, amount: 9999, date: '2026-11-26', paid: true, note: null, tenant: 'other' },
]
const tables: Record<string, QueryTable> = {
  order_lines: {
    description: 'One row per product on an order',
    columns: { order_no: 'number', product: 'text', qty: 'number', amount: 'number', date: 'date', paid: 'boolean', note: 'text' },
    scope: (c) => ({ tenant: c.identity.tenantId }),
    rows: () => lines,
  },
}
const queries: DataQuery[] = [
  { table: 'order_lines', orderBy: [{ by: 'amount' }] },
  { table: 'order_lines', columns: ['order_no'], where: [{ column: 'note', op: 'contains', value: '50%' }] },
  { table: 'order_lines', columns: ['order_no'], where: [{ column: 'note', op: 'contains', value: 'f_t' }] },
  { table: 'order_lines', columns: ['product'], where: [{ column: 'note', op: 'empty' }], orderBy: [{ by: 'product' }] },
  { table: 'order_lines', columns: ['product', 'note'], where: [{ column: 'note', op: 'ne', value: 'Gate 2' }], orderBy: [{ by: 'note', desc: true }, { by: 'product' }] },
  { table: 'order_lines', groupBy: ['product'], totals: [{ fn: 'sum', column: 'amount', as: 'sales' }, { fn: 'count' }, { fn: 'avg', column: 'qty' }], orderBy: [{ by: 'sales', desc: true }] },
  { table: 'order_lines', totals: [{ fn: 'max', column: 'date' }, { fn: 'min', column: 'product' }, { fn: 'count', column: 'note' }] },
  { table: 'order_lines', where: [{ column: 'qty', op: 'gt', value: 100 }], totals: [{ fn: 'count' }, { fn: 'sum', column: 'amount' }] },
  { table: 'order_lines', columns: ['order_no'], where: [{ column: 'order_no', op: 'in', value: [2, 3] }, { column: 'date', op: 'gte', value: '2026-11-25' }, { column: 'paid', op: 'eq', value: false }], orderBy: [{ by: 'order_no' }] },
]

suite('queryTool on Postgres', () => {
  let pool: pg.Pool
  const schema = `q_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query(`create schema ${schema}`)
    await pool.query(`create table ${schema}.order_lines (order_no int, product text, qty int, amount numeric, date date, paid boolean, note text, tenant text)`)
    for (const l of lines) await pool.query(`insert into ${schema}.order_lines values ($1, $2, $3, $4, $5, $6, $7, $8)`, Object.values(l))
    // Dates come back as text, as the model would see them.
    pg.types.setTypeParser(1082, (v) => v)
    pg.types.setTypeParser(1700, Number)
  })
  afterAll(async () => { await pool.query(`drop schema ${schema} cascade`); await pool.end() })

  it.each(queries.map((q, i) => [i, q] as const))('query %i gives the same rows as in memory', async (_i, q) => {
    const checked = checkQuery(q, tables, ctx)
    const s = toSql(checked, `${schema}.order_lines`)
    const { rows } = await pool.query(s.text, s.params as unknown[])
    expect(rows).toEqual(runRows(checked, lines))
  })

  it('runs through the app\'s sql function inside a read-only transaction', async () => {
    const tool = queryTool({
      tables: { order_lines: { ...tables.order_lines!, rows: undefined, from: `${schema}.order_lines` } },
      sql: async (s) => {
        const c = await pool.connect()
        try {
          await c.query('begin read only')
          await c.query(`set local statement_timeout = '2s'`)
          return (await c.query(s.text, s.params as unknown[])).rows
        } finally { await c.query('rollback'); c.release() }
      },
    })
    expect(await tool.run({ table: 'order_lines', totals: [{ fn: 'sum', column: 'amount', as: 'sales' }] }, ctx)).toEqual({ rows: [{ sales: 2150 }] })
  })
})
