import type { Schema } from 'ai'
import type { z } from 'zod'

/** Who is asking. The app's `identify` callback returns this; the kit never decides it. */
export interface Identity {
  tenantId: string
  userId: string
  role: string
}

/**
 * read:    looks something up and returns data to the model.
 * propose: prepares a change and returns a card for the user to confirm; nothing is written.
 * action:  offers the user a button (open a screen, run an app action); nothing is written.
 */
export type ToolKind = 'read' | 'propose' | 'action'

/** A change the user must confirm, shown as a card. */
export interface Proposal {
  kind: string
  title: string
  /** Values before and after the change, shown side by side on the card. */
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** Everything the app needs to apply the change later. */
  payload: unknown
  /**
   * How the card shows the values: which fields, in this order, with labels and formats (money shows as ₹1,320.00,
   * dates as 26 Nov 2026). Omitted: every key of before/after, named from the key. Cards from a form get the form's.
   */
  fields?: CardField[]
  /** A change to many records in one card: each row's own before and after, shown as a list; confirmed and undone together. */
  items?: CardItem[]
  /**
   * The change in plain sentences, written by code, e.g. ['2 × Belgian 500 ml — ₹760', 'Paid by GPay']. Shown on the
   * card above any before/after values; use it when the change is easier to read as lines than as fields.
   */
  lines?: string[]
  /** Which version of the tool made it (set by Teovo from defineTool's version). */
  version?: number
}

export interface CardItem { label: string; before?: Record<string, unknown>; after?: Record<string, unknown> }

export interface CardField { key: string; label?: string; format?: 'text' | 'number' | 'money' | 'date' }

/** A link to a record an answer came from. */
export interface RecordLink { label: string; to: string }

/** A button under the reply. */
export interface Action {
  label: string
  action: string
  args?: Record<string, unknown>
}

export interface ToolContext<DB = unknown> {
  identity: Identity
  /** A database client acting as this user, from the app's `asUser` callback. */
  db: DB
  /** Wrap text that came from outside the app (customer notes, screenshots, web pages). See untrusted.ts. */
  untrusted: (text: string, source: string) => string
  /**
   * With `spend` set: set more aside for this reply before costly work (e.g. a report), in the app's unit. False when
   * it can't be: then don't do the costly part, and say so. Undefined when the app has no spend rules.
   */
  reserve?: (amount: number, reason?: string) => Promise<boolean>
}

type ToolResult<K extends ToolKind> = K extends 'propose' ? Proposal : K extends 'action' ? Action : unknown

export interface TeovoTool<K extends ToolKind = ToolKind, I = any, DB = any> {
  name: string
  description: string
  kind: K
  /**
   * What the tool takes: a zod schema (checked before run), or a JSON schema wrapped with jsonSchema() from 'ai'
   * when the app already has its tools written that way (not checked here; check inside run).
   */
  input: z.ZodType<I> | Schema<I>
  /** Roles that may use this tool. Omitted: every role. A role not listed never sees the tool at all. */
  roles?: readonly string[]
  /**
   * For propose tools: bump it when the payload's shape changes. Each card remembers the version that made it, so
   * a card prepared before a deploy is migrated (or refused) by the applier instead of being applied wrongly.
   */
  version?: number
  /**
   * For read tools: the app's own pages for the records this result came from, shown under the answer as links
   * ("From: Order #142"). Up to 5 per reply. Paths are the app's own (they go to onAction as navigate).
   */
  links?: (output: any, input: I) => RecordLink[]
  run: (input: I, ctx: ToolContext<DB>) => Promise<ToolResult<K>> | ToolResult<K>
}

export function defineTool<K extends ToolKind, I, DB = any>(tool: TeovoTool<K, I, DB>): TeovoTool<K, I, DB> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Tool name "${tool.name}" must be lowercase letters, digits and underscores`)
  return tool
}

/** The tools this person may use. */
export function toolsFor(tools: readonly TeovoTool[], identity: Identity): TeovoTool[] {
  return tools.filter((t) => !t.roles || t.roles.includes(identity.role))
}
