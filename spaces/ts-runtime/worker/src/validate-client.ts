// Pre-validation for space client/src code.
//
// Runs domain-specific lint rules against a space's client source before
// typecheck so the agent gets actionable error messages instead of cascading
// tsc noise. Each rule is a small pure function returning either `null` or
// a reason string; `checkClientSource` runs them in order and surfaces the
// first violation.
//
// Style/scope mirrors `validate-migrations.ts`: hand-rolled scanner over
// comment-/string-stripped source, no TS compiler API at runtime, single
// canonical reason string per violation. Add new rules as additional
// passes on the stripped source.
//
// Known limitations:
// - The import scan runs against a comments-only-stripped copy so real
//   module specifiers (`from "@tanstack/react-query"`) survive. A source
//   file containing the literal text of a forbidden import inside a
//   string/template literal will false-positive. Vanishingly rare in real
//   space code; the tradeoff is the only sane way to keep the scanner
//   small enough to read in one sitting.

export const REASON_QUERY_CLIENT_IMPORT =
  'value-importing `QueryClient` from "@tanstack/react-query" is not allowed in web artifact client code. ' +
  'Use the SDK\'s shared instance: `import { spaceQueryClient } from "@hatch/space-sdk/client"`. ' +
  "QueryClient defaults (cache lifetime, retry policy, refetch behavior) are tuned in the SDK so they stay consistent across every web artifact.";

export const REASON_QUERY_CLIENT_STAR_IMPORT =
  'star-importing "@tanstack/react-query" is not allowed because it exposes `QueryClient` via the namespace. ' +
  "Import the named hooks/components you actually need (e.g. `useQuery`, `useMutation`, `QueryClientProvider`).";

export const REASON_QUERY_CLIENT_NEW =
  "constructing a new `QueryClient(...)` in web artifact client code is not allowed. " +
  'Use the SDK\'s shared instance: `import { spaceQueryClient } from "@hatch/space-sdk/client"`.';

export const REASON_FROM_CHAR_CODE_SPREAD =
  "spreading a byte array into `String.fromCharCode(...)` is not allowed in web artifact client code: " +
  "it throws `RangeError: Maximum call stack size exceeded` on multi-megabyte inputs (any phone photo). " +
  "Encode binary data with the SDK instead: " +
  '`import { fileToBase64, bytesToBase64 } from "@hatch/space-sdk/client"`.';

/**
 * Returns `null` if the source is clean, or a human-readable reason string
 * explaining the first violation found.
 */
export function checkClientSource(content: string): string | null {
  // The import scan needs to see real string-literal module specifiers
  // (`from "@tanstack/react-query"`) so we strip comments only. The
  // construction scan operates on a more aggressive copy with string
  // literals also blanked so a literal "new QueryClient(" inside a string
  // doesn't trip it.
  const commentsStripped = stripComments(content);
  const importViolation = findForbiddenQueryClientImport(commentsStripped);
  if (importViolation !== null) return importViolation;
  const fullyStripped = stripCommentsAndStrings(content);
  const newViolation = findForbiddenQueryClientConstruction(fullyStripped);
  if (newViolation !== null) return newViolation;
  const spreadViolation = findForbiddenFromCharCodeSpread(fullyStripped);
  if (spreadViolation !== null) return spreadViolation;
  return null;
}

/**
 * Replace line and block comments with spaces (preserving newlines), and
 * leave string/template literals intact. Used for the import scan, which
 * needs to match real `from "@tanstack/react-query"` specifiers.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      out.push("  ");
      i += 2;
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Replace string literals (single, double, template) and comments (line,
 * block) with spaces of equal length, preserving newlines and overall
 * offsets. The output is no longer valid TS but is safe to substring/regex
 * scan for top-level keywords without false positives from string content.
 *
 * Template-literal `${...}` substitutions are walked recursively so code
 * inside them remains intact for the outer scan (we want to flag a
 * `new QueryClient(` even if it's defensively wrapped in `${...}`).
 */
