import type { UIMessage } from 'ai'

/**
 * Where attached pictures are kept, apart from the conversation. Messages hold only a reference, `teovo-file:<id>`,
 * so the database stays small and a picture is downloaded only when someone looks at it.
 *
 * Teovo ships memoryFiles (tests), and in @teovo/db: postgresFiles (a tv_files table), supabaseFiles (Supabase
 * Storage) and r2Files (Cloudflare R2). Any object store fits this interface.
 */
export interface FileStore {
  put(file: StoredFile): Promise<void>
  /** The file, only if it belongs to this tenant. Null when missing or removed. */
  get(tenantId: string, id: string): Promise<StoredFile | null>
  /** Remove files older than this. Returns how many. Optional: stores that expire files themselves can skip it. */
  removeOlderThan?(before: Date): Promise<number>
  /** Remove a person's (or with no userId, a whole tenant's) files, for wipe(). Stores that keep files in tv_files can skip it: those go with their conversation. */
  removeFor?(tenantId: string, userId?: string): Promise<number>
}

export interface StoredFile {
  id: string
  tenantId: string
  userId: string
  threadId: string
  mediaType: string
  filename?: string
  bytes: Uint8Array
  createdAt?: string
}

export interface FileRules {
  store: FileStore
  /** Delete pictures after this many days (run `npx teovo prune` or call removeOlderThan on a schedule). */
  keepDays?: number
}

export const FILE_SCHEME = 'teovo-file:'

export function decodeDataUrl(url: string): { mediaType: string; bytes: Uint8Array } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(url)
  if (!m) return null
  const bin = atob(m[2]!.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { mediaType: m[1]!, bytes }
}

export function encodeDataUrl(mediaType: string, bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mediaType};base64,${btoa(s)}`
}

/** Store each inline picture of a new message and point the message at it. Returns the message to save. */
export async function storeFiles(message: UIMessage, rules: FileRules, owner: { tenantId: string; userId: string; threadId: string }): Promise<UIMessage> {
  const parts = await Promise.all(message.parts.map(async (p) => {
    if (p.type !== 'file' || !p.url.startsWith('data:')) return p
    const data = decodeDataUrl(p.url)
    if (!data) return p
    const id = crypto.randomUUID()
    await rules.store.put({ id, ...owner, mediaType: data.mediaType, ...(p.filename ? { filename: p.filename } : {}), bytes: data.bytes })
    return { ...p, url: `${FILE_SCHEME}${id}` }
  }))
  return { ...message, parts }
}

/**
 * The one rule for pictures in what the model sees: the newest user message keeps its pictures (as data the model can
 * read); every earlier picture becomes a short note, so a photo isn't paid for again on every later message.
 */
export function picturesOnce(messages: UIMessage[], current: UIMessage): UIMessage[] {
  return messages.map((m) => {
    if (m === current) return m
    if (!m.parts.some((p) => p.type === 'file')) return m
    return { ...m, parts: m.parts.map((p) => (p.type === 'file'
      ? { type: 'text' as const, text: `[${p.mediaType.startsWith('image/') ? 'picture' : 'file'}${p.filename ? `: ${p.filename}` : ''}, shared earlier]` }
      : p)) }
  })
}

export function memoryFiles(): FileStore & { files: Map<string, StoredFile> } {
  const files = new Map<string, StoredFile>()
  return {
    files,
    async put(f) { files.set(f.id, { ...f, createdAt: f.createdAt ?? new Date().toISOString() }) },
    async get(tenantId, id) { const f = files.get(id); return f && f.tenantId === tenantId ? f : null },
    async removeOlderThan(before) {
      let n = 0
      for (const [id, f] of files) if (new Date(f.createdAt!) < before) { files.delete(id); n++ }
      return n
    },
    async removeFor(tenantId, userId) {
      let n = 0
      for (const [id, f] of files) if (f.tenantId === tenantId && (userId === undefined || f.userId === userId)) { files.delete(id); n++ }
      return n
    },
  }
}
