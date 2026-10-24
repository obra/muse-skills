#!/usr/bin/env bun
// Build the @hatch/space-sdk tarball, the bun worker entrypoint, and the
// drizzle migrator runner.
//
// Invoked by:
//   - Developers locally: `bun ts-runtime/build.mjs`
//   - Bundle build: `scripts/build-linux-amd64-bundle.sh`
//
// Produces:
//   ts-runtime/dist/space-sdk.tgz   — vendored into each scaffolded space's
//                                     package.json via a `file:` dep
//   ts-runtime/dist/worker.js       — the bun worker the daemon spawns per
//                                     space (single shared artifact)
//   ts-runtime/dist/migrate.js      — bun runner the CLI shells out to in
//                                     create-space + build-space to apply
//                                     drizzle migrations against app.db
//   ts-runtime/dist/icons.js        — icon resolver the artifact build runs
//                                     over spaces/icons/{icons.json.gz,aliases.json}
//   ts-runtime/dist/base-ui.tgz     — @hatch/base-ui, Base UI's public parts
//                                     bundled with React external
//   ts-runtime/dist/muse-ui.tgz     — @hatch/muse-ui, the Muse template's
//                                     components on @hatch/base-ui; the
//                                     scaffold adds both to Muse Spaces as
//                                     `file:` deps

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = join(ROOT, "sdk");
const BASE_UI_DIR = join(ROOT, "base-ui");
const MUSE_UI_DIR = join(ROOT, "muse-ui");
const WORKER_DIR = join(ROOT, "worker");
const CVM_DIR = join(ROOT, "cvm");
const DIST = join(ROOT, "dist");
const TARBALL_NAME = "space-sdk.tgz";
const BASE_UI_TARBALL_NAME = "base-ui.tgz";
const MUSE_UI_TARBALL_NAME = "muse-ui.tgz";
const WORKER_NAME = "worker.js";
const MIGRATE_NAME = "migrate.js";
const PRUNE_IMPORTS_NAME = "prune-imports.js";
const VALIDATE_CLIENT_NAME = "validate-client.js";
const VALIDATE_SERVER_ACTIONS_NAME = "validate-server-actions.js";
const EXTRACT_PRIVILEGED_CONTRACTS_NAME = "extract-privileged-contracts.js";
const EXECUTE_PRIVILEGED_NAME = "execute-privileged.js";
const PLAYWRIGHT_AUDIT_NAME = "playwright-audit.js";
const PROBE_CTX_NAME = "probe-ctx.js";
const PROBE_UI_NAME = "probe-ui.js";
const BUILD_CVM_CLIENT_NAME = "build-cvm-client.js";
const CVM_PRELUDE_NAME = "cvm-prelude.js";
const ICONS_CLI_NAME = "icons.js";
// The one checked-in copy of the icon geometry; SDK modules are generated from it.

