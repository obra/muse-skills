// Browser-side surface of @hatch/space-sdk.
//
// Imported as `@hatch/space-sdk/client` from a space's `client/src/api.ts`:
//
//   import type { Actions } from "../../server/src/actions";
//   import { createActionClient } from "@hatch/space-sdk/client";
//
//   export const api = createActionClient<typeof Actions>();
//
// `import type { Actions }` is type-only by design — the browser bundle
// never pulls in any server runtime.

// Side-effect import of the SDK's foundational space-container styles.
// Every TS space imports `@hatch/space-sdk/client`, so this pulls the
// shared styles into each space's CSS bundle via Bun's side-effect handling.
// The `../styles.css` path is preserved through `tsc` and resolves from
// the compiled `dist/client.js` to the SDK package root's `styles.css`.
import "../styles.css";

import { QueryClient } from "@tanstack/react-query";
import type { ZodType } from "zod";

import type { ActionRequest, ActionResponse } from "./index";

export { SafeAreaTopScrim } from "./client/safe-area";
export type {
  SafeAreaTopScrimProps,
  SafeAreaTopScrimVariant,
} from "./client/safe-area";

export { bytesToBase64, fileToBase64 } from "./client/file-encoding";

/**
 * Error thrown by a {@link createActionClient} call when the daemon returns a
 * non-OK HTTP response. Carries the HTTP `status` so retry policy can tell a
 * permanent client error (4xx) apart from retryable backpressure/transient
 * failures, and the server's `Retry-After` (when present) as `retryAfterMs` so
 * the backoff honors it.
 */
export class SpaceActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly retrySafe = false,
  ) {
    super(message);
    this.name = "SpaceActionError";
  }
}

// Actions can write even when invoked by useQuery. A failed connection or
// gateway response cannot prove that the handler did not commit a write.
export const PERMANENT_ACTION_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422]);

/** Retries after the first failure for a retryable action error. */
export const MAX_ACTION_RETRIES = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

/**
 * Default retry predicate for Space action queries, used by
 * {@link spaceQueryClient}. Retry only explicit pre-invocation failures, with
 * bounded backoff. Per-query overrides must preserve this outcome boundary.
 */
export function shouldRetryAction(
  failureCount: number,
  error: unknown,
): boolean {
  if (
    error instanceof SpaceActionError &&
    PERMANENT_ACTION_STATUSES.has(error.status)
  ) {
    return false;
  }
  return error instanceof SpaceActionError && error.retrySafe && failureCount < MAX_ACTION_RETRIES;
}

/**
 * Retry delay for Space action queries: exponential backoff with full jitter,
 * honoring the server's `Retry-After` (carried on {@link SpaceActionError}) as
 * a floor. Full jitter de-synchronizes clients so a recovering worker pool is
 * not hit by a synchronized retry herd. `failureCount` is the number of prior
 * failures (0 before the first retry).
 */
export function actionRetryDelay(failureCount: number, error: unknown): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failureCount);
  const floor =
    error instanceof SpaceActionError && error.retryAfterMs != null
      ? Math.min(RETRY_CAP_MS, Math.max(0, error.retryAfterMs))
      : 0;
  // Wait at least as long as the server asked, then add full jitter on top.
  return floor + Math.random() * ceiling;
}

/**
 * Shared TanStack Query client for every Muse Space.
 *
 * This singleton is the only way a space should obtain a `QueryClient`. The
 * build pipeline's client validator forbids local `new QueryClient(...)`
 * construction so defaults (cache lifetime, retry policy, refetch behavior)
 * stay tunable here in one place across the entire fleet. The defaults below
 * are deliberately conservative: stock TanStack defaults (retry: 3,
 * staleTime: 0, refetchOnWindowFocus: true) let a saturated worker pool turn
 * one overloaded Space client into a fleet-visible retry storm.
 *
 *   import { spaceQueryClient } from "@hatch/space-sdk/client";
 *   import { QueryClientProvider } from "@tanstack/react-query";
 *
 *   <QueryClientProvider client={spaceQueryClient}>
 *     <App />
 *   </QueryClientProvider>
 */
