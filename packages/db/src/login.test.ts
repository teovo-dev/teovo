// supabaseLogin: unit tests with a stand-in createClient, and one end-to-end test against a real Supabase (local is
// fine: set TEOVO_TEST_SUPABASE_URL, TEOVO_TEST_SUPABASE_SERVICE_KEY and TEOVO_TEST_SUPABASE_ANON_KEY; skipped
// otherwise) with a real sign-in, a real token check and a row level security policy.
import { createClient } from '@supabase/supabase-js'
import { createAssistant, IdentifyError, memoryStorage } from '@teovo/server'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { supabaseLogin, type SupabaseAuthLike } from './index'

// Node 20 has no WebSocket and supabase-js asks for one when a client is made; login never opens one.
if (!(globalThis as { WebSocket?: unknown }).WebSocket) (globalThis as { WebSocket?: unknown }).WebSocket = class { constructor() { throw new Error('not used') } }

type Fake = SupabaseAuthLike & { headers: Record<string, string>; checked: string[] }
const GOOD = 'good-token'

function fakeSupabase() {
  const made: Fake[] = []
  const createClient = (_url: string, _key: string, o: { global: { headers: Record<string, string> } }) => {
    const c: Fake = {
      headers: o.global.headers, checked: [],
      auth: { getClaims: async (jwt?: string) => { c.checked.push(jwt ?? ''); return jwt === GOOD ? { data: { claims: { sub: 'u1', email: 'a@b.c' } }, error: null } : { data: null, error: new Error('invalid JWT') } } },
    }
    made.push(c)
    return c
  }
  return { createClient, made }
}
const req = (headers: Record<string, string> = {}) => new Request('https://app.test/api/assistant/policy', { headers })

describe('supabaseLogin', () => {
  it("checks the token, asks the app's rules, and acts as that person with the headers it forwards", async () => {
    const f = fakeSupabase()
    const login = supabaseLogin({
      createClient: f.createClient, url: 'https://x.supabase.co', anonKey: 'anon', forward: ['x-business-id'],
      tenant: ({ req, userId, db }) => (userId === 'u1' && db.headers['x-business-id'] === 'b1' ? req.headers.get('x-business-id') : null),
      role: ({ tenantId }) => (tenantId === 'b1' ? 'owner' : 'staff'),
    })
    const r = req({ authorization: `Bearer ${GOOD}`, 'x-business-id': 'b1', 'x-other': 'no' })
    expect(await login.identify(r)).toEqual({ tenantId: 'b1', userId: 'u1', role: 'owner' })
    const db = login.asUser({ tenantId: 'b1', userId: 'u1', role: 'owner' }, r) as Fake
    expect(f.made).toHaveLength(1)   // one client per request, shared by identify and asUser
    expect(db).toBe(f.made[0])
    expect(db.headers).toEqual({ Authorization: `Bearer ${GOOD}`, 'x-business-id': 'b1' })
    expect(db.checked).toEqual([GOOD])   // the token was checked, not just read
  })

  it('no token, or one that fails the check, is "not signed in"; no access is 403 with the app\'s sentence', async () => {
    const f = fakeSupabase()
    const login = supabaseLogin({ createClient: f.createClient, url: 'u', anonKey: 'k', tenant: ({ req }) => req.headers.get('x-business-id'), noAccess: 'You don’t have access to this business' })
    expect(await login.identify(req())).toBeNull()
    expect(await login.identify(req({ authorization: 'Bearer forged' }))).toBeNull()
    await expect(login.identify(req({ authorization: `Bearer ${GOOD}` }))).rejects.toMatchObject({ status: 403, message: 'You don’t have access to this business' })
    expect(await login.identify(req({ authorization: `Bearer ${GOOD}`, 'x-business-id': 'b2' }))).toEqual({ tenantId: 'b2', userId: 'u1', role: 'member' })
    expect(() => login.asUser({ tenantId: 'b2', userId: 'u1', role: 'member' }, req())).toThrow(IdentifyError)
  })

  it('refusals reach the browser with their status and sentence', async () => {
    const f = fakeSupabase()
    const login = supabaseLogin({ createClient: f.createClient, url: 'u', anonKey: 'k', tenant: () => null, noAccess: 'Not your shop' })
    const teovo = createAssistant({ ...login, storage: memoryStorage(), instructions: 'Help.', tools: [], models: [new MockLanguageModelV4()] })
    const policy = (h: Record<string, string>) => teovo.fetch(new Request('https://app.test/api/assistant/policy', { headers: h }))
    const none = await policy({})
    expect([none.status, await none.json()]).toEqual([401, { error: 'Sign in to use the assistant.' }])
    const no = await policy({ authorization: `Bearer ${GOOD}` })
    expect([no.status, await no.json()]).toEqual([403, { error: 'Not your shop' }])
  })
})

const url = process.env.TEOVO_TEST_SUPABASE_URL
const serviceKey = process.env.TEOVO_TEST_SUPABASE_SERVICE_KEY
const anonKey = process.env.TEOVO_TEST_SUPABASE_ANON_KEY
const real = url && serviceKey && anonKey ? describe : describe.skip

real('supabaseLogin on a real Supabase', () => {
  it('signs a real person in from their token, refuses a forged one, and acts as them', async () => {
    const opts = { auth: { persistSession: false, autoRefreshToken: false } }
    const admin = createClient(url!, serviceKey!, opts)
    const email = `teovo-login-${crypto.randomUUID().slice(0, 8)}@example.test`
    const password = crypto.randomUUID()
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (made.error) throw made.error
    try {
      const s = await createClient(url!, anonKey!, opts).auth.signInWithPassword({ email, password })
      const token = s.data.session!.access_token
      const login = supabaseLogin({ createClient, url: url!, anonKey: anonKey!, tenant: ({ claims }) => (claims.email === email ? 'shop-1' : null) })
      const r = new Request('https://app.test/x', { headers: { authorization: `Bearer ${token}` } })
      expect(await login.identify(r)).toEqual({ tenantId: 'shop-1', userId: made.data.user!.id, role: 'member' })
      // The client acts as them: Supabase itself says who it is.
      expect((await login.asUser({ tenantId: 'shop-1', userId: made.data.user!.id, role: 'member' }, r).auth.getUser()).data.user?.email).toBe(email)
      // A token with a changed payload fails the check.
      const [h, , sig] = token.split('.')
      const forged = [h, Buffer.from(JSON.stringify({ sub: crypto.randomUUID(), role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), sig].join('.')
      expect(await login.identify(new Request('https://app.test/x', { headers: { authorization: `Bearer ${forged}` } }))).toBeNull()
    } finally {
      await admin.auth.admin.deleteUser(made.data.user!.id)
    }
  })
})
