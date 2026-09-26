// Shared, runtime-agnostic mappers from a raw MASE web-search response
// (`summary.top[]`) into the typed `ctx.tool.*` result shapes the SDK promises.
//
// Used by BOTH space runtimes so their `ctx.tool.*().content` can't drift:
//   - the local bun worker (`worker/src/web_search.ts`, which talks to the
//     web-search UDS directly), and
//   - the Cloudflare worker (`cloudflare/src/worker-runtime.ts`, which calls the
//     daemon `/spaces/v2/{slug}/_sdk/tool-call` route — that route returns
//     `content: null` and only the raw `summary`, so the Cloudflare side must
//     map it here exactly like the local worker does).
//
// `buildToolContent` is the single entry point both call: it builds AND
// schema-parses, so the two runtimes return byte-identical typed `content`.
//
// Node-free by construction (no `node:net`/`node:crypto`) so it is safe in the
// Cloudflare Workers runtime. Imports use relative `../../sdk/src/...` paths
// (not the `@hatch/space-sdk` package alias, which resolves to `sdk/dist` and is
// not reachable from the Cloudflare build) so this module resolves identically
// from both `worker/src` and `cloudflare/src`.
import {
  TOOL_FINANCE_RESULT_SCHEMA,
  TOOL_FINANCE_TICKER_RESULT_SCHEMA,
  TOOL_SPORTS_DATA_RESULT_SCHEMA,
  TOOL_WEATHER_RESULT_SCHEMA,
  TOOL_WEB_SEARCH_RESULT_SCHEMA,
  type ToolFinanceInterval,
  type ToolFinanceResult,
  type ToolFinanceTickerResult,
  type ToolSportsDataResult,
  type ToolWeatherResult,
  type ToolWebSearchResult,
} from "../../sdk/src/verticals";
import type { JsonValue } from "../../sdk/src/server-contract";

// The raw web-search response shape both transports yield: the local worker's
// socket reply and the daemon tool-call route both carry `summary`/`metadata`
// (the daemon additionally sets `content: null`, which we recompute here).
export type SearchResult = {
  kind: "search";
  content?: JsonValue;
  summary?: JsonValue;
  metadata?: JsonValue;
  search_engines?: readonly string[];
  model?: string;
  usage?: JsonValue;
};

// Helpers build their typed result from `summary.top[*].vertical_data`. Every
// field is independently optional; an empty / missing payload returns a
// schema-valid stub so quiet searches don't throw ZodError.

