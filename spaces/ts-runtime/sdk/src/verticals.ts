// Managed search "vertical" schemas for `ctx.tool`.
//
// Single source of truth for the weather / sports / finance result contracts
// and their request options. Imported by:
//   - `index.ts`, which re-exports everything as part of `@hatch/space-sdk`.
//   - `worker/src/web_search.ts`, which maps MASE `vertical_data` into these
//     shapes and validates with the exported Zod schemas.
//
// Design notes live in `docs/vertical-tool-schemas.md`. Key invariants:
//   - Display strings (`summary`) are NOT parseable; read the structured
//     fields. The structure here is what we map out of MASE `vertical_data`.
//   - Every observation field is nullable/optional: MASE may omit fields or
//     surface them only in text, so the builders degrade missing data to
//     `null` rather than throwing.
//   - Payload caps live in the schema (`.max(...)`); heavy data (hourly
//     forecast, price history) is optional and only present when requested.

import { z, type JsonValue } from "./server-contract";

// ---------------------------------------------------------------------------
// Shared request types
// ---------------------------------------------------------------------------

export type ToolSearchVertical = "sports" | "weather" | "finance";

export interface ToolSearchLocation {
  readonly ip?: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly timezone?: string;
}

/** Options common to every vertical helper. Date ranges use `since`/`until`. */
export interface ToolSearchOptions {
  /**
   * Inclusive ISO date lower bound, e.g. "2026-06-01". For `finance` history
   * this is the window start (`from`); when omitted it defaults to an
   * interval-based look-back.
   */
  readonly since?: string;
  /**
   * Inclusive ISO date upper bound, e.g. "2026-06-16". For `finance` history
   * this is the window end (`to`) and is applied client-side (defaults to
   * today); it is not plumbed into the backend request. See
   * `docs/vertical-tool-schemas.md`.
   */
  readonly until?: string;
  readonly language_code?: string;
  readonly location?: ToolSearchLocation;
  readonly timeout_secs?: number;
}

export interface ToolSearchResponse<TContent = JsonValue> {
  readonly content: TContent;
  readonly summary?: JsonValue;
  readonly metadata?: JsonValue;
  readonly search_engines?: readonly string[];
  readonly model?: string;
  readonly usage?: JsonValue;
}

/** Weather: current snapshot + a bounded forecast horizon. */
export interface ToolWeatherOptions extends ToolSearchOptions {
  /**
   * Select the maximum hourly forecast points to return, capped at 48. This is
   * applied client-side to the upstream hourly series. Omit to preserve the
   * existing maximum of 48 points when hourly data is available.
   */
  readonly hourly_hours?: number;
}

/**
 * Sampling granularity for `finance` history; selects which candle set the
 * builder maps into `instruments[].history`.
 */
export type ToolFinanceInterval = "1m" | "30m" | "1d" | "1w" | "1mo";

/**
 * Finance: latest quote + an optional historical OHLCV series.
 *
 * The history window is the inherited `since`/`until` (from/to, inclusive ISO
 * dates), applied client-side to the candle set the backend returns. `until`
 * defaults to today; `since` defaults to an interval-based look-back
 * (1m ≈ 1 day, 30m ≈ 1 week, 1d ≈ 3 months, 1w ≈ 1 year,
 * 1mo ≈ 5 years). Choose `1m` for a current-session chart; `30m` is an
 * independently populated coarser series and is intended for multi-day views.
 */
export interface ToolFinanceOptions extends ToolSearchOptions {
  /** Sampling granularity for the history series. Omit for latest quote only. */
  readonly interval?: ToolFinanceInterval;
}

// ---------------------------------------------------------------------------
// Shared schema helpers
// ---------------------------------------------------------------------------

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

const toolSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
});

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

