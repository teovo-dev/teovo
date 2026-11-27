import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { generateSql, migrate, migrations, missingTables, prune, type Query, type SchemaOptions } from '@teovo/db'

export const CONFIG_FILE = 'teovo.config.json'

/** What `teovo.config.json` holds: the same options the tables are built from. */
export interface CliConfig extends SchemaOptions {
  $schema?: string
}

export interface Io {
  cwd: string
  env: Record<string, string | undefined>
  out: (line: string) => void
  /** Opens a database connection. Injected so tests and other drivers can supply their own. */
  connect: (url: string) => Promise<{ query: Query; close: () => Promise<void> }>
  now?: () => Date
}

const HELP = `Usage: teovo <command> [options]

Commands
  init        Write teovo.config.json (features and row-level rules)
  generate    Write the tables as SQL, for apps that keep their own migrations (e.g. Supabase)
  migrate     Create or update the tables in the database at DATABASE_URL
  status      Show which migrations ran and which tables are missing
  prune       Delete conversations older than --days (asks for --yes)

Options
  --url <postgres-url>     Instead of DATABASE_URL
  --features <list>        For init: comma list, e.g. proposals
  --tenant-sql <expr>      For init: SQL that returns the current tenant id as text
  --user-sql <expr>        For init: SQL that returns the current user id as text
  --supabase               For init: use Supabase's auth.uid() for the user
  --out <file>             For generate: where to write (default: a new file in supabase/migrations if that
                           folder exists, else print)
  --days <n>               For prune
  --file-days <n>          For prune: also delete pictures (tv_files) older than this
  --yes                    For prune: really delete
`

export async function main(argv: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      url: { type: 'string' }, features: { type: 'string' }, 'tenant-sql': { type: 'string' }, 'user-sql': { type: 'string' },
      supabase: { type: 'boolean' }, out: { type: 'string' }, days: { type: 'string' }, 'file-days': { type: 'string' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0]
  if (!command || values.help) { io.out(HELP); return command || values.help ? 0 : 1 }

  const configPath = join(io.cwd, CONFIG_FILE)
  const readConfig = (): CliConfig => {
    if (!existsSync(configPath)) throw new UserError(`No ${CONFIG_FILE} here. Run: npx teovo init`)
    return JSON.parse(readFileSync(configPath, 'utf8')) as CliConfig
  }
  const withDb = async <T>(fn: (q: Query) => Promise<T>): Promise<T> => {
    const url = values.url ?? io.env.DATABASE_URL
    if (!url) throw new UserError('Set DATABASE_URL or pass --url.')
    const db = await io.connect(url)
    try { return await fn(db.query) } finally { await db.close() }
  }

  try {
    switch (command) {
      case 'init': {
        if (existsSync(configPath)) throw new UserError(`${CONFIG_FILE} already exists. Edit it, then run generate or migrate.`)
        const features = Object.fromEntries((values.features ?? 'proposals').split(',').map((f) => f.trim()).filter(Boolean).map((f) => [f, true]))
        const unknown = Object.keys(features).filter((f) => f !== 'proposals' && f !== 'files')
        if (unknown.length) throw new UserError(`Unknown feature: ${unknown.join(', ')}. Known: proposals, files`)
        const user = values['user-sql'] ?? (values.supabase ? 'auth.uid()::text' : undefined)
        const tenant = values['tenant-sql']
        if (Boolean(user) !== Boolean(tenant)) throw new UserError('Row-level rules need both --tenant-sql and --user-sql (or --supabase for the user).')
        const config: CliConfig = { features, ...(user && tenant ? { rls: { tenant, user } } : {}) }
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        io.out(`Wrote ${CONFIG_FILE}.`)
        io.out(config.rls ? 'Row-level rules: on.' : 'Row-level rules: off. Add --tenant-sql and --user-sql to turn them on (recommended when the browser can reach the database).')
        io.out(existsSync(join(io.cwd, 'supabase', 'migrations')) ? 'Next: npx teovo generate   (adds a migration to supabase/migrations)' : 'Next: npx teovo migrate    (or generate, to keep the SQL with your own migrations)')
        return 0
      }
      case 'generate': {
        const sql = generateSql(readConfig())
        const supa = join(io.cwd, 'supabase', 'migrations')
        const out = values.out ? join(io.cwd, values.out) : existsSync(supa) ? join(supa, `${stamp(io.now?.() ?? new Date())}_teovo.sql`) : undefined
        if (!out) { io.out(sql); return 0 }
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, sql)
        io.out(`Wrote ${relative(io.cwd, out)}. It is safe to apply again: every statement checks before it creates.`)
        return 0
      }
      case 'migrate': {
        const config = readConfig()
        const applied = await withDb((q) => migrate(q, config))
        io.out(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.')
        return 0
      }
      case 'status': {
        const config = readConfig()
        return await withDb(async (q) => {
          const done = new Set((await q(`select id from tv_migrations`).catch(() => ({ rows: [] }))).rows.map((r) => r.id as string))
          for (const m of migrations(config)) io.out(`${done.has(m.id) ? 'done   ' : 'pending'}  ${m.id}`)
          const missing = await missingTables(q, config.features)
          io.out(missing.length ? `Missing tables: ${missing.join(', ')}` : 'All tables are there.')
          return missing.length ? 1 : 0
        })
      }
      case 'prune': {
        const days = Number(values.days)
        if (!values.days || !Number.isInteger(days) || days < 1) throw new UserError('Say how old: --days 90')
        const fileDays = values['file-days'] === undefined ? undefined : Number(values['file-days'])
        if (fileDays !== undefined && (!Number.isInteger(fileDays) || fileDays < 1)) throw new UserError('--file-days must be a whole number of days')
        const r = await withDb((q) => prune(q, { days, dryRun: !values.yes, ...(fileDays ? { fileDays } : {}) }))
        const pics = fileDays ? ` and ${r.files} pictures older than ${fileDays} days` : ''
        io.out(values.yes
          ? `Deleted ${r.threads} conversations and ${r.usageRows} usage rows older than ${days} days${pics}.`
          : `Would delete ${r.threads} conversations and ${r.usageRows} usage rows older than ${days} days${pics}. Add --yes to delete.`)
        return 0
      }
      default:
        io.out(`Unknown command: ${command}\n\n${HELP}`)
        return 1
    }
  } catch (e) {
    if (e instanceof UserError) { io.out(e.message); return 1 }
    throw e
  }
}

class UserError extends Error {}

/** Supabase migration names start with a UTC timestamp: 20261127093000. */
const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
