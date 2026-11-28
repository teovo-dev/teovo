import type { CardStatus, Storage, StoredCard } from './storage.js'
import type { Identity, ToolContext } from './tools.js'

/** How the app applies (and maybe takes back) one kind of card. Keyed by the card's `kind`. */
export interface CardApplier<P = any, DB = any> {
  /** Roles that may confirm this kind of card. Omitted: anyone who could see it. */
  roles?: readonly string[]
  /**
   * The record this card changes, as it is now (any JSON; null when it is gone). Teovo reads it when the card is made
   * and again right after applying it, and keeps a fingerprint with the card. Confirm is refused if the record changed
   * after the card was made, and Undo if it changed after Confirm, so neither writes over changes made meanwhile (an
   * edit on another screen, a second payment). Without it nothing is checked. (A card that shows `before` and has no
   * fingerprint, e.g. one made before an upgrade, is checked field by field against `before`, as before.)
   */
  current?: (payload: P, ctx: ToolContext<DB>) => unknown
  /** Make the change, as this user. Throw an Error with a sentence for the user to refuse it. */
  apply: (payload: P, ctx: ToolContext<DB>) => Promise<ApplyResult | void> | ApplyResult | void
  /** Take the change back, given what apply returned as `undo`. Without it the card can't be undone. */
  undo?: (undo: unknown, payload: P, ctx: ToolContext<DB>) => Promise<void> | void
  /**
   * 'low': a small change that is easy to take back (a status, a note, a tag) is applied as soon as the card is made,
   * without Confirm; the card shows it done, with Undo for `undoMs`. It still waits for Confirm when this applier has
   * no `undo`, when the card was prepared after reading outside text (a customer message, a picture), when the
   * person's role may not confirm it, or when no one is at the screen (a reply the app started). Default: every card
   * waits for Confirm.
   */
  risk?: 'low'
  /** The payload version this applier expects (the tool's version). Default 1. */
  version?: number
  /** Bring an older card's payload up to `version`. Without it, a card from another version is refused, not guessed at. */
  migrate?: (payload: unknown, fromVersion: number) => P
}

/**
 * A kind of card the app applies itself, in the browser with the user's own login (AssistantProvider's onCard).
 * The server still holds the card and who may decide it; Confirm, Skip and Undo only record what happened, so the
 * card keeps its state after a reload and the model knows the outcome.
 */
export interface AppCard {
  inApp: true
  /** Roles that may confirm it. Omitted: anyone who could see it. */
  roles?: readonly string[]
  /** The payload version the app applies now (the tool's version). A card from another version is refused. Default 1. */
  version?: number
}

/** The same JSON whatever order its keys come in (Postgres jsonb reorders them); absent and undefined alike. */
export function fingerprint(value: unknown): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    : v === undefined ? null : v)
  return JSON.stringify(canon(value))
}

const CHANGED_BEFORE_CONFIRM = 'This changed after the card was made, so nothing was saved. Ask again for a fresh card.'
const CHANGED_AFTER_CONFIRM = 'This changed after you confirmed it, so it can’t be undone here. Change it on its own screen instead.'

/** The applier's current, with its error as the user's sentence (the record is gone, say), like apply's. */
async function readCurrent<DB>(applier: CardApplier<any, DB>, payload: unknown, ctx: ToolContext<DB>): Promise<unknown> {
  try { return await applier.current!(payload, ctx) } catch (e) { throw new CardError(422, e instanceof Error ? e.message : String(e)) }
}

const OLD_CARD = 'This card was prepared by an earlier version of the app. Ask again and the assistant will prepare a fresh one.'

export type CardHandler<DB = any> = CardApplier<any, DB> | AppCard
const isApp = (h: CardHandler | undefined): h is AppCard => !!h && 'inApp' in h && h.inApp === true

export interface ApplyResult {
  /** Whatever undo needs (e.g. the id of the row apply created). Stored with the card; never sent to the browser. */
  undo?: unknown
  /** A short line the card shows once confirmed, e.g. "Sale #12 saved". Default: "Done". */
  note?: string
  /** Where to see the result; the card shows it as a button that opens the screen (onAction 'navigate'). */
  link?: { label: string; to: string }
}