type TopEntry = {
  title?: string;
  url?: string;
  excerpt?: string;
  vertical_data?: JsonValue;
  // Plain web-result fields (present on every `top[]` entry, no vertical_data
  // required) — used by the web_search builder.
  rank?: number;
  domain?: string;
  favicon_url?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function topFromSummary(summary: JsonValue | undefined): TopEntry[] {
  if (!isRecord(summary)) return [];
  const top = summary.top;
  if (!Array.isArray(top)) return [];
  return top.filter(isRecord) as TopEntry[];
}

function topSources(top: readonly TopEntry[]): { title: string; url: string }[] {
  return top
    .map((entry) => ({ title: entry.title ?? "", url: entry.url ?? "" }))
    .filter((source) => source.url.length > 0);
}

function selectByVertical(top: readonly TopEntry[], vertical: string): TopEntry[] {
  return top.filter((entry) => {
    return isRecord(entry.vertical_data) && entry.vertical_data.vertical === vertical;
  });
}

// Upstream measures arrive as `{ value, unit }` objects. `measureValue` pulls
// the numeric value (null if absent / non-finite); `formatMeasure` renders a
// `"<value> <unit>"` display string (e.g. "2 mm", "13 mph").
function measureValue(value: unknown): number | null {
  if (isRecord(value) && typeof value.value === "number" && Number.isFinite(value.value)) {
    return value.value;
  }
  return null;
}

function formatMeasure(value: unknown): string | null {
  const num = measureValue(value);
  if (num === null) return null;
  const unit = isRecord(value) ? nonemptyString(value.unit) : null;
  return unit ? `${num} ${unit}` : `${num}`;
}

function epochSecToIso(value: unknown): string | null {
  return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function epochSecToIsoDate(value: unknown): string | null {
  const iso = epochSecToIso(value);
  return iso === null ? null : iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Accept a YYYY-MM-DD (or longer ISO) string and return just the date portion,
// or null if it isn't a parseable ISO date. Lets a window bound be passed as
// either a plain date or a full timestamp.
function normalizeIsoDate(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function isoDaysBefore(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return isoDate;
  return new Date(ms - days * 86_400_000).toISOString().slice(0, 10);
}

export function buildWeatherResult(
  result: SearchResult,
  hourlyHours?: number,
): ToolWeatherResult {
  const top = topFromSummary(result.summary);
  const matches = selectByVertical(top, "weather");
  const entry = matches[0];
  if (!entry || !isRecord(entry.vertical_data)) {
    return {
      location: "Unknown",
      summary: "No structured weather data available for this query.",
      conditions: { temperature: null, unit: "F", description: "Unknown" },
      forecast_days: [],
      sources: topSources(top).slice(0, 3),
    };
  }
  const vd = entry.vertical_data;
  const loc = isRecord(vd.location) ? vd.location : {};
  const city = nonemptyString(loc.city);
  const stateAbbr = nonemptyString(loc.state_abbr);
  const location = city ? (stateAbbr ? `${city}, ${stateAbbr}` : city) : "Unknown";

  const current = isRecord(vd.current) ? vd.current : {};
  const temp = isRecord(current.temperature) ? current.temperature : {};
  const wind = isRecord(current.wind_speed) ? current.wind_speed : {};
  const temperature = typeof temp.value === "number" ? temp.value : null;
  const unit = nonemptyString(temp.unit) ?? "F";
  const description = nonemptyString(current.description) ?? "Unknown";
  const windPhrase = typeof wind.value === "number"
    ? `${wind.value} ${nonemptyString(wind.unit) ?? "mph"}`.trim()
    : null;

  // `unknown[]` instead of `JsonValue[]` so `isRecord` narrows cleanly.
  const dailyArr: unknown[] = Array.isArray(vd.forecast_daily) ? vd.forecast_daily : [];
  const forecast_days = dailyArr.flatMap((value) => {
    if (!isRecord(value)) return [];
    const day = value;
    return [
      {
        date: epochSecToIsoDate(day.utc_timestamp),
        summary: nonemptyString(day.description),
        current: null,
        high: measureValue(day.high_temperature),
        low: measureValue(day.low_temperature),
        precipitation_chance: measureValue(day.precipitation_chance),
        precipitation_amount: formatMeasure(day.precipitation_amount),
        wind: formatMeasure(day.wind_speed),
      },
    ];
  });

  // The model-selected hourly cap is applied to the complete upstream series.
  // Omission preserves the shipped 48-point maximum for existing callers.
  const hourlyLimit = hourlyHours === undefined
    ? 48
    : Math.max(0, Math.min(48, Math.floor(hourlyHours)));
  const hourlyArr: unknown[] = Array.isArray(vd.forecast_hourly) ? vd.forecast_hourly : [];
  const forecast_hourly = hourlyArr.slice(0, hourlyLimit).flatMap((value) => {
    if (!isRecord(value)) return [];
    const hour = value;
    return [
      {
        time: epochSecToIso(hour.utc_timestamp),
        temperature: measureValue(hour.temperature),
        description: nonemptyString(hour.description),
        precipitation_chance: measureValue(hour.precipitation_chance),
        precipitation_amount: formatMeasure(hour.precipitation_amount),
        wind: formatMeasure(hour.wind_speed),
      },
    ];
  });

  // `alerts` is an array of `{ event, severity }` objects; surface the headline.
  const alertsArr: unknown[] = Array.isArray(vd.alerts) ? vd.alerts : [];
  const alerts = alertsArr.flatMap((value) => {
    if (!isRecord(value)) return [];
    const event = nonemptyString(value.event);
    return event === null ? [] : [event];
  });

  const summaryParts: string[] = [];
  if (temperature !== null) {
    summaryParts.push(`${location} is currently ${description} at ${temperature}°${unit}.`);
  } else if (description !== "Unknown") {
    summaryParts.push(`${location} is currently ${description}.`);
  } else {
    summaryParts.push(`Weather data for ${location}.`);
  }
  if (forecast_days.length > 0) {
    summaryParts.push(`${forecast_days.length} day forecast available.`);
  }

  const conditions: ToolWeatherResult["conditions"] = {
    temperature,
    unit,
    description,
    feels_like: measureValue(current.feels_like),
    high: measureValue(current.high_temperature),
    low: measureValue(current.low_temperature),
    humidity_percent: typeof current.humidity === "number" ? current.humidity : null,
    precipitation_chance: measureValue(current.precipitation_chance),
    precipitation_amount: formatMeasure(current.precipitation_amount),
    wind: windPhrase,
    uv_index: typeof current.uv_index === "number" ? current.uv_index : null,
    air_quality_index: typeof current.air_quality_index === "number" ? current.air_quality_index : null,
    air_quality_description: nonemptyString(current.air_quality_description),
    sunrise: nonemptyString(current.sunrise),
    sunset: nonemptyString(current.sunset),
  };

  const out: ToolWeatherResult = {
    location,
    summary: summaryParts.join(" "),
    conditions,
    forecast_days,
    sources: [{ title: entry.title ?? "", url: entry.url ?? "" }],
  };
  if (forecast_hourly.length > 0) out.forecast_hourly = forecast_hourly;
  if (alerts.length > 0) out.alerts = alerts;
  return out;
}

export function buildSportsDataResult(result: SearchResult): ToolSportsDataResult {
  const top = topFromSummary(result.summary);
  const matches = selectByVertical(top, "sports");

  const items = matches.map((entry) => {
    const vd = entry.vertical_data as Record<string, unknown>;
    const event = isRecord(vd.event) ? vd.event : {};
    const attrs = isRecord(event.attributes) ? event.attributes : {};
    const home = isRecord(vd.home) ? vd.home : {};
    const away = isRecord(vd.away) ? vd.away : {};

    const players = parsePlayerStats(vd.player_statistics);
    const teamStats = parseTeamStats(vd.team_statistics);

    return {
      title: nonemptyString(event.name) ?? entry.title ?? "",
      // Display-only short body. The decoder (D108695383) no longer ships the
      // verbatim `vd.summary` blob, so read the lightweight `excerpt` directly.
      summary: entry.excerpt ?? "",
      url: entry.url ?? null,
      // `sport`/`league`/`season`/`status` are normalized to the top level of
      // `vertical_data` by the upstream decoder. `sport` is lowercased here so
      // the documented token contract holds regardless of upstream casing;
      // `status` falls back to the raw event attribute for older payloads.
      sport: nonemptyString(vd.sport)?.toLowerCase() ?? null,
      league: nonemptyString(vd.league),
      season: normalizeSeason(vd.season),
      teams: normalizeCompetitors(vd.competitors)
        .map((competitor) => nonemptyString(competitor.name))
        .filter((name): name is string => name !== null),
      home: nonemptyString(home.name),
      away: nonemptyString(away.name),
      // The trimmed decoder (D108695383) carries per-side scores on home/away
      // ({name, score}); fall back to the legacy results-blob parse for older
      // payloads that still ship `event.attributes`.
      score: homeAwayScore(home, away) ?? extractSportsScore(attrs),
      status: nonemptyString(vd.status) ?? nonemptyString(attrs.status),
      // `event.attributes` is dropped by the trimmed decoder, so `starts_at`
      // (from `startDateUTC`) resolves only for older payloads; null otherwise.
      starts_at: parseStartsAt(attrs),
      // Player/team stats are parsed from upstream text into records; omit when
      // empty so absent data stays cleanly off the result.
      player_statistics: players.records.length ? players.records : undefined,
      team_statistics: teamStats.records.length ? teamStats.records : undefined,
    };
  });

  return {
    summary: items.length === 0
      ? "No structured sports data available for this query."
      : `Found ${items.length} sports event(s).`,
    items,
    sources: items.length > 0
      ? matches.map((entry) => ({ title: entry.title ?? "", url: entry.url ?? "" }))
      : topSources(top).slice(0, 3),
  };
}

// MASE returns competitors as an array today; accept object-keyed shape
// (`{"0": {...}, "1": {...}}`) as a forward-compat hedge.
function normalizeCompetitors(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter(isRecord);
    }
    if (isRecord(value)) {
        return Object.values(value).filter(isRecord);
    }
    return [];
}

// Score as "home-away" from the trimmed decoder's per-side scores
// (`vd.home`/`vd.away` = `{name, score}`). Null when either side lacks a score.
function homeAwayScore(
  home: Record<string, unknown>,
  away: Record<string, unknown>,
): string | null {
  return typeof home.score === "number" && typeof away.score === "number"
    ? `${home.score}-${away.score}`
    : null;
}

function extractSportsScore(attrs: Record<string, unknown>): string | null {
  // `attributes.results` is a stringified JSON blob; parse defensively.
  if (typeof attrs.results !== "string" || attrs.results.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(attrs.results);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.scoring)) return null;
  const home = typeof data.scoring.home_score === "number" ? data.scoring.home_score : null;
  const away = typeof data.scoring.away_score === "number" ? data.scoring.away_score : null;
  if (home === null || away === null) return null;
  return `${home}-${away}`;
}

function parseStartsAt(attrs: Record<string, unknown>): string | null {
  if (typeof attrs.startDateUTC === "number" && attrs.startDateUTC > 0) {
    return new Date(attrs.startDateUTC * 1000).toISOString();
  }
  return null;
}

// `season` arrives either as a flat string label ("2025-26" / "2026 REG") or a
// structured object, whose shape varies by league: `{year, type, name}` (year
// as int) for some, `{name, year, start_date, end_date}` (year as a string) for
// others (e.g. the World Cup envelope). Normalize all forms into one
// optional-field object; return null when nothing carries data so the schema
// field stays cleanly absent.
function normalizeSeason(value: unknown): {
  label: string | null;
  year: number | null;
  type: string | null;
  name: string | null;
  start_date: string | null;
  end_date: string | null;
} | null {
  if (typeof value === "string") {
    const label = value.trim();
    return label
      ? { label, year: null, type: null, name: null, start_date: null, end_date: null }
      : null;
  }
  if (isRecord(value)) {
    // `year` may be an int or a numeric string ("2026"); coerce, else null.
    const year = typeof value.year === "number"
      ? value.year
      : typeof value.year === "string" && value.year.trim() !== "" && !Number.isNaN(Number(value.year))
        ? Number(value.year)
        : null;
    const type = nonemptyString(value.type);
    const name = nonemptyString(value.name);
    const start_date = nonemptyString(value.start_date);
    const end_date = nonemptyString(value.end_date);
    if (year === null && type === null && name === null && start_date === null && end_date === null) {
      return null;
    }
    return { label: null, year, type, name, start_date, end_date };
  }
  return null;
}

// Player/team stats arrive as free text from the upstream feed
// (`playerStatsSummary`/`teamStatsSummary`, single-encoded JSON strings the
// decoder unwraps to text). Both use the SAME block layout, confirmed against
// live prod (D108265855):
//   Statistics - <label>:
//     key: value
//     key: value
// where a player label nests the team + home/away qualifier, e.g.
//   "Ariel Hukporti (New York Knicks (Away))"
// and a team label is "<Team> (<Qualifier>)", e.g. "New York Knicks (Away)".
// Values are numbers or quoted strings (e.g. minutes "1:52"). The feed
// (SportRadar) does not always populate stats, so both parsers degrade to [] /
// raw text rather than throwing.
type PlayerStatRecord = {
  player: string;
  team: string | null;
  stats: Record<string, number | string>;
};
type TeamStatRecord = {
  team: string;
  qualifier: string | null;
  stats: Record<string, number | string>;
};
type StatBlock = { label: string; stats: Record<string, number | string> };

function coerceStatValue(token: string): number | string {
  let t = token.trim();
  // Strip surrounding double quotes, e.g. `minutes: "1:52"`.
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  const n = Number(t.replace(/,/g, ""));
  return t !== "" && !Number.isNaN(n) ? n : t;
}

// Parse the shared "Statistics - <label>:" + indented "key: value" block format.
function parseStatBlocks(value: unknown): { blocks: StatBlock[]; raw: string | null } {
  const text = nonemptyString(value);
  if (text === null) return { blocks: [], raw: null };
  const blocks: StatBlock[] = [];
  let current: StatBlock | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*Statistics\s*-\s*(.+?):\s*$/i);
    if (header && header[1]) {
      current = { label: header[1].trim(), stats: {} };
      blocks.push(current);
      continue;
    }
    const kv = line.match(/^\s+(.+?):\s*(.+?)\s*$/); // indented "key: value"
    if (kv && kv[1] && kv[2] && current) {
      current.stats[kv[1].trim()] = coerceStatValue(kv[2]);
    }
  }
  const withStats = blocks.filter((b) => Object.keys(b.stats).length > 0);
  return { blocks: withStats, raw: withStats.length === 0 ? text : null };
}

