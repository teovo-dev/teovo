# @teovo/db

Tables, migrations and storage for [Teovo](https://github.com/teovo-dev/teovo): threads, messages, cards, runs,
usage, limits and settings in Postgres, and pictures in Postgres, Supabase Storage or Cloudflare R2.

```ts
import { migrate, postgresStorage, postgresFiles } from '@teovo/db'

await migrate(query, { features: { proposals: true, files: true } })   // or: npx teovo migrate
const storage = postgresStorage(query)          // any (text, params) => Promise<{ rows }> query function
const files = postgresFiles(query)
```

- Supabase: `supabaseStorage(client)`, `supabaseFiles(client, bucket, supabaseFileIndex(client))`, and
  `npx teovo generate` to write the SQL into `supabase/migrations`.
- Supabase login: `supabaseLogin` gives `identify` and `asUser` from the user's Supabase token (checked, never just
  decoded), with a client acting as them; the app writes only which tenant and role:

  ```ts
  import { createClient } from '@supabase/supabase-js'
  createAssistant({
    ...supabaseLogin({
      createClient, url, anonKey, forward: ['x-business-id'],
      tenant: async ({ req, db }) => ((await db.rpc('is_member')).data ? req.headers.get('x-business-id') : null),   // null → 403
      role: async ({ db }) => ((await db.rpc('is_owner')).data ? 'owner' : 'staff'),
    }),
    …
  })
  ```
- Cloudflare R2: `r2Files(bucket)`.
- Row-level security: `rls: 'server-only'` (only your server's key touches the tables) or per-tenant rules.

It doesn't depend on a Postgres driver: pass your own query function or Supabase client. The full guide is
[AGENTS.md](https://github.com/teovo-dev/teovo/blob/main/AGENTS.md). MIT licensed.
