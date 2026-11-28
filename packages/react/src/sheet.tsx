import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AssistantHeader } from './header.js'
import { SPARKLE } from './icons.js'
import { useOptionalAssistant } from './provider.js'

export { SPARKLE } from './icons.js'

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
  /** The open button's text. Default "Ask <name>" with the name from the server's config, else "Ask". */
  label?: string
  /** The open button's icon. Default an AI sparkle; null for none. */
  icon?: ReactNode
  /** The header's title. Default: the assistant's name from the server's config, else "Assistant". */
  header?: ReactNode
  /** Keyboard shortcut to open and close, with Ctrl (Windows, Linux) or ⌘ (Mac). Default 'k'; null for none. */
  shortcut?: string | null
  /** Control it from the app. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * Whether the open sheet covers the app. 'phone' (default): on phones it is a bottom sheet over a dimmed page; on
   * wider screens it is a panel docked on the right, with no backdrop, and the user can keep using the page beside it.
   * true: always over a dimmed page, with the keyboard kept inside. false: always docked.
   *
   * While docked, <html> gets data-tv-sheet="docked" and the CSS variable --tv-sheet-width, so the app can make room:
   * html[data-tv-sheet="docked"] .app { margin-right: var(--tv-sheet-width) }
   */
  modal?: boolean | 'phone'
  /**
   * How it opens when it doesn't cover the app (wide screens, unless modal is true). 'panel' (default): docked on the
   * right, full height; the page can make room for it. 'floating': a full-height window held off the screen's edges
   * with rounded corners, over the page's right side, with the page still usable around it. While floating, <html>
   * gets data-tv-sheet="floating".
   */
  layout?: 'panel' | 'floating'
  /** A switch in the header between the docked panel and the floating window; the person's pick is remembered. Default true. */
  layoutSwitch?: boolean
  /** A History button in the header for earlier conversations (needs AssistantProvider). Default true. */
  history?: boolean
  /**
   * Extra room under the open button, as CSS, e.g. '5.5rem' to sit above the app's bottom navigation bar (the phone's
   * safe area is added on top). For only some screen widths, set the CSS variable --tv-open-offset in the app's own
   * media query instead, e.g. @media (max-width: 767px) { :root { --tv-open-offset: 5.5rem } }. Default none.
   */
  buttonOffset?: string
}

const LAYOUT_KEY = 'teovo:layout'
const savedLayout = (): 'panel' | 'floating' | null => {
  try { const v = localStorage.getItem(LAYOUT_KEY); return v === 'panel' || v === 'floating' ? v : null } catch { return null }
}

const PHONE = '(max-width: 640px)'
/** Docked panel width on wide screens. */
export const SHEET_WIDTH = '440px'

function usePhone() {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE) : null
  const [phone, setPhone] = useState(query?.matches ?? false)
  useEffect(() => {
    if (!query) return
    const on = () => setPhone(query.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [query])
  return phone
}

/**
 * A button that opens the panel: docked on the right on wide screens (the page stays usable beside it), a bottom
 * sheet on phones. Escape closes it, and focus goes back to the button.
 */
export function AssistantSheet(props: AssistantSheetProps) {
  const ctx = useOptionalAssistant()
  const [own, setOwn] = useState(false)
  // The app's own control first, then the provider's (so a button anywhere can open it), then its own.
  const open = props.open ?? ctx?.open ?? own
  const name = ctx?.policy.name
  const label = props.label ?? (name ? `Ask ${name}` : 'Ask')
  const phone = usePhone()
  const modal = props.modal === undefined || props.modal === 'phone' ? phone : props.modal
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const set = (v: boolean) => { setOwn(v); ctx?.setOpen(v); props.onOpenChange?.(v) }
  const latest = useRef(set)
  latest.current = set

  useEffect(() => {
    const key = props.shortcut === undefined ? 'k' : props.shortcut
    const onKey = (e: KeyboardEvent) => {
      if (key && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === key) { e.preventDefault(); latest.current(!open) }
      else if (e.key === 'Escape' && open) latest.current(false)
      else if (e.key === 'Tab' && open && modal && sheet.current) {
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
  }, [open, modal, props.shortcut])

  // The person's pick of docked or floating, when the switch is on; else the app's.
  const [picked, setPicked] = useState(savedLayout)
  const switchable = props.layoutSwitch !== false
  const layout = (switchable ? picked : null) ?? props.layout ?? 'panel'
  const pick = (l: 'panel' | 'floating') => { setPicked(l); try { localStorage.setItem(LAYOUT_KEY, l) } catch { /* not remembered */ } }

  // Tell the provider when the chat covers the page, so opening a screen from it closes it.
  const setCovering = ctx?.setCovering
  useEffect(() => { setCovering?.(open && modal) }, [setCovering, open, modal])

  // Docked: tell the page, so it can make room for the panel instead of sitting under it.
  const floating = layout === 'floating'
  const beside = open && !modal ? (floating ? 'floating' : 'docked') : null
  useEffect(() => {
    if (!beside || typeof document === 'undefined') return
    const html = document.documentElement
    html.dataset.tvSheet = beside
    if (beside === 'docked') html.style.setProperty('--tv-sheet-width', SHEET_WIDTH)
    return () => { delete html.dataset.tvSheet; html.style.removeProperty('--tv-sheet-width') }
  }, [beside])

  const wasOpen = useRef(open)
  useEffect(() => {
    // The message box first, so the user can type at once; else the first control.
    if (open) (sheet.current?.querySelector<HTMLElement>('textarea') ?? sheet.current?.querySelector<HTMLElement>('input, button'))?.focus()
    else if (wasOpen.current) button.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <div className="tv-sheet-root" data-theme={props.theme?.mode} style={themeStyle(props.theme)}>
      <button ref={button} type="button" className="tv-sheet-open" style={props.buttonOffset ? { '--tv-open-offset': props.buttonOffset } as CSSProperties : undefined} aria-expanded={open} aria-controls="tv-sheet" onClick={() => set(!open)}>
        {props.icon === undefined ? SPARKLE : props.icon}
        {label}
      </button>
      {open ? (
        <>
          {modal ? <div className="tv-sheet-backdrop" onClick={() => set(false)} /> : null}
          <div ref={sheet} id="tv-sheet" className={modal ? 'tv-sheet' : floating ? 'tv-sheet tv-sheet-floating' : 'tv-sheet tv-sheet-docked'} role="dialog" aria-modal={modal} aria-label={name ?? 'Assistant'}
            style={modal || floating ? undefined : { width: `min(${SHEET_WIDTH}, 100vw)` }}>
            {ctx ? (
              <AssistantHeader className="tv-sheet-header" title={props.header} history={props.history} onClose={() => set(false)}
                {...(switchable && !modal ? { layout, onLayout: pick } : {})} />
            ) : (
              <div className="tv-sheet-header tv-header">
                <div className="tv-header-title">{props.header ?? props.label ?? 'Assistant'}</div>
                <button type="button" className="tv-header-btn tv-sheet-close" aria-label="Close assistant" onClick={() => set(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            )}
            <div className="tv-sheet-body">{props.children}</div>
          </div>
        </>
      ) : null}
    </div>
  )
}