// Strip a trailing "(home)"/"(away)" qualifier from a label segment.
function splitQualifier(label: string): { name: string; qualifier: string | null } {
  const m = label.match(/^(.+?)\s*\((home|away)\)\s*$/i);
  if (m && m[1] && m[2]) return { name: m[1].trim(), qualifier: m[2].toLowerCase() };
  return { name: label.trim(), qualifier: null };
}

function parsePlayerStats(value: unknown): { records: PlayerStatRecord[]; raw: string | null } {
  const { blocks, raw } = parseStatBlocks(value);
  const records = blocks.flatMap((block) => {
    // Player label: "<Player> (<Team> (<Qualifier>))". Peel the outermost paren
    // group (team + qualifier) off the end; the rest is the player name.
    const m = block.label.match(/^(.*?)\s*\((.+)\)\s*$/);
    const player = (m?.[1] ?? block.label).trim();
    const team = m?.[2] ? splitQualifier(m[2].trim()).name : null;
    if (player === "") return [];
    return [{ player, team, stats: block.stats }];
  });
  return { records, raw };
}

function parseTeamStats(value: unknown): { records: TeamStatRecord[]; raw: string | null } {
  const { blocks, raw } = parseStatBlocks(value);
  const records = blocks.flatMap((block) => {
    const { name, qualifier } = splitQualifier(block.label); // "<Team> (<Qualifier>)"
    if (name === "") return [];
    return [{ team: name, qualifier, stats: block.stats }];
  });
  return { records, raw };
}

