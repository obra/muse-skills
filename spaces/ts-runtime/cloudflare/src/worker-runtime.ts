import { drizzle } from "drizzle-orm/d1";
import { ActionRequestError, readActionRequest } from "./action-request";
import { admitSharedAction, sharedStateAvailable, SharedStateUnavailable, type SharedDatabase } from "./shared-state";
import {
  createPrivilegedExecutor,
  inferenceOptionsToPayload,
  isAction,
  isHatchSpaceActionRefreshableFailureCode,
  isSpaceActionAuthRefreshRequiredError,
  SpaceActionAuthRefreshRequiredError,
  z,
  type AgentClient,
  type AgentSendOptions,
  type AgentSendResult,
  type AgentStatusResult,
  type ActionDefinition,
  type BlobClient,
  type BlobMetadata,
  type BlobPutData,
  type Ctx,
  type InferenceClient,
  type InferenceCompleteOptions,
  type JsonValue,
  type PrivilegedContract,
  type PrivilegedRequest,
  type SpaceDb,
  type SpaceToolClient,
  type ToolFinanceOptions,
  type ToolSearchResponse,
  type ToolWeatherOptions,
  type CloudflareViewer as Viewer,
} from "./sdk";
import {
  buildToolContent,
  normalizeTicker,
  type SearchResult,
} from "../../worker/src/search_builders";

type R2PutOptions = {
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
};

type R2ListOptions = {
  prefix?: string;
  cursor?: string;
};

type R2Object = {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
};

type R2ObjectBody = R2Object & {
  body: ReadableStream<Uint8Array> | null;
};

type R2Bucket = {
  put(key: string, value: BlobPutData, options: R2PutOptions & { onlyIf: { etagDoesNotMatch: string } }): Promise<R2Object | null>;
  put(key: string, value: BlobPutData, options?: R2PutOptions): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
  list(options?: R2ListOptions): Promise<{
    objects: R2Object[];
    truncated?: boolean;
    cursor?: string;
  }>;
};

type CloudflareEnv = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  BUCKET: R2Bucket;
  DB: SharedDatabase;
  SPACE_SHORTCODE?: string;
  SPACE_ACTION_CREDENTIAL_EXPIRES_AT_MS?: string;
  SPACE_ACTION_CREDENTIAL_REFRESH_AFTER_MS?: string;
  SPACE_ACTION_NOTARY_TOKEN?: string;
  SPACE_ACTION_SPACE_SLUG?: string;
  SPACE_ACTION_VM_ID?: string;
  SPACE_ACTION_EDGE_HOST?: string;
  SPACE_VERSION?: string;
};

type WorkerExecutionContext = { waitUntil(promise: Promise<unknown>): void };

type WorkerModule = {
  fetch(request: Request, env: CloudflareEnv, execution: WorkerExecutionContext): Promise<Response>;
};

type ActionsExport = Record<string, unknown>;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const viewerHeaders = {
  authenticated: "x-cloudflare-spaces-viewer-authenticated",
  shareId: "x-cloudflare-spaces-share-id",
  spaceSlug: "x-cloudflare-spaces-space-slug",
  spaceId: "x-cloudflare-spaces-space-id",
  viewerFbid: "x-cloudflare-spaces-viewer-fbid",
  ownerFbid: "x-cloudflare-spaces-owner-fbid",
  isOwner: "x-cloudflare-spaces-is-owner",
  tokenExpiresAt: "x-cloudflare-spaces-token-exp",
  tokenId: "x-cloudflare-spaces-token-jti",
  displayName: "x-cloudflare-spaces-viewer-display-name",
} as const;

const defaultBlobContentType = "application/octet-stream";
const defaultBlobExpiresSeconds = 600;
const SPACE_ACTION_SDK_INFERENCE_PATH_SUFFIX = "_sdk/inference";
const SPACE_ACTION_SDK_TOOL_CALL_PATH_SUFFIX = "_sdk/tool-call";
const SPACE_ACTION_SDK_AGENT_PATH_SUFFIX = "_sdk/agent";
const SPACE_ACTION_SDK_PRIVILEGED_PATH_SUFFIX = "_sdk/privileged";

class SpaceActionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceActionForbiddenError";
  }
}

function isSpaceActionForbiddenError(error: unknown): error is SpaceActionForbiddenError {
  return error instanceof SpaceActionForbiddenError;
}

// --- HMAC blob token signing (Web Crypto) ---

const BLOB_SIGNING_KEY_R2_PATH = "_internal/blob-signing-key.json";

