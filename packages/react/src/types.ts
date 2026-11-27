import type { UIMessage } from 'ai'

/** The screen the user is on. The server adds it to the model's instructions. */
export interface Page {
  path?: string
  title?: string
  /** The record open on screen; the server's `screen` callback looks it up as the user. */
  record?: { type: string; id: string }
  /** What the screen shows right now: filters, selected rows, a draft. Small, flat values only. */
  state?: Record<string, string | number | boolean | null>
}

/** Chips above the input, and the hint inside it. */
export interface Suggestions { suggestions: string[]; placeholder?: string }

/** A change the user must confirm (a `propose` tool's result, saved by the server). */
export interface Card {
  id: string
  threadId: string
  runId: string
  kind: string
  title: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  payload: unknown
  status: 'shown' | 'confirmed' | 'skipped' | 'undone' | 'expired' | 'waiting_for_approval'
  /** After confirming: whether the app can take the change back. */
  reversible?: boolean
  /** Outside text the assistant read before preparing it, e.g. ['customer note']. */
  untrustedSources?: string[]
  /** Which values to show, in order, with labels and formats. */
  fields?: { key: string; label?: string; format?: 'text' | 'number' | 'money' | 'date' }[]
}

/** One conversation in the history list. */
export interface ThreadSummary { id: string; title: string | null; createdAt: string; updatedAt: string }

export type CardDecision = 'confirm' | 'skip' | 'undo'

/** A button under the reply (an `action` tool's result). */
export interface Action { label: string; action: string; args?: Record<string, unknown> }

/** A tool the assistant is running, shown as a short line while it works. */
export interface Step { name: string; state: 'running' | 'done' }

/** The data parts Teovo's server streams. Same names as on the server: data-card, data-step, data-action. */
/** A view the assistant showed: its name, its data, and for a form whether it was sent. */
export interface View { view: string; data: any; submitted?: string; values?: Record<string, string | number | boolean | null> }

export type TeovoData = { card: Card; step: Step; action: Action; suggestions: Suggestions; view: View }

/** How the tenant writes dates and money, sent by the server with each reply. */
export interface Formats { locale: string; currency: string; timeZone: string }

export type TeovoMessage = UIMessage<{ runId?: string; threadId?: string; formats?: Formats; stopped?: boolean }, TeovoData>

/** What the tenant asks of people before they chat (GET …/policy). */
export interface Policy { notice?: string; noticeId?: string; pictures: boolean }

/** One limit and how much of it is used (GET …/allowance). */
export interface AllowanceItem { scope: 'user' | 'tenant'; unit: 'messages' | 'input_tokens' | 'output_tokens' | 'neurons'; period: 'day' | 'month'; limit: number; used: number }
