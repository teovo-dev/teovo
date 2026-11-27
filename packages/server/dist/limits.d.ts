import type { Identity } from './tools.js';
import type { Period, Storage, Unit } from './storage.js';
/** Limits per period. `user` applies to each person, `tenant` to everyone in a tenant together. */
export interface Limits {
    period?: Period;
    user?: Partial<Record<Unit, number>>;
    tenant?: Partial<Record<Unit, number>>;
    /** Replies one person may have running at once. Default 2. */
    maxRunning?: number;
}
export interface LimitHit {
    scope: 'user' | 'tenant' | 'running';
    unit?: Unit;
    period?: Period;
    limit: number;
    used: number;
}
/**
 * Checked before a model is called. Order of precedence: a tenant's own budget rows (for one person, then for
 * the whole tenant), then the code's limits. Returns the first limit reached, or null.
 */
export declare function checkLimits(storage: Storage, identity: Identity, limits: Limits | undefined, abandonAfterMs: number): Promise<LimitHit | null>;
export declare function limitMessage(hit: LimitHit): string;