export const spaceQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryAction,
      retryDelay: actionRetryDelay,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Global the UI audit reads to know when this artifact has finished loading.
 *
 * The audit used to guess: `networkidle` plus a fixed settle, and any test the
 * builder wrote had to guess again with its own `waitFor` timeouts. Both guesses
 * are unnecessary — the artifact's data layer knows the answer. Every scaffolded
 * artifact renders through this one `spaceQueryClient`, so exposing its in-flight
 * count makes settling exact for the whole population without a single artifact
 * opting in, and lets the audit report "still fetching after Ns" instead of
 * screenshotting a spinner and calling it a page.
 *
 * Introspection only: it returns a count and mutates nothing, so it is safe on a
 * published artifact. Installed at module scope because the audit must not depend
 * on the artifact remembering to call anything.
 */
const AUDIT_SETTLE_GLOBAL = "__hatchAuditSettle";

export function installAuditSettleProbe(
  queryClient: QueryClient = spaceQueryClient,
): void {
  if (typeof window === "undefined") return;
  const target = window as unknown as Record<string, unknown>;
  if (typeof target[AUDIT_SETTLE_GLOBAL] === "function") return;
  target[AUDIT_SETTLE_GLOBAL] = (): number =>
    queryClient.isFetching() + queryClient.isMutating();
}

installAuditSettleProbe();

const SPACE_QUERY_INVALIDATED_MESSAGE_TYPE = "hatch:space:query-invalidated";
const HATCH_SPACE_ACTION_AUTH_REFRESH_REQUIRED_MESSAGE =
  "hatch:space-action-auth-refresh-required";
const HATCH_SPACE_ACTION_AUTH_REFRESH_RESULT_MESSAGE =
  "hatch:space-action-auth-refresh-result";
const HATCH_SPACE_UNAVAILABLE_MESSAGE = "hatch:space-unavailable";
const HATCH_SPACE_UNAVAILABLE_REASON = "space_unavailable";
const HATCH_SPACE_ACTION_REFRESHABLE_FAILURE_CODES = [
  "notary_missing",
  "notary_expired",
  "notary_invalid",
  "credential_stale",
] as const;
const SPACE_ACTION_AUTH_REFRESH_TIMEOUT_MS = 10_000;
const LOCAL_ORIGIN_INVALIDATION_FALLBACK_MS = 1000;
const LOCAL_ACTION_CALL_RETENTION_MS = 30_000;
const RECENT_INVALIDATION_RETENTION_MS = 30_000;

type HatchSpaceActionRefreshableFailureCode =
  (typeof HATCH_SPACE_ACTION_REFRESHABLE_FAILURE_CODES)[number];

interface HatchSpaceActionAuthRefreshRequiredMessage {
  type: typeof HATCH_SPACE_ACTION_AUTH_REFRESH_REQUIRED_MESSAGE;
  reason: HatchSpaceActionRefreshableFailureCode;
  requestId: string;
}

interface HatchSpaceUnavailableMessage {
  type: typeof HATCH_SPACE_UNAVAILABLE_MESSAGE;
  reason: typeof HATCH_SPACE_UNAVAILABLE_REASON;
  actionCallId: string;
}

interface HatchSpaceActionAuthRefreshResultMessage {
  type?: unknown;
  requestId?: unknown;
  ok?: unknown;
  iframeSrc?: unknown;
  error?: unknown;
}

interface SpaceActionRefreshableErrorBody {
  error: {
    code: HatchSpaceActionRefreshableFailureCode;
    refreshable?: boolean;
  };
  authRefreshRequired?: boolean;
}

interface SpaceUnavailableErrorBody {
  error: {
    code: typeof HATCH_SPACE_UNAVAILABLE_REASON;
  };
}