function resolveBun() {
  for (const candidate of [
    process.env.SPACES_BUN_BINARY,
    "/opt/hatch-image/bin/bun",
    "/opt/hatch/bin/bun",
    "bun",
  ].filter(Boolean)) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "bun not found (tried SPACES_BUN_BINARY, /opt/hatch-image/bin/bun, " +
      "/opt/hatch/bin/bun, $PATH)",
  );
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (status ${result.status})`);
  }
}

function clean() {
  rmSync(DIST, { recursive: true, force: true });
  for (const dir of [SDK_DIR, BASE_UI_DIR, MUSE_UI_DIR]) {
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    // Drop any leftover tarballs from prior packs.
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".tgz")) {
        unlinkSync(join(dir, entry));
      }
    }
  }
  mkdirSync(DIST, { recursive: true });
}

function installDeps(bun) {
  // Workspace-aware install at the ts-runtime root: resolves zod, typescript,
  // bun-types, and the workspace link from worker → sdk in one pass.
  // Optional native deps (@libsql/<platform>) must match where the staged
  // dist/ runs, not where it builds: the bundle build sets SPACES_TARGET_CPU
  // to the bundle target because its container can be an arm64 builder
  // cross-building an amd64 bundle. A bare run installs for the running
  // platform. Nothing that runs at build time comes from optional deps.
  const targetCpu = process.env.SPACES_TARGET_CPU;
  const args = targetCpu
    ? ["install", "--os=linux", `--cpu=${targetCpu}`]
    : ["install"];
  run(bun, args, { cwd: ROOT });
}

function compileSdk(bun) {
  // SDK must be compiled before the worker is bundled — the worker imports
  // from `@hatch/space-sdk` which (via workspace) points at `sdk/dist/`.
  run(bun, ["x", "tsc", "-p", "tsconfig.json"], { cwd: SDK_DIR });
}


function bundleIconsCli(bun) {
  run(bun, ["build", "./icons/cli.ts", "--target=bun", "--outfile", join(DIST, ICONS_CLI_NAME)], { cwd: ROOT });
}

async function bundleSdkPdf() {
  const dynamicFunction =
    'return new Function("src", "srcOffset", "dest", "destOffset", compiled);';
  // PDF.js's optional ICC engine synchronously fetches WASM, which cannot be
  // implemented by the asynchronous CVM XHR tunnel. Disable that optional color
  // transform in both builds; PDF.js retains its built-in approximate fallback.
  const synchronousIccSetup = `    if (!useWorkerFetch) {
      this.#useWasm = false;
      return;
    }
    this.#useWasm = useWasm;
    this.#wasmUrl = wasmUrl;`;
  let patchedWorker = false;
  const result = await Bun.build({
    entrypoints: [join(SDK_DIR, "src", "pdf.ts")],
    outdir: join(SDK_DIR, "dist"),
    target: "browser",
    format: "esm",
    minify: true,
    external: ["react"],
    naming: { entry: "pdf.js" },
    plugins: [
      {
        name: "pdfjs-confidential-runtime-compatibility",
        setup(build) {
          build.onLoad({ filter: /pdf\.worker\.mjs$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            const dynamicFunctionOccurrences =
              source.split(dynamicFunction).length - 1;
            if (dynamicFunctionOccurrences !== 1) {
              throw new Error(
                `expected one PDF.js dynamic Function site, found ${dynamicFunctionOccurrences}`,
              );
            }
            const synchronousIccOccurrences =
              source.split(synchronousIccSetup).length - 1;
            if (synchronousIccOccurrences !== 1) {
              throw new Error(
                `expected one PDF.js synchronous ICC setup, found ${synchronousIccOccurrences}`,
              );
            }
            patchedWorker = true;
            return {
              contents: source
                .replace(dynamicFunction, "return null;")
                .replace(
                  synchronousIccSetup,
                  "    this.#useWasm = false;\n    this.#wasmUrl = null;",
                ),
              loader: "js",
            };
          });
        },
      },
    ],
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("PDF SDK bundle failed; see logged diagnostics");
  }
  if (!patchedWorker) {
    throw new Error("PDF SDK bundle did not load the PDF.js worker module");
  }

  // tsc preserves the worker's side-effect import in pdf.d.ts, but pdf.js now
  // contains that code. Remove the private build dependency from the public type
  // surface so generated Spaces do not need pdfjs-dist in node_modules.
  const declarationPath = join(SDK_DIR, "dist", "pdf.d.ts");
  const declaration = await Bun.file(declarationPath).text();
  const workerDeclarationImport = 'import "pdfjs-dist/build/pdf.worker.mjs";\n';
  if (declaration.split(workerDeclarationImport).length - 1 !== 1) {
    throw new Error("expected one PDF.js worker import in pdf.d.ts");
  }
  await Bun.write(declarationPath, declaration.replace(workerDeclarationImport, ""));

  const pdfjsRoot = join(SDK_DIR, "node_modules", "pdfjs-dist");
  const pdfjsManifest = JSON.parse(
    await Bun.file(join(pdfjsRoot, "package.json")).text(),
  );
  if (typeof pdfjsManifest.version !== "string" || pdfjsManifest.version.length === 0) {
    throw new Error("pdfjs-dist package has no version");
  }
  const assetRoot = join(
    SDK_DIR,
    "dist",
    "pdfjs-assets",
    pdfjsManifest.version,
  );
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    cpSync(join(pdfjsRoot, directory), join(assetRoot, directory), {
      recursive: true,
      dereference: true,
    });
  }
  // PDF.js's optional no-Wasm fallback is executable JavaScript. Modern Space
  // browsers provide WebAssembly, and omitting this fallback keeps the generated
  // artifact closed to one reviewed JavaScript bundle for the CVM transform.
  unlinkSync(join(assetRoot, "wasm", "openjpeg_nowasm_fallback.js"));
}

