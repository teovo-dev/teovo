import type { UIMessage } from 'ai'

/** The screen the user is on. The server adds it to the model's instructions. */
export interface Page { path?: string; title?: string }

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

export type CardDecision = 'confirm' | 'skip' | 'undo'

/** A button under the reply (an `action` tool's result). */
export interface Action { label: string; action: string; args?: Record<string, unknown> }

/** A tool the assistant is running, shown as a short line while it works. */
export interface Step { name: string; state: 'running' | 'done' }

/** The data parts Teovo's server streams. Same names as on the server: data-card, data-step, data-action. */
export type TeovoData = { card: Card; step: Step; action: Action }

export type TeovoMessage = UIMessage<{ runId?: string; threadId?: string }, TeovoData>
