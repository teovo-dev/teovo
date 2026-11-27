import type { ReactNode } from 'react'

const PATHS: Record<string, ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /><path d="M10 20v-6h4v6" /></>,
  orders: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  customers: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.4 3.5 5.2" /></>,
  products: <><path d="M4 14c0-4.4 3.6-8 8-8s8 3.6 8 8" /><path d="M3 14h18v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" /><path d="M9 9.5c.5-1 1.5-1.5 3-1.5" /></>,
  expenses: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M16 15h2" /></>,
  admin: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  note: <><path d="M5 4h14v12l-4 4H5z" /><path d="M15 20v-4h4" /></>,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17v.5" /></>,
  dock: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></>,
  float: <><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="12" y="11" width="6" height="6" rx="1" /></>,
}

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
}

export function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path d="M8 19c0-5 3.6-9 8-9s8 4 8 9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M7 19h18v2.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 7 21.5z" fill="#fff" />
      <path d="M13 14.5c.7-1 1.7-1.5 3-1.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

const TONE: Record<string, string> = {
  New: 'blue', Baking: 'amber', Ready: 'violet', Delivered: 'gray',
  Paid: 'green', 'Part paid': 'amber', Unpaid: 'red',
  'In stock': 'green', 'Running low': 'amber', 'Out of stock': 'red',
  Regular: 'blue', 'Made to order': 'blue', 'Walk-in': 'gray', Business: 'violet',
}
export function Pill({ children }: { children: string }) {
  return <span className={`pill pill-${TONE[children] ?? 'gray'}`}>{children}</span>
}
export const payState = (o: { paid: number; due: number }) => (o.due <= 0 ? 'Paid' : o.paid > 0 ? 'Part paid' : 'Unpaid')

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 55% 92%)`, color: `hsl(${hue} 45% 32%)` }}>{initials}</span>
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: 'good' | 'warn' }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `stat-${tone}` : ''}`}>{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  )
}

export function PageHead({ title, sub, back, children }: { title: ReactNode; sub?: ReactNode; back?: { to: string; label: string }; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {back ? <a className="back" href={`#${back.to}`}><Icon name="back" size={16} />{back.label}</a> : null}
        <h1>{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  )
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}{o.count !== undefined ? <span className="seg-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

/** A thin bar for "paid of total" or "stock of a full shelf". */
export function Meter({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'green' | 'amber' | 'red' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return <div className="meter"><div className={`meter-fill meter-${tone}`} style={{ width: `${pct}%` }} /></div>
}
