# AGENTS.md

Notes for coding agents. Part 1 is for adding Teovo to an app. Part 2 is for working in this repository.

The packages aren't published yet. Until they are, link them from this repo (npm workspaces or `npm link`).

---

## Part 1: Adding Teovo to an app

Teovo has three pieces. You need all of them:

| Package | Where it runs | What you use from it |
|---|---|---|
| `@teovo/server` | Your server | `createAssistant`, `defineTool`, `builtinViews` |
| `@teovo/db` | Your server | `migrate`, `postgresStorage` / `supabaseStorage`, `postgresFiles` / `supabaseFiles` / `r2Files` |
| `@teovo/react` | The browser | `AssistantProvider`, `AssistantPanel`, `AssistantSheet`, `useAssistantContext` |
| `teovo` (CLI) | Terminal | `init`, `generate`, `migrate`, `status`, `prune` |

Models come from the Vercel AI SDK (for example `@ai-sdk/google`). Tool inputs are zod schemas.

### Step 1: Create the tables

The CLI reads `TEOVO_DATABASE_URL` (or `DATABASE_URL`). You can pass `--url` instead.

```bash
npx teovo init --features proposals --tenant-sql "<sql returning tenant id>" --user-sql "<sql returning user id>"
```
```bash
npx teovo migrate
```

- For Supabase, use `--supabase` in place of `--user-sql`. Then run `teovo generate`, which writes the SQL into `supabase/migrations`.
- Use `--server-only` when only the server's own key may touch the tables. Don't combine it with the row-level flags.
- You can also migrate from code: `await migrate(query, { features: { proposals: true, files: true } })`.

### Step 2: Configure the server

The full option list, with a comment on each option, is `AssistantConfig` in `packages/server/src/assistant.ts`. Check it there; don't guess option names. A working example is `examples/shop/server.ts`.

```ts
import { createAssistant, defineTool, builtinViews } from '@teovo/server'
import { postgresStorage } from '@teovo/db'
import { z } from 'zod'

export const teovo = createAssistant({
  identify: async (req) => /* from your session */ ({ tenantId, userId, role }), // null → 401
  asUser: (identity) => dbClientActingAs(identity),   // becomes ctx.db in every tool
  models: [primaryModel, fallbackModel],             // tried in order
  name: 'Teovo',                                     // shown on the button ("Ask Teovo") and told to the model
  instructions: 'You help … Use the tools for every number; never guess. To change anything, use a propose tool.',
  storage: postgresStorage(query),
  views: builtinViews,
  tools: [
    defineTool({
      name: 'list_orders', kind: 'read', description: '…',
      input: z.object({ unpaidOnly: z.boolean().optional() }),
      run: (input, ctx) => ctx.db.orders.list(input),
    }),
    defineTool({
      name: 'record_payment', kind: 'propose', description: 'Prepare recording a payment.',
      input: z.object({ no: z.number(), amount: z.number().positive() }),
      run: ({ no, amount }) => ({ kind: 'record_payment', title: `Payment ₹${amount} for #${no}`,
        before: { paid: 0 }, after: { paid: amount }, payload: { no, amount } }),
    }),
  ],
  cards: {
    record_payment: {
      apply: (payload, ctx) => { /* write */ return { undo: payload } },
      undo: (undo, payload, ctx) => { /* reverse */ },
    },
  },
})
```

Mount the handler on any route prefix. It takes a web `Request` and returns a `Response`:

```ts
if (url.pathname.startsWith('/api/assistant/')) return teovo.fetch(request)
```

### Step 3: Add the panel to the app

```tsx
import { AssistantProvider, AssistantSheet, AssistantPanel, useAssistantContext } from '@teovo/react'

<AssistantProvider endpoint="/api/assistant" headers={() => ({ authorization: `Bearer ${token}` })}>
  <AssistantSheet label="Ask">
    <AssistantPanel stepLabels={{ list_orders: 'Looking at orders' }} />
  </AssistantSheet>
</AssistantProvider>