type FinanceInstrument = ToolFinanceResult["instruments"][number];

// Map one finance `vertical_data` entry into a typed instrument. History is
// opt-in: populated only when the caller requests an `interval` (an
// upstream-gated candle set, e.g. monthly today, yields empty `points`).
// Shared by `buildFinanceResult` (array) and `buildFinanceTickerResult` (one).
function buildFinanceInstrument(
  entry: TopEntry,
  interval?: ToolFinanceInterval,
  since?: string,
  until?: string,
): FinanceInstrument {
  const vd = isRecord(entry.vertical_data) ? entry.vertical_data : {};
  const entity = isRecord(vd.entity) ? vd.entity : {};
  const attrs = isRecord(entity.attributes) ? entity.attributes : {};
  const instrument: FinanceInstrument = {
    name: nonemptyString(entity.name) ?? entry.title ?? "",
    symbol: nonemptyString(attrs.symbol),
    summary: entry.excerpt ?? "",
    price: parseFinancePrice(attrs.currentPrice),
    currency: nonemptyString(attrs.currency),
    change: typeof attrs.change === "number" ? attrs.change : null,
    change_percent: typeof attrs.percentChange === "number" ? attrs.percentChange : null,
    high: typeof attrs.highPrice === "number" ? attrs.highPrice : null,
    low: typeof attrs.lowPrice === "number" ? attrs.lowPrice : null,
    week_52_high: typeof attrs["52WeekHigh"] === "number" ? attrs["52WeekHigh"] : null,
    week_52_low: typeof attrs["52WeekLow"] === "number" ? attrs["52WeekLow"] : null,
    beta: typeof attrs.beta === "number" ? attrs.beta : null,
    // Upstream reports market cap in millions; normalize to `currency` units.
    market_cap: typeof attrs.marketCap === "number" ? attrs.marketCap * 1e6 : null,
    market_status: nonemptyString(attrs.market_status),
    as_of: epochSecToIso(attrs.lastUpdatedAt),
    url: entry.url ?? null,
  };
  if (interval !== undefined) {
    instrument.history = buildFinanceHistory(vd.candles, interval, since, until);
  }
  return instrument;
}

