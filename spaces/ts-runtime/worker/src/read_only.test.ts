import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";

import { openReadOnlyClient } from "./db";
import { ViewOnlyError, isReadOnlyRefusal, readOnlyClient } from "./read_only";

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const dirs: string[] = [];
const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ writer: Client; reader: Client }> {
  const dir = mkdtempSync(join(tmpdir(), "space-read-only-"));
  dirs.push(dir);
  const path = join(dir, "app.db");
  const writer = createClient({ url: `file:${path}` });
  await writer.execute("PRAGMA journal_mode = WAL");
  await writer.execute("CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT)");
  await writer.execute({ sql: "INSERT INTO songs (title) VALUES (?)", args: ["Choir"] });
  const raw = await openReadOnlyClient(path);
  clients.push(writer, raw);
  return { writer, reader: readOnlyClient(raw) };
}

async function count(writer: Client): Promise<number> {
  return Number((await writer.execute("SELECT count(*) AS n FROM songs")).rows[0]?.n);
}

describe("a view grantee's action", () => {

  test("can't write, turn query_only off, or run a script or transaction", async () => {
    const { writer, reader } = await fixture();
    for (const statement of [
      "INSERT INTO songs (title) VALUES ('x')",
      "UPDATE songs SET title = 'x'",
      "DELETE FROM songs",
      "WITH gone AS (SELECT 1) DELETE FROM songs",
      "PRAGMA query_only = OFF",
      "/* hi */ PRAGMA query_only = 0",
      "ATTACH DATABASE ':memory:' AS other",
      "SELECT 1; DELETE FROM songs",
      "VACUUM",
    ]) {
      await expect(reader.execute(statement)).rejects.toBeInstanceOf(ViewOnlyError);
    }
    await expect(reader.batch(["SELECT 1", "DELETE FROM songs"])).rejects.toBeInstanceOf(ViewOnlyError);
    await expect(reader.transaction("read")).rejects.toBeInstanceOf(ViewOnlyError);
    await expect(reader.executeMultiple("DELETE FROM songs")).rejects.toBeInstanceOf(ViewOnlyError);
    await expect(reader.migrate([])).rejects.toBeInstanceOf(ViewOnlyError);
    expect(isReadOnlyRefusal(await rejection(drizzle(reader).run(sql`DELETE FROM songs`)))).toBe(true);
    expect(await count(writer)).toBe(1);
    expect((await reader.execute("SELECT count(*) AS n FROM songs")).rows[0]?.n).toBe(1);
  });

  test("SQLite itself refuses a write on the read-only connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "space-read-only-"));
    dirs.push(dir);
    const path = join(dir, "app.db");
    const writer = createClient({ url: `file:${path}` });
    await writer.execute("CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT)");
    const raw = await openReadOnlyClient(path);
    clients.push(writer, raw);
    expect(isReadOnlyRefusal(await rejection(raw.execute("INSERT INTO songs (title) VALUES ('x')")))).toBe(true);
    expect(await count(writer)).toBe(0);
  });
});
