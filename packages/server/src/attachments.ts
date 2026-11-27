import type { UIMessage } from 'ai'

/** Pictures (and other files) the user may attach, e.g. a photo of a bill or a screenshot of a bank message. */
export interface AttachmentRules {
  /** Media types allowed. Default: JPEG, PNG and WebP images. */
  types?: readonly string[]
  /** Largest file, in bytes, after base64 decoding. Default 5 MB. */
  maxBytes?: number
  /** Files per message. Default 4. */
  maxFiles?: number
}

const DEFAULT_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/**
 * Check a user message's parts. Files must be inline data: URLs (never a link the server would fetch), of an allowed
 * type and size. Returns a sentence for the user when something is wrong, else null.
 */
export function checkMessage(message: UIMessage, rules: AttachmentRules | undefined): string | null {
  const files = message.parts.filter((p) => p.type === 'file') as { mediaType?: string; url?: string; filename?: string }[]
  const hasText = message.parts.some((p) => p.type === 'text' && p.text.trim())
  const other = message.parts.filter((p) => p.type !== 'text' && p.type !== 'file')
  if (other.length) return 'Send text, and pictures if this assistant takes them.'
  if (!files.length) return hasText ? null : 'Send one user message with some text.'
  if (!rules) return 'This assistant doesn’t take attachments.'
  const types = rules.types ?? DEFAULT_TYPES
  const maxBytes = rules.maxBytes ?? 5 * 1024 * 1024
  if (files.length > (rules.maxFiles ?? 4)) return `Attach at most ${rules.maxFiles ?? 4} files at a time.`
  for (const f of files) {
    const name = f.filename ? `“${f.filename}”` : 'That file'
    const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(f.url ?? '')
    if (!m) return `${name} must be sent with the message, not as a link.`
    if (!types.includes(m[1]!) || (f.mediaType && f.mediaType !== m[1])) return `${name} isn’t a type this assistant reads (${types.map((t) => t.split('/')[1]).join(', ')}).`
    const bytes = Math.floor((m[2]!.replace(/\s/g, '').length * 3) / 4)
    if (bytes > maxBytes) return `${name} is too big. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`
  }
  return null
}