export type Decision = 'confirm' | 'skip' | 'undo'

export interface CardRules {
  /** Cards older than this can't be confirmed any more. Default 24 hours. */
  ttlMs: number
  /** How long after confirming a change can be undone. Default 10 minutes. */
  undoMs: number
}

export class CardError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** What the browser may see of a card. */
export function publicCard(c: StoredCard): Omit<StoredCard, 'undo' | 'recordVersion'> {
  const { undo: _, recordVersion: _v, ...rest } = c
  return rest
}

/** Confirm, skip or undo one card, for the person who was shown it. Throws CardError with a sentence for the user. */
export async function decide<DB>(opts: {
  storage: Storage; appliers: Record<string, CardHandler<DB>>; rules: CardRules
  identity: Identity; ctx: () => Promise<ToolContext<DB>>; id: string; decision: Decision
  /** For an app-applied card: whether the app can take the change back (what its onCard returned). */
  reversible?: boolean
}): Promise<StoredCard> {
  const { storage, identity, id, decision, rules } = opts
  const card = await storage.getCard(identity.tenantId, identity.userId, id)
  if (!card) throw new CardError(404, 'That card was not found.')
  const handler = opts.appliers[card.kind]
  if (isApp(handler)) return recordAppDecision(storage, card, handler, identity, decision, rules, opts.reversible)
  const applier = handler
  const now = new Date()
  const claim = async (from: CardStatus[], patch: Parameters<Storage['updateCard']>[2]) => {
    const c = await storage.updateCard(id, from, patch)
    if (!c) throw new CardError(409, 'This card was already decided.')
    return c
  }

  if (decision === 'skip') return claim(['shown'], { status: 'skipped', decidedBy: identity.userId, decidedAt: now.toISOString() })

  if (decision === 'confirm') {
    if (card.status !== 'shown') throw new CardError(409, 'This card was already decided.')
    if (!applier) throw new CardError(501, `This app can't apply "${card.kind}" changes yet.`)
    if (applier.roles && !applier.roles.includes(identity.role)) throw new CardError(403, 'Your role can’t make this change. Ask an owner.')
    if (card.createdAt && now.getTime() - new Date(card.createdAt).getTime() > rules.ttlMs) {
      await storage.updateCard(id, ['shown'], { status: 'expired' })
      throw new CardError(410, 'This card is too old to apply. Ask again and the assistant will prepare a fresh one.')
    }
    // A card made by another version of the tool: migrate its payload, or refuse rather than guess.
    if ((card.version ?? 1) !== (applier.version ?? 1)) {
      if (!applier.migrate) {
        await storage.updateCard(id, ['shown'], { status: 'expired' })
        throw new CardError(409, OLD_CARD)
      }
      card.payload = applier.migrate(card.payload, card.version ?? 1)
    }
    const ctx = await opts.ctx()
    if (applier.current && (card.recordVersion !== undefined || card.before)) {
      const cur = await readCurrent(applier, card.payload, ctx)
      // Fields the card showed that differ now, named in the sentence when there are any.
      const changed = card.before ? Object.keys(card.before).filter((k) => fingerprint(((cur ?? {}) as Record<string, unknown>)[k]) !== fingerprint(card.before![k])) : []
      if (changed.length || (card.recordVersion !== undefined && fingerprint(cur) !== card.recordVersion)) {
        await storage.updateCard(id, ['shown'], { status: 'expired' })
        throw new CardError(409, changed.length ? `This changed since the card was prepared (${changed.join(', ')}). Ask again for a fresh card.` : CHANGED_BEFORE_CONFIRM)
      }
    }
    const claimed = await claim(['shown'], { status: 'confirmed', decidedBy: identity.userId, decidedAt: now.toISOString() })
    try {
      const out = await applier.apply(card.payload, ctx)
      const reversible = Boolean(applier.undo)
      // What applying left, so Undo can tell whether anything changed it since. If it can't be read, Undo isn't checked.
      const recordVersion = applier.current && reversible ? await readCurrent(applier, card.payload, ctx).then(fingerprint, () => undefined) : undefined
      const saved = (await storage.updateCard(id, ['confirmed'], { reversible, undo: out?.undo ?? null, recordVersion })) ?? claimed
      return { ...saved, ...(out?.note ? { note: out.note } : {}), ...(out?.link ? { link: out.link } : {}) }
    } catch (e) {
      // Nothing was applied: put the card back so the user can try again or skip it.
      await storage.updateCard(id, ['confirmed'], { status: 'shown', decidedBy: undefined, decidedAt: undefined })
      throw new CardError(422, e instanceof Error ? e.message : String(e))
    }
  }

  // undo
  if (card.status !== 'confirmed') throw new CardError(409, 'Only a confirmed change can be undone.')
  if (!applier?.undo || !card.reversible) throw new CardError(409, 'This change can’t be undone here.')
  if (card.decidedBy !== identity.userId) throw new CardError(403, 'Only the person who confirmed this can undo it.')
  if (now.getTime() - new Date(card.decidedAt!).getTime() > rules.undoMs) throw new CardError(410, 'It’s too late to undo this here.')
  const ctx = await opts.ctx()
  if (applier.current && card.recordVersion !== undefined && fingerprint(await readCurrent(applier, card.payload, ctx)) !== card.recordVersion) {
    throw new CardError(409, CHANGED_AFTER_CONFIRM)
  }
  const claimed = await claim(['confirmed'], { status: 'undone', undoneAt: now.toISOString() })
  try {
    await applier.undo(card.undo, card.payload, ctx)
    return claimed
  } catch (e) {
    await storage.updateCard(id, ['undone'], { status: 'confirmed', undoneAt: undefined })
    throw new CardError(422, e instanceof Error ? e.message : String(e))
  }
}

