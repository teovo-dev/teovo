# @teovo/server

The server half of [Teovo](https://github.com/teovo-dev/teovo), the AI assistant that lives inside your app: the
chat's tool loop, cards the user confirms (with undo), readers that fill forms from text, pictures or recordings,
voice to text, model fallback, per-tenant and per-user limits, usage and logs.

```ts
import { createAssistant, defineTool, defineReader, builtinViews, noClaimedChanges } from '@teovo/server'

export const teovo = createAssistant({
  identify: async (req) => ({ tenantId, userId, role }),   // null → 401; throw IdentifyError(403, '…') to refuse
  asUser: (identity) => dbClientActingAs(identity),       // ctx.db in every tool
  models: [primaryModel, fallbackModel],                   // Vercel AI SDK models, tried in order
  instructions: 'You help … Use the tools for every number; never guess.',   // or ({ identity, page, db }) => …
  storage: postgresStorage(query),                         // from @teovo/db
  views: builtinViews,
  tools: [/* defineTool({ name, kind: 'read' | 'propose' | 'action', input, run }) */],
  readers: [/* defineReader({ name, accepts, schema, instructions, after }) */],
  checks: [noClaimedChanges],                              // rules a reply must pass before the user sees it
  runs: { asUser: (identity) => dbClientFor(identity) },   // long runs: replies outlive their request
})

// Mount on any route prefix: a web Request in, a Response out. On Workers pass ctx, so a reply goes on after the
// response: teovo.fetch(request, ctx).
if (url.pathname.startsWith('/api/assistant/')) return teovo.fetch(request)
```

### Who is asking: `identify` and `asUser`

`identify` reads the app's own login from the request; `asUser` gives tools a database client acting as that person,
so the app's row level security still applies. On Supabase, `supabaseLogin` from `@teovo/db` does both. With
another login, a few lines with its own SDK:

```ts
// Clerk
identify: async (req) => { const a = await clerk.authenticateRequest(req); const s = a.toAuth(); return s?.userId ? { tenantId: s.orgId ?? s.userId, userId: s.userId, role: s.orgRole ?? 'member' } : null }
// Auth.js (Next.js)
identify: async () => { const s = await auth(); return s?.user?.id ? { tenantId: s.user.teamId, userId: s.user.id, role: s.user.role } : null }
// Firebase
identify: async (req) => { const t = req.headers.get('authorization')?.replace(/^Bearer /, ''); if (!t) return null; const u = await getAuth().verifyIdToken(t); return { tenantId: u.tenant ?? u.uid, userId: u.uid, role: u.role ?? 'member' } }
```

Always verify the token with the login's own SDK; never just decode it.

Long runs (`runs`) keep each reply in the run log as it is written. Closing the panel doesn't stop it, Stop works
from any server, a reload shows it still being written, and a reply whose server stopped or crashed is carried on by
another from its last finished tool step. Something has to take those over: `teovo.startWorker()` in a Node process
(its `stop()` hands running replies back on shutdown), or `teovo.work()` from a scheduled job (a Cloudflare cron every
minute). With `runs: { inline: false }` replies wait for a worker instead of running in the request.

For questions the app's own read tools don't cover, `queryTool` lets the model fill in a checked query (one table,
filters, groups, totals, order, limit), never SQL. Only the tables and columns you list can be named or returned:

```ts
queryTool({
  tables: {
    order_lines: {
      description: 'One row per product on an order',
      columns: { order_no: 'number', date: 'date', product: 'text', amount: { type: 'number', description: 'Rupees' } },
      from: 'app.order_lines_view',                       // with sql; or rows: (ctx) => [...] to query in memory
      scope: (ctx) => ({ tenant_id: ctx.identity.tenantId }),
    },
  },
  // One parameterized SELECT: run it as the user, read-only, with a timeout.
  sql: (s, ctx) => ctx.db.readOnly((c) => c.query(s.text, s.params)).then((r) => r.rows),
})
```

For "how do I…" questions, `helpTool({ docs, embeddings? })` searches the app's own Markdown guide by section, so the
model answers from it instead of guessing, without the whole guide in every prompt.

- `@teovo/server/workers-ai`: Cloudflare Workers AI as a model (`workersAi`) and Whisper voice-to-text (`workersAiWhisper`).
- `@teovo/server/testing`: record real conversations and replay them in tests (`recordingModel`, `replayModel`, `chat`), or
  keep them as files: `recordChat` / `replayChat`, `recordRead` / `replayRead`, `idNames`, `saveRecording`, `loadRecordings`.

Every option is documented in `AssistantConfig` (`src/assistant.ts`). The full guide, with the React panel and the
tables, is [AGENTS.md](https://github.com/teovo-dev/teovo/blob/main/AGENTS.md). MIT licensed.
