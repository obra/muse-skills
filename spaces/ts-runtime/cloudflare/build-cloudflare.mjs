#!/usr/bin/env bun

import { createRequire } from "node:module";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { analyzeServerActionsShape } from "../worker/src/validate-server-actions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsRuntimeRoot = path.resolve(__dirname, "..");
const sdkShimPath = path.join(__dirname, "src", "sdk.ts");
const workerRuntimePath = path.join(__dirname, "src", "worker-runtime.ts");
const workerPackageJsonPath = path.join(tsRuntimeRoot, "worker", "package.json");
const workerTsconfigBasePath = path.join(__dirname, "tsconfig.worker.base.json");
const defaultManifestName = "deploy-manifest.json";
const defaultWorkerName = "worker.js";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
]);

function parseArgs(argv) {
  const parsed = {
    spaceDir: "",
    outDir: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextArgument = argv[index + 1];
    if (argument === "--space-dir" && typeof nextArgument === "string") {
      parsed.spaceDir = nextArgument;
      index += 1;
      continue;
    }
    if (argument === "--out-dir" && typeof nextArgument === "string") {
      parsed.outDir = nextArgument;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (parsed.spaceDir.length === 0) {
    throw new Error("Missing --space-dir");
  }
  if (parsed.outDir.length === 0) {
    throw new Error("Missing --out-dir");
  }
  return parsed;
}

function toImportSpecifier(fromDir, targetPath) {
  const relative = path.relative(fromDir, targetPath).replaceAll(path.sep, "/");
  if (relative.startsWith(".")) {
    return relative;
  }
  return `./${relative}`;
}

function loadTypeScript(spaceDir) {
  const candidates = [
    path.join(spaceDir, "package.json"),
    path.join(tsRuntimeRoot, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)("typescript");
    } catch {
      continue;
    }
  }
  throw new Error("Could not resolve TypeScript from the space or ts-runtime");
}

function resolveModule(specifier, spaceDir) {
  const candidates = [
    path.join(spaceDir, "package.json"),
    workerPackageJsonPath,
    path.join(tsRuntimeRoot, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate).resolve(specifier);
    } catch {
      continue;
    }
  }
  throw new Error(`Could not resolve ${specifier} from the space or ts-runtime`);
}