type SpaceQueryInvalidatedMessage = {
  type?: unknown;
  payload?: {
    originActionCallId?: unknown;
    queryKeys?: unknown;
  };
};

function isSpaceQueryInvalidatedMessage(
  value: unknown,
): value is SpaceQueryInvalidatedMessage {
  return (
    typeof value === "object" &&
    value != null &&
    (value as SpaceQueryInvalidatedMessage).type ===
      SPACE_QUERY_INVALIDATED_MESSAGE_TYPE
  );
}

function isHatchSpaceActionRefreshableFailureCode(
  value: unknown,
): value is HatchSpaceActionRefreshableFailureCode {
  return HATCH_SPACE_ACTION_REFRESHABLE_FAILURE_CODES.includes(
    value as HatchSpaceActionRefreshableFailureCode,
  );
}

function isSpaceActionRefreshableErrorBody(
  value: unknown,
): value is SpaceActionRefreshableErrorBody {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error == null) {
    return false;
  }
  return isHatchSpaceActionRefreshableFailureCode(
    (error as { code?: unknown }).code,
  );
}

function isSpaceUnavailableErrorBody(
  value: unknown,
): value is SpaceUnavailableErrorBody {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error == null) {
    return false;
  }
  return (error as { code?: unknown }).code === HATCH_SPACE_UNAVAILABLE_REASON;
}

function notifySpaceActionAuthRefreshRequired(
  reason: HatchSpaceActionRefreshableFailureCode,
  requestId: string,
): boolean {
  if (typeof window === "undefined" || window.parent === window) {
    return false;
  }
  window.parent.postMessage(
    {
      type: HATCH_SPACE_ACTION_AUTH_REFRESH_REQUIRED_MESSAGE,
      reason,
      requestId,
    } satisfies HatchSpaceActionAuthRefreshRequiredMessage,
    "*",
  );
  return true;
}

function notifyHostSpaceUnavailable(actionCallId: string): boolean {
  if (typeof window === "undefined" || window.parent === window) {
    return false;
  }
  window.parent.postMessage(
    {
      type: HATCH_SPACE_UNAVAILABLE_MESSAGE,
      reason: HATCH_SPACE_UNAVAILABLE_REASON,
      actionCallId,
    } satisfies HatchSpaceUnavailableMessage,
    "*",
  );
  return true;
}

function isSpaceActionAuthRefreshResultMessage(
  value: unknown,
  requestId: string,
): value is HatchSpaceActionAuthRefreshResultMessage {
  return (
    typeof value === "object" &&
    value != null &&
    (value as HatchSpaceActionAuthRefreshResultMessage).type ===
      HATCH_SPACE_ACTION_AUTH_REFRESH_RESULT_MESSAGE &&
    (value as HatchSpaceActionAuthRefreshResultMessage).requestId === requestId
  );
}

function createRefreshRequestId(): string {
  return `refresh-${createActionCallId()}`;
}

function waitForSpaceActionAuthRefresh(
  reason: HatchSpaceActionRefreshableFailureCode,
): Promise<HatchSpaceActionAuthRefreshResultMessage> {
  const requestId = createRefreshRequestId();
  const refreshWindow = typeof window === "undefined" ? null : window;
  if (
    refreshWindow == null ||
    refreshWindow.parent === refreshWindow ||
    typeof refreshWindow.addEventListener !== "function" ||
    typeof refreshWindow.removeEventListener !== "function"
  ) {
    notifySpaceActionAuthRefreshRequired(reason, requestId);
    return Promise.reject(new Error("space action auth refresh is unavailable"));
  }

  return new Promise((resolve, reject) => {
    const timeout = refreshWindow.setTimeout(() => {
      cleanup();
      reject(new Error("space action auth refresh timed out"));
    }, SPACE_ACTION_AUTH_REFRESH_TIMEOUT_MS);

    const cleanup = () => {
      refreshWindow.clearTimeout(timeout);
      refreshWindow.removeEventListener("message", handleMessage);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== refreshWindow.parent) {
        return;
      }
      if (!isSpaceActionAuthRefreshResultMessage(event.data, requestId)) {
        return;
      }
      cleanup();
      if (event.data.ok === true) {
        resolve(event.data);
        return;
      }
      const error =
        typeof event.data.error === "string" && event.data.error.length > 0
          ? event.data.error
          : "space action auth refresh failed";
      reject(new Error(error));
    };

    refreshWindow.addEventListener("message", handleMessage);
    if (!notifySpaceActionAuthRefreshRequired(reason, requestId)) {
      cleanup();
      reject(new Error("space action auth refresh is unavailable"));
    }
  });
}

