// Teovo's own tables. Core tables are always created; a feature's tables only when that feature is on.
// Nothing here touches the app's tables. Ids of tenants and users are text, so any app's ids fit.

export interface Migration { id: string; sql: string }

export interface SchemaOptions {
  /** Features switched on in createAssistant({ features }). Only their tables are created. */
  features?: { proposals?: boolean }
  /**
   * Row-level rules that match the app's own tenancy, as SQL expressions returning text. When given, every
   * tv_ table gets rules so a user sees only their own tenant's rows (and only their own threads).
   * Example for scoops on Supabase: { tenant: 'public.current_business_id()::text', user: 'auth.uid()::text' }.
   */
  rls?: { tenant: string; user: string; roles?: string[] }
}

const core: Migration = {
  id: '0001_core',
  sql: `
create table if not exists tv_threads (
  id          uuid primary key,
  tenant_id   text not null,
  user_id     text not null,
  title       text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists tv_threads_owner on tv_threads (tenant_id, user_id, created_at desc);

create table if not exists tv_messages (
  seq         bigserial primary key,
  id          text not null,
  thread_id   uuid not null references tv_threads (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system')),
  parts       jsonb not null,
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  unique (thread_id, id)
);

create table if not exists tv_runs (
  id             uuid primary key,
  thread_id      uuid not null references tv_threads (id) on delete cascade,
  tenant_id      text not null,
  user_id        text not null,
  model          text,
  prompt_version text,
  status         text not null default 'running' check (status in ('running', 'done', 'failed', 'stopped')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  error          text
);

create table if not exists tv_run_steps (
  id           bigserial primary key,
  run_id       uuid not null references tv_runs (id) on delete cascade,
  seq          int not null,
  type         text not null,
  tool_call_id text,
  name         text,
  input        jsonb,
  output       jsonb,
  truncated    boolean not null default false,
  error        text,
  duration_ms  int,
  created_at   timestamptz not null default now()
);
create index if not exists tv_run_steps_run on tv_run_steps (run_id, seq);

create table if not exists tv_usage (
  id         bigserial primary key,
  tenant_id  text not null,
  user_id    text not null,
  run_id     uuid,
  provider   text not null,
  model      text not null,
  unit       text not null,
  amount     numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists tv_usage_daily (
  tenant_id text not null,
  user_id   text not null default '',
  day       date not null,
  unit      text not null,
  amount    numeric not null default 0,
  primary key (tenant_id, user_id, day, unit)
);

create table if not exists tv_budgets (
  tenant_id text not null,
  user_id   text not null default '',
  unit      text not null,
  period    text not null default 'day' check (period in ('day', 'month')),
  "limit"   numeric not null,
  primary key (tenant_id, user_id, unit, period)
);

create table if not exists tv_tenant_settings (
  tenant_id    text primary key,
  enabled      boolean not null default true,
  instructions text,
  glossary     jsonb,
  tools_off    jsonb
);`,
}

const proposals: Migration = {
  id: '0002_proposals',
  sql: `
create table if not exists tv_proposals (
  id             uuid primary key,
  thread_id      uuid not null references tv_threads (id) on delete cascade,
  run_id         uuid not null,
  kind           text not null,
  title          text not null,
  before         jsonb,
  after          jsonb,
  payload        jsonb,
  status         text not null default 'shown' check (status in ('shown', 'waiting_for_approval', 'confirmed', 'skipped', 'undone', 'expired')),
  decided_by     text,
  decided_at     timestamptz,
  reversible     boolean,
  undo           jsonb,
  record_version text,
  undone_at      timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists tv_proposals_thread on tv_proposals (thread_id, created_at);`,
}

const proposalSources: Migration = {
  id: '0004_proposal_sources',
  sql: `alter table tv_proposals add column if not exists untrusted_sources jsonb;`,
}

const formats: Migration = {
  id: '0003_tenant_formats',
  sql: `alter table tv_tenant_settings add column if not exists formats jsonb;`,
}

function rlsMigration(tables: string[], rls: NonNullable<SchemaOptions['rls']>): Migration {
  const to = (rls.roles?.length ? rls.roles : ['public']).join(', ')
  const own = `tenant_id = (${rls.tenant}) and user_id = (${rls.user})`
  const viaThread = `exists (select 1 from tv_threads t where t.id = thread_id and t.tenant_id = (${rls.tenant}) and t.user_id = (${rls.user}))`
  const rule: Record<string, string> = {
    tv_threads: own, tv_runs: own, tv_messages: viaThread, tv_proposals: viaThread,
    tv_run_steps: `exists (select 1 from tv_runs r where r.id = run_id and r.tenant_id = (${rls.tenant}) and r.user_id = (${rls.user}))`,
    tv_usage: own, tv_usage_daily: `tenant_id = (${rls.tenant})`, tv_budgets: `tenant_id = (${rls.tenant})`, tv_tenant_settings: `tenant_id = (${rls.tenant})`,
  }
  const sql = tables.map((t) =>
    `alter table ${t} enable row level security;\n` +
    `drop policy if exists ${t}_own on ${t};\n` +
    `create policy ${t}_own on ${t} for all to ${to} using (${rule[t]}) with check (${rule[t]});`).join('\n')
  return { id: `rls_${tables.join('_').replace(/tv_/g, '').slice(0, 40)}`, sql }
}

/** The migrations for these options, in order. */
export function migrations(options: SchemaOptions = {}): Migration[] {
  const list: Migration[] = [core]
  const tables = ['tv_threads', 'tv_messages', 'tv_runs', 'tv_run_steps', 'tv_usage', 'tv_usage_daily', 'tv_budgets', 'tv_tenant_settings']
  if (options.features?.proposals) { list.push(proposals); tables.push('tv_proposals') }
  list.push(formats)
  if (options.features?.proposals) list.push(proposalSources)
  if (options.rls) list.push({ ...rlsMigration(tables, options.rls), id: `0100_rls_${options.features?.proposals ? 'with_proposals' : 'core'}` })
  return list
}

/** Tables each feature needs, for the start-up check. */
export const FEATURE_TABLES: Record<string, string[]> = {
  core: ['tv_threads', 'tv_messages', 'tv_runs', 'tv_run_steps', 'tv_usage', 'tv_usage_daily', 'tv_budgets', 'tv_tenant_settings', 'tv_migrations'],
  proposals: ['tv_proposals'],
}
