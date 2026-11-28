import type { Identity, ToolContext } from './tools.js'

/** Where the user is, as the panel reports it. Every field comes from the browser: treat it as a claim, not a fact. */
export interface Page {
  path?: string
  title?: string
  /** The record open on screen, e.g. { type: 'order', id: '142' }. */
  record?: { type: string; id: string }
  /** What components on the screen published: filters, selected rows, a draft. Small, flat values only. */
  state?: Record<string, string | number | boolean | null>
}

/**
 * A screen the assistant may send the user to. `path` may hold :params, e.g. '/orders/:id'. `filters` are the query
 * values the screen understands, by name with what they do, e.g. { unpaid: "'yes' to show only orders with money due" };
 * they go on the link as ?unpaid=yes, and the app's page reads them.
 */
export interface ScreenInfo {
  path: string
  title: string
  description?: string
  filters?: Record<string, string>
  /** Roles that may be sent to this screen. Omitted: every role. Others never hear of it. */
  roles?: readonly string[]
}

const SAFE = /^[\w .,:@-]{1,64}$/

/** The values a filled-in path gives a screen's :params ('/orders/142' on '/orders/:id' → { id: '142' }), or null. */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/'), got = path.split('/')
  if (want.length !== got.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(':')) {
      let v: string
      try { v = decodeURIComponent(got[i]!) } catch { return null }
      if (!v) return null
      out[want[i]!.slice(1)] = v
    } else if (want[i] !== got[i]) return null
  }
  return out
}

/**
 * The screen a name points at (its path, its title, or a path with values filled in such as '/orders/142?unpaid=yes'),
 * with the values the name carries; null when it fits none.
 */
export function findScreen(screens: readonly ScreenInfo[], name: string): { screen: ScreenInfo; values: Record<string, string> } | null {
  const [bare = '', qs] = name.trim().split('?') as [string, string?]
  const values: Record<string, string> = {}
  let screen = screens.find((x) => x.path === bare || x.title === name.trim())
  if (!screen) {
    // A filled-in path: the literal screens first, so '/orders/new' isn't read as '/orders/:id'.
    for (const x of [...screens].sort((a, b) => Number(a.path.includes(':')) - Number(b.path.includes(':')))) {
      const m = matchPath(x.path, bare)
      if (m) { screen = x; Object.assign(values, m); break }
    }
  }
  if (!screen) return null
  if (qs) for (const [k, v] of new URLSearchParams(qs)) if (!(k in values)) values[k] = v
  return { screen, values }
}

/**
 * Fill a screen's :params and filters; null when the path doesn't fit any screen or a value is missing or odd.
 * `name` is a screen's path or title, or a path with its values filled in, e.g. '/orders/142?unpaid=yes'.
 */
export function screenPath(screens: readonly ScreenInfo[], name: string, params: Record<string, string | number> = {}): { path: string; title: string } | null {
  const found = findScreen(screens, name)
  if (!found) return null
  const s = found.screen
  params = { ...found.values, ...params }
  let ok = true
  const used = new Set<string>()
  const path = s.path.replace(/:(\w+)/g, (_, k: string) => {
    used.add(k)
    const v = params[k]
    if (v === undefined || !/^[\w-]{1,64}$/.test(String(v))) { ok = false; return '' }
    return encodeURIComponent(String(v))
  })
  if (!ok) return null
  // Every other value must be one of the screen's filters: a value it can't use would give the user a button that
  // quietly does less than the model said.
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (used.has(k)) continue
    if (!s.filters || !(k in s.filters) || !SAFE.test(String(v))) return null
    query.set(k, String(v))
  }
  const q = query.toString()
  return { path: q ? `${path}?${q}` : path, title: s.title }
}

/** The screens map for the model. */
export function screensText(screens: readonly ScreenInfo[]): string {
  if (!screens.length) return ''
  return `\n\nScreens in this app. Only open_screen puts a button under your reply: never write a button, link or tool call in your text. When the user asks to go to or open a screen, call open_screen. Otherwise a button is an extra, never the answer: when the user asks about something, look it up with your tools and answer (or show it); then offer a screen with open_screen if it helps.\n${screens.map((s) => `- ${s.title}: ${s.path}${s.description ? ` (${s.description})` : ''}${s.filters ? `; filters: ${Object.entries(s.filters).map(([k, d]) => `${k} (${d})`).join(', ')}` : ''}`).join('\n')}`
}

/**
 * Describe the screen for the model, as this user (so a record they can't see stays unseen). Return a few lines
 * of facts, e.g. "Order #142 for Riya: ₹880, unpaid, due Friday", or null when there's nothing useful to add.
 */
export type ScreenFn<DB> = (page: Page, ctx: ToolContext<DB>) => Promise<string | null> | string | null

/** Questions shown as chips above the input, and the grey hint inside it (Tab accepts it). */
export interface Suggestions {
  suggestions: string[]
  placeholder?: string
  /** Example questions the empty message box shows in turn (Tab takes the one showing). Up to 6. */
  examples?: string[]
}

/**
 * Suggestions for this person on this screen. `after` is the assistant's last reply when called after a reply
 * (for follow-ups), undefined when the panel opens or the screen changes.
 */
export type SuggestionsFn<DB> = (ctx: { identity: Identity; page?: Page; after?: string; db: DB }) => Promise<Suggestions> | Suggestions

const MAX_CHIPS = 4
const MAX_CHARS = 80

/** Keep suggestions short and few, whatever the app returns. */
export function tidy(s: Suggestions): Suggestions {
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
  const suggestions = [...new Set(s.suggestions.map(clean).filter(Boolean))].slice(0, MAX_CHIPS)
  const placeholder = s.placeholder ? clean(s.placeholder) : undefined
  const examples = [...new Set((s.examples ?? []).map(clean).filter(Boolean))].slice(0, 6)
  return { suggestions, ...(placeholder ? { placeholder } : {}), ...(examples.length ? { examples } : {}) }
}

/** A page from the request body or query string, with anything malformed dropped. */
export function readPage(raw: unknown): Page | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  const page: Page = {}
  const path = str(r.path, 300), title = str(r.title, 200)
  if (path) page.path = path
  if (title) page.title = title
  const st = r.state
  if (st && typeof st === 'object' && !Array.isArray(st)) {
    const entries = Object.entries(st as Record<string, unknown>)
      .filter(([k, v]) => /^[\w.-]{1,40}$/.test(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v)))
      .slice(0, 20)
      .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v] as const)
    if (entries.length) page.state = Object.fromEntries(entries) as Page['state']
  }
  const rec = r.record as Record<string, unknown> | undefined
  const type = str(rec?.type, 50), id = str(rec?.id, 100)
  if (type && id) page.record = { type, id }
  return Object.keys(page).length ? page : undefined
}

/** The part of the system prompt that says where the user is. All of it is fenced: the browser and the records supplied it. */
export function screenText(page: Page | undefined, summary: string | null, untrusted: (text: string, source: string) => string): string {
  if (!page && !summary) return ''
  const lines = [
    page?.title ? `Screen: ${page.title}` : '',
    page?.path ? `Path: ${page.path}` : '',
    page?.record ? `Open record: ${page.record.type} ${page.record.id}` : '',
    page?.state ? `On screen: ${Object.entries(page.state).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}` : '',
    summary ? `What it shows:\n${summary}` : '',
  ].filter(Boolean)
  return lines.length ? `\n\nWhat the user is looking at now:\n${untrusted(lines.join('\n'), 'screen')}` : ''
}
