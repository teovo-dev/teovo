import type { Identity, ToolContext } from './tools.js';
/** Where the user is, as the panel reports it. Every field comes from the browser: treat it as a claim, not a fact. */
export interface Page {
    path?: string;
    title?: string;
    /** The record open on screen, e.g. { type: 'order', id: '142' }. */
    record?: {
        type: string;
        id: string;
    };
}
/**
 * Describe the screen for the model, as this user (so a record they can't see stays unseen). Return a few lines
 * of facts, e.g. "Order #142 for Riya: ₹880, unpaid, due Friday", or null when there's nothing useful to add.
 */
export type ScreenFn<DB> = (page: Page, ctx: ToolContext<DB>) => Promise<string | null> | string | null;
/** Questions shown as chips above the input, and the grey hint inside it (Tab accepts it). */
export interface Suggestions {
    suggestions: string[];
    placeholder?: string;
}
/**
 * Suggestions for this person on this screen. `after` is the assistant's last reply when called after a reply
 * (for follow-ups), undefined when the panel opens or the screen changes.
 */
export type SuggestionsFn<DB> = (ctx: {
    identity: Identity;
    page?: Page;
    after?: string;
    db: DB;
}) => Promise<Suggestions> | Suggestions;
/** Keep suggestions short and few, whatever the app returns. */
export declare function tidy(s: Suggestions): Suggestions;
/** A page from the request body or query string, with anything malformed dropped. */
export declare function readPage(raw: unknown): Page | undefined;
/** The part of the system prompt that says where the user is. All of it is fenced: the browser and the records supplied it. */
export declare function screenText(page: Page | undefined, summary: string | null, untrusted: (text: string, source: string) => string): string;