// Convenience target for turning raw weather search results into a compact
// object. This is not a backend contract: MASE may omit fields or surface them
// only in text, so non-core observations are nullable and callers should handle
// missing values.
export const TOOL_WEATHER_RESULT_SCHEMA = z.object({
  location: z
    .string()
    .describe('Resolved location these conditions describe, e.g. "San Francisco, CA".'),
  summary: z
    .string()
    .describe(
      "Human-readable weather summary for display. Display only — do NOT parse it for values; read the structured `conditions` and `forecast_days` fields instead.",
    ),
  conditions: z
    .object({
      temperature: nullableNumber.describe("Current temperature in `unit`. Null if unavailable."),
      unit: z.string().describe('Unit for every temperature value, e.g. "F" or "C".'),
      description: z.string().describe('Short current-conditions phrase, e.g. "Partly cloudy".'),
      feels_like: nullableNumber.optional().describe("Apparent ('feels like') temperature in `unit`."),
      high: nullableNumber.optional().describe("Today's forecast high in `unit`."),
      low: nullableNumber.optional().describe("Today's forecast low in `unit`."),
      humidity_percent: nullableNumber.optional().describe("Relative humidity, 0–100."),
      precipitation_chance: nullableNumber.optional().describe("Chance of precipitation, 0–100."),
      precipitation_amount: nullableString.optional().describe('Precipitation amount with unit, e.g. "2 mm".'),
      wind: nullableString.optional().describe('Wind description, e.g. "10 mph NW".'),
      uv_index: nullableNumber.optional().describe("UV index value."),
      uv_description: nullableString.optional().describe('UV index category, e.g. "Moderate".'),
      air_quality_index: nullableNumber.optional().describe("Air quality index value."),
      air_quality_description: nullableString.optional().describe('Air quality category, e.g. "Good".'),
      sunrise: nullableString.optional().describe("Sunrise time (local) as an ISO 8601 or clock string."),
      sunset: nullableString.optional().describe("Sunset time (local) as an ISO 8601 or clock string."),
    })
    .describe("Current observed/derived conditions. Prefer these fields over parsing `summary`."),
  forecast_days: z
    .array(
      z.object({
        date: nullableString.describe("Forecast day as an ISO 8601 date (YYYY-MM-DD). Null if unknown."),
        summary: nullableString.describe("Human-readable per-day summary for display. Not for parsing."),
        current: nullableNumber.describe("Current temperature for the day in `conditions.unit`."),
        high: nullableNumber.describe("Forecast high in `conditions.unit`."),
        low: nullableNumber.describe("Forecast low in `conditions.unit`."),
        precipitation_chance: nullableNumber.optional().describe("Chance of precipitation, 0–100."),
        precipitation_amount: nullableString.optional().describe("Precipitation amount with unit."),
        wind: nullableString.optional().describe("Wind description for the day."),
      }),
    )
    .describe("Per-day forecast entries, soonest first."),
  forecast_hourly: z
    .array(
      z.object({
        time: nullableString.describe("Hour as an ISO 8601 timestamp (UTC)."),
        temperature: nullableNumber.describe("Temperature in `conditions.unit`. Null if the feed omits it hourly."),
        description: nullableString.optional().describe('Short conditions phrase, e.g. "Light rain".'),
        precipitation_chance: nullableNumber.optional().describe("Chance of precipitation, 0–100."),
        precipitation_amount: nullableString.optional().describe("Precipitation amount with unit."),
        wind: nullableString.optional().describe('Wind description, e.g. "8 mph NW".'),
      }),
    )
    .max(48)
    .optional()
    .describe("Hourly forecast, soonest first. Present only when hourly data is available (≤48)."),
  alerts: z.array(z.string()).optional().describe("Active weather alert headlines, if any."),
  sources: z.array(toolSourceSchema).describe("Attribution sources backing this result."),
});

export type ToolWeatherResult = z.infer<typeof TOOL_WEATHER_RESULT_SCHEMA>;

// ---------------------------------------------------------------------------
// Sports
// ---------------------------------------------------------------------------

// Flat per-event list with normalized header fields + per-player/team stats.
// A sport-discriminated `games` union is a deferred follow-up — see
// docs/vertical-tool-schemas.md.

// A single stat map. Keys vary by sport (kept verbatim from upstream, not
// canonicalized), values are numbers when the token parses cleanly, else the
// raw string (e.g. "DNP", "32:14").
const sportsStatMapSchema = z
  .record(z.string(), z.union([z.number(), z.string()]))
  .describe(
    'Sport-specific stats, e.g. {"PTS":30,"REB":8,"AST":11} (basketball) or {"goals":2,"assists":1} (soccer).',
  );