// Upper-cased ticker symbol carried on a finance entry's `vertical_data`, or
// null. Used to resolve a `finance_ticker` request to its exact instrument.
function financeEntrySymbol(entry: TopEntry): string | null {
  const vd = isRecord(entry.vertical_data) ? entry.vertical_data : {};
  const entity = isRecord(vd.entity) ? vd.entity : {};
  const attrs = isRecord(entity.attributes) ? entity.attributes : {};
  return nonemptyString(attrs.symbol)?.toUpperCase() ?? null;
}

export function buildFinanceResult(
  result: SearchResult,
  interval?: ToolFinanceInterval,
  since?: string,
  until?: string,
): ToolFinanceResult {
  const top = topFromSummary(result.summary);
  const matches = selectByVertical(top, "finance");

  const instruments = matches.map((entry) => buildFinanceInstrument(entry, interval, since, until));

  return {
    summary: instruments.length === 0
      ? "No structured finance data available for this query."
      : `Found ${instruments.length} instrument(s).`,
    instruments,
    sources: instruments.length > 0
      ? matches.map((entry) => ({ title: entry.title ?? "", url: entry.url ?? "" }))
      : topSources(top).slice(0, 3),
  };
}

// A single ticker symbol: a leading letter or digit then letters/digits with
// optional `.`/`-` (e.g. "AAPL", "BRK.B", and digit-leading foreign listings
// like "0R1I.L" or Hong Kong "0700"), no whitespace or separators. Rejecting
// multi-token input is the point — it forces one `finance_ticker` call per
// ticker instead of a bloated, conflated combined query.
const TICKER_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,14}$/;

