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
} from "../../sdk/src/server-contract";

export {
  INFERENCE_SCHEMA_ERROR_BRAND,
  InferenceSchemaError,
} from "../../sdk/src/index";

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
} from "../../sdk/src/server-contract";

export {
  createPrivilegedExecutor,
  definePrivilegedContracts,
  definePrivilegedHandlers,
  isPrivilegedContract,
  isPrivilegedHandlers,
};

export const HATCH_SPACE_ACTION_AUTH_REFRESH_REQUIRED_MESSAGE =
  "hatch:space-action-auth-refresh-required" as const;

export const HATCH_SPACE_ACTION_REFRESHABLE_FAILURE_CODES = [
  "notary_missing",
  "notary_expired",
  "notary_invalid",
  "credential_stale",
] as const;

export type HatchSpaceActionRefreshableFailureCode =
  (typeof HATCH_SPACE_ACTION_REFRESHABLE_FAILURE_CODES)[number];

export interface HatchSpaceActionAuthRefreshRequiredMessage {
  type: typeof HATCH_SPACE_ACTION_AUTH_REFRESH_REQUIRED_MESSAGE;
  reason: HatchSpaceActionRefreshableFailureCode;
}

export interface InferenceImageInput {
  readonly dataBase64: string;
  readonly mimeType?: "image/jpeg" | "image/png";
  readonly filename?: string;
  readonly caption?: string;
}

export interface InferenceCompleteOptions<T extends z.ZodType = z.ZodType> {
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
  readonly images?: readonly InferenceImageInput[];
}

export interface InferenceClient {
  complete<T extends z.ZodType>(
    prompt: string,
    options: InferenceCompleteOptions<T>,
  ): Promise<z.infer<T>>;
}

export type ToolSearchVertical = "sports" | "weather" | "finance";

export interface ToolSearchLocation {
  readonly ip?: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly timezone?: string;
}

export interface ToolSearchOptions {
  readonly since?: string;
  /** Inclusive ISO upper bound; for `finance` history the window end (applied
   * client-side, defaults to today). Mirrors the primary SDK. */
  readonly until?: string;
  readonly language_code?: string;
  readonly location?: ToolSearchLocation;
  readonly timeout_secs?: number;
}

export interface ToolWeatherOptions extends ToolSearchOptions {
  /** Client-side cap for the upstream hourly forecast series, at most 48. */
  readonly hourly_hours?: number;
}

export interface ToolFinanceOptions extends ToolSearchOptions {
  /** History sampling granularity. Omit for latest quote only. The candle set
   * is selected client-side, so this must be forwarded to the builder on BOTH
   * runtimes (the Cloudflare path mapped it client-side too). */
  readonly interval?: "1m" | "30m" | "1d" | "1w" | "1mo";
}

export interface ToolSearchResponse<TContent = JsonValue> {
  readonly content: TContent;
  readonly summary?: JsonValue;
  readonly metadata?: JsonValue;
  readonly search_engines?: readonly string[];
  readonly model?: string;
  readonly usage?: JsonValue;
}

export type ToolWeatherResult = JsonValue;
export type ToolSportsDataResult = JsonValue;
export type ToolFinanceResult = JsonValue;
export type ToolFinanceTickerResult = JsonValue;
export type ToolWebSearchResult = JsonValue;

export interface SpaceToolClient {
  weather(
    query: string,
    options?: ToolWeatherOptions,
  ): Promise<ToolSearchResponse<ToolWeatherResult>>;
  sports_data(
    query: string,
    options?: ToolSearchOptions,
  ): Promise<ToolSearchResponse<ToolSportsDataResult>>;
  /**
   * @deprecated Don't reach for `finance`. Use `finance_ticker` for a single
   * ticker's quote/price/history (by symbol) and `web_search` for everything
   * else — resolving a company name to a ticker (search the name, read the
   * symbol out of the results, then call `finance_ticker`), comparing several
   * instruments, and analysis (earnings, analyst views, why a stock moved). The
   * method stays available so existing artifacts keep working, but it is being
   * removed from the guidance and will be deleted.
   */
  finance(
    query: string,
    options?: ToolFinanceOptions,
  ): Promise<ToolSearchResponse<ToolFinanceResult>>;
  finance_ticker(
    symbol: string,
    options?: ToolFinanceOptions,
  ): Promise<ToolSearchResponse<ToolFinanceTickerResult>>;
  web_search(
    query: string,
    options?: ToolSearchOptions,
  ): Promise<ToolSearchResponse<ToolWebSearchResult>>;
}

