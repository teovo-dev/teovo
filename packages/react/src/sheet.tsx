import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** The app's look, as CSS variables on the panel. Anything left out keeps the default in styles.css. */
export interface Theme {
  accent?: string
  accentText?: string
  background?: string
  text?: string
  muted?: string
  border?: string
  userBubble?: string
  radius?: string
  font?: string
  /** Force light or dark; default follows the device. */
  mode?: 'light' | 'dark'
}

const VARS: Record<Exclude<keyof Theme, 'mode'>, string> = {
  accent: '--tv-accent', accentText: '--tv-accent-text', background: '--tv-bg', text: '--tv-fg', muted: '--tv-muted',
  border: '--tv-border', userBubble: '--tv-user-bg', radius: '--tv-radius', font: '--tv-font',
}

export function themeStyle(theme: Theme | undefined): CSSProperties {
  const style: Record<string, string> = {}
  for (const [k, v] of Object.entries(theme ?? {})) if (k !== 'mode' && v) style[VARS[k as keyof typeof VARS]] = v
  return style as CSSProperties
}

export interface AssistantSheetProps {
  children: ReactNode
  theme?: Theme
  /** The open button's text. */
  label?: string
  /** Keyboard shortcut to open and close, with Ctrl (Windows, Linux) or ⌘ (Mac). Default 'k'; null for none. */
  shortcut?: string | null
  /** Control it from the app. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * A button that opens the panel: a drawer on the right on wide screens, a bottom sheet on phones. Escape closes it,
 * and focus goes back to the button.
 */
export function AssistantSheet(props: AssistantSheetProps) {
  const [own, setOwn] = useState(false)
  const open = props.open ?? own
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const set = (v: boolean) => { setOwn(v); props.onOpenChange?.(v) }
  const latest = useRef(set)
  latest.current = set

  useEffect(() => {
    const key = props.shortcut === undefined ? 'k' : props.shortcut
    const onKey = (e: KeyboardEvent) => {
      if (key && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === key) { e.preventDefault(); latest.current(!open) }
      else if (e.key === 'Escape' && open) latest.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, props.shortcut])

  const wasOpen = useRef(open)
  useEffect(() => {
    // The message box first, so the user can type at once; else the first control.
    if (open) (sheet.current?.querySelector<HTMLElement>('textarea') ?? sheet.current?.querySelector<HTMLElement>('input, button'))?.focus()
    else if (wasOpen.current) button.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <div className="tv-sheet-root" data-theme={props.theme?.mode} style={themeStyle(props.theme)}>
      <button ref={button} type="button" className="tv-sheet-open" aria-expanded={open} aria-controls="tv-sheet" onClick={() => set(!open)}>
        {props.label ?? 'Ask'}
      </button>
      {open ? (
        <>
          <div className="tv-sheet-backdrop" onClick={() => set(false)} />
          <div ref={sheet} id="tv-sheet" className="tv-sheet" role="dialog" aria-modal="true" aria-label="Assistant">
            <button type="button" className="tv-sheet-close" aria-label="Close assistant" onClick={() => set(false)}>×</button>
            {props.children}
          </div>
        </>
      ) : null}
    </div>
  )
}
