# teovo

The command line for [Teovo](https://github.com/teovo-dev/teovo): set up, migrate, check and prune the assistant's
tables.

```bash
npx teovo init --features proposals --tenant-sql "<sql returning tenant id>" --user-sql "<sql returning user id>"
```

```bash
npx teovo migrate
```

| Command | Does |
|---|---|
| `init` | Writes `teovo.config.json`: which features, and the row-level rules (`--supabase`, `--server-only`) |
| `generate` | Writes the tables as SQL, e.g. into `supabase/migrations` |
| `migrate` | Applies what is missing (reads `TEOVO_DATABASE_URL` or `DATABASE_URL`, or `--url`) |
| `status` | Lists the migrations and checks every table is there |
| `prune --days 90 --yes` | Deletes conversations older than that |

The full guide is [AGENTS.md](https://github.com/teovo-dev/teovo/blob/main/AGENTS.md). MIT licensed.
