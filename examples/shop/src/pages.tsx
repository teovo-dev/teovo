import { RunViewer, useAssistant, useAssistantContext, useReader, VoiceButton } from '@teovo/react'
import { useEffect, useState } from 'react'
import { addDays, ago, longDate, money, shortDate, type Expense, type Order, type Product, type Shop, type Status } from './data.js'
import { Avatar, Empty, Icon, Meter, PageHead, Pill, Stat, Tabs, payState } from './ui.js'

/** Opens the assistant, and sends the text if there is one (Teovo's ask). */
const useAsk = () => { const { ask } = useAssistant(); return (text?: string) => void ask(text) }
const go = (to: string) => { location.hash = to }

function AskButton({ text, children }: { text?: string; children: string }) {
  const ask = useAsk()
  return <button type="button" className="btn btn-soft" onClick={() => ask(text)}><Icon name="spark" size={16} />{children}</button>
}

function OrderRows({ orders, today, compact }: { orders: Order[]; today: string; compact?: boolean }) {
  if (!orders.length) return <Empty>No orders match.</Empty>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th>Order</th><th>Customer</th>{compact ? null : <th className="hide-sm">Items</th>}<th className="hide-sm">Placed</th><th>Status</th>
          <th className="num hide-sm">Total</th><th className="num">Due</th>
        </tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.no} className="link-row" onClick={() => go(`/orders/${o.no}`)}>
              <td className="mono"><a href={`#/orders/${o.no}`} onClick={(e) => e.stopPropagation()}>#{o.no}</a></td>
              <td><div className="who"><Avatar name={o.customer} size={26} /><span>{o.customer}</span></div></td>
              {compact ? null : <td className="hide-sm muted clip">{o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}</td>}
              <td className="hide-sm muted">{ago(o.date, today)}</td>
              <td><Pill>{o.status}</Pill></td>
              <td className="num hide-sm">{money(o.total)}</td>
              <td className="num">{o.due > 0 ? <span className="due">{money(o.due)}</span> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- Dashboard --------------------------------------------------------------------------------------------------
function SalesChart({ orders, today }: { orders: Order[]; today: string }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13))
  const totals = days.map((d) => orders.filter((o) => o.date === d).reduce((a, o) => a + o.total, 0))
  const max = Math.max(1000, ...totals)
  const W = 640, H = 180, gap = 10, bw = (W - gap * 13) / 14
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label="Sales for the last 14 days">
      {[0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={H - H * f * 0.92} y2={H - H * f * 0.92} className="chart-grid" />)}
      {totals.map((t, i) => {
        const h = Math.max(t ? 4 : 2, (t / max) * H * 0.92)
        return (
          <g key={days[i]}>
            <rect x={i * (bw + gap)} y={H - h} width={bw} height={h} rx="5" className={days[i] === today ? 'bar bar-today' : 'bar'}>
              <title>{`${shortDate(days[i]!)}: ${money(t)}`}</title>
            </rect>
            {i % 2 === 1 || i === 13 ? <text x={i * (bw + gap) + bw / 2} y={H + 18} textAnchor="middle" className="chart-label">{days[i] === today ? 'Today' : shortDate(days[i]!)}</text> : null}
          </g>
        )
      })}
    </svg>
  )
}

