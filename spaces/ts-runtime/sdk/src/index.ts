// Server-side surface of @hatch/space-sdk.
//
// Imported as `@hatch/space-sdk` from a space's `server/src/actions.ts`:
//
//   import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
//
//   export const Actions = {
//     listEntries: defineAction({
//       request: z.object({ limit: z.number() }),
//       response: z.object({ entries: z.array(z.string()) }),
//       async handler(ctx, args) { … },
//     }),
//   } satisfies ActionsModule;
//
// The browser-side counterpart lives at @hatch/space-sdk/client.

import {
  createDefineAction,
  createPrivilegedExecutor,
  definePrivilegedContracts,
  definePrivilegedHandlers,
  isAction as isSharedAction,
  isPrivilegedContract,
  isPrivilegedHandlers,
  z,
  type ActionDefinition as SharedActionDefinition,
  type ActionsModuleFor,
  type JsonValue,
  type PortableCtx,
} from "./server-contract";

export {
  ACTION_BRAND,
  PRIVILEGED_CONTRACT_BRAND,
  PRIVILEGED_HANDLERS_FORMAT,
  z,
  type ActionRequest,
  type ActionResponse,
  type BlobClient,
  type BlobMetadata,
  type BlobPutData,
  type BlobPutOptions,
  type BlobUrlOptions,
  type JsonValue,
  type PortableCtx,
  type PrivilegedContract,
  type PrivilegedContractSpec,
  type PrivilegedContractsFor,
  type PrivilegedExecutor,
  type PrivilegedHandler,
  type PrivilegedHandlerEntry,
  type PrivilegedHandlers,
  type PrivilegedHandlersFor,
  type PrivilegedRequest,
  type PrivilegedResponse,
  type PrivilegedTransport,
  type SpaceDb,
  type SpaceDbAccessor,
  type Viewer,
  type LocalViewer,
  type CloudflareViewer,
} from "./server-contract";

// Local handle for the `Ctx` interface below; the full set of these symbols
// is re-exported from `./verticals` further down.
import { type SpaceToolClient } from "./verticals";

export {
  createPrivilegedExecutor,
  definePrivilegedContracts,
  definePrivilegedHandlers,
  isPrivilegedContract,
  isPrivilegedHandlers,
};

/** React Query key that can be invalidated across open clients for this space. */
export type SpaceQueryKey = readonly JsonValue[];

export interface SpaceQueryInvalidation {
  readonly queryKey: SpaceQueryKey;
}

export interface SpaceQueryInvalidationBatch {
  readonly queryKeys: readonly SpaceQueryKey[];
}

export type SpaceQueryInvalidationInput =
  | SpaceQueryKey
  | SpaceQueryInvalidation
  | SpaceQueryInvalidationBatch;

/** Client for talking back to the main Muse agent that owns this space. */
export interface AgentSendOptions {
  /**
   * Space action that should be called by the spawned task to count as a
   * successful result. Status remains derived at read time; no durable task
   * state is created by this option.
   */
  readonly expectsAction?: string;
  /**
   * Semantic single-flight key for the spawned task. While a matching task is
   * active or recently terminal for the same Space action, the daemon returns
   * the existing task handle instead of starting duplicate background agent
   * work.
   */
  readonly dedupeKey?: string;
  /**
   * Disable automatic exact-message single-flight. Explicit `dedupeKey`
   * values are still honored.
   */
  readonly allowParallel?: boolean;
}

export type AgentSendResult =
  | {
      ok: true;
      taskId: string;
      agentId: string;
      messageId: string;
    }
  | { ok: false; error: string };

export interface AgentStatusResult {
  readonly taskId: string;
  readonly status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "not_found";
  readonly returnContractStatus?:
    | "not_expected"
    | "pending"
    | "satisfied"
    | "unsatisfied";
  readonly agentStatus?: string;
  readonly agentId?: string;
  readonly messageId?: string;
  /**
   * Contract-aware final text. If a task ends before satisfying
   * `expectsAction`, this is a safe failure message rather than the model's
   * unsupported last answer.
   */
  readonly finalResponse?: string;
  readonly statusMessage?: string;
  readonly failureReason?: string;
  readonly expectedAction?: string;
  readonly completedAction?: string;
}

/** Options for `ctx.agent.spawnTask`. Alias of {@link AgentSendOptions}. */
export type AgentTaskOptions = AgentSendOptions;

/** Result handle from `ctx.agent.spawnTask`. Alias of {@link AgentSendResult}. */
export type AgentTaskResult = AgentSendResult;

