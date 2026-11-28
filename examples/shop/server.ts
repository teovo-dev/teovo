// The Teovo example shop's server: a small bakery (shop.ts, kept in memory), with Teovo's assistant mounted at /api/assistant.
// Conversations, cards, runs and usage go to Postgres (TEOVO_DATABASE_URL); the model is Gemini (GEMINI_API_KEY).
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai'
import { migrate, postgresFiles, postgresStorage } from '@teovo/db'
import { builtinViews, createAssistant, defineCheck, defineReader, defineTool, noClaimedChanges, type Identity, type SpendRules } from '@teovo/server'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import pg from 'pg'
import { z } from 'zod'
import { customerOf, customerStats, daysAgo, due, order, orderView, paid, product, productName, sales, shop, stockState, STATUSES, today, type Method, type Status } from './shop.js'

// .env next to this file: GEMINI_API_KEY and TEOVO_DATABASE_URL. Never committed.
for (const line of (() => { try { return readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n') } catch { return [] } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!
}
const key = process.env.GEMINI_API_KEY
if (!key) throw new Error('Set GEMINI_API_KEY in examples/shop/.env')
const dbUrl = process.env.TEOVO_DATABASE_URL
if (!dbUrl) throw new Error('Set TEOVO_DATABASE_URL in examples/shop/.env')

// ---------- Teovo -------------------------------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=teovo_demo' })
await pool.query('create schema if not exists teovo_demo')
const query = (text: string, params?: unknown[]) => pool.query(text, params as unknown[])
console.log('migrations applied:', await migrate(query, { features: { proposals: true, files: true } }))

const google = createGoogleGenerativeAI({ apiKey: key })
// Gemini 2.5 Flash, left to set its own thinking budget, ended about half its steps with nothing at all in a by-hand
// count (Teovo asks again, but each blank costs a round trip). A fixed budget of 1024 tokens halved that and kept the
// answers right; turning thinking off cut blanks further but got "who owes the most?" wrong.
const flash = wrapLanguageModel({ model: google('gemini-2.5-flash'), middleware: defaultSettingsMiddleware({ settings: { providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } } } }) })

/** For trying long runs by hand: DEMO_SLOW_TOOLS_MS=8000 npm run server makes every tool take that long. */
function slowly<T extends { run: (...a: any[]) => unknown }>(tools: T[]): T[] {
  const ms = Number(process.env.DEMO_SLOW_TOOLS_MS ?? 0)
  return ms ? tools.map((t) => ({ ...t, run: async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, ms)); return t.run(...a) } })) : tools
}