function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      // line comment
      out.push("  ");
      i += 2;
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      // block comment
      out.push("  ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out.push(" ");
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "`") {
      // template literal — walk to matching backtick, recursing through ${...}
      out.push(" ");
      i++;
      let depth = 0;
      while (i < n) {
        const ch = source[i]!;
        if (depth === 0 && ch === "`") break;
        if (ch === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (ch === "$" && source[i + 1] === "{") {
          depth++;
          out.push("${");
          i += 2;
          continue;
        }
        if (depth > 0 && ch === "}") {
          depth--;
          out.push("}");
          i++;
          continue;
        }
        if (depth > 0) {
          // inside ${...} — preserve so the outer scan still sees the code
          out.push(ch);
          i++;
          continue;
        }
        out.push(ch === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push(" ");
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Look for `import` statements whose module specifier is exactly
 * `@tanstack/react-query` and inspect the named-imports list (or detect a
 * star import). Returns a violation reason if the import smuggles in the
 * `QueryClient` constructor; allows `import type`, allows `QueryClient`
 * inside an `import { type QueryClient, ... }` mixed-syntax form.
 */
function findForbiddenQueryClientImport(stripped: string): string | null {
  // Two regex shapes we care about:
  //   1. star import:  import * as X from "@tanstack/react-query"
  //   2. named import: import [type] { ... } from "@tanstack/react-query"
  // Default imports don't apply (react-query has no default export).
  // The named-imports group `[^}]*` is multiline because `[^}]` matches
  // newlines without the `s` flag.
  const importStatement =
    /\bimport\s+(?:(type)\s+)?(?:\*\s+as\s+\w+|\{([^}]*)\}|\w+(?:\s*,\s*\{([^}]*)\})?)\s+from\s+["']@tanstack\/react-query["']/g;
  let match: RegExpExecArray | null;
  while ((match = importStatement.exec(stripped)) !== null) {
    const fullMatch = match[0];
    const isTypeOnly = match[1] !== undefined;
    if (isTypeOnly) continue;
    if (/\*\s+as\s+\w+/.test(fullMatch)) {
      return REASON_QUERY_CLIENT_STAR_IMPORT;
    }
    const namedGroup = match[2] ?? match[3];
    if (namedGroup === undefined) continue;
    if (importsValueQueryClient(namedGroup)) {
      return REASON_QUERY_CLIENT_IMPORT;
    }
  }
  return null;
}

function importsValueQueryClient(namedImportList: string): boolean {
  // Split by comma; per-entry, check for `QueryClient` (optionally renamed
  // via `as`), excluding `type QueryClient` (type-only inline syntax).
  for (const raw of namedImportList.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    // `type QueryClient` or `type QueryClient as Foo` — type-only, allowed.
    if (/^type\s+/.test(entry)) continue;
    // `QueryClient` or `QueryClient as Foo`
    const baseName = entry.split(/\s+as\s+/)[0]!.trim();
    if (baseName === "QueryClient") return true;
  }
  return false;
}

/**
 * Defensive scan for `new QueryClient(` after the import-side gate. If the
 * import scan caught the import we'll never reach a successful construction
 * call, but a typo'd or aliased path can still mention this exact name; the
 * second pass surfaces a clearer error than letting it ride to runtime.
 */
function findForbiddenQueryClientConstruction(stripped: string): string | null {
  if (/\bnew\s+QueryClient\s*\(/.test(stripped)) {
    return REASON_QUERY_CLIENT_NEW;
  }
  return null;
}

/**
 * Hand-rolled base64 encodes spread the whole byte array into
 * `String.fromCharCode(...)`, which passes every byte as a separate call
 * argument and overflows on multi-megabyte inputs. The SDK ships
 * `fileToBase64`/`bytesToBase64` precisely so generated code never writes
 * this; the scan targets the spread form only, so small fixed-arity
 * `String.fromCharCode(a, b)` calls stay legal.
 */
function findForbiddenFromCharCodeSpread(stripped: string): string | null {
  if (/\bString\s*\.\s*fromCharCode\s*\(\s*\.\.\./.test(stripped)) {
    return REASON_FROM_CHAR_CODE_SPREAD;
  }
  return null;
}