export interface AgentClient {
  /**
   * Start a background Space task: spawn a detached Muse agent that runs the
   * full agent loop (web search, web fetch, multi-step tool use) to do
   * open-ended work an action cannot do inline. Reach for this whenever a
   * Space needs general web research / search / browsing at runtime — those
   * tools are not on `ctx`, so a spawned task is the only way to use them.
   *
   * Returns as soon as the task is *accepted*, NOT when it finishes: the
   * result is `{ ok: true, taskId, ... }` (a handle), never the task's
   * answer. The results arrive via the `expectsAction` callback below;
   * `ctx.agent.status(taskId)` only reports lifecycle state
   * (queued/running/completed/failed), not the data.
   *
   * Pass `expectsAction: "<actionName>"` to have the task write its results
   * back by calling that Space action; the runtime injects the
   * call-this-action instruction for you, so you do not need to spell it out
   * in `message`. That action runs against the Space's live database like any
   * other action.
   *
   * Duplicate tasks with the same Space action and exact message are
   * single-flighted by default while active or recently terminal. Pass
   * `dedupeKey` when the semantic job key is known, or `allowParallel: true`
   * when identical concurrent work is intended.
   */
  spawnTask(
    message: string,
    options?: AgentTaskOptions,
  ): Promise<AgentTaskResult>;
  /**
   * @deprecated Prefer {@link spawnTask}, which names what this does. `send`
   * stays functional for compatibility with older Spaces that call it.
   */
  send(message: string, options?: AgentSendOptions): Promise<AgentSendResult>;
  /** Read the in-memory status for a task started by spawnTask()/send(). */
  status(taskId: string): Promise<AgentStatusResult>;
}

export interface InferenceCompleteOptions<T extends z.ZodType = z.ZodType> {
  /** Zod schema the model output is validated against. Required. */
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
  readonly images?: readonly InferenceImageInput[];
}

export interface InferenceImageInput {
  readonly dataBase64: string;
  readonly mimeType?: "image/jpeg" | "image/png";
  readonly filename?: string;
  readonly caption?: string;
}

/**
 * Brand string carried on every `InferenceSchemaError` instance. Same
 * pattern as `ACTION_BRAND`: bundle-stable string identity, so cross-bundle
 * recognition via `InferenceSchemaError.is(e)` works even when the worker
 * and the user's `actions.js` were bundled with separate copies of the SDK
 * (which is the normal case — each `bun build` inlines the SDK into its own
 * output).
 */
export const INFERENCE_SCHEMA_ERROR_BRAND =
  "@hatch/space-sdk/InferenceSchemaError/v1" as const;

/**
 * Thrown when the model's structured response does not satisfy the Zod
 * schema passed to `complete()`. Inspect `issues` for the per-path
 * validation failures.
 *
 * **Use `InferenceSchemaError.is(e)` for the catch check, not
 * `e instanceof InferenceSchemaError`.** The worker that throws this error
 * and the user `actions.js` that catches it are separate bundles with
 * separate class identities; `instanceof` would return `false` even when the
 * error did come from a failed schema validation. `is()` does an
 * `instanceof` first (same-bundle fast path) then falls back to a stable
 * brand string check.
 */
export class InferenceSchemaError extends Error {
  /** @internal — branded property; check via `InferenceSchemaError.is(e)`. */
  readonly __brand: typeof INFERENCE_SCHEMA_ERROR_BRAND =
    INFERENCE_SCHEMA_ERROR_BRAND;
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(
      `Inference output failed schema validation (${issues.length} issue${
        issues.length === 1 ? "" : "s"
      })`,
    );
    this.name = "InferenceSchemaError";
    this.issues = issues;
  }

  /**
   * Type guard that recognizes both same-bundle instances and cross-bundle
   * shapes carrying the documented brand. Prefer this over
   * `instanceof InferenceSchemaError` in space `actions.ts` code, because
   * the worker bundle and the user actions bundle inline separate copies of
   * the SDK and therefore have separate class identities.
   */
  static is(value: unknown): value is InferenceSchemaError {
    if (value instanceof InferenceSchemaError) return true;
    return (
      typeof value === "object" &&
      value !== null &&
      "__brand" in value &&
      (value as { __brand: unknown }).__brand ===
        INFERENCE_SCHEMA_ERROR_BRAND &&
      "issues" in value &&
      Array.isArray((value as { issues: unknown }).issues)
    );
  }
}

