import type { LanguageModelV4 } from '@ai-sdk/provider';
import { type CardApplier, type CardRules, type Decision } from './cards.js';
import { type LimitHit, type Limits } from './limits.js';
import type { Storage, StoredCard, UsageRow } from './storage.js';
import { type Identity, type TeovoTool } from './tools.js';
import { type Page, type ScreenFn, type SuggestionsFn } from './screens.js';
export type { Page } from './screens.js';
export interface AssistantConfig<DB = unknown> {
    /** Who is asking, from the request (cookie, token, header). Return null to refuse with 401. Required. */
    identify: (req: Request) => Promise<Identity | null> | Identity | null;
    /** A database client acting as this person; every tool receives it as ctx.db. Required. */
    asUser: (identity: Identity, req: Request) => Promise<DB> | DB;
    tools: readonly TeovoTool<any, any, DB>[];
    /** Models in order: if one fails before saying anything, the next is tried. */
    models: readonly LanguageModelV4[];
    /** The app's own instructions for the model. */
    instructions: string | ((ctx: {
        identity: Identity;
        page?: Page;
    }) => string | Promise<string>);
    storage: Storage;
    /** Model calls per message, tool calls included. Default 8. */
    maxSteps?: number;
    /** Earlier messages the model sees. Default 30. */
    historyMessages?: number;
    /** Give up on a model that sends nothing at first, goes quiet, or runs too long. Milliseconds. */
    timeouts?: {
        firstChunkMs?: number;
        chunkMs?: number;
        totalMs?: number;
    };
    /** Messages and tokens per person and per tenant, checked before every reply. Tenants can set their own in tv_budgets. */
    limits?: Limits;
    /** Describe the screen and its open record for the model, as the user. See screens.ts. */
    screen?: ScreenFn<DB>;
    /** Chips above the input and the hint inside it; also called after each reply for follow-ups. */
    suggestions?: SuggestionsFn<DB>;
    /** How to apply each kind of card when the user confirms it, keyed by the card's `kind`. */
    cards?: Record<string, CardApplier<any, DB>>;
    /** How long a card can be confirmed, and how long after confirming it can be undone. */
    cardRules?: Partial<CardRules>;
    /** Roles that may read and change their tenant's settings (GET/PUT …/settings). Default ['owner', 'admin']. */
    settingsRoles?: readonly string[];
    /** Saved on each run, so a change in replies can be traced to a change in instructions. */
    promptVersion?: string;
    /** Tool inputs and outputs longer than this are cut in the run log (the model still sees all of it). Default 8000 characters. */
    logLimit?: number;
    on?: {
        error?: (error: unknown, ctx: {
            identity: Identity;
            threadId: string;
        }) => void;
        modelSwitch?: (from: string, error: unknown) => void;
        card?: (card: StoredCard) => void;
        limit?: (hit: LimitHit, identity: Identity) => void;
        usage?: (rows: UsageRow[]) => void;
        decision?: (card: StoredCard, decision: Decision, identity: Identity) => void;
    };
}
export declare function createAssistant<DB>(config: AssistantConfig<DB>): {
    /** Mount under any path, e.g. app.all('/api/assistant/*', teovo.fetch). Handles POST …/chat, GET …/suggestions, GET/PUT …/settings and POST …/cards/:id/(confirm|skip|undo). */
    fetch(req: Request): Promise<Response>;
};