const demoWallet: SpendRules | undefined = process.env.DEMO_CREDITS ? (() => {
  let balance = Number(process.env.DEMO_CREDITS)
  const holds = new Map<string, number>()
  return {
    hold: 1,
    cost: (u) => Math.max(1, Math.ceil(((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) / 5000)),
    reserve: ({ runId, amount, first }) => {
      if (first && holds.has(runId)) return true
      if (amount > balance) return first ? `The shop has ${balance} credit${balance === 1 ? '' : 's'} left; a reply needs ${amount}. Add more on the billing page.` : false
      balance -= amount
      holds.set(runId, (holds.get(runId) ?? 0) + amount)
      console.log(`[credits] held ${amount} for ${runId.slice(0, 8)}${first ? '' : ' (more)'}; ${balance} left`)
      return true
    },
    settle: ({ runId, status, cost, used }) => {
      const held = holds.get(runId) ?? 0
      const charge = status === 'done' ? Math.min(held, cost ?? held) : 0
      balance += held - charge
      holds.delete(runId)
      console.log(`[credits] ${runId.slice(0, 8)} ${status}: used ${JSON.stringify(used)}, charged ${charge}, gave back ${held - charge}; ${balance} left`)
    },
  }
})() : undefined

const teovo = createAssistant({
  // The demo picks the user from a header the page sends; a real app reads its session here.
  identify: (req): Identity => {
    const who = req.headers.get('x-demo-user') === 'staff' ? 'staff' : 'owner'
    return { tenantId: 'demo-shop', userId: `demo-${who}`, role: who }
  },
  asUser: (identity) => ({ role: identity.role }),
  models: [flash, google('gemini-2.5-flash-lite')],
  // Short "who…?" look-ups ("who owes money?") go to the cheaper flash-lite first. Not "show…" or amounts: flash-lite
  // misread "how much does X owe?" and went silent after reading the customer note on Riya Sharma's order in by-hand
  // checks. Anything longer, with a picture, or deep in a conversation keeps Flash. Each list still falls back.
  route: ({ text, history }) => (text.length <= 60 && history < 6 && !/[?]\s*\S/.test(text) && /^who\b/i.test(text.trim())
    ? [google('gemini-2.5-flash-lite'), flash]
    : undefined),
  // The assistant's name: the model is told it, and the panel shows it ("Ask Teovo").
  name: 'Teovo',
  instructions: 'You help the owner and staff of Little Oven, a small bakery, run the shop: orders, payments, customers, ' +
    'stock and expenses. Be brief. Use the tools for every number; never guess. To change anything, use a propose tool: ' +
    'the user confirms it on a card. Show lists of orders, customers or products as a table. "This week" means the last 7 days. ' +
    '"Who owes money" means customers with money due: answer it straight from list_customers, without asking which list.',
  storage: postgresStorage(query),
  // Long runs: a reply goes on when the panel closes, Stop works from any server, and a reply this server was writing
  // when it stopped is carried on from its last finished step by the next server to start (startWorker below).
  runs: { asUser: (identity) => ({ role: identity.role }), leaseMs: 10_000 },
  // For trying the spend hold by hand: DEMO_CREDITS=3 npm run server gives the shop 3 credits. A reply holds 1, costs
  // 1 per 5,000 tokens it uses (raised as it goes), and is charged when it finishes; a stopped or failed one costs nothing.
  ...(demoWallet ? { spend: demoWallet } : {}),
  formats: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' },
  limits: { user: { messages: 200 } },
  // Done-checks: a reply is held until it passes these. Teovo's own catches "Payment recorded" next to a card that
  // still waits for Confirm; the shop's own refuses an amount in rupees when no tool was asked for one.
  checks: [
    noClaimedChanges,
    defineCheck({
      name: 'amounts-from-tools',
      check: (r) => (/₹\s?\d/.test(r.text) && !r.toolCalls.length && !r.cards.length
        ? 'It gives an amount in rupees without looking anything up. Use the tools for every number, then answer.'
        : null),
    }),
    // For seeing a refusal by hand: DEMO_REFUSE_FIRST=1 npm run server refuses every first reply once.
    ...(process.env.DEMO_REFUSE_FIRST ? [defineCheck({ name: 'demo-refuse-first', check: (r) => (r.attempt === 0 ? 'Start the reply with "Checked:".' : null) })] : []),
  ],
  // For trying the stalled-reply timeout by hand: DEMO_FIRST_CHUNK_MS=300 npm run server. Default: Teovo's (30 s).
  ...(process.env.DEMO_FIRST_CHUNK_MS ? { timeouts: { firstChunkMs: Number(process.env.DEMO_FIRST_CHUNK_MS) } } : {}),
  attachments: {},
  // Pictures go to tv_files, not into the conversation; kept 30 days (call teovo.removeOldFiles() daily).
  files: { store: postgresFiles(query), keepDays: 30 },
  redact: { fields: ['phone'], patterns: ['phone', 'email', 'upi'] },
  views: builtinViews,
  screens: [
    { path: '/dashboard', title: 'Dashboard', description: 'sales, money to collect, today\'s orders and low stock at a glance' },
    { path: '/orders', title: 'Orders', description: 'all orders, their status and what is due', filters: { unpaid: "'yes' to show only orders with money due", status: 'New, Baking, Ready or Delivered' } },
    { path: '/orders/:no', title: 'Order', description: 'one order: items, payments, note' },
    { path: '/customers', title: 'Customers', description: 'everyone who orders, with what they spent and owe' },
    { path: '/customers/:id', title: 'Customer', description: 'one customer and their orders' },
    { path: '/products', title: 'Products', description: 'prices and stock', filters: { low: "'yes' to show only products running low or out of stock" } },
    { path: '/expenses', title: 'Expenses', description: 'money spent, by category' },
  ],
  // Readers: fill the expense form from a note, a recording or a bill photo (Expenses → Quick add). Same models and
  // limits as the chat; the form is filled for the user to check, nothing is saved until they press Save.
  readers: [
    defineReader({
      name: 'expense', accepts: ['text', 'image', 'audio'],
      schema: z.object({
        amount: z.number().nullable(), vendor: z.string().nullable(), category: z.enum(['Ingredients', 'Packaging', 'Rent', 'Utilities', 'Wages', 'Equipment', 'Other']).nullable(),
        date: z.string().nullable(), method: z.enum(['Cash', 'UPI', 'Card', 'Bank']).nullable(), question: z.string().nullable(),
      }),
      instructions: 'Read one expense of a small bakery from a note, a recording or a bill photo. amount: the total paid in rupees. vendor: who was paid. ' +
        'date: YYYY-MM-DD ("yesterday" counts back from today); null if not said. method: how it was paid, if said. question: a short question when the amount is missing, else null.',
      after: (r) => ({ ...r, date: r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date <= today() ? r.date : today() }),
    }),
  ],
  // Voice to text for the chat's microphone and the Quick add microphone: Gemini hears it, in English.
  voice: { hint: 'expenses and orders of a small bakery: milk, butter, flour, croissants, cakes; paid by UPI or cash' },
  tools: slowly([
    defineTool({
      name: 'list_orders', kind: 'read',
      description: 'Orders with customer, status, items, total, paid, due and the customer note. Filters: unpaidOnly (money due), status, customer (part of a name), from (YYYY-MM-DD, placed on or after).',
      input: z.object({ unpaidOnly: z.boolean().nullish(), status: z.enum(STATUSES as [Status, ...Status[]]).nullish(), customer: z.string().nullish(), from: z.string().nullish() }),
      run: ({ unpaidOnly, status, customer, from }, ctx) => shop.orders
        .filter((o) => (!unpaidOnly || due(o) > 0) && (!status || o.status === status) && (!from || o.date >= from)
          && (!customer || customerOf(o).name.toLowerCase().includes(customer.toLowerCase())))
        .map((o) => ({ no: o.no, customer: customerOf(o).name, date: o.date, status: o.status,
          items: o.items.map((i) => `${i.qty} × ${productName(i.productId)}`).join(', '), total: o.total, paid: paid(o), due: due(o),
          note: o.note ? ctx.untrusted(o.note, 'customer note') : undefined })),
      // Under the answer: a link to each order it used (a long list links to the Orders screen instead).
      links: (rows: { no: number }[], { unpaidOnly }) => (rows.length <= 4 ? rows.map((o) => ({ label: `Order #${o.no}`, to: `/orders/${o.no}` })) : [{ label: unpaidOnly ? 'Unpaid orders' : 'Orders', to: unpaidOnly ? '/orders?unpaid=yes' : '/orders' }]),
    }),
    defineTool({
      name: 'get_order', kind: 'read', description: 'One order: customer, status, items, total, payments, paid, due, date and the customer note if any.',
      input: z.object({ no: z.number() }),
      run: ({ no }, ctx) => { const o = orderView(order(no)); return { ...o, note: o.note ? ctx.untrusted(o.note, 'customer note') : undefined } },
      links: (o: { no: number }) => [{ label: `Order #${o.no}`, to: `/orders/${o.no}` }],
    }),
    defineTool({
      name: 'list_customers', kind: 'read', description: 'Customers with id (for the Customer screen), type, phone, number of orders, total spent, money due and last order date. name filters by part of the name.',
      input: z.object({ name: z.string().nullish() }),
      run: ({ name }) => shop.customers.filter((c) => !name || c.name.toLowerCase().includes(name.toLowerCase()))
        .map((c) => ({ id: c.id, name: c.name, type: c.type, phone: c.phone, ...customerStats(c) })),
      links: (rows: { name: string }[]) => (rows.length <= 3 ? rows.map((r) => ({ label: r.name, to: `/customers/${shop.customers.find((c) => c.name === r.name)!.id}` })) : [{ label: 'Customers', to: '/customers' }]),
    }),
    defineTool({
      name: 'list_products', kind: 'read', description: 'Products with price, stock and whether they are running low. lowOnly for those running low or out of stock.',
      input: z.object({ lowOnly: z.boolean().nullish() }),
      run: ({ lowOnly }) => shop.products.filter((p) => !lowOnly || stockState(p) !== 'In stock')
        .map((p) => ({ name: p.name, price: p.price, stock: p.stock, unit: p.unit, state: stockState(p) })),
      links: (_rows, { lowOnly }) => [{ label: lowOnly ? 'Products running low' : 'Products', to: lowOnly ? '/products?low=yes' : '/products' }],
    }),
    defineTool({
      name: 'sales_summary', kind: 'read',
      description: 'Sales between two dates (YYYY-MM-DD, inclusive; default the last 7 days): number of orders, their value, money collected, expenses, and the best sellers.',
      input: z.object({ from: z.string().nullish(), to: z.string().nullish() }),
      run: ({ from, to }) => sales(from ?? daysAgo(6), to ?? today()),
    }),
    defineTool({
      name: 'list_expenses', kind: 'read', description: 'Expenses with vendor, category, date and how they were paid. Filters: from (YYYY-MM-DD), category.',
      input: z.object({ from: z.string().nullish(), category: z.string().nullish() }),
      run: ({ from, category }) => shop.expenses.filter((e) => (!from || e.date >= from) && (!category || e.category.toLowerCase() === category.toLowerCase()))
        .sort((a, b) => b.date.localeCompare(a.date)),
      links: () => [{ label: 'Expenses', to: '/expenses' }],
    }),
    defineTool({
      name: 'record_payment', kind: 'propose', description: 'Prepare recording a payment against an order. method: Cash, UPI, Card or Bank (default Cash).',
      input: z.object({ no: z.number(), amount: z.number().positive(), method: z.enum(['Cash', 'UPI', 'Card', 'Bank']).optional() }),
      run: ({ no, amount, method = 'Cash' }) => {
        const o = order(no)
        if (amount > due(o)) throw new Error(`Order #${no} has only ₹${due(o)} due.`)
        return { kind: 'record_payment', title: `Payment ₹${amount} by ${method} for order #${no} (${customerOf(o).name})`, before: { paid: paid(o) }, after: { paid: paid(o) + amount }, payload: { no, amount, method }, fields: [{ key: 'paid', label: 'Paid', format: 'money' as const }] }
      },
    }),
    defineTool({
      name: 'settle_orders', kind: 'propose', description: 'Prepare marking several orders as paid in full, as one card.',
      input: z.object({ nos: z.array(z.number()).min(2).max(20) }),
      run: ({ nos }) => {
        const list = nos.map(order).filter((o) => due(o) > 0)
        if (list.length < 2) throw new Error('Fewer than two of those orders have money due; record a single payment instead.')
        return {
          kind: 'settle_orders', title: `Mark ${list.length} orders paid in full`, payload: { nos: list.map((o) => o.no) },
          fields: [{ key: 'paid', label: 'Paid', format: 'money' as const }],
          items: list.map((o) => ({ label: `#${o.no} ${customerOf(o).name}`, before: { paid: paid(o) }, after: { paid: o.total } })),
        }
      },
    }),
    defineTool({
      name: 'set_status', kind: 'propose', description: 'Prepare moving an order to another status: New, Baking, Ready or Delivered.',
      input: z.object({ no: z.number(), status: z.enum(STATUSES as [Status, ...Status[]]) }),
      run: ({ no, status }) => {
        const o = order(no)
        if (o.status === status) throw new Error(`Order #${no} is already ${status}.`)
        return { kind: 'set_status', title: `Order #${no} (${customerOf(o).name}): ${o.status} → ${status}`, before: { status: o.status }, after: { status }, payload: { no, status }, fields: [{ key: 'status', label: 'Status' }] }
      },
    }),
    defineTool({
      name: 'restock', kind: 'propose', description: 'Prepare adding freshly baked or bought stock to a product (qty is how many to add).',
      input: z.object({ product: z.string(), qty: z.number().int().positive() }),
      run: ({ product: name, qty }) => {
        const p = product(name)
        return { kind: 'restock', title: `Add ${qty} to ${p.name}`, before: { stock: p.stock }, after: { stock: p.stock + qty }, payload: { id: p.id, qty }, fields: [{ key: 'stock', label: 'In stock' }] }
      },
    }),
    defineTool({
      name: 'change_total', kind: 'propose', roles: ['owner'], description: 'Prepare changing an order total (a discount or a correction).',
      input: z.object({ no: z.number(), total: z.number().positive() }),
      run: ({ no, total }) => ({ kind: 'change_total', title: `Order #${no} total ₹${order(no).total} → ₹${total}`, before: { total: order(no).total }, after: { total }, payload: { no, total }, fields: [{ key: 'total', label: 'Total', format: 'money' as const }] }),
    }),
  ]),
  forms: {
    expense: {
      fields: ['amount', 'vendor', 'category', 'date', 'method'],
      description: 'a new expense; category is Ingredients, Packaging, Rent, Utilities, Wages or Equipment as a select; method is Cash, UPI, Card or Bank as a select',
      handle: (v) => ({
        kind: 'add_expense', title: `Expense to ${v.vendor ?? 'unknown'}`, after: v, payload: v,
        fields: [{ key: 'amount', label: 'Amount', format: 'money' as const }, { key: 'vendor', label: 'Vendor' }, { key: 'category', label: 'Category' }, { key: 'date', label: 'Date', format: 'date' as const }, { key: 'method', label: 'Paid by' }],
      }),
    },
  },
  cards: {
    record_payment: {
      current: ({ no }: { no: number }) => ({ paid: paid(order(no)) }),
      apply: ({ no, amount, method = 'Cash' }: { no: number; amount: number; method?: Method }) => {
        const id = shop.nextPayment()
        order(no).payments.push({ id, amount, date: today(), method })
        return { undo: { no, id } }
      },
      undo: (u) => { const { no, id } = u as { no: number; id: number }; const o = order(no); o.payments = o.payments.filter((p) => p.id !== id) },
    },
    settle_orders: {
      apply: ({ nos }: { nos: number[] }) => {
        const added = nos.map((no) => { const id = shop.nextPayment(); const o = order(no); o.payments.push({ id, amount: due(o), date: today(), method: 'Cash' }); return { no, id } })
        return { undo: added }
      },
      undo: (u) => { for (const { no, id } of u as { no: number; id: number }[]) { const o = order(no); o.payments = o.payments.filter((p) => p.id !== id) } },
    },
    set_status: {
      current: ({ no }: { no: number }) => ({ status: order(no).status }),
      apply: ({ no, status }: { no: number; status: Status }) => { const o = order(no); const old = o.status; o.status = status; return { undo: { no, old } } },
      undo: (u) => { const { no, old } = u as { no: number; old: Status }; order(no).status = old },
    },
    restock: {
      current: ({ id }: { id: string }) => ({ stock: product(id).stock }),
      apply: ({ id, qty }: { id: string; qty: number }) => { product(id).stock += qty; return { undo: { id, qty } } },
      undo: (u) => { const { id, qty } = u as { id: string; qty: number }; product(id).stock -= qty },
    },
    change_total: {
      roles: ['owner'],
      current: ({ no }: { no: number }) => ({ total: order(no).total }),
      apply: ({ no, total }: { no: number; total: number }) => { const o = order(no); const old = o.total; o.total = total; return { undo: { no, old } } },
      undo: (u) => { const { no, old } = u as { no: number; old: number }; order(no).total = old },
    },
    add_expense: {
      apply: (v: Record<string, string | number | null>) => {
        const id = Math.max(0, ...shop.expenses.map((e) => e.id)) + 1
        shop.expenses.push({ id, amount: Number(v.amount), vendor: String(v.vendor ?? ''), category: String(v.category ?? 'Other'), date: String(v.date || today()), method: (String(v.method ?? 'Cash') as Method) })
        return { undo: id }
      },
      undo: (id) => { shop.expenses = shop.expenses.filter((e) => e.id !== id) },
    },
  },
  // What the open record is, so "what is due here?" needs no look-up.
  screen: (page) => {
    if (page.record?.type === 'order') {
      const o = shop.orders.find((x) => x.no === Number(page.record!.id))
      return o ? `Order #${o.no} for ${customerOf(o).name}: ${o.status}, total ₹${o.total}, paid ₹${paid(o)}, due ₹${due(o)}, placed ${o.date}.` : null
    }
    if (page.record?.type === 'customer') {
      const c = shop.customers.find((x) => x.id === page.record!.id)
      if (!c) return null
      const s = customerStats(c)
      return `Customer ${c.name} (${c.type}): ${s.orders} orders, spent ₹${s.spent}, owes ₹${s.due}.`
    }
    return null
  },
  // The message box completes customer and product names and the shop's own words as people type (no model call).
  completions: () => shop.customers.map((c) => c.name).concat(shop.products.map((p) => p.name), ['Milk depot', 'UPI', 'Cash', 'unpaid orders', 'expenses this week', 'running low']),
  suggestions: ({ page, after }) => {
    if (after) return { suggestions: ['Who still owes money?', 'What is running low?'] }
    if (page?.record?.type === 'order') return { suggestions: [`What is due on order #${page.record.id}?`, 'Record a payment', 'Mark it ready'], placeholder: `Ask about order #${page.record.id}` }
    if (page?.record?.type === 'customer') return { suggestions: ['What do they owe?', 'What do they usually buy?'], placeholder: 'Ask about this customer' }
    if (page?.path === '/expenses') return { suggestions: ['Spent ₹450 on milk today', 'Expenses this week'], placeholder: 'Add or ask about expenses' }
    if (page?.path === '/products') return { suggestions: ['What is running low?', 'We baked 24 cinnamon rolls'], placeholder: 'Ask about stock' }
    if (page?.path === '/customers') return { suggestions: ['Who are our best customers?', 'Who owes money?'] }
    return { suggestions: ['How did we do this week?', 'Who owes money?'], examples: ['Who owes the most?', 'Riya K paid 100 by UPI', 'What sold best this week?', 'What is running low?'] }
  },
  on: {
    error: (e) => console.error('[teovo error]', e instanceof Error ? e.message : e),
    modelSwitch: (from, e) => console.warn(`[teovo] ${from} failed (${e instanceof Error ? e.message : e}); trying the backup`),
    check: (c) => console.warn(`[teovo] check ${c.name} refused a reply (try ${c.attempt + 1}${c.final ? ', last' : ''}): ${c.problem}`),
  },
})

// ---------- HTTP ----------------------------------------------------------------------------------------------------
async function toRequest(req: IncomingMessage, res: ServerResponse): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  // The browser hanging up (Stop, closing the tab) shows on the response, not the request, whose body is already
  // read. Passing it on as the request's signal is what makes Teovo stop the model instead of paying for the rest.
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ac.abort() })
  return new Request(`http://localhost${req.url}`, {
    method: req.method, headers: req.headers as Record<string, string>, signal: ac.signal,
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  })
}

