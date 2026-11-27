import { Fragment, useState } from 'react'
import { useAssistant, useThreads } from './provider.js'
import type { ThreadSummary } from './types.js'

export interface ThreadListProps {
  /** Called after a conversation opens, e.g. to switch back to the chat view. */
  onOpen?: (id: string) => void
  limit?: number
  /** Language for the day headings and times, e.g. 'en-IN'. Default: the browser's. */
  locale?: string
  className?: string
}

const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today", "Yesterday", or the date; and the time for today's, the date otherwise. */
function when(iso: string, locale?: string, now = new Date()): { day: string; time: string } {
  const d = new Date(iso)
  const ago = (startOfDay(now) - startOfDay(d)) / DAY
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d)
  if (ago <= 0) return { day: 'Today', time }
  if (ago === 1) return { day: 'Yesterday', time }
  if (ago < 7) return { day: 'Earlier this week', time: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d) }
  const sameYear = d.getFullYear() === now.getFullYear()
  return { day: 'Older', time: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d) }
}

/** Earlier conversations, one row per chat, grouped by day: tap one to continue it, or remove it from the list. */
export function ThreadList(props: ThreadListProps) {
  const { openThread, threadId } = useAssistant()
  const { threads, error, archive } = useThreads(props.limit)
  const [failed, setFailed] = useState<string>()
  if (error) return <div className="tv-error" role="alert">{error}</div>
  if (!threads.length) return <div className={`tv-threads tv-empty ${props.className ?? ''}`}>No earlier conversations.</div>
  let lastDay = ''
  return (
    <ul className={`tv-threads ${props.className ?? ''}`} aria-label="Earlier conversations">
      {failed ? <li className="tv-error" role="alert">{failed}</li> : null}
      {threads.map((t: ThreadSummary) => {
        const w = when(t.updatedAt || t.createdAt, props.locale)
        const heading = w.day !== lastDay ? w.day : null
        lastDay = w.day
        return (
          <Fragment key={t.id}>
            {heading ? <li className="tv-threads-day" role="presentation">{heading}</li> : null}
            <li aria-current={t.id === threadId ? 'true' : undefined}>
              <button type="button" className="tv-thread" onClick={() => openThread(t.id).then(() => { setFailed(undefined); props.onOpen?.(t.id) }, (e: Error) => setFailed(e.message))}>
                <span className="tv-thread-title">{t.title || 'Untitled conversation'}</span>
                <span className="tv-thread-time" aria-hidden="true">{w.time}</span>
              </button>
              <button type="button" className="tv-thread-remove" aria-label={`Remove ${t.title || 'conversation'}`} title="Remove" onClick={() => archive(t.id).catch((e: Error) => setFailed(e.message))}>×</button>
            </li>
          </Fragment>
        )
      })}
    </ul>
  )
}
