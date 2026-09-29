// TypeScript space worker entrypoint.
//
// Spawned by the daemon when `space.json -> runtime == "typescript"`. Reads
// the space's compiled actions module (server/dist/actions.js), builds a
// dispatch table from the named export `Actions`, and runs an NDJSON loop
// on stdin / FD 3 that the daemon's per-space supervisor speaks.
//
// Required env (set by the daemon):
//   HATCH_SPACE_DIR             absolute path to the space root
//   HATCH_SPACE_SLUG            published slug
//   HATCH_ACTION_PROTOCOL_FD    fd to write protocol frames to (typically 3)
//   HATCH_SPACE_DB_PATH         optional override; defaults to <space>/app.db
//   HATCH_API_SOCKET            preferred daemon connect path (Unix socket)
//   HATCH_API_URL               TCP fallback if no socket
//   HATCH_SPACE_INFERENCE_SOCKET daemon-owned length-prefixed JSON RPC socket
//   HATCH_SPACE_ACTION_TIMEOUT_MS enclosing daemon action deadline
//   HATCH_SPACE_INFERENCE_DEFAULT_TIMEOUT_MS inference budget inside that deadline
//   HATCH_SPACE_WEB_SEARCH_SOCKET daemon-owned length-prefixed JSON RPC socket for ctx.tool
//   HATCH_SPACE_PRIVILEGED_SOCKET daemon-owned length-prefixed JSON RPC socket for ctx.executePrivileged

