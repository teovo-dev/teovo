import { FEATURE_TABLES, migrations } from './schema.js';
const LEDGER = `create table if not exists tv_migrations (id text primary key, applied_at timestamptz not null default now())`;
/** Apply the migrations this configuration needs that haven't run yet. Never drops anything. Returns the ids applied. */
export async function migrate(query, options = {}) {
    await query(LEDGER);
    const done = new Set((await query('select id from tv_migrations')).rows.map((r) => r.id));
    const applied = [];
    for (const m of migrations(options)) {
        if (done.has(m.id))
            continue;
        await query('begin');
        try {
            await query(m.sql);
            await query('insert into tv_migrations (id) values ($1)', [m.id]);
            await query('commit');
            applied.push(m.id);
        }
        catch (e) {
            await query('rollback');
            throw new Error(`Teovo migration ${m.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return applied;
}
/** The same migrations as plain SQL, for apps that apply migrations their own way (e.g. a Supabase migrations folder). */
export function generateSql(options = {}) {
    return [`-- Teovo tables. Generated; apply once, in order.`, `${LEDGER};`,
        ...migrations(options).map((m) => `-- ${m.id}\n${m.sql.trim()}\ninsert into tv_migrations (id) values ('${m.id}') on conflict do nothing;`)].join('\n\n') + '\n';
}
/** Start-up check: the tables every enabled feature needs. Returns the missing ones (empty when ready). */
export async function missingTables(query, features = {}) {
    const need = [...FEATURE_TABLES.core, ...(features.proposals ? FEATURE_TABLES.proposals : [])];
    const have = new Set((await query(`select table_name from information_schema.tables where table_schema = any (current_schemas(false))`)).rows.map((r) => r.table_name));
    return need.filter((t) => !have.has(t));
}
//# sourceMappingURL=migrate.js.map