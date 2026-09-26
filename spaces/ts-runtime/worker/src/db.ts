// Worker-lifetime drizzle-orm accessor backed by `@libsql/client` in
// `file:` mode.
//
// The accessor returned here is API-compatible with the future remote-mode
// (Hrana over HTTPS) variant — switching local for remote will be a URL
// change only. The `LibSQLDatabase<TSchema>` cast type the SDK declares is
// identical regardless of how the underlying client was opened.
//
// Migrations are NOT applied here. `build-space` runs the drizzle migrator
// (`drizzle-orm/libsql/migrator`) as part of its pipeline and refuses to
// publish a bundle whose schema hasn't applied cleanly. By the time the
// worker spawns, app.db is already at the target schema.
//
// One client per worker process: the libsql file-mode client carries an
// underlying SQLite handle plus WAL state. Opening one per invocation
// leaks file descriptors over the worker's lifetime. We open at startup
// and close on shutdown. PRAGMAs (`journal_mode = WAL`, `foreign_keys = ON`)
// are set once here — `foreign_keys` is per-connection but the file-mode
// libsql client uses a single underlying connection, so setting it once is
// durable for the worker's lifetime.

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { SpaceDbAccessor } from "@hatch/space-sdk";

export interface SpaceDb {
  accessor: SpaceDbAccessor;
  close(): Promise<void>;
}

export async function openSpaceDb(dbPath: string): Promise<SpaceDb> {
  const client: Client = createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  const drizzleInstance = drizzle(client);

  return {
    accessor: <TSchema extends Record<string, unknown>>() =>
      drizzleInstance as unknown as LibSQLDatabase<TSchema>,
    async close(): Promise<void> {
      // libsql's close is sync in file mode but the Client interface
      // exposes it as void; await-ing is harmless and forward-compatible
      // with the remote (Hrana) variant where it's async.
      try {
        client.close();
      } catch (err) {
        process.stderr.write(`[ts-worker] libsql close failed: ${String(err)}\n`);
      }
    },
  };
}