function resolvePackageRoot(packageName, spaceDir) {
  let currentDir = path.dirname(resolveModule(packageName, spaceDir));
  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    try {
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, "utf8"));
      if (packageJson.name !== packageName) {
        throw new Error(
          `Resolved ${packageName} to package ${packageJson.name ?? "<unnamed>"} at ${currentDir}`,
        );
      }
      return currentDir;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find package root for ${packageName}`);
    }
    currentDir = parentDir;
  }
}

function dependencyAliases(spaceDir) {
  return {
    zod: resolvePackageRoot("zod", spaceDir),
    drizzleOrm: resolvePackageRoot("drizzle-orm", spaceDir),
  };
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(candidate) {
  try {
    return JSON.parse(await fs.readFile(candidate, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function formatDiagnostics(ts, diagnostics) {
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  };
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, host);
}

async function collectFiles(rootDir, relativePrefix = "") {
  if (!(await pathExists(rootDir))) {
    return [];
  }

  const collected = [];
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    const relativePath = path.posix.join(relativePrefix, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectFiles(entryPath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    collected.push({
      path: relativePath,
      absolutePath: entryPath,
    });
  }
  return collected;
}

async function collectClientFiles(spaceDir) {
  const clientDist = path.join(spaceDir, "client", "dist");
  const iconFiles = [];
  for (const name of ["icon.webp", "icon.png", "icon.jpg"]) {
    const absolutePath = path.join(spaceDir, name);
    if (await pathExists(absolutePath)) {
      iconFiles.push({
        name,
        absolutePath,
        assetPath: `assets/${name}`,
        contentType: contentTypes.get(path.extname(name)),
      });
    }
  }
  const favicon = iconFiles[0];
  const files = await collectFiles(clientDist);
  const clientFiles = await Promise.all(
    files.map(async (file) => {
      const content =
        favicon && file.path === "index.html"
          ? await indexHtmlWithIconLink(file.absolutePath, favicon)
          : await fs.readFile(file.absolutePath);
      return {
        path: file.path,
        contentType:
          contentTypes.get(path.extname(file.path).toLowerCase()) ??
          "application/octet-stream",
        contentBase64: content.toString("base64"),
      };
    }),
  );
  for (const icon of iconFiles) {
    const iconFile = {
      path: icon.assetPath,
      contentType: icon.contentType,
      contentBase64: (await fs.readFile(icon.absolutePath)).toString("base64"),
    };
    const existingIndex = clientFiles.findIndex((file) => file.path === iconFile.path);
    if (existingIndex === -1) {
      clientFiles.push(iconFile);
    } else {
      clientFiles[existingIndex] = iconFile;
    }
  }
  return clientFiles;
}

async function indexHtmlWithIconLink(indexPath, icon) {
  const html = await fs.readFile(indexPath, "utf8");
  if (/<link\b[^>]*\brel=["'](?:shortcut )?icon["']/i.test(html)) {
    return Buffer.from(html);
  }
  return Buffer.from(
    html.replace(
      /<\/head>/i,
      `<link rel="icon" type="${icon.contentType}" href="./${icon.assetPath}"></head>`,
    ),
  );
}

async function collectMigrations(spaceDir) {
  const drizzleDir = path.join(spaceDir, "drizzle");
  const files = (await collectFiles(drizzleDir))
    .filter((file) => file.path.endsWith(".sql"))
    .sort((left, right) => left.path.localeCompare(right.path));
  return Promise.all(
    files.map(async (file) => ({
      name: file.path,
      sql: await fs.readFile(file.absolutePath, "utf8"),
    })),
  );
}

async function writeEntrypoint(entryDir, spaceDir) {
  await fs.mkdir(entryDir, { recursive: true });
  const entryPath = path.join(entryDir, "entry.ts");
  const packageJson = await readJsonIfExists(path.join(spaceDir, "package.json"));
  const slug = packageJson.hatch?.slug ?? path.basename(spaceDir);
  const runtimeImport = toImportSpecifier(entryDir, workerRuntimePath);
  const actionsPath = path.join(spaceDir, "server", "src", "actions.ts");
  const actionsImport = toImportSpecifier(entryDir, actionsPath);
  await fs.writeFile(
    entryPath,
    [
      `import { createWorker } from "${runtimeImport}";`,
      `import { Actions } from "${actionsImport}";`,
      "",
      `export default createWorker(Actions, ${JSON.stringify(slug)});`,
      "",
    ].join("\n"),
  );
  return entryPath;
}

async function writeTypecheckConfig(entryDir, entryPath, spaceDir, aliases) {
  const relativeShim = toImportSpecifier(entryDir, sdkShimPath);
  const relativeZod = toImportSpecifier(entryDir, aliases.zod);
  const relativeDrizzle = toImportSpecifier(entryDir, aliases.drizzleOrm);
  const relativeBaseConfig = toImportSpecifier(entryDir, workerTsconfigBasePath);
  const configPath = path.join(entryDir, "tsconfig.cloudflare-worker.json");
  const config = {
    extends: relativeBaseConfig,
    compilerOptions: {
      baseUrl: ".",
      ignoreDeprecations: "5.0",
      paths: {
        "@hatch/space-sdk": [relativeShim],
        zod: [relativeZod],
        "drizzle-orm": [relativeDrizzle],
        "drizzle-orm/*": [`${relativeDrizzle}/*`],
      },
    },
    include: [
      toImportSpecifier(entryDir, entryPath),
      toImportSpecifier(entryDir, path.join(spaceDir, "server", "src", "**", "*.ts")),
      toImportSpecifier(entryDir, path.join(__dirname, "src", "**", "*.ts")),
    ],
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function typecheckCloudflareWorker({ spaceDir, configPath }) {
  const ts = loadTypeScript(spaceDir);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(formatDiagnostics(ts, [configFile.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatDiagnostics(ts, parsed.errors));
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(formatDiagnostics(ts, diagnostics));
  }
}

async function bundleWorker({ entryPath, outDir, spaceDir }) {
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: outDir,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    naming: defaultWorkerName,
    plugins: [
      {
        name: "hatch-cloudflare-sdk-alias",
        setup(build) {
          build.onResolve({ filter: /^@hatch\/space-sdk$/ }, () => ({
            path: sdkShimPath,
          }));
          build.onResolve({ filter: /^zod$/ }, () => ({
            path: resolveModule("zod", spaceDir),
          }));
          build.onResolve({ filter: /^drizzle-orm(\/.*)?$/ }, (args) => ({
            path: resolveModule(args.path, spaceDir),
          }));
        },
      },
    ],
  });

  if (!result.success) {
    const logs = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`Cloudflare worker bundle failed\n${logs}`);
  }
  return path.join(outDir, defaultWorkerName);
}

async function readServerActionsShape(spaceDir) {
  // Mirror the daemon build pipeline's static classification so the share-time
  // assertion (Rust side) can confirm a client-only artifact really ships an
  // inert, zero-action server module before deploying it.
  const actionsPath = path.join(spaceDir, "server", "src", "actions.ts");
  const source = await fs.readFile(actionsPath, "utf8").catch(() => "");
  const shape = analyzeServerActionsShape(source);
  return { clientOnly: shape.clientOnly, hasServerActions: !shape.clientOnly };
}

async function writeDeployManifest({ spaceDir, outDir, workerPath }) {
  const packageJson = await readJsonIfExists(path.join(spaceDir, "package.json"));
  const workerJs = await fs.readFile(workerPath, "utf8");
  const serverActions = await readServerActionsShape(spaceDir);
  const manifest = {
    runtime: "hatch-ts-cloudflare-v1",
    sharedStateVersion: 1,
    runWorkerFirst: serverActions.hasServerActions,
    slug: packageJson.hatch?.slug ?? path.basename(spaceDir),
    name: packageJson.hatch?.name ?? packageJson.name ?? path.basename(spaceDir),
    workerJs,
    serverActions,
    migrations: await collectMigrations(spaceDir),
    clientFiles: await collectClientFiles(spaceDir),
  };
  const manifestPath = path.join(outDir, defaultManifestName);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export async function buildCloudflareArtifacts({ spaceDir, outDir }) {
  const resolvedSpaceDir = path.resolve(spaceDir);
  const resolvedOutDir = path.resolve(outDir);
  const actionsPath = path.join(resolvedSpaceDir, "server", "src", "actions.ts");
  if (!(await pathExists(actionsPath))) {
    throw new Error(`Missing server actions file: ${actionsPath}`);
  }

  await fs.rm(resolvedOutDir, { recursive: true, force: true });
  await fs.mkdir(resolvedOutDir, { recursive: true });
  const aliases = dependencyAliases(resolvedSpaceDir);
  const entryDir = path.join(resolvedOutDir, ".entry");
  const entryPath = await writeEntrypoint(entryDir, resolvedSpaceDir);
  const configPath = await writeTypecheckConfig(
    entryDir,
    entryPath,
    resolvedSpaceDir,
    aliases,
  );
  await typecheckCloudflareWorker({
    spaceDir: resolvedSpaceDir,
    configPath,
  });
  const workerPath = await bundleWorker({
    entryPath,
    outDir: resolvedOutDir,
    spaceDir: resolvedSpaceDir,
  });
  const manifestPath = await writeDeployManifest({
    spaceDir: resolvedSpaceDir,
    outDir: resolvedOutDir,
    workerPath,
  });
  return {
    manifestPath,
    workerPath,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv);
    const result = await buildCloudflareArtifacts(args);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          manifest: result.manifestPath,
          worker: result.workerPath,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
