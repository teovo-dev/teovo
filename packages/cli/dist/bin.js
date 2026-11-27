#!/usr/bin/env node
import pg from 'pg';
import { main } from './cli.js';
const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => console.log(line),
    connect: async (url) => {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        return { query: (text, params) => client.query(text, params), close: () => client.end() };
    },
}).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    return 1;
});
process.exit(code);
//# sourceMappingURL=bin.js.map