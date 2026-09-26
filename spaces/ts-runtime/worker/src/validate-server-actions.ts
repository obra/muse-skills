import { existsSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

export const REASON_IMPORT_PRIVILEGED_IMPLEMENTATION =
  "web artifact action code must not import `server/src/privileged.ts`. " +
  "Import descriptors from `@space/privileged` and call `ctx.executePrivileged(...)` instead.";

export const REASON_HOST_MODULE_IMPORT =
  "web artifact action code must not import Node/Bun host modules. " +
  "Move host-only behavior into `server/src/privileged.ts` and expose it through a typed privileged function.";

export const REASON_PROCESS_GLOBAL =
  "web artifact action code must not read the `process` global. " +
  "Use the fixed ctx API, or move host-only behavior into a privileged function.";

export const REASON_BUN_GLOBAL =
  "web artifact action code must not read the `Bun` global. " +
  "Use the fixed ctx API, or move host-only behavior into a privileged function.";

export const REASON_REQUIRE_CALL =
  "web artifact action code must not call `require(...)`. " +
  "Use static portable imports, or move host-only behavior into a privileged function.";

export const REASON_DYNAMIC_IMPORT =
  "web artifact action code must not call dynamic `import(...)`. " +
  "Use static portable imports so the build can validate portability.";

export const REASON_SUBPROCESS_API =
  "web artifact action code must not use subprocess APIs. " +
  "Move subprocess or host-command behavior into `server/src/privileged.ts`.";

export const REASON_EVAL_API =
  "web artifact action code must not use eval-like dynamic code execution.";

const HOST_MODULES = new Set([
  "bun",
  "bun:ffi",
  "bun:jsc",
  "child_process",
  "cluster",
  "crypto",
  "dns",
  "fs",
  "fs/promises",
  "module",
  "net",
  "node:child_process",
  "node:cluster",
  "node:crypto",
  "node:dns",
  "node:fs",
  "node:fs/promises",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:process",
  "node:readline",
  "node:stream",
  "node:tls",
  "node:url",
  "node:util",
  "node:vm",
  "node:worker_threads",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "tls",
  "url",
  "util",
  "vm",
  "worker_threads",
]);

export interface ServerActionViolation {
  readonly filePath: string;
  readonly reason: string;
}

interface ImportReference {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export async function checkServerActionGraphAsync(
  serverDir: string,
): Promise<ServerActionViolation | null> {
  const root = resolve(serverDir);
  const entry = join(root, "src", "actions.ts");
  if (!existsSync(entry)) {
    return null;
  }

  const stack = [entry];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const filePath = stack.pop()!;
    const canonical = resolve(filePath);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);

    const content = await Bun.file(canonical).text();
    const sourceViolation = checkServerActionSource(content);
    if (sourceViolation !== null) {
      return { filePath: canonical, reason: sourceViolation };
    }

    for (const ref of collectImportReferences(stripComments(content))) {
      if (isHostModuleSpecifier(ref.specifier)) {
        return { filePath: canonical, reason: REASON_HOST_MODULE_IMPORT };
      }
      if (ref.typeOnly) {
        continue;
      }
      if (!isRelativeSpecifier(ref.specifier)) {
        continue;
      }
      const target = resolveImport(canonical, ref.specifier);
      if (target === null) {
        continue;
      }
      if (!isWithin(root, target)) {
        continue;
      }
      if (isPrivilegedImplementationPath(target)) {
        return {
          filePath: canonical,
          reason: REASON_IMPORT_PRIVILEGED_IMPLEMENTATION,
        };
      }
      stack.push(target);
    }
  }
  return null;
}

export interface ServerActionsShape {
  /// True only when the entry actions module is *provably* a no-op: it declares
  /// zero server actions and performs no side effects when imported/executed.
  /// This is the only shape allowed to be served client-only and shared to
  /// Cloudflare. Anything we cannot prove inert reports `false` (server-backed),
  /// which is the safe direction: it runs a local worker and is not
  /// Cloudflare-shareable.
  readonly clientOnly: boolean;
  /// Diagnostic for why the module was treated as server-backed; null when
  /// `clientOnly` is true.
  readonly reason: string | null;
}

