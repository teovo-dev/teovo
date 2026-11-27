import type { Query } from './migrate.js';
export interface PruneOptions {
    /** Delete conversations with no message newer than this many days, with their messages, runs, steps and cards. */
    days: number;
    /** Count only; delete nothing. */
    dryRun?: boolean;
}
export interface PruneResult {
    threads: number;
    usageRows: number;
}
/**
 * Delete old conversations and detailed usage rows. Daily usage totals and budgets are kept, so limits and
 * reports still work. Run it on a schedule (e.g. `npx teovo prune --days 90 --yes` in a nightly job).
 */
export declare function prune(query: Query, { days, dryRun }: PruneOptions): Promise<PruneResult>;
