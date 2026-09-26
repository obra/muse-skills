// Actions for this artifact. One file, one exported `Actions` map.
//
// Each action has a zod Request/Response schema and a handler. The handler
// receives a typed `ctx` (see `@hatch/space-sdk`) with:
//   ctx.db<typeof schema>()  — drizzle-orm DB instance, typed by your schema
//   ctx.agent.send           — Muse agent handoff for research, web search,
//                             tool use, or multi-step investigation
//   ctx.inference            — direct model-only inference for bounded
//                             transformations: extraction, classification,
//                             summarization, formatting, JSON generation
//   ctx.blobs                — placeholder blob storage API for action-owned
//                             binary data (put/getUrl/delete/head/list)
//   ctx.emit                 — streaming responses (defineStreamingAction only)
//   ctx.invalidateQueries    — notify all clients to refetch data after writes
//
// `satisfies ActionsModule` enforces that every value in `Actions` is a real
// action (not a stray helper) without widening the type — call-site typing
// on the client stays precise per-action.
//
// The client picks up types from this file via
// `import type { Actions } from "../../server/src/actions"`.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { desc } from "drizzle-orm";
import * as schema from "./schema";

export const Actions = {
  listEntries: defineAction({
    request: z.object({
      limit: z.number().int().positive().max(100).default(20),
    }),
    response: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          text: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.entries)
        .orderBy(desc(schema.entries.id))
        .limit(args.limit);
      return {
        entries: rows.map((row) => ({
          id: row.id,
          text: row.text,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  }),

  addEntry: defineAction({
    request: z.object({ text: z.string().min(1) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.entries)
        .values({ text: args.text })
        .returning({ id: schema.entries.id });
      const inserted = result[0];
      if (!inserted) {
        throw new Error("addEntry: insert returned no rows");
      }
      // Notify all clients to refetch after this write.
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),
} satisfies ActionsModule;
