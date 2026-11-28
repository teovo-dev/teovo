import type { CSSProperties, ReactNode } from 'react'
import { useAssistant } from './provider.js'
import type { AllowanceItem } from './types.js'

const UNIT_NAMES: Record<AllowanceItem['unit'], string> = {
  messages: 'requests', input_tokens: 'input tokens', output_tokens: 'output tokens', neurons: 'Workers AI neurons',
}

export interface AllowanceMeterProps {
  /** Whose allowance: the whole tenant's (default) or this person's own. */
  scope?: AllowanceItem['scope']
  /** Which period's limits. Default 'day'. */
  period?: AllowanceItem['period']
  /** The app's words for each unit, e.g. { messages: 'AI requests (chat, filling forms, voice)' }. */
  units?: Partial<Record<AllowanceItem['unit'], string>>
  /** A heading above the bar. Default "Assistant usage today" (or "this month"); null for none. */
  title?: ReactNode
  /** A line under the numbers, e.g. what happens when it runs out. */
  note?: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * How much of the assistant allowance is used, as a bar with the numbers under it: for a settings screen. The bar
 * follows the tightest limit; it turns amber at 70% and red at 90%. Draws nothing when no limit applies.
 */
export function AllowanceMeter(props: AllowanceMeterProps) {
  const { allowance } = useAssistant()
  const period = props.period ?? 'day'
  const items = allowance.filter((a) => a.scope === (props.scope ?? 'tenant') && a.period === period && a.limit > 0)
  if (!items.length) return null
  const pct = Math.min(100, Math.round(Math.max(...items.map((a) => a.used / a.limit)) * 100))
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'
  const when = period === 'day' ? 'today' : 'this month'
  const title = props.title === undefined ? `Assistant usage ${when}` : props.title
  return (
    <div className={`tv-meter tv-meter-${level}${props.className ? ` ${props.className}` : ''}`} style={props.style}>
      <div className="tv-meter-top">
        {title !== null ? <span className="tv-meter-title">{title}</span> : <span />}
        <span className="tv-meter-pct">{pct}%</span>
      </div>
      <div className="tv-meter-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={typeof title === 'string' ? title : 'Assistant usage'}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="tv-meter-lines">
        {items.map((a) => `${Math.round(a.used).toLocaleString()} of ${a.limit.toLocaleString()} ${props.units?.[a.unit] ?? UNIT_NAMES[a.unit]}`).join(' · ')} {when}.
        {props.note ? <> {props.note}</> : null}
      </p>
    </div>
  )
}