async function loadOrCreateBlobSigningKey(bucket: R2Bucket): Promise<CryptoKey> {
  let existing = await bucket.get(BLOB_SIGNING_KEY_R2_PATH);
  if (!existing) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key_b64 = btoa(String.fromCharCode(...raw));
    const created = await bucket.put(BLOB_SIGNING_KEY_R2_PATH, JSON.stringify({ key_b64 }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (created) {
      return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    }
    // Concurrent initialization has one winner. Every invocation uses that
    // persisted key; existing links must never be invalidated by a losing put.
    existing = await bucket.get(BLOB_SIGNING_KEY_R2_PATH);
  }
  if (!existing) throw new Error("Blob signing key is unavailable");
  const persisted = await new Response(existing.body).json() as { key_b64?: unknown };
  if (typeof persisted.key_b64 !== "string") throw new Error("Invalid blob signing key");
  const raw = Uint8Array.from(atob(persisted.key_b64), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("Invalid blob signing key");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

interface BlobTokenPayload {
  key: string;
  etag: string;
  exp: number;
}

async function signBlobToken(
  signingKey: CryptoKey,
  key: string,
  etag: string,
  expiresInSeconds: number,
): Promise<{ token: string; exp: number }> {
  const exp = Date.now() + expiresInSeconds * 1000;
  const payload: BlobTokenPayload = { key, etag, exp };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = btoa(String.fromCharCode(...payloadBytes));
  const sig = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { token: `${payloadB64}.${sigB64}`, exp };
}

async function verifyBlobToken(
  signingKey: CryptoKey,
  token: string,
): Promise<BlobTokenPayload | null> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;
  const payloadB64 = token.slice(0, dotIndex);
  const sigB64 = token.slice(dotIndex + 1);
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    signingKey,
    sigBytes,
    new TextEncoder().encode(payloadB64),
  );
  if (!valid) return null;
  try {
    const payloadBytes = Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as BlobTokenPayload;
    if (typeof payload.key !== "string" || typeof payload.etag !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Helpers ---

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

function normalizeActionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function normalizeActionCallId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return undefined;
  }
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

function requireHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`Missing viewer header: ${name}`);
  }
  return value;
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}

function decodeOptionalHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value ? decodeURIComponent(value) : undefined;
}

