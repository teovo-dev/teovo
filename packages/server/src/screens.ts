import type { Identity, ToolContext } from './tools.js'

/** Where the user is, as the panel reports it. Every field comes from the browser: treat it as a claim, not a fact. */
export interface Page {
  path?: string
  title?: string
  /** The record open on screen, e.g. { type: 'order', id: '142' }. */
  record?: { type: string; id: string }
}

/**
 * Describe the screen for the model, as this user (so a record they can't see stays unseen). Return a few lines
 * of facts, e.g. "Order #142 for Riya: ₹880, unpaid, due Friday", or null when there's nothing useful to add.
 */
export type ScreenFn<DB> = (page: Page, ctx: ToolContext<DB>) => Promise<string | null> | string | null

/** Questions shown as chips above the input, and the grey hint inside it (Tab accepts it). */
export interface Suggestions { suggestions: string[]; placeholder?: string }

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
  return placeholder ? { suggestions, placeholder } : { suggestions }
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
    summary ? `What it shows:\n${summary}` : '',
  ].filter(Boolean)
  return lines.length ? `\n\nWhat the user is looking at now:\n${untrusted(lines.join('\n'), 'screen')}` : ''
}