import { existsSync } from "node:fs";
import { createReadStream, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import {
  createPrivilegedExecutor,
  isAction,
  type ActionDefinition,
  type Ctx,
  type JsonValue,
  type LocalViewer,
  type PrivilegedContract,
  type SpaceQueryInvalidationInput,
  type SpaceToolClient,
} from "@hatch/space-sdk";

import { openSpaceDb, type SpaceDb } from "./db";
import { createAgentClient } from "./agent";
import { createBlobClient } from "./blobs";
import { createInferenceClient } from "./inference";
import { createPrivilegedTransport } from "./privileged";
import { generateMedia } from "./space_media";
import { createToolClient } from "./web_search";
import {
  installInvocationFetchProxy,
  withInvocationProxyEnv,
} from "./invocation_env";
import {
  parseCommand,
  type InvokeCommand,
  type SpaceActionMetadata,
  type WorkerFrame,
} from "./protocol";
import { zodToJsonSchema } from "./schema";

const PROTOCOL_FD_ENV = "HATCH_ACTION_PROTOCOL_FD";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required worker environment variable ${name}`);
  }
  return value;
}

function resolveProtocolFd(): number {
  const raw = process.env[PROTOCOL_FD_ENV]?.trim();
  if (!raw) {
    return 1;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

const PROTOCOL_FD = resolveProtocolFd();

// Flipped during shutdown so any frame writes from in-flight handlers
// that race past the loop exit are silently dropped instead of throwing
// against a torn-down FD (the daemon supervisor closes our stdin to
// signal shutdown, and an in-flight `writeSync` against the matching
// closed protocol FD would surface as an unhandled rejection inside
// `Promise.allSettled`).
let protocolClosed = false;

function markProtocolClosed(): void {
  protocolClosed = true;
}

function writeFrame(frame: WorkerFrame): void {
  if (protocolClosed) {
    return;
  }
  writeSync(PROTOCOL_FD, JSON.stringify(frame) + "\n");
}

function emitReady(actions: string[], actionMetadata: SpaceActionMetadata[]): void {
  writeFrame({
    kind: "ready",
    actions: actions.slice().sort(),
    action_metadata: actionMetadata
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

function emitData(requestId: string, data: unknown): void {
  writeFrame({ kind: "data", request_id: requestId, data });
}

function emitEnd(requestId: string): void {
  writeFrame({ kind: "end", request_id: requestId });
}

function emitError(requestId: string, error: string): void {
  writeFrame({ kind: "error", request_id: requestId, error });
}

type QueryInvalidationState = {
  invalidateAll: boolean;
  queryKeys: JsonValue[][];
};

type NormalizedQueryInvalidation = "all" | JsonValue[][] | undefined;

function emitInvalidateQueries(
  requestId: string,
  invalidation: QueryInvalidationState,
): void {
  if (!invalidation.invalidateAll && invalidation.queryKeys.length === 0) {
    return;
  }
  writeFrame({
    kind: "invalidate_queries",
    request_id: requestId,
    query_keys: invalidation.invalidateAll ? [] : invalidation.queryKeys,
  });
}

// Mirror the daemon's slugifyActionName so HTTP route names map to the same
// dispatch keys regardless of whether the agent authored the export name as
// camelCase, snake_case, or kebab-case.
function slugifyActionName(raw: string): string {
  let normalized = "";
  let lastWasSeparator = true;
  for (const ch of raw.trim()) {
    if (/[A-Za-z0-9]/.test(ch)) {
      normalized += ch.toLowerCase();
      lastWasSeparator = false;
    } else if (!lastWasSeparator) {
      normalized += "_";
      lastWasSeparator = true;
    }
  }
  normalized = normalized.replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "action";
}

async function loadActions(spaceDir: string): Promise<Map<string, ActionDefinition>> {
  const compiled = join(spaceDir, "server", "dist", "actions.js");
  if (!existsSync(compiled)) {
    throw new Error(
      `artifact actions module not found at ${compiled}. Call the web_artifact_build tool to compile the bundle first.`,
    );
  }
  const mod = (await import(compiled)) as Record<string, unknown>;
  const actionsExport = mod.Actions ?? mod.default;
  if (!actionsExport || typeof actionsExport !== "object") {
    throw new Error(
      `artifact actions module at ${compiled} must export 'Actions' (a map of defineAction(...) values)`,
    );
  }
  const byName = new Map<string, ActionDefinition>();
  for (const [name, value] of Object.entries(actionsExport as Record<string, unknown>)) {
    if (isAction(value)) {
      byName.set(slugifyActionName(name), value);
    }
  }
  // A zero-action module is valid: client-only web artifacts ship an empty
  // `Actions` map. In production the daemon does not spawn a local worker for
  // them, but the worker must still come up cleanly (dev/CLI, or a server-backed
  // artifact mid-edit) and simply serve no invokable actions.
  return byName;
}

function buildActionMetadata(
  actionsByName: Map<string, ActionDefinition>,
): SpaceActionMetadata[] {
  return [...actionsByName.entries()].map(([name, definition]) => ({
    name,
    request_schema: zodToJsonSchema(definition.request),
  }));
}

function normalizeJsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 8) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];
    for (const item of value) {
      const normalizedItem = normalizeJsonValue(item, depth + 1);
      if (normalizedItem === undefined) {
        return undefined;
      }
      normalized.push(normalizedItem);
    }
    return normalized;
  }
  if (typeof value === "object" && value != null) {
    const normalized: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedItem = normalizeJsonValue(item, depth + 1);
      if (normalizedItem === undefined) {
        return undefined;
      }
      normalized[key] = normalizedItem;
    }
    return normalized;
  }
  return undefined;
}

function normalizeQueryKey(value: unknown): JsonValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    return undefined;
  }
  const normalized = normalizeJsonValue(value);
  return Array.isArray(normalized) ? normalized : undefined;
}

function normalizeQueryInvalidationInput(
  input: SpaceQueryInvalidationInput | undefined,
): NormalizedQueryInvalidation {
  const queryKeys: JsonValue[][] = [];

  if (input === undefined) {
    return "all";
  }

  if (Array.isArray(input)) {
    const queryKey = normalizeQueryKey(input);
    return queryKey == null ? undefined : [queryKey];
  }

  if (typeof input !== "object" || input == null) {
    return undefined;
  }

  if ("queryKey" in input) {
    const queryKey = normalizeQueryKey(input.queryKey);
    return queryKey == null ? undefined : [queryKey];
  }

  if ("queryKeys" in input && Array.isArray(input.queryKeys)) {
    for (const candidate of input.queryKeys.slice(0, 32)) {
      const queryKey = normalizeQueryKey(candidate);
      if (queryKey != null) {
        queryKeys.push(queryKey);
      }
    }
  }

  return queryKeys.length === 0 ? undefined : queryKeys;
}

function buildCtx(args: {
  slug: string;
  spaceDir: string;
  blobDir?: string;
  spaceDb: SpaceDb;
  invocationId: string;
  viewer?: LocalViewer;
  requestId: string;
  rootRequestId?: string;
  action: string;
  privileged?: readonly PrivilegedContract[];
  transport: InvokeCommand["transport"];
  queryInvalidation: QueryInvalidationState;
}): Ctx {
  const agent = createAgentClient({
    slug: args.slug,
    invocationId: args.invocationId,
    action: args.action,
    ...(args.rootRequestId !== undefined
      ? { rootRequestId: args.rootRequestId }
      : {}),
  });
  const inference = createInferenceClient(
    args.invocationId,
    args.action,
    args.rootRequestId,
  );
  const blobs = createBlobClient({
    spaceDir: args.spaceDir,
    blobDir: args.blobDir,
  });
  const privilegedExecutor = createPrivilegedExecutor(
    args.privileged,
    createPrivilegedTransport({
      actionInvocationId: args.invocationId,
      actionName: args.action,
      ...(args.rootRequestId !== undefined
        ? { rootRequestId: args.rootRequestId }
        : {}),
    }),
  );
  const searchTool = createToolClient(
    args.invocationId,
    args.action,
    args.rootRequestId,
  );
  const tool: SpaceToolClient = {
    ...searchTool,
    generate_media: (prompt, options) =>
      generateMedia(blobs, prompt, options, {
        actionInvocationId: args.invocationId,
        actionName: args.action,
        rootRequestId: args.rootRequestId,
      }),
  };
  return {
    slug: args.slug,
    invocationId: args.invocationId,
    spaceDir: args.spaceDir,
    db: args.spaceDb.accessor,
    ...(args.viewer !== undefined ? { viewer: args.viewer } : {}),
    agent,
    inference,
    tool,
    blobs,
    executePrivileged: privilegedExecutor.executePrivileged,
    emit(data: JsonValue): void {
      if (args.transport !== "stream") {
        return;
      }
      emitData(args.requestId, data);
    },
    invalidateQueries(input?: SpaceQueryInvalidationInput): void {
      const invalidation = normalizeQueryInvalidationInput(input);
      if (invalidation === undefined || args.queryInvalidation.invalidateAll) {
        return;
      }
      if (invalidation === "all") {
        args.queryInvalidation.invalidateAll = true;
        args.queryInvalidation.queryKeys = [];
        return;
      }
      args.queryInvalidation.queryKeys.push(...invalidation);
    },
  };
}

async function runInvocation(args: {
  command: InvokeCommand;
  actionsByName: Map<string, ActionDefinition>;
  slug: string;
  spaceDir: string;
  blobDir?: string;
  spaceDb: SpaceDb;
}): Promise<void> {
  const { command, actionsByName, slug, spaceDir, blobDir, spaceDb } = args;
  const normalized = slugifyActionName(command.action);
  const definition = actionsByName.get(normalized) ?? actionsByName.get(command.action);
  if (!definition) {
    emitError(command.request_id, `action '${command.action}' is not defined`);
    emitEnd(command.request_id);
    return;
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = definition.request.parse(command.args ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) {
      emitError(command.request_id, `invalid args: ${err.message}`);
    } else {
      emitError(command.request_id, String(err));
    }
    emitEnd(command.request_id);
    return;
  }

  const queryInvalidation: QueryInvalidationState = {
    invalidateAll: false,
    queryKeys: [],
  };
  const ctx = buildCtx({
    slug,
    spaceDir,
    blobDir,
    spaceDb,
    invocationId: command.invocation_id,
    viewer: command.viewer,
    requestId: command.request_id,
    rootRequestId: command.root_request_id,
    action: command.action,
    privileged: definition.privileged,
    transport: command.transport,
    queryInvalidation,
  });

  let invalidationsEmitted = false;
  const emitQueuedInvalidations = () => {
    if (invalidationsEmitted) {
      return;
    }
    invalidationsEmitted = true;
    emitInvalidateQueries(command.request_id, queryInvalidation);
  };

  try {
    const result = await withInvocationProxyEnv(command.proxy_env, async () =>
      definition.handler(ctx, parsedArgs as never),
    );
    emitQueuedInvalidations();
    const validated = definition.response.parse(result);
    emitData(command.request_id, validated as unknown);
    emitEnd(command.request_id);
  } catch (err) {
    emitQueuedInvalidations();
    if (err instanceof z.ZodError) {
      emitError(command.request_id, `response validation failed: ${err.message}`);
    } else {
      emitError(
        command.request_id,
        err instanceof Error ? err.message : String(err),
      );
    }
    emitEnd(command.request_id);
  }
}

async function main(): Promise<number> {
  const slug = requireEnv("HATCH_SPACE_SLUG");
  const spaceDir = resolve(requireEnv("HATCH_SPACE_DIR"));
  const dbPath = process.env.HATCH_SPACE_DB_PATH?.trim() || join(spaceDir, "app.db");
  const blobDir = process.env.HATCH_SPACE_BLOB_DIR?.trim() || undefined;

  installInvocationFetchProxy();

  let actionsByName: Map<string, ActionDefinition>;
  try {
    actionsByName = await loadActions(spaceDir);
  } catch (err) {
    process.stderr.write(`[ts-worker] failed to load actions: ${String(err)}\n`);
    return 1;
  }

  // One libsql client for the whole worker lifetime. Per-invocation opens
  // would leak FDs / WAL state across the worker's many invocations.
  const spaceDb = await openSpaceDb(dbPath);

  emitReady(Array.from(actionsByName.keys()), buildActionMetadata(actionsByName));

  const inFlight = new Map<string, Promise<void>>();
  const reader = createInterface({
    input: createReadStream("/dev/stdin", { fd: 0 }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let command;
    try {
      command = parseCommand(line);
    } catch (err) {
      process.stderr.write(`[ts-worker] bad command: ${String(err)}\n`);
      continue;
    }
    if (command.kind === "shutdown") {
      break;
    }
    if (command.kind === "cancel") {
      // Cooperative cancellation is not implemented yet; in-flight requests
      // run to completion. Safe because the daemon supervisor closes our
      // stdin and waits with a deadline before SIGKILL.
      continue;
    }
    const promise = runInvocation({
      command,
      actionsByName,
      slug,
      spaceDir,
      blobDir,
      spaceDb,
    }).finally(() => {
      inFlight.delete(command.request_id);
    });
    inFlight.set(command.request_id, promise);
  }

  // Mark the protocol FD as closing BEFORE we await stragglers. Any
  // emitData/emitEnd they fire after this point is dropped silently
  // — the FD may already be torn down by the daemon supervisor (which
  // closes our stdin to signal shutdown), and a writeSync against a
  // closed FD throws synchronously inside the in-flight handler's
  // outer try/catch where it would be lost in Promise.allSettled.
  markProtocolClosed();

  await Promise.allSettled(inFlight.values());
  await spaceDb.close();
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`[ts-worker] fatal: ${String(err)}\n`);
    process.exit(1);
  },
);