// On each screen, tell the assistant what the user is looking at:
useAssistantContext({ path: '/orders/142', title: 'Order', record: { type: 'order', id: '142' } })
```

- `endpoint` must match the prefix where you mounted `teovo.fetch`.
- Props are documented in `packages/react/src/provider.tsx`, `panel.tsx`, `sheet.tsx` and `header.tsx`.
- **Don't build chat UI in the app.** Teovo already has the header (name, History, dock/float, close), earlier
  chats, the remembered conversation (`rememberThread`), opening and sending from anywhere (`useAssistant().ask`),
  the page chip with its × , cards with `lines` and an after-confirm `note`/`link`, and closing the phone chat when
  a button opens a screen. If the chat has its own place (a full page, a side column) instead of `AssistantSheet`,
  put `<AssistantHeader />` above `<AssistantPanel />`. If something chat-related is missing, add it to
  `@teovo/react`, not to the app.

### Rules that keep it safe

- **The assistant acts as the user.** Tools read through `ctx.db` from `asUser`, never through an admin client. Tenant and permission checks belong in your database layer or in `asUser`.
- **Every change goes through a card.** Any tool that changes data is `kind: 'propose'`. It returns a proposal with `kind`, `title`, `before`, `after` and `payload`. The change runs only in `cards[kind].apply`, after the user confirms. Return `{ undo }` from `apply` and add an `undo` function so the change can be undone.
- **Outside text is marked.** Wrap text that came from customers, uploads or the web with `ctx.untrusted(text, 'source')`. That way the model treats it as data, not instructions.
- **Personal data is hidden from the model.** Use `redact: { fields: [...], patterns: ['phone', 'email', 'upi'] }` to keep it out of the model's input and the run log.
- **Read tools don't write.** A `read` tool never changes data.
- **Every AI call goes through Teovo.** Don't call a model from the app's own code: use a reader (one input → one
  checked answer, e.g. a WhatsApp order → an order draft) or voice. They share the chat's models, fallback, limits,
  usage and untrusted-text rules. A reader only fills a form; the app saves after the user checks it.

### Optional features

| Feature | Server option | React side |
|---|---|---|
| Pictures | `attachments: {}` with `files: { store, keepDays }` | `<AssistantPanel attach />` |
| Fill a form from text, a picture or a recording (readers) | `readers: [defineReader({ name, accepts, schema, instructions, after })]`; webhooks: `teovo.read(name, input, { identity, db })` | `useReader(name).read(input)` |
| Voice to text | `voice: { models, hint }` (Gemini hears audio; `workersAiWhisper(env.AI)` as backup) | `<VoiceButton onText />`; the chat's microphone uses it too |
| Screen navigation | `screens: [{ path, title, description, filters }]` | `onAction` on the provider |
| Changes the app applies in the browser | `cards: { kind: { inApp: true } }` | `onCard` on the provider |
| Forms in chat | `forms: { submitKind: … }` | Works with the built-in views |
| Limits | `limits: { user: { messages: 200 } }` | The panel shows how many messages are left |
| Run viewer (every reply, its tools and a trace to download) | Nothing: needs `postgresStorage` or `supabaseStorage` (admins only) | `<RunViewer />` on the app's admin screen |
| Long runs (a reply goes on when the panel closes, Stop works from any server, a reply whose server stopped is carried on by another) | `runs: { asUser }`; then `teovo.startWorker()` in Node, or `teovo.work()` from a cron on Workers (and `teovo.fetch(req, ctx)`); `inline: false` to leave replies to workers | Nothing: Stop and reload just work |
| Hosts that hold back streams (Firebase Hosting, some proxies) | Long runs (`runs`) | `<AssistantProvider transport="poll">` |
| Replies nobody typed (a schedule, a heartbeat, a webhook) | `await teovo.start({ identity, text, label, db })` from the app's job; throws `StartError` when refused | Nothing: the panel labels the app's message |
| A switch to another model partway through a reply (analyst → writer) | `roles: { writer: { description, models, takesOver } }`: the model's `hand_over` or the app's `takesOver` plan | Nothing: the steps show "Handed over to the writer" |
| Charging for replies (credits, a wallet) | `spend: { hold, reserve, settle, cost? }`: the app's wallet holds before a reply, `ctx.reserve(n)` in a tool raises it, `settle` charges at the end | Nothing: a refusal shows the app's sentence |
| Done-checks (rules a reply must pass before the user sees it) | `checks: [noClaimedChanges, defineCheck({ name, check })]`, `checkRetries` | Nothing: the panel gets only the reply that passed |
| Dates and money | `formats: { locale, currency, timeZone }` | Applied automatically |
| Cheap model for simple questions | `route: (ctx) => models \| undefined` | Nothing needed |
| Monitoring | `on: { error, usage, miss, rating, … }`, `promptVersion` | Nothing needed |

Delete old conversations with:

```bash
npx teovo prune --days 90 --yes
```

---

## Part 2: Working in this repository

- Use Node 20 or newer, with npm workspaces: `packages/server`, `packages/react`, `packages/db`, `packages/cli`, and the projects in `examples/*`.
- Install, then check:

```bash
npm install
```
```bash
npm run typecheck && npm test
```

- `typecheck` builds the packages in this order: server, react, db, cli. It then type-checks the tests and both examples. Run it after changing any public type, because the examples break first.
- The database tests run only when `TEOVO_TEST_DATABASE_URL` is set. Each test creates its own schema and drops it afterwards. Use a plain Postgres, not Supabase's local one, which has crashed on the role test.
- Tests sit next to the code (`*.test.ts` / `*.test.tsx`) and run with vitest.
- Code under `src/` imports with a `.js` extension, even from `.ts` files. Export everything public from the package's `src/index.ts`.
- Put a short doc comment on each config option, saying what it does and its default. Users read those comments as the reference.
- Read `docs/architecture.md`, `docs/plan.md` and `docs/decisions/` before making design changes. Update `docs/features.md` when something gets built.
- Work on a branch and open a pull request to `main`.
