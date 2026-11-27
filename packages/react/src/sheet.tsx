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
  /** What the header shows: a title, or the app's own controls (e.g. Chat / History tabs). Default: the label. */
  header?: ReactNode
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
      else if (e.key === 'Tab' && open && sheet.current) {
        // Keep the keyboard inside the open sheet (it is a modal dialog): Tab from the last control goes to the first.
        const all = Array.from(sheet.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
          .filter((el) => el.offsetParent !== null || el === document.activeElement)
        if (!all.length) return
        const first = all[0]!, last = all[all.length - 1]!
        if (!sheet.current.contains(document.activeElement)) { e.preventDefault(); first.focus() }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
        {props.label ?? 'Ask'}
      </button>
      {open ? (
        <>
          <div className="tv-sheet-backdrop" onClick={() => set(false)} />
          <div ref={sheet} id="tv-sheet" className="tv-sheet" role="dialog" aria-modal="true" aria-label="Assistant">
            <div className="tv-sheet-header">
              <div className="tv-sheet-title">{props.header ?? props.label ?? 'Assistant'}</div>
              <button type="button" className="tv-sheet-close" aria-label="Close assistant" onClick={() => set(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="tv-sheet-body">{props.children}</div>
          </div>
        </>
      ) : null}
    </div>
  )
}
