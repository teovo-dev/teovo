import type { Identity } from './tools'
import type { Budget, Period, Storage, Unit } from './storage'

/** Limits per period. `user` applies to each person, `tenant` to everyone in a tenant together. */
export interface Limits {
  period?: Period
  user?: Partial<Record<Unit, number>>
  tenant?: Partial<Record<Unit, number>>
  /** Replies one person may have running at once. Default 2. */
  maxRunning?: number
}

export interface LimitHit { scope: 'user' | 'tenant' | 'running'; unit?: Unit; period?: Period; limit: number; used: number }

/**
 * Checked before a model is called. Order of precedence: a tenant's own budget rows (for one person, then for
 * the whole tenant), then the code's limits. Returns the first limit reached, or null.
 */
export async function checkLimits(storage: Storage, identity: Identity, limits: Limits = {}, abandonAfterMs: number): Promise<LimitHit | null> {
  const maxRunning = limits.maxRunning ?? 2
  const running = await storage.runningRuns(identity.tenantId, identity.userId, new Date(Date.now() - abandonAfterMs))
  if (running >= maxRunning) return { scope: 'running', limit: maxRunning, used: running }

  const budgets = await storage.budgets(identity.tenantId, identity.userId)
  const periods = new Set<Period>([limits.period ?? 'day', ...budgets.map((b) => b.period)])
  for (const period of periods) {
    const own = (scope: 'user' | 'tenant', unit: Unit): number | undefined => {
      const rows = budgets.filter((b: Budget) => b.period === period && b.unit === unit && (scope === 'user' ? b.userId === identity.userId : b.userId === ''))
      if (rows.length) return rows[0]!.limit
      return period === (limits.period ?? 'day') ? limits[scope]?.[unit] : undefined
    }
    const used = await storage.usage(identity.tenantId, identity.userId, period)
    for (const scope of ['user', 'tenant'] as const) {
      for (const unit of ['messages', 'input_tokens', 'output_tokens'] as const) {
        const limit = own(scope, unit)
        const n = used[scope][unit] ?? 0
        if (limit !== undefined && n >= limit) return { scope, unit, period, limit, used: n }
      }
    }
  }
  return null
}

export function limitMessage(hit: LimitHit): string {
  const period = hit.period ?? 'day'
  if (hit.scope === 'running') return 'The assistant is still answering your last message. Wait for it to finish, then try again.'
  const when = period === 'day' ? 'tomorrow' : 'next month'
  return hit.scope === 'user'
    ? `You have reached your assistant limit for this ${period}. It resets ${when}.`
    : `Your team has reached its assistant limit for this ${period}. It resets ${when}.`
}
