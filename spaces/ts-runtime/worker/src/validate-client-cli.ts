// Client source validator CLI — invoked by the daemon-side build pipeline
// (`web_artifact_build` tool) before the client typecheck so domain-specific
// violation reasons reach the agent before tsc's wall of consequence
// errors.
//
// Bundle build emits this as `dist/validate-client.js` next to `worker.js`;
// the build pipeline shells out to:
//
//   bun run validate-client.js --client-dir=<path>
//
// On success: writes `{"ok":true,"files":<N>}` to stdout, exits 0.
// On violation: writes the first violation reason (with file path) to
// stderr, exits 1.
// On argument error or I/O failure: exits 2.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { checkClientSource } from "./validate-client";

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(flag)) {
      return raw.slice(flag.length);
    }
  }
  return undefined;
}

const clientDir = arg("client-dir");
if (!clientDir) {
  process.stderr.write("usage: validate-client.js --client-dir=<path>\n");
  process.exit(2);
}

async function isNotFound(err: unknown): Promise<boolean> {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/**
 * Walk `dir` recursively, yielding paths to `.ts` and `.tsx` files. Skips
 * `node_modules/` and `dist/` (build output that we don't author, and that
 * could contain our own forbidden patterns from external libraries).
 */
async function* walkTsSources(dir: string): AsyncIterableIterator<string> {
  let entries: Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (await isNotFound(err)) return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsSources(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      yield full;
    }
  }
}

async function main(): Promise<number> {
  try {
    const dirStat = await stat(clientDir!).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      // Nothing to validate. Spaces without a client/src tree are valid (the
      // scaffold always ships one, but an in-progress space might not).
      process.stdout.write(JSON.stringify({ ok: true, files: 0 }) + "\n");
      return 0;
    }
    let scanned = 0;
    for await (const filePath of walkTsSources(clientDir!)) {
      const content = await readFile(filePath, "utf8");
      const reason = checkClientSource(content);
      if (reason !== null) {
        const rel = relative(clientDir!, filePath);
        process.stderr.write(`${rel}: ${reason}\n`);
        return 1;
      }
      scanned++;
    }
    process.stdout.write(JSON.stringify({ ok: true, files: scanned }) + "\n");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`validate-client fatal: ${message}\n`);
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`validate-client fatal: ${String(err)}\n`);
    process.exit(2);
  },
);
