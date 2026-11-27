import { checkFormats, type Formats } from './formats.js'
import type { TeovoTool } from './tools.js'

/** What a business (tenant) can set for itself. The app's own code always comes first; these only add or narrow. */
export interface TenantSettings {
  /** False turns the assistant off for everyone in the tenant. */
  enabled: boolean
  /** Extra notes for the model, e.g. "We close on Sundays. Call customers by first name." */
  instructions?: string
  /** Words this business uses, e.g. { "khata": "a customer's running credit account" }. */
  glossary?: Record<string, string>
  /** Tools switched off for this tenant. A tenant can only narrow what roles already allow, never widen it. */
  toolsOff?: string[]
  /** How this business writes dates and money; any part left out uses the app's default. */
  formats?: Partial<Formats>
  /** What people are told before they use the assistant, and whether pictures may be sent to the model. */
  privacy?: { notice?: string; pictures?: boolean }
  /** Only in the switches row (teovo.setSwitches): models taken out of service for every tenant, by model id. */
  modelsOff?: string[]
}

/** Tools Teovo adds itself, which a tenant can also switch off. */
export const BUILTIN_TOOLS = ['cannot_help']
const MAX_NOTICE = 2000

export const DEFAULT_SETTINGS: TenantSettings = { enabled: true }

const MAX_INSTRUCTIONS = 2000
const MAX_TERMS = 50

export class SettingsError extends Error {}

/** Check settings sent by a tenant admin. Throws SettingsError with a sentence for them. */
export function validateSettings(raw: unknown, tools: readonly TeovoTool[]): TenantSettings {
  if (!raw || typeof raw !== 'object') throw new SettingsError('Send the settings as an object.')
  const r = raw as Record<string, unknown>
  const out: TenantSettings = { enabled: r.enabled === undefined ? true : Boolean(r.enabled) }
  if (r.instructions !== undefined && r.instructions !== null) {
    if (typeof r.instructions !== 'string') throw new SettingsError('Instructions must be text.')
    const text = r.instructions.trim()
    if (text.length > MAX_INSTRUCTIONS) throw new SettingsError(`Instructions can be at most ${MAX_INSTRUCTIONS} characters.`)
    if (text) out.instructions = text
  }
  if (r.glossary !== undefined && r.glossary !== null) {
    if (typeof r.glossary !== 'object' || Array.isArray(r.glossary)) throw new SettingsError('The glossary must be a list of words and meanings.')
    const entries = Object.entries(r.glossary as Record<string, unknown>)
      .map(([k, v]) => [k.trim().slice(0, 60), typeof v === 'string' ? v.trim().slice(0, 200) : ''] as const)
      .filter(([k, v]) => k && v)
    if (entries.length > MAX_TERMS) throw new SettingsError(`The glossary can have at most ${MAX_TERMS} words.`)
    if (entries.length) out.glossary = Object.fromEntries(entries)
  }
  if (r.toolsOff !== undefined && r.toolsOff !== null) {
    if (!Array.isArray(r.toolsOff) || r.toolsOff.some((t) => typeof t !== 'string')) throw new SettingsError('toolsOff must be a list of tool names.')
    const known = new Set([...tools.map((t) => t.name), ...BUILTIN_TOOLS])
    const unknown = (r.toolsOff as string[]).filter((t) => !known.has(t))
    if (unknown.length) throw new SettingsError(`Unknown tool: ${unknown.join(', ')}.`)
    if (r.toolsOff.length) out.toolsOff = [...new Set(r.toolsOff as string[])]
  }
  if (r.formats !== undefined && r.formats !== null) {
    if (typeof r.formats !== 'object') throw new SettingsError('formats must be { locale, currency, timeZone }.')
    const f = r.formats as Record<string, unknown>
    const pick: Partial<Formats> = {}
    for (const k of ['locale', 'currency', 'timeZone'] as const) {
      if (f[k] === undefined || f[k] === null || f[k] === '') continue
      if (typeof f[k] !== 'string') throw new SettingsError(`${k} must be text.`)
      pick[k] = (f[k] as string).trim()
    }
    const problem = checkFormats(pick)
    if (problem) throw new SettingsError(problem)
    if (Object.keys(pick).length) out.formats = pick
  }
  if (r.privacy !== undefined && r.privacy !== null) {
    if (typeof r.privacy !== 'object' || Array.isArray(r.privacy)) throw new SettingsError('privacy must be { notice, pictures }.')
    const pr = r.privacy as Record<string, unknown>
    const privacy: NonNullable<TenantSettings['privacy']> = {}
    if (pr.notice !== undefined && pr.notice !== null) {
      if (typeof pr.notice !== 'string') throw new SettingsError('The notice must be text.')
      if (pr.notice.trim().length > MAX_NOTICE) throw new SettingsError(`The notice can be at most ${MAX_NOTICE} characters.`)
      if (pr.notice.trim()) privacy.notice = pr.notice.trim()
    }
    if (pr.pictures !== undefined && pr.pictures !== null) privacy.pictures = Boolean(pr.pictures)
    if (Object.keys(privacy).length) out.privacy = privacy
  }
  return out
}

/** A short id for a notice's exact words: accepting one notice doesn't count as accepting a changed one. */
export async function noticeId(notice: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(notice)))
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The tenant's part of the system prompt. Written by the tenant's own admins, so it guides but never overrides the app. */
export function settingsText(s: TenantSettings): string {
  const parts: string[] = []
  if (s.instructions) parts.push(`Notes from this business (follow them unless they conflict with anything above):\n${s.instructions}`)
  if (s.glossary && Object.keys(s.glossary).length) {
    parts.push(`Words this business uses:\n${Object.entries(s.glossary).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`)
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : ''
}
