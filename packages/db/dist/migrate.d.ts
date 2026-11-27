import { type SchemaOptions } from './schema.js';
/** Runs one SQL statement with parameters, e.g. (text, params) => pool.query(text, params). */
export type Query = (text: string, params?: unknown[]) => Promise<{
    rows: any[];
}>;
/** Apply the migrations this configuration needs that haven't run yet. Never drops anything. Returns the ids applied. */
export declare function migrate(query: Query, options?: SchemaOptions): Promise<string[]>;
/** The same migrations as plain SQL, for apps that apply migrations their own way (e.g. a Supabase migrations folder). */
export declare function generateSql(options?: SchemaOptions): string;
/** Start-up check: the tables every enabled feature needs. Returns the missing ones (empty when ready). */
export declare function missingTables(query: Query, features?: SchemaOptions['features']): Promise<string[]>;
