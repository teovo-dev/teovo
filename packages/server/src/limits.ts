import type { Identity } from './tools.js'
import type { Budget, Period, Storage, Unit } from './storage.js'

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
      for (const unit of ['messages', 'input_tokens', 'output_tokens', 'neurons'] as const) {
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
    ? `You have reached your assistant limit for ${period === 'day' ? 'today' : `this ${period}`}. It resets ${when}.`
    : `Your team has reached its assistant limit for ${period === 'day' ? 'today' : `this ${period}`}. It resets ${when}.`
}

export interface AllowanceItem { scope: 'user' | 'tenant'; unit: Unit; period: Period; limit: number; used: number }

/** Every limit that applies to this person now, with how much of it is used: the tenant's own budgets first, then the code's. */
export async function allowance(storage: Storage, identity: Identity, limits: Limits = {}): Promise<AllowanceItem[]> {
  const budgets = await storage.budgets(identity.tenantId, identity.userId)
  const periods = new Set<Period>([limits.period ?? 'day', ...budgets.map((b) => b.period)])
  const out: AllowanceItem[] = []
  for (const period of periods) {
    const used = await storage.usage(identity.tenantId, identity.userId, period)
    for (const scope of ['user', 'tenant'] as const) {
      for (const unit of ['messages', 'input_tokens', 'output_tokens', 'neurons'] as const) {
        const rows = budgets.filter((b) => b.period === period && b.unit === unit && (scope === 'user' ? b.userId === identity.userId : b.userId === ''))
        const limit = rows.length ? rows[0]!.limit : period === (limits.period ?? 'day') ? limits[scope]?.[unit] : undefined
        if (limit !== undefined) out.push({ scope, unit, period, limit, used: used[scope][unit] ?? 0 })
      }
    }
  }
  return out
}
