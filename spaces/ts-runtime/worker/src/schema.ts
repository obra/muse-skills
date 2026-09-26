import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: unknown): JsonSchema | undefined {
  try {
    return z.toJSONSchema(schema as z.ZodType, {
      io: "input",
      unrepresentable: "any",
    }) as JsonSchema;
  } catch {
    return undefined;
  }
}
