// Pre-validation for hand-written drizzle migration files.
//
// Drizzle's libsql migrator splits each migration file on the literal
// `--> statement-breakpoint` string and hands every resulting chunk to
// libsql's single-statement `db.run`. Two malformed shapes both detonate:
//
//   1. A chunk with multiple `;`-terminated statements: libsql executes
//      only the first and silently drops the rest, but drizzle still
//      records the migration as applied — schema silently incomplete.
//   2. An EMPTY chunk, produced by a leading/trailing/doubled marker:
//      libsql executes an empty statement and throws the self-
//      contradicting `SQLITE_OK: not an error`, which is opaque enough
//      that builders abandon the migrator and hand-edit app.db, breaking
//      the migration ledger. The scaffold template historically shipped a
//      trailing marker, so this was the most common shape in practice.
//
// This module fails loud, with an actionable message, before drizzle's
// migrator gets a chance to produce either state. Scoping to not-yet-
// applied migrations is the caller's job (see migrate-cli.ts) so existing
// spaces with already-applied broken migrations don't suddenly fail.
//
// SQL tokenization: `findExplicitTransaction`, `countTopLevelStatements`,
// and `splitTopLevelStatements` share one state machine that skips string
// literals (`'…'`), and all three SQLite identifier-quoting styles —
// double-quote (`"…"`), backtick (`` `…` ``), and bracket (`[…]`) — plus
// line/block comments, so a `;` or a keyword (`case`, `begin`, `end`) that
// only appears *inside* a quoted identifier or comment is never mistaken
// for real SQL. The three MUST stay in lockstep: a quoting style one of
// them fails to skip lets a spurious `;`/keyword through, which either
// mis-splits a valid statement or (worse) merges two statements into a
// chunk drizzle then applies incompletely while still recording success.

/**
 * Returns `null` if the SQL content is safe to hand to drizzle's
 * migrator, or a human-readable reason string explaining why it isn't.
 *
 * "Safe" means: every chunk between `--> statement-breakpoint` markers
 * carries exactly one real SQL statement — never more than one, and never
 * a statementless chunk (whitespace/comments/bare `;` only, which libsql
 * runs as an empty statement and fails on) — AND no explicit transaction
 * control (`BEGIN/COMMIT/ROLLBACK`). An empty/unfilled migration file is
 * rejected too: drizzle would choke on it with `SQLITE_OK`, so a clear
 * "no statement" error is strictly better than letting it reach libsql.
 */
export function checkStatementBreakpoints(content: string): string | null {
  const chunks = content.split("--> statement-breakpoint");
  for (const chunk of chunks) {
    const txnReason = findExplicitTransaction(chunk);
    if (txnReason !== null) return txnReason;
    const count = countTopLevelStatements(chunk);
    if (count > 1) {
      return `found ${count} \`;\`-terminated statements in a single chunk without a \`--> statement-breakpoint\` between them`;
    }
    // A chunk that carries no executable statement — only whitespace,
    // comments, and/or bare `;` terminators — makes libsql run an empty
    // statement and throw the opaque `SQLITE_OK: not an error`. Every such
    // shape is a mistake that ends in that error, so reject them all up
    // front with one actionable message: a stray leading/trailing/doubled
    // `--> statement-breakpoint` (empty chunk), a lone `;`, or a wholly
    // empty/unfilled migration file. There is no legitimate empty
    // migration — drizzle would choke on it regardless.
    if (isStatementless(chunk)) {
      return (
        "found a chunk with no executable statement (only whitespace, " +
        "comments, or a bare `;`). Causes: an empty/unfilled migration " +
        "file, a stray `--> statement-breakpoint` (leading, trailing, or " +
        "doubled), or a lone `;`. libsql runs the empty chunk and fails " +
        "with the opaque `SQLITE_OK: not an error`. Every chunk between " +
        "markers must be exactly one real SQL statement."
      );
    }
  }
  return null;
}

