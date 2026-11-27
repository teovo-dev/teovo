import type { CardStatus, Storage, StoredCard } from './storage.js'
import type { Identity, ToolContext } from './tools.js'

/** How the app applies (and maybe takes back) one kind of card. Keyed by the card's `kind`. */
export interface CardApplier<P = any, DB = any> {
  /** Roles that may confirm this kind of card. Omitted: anyone who could see it. */
  roles?: readonly string[]
  /**
   * The current values of the fields the card showed as `before`. If any differ, the record changed since the
   * card was prepared, and Confirm is refused so the user never applies a change to data they didn't see.
   */
  current?: (payload: P, ctx: ToolContext<DB>) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** Make the change, as this user. Throw an Error with a sentence for the user to refuse it. */
  apply: (payload: P, ctx: ToolContext<DB>) => Promise<ApplyResult | void> | ApplyResult | void
  /** Take the change back, given what apply returned as `undo`. Without it the card can't be undone. */
  undo?: (undo: unknown, payload: P, ctx: ToolContext<DB>) => Promise<void> | void
}

export interface ApplyResult {
  /** Whatever undo needs (e.g. the id of the row apply created). Stored with the card; never sent to the browser. */
  undo?: unknown
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
export function publicCard(c: StoredCard): Omit<StoredCard, 'undo'> {
  const { undo: _, ...rest } = c
  return rest
}

/** Confirm, skip or undo one card, for the person who was shown it. Throws CardError with a sentence for the user. */
export async function decide<DB>(opts: {
  storage: Storage; appliers: Record<string, CardApplier<any, DB>>; rules: CardRules
  identity: Identity; ctx: () => Promise<ToolContext<DB>>; id: string; decision: Decision
}): Promise<StoredCard> {
  const { storage, identity, id, decision, rules } = opts
  const card = await storage.getCard(identity.tenantId, identity.userId, id)
  if (!card) throw new CardError(404, 'That card was not found.')
  const applier = opts.appliers[card.kind]
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
    const ctx = await opts.ctx()
    if (applier.current && card.before) {
      const cur = await applier.current(card.payload, ctx)
      const changed = Object.keys(card.before).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(card.before![k]))
      if (changed.length) {
        await storage.updateCard(id, ['shown'], { status: 'expired' })
        throw new CardError(409, `This changed since the card was prepared (${changed.join(', ')}). Ask again for a fresh card.`)
      }
    }
    const claimed = await claim(['shown'], { status: 'confirmed', decidedBy: identity.userId, decidedAt: now.toISOString() })
    try {
      const out = await applier.apply(card.payload, ctx)
      const reversible = Boolean(applier.undo)
      return (await storage.updateCard(id, ['confirmed'], { reversible, undo: out?.undo ?? null })) ?? claimed
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
  const claimed = await claim(['confirmed'], { status: 'undone', undoneAt: now.toISOString() })
  try {
    await applier.undo(card.undo, card.payload, await opts.ctx())
    return claimed
  } catch (e) {
    await storage.updateCard(id, ['undone'], { status: 'confirmed', undoneAt: undefined })
    throw new CardError(422, e instanceof Error ? e.message : String(e))
  }
}

/** How a card reads to the model in later turns, with its status now (not when it was shown). */
export function cardForModel(c: Pick<StoredCard, 'title' | 'status'>): string {
  const what = { shown: 'shown, not decided yet', confirmed: 'the user confirmed it and it was applied', skipped: 'the user skipped it; nothing changed',
    undone: 'the user confirmed it, then undid it; nothing changed', expired: 'it expired before being applied; nothing changed',
    waiting_for_approval: 'waiting for someone to approve it' }[c.status]
  return `[Card "${c.title}": ${what}]`
}
