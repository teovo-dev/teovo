/** How a tenant writes dates and money. The app's default comes first; a tenant's own settings override it. */
export interface Formats {
  /** A BCP 47 locale, e.g. 'en-IN'. */
  locale: string
  /** An ISO 4217 code, e.g. 'INR'. */
  currency: string
  /** An IANA time zone, e.g. 'Asia/Kolkata'. */
  timeZone: string
}

export const DEFAULT_FORMATS: Formats = { locale: 'en-US', currency: 'USD', timeZone: 'UTC' }

/** Returns a sentence when a value isn't one Intl knows, else null. */
export function checkFormats(f: Partial<Formats>): string | null {
  try { if (f.locale) new Intl.NumberFormat(f.locale) } catch { return `Unknown locale: ${f.locale}.` }
  try { if (f.currency) new Intl.NumberFormat('en', { style: 'currency', currency: f.currency }) } catch { return `Unknown currency: ${f.currency}.` }
  if (f.currency && !/^[A-Z]{3}$/.test(f.currency)) return `Unknown currency: ${f.currency}.`
  try { if (f.timeZone) new Intl.DateTimeFormat('en', { timeZone: f.timeZone }) } catch { return `Unknown time zone: ${f.timeZone}.` }
  return null
}

/**
 * The prompt lines that fix "today" and the way numbers are written, so the model never guesses the date or
 * writes $ for a shop that counts in ₹.
 */
/** How to write money and dates. The same for a tenant every day (a fixed example date), so it can be cached. */
export function formatsText(f: Formats): string {
  const money = new Intl.NumberFormat(f.locale, { style: 'currency', currency: f.currency }).format(1250)
  const short = new Intl.DateTimeFormat(f.locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(2026, 2, 14)))
  return `\n\nWrite amounts like ${money} and dates like ${short}. When a tool needs a date, use YYYY-MM-DD.`
}

/** The date and time now, in the tenant's time zone. Placed at the end of the prompt, with the screen: it changes. */
export function todayText(f: Formats, now: Date): string {
  const date = new Intl.DateTimeFormat(f.locale, { timeZone: f.timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)
  const time = new Intl.DateTimeFormat(f.locale, { timeZone: f.timeZone, hour: 'numeric', minute: '2-digit' }).format(now)
  return `\n\nToday is ${date}, ${time} (${f.timeZone}).`
}
