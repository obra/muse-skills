// Builder-only ctx probe — evaluate a TS snippet against a real Ctx with
// live `ctx.inference` and `ctx.tool` clients before any Space is built.
//
// Why it exists: `ctx.*` methods only exist inside a built action's runtime,
// so the spaces builder subagent has no way to test data sources during the
// Explore/Plan phase without first committing to a build. This CLI gives
// them a probe that wires the same SDK client factories the worker uses
// (createInferenceClient / createToolClient) into a Ctx-shaped sandbox
// with stub `db` and `agent` (those genuinely need a built Space).
//
// In-sync-by-construction: the probe imports and constructs the same `Ctx`
// the worker exposes to actions. If the SDK adds a method on
// `InferenceClient` or `SpaceToolClient`, the probe gets it for free; if
// the `Ctx` interface gains a required field, this file fails to type-check
// until the field is added here too.
//
// Bundle output: dist/probe-ctx.js. Invoked over exec by the builder:
//
//   bun /opt/hatch/skills/spaces/ts-runtime/dist/probe-ctx.js <<'TS'
//     const w = await ctx.tool.weather("San Francisco");
//     return { keys: Object.keys(w.content), conditions: w.content.conditions };
//   TS
//
// Defaults the daemon-owned socket paths and a stub slug so the builder
// does not need to set any env. Snippet runs as the body of an
// `async (ctx, z) => { ... }` — use top-level `return` to surface a value;
// the return is JSON-stringified to stdout. Errors go to stderr, exit 1.

import { randomUUID } from "node:crypto";

import {
  z,
  createPrivilegedExecutor,
  TOOL_FINANCE_SCHEMA,
  TOOL_FINANCE_TICKER_SCHEMA,
  TOOL_SPORTS_DATA_SCHEMA,
  TOOL_WEATHER_SCHEMA,
  TOOL_WEB_SEARCH_SCHEMA,
  type AgentClient,
  type BlobClient,
  type Ctx,
  type JsonValue,
  type SpaceDbAccessor,
  type SpaceQueryInvalidationInput,
  type SpaceToolClient,
} from "@hatch/space-sdk";

import { createInferenceClient } from "./inference";
import { createBuilderProbeToolClient } from "./web_search";

// Maps each ctx.tool.* method to the JSON Schema of the `.content` value it
// returns. Sourced from the SDK's exported schemas (which run zod
// `toJSONSchema`, so field `.describe()` text rides along as `description`),
// so this can never drift from the SpaceToolClient surface.
const TOOL_CONTENT_SCHEMAS: Record<string, JsonValue> = {
  weather: TOOL_WEATHER_SCHEMA,
  sports_data: TOOL_SPORTS_DATA_SCHEMA,
  finance: TOOL_FINANCE_SCHEMA,
  finance_ticker: TOOL_FINANCE_TICKER_SCHEMA,
  web_search: TOOL_WEB_SEARCH_SCHEMA,
};