export function normalizeTicker(symbol: string): string {
  const trimmed = typeof symbol === "string" ? symbol.trim() : "";
  if (!TICKER_RE.test(trimmed)) {
    throw new Error(
      `ctx.tool.finance_ticker expects a single ticker symbol (e.g. "AAPL"), got ${JSON.stringify(symbol)}. ` +
        "For multiple tickers, call finance_ticker once per ticker (e.g. with Promise.all).",
    );
  }
  return trimmed.toUpperCase();
}

// Resolve the upstream finance matches for a single requested ticker down to
// exactly one instrument: prefer an exact ticker-symbol match, else fall back
// to the top-ranked result (e.g. a company-name query), else none. This drops
// the leveraged-ETF / foreign-listing instruments MASE returns alongside the
// requested ticker. `symbol` must already be normalized (upper-case).
export function buildFinanceTickerResult(
  result: SearchResult,
  symbol: string,
  interval?: ToolFinanceInterval,
  since?: string,
  until?: string,
): ToolFinanceTickerResult {
  const top = topFromSummary(result.summary);
  const matches = selectByVertical(top, "finance");

  // `matches` is in upstream rank order, so the first exact symbol match is the
  // highest-ranked one — the right tie-break if several entries share a symbol.
  const exact = matches.find((entry) => financeEntrySymbol(entry) === symbol);
  let chosen: TopEntry | undefined = exact;
  let matched: ToolFinanceTickerResult["resolved"]["matched"] = "none";
  if (exact) {
    matched = "exact";
  } else if (matches.length > 0) {
    chosen = matches[0];
    matched = "best";
  }

  return {
    resolved: { symbol, matched },
    instrument: chosen ? buildFinanceInstrument(chosen, interval, since, until) : null,
    sources: chosen
      ? [{ title: chosen.title ?? "", url: chosen.url ?? "" }]
      : topSources(top).slice(0, 3),
  };
}

type FinanceHistory = NonNullable<ToolFinanceResult["instruments"][number]["history"]>;

// `vd.candles` is a top-level sibling of `entity`, keyed by candle set. The
// caller's model-selected `interval` option selects exactly one set.
const CANDLE_KEY_BY_INTERVAL: Record<ToolFinanceInterval, string> = {
  "1m": "one_minute",
  "30m": "thirty_minute",
  "1d": "daily",
  "1w": "weekly",
  "1mo": "monthly",
};

// Default look-back per interval, used when the caller omits `since`. Ends at
// `until` (default: today) and keeps a roughly comparable bar count across
// granularities.
const HISTORY_DEFAULT_LOOKBACK_DAYS: Record<ToolFinanceInterval, number> = {
  "1m": 1,
  "30m": 7,
  "1d": 90,
  "1w": 365,
  "1mo": 1825,
};

function barTimestampSec(value: unknown): number {
  return isRecord(value) && typeof value.timestamp === "number" ? value.timestamp : 0;
}

