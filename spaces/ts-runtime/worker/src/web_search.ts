import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import {
  type SpaceToolClient,
  type ToolSearchLocation,
  type ToolSearchOptions,
  type ToolSearchResponse,
  type ToolSearchVertical,
} from "@hatch/space-sdk";

import { buildToolContent, normalizeTicker, type SearchResult } from "./search_builders";
import { decodeWebSearchFrame, encodeWebSearchFrame } from "./web_search_frame";

export {
  buildFinanceResult,
  buildFinanceTickerResult,
  buildSportsDataResult,
  buildToolContent,
  buildWeatherResult,
  buildWebSearchResult,
  normalizeTicker,
} from "./search_builders";
export type { SearchResult } from "./search_builders";

const SOCKET_ENV = "HATCH_SPACE_WEB_SEARCH_SOCKET";
const SLUG_ENV = "HATCH_SPACE_SLUG";
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const MAX_TIMEOUT_SECS = 120;
const TIMEOUT_HEADROOM_MS = 30_000;

type SearchOptions = ToolSearchOptions & {
  readonly verticals?: readonly ToolSearchVertical[];
};

export type SearchRequest = {
  kind: "search";
  request_id: string;
  slug: string;
  primary_query: {
    query: string;
    language_code?: string;
  };
  verticals?: readonly ToolSearchVertical[];
  since?: string;
  location?: ToolSearchLocation;
  timeout_secs?: number;
  action_invocation_id?: string;
  tool_method?: string;
  action_name?: string;
  root_request_id?: string;
  builder_probe_authority?: {
    runtime_context_token: string;
  };
};

