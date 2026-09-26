// Finalize dead-import strip.
//
// Invoked by the daemon AFTER the builder submits a SUCCESSFUL build
// (`spaces_submit_build_result`), i.e. once the builder's edit loop is over — so
// it can never desync an in-flight edit (the write tool's staleness guard) or
// cost the builder a turn. It removes unused imports the relaxed typecheck gate
// (see build.rs `typecheck`) intentionally let through during iteration.
//
// HOW: the TypeScript language service's `organizeImports` in RemoveUnused mode
// — the same engine VS Code uses. Its output is always valid TS, so it can only
// ever remove genuinely-unused import bindings (never corrupt a file, never
// touch code). Removing an unused import is semantically inert (it was already
// tree-shaken from the bundle), so no rebuild is needed and the served bundle is
// unchanged; this only cleans the persisted source a future `modify_space` sees.
//
// Scope: the builder-authored source under `<space>/client/src` and
// `<space>/server/src`. Generated/vendored trees are skipped.
//
// Output: one JSON report on stdout so the daemon can log exactly what was
// removed and whether the strip helped. Best-effort: any failure still exits 0
// with `{"ok":false,...}` so a diagnostic strip never fails a submitted build.

import * as ts from "typescript";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(flag)) return raw.slice(flag.length);
  }
  return undefined;
}

/** Every binding a file's `import` statements introduce (named, default, namespace). */
function importBindings(src: string): string[] {
  const names: string[] = [];
  const re =
    /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)\s*)?(?:\{([^}]*)\})?\s*from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) names.push(m[1]);
    if (m[2]) names.push(m[2]);
    if (m[3]) {
      for (const part of m[3].split(",")) {
        const n = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (n) names.push(n);
      }
    }
  }
  return names;
}

interface FileResult {
  file: string; // space-relative
  removed: string[];
}

interface PruneReport {
  ok: boolean;
  files_scanned: number;
  files_changed: number;
  imports_removed_total: number;
  results: FileResult[];
  duration_ms: number;
  error?: string;
}

function organizeProject(
  spaceDir: string,
  project: string,
  results: FileResult[],
): number {
  let scanned = 0;
  const tsconfigPath = join(spaceDir, project, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return scanned;

  const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (cfg.error) return scanned;
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    join(spaceDir, project),
  );
  const files = parsed.fileNames;
  const versions = new Map<string, number>();

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(f, "utf8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => join(spaceDir, project),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  // Preserve tidy formatting when a chunk of an import survives.
  const fmt: ts.FormatCodeSettings = { insertSpaceAfterCommaDelimiter: true };

  // Only rewrite the builder-authored source physically under this project's
  // src/ — never the shared files a client tsconfig pulls in from server/, and
  // never generated/vendored trees.
  const ownedPrefix = join(spaceDir, project, "src") + "/";
  for (const f of files) {
    if (!f.startsWith(ownedPrefix)) continue;
    if (f.includes("/node_modules/") || f.includes("/.generated/") || f.includes("/dist/")) continue;
    scanned++;

    let before: string;
    try {
      before = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const changes = ls.organizeImports(
      { type: "file", fileName: f, mode: ts.OrganizeImportsMode.RemoveUnused },
      fmt,
      {},
    );
    const fc = changes.find((c) => c.fileName === f);
    if (!fc || fc.textChanges.length === 0) continue;

    let after = before;
    for (const e of [...fc.textChanges].sort((a, b) => b.span.start - a.span.start)) {
      after = after.slice(0, e.span.start) + e.newText + after.slice(e.span.start + e.span.length);
    }
    if (after === before) continue;

    const beforeNames = importBindings(before);
    const afterNames = new Set(importBindings(after));
    // multiset diff: names present before and now gone
    const removed: string[] = [];
    const seen = new Map<string, number>();
    for (const n of importBindings(after)) seen.set(n, (seen.get(n) ?? 0) + 1);
    const afterCount = new Map(seen);
    for (const n of beforeNames) {
      const c = afterCount.get(n) ?? 0;
      if (c > 0) afterCount.set(n, c - 1);
      else removed.push(n);
    }
    void afterNames;

    writeFileSync(f, after, "utf8");
    results.push({ file: f.slice(spaceDir.length + 1), removed });
  }
  return scanned;
}

function main(): void {
  const start = Date.now();
  const spaceDir = arg("space-dir");
  const report: PruneReport = {
    ok: true,
    files_scanned: 0,
    files_changed: 0,
    imports_removed_total: 0,
    results: [],
    duration_ms: 0,
  };
  try {
    if (!spaceDir) {
      report.ok = false;
      report.error = "missing --space-dir";
    } else {
      for (const project of ["client", "server"]) {
        report.files_scanned += organizeProject(spaceDir, project, report.results);
      }
      report.files_changed = report.results.length;
      report.imports_removed_total = report.results.reduce((n, r) => n + r.removed.length, 0);
    }
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.message : String(err);
  }
  report.duration_ms = Date.now() - start;
  // The report rides stdout; the daemon-side caller logs it when the strip
  // removed anything.
  process.stdout.write(JSON.stringify(report) + "\n");
  // Best-effort: never fail the submitted build over a diagnostic strip.
  process.exit(0);
}

main();