function packSdk(bun) {
  packWorkspace(bun, SDK_DIR, TARBALL_NAME);
}

function packWorkspace(bun, dir, tarballName) {
  // `bun pm pack` produces a tarball in cwd named after the package + version
  // (e.g. hatch-space-sdk-0.1.0.tgz). Rename to the canonical name consumed by
  // template `package.json` `file:` deps.
  const result = spawnSync(bun, ["pm", "pack"], {
    cwd: dir,
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`bun pm pack failed (status ${result.status})`);
  }
  const produced = readdirSync(dir).filter((name) => name.endsWith(".tgz"));
  if (produced.length === 0) {
    throw new Error("bun pm pack produced no .tgz");
  }
  if (produced.length > 1) {
    throw new Error(`bun pm pack produced multiple tarballs: ${produced.join(", ")}`);
  }
  const src = join(dir, produced[0]);
  const dest = join(DIST, tarballName);
  copyFileSync(src, dest);
  unlinkSync(src);
}

// Base UI's public entry points: every subpath it exports except
// `./internals/*`, which it marks internal and whose date adapters need
// date-fns or luxon. Read from the pinned package so the surface follows the pin.
function baseUiSubpaths(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return Object.keys(manifest.exports)
    .filter(
      (key) =>
        key === "." ||
        (key.startsWith("./") && key !== "./package.json" && !key.startsWith("./internals/")),
    )
    .map((key) => (key === "." ? "index" : key.slice(2)));
}

// The package directory a bare specifier names, found the way Node does: up
// the node_modules chain from the importing file.
function packageDirFrom(fromFile, name) {
  let dir = dirname(fromFile);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function declarationFor(target) {
  if (typeof target === "string") {
    if (target.endsWith(".d.ts")) return target;
    if (target.endsWith(".d.mts")) return target.replace(/\.d\.mts$/, ".d.ts");
    return null;
  }
  if (target == null || typeof target !== "object") return null;
  for (const condition of ["require", "types", "import", "default"]) {
    const found = declarationFor(target[condition]);
    if (found != null) return found;
  }
  return null;
}

// The declaration file a bare `name[/sub]` specifier resolves to.
function resolveBareDeclaration(fromFile, specifier) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = specifier.slice(name.length);
  const pkgDir = packageDirFrom(fromFile, name);
  if (pkgDir == null) return null;
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  let rel = manifest.exports == null ? null : declarationFor(manifest.exports["." + sub]);
  if (rel == null && sub === "") rel = manifest.types ?? manifest.typings ?? "index.d.ts";
  if (rel == null) return null;
  const file = join(pkgDir, rel);
  return existsSync(file) ? { name, pkgDir, file } : null;
}

