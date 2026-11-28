# @teovo/server

The server half of [Teovo](https://github.com/teovo-dev/teovo), the AI assistant that lives inside your app: the
chat's tool loop, cards the user confirms (with undo), readers that fill forms from text, pictures or recordings,
voice to text, model fallback, per-tenant and per-user limits, usage and logs.

```ts
import { createAssistant, defineTool, defineReader, builtinViews } from '@teovo/server'

export const teovo = createAssistant({
  identify: async (req) => ({ tenantId, userId, role }),   // null → 401
  asUser: (identity) => dbClientActingAs(identity),       // ctx.db in every tool
  models: [primaryModel, fallbackModel],                   // Vercel AI SDK models, tried in order
  instructions: 'You help … Use the tools for every number; never guess.',
  storage: postgresStorage(query),                         // from @teovo/db
  views: builtinViews,
  tools: [/* defineTool({ name, kind: 'read' | 'propose' | 'action', input, run }) */],
  readers: [/* defineReader({ name, accepts, schema, instructions, after }) */],
})

// Mount on any route prefix: a web Request in, a Response out.
if (url.pathname.startsWith('/api/assistant/')) return teovo.fetch(request)
```

- `@teovo/server/workers-ai`: Cloudflare Workers AI as a model (`workersAi`) and Whisper voice-to-text (`workersAiWhisper`).
- `@teovo/server/testing`: record real conversations and replay them in tests (`recordingModel`, `replayModel`, `chat`).

Every option is documented in `AssistantConfig` (`src/assistant.ts`). The full guide, with the React panel and the
tables, is [AGENTS.md](https://github.com/teovo-dev/teovo/blob/main/AGENTS.md). MIT licensed.