function endpointWithViewerAssertion(endpoint: string, iframeSrc: unknown): string | null {
  if (typeof iframeSrc !== "string" || iframeSrc.length === 0) {
    return null;
  }
  const baseHref = globalThis.location?.href ?? "https://hatch.invalid/";
  let viewerAssertion: string | null = null;
  try {
    viewerAssertion = new URL(iframeSrc, baseHref).searchParams.get(
      "viewer_assertion",
    );
  } catch {
    return null;
  }
  if (viewerAssertion == null || viewerAssertion.length === 0) {
    return null;
  }
  try {
    const actionUrl = new URL(endpoint, baseHref);
    actionUrl.searchParams.set("viewer_assertion", viewerAssertion);
    return actionUrl.toString();
  } catch {
    return null;
  }
}

function queryKeysFromMessage(
  message: SpaceQueryInvalidatedMessage,
): readonly unknown[][] | null {
  const queryKeys = message.payload?.queryKeys;
  if (!Array.isArray(queryKeys)) {
    return null;
  }
  return queryKeys.filter((queryKey): queryKey is unknown[] =>
    Array.isArray(queryKey),
  );
}

const localActionCalls = new Map<string, number>();
let spaceUnavailable = false;
type LocalInvalidationTarget = "all" | readonly unknown[];
const recentLocalInvalidations: Array<{
  target: LocalInvalidationTarget;
  tsMs: number;
}> = [];

function nowMs(): number {
  return Date.now();
}

function pruneRecentInvalidations(timestampMs: number): void {
  const cutoff = timestampMs - RECENT_INVALIDATION_RETENTION_MS;
  while (true) {
    const oldest = recentLocalInvalidations[0];
    if (oldest == null || oldest.tsMs >= cutoff) {
      break;
    }
    recentLocalInvalidations.shift();
  }
}

function queryKeyPartEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function queryKeyStartsWith(
  queryKey: readonly unknown[],
  prefix: readonly unknown[],
): boolean {
  if (prefix.length > queryKey.length) {
    return false;
  }
  return prefix.every((part, index) =>
    queryKeyPartEquals(part, queryKey[index]),
  );
}

function queryKeysOverlap(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return queryKeyStartsWith(left, right) || queryKeyStartsWith(right, left);
}

function invalidationTargetFromArgs(
  args: Parameters<QueryClient["invalidateQueries"]>,
): LocalInvalidationTarget | null {
  const [filters] = args;
  if (filters == null) {
    return "all";
  }
  if (Array.isArray(filters)) {
    return filters;
  }
  if (
    typeof filters === "object" &&
    filters != null &&
    "queryKey" in filters &&
    Array.isArray(filters.queryKey)
  ) {
    return filters.queryKey;
  }
  return "all";
}

function recordLocalInvalidation(target: LocalInvalidationTarget): void {
  const tsMs = nowMs();
  pruneRecentInvalidations(tsMs);
  recentLocalInvalidations.push({ target, tsMs });
}

function hasOverlappingLocalInvalidationSince(
  queryKey: readonly unknown[],
  sinceMs: number,
): boolean {
  const tsMs = nowMs();
  pruneRecentInvalidations(tsMs);
  return recentLocalInvalidations.some(
    (entry) =>
      entry.tsMs >= sinceMs &&
      (entry.target === "all" || queryKeysOverlap(queryKey, entry.target)),
  );
}