function resolveRelativeDeclaration(fromFile, specifier) {
  const base = join(dirname(fromFile), specifier.replace(/\.(m?js)$/, ""));
  for (const candidate of [base + ".d.ts", join(base, "index.d.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const DECLARATION_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
// Bare specifiers a Space provides itself, left as they are.
const SPACE_PROVIDED_TYPES = /^(react|react-dom)(\/|$)/;

// Copies the declarations reachable from Base UI's public entry points into
// dist/types/<package>/..., rewriting bare imports of its dependencies to
// relative paths, so a Space typechecks against Base UI's own types without
// installing Base UI or its dependencies.
function copyBaseUiDeclarations(baseUiPkgDir, subpaths, typesRoot) {
  const outPath = new Map();
  const queue = [];
  const enqueue = (file, name, pkgDir) => {
    if (outPath.has(file)) return outPath.get(file);
    const out = join(typesRoot, name, relative(pkgDir, file));
    outPath.set(file, out);
    queue.push({ file, name, pkgDir, out });
    return out;
  };
  const entries = new Map();
  for (const sub of subpaths) {
    const specifier = sub === "index" ? "@base-ui/react" : `@base-ui/react/${sub}`;
    const resolved = resolveBareDeclaration(join(baseUiPkgDir, "package.json"), specifier);
    if (resolved == null) throw new Error(`no declarations for ${specifier}`);
    entries.set(sub, enqueue(resolved.file, resolved.name, resolved.pkgDir));
  }
  while (queue.length > 0) {
    const { file, name, pkgDir, out } = queue.shift();
    const text = readFileSync(file, "utf8").replace(
      DECLARATION_SPECIFIER,
      (match, lead, quote, specifier, offset, source) => {
        // Examples inside doc comments name modules that do not exist.
        const line = source.slice(source.lastIndexOf("\n", offset) + 1, offset).trimStart();
        if (line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) return match;
        if (specifier.startsWith(".")) {
          const target = resolveRelativeDeclaration(file, specifier);
          if (target == null) throw new Error(`${file}: cannot resolve ${specifier}`);
          enqueue(target, name, pkgDir);
          return match;
        }
        if (SPACE_PROVIDED_TYPES.test(specifier)) return match;
        const target = resolveBareDeclaration(file, specifier);
        if (target == null) throw new Error(`${file}: cannot resolve ${specifier}`);
        const targetOut = enqueue(target.file, target.name, target.pkgDir);
        let rel = relative(dirname(out), targetOut).replace(/\.d\.ts$/, ".js");
        if (!rel.startsWith(".")) rel = "./" + rel;
        return `${lead}${quote}${rel}${quote}`;
      },
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  return entries;
}

async function buildBaseUi(bun) {
  // One entry per public subpath, built together with code splitting, so a
  // Space that imports several subpaths (and @hatch/muse-ui, which imports
  // this package) shares one copy of every Base UI module. React stays
  // external and resolves from the Space, so hooks see a single React.
  const baseUiPkgDir = packageDirFrom(join(BASE_UI_DIR, "package.json"), "@base-ui/react");
  if (baseUiPkgDir == null) throw new Error("@base-ui/react is not installed for base-ui/");
  const subpaths = baseUiSubpaths(baseUiPkgDir);
  const distDir = join(BASE_UI_DIR, "dist");
  const entryDir = join(distDir, ".entries");
  mkdirSync(entryDir, { recursive: true });
  for (const sub of subpaths) {
    const from = sub === "index" ? "@base-ui/react" : `@base-ui/react/${sub}`;
    writeFileSync(join(entryDir, `${sub}.ts`), `export * from "${from}";\n`);
  }
  const result = await Bun.build({
    entrypoints: subpaths.map((sub) => join(entryDir, `${sub}.ts`)),
    root: entryDir,
    outdir: distDir,
    target: "browser",
    format: "esm",
    splitting: true,
    external: ["react", "react-dom", "react/*", "react-dom/*"],
    naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
  });
  rmSync(entryDir, { recursive: true, force: true });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("base-ui bundle failed; see logged diagnostics");
  }
  for (const output of result.outputs) {
    const code = await Bun.file(output.path).text();
    const leaked = code.match(
      /from\s*["'](@base-ui|@floating-ui|use-sync-external-store|reselect|@babel)[^"']*["']/,
    );
    if (leaked != null) {
      throw new Error(`base-ui ${relative(distDir, output.path)} still imports ${leaked[0]}`);
    }
  }
  const entries = copyBaseUiDeclarations(baseUiPkgDir, subpaths, join(distDir, "types"));
  for (const [sub, declaration] of entries) {
    const rel = "./" + relative(distDir, declaration).replace(/\.d\.ts$/, ".js");
    writeFileSync(join(distDir, `${sub}.d.ts`), `export * from "${rel}";\n`);
  }
  packWorkspace(bun, BASE_UI_DIR, BASE_UI_TARBALL_NAME);
}

function buildMuseUi(bun) {
  // Compiled per file so the class names Tailwind reads stay in dist/*.js.
  // Base UI comes from @hatch/base-ui, which a Muse Space installs beside it.
  run(bun, ["x", "tsc", "-p", "tsconfig.json"], { cwd: MUSE_UI_DIR });
  packWorkspace(bun, MUSE_UI_DIR, MUSE_UI_TARBALL_NAME);
}

function bundleWorker(bun) {
  // `--target=bun` inlines zod, drizzle-orm, @libsql/client (JS), and the
  // SDK helpers. @libsql/client's platform-specific native binding
  // (`@libsql/<target>/index.node`) is NOT inlined — the bundle does
  // `__require(`@libsql/${target}`)` at runtime and walks node_modules
  // upward from the bundle's location. `stageNativeLibsql()` writes those
  // native packages into `dist/node_modules/@libsql/...` so the resolver
  // finds them next to worker.js / migrate.js without a package install.
  run(
    bun,
    [
      "build",
      "./src/main.ts",
      "--target=bun",
      "--outfile",
      join(DIST, WORKER_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleMigrate(bun) {
  // Drizzle migrator runner; same externals story as bundleWorker (see
  // comment there). Native binding is staged once per build into
  // `dist/node_modules/@libsql/...` and shared by both bundles.
  run(
    bun,
    [
      "build",
      "./src/migrate-cli.ts",
      "--target=bun",
      "--outfile",
      join(DIST, MIGRATE_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundlePruneImports(bun) {
  // Finalize dead-import strip, invoked by the daemon after a successful build
  // submit. Bundles the TypeScript compiler (organizeImports) into a
  // self-contained dist script, same as the other daemon-side runners; large
  // (~8-9 MB) but build-time-only and never shipped to the client.
  run(
    bun,
    [
      "build",
      "./src/prune-imports.ts",
      "--target=bun",
      "--outfile",
      join(DIST, PRUNE_IMPORTS_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleValidateClient(bun) {
  // Client source validator runner; no native deps, no externals.
  run(
    bun,
    [
      "build",
      "./src/validate-client-cli.ts",
      "--target=bun",
      "--outfile",
      join(DIST, VALIDATE_CLIENT_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleValidateServerActions(bun) {
  // Action source portability validator runner; no native deps, no externals.
  run(
    bun,
    [
      "build",
      "./src/validate-server-actions-cli.ts",
      "--target=bun",
      "--outfile",
      join(DIST, VALIDATE_SERVER_ACTIONS_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleExtractPrivilegedContracts(bun) {
  // Build-time metadata extractor for optional per-Space
  // generated `server/.generated/privileged.contract.ts` descriptors.
  run(
    bun,
    [
      "build",
      "./src/extract-privileged-contracts-cli.ts",
      "--target=bun",
      "--outfile",
      join(DIST, EXTRACT_PRIVILEGED_CONTRACTS_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleExecutePrivileged(bun) {
  // Daemon-side runner for optional per-Space `server/dist/privileged.js`
  // implementation bundles. Action workers never import this runner.
  run(
    bun,
    [
      "build",
      "./src/execute-privileged-cli.ts",
      "--target=bun",
      "--outfile",
      join(DIST, EXECUTE_PRIVILEGED_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleProbeCtx(bun) {
  // Builder-only ctx probe runner; reuses createInferenceClient and
  // createToolClient from the worker so its surface stays in lockstep with
  // what real actions see. No native deps, no externals.
  run(
    bun,
    [
      "build",
      "./src/probe-ctx-cli.ts",
      "--target=bun",
      "--outfile",
      join(DIST, PROBE_CTX_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundleProbeUi(bun) {
  // Builder-facing UI probe (`serve` + the observe/act client). Shares the
  // audit's browser bring-up by importing playwright-audit directly, so the
  // notary/egress/network-policy posture cannot drift between the two entry
  // points. `playwright` is externalized for the same reason as the audit:
  // resolution walks up from the bundle to dist/node_modules/playwright/.
  run(
    bun,
    [
      "build",
      "./src/probe-ui-cli.ts",
      "--target=bun",
      "--external",
      "playwright",
      "--outfile",
      join(DIST, PROBE_UI_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

function bundlePlaywrightAudit(bun) {
  // The Playwright UI audit. `playwright` is externalized — it carries
  // ~50MB of driver/native bits we don't want inlined into a JS bundle.
  // Resolution at runtime walks up from the bundle's location, so the
  // staging step (stagePlaywrightModule) writes node_modules/playwright/
  // into dist/.
  run(
    bun,
    [
      "build",
      "./src/playwright-audit.ts",
      "--target=bun",
      "--external",
      "playwright",
      "--outfile",
      join(DIST, PLAYWRIGHT_AUDIT_NAME),
    ],
    { cwd: WORKER_DIR },
  );
}

// @libsql/client platform native packages produced by `bun install`. We
// only copy the platform binaries (each has an index.node) — the @libsql
// pure-JS packages (`client`, `core`, `hrana-client`, ...) are already
// inlined into the JS bundles.
function stageNativeLibsql() {
  const libsqlDir = join(ROOT, "node_modules", ".bun", "node_modules", "@libsql");
  if (!existsSync(libsqlDir)) {
    throw new Error(
      `bun install did not produce ${libsqlDir} — cannot stage native libsql binding`,
    );
  }
  const destRoot = join(DIST, "node_modules", "@libsql");
  mkdirSync(destRoot, { recursive: true });
  const candidates = readdirSync(libsqlDir);
  // When cross-building (SPACES_TARGET_CPU set), stage only the target linux
  // binding(s). The bun store can also hold the builder/host platform (e.g. a
  // stale @libsql/darwin-arm64 from a local `bun install`), which would ship a
  // wrong-platform binary and fail the bundle's ELF check. A bare local run has
  // no target and stages whatever the host install produced (current behavior).
  const targetCpu = process.env.SPACES_TARGET_CPU;
  const targetPrefix = targetCpu ? `linux-${targetCpu}` : null;
  let staged = 0;
  for (const name of candidates) {
    if (targetPrefix && !name.startsWith(targetPrefix)) {
      continue;
    }
    const src = join(libsqlDir, name);
    const indexNode = join(src, "index.node");
    if (!existsSync(indexNode)) {
      // pure-JS package (client, core, etc.) — already inlined.
      continue;
    }
    if (!statSync(indexNode).isFile()) {
      continue;
    }
    const dest = join(destRoot, name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    staged += 1;
  }
  if (staged === 0) {
    throw new Error(
      `no @libsql/<platform>/index.node found under ${libsqlDir}` +
        (targetPrefix ? ` matching ${targetPrefix}*` : "") +
        " — bun install must produce at least one platform native package",
    );
  }
}

// Resolve the playwright package's actual on-disk location and copy it
// into `dist/node_modules/playwright/` so the bundle can `import("playwright")`
// at runtime without a separate package install on the VM. Same pattern
// as stageNativeLibsql for the libsql native binding.
function stagePlaywrightModule() {
  // bun's hoisted layout puts the package under .bun/node_modules/playwright/
  // (resolved as a symlink to the per-version installation). dereference: true
  // copies the materialized files.
  const pwSrc = join(ROOT, "node_modules", ".bun", "node_modules", "playwright");
  if (!existsSync(pwSrc)) {
    throw new Error(
      `bun install did not produce ${pwSrc} — cannot stage playwright module`,
    );
  }
  const destRoot = join(DIST, "node_modules", "playwright");
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(dirname(destRoot), { recursive: true });
  cpSync(pwSrc, destRoot, { recursive: true, dereference: true });

  // playwright re-exports playwright-core; ship it too so resolution succeeds.
  const pwCoreSrc = join(ROOT, "node_modules", ".bun", "node_modules", "playwright-core");
  if (existsSync(pwCoreSrc)) {
    const pwCoreDest = join(DIST, "node_modules", "playwright-core");
    rmSync(pwCoreDest, { recursive: true, force: true });
    cpSync(pwCoreSrc, pwCoreDest, { recursive: true, dereference: true });
  }
}

function compileCvmPrelude(bun) {
  // The CVM runtime tunnel (`__tunnel`). Compiled to a self-contained browser
  // IIFE here so the CVM client builder can read it from dist/ and inline it
  // verbatim into each Space's opaque-origin bundle as a classic <script>. No
  // native deps, no externals. `--format=iife` keeps the bundled ./tunnel-url
  // helpers scoped inside the wrapper instead of leaking as window globals.
  run(
    bun,
    [
      "build",
      "./src/prelude.ts",
      "--target=browser",
      "--format=iife",
      "--outfile",
      join(DIST, CVM_PRELUDE_NAME),
    ],
    { cwd: CVM_DIR },
  );
}

function bundleCvmBuilder(bun) {
  // The CVM hermetic client builder. `--target=bun` inlines Babel
  // (@babel/parser|traverse|generator|types), the AST/CSS/HTML URL rewriters,
  // and the Tailwind plugin, so the Rust build pipeline can invoke one
  // self-contained dist script without a per-Space install of those deps.
  run(
    bun,
    [
      "build",
      "./src/build-cvm-client.ts",
      "--target=bun",
      "--outfile",
      join(DIST, BUILD_CVM_CLIENT_NAME),
    ],
    { cwd: CVM_DIR },
  );
}

async function main() {
  const bun = resolveBun();
  clean();
  installDeps(bun);
  compileSdk(bun);
  await bundleSdkPdf();
  packSdk(bun);
  await buildBaseUi(bun);
  buildMuseUi(bun);
  bundleWorker(bun);
  bundleMigrate(bun);
  bundlePruneImports(bun);
  bundleValidateClient(bun);
  bundleValidateServerActions(bun);
  bundleExtractPrivilegedContracts(bun);
  bundleExecutePrivileged(bun);
  bundleProbeCtx(bun);
  bundleProbeUi(bun);
  bundlePlaywrightAudit(bun);
  compileCvmPrelude(bun);
  bundleCvmBuilder(bun);
  bundleIconsCli(bun);
  stageNativeLibsql();
  stagePlaywrightModule();
  for (const name of [
    TARBALL_NAME,
    BASE_UI_TARBALL_NAME,
    MUSE_UI_TARBALL_NAME,
    WORKER_NAME,
    MIGRATE_NAME,
    VALIDATE_CLIENT_NAME,
    VALIDATE_SERVER_ACTIONS_NAME,
    EXTRACT_PRIVILEGED_CONTRACTS_NAME,
    EXECUTE_PRIVILEGED_NAME,
    PROBE_CTX_NAME,
    PROBE_UI_NAME,
    PLAYWRIGHT_AUDIT_NAME,
    CVM_PRELUDE_NAME,
    BUILD_CVM_CLIENT_NAME,
    ICONS_CLI_NAME,
  ]) {
    if (!existsSync(join(DIST, name))) {
      throw new Error(`build failed: ${name} missing from ${DIST}`);
    }
  }
  process.stdout.write(
    `built ${join("ts-runtime/dist", TARBALL_NAME)} + ` +
      `${join("ts-runtime/dist", BASE_UI_TARBALL_NAME)} + ` +
      `${join("ts-runtime/dist", MUSE_UI_TARBALL_NAME)} + ` +
      `${join("ts-runtime/dist", WORKER_NAME)} + ` +
      `${join("ts-runtime/dist", MIGRATE_NAME)} + ` +
      `${join("ts-runtime/dist", VALIDATE_CLIENT_NAME)} + ` +
      `${join("ts-runtime/dist", VALIDATE_SERVER_ACTIONS_NAME)} + ` +
      `${join("ts-runtime/dist", EXTRACT_PRIVILEGED_CONTRACTS_NAME)} + ` +
      `${join("ts-runtime/dist", EXECUTE_PRIVILEGED_NAME)} + ` +
      `${join("ts-runtime/dist", PROBE_CTX_NAME)} + ` +
      `${join("ts-runtime/dist", PROBE_UI_NAME)} + ` +
      `${join("ts-runtime/dist", PLAYWRIGHT_AUDIT_NAME)} + ` +
      `${join("ts-runtime/dist", CVM_PRELUDE_NAME)} + ` +
      `${join("ts-runtime/dist", BUILD_CVM_CLIENT_NAME)} + ` +
      `${join("ts-runtime/dist", ICONS_CLI_NAME)}\n`,
  );
}

await main();