export const TOOL_SPORTS_DATA_RESULT_SCHEMA = z.object({
  summary: z
    .string()
    .describe(
      'Human-readable status line for the whole result, e.g. "Found 2 sports event(s).". Display only — do NOT parse it; read the structured fields on each `items` entry.',
    ),
  items: z
    .array(
      z.object({
        title: z.string().describe('Event name, e.g. "Lakers vs Bulls".'),
        summary: z
          .string()
          .describe(
            "Short human-readable per-event description for display. Display only — do NOT parse it for score/status/players; read the structured fields on this object.",
          ),
        url: nullableString.optional().describe("Source URL for the event, if available."),
        sport: nullableString
          .optional()
          .describe('Normalized sport token, e.g. "basketball", "football", "baseball". Null when unknown.'),
        league: nullableString
          .optional()
          .describe('League/competition, e.g. "NBA", "NFL", "MLB". Null when unknown or ambiguous (e.g. individual sports).'),
        season: z
          .object({
            label: nullableString
              .optional()
              .describe('String-form season label, e.g. "2025-26" or "2026 REG". Present for leagues that emit a flat label.'),
            year: nullableNumber.optional().describe("Season start year, e.g. 2025."),
            type: nullableString.optional().describe('Season type code, e.g. "REG" (regular) or "PST" (post-season).'),
            name: nullableString.optional().describe('Human-readable season name, e.g. "Regular Season" or "World Cup 2026".'),
            start_date: nullableString.optional().describe("Season start date (ISO 8601, YYYY-MM-DD) when provided."),
            end_date: nullableString.optional().describe("Season end date (ISO 8601, YYYY-MM-DD) when provided."),
          })
          .nullable()
          .optional()
          .describe(
            "Season scope. Carries either a flat `label` or structured `year`/`type`/`name` (plus optional `start_date`/`end_date`), depending on the league. Null when unknown.",
          ),
        teams: z
          .array(z.string())
          .optional()
          .describe("Team names involved in the event. Order is not a reliable home/away signal — use `home`/`away` when present."),
        home: nullableString
          .optional()
          .describe("Home team name. Null when the upstream entity does not split home/away."),
        away: nullableString
          .optional()
          .describe("Away team name. Null when the upstream entity does not split home/away."),
        score: nullableString
          .optional()
          .describe('Score formatted as "home-away", e.g. "110-98". Null when no score is available yet.'),
        status: nullableString
          .optional()
          .describe('Event status, e.g. "closed", "inprogress", "scheduled". Null when unknown.'),
        starts_at: nullableString
          .optional()
          .describe("Event start time as an ISO 8601 UTC timestamp. Null when unknown."),
        player_statistics: z
          .array(
            z.object({
              player: z.string().describe('Player name, e.g. "LeBron James".'),
              team: nullableString.optional().describe("Team the player is on, if known."),
              position: nullableString.optional().describe('Position, e.g. "Guard". Null if absent.'),
              stats: sportsStatMapSchema,
            }),
          )
          .optional()
          .describe(
            "Per-player statistics, universal across sports via the flexible `stats` map. MAY be absent or empty — the upstream feed (SportRadar) does not always provide it; never assume presence.",
          ),
        team_statistics: z
          .array(
            z.object({
              team: z.string().describe('Team name, e.g. "Boston Celtics".'),
              qualifier: nullableString.optional().describe('"home" or "away" when known.'),
              stats: sportsStatMapSchema,
            }),
          )
          .optional()
          .describe("Per-team statistics. MAY be absent or empty — not always provided."),
      }),
    )
    .describe("One entry per sports event matched for the query."),
  sources: z.array(toolSourceSchema).describe("Attribution sources backing this result."),
});

export type ToolSportsDataResult = z.infer<typeof TOOL_SPORTS_DATA_RESULT_SCHEMA>;

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

