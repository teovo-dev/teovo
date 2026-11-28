import type { Page } from './screens.js'
import type { Identity } from './tools.js'

/** What a done-check sees: the reply as the user would get it, and what the run did to get there. */
export interface ReplyToCheck {
  /** The reply's words. */
  text: string
  /** The user's message it answers. */
  question: string
  /** Cards prepared in this run (they are already on screen; only the words are held back). */
  cards: { kind: string; title: string }[]
  /** Tools the model called in this run, in order. */
  toolCalls: { name: string; input: unknown }[]
  /** Which try this is: 0 for the first reply, 1 after one refusal, … */
  attempt: number
}

/**
 * A rule a reply must pass before the user sees it. Return a problem in a sentence (said to the model, which then writes
 * the reply again) or nothing when the reply is fine. A check that throws is reported to on.error and counts as passed,
 * so a bug in a check never stops replies.
 */
export interface DoneCheck<DB = unknown> {
  name: string
  check: (reply: ReplyToCheck, ctx: { identity: Identity; db: DB; page?: Page }) => string | null | undefined | false | Promise<string | null | undefined | false>
}

export const defineCheck = <DB = unknown>(c: DoneCheck<DB>): DoneCheck<DB> => c

/** Said to the user when every try was refused. */
export const CHECK_FAILED = 'I could not put together a reply I am sure of. Try asking in another way.'

/** What the model is told when its reply was refused. */
export const refusedNote = (problem: string) =>
  `[From the app, not the user] Your last reply was not sent, because: ${problem} Write the whole reply again, fixing that. ` +
  'The user has not seen it. Cards, tables and buttons you already showed are still on screen; do not show them again.'

/** The first problem any check finds, or null. */
export async function firstProblem<DB>(
  checks: readonly DoneCheck<DB>[],
  reply: ReplyToCheck,
  ctx: { identity: Identity; db: DB; page?: Page },
  onError: (e: unknown) => void,
): Promise<{ name: string; problem: string } | null> {
  for (const c of checks) {
    try {
      const p = await c.check(reply, ctx)
      if (typeof p === 'string' && p.trim()) return { name: c.name, problem: p.trim().slice(0, 1000) }
    } catch (e) {
      onError(e)
    }
  }
  return null
}

/**
 * A ready-made check: a reply that prepared a card must not say the change is already made. The rule is in the
 * instructions too, but small models still write "Payment recorded" next to a card that only waits for Confirm.
 */
export const noClaimedChanges: DoneCheck = {
  name: 'no-claimed-changes',
  check: (r) => {
    if (!r.cards.length) return null
    const claims = /\b(has been|have been|is now|are now|successfully|i(?:'|’)ve)\s+(recorded|saved|updated|added|created|marked|changed|deleted|applied|done)\b|\b(recorded|saved|updated|done)\s*[.!✅]/i
    return claims.test(r.text)
      ? `It says a change is already made, but "${r.cards[0]!.title}" only waits for the user to confirm. Say it is ready to confirm.`
      : null
  },
}
