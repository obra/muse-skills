// Turns a request-schema rejection into one readable line per field. The VM
// worker sends `{ error: "invalid args: <Zod issues JSON>" }`; a shared
// Cloudflare app sends `{ error, issues }`.

/** One request field the action's schema rejected, with the schema's message. */
export type SpaceActionIssue = {
  readonly path: readonly string[];
  readonly message: string;
};

const INVALID_ARGS_PREFIX = "invalid args: ";

type RawIssue = Record<string, unknown>;

export function requestSchemaIssues(body: unknown): SpaceActionIssue[] {
  if (body === null || typeof body !== "object") {
    return [];
  }
  let raw: unknown = "issues" in body ? body.issues : undefined;
  const error = "error" in body ? body.error : undefined;
  if (raw === undefined && typeof error === "string" && error.startsWith(INVALID_ARGS_PREFIX)) {
    try {
      raw = JSON.parse(error.slice(INVALID_ARGS_PREFIX.length));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((issue): issue is RawIssue => issue !== null && typeof issue === "object")
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.map(String) : [];
      return { path, message: describeIssue(issue) };
    });
}

/** The issues' messages, each said once: list items repeat the same rule. */
export function requestSchemaMessage(issues: readonly SpaceActionIssue[]): string {
  // Joined on new lines so messages without end punctuation stay separate, in any language.
  return [...new Set(issues.map((issue) => issue.message))].join("\n");
}

/** The schema's message exactly as written: the runtime's English defaults already name the field. */
function describeIssue(issue: RawIssue): string {
  const message = typeof issue.message === "string" ? issue.message.trim() : "";
  return message.length === 0 ? "This value is invalid." : message;
}