export function Dashboard({ shop, who }: { shop: Shop; who: string }) {
  useAssistantContext({ path: '/dashboard', title: 'Dashboard' })
  const { today, orders, customers, products, expenses } = shop
  const from = addDays(today, -29)
  const recent = orders.filter((o) => o.date >= from)
  const sales = recent.reduce((a, o) => a + o.total, 0)
  const weekFrom = addDays(today, -6), prevFrom = addDays(today, -13)
  const week = orders.filter((o) => o.date >= weekFrom).reduce((a, o) => a + o.total, 0)
  const prev = orders.filter((o) => o.date >= prevFrom && o.date < weekFrom).reduce((a, o) => a + o.total, 0)
  const change = prev ? Math.round(((week - prev) / prev) * 100) : 0
  const owing = customers.filter((c) => c.due > 0).sort((a, b) => b.due - a.due)
  const toCollect = owing.reduce((a, c) => a + c.due, 0)
  const spent = expenses.filter((e) => e.date >= from).reduce((a, e) => a + e.amount, 0)
  const open = orders.filter((o) => o.status !== 'Delivered').sort((a, b) => b.no - a.no)
  const low = products.filter((p) => p.state !== 'In stock')
  const hour = new Date().getHours()
  const ask = useAsk()
  return (
    <>
      <PageHead title={`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${who}`} sub={longDate(today)}>
        <AskButton text="How did we do this week?">How did we do this week?</AskButton>
      </PageHead>
      <div className="stats">
        <Stat label="Sales, last 7 days" value={money(week)} hint={prev ? <span className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '▲' : '▼'} {Math.abs(change)}% on the week before</span> : null} />
        <Stat label="Sales, last 30 days" value={money(sales)} hint={`${recent.length} orders`} />
        <Stat label="To collect" value={money(toCollect)} tone="warn" hint={`${owing.length} customers owe money`} />
        <Stat label="Spent, last 30 days" value={money(spent)} hint={`${money(sales - spent)} left after expenses`} />
      </div>
      <div className="grid-2">
        <section className="card span-2">
          <div className="card-head"><h2>Sales</h2><span className="muted">Last 14 days</span></div>
          <SalesChart orders={orders} today={today} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Open orders</h2><a href="#/orders?status=open" className="link">All <Icon name="arrow" size={14} /></a></div>
          {open.length ? <ul className="list">{open.map((o) => (
            <li key={o.no}><a href={`#/orders/${o.no}`} className="list-row">
              <Avatar name={o.customer} size={34} />
              <div className="grow"><div className="strong">{o.customer}</div><div className="muted small">#{o.no} · {o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}</div></div>
              <Pill>{o.status}</Pill>
            </a></li>
          ))}</ul> : <Empty>Nothing waiting. Every order is delivered.</Empty>}
        </section>
        <section className="card">
          <div className="card-head"><h2>To collect</h2><a href="#/orders?unpaid=yes" className="link">Unpaid orders <Icon name="arrow" size={14} /></a></div>
          {owing.length ? <ul className="list">{owing.map((c) => (
            <li key={c.id}><a href={`#/customers/${c.id}`} className="list-row">
              <Avatar name={c.name} size={34} />
              <div className="grow"><div className="strong">{c.name}</div><div className="muted small">{c.type}</div></div>
              <span className="due strong">{money(c.due)}</span>
            </a></li>
          ))}</ul> : <Empty>Nobody owes anything.</Empty>}
        </section>
        <section className="card">
          <div className="card-head"><h2>Running low</h2><a href="#/products?low=yes" className="link">Stock <Icon name="arrow" size={14} /></a></div>
          {low.length ? <ul className="list">{low.map((p) => (
            <li key={p.id} className="list-row">
              <div className="grow"><div className="strong">{p.name}</div><div className="muted small">{p.stock} left · reorder at {p.lowAt}</div></div>
              <Pill>{p.state}</Pill>
            </li>
          ))}</ul> : <Empty>Everything is stocked.</Empty>}
        </section>
        <section className="card try">
          <div className="card-head"><h2><Icon name="spark" /> Ask Teovo</h2></div>
          <p className="muted">The assistant reads the same data you see, and prepares changes for you to confirm.</p>
          <div className="chips">
            {['Who owes the most?', 'What sold best this week?', 'Riya K paid 100 by UPI', 'We baked 24 cinnamon rolls', 'Mark order 161 ready', 'I spent 450 on milk, paid by UPI'].map((t) => (
              <button key={t} type="button" className="chip" onClick={() => ask(t)}>{t}</button>
            ))}
          </div>
        </section>
      </div>
    </>
  )
}

