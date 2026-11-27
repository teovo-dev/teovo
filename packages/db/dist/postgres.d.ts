import { type Storage } from '@teovo/server';
import type { Query } from './migrate.js';
/**
 * Storage on Postgres through any query function (node-postgres Pool, a Drizzle/pg client, a Cloudflare
 * Hyperdrive client…). Run `migrate` first. Threads are only ever found by tenant and user together.
 */
export declare function postgresStorage(query: Query): Storage;
