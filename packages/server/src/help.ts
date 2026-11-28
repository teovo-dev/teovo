// Search over the app's own help, so the assistant answers "how do I…" from the guide instead of guessing, and
// without the whole guide in every prompt. The guide is split into sections at its headings and ranked by words
// (BM25), or by words and meaning together when an embedding model is given.
import { cosineSimilarity, embedMany, type EmbeddingModel } from 'ai'
import { z } from 'zod'
import { defineTool, type TeovoTool, type ToolContext } from './tools.js'

/** One page of the app's help, in Markdown. */
export interface HelpDoc {
  title: string
  /** Markdown. Split into sections at its headings; a long section is split again at paragraphs. */
  text: string
  /** The app's page for it, shown under the answer as a link (it goes to onAction as navigate). */
  path?: string
  /** Roles that may read it. Omitted: every role. */
  roles?: readonly string[]
}

/** A piece of a help page, with the headings above it. */
export interface HelpSection {
  /** 'Payments › Refunds › Part refunds' */
  title: string
  text: string
  path?: string
}

export interface HelpToolOptions<DB = any> {
  /** The help pages, or a function returning this person's (e.g. read from the app's CMS). */
  docs: HelpDoc[] | ((ctx: ToolContext<DB>) => HelpDoc[] | Promise<HelpDoc[]>)
  /** Default 'search_help'. */
  name?: string
  /** Default: says to use it for questions about how the app works. */
  description?: string
  /** What the chat shows while it runs. Default 'Looked in the help'. */
  label?: string
  /** How many sections one search returns. Default 4. */
  results?: number
  /**
   * Rank by meaning as well as words (e.g. google.textEmbeddingModel('gemini-embedding-001')), so "money back" finds
   * "Refunds". Sections are embedded once and kept in memory. Omitted, or when it fails: words only.
   */
  embeddings?: EmbeddingModel
}

const MAX_SECTION = 1500
const STOP = new Set('a an and are as at be by can do does for from how i if in is it me my of on or so that the this to was what when where which who why will with you your'.split(' '))

/** Split a help page into sections at its headings, keeping the headings above each as its title. */
export function splitHelp(doc: HelpDoc): HelpSection[] {
  const out: HelpSection[] = []
  const trail: string[] = []
  let body: string[] = []
  const flush = () => {
    const text = body.join('\n').trim()
    body = []
    if (!text) return
    const title = [doc.title, ...trail.filter((h, i) => !(i === 0 && h === doc.title))].filter(Boolean).join(' › ')
    for (const piece of pieces(text)) out.push({ title, text: piece, ...(doc.path ? { path: doc.path } : {}) })
  }
  let fenced = false
  for (const line of doc.text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const h = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!h) { body.push(line); continue }
    flush()
    trail.length = h[1]!.length - 1
    trail[h[1]!.length - 1] = h[2]!
    for (let i = 0; i < trail.length; i++) trail[i] ??= ''
  }
  flush()
  return out
}

/** Long text cut at paragraphs into pieces of at most MAX_SECTION characters (a longer paragraph stays whole). */
function pieces(text: string): string[] {
  if (text.length <= MAX_SECTION) return [text]
  const out: string[] = []
  let cur = ''
  for (const p of text.split(/\n\s*\n/)) {
    if (cur && cur.length + p.length + 2 > MAX_SECTION) { out.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur) out.push(cur)
  return out
}

function stem(w: string) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2)
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('es') && /(sh|ch|x|z)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Words for matching: lower case, no common words, plurals and -ing/-ed taken off. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem)
}

/** Sections ranked by words (BM25), the title counting twice. */
export function rankByWords(sections: HelpSection[], query: string): { section: HelpSection; score: number }[] {
  const docs = sections.map((s) => { const t = [...words(s.title), ...words(s.title), ...words(s.text)]; const tf = new Map<string, number>(); for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1); return { s, tf, len: t.length } })
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1)
  const q = [...new Set(words(query))]
  const idf = new Map(q.map((w) => { const n = docs.filter((d) => d.tf.has(w)).length; return [w, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))] }))
  return docs
    .map((d) => ({ section: d.s, score: q.reduce((a, w) => { const f = d.tf.get(w) ?? 0; return a + (f ? (idf.get(w)! * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / avg)) : 0) }, 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

/**
 * A read tool that finds the help sections for a question. The model is told to answer from them and to say when the
 * help doesn't cover something. See HelpToolOptions.
 */
export function helpTool<DB = any>(options: HelpToolOptions<DB>): TeovoTool<'read', { query: string }, DB> {
  const n = options.results ?? 4
  const vectors = new Map<string, Promise<number[] | null>>()
  const byRole = new Map<string, HelpSection[]>()   // fixed docs: split once per role
  const sectionsOf = (docs: HelpDoc[], role: string) => docs.filter((d) => !d.roles || d.roles.includes(role)).flatMap(splitHelp)

  async function embedAll(texts: string[]): Promise<(number[] | null)[]> {
    const model = options.embeddings!
    const missing = [...new Set(texts.filter((t) => !vectors.has(t)))]
    if (missing.length) {
      const job = embedMany({ model, values: missing, maxRetries: 1 }).then((r) => r.embeddings, () => null)
      missing.forEach((t, i) => vectors.set(t, job.then((e) => e?.[i] ?? null)))
      // A failed batch is forgotten, so the next search tries again.
      void job.then((e) => { if (!e) for (const t of missing) vectors.delete(t) })
    }
    return Promise.all(texts.map((t) => vectors.get(t)!))
  }

  return defineTool<'read', { query: string }, DB>({
    name: options.name ?? 'search_help',
    kind: 'read',
    label: options.label ?? 'Looked in the help',
    description: options.description ??
      'Search the app\'s help for how something works or how to do it (screens, steps, rules, policies). Answer from what it returns, and say so when it has nothing: never guess how the app works.',
    input: z.object({ query: z.string().min(1).describe('The question in a few words, e.g. "give a refund"') }),
    links: (out: { results?: HelpSection[] }) => {
      const seen = new Set<string>()
      return (out.results ?? []).filter((r) => r.path && !seen.has(r.path) && seen.add(r.path)).map((r) => ({ label: r.title.split(' › ')[0]!, to: r.path! }))
    },
    run: async ({ query }, ctx) => {
      const docs = Array.isArray(options.docs) ? options.docs : await options.docs(ctx)
      const role = ctx.identity.role
      const sections = Array.isArray(options.docs)
        ? byRole.get(role) ?? byRole.set(role, sectionsOf(docs, role)).get(role)!
        : sectionsOf(docs, role)
      let ranked = rankByWords(sections, query).map((r) => r.section)
      if (options.embeddings && sections.length) {
        const [q, ...vs] = await embedAll([query, ...sections.map((s) => `${s.title}\n${s.text}`)])
        if (q && vs.every(Boolean)) {
          const byMeaning = sections.map((s, i) => ({ s, sim: cosineSimilarity(q, vs[i]!) })).sort((a, b) => b.sim - a.sim).map((r) => r.s)
          // Both lists together (reciprocal rank fusion): high in either counts.
          const score = new Map<HelpSection, number>()
          for (const list of [ranked, byMeaning]) list.forEach((s, i) => score.set(s, (score.get(s) ?? 0) + 1 / (60 + i)))
          ranked = [...score].sort((a, b) => b[1] - a[1]).map(([s]) => s)
        }
      }
      const results = ranked.slice(0, n)
      return results.length ? { results } : { results, note: 'Nothing in the help matches. Say the help doesn\'t cover it; don\'t guess how the app works.' }
    },
  })
}