// ---------- Orders -----------------------------------------------------------------------------------------------------
export function Orders({ shop, query }: { shop: Shop; query: URLSearchParams }) {
  // The filters live in the link (#/orders?unpaid=yes), so the assistant's buttons can set them.
  const unpaid = query.get('unpaid') === 'yes'
  const status = query.get('status') ?? ''
  const tab = unpaid ? 'unpaid' : status === 'open' ? 'open' : (['New', 'Baking', 'Ready', 'Delivered'].includes(status) ? status : 'all')
  const [q, setQ] = useState('')
  useAssistantContext({ path: '/orders', title: 'Orders', ...(tab !== 'all' ? { state: { filter: tab === 'unpaid' ? 'unpaid only' : tab === 'open' ? 'not delivered yet' : `status ${tab}` } } : {}) })
  const byTab = (o: Order) => tab === 'all' || (tab === 'unpaid' ? o.due > 0 : tab === 'open' ? o.status !== 'Delivered' : o.status === tab)
  const list = shop.orders.filter(byTab).filter((o) => !q || `${o.no} ${o.customer}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.no - a.no)
  const set = (t: string) => go(t === 'all' ? '/orders' : t === 'unpaid' ? '/orders?unpaid=yes' : `/orders?status=${t}`)
  return (
    <>
      <PageHead title="Orders" sub={`${shop.orders.length} orders · ${money(shop.orders.reduce((a, o) => a + o.due, 0))} to collect`}>
        <AskButton text="Show unpaid orders">Ask about orders</AskButton>
      </PageHead>
      <div className="toolbar">
        <Tabs value={tab} onChange={set} options={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open', count: shop.orders.filter((o) => o.status !== 'Delivered').length },
          { value: 'unpaid', label: 'Unpaid', count: shop.orders.filter((o) => o.due > 0).length },
          { value: 'Ready', label: 'Ready' },
        ]} />
        <label className="search"><Icon name="search" size={16} /><input placeholder="Order # or customer" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      <section className="card flush"><OrderRows orders={list} today={shop.today} /></section>
    </>
  )
}

const NEXT: Record<Status, Status | null> = { New: 'Baking', Baking: 'Ready', Ready: 'Delivered', Delivered: null }

export function OrderPage({ shop, no }: { shop: Shop; no: number }) {
  const o = shop.orders.find((x) => x.no === no)
  useAssistantContext({ path: `/orders/${no}`, title: `Order #${no}`, record: { type: 'order', id: String(no) } })
  if (!o) return shop.orders.length ? <Empty>There is no order #{no}.</Empty> : null
  const next = NEXT[o.status]
  return (
    <>
      <PageHead back={{ to: '/orders', label: 'Orders' }} title={<>Order #{o.no} <Pill>{o.status}</Pill></>} sub={`Placed ${longDate(o.date)}`}>
        {next ? <AskButton text={`Mark order ${o.no} ${next.toLowerCase()}`}>{`Mark ${next.toLowerCase()}`}</AskButton> : null}
        {o.due > 0 ? <AskButton text={`Record a payment for order ${o.no}`}>Record payment</AskButton> : null}
      </PageHead>
      <div className="grid-side">
        <div className="stack">
          <section className="card flush">
            <div className="card-head pad"><h2>Items</h2></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num hide-sm">Price</th><th className="num">Amount</th></tr></thead>
              <tbody>{o.items.map((i) => (
                <tr key={i.productId}><td>{i.name}</td><td className="num">{i.qty}</td><td className="num hide-sm">{money(i.price)}</td><td className="num">{money(i.qty * i.price)}</td></tr>
              ))}</tbody>
              <tfoot>
                {o.total !== o.itemsTotal ? <tr><td colSpan={3} className="hide-sm">Adjusted from {money(o.itemsTotal)}</td><td className="num muted">{money(o.total - o.itemsTotal)}</td></tr> : null}
                <tr><td colSpan={3}>Total</td><td className="num strong">{money(o.total)}</td></tr>
              </tfoot>
            </table></div>
          </section>
          {o.note ? (
            <section className="card note">
              <div className="card-head"><h2><Icon name="note" /> Customer note</h2></div>
              <p>{o.note}</p>
            </section>
          ) : null}
        </div>
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Payment</h2><Pill>{payState(o)}</Pill></div>
            <div className="pay-row"><span>Paid</span><strong>{money(o.paid)}</strong></div>
            <Meter value={o.paid} max={o.total} tone={o.due > 0 ? 'amber' : 'green'} />
            <div className="pay-row"><span>Due</span><strong className={o.due > 0 ? 'due' : ''}>{money(o.due)}</strong></div>
            {o.payments.length ? <ul className="payments">{o.payments.map((p) => (
              <li key={p.id}><span>{shortDate(p.date)} · {p.method}</span><span>{money(p.amount)}</span></li>
            ))}</ul> : <p className="muted small">No payments yet.</p>}
          </section>
          <section className="card">
            <div className="card-head"><h2>Customer</h2></div>
            <a className="list-row" href={`#/customers/${o.customerId}`}>
              <Avatar name={o.customer} size={38} />
              <div className="grow"><div className="strong">{o.customer}</div><div className="muted small">View all their orders</div></div>
              <Icon name="arrow" size={16} />
            </a>
          </section>
        </div>
      </div>
    </>
  )
}

// ---------- Customers --------------------------------------------------------------------------------------------------
export function Customers({ shop }: { shop: Shop }) {
  useAssistantContext({ path: '/customers', title: 'Customers' })
  const [q, setQ] = useState('')
  const list = shop.customers.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.spent - a.spent)
  return (
    <>
      <PageHead title="Customers" sub={`${shop.customers.length} customers`}><AskButton text="Who are our best customers?">Ask about customers</AskButton></PageHead>
      <div className="toolbar"><label className="search"><Icon name="search" size={16} /><input placeholder="Search customers" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
      <section className="card flush"><div className="table-wrap"><table className="table">
        <thead><tr><th>Customer</th><th className="hide-sm">Type</th><th className="num hide-sm">Orders</th><th className="num">Spent</th><th className="num">Owes</th><th className="hide-sm">Last order</th></tr></thead>
        <tbody>{list.map((c) => (
          <tr key={c.id} className="link-row" onClick={() => go(`/customers/${c.id}`)}>
            <td><div className="who"><Avatar name={c.name} size={30} /><div><div className="strong">{c.name}</div><div className="muted small">{c.phone}</div></div></div></td>
            <td className="hide-sm"><Pill>{c.type}</Pill></td>
            <td className="num hide-sm">{c.orders}</td>
            <td className="num">{money(c.spent)}</td>
            <td className="num">{c.due > 0 ? <span className="due">{money(c.due)}</span> : <span className="muted">—</span>}</td>
            <td className="hide-sm muted">{c.lastOrder ? ago(c.lastOrder, shop.today) : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div></section>
    </>
  )
}

export function CustomerPage({ shop, id }: { shop: Shop; id: string }) {
  const c = shop.customers.find((x) => x.id === id)
  useAssistantContext({ path: `/customers/${id}`, title: c ? c.name : 'Customer', record: { type: 'customer', id } })
  if (!c) return shop.customers.length ? <Empty>No such customer.</Empty> : null
  const orders = shop.orders.filter((o) => o.customerId === id).sort((a, b) => b.no - a.no)
  return (
    <>
      <PageHead back={{ to: '/customers', label: 'Customers' }} title={<span className="who big"><Avatar name={c.name} size={44} />{c.name}</span>} sub={<><Pill>{c.type}</Pill> · {c.phone} · customer since {shortDate(c.since)} {c.since.slice(0, 4)}</>}>
        <AskButton text={`What does ${c.name} usually buy?`}>{`Ask about ${c.name.split(" ")[0]!}`}</AskButton>
      </PageHead>
      <div className="stats stats-3">
        <Stat label="Orders" value={String(c.orders)} hint={c.lastOrder ? `Last ${ago(c.lastOrder, shop.today).toLowerCase()}` : undefined} />
        <Stat label="Spent" value={money(c.spent)} />
        <Stat label="Owes" value={money(c.due)} tone={c.due > 0 ? 'warn' : undefined} />
      </div>
      <section className="card flush"><div className="card-head pad"><h2>Orders</h2></div><OrderRows orders={orders} today={shop.today} compact /></section>
    </>
  )
}

// ---------- Products ---------------------------------------------------------------------------------------------------
export function Products({ shop, query }: { shop: Shop; query: URLSearchParams }) {
  const low = query.get('low') === 'yes'
  useAssistantContext({ path: '/products', title: 'Products', ...(low ? { state: { filter: 'running low only' } } : {}) })
  const list = shop.products.filter((p) => !low || p.state !== 'In stock')
  const tone = (p: Product) => (p.state === 'Out of stock' ? 'red' : p.state === 'Running low' ? 'amber' : 'green')
  return (
    <>
      <PageHead title="Products" sub={`${shop.products.length} products · ${shop.products.filter((p) => p.state !== 'In stock').length} need baking`}>
        <AskButton text="What is running low?">Ask about stock</AskButton>
      </PageHead>
      <div className="toolbar">
        <Tabs value={low ? 'low' : 'all'} onChange={(v) => go(v === 'low' ? '/products?low=yes' : '/products')} options={[
          { value: 'all', label: 'All' }, { value: 'low', label: 'Running low', count: shop.products.filter((p) => p.state !== 'In stock').length },
        ]} />
      </div>
      <div className="products">
        {list.map((p) => (
          <section key={p.id} className="card product">
            <div className="product-top"><div className="strong">{p.name}</div><Pill>{p.lowAt ? p.state : 'Made to order'}</Pill></div>
            <div className="product-price">{money(p.price)} <span className="muted small">/ {p.unit}</span></div>
            {p.lowAt ? <><Meter value={p.stock} max={p.lowAt * 3} tone={tone(p)} /><div className="muted small">{p.stock} in stock · reorder at {p.lowAt}</div></>
              : <div className="muted small made">Baked when ordered</div>}
          </section>
        ))}
      </div>
    </>
  )
}

// ---------- Expenses ---------------------------------------------------------------------------------------------------
export function Expenses({ shop }: { shop: Shop }) {
  useAssistantContext({ path: '/expenses', title: 'Expenses' })
  const from = addDays(shop.today, -29)
  const recent = shop.expenses.filter((e) => e.date >= from)
  const total = recent.reduce((a, e) => a + e.amount, 0)
  const byCat = [...recent.reduce((m, e) => m.set(e.category, (m.get(e.category) ?? 0) + e.amount), new Map<string, number>())].sort((a, b) => b[1] - a[1])
  const list = [...shop.expenses].sort((a: Expense, b: Expense) => b.date.localeCompare(a.date) || b.id - a.id)
  return (
    <>
      <PageHead title="Expenses" sub={`${money(total)} in the last 30 days`}><AskButton text="I spent 450 on milk today, paid by UPI">Add an expense</AskButton></PageHead>
      <QuickAdd />
      <div className="grid-side">
        <section className="card flush"><div className="table-wrap"><table className="table">
          <thead><tr><th>Date</th><th>Vendor</th><th className="hide-sm">Category</th><th className="hide-sm">Paid by</th><th className="num">Amount</th></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={e.id}><td className="muted">{shortDate(e.date)}</td><td className="strong">{e.vendor}</td><td className="hide-sm">{e.category}</td><td className="hide-sm muted">{e.method}</td><td className="num">{money(e.amount)}</td></tr>
          ))}</tbody>
        </table></div></section>
        <section className="card">
          <div className="card-head"><h2>By category</h2><span className="muted">30 days</span></div>
          <ul className="cats">{byCat.map(([cat, amt]) => (
            <li key={cat}><div className="cat-row"><span>{cat}</span><span className="strong">{money(amt)}</span></div><Meter value={amt} max={byCat[0]![1]} /></li>
          ))}</ul>
        </section>
      </div>
    </>
  )
}

// ---------- Admin ------------------------------------------------------------------------------------------------------
/** What an app's own admin screen can show from Teovo: the trail of changes, the misses, every reply, and deleting conversations. */
export function Admin({ user }: { user: string }) {
  const [events, setEvents] = useState<{ title: string; event: string; userId: string; at: string }[]>([])
  const [misses, setMisses] = useState<{ question: string; reason: string; userId: string; at: string }[]>([])
  const [note, setNote] = useState('')
  const get = (path: string) => fetch(`/api/assistant/${path}`, { headers: { 'x-demo-user': user } }).then((r) => r.json())
  const load = () => { void get('audit?limit=20').then((b) => setEvents(b.events ?? [])); void get('misses?limit=20').then((b) => setMisses(b.misses ?? [])) }
  useEffect(load, [user])
  useAssistantContext({ path: '/admin', title: 'Admin' })
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  return (
    <>
      <PageHead title="Assistant admin" sub="What the assistant changed, what it couldn't answer, and your data." />
      <div className="stack">
        <section className="card flush">
          <div className="card-head pad"><h2>Changes made through the assistant</h2></div>
          {events.length ? <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th className="hide-sm">Who</th><th>Change</th><th>What happened</th></tr></thead>
            <tbody>{events.map((e, i) => <tr key={i}><td className="muted">{when(e.at)}</td><td className="hide-sm">{e.userId}</td><td>{e.title}</td><td><span className="pill pill-gray">{e.event}</span></td></tr>)}</tbody>
          </table></div> : <Empty>None yet.</Empty>}
        </section>
        <section className="card flush">
          <div className="card-head pad"><h2>Questions it couldn't answer</h2></div>
          {misses.length ? <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th className="hide-sm">Who</th><th>Asked</th><th>Why not</th></tr></thead>
            <tbody>{misses.map((m, i) => <tr key={i}><td className="muted">{when(m.at)}</td><td className="hide-sm">{m.userId}</td><td>{m.question}</td><td className="muted">{m.reason}</td></tr>)}</tbody>
          </table></div> : <Empty>None yet.</Empty>}
        </section>
        <section className="card">
          <div className="card-head"><h2>Every reply</h2></div>
          <p className="muted">What each reply was asked, the tools it ran, what a check refused, and a trace to download.</p>
          <RunViewer locale="en-IN" limit={15} userName={(id) => (id === 'demo-owner' ? 'Nisha (owner)' : id === 'demo-staff' ? 'Ravi (staff)' : id)} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Your data</h2></div>
          <p className="muted">Delete every conversation you had with the assistant, and the pictures you sent.</p>
          <div className="row">
            <button type="button" className="btn btn-danger" onClick={async () => {
              if (!confirm('Delete all your conversations with the assistant? This cannot be undone.')) return
              const r = await fetch('/api/assistant/wipe', { method: 'POST', headers: { 'x-demo-user': user, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'me' }) }).then((x) => x.json())
              setNote(`Deleted ${r.threads} conversation(s) and ${r.files} picture(s).`)
              load()
            }}>Delete my conversations</button>
            <span className="muted">{note}</span>
          </div>
        </section>
      </div>
    </>
  )
}


// ---------- Quick add: a form filled by Teovo's 'expense' reader ------------------------------------------------------
interface Draft { amount: number | null; vendor: string | null; category: string | null; date: string | null; method: string | null; question: string | null }

/** Type a note, say it, or scan a bill: the reader fills the form; nothing is saved until Save. */
function QuickAdd() {
  const r = useReader<Draft>('expense')
  const [note, setNote] = useState('')
  const [form, setForm] = useState<Draft | null>(null)
  const [saved, setSaved] = useState('')
  const fill = async (input: string | File) => { setSaved(''); const d = await r.read(input); if (d) setForm(d) }
  const set = (k: keyof Draft, v: string) => setForm((f) => (f ? { ...f, [k]: k === 'amount' ? (v ? Number(v) : null) : v || null } : f))
  const save = async () => {
    const res = await fetch('/api/shop/expenses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
    if (res.ok) { setSaved(`Saved ${money(form!.amount ?? 0)} to ${form!.vendor}.`); setForm(null); setNote(''); r.reset() }
    else setSaved(((await res.json()) as { error: string }).error)
  }
  return (
    <section className="card quick">
      <div className="card-head"><h2>Quick add</h2><span className="muted small">Type it, say it, or scan a bill — then check and save</span></div>
      <div className="quick-row">
        <input className="quick-input" placeholder="e.g. 2 kg butter from the dairy, 1100, UPI" value={note} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) void fill(note) }} />
        <button type="button" className="btn btn-soft" disabled={!note.trim() || r.busy} onClick={() => void fill(note)}>Fill</button>
        <VoiceButton label="Say it" className="btn btn-soft" onText={(t) => { setNote(t); void fill(t) }} />
        <label className="btn btn-soft">Scan bill<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void fill(f); e.target.value = '' }} /></label>
      </div>
      {r.busy ? <p className="muted small">Reading…</p> : null}
      {r.error ? <p className="due small" role="alert">{r.error}</p> : null}
      {saved ? <p className="small" role="status">{saved}</p> : null}
      {form ? (
        <div className="quick-form">
          {form.question ? <p className="due small">{form.question}</p> : null}
          <label>Amount<input type="number" value={form.amount ?? ''} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Vendor<input value={form.vendor ?? ''} onChange={(e) => set('vendor', e.target.value)} /></label>
          <label>Category<select value={form.category ?? 'Other'} onChange={(e) => set('category', e.target.value)}>
            {['Ingredients', 'Packaging', 'Rent', 'Utilities', 'Wages', 'Equipment', 'Other'].map((c) => <option key={c}>{c}</option>)}
          </select></label>
          <label>Date<input type="date" value={form.date ?? ''} onChange={(e) => set('date', e.target.value)} /></label>
          <label>Paid by<select value={form.method ?? 'Cash'} onChange={(e) => set('method', e.target.value)}>
            {['Cash', 'UPI', 'Card', 'Bank'].map((c) => <option key={c}>{c}</option>)}
          </select></label>
          <div className="row"><button type="button" className="btn btn-brand-sm" onClick={() => void save()}>Save</button><button type="button" className="btn btn-soft" onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      ) : null}
    </section>
  )
}
