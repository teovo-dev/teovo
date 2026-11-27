# Teovo

The AI assistant that lives inside your app.

Teovo is a planned open-source kit — a server handler, a React chat panel and Postgres tables — that gives any app an assistant which:

- knows which screen and record the user is looking at,
- answers from the app's own data, as the signed-in user,
- proposes changes as cards the user confirms, with undo,
- shows forms, tables and record cards inside the chat,
- keeps per-tenant and per-user limits, logs and history.

**Status: planning.** There is no code yet. The first version will be extracted from an app already running in production and published once a second app runs on it.

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
npm run typecheck && npm test && npm run build
```

## Licence

[MIT](LICENSE)
