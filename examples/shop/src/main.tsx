import { AssistantPanel, AssistantProvider, AssistantSheet, ThreadList, useAssistantContext } from '@teovo/react'
import '@teovo/react/styles.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

interface Order { no: number; customer: string; total: number; paid: number; due: number; date: string; note?: string }
interface Expense { id: number; amount: number; vendor: string; date: string; method: string }
const money = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n)

/** The shop's data, refreshed every second so confirmed cards show up on the page. */
function useShop() {
  const [data, setData] = useState<{ orders: Order[]; expenses: Expense[] }>({ orders: [], expenses: [] })
  useEffect(() => {
    let live = true
    const load = () => fetch('/api/shop').then((r) => r.json()).then((d) => { if (live) setData(d) }).catch(() => {})
    void load()
    const t = setInterval(load, 1000)
    return () => { live = false; clearInterval(t) }
  }, [])
  return data
}

function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(location.hash.slice(1) || '/orders')
  useEffect(() => {
    const on = () => setPath(location.hash.slice(1) || '/orders')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return [path, (to) => { location.hash = to }]
}

function Orders({ orders, go, query }: { orders: Order[]; go: (to: string) => void; query: URLSearchParams }) {
  // The filter lives in the link (#/orders?unpaid=yes), so the assistant's "Show unpaid orders" button can set it.
  const unpaid = query.get('unpaid') === 'yes'
  const setUnpaid = (on: boolean) => go(on ? '/orders?unpaid=yes' : '/orders')
  useAssistantContext({ path: '/orders', title: 'Orders', ...(unpaid ? { state: { filter: 'unpaid only' } } : {}) })
  return (
    <section>
      <h1>Orders</h1>
      <label><input type="checkbox" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} /> Unpaid only</label>
      <table>
        <thead><tr><th>#</th><th>Customer</th><th>Total</th><th>Paid</th><th>Due</th></tr></thead>
        <tbody>
          {orders.filter((o) => !unpaid || o.due > 0).map((o) => (
            <tr key={o.no} onClick={() => go(`/orders/${o.no}`)} style={{ cursor: 'pointer' }}>
              <td>{o.no}</td><td>{o.customer}</td><td>{money(o.total)}</td><td>{money(o.paid)}</td><td>{money(o.due)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function OrderPage({ order }: { order: Order | undefined }) {
  useAssistantContext({ path: order ? `/orders/${order.no}` : '/orders', title: order ? `Order #${order.no}` : 'Order', ...(order ? { record: { type: 'order', id: String(order.no) } } : {}) })
  if (!order) return <p>Loading…</p>
  return (
    <section>
      <h1>Order #{order.no}</h1>
      <p>{order.customer} · placed {order.date}</p>
      <p>Total {money(order.total)} · paid {money(order.paid)} · <strong>due {money(order.due)}</strong></p>
      {order.note ? <p><em>Customer note:</em> {order.note}</p> : null}
      <p><a href="#/orders">← All orders</a></p>
    </section>
  )
}

/** What an app's own admin screen can show from Teovo: the trail of changes, the misses, and deleting conversations. */
function Admin({ user }: { user: string }) {
  const [events, setEvents] = useState<{ title: string; event: string; userId: string; at: string }[]>([])
  const [misses, setMisses] = useState<{ question: string; reason: string; userId: string; at: string }[]>([])
  const [note, setNote] = useState('')
  const get = (path: string) => fetch(`/api/assistant/${path}`, { headers: { 'x-demo-user': user } }).then((r) => r.json())
  const load = () => { void get('audit?limit=20').then((b) => setEvents(b.events ?? [])); void get('misses?limit=20').then((b) => setMisses(b.misses ?? [])) }
  useEffect(load, [user])
  useAssistantContext({ path: '/admin', title: 'Admin' })
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  return (
    <section>
      <h1>Admin</h1>
      <h2>Changes made through the assistant</h2>
      {events.length ? <table><thead><tr><th>When</th><th>Who</th><th>Change</th><th>What happened</th></tr></thead>
        <tbody>{events.map((e, i) => <tr key={i}><td>{when(e.at)}</td><td>{e.userId}</td><td>{e.title}</td><td>{e.event}</td></tr>)}</tbody></table> : <p>None yet.</p>}
      <h2>Questions it couldn't answer</h2>
      {misses.length ? <table><thead><tr><th>When</th><th>Who</th><th>Asked</th><th>Why not</th></tr></thead>
        <tbody>{misses.map((m, i) => <tr key={i}><td>{when(m.at)}</td><td>{m.userId}</td><td>{m.question}</td><td>{m.reason}</td></tr>)}</tbody></table> : <p>None yet.</p>}
      <h2>Your data</h2>
      <button type="button" onClick={async () => {
        if (!confirm('Delete all your conversations with the assistant? This cannot be undone.')) return
        const r = await fetch('/api/assistant/wipe', { method: 'POST', headers: { 'x-demo-user': user, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'me' }) }).then((x) => x.json())
        setNote(`Deleted ${r.threads} conversation(s) and ${r.files} picture(s).`)
        load()
      }}>Delete my conversations</button> <span>{note}</span>
    </section>
  )
}

function Expenses({ expenses }: { expenses: Expense[] }) {
  useAssistantContext({ path: '/expenses', title: 'Expenses' })
  return (
    <section>
      <h1>Expenses</h1>
      <ul>{expenses.map((e) => <li key={e.id}>{e.date} · {e.vendor} · {money(e.amount)} ({e.method})</li>)}</ul>
    </section>
  )
}

// Remember the open conversation per demo user, so a reload continues it.
const saved = (user: string) => { try { return localStorage.getItem(`teovo-thread-${user}`) ?? undefined } catch { return undefined } }
const save = (user: string, id: string) => { try { localStorage.setItem(`teovo-thread-${user}`, id) } catch { /* private mode */ } }

function App() {
  const shop = useShop()
  const [path, go] = usePath()
  const [user, setUser] = useState<'owner' | 'staff'>('owner')
  const [history, setHistory] = useState(false)
  const [open, setOpen] = useState(false)
  const [route, search = ''] = path.split('?') as [string, string?]
  const match = /^\/orders\/(\d+)$/.exec(route)
  return (
    <AssistantProvider key={user} endpoint="/api/assistant" headers={{ 'x-demo-user': user }}
      threadId={saved(user)} onThread={(id) => save(user, id)}
      // A button under a reply: go there and close the sheet, so the user sees the page it opened.
      onAction={(a) => { if (a.action === 'navigate' && typeof a.args?.to === 'string') { go(a.args.to); setOpen(false) } }}>
      <header className="bar">
        <strong>Teovo shop</strong>
        <a href="#/orders">Orders</a>
        <a href="#/expenses">Expenses</a>
        {user === 'owner' ? <a href="#/admin">Admin</a> : null}
        <select aria-label="Signed in as" value={user} onChange={(e) => setUser(e.target.value as 'owner' | 'staff')}>
          <option value="owner">Owner</option>
          <option value="staff">Staff</option>
        </select>
      </header>
      <main>
        {match ? <OrderPage order={shop.orders.find((o) => o.no === Number(match[1]))} />
          : route === '/expenses' ? <Expenses expenses={shop.expenses} />
          : route === '/admin' ? <Admin user={user} />
          : <Orders orders={shop.orders} go={go} query={new URLSearchParams(search)} />}
      </main>
      <AssistantSheet label="Ask Teovo" theme={{ accent: '#b45309' }} open={open} onOpenChange={setOpen} header={
        <div className="tv-tabs" role="group" aria-label="View">
          <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>Chat</button>
          <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>History</button>
        </div>
      }>
        {history ? <ThreadList onOpen={() => setHistory(false)} />
          : <AssistantPanel attach welcome="Ask about orders, payments and expenses." stepLabels={{ list_orders: 'Looking at orders', list_expenses: 'Looking at expenses' }} />}
      </AssistantSheet>
    </AssistantProvider>
  )
}

// One React root, even when Vite reloads this file: a second createRoot on the same element breaks the page.
const el = document.getElementById('root')! as HTMLElement & { root?: ReturnType<typeof createRoot> }
el.root ??= createRoot(el)
el.root.render(<StrictMode><App /></StrictMode>)
