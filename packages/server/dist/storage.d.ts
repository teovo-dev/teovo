import type { UIMessage } from 'ai';
import type { TenantSettings } from './settings.js';
import type { Proposal } from './tools.js';
export interface Thread {
    id: string;
    tenantId: string;
    userId: string;
    title: string | null;
    createdAt: string;
}
export interface StoredCard extends Proposal {
    id: string;
    threadId: string;
    runId: string;
    status: CardStatus;
    createdAt?: string;
    decidedBy?: string;
    decidedAt?: string;
    /** Set when the card was applied and the app can take it back. */
    reversible?: boolean;
    /** What the app's undo needs, returned by its apply. Never sent to the browser. */
    undo?: unknown;
    undoneAt?: string;
}
export type CardStatus = 'shown' | 'confirmed' | 'skipped' | 'undone' | 'expired' | 'waiting_for_approval';
/** The fields a decision changes. */
export type CardPatch = Partial<Pick<StoredCard, 'status' | 'decidedBy' | 'decidedAt' | 'reversible' | 'undo' | 'undoneAt'>>;
/**
 * Where the kit keeps conversations and cards. @teovo/db provides the Postgres version; `memoryStorage` is for
 * tests and local trials. Every call is scoped to one tenant and one user: a thread is only ever found by the
 * person who started it.
 */
export interface Storage {
    getThread(tenantId: string, userId: string, threadId: string): Promise<Thread | null>;
    createThread(tenantId: string, userId: string): Promise<Thread>;
    listMessages(threadId: string): Promise<UIMessage[]>;
    saveMessages(threadId: string, messages: UIMessage[]): Promise<void>;
    saveCard(card: StoredCard): Promise<void>;
    /** A card, only if it is in one of this person's threads. */
    getCard(tenantId: string, userId: string, id: string): Promise<StoredCard | null>;
    listCards(threadId: string): Promise<StoredCard[]>;
    /**
     * Change a card only if its status is still one of `from`; returns the updated card, or null if someone
     * (a second tab, a double tap) got there first. This is what makes Confirm safe to press twice.
     */
    updateCard(id: string, from: CardStatus[], patch: CardPatch): Promise<StoredCard | null>;
    /** A tenant's own settings, or null when it never saved any. */
    tenantSettings(tenantId: string): Promise<TenantSettings | null>;
    saveTenantSettings(tenantId: string, settings: TenantSettings): Promise<void>;
    startRun(run: RunRecord): Promise<void>;
    finishRun(id: string, end: {
        status: 'done' | 'failed' | 'stopped';
        model?: string;
        error?: string;
    }): Promise<void>;
    saveStep(step: StepRecord): Promise<void>;
    /** Number of this person's runs still running that started after `since` (older ones count as abandoned). */
    runningRuns(tenantId: string, userId: string, since: Date): Promise<number>;
    addUsage(rows: UsageRow[]): Promise<void>;
    /** Totals for the current day or month (UTC), for this person and for the whole tenant. */
    usage(tenantId: string, userId: string, period: Period): Promise<{
        user: Totals;
        tenant: Totals;
    }>;
    /** Limits a tenant set for itself (user '' = the whole tenant) or for one person; they override the code's. */
    budgets(tenantId: string, userId: string): Promise<Budget[]>;
}
export type Unit = 'messages' | 'input_tokens' | 'output_tokens';
export type Period = 'day' | 'month';
export type Totals = Partial<Record<Unit, number>>;
export interface Budget {
    userId: string;
    unit: Unit;
    period: Period;
    limit: number;
}
export interface RunRecord {
    id: string;
    threadId: string;
    tenantId: string;
    userId: string;
    model?: string;
    promptVersion?: string;
}
export interface StepRecord {
    runId: string;
    seq: number;
    type: 'tool';
    toolCallId?: string;
    name: string;
    input?: unknown;
    output?: unknown;
    truncated: boolean;
    error?: string;
    durationMs: number;
}
export interface UsageRow {
    tenantId: string;
    userId: string;
    runId?: string;
    provider: string;
    model: string;
    unit: Unit;
    amount: number;
}
/** The UTC day or month a moment falls in, as the key usage is summed under ('2026-11-27' / '2026-11'). */
export declare const periodKey: (period: Period, at?: Date) => string;
export interface MemoryRun extends RunRecord {
    status: 'running' | 'done' | 'failed' | 'stopped';
    startedAt: Date;
    error?: string;
}
export declare function memoryStorage(): Storage & {
    threads: Map<string, Thread>;
    messages: Map<string, UIMessage<unknown, import("ai").UIDataTypes, import("ai").UITools>[]>;
    cards: Map<string, StoredCard>;
    runs: Map<string, MemoryRun>;
    steps: StepRecord[];
    usageRows: (UsageRow & {
        at: Date;
    })[];
    budgetRows: (Budget & {
        tenantId: string;
    })[];
    settings: Map<string, TenantSettings>;
};
