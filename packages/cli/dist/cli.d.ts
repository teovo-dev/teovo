import { type Query, type SchemaOptions } from '@teovo/db';
export declare const CONFIG_FILE = "teovo.config.json";
/** What `teovo.config.json` holds: the same options the tables are built from. */
export interface CliConfig extends SchemaOptions {
    $schema?: string;
}
export interface Io {
    cwd: string;
    env: Record<string, string | undefined>;
    out: (line: string) => void;
    /** Opens a database connection. Injected so tests and other drivers can supply their own. */
    connect: (url: string) => Promise<{
        query: Query;
        close: () => Promise<void>;
    }>;
    now?: () => Date;
}
export declare function main(argv: string[], io: Io): Promise<number>;