function hasAnyLocalInvalidationSince(sinceMs: number): boolean {
  const tsMs = nowMs();
  pruneRecentInvalidations(tsMs);
  return recentLocalInvalidations.some((entry) => entry.tsMs >= sinceMs);
}

function rememberLocalActionCall(actionCallId: string): void {
  const startedAtMs = nowMs();
  localActionCalls.set(actionCallId, startedAtMs);
  if (typeof window === "undefined") {
    return;
  }
  window.setTimeout(() => {
    if (localActionCalls.get(actionCallId) === startedAtMs) {
      localActionCalls.delete(actionCallId);
    }
  }, LOCAL_ACTION_CALL_RETENTION_MS);
}

function markSpaceUnavailable(actionCallId: string): void {
  if (spaceUnavailable) {
    return;
  }
  spaceUnavailable = true;
  void spaceQueryClient.cancelQueries();
  notifyHostSpaceUnavailable(actionCallId);
}

function throwIfSpaceUnavailable(): void {
  if (!spaceUnavailable) {
    return;
  }
  throw new SpaceActionError("Space is no longer available", 404);
}

function originActionCallIdFromMessage(
  message: SpaceQueryInvalidatedMessage,
): string | null {
  const value = message.payload?.originActionCallId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function invalidateFromBridge(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  originActionCallId: string | null,
): void {
  const localStartedAtMs =
    originActionCallId == null
      ? undefined
      : localActionCalls.get(originActionCallId);
  if (localStartedAtMs == null) {
    void invalidateQueryFromBridge(queryClient, queryKey);
    return;
  }

  if (hasOverlappingLocalInvalidationSince(queryKey, localStartedAtMs)) {
    return;
  }

  window.setTimeout(() => {
    if (hasOverlappingLocalInvalidationSince(queryKey, localStartedAtMs)) {
      return;
    }
    void invalidateQueryFromBridge(queryClient, queryKey);
  }, LOCAL_ORIGIN_INVALIDATION_FALLBACK_MS);
}

function invalidateAllFromBridge(
  queryClient: QueryClient,
  originActionCallId: string | null,
): void {
  const localStartedAtMs =
    originActionCallId == null
      ? undefined
      : localActionCalls.get(originActionCallId);
  if (localStartedAtMs == null) {
    void invalidateAllQueriesFromBridge(queryClient);
    return;
  }

  if (hasAnyLocalInvalidationSince(localStartedAtMs)) {
    return;
  }

  window.setTimeout(() => {
    if (hasAnyLocalInvalidationSince(localStartedAtMs)) {
      return;
    }
    void invalidateAllQueriesFromBridge(queryClient);
  }, LOCAL_ORIGIN_INVALIDATION_FALLBACK_MS);
}

const rawInvalidateQueries = spaceQueryClient.invalidateQueries.bind(spaceQueryClient);
spaceQueryClient.invalidateQueries = ((...args) => {
  const target = invalidationTargetFromArgs(args);
  if (target != null) {
    recordLocalInvalidation(target);
  }
  return rawInvalidateQueries(...args);
}) as QueryClient["invalidateQueries"];

function invalidateQueryFromBridge(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): ReturnType<QueryClient["invalidateQueries"]> {
  if (queryClient === spaceQueryClient) {
    return rawInvalidateQueries({ queryKey });
  }
  return queryClient.invalidateQueries({ queryKey });
}

function invalidateAllQueriesFromBridge(
  queryClient: QueryClient,
): ReturnType<QueryClient["invalidateQueries"]> {
  if (queryClient === spaceQueryClient) {
    return rawInvalidateQueries();
  }
  return queryClient.invalidateQueries();
}

let queryInvalidationListenerInstalled = false;

export function installSpaceQueryInvalidationListener(
  queryClient: QueryClient = spaceQueryClient,
): void {
  if (queryInvalidationListenerInstalled || typeof window === "undefined") {
    return;
  }
  queryInvalidationListenerInstalled = true;

  window.addEventListener("message", (event) => {
    // NOTE(tec27): When framed, we don't check for same origin because Spaces are served on their
    // own subdomains (with a separate base domain from the hatch frontend). The VM has to be
    // provided with a short-lived notary token to load these in the first place, so we can safely
    // assume that anyone that was allowed to frame us is authorized to do so + send us messages.
    // The event.source === window.parent check is still useful though: only the thing framing us
    // can send messages, not popups, sibling frames, etc.
    //
    // When top-level (e.g. a Space opened directly via its share URL), the framing-trust argument
    // doesn't apply — any cross-origin opener that holds a window handle could otherwise spam
    // invalidations and trigger refetch churn against the Space backend — so we fall back to a
    // strict same-origin check.
    if (window.parent !== window) {
      if (event.source !== window.parent) {
        return;
      }
    } else if (event.origin !== window.location.origin) {
      return;
    }
    if (!isSpaceQueryInvalidatedMessage(event.data)) {
      return;
    }

    const originActionCallId = originActionCallIdFromMessage(event.data);
    const queryKeys = queryKeysFromMessage(event.data);
    if (queryKeys == null) {
      return;
    }
    if (queryKeys.length === 0) {
      invalidateAllFromBridge(queryClient, originActionCallId);
      return;
    }
    for (const queryKey of queryKeys) {
      invalidateFromBridge(queryClient, queryKey, originActionCallId);
    }
  });
}

installSpaceQueryInvalidationListener();

/**
 * Request shape for an action on a typed action client, by name.
 *
 *     import { api } from "./api";
 *     import type { ApiRequest } from "@hatch/space-sdk/client";
 *     type Filter = ApiRequest<typeof api, "listArticles">;
 */
export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

/**
 * Response shape for an action on a typed action client, by name.
 *
 *     import { api } from "./api";
 *     import type { ApiResponse } from "@hatch/space-sdk/client";
 *     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
 */
export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

// Structural client view of an action. The client only needs `request` and
// `response` for type extraction — it never invokes `handler` — so the
// constraint deliberately omits it. Including `handler` would force `Req`
// invariant via its `args: z.infer<Req>` parameter and break
// `createActionClient<typeof Actions>()` for any module with non-empty
// request/response schemas.
type ClientActionShape = { request: ZodType; response: ZodType };

export type ActionClient<A extends Record<string, ClientActionShape>> = {
  [K in keyof A]: (args: ActionRequest<A[K]>) => Promise<ActionResponse<A[K]>>;
};

interface ClientOptions {
  /** Override the action endpoint (defaults to `./actions` resolved against `location.href`). */
  endpoint?: string;
  /** Inject a custom fetch (mostly for tests). */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_ENDPOINT = "./actions";

function resolveEndpoint(relative: string): string {
  const href = globalThis.location?.href;
  if (typeof href !== "string" || href.length === 0) {
    return relative;
  }
  const base = new URL(href);
  base.hash = "";
  base.search = "";
  return new URL(relative, base).toString();
}

export function createActionClient<A extends Record<string, ClientActionShape>>(
  options: ClientOptions = {},
): ActionClient<A> {
  const endpoint = options.endpoint ?? resolveEndpoint(DEFAULT_ENDPOINT);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const callAction = (
    action: string,
    args: unknown,
    actionEndpoint: string,
    actionCallId: string,
  ) =>
    fetchImpl(actionEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Belt-and-suspenders request correlation: the agent.meta.ai proxy
        // strips this header (the daemon falls back to the body `actionCallId`),
        // but we still send it for environments that preserve it.
        "x-request-id": actionCallId,
      },
      body: JSON.stringify({
        action,
        args: args ?? {},
        actionCallId,
      }),
    });
  const readActionData = async (response: Response, name: string): Promise<unknown> => {
    const body = (await response.json()) as { data?: unknown; error?: string };
    if (body && typeof body === "object" && "error" in body && body.error) {
      throw new Error(`action ${name} error: ${String(body.error)}`);
    }
    return (body as { data: unknown }).data;
  };
  return new Proxy({} as ActionClient<A>, {
    get(_target, name) {
      // Symbol keys (Symbol.toPrimitive, Symbol.iterator, etc.) and
      // promise-protocol property names (then/catch/finally) must NOT
      // resolve to a phantom action. If `then` returned a function, any
      // accidental `await client` or `Promise.resolve(client)` would
      // see a thenable and call our function with (resolve, reject) as
      // its args — firing a network POST to a non-existent action named
      // "then". Same hazard for `catch`/`finally` in some
      // promise-chaining utilities.
      if (typeof name !== "string") {
        return undefined;
      }
      if (name === "then" || name === "catch" || name === "finally") {
        return undefined;
      }
      return async (args: unknown) => {
        throwIfSpaceUnavailable();
        const actionCallId = createActionCallId();
        rememberLocalActionCall(actionCallId);
        const response = await callAction(name, args, endpoint, actionCallId);
        if (!response.ok) {
          const body = await readActionErrorBody(response);
          if (
            response.status === 404 &&
            isSpaceUnavailableErrorBody(body)
          ) {
            markSpaceUnavailable(actionCallId);
            // A space_unavailable 404 is terminal. Throw the canonical error
            // for this first failing call too, so it matches every later
            // latched call instead of leaking the raw server body.
            throwIfSpaceUnavailable();
          }
          if (isSpaceActionRefreshableErrorBody(body)) {
            const refreshResult = await waitForSpaceActionAuthRefresh(
              body.error.code,
            );
            // The handler may have committed a write before needing a VM
            // credential. Refresh authentication, but replay only when the
            // server explicitly guarantees the handler never started.
            if (!("retrySafe" in body) || body.retrySafe !== true) {
              throw new SpaceActionError(
                "Your session has been refreshed. Reload the app to check whether your changes were saved before trying again.",
                409,
              );
            }
            const retryEndpoint = endpointWithViewerAssertion(
              endpoint,
              refreshResult.iframeSrc,
            );
            if (retryEndpoint == null) {
              throw new Error(
                `action ${name} auth refresh did not return a fresh viewer_assertion`,
              );
            }
            throwIfSpaceUnavailable();
            const retryResponse = await callAction(
              name,
              args,
              retryEndpoint,
              actionCallId,
            );
            if (!retryResponse.ok) {
              const retryBody = await readActionErrorBody(retryResponse);
              if (
                retryResponse.status === 404 &&
                isSpaceUnavailableErrorBody(retryBody)
              ) {
                markSpaceUnavailable(actionCallId);
                throwIfSpaceUnavailable();
              }
              const retryText =
                typeof retryBody === "string"
                  ? retryBody
                  : JSON.stringify(retryBody ?? null);
              throw new SpaceActionError(
                `action ${name} failed after auth refresh: ${retryResponse.status} ${retryText}`,
                retryResponse.status,
                parseRetryAfterMs(retryResponse),
                isActionRetrySafe(retryBody),
              );
            }
            return readActionData(retryResponse, name);
          }
          const text =
            typeof body === "string" ? body : JSON.stringify(body ?? null);
          throw new SpaceActionError(
            `action ${name} failed: ${response.status} ${text}`,
            response.status,
            parseRetryAfterMs(response),
            isActionRetrySafe(body),
          );
        }
        return readActionData(response, name);
      };
    },
  });
}

function isActionRetrySafe(body: unknown): boolean {
  return body !== null && typeof body === "object" && "retrySafe" in body && body.retrySafe === true;
}

// Parse a `Retry-After` response header (RFC 7231 delta-seconds or HTTP-date)
// into milliseconds-from-now. Returns undefined when absent/unparseable.
function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw == null) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

async function readActionErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return "";
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function createActionCallId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `space-action-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}
