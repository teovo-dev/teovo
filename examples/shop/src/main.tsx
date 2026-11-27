import { AssistantPanel, AssistantProvider, AssistantSheet, ThreadList, useAssistant } from '@teovo/react'
import '@teovo/react/styles.css'
import './app.css'
import { StrictMode, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useRoute, useShop } from './data.js'
import { Admin, AskContext, CustomerPage, Customers, Dashboard, Expenses, OrderPage, Orders, Products } from './pages.js'
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

// Remember the open conversation per demo user, so a reload continues it.
const saved = (user: string) => { try { return localStorage.getItem(`teovo-thread-${user}`) ?? undefined } catch { return undefined } }
const save = (user: string, id: string) => { try { localStorage.setItem(`teovo-thread-${user}`, id) } catch { /* private mode */ } }

/** The app inside the provider, so its buttons can open the assistant and send a question. */
function Shell({ user, setUser, open, setOpen }: { user: User; setUser: (u: User) => void; open: boolean; setOpen: (v: boolean) => void }) {
  const shop = useShop()
  const [route, query] = useRoute()
  const [history, setHistory] = useState(false)
  // Docked on the right, or a floating window: the user's pick, remembered in this browser.
  const [layout, setLayout] = useState<'panel' | 'floating'>(() => { try { return localStorage.getItem('teovo-layout') === 'floating' ? 'floating' : 'panel' } catch { return 'panel' } })
  const switchLayout = () => { const next = layout === 'panel' ? 'floating' : 'panel'; setLayout(next); try { localStorage.setItem('teovo-layout', next) } catch { /* private mode */ } }
  const { chat } = useAssistant()
  const ask = (text?: string) => {
    setHistory(false)
    setOpen(true)
    if (text && chat.status !== 'streaming' && chat.status !== 'submitted') void chat.sendMessage({ text })
  }
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
    <AskContext.Provider value={ask}>
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
            <button type="button" className="btn btn-brand" onClick={() => ask()}>Open <kbd>⌘K</kbd></button>
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
      <AssistantSheet theme={{ accent: '#c2410c' }} open={open} onOpenChange={setOpen} layout={layout} header={
        <div className="sheet-head">
          <div className="tv-tabs" role="group" aria-label="View">
            <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>Chat</button>
            <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>History</button>
          </div>
          <button type="button" className="layout-btn" onClick={switchLayout}
            aria-label={layout === 'panel' ? 'Float the chat as a window' : 'Dock the chat on the right'} title={layout === 'panel' ? 'Float as a window' : 'Dock on the right'}>
            <Icon name={layout === 'panel' ? 'float' : 'dock'} />
          </button>
        </div>
      }>
        {history ? <ThreadList onOpen={() => setHistory(false)} />
          : <AssistantPanel attach welcome={`Hi ${me.name}. Ask about orders, payments, customers, stock and expenses.`} stepLabels={{
            list_orders: 'Looked at orders', get_order: 'Opened the order', list_customers: 'Looked at customers', list_products: 'Checked stock',
            sales_summary: 'Added up sales', list_expenses: 'Looked at expenses',
          }} />}
      </AssistantSheet>
    </AskContext.Provider>
  )
}

function App() {
  const [user, setUser] = useState<User>('owner')
  const [open, setOpen] = useState(false)
  return (
    <AssistantProvider key={user} endpoint="/api/assistant" headers={{ 'x-demo-user': user }}
      threadId={saved(user)} onThread={(id) => save(user, id)}
      // A button under a reply: go there and close the sheet, so the user sees the page it opened.
      onAction={(a) => { if (a.action === 'navigate' && typeof a.args?.to === 'string') { location.hash = a.args.to; setOpen(false) } }}>
      <Shell user={user} setUser={setUser} open={open} setOpen={setOpen} />
    </AssistantProvider>
  )
}

// One React root, even when Vite reloads this file: a second createRoot on the same element breaks the page.
const el = document.getElementById('root')! as HTMLElement & { root?: ReturnType<typeof createRoot> }
el.root ??= createRoot(el)
el.root.render(<StrictMode><App /></StrictMode>)
