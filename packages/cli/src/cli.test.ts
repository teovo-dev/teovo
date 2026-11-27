import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { main, type Io } from './cli'

const url = process.env.TEOVO_TEST_DATABASE_URL
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function project(withSupabase = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'teovo-cli-'))
  dirs.push(cwd)
  if (withSupabase) mkdirSync(join(cwd, 'supabase', 'migrations'), { recursive: true })
  const lines: string[] = []
  let schema = ''
  const io: Io = {
    cwd, env: { DATABASE_URL: url ? 'from-env' : undefined }, out: (l) => lines.push(l), now: () => new Date('2026-11-27T09:30:00Z'),
    connect: async () => {
      const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` })
      await client.connect()
      return { query: (t, p) => client.query(t, p as unknown[]), close: () => client.end() }
    },
  }
  const run = async (...args: string[]) => { lines.length = 0; const code = await main(args, io); return { code, text: lines.join('\n') } }
  return { cwd, io, run, lines, useSchema: (s: string) => { schema = s } }
}

describe('teovo init and generate', () => {
  it('prints help without a command and refuses unknown ones', async () => {
    const p = project()
    expect((await p.run()).code).toBe(1)
    expect((await p.run('--help')).text).toContain('Usage: teovo <command>')
    expect((await p.run('deploy')).text).toContain('Unknown command: deploy')
  })

  it('writes the config once, with row-level rules when given both expressions', async () => {
    const p = project(true)
    expect((await p.run('init', '--supabase')).text).toBe('Row-level rules need both --tenant-sql and --user-sql (or --supabase for the user).')
    expect((await p.run('init', '--features', 'proposals,voice')).text).toBe('Unknown feature: voice. Known: proposals, files')
    const r = await p.run('init', '--supabase', '--tenant-sql', 'public.current_business_id()::text')
    expect(r.code).toBe(0)
    expect(r.text).toContain('Next: npx teovo generate')
    expect(JSON.parse(readFileSync(join(p.cwd, 'teovo.config.json'), 'utf8'))).toEqual({
      features: { proposals: true }, rls: { tenant: 'public.current_business_id()::text', user: 'auth.uid()::text' } })
    expect((await p.run('init')).code).toBe(1)
  })

  it('adds a timestamped migration to supabase/migrations, or prints the SQL', async () => {
    const supa = project(true)
    await supa.run('init', '--supabase', '--tenant-sql', 'public.current_business_id()::text')
    expect((await supa.run('generate')).text).toBe('Wrote supabase/migrations/20261127093000_teovo.sql. It is safe to apply again: every statement checks before it creates.')
    const sql = readFileSync(join(supa.cwd, 'supabase/migrations/20261127093000_teovo.sql'), 'utf8')
    expect(sql).toContain('create table if not exists tv_proposals')
    expect(sql).toContain('auth.uid()::text')

    const plain = project()
    expect((await plain.run('generate')).text).toBe('No teovo.config.json here. Run: npx teovo init')
    await plain.run('init', '--features', '')
    const printed = (await plain.run('generate')).text
    expect(printed).toContain('create table if not exists tv_threads')
    expect(printed).not.toContain('tv_proposals')
    await plain.run('generate', '--out', 'db/teovo.sql')
    expect(existsSync(join(plain.cwd, 'db/teovo.sql'))).toBe(true)
    expect(readdirSync(plain.cwd)).not.toContain('supabase')
  })

  it('asks for a database before connecting', async () => {
    const p = project()
    await p.run('init')
    p.io.env.DATABASE_URL = undefined
    expect((await p.run('migrate')).text).toBe('Set TEOVO_DATABASE_URL (or DATABASE_URL) or pass --url.')
  })
})

const db = url ? describe : describe.skip
db('teovo migrate, status and prune on Postgres', () => {
  let admin: pg.Pool
  let schema = ''
  beforeAll(() => { admin = new pg.Pool({ connectionString: url }) })
  afterEach(async () => { if (schema) await admin.query(`drop schema if exists ${schema} cascade`) })
  afterAll(async () => { await admin.end() })
  const fresh = async (p: ReturnType<typeof project>) => {
    schema = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    await admin.query(`create schema ${schema}`)
    p.useSchema(schema)
  }

  it('shows what is missing, creates it, and then has nothing to do', async () => {
    const p = project()
    await fresh(p)
    await p.run('init')
    const before = await p.run('status')
    expect(before.code).toBe(1)
    expect(before.text).toContain('pending  0002_proposals')
    expect(before.text).toContain('Missing tables: tv_threads')
    expect((await p.run('migrate')).text).toBe('Applied: 0001_core, 0002_proposals, 0003_tenant_formats, 0004_proposal_sources, 0006_proposal_fields, 0007_api_functions, 0009_ratings, 0010_audit_misses, 0011_privacy_switches')
    expect((await p.run('migrate')).text).toBe('Already up to date.')
    const after = await p.run('status')
    expect(after).toEqual({ code: 0, text: 'done     0001_core\ndone     0002_proposals\ndone     0003_tenant_formats\ndone     0004_proposal_sources\ndone     0006_proposal_fields\ndone     0007_api_functions\ndone     0009_ratings\ndone     0010_audit_misses\ndone     0011_privacy_switches\nAll tables are there.' })
  })

  it('prunes only old conversations, and only with --yes', async () => {
    const p = project()
    await fresh(p)
    await p.run('init')
    await p.run('migrate')
    const q = (t: string) => admin.query(t.replaceAll('tv_', `${schema}.tv_`))
    const old = crypto.randomUUID(), revived = crypto.randomUUID(), fresh2 = crypto.randomUUID()
    await q(`insert into tv_threads (id, tenant_id, user_id, created_at) values ('${old}', 's', 'u', now() - interval '200 days'), ('${revived}', 's', 'u', now() - interval '200 days'), ('${fresh2}', 's', 'u', now())`)
    await q(`insert into tv_messages (id, thread_id, role, parts, created_at) values ('m1', '${old}', 'user', '[]', now() - interval '200 days'), ('m2', '${revived}', 'user', '[]', now() - interval '1 day')`)
    await q(`insert into tv_usage (tenant_id, user_id, provider, model, unit, amount, created_at) values ('s', 'u', 'g', 'm', 'messages', 1, now() - interval '200 days'), ('s', 'u', 'g', 'm', 'messages', 1, now())`)
    await q(`insert into tv_usage_daily (tenant_id, user_id, day, unit, amount) values ('s', 'u', current_date - 200, 'messages', 1)`)

    expect((await p.run('prune')).text).toBe('Say how old: --days 90')
    expect((await p.run('prune', '--days', '90')).text).toBe('Would delete 1 conversations and 1 usage rows older than 90 days. Add --yes to delete.')
    expect((await q('select count(*)::int n from tv_threads')).rows[0].n).toBe(3)
    expect((await p.run('prune', '--days', '90', '--yes')).text).toBe('Deleted 1 conversations and 1 usage rows older than 90 days.')
    expect((await q('select id from tv_threads order by created_at')).rows.map((r) => r.id).sort()).toEqual([revived, fresh2].sort())
    expect((await q('select count(*)::int n from tv_messages')).rows[0].n).toBe(1)
    expect((await q('select count(*)::int n from tv_usage_daily')).rows[0].n).toBe(1)   // totals stay
  })
})
