// Plain wording for the request-schema checks an action author left without a
// message. Both worker runtimes pass it to the request parse, where it ranks
// below the schema's own messages, so an authored message always wins and is
// shown exactly as written; only these English defaults name the field.

type Issue = {
  code?: string;
  path?: readonly PropertyKey[];
  input?: unknown;
  origin?: unknown;
  format?: unknown;
  expected?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  inclusive?: unknown;
};

export function requestIssueMessage(i: Issue): string | undefined {
  const message = defaultMessage(i);
  return message === undefined ? undefined : `${fieldLabel(i.path ?? [])}: ${message}`;
}

function fieldLabel(path: readonly PropertyKey[]): string {
  const field = [...path].reverse().find((segment) => typeof segment === "string");
  const words = (field ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.length === 0 ? "This value" : words.charAt(0).toUpperCase() + words.slice(1);
}

function defaultMessage(i: Issue): string | undefined {
  const list = i.origin === "array" || i.origin === "set";
  switch (i.code) {
    case "too_big":
      if (typeof i.maximum !== "number") return undefined;
      if (i.origin === "string") return `Must be ${i.maximum} characters or fewer.`;
      if (list) return `Must have at most ${i.maximum} items.`;
      return `Must be ${i.inclusive === false ? "less than" : "at most"} ${i.maximum}.`;
    case "too_small":
      if (typeof i.minimum !== "number") return undefined;
      if (i.origin === "string") return i.minimum <= 1 ? "Required." : `Must be at least ${i.minimum} characters.`;
      if (list) return `Must have at least ${i.minimum} ${i.minimum === 1 ? "item" : "items"}.`;
      return `Must be ${i.inclusive === false ? "more than" : "at least"} ${i.minimum}.`;
    case "invalid_format":
      if (i.format === "email") return "Must be a valid email address.";
      if (i.format === "url") return "Must be a valid URL.";
      return "Isn't in the expected format.";
    case "invalid_type":
      if (i.input === undefined || i.input === null) return "Required.";
      if (i.expected === "int") return "Must be a whole number.";
      if (i.expected === "number") return "Must be a number.";
      return undefined;
    default:
      return undefined;
  }
}
