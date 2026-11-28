// Tell someone when the assistant is in trouble: too many replies falling back to the backup model, or failing.
// One message when it starts and one when it is over, nothing in between, so a bad hour is two messages, not
// two hundred. Counted per server over a sliding window.

/** A message for the app's people, e.g. a chat channel or an email. */
export interface Alert {
  /** backup: replies falling back to the next model. errors: replies failing. */
  kind: 'backup' | 'errors'
  /** started: it crossed the line. over: it fell back under half of it. */
  state: 'started' | 'over'
  /** A sentence ready to post. */
  text: string
  /** Replies counted in the window, and how many of them fell back (or failed). */
  replies: number
  count: number
  /** The model that failed and the error from the last one that did, when known. */
  model?: string
  error?: string
}

export interface AlertRules {
  /** Where alerts go. Errors in it are reported to on.error and otherwise ignored. See postAlert for a webhook. */
  send: (alert: Alert) => void | Promise<void>
  /** Share of replies that fall back to a backup model before an alert. Default 0.25 (one in four). */
  backup?: number
  /** Share of replies that fail before an alert. Default 0.1 (one in ten). */
  errors?: number
  /** How far back replies are counted. Default 15 minutes. */
  windowMs?: number
  /** Replies needed in the window before anything is sent, so one failure at night isn't an alert. Default 5. */
  minReplies?: number
}

/** How one reply ended, for the alert watch. */
export interface ReplyOutcome {
  failed: boolean
  /** The reply's first model failed and a backup answered (or was tried). */
  fellBack: boolean
  /** The model that failed, and its error. */
  model?: string
  error?: string
}

/** Counts replies and sends an alert when a line is crossed, and again when it's over. */
export function alertWatch(rules: AlertRules, name = 'Teovo', now: () => number = Date.now, report?: (e: unknown) => void) {
  const windowMs = rules.windowMs ?? 15 * 60_000
  const min = rules.minReplies ?? 5
  const lines = { backup: rules.backup ?? 0.25, errors: rules.errors ?? 0.1 }
  const seen: (ReplyOutcome & { at: number })[] = []
  const active = { backup: false, errors: false }
  const last: Partial<Record<Alert['kind'], { model?: string; error?: string }>> = {}
  const minutes = Math.round(windowMs / 60_000)
  const span = minutes >= 1 ? `the last ${minutes} min` : 'the last minute'

  const sentence = (kind: Alert['kind'], state: Alert['state'], count: number, replies: number, l?: { model?: string; error?: string }) => {
    const why = l?.model || l?.error ? ` (${[l.model && `${l.model} failed`, l.error].filter(Boolean).join(': ')})` : ''
    if (kind === 'backup') return state === 'started'
      ? `${name}: ${count} of ${replies} replies in ${span} fell back to the backup model${why}.`
      : `${name}: back on the main model; ${count} of ${replies} replies in ${span} used the backup.`
    return state === 'started'
      ? `${name}: ${count} of ${replies} replies in ${span} failed${why}.`
      : `${name}: replies are working again; ${count} of ${replies} in ${span} failed.`
  }

  return {
    record(r: ReplyOutcome) {
      const t = now()
      seen.push({ ...r, at: t })
      while (seen.length && seen[0]!.at < t - windowMs) seen.shift()
      const why = { model: r.model, error: r.error?.slice(0, 200) }
      if (r.fellBack) last.backup = why
      if (r.failed) last.errors = why
      const replies = seen.length
      for (const kind of ['backup', 'errors'] as const) {
        const count = seen.filter((s) => (kind === 'backup' ? s.fellBack : s.failed)).length
        const share = count / replies
        let state: Alert['state'] | undefined
        if (!active[kind] && replies >= min && share >= lines[kind]) state = 'started'
        else if (active[kind] && share < lines[kind] / 2) state = 'over'
        if (!state) continue
        active[kind] = state === 'started'
        const l = last[kind]
        const alert: Alert = { kind, state, text: sentence(kind, state, count, replies, l), replies, count, ...(state === 'started' && l?.model ? { model: l.model } : {}), ...(state === 'started' && l?.error ? { error: l.error } : {}) }
        void Promise.resolve().then(() => rules.send(alert)).catch((e) => report?.(e))
      }
    },
  }
}

/**
 * Send alerts to a webhook as JSON `{ text, alert }`: Slack and Google Chat incoming webhooks post `text` as is.
 * For Discord, pass `{ body: (a) => ({ content: a.text }) }`.
 */
export function postAlert(url: string, options: { body?: (alert: Alert) => unknown; headers?: Record<string, string> } = {}): AlertRules['send'] {
  return async (alert) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(options.body ? options.body(alert) : { text: alert.text, alert }) })
    if (!res.ok) throw new Error(`Alert webhook answered ${res.status}`)
  }
}
