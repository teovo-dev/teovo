import { useState } from 'react'
import { useAssistant, useThreads } from './provider.js'

export interface ThreadListProps {
  /** Called after a conversation opens, e.g. to switch back to the chat view. */
  onOpen?: (id: string) => void
  limit?: number
  className?: string
}

/** Earlier conversations: tap one to continue it, or remove it from the list. */
export function ThreadList(props: ThreadListProps) {
  const { openThread, threadId } = useAssistant()
  const { threads, error, archive } = useThreads(props.limit)
  const [failed, setFailed] = useState<string>()
  if (error) return <div className="tv-error" role="alert">{error}</div>
  if (!threads.length) return <div className={`tv-threads tv-empty ${props.className ?? ''}`}>No earlier conversations.</div>
  return (
    <ul className={`tv-threads ${props.className ?? ''}`} aria-label="Earlier conversations">
      {failed ? <li className="tv-error" role="alert">{failed}</li> : null}
      {threads.map((t) => (
        <li key={t.id} aria-current={t.id === threadId ? 'true' : undefined}>
          <button type="button" className="tv-thread" onClick={() => openThread(t.id).then(() => { setFailed(undefined); props.onOpen?.(t.id) }, (e: Error) => setFailed(e.message))}>
            {t.title || 'Untitled conversation'}
          </button>
          <button type="button" className="tv-thread-remove" aria-label={`Remove ${t.title || 'conversation'}`} onClick={() => archive(t.id).catch((e: Error) => setFailed(e.message))}>×</button>
        </li>
      ))}
    </ul>
  )
}
