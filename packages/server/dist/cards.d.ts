import type { Storage, StoredCard } from './storage.js';
import type { Identity, ToolContext } from './tools.js';
/** How the app applies (and maybe takes back) one kind of card. Keyed by the card's `kind`. */
export interface CardApplier<P = any, DB = any> {
    /** Roles that may confirm this kind of card. Omitted: anyone who could see it. */
    roles?: readonly string[];
    /**
     * The current values of the fields the card showed as `before`. If any differ, the record changed since the
     * card was prepared, and Confirm is refused so the user never applies a change to data they didn't see.
     */
    current?: (payload: P, ctx: ToolContext<DB>) => Promise<Record<string, unknown>> | Record<string, unknown>;
    /** Make the change, as this user. Throw an Error with a sentence for the user to refuse it. */
    apply: (payload: P, ctx: ToolContext<DB>) => Promise<ApplyResult | void> | ApplyResult | void;
    /** Take the change back, given what apply returned as `undo`. Without it the card can't be undone. */
    undo?: (undo: unknown, payload: P, ctx: ToolContext<DB>) => Promise<void> | void;
}
export interface ApplyResult {
    /** Whatever undo needs (e.g. the id of the row apply created). Stored with the card; never sent to the browser. */
    undo?: unknown;
}
export type Decision = 'confirm' | 'skip' | 'undo';
export interface CardRules {
    /** Cards older than this can't be confirmed any more. Default 24 hours. */
    ttlMs: number;
    /** How long after confirming a change can be undone. Default 10 minutes. */
    undoMs: number;
}
export declare class CardError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
/** What the browser may see of a card. */
export declare function publicCard(c: StoredCard): Omit<StoredCard, 'undo'>;
/** Confirm, skip or undo one card, for the person who was shown it. Throws CardError with a sentence for the user. */
export declare function decide<DB>(opts: {
    storage: Storage;
    appliers: Record<string, CardApplier<any, DB>>;
    rules: CardRules;
    identity: Identity;
    ctx: () => Promise<ToolContext<DB>>;
    id: string;
    decision: Decision;
}): Promise<StoredCard>;
/** How a card reads to the model in later turns, with its status now (not when it was shown). */
export declare function cardForModel(c: Pick<StoredCard, 'title' | 'status'>): string;