type RawResponse =
  | { ok: true; result?: SearchResult }
  | { ok: false; error?: string };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required worker environment variable ${name}`);
  }
  return value;
}

export function timeoutMs(options: SearchOptions | undefined): number {
  const rawSecs = options?.timeout_secs;
  if (typeof rawSecs === "number" && Number.isFinite(rawSecs) && rawSecs > 0) {
    return Math.min(rawSecs, MAX_TIMEOUT_SECS) * 1000 + TIMEOUT_HEADROOM_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

type ToolContext = {
  actionInvocationId?: string;
  toolMethod?: string;
  actionName?: string;
  rootRequestId?: string;
  builderProbeRuntimeContextToken?: string;
};

function normalizeSearchRequest(
  query: string,
  options: SearchOptions = {},
  ctx?: ToolContext,
): SearchRequest {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("ctx.tool search helpers require a non-empty query");
  }
  const request: SearchRequest = {
    kind: "search",
    request_id: `space-web-search-${randomUUID()}`,
    slug: requiredEnv(SLUG_ENV),
    primary_query: {
      query: trimmed,
    },
  };
  if (options.language_code !== undefined) request.primary_query.language_code = options.language_code;
  if (options.verticals !== undefined) request.verticals = options.verticals;
  if (options.since !== undefined) request.since = options.since;
  if (options.location !== undefined) request.location = options.location;
  if (options.timeout_secs !== undefined) request.timeout_secs = options.timeout_secs;
  if (ctx?.actionInvocationId !== undefined) request.action_invocation_id = ctx.actionInvocationId;
  if (ctx?.toolMethod !== undefined) request.tool_method = ctx.toolMethod;
  if (ctx?.actionName !== undefined) request.action_name = ctx.actionName;
  if (ctx?.rootRequestId !== undefined) request.root_request_id = ctx.rootRequestId;
  if (ctx?.builderProbeRuntimeContextToken !== undefined) {
    request.builder_probe_authority = {
      runtime_context_token: ctx.builderProbeRuntimeContextToken,
    };
  }
  return request;
}

async function sendSearch(request: SearchRequest, timeout: number): Promise<SearchResult> {
  const socketPath = requiredEnv(SOCKET_ENV);
  const frame = encodeWebSearchFrame(request);
  const chunks: Buffer[] = [];

  const raw = await new Promise<RawResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`artifact web search exceeded ${timeout}ms wall-clock budget`));
    }, timeout);

    function finish(err?: Error, response?: RawResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (response) resolve(response);
      else reject(new Error("artifact web search socket closed without a response"));
    }

    socket.on("connect", () => {
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on("end", () => {
      try {
        finish(undefined, decodeWebSearchFrame<RawResponse>(Buffer.concat(chunks)));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => finish(err));
  });

  if (raw.ok !== true) {
    throw new Error(raw.error || "artifact web search failed");
  }
  if (!raw.result || raw.result.kind !== "search") {
    throw new Error("artifact web search response did not contain a search result");
  }
  return raw.result;
}

async function search<TContent>(
  query: string,
  options: SearchOptions,
  build: (raw: SearchResult) => TContent,
  ctx?: ToolContext,
): Promise<ToolSearchResponse<TContent>> {
  const request = normalizeSearchRequest(query, options, ctx);
  const result = await sendSearch(request, timeoutMs(options));
  return {
    content: build(result),
    summary: result.summary,
    metadata: result.metadata,
    search_engines: result.search_engines ?? [],
    model: result.model,
    usage: result.usage,
  };
}

function createToolClientWithContext(
  baseCtx: ToolContext,
): Omit<SpaceToolClient, "generate_media"> {
  return {
    weather(query, options = {}) {
      return search(
        query,
        { ...options, verticals: ["weather"] },
        (raw) => buildToolContent("weather", raw, { hourly_hours: options.hourly_hours }),
        { ...baseCtx, toolMethod: "weather" },
      );
    },
    sports_data(query, options = {}) {
      return search(
        query,
        { ...options, verticals: ["sports"] },
        (raw) => buildToolContent("sports_data", raw),
        { ...baseCtx, toolMethod: "sports_data" },
      );
    },
    finance(query, options = {}) {
      return search(
        query,
        { ...options, verticals: ["finance"] },
        (raw) =>
          buildToolContent("finance", raw, {
            interval: options.interval,
            since: options.since,
            until: options.until,
          }),
        { ...baseCtx, toolMethod: "finance" },
      );
    },
    finance_ticker(symbol, options = {}) {
      // Validate up front so a multi-ticker string fails fast (before a search)
      // and the caller is pushed to one call per ticker.
      const ticker = normalizeTicker(symbol);
      return search(
        ticker,
        { ...options, verticals: ["finance"] },
        (raw) =>
          buildToolContent("finance_ticker", raw, {
            symbol: ticker,
            interval: options.interval,
            since: options.since,
            until: options.until,
          }),
        { ...baseCtx, toolMethod: "finance_ticker" },
      );
    },
    // The generic web tool: the query is sent with NO vertical (empty
    // `verticals`) — the same plain web search the agent's browser_search runs
    // by default. Maps plain `top[]` entries through `buildWebSearchResult`.
    web_search(query, options = {}) {
      return search(
        query,
        { ...options, verticals: [] },
        (raw) => buildToolContent("web_search", raw),
        { ...baseCtx, toolMethod: "web_search" },
      );
    },
  };
}

export function createToolClient(
  actionInvocationId?: string,
  actionName?: string,
  rootRequestId?: string,
): Omit<SpaceToolClient, "generate_media"> {
  return createToolClientWithContext({
    ...(actionInvocationId !== undefined ? { actionInvocationId } : {}),
    ...(actionName !== undefined ? { actionName } : {}),
    ...(rootRequestId !== undefined ? { rootRequestId } : {}),
  });
}

const BUILDER_PROBE_ACTION = "__builder_probe__";

/**
 * Build the local-only probe client without teaching ordinary Space actions
 * to read an ambient runtime credential. The daemon and Sentinel validate the
 * opaque token; the fixed action and invocation id are correlation labels.
 */
export function createBuilderProbeToolClient(
  invocationId: string,
  runtimeContextToken: string,
): Omit<SpaceToolClient, "generate_media"> {
  return createToolClientWithContext({
    actionInvocationId: invocationId,
    actionName: BUILDER_PROBE_ACTION,
    builderProbeRuntimeContextToken: runtimeContextToken,
  });
}
