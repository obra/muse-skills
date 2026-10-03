// Builder-facing UI probe: a resident browser session the builder drives, and
// the thin CLI it drives it with.
//
// Why it exists: `ctx.*` only exists inside a built action's runtime, so
// `probe-ctx.js` gives the builder a way to test data sources before committing
// to a build. The UI had no equivalent — the only way to see the artifact was a
// full `web_artifact_audit` round trip, so builders wrote the whole app before
// looking at it once, then debugged hand-authored Playwright selectors instead
// of the app. This is the missing sibling: `observe` / `act` against a page that
// stays warm between calls.
//
// Two modes in one bundle:
//   serve  — spawned by the `web_artifact_audit` tool. Owns Chromium, the
//            notary token and the page; listens on a UDS. Never exits on its
//            own except on idle or when its parent kills it.
//   client — every other verb. Connects to that socket, sends one JSON line,
//            prints one JSON line, exits. This is what the builder runs.
//
// Security posture: the notary endorsement token and the Sentinel egress token
// live only in the server process, exactly as they do for the one-shot audit —
// they arrive on stdin (never argv, which is world-readable via
// /proc/<pid>/cmdline) and are never echoed into a response. The op set below is
// deliberately CLOSED: observe / act / viewport / flag / status / close. Nothing
// evaluates caller-supplied script, takes a URL, or returns a raw response body.
// The one-shot audit protects that token by process isolation (test bodies run
// through `new Function` with a scrubbed global scope); a socket the builder can
// reach moves that protection from isolation to protocol, so the protocol has to
// stay closed. Do not add an `eval` op.

import { createHash } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  attachAuditNetworkPolicy,
  buildLaunchOptions,
  ensureChromium,
  findSystemChrome,
  collectRawImages,
  installPageDiagnostics,
  loadPlaywright,
  navigateAndSettle,
  newExternalRequestLog,
  readAuditTokensFromStdin,
  readBodyText,
  scanTextIssues,
  startProxyAuthRelay,
  summarizeImages,
  type ExternalRequestLog,
  type FailedImageRequest,
} from "./playwright-audit";
import {
  ledgerDestinationKey,
  startTransportLedger,
  unexplainedTransportHosts,
  type TransportLedgerHandle,
} from "./transport-ledger";
import {
  OBSERVE_ATTR,
  ariaSnapshot,
  freezeTimeScript,
  clippedNodes,
  observeNodes,
  settlePage,
  unnamedInteractiveNodes,
} from "./probe-ui-observe";

const SESSION_SCHEMA_VERSION = "hatch.probe_ui_session.v1";
const SOCKET_BASENAME = "sock";
const SESSION_BASENAME = "session.json";
/** Directory, relative to the space dir, that holds the socket + session file. */
export const PROBE_DIR = join(".harness", "probe-ui");
/** Idle shutdown.
 *
 *  90s was not long enough to survive a slow builder turn: the production
 *  model's gap between probe calls routinely exceeds it (big prompts, long
 *  generations), and in a 200-run fleet 9 sessions found a dead socket
 *  mid-verification and had to re-audit to get a new one. Five minutes covers
 *  the slowest observed inter-call gap with margin while still bounding how
 *  long a builder that died mid-loop leaves Chromium holding a live token —
 *  the egress token itself is clamped at 30 minutes regardless. */
const IDLE_EXIT_MS = 300_000;
/** Network-idle fallback when the artifact predates the SDK settle hook. */
const NETWORK_IDLE_FALLBACK_MS = 4_000;
/** Per-request cap so a wedged page cannot hang the builder's turn. Enforced at
 *  dispatch (`withOpTimeout`) so it bounds every op — observe/viewport/key/
 *  reload/batch and act's post-action settle — not just act's locator calls. */
const OP_TIMEOUT_MS = 30_000;
/**
 * The instant the page's clock is pinned to.
 *
 * Determinism only needs the clock to be stable *within* a session — long
 * enough that two observes of an unchanged page produce the same pixels. Pinning
 * it to a fixed calendar date instead made every date-aware artifact render the
 * wrong day during its own audit (a habit tracker showed "Thursday, January 1"
 * on July 28), which invites the builder to "fix" correct date logic against
 * what it saw and puts a wrong date in the screenshots a human reviews. So
 * freeze to the session's own start time unless a caller pins one explicitly.
 */