export function viewerFromHeaders(headers: Headers): Viewer | undefined {
  if (headers.get(viewerHeaders.authenticated) !== "1") {
    return undefined;
  }

  const tokenExpiresAt = Number(requireHeader(headers, viewerHeaders.tokenExpiresAt));
  if (!Number.isFinite(tokenExpiresAt)) {
    throw new Error(`Invalid viewer header: ${viewerHeaders.tokenExpiresAt}`);
  }
  const spaceId = optionalHeader(headers, viewerHeaders.spaceId);
  const displayName = decodeOptionalHeader(headers, viewerHeaders.displayName);
  const isOwner = requireHeader(headers, viewerHeaders.isOwner);
  if (isOwner !== "true" && isOwner !== "false") throw new Error("Invalid viewer owner flag");

  return {
    source: "cloudflare",
    authenticated: true,
    shareId: requireHeader(headers, viewerHeaders.shareId),
    spaceSlug: requireHeader(headers, viewerHeaders.spaceSlug),
    ...(spaceId !== undefined ? { spaceId } : {}),
    viewerFbid: requireHeader(headers, viewerHeaders.viewerFbid),
    ownerFbid: requireHeader(headers, viewerHeaders.ownerFbid),
    isOwner: isOwner === "true",
    tokenExpiresAt,
    tokenId: requireHeader(headers, viewerHeaders.tokenId),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

type CloudflareActionDefinition = ActionDefinition;

function buildActionMap(actionsExport: unknown): Map<string, CloudflareActionDefinition> {
  if (
    typeof actionsExport !== "object" ||
    actionsExport === null ||
    Array.isArray(actionsExport)
  ) {
    throw new Error("Actions export must be an object");
  }

  const actions = new Map<string, CloudflareActionDefinition>();
  for (const [name, candidate] of Object.entries(actionsExport as ActionsExport)) {
    if (!isAction(candidate)) {
      continue;
    }
    actions.set(name, candidate as CloudflareActionDefinition);
    actions.set(normalizeActionName(name), candidate as CloudflareActionDefinition);
  }
  return actions;
}

function createCtx(
  slug: string,
  env: CloudflareEnv,
  request: Request,
  action: CloudflareActionDefinition,
  actionName: string,
  actionCallId: string | undefined,
): Ctx {
  let db: SpaceDb | null = null;
  const viewer = viewerFromHeaders(request.headers);
  const invocationId = actionCallId ?? crypto.randomUUID();
  const privilegedExecutor = createPrivilegedExecutor(
    action.privileged,
    createPrivilegedTransport(env, viewer, invocationId, actionName),
  );
  return {
    slug,
    invocationId,
    spaceDir: "",
    viewer,
    agent: createAgentClient(env, viewer, invocationId, actionName),
    inference: createInferenceClient(env, viewer, invocationId, actionName),
    tool: createToolClient(env, viewer, invocationId, actionName),
    db: () => {
      db ??= drizzle(env.DB as never) as unknown as SpaceDb;
      return db;
    },
    blobs: createBlobClient(env),
    executePrivileged: privilegedExecutor.executePrivileged,
    invalidateQueries(): void {
      // Cloudflare Spaces serve actions remotely; viewer clients refetch on
      // action completion, so invalidation is currently a compatibility no-op.
    },
  };
}

interface SpaceActionCredentialStatus {
  readonly spaceShortcode: string;
  readonly spaceSlug: string;
  readonly vmId: string;
  readonly edgeHost: string;
  readonly notaryToken: string;
}

function requiredEnvString(env: CloudflareEnv, name: keyof CloudflareEnv): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

// The per-VM FQDN is being retired, so the callback target is no longer parsed
// out of a hostname: the deploy/refresh contract now ships the VM uuid and edge
// host as explicit bindings (SPACE_ACTION_VM_ID + SPACE_ACTION_EDGE_HOST). We
// validate both — vm_id is the shared edge's only routing key, and edge_host is
// the TLS-terminating VIP we dial — so a malformed binding fails as a refreshable
// credential error rather than producing a bad callback URL.
const SPACE_ACTION_VM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shared-VIP allowlist — NOT a loose `*.metaaivm.com` matcher: a per-VM FQDN
// (`<uuid>.metaaivm.com`, being retired) must NOT be accepted as an edge host.
// Accepts only the prod VIP and its non-prod counterpart.
const SPACE_ACTION_EDGE_HOST_RE = /^hatch\.(?:test-only\.)?metaaivm\.com$/i;
const DEFAULT_SPACE_ACTION_EDGE_HOST = "hatch.metaaivm.com";

function credentialStatusFromEnv(env: CloudflareEnv): SpaceActionCredentialStatus {
  const spaceShortcode = requiredEnvString(env, "SPACE_SHORTCODE");
  const spaceSlug = requiredEnvString(env, "SPACE_ACTION_SPACE_SLUG");
  const vmId = requiredEnvString(env, "SPACE_ACTION_VM_ID").toLowerCase();
  const edgeHost =
    requiredEnvString(env, "SPACE_ACTION_EDGE_HOST").toLowerCase() ||
    DEFAULT_SPACE_ACTION_EDGE_HOST;
  const notaryToken = requiredEnvString(env, "SPACE_ACTION_NOTARY_TOKEN");
  const expiresAtMs = Number(
    requiredEnvString(env, "SPACE_ACTION_CREDENTIAL_EXPIRES_AT_MS"),
  );
  const refreshAfterMs = Number(
    requiredEnvString(env, "SPACE_ACTION_CREDENTIAL_REFRESH_AFTER_MS"),
  );

  if (
    spaceShortcode.length === 0 ||
    spaceSlug.length === 0 ||
    !SPACE_ACTION_VM_ID_RE.test(vmId) ||
    !SPACE_ACTION_EDGE_HOST_RE.test(edgeHost) ||
    notaryToken.length === 0 ||
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(refreshAfterMs)
  ) {
    throw new SpaceActionAuthRefreshRequiredError("notary_missing");
  }

  const nowMs = Date.now();
  if (expiresAtMs <= nowMs) {
    throw new SpaceActionAuthRefreshRequiredError("notary_expired");
  }
  if (refreshAfterMs <= nowMs) {
    throw new SpaceActionAuthRefreshRequiredError("credential_stale");
  }

  return { spaceShortcode, spaceSlug, vmId, edgeHost, notaryToken };
}

function notaryAuthorizationHeader(notaryToken: string): string {
  return notaryToken.startsWith("endorsement.")
    ? notaryToken
    : `endorsement.${notaryToken}`;
}

// Build the CF→VM callback URL on the shared edge. Unlike a per-VM FQDN
// (`<uuid>.metaaivm.com`, which routed by hostname), the edge host is shared
// across VMs and routes to one only by the `vm_id` query param. Both inputs come
// straight from validated credential bindings — no hostname parsing — so the VM
// uuid stays valid even after the per-VM FQDN/DNS is retired. TLS terminates at
// the edge; the notary endorsement (not the transport cert) remains the CF→VM
// trust anchor. Mirrors hatch's `toSharedLbVmHttpUrl` (app/_lib/hatchGatewayUrl.ts).
export function toSharedLbVmCallbackUrl(
  edgeHost: string,
  vmId: string,
  vmPath: string,
): string {
  const url = new URL(`https://${edgeHost}${vmPath}`);
  url.searchParams.set("vm_id", vmId); // exactly one, server-resolved; drops any client value
  return url.toString();
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function refreshableCodeFromVmError(body: unknown): string | null {
  if (typeof body !== "object" || body == null) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error == null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function createInferenceClient(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  actionInvocationId: string,
  actionName: string,
): InferenceClient {
  return {
    async complete<T extends z.ZodType>(
      prompt: string,
      options: InferenceCompleteOptions<T>,
    ): Promise<z.infer<T>> {
      if (viewer?.isOwner !== true) {
        throw new SpaceActionForbiddenError(
          "Cloudflare space action inference requires owner viewer",
        );
      }
      const status = credentialStatusFromEnv(env);
      const vmPath = `/spaces/v2/${encodeURIComponent(
        status.spaceSlug,
      )}/${SPACE_ACTION_SDK_INFERENCE_PATH_SUFFIX}`;
      const payload: JsonValue = {
        operation: "complete",
        prompt,
        options: inferenceOptionsToPayload(options),
        actionInvocationId,
        actionName,
      };
      const requestBody = JSON.stringify(payload);
      const callbackRequest = {
        body_sha256: await sha256Base64Url(requestBody),
        capability: "inference",
        method: "POST",
        nonce: crypto.randomUUID(),
        path: vmPath,
        space: status.spaceShortcode,
        ts: Math.floor(Date.now() / 1000),
        payload,
      };
      const response = await fetch(toSharedLbVmCallbackUrl(status.edgeHost, status.vmId, vmPath), {
        method: "POST",
        headers: {
          authorization: notaryAuthorizationHeader(status.notaryToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(callbackRequest),
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        const code = refreshableCodeFromVmError(body);
        if (isHatchSpaceActionRefreshableFailureCode(code)) {
          throw new SpaceActionAuthRefreshRequiredError(code);
        }
        if (response.status === 401 || response.status === 403) {
          throw new SpaceActionAuthRefreshRequiredError("notary_invalid");
        }
        throw new Error(
          `inference callback failed: ${response.status} ${JSON.stringify(body)}`,
        );
      }
      const parsed = options.schema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`inference callback response did not match schema: ${parsed.error.message}`);
      }
      return parsed.data as z.infer<T>;
    },
  };
}

type ToolMethod = "weather" | "sports_data" | "finance" | "finance_ticker" | "web_search";
type ToolCallOptions = ToolFinanceOptions & ToolWeatherOptions;

async function callVmTool(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  tool: ToolMethod,
  query: string,
  options: ToolCallOptions,
  actionInvocationId: string,
  actionName: string,
): Promise<ToolSearchResponse> {
  if (viewer?.isOwner !== true) {
    throw new SpaceActionForbiddenError(
      "Cloudflare space action tool calls require owner viewer",
    );
  }
  const status = credentialStatusFromEnv(env);
  const vmPath = `/spaces/v2/${encodeURIComponent(
    status.spaceSlug,
  )}/${SPACE_ACTION_SDK_TOOL_CALL_PATH_SUFFIX}`;
  const payload: JsonValue = {
    operation: "search",
    tool,
    query,
    options: options as unknown as JsonValue,
    actionInvocationId,
    actionName,
  };
  const requestBody = JSON.stringify(payload);
  const callbackRequest = {
    body_sha256: await sha256Base64Url(requestBody),
    capability: "tool_call",
    method: "POST",
    nonce: crypto.randomUUID(),
    path: vmPath,
    space: status.spaceShortcode,
    ts: Math.floor(Date.now() / 1000),
    payload,
  };
  const response = await fetch(toSharedLbVmCallbackUrl(status.edgeHost, status.vmId, vmPath), {
    method: "POST",
    headers: {
      authorization: notaryAuthorizationHeader(status.notaryToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(callbackRequest),
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const code = refreshableCodeFromVmError(body);
    if (isHatchSpaceActionRefreshableFailureCode(code)) {
      throw new SpaceActionAuthRefreshRequiredError(code);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SpaceActionAuthRefreshRequiredError("notary_invalid");
    }
    throw new Error(
      `tool call callback failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  // The daemon `_sdk/tool-call` route returns the raw web-search response with
  // `content: null` — it carries only `summary`/`metadata`, and the typed
  // `content` is mapped client-side. The local bun worker does this in
  // `createToolClient`; here we run the SAME shared builder so both runtimes
  // return identical `content`. Without this, a published Cloudflare Space
  // reading e.g. `ctx.tool.web_search(...).content.results` would get `null` and
  // break, even though it works locally.
  const raw = body as unknown as SearchResult;
  // Weather and finance selectors are applied to the complete series already
  // in the response, so both runtimes must forward them to the shared builder.
  const buildOptions =
    tool === "weather"
      ? { hourly_hours: options.hourly_hours }
      : tool === "finance_ticker"
        ? { symbol: normalizeTicker(query), interval: options.interval, since: options.since, until: options.until }
        : tool === "finance"
          ? { interval: options.interval, since: options.since, until: options.until }
          : undefined;
  return { ...raw, content: buildToolContent(tool, raw, buildOptions) } as ToolSearchResponse;
}

function createToolClient(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  actionInvocationId: string,
  actionName: string,
): SpaceToolClient {
  return {
    weather(query, options = {}) {
      return callVmTool(env, viewer, "weather", query, options, actionInvocationId, actionName);
    },
    sports_data(query, options = {}) {
      return callVmTool(
        env,
        viewer,
        "sports_data",
        query,
        options,
        actionInvocationId,
        actionName,
      );
    },
    finance(query, options = {}) {
      return callVmTool(env, viewer, "finance", query, options, actionInvocationId, actionName);
    },
    finance_ticker(symbol, options = {}) {
      // Validate up front (fail-fast) so a multi-ticker string is rejected
      // before paying for a finance search — parity with the local worker.
      const ticker = normalizeTicker(symbol);
      return callVmTool(
        env,
        viewer,
        "finance_ticker",
        ticker,
        options,
        actionInvocationId,
        actionName,
      );
    },
    web_search(query, options = {}) {
      return callVmTool(
        env,
        viewer,
        "web_search",
        query,
        options,
        actionInvocationId,
        actionName,
      );
    },
  };
}

type AgentOperationPayload = JsonValue;

async function callVmPrivileged(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  payload: JsonValue,
): Promise<unknown> {
  if (viewer?.isOwner !== true) {
    throw new SpaceActionForbiddenError(
      "Cloudflare space action privileged functions require owner viewer",
    );
  }
  const status = credentialStatusFromEnv(env);
  const vmPath = `/spaces/v2/${encodeURIComponent(
    status.spaceSlug,
  )}/${SPACE_ACTION_SDK_PRIVILEGED_PATH_SUFFIX}`;
  const requestBody = JSON.stringify(payload);
  const callbackRequest = {
    body_sha256: await sha256Base64Url(requestBody),
    capability: "privileged",
    method: "POST",
    nonce: crypto.randomUUID(),
    path: vmPath,
    space: status.spaceShortcode,
    ts: Math.floor(Date.now() / 1000),
    payload,
  };
  const response = await fetch(toSharedLbVmCallbackUrl(status.edgeHost, status.vmId, vmPath), {
    method: "POST",
    headers: {
      authorization: notaryAuthorizationHeader(status.notaryToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(callbackRequest),
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const code = refreshableCodeFromVmError(body);
    if (isHatchSpaceActionRefreshableFailureCode(code)) {
      throw new SpaceActionAuthRefreshRequiredError(code);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SpaceActionAuthRefreshRequiredError("notary_invalid");
    }
    throw new Error(
      `privileged callback failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function createPrivilegedTransport(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  actionInvocationId: string,
  actionName: string,
) {
  return async function execute<C extends PrivilegedContract>(
    contract: C,
    args: PrivilegedRequest<C>,
  ): Promise<unknown> {
    return await callVmPrivileged(env, viewer, {
      operation: "call",
      actionName,
      actionInvocationId,
      contractName: contract.name,
      args: args as unknown as JsonValue,
    });
  };
}

async function callVmAgent(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  payload: AgentOperationPayload,
): Promise<unknown> {
  if (viewer?.isOwner !== true) {
    throw new SpaceActionForbiddenError(
      "Cloudflare space action agent tasks require owner viewer",
    );
  }
  const status = credentialStatusFromEnv(env);
  const vmPath = `/spaces/v2/${encodeURIComponent(
    status.spaceSlug,
  )}/${SPACE_ACTION_SDK_AGENT_PATH_SUFFIX}`;
  const requestBody = JSON.stringify(payload);
  const callbackRequest = {
    body_sha256: await sha256Base64Url(requestBody),
    capability: "agent",
    method: "POST",
    nonce: crypto.randomUUID(),
    path: vmPath,
    space: status.spaceShortcode,
    ts: Math.floor(Date.now() / 1000),
    payload,
  };
  const response = await fetch(toSharedLbVmCallbackUrl(status.edgeHost, status.vmId, vmPath), {
    method: "POST",
    headers: {
      authorization: notaryAuthorizationHeader(status.notaryToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(callbackRequest),
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const code = refreshableCodeFromVmError(body);
    if (isHatchSpaceActionRefreshableFailureCode(code)) {
      throw new SpaceActionAuthRefreshRequiredError(code);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SpaceActionAuthRefreshRequiredError("notary_invalid");
    }
    throw new Error(
      `agent callback failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function objectString(
  value: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const snakeValue = value[snakeKey];
  if (typeof snakeValue === "string") {
    return snakeValue;
  }
  const camelValue = value[camelKey];
  return typeof camelValue === "string" ? camelValue : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAgentTaskStatus(
  value: string | undefined,
): value is AgentStatusResult["status"] {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "not_found"
  );
}

function createAgentClient(
  env: CloudflareEnv,
  viewer: Viewer | undefined,
  actionInvocationId: string,
  actionName: string,
): AgentClient {
  let nextSpawnRequestOrdinal = 0;

  function nextSpawnRequestId(): string {
    nextSpawnRequestOrdinal += 1;
    return `space-agent-spawn:${actionInvocationId}:${nextSpawnRequestOrdinal}`;
  }

  async function spawnTask(
    message: string,
    options: AgentSendOptions = {},
  ): Promise<AgentSendResult> {
    const normalizedMessage = normalizeOptionalText(message);
    if (normalizedMessage === undefined) {
      return { ok: false, error: "a Space task requires a non-empty message" };
    }
    try {
      const expectedAction = normalizeOptionalText(options.expectsAction);
      const dedupeKey = normalizeOptionalText(options.dedupeKey);
      const payload: JsonValue = {
        operation: "spawn_task",
        actionName,
        actionInvocationId,
        spawnRequestId: nextSpawnRequestId(),
        message: normalizedMessage,
        ...(expectedAction !== undefined ? { expectedAction } : {}),
        ...(dedupeKey !== undefined ? { dedupeKey } : {}),
        ...(options.allowParallel === true ? { allowParallel: true } : {}),
      };
      const body = await callVmAgent(env, viewer, payload);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return {
          ok: false,
          error: "starting a Space task did not return a task handle",
        };
      }
      const response = body as Record<string, unknown>;
      const taskId = objectString(response, "task_id", "taskId");
      const agentId = objectString(response, "agent_id", "agentId");
      const messageId = objectString(response, "message_id", "messageId");
      if (
        taskId === undefined ||
        agentId === undefined ||
        messageId === undefined
      ) {
        return {
          ok: false,
          error: "starting a Space task did not return a task handle",
        };
      }
      return { ok: true, taskId, agentId, messageId };
    } catch (error) {
      if (
        isSpaceActionAuthRefreshRequiredError(error) ||
        isSpaceActionForbiddenError(error)
      ) {
        throw error;
      }
      return { ok: false, error: errorMessage(error) };
    }
  }

  return {
    spawnTask,
    send(message, options) {
      return spawnTask(message, options);
    },
    async status(taskId: string): Promise<AgentStatusResult> {
      const normalizedTaskId = normalizeOptionalText(taskId);
      if (normalizedTaskId === undefined) {
        return { taskId, status: "not_found" };
      }
      const body = await callVmAgent(env, viewer, {
        operation: "status",
        taskId: normalizedTaskId,
      });
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("agent status callback response did not match schema");
      }
      const response = body as Record<string, unknown>;
      const status = objectString(response, "status", "status");
      if (!isAgentTaskStatus(status)) {
        throw new Error("agent status callback response did not match schema");
      }
      const returnContractStatus = objectString(
        response,
        "return_contract_status",
        "returnContractStatus",
      );
      const agentStatus = objectString(response, "agent_status", "agentStatus");
      const agentId = objectString(response, "agent_id", "agentId");
      const messageId = objectString(response, "message_id", "messageId");
      const finalResponse = objectString(
        response,
        "final_response",
        "finalResponse",
      );
      const statusMessage = objectString(
        response,
        "status_message",
        "statusMessage",
      );
      const failureReason = objectString(
        response,
        "failure_reason",
        "failureReason",
      );
      const expectedAction = objectString(
        response,
        "expected_action",
        "expectedAction",
      );
      const completedAction = objectString(
        response,
        "completed_action",
        "completedAction",
      );
      const result: AgentStatusResult = {
        taskId: objectString(response, "task_id", "taskId") ?? normalizedTaskId,
        status,
        ...(returnContractStatus === "not_expected" ||
        returnContractStatus === "pending" ||
        returnContractStatus === "satisfied" ||
        returnContractStatus === "unsatisfied"
          ? { returnContractStatus }
          : {}),
        ...(agentStatus !== undefined ? { agentStatus } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        ...(failureReason !== undefined ? { failureReason } : {}),
        ...(expectedAction !== undefined ? { expectedAction } : {}),
        ...(completedAction !== undefined ? { completedAction } : {}),
      };
      return result;
    },
  };
}

// --- Blob key/path helpers ---

function normalizeBlobKey(key: string): string {
  const normalized = key.trim();
  if (normalized.length === 0) {
    throw new Error("Blob key must not be empty");
  }
  if (normalized.startsWith("/")) {
    throw new Error("Blob key must not start with /");
  }
  if (normalized.includes("\\")) {
    throw new Error("Blob key must use / path separators");
  }
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error("Blob key must not contain empty, . or .. path segments");
    }
  }
  return normalized;
}

function normalizeBlobPrefix(prefix: string): string {
  if (prefix.length === 0) {
    return "";
  }
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (trimmed.length === 0) {
    return "";
  }
  return normalizeBlobKey(trimmed) + (prefix.endsWith("/") ? "/" : "");
}

// Carry the logical key through the URL as a single opaque base64url token
// (RFC 4648 §5, no padding). Like the VM-local runtime, this removes the lossy
// path round-trip for keys holding `%`, encoded slashes, or other reserved
// bytes. See docs/spaces-blob-key-roundtrip-fix.md.
function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecodeUtf8(token: string): string {
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function encodeBlobKeyToken(key: string): string {
  return base64UrlEncodeUtf8(normalizeBlobKey(key));
}

function decodeBlobKeyToken(encodedKey: string): string {
  // New opaque token: a single segment over the base64url alphabet.
  if (/^[A-Za-z0-9_-]+$/.test(encodedKey)) {
    try {
      return normalizeBlobKey(base64UrlDecodeUtf8(encodedKey));
    } catch {
      // Fall through to the legacy interpretation below. A bare-alphanumeric
      // legacy key would land here; real keys carry `/` or an extension, so
      // they take the legacy branch directly.
    }
  }
  // Legacy already-minted / browser-cached URLs: per-segment percent-encoded.
  return normalizeBlobKey(
    encodedKey
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/"),
  );
}

type BlobVisibility = "public" | "private";

function r2Key(visibility: BlobVisibility, key: string): string {
  return `blobs/${visibility}/${key}`;
}

function stripR2Prefix(r2Key: string): { visibility: BlobVisibility; key: string } | null {
  if (r2Key.startsWith("blobs/public/")) {
    return { visibility: "public", key: r2Key.slice("blobs/public/".length) };
  }
  if (r2Key.startsWith("blobs/private/")) {
    return { visibility: "private", key: r2Key.slice("blobs/private/".length) };
  }
  return null;
}

function metadataFromR2Object(object: R2Object): BlobMetadata {
  const parsed = stripR2Prefix(object.key);
  const visibility = parsed?.visibility ?? "private";
  const key = parsed?.key ?? object.key;
  const uploadedMs =
    object.uploaded instanceof Date ? object.uploaded.getTime() : Date.now();
  return {
    key,
    contentType: object.httpMetadata?.contentType ?? defaultBlobContentType,
    size: object.size,
    sizeBytes: object.size,
    etag: object.etag,
    visibility,
    createdAtMs: uploadedMs,
    updatedAtMs: uploadedMs,
    public: visibility === "public",
  };
}

// --- Blob client ---

function createBlobClient(env: CloudflareEnv): BlobClient {
  const bucket = env.BUCKET;
  let signingKeyPromise: Promise<CryptoKey> | null = null;

  function getSigningKey(): Promise<CryptoKey> {
    signingKeyPromise ??= loadOrCreateBlobSigningKey(bucket);
    return signingKeyPromise;
  }

  async function resolveObject(
    key: string,
  ): Promise<{ r2Key: string; visibility: BlobVisibility; etag: string } | null> {
    const pubKey = r2Key("public", key);
    const pubHead = await bucket.head(pubKey);
    if (pubHead) return { r2Key: pubKey, visibility: "public", etag: pubHead.etag };
    const privKey = r2Key("private", key);
    const privHead = await bucket.head(privKey);
    if (privHead) return { r2Key: privKey, visibility: "private", etag: privHead.etag };
    return null;
  }

  return {
    async put(key, data, options) {
      const normalizedKey = normalizeBlobKey(key);
      const contentType = options?.contentType ?? defaultBlobContentType;
      const visibility: BlobVisibility = options?.public === true ? "public" : "private";
      const oldVisibility: BlobVisibility = visibility === "public" ? "private" : "public";
      await bucket.delete(r2Key(oldVisibility, normalizedKey));
      await bucket.put(r2Key(visibility, normalizedKey), data, {
        httpMetadata: { contentType },
      });
    },
    async getUrl(key, options) {
      const normalizedKey = normalizeBlobKey(key);
      const resolved = await resolveObject(normalizedKey);
      if (!resolved) {
        throw new Error(`Blob not found: ${normalizedKey}`);
      }
      if (resolved.visibility === "public") {
        return `./blobs/public/${encodeBlobKeyToken(normalizedKey)}`;
      }
      const expiresIn = options?.expiresInSeconds ?? defaultBlobExpiresSeconds;
      const sk = await getSigningKey();
      const { token } = await signBlobToken(sk, normalizedKey, resolved.etag, expiresIn);
      return `./blobs/private/${encodeBlobKeyToken(normalizedKey)}?token=${encodeURIComponent(token)}`;
    },
    async delete(key) {
      const normalizedKey = normalizeBlobKey(key);
      await Promise.all([
        bucket.delete(r2Key("public", normalizedKey)),
        bucket.delete(r2Key("private", normalizedKey)),
      ]);
    },
    async head(key) {
      const normalizedKey = normalizeBlobKey(key);
      const resolved = await resolveObject(normalizedKey);
      if (!resolved) return null;
      const object = await bucket.head(resolved.r2Key);
      return object === null ? null : metadataFromR2Object(object);
    },
    async list(prefix = "") {
      const normalizedPrefix = normalizeBlobPrefix(prefix);
      const results: BlobMetadata[] = [];
      for (const vis of ["public", "private"] as const) {
        const r2Prefix = `blobs/${vis}/${normalizedPrefix}`;
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix: r2Prefix, cursor });
          results.push(...page.objects.map(metadataFromR2Object));
          cursor = page.truncated === true ? page.cursor : undefined;
        } while (cursor !== undefined);
      }
      const seen = new Set<string>();
      return results.filter((item) => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      });
    },
  };
}

// --- Blob download handler ---

async function handleBlobDownload(request: Request, env: CloudflareEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  let r2LookupKey: string;
  let requireToken = false;

  if (pathname.startsWith("/blobs/public/")) {
    const encodedKey = pathname.slice("/blobs/public/".length);
    try {
      r2LookupKey = r2Key("public", decodeBlobKeyToken(encodedKey));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid blob key";
      return jsonResponse({ error: message }, 400);
    }
  } else if (pathname.startsWith("/blobs/private/")) {
    requireToken = true;
    const encodedKey = pathname.slice("/blobs/private/".length);
    try {
      r2LookupKey = r2Key("private", decodeBlobKeyToken(encodedKey));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid blob key";
      return jsonResponse({ error: message }, 400);
    }
  } else {
    return jsonResponse({ error: "Invalid blob path" }, 400);
  }

  let tokenExpMs = 0;
  if (requireToken) {
    const token = url.searchParams.get("token");
    if (!token) {
      return jsonResponse({ error: "Missing blob token" }, 401);
    }
    const sk = await loadOrCreateBlobSigningKey(env.BUCKET);
    const payload = await verifyBlobToken(sk, token);
    if (!payload) {
      return jsonResponse({ error: "Invalid or expired blob token" }, 401);
    }
    const parsed = stripR2Prefix(r2LookupKey);
    if (!parsed || parsed.key !== payload.key) {
      return jsonResponse({ error: "Token does not match requested blob" }, 401);
    }
    const head = await env.BUCKET.head(r2LookupKey);
    if (!head) {
      return jsonResponse({ error: "Blob not found" }, 404);
    }
    if (head.etag !== payload.etag) {
      return jsonResponse({ error: "Token etag does not match blob" }, 401);
    }
    tokenExpMs = payload.exp;
  }

  const object = await env.BUCKET.get(r2LookupKey);
  if (object === null) {
    return jsonResponse({ error: "Blob not found" }, 404);
  }

  const metadata = metadataFromR2Object(object);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", metadata.contentType);
  // Uploaded documents must not execute with a viewer's app authority.
  headers.set("content-security-policy", "sandbox");
  headers.set("x-content-type-options", "nosniff");
  headers.set("etag", metadata.etag);
  headers.set("content-length", String(metadata.sizeBytes));
  let cacheControl: string;
  if (metadata.public) {
    cacheControl = "public, max-age=31536000, immutable";
  } else {
    const remainingSecs = Math.max(0, Math.floor((tokenExpMs - Date.now()) / 1000));
    cacheControl = `private, max-age=${remainingSecs}`;
  }
  headers.set("cache-control", cacheControl);

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

// --- Worker entrypoint ---

export function createWorker(actionsExport: unknown, slug: string): WorkerModule {
  const actions = buildActionMap(actionsExport);

  async function handleRequest(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);
    let finish: (() => Promise<void>) | undefined;
    let viewer: Viewer | undefined;
    try {
      if (actions.size > 0) {
        try { viewer = viewerFromHeaders(request.headers); } catch { /* Invalid trusted context is denied. */ }
        if (!viewer || !viewer.spaceId ||
            `${viewer.spaceSlug}-${viewer.spaceId}` !== env.SPACE_SHORTCODE ||
            (viewer.isOwner && viewer.viewerFbid !== viewer.ownerFbid)) {
          return jsonResponse({ error: "Sign in to open this shared app", code: "viewer_required" }, 401);
        }
        if (request.method === "GET" || request.method === "HEAD") {
          if (!await sharedStateAvailable(env.DB)) throw new SharedStateUnavailable();
        }
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        /^\/blobs\/(?:public|private)\//.test(url.pathname)
      ) {
        const response = await handleBlobDownload(request, env);
        if (actions.size > 0) response.headers.set("cache-control", "no-store");
        return response;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          if (actions.size === 0) return assetResponse;
          const response = new Response(assetResponse.body, assetResponse);
          response.headers.set("cache-control", "no-store");
          return response;
        }
      }

      if (url.pathname !== "/actions") return jsonResponse({ error: "Not found" }, 404);
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      const body = await readActionRequest(request);
      if ("kind" in body) {
        if (actions.size > 0 && !await sharedStateAvailable(env.DB)) throw new SharedStateUnavailable();
        const names = [...new Set([...actions.keys()].map(normalizeActionName))].sort();
        const data = names.map(action => ({
          slug,
          action,
          request_schema: z.toJSONSchema(actions.get(action)!.request, { io: "input", unrepresentable: "any" }),
        }));
        return jsonResponse({ data, version: 1 });
      }

      // Client-only web artifacts ship an empty action map: they are static
      // client bundles with no server surface. Make that explicit instead of
      // returning a generic "unknown action" for every POST.
      if (actions.size === 0) {
        return jsonResponse(
          { error: "This web artifact has no server actions" },
          404,
        );
      }

      const action =
        actions.get(body.action) ?? actions.get(normalizeActionName(body.action));
      if (action === undefined) {
        return jsonResponse({ error: `Unknown action: ${body.action}` }, 404);
      }

      const parsedArgs = action.request.safeParse(body.args);
      if (!parsedArgs.success) {
        return jsonResponse(
          {
            error: "Invalid action request",
            issues: parsedArgs.error.issues,
          },
          400,
        );
      }

      finish = await admitSharedAction(env.DB);
      const data = await action.handler(
        createCtx(
          slug,
          env,
          request,
          action,
          body.action,
          normalizeActionCallId(body.actionCallId),
        ),
        parsedArgs.data,
      );
      const parsedResponse = action.response.safeParse(data);
      if (!parsedResponse.success) {
        return jsonResponse(
          {
            error: "The app could not confirm the result. Reload to check your changes before trying again.",
            code: "action_outcome_unknown",
          },
          409,
        );
      }
      return jsonResponse({ data: parsedResponse.data, version: 1 });
    } catch (error) {
      if (error instanceof ActionRequestError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      if (error instanceof SharedStateUnavailable) {
        const response = jsonResponse({ error: error.message, code: "shared_state_busy", retrySafe: true }, 503);
        response.headers.set("retry-after", "3");
        return response;
      }
      if (isSpaceActionAuthRefreshRequiredError(error)) {
        return jsonResponse(
          { error: { code: error.code, refreshable: true }, authRefreshRequired: true, retrySafe: false },
          401,
        );
      }
      if (isSpaceActionForbiddenError(error)) {
        return jsonResponse({ error: error.message }, 403);
      }
      return finish
        ? jsonResponse({ error: "The app could not confirm the result. Reload to check your changes before trying again.", code: "action_outcome_unknown" }, 409)
        : jsonResponse({ error: "The app is temporarily unavailable. Please try again shortly.", code: "shared_state_unavailable", retrySafe: true }, 503);
    } finally {
      if (finish) await finish();
    }
  }

  return {
    fetch(request, env, execution) {
      const response = handleRequest(request, env);
      // Retain admission, effects, and cleanup through client disconnects.
      // Cloudflare limits this grace period to 30 seconds; work terminated
      // before cleanup remains recorded and must never be expired by guess.
      execution.waitUntil(response);
      return response;
    },
  };
}