export interface AgentSendOptions {
  readonly expectsAction?: string;
  readonly dedupeKey?: string;
  readonly allowParallel?: boolean;
}

export type AgentSendResult =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly agentId: string;
      readonly messageId: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface AgentStatusResult {
  readonly taskId: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "not_found";
  readonly returnContractStatus?: "not_expected" | "pending" | "satisfied" | "unsatisfied";
  readonly agentStatus?: string;
  readonly agentId?: string;
  readonly messageId?: string;
  readonly finalResponse?: string;
  readonly statusMessage?: string;
  readonly failureReason?: string;
  readonly expectedAction?: string;
  readonly completedAction?: string;
}

export type AgentTaskOptions = AgentSendOptions;
export type AgentTaskResult = AgentSendResult;

export interface AgentClient {
  spawnTask(message: string, options?: AgentTaskOptions): Promise<AgentTaskResult>;
  send(message: string, options?: AgentSendOptions): Promise<AgentSendResult>;
  status(taskId: string): Promise<AgentStatusResult>;
}

export class SpaceActionAuthRefreshRequiredError extends Error {
  readonly code: HatchSpaceActionRefreshableFailureCode;
  readonly refreshable = true;

  constructor(code: HatchSpaceActionRefreshableFailureCode) {
    super(`Space action auth refresh required: ${code}`);
    this.name = "SpaceActionAuthRefreshRequiredError";
    this.code = code;
  }
}

export function isHatchSpaceActionRefreshableFailureCode(
  value: unknown,
): value is HatchSpaceActionRefreshableFailureCode {
  return HATCH_SPACE_ACTION_REFRESHABLE_FAILURE_CODES.includes(
    value as HatchSpaceActionRefreshableFailureCode,
  );
}

export function isSpaceActionAuthRefreshRequiredError(
  value: unknown,
): value is SpaceActionAuthRefreshRequiredError {
  return (
    value instanceof SpaceActionAuthRefreshRequiredError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { refreshable?: unknown }).refreshable === true &&
      isHatchSpaceActionRefreshableFailureCode(
        (value as { code?: unknown }).code,
      ))
  );
}

export function inferenceOptionsToPayload(
  options: InferenceCompleteOptions,
): JsonValue {
  return {
    schema: z.toJSONSchema(options.schema, {
      io: "output",
      unrepresentable: "any",
    }) as JsonValue,
    ...(options.timeout_secs !== undefined
      ? { timeout_secs: options.timeout_secs }
      : {}),
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.images !== undefined
      ? { images: options.images as unknown as JsonValue }
      : {}),
  };
}

/** React Query key accepted by local Spaces invalidation APIs. */
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

export interface Ctx extends PortableCtx {
  readonly agent: AgentClient;
  readonly inference: InferenceClient;
  readonly tool: SpaceToolClient;
  invalidateQueries(invalidation?: SpaceQueryInvalidationInput): void;
}

export type ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> = SharedActionDefinition<Ctx, Req, Res>;

export function isAction(value: unknown): value is ActionDefinition {
  return isSharedAction(value);
}

export type AnyZodObject = z.ZodType;

export type Infer<T extends z.ZodType> = z.infer<T>;

export const defineAction = createDefineAction<Ctx>();

export type ActionsModule = ActionsModuleFor<Ctx>;

export interface ActionRpcRequest {
  action: string;
  args: unknown;
  actionCallId?: string;
}

export interface ActionRpcResponse<T = unknown> {
  data: T;
  version: 1;
}
