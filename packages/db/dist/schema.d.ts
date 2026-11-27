export interface Migration {
    id: string;
    sql: string;
}
export interface SchemaOptions {
    /** Features switched on in createAssistant({ features }). Only their tables are created. */
    features?: {
        proposals?: boolean;
    };
    /**
     * Row-level rules that match the app's own tenancy, as SQL expressions returning text. When given, every
     * tv_ table gets rules so a user sees only their own tenant's rows (and only their own threads).
     * Example for scoops on Supabase: { tenant: 'public.current_business_id()::text', user: 'auth.uid()::text' }.
     */
    rls?: {
        tenant: string;
        user: string;
        roles?: string[];
    };
}
/** The migrations for these options, in order. */
export declare function migrations(options?: SchemaOptions): Migration[];
/** Tables each feature needs, for the start-up check. */
export declare const FEATURE_TABLES: Record<string, string[]>;
