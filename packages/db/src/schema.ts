// Teovo's own tables. Core tables are always created; a feature's tables only when that feature is on.
// Nothing here touches the app's tables. Ids of tenants and users are text, so any app's ids fit.

export interface Migration { id: string; sql: string }

export interface SchemaOptions {
  /** Features switched on in createAssistant({ features }). Only their tables are created. */
  features?: { proposals?: boolean; files?: boolean }
  /**
   * Row-level rules that match the app's own tenancy, as SQL expressions returning text. When given, every
   * tv_ table gets rules so a user sees only their own tenant's rows (and only their own threads).
   * Example for scoops on Supabase: { tenant: 'public.current_business_id()::text', user: 'auth.uid()::text' }.
   */
  rls?: { tenant: string; user: string; roles?: string[] } | 'server-only'
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

const proposalFields: Migration = {
  id: '0006_proposal_fields',
  sql: `alter table tv_proposals add column if not exists fields jsonb;`,
}

/**
 * Two functions for apps that reach the tables through an HTTP API instead of SQL (Supabase's, with
 * supabaseStorage): adding to a running total, and listing threads by latest activity. Plain SQL apps never call
 * them. They run as the caller (security invoker), so row-level rules still apply.
 */
const apiFunctions: Migration = {
  id: '0007_api_functions',
  sql: `
create or replace function tv_add_usage_daily(p_tenant text, p_user text, p_day date, p_unit text, p_amount numeric)
returns void language sql security invoker as $$
  insert into tv_usage_daily (tenant_id, user_id, day, unit, amount) values (p_tenant, p_user, p_day, p_unit, p_amount), (p_tenant, '', p_day, p_unit, p_amount)
  on conflict (tenant_id, user_id, day, unit) do update set amount = tv_usage_daily.amount + excluded.amount
$$;
create or replace function tv_list_threads(p_tenant text, p_user text, p_limit int)
returns table (id uuid, tenant_id text, user_id text, title text, created_at timestamptz, updated_at timestamptz)
language sql stable security invoker as $$
  select t.id, t.tenant_id, t.user_id, t.title, t.created_at,
         coalesce((select max(m.created_at) from tv_messages m where m.thread_id = t.id), t.created_at) as updated_at
  from tv_threads t where t.tenant_id = p_tenant and t.user_id = p_user and t.archived_at is null
  order by 6 desc limit p_limit
$$;
revoke all on function tv_add_usage_daily(text, text, date, text, numeric) from public;
revoke all on function tv_list_threads(text, text, int) from public;`,
}

/** Thumbs up or down on a reply, kept with its run. */
const ratings: Migration = {
  id: '0009_ratings',
  sql: `alter table tv_runs add column if not exists rating smallint check (rating in (-1, 1));
alter table tv_runs add column if not exists rating_note text;
alter table tv_runs add column if not exists rated_at timestamptz;`,
}

/** Who proposed, confirmed, skipped or undid each change, and when; and the questions the assistant couldn't answer. */
const auditAndMisses: Migration = {
  id: '0010_audit_misses',
  sql: `
create table if not exists tv_card_events (
  id         bigserial primary key,
  card_id    uuid not null,
  thread_id  uuid not null,
  tenant_id  text not null,
  user_id    text not null,
  kind       text not null,
  title      text not null,
  event      text not null check (event in ('proposed', 'confirmed', 'skipped', 'undone', 'expired')),
  at         timestamptz not null default now()
);
create index if not exists tv_card_events_tenant on tv_card_events (tenant_id, at desc);

create table if not exists tv_misses (
  id         bigserial primary key,
  tenant_id  text not null,
  user_id    text not null,
  thread_id  uuid,
  run_id     uuid,
  question   text not null,
  reason     text not null,
  at         timestamptz not null default now()
);
create index if not exists tv_misses_tenant on tv_misses (tenant_id, at desc);`,
}

/** A tenant's privacy notice and whether pictures are allowed; and, in the switches row, models taken out of service. */
const privacySwitches: Migration = {
  id: '0011_privacy_switches',
  sql: `alter table tv_tenant_settings add column if not exists privacy jsonb;
alter table tv_tenant_settings add column if not exists models_off jsonb;`,
}

/** One card for many records (items), and the version of the tool that made a card. */
const cardItemsVersions: Migration = {
  id: '0012_card_items_versions',
  sql: `alter table tv_proposals add column if not exists items jsonb;
alter table tv_proposals add column if not exists version int;`,
}

/** A card's change in plain sentences (Proposal.lines). */
const cardLines: Migration = {
  id: '0013_card_lines',
  sql: `alter table tv_proposals add column if not exists lines jsonb;`,
}

/** Pictures kept in an object store (Supabase Storage, R2) only need their owner row here, not the bytes. */
const fileIndex: Migration = {
  id: '0008_file_index',
  sql: `alter table tv_files alter column bytes drop not null;`,
}

const formats: Migration = {
  id: '0003_tenant_formats',
  sql: `alter table tv_tenant_settings add column if not exists formats jsonb;`,
}

const files: Migration = {
  id: '0005_files',
  sql: `
create table if not exists tv_files (
  id         uuid primary key,
  tenant_id  text not null,
  user_id    text not null,
  thread_id  uuid not null references tv_threads (id) on delete cascade,
  media_type text not null,
  filename   text,
  size       int not null,
  bytes      bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists tv_files_age on tv_files (created_at);`,
}

/**
 * 'server-only': only the server's own key (which bypasses row-level security) can use the tables. Row-level
 * security is on with no policies, so a signed-in browser calling the database API directly sees nothing and can
 * change nothing (it could otherwise delete its usage rows to get past a limit). On Supabase the API roles also
 * lose the right to call Teovo's functions.
 */
function serverOnlyMigration(tables: string[]): Migration {
  const sql = tables.map((t) => `alter table ${t} enable row level security;`).join('\n') + `
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on ${tables.join(', ')} to service_role;
    perform 1;
    declare q text; begin
      for q in select format('grant usage, select on sequence %s to service_role', s.relname) from pg_class s
        join pg_depend d on d.objid = s.oid join pg_class t on t.oid = d.refobjid
        where s.relkind = 'S' and t.relname = any(array['${tables.join("','")}']) and t.relnamespace = s.relnamespace
      loop execute q; end loop;
    end;
    grant execute on function tv_add_usage_daily(text, text, date, text, numeric), tv_list_threads(text, text, int) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on ${tables.join(', ')} from anon, authenticated;
    revoke all on function tv_add_usage_daily(text, text, date, text, numeric) from anon, authenticated;
    revoke all on function tv_list_threads(text, text, int) from anon, authenticated;
  end if;
end $$;`
  return { id: 'server_only', sql }
}

function rlsMigration(tables: string[], rls: Exclude<NonNullable<SchemaOptions['rls']>, 'server-only'>): Migration {
  const to = (rls.roles?.length ? rls.roles : ['public']).join(', ')
  const own = `tenant_id = (${rls.tenant}) and user_id = (${rls.user})`
  const viaThread = `exists (select 1 from tv_threads t where t.id = thread_id and t.tenant_id = (${rls.tenant}) and t.user_id = (${rls.user}))`
  const rule: Record<string, string> = {
    tv_threads: own, tv_runs: own, tv_messages: viaThread, tv_proposals: viaThread,
    tv_run_events: `exists (select 1 from tv_runs r where r.id = run_id and r.tenant_id = (${rls.tenant}) and r.user_id = (${rls.user}))`,
    tv_run_steps: `exists (select 1 from tv_runs r where r.id = run_id and r.tenant_id = (${rls.tenant}) and r.user_id = (${rls.user}))`,
    tv_files: own, tv_card_events: own, tv_misses: own, tv_usage: own, tv_usage_daily: `tenant_id = (${rls.tenant})`, tv_budgets: `tenant_id = (${rls.tenant})`, tv_tenant_settings: `tenant_id = (${rls.tenant})`,
  }
  const sql = tables.map((t) =>
    `alter table ${t} enable row level security;\n` +
    `drop policy if exists ${t}_own on ${t};\n` +
    `create policy ${t}_own on ${t} for all to ${to} using (${rule[t]}) with check (${rule[t]});`).join('\n')
  return { id: `rls_${tables.join('_').replace(/tv_/g, '').slice(0, 40)}`, sql }
}

const runViewer: Migration = {
  id: '0014_run_viewer',
  sql: `alter table tv_runs add column if not exists question text;
create index if not exists tv_runs_tenant_started on tv_runs (tenant_id, started_at desc);
create index if not exists tv_usage_run on tv_usage (run_id) where run_id is not null;`,
}

/**
 * Long runs: tv_runs doubles as the queue (queued status, the job, which server holds it until when, tries, a stop
 * flag), and tv_run_events keeps each reply's stream in batches, so any server can send it, resume it or stop it.
 */
const longRuns: Migration = {
  id: '0015_long_runs',
  sql: `alter table tv_runs drop constraint if exists tv_runs_status_check;
alter table tv_runs add constraint tv_runs_status_check check (status in ('queued', 'running', 'done', 'failed', 'stopped'));
alter table tv_runs add column if not exists job jsonb;
alter table tv_runs add column if not exists worker text;
alter table tv_runs add column if not exists lease_until timestamptz;
alter table tv_runs add column if not exists attempts int not null default 0;
alter table tv_runs add column if not exists stop_requested_at timestamptz;
create index if not exists tv_runs_waiting on tv_runs (started_at) where status in ('queued', 'running');
create table if not exists tv_run_events (
  run_id     uuid not null references tv_runs (id) on delete cascade,
  attempt    int not null,
  seq        int not null,
  chunks     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, attempt, seq)
);`,
}

/** A conversation's summary of its older messages, once they no longer fit in what the model sees. */
const threadSummary: Migration = {
  id: '0016_thread_summary',
  sql: `alter table tv_threads add column if not exists summary text;
alter table tv_threads add column if not exists summary_upto text;`,
}

/** The migrations for these options, in order. */
export function migrations(options: SchemaOptions = {}): Migration[] {
  const list: Migration[] = [core]
  const tables = ['tv_threads', 'tv_messages', 'tv_runs', 'tv_run_steps', 'tv_usage', 'tv_usage_daily', 'tv_budgets', 'tv_tenant_settings']
  if (options.features?.proposals) { list.push(proposals); tables.push('tv_proposals') }
  list.push(formats)
  if (options.features?.proposals) list.push(proposalSources, proposalFields)
  if (options.features?.files) { list.push(files); tables.push('tv_files') }
  list.push(apiFunctions, ratings)
  if (options.features?.files) list.push(fileIndex)
  const suffix = `${options.features?.proposals ? 'with_proposals' : 'core'}${options.features?.files ? '_files' : ''}`
  if (options.rls === 'server-only') list.push({ ...serverOnlyMigration(tables), id: `0101_server_only_${suffix}` })
  else if (options.rls) list.push({ ...rlsMigration(tables, options.rls), id: `0100_rls_${suffix}` })
  // Tables added later get their rules in their own migration, so apps that already ran the ones above get them too.
  list.push(auditAndMisses, privacySwitches)
  if (options.features?.proposals) list.push(cardItemsVersions, cardLines)
  list.push(runViewer)
  const later = ['tv_card_events', 'tv_misses']
  if (options.rls === 'server-only') list.push({ ...serverOnlyMigration(later), id: '0111_server_only_audit_misses' })
  else if (options.rls) list.push({ ...rlsMigration(later, options.rls), id: '0110_rls_audit_misses' })
  list.push(longRuns)
  if (options.rls === 'server-only') list.push({ ...serverOnlyMigration(['tv_run_events']), id: '0115_server_only_run_events' })
  else if (options.rls) list.push({ ...rlsMigration(['tv_run_events'], options.rls), id: '0115_rls_run_events' })
  list.push(threadSummary)
  return list
}

/** Tables each feature needs, for the start-up check. */
export const FEATURE_TABLES: Record<string, string[]> = {
  core: ['tv_threads', 'tv_messages', 'tv_runs', 'tv_run_steps', 'tv_run_events', 'tv_usage', 'tv_usage_daily', 'tv_budgets', 'tv_tenant_settings', 'tv_card_events', 'tv_misses', 'tv_migrations'],
  proposals: ['tv_proposals'],
  files: ['tv_files'],
}