// A single instrument/security quote (+ optional OHLCV history). Shared between
// `TOOL_FINANCE_RESULT_SCHEMA` (an array of these) and the single-instrument
// `TOOL_FINANCE_TICKER_RESULT_SCHEMA`, so the per-instrument contract lives in
// exactly one place.
const financeInstrumentSchema = z.object({
  name: z.string().describe('Instrument/company name, e.g. "Apple Inc.".'),
  symbol: nullableString.optional().describe('Ticker symbol, e.g. "AAPL". Null if unknown.'),
  summary: z
    .string()
    .describe("Human-readable per-instrument description for display. Not for parsing."),
  price: nullableNumber.optional().describe("Latest price in `currency`."),
  currency: nullableString.optional().describe('ISO currency code for `price`, e.g. "USD".'),
  change: nullableNumber.optional().describe("Absolute price change for the session, in `currency`."),
  change_percent: nullableNumber.optional().describe("Percent price change for the session."),
  high: nullableNumber.optional().describe("Intraday high in `currency`."),
  low: nullableNumber.optional().describe("Intraday low in `currency`."),
  week_52_high: nullableNumber.optional().describe("Trailing 52-week high in `currency`."),
  week_52_low: nullableNumber.optional().describe("Trailing 52-week low in `currency`."),
  beta: nullableNumber.optional().describe("Beta relative to the broad market."),
  market_cap: nullableNumber.optional().describe("Market capitalization in `currency`."),
  market_status: nullableString.optional().describe('Market status, e.g. "open", "closed".'),
  as_of: nullableString.optional().describe("Quote timestamp as an ISO 8601 string."),
  url: nullableString.optional().describe("Source URL for the instrument, if available."),
  history: z
    .object({
      since: nullableString.optional().describe("Effective window start (ISO date) — the requested `since`, else the interval-based default."),
      until: nullableString.optional().describe("Effective window end (ISO date) — the requested `until`, else today."),
      interval: z.string().describe('Sampling interval: "1m", "30m", "1d", "1w", or "1mo".'),
      points: z
        .array(
          z.object({
            date: nullableString.describe(
              "Bar date (YYYY-MM-DD); for intraday intervals (1m or 30m) a full ISO 8601 timestamp, so bars within a day stay distinct.",
            ),
            close: nullableNumber.describe("Closing price in `currency`."),
            open: nullableNumber.optional().describe("Opening price."),
            high: nullableNumber.optional().describe("Intraday/period high."),
            low: nullableNumber.optional().describe("Intraday/period low."),
            volume: nullableNumber.optional().describe("Traded volume."),
          }),
        )
        // `interval` is the throttle: coarser intervals keep long ranges
        // under this ceiling. May be empty when a candle set is
        // upstream-gated (e.g. monthly today).
        .max(400)
        .describe("Time-ordered OHLCV bars, oldest first."),
    })
    .optional()
    .describe("Historical OHLCV series. Present only when an `interval` was requested."),
});

export const TOOL_FINANCE_RESULT_SCHEMA = z.object({
  summary: z
    .string()
    .describe(
      "Human-readable status line for the whole result. Display only — do NOT parse it; read the structured `instruments` fields.",
    ),
  instruments: z
    .array(financeInstrumentSchema)
    .describe("One entry per matched instrument/security."),
  sources: z.array(toolSourceSchema).describe("Attribution sources backing this result."),
});

export type ToolFinanceResult = z.infer<typeof TOOL_FINANCE_RESULT_SCHEMA>;

/**
 * Single-ticker finance result: exactly one resolved instrument (not an array).
 *
 * `finance_ticker` takes ONE ticker symbol and resolves the upstream matches
 * down to a single instrument — dropping the leveraged-ETF / foreign-listing
 * noise a bare symbol otherwise pulls in. `resolved.matched` reports how it
 * resolved; `instrument` is null only when nothing matched.
 */
export const TOOL_FINANCE_TICKER_RESULT_SCHEMA = z.object({
  resolved: z
    .object({
      symbol: z.string().describe("The requested ticker, normalized to upper-case."),
      matched: z
        .enum(["exact", "best", "none"])
        .describe(
          'How the request resolved: "exact" = an instrument whose ticker equals the request; "best" = the top-ranked match when no ticker matched exactly (e.g. a company-name query); "none" = nothing found.',
        ),
    })
    .describe("How the requested ticker resolved to the returned instrument."),
  instrument: financeInstrumentSchema
    .nullable()
    .describe('The single resolved instrument, or null when nothing matched (`resolved.matched` = "none").'),
  sources: z.array(toolSourceSchema).describe("Attribution sources backing this result."),
});

