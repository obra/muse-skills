// Drizzle migrator runner — invoked by the daemon-side build pipeline
// (`web_artifact_build` tool, `artifacts` action `create` scaffold) to apply pending
// migrations BEFORE typecheck/bundle.
//
// Bundle build emits this as `dist/migrate.js` next to `worker.js`; the
// build pipeline shells out to `bun run migrate.js --space-dir=<path>
// --db-path=<path>`.
//
// On success: writes `{"ok":true}` to stdout, exits 0.
// On failure: writes the SQLite error message to stderr, exits 1.
//
// The CLI invocation contract is unchanged from the bun:sqlite era; only
// the underlying driver is libsql now. `drizzle-orm/libsql/migrator` reads
// the same `drizzle/_journal.json` + SQL files we already produce.

import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  checkStatementBreakpoints,
  findExplicitTransaction,
  normalizeStatementBreakpoints,
} from "./validate-migrations";

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(flag)) {
      return raw.slice(flag.length);
    }
  }
  return undefined;
}

const spaceDir = arg("space-dir");
const dbPath = arg("db-path");
if (!spaceDir || !dbPath) {
  process.stderr.write(
    "usage: migrate.js --space-dir=<path> --db-path=<path>\n",
  );
  process.exit(2);
}

const drizzleDir = join(spaceDir, "drizzle");
if (!existsSync(drizzleDir)) {
  process.stdout.write(JSON.stringify({ ok: true, applied: 0 }) + "\n");
  process.exit(0);
}

async function lastAppliedTimestamp(client: Client): Promise<number> {
  // Positively confirm the `__drizzle_migrations` ledger exists before reading
  // it. A MISSING ledger is the one condition that legitimately means "first
  // run, nothing applied" → 0. We must NOT infer that from a failed read: a
  // transient/locked/corrupt error would then be swallowed into "0 applied",
  // making already-applied migrations look pending and get rewritten in place;
  // if drizzle's own ledger read later succeeds it sees them as applied and
  // skips them, leaving the rewritten SQL unrun and the source file diverged
  // from the live schema. So a genuine read failure fails the run loudly
  // instead of silently corrupting a migration.
  try {
    const exists = await client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    );
    if (exists.rows.length === 0) return 0;

    const result = await client.execute(
      "SELECT MAX(created_at) AS last FROM __drizzle_migrations",
    );
    const last = result.rows[0]?.last;
    return last == null ? 0 : Number(last);
  } catch (err) {
    // A failure reading the ledger is operational (locked / unreadable /
    // corrupt DB), NOT a defect in the migration SQL. The build surfaces this
    // verbatim as a Migrations-stage failure, so phrase it to steer the builder
    // AWAY from editing valid source: retry the build, and report the
    // infrastructure failure only if it persists.
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not read the migration ledger (__drizzle_migrations): ${cause}. ` +
        "This is a transient/infrastructure database error, not a problem with " +
        "the migration SQL — do NOT edit the migration or schema; retry the " +
        "build, and report the infrastructure failure if it persists.",
    );
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

async function readJournalEntries(
  path: string,
): Promise<Array<{ tag: string; when: number }>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as {
    entries?: Array<{ tag: string; when: number }>;
  };
  return parsed.entries ?? [];
}

/**
 * Validate every migration drizzle would actually run on this DB.
 *
 * Drizzle's libsql migrator splits each file on `--> statement-breakpoint`
 * and hands every chunk to libsql's single-statement `execute`, which
 * silently drops anything after the first `;` in a chunk while still
 * reporting success. We catch that here by counting top-level statements
 * per chunk and bailing if any chunk has more than one.
 *
 * Scope mirrors drizzle's own dedup: only validate migrations whose
 * journal `when` is strictly greater than `MAX(created_at)` in
 * `__drizzle_migrations`. That's exactly the set drizzle is going to run,
 * so the validator never yells about a migration drizzle would skip.
 *
 * Returns the filenames whose missing `--> statement-breakpoint` markers were
 * auto-inserted this run, so the caller can surface when the fix fired.
 */
async function validateMigrations(client: Client): Promise<string[]> {
  const normalizedFiles: string[] = [];
  const entries = await readJournalEntries(
    join(drizzleDir, "meta", "_journal.json"),
  );
  if (entries.length === 0) return normalizedFiles;

  const lastApplied = await lastAppliedTimestamp(client);
  const pending = entries.filter((e) => e.when > lastApplied);

  for (const entry of pending) {
    const filename = `${entry.tag}.sql`;
    const path = join(drizzleDir, filename);
    const content = await readFile(path, "utf8");

    // Already drizzle-safe → leave the builder's file untouched.
    if (checkStatementBreakpoints(content) === null) continue;

    // Explicit transaction control can't be auto-fixed (removing BEGIN/COMMIT/
    // ROLLBACK is a semantic change, and an unmatched BEGIN would corrupt the
    // statement splitter). Surface it for the builder to fix.
    const txn = findExplicitTransaction(content);
    if (txn !== null) throw new Error(`drizzle/${filename}: ${txn}`);

    // The dominant migration failure is multiple `;`-terminated statements in
    // one chunk without a `--> statement-breakpoint` between them. Auto-insert
    // the markers at the real top-level boundaries the validator already
    // detects, then re-validate. This runs only on a PENDING (not-yet-applied)
    // migration and rewrites the file BEFORE drizzle hashes/applies it, so the
    // ledger stays consistent; it is idempotent (an already-safe file is
    // skipped above).
    const normalized = normalizeStatementBreakpoints(content);
    const reason = checkStatementBreakpoints(normalized);
    if (reason !== null) {
      // Normalization can't rescue a statementless/empty migration — surface
      // the clear, actionable error.
      throw new Error(
        `drizzle/${filename}: ${reason}\n` +
          "Drizzle hands each `--> statement-breakpoint`-separated chunk " +
          "to libsql as a single statement and silently drops everything " +
          "after the first `;`. Insert `--> statement-breakpoint` on its " +
          "own line between each statement (typical case: between " +
          "consecutive `CREATE TABLE` / `ALTER TABLE` statements).",
      );
    }
    if (normalized !== content) {
      await writeFile(path, normalized, "utf8");
      normalizedFiles.push(filename);
    }
  }
  return normalizedFiles;
}

async function main(): Promise<number> {
  const client = createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client);

  try {
    const normalized = await validateMigrations(client);
    await migrate(db, { migrationsFolder: drizzleDir });
    // `normalized` lists any pending migrations the auto-fix rewrote; the
    // daemon-side runner (migrations.rs) logs it when non-empty.
    process.stdout.write(JSON.stringify({ ok: true, normalized }) + "\n");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + "\n");
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`migrate fatal: ${String(err)}\n`);
    process.exit(1);
  },
);
