// Build-time macro: each action's request fields as form-input attributes, read
// from the schemas the server enforces. Bun inlines the result while bundling
// the client, so the page carries no zod and no copy of any limit.

import { createRequire } from "node:module";
import { join } from "node:path";
import { describeRequest, type RequestFields } from "./client/field-props";

type ActionRequestFields<A> = A extends { request: { shape: infer Shape } }
  ? { readonly [F in keyof Shape]: RequestFields<Shape[F]> }
  : Record<never, never>;

/**
 * Input attributes for each action's request fields, keyed by action name and
 * then field name. An object field nests its fields, and a list field takes
 * the fields of one item: `FIELDS.logWorkout.sets.rpe`.
 */
export type ActionFields<A> = { readonly [K in keyof A]: ActionRequestFields<A[K]> };

/**
 * Must be imported `with { type: "macro" }`; it reads the Space's
 * `server/src/actions.ts`, relative to the client build's working directory
 * (the Space root).
 */
export function actionFields<A>(): ActionFields<A> {
  const actionsPath = join(process.cwd(), "server", "src", "actions.ts");
  const loaded = createRequire(join(process.cwd(), "package.json"))(actionsPath) as {
    Actions?: Record<string, { request?: unknown }>;
  };
  if (loaded.Actions === undefined) {
    throw new Error(`actionFields: ${actionsPath} does not export \`Actions\``);
  }
  const fields: Record<string, unknown> = {};
  for (const [action, definition] of Object.entries(loaded.Actions)) {
    fields[action] = describeRequest(definition.request);
  }
  return fields as ActionFields<A>;
}
