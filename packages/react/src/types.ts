import type { UIMessage } from 'ai'

/** The screen the user is on. The server adds it to the model's instructions. */
export interface Page {
  path?: string
  title?: string
  /** The record open on screen; the server's `screen` callback looks it up as the user. */
  record?: { type: string; id: string }
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

export type TeovoMessage = UIMessage<{ runId?: string; threadId?: string }, TeovoData>
