import { Fragment, type ReactNode } from 'react'

/**
 * A small Markdown renderer for replies: paragraphs, line breaks, headings, bullet and numbered lists, bold,
 * italics, inline code, code blocks and links. It builds React elements and never inserts HTML, so a reply can't
 * carry a script or a fake form. Links open in a new tab and must be http(s) or mailto.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="tv-md">{blocks(text)}</div>
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!)
      i++
      out.push(<pre key={out.length}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push(<p key={out.length} className="tv-md-h"><strong>{inline(h[2]!)}</strong></p>); i++; continue }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      const item = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*•]\s+(.*)$/
      while (i < lines.length && item.test(lines[i]!)) items.push(item.exec(lines[i++]!)![1]!)
      const li = items.map((t, k) => <li key={k}>{inline(t)}</li>)
      out.push(ordered ? <ol key={out.length}>{li}</ol> : <ul key={out.length}>{li}</ul>)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) para.push(lines[i++]!)
    out.push(<p key={out.length}>{para.map((l, k) => <Fragment key={k}>{k > 0 ? <br /> : null}{inline(l)}</Fragment>)}</p>)
  }
  return out
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  // Code first, then links, bold, italics. Each match is drawn as an element; everything else stays text.
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = out.length
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(SAFE_LINK.test(m[3]!) ? <a key={k} href={m[3]} target="_blank" rel="noopener noreferrer">{m[2]}</a> : `${m[2]} (${m[3]})`)
    else if (m[4] !== undefined || m[5] !== undefined) out.push(<strong key={k}>{inline(m[4] ?? m[5]!)}</strong>)
    else out.push(<em key={k}>{inline(m[6] ?? m[7]!)}</em>)
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