function buildFinanceHistory(
  candles: unknown,
  interval: ToolFinanceInterval,
  since?: string,
  until?: string,
): FinanceHistory {
  // Resolve the [from, to] window: `to` defaults to today, `from` to an
  // interval-based look-back ending at `to`. Window bounds are date-granular
  // (YYYY-MM-DD), so string comparison against each bar's calendar date is
  // chronological.
  const to = normalizeIsoDate(until) ?? todayIso();
  const from = normalizeIsoDate(since) ?? isoDaysBefore(to, HISTORY_DEFAULT_LOOKBACK_DAYS[interval]);

  // Intraday intervals (1m and 30m) pack many bars into one calendar day, so a
  // date-only key can't distinguish them — emit the full ISO timestamp instead.
  const intraday = interval === "1m" || interval === "30m";

  const sets = isRecord(candles) ? candles : {};
  const raw = sets[CANDLE_KEY_BY_INTERVAL[interval]];
  const bars: unknown[] = Array.isArray(raw) ? raw : [];
  // Sort ascending by timestamp so points are always chronological regardless
  // of upstream ordering.
  const sorted = [...bars].sort((a, b) => barTimestampSec(a) - barTimestampSec(b));
  const points = sorted.flatMap((value) => {
    if (!isRecord(value)) return [];
    const bar = value;
    const day = epochSecToIsoDate(bar.timestamp);
    // Drop bars outside the [from, to] window or without a usable date.
    if (day === null || day < from || day > to) return [];
    return [
      {
        date: intraday ? epochSecToIso(bar.timestamp) : day,
        close: typeof bar.close === "number" ? bar.close : null,
        open: typeof bar.open === "number" ? bar.open : null,
        high: typeof bar.high === "number" ? bar.high : null,
        low: typeof bar.low === "number" ? bar.low : null,
        volume: typeof bar.volume === "number" ? bar.volume : null,
      },
    ];
  });
  // Safety cap: keep the most recent bars if a window ever exceeds the ceiling.
  const capped = points.length > 400 ? points.slice(-400) : points;
  return {
    interval,
    since: from,
    until: to,
    points: capped,
  };
}

