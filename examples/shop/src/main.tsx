import { AssistantPanel, AssistantProvider, AssistantSheet, useAssistant } from '@teovo/react'
import '@teovo/react/styles.css'
import './app.css'
import { StrictMode, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useRoute, useShop } from './data.js'
import { Admin, CustomerPage, Customers, Dashboard, Expenses, OrderPage, Orders, Products } from './pages.js'
import { Avatar, Icon, Logo } from './ui.js'

type User = 'owner' | 'staff'
const PEOPLE: Record<User, { name: string; role: string }> = { owner: { name: 'Nisha', role: 'Owner' }, staff: { name: 'Ravi', role: 'Staff' } }
const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: 'home' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/customers', label: 'Customers', icon: 'customers' },
  { to: '/products', label: 'Products', icon: 'products' },
  { to: '/expenses', label: 'Expenses', icon: 'expenses' },
] as const

/** The app inside the provider, so its buttons can open the assistant and send a question (useAssistant().ask). */
function Shell({ user, setUser }: { user: User; setUser: (u: User) => void }) {
  const shop = useShop()
  const [route, query] = useRoute()
  const order = /^\/orders\/(\d+)$/.exec(route)
  const customer = /^\/customers\/([\w-]+)$/.exec(route)
  const section = '/' + (route.split('/')[1] ?? '')
  const me = PEOPLE[user]

  let page: ReactNode
  if (order) page = <OrderPage shop={shop} no={Number(order[1])} />
  else if (customer) page = <CustomerPage shop={shop} id={customer[1]!} />
  else if (route === '/orders') page = <Orders shop={shop} query={query} />
  else if (route === '/customers') page = <Customers shop={shop} />
  else if (route === '/products') page = <Products shop={shop} query={query} />
  else if (route === '/expenses') page = <Expenses shop={shop} />
  else if (route === '/admin' && user === 'owner') page = <Admin user={user} />
  else page = <Dashboard shop={shop} who={me.name} />

  const nav = (extra: string) => (
    <>
      {NAV.map((n) => (
        <a key={n.to} href={`#${n.to}`} className={`${extra} ${section === n.to ? 'active' : ''}`} aria-current={section === n.to ? 'page' : undefined}>
          <Icon name={n.icon} size={20} /><span>{n.label}</span>
        </a>
      ))}
    </>
  )

  return (
    <>
      <div className="app">
        <aside className="sidebar">
          <a className="brand" href="#/dashboard"><Logo /><div><div className="brand-name">Little Oven</div><div className="brand-sub">Bakery · Indiranagar</div></div></a>
          <nav className="side-nav">{nav('side-link')}</nav>
          {user === 'owner' ? <nav className="side-nav side-bottom">
            <a href="#/admin" className={`side-link ${section === '/admin' ? 'active' : ''}`}><Icon name="admin" size={20} /><span>Assistant admin</span></a>
          </nav> : null}
          <div className="side-ask">
            <div className="strong">Ask Teovo</div>
            <p>Questions about orders, money and stock, in plain words.</p>
            <OpenChat />
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <a className="brand brand-mobile" href="#/dashboard"><Logo /><span className="brand-name">Little Oven</span></a>
            <div className="grow" />
            {user === 'owner' ? <a href="#/admin" className="icon-btn mobile-only" aria-label="Assistant admin"><Icon name="admin" /></a> : null}
            <label className="user">
              <Avatar name={me.name} size={30} />
              <span className="user-text"><span className="strong">{me.name}</span><span className="muted small">{me.role}</span></span>
              <select aria-label="Signed in as" value={user} onChange={(e) => setUser(e.target.value as User)}>
                <option value="owner">Nisha · Owner</option>
                <option value="staff">Ravi · Staff</option>
              </select>
            </label>
          </header>
          <main className="content">{shop.loaded ? page : <div className="loading">Loading…</div>}</main>
        </div>
        <nav className="tabbar">{nav('tab')}</nav>
      </div>
      {/* The chat: its header (History, dock / float, close), the open button and ⌘K all come from Teovo. */}
      <AssistantSheet theme={{ accent: '#c2410c' }}>
        <AssistantPanel attach welcome={`Hi ${me.name}. Ask about orders, payments, customers, stock and expenses.`} stepLabels={{
          list_orders: 'Looked at orders', get_order: 'Opened the order', list_customers: 'Looked at customers', list_products: 'Checked stock',
          sales_summary: 'Added up sales', list_expenses: 'Looked at expenses',
        }} />
      </AssistantSheet>
    </>
  )
}

/** The sidebar's Open button: the same open state as the chat's own button and ⌘K. */
function OpenChat() {
  const { ask } = useAssistant()
  return <button type="button" className="btn btn-brand" onClick={() => void ask()}>Open <kbd>⌘K</kbd></button>
}

function App() {
  const [user, setUser] = useState<User>('owner')
  return (
    // One conversation remembered per demo user, so switching user and reloading each continue their own.
    <AssistantProvider key={user} endpoint="/api/assistant" headers={{ 'x-demo-user': user }} rememberThread={`teovo-thread-${user}`}
      // A button under a reply opens that screen; on a phone Teovo then closes the chat so the screen shows.
      onAction={(a) => { if (a.action === 'navigate' && typeof a.args?.to === 'string') location.hash = a.args.to }}>
      <Shell user={user} setUser={setUser} />
    </AssistantProvider>
  )
}

// One React root, even when Vite reloads this file: a second createRoot on the same element breaks the page.
const el = document.getElementById('root')! as HTMLElement & { root?: ReturnType<typeof createRoot> }
el.root ??= createRoot(el)
el.root.render(<StrictMode><App /></StrictMode>)
