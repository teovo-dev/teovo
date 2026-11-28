# @teovo/server

The server half of [Teovo](https://github.com/teovo-dev/teovo), the AI assistant that lives inside your app: the
chat's tool loop, cards the user confirms (with undo), readers that fill forms from text, pictures or recordings,
voice to text, model fallback, per-tenant and per-user limits, usage and logs.

```ts
import { createAssistant, defineTool, defineReader, builtinViews, noClaimedChanges } from '@teovo/server'

export const teovo = createAssistant({
  identify: async (req) => ({ tenantId, userId, role }),   // null → 401
  asUser: (identity) => dbClientActingAs(identity),       // ctx.db in every tool
  models: [primaryModel, fallbackModel],                   // Vercel AI SDK models, tried in order
  instructions: 'You help … Use the tools for every number; never guess.',
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

- `@teovo/server/workers-ai`: Cloudflare Workers AI as a model (`workersAi`) and Whisper voice-to-text (`workersAiWhisper`).
- `@teovo/server/testing`: record real conversations and replay them in tests (`recordingModel`, `replayModel`, `chat`), or
  keep them as files: `recordChat` / `replayChat`, `recordRead` / `replayRead`, `idNames`, `saveRecording`, `loadRecordings`.

Every option is documented in `AssistantConfig` (`src/assistant.ts`). The full guide, with the React panel and the
tables, is [AGENTS.md](https://github.com/teovo-dev/teovo/blob/main/AGENTS.md). MIT licensed.
