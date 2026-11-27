/**
 * Hide sensitive details before they reach the model or the run log. Applied to what read tools return and to the
 * screen description. Cards keep their full payload (the app's apply needs it), so a tool can still prepare a
 * WhatsApp reminder to a number the model never saw: put the number in the payload, not in what the model reads.
 */
export interface RedactOptions {
  /** Field names whose values are always hidden, at any depth, e.g. ['phone', 'gstin', 'address']. Case-insensitive. */
  fields?: readonly string[]
  /** Built-in patterns to hide inside any text. */
  patterns?: readonly ('email' | 'phone' | 'upi' | 'card')[]
  /** The app's own last step, e.g. to hide a customer's surname. Runs after fields and patterns. */
  custom?: (value: unknown) => unknown
}

const PATTERNS = {
  // Before phone, so card numbers aren't read as two phone numbers.
  card: { re: /\b(?:\d[ -]?){12,18}\d\b/g, label: '[card number]' },
  email: { re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, label: '[email]' },
  // A UPI id looks like name@bank with no dot after the @.
  upi: { re: /\b[\w.-]{2,}@[a-z]{2,}\b(?!\.)/gi, label: '[UPI id]' },
  // An optional country code, then 10 to 12 digits with single spaces or dashes between them.
  phone: { re: /(?<!\d)(?:\+\d{1,3}[ -]?)?\d(?:[ -]?\d){9,11}(?!\d)/g, label: '[phone]' },
} as const

const ORDER = ['card', 'email', 'upi', 'phone'] as const

export type Redactor = (value: unknown) => unknown

export function makeRedactor(options: RedactOptions | undefined): Redactor {
  if (!options) return (v) => v
  const fields = new Set((options.fields ?? []).map((f) => f.toLowerCase()))
  const on = ORDER.filter((p) => options.patterns?.includes(p))
  const text = (s: string) => on.reduce((acc, p) => acc.replace(PATTERNS[p].re, PATTERNS[p].label), s)
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 20) return v
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fields.has(k.toLowerCase()) && x !== null && x !== undefined ? '[hidden]' : walk(x, depth + 1)]))
    }
    return v
  }
  return (v) => {
    const out = walk(v, 0)
    return options.custom ? options.custom(out) : out
  }
}
