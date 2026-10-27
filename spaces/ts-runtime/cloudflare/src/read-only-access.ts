import type { BlobClient } from "./sdk";

/**
 * Restricted shares grant each recipient `view` or `use`. The Cloudflare
 * dispatcher (par-msl/tinker-sandbox `services/dispatch-worker`) forwards a
 * view-only recipient's `POST /actions` here instead of `/actions`. Runtimes
 * built before this path existed answer it with 404, so view-only recipients
 * of older deployments still cannot run actions.
 */
export const READ_ONLY_ACTIONS_PATH = "/__hatch/read-only-actions";

export const READ_ONLY_DENIAL_MESSAGE = "You can view this app but can't make changes to it.";

type Program = { results?: unknown[] };

type Statement = {
  bind(...values: unknown[]): Statement;
  first(...args: unknown[]): Promise<unknown>;
  all(): Promise<Program>;
  run(): Promise<unknown>;
  raw(...args: unknown[]): Promise<unknown>;
};

type Database = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Program[]>;
};

/**
 * Wraps the D1 binding so a statement runs only when SQLite compiles it to a
 * program that does not write. SQLite decides: `EXPLAIN` of the same statement,
 * with the same bindings, compiles it without running it and lists the program.
 * A program writes when it opens a write transaction (`Transaction` with P2
 * other than 0), checkpoints, vacuums, changes the journal mode, or runs nested
 * SQL (`SqlExec`, which `PRAGMA optimize` uses to run ANALYZE). D1 prepares
 * exactly one statement per `prepare`, so the check covers everything a
 * statement runs.
 */
export function readOnlyDatabase(database: Database, deny: () => never): Database {
  return {
    prepare: sql => new ReadOnlyStatement(database.prepare(sql), database.prepare(`EXPLAIN ${sql}`), deny),
    async batch(statements) {
      const checked = statements.map(statement => {
        if (!(statement instanceof ReadOnlyStatement)) {
          throw new Error("A batched statement was not prepared by the read-only database.");
        }
        return statement;
      });
      for (const program of await database.batch(checked.map(statement => statement.explain))) {
        requireReadOnly(program, deny);
      }
      return database.batch(checked.map(statement => statement.statement));
    },
  };
}

class ReadOnlyStatement implements Statement {
  readonly statement: Statement;
  readonly explain: Statement;
  readonly #deny: () => never;

  constructor(statement: Statement, explain: Statement, deny: () => never) {
    this.statement = statement;
    this.explain = explain;
    this.#deny = deny;
  }

  bind(...values: unknown[]): Statement {
    return new ReadOnlyStatement(this.statement.bind(...values), this.explain.bind(...values), this.#deny);
  }

  async first(...args: unknown[]): Promise<unknown> {
    await this.#check();
    return this.statement.first(...args);
  }

  async all(): Promise<Program> {
    await this.#check();
    return this.statement.all();
  }

  async run(): Promise<unknown> {
    await this.#check();
    return this.statement.run();
  }

  async raw(...args: unknown[]): Promise<unknown> {
    await this.#check();
    return this.statement.raw(...args);
  }

  async #check(): Promise<void> {
    requireReadOnly(await this.explain.all(), this.#deny);
  }
}

const WRITING_OPCODES = new Set(["Checkpoint", "Vacuum", "JournalMode", "SqlExec"]);

function requireReadOnly(program: Program, deny: () => never): void {
  for (const instruction of program.results ?? []) {
    const { opcode, p2 } = instruction as { opcode?: unknown; p2?: unknown };
    if ((opcode === "Transaction" && Number(p2) !== 0) || WRITING_OPCODES.has(String(opcode))) deny();
  }
}

export function readOnlyBlobs(blobs: BlobClient, deny: () => never): BlobClient {
  return {
    put: async () => deny(),
    delete: async () => deny(),
    getUrl: (key, options) => blobs.getUrl(key, options),
    head: key => blobs.head(key),
    list: prefix => blobs.list(prefix),
  };
}