/** The app already applied (or skipped, or undid) it in the browser: check who may, then record it. */
async function recordAppDecision(storage: Storage, card: StoredCard, h: AppCard, identity: Identity, decision: Decision, rules: CardRules, reversible?: boolean): Promise<StoredCard> {
  const now = new Date()
  const claim = async (from: CardStatus[], patch: Parameters<Storage['updateCard']>[2]) => {
    const c = await storage.updateCard(card.id, from, patch)
    if (!c) throw new CardError(409, 'This card was already decided.')
    return c
  }
  if (decision === 'skip') return claim(['shown'], { status: 'skipped', decidedBy: identity.userId, decidedAt: now.toISOString() })
  if (decision === 'confirm') {
    if (h.roles && !h.roles.includes(identity.role)) throw new CardError(403, 'Your role can’t make this change. Ask an owner.')
    if ((card.version ?? 1) !== (h.version ?? 1)) {
      await storage.updateCard(card.id, ['shown'], { status: 'expired' })
      throw new CardError(409, OLD_CARD)
    }
    return claim(['shown'], { status: 'confirmed', decidedBy: identity.userId, decidedAt: now.toISOString(), reversible: reversible === true })
  }
  if (card.decidedBy !== identity.userId) throw new CardError(403, 'Only the person who confirmed this can undo it.')
  if (!card.reversible) throw new CardError(409, 'This change can’t be undone here.')
  if (now.getTime() - new Date(card.decidedAt!).getTime() > rules.undoMs) throw new CardError(410, 'It’s too late to undo this here.')
  return claim(['confirmed'], { status: 'undone', undoneAt: now.toISOString() })
}

/** How a card reads to the model in later turns, with its status now (not when it was shown). */
export function cardForModel(c: Pick<StoredCard, 'title' | 'status'>): string {
  const what = { shown: 'shown, not decided yet', confirmed: 'the user confirmed it and it was applied', skipped: 'the user skipped it; nothing changed',
    undone: 'the user confirmed it, then undid it; nothing changed', expired: 'it expired before being applied; nothing changed',
    waiting_for_approval: 'waiting for someone to approve it' }[c.status]
  return `[Card "${c.title}": ${what}]`
}
