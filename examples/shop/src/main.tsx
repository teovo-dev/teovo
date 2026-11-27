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

function Orders({ orders, go }: { orders: Order[]; go: (to: string) => void }) {
  const [unpaid, setUnpaid] = useState(false)
  useAssistantContext({ path: '/orders', title: 'Orders', state: { filter: unpaid ? 'unpaid' : 'all' } })
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
  const match = /^\/orders\/(\d+)$/.exec(path)
  return (
    <AssistantProvider key={user} endpoint="/api/assistant" headers={{ 'x-demo-user': user }}
      threadId={saved(user)} onThread={(id) => save(user, id)}
      onAction={(a) => { if (a.action === 'navigate' && typeof a.args?.to === 'string') go(a.args.to) }}>
      <header className="bar">
        <strong>Teovo shop</strong>
        <a href="#/orders">Orders</a>
        <a href="#/expenses">Expenses</a>
        <select aria-label="Signed in as" value={user} onChange={(e) => setUser(e.target.value as 'owner' | 'staff')}>
          <option value="owner">Owner</option>
          <option value="staff">Staff</option>
        </select>
      </header>
      <main>
        {match ? <OrderPage order={shop.orders.find((o) => o.no === Number(match[1]))} />
          : path === '/expenses' ? <Expenses expenses={shop.expenses} />
          : <Orders orders={shop.orders} go={go} />}
      </main>
      <AssistantSheet label="Ask Teovo" theme={{ accent: '#b45309' }}>
        <div className="sheet-tabs">
          <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>Chat</button>
          <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>History</button>
        </div>
        {history ? <ThreadList onOpen={() => setHistory(false)} />
          : <AssistantPanel attach welcome="Ask about orders, payments and expenses." stepLabels={{ list_orders: 'Looking at orders', list_expenses: 'Looking at expenses' }} />}
      </AssistantSheet>
    </AssistantProvider>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
