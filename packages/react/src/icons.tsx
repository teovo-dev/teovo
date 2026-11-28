import type { ReactNode } from 'react'

/** The AI sparkle (one large star, two small): the open button's icon, the header's mark, the steps line's mark. */
export const SPARKLE = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M10 3.5c.4 3.6 2.4 5.6 6 6-3.6.4-5.6 2.4-6 6-.4-3.6-2.4-5.6-6-6 3.6-.4 5.6-2.4 6-6z" />
    <path d="M18 13c.2 1.8 1.2 2.8 3 3-1.8.2-2.8 1.2-3 3-.2-1.8-1.2-2.8-3-3 1.8-.2 2.8-1.2 3-3z" />
    <path d="M18.5 2.5c.15 1.2.8 1.85 2 2-1.2.15-1.85.8-2 2-.15-1.2-.8-1.85-2-2 1.2-.15 1.85-.8 2-2z" />
  </svg>
)

const line = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)

/** The header's buttons. */
export const headerIcons = {
  history: line(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>),
  back: line(<path d="M19 12H5M11 18l-6-6 6-6" />),
  close: line(<path d="M6 6l12 12M18 6L6 18" />),
  // Docked: a shaded strip on the right edge. Floating: a shaded window held off the edges.
  dock: line(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /><path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5z" fill="currentColor" fillOpacity="0.18" stroke="none" /></>),
  float: line(<><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="11.5" y="6.75" width="7" height="10.5" rx="1.5" fill="currentColor" fillOpacity="0.18" /></>),
}