export type ToolFinanceTickerResult = z.infer<typeof TOOL_FINANCE_TICKER_RESULT_SCHEMA>;

// ---------------------------------------------------------------------------
// Web search (generic; no vertical filter)
// ---------------------------------------------------------------------------
// `web_search` sends the query with NO vertical — the same plain web search the
// agent's browser_search runs by default (a vertical filter is only attached
// when one is requested) — a ranked `results[]` of web entries, no
// `vertical_data` (every field is mapped from the plain web results).
export const TOOL_WEB_SEARCH_RESULT_SCHEMA = z.object({
  summary: z
    .string()
    .describe("Human-readable status line for the whole result. Display only — read the structured `results`."),
  vertical: z
    .string()
    .describe('Empty for web_search (no vertical filter) — generic web results. For debugging / scoping A/B.'),
  results: z
    .array(
      z.object({
        title: z.string().describe("Result title / page headline."),
        url: nullableString.describe("Result URL. Null if unavailable."),
        source: nullableString.describe('Publisher / domain, e.g. "reuters.com". Null if unknown.'),
        snippet: nullableString.describe("Short excerpt of the page for display. Not for parsing."),
        published_at: nullableString.describe(
          "Best-effort publish date (ISO 8601 / YYYY-MM-DD), derived primarily from the URL slug. NOT authoritative — a hint only; prefer it over `last_updated_raw` for date ordering.",
        ),
        last_updated_raw: nullableString.describe(
          'Raw freshness marker from the feed, e.g. "Just now", "3 hours ago", "525 days ago". Unstructured and unreliable in BOTH directions — display only, never parse it into a real date.',
        ),
        favicon_url: nullableString.describe(
          "Source-domain favicon — an external Google s2 URL the artifact does NOT own. For a small icon next to the source name only, rendered decoratively with an onError fallback. Never content imagery and never a hotlinked page image: for real pictures use ctx.tool.generate_media or fetch-and-self-host the page's og:image. Usually present.",
        ),
        rank: z.number().describe("Upstream result rank (0-based) — stable ordering + debugging."),
        is_index_page: z
          .boolean()
          .describe(
            "Heuristic: true when the URL looks like a section/tag/index page rather than a single page (e.g. a `/ai` category page). Best-effort.",
          ),
      }),
    )
    .max(20)
    .describe("Web results for the query, in upstream rank order (capped)."),
  sources: z.array(toolSourceSchema).describe("Attribution sources backing this result."),
});

export type ToolWebSearchResult = z.infer<typeof TOOL_WEB_SEARCH_RESULT_SCHEMA>;

// ---------------------------------------------------------------------------
// JSON Schema projections (for tool/agent surfaces)
// ---------------------------------------------------------------------------

function toJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, {
    io: "output",
    unrepresentable: "any",
  }) as JsonValue;
}

export const TOOL_WEATHER_SCHEMA: JsonValue = toJsonSchema(TOOL_WEATHER_RESULT_SCHEMA);
export const TOOL_SPORTS_DATA_SCHEMA: JsonValue = toJsonSchema(TOOL_SPORTS_DATA_RESULT_SCHEMA);
export const TOOL_FINANCE_SCHEMA: JsonValue = toJsonSchema(TOOL_FINANCE_RESULT_SCHEMA);
export const TOOL_FINANCE_TICKER_SCHEMA: JsonValue = toJsonSchema(TOOL_FINANCE_TICKER_RESULT_SCHEMA);
export const TOOL_WEB_SEARCH_SCHEMA: JsonValue = toJsonSchema(TOOL_WEB_SEARCH_RESULT_SCHEMA);

// ---------------------------------------------------------------------------
// Client surface
// ---------------------------------------------------------------------------

/** Orientation for {@link SpaceToolClient.generate_media}. */
export type GenerateMediaOrientation = "square" | "landscape" | "portrait";

