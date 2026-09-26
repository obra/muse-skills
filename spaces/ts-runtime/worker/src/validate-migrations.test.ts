import { describe, expect, test } from "bun:test";

import {
  checkStatementBreakpoints,
  countTopLevelStatements,
  normalizeStatementBreakpoints,
} from "./validate-migrations";

// One case per distinct silent-data-loss class in the SQL lexer/validator.
// Enumerated quote/keyword/whitespace siblings are deliberately collapsed to
// the minimal distinguishing subset.

describe("countTopLevelStatements", () => {
  test("doubled-quote escape inside string", () => {
    // 'it''s; a string;' is one literal containing semicolons. A misread
    // quoted `;` over-splits, and normalize then inserts a breakpoint inside
    // the statement, corrupting the migration.
    const sql = "INSERT INTO t VALUES ('it''s; a string;');";
    expect(countTopLevelStatements(sql)).toBe(1);
  });

  test("semicolons inside line comments are ignored", () => {
    const sql = "-- this; is; a; comment\nCREATE TABLE a (id INTEGER);";
    expect(countTopLevelStatements(sql)).toBe(1);
  });

  test("identifiers containing 'begin' substring don't open depth", () => {
    // `beginning` is not the keyword `begin`; a substring match opens a
    // phantom block that swallows the boundary between real statements.
    const sql = "INSERT INTO log VALUES ('beginning'); INSERT INTO log VALUES ('ending');";
    expect(countTopLevelStatements(sql)).toBe(2);
  });

  test("CASE..END inside trigger body doesn't escape BEGIN..END depth", () => {
    // Regression: `END` terminates both `BEGIN..END` blocks and `CASE..END`
    // expressions. If the validator only tracks BEGIN, the inner `CASE`'s
    // `END` decrements depth to 0 and the trigger body's `;`s leak out as
    // top-level statements.
    const sql = `CREATE TRIGGER t AFTER INSERT ON x BEGIN
        UPDATE t SET col = CASE WHEN NEW.id > 0 THEN 1 ELSE 2 END;
        INSERT INTO log VALUES (1);
      END;`;
    expect(countTopLevelStatements(sql)).toBe(1);
  });
});

describe("checkStatementBreakpoints", () => {
  test("multiple statements with breakpoint between is fine", () => {
    const sql = `CREATE TABLE a (id INTEGER);
--> statement-breakpoint
CREATE TABLE b (id INTEGER);`;
    expect(checkStatementBreakpoints(sql)).toBeNull();
  });

  test("multiple statements without breakpoint fails", () => {
    // The core loss: drizzle runs only the first statement of a
    // multi-statement chunk and still records the migration as applied.
    const sql = `CREATE TABLE a (id INTEGER);
CREATE TABLE b (id INTEGER);`;
    expect(checkStatementBreakpoints(sql)).toMatch(
      /found 2 .*statements in a single chunk/,
    );
  });

  test("trigger with internal semicolons does not need a breakpoint", () => {
    const sql = `CREATE TRIGGER t AFTER INSERT ON x
BEGIN
  UPDATE x SET id = NEW.id;
  INSERT INTO log VALUES (1);
END;`;
    expect(checkStatementBreakpoints(sql)).toBeNull();
  });

  test("explicit BEGIN/COMMIT transaction in a migration is rejected", () => {
    // Same silent-failure shape the validator is meant to catch: BEGIN
    // increments depth, no matching END, all subsequent ;s get suppressed,
    // validator returns null, drizzle then runs only the first statement
    // inside the transaction wrap.
    const sql = `BEGIN;
      CREATE TABLE a (id INTEGER);
      CREATE TABLE b (id INTEGER);
      COMMIT;`;
    expect(checkStatementBreakpoints(sql)).toMatch(/BEGIN|transaction/i);
  });

  test("top-level COMMIT is rejected", () => {
    // Even without a preceding BEGIN in this chunk, a stray COMMIT;
    // tries to close drizzle's wrapping transaction and produces a
    // confusing runtime error. The validator's contract names it.
    const sql = `CREATE TABLE a (id INTEGER);
--> statement-breakpoint
COMMIT;`;
    expect(checkStatementBreakpoints(sql)).toMatch(/COMMIT|transaction/i);
  });

  test("trailing breakpoint (the historical template shape) is rejected", () => {
    // libsql runs the empty final chunk and throws `SQLITE_OK: not an
    // error`. This is the exact pattern the scaffold template shipped.
    const sql = `CREATE TABLE a (id INTEGER);
--> statement-breakpoint
`;
    expect(checkStatementBreakpoints(sql)).toMatch(/empty chunk|SQLITE_OK/);
  });

  test("bare-semicolon chunk after a breakpoint is rejected", () => {
    // `;` alone is one `;`-terminated statement to the counter but an
    // empty statement to libsql -> `SQLITE_OK: not an error`.
    const sql = `CREATE TABLE a (id INTEGER);
--> statement-breakpoint
;
`;
    expect(checkStatementBreakpoints(sql)).toMatch(/no executable statement|SQLITE_OK/);
  });
});

describe("normalizeStatementBreakpoints", () => {
  const safe = (sql: string) =>
    expect(checkStatementBreakpoints(normalizeStatementBreakpoints(sql))).toBeNull();

  test("multi-statement chunk becomes drizzle-safe", () => {
    const broken =
      "CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);\nCREATE TABLE c (id INTEGER);";
    // originally rejected...
    expect(checkStatementBreakpoints(broken)).not.toBeNull();
    // ...normalized is accepted, with the right number of chunks.
    const out = normalizeStatementBreakpoints(broken);
    expect(out.split("--> statement-breakpoint").length).toBe(3);
    safe(broken);
  });

  test("preserves a trigger with internal semicolons as one chunk", () => {
    // The normalize-side loss class: inserting a breakpoint inside a
    // statement body splits a valid trigger into broken fragments that
    // drizzle then applies incompletely.
    const sql =
      "CREATE TABLE a (id INTEGER);\nCREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x=1; END;";
    const out = normalizeStatementBreakpoints(sql);
    expect(out.split("--> statement-breakpoint").length).toBe(2);
    safe(sql);
  });
});

describe("quoted identifiers (backtick / bracket)", () => {
  // Regression guard: SQLite also quotes identifiers with backticks and
  // brackets. These must be skipped exactly like `'…'`/`"…"` so a `;` or a
  // keyword (case/begin/end) appearing only *inside* a quoted identifier is
  // never read as real SQL. Missing this let a table named `case` open a
  // phantom CASE..END block that hid the `;` between two statements, merging
  // them into one chunk that normalize kept and drizzle then applied
  // incompletely while still recording the migration as applied.

  test("backtick `case` identifier does not open a phantom CASE block", () => {
    const sql = "CREATE TABLE `case` (id INTEGER);\nCREATE TABLE b (id INTEGER);";
    // Both statements stay visible (not merged into one) ...
    expect(countTopLevelStatements(sql)).toBe(2);
    // ... so it's correctly flagged multi-statement, not silently "safe" ...
    expect(checkStatementBreakpoints(sql)).not.toBeNull();
    // ... and normalized into two safe chunks rather than an incomplete merge.
    const out = normalizeStatementBreakpoints(sql);
    expect(out.split("--> statement-breakpoint").length).toBe(2);
    expect(checkStatementBreakpoints(out)).toBeNull();
  });
});
