import { useEffect, useState } from 'react'

export type Status = 'New' | 'Baking' | 'Ready' | 'Delivered'
export interface Payment { id: number; amount: number; date: string; method: string }
export interface Order {
  no: number; customer: string; customerId: string; date: string; status: Status
  items: { productId: string; name: string; qty: number; price: number }[]; payments: Payment[]
  total: number; itemsTotal: number; paid: number; due: number; note?: string
}
export interface Customer { id: string; name: string; phone: string; type: string; since: string; orders: number; spent: number; due: number; lastOrder: string | null }
export interface Product { id: string; name: string; price: number; stock: number; lowAt: number; unit: string; state: string }
export interface Expense { id: number; amount: number; vendor: string; category: string; date: string; method: string }
export interface Shop { today: string; orders: Order[]; customers: Customer[]; products: Product[]; expenses: Expense[] }

const empty: Shop = { today: new Date().toISOString().slice(0, 10), orders: [], customers: [], products: [], expenses: [] }

/** The shop's data, refreshed every second so confirmed cards show up on the page. */
export function useShop(): Shop & { loaded: boolean } {
  const [data, setData] = useState<Shop & { loaded: boolean }>({ ...empty, loaded: false })
  useEffect(() => {
    let live = true
    const load = () => fetch('/api/shop').then((r) => r.json()).then((d: Shop) => { if (live) setData({ ...d, loaded: true }) }).catch(() => {})
    void load()
    const t = setInterval(load, 1000)
    return () => { live = false; clearInterval(t) }
  }, [])
  return data
}

/** The hash route: #/orders/142?x=y → ['/orders/142', URLSearchParams]. */
export function useRoute(): [string, URLSearchParams, (to: string) => void] {
  const read = () => location.hash.slice(1) || '/dashboard'
  const [path, setPath] = useState(read)
  useEffect(() => {
    const on = () => { setPath(read()); window.scrollTo(0, 0) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const [route, search = ''] = path.split('?') as [string, string?]
  return [route, new URLSearchParams(search), (to) => { location.hash = to }]
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
export const money = (n: number) => inr.format(n)
export const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
export const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
export const DAY = 86_400_000
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10)

/** "Today", "Yesterday", "3 days ago" or a date. */
export function ago(iso: string, today: string) {
  const d = Math.round((Date.parse(today) - Date.parse(iso)) / DAY)
  return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : shortDate(iso)
}