function frozenEpochMs(flags: Map<string, string>): number {
  const raw = Number((flags.get("frozen-epoch-ms") ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now();
}

const OPS = new Set(["observe", "act", "viewport", "flag", "status", "close", "batch", "reload", "key"]);
/** Cap on steps in one batch: enough for a real flow, small enough that a wedged
 *  page cannot hold the builder's turn open indefinitely. */
const MAX_BATCH_STEPS = 12;
// Artifacts are React apps with forms, so the gaps that bite are the ones a
// form needs: a <select> cannot be filled, a hover-revealed control cannot be
// clicked without hovering, and a modal often closes on a key sent to the page
// rather than to any node. Coordinate-level drag (Codex's `cua.drag`) is
// deliberately absent — nothing in the corpus needed it and it would reintroduce
// coordinate guessing.
const ACTIONS = new Set(["click", "fill", "press", "scroll", "select", "hover", "double_click"]);

export interface ProbeRequest {
  op: string;
  /** For `batch`: the ops to run in order. */
  steps?: ProbeRequest[];
  /** For `act`: address by accessible name instead of a node number. The name is
   *  re-resolved against a fresh walk at the moment the step runs, so a step
   *  later in a batch still binds to the page as it is *then* — and an ambiguous
   *  name is refused rather than resolved to an arbitrary match. */
  name?: string;
  snapshot_id?: string;
  node?: number;
  action?: string;
  text?: string;
  key?: string;
  dy?: number;
  preset?: string;
  severity?: string;
  what?: string;
  /** For `observe`: return only nodes whose accessible name contains this text,
   *  and drop the aria tree. See doObserve. */
  find?: string;
}

export interface ProbeFinding {
  severity: string;
  what: string;
  viewport: string;
  at_ms: number;
}

/** Parse `--k=v`, `--k v`, and bare `--flag`. The one-shot audit only accepts
 *  `--k=v`; accept both here so a caller cannot be silently misread. */
export function parseProbeArgv(argv: string[]): {
  op: string | null;
  flags: Map<string, string>;
} {
  const flags = new Map<string, string>();
  let op: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) {
      if (op === null) op = raw.trim();
      else if (!flags.has("_positional")) flags.set("_positional", raw.trim());
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      flags.set(raw.slice(2, eq), raw.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(raw.slice(2), next);
      i += 1;
    } else {
      flags.set(raw.slice(2), "true");
    }
  }
  return { op, flags };
}

/** Flags each op accepts. Anything else is a mistake worth failing on: in the
 *  production, 10 of 18 sampled runs passed --viewport — an OP, not a flag —
 *  and were silently answered in desktop, so they believed they had checked a
 *  narrow layout they never loaded. */
const KNOWN_FLAGS: Record<string, string[]> = {
  observe: ["socket", "find"],
  act: ["socket", "node", "snapshot", "click", "double_click", "fill", "select", "hover", "press", "scroll"],
  viewport: ["socket", "preset", "_positional"],
  key: ["socket", "key", "_positional"],
  reload: ["socket"],
  flag: ["socket", "severity", "what"],
  status: ["socket"],
  close: ["socket"],
  batch: ["socket"],
};

/** Build the request a client sends, or an error string explaining the misuse. */
export function requestFromArgv(
  op: string | null,
  flags: Map<string, string>,
): ProbeRequest | string {
  if (op !== null && KNOWN_FLAGS[op] !== undefined) {
    const allowed = new Set(KNOWN_FLAGS[op]);
    const unknown = [...flags.keys()].filter((f) => !allowed.has(f));
    if (unknown.length > 0) {
      const opFlag = unknown.find((u) => OPS.has(u));
      // session_id/window/tab: a model copies the probe object's `session_id`
      // into a flag. There is none — the socket alone addresses the live session.
      const idFlag = unknown.find((u) => /^(session|session_id|sessionid|window|tab)$/i.test(u));
      const hint = opFlag !== undefined
        ? ` — ${unknown.filter((u) => OPS.has(u)).join(", ")} is an op, not a flag: run it as \`probe-ui.js ${opFlag}\``
        : idFlag !== undefined
          ? ` — the live session is addressed by --socket alone; there is no --${idFlag}. The session_id in the probe object is a record id, not a CLI argument.`
          : "";
      return `${op} does not accept --${unknown.join(", --")}${hint}`;
    }
  }
  if (op === null || !OPS.has(op)) {
    return `unknown op ${JSON.stringify(op)}; expected one of ${[...OPS].join(", ")}`;
  }
  if (op === "act") {
    const nodeRaw = flags.get("node");
    const node = nodeRaw === undefined ? Number.NaN : Number(nodeRaw);
    if (!Number.isInteger(node) || node < 1) {
      return "act requires --node <n>, the number from the latest observe";
    }
    const action = [...ACTIONS].find((a) => flags.has(a));
    if (action === undefined) {
      return `act requires one of --${[...ACTIONS].join(" --")}`;
    }
    const req: ProbeRequest = { op, node, action };
    const snapshot = flags.get("snapshot");
    if (snapshot !== undefined) req.snapshot_id = snapshot;
    if (action === "fill") req.text = flags.get("fill") ?? "";
    if (action === "select") req.text = flags.get("select") ?? "";
    if (action === "press") req.key = flags.get("press") ?? "Enter";
    if (action === "scroll") req.dy = Number(flags.get("scroll") ?? "400") || 400;
    return req;
  }
  if (op === "viewport") {
    const preset = (flags.get("preset") ?? flags.get("_positional") ?? "").trim();
    if (preset !== "desktop" && preset !== "mobile") {
      return "viewport requires desktop or mobile";
    }
    return { op, preset };
  }
  if (op === "key") {
    const key = (flags.get("key") ?? flags.get("_positional") ?? "").trim();
    if (key.length === 0) return "key requires a key name, e.g. key Escape";
    return { op, key };
  }
  if (op === "flag") {
    const what = (flags.get("what") ?? "").trim();
    if (what.length === 0) return "flag requires --what \"<what you saw>\"";
    return { op, severity: (flags.get("severity") ?? "major").trim(), what };
  }
  if (op === "observe") {
    const find = (flags.get("find") ?? "").trim();
    return find.length > 0 ? { op, find } : { op };
  }
  return { op };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

interface SessionState {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  url: string;
  slug: string;
  daemonOrigin: string;
  /** Unique per audit; mixed into snapshot ids so they cannot collide. */
  auditSessionId: string;
  viewport: "desktop" | "mobile";
  /** Every viewport this session actually loaded, for the session record. */
  viewportsSeen: Set<string>;
  /** Rotated on every observe and every act; `act` refuses a stale one so the
   *  model can never operate on a node list that no longer describes the page. */
  snapshotId: string | null;
  consoleErrors: string[];
  failedImages: FailedImageRequest[];
  /** Whether the transport ledger fronted this session (the same egress
   *  lockdown as the audit render). Drives the diagnostics classification:
   *  under lockdown a refused cross-origin image is `images.external_blocked`
   *  and a refused fetch is an external fetch failure, never a page defect.
   *  False when the ledger failed to start, so a dead external image is a
   *  real broken image again. */
  egressLockdown: boolean;
  /** Refused-external console errors diverted out of `consoleErrors` under
   *  lockdown, counted so they stay visible as a lockdown artifact. */
  externalFetchFailures: { count: number; samples: string[] };
  findings: ProbeFinding[];
  navStatus: number | null;
  observes: number;
  acts: number;
  /** Highest interactive-node count seen, and whether any act ever landed —
   *  the completion gate needs "the artifact offers interactions and none were
   *  driven" to be a measured fact rather than the builder's self-assessment. */
  interactiveNodesSeen: number;
  actedOk: number;
  /** Hash of the last screenshot, so an observe can say whether the picture
   *  actually changed. `exec` output is text and only the `read` tool can turn a
   *  path into pixels, so the model has to spend a turn to look — this is what
   *  tells it when that turn is worth spending. */
  lastShotHash: string | null;
  /** The path + hash of the frame the last observe/act actually pointed the model
   *  at with a `look_at_screenshot` directive. The "you already have this frame"
   *  hint may only reference THIS frame — never a bare "last capture" (which can
   *  be an act frame the model never opened), so the tool never tells a caller a
   *  brand-new screenshot needs no reading against pixels it was never shown. */
  lastSurfacedShot: { path: string; hash: string } | null;
}

function newSnapshotId(state: SessionState): string {
  // Must be unique ACROSS sessions, not just within one. Hashing (observes, acts)
  // alone is deterministic — and the page PRNG is frozen — so the first snapshot
  // of every session was s1-1663353798, across 9 sampled production runs. A model
  // holding two identical ids cannot tell which page it is looking at, which is
  // exactly the build-identity confusion the trajectories show.
  const id = `s${state.observes}-${Math.abs(
    hash32(`${state.auditSessionId}:${state.observes}:${state.acts}`),
  ).toString(36)}`;
  state.snapshotId = id;
  return id;
}

/** Small deterministic hash; snapshot ids must not depend on wall time because
 *  the page's clock is frozen and `Math.random` is seeded. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Write this frame to a PNG and say whether it differs from the previous frame.
 *
 * Shared by `observe` and `act` so the changed-detection is one running
 * comparison across both: an act that visibly did nothing reports
 * `screenshot_changed: false`, which is the cheapest possible "your click had no
 * effect" signal and needs no assertion from the model.
 */
async function captureFrame(
  state: SessionState,
  auditDir: string | null,
  name: string,
): Promise<{ path: string | null; changed: boolean | null; hash: string | null }> {
  if (auditDir === null) return { path: null, changed: null, hash: null };
  const path = join(auditDir, name);
  try {
    await state.page.screenshot({ path, fullPage: false });
    const hash = createHash("sha256").update(await readFile(path)).digest("hex");
    const changed = state.lastShotHash === null ? true : hash !== state.lastShotHash;
    state.lastShotHash = hash;
    return { path, changed, hash };
  } catch {
    return { path: null, changed: null, hash: null };
  }
}

/**
 * The imperative that gets the model to actually look.
 *
 * Measured across 8 production runs before this existed: 73 frames written, 31
 * carrying a "look_at_screenshot" hint, and ZERO reads. The hint was a
 * mid-object metadata field on `observe` only, and `act` returned no image at
 * all while its `next` line told the model a fresh observe was needed only "when
 * you need node numbers to act on, or a screenshot" -- so immediately after
 * changing the page, the one moment the picture matters most, there was nothing
 * to look at and nothing asking it to. This returns a directive, first in the
 * object so it survives the `head`/`tail`/`jq` truncation the model applies to
 * 63% of its own probe calls, and it is phrased as the next step rather than as
 * an observation about the file.
 */
export function lookDirective(
  path: string | null,
  acted: boolean,
  sameAsSeen?: string | null,
): string | undefined {
  if (path === null) return undefined;
  if (sameAsSeen) {
    // Byte-identical to a frame we already pointed the model at. For an act that
    // is a hard signal — the action produced nothing new. For an observe, condition
    // the skip on the model actually having looked: never tell it a brand-new file
    // "needs no reading" against pixels it may never have opened.
    return acted
      ? `THE PIXELS DID NOT CHANGE. Your action ran but this frame is byte-identical to ${sameAsSeen} — treat that as evidence the action had no visible effect, and check whether it was supposed to.`
      : `This frame is byte-identical to ${sameAsSeen}. If you already read ${sameAsSeen}, no need to re-read it; if you have not, READ ${path} now — the tree below cannot show layout, clipping, overlap, contrast or styling.`;
  }
  return acted
    ? `READ ${path} NOW with the read tool. You just changed the page; this is the frame you have to judge, and the tree below cannot show layout, clipping, overlap, contrast or styling. Do not report on this action without looking at it.`
    : `READ ${path} with the read tool before judging this frame. The tree below cannot show layout, clipping, overlap, contrast or styling.`;
}

/** Compute the "you already have this" pointer for a freshly captured frame, and
 *  advance the surfaced-frame baseline to it. Returns the path of a prior frame
 *  the caller was already directed at when this one is byte-identical, else null.
 *  Called by observe/act (and, through them, batch steps) so every directive is
 *  computed against the frame the model was last pointed at. */
function surfaceFrame(
  state: SessionState,
  frame: { path: string | null; hash: string | null },
): string | null {
  const sameAsSeen =
    frame.hash !== null &&
    state.lastSurfacedShot !== null &&
    state.lastSurfacedShot.hash === frame.hash
      ? state.lastSurfacedShot.path
      : null;
  if (frame.path !== null && frame.hash !== null) {
    state.lastSurfacedShot = { path: frame.path, hash: frame.hash };
  }
  return sameAsSeen;
}

/**
 * `observe --find <text>`: the whole frame, narrowed to the nodes you asked for.
 *
 * A full frame is ~5.5k chars at p50 and 34k at worst, and `nodes[]` is 45% of
 * those bytes. The model does not passively absorb that: in production it piped
 * 63% of its own probe calls through `head`/`tail`/`jq`, and where it reached for
 * python the query was almost always the same one -- give me the node whose name
 * contains this:
 *
 *   python3 -c "... [n for n in d['nodes'] if 'stage' in n['name'].lower()]"
 *   python3 -c "... [n for n in d['nodes'] if 'total' in n['name'].lower()]"
 *
 * That is a missing CLI capability being emulated in shell, and the emulation is
 * worse than the real thing: `tail -c 800` truncates mid-JSON, which is why a
 * third of the probe stdout in the corpus did not parse. So answer the question
 * directly. Node numbers are preserved from the full walk, so a `--find` result
 * is immediately actionable; the aria tree is dropped because a targeted lookup
 * does not want a 1.5k-char tree, and the counts say what was filtered out so a
 * narrowed view can never read as the whole page.
 */
export function narrowToFind(
  frame: Record<string, unknown>,
  find: string,
): Record<string, unknown> {
  const wanted = find.trim().toLowerCase();
  const all = (frame.nodes ?? []) as Array<{ name?: string }>;
  const matched = all.filter((n) => (n.name ?? "").toLowerCase().includes(wanted));
  const { aria: _aria, ...rest } = frame;
  return {
    ...rest,
    find,
    nodes: matched,
    nodes_matched: matched.length,
    nodes_total: all.length,
    aria_omitted: "observe without --find to get the accessibility tree",
    ...(matched.length === 0
      ? { hint: `no visible node's name contains ${JSON.stringify(find)} — observe without --find to see what is actually on the page` }
      : {}),
  };
}

async function doObserve(
  state: SessionState,
  auditDir: string | null,
  find?: string,
): Promise<Record<string, unknown>> {
  const settle = await settlePage(state.page, NETWORK_IDLE_FALLBACK_MS);
  const walk = await observeNodes(state.page);
  const aria = await ariaSnapshot(state.page);
  state.observes += 1;
  state.interactiveNodesSeen = Math.max(
    state.interactiveNodesSeen,
    walk.interactive_nodes,
  );
  const snapshotId = newSnapshotId(state);

  const frame = await captureFrame(
    state,
    auditDir,
    `observe-${String(state.observes).padStart(3, "0")}.png`,
  );
  const screenshotPath = frame.path;
  const screenshotChanged = frame.changed;
  const sameAsSeen = surfaceFrame(state, frame);

  const images = await collectRawImages(state.page)
    .then((raw) =>
      summarizeImages(raw, state.failedImages, state.daemonOrigin, state.egressLockdown),
    )
    .catch(() => null);
  const textIssues = await readBodyText(state.page)
    .then(scanTextIssues)
    .catch(() => []);
  const unnamed = unnamedInteractiveNodes(walk);
  const clipped = clippedNodes(walk);
  // Drain the diagnostics so each look reports what happened since the last one
  // rather than re-reporting the page's whole history on every observe.
  const consoleErrors = state.consoleErrors.splice(0, state.consoleErrors.length);

  // Field order is load-bearing: the model truncates its own probe output with
  // head/tail/jq on most calls, and `aria` + `nodes` are the bulk of the bytes.
  // Every compact verdict/gate field goes ABOVE them so a partial read still
  // carries the screenshot directive, the change flag, and the reachability
  // channels; the two big arrays sit last, where a reader that wants them looks.
  const response: Record<string, unknown> = {
    ok: true,
    look_at_screenshot: lookDirective(screenshotPath, false, sameAsSeen),
    snapshot_id: snapshotId,
    viewport: state.viewport,
    settled: settle.settled,
    settle_ms: settle.settle_ms,
    // null here just means the artifact predates the SDK settle hook; printing
    // "in_flight": null made readers ask what was wrong. Omit it instead.
    ...(settle.in_flight === null ? {} : { in_flight: settle.in_flight }),
    nav_status: state.navStatus,
    screenshot_path: screenshotPath,
    screenshot_sha256: frame.hash,
    screenshot_changed: screenshotChanged,
    interactive_nodes: walk.interactive_nodes,
    nodes_truncated: walk.truncated,
    total_candidates: walk.total_candidates,
    console_errors: consoleErrors,
    // Refused externals under the lockdown, diverted out of `console_errors`;
    // nonzero here is the lockdown at work, never a page defect.
    external_fetch_failures: state.externalFetchFailures.count,
    images,
    text_issues: textIssues,
    unnamed_interactive: unnamed.map((n) => ({ i: n.i, tag: n.tag, bbox: n.bbox })),
    clipped_nodes: clipped,
    // Controls the user cannot operate at this viewport, and why. These are NOT
    // in `nodes` (you cannot act on them), so without this channel they were
    // simply absent and the model read their absence as "not there" rather than
    // "there but unusable".
    unreachable_controls: walk.unreachable,
    needs_inner_scroll: walk.needs_inner_scroll,
    // in_flight null with settled false is the network-idle fallback timing out
    // (no SDK hook), so the note must not print a count.
    note: settle.settled
      ? undefined
      : settle.in_flight === null
        ? `network still active after ${settle.settle_ms}ms (no SDK settle hook; network idle did not arrive inside the window); the artifact may not have finished loading`
        : `still fetching after ${settle.settle_ms}ms (${settle.in_flight} query/queries in flight); the artifact has not finished loading`,
    // The two bulky arrays last, so head/tail/jq truncation drops these, not the
    // verdict fields above. `nodes` (the actionable list the model addresses its
    // next act by) precedes `aria`: on a dense page even the model's own `head -c`
    // clips the tail, and `aria` — a tree the screenshot already shows — is the
    // one field safe to lose. Keep it dead last so a clipped read still carries
    // the numbered nodes.
    nodes: walk.nodes,
    aria,
  };
  return find !== undefined && find.trim().length > 0 ? narrowToFind(response, find) : response;
}

/**
 * Resolve an `act` addressed by accessible name against the page as it is now.
 *
 * Batching a flow into one call is the whole point — 194 one-op calls cost 194
 * model turns in sampled production runs — but a node number captured before step 1 may
 * describe a page that step 1 destroyed. Re-walking and matching by name keeps
 * every step bound to the live page without the model predicting anything, and
 * an ambiguous or missing name stops the batch instead of clicking something
 * arbitrary.
 */
async function resolveByName(
  state: SessionState,
  name: string,
): Promise<{ node: number } | { error: string }> {
  const walk = await observeNodes(state.page);
  const wanted = name.trim().toLowerCase();
  const exact = walk.nodes.filter((n) => n.name.trim().toLowerCase() === wanted);
  const hits = exact.length > 0
    ? exact
    : walk.nodes.filter((n) => n.name.toLowerCase().includes(wanted));
  if (hits.length === 0) {
    return { error: `no visible node named ${JSON.stringify(name)}; observe to see what is there` };
  }
  if (hits.length > 1) {
    return {
      error: `${hits.length} visible nodes match ${JSON.stringify(name)} (${hits
        .map((h) => `${h.i}:${h.tag}`)
        .join(", ")}); observe and act by node number instead`,
    };
  }
  state.snapshotId = newSnapshotId(state);
  return { node: hits[0]!.i };
}

async function doBatch(
  state: SessionState,
  auditDir: string | null,
  req: ProbeRequest,
): Promise<Record<string, unknown>> {
  const steps = req.steps ?? [];
  if (steps.length === 0) {
    return { ok: false, code: "empty_batch", error: "batch needs a non-empty steps array" };
  }
  if (steps.length > MAX_BATCH_STEPS) {
    return {
      ok: false,
      code: "batch_too_long",
      error: `batch has ${steps.length} steps; the cap is ${MAX_BATCH_STEPS}`,
    };
  }
  const log: Record<string, unknown>[] = [];
  let last: Record<string, unknown> | null = null;
  for (const [idx, raw] of steps.entries()) {
    if (raw.op === "batch") {
      log.push({ step: idx + 1, op: raw.op, ok: false, error: "a batch step cannot itself be a batch" });
      break;
    }
    if (raw.op === undefined || !OPS.has(raw.op)) {
      // Missing or misspelled "op" — the old message ("not allowed inside a
      // batch") mislabelled a schema mistake as a nesting rule. Say the real
      // shape instead: each step is one op object, addressed by name.
      log.push({
        step: idx + 1,
        op: raw.op ?? null,
        ok: false,
        error:
          `${raw.op === undefined ? 'step has no "op" key' : `unknown op ${JSON.stringify(raw.op)}`}; ` +
          `each step is {"op": "observe"|"act"|"viewport"|"key"|"flag", ...}, e.g. ` +
          `{"op":"act","name":"Add habit","action":"click"} or ` +
          `{"op":"act","name":"Destination","action":"fill","text":"Kyoto"} or {"op":"observe"}`,
      });
      break;
    }
    const step: ProbeRequest = { ...raw };
    if (step.op === "act" && step.name !== undefined && step.node === undefined) {
      const resolved = await resolveByName(state, step.name);
      if ("error" in resolved) {
        log.push({ step: idx + 1, op: "act", name: step.name, ok: false, error: resolved.error });
        break;
      }
      step.node = resolved.node;
      step.snapshot_id = state.snapshotId ?? undefined;
    }
    const res = await handle(state, auditDir, step);
    last = res;
    // Carry each step's evidence up into the log, not just ok/error. Without the
    // screenshot path + change flag + fresh snapshot id here, a batched flow's
    // per-step frames were written to disk but never named to the model, so it
    // could not look at any state between the first and last step.
    log.push({
      step: idx + 1,
      op: step.op,
      ...(step.name !== undefined ? { name: step.name } : {}),
      ...(step.node !== undefined ? { node: step.node } : {}),
      ok: res.ok === true,
      ...(res.snapshot_id !== undefined ? { snapshot_id: res.snapshot_id } : {}),
      ...(res.screenshot_path !== undefined ? { screenshot_path: res.screenshot_path } : {}),
      ...(res.screenshot_sha256 !== undefined ? { screenshot_sha256: res.screenshot_sha256 } : {}),
      ...(res.screenshot_changed !== undefined ? { screenshot_changed: res.screenshot_changed } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
    });
    // Fail closed: a step that did not land invalidates everything planned after
    // it, because those steps were planned against a page that never happened.
    if (res.ok !== true) break;
  }
  const allOk = log.every((l) => l.ok === true);
  // `final` carries the last frame's actionable state (nodes, gate fields, screenshot
  // path) but DROPS its aria tree, exactly as `--find` does (see narrowToFind): echoing
  // the last frame's full 14-28KB tree here is what pushed a dense batch past the
  // harness large-output cap and into cat/parse detours. The tree is re-fetchable with
  // a plain observe, and the screenshot the step already named shows the frame.
  let finalState: Record<string, unknown> | null = null;
  if (last) {
    if ("aria" in last) {
      const { aria: _finalAria, ...rest } = last;
      finalState = { ...rest, aria_omitted: "observe to get the accessibility tree for the final frame" };
    } else {
      finalState = last;
    }
  }
  return {
    ok: allOk,
    // One directive for the whole batch, verdict-first, instead of echoing the same
    // ~200-char string once per step (pure duplication x N steps). Each step above keeps
    // its own screenshot_path + screenshot_changed, so the model reads only moved frames.
    look_at_screenshot:
      "READ each step's screenshot_path below whose screenshot_changed is true, with the " +
      "read tool, before judging what the batch did — the tree cannot show layout, " +
      "clipping, overlap, or contrast. The final frame's node list is in `final`; " +
      "observe again if you need an earlier step's nodes.",
    steps: log,
    stopped_early: !allOk,
    final: finalState,
  };
}

async function doAct(
  state: SessionState,
  req: ProbeRequest,
  auditDir: string | null,
): Promise<Record<string, unknown>> {
  if (state.snapshotId === null) {
    return { ok: false, code: "no_snapshot", error: "call observe before act" };
  }
  if (req.snapshot_id !== undefined && req.snapshot_id !== state.snapshotId) {
    return {
      ok: false,
      code: "stale_snapshot",
      error: `snapshot ${req.snapshot_id} is stale (current ${state.snapshotId}); observe again`,
    };
  }
  const locator = state.page.locator(`[${OBSERVE_ATTR}="${req.node}"]`);
  const count = await locator.count().catch(() => 0);
  if (count !== 1) {
    // The page re-rendered out from under the node list. Fail closed: the whole
    // point of numbered nodes is that the model never reasons about a state the
    // harness did not just show it.
    state.snapshotId = null;
    return {
      ok: false,
      code: "stale_node",
      error: `node ${req.node} resolved to ${count} elements; observe again`,
      acted: false,
    };
  }

  let acted = false;
  let actionError: string | null = null;
  try {
    if (req.action === "click") await locator.click({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "double_click") await locator.dblclick({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "hover") await locator.hover({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "select") {
      await locator.selectOption(req.text ?? "", { timeout: OP_TIMEOUT_MS });
    }
    else if (req.action === "fill") await locator.fill(req.text ?? "", { timeout: OP_TIMEOUT_MS });
    else if (req.action === "press") await locator.press(req.key ?? "Enter", { timeout: OP_TIMEOUT_MS });
    else if (req.action === "scroll") {
      await locator.scrollIntoViewIfNeeded({ timeout: OP_TIMEOUT_MS });
      await state.page.mouse.wheel(0, req.dy ?? 400);
    }
    acted = true;
  } catch (err) {
    actionError = (err as Error).message?.split("\n")[0] ?? String(err);
  }
  state.acts += 1;
  if (acted) state.actedOk += 1;

  const settle = await settlePage(state.page, NETWORK_IDLE_FALLBACK_MS);
  const aria = await ariaSnapshot(state.page);
  // A fresh snapshot id: the act changed the page, so every previously offered
  // node number is now unverified.
  state.snapshotId = null;
  const consoleErrors = state.consoleErrors.splice(0, state.consoleErrors.length);
  // An act gets its own frame. The moment right after the page changed is when
  // the picture is worth the most, and the previous cut returned no image here
  // at all -- so the model judged its own actions from a tree, and read none of
  // the 73 frames the session wrote.
  const frame = await captureFrame(
    state,
    auditDir,
    `act-${String(state.acts).padStart(3, "0")}.png`,
  );
  const sameAsSeen = surfaceFrame(state, frame);
  return {
    ok: acted,
    // First key deliberately; see lookDirective.
    look_at_screenshot: lookDirective(frame.path, acted, sameAsSeen),
    acted,
    error: actionError ?? undefined,
    settled: settle.settled,
    settle_ms: settle.settle_ms,
    screenshot_path: frame.path,
    screenshot_sha256: frame.hash,
    // Same field name observe uses: one word for "did the picture change", not a
    // second name for the same thing (the split frame_changed/screenshot_changed
    // made models treat them as different signals).
    screenshot_changed: frame.changed,
    console_errors: consoleErrors,
    external_fetch_failures: state.externalFetchFailures.count,
    // Steer the ratio: sampled runs spent 194 observes on 38 acts, and an act
    // already returns the post-action tree, so a bare re-observe is usually
    // waste. Looking at the frame is not -- keep those two straight.
    next: acted
      ? "the post-action tree is below (`aria`), so you only need a fresh `observe` when you want node numbers to act on. Read the screenshot above before you judge what this action did. If you already know the next few steps, send them as one `batch` call instead of one call per step."
      : "observe to get a fresh node list",
    // `aria` dead last, same as observe: the model truncates its own output, and
    // the tree (which the screenshot already shows) is the one field safe to lose.
    // `console_errors` — where a 4xx/5xx from the artifact's own route blocks the
    // attestation — and `next` must survive that cut, so they precede it.
    aria,
  };
}

async function applyViewport(state: SessionState, preset: string): Promise<void> {
  const isMobile = preset === "mobile";
  const viewport = isMobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
  await state.page.setViewportSize({ ...viewport });
  state.viewport = isMobile ? "mobile" : "desktop";
  state.viewportsSeen.add(state.viewport);
  // The node list described the previous layout; refuse to act on it.
  state.snapshotId = null;
}

async function handle(
  state: SessionState,
  auditDir: string | null,
  req: ProbeRequest,
): Promise<Record<string, unknown>> {
  switch (req.op) {
    case "observe":
      return doObserve(state, auditDir, req.find);
    case "act":
      return doAct(state, req, auditDir);
    case "viewport":
      await applyViewport(state, req.preset ?? "desktop");
      return { ...(await doObserve(state, auditDir)), viewport_changed: state.viewport };
    case "flag":
      state.findings.push({
        severity: req.severity ?? "major",
        what: req.what ?? "",
        viewport: state.viewport,
        at_ms: Date.now(),
      });
      return { ok: true, findings: state.findings.length };
    case "reload": {
      // The session's page is navigated once at startup, so after a rebuild it
      // shows the previous bundle. The tool restarts the probe per audit, but a
      // builder that rebuilt mid-session needs this to see its own change.
      state.navStatus = await navigateAndSettle(state.page, state.url);
      state.snapshotId = null;
      state.lastShotHash = null;
      state.lastSurfacedShot = null;
      return { ...(await doObserve(state, auditDir)), reloaded: true };
    }
    case "key": {
      // A key sent to the page rather than to a node: Escape to dismiss a modal
      // whose overlay is not an addressable target, Tab to walk focus. Return a
      // full observe of the result — dismissing a modal changes the page, and the
      // new frame (screenshot + look directive + fresh, actionable node list) is
      // exactly what the caller needs next. Returning only aria left the model
      // with no picture and no numbered nodes right after a state change.
      await state.page.keyboard.press(req.key ?? "Escape");
      return { ...(await doObserve(state, auditDir)), key: req.key ?? "Escape" };
    }
    case "batch":
      return doBatch(state, auditDir, req);
    case "status":
      return {
        ok: true,
        slug: state.slug,
        url: state.url,
        viewport: state.viewport,
        observes: state.observes,
        acts: state.acts,
        acts_ok: state.actedOk,
        interactive_nodes_seen: state.interactiveNodesSeen,
        findings: state.findings,
        snapshot_id: state.snapshotId,
      };
    default:
      return { ok: false, code: "unknown_op", error: `unsupported op ${req.op}` };
  }
}

/**
 * Bound one socket op by {@link OP_TIMEOUT_MS}. A page whose JS main thread is
 * blocked (heavy sync compute, an infinite loop) makes an unguarded
 * `page.evaluate` in `settlePage`/`observeNodes` never resolve, so observe,
 * viewport, key, reload, batch, and act's post-action settle would otherwise
 * hang until the 5-minute idle timer tore the whole session down. Racing here
 * returns a bounded `op_timeout` instead; the losing `handle` promise is left
 * pending (the page is wedged, so it never resolves anyway) while the process
 * stays up to serve — and bound — the next op.
 */
async function withOpTimeout(
  work: Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<Record<string, unknown>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          code: "op_timeout",
          error: `op exceeded ${OP_TIMEOUT_MS} ms; the page's main thread is likely blocked`,
        }),
      OP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const PROBE_NETWORK_BASENAME = "probe-network.json";

/**
 * The interaction phase's network record.
 *
 * Human evidence for now: no daemon or Sentinel code reads this file yet; it
 * exists so an investigator can see what the page tried to send while the
 * builder drove it. When an automated reader lands, it should consume this
 * record rather than a second capture.
 *
 * The one-shot audit only ever sees the page as it loads; click-triggered
 * exfiltration executes here, in the resident session the builder drives. So
 * this session runs behind the same transport ledger and keeps the same
 * capture, and writes both out next to the session's frames — otherwise the
 * only artifact of the phase where the interesting sends happen is a
 * screenshot.
 *
 * Written after every op and at teardown, not only at shutdown: the parent
 * kills this process, so a shutdown-only write would routinely lose the record.
 */
async function writeProbeNetworkRecord(
  outputDir: string,
  ledger: TransportLedgerHandle | null,
  externalRequests: ExternalRequestLog,
  url: string,
): Promise<void> {
  const explained = new Set<string>();
  const probeDestination = ledgerDestinationKey(url);
  if (probeDestination !== null) {
    explained.add(probeDestination);
  }
  for (const request of externalRequests.requests) {
    const destination = ledgerDestinationKey(request.url);
    if (destination !== null) {
      explained.add(destination);
    }
  }
  await writeFile(
    join(outputDir, PROBE_NETWORK_BASENAME),
    JSON.stringify(
      {
        // False means the interaction phase's transport view is UNOBSERVED
        // (host/dev run, or a ledger that would not start), never that
        // nothing connected.
        probe_transport_ledger_active: ledger !== null,
        external_requests: externalRequests.requests,
        external_requests_dropped: externalRequests.dropped,
        external_requests_dropped_data_bearing: externalRequests.dropped_data_bearing,
        transport_connections:
          ledger === null ? [] : [...ledger.state.entries.values()],
        transport_udp_attempts: ledger === null ? 0 : ledger.state.udp_attempts,
        transport_overflow: ledger === null ? 0 : ledger.state.overflow,
        unexplained_transport_hosts:
          ledger === null
            ? []
            : unexplainedTransportHosts(ledger.state, explained),
      },
      null,
      2,
    ) + "\n",
  );
}

/** Everything the Rust side needs to read back after the session ends. */
async function writeSessionSummary(
  probeDir: string,
  state: SessionState,
  sessionId: string | null,
): Promise<void> {
  await writeFile(
    join(probeDir, "summary.json"),
    JSON.stringify(
      {
        schema_version: "hatch.probe_ui_summary.v1",
        slug: state.slug,
        // The audit session this probe served under (the `--audit-session`
        // UUID), or null on a host/dev run. The completion gate requires this to
        // match the capture envelope's `audit_session_id` before it pairs the
        // envelope's node count with these acts, so it can never grade a build
        // against a stale probe session left over from an earlier audit.
        session_id: sessionId,
        observes: state.observes,
        acts: state.acts,
        acts_ok: state.actedOk,
        interactive_nodes: state.interactiveNodesSeen,
        // The viewports actually loaded. A mobile claim on a session whose list
        // is ["desktop"] is contradicted by its own record.
        viewports_seen: [...state.viewportsSeen].sort(),
        findings: state.findings,
      },
      null,
      2,
    ) + "\n",
  );
}

async function serve(flags: Map<string, string>): Promise<number> {
  // Keep the canonical Space identity in builder-visible state while using the
  // opaque route alias exclusively for browser request admission.
  const slug = (flags.get("slug") ?? "").trim();
  const routeSlug = (flags.get("route-slug") ?? "").trim();
  const url = (flags.get("url") ?? "").trim();
  const spaceDir = (flags.get("space-dir") ?? "").trim();
  const socketPath = (flags.get("socket") ?? "").trim()
    || (spaceDir ? join(spaceDir, PROBE_DIR, SOCKET_BASENAME) : "");
  const auditSessionId = (flags.get("audit-session") ?? flags.get("session") ?? "").trim() || null;
  const auditDir = (flags.get("audit-dir") ?? "").trim() || null;
  const proxyServer = (flags.get("proxy-server") ?? "").trim() || null;
  const proxyAuthUsername = (flags.get("proxy-auth-username") ?? "").trim() || null;
  if (!slug || !routeSlug || !url || !socketPath) {
    process.stderr.write(
      "probe-ui serve: --slug, --route-slug, --url and (--socket or --space-dir) are required\n",
    );
    return 2;
  }

  const { notaryToken, proxyAuthToken } = await readAuditTokensFromStdin();
  const probeDir = dirname(socketPath);
  await mkdir(probeDir, { recursive: true });
  if (auditDir !== null) await mkdir(auditDir, { recursive: true });

  // Same egress posture as the one-shot audit: the token must be behind a
  // loopback relay before Chromium starts, never handed to Playwright.
  let effectiveProxy = proxyServer;
  let relayClose: (() => Promise<void>) | null = null;
  if (proxyServer !== null && proxyAuthToken !== null) {
    // CONNECT-only from the first byte: with the transport ledger fronting
    // Chromium (below), the relay's only legitimate client is the ledger's
    // CONNECT hop, and an origin-form request would carry the injected
    // credential for any loopback caller — including the audited page, which
    // Chromium never proxies loopback traffic away from. The ledger-failure
    // fallback reopens origin-form explicitly.
    const relay = await startProxyAuthRelay(
      proxyServer,
      proxyAuthUsername ?? "hatch-runtime",
      proxyAuthToken,
      { connectOnly: true },
    );
    effectiveProxy = relay.server;
    relayClose = relay.close;
  }

  // Front the resident Chromium with the same loopback SOCKS5 transport ledger
  // and egress lockdown the one-shot audit uses: only the artifact's own
  // origin (exact host AND port) tunnels out, every other destination is
  // recorded and refused at this hop, so the interaction phase reaches
  // Sentinel with nothing and raises no mid-build approval prompt. Chromium is
  // pointed at the ledger's socks5 URL, which also switches
  // `buildHostResolverRulesArg` into its socks5h shape (names resolve
  // proxy-side, so a hostname carrying data lands in the ledger).
  //
  // Unlike the audit, a ledger that will not start does NOT fail the session:
  // the socket is about to be advertised to a builder mid-turn and "an
  // advertised socket always answers" outranks fail-closed here. The record
  // says so with `probe_transport_ledger_active: false`.
  let transportLedger: TransportLedgerHandle | null = null;
  if (effectiveProxy !== null) {
    try {
      const probeDestination = ledgerDestinationKey(url);
      if (probeDestination === null) {
        throw new Error(`probe url has no TCP destination: ${url}`);
      }
      transportLedger = await startTransportLedger(effectiveProxy, {
        allowedDestinations: new Set([probeDestination]),
      });
      effectiveProxy = transportLedger.server;
    } catch (err) {
      process.stderr.write(
        `[probe-ui] transport ledger failed to start; continuing without egress lockdown: ${String(err)}\n`,
      );
      transportLedger = null;
      // Without the ledger, Chromium talks to the relay directly as its HTTP
      // proxy and plain-http fetches need the origin-form path — restart the
      // relay open. Only this explicit fallback runs origin-form.
      if (relayClose !== null && proxyServer !== null && proxyAuthToken !== null) {
        try {
          await relayClose();
        } catch {
          /* replaced below either way */
        }
        const openRelay = await startProxyAuthRelay(
          proxyServer,
          proxyAuthUsername ?? "hatch-runtime",
          proxyAuthToken,
        );
        effectiveProxy = openRelay.server;
        relayClose = openRelay.close;
      }
    }
  }

  let executablePath = findSystemChrome();
  if (executablePath === null) {
    await ensureChromium();
  }
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch(
    buildLaunchOptions(executablePath, effectiveProxy, null, proxyAuthUsername),
  );
  const context = await browser.newContext({
    viewport: { ...DESKTOP_VIEWPORT },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    // See the one-shot audit: this hop is a VM-loopback dial to the pinned
    // self-FQDN whose leaf is signed by a private CA the cell does not trust,
    // and the notary endorsement (not TLS) is the real authorization.
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(freezeTimeScript(frozenEpochMs(flags)));
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const failedImages: FailedImageRequest[] = [];
  const blockedRequests: string[] = [];
  // Persisted to probe-network.json (see writeProbeNetworkRecord): the
  // interaction phase's sends are the ones the one-shot capture cannot see.
  const externalRequests = newExternalRequestLog();
  const daemonOrigin = await attachAuditNetworkPolicy(
    page,
    url,
    slug,
    routeSlug,
    notaryToken,
    auditSessionId,
    blockedRequests,
    externalRequests,
    (flags.get("sandbox-api-socket") ?? "").trim() || null,
  );
  // The probe runs under the same egress lockdown as the audit render when the
  // ledger started, so its diagnostics classify refused externals the same way
  // the audit does instead of scoring a working CDN image as broken.
  const egressLockdown = transportLedger !== null;
  const externalFetchFailures = { count: 0, samples: [] as string[] };
  installPageDiagnostics(
    page,
    consoleErrors,
    failedImages,
    daemonOrigin,
    [],
    [],
    externalFetchFailures,
    egressLockdown,
  );

  // Frames land in the audit dir when the runner gave us one; otherwise the
  // session dir is the only durable place this record can go.
  const networkDir = auditDir ?? probeDir;
  const recordNetwork = (): Promise<void> =>
    writeProbeNetworkRecord(
      networkDir,
      transportLedger,
      externalRequests,
      url,
    ).catch(() => {});

  const state: SessionState = {
    browser,
    context,
    page,
    url,
    slug,
    daemonOrigin,
    auditSessionId: auditSessionId ?? socketPath,
    viewport: "desktop",
    viewportsSeen: new Set(["desktop"]),
    snapshotId: null,
    consoleErrors,
    failedImages,
    egressLockdown,
    externalFetchFailures,
    findings: [],
    // Filled in by the deferred navigation below the socket bind.
    navStatus: null,
    observes: 0,
    acts: 0,
    interactiveNodesSeen: 0,
    actedOk: 0,
    lastShotHash: null,
    lastSurfacedShot: null,
  };

  await writeFile(
    join(probeDir, SESSION_BASENAME),
    JSON.stringify(
      {
        schema_version: SESSION_SCHEMA_VERSION,
        socket: socketPath,
        slug,
        url,
        audit_session_id: auditSessionId,
        pid: process.pid,
      },
      null,
      2,
    ) + "\n",
  );

  // Stamp a fresh zero-act summary before the socket opens, so the completion
  // gate always finds a summary carrying THIS session's id. Without it, a VM
  // captured before the builder drove a single op would leave no summary, and a
  // stale one from an earlier audit could still be on disk; the fail-closed gate
  // needs a same-session record that honestly reads "0 acts so far" instead.
  await writeSessionSummary(probeDir, state, auditSessionId).catch(() => {});
  await recordNetwork();

  // Navigation readiness gate. The socket binds BEFORE the first navigation,
  // so the Rust side's socket-readiness wait (and with it the whole
  // `web_artifact_audit` tool call) unblocks after the browser launch instead
  // of after a full page load: the builder cannot send an op until it has read
  // the audit response, so the navigation completes inside that inference gap
  // rather than on the tool call's critical path. An op that does arrive early
  // waits here, bounded by the same `withOpTimeout` every op already has;
  // `close` stays instant because it never touches the page.
  let pageNavigated: () => void = () => {};
  const pageReady = new Promise<void>((resolve) => {
    pageNavigated = resolve;
  });
  // Set when the deferred startup navigation failed (even through its own
  // transient retry). The session then DEGRADES rather than dying: the socket
  // was already advertised in the audit response, and "an advertised socket
  // always answers" outranks fail-fast. Page ops answer `nav_failed` (never a
  // blank-frame observe), `reload` retries the navigation, and the idle timer
  // reaps an abandoned session.
  let navFailedReason: string | null = null;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    process.stderr.write(`[probe-ui] shutting down: ${reason}\n`);
    await writeSessionSummary(probeDir, state, auditSessionId).catch(() => {});
    await recordNetwork();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (transportLedger !== null) await transportLedger.close().catch(() => {});
    if (relayClose !== null) await relayClose().catch(() => {});
    server.close();
    process.exit(0);
  };
  const touchIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown("idle"), IDLE_EXIT_MS);
  };

  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      touchIdle();
      void (async () => {
        let response: Record<string, unknown>;
        try {
          const req = JSON.parse(line) as ProbeRequest;
          if (!OPS.has(req.op)) {
            response = { ok: false, code: "unknown_op", error: `unsupported op ${req.op}` };
          } else if (req.op === "close") {
            response = { ok: true, closing: true };
          } else if (req.op === "status" || req.op === "flag") {
            // State-only ops never touch the page: answer them even while the
            // startup navigation is still in flight (status then honestly
            // reports nav_status: null).
            response = await withOpTimeout(handle(state, auditDir, req));
          } else {
            // Wait for the deferred startup navigation OUTSIDE the op's own
            // timeout race. Gating inside withOpTimeout would let an op that
            // loses the 30s race keep running as an abandoned closure and act
            // on the page once navigation lands (~38s worst case with the nav
            // retry): a ghost act the client was told failed — double-executed
            // when the client retries — and silently counted into
            // summary.json's act ledger. The gate always settles: navigation
            // success and failure both release it.
            await pageReady;
            if (navFailedReason !== null && req.op !== "reload") {
              response = {
                ok: false,
                code: "nav_failed",
                error:
                  `the probe's startup navigation failed (${navFailedReason}); ` +
                  "run `reload` to retry it, or re-run web_artifact_audit",
              };
            } else {
              response = await withOpTimeout(handle(state, auditDir, req));
              if (req.op === "reload" && response.ok === true) {
                // A successful reload re-navigated the page; the session is
                // healthy again.
                navFailedReason = null;
              }
            }
          }
        } catch (err) {
          response = { ok: false, code: "op_failed", error: (err as Error).message };
        }
        // The completion gate reads summary.json to compare driven acts against
        // the capture envelope's interactive-node count, so it must reflect the
        // acts landed SO FAR, not just the final tally. Writing it only at
        // shutdown once left a warm-captured VM's summary stale (6 of 18 in the
        // first measured). Keep it current after every op instead.
        await writeSessionSummary(probeDir, state, auditSessionId).catch(() => {});
        // Same reasoning for the network record: the parent kills this process,
        // so the durable copy has to be current after every op.
        await recordNetwork();
        sock.end(JSON.stringify(response) + "\n");
        // Reuse the already-computed response instead of re-parsing `line`: a
        // second unguarded JSON.parse here throws on a malformed line (the first
        // parse already failed into op_failed above), and that throw inside this
        // void async IIFE is an unhandled rejection that kills the resident
        // probe — warm Chromium and every later op with it.
        if ((response as { closing?: boolean }).closing) {
          void shutdown("client asked to close");
        }
      })();
    });
    sock.on("error", () => sock.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  touchIdle();
  process.stderr.write(
    `[probe-ui] listening on ${socketPath} slug=${slug} (navigation pending)\n`,
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // Navigate AFTER the socket is up (see the pageReady gate above). A
  // navigation that throws even through navigateAndSettle's own transient
  // retry does NOT tear the session down — the socket is already advertised,
  // so it must keep answering (see navFailedReason); ops degrade to
  // `nav_failed` instead of ever observing the blank un-navigated page.
  const navStarted = Date.now();
  try {
    state.navStatus = await navigateAndSettle(page, url);
    process.stderr.write(
      `[probe-ui] navigated slug=${slug} nav_status=${state.navStatus} nav_ms=${Date.now() - navStarted}\n`,
    );
  } catch (err) {
    navFailedReason = (err as Error).message?.split("\n")[0] ?? String(err);
    process.stderr.write(
      `[probe-ui] startup navigation failed: ${navFailedReason}\n`,
    );
  }
  pageNavigated();

  // Resident: resolve never fires. The parent kills us, a client closes us, or
  // the idle timer does.
  await new Promise<void>(() => {});
  return 0;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

async function runClient(socketPath: string, req: ProbeRequest): Promise<number> {
  return new Promise<number>((resolve) => {
    const sock = connect(socketPath);
    let buf = "";
    const fail = (msg: string): void => {
      process.stderr.write(
        `probe-ui: ${msg}\n` +
          "  The session is opened by web_artifact_audit; run it first (or again).\n",
      );
      resolve(1);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (!buf.includes("\n")) return;
      process.stdout.write(buf.slice(0, buf.indexOf("\n")) + "\n");
      sock.end();
      resolve(0);
    });
    sock.on("error", (err) => fail(`cannot reach the probe session (${err.message})`));
    sock.on("close", () => {
      if (buf.length === 0) fail("probe session closed without answering");
    });
  });
}

/**
 * Find the live session's socket when the caller did not name one.
 *
 * The builder's shell starts in `~`, not in the artifact directory, so a
 * cwd-relative default would miss every real session and the commands printed in
 * the audit result would not work as written. Look where sessions actually live
 * — one per artifact under the TS spaces workspace — and take the newest, which
 * is the build just audited.
 */
async function discoverSocket(): Promise<string | null> {
  const envSocket = (process.env.HATCH_PROBE_UI_SOCKET ?? "").trim();
  if (envSocket.length > 0) return envSocket;

  const roots = [
    join(homedir(), "workspace", "ts-spaces"),
    join(process.cwd(), "..", "..", "ts-spaces"),
  ];
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const root of roots) {
    let slugs: string[];
    try {
      slugs = await readdir(root);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const candidate = join(root, slug, PROBE_DIR, SOCKET_BASENAME);
      try {
        const info = await stat(candidate);
        if (newest === null || info.mtimeMs > newest.mtimeMs) {
          newest = { path: candidate, mtimeMs: info.mtimeMs };
        }
      } catch {
        // no session for this artifact
      }
    }
    if (newest !== null) break;
  }
  if (newest !== null) return newest.path;

  // Last resort: the cwd-relative location, for a caller that really is sitting
  // in the artifact directory.
  const local = join(process.cwd(), PROBE_DIR, SOCKET_BASENAME);
  try {
    await stat(local);
    return local;
  } catch {
    return null;
  }
}

const USAGE = `usage: bun probe-ui.js <op> [flags]

  observe                          look at the artifact: screenshot + visible
                                   accessibility tree + numbered nodes
  observe --find "<text>"          just the nodes whose name contains <text>
                                   (numbers stay valid for act; no aria tree) —
                                   use this instead of piping observe through
                                   head/tail/jq to find one control
  act --node <n> --click           click the node numbered by the last observe
  act --node <n> --fill "<text>"   type into it
  act --node <n> --press <Key>     press a key against it
  act --node <n> --scroll <dy>     scroll it into view and wheel
  act --node <n> --select "<opt>"   choose an option in a <select>
  act --node <n> --hover           hover it (reveals hover-only controls)
  act --node <n> --double_click    double-click it
  key <Key>                        send a key to the page, not a node (Escape, Tab)
  reload                           re-navigate to pick up a rebuild, then observe
  viewport desktop|mobile          switch viewport (spends the node list)
  flag --severity <s> --what "…"   record a finding
  status                           session counters and findings
  batch  (steps on stdin)          run several ops in ONE call — the way to keep a
                                   multi-step flow to a single turn. Address by
                                   "name" and each step re-resolves against the
                                   live page; an ambiguous name stops the batch
                                   instead of guessing:
                                     bun probe-ui.js batch <<'JSON'
                                     [{"op":"act","name":"New habit name","action":"fill","text":"Walk"},
                                      {"op":"act","name":"Add habit","action":"click"},
                                      {"op":"observe"}]
                                     JSON

  --socket <path>   override the socket (default: the newest live session under
                    ~/workspace/ts-spaces/*/.harness/probe-ui/sock)

The harness owns settling — never write a wait or a timeout. Address elements
only by the numbers observe just gave you; if the page moved, observe again.
`;

async function readStdin(): Promise<string> {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

async function main(argv: string[]): Promise<number> {
  const { op, flags } = parseProbeArgv(argv);
  if (op === "serve") return serve(flags);
  if (op === "batch") {
    const raw = (await readStdin()).trim();
    if (raw.length === 0) {
      process.stderr.write(
        "probe-ui batch: pipe a JSON array of steps on stdin, e.g.\n" +
          "  bun probe-ui.js batch <<'JSON'\n" +
          "  [{\"op\":\"act\",\"name\":\"New habit name\",\"action\":\"fill\",\"text\":\"Walk\"},\n" +
          "   {\"op\":\"act\",\"name\":\"Add habit\",\"action\":\"click\"},\n" +
          "   {\"op\":\"observe\"}]\n" +
          "  JSON\n",
      );
      return 2;
    }
    let steps: ProbeRequest[];
    try {
      const parsed = JSON.parse(raw);
      steps = Array.isArray(parsed) ? parsed : (parsed.steps ?? []);
    } catch (err) {
      process.stderr.write(`probe-ui batch: steps are not valid JSON (${(err as Error).message})\n`);
      return 2;
    }
    const socket = (flags.get("socket") ?? "").trim() || (await discoverSocket());
    if (socket === null) {
      process.stderr.write("probe-ui: no probe session found; web_artifact_audit opens one\n");
      return 1;
    }
    return runClient(socket, { op: "batch", steps });
  }
  if (op === null || op === "help" || flags.has("help")) {
    process.stdout.write(USAGE);
    return op === null ? 2 : 0;
  }
  const req = requestFromArgv(op, flags);
  if (typeof req === "string") {
    process.stderr.write(`probe-ui: ${req}\n\n${USAGE}`);
    return 2;
  }
  const socketPath = (flags.get("socket") ?? "").trim() || (await discoverSocket());
  if (socketPath === null) {
    process.stderr.write(
      "probe-ui: no probe session found. `web_artifact_audit` opens one and returns its\n" +
        "  socket path in the response's `probe` object; run the audit first, or pass\n" +
        "  --socket <path> explicitly.\n",
    );
    return 1;
  }
  return runClient(socketPath, req);
}

// Only execute when invoked as a script, so importing the pure helpers from a
// test runner cannot start a browser or call process.exit (same gate as
// playwright-audit.ts).
if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`probe-ui fatal: ${msg}\n`);
      process.exit(2);
    },
  );
}
