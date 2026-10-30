import { drizzle } from "drizzle-orm/d1";
import { ActionRequestError, readActionRequest } from "./action-request";
import { admitSharedAction, sharedStateAvailable, SharedStateUnavailable, type SharedDatabase } from "./shared-state";
import { runSharedDataOperation, SHARED_DATA_PROTOCOL } from "./shared-data";
import {
  READ_ONLY_ACTIONS_PATH,
  READ_ONLY_DENIAL_MESSAGE,
  readOnlyBlobs,
  readOnlyDatabase,
} from "./read-only-access";
import {
  createPrivilegedExecutor,
  isAction,
  type AgentClient,
  type ActionDefinition,
  type BlobClient,
  type BlobMetadata,
  type BlobPutData,
  type Ctx,
  type InferenceClient,
  type SpaceDb,
  type SpaceToolClient,
  type CloudflareViewer as Viewer,
  z,
} from "./sdk";

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

class SpaceActionForbiddenError extends Error {
  code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SpaceActionForbiddenError";
    this.code = code;
  }
}

/**
 * The forbidden error behind `error`. Drizzle wraps a driver error as the
 * `cause` of a `DrizzleQueryError` whose message carries the SQL and its
 * parameters, so respond with the forbidden error's own message.
 */
function spaceActionForbiddenCause(error: unknown): SpaceActionForbiddenError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof SpaceActionForbiddenError) return current;
    current = current.cause;
  }
  return null;
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
  actionCallId: string | undefined,
  readOnly: boolean,
): Ctx {
  let db: SpaceDb | null = null;
  const viewer = viewerFromHeaders(request.headers);
  const invocationId = actionCallId ?? crypto.randomUUID();
  const privilegedExecutor = createPrivilegedExecutor(action.privileged, () =>
    vmCapabilityUnavailable("ctx.executePrivileged"),
  );
  // Agent, inference, tool and privileged calls are unavailable in shared
  // artifacts, so a view-only recipient's data access is the DB and blobs,
  // guarded here.
  const denyWrite = (): never => {
    throw new SpaceActionForbiddenError(READ_ONLY_DENIAL_MESSAGE);
  };
  const blobs = createBlobClient(env);
  return {
    slug,
    invocationId,
    spaceDir: "",
    viewer,
    agent: createAgentClient(),
    inference: createInferenceClient(),
    tool: createToolClient(),
    db: () => {
      db ??= drizzle(
        (readOnly ? readOnlyDatabase(env.DB as never, denyWrite) : env.DB) as never,
      ) as unknown as SpaceDb;
      return db;
    },
    blobs: readOnly ? readOnlyBlobs(blobs, denyWrite) : blobs,
    executePrivileged: privilegedExecutor.executePrivileged,
    invalidateQueries(): void {
      // Cloudflare Spaces serve actions remotely; viewer clients refetch on
      // action completion, so invalidation is currently a compatibility no-op.
    },
  };
}

// Shared artifacts cannot reach the owner's VM. The browser SDK treats 403
// as permanent: no retry and no credential refresh.
function vmCapabilityUnavailable(capability: string): never {
  throw new SpaceActionForbiddenError(
    `${capability} is not available in shared web artifacts`,
    "shared_artifact_vm_capability_unavailable",
  );
}

function createInferenceClient(): InferenceClient {
  return {
    async complete() {
      return vmCapabilityUnavailable("ctx.inference.complete");
    },
  };
}

function createToolClient(): SpaceToolClient {
  return {
    async weather() {
      return vmCapabilityUnavailable("ctx.tool.weather");
    },
    async sports_data() {
      return vmCapabilityUnavailable("ctx.tool.sports_data");
    },
    async finance() {
      return vmCapabilityUnavailable("ctx.tool.finance");
    },
    async finance_ticker() {
      return vmCapabilityUnavailable("ctx.tool.finance_ticker");
    },
    async web_search() {
      return vmCapabilityUnavailable("ctx.tool.web_search");
    },
  };
}

function createAgentClient(): AgentClient {
  return {
    async spawnTask() {
      return vmCapabilityUnavailable("ctx.agent.spawnTask");
    },
    async send() {
      return vmCapabilityUnavailable("ctx.agent.send");
    },
    async status() {
      return vmCapabilityUnavailable("ctx.agent.status");
    },
  };
}

// --- Blob key/path helpers ---

export function normalizeBlobKey(key: string): string {
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

export function r2Key(visibility: BlobVisibility, key: string): string {
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

// `checkedPut` replaces file writes on integrity-checked builds, for the
// owner VM's shared-data writes as it does inside actions.
export function createWorker(
  actionsExport: unknown,
  slug: string,
  checkedPut?: BlobClient["put"],
): WorkerModule {
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

      const readOnly = url.pathname === READ_ONLY_ACTIONS_PATH;
      if (url.pathname !== "/actions" && !readOnly) return jsonResponse({ error: "Not found" }, 404);
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      const body = await readActionRequest(request);
      if ("kind" in body && body.kind === "shared_data") {
        // The owner's VM runs this app's actions locally and keeps the data
        // here; nobody else may reach the database directly.
        if (readOnly || viewer?.isOwner !== true) {
          return jsonResponse({ error: "Only the app's owner can use its data directly" }, 403);
        }
        finish = await admitSharedAction(env.DB);
        const blobs = createBlobClient(env);
        if (checkedPut !== undefined) blobs.put = checkedPut;
        try {
          const data = await runSharedDataOperation(env.DB as never, blobs, body.operation);
          return jsonResponse({ data, version: 1, protocol: SHARED_DATA_PROTOCOL });
        } catch (error) {
          // The file checker is down and nothing was written: a platform
          // outage the VM may retry, not an unknown outcome or an app error.
          if (error instanceof Error && error.message === "upload_integrity:unavailable") {
            return jsonResponse(
              { error: "File checks are temporarily unavailable.", code: "upload_check_unavailable", retrySafe: true },
              503,
            );
          }
          throw error;
        }
      }
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

      // The read-only wrappers do not cover direct fetches from handlers.
      // Every handler must remain counted until all its awaited effects settle.
      finish = await admitSharedAction(env.DB);
      const data = await action.handler(
        createCtx(
          slug,
          env,
          request,
          action,
          normalizeActionCallId(body.actionCallId),
          readOnly,
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
      const forbidden = spaceActionForbiddenCause(error);
      if (forbidden) {
        return jsonResponse({ error: forbidden.message, code: forbidden.code }, 403);
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