/** Strip SQL line and block comments, leaving only code + whitespace. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * True when a chunk carries no executable statement: only whitespace,
 * comments, and/or bare `;` terminators. Catches empty files, the empty
 * chunk a stray marker leaves, and a lone `;`. Distinct from
 * `countTopLevelStatements()===0`, which also matches a real statement
 * that merely lacks a trailing `;` (valid — `isStatementless` returns
 * false for it because real SQL tokens survive the strip).
 */
function isStatementless(sql: string): boolean {
  return stripComments(sql).replace(/[;\s]/g, "").length === 0;
}

const TRANSACTION_FOLLOWERS = new Set([
  "transaction",
  "deferred",
  "immediate",
  "exclusive",
]);

/**
 * Returns a reason string if `sql` contains explicit transaction control
 * (`BEGIN [TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE];`, `COMMIT;`, or
 * `ROLLBACK;`) at the top level, or `null` if it's clean.
 *
 * Drizzle wraps every migration in its own transaction. Explicit
 * BEGIN/COMMIT/ROLLBACK in the migration body is both wrong and silently
 * catastrophic for BEGIN: the missing END would leave the depth tracker
 * pinned at 1 forever, suppressing every subsequent `;` count, so the
 * migration sails through `checkStatementBreakpoints` and drizzle then
 * runs only the first statement inside the transaction wrap. Same shape
 * as the bug the breakpoint validator is meant to catch. COMMIT/ROLLBACK
 * are less catastrophic (they'd produce a runtime error from drizzle
 * rather than silently truncate) but still worth catching here so the
 * agent gets a clear, single error pointing at the right fix.
 *
 * Disambiguation: a `BEGIN` whose next significant token is `;` or one
 * of the transaction-mode keywords is transaction control. A `BEGIN`
 * followed by SQL keywords (`UPDATE`, `INSERT`, `SELECT`, ...) is a
 * trigger body and is fine. `COMMIT`/`ROLLBACK` are unambiguous when
 * they appear at the top level (depth == 0) — neither is a valid
 * trigger-body statement, and the word-boundary scan ignores
 * identifiers like `commit_id` or `rollback_count`.
 */
export function findExplicitTransaction(sql: string): string | null {
  const REASON =
    "explicit transaction control (BEGIN/COMMIT/ROLLBACK) inside a migration is not allowed — drizzle wraps every migration in a transaction already. Remove the BEGIN/COMMIT/ROLLBACK and let drizzle handle it.";
  let i = 0;
  let depth = 0;
  let state:
    | "normal"
    | "single"
    | "double"
    | "backtick"
    | "bracket"
    | "line_comment"
    | "block_comment" = "normal";
  let wordStart = -1;
  const n = sql.length;
  const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = sql[i]!;
    if (state === "normal") {
      const ident = isIdent(c);
      if (!ident && wordStart >= 0) {
        const word = sql.substring(wordStart, i).toLowerCase();
        if (word === "begin") {
          if (depth === 0 && isTransactionStartLookahead(sql, i)) {
            return REASON;
          }
          depth++;
        } else if (word === "case") {
          depth++;
        } else if (word === "end" && depth > 0) {
          depth--;
        } else if ((word === "commit" || word === "rollback") && depth === 0) {
          return REASON;
        }
        wordStart = -1;
      }
      if (ident && wordStart < 0) wordStart = i;

      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "backtick";
      else if (c === "[") state = "bracket";
      else if (c === "-" && sql[i + 1] === "-") {
        state = "line_comment";
        i++;
      } else if (c === "/" && sql[i + 1] === "*") {
        state = "block_comment";
        i++;
      }
    } else if (state === "single") {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;
        else state = "normal";
      }
    } else if (state === "double") {
      if (c === '"') {
        if (sql[i + 1] === '"') i++;
        else state = "normal";
      }
    } else if (state === "backtick") {
      if (c === "`") {
        if (sql[i + 1] === "`") i++;
        else state = "normal";
      }
    } else if (state === "bracket") {
      // SQLite `[bracketed]` identifiers have no escape — `]` always closes.
      if (c === "]") state = "normal";
    } else if (state === "line_comment") {
      if (c === "\n") state = "normal";
    } else if (state === "block_comment") {
      if (c === "*" && sql[i + 1] === "/") {
        state = "normal";
        i++;
      }
    }
    i++;
  }

  if (wordStart >= 0) {
    const word = sql.substring(wordStart).toLowerCase();
    if (depth === 0) {
      if (word === "begin" && isTransactionStartLookahead(sql, n)) {
        return REASON;
      }
      if (word === "commit" || word === "rollback") {
        return REASON;
      }
    }
  }
  return null;
}

