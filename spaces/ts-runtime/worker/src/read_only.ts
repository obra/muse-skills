// Read-only data access for an action the daemon runs for a `view` grantee.
//
// The daemon decides which invocations are read-only (`read_only` on the
// invoke command); the page never does. Such an invocation gets a database
// accessor on its own connection with `PRAGMA query_only = ON`, so SQLite
// refuses every write. In front of it each statement must be one SELECT,
// WITH or VALUES statement (no PRAGMA can turn `query_only` off, no ATTACH),
// and SQLite's own `EXPLAIN` of it, with its bindings, must show a program
// that doesn't write: the same check the Cloudflare read-only path uses.
// Transactions, migrations and multi-statement scripts are refused outright:
// libsql hands a transaction the client's connection and opens a fresh one
// without the pragma. Blob writes are refused; blob reads pass through.

import type { Client, InArgs, InStatement, ResultSet, Transaction, TransactionMode } from "@libsql/client";
import type { BlobClient } from "@hatch/space-sdk";

export const VIEW_ONLY_CODE = "view_only";

export class ViewOnlyError extends Error {
  readonly code = VIEW_ONLY_CODE;

  constructor() {
    super("You can view this app but can't make changes to it.");
    this.name = "ViewOnlyError";
  }
}

function deny(): never {
  throw new ViewOnlyError();
}

/**
 * True when an error from a read-only invocation is the refused write:
 * a `ViewOnlyError`, or SQLite refusing it, found on the error or anywhere
 * down its `cause` chain. drizzle wraps a failed query in its own error
 * ("Failed query: …") with the driver's error as `cause`, and action code
 * may wrap it again.
 */
export function isReadOnlyRefusal(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (isRefusalItself(current)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isRefusalItself(err: object): boolean {
  const code = (err as { code?: unknown }).code;
  const rawCode = (err as { rawCode?: unknown }).rawCode;
  return (
    code === VIEW_ONLY_CODE ||
    (typeof code === "string" && code.startsWith("SQLITE_READONLY")) ||
    (typeof rawCode === "number" && (rawCode & 0xff) === 8)
  );
}

const WRITING_OPCODES = new Set(["Checkpoint", "Vacuum", "JournalMode", "SqlExec"]);

/** Strips leading whitespace and SQL comments. */
function stripLeadingTrivia(sql: string): string {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const end = trimmed.indexOf("\n");
      rest = end === -1 ? "" : trimmed.slice(end + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) {
        return "";
      }
      rest = trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

/**
 * Whether `sql` is a single statement that can only read: it starts with
 * SELECT, WITH or VALUES and has no second statement after a semicolon. A
 * semicolon inside a string literal also fails the check, which refuses a
 * read rather than risk running a second statement.
 */
export function isSingleReadStatement(sql: string): boolean {
  const body = stripLeadingTrivia(sql);
  if (!/^(select|with|values)\b/i.test(body)) {
    return false;
  }
  const semicolon = body.indexOf(";");
  return semicolon === -1 || stripLeadingTrivia(body.slice(semicolon + 1)) === "";
}

function normalize(stmt: InStatement | [string, InArgs?], args?: InArgs): { sql: string; args: InArgs } {
  if (typeof stmt === "string") {
    return { sql: stmt, args: args ?? [] };
  }
  if (Array.isArray(stmt)) {
    const [sql, tupleArgs] = stmt;
    return { sql, args: tupleArgs ?? [] };
  }
  return { sql: stmt.sql, args: stmt.args ?? [] };
}

async function requireReadOnly(client: Client, stmt: { sql: string; args: InArgs }): Promise<void> {
  if (!isSingleReadStatement(stmt.sql)) {
    deny();
  }
  const program = await client.execute({ sql: `EXPLAIN ${stmt.sql}`, args: stmt.args });
  for (const row of program.rows) {
    const opcode = String((row as Record<string, unknown>).opcode);
    const p2 = Number((row as Record<string, unknown>).p2);
    if ((opcode === "Transaction" && p2 !== 0) || WRITING_OPCODES.has(opcode)) {
      deny();
    }
  }
}

/**
 * Wraps a libsql client whose connection has `query_only` on so it runs only
 * statements that read. The wrapper is all drizzle sees.
 */
export function readOnlyClient(client: Client): Client {
  const wrapper = {
    get closed() {
      return client.closed;
    },
    get protocol() {
      return client.protocol;
    },
    async execute(stmtOrSql: InStatement, args?: InArgs): Promise<ResultSet> {
      const stmt = normalize(stmtOrSql, args);
      await requireReadOnly(client, stmt);
      return client.execute(stmt);
    },
    async batch(stmts: Array<InStatement | [string, InArgs?]>, _mode?: TransactionMode): Promise<ResultSet[]> {
      const normalized = stmts.map((stmt) => normalize(stmt));
      for (const stmt of normalized) {
        await requireReadOnly(client, stmt);
      }
      return client.batch(normalized, "deferred");
    },
    async migrate(): Promise<ResultSet[]> {
      deny();
    },
    async transaction(): Promise<Transaction> {
      deny();
    },
    async executeMultiple(): Promise<void> {
      deny();
    },
    async sync(): Promise<never> {
      deny();
    },
    close(): void {
    },
  };
  return wrapper as unknown as Client;
}

export function readOnlyBlobs(blobs: BlobClient): BlobClient {
  return {
    put: async () => deny(),
    delete: async () => deny(),
    getUrl: (key, options) => blobs.getUrl(key, options),
    head: (key) => blobs.head(key),
    list: (prefix) => blobs.list(prefix),
  };
}
