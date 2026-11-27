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
}

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
}

type ToolResult<K extends ToolKind> = K extends 'propose' ? Proposal : K extends 'action' ? Action : unknown

export interface TeovoTool<K extends ToolKind = ToolKind, I = any, DB = any> {
  name: string
  description: string
  kind: K
  input: z.ZodType<I>
  /** Roles that may use this tool. Omitted: every role. A role not listed never sees the tool at all. */
  roles?: readonly string[]
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