// `<ident-or-close>(` — any function/constructor call. An inert client-only
// module performs none (no `fetch()`, no IIFE, no `Object.freeze({})`, no
// `defineAction(...)`).
const CALL_EXPRESSION = /[A-Za-z0-9_$)\]]\s*\(/;
// Top-level statements that run code on import.
const EXECUTABLE_KEYWORD = /\b(throw|await|delete|yield|for|while|if|switch|do|new)\b/;
// The canonical empty actions export: `export const Actions = {} satisfies X;`
// (optional type annotation, optional `satisfies`, optional trailing `;`).
const EMPTY_ACTIONS_EXPORT =
  /\bexport\s+const\s+Actions\s*(?::\s*[^=;]+)?=\s*\{\s*\}\s*(?:satisfies\s+[^;]+)?;?/;

/// Classify the entry `server/src/actions.ts` source as a client-only (inert,
/// zero-action) module or a server-backed one. Fail-safe by construction: only
/// the minimal canonical empty module is reported client-only; any value
/// import, function call, tagged template, control-flow keyword, or non-empty
/// `Actions` literal reports server-backed. This proof runs WITHOUT executing
/// the module, so a side-effecting module is never run to classify it.
export function analyzeServerActionsShape(content: string): ServerActionsShape {
  const stripped = stripCommentsAndStrings(content);
  if (!EMPTY_ACTIONS_EXPORT.test(stripped)) {
    return { clientOnly: false, reason: "module exports server actions" };
  }
  for (const ref of collectImportReferences(stripComments(content))) {
    if (!ref.typeOnly) {
      return {
        clientOnly: false,
        reason: "module imports runtime (value) modules",
      };
    }
  }
  // Template literals are blanked by `stripCommentsAndStrings`, so a tagged
  // template call would slip past CALL_EXPRESSION; reject any backtick instead.
  if (/`/.test(stripComments(content))) {
    return { clientOnly: false, reason: "module uses template literals" };
  }
  if (CALL_EXPRESSION.test(stripped)) {
    return { clientOnly: false, reason: "module contains a function call" };
  }
  if (EXECUTABLE_KEYWORD.test(stripped)) {
    return {
      clientOnly: false,
      reason: "module contains top-level executable statements",
    };
  }
  return { clientOnly: true, reason: null };
}

export function checkServerActionSource(content: string): string | null {
  const stripped = stripCommentsAndStrings(content);
  if (/\bprocess\b/.test(stripped)) {
    return REASON_PROCESS_GLOBAL;
  }
  if (/\bBun\b/.test(stripped)) {
    return REASON_BUN_GLOBAL;
  }
  if (/\brequire\s*\(/.test(stripped)) {
    return REASON_REQUIRE_CALL;
  }
  if (/\bimport\s*\(/.test(stripped)) {
    return REASON_DYNAMIC_IMPORT;
  }
  if (
    /\b(spawn|spawnSync|exec|execFile|execFileSync|execSync)\s*\(/.test(
      stripped,
    )
  ) {
    return REASON_SUBPROCESS_API;
  }
  if (/\b(eval|Function)\s*\(/.test(stripped)) {
    return REASON_EVAL_API;
  }
  return null;
}

function collectImportReferences(source: string): ImportReference[] {
  const refs: ImportReference[] = [];
  const importFrom =
    /\bimport\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importFrom.exec(source)) !== null) {
    refs.push({
      specifier: match[2]!,
      typeOnly: match[1] !== undefined,
    });
  }

  const exportFrom =
    /\bexport\s+(type\s+)?(?:[^'";]*?\s+from\s+)["']([^"']+)["']/g;
  while ((match = exportFrom.exec(source)) !== null) {
    refs.push({
      specifier: match[2]!,
      typeOnly: match[1] !== undefined,
    });
  }
  return refs;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isHostModuleSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    HOST_MODULES.has(specifier)
  );
}

function isPrivilegedImplementationPath(path: string): boolean {
  const normalized = normalize(path);
  return basename(normalized) === "privileged.ts";
}

function resolveImport(importerPath: string, specifier: string): string | null {
  const base = resolve(dirname(importerPath), specifier);
  const candidates = [];
  if (extname(base) !== "") {
    candidates.push(base);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"));
  }
  for (const candidate of candidates) {
    try {
      const stats = statSync(candidate);
      if (stats.isFile()) {
        return resolve(candidate);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

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

function stripCommentsAndStrings(source: string): string {
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