/** Options for {@link SpaceToolClient.generate_media}. */
export interface GenerateMediaOptions {
  /** Image aspect orientation. Defaults to `"square"`. */
  readonly orientation?: GenerateMediaOrientation;
  /** Optional override key under which to store the blob (default: a generated key). */
  readonly key?: string;
}

/**
 * A generated image, already stored in THIS Space's `ctx.blobs`. `url` is an
 * own-origin, stable, no-expiry, document-relative URL (`./blobs/<key>`) —
 * render it directly and persist `blobKey` (never a foreign URL).
 */
export interface GeneratedMedia {
  readonly blobKey: string;
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
}

export interface SpaceToolClient {
  /** Weather-shaped current conditions + forecast horizon via Muse's managed weather vertical. */
  weather(query: string, options?: ToolWeatherOptions): Promise<ToolSearchResponse<ToolWeatherResult>>;
  /** Sports scores/schedules/results via Muse's managed sports vertical. */
  sports_data(query: string, options?: ToolSearchOptions): Promise<ToolSearchResponse<ToolSportsDataResult>>;
  /**
   * @deprecated Don't reach for `finance`. Use
   * {@link SpaceToolClient.finance_ticker} for a single ticker's quote / price /
   * history (by symbol), and {@link SpaceToolClient.web_search} for everything
   * else — including resolving a company name to a ticker (search the name, read
   * the symbol out of the results, then call `finance_ticker`), comparing
   * several instruments, and analytical questions (earnings, analyst views, why
   * a stock moved). The method stays available so existing artifacts keep
   * working, but it is being removed from the guidance and will be deleted.
   *
   * Finance search via Muse's managed finance vertical: a free-text query
   * returns an array of matched instruments (latest quote + optional OHLCV
   * history each). For a single ticker symbol, see
   * {@link SpaceToolClient.finance_ticker}.
   */
  finance(query: string, options?: ToolFinanceOptions): Promise<ToolSearchResponse<ToolFinanceResult>>;
  /**
   * Single-ticker quote (+ optional OHLCV history) via Muse's managed finance
   * vertical. Takes one ticker symbol, e.g. `"AAPL"`; the result is one
   * resolved `instrument` (not an array) plus `resolved.matched`
   * (`"exact"` | `"best"` | `"none"`) — the exact symbol match when present,
   * otherwise the top-ranked result, with the other matched instruments (ETFs,
   * cross-listings) omitted. For several tickers, call once per ticker (e.g.
   * with `Promise.all`); a multi-token string (`"META GOOG"`) is rejected. To go
   * from a company name to a symbol, or to compare several instruments, use
   * {@link SpaceToolClient.web_search} (then call this with the resolved symbol).
   */
  finance_ticker(
    symbol: string,
    options?: ToolFinanceOptions,
  ): Promise<ToolSearchResponse<ToolFinanceTickerResult>>;
  /**
   * A general **web search**, run in the action — the same search the agent's
   * browser_search runs by default (no vertical filter). Use it for any topic
   * the structured vertical tools don't cover: analysis, "why", world
   * knowledge, comparisons, how-tos (e.g. "how does a heat pump work", "best
   * espresso machines 2026"). Returns a typed list of `results` ({@link ToolWebSearchResult});
   * each `snippet` is a substantial excerpt — usually enough to summarize via
   * `ctx.inference.complete` without opening the page; dates are best-effort.
   * For a stock quote / price / history use {@link SpaceToolClient.finance_ticker};
   * for scores/schedules/stats use
   * {@link SpaceToolClient.sports_data}. Don't spawn an artifact task just to search
   * — it runs this same search; reserve a task for opening/reading full pages,
   * multi-step research, or other agent tools.
   */
  web_search(query: string, options?: ToolSearchOptions): Promise<ToolSearchResponse<ToolWebSearchResult>>;
  /**
   * Generate an image server-side and store it in this Space's `ctx.blobs`,
   * returning a durable own-origin URL + blob key. No network egress from the
   * action and no expiring URL — prefer this for hero/per-item imagery, and as
   * the fallback when a web photo can't be sourced. Persist `blobKey` in your
   * DB and render `url`.
   */
  generate_media(prompt: string, options?: GenerateMediaOptions): Promise<GeneratedMedia>;
}