/**
 * Starting at `from`, skip whitespace and comments and look at the next
 * significant token. Return `true` if it indicates a transaction-control
 * BEGIN: either `;` (bare `BEGIN;`) or a SQLite transaction-mode
 * keyword (`TRANSACTION`/`DEFERRED`/`IMMEDIATE`/`EXCLUSIVE`).
 */
function isTransactionStartLookahead(sql: string, from: number): boolean {
  const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  let i = from;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ";") return true;
    if (isIdent(c)) {
      let j = i;
      while (j < sql.length && isIdent(sql[j]!)) j++;
      const word = sql.substring(i, j).toLowerCase();
      return TRANSACTION_FOLLOWERS.has(word);
    }
    // Anything else (e.g. an SQL operator) — not transaction-control.
    return false;
  }
  // EOF after BEGIN — treat as transaction-style (incomplete migration).
  return true;
}

/**
 * Count `;` characters in `sql` that act as statement terminators at the
 * top level — i.e. not inside string literals, quoted identifiers
 * (double-quote / backtick / bracket), line comments, block comments, or
 * `BEGIN..END` / `CASE..END` blocks.
 *
 * Known limitation:
 * - Explicit `BEGIN [TRANSACTION|...];` / `COMMIT;` / `ROLLBACK;`
 *   transaction control in a migration would confuse the BEGIN/END
 *   depth tracker (no matching `END`). `findExplicitTransaction` catches
 *   this case separately and rejects the migration before the count is
 *   trusted.
 *
 * NOTE(tec27): I wish there were a better way to deal with this without resorting to custom
 * parsing logic. Unfortunately libsql does not seem to expose things in a way we can utilize for
 * this without also running the migrations ourselves :(
 */
export function countTopLevelStatements(sql: string): number {
  let count = 0;
  let depth = 0;
  let i = 0;
  let state:
    | "normal"
    | "single"
    | "double"
    | "backtick"
    | "bracket"
    | "line_comment"
    | "block_comment" = "normal";
  let wordStart = -1;
  const n = sql.length;
  const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = sql[i]!;
    if (state === "normal") {
      const ident = isIdent(c);
      if (!ident && wordStart >= 0) {
        const word = sql.substring(wordStart, i).toLowerCase();
        // Both `BEGIN..END` blocks (trigger bodies) and `CASE..END`
        // expressions terminate with `END`. Track CASE depth too so the
        // inner expression's END doesn't escape the outer block.
        if (word === "begin" || word === "case") depth++;
        else if (word === "end" && depth > 0) depth--;
        wordStart = -1;
      }
      if (ident && wordStart < 0) wordStart = i;

      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "backtick";
      else if (c === "[") state = "bracket";
      else if (c === "-" && sql[i + 1] === "-") {
        state = "line_comment";
        i++;
      } else if (c === "/" && sql[i + 1] === "*") {
        state = "block_comment";
        i++;
      } else if (c === ";" && depth === 0) count++;
    } else if (state === "single") {
      if (c === "'") {
        if (sql[i + 1] === "'") i++; // doubled-quote escape
        else state = "normal";
      }
    } else if (state === "double") {
      if (c === '"') {
        if (sql[i + 1] === '"') i++;
        else state = "normal";
      }
    } else if (state === "backtick") {
      if (c === "`") {
        if (sql[i + 1] === "`") i++;
        else state = "normal";
      }
    } else if (state === "bracket") {
      // SQLite `[bracketed]` identifiers have no escape — `]` always closes.
      if (c === "]") state = "normal";
    } else if (state === "line_comment") {
      if (c === "\n") state = "normal";
    } else if (state === "block_comment") {
      if (c === "*" && sql[i + 1] === "/") {
        state = "normal";
        i++;
      }
    }
    i++;
  }

  if (wordStart >= 0) {
    const word = sql.substring(wordStart).toLowerCase();
    if (word === "begin" || word === "case") depth++;
    else if (word === "end" && depth > 0) depth--;
  }
  return count;
}

