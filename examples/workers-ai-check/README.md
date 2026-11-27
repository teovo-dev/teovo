# Example: Teovo on Cloudflare Workers AI

A Worker that runs the assistant on Workers AI only (`@cf/openai/gpt-oss-20b`), to check
`@teovo/server/workers-ai` against the real service. `GET /check` runs three conversations and returns what each
produced, plus the tokens and neurons recorded.

```ts
import { workersAi } from '@teovo/server/workers-ai'

createAssistant({
  models: [google('gemini-2.5-flash'), workersAi(env.AI, '@cf/openai/gpt-oss-20b')],   // Workers AI as the backup
  limits: { tenant: { neurons: 2000 } },   // keep each business inside the free allowance
  // …
})
```

Run it (needs `wrangler login`; the Worker runs locally and only the AI calls go to Cloudflare):

```bash
cd examples/workers-ai-check && npm run dev
```

```bash
npm run check
```

A run uses about 30–80 neurons of the account's daily allowance (10,000 free).