// Wrap the tool client so every `ctx.tool.<name>(...)` call records <name>.
// After the snippet runs we print the schema for whatever it actually called,
// giving the builder the full typed surface (incl. which fields are
// display-only) alongside the live sample \u2014 not just the fields that happened
// to be populated for this one query.
function instrumentToolClient(
  client: SpaceToolClient,
  invoked: Set<string>,
): SpaceToolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && typeof value === "function") {
        return (...args: unknown[]): unknown => {
          invoked.add(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
}

// Print, to stderr, the result-content schema for each ctx.tool.* method the
// snippet invoked. Using stderr keeps stdout a clean JSON dump of the
// snippet's return value.
function emitInvokedToolSchemas(invoked: Set<string>): void {
  const blocks: string[] = [];
  for (const name of invoked) {
    const schema = TOOL_CONTENT_SCHEMAS[name];
    if (schema === undefined) continue;
    blocks.push(
      `\nctx.tool.${name}(...).content:\n${JSON.stringify(schema, null, 2)}`,
    );
  }
  if (blocks.length === 0) return;
  const header = [
    "",
    "============================================================",
    "ctx.tool result schema(s) for this probe",
    "",
    "Typed shape of `<tool>(...).content` that the runtime validates against",
    "\u2014 the source of truth for fields you can rely on. Use these structured",
    "fields; any field whose description says it is display-only is",
    "human-readable text and must not be parsed. Fields not present here are",
    "not available structurally.",
    "============================================================",
  ].join("\n");
  process.stderr.write(`${header}${blocks.join("\n")}\n`);
}

const DEFAULT_INFERENCE_SOCKET = "/run/hatch/sandbox/space-inference.sock";
const DEFAULT_WEB_SEARCH_SOCKET = "/run/hatch/sandbox/space-web-search.sock";
const DEFAULT_SLUG = "__probe__";
const RUNTIME_CONTEXT_TOKEN_ENV = "JARVIS_RUNTIME_CONTEXT_TOKEN";

function ensureEnv(name: string, fallback: string): void {
  if (!process.env[name]?.trim()) {
    process.env[name] = fallback;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required builder probe environment variable ${name}`);
  }
  return value;
}

export function buildProbeCtx(invokedTools: Set<string>): Ctx {
  ensureEnv("HATCH_SPACE_INFERENCE_SOCKET", DEFAULT_INFERENCE_SOCKET);
  ensureEnv("HATCH_SPACE_WEB_SEARCH_SOCKET", DEFAULT_WEB_SEARCH_SOCKET);
  ensureEnv("HATCH_SPACE_SLUG", DEFAULT_SLUG);
  const invocationId = `probe-${randomUUID()}`;
  const runtimeContextToken = requireEnv(RUNTIME_CONTEXT_TOKEN_ENV);

  const db: SpaceDbAccessor = () => {
    throw new Error(
      "ctx.db is not available in probe mode — db access requires a built web artifact with app.db",
    );
  };

  const agent: AgentClient = {
    async spawnTask() {
      throw new Error(
        "ctx.agent.spawnTask is not available in probe mode — requires a built web artifact",
      );
    },
    async send() {
      throw new Error(
        "ctx.agent.send is not available in probe mode — requires a built web artifact",
      );
    },
    async status() {
      throw new Error(
        "ctx.agent.status is not available in probe mode — requires a built web artifact",
      );
    },
  };

  const probeUnavailable = (method: string) => (): never => {
    throw new Error(
      `ctx.blobs.${method} is not available in probe mode — requires a built web artifact`,
    );
  };
  const blobs: BlobClient = {
    put: probeUnavailable("put"),
    getUrl: probeUnavailable("getUrl"),
    delete: probeUnavailable("delete"),
    head: probeUnavailable("head"),
    list: probeUnavailable("list"),
  };

  const tool: SpaceToolClient = {
    ...createBuilderProbeToolClient(invocationId, runtimeContextToken),
    generate_media() {
      throw new Error(
        "ctx.tool.generate_media is not available in probe mode — requires a built web artifact",
      );
    },
  };

  const privilegedExecutor = createPrivilegedExecutor([], async () => {
    throw new Error(
      "ctx.executePrivileged is not available in probe mode — requires a built web artifact",
    );
  });

  return {
    slug: process.env.HATCH_SPACE_SLUG ?? DEFAULT_SLUG,
    invocationId,
    spaceDir: "/tmp/probe-mode-no-space-dir",
    db,
    agent,
    inference: createInferenceClient(),
    tool: instrumentToolClient(tool, invokedTools),
    blobs,
    executePrivileged: privilegedExecutor.executePrivileged,
    emit(_data: JsonValue): void {
      // discarded in probe mode (no transport)
    },
    invalidateQueries(_input?: SpaceQueryInvalidationInput): void {
      // no clients to invalidate in probe mode
    },
  };
}

async function readStdin(): Promise<string> {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buf += chunk;
  }
  return buf;
}

type SnippetHandler = (ctx: Ctx, z: typeof import("zod").z) => Promise<unknown>;

// Snippets come in as TypeScript — the prompt tells builders to paste real
// action code, which carries type annotations, `as const`, `satisfies`,
// generic params on calls, etc. The plain-JS `AsyncFunction` constructor
// can't parse any of those. Strip the TS via Bun's built-in transpiler
// (no extra dependency; this CLI is already bundled with `--target=bun`).
//
// Bun.Transpiler rejects top-level `return` because it treats input as a
// module, but the snippet body needs `return <value>` to surface a result.
// Work around that by wrapping the snippet as a named async-arrow `var`
// declaration before transpile (legal at module top level), then loading
// the transpiled JS through `Function(...)("ctx","z") → handler` so the
// snippet's `return` lands inside a real function body.
//
// `Bun` is always present in the bundled probe runtime, but keep a
// defensive fallback: if it's somehow missing, fall back to the plain-JS
// path so JS-only snippets still work and TS-only syntax fails with a
// normal parse error.
function buildHandler(snippet: string): SnippetHandler {
  const bun = (globalThis as {
    Bun?: {
      Transpiler: new (opts: { loader: string }) => {
        transformSync(src: string): string;
      };
    };
  }).Bun;

  if (!bun) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AsyncFunction: new (...args: string[]) => SnippetHandler =
      Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction("ctx", "z", snippet);
  }

  const wrapped = `var __probe = async (ctx, z) => {\n${snippet}\n};`;
  const transpiled = new bun.Transpiler({ loader: "ts" }).transformSync(wrapped);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(`${transpiled}\nreturn __probe;`);
  return factory() as SnippetHandler;
}

async function main(): Promise<number> {
  const snippet = (await readStdin()).trim();
  if (!snippet) {
    process.stderr.write(
      [
        "usage: bun probe-ctx.js < snippet.ts",
        "",
        "  Snippet runs as the body of an async (ctx, z) => { ... } function.",
        "  TypeScript syntax (type annotations, `as const`, `satisfies`) is",
        "  stripped before evaluation, so you can paste real action code.",
        "  Use `return <value>` to surface a result (JSON-stringified to stdout).",
        "  ctx.inference and ctx.tool are live; ctx.db and ctx.agent throw.",
        "",
      ].join("\n"),
    );
    return 2;
  }

  let handler: SnippetHandler;
  try {
    handler = buildHandler(snippet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`probe snippet parse error: ${msg}\n`);
    return 1;
  }

  const invokedTools = new Set<string>();
  const ctx = buildProbeCtx(invokedTools);
  let result: unknown;
  try {
    result = await handler(ctx, z);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`probe snippet runtime error: ${msg}\n`);
    emitInvokedToolSchemas(invokedTools);
    return 1;
  }

  emitInvokedToolSchemas(invokedTools);

  let serialized: string;
  try {
    serialized = JSON.stringify(result === undefined ? null : result, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`probe result is not JSON-serializable: ${msg}\n`);
    return 1;
  }
  process.stdout.write(serialized + "\n");
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`probe-ctx fatal: ${msg}\n`);
      process.exit(2);
    },
  );
}