function parseFinancePrice(value: unknown): number | null {
  // Number is the canonical wire shape; string fallback for sibling sources.
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------
//
// `web_search` sends no vertical, so MASE returns NO structured `vertical_data`
// — results are plain web entries in `summary.top[]`. So the web-search builder
// maps every top entry directly (it does NOT use `selectByVertical`, which keys
// off `vertical_data`).
// Dates are best-effort: the feed has no authoritative publish date, so
// `published_at` comes from the URL slug and `last_updated_raw` is the raw,
// unstructured freshness phrase pulled out of the result text.

const MAX_WEB_RESULTS = 20;

// Freshness phrases MASE embeds in result text ("Just now", "3 hours ago",
// "525 days ago"). Not a structured field — exposed raw, never parsed to a date.
const FRESHNESS_RE =
  /\b(just now|(?:\d+|an?)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)\b/i;

function hostnameOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Best-effort publish date from the URL slug (e.g. `/2026/06/09/headline` or
// `/2026-06-09-headline`). Returns `YYYY-MM-DD` (or `YYYY-MM` when no day).
// This is the stale-source guard: a marker may say "1 day ago" while the URL
// says /2023/, so we surface the slug date and let callers distrust both.
function publishedAtFromUrl(url: string | null): string | null {
  if (url === null) return null;
  const m = url.match(/\/(20\d{2})[/-](0[1-9]|1[0-2])(?:[/-](0[1-9]|[12]\d|3[01]))?(?:[/-]|$)/);
  if (!m) return null;
  return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

function entryDateKey(entry: TopEntry): string | null {
  const rec = entry as Record<string, unknown>;
  for (const key of ["published_at", "date", "pub_date"]) {
    const value = nonemptyString(rec[key]);
    if (value !== null) return value;
  }
  return null;
}

function lastUpdatedRaw(entry: TopEntry): string | null {
  // Usually embedded in the result text; occasionally a discrete field.
  const rec = entry as Record<string, unknown>;
  for (const key of ["last_updated", "lastUpdated", "freshness", "age", "last_crawl"]) {
    const value = nonemptyString(rec[key]);
    if (value !== null) return value;
  }
  const text = nonemptyString(entry.excerpt);
  const match = text?.match(FRESHNESS_RE);
  return match ? match[0] : null;
}

// Heuristic: does the URL look like a section/tag/index page rather than a
// single article? (e.g. `gadgets360.com/ai`). Best-effort — articles usually
// carry a date slug and/or a long hyphenated headline segment.
function looksLikeIndexPage(url: string | null): boolean {
  if (url === null) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return true; // bare homepage
  const sectionMarkers = ["tag", "tags", "category", "categories", "topic", "topics", "section"];
  if (segments.some((segment) => sectionMarkers.includes(segment.toLowerCase()))) return true;
  if (/\/20\d{2}[/-]\d{2}/.test(pathname)) return false; // has a date slug → article
  if (segments.length === 1) {
    const only = segments[0] ?? "";
    // Article slugs are long and hyphenated; a short single word is a section.
    return !(only.includes("-") && only.length > 12);
  }
  return false;
}

// Row mapping for `web_search`: maps a plain `summary.top[]` of web entries
// (no `vertical_data`) into the typed row shape.
function webEntriesFromSummary(result: SearchResult): {
  top: ReturnType<typeof topFromSummary>;
  rows: Array<{
    title: string;
    url: string | null;
    source: string | null;
    snippet: string | null;
    published_at: string | null;
    last_updated_raw: string | null;
    favicon_url: string | null;
    rank: number;
    is_index_page: boolean;
  }>;
} {
  const top = topFromSummary(result.summary);
  const rows = top.slice(0, MAX_WEB_RESULTS).map((entry, index) => {
    const url = nonemptyString(entry.url);
    return {
      title: nonemptyString(entry.title) ?? "Untitled",
      url,
      source: nonemptyString(entry.domain) ?? hostnameOf(url),
      snippet: nonemptyString(entry.excerpt),
      published_at: publishedAtFromUrl(url) ?? entryDateKey(entry),
      last_updated_raw: lastUpdatedRaw(entry),
      favicon_url: nonemptyString(entry.favicon_url),
      rank: typeof entry.rank === "number" ? entry.rank : index,
      is_index_page: looksLikeIndexPage(url),
    };
  });
  return { top, rows };
}

// `web_search` is the generic web tool: query sent with NO vertical (empty
// `verticals`), so `vertical` is "". Web entries land in `results`.
export function buildWebSearchResult(result: SearchResult): ToolWebSearchResult {
  const { top, rows } = webEntriesFromSummary(result);
  return {
    summary: rows.length === 0
      ? "No results available for this query."
      : `Found ${rows.length} result(s).`,
    vertical: "",
    results: rows,
    sources: topSources(top).slice(0, 5),
  };
}

// Single mapping entry point shared by both runtimes. Builds the typed result
// for `method` from a raw `SearchResult`, then validates it against the SDK
// schema (same parse the local worker has always done) so the two runtimes
// cannot return divergent shapes. `hourly_hours` caps weather's hourly series;
// `symbol`/`interval`/`since`/`until` drive finance resolution and history.
export type BuildToolOptions = {
  hourly_hours?: number;
  interval?: ToolFinanceInterval;
  since?: string;
  until?: string;
  symbol?: string;
};

export function buildToolContent(
  method: "weather",
  result: SearchResult,
  options?: BuildToolOptions,
): ToolWeatherResult;
export function buildToolContent(
  method: "sports_data",
  result: SearchResult,
  options?: BuildToolOptions,
): ToolSportsDataResult;
export function buildToolContent(
  method: "finance",
  result: SearchResult,
  options?: BuildToolOptions,
): ToolFinanceResult;
export function buildToolContent(
  method: "finance_ticker",
  result: SearchResult,
  options?: BuildToolOptions,
): ToolFinanceTickerResult;
export function buildToolContent(
  method: "web_search",
  result: SearchResult,
  options?: BuildToolOptions,
): ToolWebSearchResult;
// General overload for callers holding a non-literal method (e.g. the Cloudflare
// runtime, which dispatches by a `ToolMethod` variable): returns `JsonValue`.
// Declared after the literal overloads so literal callers still get the precise
// typed result.
export function buildToolContent(
  method: "weather" | "sports_data" | "finance" | "finance_ticker" | "web_search",
  result: SearchResult,
  options?: BuildToolOptions,
): JsonValue;
export function buildToolContent(
  method: string,
  result: SearchResult,
  options: BuildToolOptions = {},
): JsonValue {
  switch (method) {
    case "weather":
      return TOOL_WEATHER_RESULT_SCHEMA.parse(
        buildWeatherResult(result, options.hourly_hours),
      ) as JsonValue;
    case "sports_data":
      return TOOL_SPORTS_DATA_RESULT_SCHEMA.parse(buildSportsDataResult(result)) as JsonValue;
    case "finance":
      return TOOL_FINANCE_RESULT_SCHEMA.parse(
        buildFinanceResult(result, options.interval, options.since, options.until),
      ) as JsonValue;
    case "finance_ticker":
      return TOOL_FINANCE_TICKER_RESULT_SCHEMA.parse(
        buildFinanceTickerResult(
          result,
          options.symbol ?? "",
          options.interval,
          options.since,
          options.until,
        ),
      ) as JsonValue;
    case "web_search":
      return TOOL_WEB_SEARCH_RESULT_SCHEMA.parse(buildWebSearchResult(result)) as JsonValue;
    default:
      throw new Error(`unknown ctx.tool method: ${method}`);
  }
}