async function send(res: ServerResponse, r: Response) {
  res.writeHead(r.status, Object.fromEntries(r.headers))
  if (!r.body) return res.end()
  const reader = r.body.getReader()
  res.on('close', () => { void reader.cancel().catch(() => {}) })
  for (;;) { const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined })); if (done) break; res.write(value) }
  res.end()
}

const port = Number(process.env.PORT ?? 8788)
createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/assistant/')) return await send(res, await teovo.fetch(await toRequest(req, res)))
    if (req.url === '/api/shop/expenses' && req.method === 'POST') {
      // The Quick add form's Save: what the person checked and saved (the reader only filled the form).
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const v = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { amount?: number; vendor?: string; category?: string; date?: string; method?: Method }
      if (!(Number(v.amount) > 0) || !v.vendor?.trim()) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Amount and vendor are needed.' })) }
      const id = Math.max(0, ...shop.expenses.map((e) => e.id)) + 1
      shop.expenses.push({ id, amount: Number(v.amount), vendor: v.vendor.trim(), category: v.category || 'Other', date: v.date || today(), method: v.method || 'Cash' })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id }))
    }
    if (req.url === '/api/shop') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        today: today(),
        orders: shop.orders.map(orderView),
        customers: shop.customers.map((c) => ({ ...c, ...customerStats(c) })),
        products: shop.products.map((p) => ({ ...p, state: stockState(p) })),
        expenses: shop.expenses,
      }))
    }
    res.writeHead(404).end()
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}).listen(port, () => console.log(`Teovo example shop API on http://localhost:${port}`))

// Picks up replies a stopped or crashed server left (and on shutdown hands this one's back for the next).
const worker = teovo.startWorker()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void worker.stop({ waitMs: 3000 }).then(() => process.exit(0)) })
