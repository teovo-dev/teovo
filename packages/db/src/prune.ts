import type { Query } from './migrate.js'

export interface PruneOptions {
  /** Delete conversations with no message newer than this many days, with their messages, runs, steps and cards. */
  days: number
  /** Count only; delete nothing. */
  dryRun?: boolean
}

export interface PruneResult { threads: number; usageRows: number }

/**
 * Delete old conversations and detailed usage rows. Daily usage totals and budgets are kept, so limits and
 * reports still work. Run it on a schedule (e.g. `npx teovo prune --days 90 --yes` in a nightly job).
 */
export async function prune(query: Query, { days, dryRun = false }: PruneOptions): Promise<PruneResult> {
  if (!Number.isFinite(days) || days < 1) throw new Error('prune: days must be 1 or more')
  const old = `select t.id from tv_threads t
    where t.created_at < now() - make_interval(days => $1)
      and not exists (select 1 from tv_messages m where m.thread_id = t.id and m.created_at >= now() - make_interval(days => $1))`
  if (dryRun) {
    const threads = (await query(`select count(*)::int as n from (${old}) x`, [days])).rows[0].n as number
    const usageRows = (await query(`select count(*)::int as n from tv_usage where created_at < now() - make_interval(days => $1)`, [days])).rows[0].n as number
    return { threads, usageRows }
  }
  const threads = (await query(`delete from tv_threads where id in (${old}) returning id`, [days])).rows.length
  const usageRows = (await query(`delete from tv_usage where created_at < now() - make_interval(days => $1) returning id`, [days])).rows.length
  return { threads, usageRows }
}