export interface InferenceClient {
  /**
   * Direct completion for bounded model-only work.
   *
   * Use for classification, extraction, summarization, formatting, or structured
   * generation from data already in hand, including optional JPEG/PNG image
   * attachments. Does not browse the web, call tools, run an agent loop, or
   * perform research — use `ctx.agent.spawnTask(...)` for that.
   *
   * The Zod `schema` is required. It is converted to JSON Schema and enforced by
   * the managed runtime as the output contract, and the response is validated
   * against the same schema before being returned. Keep the prompt focused on
   * the task rather than asking for JSON or repeating the schema. On validation
   * failure this throws `InferenceSchemaError`. The returned value is the typed,
   * parsed shape — never call `JSON.parse` on it.
   *
   *   const { bullets } = await ctx.inference.complete("summarize", {
   *     schema: z.object({ bullets: z.array(z.string()).min(1).max(4) }),
   *   });
   *
   * To catch schema-validation failures, prefer the static type guard
   * `InferenceSchemaError.is(e)` over `e instanceof InferenceSchemaError`.
   * The worker and the user `actions.js` are separate bundles with separate
   * class identities, so `instanceof` would miss the error even when the
   * SDK did throw `InferenceSchemaError`.
   */
  complete<T extends z.ZodType>(
    prompt: string,
    options: InferenceCompleteOptions<T>,
  ): Promise<z.infer<T>>;
}

// Managed-search vertical schemas plus their request/response types. These are
// defined in `./verticals` (the single source of truth, also consumed by the
// worker) and re-exported here so spaces import them from `@hatch/space-sdk`.
export {
  TOOL_FINANCE_RESULT_SCHEMA,
  TOOL_FINANCE_SCHEMA,
  TOOL_FINANCE_TICKER_RESULT_SCHEMA,
  TOOL_FINANCE_TICKER_SCHEMA,
  TOOL_SPORTS_DATA_RESULT_SCHEMA,
  TOOL_SPORTS_DATA_SCHEMA,
  TOOL_WEATHER_RESULT_SCHEMA,
  TOOL_WEATHER_SCHEMA,
  TOOL_WEB_SEARCH_RESULT_SCHEMA,
  TOOL_WEB_SEARCH_SCHEMA,
  type GeneratedMedia,
  type GenerateMediaOptions,
  type GenerateMediaOrientation,
  type SpaceToolClient,
  type ToolFinanceInterval,
  type ToolFinanceOptions,
  type ToolFinanceResult,
  type ToolFinanceTickerResult,
  type ToolSearchLocation,
  type ToolSearchOptions,
  type ToolSearchResponse,
  type ToolSearchVertical,
  type ToolSportsDataResult,
  type ToolWeatherOptions,
  type ToolWeatherResult,
  type ToolWebSearchResult,
} from "./verticals";

/** Per-invocation context passed to every action handler. */
export interface Ctx extends PortableCtx {
  readonly agent: AgentClient;
  readonly inference: InferenceClient;
  readonly tool: SpaceToolClient;
  /** Emit a streaming frame. No-op on non-streaming actions. */
  emit(data: JsonValue): void;
  /**
   * Signal every open client for this Space to refetch React Query data. Call
   * this from successful mutating actions or async-task completion actions
   * after durable data changes. Passing a query key is supported for advanced
   * targeted invalidation; omitting the argument invalidates the whole Space
   * query client.
   */
  invalidateQueries(invalidation?: SpaceQueryInvalidationInput): void;
}

export type ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> = SharedActionDefinition<Ctx, Req, Res>;

export function isAction(value: unknown): value is ActionDefinition {
  return isSharedAction(value);
}

/**
 * Define a single action. The schemas drive both runtime validation (in the
 * worker) and static typing (on the client via `createActionClient`).
 */
export const defineAction = createDefineAction<Ctx>();

/**
 * The shape every space's `actions.ts` must satisfy. Use as
 * `} satisfies ActionsModule;` to flag stray non-action values without
 * widening the inferred type — call-site typing on the client stays precise
 * per-action.
 *
 * Why `Omit<ActionDefinition, 'handler'> & { handler: ... }` and not just
 * `ActionDefinition<Ctx, ZodType, ZodType>`? `ActionDefinition<Ctx, Req, Res>`
 * uses `Req` invariantly (covariantly via `request: Req`, contravariantly
 * via `handler`'s `args: z.infer<Req>` parameter), so a concrete
 * `ActionDefinition<Ctx, ZodObject<...>, ...>` is not assignable to
 * `ActionDefinition<Ctx, ZodType, ...>` under `strictFunctionTypes`. Omit
 * collapses the generic into a concrete record (no Req/Res to be invariant
 * about), and we re-attach a loose-but-still-required `handler` so the
 * server-side brand check still rejects stray non-action exports that
 * lack a callable handler. Same variance dodge as `client.ts`'s
 * `ClientActionShape`, just keeping `handler` in the picture because the
 * worker actually invokes it.
 */
export type ActionsModule = ActionsModuleFor<Ctx>;
