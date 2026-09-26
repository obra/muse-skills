// Drizzle schema for this space.
//
// This file declares the typed shape of your tables — the runtime view
// your action handlers query against. The SQL files under drizzle/ are
// the operations that, applied in order at build time, land app.db at
// that shape. Migrations are not auto-generated from this file (rename
// vs drop-and-create is ambiguous, and we keep migration semantics
// explicit), so when you change the schema you also write the
// corresponding SQL in a new migration.
//
// Workflow when adding a column:
//   1. Add the column here.
//   2. Call the `web_artifact_new_migration` tool with `name: "add <thing>"`.
//   3. Edit the resulting drizzle/<NNNN>_*.sql with the ALTER TABLE that
//      lands app.db at the new shape. Multiple statements in one file?
//      Separate them with the literal drizzle marker on its own line.
//      The new file is empty; you write the SQL straight in.
//   4. Call the `web_artifact_build` tool to apply the migration and rebuild.
//
// See https://orm.drizzle.team/docs/sql-schema-declaration for column types.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