/**
 * Split `sql` into individual top-level statements, cutting at each `;` that
 * `countTopLevelStatements` counts (depth 0, outside strings/comments/quoted
 * identifiers and outside `BEGIN..END` / `CASE..END` blocks). Each slice is the
 * verbatim source text for one statement INCLUDING its terminating `;` and any
 * leading whitespace/comments; trailing text after the last `;` (an
 * unterminated statement, or whitespace/comments) is returned as a final slice.
 *
 * Deliberately mirrors the state machine in `countTopLevelStatements` so the
 * cut points are exactly the boundaries the validator counts — this is what
 * makes `normalizeStatementBreakpoints` safe: it only inserts markers where a
 * real top-level statement boundary already exists.
 */
export function splitTopLevelStatements(sql: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  let start = 0;
  let state:
    | "normal"
    | "single"
    | "double"
    | "backtick"
    | "bracket"
    | "line_comment"
    | "block_comment" = "normal";
  let wordStart = -1;
  const n = sql.length;
  const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = sql[i]!;
    if (state === "normal") {
      const ident = isIdent(c);
      if (!ident && wordStart >= 0) {
        const word = sql.substring(wordStart, i).toLowerCase();
        if (word === "begin" || word === "case") depth++;
        else if (word === "end" && depth > 0) depth--;
        wordStart = -1;
      }
      if (ident && wordStart < 0) wordStart = i;

      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "backtick";
      else if (c === "[") state = "bracket";
      else if (c === "-" && sql[i + 1] === "-") {
        state = "line_comment";
        i++;
      } else if (c === "/" && sql[i + 1] === "*") {
        state = "block_comment";
        i++;
      } else if (c === ";" && depth === 0) {
        out.push(sql.slice(start, i + 1));
        start = i + 1;
      }
    } else if (state === "single") {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;
        else state = "normal";
      }
    } else if (state === "double") {
      if (c === '"') {
        if (sql[i + 1] === '"') i++;
        else state = "normal";
      }
    } else if (state === "backtick") {
      if (c === "`") {
        if (sql[i + 1] === "`") i++;
        else state = "normal";
      }
    } else if (state === "bracket") {
      // SQLite `[bracketed]` identifiers have no escape — `]` always closes.
      if (c === "]") state = "normal";
    } else if (state === "line_comment") {
      if (c === "\n") state = "normal";
    } else if (state === "block_comment") {
      if (c === "*" && sql[i + 1] === "/") {
        state = "normal";
        i++;
      }
    }
    i++;
  }
  if (start < n) out.push(sql.slice(start));
  return out;
}

/**
 * Rewrite a hand-written migration so every top-level statement is separated
 * by `--> statement-breakpoint` — the exact shape drizzle's libsql migrator
 * needs. Splits on any existing markers first, re-splits each chunk at real
 * top-level statement boundaries, drops statementless fragments, and rejoins
 * with one marker per boundary. Semantics are preserved (same statements, same
 * order); only the drizzle chunk markers change.
 *
 * NOTE: not safe for files with explicit transaction control — the caller
 * (`migrate-cli.ts`) rejects those via `findExplicitTransaction` BEFORE calling
 * this, because an unmatched `BEGIN` would corrupt the depth tracker.
 */
export function normalizeStatementBreakpoints(content: string): string {
  const statements: string[] = [];
  for (const chunk of content.split("--> statement-breakpoint")) {
    for (const stmt of splitTopLevelStatements(chunk)) {
      if (!isStatementless(stmt)) statements.push(stmt.trim());
    }
  }
  return statements.join("\n--> statement-breakpoint\n") + "\n";
}
