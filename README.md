# Teovo

The AI assistant that lives inside your app.

Teovo is an open-source kit — a server handler, a React chat panel and Postgres tables — that gives any app an assistant which:

- knows which screen and record the user is looking at,
- answers from the app's own data, as the signed-in user,
- proposes changes as cards the user confirms, with undo,
- shows forms, tables and record cards inside the chat,
- keeps per-tenant and per-user limits, logs and history.

**Status: in development.** The packages are being built in open pull requests and are not published yet. The first version comes from an app already running in production and is published once a second app runs on it.

Read: [architecture](docs/architecture.md) (with a diagram) · [features](docs/features.md) (what each release holds, and what is built) · [plan](docs/plan.md) (phases and decisions) · [decision records](docs/decisions/).

Packages (planned): `@teovo/server`, `@teovo/react`, `@teovo/db`.

## Development

One repository, three packages, managed with npm workspaces:

| Package | Holds |
|---|---|
| `packages/server` (`@teovo/server`) | The handler, tool loop, cards, limits and logs |
| `packages/react` (`@teovo/react`) | The chat panel and screen-context hooks |
| `packages/db` (`@teovo/db`) | Postgres tables, migrations and storage adapters |

Requires Node 20 or newer.

```bash
npm install
```

```bash
npm run typecheck && npm test
```

`npm run typecheck` builds the packages in order (server, react, db), then type-checks the tests. The database
tests run when `TEOVO_TEST_DATABASE_URL` points at a Postgres you can create schemas and roles in; each test
uses its own schema and drops it afterwards. Use a plain Postgres, not Supabase's local database, whose
Postgres build has crashed on the role test.

## Licence

[MIT](LICENSE)
