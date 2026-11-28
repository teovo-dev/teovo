// Sign-in for apps on Supabase: who is asking (identify) and a database client acting as them (asUser), from the
// Supabase login token the app's browser sends. Teovo doesn't depend on @supabase/supabase-js: the app passes its own
// createClient. The app keeps only its own rules: which tenant the person is in, and their role there.
import { IdentifyError, type Identity } from '@teovo/server'

/** The part of a Supabase client the helper uses: checking the login token. */
export interface SupabaseAuthLike {
  auth: { getClaims(jwt?: string): Promise<{ data: { claims: Record<string, unknown> } | null; error: unknown }> }
}

// Supabase's createClient is generic: the client type is read from the function as a whole (ReturnType), so asUser
// gives the app its own SupabaseClient. Options are loose for the same reason.
type AnyCreateClient = (url: string, key: string, options?: any) => SupabaseAuthLike

/** What the app's rules get: the request, the client acting as this person, and who they are. */
export interface LoginContext<C> { req: Request; db: C; userId: string; claims: Record<string, unknown> }

export interface SupabaseLoginOptions<F extends AnyCreateClient, C = ReturnType<F>> {
  /** createClient from @supabase/supabase-js. */
  createClient: F
  /** The project's URL and its anon (public) key: the client acts as the person, so row level security applies. */
  url: string
  anonKey: string
  /** Request headers to pass on to the person's client besides the login, e.g. the app's tenant header. */
  forward?: readonly string[]
  /**
   * Which tenant this request is for (a business, a workspace). Return null when the person has no access there:
   * the request is refused with 403 and `noAccess`. Throw IdentifyError for another status or sentence.
   */
  tenant: (ctx: LoginContext<C>) => Promise<string | null> | string | null
  /** Their role in that tenant (e.g. 'owner', 'staff'), as tools, readers and cards' roles name it. Default 'member'. */
  role?: (ctx: LoginContext<C> & { tenantId: string }) => Promise<string> | string
  /** The sentence for someone signed in but without access. Default: "You don't have access to this." */
  noAccess?: string
}

/**
 * `identify` and `asUser` for createAssistant, from a Supabase login: the token in `Authorization: Bearer …` is
 * checked by Supabase (getClaims verifies its signature; it is never just decoded), and the database client acts as
 * that person, so row level security still decides what the assistant may read and change. No token, or one that
 * fails the check: not signed in (401). One client per request, shared by identify and asUser.
 */
export function supabaseLogin<F extends AnyCreateClient, C extends SupabaseAuthLike = ReturnType<F>>(o: SupabaseLoginOptions<F, C>): {
  identify: (req: Request) => Promise<Identity | null>
  asUser: (identity: Identity, req: Request) => C
} {
  const clients = new WeakMap<Request, C>()
  const tokenOf = (req: Request) => /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim() || null
  const clientFor = (req: Request, token: string) => {
    let c = clients.get(req)
    if (!c) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
      for (const h of o.forward ?? []) { const v = req.headers.get(h); if (v) headers[h] = v }
      c = o.createClient(o.url, o.anonKey, { global: { headers }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) as C
      clients.set(req, c)
    }
    return c
  }
  return {
    async identify(req) {
      const token = tokenOf(req)
      if (!token) return null
      const db = clientFor(req, token)
      const { data, error } = await db.auth.getClaims(token)
      const claims = data?.claims
      const userId = !error && typeof claims?.sub === 'string' && claims.sub ? claims.sub : null
      if (!userId || !claims) return null
      const ctx: LoginContext<C> = { req, db, userId, claims }
      const tenantId = await o.tenant(ctx)
      if (!tenantId) throw new IdentifyError(403, o.noAccess ?? 'You don’t have access to this.')
      const role = o.role ? await o.role({ ...ctx, tenantId }) : 'member'
      return { tenantId, userId, role }
    },
    asUser(_identity, req) {
      const token = tokenOf(req)
      if (!token) throw new IdentifyError(401, 'Sign in to use the assistant.')
      return clientFor(req, token)
    },
  }
}
