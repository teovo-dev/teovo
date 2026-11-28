import type { ReactNode } from 'react'
import { headerIcons, SPARKLE } from './icons.js'
import { useAssistant } from './provider.js'

export interface AssistantHeaderProps {
  /** The chat's name. Default: the name from the server's config, else "Assistant". "Earlier chats" while the history shows. */
  title?: ReactNode
  /** A History button that switches the panel to the earlier conversations and back. Default true. */
  history?: boolean
  /** The current layout and how to change it: shows the dock / float switch. Omitted: no switch. */
  layout?: 'panel' | 'floating'
  onLayout?: (layout: 'panel' | 'floating') => void
  /** Shows a close button. */
  onClose?: () => void
  className?: string
}

/**
 * The chat's top bar: its name, History (earlier conversations), the dock / float switch and close. AssistantSheet
 * draws it; put it above AssistantPanel yourself when the chat has a place of its own (a full page, a side column).
 */
export function AssistantHeader(props: AssistantHeaderProps) {
  const { view, setView, policy } = useAssistant()
  const history = view === 'history' && props.history !== false
  return (
    <div className={`tv-header ${props.className ?? ''}`}>
      <span className="tv-header-mark" aria-hidden="true">{SPARKLE}</span>
      <div className="tv-header-title">{history ? 'Earlier chats' : props.title ?? policy.name ?? 'Assistant'}</div>
      {props.history !== false ? (
        <button type="button" className="tv-header-btn" aria-pressed={history} onClick={() => setView(history ? 'chat' : 'history')}
          aria-label={history ? 'Back to chat' : 'Earlier chats'} title={history ? 'Back to chat' : 'Earlier chats'}>
          {history ? headerIcons.back : headerIcons.history}
        </button>
      ) : null}
      {props.layout && props.onLayout ? (
        <button type="button" className="tv-header-btn tv-header-layout" onClick={() => props.onLayout!(props.layout === 'panel' ? 'floating' : 'panel')}
          aria-label={props.layout === 'panel' ? 'Float the chat as a window' : 'Dock the chat on the right'}
          title={props.layout === 'panel' ? 'Float as a window' : 'Dock on the right'}>
          {props.layout === 'panel' ? headerIcons.float : headerIcons.dock}
        </button>
      ) : null}
      {props.onClose ? (
        <button type="button" className="tv-header-btn tv-sheet-close" aria-label={`Close ${policy.name ?? 'assistant'}`} onClick={props.onClose}>
          {headerIcons.close}
        </button>
      ) : null}
    </div>
  )
}
