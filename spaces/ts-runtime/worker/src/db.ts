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

import { readOnlyClient } from "./read_only";

export interface SpaceDb {
  accessor: SpaceDbAccessor;
  /**
   * The accessor a `view` grantee's action gets (`read_only.ts`). Its
   * connection opens on first use, so a Space no one views read-only never
   * opens it.
   */
  readOnlyAccessor(): Promise<SpaceDbAccessor>;
  close(): Promise<void>;
}

/** A second connection that SQLite keeps from writing. */
export async function openReadOnlyClient(dbPath: string): Promise<Client> {
  const client: Client = createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA query_only = ON");
  return client;
}

export async function openSpaceDb(dbPath: string): Promise<SpaceDb> {
  const client: Client = createClient({ url: `file:${dbPath}` });
  // Wait for other app.db writers and checkpoints instead of failing at once
  // with SQLITE_BUSY. Set first: the first read can meet WAL recovery.
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  const drizzleInstance = drizzle(client);
  let readOnlyRaw: Promise<Client> | null = null;

  return {
    accessor: <TSchema extends Record<string, unknown>>() =>
      drizzleInstance as unknown as LibSQLDatabase<TSchema>,
    async readOnlyAccessor(): Promise<SpaceDbAccessor> {
      readOnlyRaw ??= openReadOnlyClient(dbPath).catch((err: unknown) => {
        readOnlyRaw = null;
        throw err;
      });
      const readOnlyInstance = drizzle(readOnlyClient(await readOnlyRaw));
      return <TSchema extends Record<string, unknown>>() =>
        readOnlyInstance as unknown as LibSQLDatabase<TSchema>;
    },
    async close(): Promise<void> {
      // libsql's close is sync in file mode but the Client interface
      // exposes it as void; await-ing is harmless and forward-compatible
      // with the remote (Hrana) variant where it's async.
      try {
        client.close();
      } catch (err) {
        process.stderr.write(`[ts-worker] libsql close failed: ${String(err)}\n`);
      }
      if (readOnlyRaw !== null) {
        try {
          (await readOnlyRaw).close();
        } catch (err) {
          process.stderr.write(`[ts-worker] libsql close failed: ${String(err)}\n`);
        }
      }
    },
  };
}
