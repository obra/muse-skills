/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fulfillLocalAuditRequest } from "./local-audit-transport";
// Lightweight Playwright UI audit, invoked by the `web_artifact_audit` agent tool
// after a successful build. Writes a deterministic JSON report to report.json
// and prints only that file's path on stdout.
//
// Inputs (CLI args):
//   --slug=<slug>            canonical published Space slug used in reports
//                            and business attribution (required)
//   --route-slug=<slug>      opaque per-audit route alias used only for browser
//                            URL admission and credential attachment (required)
//   --space-dir=<path>       absolute path to the space root (required)
//   --url=<url>              synthetic HTTPS origin and opaque route (required).
//                            The Rust runner uses artifact-capture.invalid;
//                            admitted artifact requests are fulfilled locally
//                            without DNS, TLS, or VM HTTP ingress.
//   --sandbox-api-socket     runtime-cell sandbox API Unix socket used for
//                            artifact requests by all Rust capture callers.
//   --proxy-server=<url>     HTTP/HTTPS forward-proxy URL Chromium uses
//                            (Sentinel on the runtime-cell gateway, e.g.
//                            `http://198.19.0.1:3128`). Required when
//                            running inside the runtime cell because the
//                            cell egress firewall drops all cell→host TCP
//                            except this port.
//   (stdin)                 first line is the legacy notary-token slot, now
//                            blank from Rust; second line carries the Sentinel
//                            proxy token. Credentials never travel in argv.
//   --audit-session=<uuid>   Per-audit routing key minted by the Rust
//                            runner's static/sandbox registration. Attached
//                            as `X-Hatch-Audit-Session` only on the opaque
//                            route through the local socket; daemon middleware
//                            requires it before translating to the canonical
//                            Space and optional sandbox data.
//   --output-dir=<path>      where to write screenshots + report.json
//                            (defaults to <space_dir>/.space-build/playwright)
//   --skip-install           assume Chromium is already installed
//   --egress-lockdown        refuse every non-audit-origin tunnel at the
//                            ledger (audit caller only; preview/inspection
//                            captures observe-and-forward)
//   --capture=<mode>         "full" captures desktop+mobile (default);
//                            "desktop-only" skips the mobile screenshot.
//
// Output: `<output_dir>/report.json`, whose JSON matches the shape:
//   {
//     "ok": true | false,
//     "url": "...",
//     "duration_ms": N,
//     "output_dir": "<absolute path to per-call audit dir>",
//     "viewports": {
//       "desktop": { "width": 1440, "height": 900, "screenshot_path": "...",
//                    "fullpage_screenshot_path": "..." },
//       "mobile":  { "width": 390,  "height": 844, "screenshot_path": "..." }
//     },
//     "mobile_layout": { "viewport_width": 390, "scroll_width": N,
//                        "overflow_px": N, "widest_selector": "..."|null,
//                        "verdict": "pass" | "fail" } | null,
//     "horizontal_scrollers": [ { "selector": "...", "scroll_width": N,
//                                 "client_width": N } ],  // sideways-scrolling
//                               // components at the mobile viewport
//     "images":   { "total": N, "broken": [...], "duplicate": [...],
//                   "unstable": [{ "src": "...", "reason": "..." }],
//                   "failed_requests": [{ "url": "...", "status": 403 }],
//                   "sample_urls": [...], "verdict": "pass" | "fail" },
//     "text_issues":     [ { "kind": "...", "...": "..." } ],
//     "console_errors":  [ "..." ],
//     "blocked_requests":[ "..." ],
//     "interactive_nodes": N,   // page-derived count of interactive controls,
//                               // max across the captured viewports. The
//                               // completion gate compares this against the
//                               // resident probe's driven-act count.
//     "audit_session_id": "<uuid>"|null,  // the per-audit routing key this
//                                         // capture ran under; the gate matches
//                                         // it against the probe summary's id.
//     "readiness": { "desktop": {...}|null, "mobile": {...}|null },  // per-viewport
//                               // settle outcome (ViewportReadiness); never gating.
//     "color_scheme": { "declared": "..."|null, "media_dependent": bool|null, "dark_frame": bool }|null,
//                         // desktop pass; media_dependent null = unknown; dark_frame: screenshot-dark.png written (fold under prefers-color-scheme: dark, only when media_dependent)
//                               // the scheme the images were taken under.
//     "error":           "<populated when ok=false>"
//   }
// Stdout carries only `report-sha256:<hex>` followed by the report path (last
// line), so the report itself can exceed subprocess output limits without
// being truncated and the daemon can verify the on-disk bytes it reads back
// against a digest the builder-writable audit dir cannot influence.
//
// Network policy: Playwright intercepts artifact-origin requests and admits
// only the opaque audit route. The local transport strips browser credentials
// and forwards the alias/session pair to the sandbox API, which owns admission
// and isolation. External requests remain subject to Sentinel and the ledger;
// attempts to leave the admitted artifact route are logged and blocked.
//
// Failure modes that DON'T crash:
//   - Chromium install fails (no internet, etc.) → ok:false, error mentions install.
//   - Page doesn't load → ok:false, error mentions load.
//   - Anything else unexpected → ok:false, error stringifies the cause.
// Crashing the script itself is reserved for "we couldn't write the report",
// which is a real infrastructure failure.

import { mkdir, writeFile } from "node:fs/promises";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import {
  ledgerDestinationKey,
  startTransportLedger,
  unexplainedTransportHosts,
  type TransportConnection,
  type TransportLedgerHandle,
} from "./transport-ledger";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { Browser, Page } from "playwright";

import {
  SCENARIO_CLOCK_OFFSET_MS,
  ariaSnapshot,
  clippedNodes,
  observeNodes,
  pollSdkIdle,
  shiftTimeScript,
  type ClippedNode,
  type SettleResult,
  type UnreachableControl,
} from "./probe-ui-observe";


const PLAYWRIGHT_DIRNAME = "playwright";
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 4_000;

/** Wait this long before re-walking to confirm an unreachable finding. Longer
 *  than common UI transitions (200-700ms), short enough to stay invisible in
 *  the audit's multi-second budget — and it only runs when something fired. */
const TRANSITION_DOUBLE_TAKE_MS = 800;

/**
 * Intersect two reachability walks so only findings present in BOTH survive.
 *
 * The gate blocks on mobile unreachable entries, and a control flagged mid-way
 * through a CSS transition would stall a run on a page that is fine 800ms
 * later. Entries keep the first walk's geometry. Pure, so the intersection
 * contract is unit-testable without Chromium.
 */
export function confirmTransientUnreachable(
  first: UnreachableControl[],
  second: UnreachableControl[],
): UnreachableControl[] {
  const key = (u: UnreachableControl) => `${u.reason} ${u.name}`;
  const confirmed = new Set(second.map(key));
  return first.filter((u) => confirmed.has(key(u)));
}

// Page-level horizontal overflow above this many CSS px at the 390px mobile
// viewport is treated as a layout defect. A couple of px absorbs sub-pixel
// rounding without masking a genuinely sideways-scrolling page.
const MOBILE_OVERFLOW_TOLERANCE_PX = 2;

// System browser candidates — prefer the image-baked Meta Chromium before
// relying on a runtime download of Playwright's bundled chromium headless
// shell. The runtime cell's daemon can't always download chromium (HOME /
// cache permissions, CDN egress under Sentinel), so when an image/system
// browser is present we use it directly.
const SYSTEM_CHROME_PATHS = [
  "/opt/meta-chromium/chrome",
];

const SCREENSHOT_FILENAME = "screenshot.png";
const MOBILE_SCREENSHOT_FILENAME = "screenshot-mobile.png";
// Full-page (whole scrolled document) desktop screenshot. The two screenshots
// above capture only the fold; this one shows everything below it in one image
// so a reviewer can see clipping/overflow past the fold without driving scroll.
const FULLPAGE_SCREENSHOT_FILENAME = "screenshot-full.png";
const CAPTURE_MODE_FULL = "full";
const CAPTURE_MODE_DESKTOP_ONLY = "desktop-only";

type CaptureMode = typeof CAPTURE_MODE_FULL | typeof CAPTURE_MODE_DESKTOP_ONLY;

// Chromium "phone home" suppression. The audit's Chromium is fronted by the
// transport ledger's egress lockdown (only the daemon origin tunnels out), so
// external chatter can no longer reach Sentinel or raise HITL prompts; these
// flags remain as noise reduction so Chrome's own background fetches do not
// pollute the ledger/capture record the screen and critique read. Playwright's defaults already cover most
// of it; we add only what they omit: --disable-sync, --disable-domain-reliability,
// --disable-component-update (the update.googleapis.com component/update check),
// OptimizationHints (the optimizationguide-pa.googleapis.com fetch, which
// --disable-background-networking may miss), and
// AutofillServerCommunication (the content-autofill.googleapis.com field-prediction
// fetch). Hosts that still slip past a flag on branded chrome are also routed
// DIRECT via CHROME_PHONE_HOME_BYPASS_HOSTS below (firewall-dropped, never prompts).
//
// Chrome honors only the LAST --disable-features, and Playwright appends our args
// after its own — so ours must REPEAT Playwright's default list (else we re-enable
// Translate/MediaRouter/etc.) plus our additions. Keep PW_DEFAULT_DISABLED_FEATURES
// in sync with playwright-core chromiumSwitches.js on bumps (pinned 1.55.1).
const PW_DEFAULT_DISABLED_FEATURES =
  "AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate";
export const CHROME_HARDENING_ARGS = [
  "--disable-sync",
  "--disable-domain-reliability",
  "--disable-component-update",
  // Keep the audit Chromium on HTTP/1.1 (out of Sentinel's HTTP/2 relay path)
  // for the cross-origin loads it proxies. The Space itself is fulfilled over
  // the local sandbox UDS, and the runtime cell deliberately does NOT trust
  // the VM's ingress CA (see `build-cell-trust-store.sh`).
  "--disable-http2",
  // Pin every network flow to TCP through the configured proxy so the
  // transport ledger's view is complete: QUIC is UDP (invisible to a SOCKS
  // CONNECT hop), and WebRTC would otherwise open non-proxied UDP as a
  // covert channel. With UDP pinned to the proxy and the ledger refusing
  // SOCKS UDP-ASSOCIATE, both fail closed and the refusal is counted.
  "--disable-quic",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy",
  `--disable-features=${PW_DEFAULT_DISABLED_FEATURES},OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication`,
];

// Chrome phone-home hosts routed DIRECT (not through Sentinel). The runtime-cell
// egress firewall drops direct egress, so these never reach Sentinel and never
// prompt mid-build, while real traffic (the space URL, CDNs, fonts) stays on the
// proxy and is unaffected. These are non-essential Chrome/Google probes Chrome
// tolerates failing; do NOT add a host a Space legitimately loads. The
// artifacts renderer keeps its own variant (render_audit.mjs's
// CHROME_STARTUP_PROXY_BYPASS_HOSTS).
export const CHROME_PHONE_HOME_BYPASS_HOSTS = [
  "accounts.google.com",
  "www.google.com",
  "clients2.google.com",
  "android.clients.google.com",
  "*.gvt1.com",
  "optimizationguide-pa.googleapis.com",
  "update.googleapis.com",
  "content-autofill.googleapis.com",
];

// Blackhole address every DIRECT (bypass-list) phone-home host resolves to.
// The audit runs inside the runtime cell where cell DNS is intentionally
// minimal (the gateway is an explicit HTTP/HTTPS proxy, not a recursive
// resolver) and is dead by default — the transparent UDP DNS->gateway:53 relay
// is gated off and intentionally stays off (it is an ungoverned DNS-exfil
// surface). The DIRECT phone-home hosts would otherwise run a cell DNS task
// that hangs; MAPing them to this unroutable blackhole makes those lookups
// fail fast (never a HITL prompt, never an 8s stall).
//
// IMPORTANT: this does NOT fix the main navigation. The proxied self-FQDN nav
// hung on Chromium's NAT64/DNS64 `ipv4only.arpa` probe, which the resolver
// issues before connecting to an IPv4-LITERAL proxy endpoint and which
// `--host-resolver-rules` canNOT intercept — the probe runs inside
// HostResolverManager, below the MappedHostResolver rule layer (confirmed by
// net-log: the MAP rule does not stop the ~8001ms `ipv4only.arpa`
// HOST_RESOLVER_MANAGER_JOB, and neither does `--disable-features`). The real
// fix is upstream: the Rust runner dials the proxy's IPv6 gateway literal
// (`sentinel_proxy_url`), which triggers no NAT64 probe at all. Real hostnames
// (the self-FQDN, cross-origin CDN/font/image) carry no MAP rule, so they
// resolve PROXY-SIDE over CONNECT and stay on the explicit Sentinel proxy that
// PR #10221 auto-allows.
const CHROME_DNS_BLACKHOLE_IP = "0.0.0.0";

// Build Chrome's `--host-resolver-rules` to blackhole the DIRECT phone-home
// hosts so their (otherwise dead) cell DNS lookups fail fast instead of
// hanging. `proxyServer` is the explicit Sentinel proxy URL the Rust runner
// passes (now an IPv6 gateway literal); we keep a self-MAP of its host as a
// harmless belt-and-suspenders short-circuit (an IPv6 literal needs no
// resolution, so this is a no-op — the NAT64 fix is the IPv6 proxy itself, not
// this rule). Real hostnames get no rule and resolve proxy-side over CONNECT.
// Returns null when there is no proxy (host test/dev path), where Chrome
// should use the host's own resolver.
function buildHostResolverRulesArg(proxyServer: string | null): string | null {
  if (proxyServer === null) {
    return null;
  }
  let proxyHost: string;
  try {
    proxyHost = new URL(proxyServer).hostname;
  } catch {
    return null;
  }
  if (proxyHost.length === 0) {
    return null;
  }
  const socks = proxyServer.startsWith("socks5://");
  const rules = [
    // Harmless self-MAP of the proxy host (no-op for the IPv6 literal proxy).
    `MAP ${proxyHost} ${proxyHost}`,
    // Each DIRECT phone-home host fails fast to the blackhole instead of
    // retrying against dead cell DNS.
    ...CHROME_PHONE_HOME_BYPASS_HOSTS.map(
      (host) => `MAP ${host} ${CHROME_DNS_BLACKHOLE_IP}`,
    ),
  ];
  if (socks) {
    // Chrome resolves names client-side for a SOCKS proxy by default; the
    // cell's resolver is dead AND client-side resolution would hide the
    // hostname (and any data encoded in it) from the transport ledger. Fail
    // every other local lookup so Chrome hands the hostname to the proxy
    // (socks5h), keeping DNS out of the cell and the name in the ledger.
    // Loopback is excluded: the ledger itself lives there, and Chrome never
    // proxies loopback anyway.
    rules.push("MAP * ~NOTFOUND");
    rules.push("EXCLUDE 127.0.0.1");
    rules.push("EXCLUDE localhost");
  }
  return `--host-resolver-rules=${rules.join(",")}`;
}

interface CliArgs {
  // Canonical Space identity. This is the only slug written to reports and
  // logs; it never controls browser URL admission or credential attachment.
  slug: string;
  // Opaque, per-audit route alias. This is the only slug allowed by the
  // browser network policy, keeping the canonical Space identity out of the
  // notary mint request and browser authorization scope.
  routeSlug: string;
  spaceDir: string;
  sandboxApiSocket?: string | null;
  outputDir: string;
  url: string;
  skipInstall: boolean;
  captureMode: CaptureMode;
  // Route-alias-scoped notary endorsement token minted via STEFI by the
  // Rust runner. The route handler attaches it as
  // `Authorization: <token>` ONLY on requests whose origin matches
  // the audit's daemon origin (the VM's nginx); cross-origin
  // requests the Space may issue (CDNs, fonts, third-party APIs)
  // never see the token. nginx auth_request → authd
  // `/v1/auth/check` verifies the endorsement and injects
  // `X-Hatch-Verified-Notary-Spaces: 1` so the daemon admits as
  // `HttpAuthProof::NotarySpace`.
  notaryToken: string | null;
  // Independent per-audit UUID minted by static/sandbox registration. The
  // route handler attaches it as `X-Hatch-Audit-Session: <uuid>` alongside the
  // notary token, and daemon middleware translates the alias only when it
  // matches the live entry. It stays local and is never sent to STEFI.
  auditSessionId: string | null;
  // HTTP/HTTPS forward-proxy URL Chromium dials (Sentinel on the
  // runtime-cell gateway, e.g. `http://198.19.0.1:3128`). The cell's
  // egress firewall drops all cell→host TCP except this port, so
  // Sentinel is the only path to the VM's ingress-rev-proxy :4431 edge from
  // inside Chromium. `null` skips the proxy override (test runs from the host).
  proxyServer: string | null;
  // Runtime egress proxy-auth token (basic-auth password) Chromium presents
  // to Sentinel so it can attribute the in-cell CONNECT. The Rust runner
  // registers a matching runtime egress context and pipes this token over
  // stdin (line 2). Sentinel's forward-proxy front door rejects any CONNECT it
  // cannot attribute with a 407 challenge; Playwright answers the challenge
  // with these credentials. `null` when the caller registered no context
  // (test/dev paths, or a registration failure) — the CONNECT then relies on
  // Sentinel admitting an unattributed-but-tokenless path, which it does not,
  // so a token is required against a real Sentinel proxy.
  proxyAuthToken: string | null;
  // Basic-auth username paired with `proxyAuthToken` (from argv; not secret).
  proxyAuthUsername: string | null;
  // Loopback SOCKS5 ledger Chromium is routed through (started by main()
  // when a proxy path exists); null on the direct host test/dev path.
  transport: TransportLedgerHandle | null;
  // Audit egress lockdown: set only by the audit caller (--egress-lockdown).
  // Preview/inspection captures run the ledger observe-and-forward so share
  // cards and thumbnails keep rendering external assets exactly as at base.
  egressLockdown: boolean;
}

interface BrokenImage {
  src: string;
  alt: string;
  reason: string;
}

interface DuplicateImage {
  src: string;
  count: number;
}

interface UnstableImage {
  src: string;
  reason: string;
}

export interface FailedImageRequest {
  url: string;
  status: number;
}

// A non-image sub-resource whose HTTP response failed during the audit.
// `resource_type` is Playwright's classification (stylesheet/script/font/…) so
// the report can say what kind of local asset is broken.
export interface FailedAssetRequest {
  url: string;
  status: number;
  resource_type: string;
}

interface ImageStats {
  total: number;
  broken: BrokenImage[];
  duplicate: DuplicateImage[];
  // Rendered <img> sources on an expiring / origin-locked host (Instagram /
  // signed CDN / presigned S3): they resolve during the build but 401/403 from
  // the Space's own origin once published. The Space must self-host the bytes.
  unstable: UnstableImage[];
  // Image resources whose HTTP response was 401/403/404 during the audit.
  // Correlated so an onError handler that hides the element can't launder a
  // broken hotlink into "absent".
  failed_requests: FailedImageRequest[];
  // Cross-origin <img> that rendered no pixels. Under the audit's egress
  // lockdown every hotlinked image is refused at the ledger, so this is the
  // audit environment talking, not a defect: the published page loads them in
  // viewers' browsers with no proxy in front. Advisory — never gates the
  // verdict, or every legitimate hotlink would pressure the builder into
  // stripping or inlining it.
  external_blocked: { count: number; sample: string[] };
  sample_urls: string[];
  // Single actionable verdict: "fail" when a SAME-ORIGIN image is broken, or
  // any image is hotlinked from an expiring host — so a `broken: 0` report
  // can't be misread as success.
  verdict: "pass" | "fail";
}

// Bounded sample of cross-origin images the audit could not load; enough to
// name the offenders without bloating the envelope.
const MAX_EXTERNAL_BLOCKED_IMAGE_SAMPLE = 5;

export interface RawImg {
  src: string;
  alt: string;
  complete: boolean;
  nw: number;
  nh: number;
  hidden: boolean;
}

// Image-resource HTTP statuses that mean the source is gone/blocked from the
// Space's own origin (expired signed CDN URL, hotlink protection, missing file).
const FAILED_IMAGE_RESPONSE_STATUSES = new Set([401, 403, 404]);

// Non-image sub-resource types whose 4xx/5xx response means a local asset the
// page depends on didn't load: a dead relative `assets/…` reference, a missing
// self-hosted font, or a broken script/stylesheet. These render the page blank
// or unstyled without ever surfacing in the <img> scan, so they are captured
// separately as `broken_assets`.
const FAILED_ASSET_RESOURCE_TYPES = new Set([
  "stylesheet",
  "script",
  "font",
  "fetch",
  "xhr",
  "media",
]);
// Any 4xx/5xx counts as a failed asset response.
const FAILED_ASSET_MIN_ERROR_STATUS = 400;

// Hosts whose served images carry per-request signed/expiring/origin-locked
// tokens — they 401/403 from a Space's own origin once published. Mirrors the
// JS audit's `image-audit-core.mjs` classifier. Suffix-matched.
const EXPIRING_HOST_SUFFIXES = ["cdninstagram.com", "fbcdn.net"];

// Query params that mark a URL as signed / time-limited regardless of host.
const EXPIRING_QUERY_PARAMS = new Set([
  "expires",
  "oe",
  "oh",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-expires",
  "x-goog-signature",
  "key-pair-id",
]);

/**
 * Decide whether an image source is on an expiring / origin-locked host that a
 * Space must not hotlink. Pure and host/param-named, so it can be unit-tested
 * without Chromium. Owned/self-hosted forms — relative paths (build-time
 * `assets/`, `/spaces/v2/<slug>/blobs/...`), `data:`/`blob:` URLs, and
 * `sandbox://` generated-media refs — are never unstable.
 */
export function classifyImageSource(
  rawSrc: string,
  ownOrigin?: string,
): {
  unstable: boolean;
  reason: string | null;
} {
  if (typeof rawSrc !== "string" || rawSrc.trim().length === 0) {
    return { unstable: false, reason: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawSrc.trim());
  } catch {
    return { unstable: false, reason: null }; // relative ⇒ owned/local
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { unstable: false, reason: null }; // data: / blob: / sandbox: / file:
  }
  // The Space's own origin is bytes it controls — never "hotlinked", even if a
  // self-hosted URL carries a benign cache/TTL query param. Only cross-origin
  // URLs can expire or lock to a foreign host.
  if (typeof ownOrigin === "string" && ownOrigin.length > 0 && parsed.origin === ownOrigin) {
    return { unstable: false, reason: null };
  }
  const host = parsed.hostname.toLowerCase();
  for (const suffix of EXPIRING_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return { unstable: true, reason: `expiring/origin-locked host (${suffix})` };
    }
  }
  for (const key of parsed.searchParams.keys()) {
    if (EXPIRING_QUERY_PARAMS.has(key.toLowerCase())) {
      return { unstable: true, reason: `signed/expiring URL param (${key})` };
    }
  }
  return { unstable: false, reason: null };
}

interface MobileLayoutAudit {
  // The mobile viewport width the page was measured at (typically 390).
  viewport_width: number;
  // The widest horizontal extent the document actually laid out to.
  scroll_width: number;
  // How far the document overflows the viewport horizontally, in CSS px
  // (0 when it fits). Clamped at 0 — a page narrower than the viewport is fine.
  overflow_px: number;
  // Best-effort selector of the widest element poking past the right edge, so a
  // fix can target the offender instead of hunting. null when there is no
  // meaningful overflow.
  widest_selector: string | null;
  // "fail" once overflow_px exceeds the tolerance: a page-level sideways scroll
  // on a phone, which is essentially always a defect. Inner scroll regions
  // (carousels, wide tables in overflow-x:auto) do not grow the document's
  // scrollWidth, so they never trip this; the element-level
  // `horizontal_scrollers` scan reports them instead.
  verdict: "pass" | "fail";
}

/**
 * Reduce a raw (viewportWidth, scrollWidth, widestSelector) measurement into the
 * mobile-layout audit and verdict. Pure (no Chromium) so the tolerance/verdict
 * contract is unit-testable. Measures PAGE-LEVEL overflow only: intentional
 * horizontal scroll belongs to inner containers, which clip/scroll internally
 * and do not grow document scrollWidth, so they do not fail here.
 */
export function classifyMobileOverflow(
  viewportWidth: number,
  scrollWidth: number,
  widestSelector: string | null,
): MobileLayoutAudit {
  const overflowPx = Math.max(0, Math.round(scrollWidth - viewportWidth));
  const overflows = overflowPx > MOBILE_OVERFLOW_TOLERANCE_PX;
  return {
    viewport_width: Math.round(viewportWidth),
    scroll_width: Math.round(scrollWidth),
    overflow_px: overflowPx,
    widest_selector: overflows ? widestSelector : null,
    verdict: overflows ? "fail" : "pass",
  };
}

// An element that scrolls sideways inside the page at the mobile viewport —
// a defect: artifacts reflow on mobile. `mobile_layout` is blind to these
// (inner scrollers never grow the document's scrollWidth).
export interface HorizontalScroller {
  // Short unique-ish CSS path of the scrolling container.
  selector: string;
  scroll_width: number;
  client_width: number;
}

// Raw per-element measurement the in-page walk hands to the pure classifier:
// the walk pre-filters structural facts; the classifier owns the numeric
// thresholds and the cap (unit-testable without Chromium).
export interface RawScrollerCandidate {
  selector: string;
  scroll_width: number;
  client_width: number;
  // Computed display/visibility plus a non-empty rendered box. An element in
  // a display:none subtree reports clientWidth 0, so the min-width floor
  // skips it even when its own computed style looks visible.
  visible: boolean;
}

// Content must exceed the container by MORE than this many CSS px: absorbs
// sub-pixel rounding and scrollbar-width noise.
const HORIZONTAL_SCROLLER_SLACK_PX = 8;
// Ignore containers narrower than this: tiny boxes are rounding noise, not
// the component-level defect.
const HORIZONTAL_SCROLLER_MIN_CLIENT_WIDTH_PX = 80;
// Report cap: a pathological page must not bloat the envelope.
const MAX_HORIZONTAL_SCROLLERS = 10;

/**
 * Reduce raw overflow-x candidates into the reported horizontal-scroller
 * list: visible, wide-enough containers overflowing beyond the slack,
 * capped. Pure (no Chromium) so the predicate is unit-testable.
 */
export function classifyHorizontalScrollers(
  candidates: RawScrollerCandidate[],
): HorizontalScroller[] {
  const out: HorizontalScroller[] = [];
  for (const candidate of candidates) {
    if (!candidate.visible) continue;
    const clientWidth = Math.round(candidate.client_width);
    const scrollWidth = Math.round(candidate.scroll_width);
    if (clientWidth < HORIZONTAL_SCROLLER_MIN_CLIENT_WIDTH_PX) continue;
    if (scrollWidth <= clientWidth + HORIZONTAL_SCROLLER_SLACK_PX) continue;
    out.push({
      selector: candidate.selector,
      scroll_width: scrollWidth,
      client_width: clientWidth,
    });
    if (out.length >= MAX_HORIZONTAL_SCROLLERS) break;
  }
  return out;
}

export interface TextIssue {
  kind: string;
  text?: string;
  selector?: string;
}

interface ViewportReport {
  width: number;
  height: number;
  screenshot_path: string | null;
  // Full-page (whole scrolled document) screenshot, captured on the desktop
  // pass only; null on mobile and when the capture failed. `screenshot_path`
  // above is the fold only — this shows everything below it so a reviewer can
  // catch below-the-fold clipping/overflow the fold screenshot cannot.
  fullpage_screenshot_path?: string | null;
}

/** One settle window's outcome plus whether Playwright's network idle arrived
 *  inside it; the SDK count is read only after idle, so it never advances a capture. */
export interface CaptureSettle extends SettleResult {
  network_idle: boolean;
}

/** Loading state of one viewport when its images were taken (`settle_ms` totals every
 *  window). Nothing gates on it; it tells the critic a still-loading frame is unjudged. */
export interface ViewportReadiness extends CaptureSettle {
  /** A second settle window ran because the navigation settle did not reach idle. */
  retried: boolean;
}

/** The document's declared `color-scheme` and, when it declares dark, whether its
 *  fold renders differently under `prefers-color-scheme: dark` (light-mode viewers
 *  get the light palette) and whether a dark fold frame was captured beside the light
 *  primary frames, which stay the frames light-mode viewers actually get. */
export interface ColorSchemeRecord {
  /** Computed `color-scheme` of `:root` (or the meta tag's content), clamped to 64 chars. */
  declared: string | null;
  /** Null when unknown, including a light fold that did not hold still around the
   *  dark probe. */
  media_dependent: boolean | null;
  dark_frame: boolean;
}

interface AuditReport {
  ok: boolean;
  url: string;
  duration_ms: number;
  output_dir: string;
  // HTTP status of the main document navigation (desktop pass). 401/403 means
  // the audit's /spaces/v2/<route-slug>/ route was auth/notary-gated, so the
  // screenshot is the nginx error page, not the Space — the eval harness reads
  // this to mark image judges TRANSIENT_ERROR instead of a false content FAIL.
  // null when the navigation produced no response object.
  nav_status: number | null;
  viewports: { desktop: ViewportReport; mobile: ViewportReport };
  // Page-level horizontal-overflow audit from the mobile pass. null when the
  // mobile capture was skipped (desktop-only mode) or failed.
  mobile_layout: MobileLayoutAudit | null;
  // Components that scroll sideways at the mobile viewport (`mobile_layout`
  // is page-level only). [] when the mobile capture was skipped or failed,
  // and on any probe error.
  horizontal_scrollers: HorizontalScroller[];
  // Interactive controls a user cannot operate, per viewport. Deterministic and
  // free: `mobile_layout.overflow_px` is blind to a clip INSIDE a scroller, and
  // reported 0 on every artifact whose users then complained the control was cut
  // off. Mobile is the one that matters (no hover, less room), so the gate reads
  // mobile; desktop is diagnostic.
  unreachable_controls: {
    desktop: UnreachableControl[];
    mobile: UnreachableControl[];
  };
  // Text runs the walk measured as visibly cut off, per viewport: `text_truncated`
  // (an ellipsis / `overflow:hidden` clipping a label) or `past_viewport` (pushed
  // off the edge). Advisory — a screenshot only shows clipping if you look at the
  // right region, so the walk reports it explicitly for the builder to fix.
  clipped: {
    desktop: ClippedNode[];
    mobile: ClippedNode[];
  };
  images: ImageStats;
  text_issues: TextIssue[];
  console_errors: string[];
  // Console warnings kept only when they match the high-priority allowlist
  // (`isHighPriorityWarning`): React hydration mismatch, a list missing stable
  // keys, a CSP block, a deprecated API, an unused preload, or an <img> sized on
  // one axis. Advisory — surfaced for the builder, never folded into the
  // pass/fail aggregate. Capped like console_errors.
  console_warnings: string[];
  // Console errors that were a cross-origin resource failing to load
  // (`net::ERR_*` / "Failed to load resource" against a foreign origin).
  // Under the audit's egress lockdown every external fetch fails, so these
  // would otherwise fill the 20-entry `console_errors` cap and crowd out the
  // artifact's own errors. Counted here instead, with a bounded sample; the
  // same failure on the daemon origin stays a real console error.
  external_fetch_failures: number;
  external_fetch_failure_samples: string[];
  blocked_requests: string[];
  // Every cross-origin request the page attempted, deduped and bounded
  // (see the ExternalRequest caps). The daemon consumes this field for its
  // exfiltration screen and REPLACES it with a compact summary before the
  // envelope reaches the builder; report.json on disk keeps the full record.
  external_requests: ExternalRequest[];
  // How many distinct external requests the cap dropped (0 almost always;
  // a nonzero count means the screen saw a truncated picture).
  external_requests_dropped: number;
  // How many of those drops carried data (non-GET/HEAD, websocket, popup).
  // Reserved slots make this ~impossible to reach by flooding, so a nonzero
  // count is a strong signal on its own.
  external_requests_dropped_data_bearing: number;
  // Whether the loopback SOCKS5 transport ledger fronted Chromium for this
  // audit. False means the transport view is UNOBSERVED (host test/dev path
  // or a ledger start failure), never that nothing connected.
  transport_ledger_active: boolean;
  // Whether the audit egress lockdown was requested (--egress-lockdown, the
  // audit caller only): policy_denied ledger entries are expected exactly
  // when this is true. Preview/inspection captures observe-and-forward.
  egress_lockdown: boolean;
  // Every TCP destination the browser process reached (or attempted),
  // aggregated per host:port. Complete at transport granularity even for
  // traffic the in-browser capture cannot see (popups, WebSocket frames,
  // non-fetch channels).
  transport_connections: TransportConnection[];
  // SOCKS BIND/UDP-ASSOCIATE attempts refused (WebRTC or other non-TCP).
  transport_udp_attempts: number;
  // Distinct destinations beyond the ledger's entry cap (existence counted,
  // detail dropped).
  transport_overflow: number;
  // Transport destinations no captured request or the audit's own daemon
  // origin explains: the page reached these through a channel the content
  // capture could not inspect. Each entry is `host:port` (IPv6 hosts
  // bracketed, e.g. `[2401:db00:0:0:0:0:0:34]:443`) — one captured request to
  // a host explains only the port it used, so a decoy image on :443 can no
  // longer launder a covert channel on another port of the same host.
  unexplained_transport_hosts: string[];
  // Non-image sub-resources (stylesheet/script/font/fetch/media) whose HTTP
  // response was 4xx/5xx — the signature of a broken local asset (a dead
  // relative `assets/…` reference, a missing self-hosted font) that renders the
  // page blank or unstyled without appearing in the <img> scan. Advisory;
  // deduped and capped.
  broken_assets: FailedAssetRequest[];
  // Affordances the artifact wired that silently break inside the sandboxed
  // iframe: window.print()/alert()/confirm()/prompt() (blocked) and a
  // share/copy-link control that copies the page's own URL (the iframe URL, not
  // a real link; the Hatch shell owns sharing). Advisory — surfaced for the
  // builder to remove before attesting, never folded into a pass/fail verdict.
  blocked_affordances: BlockedAffordance[];
  // Page-derived count of interactive controls, taken as the max across the
  // captured viewports. This is the audit's own measurement of "how many
  // controls this artifact offers" — sourced from the page, never from whether
  // the builder chose to drive anything — so the completion gate can compare it
  // against the resident probe's driven-act count and fail a build that ships
  // interactive surface it never exercised.
  interactive_nodes: number;
  // Playwright accessibility snapshot of the desktop pass's visible tree, capped
  // at MAX_ARIA_SNAPSHOT_CHARS, or null when it failed. Gives the builder the
  // page's semantic structure straight from the one-shot audit — control names,
  // roles, headings — without driving the resident probe. Best-effort, never gating.
  aria_snapshot: string | null;
  // The per-audit routing key (UUID) this capture ran under, or null on a
  // host/dev run with no `--audit-session`. The completion gate requires this to
  // match the probe summary's `session_id` so it can never pair this envelope's
  // node count with a stale probe session's acts.
  audit_session_id: string | null;
  // null for a pass that failed before its images were taken; nothing gates on it.
  readiness: { desktop: ViewportReadiness | null; mobile: ViewportReadiness | null };
  // Desktop is authoritative; mobile fills it only when the desktop pass failed.
  color_scheme: ColorSchemeRecord | null;
  error?: string;
  /** Local capture connection/read failure, distinct from an artifact load failure. */
  error_kind?: "capture_transport";
  // Phase-0 latency telemetry (additive; consumers tolerate absence). Rust
  // reads the envelope as an untyped Value and only these fields' presence is
  // relied on by the read-only extractor, never by the pass/fail aggregate.
  // cold_launch_ms: time to launch Chromium for the desktop pass (the fixed
  // cold-start cost each of the current 2-3 launches pays). *_ms: wall of each
  // viewport pass. browser_launches: how many chromium.launch() this audit did.
  // audit_path: which browser strategy ran ("current" today; "shared"/"warm"
  // once Fix 1/3 land).
  cold_launch_ms?: number | null;
  desktop_ms?: number | null;
  mobile_ms?: number | null;
  // The Rust runner adds notary_mint_ms to its returned envelope for compatibility.
  // It is zero because local capture does not mint a notary token.
  browser_launches?: number;
  audit_path?: string;
  // Structured per-fix decision record for validation (which flags were on,
  // which path ran, retries taken, fallbacks triggered). Additive; consumers
  // tolerate absence. Mirrors the [spaces-audit] stderr lines.
  diagnostics?: AuditDiagnostics;
}

interface AuditDiagnostics {
  audit_path: string;
  concurrent_ran: boolean;
  concurrent_desktop_retry: boolean; // desktop SQLITE_BUSY guard fired
  concurrent_mobile_retry: boolean; // mobile SQLITE_BUSY guard fired
  shared_launch_failed: boolean; // shared-browser launch failed → per-pass
  nav_retries: number; // transient-nav retries taken
  settle_retries: number; // viewports whose navigation settle needed the one retry
}

// Cap how many blocked URLs we keep so a runaway Space can't bloat the
// report. The first N are usually enough to diagnose what was blocked.
const MAX_LOGGED_BLOCKED_REQUESTS = 20;
/** Console errors and text issues are serialized into the tool result verbatim
 *  (nothing downstream truncates this path), and a chatty artifact audited
 *  repeatedly can pump thousands of duplicate lines into the builder's context.
 *  Cap them like their siblings. */
const MAX_LOGGED_CONSOLE_ERRORS = 20;
const MAX_LOGGED_CONSOLE_WARNINGS = 20;
const MAX_LOGGED_BROKEN_ASSETS = 20;
const MAX_LOGGED_TEXT_ISSUES = 10;

// Every cross-origin request the audited page attempts, recorded for the
// daemon's exfiltration screen. A shared artifact runs in viewers' browsers
// with no Sentinel proxy in front of it, so this audit-time capture is the
// only pre-ship look at where the page sends data. Recorded at request time
// — the attempt is the signal; a request the proxy later denies still
// proves the code tries to send — then deduped and bounded so a chatty page
// cannot bloat the report. The daemon extracts this field from the envelope
// for classification and hands the builder only a compact summary.
const MAX_EXTERNAL_REQUESTS = 40;
// Of the total, at most this many may be generic GET/HEAD page resources. The
// remaining slots are reserved for data-bearing entries (a POST body, a
// WebSocket, a popup), so a flood of benign GETs to a decoy host can never
// evict the one request that actually carries data — the eviction was silent
// and the flood also kept the decoy host "explained" at the transport
// cross-check, so nothing downstream saw the payload at all.
const MAX_EXTERNAL_GENERIC_REQUESTS = 32;
const MAX_EXTERNAL_REQUEST_URL_CHARS = 2048;
const MAX_EXTERNAL_REQUEST_BODY_CHARS = 1024;
const MAX_EXTERNAL_REQUEST_HEADERS = 12;
const MAX_EXTERNAL_REQUEST_HEADER_NAME_CHARS = 128;
const MAX_EXTERNAL_REQUEST_HEADER_VALUE_CHARS = 256;

/** Truncate to `max` UTF-16 code units without leaving a lone trailing high
 *  surrogate: a dangling surrogate survives JSON.stringify but is rejected by
 *  the daemon's JSON parser, which would fail the whole report. */
function sliceCodepointSafe(text: string, max: number): string {
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

// Request headers every browser attaches to every request; recording them
// adds bytes, not exfil signal. Anything else — authorization, x-api-key,
// custom names — is exactly what the screen wants to see, so it survives.
// Matched on the lowercased name. `referer` is NOT here: it is page-steerable
// (pushState + referrerPolicy) and is kept when it points off the daemon
// origin (see recordExternalRequest).
const EXTERNAL_REQUEST_BOILERPLATE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "host",
  "origin",
  "pragma",
  "priority",
  "upgrade-insecure-requests",
  "user-agent",
]);

// Chromium-generated header families dropped by prefix. Deliberately narrow:
// a blanket `sec-` skip also swallowed attacker-CHOSEN `sec-*` names, which
// are exactly what a header-channel exfil would use, so only the families the
// browser itself emits are matched.
const CHROMIUM_GENERATED_HEADER_PREFIXES = [
  "sec-ch-",
  "sec-fetch-",
  "sec-websocket-",
];

/** A request that can carry data out on its own (a body-bearing method, a
 *  bidirectional socket, or a popup navigation whose URL is the payload), as
 *  opposed to a generic page resource fetch. Pure so the reserved-slot policy
 *  is unit-testable. */
export function isDataBearingRequest(
  method: string,
  resourceType: string,
): boolean {
  const verb = method.toUpperCase();
  return (
    (verb !== "GET" && verb !== "HEAD") ||
    resourceType === "websocket" ||
    resourceType === "popup"
  );
}

/** One recorded cross-origin request attempt (bounded fields). */
export interface ExternalRequest {
  url: string;
  method: string;
  resource_type: string;
  /** Non-boilerplate request headers, bounded per name/value. */
  headers?: Record<string, string>;
  /** Bounded request-body prefix; absent when the request carried none. */
  post_data?: string;
  /** Set when any recorded field was cut at its cap — url, body, a header
   *  name or value, or a header dropped past the per-request header cap. The
   *  screen must not read a truncated entry as fully inspected. */
  truncated?: boolean;
}

/** Dedup + cap state for external-request recording, shared across the
 *  desktop and mobile passes (both load the same page, so the same request
 *  set appears twice without it). */
export interface ExternalRequestLog {
  requests: ExternalRequest[];
  seen: Set<string>;
  dropped: number;
  /** How many of `dropped` carried data (see `isDataBearingRequest`). Nonzero
   *  means the cap lost something the screen most wanted to see, which reads
   *  differently from a page that merely fetched too many images. */
  dropped_data_bearing: number;
  /** Generic GET/HEAD entries recorded so far, capped below the total so the
   *  reserved data-bearing slots survive a flood. */
  generic: number;
}

export function newExternalRequestLog(): ExternalRequestLog {
  return {
    requests: [],
    seen: new Set(),
    dropped: 0,
    dropped_data_bearing: 0,
    generic: 0,
  };
}

/** Record one cross-origin request attempt: dedupe on method+url+body+kept
 *  headers, bound every field, flag anything cut, and count what the cap
 *  drops instead of silently losing it. `daemonOrigin` (when known) decides
 *  whether a `referer` points off the audit's own origin and is therefore
 *  worth recording. Pure state-in/state-out so the policy is unit-testable
 *  without Chromium. */
export function recordExternalRequest(
  log: ExternalRequestLog,
  request: {
    url: string;
    method: string;
    resourceType: string;
    headers?: Record<string, string>;
    postData?: string | null;
  },
  daemonOrigin?: string,
): void {
  const body = request.postData ?? undefined;
  let truncated = false;
  // Filter the headers BEFORE the dedup key: the kept set is part of the key,
  // so a benign same-URL request can no longer collapse a later request that
  // carries a secret in a custom header into "already seen".
  const kept: Record<string, string> = {};
  let keptCount = 0;
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    if (keptCount >= MAX_EXTERNAL_REQUEST_HEADERS) {
      truncated = true;
      break;
    }
    const name = rawName.toLowerCase();
    // Playwright surfaces Chromium-internal pseudo headers with a ':'
    // prefix; those and browser boilerplate carry no exfil signal.
    if (name.startsWith(":")) continue;
    if (CHROMIUM_GENERATED_HEADER_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (name === "referer") {
      // Page-steerable, so it is only boilerplate while it points at the
      // artifact's own origin; a referer aimed elsewhere is page-authored
      // data on the wire.
      const refererOrigin = safeOrigin(value);
      if (refererOrigin === null || refererOrigin === daemonOrigin) continue;
    } else if (EXTERNAL_REQUEST_BOILERPLATE_HEADERS.has(name)) {
      continue;
    }
    // An oversized header NAME is itself a smuggling carrier; record that
    // something was cut rather than ballooning the report with it.
    if (name.length > MAX_EXTERNAL_REQUEST_HEADER_NAME_CHARS) {
      truncated = true;
      continue;
    }
    if (value.length > MAX_EXTERNAL_REQUEST_HEADER_VALUE_CHARS) {
      kept[name] = sliceCodepointSafe(value, MAX_EXTERNAL_REQUEST_HEADER_VALUE_CHARS);
      truncated = true;
    } else {
      kept[name] = value;
    }
    keptCount += 1;
  }
  const headerKey = Object.entries(kept)
    .map(([name, value]) => `${name}=${value.slice(0, 64)}`)
    .sort()
    .join(" ");
  // resource_type is part of the identity: a popup/websocket record must
  // never dedup-collide with the routed document/fetch record for the same
  // URL, or the daemon's channel-shape always-flag loses its input.
  const key = `${request.method} ${request.resourceType} ${request.url.slice(0, MAX_EXTERNAL_REQUEST_URL_CHARS * 2)} ${
    body === undefined ? "" : body.slice(0, MAX_EXTERNAL_REQUEST_BODY_CHARS)
  } ${headerKey}`;
  if (log.seen.has(key)) return;
  log.seen.add(key);
  const dataBearing = isDataBearingRequest(request.method, request.resourceType);
  const atTotalCap = log.requests.length >= MAX_EXTERNAL_REQUESTS;
  // A data-bearing entry may use free generic capacity too; a generic one may
  // never spend a reserved slot.
  if (atTotalCap || (!dataBearing && log.generic >= MAX_EXTERNAL_GENERIC_REQUESTS)) {
    log.dropped += 1;
    if (dataBearing) {
      log.dropped_data_bearing += 1;
    }
    return;
  }
  let url = request.url;
  if (url.length > MAX_EXTERNAL_REQUEST_URL_CHARS) {
    url = sliceCodepointSafe(url, MAX_EXTERNAL_REQUEST_URL_CHARS);
    truncated = true;
  }
  const entry: ExternalRequest = {
    url,
    method: request.method,
    resource_type: request.resourceType,
  };
  if (body !== undefined && body.length > 0) {
    if (body.length > MAX_EXTERNAL_REQUEST_BODY_CHARS) {
      entry.post_data = sliceCodepointSafe(body, MAX_EXTERNAL_REQUEST_BODY_CHARS);
      truncated = true;
    } else {
      entry.post_data = body;
    }
  }
  if (keptCount > 0) {
    entry.headers = kept;
  }
  if (truncated) {
    entry.truncated = true;
  }
  if (!dataBearing) {
    log.generic += 1;
  }
  log.requests.push(entry);
}

/**
 * Decide whether a request fired by the audited Space's browser may be
 * sent to the network. Pure function so the policy is unit-testable
 * without spinning up Chromium.
 *
 * Allow rules:
 *   - Any cross-origin request — CDNs, fonts, images, third-party APIs.
 *   - Same-origin requests under `/spaces/v2/<route-slug>/...` (the Space's
 *     own document, assets, icons, and action invocation endpoints).
 *
 * Block everything else. The audit runs inside the daemon's network
 * namespace, so same-origin requests to the daemon's HTTP API take the
 * runtime-cell localhost-auth bypass. Without this filter a Space could
 * `fetch('/api/config')` (or any other non-exempt `/api/*` route) and
 * have the daemon admit it as authenticated.
 */
/**
 * Parse the URL and return its origin, or `null` if the input does
 * not parse. Used by the route handler to decide whether to attach
 * the notary token to a given request (only when the request origin
 * matches the audit's daemon origin).
 */
export function safeOrigin(requestUrl: string): string | null {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Render a captured console error with the URL it originated from. Chromium's
 * resource-failure messages ("Failed to load resource: the server responded
 * with a status of 401") carry the failing URL only in the message *location*,
 * not the text — without it the report can't say which request failed, and
 * the builder agent is left guessing. Appends the location URL whenever it
 * adds information the text doesn't already contain.
 */
function formatConsoleLine(
  prefix: string,
  text: string,
  locationUrl: string,
): string {
  const trimmed = locationUrl.trim();
  if (trimmed.length === 0 || text.includes(trimmed)) {
    return `${prefix}: ${text}`;
  }
  return `${prefix}: ${text} (${trimmed})`;
}

export function formatConsoleError(text: string, locationUrl: string): string {
  return formatConsoleLine("console.error", text, locationUrl);
}

/**
 * Render a captured console warning with its origin URL, mirroring
 * `formatConsoleError` so the two read alike in the report.
 */
export function formatConsoleWarning(text: string, locationUrl: string): string {
  return formatConsoleLine("console.warn", text, locationUrl);
}

// Console warnings are dropped by default: a chatty artifact logs dozens that
// say nothing about the build. This allowlist keeps only the classes that each
// name a real, fixable defect the screenshots and the error scan miss. Matched
// case-insensitively as substrings of the warning text; each entry notes the
// failure it catches.
const HIGH_PRIORITY_WARNING_PATTERNS = [
  "hydrat", // React hydration mismatch: SSR/static markup diverged from the client render
  "did not match", // the other half of a hydration / text-content mismatch message
  "should have a unique", // a React list without stable keys → rows drop or duplicate on update
  "deprecat", // a deprecated API/prop that breaks on the next dependency bump
  "content security policy", // a CSP violation blocking a script/style/font the page needs
  "preloaded using link preload", // a preloaded asset the page never used — a wrong or dead resource ref
  "either width or height", // an <img> given one dimension only, so it renders at the wrong aspect ratio
  "aspect ratio", // the same image-sizing defect under Chrome's other phrasing
];

/**
 * Decide whether a console warning is one of the high-priority classes worth
 * surfacing. Pure and pattern-named so the allowlist is unit-testable without
 * Chromium; everything off the list is dropped as build noise.
 */
export function isHighPriorityWarning(text: string): boolean {
  const lowered = text.toLowerCase();
  return HIGH_PRIORITY_WARNING_PATTERNS.some((pattern) =>
    lowered.includes(pattern),
  );
}

// The whole report is serialized into the builder's context verbatim, so a huge
// DOM's accessibility tree could crowd out everything else. Cap it.
const MAX_ARIA_SNAPSHOT_CHARS = 20_000;

/**
 * Bound the accessibility snapshot to MAX_ARIA_SNAPSHOT_CHARS. Passes null
 * through unchanged and appends a marker when it truncates, so a reader can tell
 * a cut tree from a small one. Pure, so the cap is unit-testable.
 */
export function capAriaSnapshot(snapshot: string | null): string | null {
  if (snapshot === null || snapshot.length <= MAX_ARIA_SNAPSHOT_CHARS) {
    return snapshot;
  }
  return `${snapshot.slice(0, MAX_ARIA_SNAPSHOT_CHARS)}\n… (aria snapshot truncated at ${MAX_ARIA_SNAPSHOT_CHARS} chars)`;
}

/**
 * Desktop and mobile load the same page, so each broken asset is recorded once
 * per pass. Collapse to unique url+status, preserving first-seen order. Pure, so
 * the dedupe contract is unit-testable.
 */
export function dedupeBrokenAssets(
  assets: FailedAssetRequest[],
): FailedAssetRequest[] {
  const seen = new Set<string>();
  const out: FailedAssetRequest[] = [];
  for (const asset of assets) {
    const key = `${asset.url} ${asset.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

/**
 * Known environment noise: the browser fetches `/favicon.ico` at the page
 * origin on its own. That is a browser-process request, so it bypasses the
 * route interception that attaches the audit's notary header and always
 * fails auth at ingress. The Space has no control over the origin root, so
 * the resulting console error says nothing about the build; drop it instead
 * of asking every builder to explain it. Scoped to exactly the origin-root
 * favicon at the audit's daemon origin so real failures still surface.
 */
export function isDaemonRootFaviconRequest(
  locationUrl: string,
  daemonOrigin: string,
): boolean {
  try {
    const parsed = new URL(locationUrl);
    return parsed.origin === daemonOrigin && parsed.pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

export function isAuditRequestAllowed(
  requestUrl: string,
  daemonOrigin: string,
  routeSlug: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.origin !== daemonOrigin) return true;
  const spacePrefix = `/spaces/v2/${routeSlug}/`;
  const spaceExact = `/spaces/v2/${routeSlug}`;
  return (
    parsed.pathname === spaceExact || parsed.pathname.startsWith(spacePrefix)
  );
}

function rewriteLegacyAuditBlobUrl(
  requestUrl: string,
  daemonOrigin: string,
  canonicalSlug: string,
  routeSlug: string,
  transport: "local" | "notary",
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  const canonicalPrefix = `/spaces/v2/${canonicalSlug}/blobs/`;
  if (parsed.origin !== daemonOrigin || !parsed.pathname.startsWith(canonicalPrefix)) {
    return null;
  }
  const key = parsed.pathname.slice(canonicalPrefix.length);
  parsed.pathname = transport === "local"
    ? `/spaces/v2/${routeSlug}/blobs/${key}`
    : `/spaces/v2/${routeSlug}/spaces/v2/${canonicalSlug}/blobs/${key}`;
  return parsed.toString();
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  let skipInstall = false;
  let egressLockdown = false;
  for (const raw of argv) {
    if (raw === "--skip-install") {
      skipInstall = true;
      continue;
    }
    if (raw === "--egress-lockdown") {
      egressLockdown = true;
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq < 0 || !raw.startsWith("--")) continue;
    args.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  const slug = args.get("slug")?.trim();
  const routeSlug = args.get("route-slug")?.trim();
  const spaceDir = args.get("space-dir")?.trim();
  const url = args.get("url")?.trim();
  if (!slug || !routeSlug || !spaceDir || !url) {
    throw new Error(
      "playwright-audit: --slug, --route-slug, --space-dir, and --url are required",
    );
  }
  // Default to the legacy `.space-build/playwright/` path so the script
  // remains usable for any caller that doesn't yet pass --output-dir; the
  // `web_artifact_audit` tool always passes an explicit timestamped path.
  const outputDir = args.get("output-dir")?.trim()
    || join(spaceDir, ".space-build", PLAYWRIGHT_DIRNAME);
  // Notary token is NOT parsed from argv — argv ends up in
  // /proc/<pid>/cmdline, readable by any local process. The Rust
  // runner pipes the token over stdin; `readAuditTokensFromStdin`
  // reads it before runAudit starts.
  const proxyRaw = args.get("proxy-server")?.trim();
  const proxyServer = proxyRaw && proxyRaw.length > 0 ? proxyRaw : null;
  // The audit session id is a routing key (not a secret) — argv is
  // fine because the daemon's redirect refuses any session id that
  // doesn't match the live registry entry minted at audit start.
  const sessionRaw = args.get("audit-session")?.trim();
  const auditSessionId = sessionRaw && sessionRaw.length > 0 ? sessionRaw : null;
  // Proxy-auth username is not a secret (Sentinel attributes by the token in
  // the password slot), so it rides on argv; the token comes off stdin.
  const proxyAuthUserRaw = args.get("proxy-auth-username")?.trim();
  const proxyAuthUsername =
    proxyAuthUserRaw && proxyAuthUserRaw.length > 0 ? proxyAuthUserRaw : null;
  const captureMode = parseCaptureMode(args.get("capture"));
  return {
    slug,
    routeSlug,
    spaceDir,
    sandboxApiSocket: args.get("sandbox-api-socket")?.trim() || null,
    outputDir,
    url,
    skipInstall,
    captureMode,
    notaryToken: null,
    auditSessionId,
    proxyServer,
    proxyAuthToken: null,
    proxyAuthUsername,
    transport: null,
    egressLockdown,
  };
}

function parseCaptureMode(rawValue: string | undefined): CaptureMode {
  const raw = rawValue?.trim();
  if (!raw || raw === CAPTURE_MODE_FULL) {
    return CAPTURE_MODE_FULL;
  }
  if (raw === CAPTURE_MODE_DESKTOP_ONLY) {
    return CAPTURE_MODE_DESKTOP_ONLY;
  }
  throw new Error(
    `playwright-audit: --capture must be ${CAPTURE_MODE_FULL} or ${CAPTURE_MODE_DESKTOP_ONLY}`,
  );
}

export interface AuditStdinTokens {
  // Route-alias-scoped notary endorsement (line 1), or null when absent/invalid.
  notaryToken: string | null;
  // Runtime egress proxy-auth token (line 2), or null when absent.
  proxyAuthToken: string | null;
}

/**
 * Read the two token lines the Rust runner pipes over stdin then closes:
 *   line 1: route-alias-scoped notary endorsement token (`endorsement.<...>`)
 *   line 2: runtime egress proxy-auth token (opaque; may be empty)
 *
 * Reads to EOF rather than settling on the first newline so both lines are
 * captured. Returns `null` for either token when its line is empty or, for the
 * notary token, does not carry the `endorsement.` prefix. Test/dev paths that
 * provide no stdin yield `{ notaryToken: null, proxyAuthToken: null }`.
 */
export async function readAuditTokensFromStdin(): Promise<AuditStdinTokens> {
  return new Promise<AuditStdinTokens>((resolve) => {
    let buf = "";
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.pause();
      } catch {
        // best-effort: stdin may already be paused
      }
      const lines = buf.split("\n");
      const notaryLine = (lines[0] ?? "").trim();
      const proxyLine = (lines[1] ?? "").trim();
      resolve({
        notaryToken: notaryLine.startsWith("endorsement.") ? notaryLine : null,
        proxyAuthToken: proxyLine.length > 0 ? proxyLine : null,
      });
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += String(chunk);
      // Both lines are present once we've seen the second newline.
      if (buf.split("\n").length >= 3) {
        settle();
      }
    });
    process.stdin.on("end", settle);
    process.stdin.on("error", settle);
  });
}

// An affordance the artifact wired that silently breaks inside the sandboxed
// iframe. `print`/`dialog` never work there; `self_url_share` copies the iframe's
// internal URL instead of a real link (the Hatch shell owns sharing).
export interface BlockedAffordance {
  kind: "print" | "dialog" | "self_url_share";
  detail: string;
}

// Scan the rendered page for sandbox-incompatible affordances. Advisory: the
// builder never SEES these fail (the audit doesn't click Print/Share and the
// blocked APIs no-op), so surfacing them is the only feedback that gets the dead
// control removed. Precise by design — copying a coupon/email or sharing a
// generated file is fine; only self-URL sharing (location.href/origin) is
// flagged. Inline-script scan catches the lite path (all JS inline); the visible
// control-label scan catches wired buttons in BOTH lite and dynamic (the handler
// may live in an external bundle, but the label is in the DOM). Never throws.
async function detectBlockedAffordances(page: Page): Promise<BlockedAffordance[]> {
  try {
    const raw = await page.evaluate(() => {
      const out: { kind: string; detail: string }[] = [];
      const seen = new Set<string>();
      const add = (kind: string, detail: string) => {
        const key = kind + "|" + detail;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ kind, detail });
        }
      };
      let inline = "";
      for (const s of Array.from(document.querySelectorAll("script:not([src])"))) {
        inline += "\n" + (s.textContent || "");
      }
      if (/\bwindow\.print\s*\(|[^.\w]print\s*\(\s*\)/.test(inline))
        add("print", "window.print() in page script");
      if (/\b(alert|confirm|prompt)\s*\(/.test(inline))
        add("dialog", "alert()/confirm()/prompt() in page script");
      if (
        /navigator\.share\s*\(|navigator\.clipboard/.test(inline) &&
        /location\.(href|origin)|document\.URL/.test(inline)
      )
        add("self_url_share", "copies the page's own URL (location.href) in page script");
      const controls = Array.from(
        document.querySelectorAll(
          'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]',
        ),
      );
      for (const el of controls) {
        const label = ((el.textContent || "") + " " + (el.getAttribute("aria-label") || ""))
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!label) continue;
        const short = label.slice(0, 40);
        if (/\bprint\b|save as pdf/.test(label)) add("print", `control labeled "${short}"`);
        else if (/share this page|copy link|copy url|share link/.test(label))
          add("self_url_share", `control labeled "${short}"`);
      }
      return out;
    });
    return raw.map((a) => ({ kind: a.kind as BlockedAffordance["kind"], detail: a.detail }));
  } catch {
    return [];
  }
}

function emptyReport(args: CliArgs): AuditReport {
  return {
    ok: true,
    url: args.url,
    duration_ms: 0,
    output_dir: args.outputDir,
    nav_status: null,
    viewports: {
      desktop: { ...DESKTOP_VIEWPORT, screenshot_path: null, fullpage_screenshot_path: null },
      mobile: { ...MOBILE_VIEWPORT, screenshot_path: null },
    },
    mobile_layout: null,
    horizontal_scrollers: [],
    unreachable_controls: { desktop: [], mobile: [] },
    clipped: { desktop: [], mobile: [] },
    images: {
      total: 0,
      broken: [],
      duplicate: [],
      unstable: [],
      failed_requests: [],
      external_blocked: { count: 0, sample: [] },
      sample_urls: [],
      verdict: "pass",
    },
    text_issues: [],
    console_errors: [],
    console_warnings: [],
    external_fetch_failures: 0,
    external_fetch_failure_samples: [],
    blocked_requests: [],
    external_requests: [],
    external_requests_dropped: 0,
    external_requests_dropped_data_bearing: 0,
    transport_ledger_active: false,
    egress_lockdown: args.egressLockdown,
    transport_connections: [],
    transport_udp_attempts: 0,
    transport_overflow: 0,
    unexplained_transport_hosts: [],
    broken_assets: [],
    blocked_affordances: [],
    interactive_nodes: 0,
    aria_snapshot: null,
    audit_session_id: args.auditSessionId,
    readiness: { desktop: null, mobile: null },
    color_scheme: null,
  };
}

function resolveBundledPlaywrightCli(): string {
  // The build script stages playwright into `<dist>/node_modules/playwright/`
  // sibling to playwright-audit.js. Resolve that cli.js absolutely so we
  // don't fall back to `bunx`, which (a) re-downloads playwright into a
  // tmpdir on every call and (b) can race against itself with multiple
  // parallel chromium downloads.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "node_modules", "playwright", "cli.js");
}

export function findSystemChrome(): string | null {
  // First chrome binary that exists and is executable.
  for (const candidate of SYSTEM_CHROME_PATHS) {
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // exists but not executable — skip
    }
  }
  return null;
}

export async function ensureChromium(): Promise<void> {
  // First call is the slow one (~30-60s, downloads ~180MB of chromium
  // headless shell); subsequent calls are no-ops because playwright caches
  // under ~/.cache/ms-playwright (or $PLAYWRIGHT_BROWSERS_PATH).
  //
  // Use `process.execPath` (the bun running this script) instead of bare
  // "bun" — the runtime cell doesn't put bun on $PATH for this subprocess,
  // so `spawn("bun", ...)` would ENOENT before we ever hit playwright. And
  // call the bundled `playwright/cli.js` directly instead of `bun x
  // playwright`, which re-resolves playwright via npm/bunx into a tmpdir.
  const cli = resolveBundledPlaywrightCli();
  if (!existsSync(cli)) {
    throw new Error(`bundled playwright cli not found at ${cli}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["run", cli, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`playwright install chromium exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

export async function loadPlaywright(): Promise<typeof import("playwright")> {
  // Resolve from worker's node_modules at runtime. `bun build` doesn't
  // bundle playwright (it's listed as external); the daemon spawn passes
  // the dist artifact path, but require resolution walks up from there.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = (await import("playwright")) as typeof import("playwright");
  return mod;
}

function dedupeAndSample(urls: string[]): {
  duplicate: DuplicateImage[];
  sample_urls: string[];
} {
  const counts = new Map<string, number>();
  for (const u of urls) counts.set(u, (counts.get(u) ?? 0) + 1);
  const duplicate: DuplicateImage[] = [];
  const sample_urls: string[] = [];
  let sampleBudget = 6;
  for (const [src, count] of counts.entries()) {
    if (count > 1) duplicate.push({ src, count });
    if (sampleBudget > 0) {
      sample_urls.push(src);
      sampleBudget -= 1;
    }
  }
  return { duplicate, sample_urls };
}

const MAX_IMAGE_SAMPLE = 12;

/**
 * Reduce raw per-`<img>` diagnostics + the image resources that returned
 * 401/403/404 into the image audit report and a single pass/fail verdict. Pure
 * (no Chromium), so the gating logic is unit-testable. Mirrors the JS audit's
 * `buildImageAudit` / `computeImageGate` in `image-audit-core.mjs`.
 *
 * An image is broken if the browser finished loading it with no pixels
 * (`!complete` or zero natural size) OR its source matches a failed response —
 * both ignore `hidden`, so an onError handler that set `display:none` does not
 * launder a broken hotlink into "absent".
 */
function isSvgSource(src: string): boolean {
  // SVGs report naturalWidth/Height 0 even when they render fine (no intrinsic
  // raster size), so the decode-empty check below would false-flag them.
  try {
    return new URL(src, "http://_local_").pathname.toLowerCase().endsWith(".svg");
  } catch {
    return (src.toLowerCase().split("?")[0] ?? src.toLowerCase()).endsWith(".svg");
  }
}

export function summarizeImages(
  rawImages: RawImg[],
  failedResponses: FailedImageRequest[],
  ownOrigin?: string,
  egressLockdown = false,
): ImageStats {
  // failed_requests is reported as a DIAGNOSTIC only — it never gates the
  // verdict. Playwright's "image" resourceType also covers favicons, CSS
  // background-images, tracking pixels, and offscreen lazy images, none of
  // which should fail a build; a genuinely broken content <img> is caught by
  // the decode check below instead, which is auth-agnostic (a 401 the audit
  // can't see but the user can still loads with naturalWidth > 0).
  const failed: FailedImageRequest[] = [];
  for (const failure of failedResponses) {
    if (!failure || typeof failure.url !== "string" || failure.url.length === 0) continue;
    if (failed.length < MAX_IMAGE_SAMPLE) {
      failed.push({ url: failure.url, status: failure.status });
    }
  }

  const broken: BrokenImage[] = [];
  const unstable: UnstableImage[] = [];
  const unstableSeen = new Set<string>();
  const externalBlocked: string[] = [];
  let externalBlockedCount = 0;
  const sources: string[] = [];
  for (const img of rawImages) {
    if (!img.src) continue;
    sources.push(img.src);

    // Decode-confirmed failure: the browser FINISHED loading and got zero
    // pixels. Requiring `complete` excludes still-loading and offscreen
    // lazy images (the main false-positive source) without trusting the
    // audit's auth context the way a raw 401 would; it still catches an
    // onError that set display:none (the element stays in the DOM). SVGs are
    // skipped because they legitimately report a zero natural size.
    if (img.complete && (img.nw === 0 || img.nh === 0) && !isSvgSource(img.src)) {
      const srcOrigin = safeOrigin(img.src);
      // http(s) only: an opaque origin (a corrupt data: URI) serializes to
      // the STRING "null", which would otherwise read as "external" and turn
      // a genuinely broken inline image into an advisory lockdown artifact.
      // Gated on the lockdown actually having run: preview/inspection
      // captures egress normally, so a dead external image there is a real
      // defect, never the lockdown.
      const external =
        egressLockdown &&
        typeof ownOrigin === "string" &&
        ownOrigin.length > 0 &&
        /^https?:/i.test(img.src) &&
        srcOrigin !== null &&
        srcOrigin !== "null" &&
        srcOrigin !== ownOrigin;
      if (external) {
        // The ledger refused this hop during the audit; the published page is
        // ungated, so this is not a broken build.
        externalBlockedCount += 1;
        if (externalBlocked.length < MAX_EXTERNAL_BLOCKED_IMAGE_SAMPLE) {
          externalBlocked.push(img.src);
        }
      } else {
        broken.push({ src: img.src, alt: img.alt, reason: "not_loaded_or_zero_size" });
      }
    }

    const classification = classifyImageSource(img.src, ownOrigin);
    if (classification.unstable && classification.reason && !unstableSeen.has(img.src)) {
      unstableSeen.add(img.src);
      if (unstable.length < MAX_IMAGE_SAMPLE) {
        unstable.push({ src: img.src, reason: classification.reason });
      }
    }
  }

  const { duplicate, sample_urls } = dedupeAndSample(sources);
  // The verdict gates ONLY on broken (decode-confirmed, same-origin) and
  // unstable (cross-origin signed/origin-locked hotlink). Duplicates are
  // reported but never fail the build — a repeated image is a content-quality
  // nudge, not a defect, and gating it false-fails repeated logos/icons.
  // failed_requests and external_blocked are diagnostic-only (see above).
  const verdict: "pass" | "fail" =
    broken.length > 0 || unstable.length > 0 ? "fail" : "pass";

  return {
    total: rawImages.length,
    broken,
    duplicate,
    unstable,
    failed_requests: failed,
    external_blocked: { count: externalBlockedCount, sample: externalBlocked },
    sample_urls,
    verdict,
  };
}

type AuditLaunchOptions = {
  headless: boolean;
  executablePath?: string;
  args?: string[];
  proxy?: { server: string; username?: string; password?: string; bypass?: string };
};

// Build the Chromium launch options shared by the baseline capture and the
// agent-test runner: headless, optional system-chrome executable, and the
// Sentinel forward proxy. Runtime egress tokens must already have been moved
// behind startProxyAuthRelay; this function refuses to pass them to Chromium.
export function buildLaunchOptions(
  executablePath: string | null,
  proxyServer: string | null,
  proxyAuthToken: string | null,
  _proxyAuthUsername: string | null,
): AuditLaunchOptions {
  const launchOptions: AuditLaunchOptions = {
    headless: true,
    args: [...CHROME_HARDENING_ARGS],
  };
  // Remove Chrome's dependency on cell DNS for the proxy endpoint and the
  // DIRECT phone-home hosts (see buildHostResolverRulesArg). Without this the
  // resolver hangs on dead cell DNS and times out even the already-governed
  // proxied self-FQDN navigation. Real hostnames carry no rule and resolve
  // proxy-side over CONNECT, so the explicit-proxy egress posture is unchanged.
  const hostResolverRulesArg = buildHostResolverRulesArg(proxyServer);
  if (hostResolverRulesArg !== null) {
    launchOptions.args = [...(launchOptions.args ?? []), hostResolverRulesArg];
  }
  if (executablePath !== null) {
    launchOptions.executablePath = executablePath;
  }
  if (proxyServer !== null) {
    // Routes Chromium through Sentinel's HTTP/HTTPS forward proxy so
    // CONNECT can tunnel out to the VM's own ingress-rev-proxy :4431 `/spaces`
    // edge (the nginx replacement). Without this Chromium would try to dial it
    // directly and the cell's egress firewall drops the TCP SYN.
    //
    // When a runtime egress token is present, main() must route Chromium through
    // a loopback relay and clear proxyAuthToken before this point. Passing the
    // token to Playwright would put it inside Chromium, where DEBUG=pw:protocol
    // can serialize the proxy-auth exchange to stderr.
    if (proxyAuthToken !== null) {
      throw new Error(
        "proxy auth token must be routed through relay before launching Chromium",
      );
    }
    // Route Chromium's startup phone-home probes DIRECT instead of through
    // Sentinel — see CHROME_PHONE_HOME_BYPASS_HOSTS. Comma-separated here;
    // Playwright joins the entries with ';' for Chrome's --proxy-bypass-list.
    const bypass = CHROME_PHONE_HOME_BYPASS_HOSTS.join(",");
    launchOptions.proxy = { server: proxyServer, bypass };
  }
  return launchOptions;
}

// A console error that is a cross-origin resource failing to load rather than
// the artifact's own defect. Under the audit's egress lockdown these fire on
// every hotlinked asset, so counting them separately keeps them out of the
// 20-entry `console_errors` cap. Requires BOTH a net-error shape and a
// cross-origin URL (in the message location or the text), so a same-origin
// failure — the kind that blocks attestation — is never diverted. Pure, so
// the classification is unit-testable.
export function isExternalFetchFailure(
  text: string,
  locationUrl: string,
  daemonOrigin: string,
): boolean {
  if (!/net::ERR_[A-Z_]+/.test(text) && !/failed to load resource/i.test(text)) {
    return false;
  }
  const candidates = [locationUrl, ...(text.match(/https?:\/\/[^\s"')]+/g) ?? [])];
  return candidates.some((candidate) => {
    // http(s) only — an opaque origin serializes to the string "null" and a
    // data:/blob: location must stay a real (same-origin-classed) error.
    if (!/^https?:\/\//i.test(candidate)) return false;
    const origin = safeOrigin(candidate);
    return origin !== null && origin !== "null" && origin !== daemonOrigin;
  });
}

// Bounded sample of diverted cross-origin failures kept alongside the count.
const MAX_EXTERNAL_FETCH_FAILURE_SAMPLES = 5;

// Attach the pageerror / console-error / failed-image-response diagnostics
// shared by the baseline capture and the agent tests. `daemonOrigin` lets the
// console handler drop the benign daemon-root favicon 401 (which every audit
// otherwise surfaces), divert cross-origin load failures, and annotate other
// console errors with their location.
export function installPageDiagnostics(
  page: Page,
  consoleErrors: string[],
  failedImageResponses: FailedImageRequest[],
  daemonOrigin: string,
  // Optional additional capture. Observe-mode captures (preview/inspection)
  // omit them and get fresh throwaway sinks; the audit run and the resident
  // probe pass their own sinks plus the lockdown flag so refused externals
  // classify the same way in both.
  consoleWarnings: string[] = [],
  brokenAssets: FailedAssetRequest[] = [],
  externalFetchFailures: { count: number; samples: string[] } = {
    count: 0,
    samples: [],
  },
  // Divert refused-external console errors only when the egress lockdown is
  // actually refusing them; in observe-mode captures (preview/inspection) an
  // external failure is a real page defect and stays in console_errors.
  egressLockdown = false,
): void {
  page.on("pageerror", (err) => {
    if (consoleErrors.length >= MAX_LOGGED_CONSOLE_ERRORS) return;
    consoleErrors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    const type = msg.type();
    const locationUrl = msg.location().url;
    if (type === "error") {
      if (isDaemonRootFaviconRequest(locationUrl, daemonOrigin)) return;
      const text = msg.text();
      // Classify before the cap so a flood of refused externals can neither
      // fill `console_errors` nor go uncounted.
      if (egressLockdown && isExternalFetchFailure(text, locationUrl, daemonOrigin)) {
        externalFetchFailures.count += 1;
        if (externalFetchFailures.samples.length < MAX_EXTERNAL_FETCH_FAILURE_SAMPLES) {
          externalFetchFailures.samples.push(formatConsoleError(text, locationUrl));
        }
        return;
      }
      if (consoleErrors.length >= MAX_LOGGED_CONSOLE_ERRORS) return;
      consoleErrors.push(formatConsoleError(text, locationUrl));
      return;
    }
    // Warnings are noisy, so keep only the high-priority classes that each name
    // a real, fixable defect (hydration, missing keys, CSP, deprecations, image
    // sizing). Everything else is dropped as build chatter.
    if (type === "warning") {
      if (consoleWarnings.length >= MAX_LOGGED_CONSOLE_WARNINGS) return;
      const text = msg.text();
      if (!isHighPriorityWarning(text)) return;
      consoleWarnings.push(formatConsoleWarning(text, locationUrl));
    }
  });
  // Capture sub-resources whose HTTP response failed. Images feed the <img>
  // correlation (an expired signed CDN URL or hotlink 401/403/404 that an
  // onError handler could otherwise launder into "absent"); non-image assets
  // (stylesheet/script/font/…) that 4xx/5xx are broken local references that
  // render the page blank or unstyled and never appear in the <img> scan.
  page.on("response", (response) => {
    try {
      const resourceType = response.request().resourceType();
      const status = response.status();
      if (resourceType === "image") {
        if (FAILED_IMAGE_RESPONSE_STATUSES.has(status)) {
          failedImageResponses.push({ url: response.url(), status });
        }
        return;
      }
      if (
        FAILED_ASSET_RESOURCE_TYPES.has(resourceType) &&
        status >= FAILED_ASSET_MIN_ERROR_STATUS &&
        brokenAssets.length < MAX_LOGGED_BROKEN_ASSETS
      ) {
        brokenAssets.push({
          url: response.url(),
          status,
          resource_type: resourceType,
        });
      }
    } catch {
      // best-effort; never fail the audit on a response-listener error
    }
  });
}

// Contexts whose route handler is already installed. `captureViewport` builds
// one context per pass and attaches once, but the route is context-scoped now,
// so a second attach on the same context would double-handle every request.
const ROUTED_CONTEXTS = new WeakSet<object>();

// Install the runner-owned network policy on a page's whole BROWSER CONTEXT and
// return the daemon origin. We mediate every request so a Space can't reach
// privileged daemon paths, and so the route-alias-scoped notary token only goes
// to the audit's daemon origin (never to cross-origin URLs a Space's page may
// load). The notary token is supplied by the runner and is never exposed to
// agent test code; agent tests run on a fresh page so a test that tampers with
// its own routes cannot affect the next test. We deliberately do NOT use
// `context.setExtraHTTPHeaders` for the token — that would attach
// `Authorization: endorsement.<...>` to cross-origin fetches the Space may
// issue, letting a malicious Space exfiltrate a ~20h bearer; the per-request
// handler below attaches it only when the request origin is the daemon origin.
//
// Context scope, not page scope: `page.route` sees only the page it was
// attached to, so a popup (popup blocking is off during the audit) issued its
// requests entirely outside the capture while still traversing the transport
// ledger — visible there as a bare host:port and, before the host:port
// cross-check, explainable by any innocent request to the same host.
export async function attachAuditNetworkPolicy(
  page: Page,
  url: string,
  canonicalSlug: string,
  routeSlug: string,
  notaryToken: string | null,
  auditSessionId: string | null,
  blockedRequests: string[],
  externalRequests: ExternalRequestLog,
  sandboxApiSocket: string | null = null,
  onTransportFailure?: () => void,
): Promise<string> {
  const daemonOrigin = new URL(url).origin;
  const daemonHost = new URL(url).host;
  const context = page.context();
  // Everything below is context-scoped, so a second attach on the same context
  // would double-handle every request and double-record every socket.
  if (ROUTED_CONTEXTS.has(context)) {
    return daemonOrigin;
  }
  ROUTED_CONTEXTS.add(context);
  const localRequests = new AbortController();
  context.on("close", () => localRequests.abort());
  // WebSockets bypass route interception, so observe them separately; a socket
  // to a foreign origin is a data channel the exfiltration screen must see.
  // Compare on host:port, not origin — a ws:/wss: origin never string-equals
  // the http(s): daemon origin, which would record the artifact's own
  // data-plane socket as external.
  const recordWebSockets = (target: Page): void => {
    target.on("websocket", (ws) => {
      const wsUrl = ws.url();
      let wsHost: string | null = null;
      try {
        wsHost = new URL(wsUrl).host;
      } catch {
        wsHost = null;
      }
      if (wsHost !== null && wsHost !== daemonHost) {
        recordExternalRequest(
          externalRequests,
          { url: wsUrl, method: "GET", resourceType: "websocket" },
          daemonOrigin,
        );
      }
    });
  };
  recordWebSockets(page);
  context.on("page", (popup) => {
    recordWebSockets(popup);
    // The popup's own URL is page-authored data on the wire (a window.open to
    // an attacker origin with the payload in the query), so record the
    // navigation itself, not just what the popup then fetches.
    let recorded = false;
    const recordPopupUrl = (): void => {
      if (recorded) return;
      const popupUrl = popup.url();
      // A popup starts at about:blank before its first navigation lands.
      if (popupUrl.length === 0 || popupUrl === "about:blank") return;
      const origin = safeOrigin(popupUrl);
      if (origin === null || origin === daemonOrigin) return;
      recorded = true;
      recordExternalRequest(
        externalRequests,
        { url: popupUrl, method: "GET", resourceType: "popup" },
        daemonOrigin,
      );
    };
    try {
      recordPopupUrl();
      // `on`, not `once`: the first framenavigated is often the about:blank
      // initial document, which the guard skips without recording — keep
      // listening until a real cross-origin navigation lands.
      popup.on("framenavigated", recordPopupUrl);
      popup.on("domcontentloaded", recordPopupUrl);
    } catch {
      // best-effort: a popup that closes immediately still rode the ledger
    }
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const reqUrl = req.url();
    const requestOrigin = safeOrigin(reqUrl);
    if (requestOrigin !== null && requestOrigin !== daemonOrigin) {
      // Record the attempt before any allow/deny decision: cross-origin
      // requests are never blocked here, but even a proxy-denied request
      // proves the page tries to send. postData() is null for GETs and
      // non-text bodies; headers() carries the page-authored custom headers.
      recordExternalRequest(
        externalRequests,
        {
          url: reqUrl,
          method: req.method(),
          resourceType: req.resourceType(),
          headers: req.headers(),
          postData: req.postData(),
        },
        daemonOrigin,
      );
    }
    const rewrittenBlobUrl = rewriteLegacyAuditBlobUrl(
      reqUrl,
      daemonOrigin,
      canonicalSlug,
      routeSlug,
      sandboxApiSocket !== null ? "local" : "notary",
    );
    if (
      rewrittenBlobUrl === null &&
      !isAuditRequestAllowed(reqUrl, daemonOrigin, routeSlug)
    ) {
      if (blockedRequests.length < MAX_LOGGED_BLOCKED_REQUESTS) {
        blockedRequests.push(reqUrl);
      }
      await route.abort("blockedbyclient");
      return;
    }
    if (sandboxApiSocket !== null && requestOrigin === daemonOrigin) {
      await fulfillLocalAuditRequest(
        route,
        sandboxApiSocket,
        rewrittenBlobUrl ?? reqUrl,
        auditSessionId,
        localRequests.signal,
        onTransportFailure,
      );
      return;
    }
    if (notaryToken !== null && safeOrigin(reqUrl) === daemonOrigin) {
      const headers: Record<string, string> = {
        ...req.headers(),
        authorization: notaryToken,
      };
      if (auditSessionId !== null) {
        // Routing key for the daemon's per-audit DB redirect; only
        // attached on same-origin requests (same scope as the notary
        // token) so cross-origin URLs the Space's page may load never see it.
        headers["x-hatch-audit-session"] = auditSessionId;
      }
      const outboundUrl = rewrittenBlobUrl ?? reqUrl;
      const outboundPath = new URL(outboundUrl).pathname;
      if (outboundPath === `/spaces/v2/${routeSlug}/actions_stream`) {
        // The daemon owns this exact streaming endpoint and never redirects
        // it. It cannot be buffered through route.fetch without destroying
        // streaming semantics.
        await route.continue({
          headers,
          ...(rewrittenBlobUrl === null ? {} : { url: outboundUrl }),
        });
        return;
      }
      // Playwright carries route.continue header overrides across redirects,
      // including cross-origin redirects. Fetch exactly one hop and fulfill
      // the browser request instead: a 3xx is handed back to Chromium, whose
      // follow-up request is intercepted afresh without inherited credentials.
      // route.fetch re-issues the request one hop upstream; the daemon/edge can
      // drop the connection mid-flight (a restart/graceful-shutdown bounce),
      // rejecting here. Without a guard the async route handler's rejection is
      // unhandled and crashes the whole audit process (exit non-zero). Abort the
      // route instead: the main document then hits page.goto's transient
      // net::ERR_ retry, and a sub-resource is recorded as a broken asset — a
      // transient upstream blip can no longer hard-fail the audit.
      try {
        const response = await route.fetch({
          headers,
          maxRedirects: 0,
          timeout: 0,
          ...(rewrittenBlobUrl === null ? {} : { url: outboundUrl }),
        });
        await route.fulfill({ response });
      } catch {
        await route.abort("failed").catch(() => {});
      }
      return;
    }
    await route.continue(rewrittenBlobUrl === null ? undefined : { url: rewrittenBlobUrl });
  });
  return daemonOrigin;
}

// Structured audit logging. Goes to STDERR so stdout contains only the report
// path; the Rust runner captures stderr and surfaces it (see
// playwright_audit.rs) so these lines land in journald for validation.
function logAuditEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    process.stderr.write(`[spaces-audit] ${event} ${JSON.stringify(fields)}\n`);
  } catch {
    // Logging must never break an audit.
  }
}

// Count of transient-nav retries taken this run (Fix 5). Module-scoped because
// the runner is a one-shot process (one runAudit per invocation); reset at the
// top of runAudit for safety. Surfaced in the envelope diagnostics.
let navRetriesThisRun = 0;

// A transient main-document status worth one retry (server-side hiccup), vs a
// deterministic 4xx (auth/notary refusal, real 404) which retry can never fix.
// Pure — unit-tested without Chromium.
export function isTransientNavStatus(status: number | null): boolean {
  return status !== null && (status >= 500 || status === 429);
}

// A thrown navigation worth one retry: nav timeout, connection reset/refused,
// DNS, or a transient net::ERR_*. NOT net::ERR_ABORTED (intentional) and NOT a
// deterministic page error. Pure — unit-tested without Chromium.
export function isTransientNavError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("net::err_aborted")) return false;
  return (
    msg.includes("timeout") ||
    msg.includes("net::err_") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up")
  );
}

/** Trimmed `body.innerText`, for the text-issue scan. */
export async function readBodyText(page: Page): Promise<string> {
  return (await page.evaluate(() => document.body?.innerText ?? "")).trim();
}

/**
 * Classify the page's visible text. Pure so both the one-shot audit and the
 * resident UI probe report the same floor from one implementation, and so the
 * thresholds are testable without a browser.
 *
 * `loading_stuck` is the load-bearing one: an artifact whose queries never
 * resolve renders a spinner, and a screenshot of a spinner looks like a page.
 */
export function scanTextIssues(bodyText: string): TextIssue[] {
  const issues: TextIssue[] = [];
  // Bounded by construction today (two rules), but the cap is the contract the
  // caller relies on, so apply it at the end rather than trusting rule count.
  if (bodyText.length === 0) {
    issues.push({ kind: "blank_region", selector: "body" });
  }
  if (/\b(loading|loading…|loading\.\.\.|please wait)\b/i.test(bodyText) && bodyText.length < 80) {
    issues.push({ kind: "loading_stuck", text: bodyText });
  }
  return issues.slice(0, MAX_LOGGED_TEXT_ISSUES);
}

/** Scrape every `<img>` with the geometry `summarizeImages` needs. */
export async function collectRawImages(page: Page): Promise<RawImg[]> {
  return (await page.evaluate(() =>
    Array.from(document.querySelectorAll("img")).map((img) => {
      const style = window.getComputedStyle(img);
      const rect = img.getBoundingClientRect();
      return {
        src: img.currentSrc || img.src,
        alt: img.alt ?? "",
        complete: img.complete,
        nw: img.naturalWidth,
        nh: img.naturalHeight,
        hidden:
          style.display === "none" ||
          style.visibility === "hidden" ||
          rect.width <= 0 ||
          rect.height <= 0,
      };
    }),
  )) as RawImg[];
}

/** Settle for a capture: network idle (the same bound as before), then the SDK's
 *  in-flight count when the page exposes it. Only network idle sees plain fetches
 *  and lazy chunks, so the count may only delay a capture, never advance it. */
export async function settleForCapture(page: Page): Promise<CaptureSettle> {
  const startedAt = Date.now();
  let network_idle = true;
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {
    network_idle = false;
  });
  const sdk = network_idle ? await pollSdkIdle(page, SETTLE_TIMEOUT_MS) : null;
  return {
    settled: network_idle && (sdk?.settled ?? true),
    settle_ms: Date.now() - startedAt,
    in_flight: sdk?.in_flight ?? null,
    network_idle,
  };
}

export interface NavigationResult {
  status: number | null;
  settle: CaptureSettle;
}

// Navigate a prepared page to the published space and settle. The settle outcome
// is returned, never swallowed, so a capture off an unsettled page can say so.
export async function navigateForCapture(
  page: Page,
  url: string,
  onAttempt?: () => void,
): Promise<NavigationResult> {
  // One goto + best-effort first-paint settle. This settle is what makes
  // `domcontentloaded` safe for SPAs; it must NOT be removed.
  const attempt = async (): Promise<NavigationResult> => {
    onAttempt?.();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    const settle = await settleForCapture(page);
    // The main-document HTTP status. An HTTP error from the artifact route
    // means the renderer returned an error page, even if transport succeeded.
    return { status: response ? response.status() : null, settle };
  };

  // At most ONE retry on a TRANSIENT failure — a thrown goto (timeout /
  // net::ERR_*) or a transient 5xx main-doc status. A deterministic 4xx or a
  // real broken page is returned as-is (never retried). An unsettled page is
  // not a retry trigger here; captureViewport owns that retry.
  try {
    const first = await attempt();
    if (isTransientNavStatus(first.status)) {
      navRetriesThisRun += 1;
      logAuditEvent("nav_retry", { reason: `transient status ${first.status}`, url });
      // Retry once; keep the first result if the retry itself throws.
      const retried = await attempt().catch(() => first);
      logAuditEvent("nav_retry_result", { first: first.status, retried: retried.status });
      return retried;
    }
    return first;
  } catch (err) {
    if (!isTransientNavError(err)) throw err;
    navRetriesThisRun += 1;
    logAuditEvent("nav_retry", {
      reason: (err as Error).message?.slice(0, 160),
      url,
    });
    const retried = await attempt(); // single retry; a second throw propagates
    logAuditEvent("nav_retry_result", { recovered: true, status: retried.status });
    return retried;
  }
}

/** Status-only form for the resident probe, which does not record the settle. */
export async function navigateAndSettle(
  page: Page,
  url: string,
  onAttempt?: () => void,
): Promise<number | null> {
  return (await navigateForCapture(page, url, onAttempt)).status;
}

/** Bound on the page-authored `declared` string; every well-formed `color-scheme`
 *  value fits, so an artifact cannot pad the record. */
const COLOR_SCHEME_DECLARED_CHARS = 64;

/** Computed `color-scheme` of `:root`, falling back to `<meta name="color-scheme">`
 *  when it computes to `normal`. A style read, never page text. */
const COLOR_SCHEME_SCRIPT = `(() => {
  const computed = (getComputedStyle(document.documentElement).colorScheme || "normal").trim();
  if (computed !== "normal") return computed;
  const content = document.querySelector('meta[name="color-scheme"]')?.getAttribute("content");
  return content && content.trim() ? content.trim().split(/\\s+/).join(" ") : computed;
})()`;

const DARK_SCREENSHOT_FILENAME = "screenshot-dark.png";

/** Light frames stay primary. When the document declares `color-scheme: dark`, the
 *  desktop pass compares a light fold with a fold under the dark preference, records
 *  whether the pixels differ (the render depends on a dark media query), keeps the
 *  dark fold for the critic only when they do and the light fold held still, and
 *  resets to light before the primary frames. Only an exact computed `dark` flips
 *  the emulation: scaffolded artifacts declare `light dark`, and emulating dark for
 *  those would flip fleet-wide captures. */
async function probeColorScheme(
  page: Page,
  outputDir: string | null,
  settleAgain: () => Promise<void>,
): Promise<ColorSchemeRecord> {
  let declared: string | null = null;
  try {
    const value = await page.evaluate(COLOR_SCHEME_SCRIPT);
    declared = typeof value === "string" ? value.slice(0, COLOR_SCHEME_DECLARED_CHARS) : null;
  } catch {
    // unknown; the light capture stands
  }
  const record: ColorSchemeRecord = { declared, media_dependent: null, dark_frame: false };
  if (declared !== "dark" || outputDir === null) return record;
  // Compare pixels, not styles: template Spaces paint on a wrapper, not <body>, and
  // frozen animations keep a moving element from reading as a palette change.
  const fold = () =>
    page.screenshot({ fullPage: false, animations: "disabled" }).catch(() => null);
  const same = (a: Buffer | null, b: Buffer | null) => !!a && !!b && a.equals(b);
  // Content that changes on its own (a timer, a rotator, a blink) would read as a
  // palette change, so the light fold must hold still across a settle before the
  // dark fold and after the reset; otherwise the result stays unknown.
  const light = await fold();
  await settleAgain();
  if (!same(light, await fold())) return record;
  let dark: Buffer | null = null;
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await settleAgain();
    dark = await fold();
  } catch {
    // best effort; the light frames below are unaffected
  } finally {
    await page.emulateMedia({ colorScheme: null }).catch(() => {});
    await settleAgain();
  }
  if (!dark) return record;
  // A page that is dark without the preference renders the same frame twice;
  // only a palette that lives in the dark media query earns the extra capture.
  if (same(light, dark)) {
    record.media_dependent = false;
    return record;
  }
  if (!same(light, await fold())) return record;
  record.media_dependent = true;
  record.dark_frame = await writeFile(join(outputDir, DARK_SCREENSHOT_FILENAME), dark).then(
    () => true,
    () => false,
  );
  return record;
}

/** Hard ceiling on the mobile overflow probe.
 *
 * The probe walks `body *` calling `getBoundingClientRect()` per element, which
 * forces a synchronous layout each time. `page.evaluate` carries no timeout of
 * its own, so on a dense artifact this is the one place in the harness that can
 * stall without bound — and it has never produced a non-zero result in
 * production, so stalling here buys nothing. Losing the measurement degrades to
 * a passing verdict, exactly as any other probe failure already does. */
const MOBILE_OVERFLOW_PROBE_TIMEOUT_MS = 5_000;

async function withOverflowProbeTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("mobile overflow probe timed out")),
          MOBILE_OVERFLOW_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Measure page-level horizontal overflow at the mobile viewport. Runs in-page
// (DOM), then hands the raw numbers to the pure classifier. Best-effort: any
// evaluate failure yields a passing (overflow 0) result so a probe error never
// false-fails a build. Scrollbars are hidden by the SDK root styles, so this
// measurement — not the screenshot — is the reliable overflow signal.
async function evaluateMobileOverflow(
  page: Page,
): Promise<MobileLayoutAudit> {
  try {
    const raw = (await withOverflowProbeTimeout(page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollingEl = document.scrollingElement ?? doc;
      const viewportWidth = window.innerWidth || (doc ? doc.clientWidth : 0) || 0;
      const scrollWidth = Math.max(
        scrollingEl ? scrollingEl.scrollWidth : 0,
        doc ? doc.scrollWidth : 0,
        body ? body.scrollWidth : 0,
      );
      // Point the fix at the widest element that extends past the right edge.
      let widestSelector: string | null = null;
      let widestRight = viewportWidth;
      const nodes = body ? body.querySelectorAll("*") : [];
      const MAX_SCAN = 4000;
      let scanned = 0;
      for (const el of Array.from(nodes)) {
        if (scanned >= MAX_SCAN) break;
        scanned += 1;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.right > widestRight + 1) {
          widestRight = rect.right;
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : "";
          const className =
            typeof el.className === "string" ? el.className.trim() : "";
          const cls =
            className.length > 0
              ? "." + className.split(/\s+/).slice(0, 2).join(".")
              : "";
          widestSelector = `${tag}${id}${cls}`.slice(0, 120);
        }
      }
      return { viewportWidth, scrollWidth, widestSelector, scanned };
    }))) as {
      viewportWidth: number;
      scrollWidth: number;
      widestSelector: string | null;
      scanned: number;
    };
    return classifyMobileOverflow(
      raw.viewportWidth,
      raw.scrollWidth,
      raw.widestSelector,
    );
  } catch {
    // Never fail the audit on a probe error; report "fits".
    return classifyMobileOverflow(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.width, null);
  }
}

// Element-level companion to `evaluateMobileOverflow`: walk the mobile page
// for overflowing `overflow-x: auto|scroll` containers. Best-effort: any
// failure yields an empty list, never false-flagging an unmeasured build.
async function evaluateHorizontalScrollers(
  page: Page,
): Promise<HorizontalScroller[]> {
  try {
    const raw = (await withOverflowProbeTimeout(page.evaluate(() => {
      const out: {
        selector: string;
        scroll_width: number;
        client_width: number;
        visible: boolean;
      }[] = [];
      const body = document.body;
      if (!body) return out;
      // Short unique-ish CSS path (tag#id.classes, up to two ancestor
      // segments); enough to find the offender, never a full DOM path.
      const segment = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const className =
          typeof el.className === "string" ? el.className.trim() : "";
        const cls =
          className.length > 0
            ? "." + className.split(/\s+/).slice(0, 2).join(".")
            : "";
        return `${tag}${id}${cls}`;
      };
      const shortPath = (el: Element): string => {
        const parts = [segment(el)];
        let cursor: Element | null = el.parentElement;
        while (
          cursor !== null &&
          cursor !== body &&
          parts.length < 3 &&
          !parts.some((part) => part.includes("#"))
        ) {
          parts.unshift(segment(cursor));
          cursor = cursor.parentElement;
        }
        return parts.join(" > ").slice(0, 160);
      };
      // Same walk budget as the page-level overflow probe: layout is forced
      // per element, so bound the walk.
      const MAX_SCAN = 4000;
      let scanned = 0;
      for (const el of Array.from(body.querySelectorAll("*"))) {
        if (scanned >= MAX_SCAN) break;
        scanned += 1;
        const style = window.getComputedStyle(el);
        const overflowX = style.overflowX;
        if (overflowX !== "auto" && overflowX !== "scroll") continue;
        const scrollWidth = el.scrollWidth;
        const clientWidth = el.clientWidth;
        if (scrollWidth <= clientWidth) continue;
        const rect = el.getBoundingClientRect();
        out.push({
          selector: shortPath(el),
          scroll_width: scrollWidth,
          client_width: clientWidth,
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0,
        });
        // Bound the raw list too so the evaluate payload stays small.
        if (out.length >= 50) break;
      }
      return out;
    }))) as RawScrollerCandidate[];
    return classifyHorizontalScrollers(raw);
  } catch {
    // Never fail the audit on a probe error; report no scrollers.
    return [];
  }
}

class AuditNavigationError extends Error {
  constructor(
    readonly status: number | null,
    readonly error_kind?: "capture_transport",
  ) {
    super(
      error_kind === "capture_transport"
        ? "Artifact capture local transport failed"
        : `Artifact render failed with HTTP status ${status ?? "missing"}`,
    );
  }
}

async function captureViewport(
  pw: typeof import("playwright"),
  url: string,
  canonicalSlug: string,
  routeSlug: string,
  viewport: { width: number; height: number },
  outputDir: string,
  fileName: string,
  consoleErrors: string[],
  consoleWarnings: string[],
  blockedRequests: string[],
  externalRequests: ExternalRequestLog,
  brokenAssets: FailedAssetRequest[],
  externalFetchFailures: { count: number; samples: string[] },
  isMobile: boolean,
  executablePath: string | null,
  notaryToken: string | null,
  auditSessionId: string | null,
  proxyServer: string | null,
  proxyAuthToken: string | null,
  proxyAuthUsername: string | null,
  egressLockdown: boolean,
  // Fix 1: when provided, reuse this browser (one launch per audit) via a fresh
  // context; when null, launch a dedicated browser for this pass (legacy path).
  sharedBrowser: Browser | null = null,
  sandboxApiSocket: string | null = null,
): Promise<{
  screenshot_path: string | null;
  images: ImageStats;
  text_issues: TextIssue[];
  nav_status: number | null;
  mobile_layout: MobileLayoutAudit | null;
  /** Components that scroll sideways at THIS viewport; measured on the
   *  mobile pass only ([] on desktop). */
  horizontal_scrollers: HorizontalScroller[];
  /** Interactive controls a user at THIS viewport cannot operate. */
  unreachable_controls: UnreachableControl[];
  /** Text runs the walk measured as visibly cut off at THIS viewport. */
  clipped: ClippedNode[];
  /** Page-derived count of interactive controls at THIS viewport (0 if the
   *  observe pass failed). runAudit takes the max across viewports for the
   *  envelope's `interactive_nodes`. */
  interactive_nodes: number;
  /** Full-page screenshot path, captured on the desktop pass only; null on
   *  mobile and on capture failure. */
  fullpage_screenshot_path: string | null;
  /** Desktop accessibility tree (capped), or null on mobile / on failure. */
  aria_snapshot: string | null;
  /** Sandbox-incompatible affordances found on the desktop pass; [] on mobile. */
  blocked_affordances: BlockedAffordance[];
  readiness: ViewportReadiness;
  color_scheme: ColorSchemeRecord;
  // Phase-0 telemetry: cold Chromium launch time for this pass (ms). 0 when a
  // shared browser is reused (the launch cost is attributed once in runAudit).
  launch_ms: number;
}> {
  let browser: Browser;
  let ownsBrowser = false;
  let launch_ms = 0;
  let captureTransportFailed = false;
  if (sharedBrowser) {
    browser = sharedBrowser;
  } else {
    const launchStartedAt = performance.now();
    browser = await pw.chromium.launch(
      buildLaunchOptions(executablePath, proxyServer, proxyAuthToken, proxyAuthUsername),
    );
    launch_ms = performance.now() - launchStartedAt;
    ownsBrowser = true;
  }
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: isMobile ? 3 : 1,
      hasTouch: isMobile,
      isMobile,
      serviceWorkers: "block",
      // Scoped cert-error bypass for this audit context only. The audit dials
      // the VM's own ingress-rev-proxy `:4431` `/spaces` edge, whose leaf is
      // signed by the private "Meta Hatch Intermediate CA". The runtime cell's
      // headless Chromium does NOT honor that CA (the cell NSS import does not
      // reach it), so without this every capture fails ERR_CERT_AUTHORITY_INVALID.
      // Safe here: a VM-loopback hop to a single pinned self-FQDN origin, where
      // the notary endorsement — not the TLS cert — is the real authorization,
      // so the cert carries no security on this hop. Scoped to the audit
      // context; global TLS validation elsewhere is unchanged.
      ignoreHTTPSErrors: true,
    });
    if (SCENARIO_CLOCK_OFFSET_MS !== null) {
      await context.addInitScript(shiftTimeScript(SCENARIO_CLOCK_OFFSET_MS));
    }
    const page = await context.newPage();
    const daemonOrigin = new URL(url).origin;
    const failedImageResponses: FailedImageRequest[] = [];
    installPageDiagnostics(
      page,
      consoleErrors,
      failedImageResponses,
      daemonOrigin,
      consoleWarnings,
      brokenAssets,
      externalFetchFailures,
      egressLockdown,
    );
    await attachAuditNetworkPolicy(
      page,
      url,
      canonicalSlug,
      routeSlug,
      notaryToken,
      auditSessionId,
      blockedRequests,
      externalRequests,
      sandboxApiSocket,
      () => {
        captureTransportFailed = true;
      },
    );
    let priorAttemptTransportFailed = false;
    const navigation = await navigateForCapture(page, url, () => {
      // An existing navigation retry starts a fresh capture. A recovered
      // connection must not retain the prior attempt's infrastructure flag.
      priorAttemptTransportFailed ||= captureTransportFailed;
      captureTransportFailed = false;
    }).catch((error) => {
      // Chromium can interrupt the retry while committing its first error
      // page. Without a completed navigation, retain the transport cause.
      if (priorAttemptTransportFailed || captureTransportFailed) {
        throw new AuditNavigationError(null, "capture_transport");
      }
      throw error;
    });
    const navStatus = navigation.status;
    if (navStatus === null || navStatus < 200 || navStatus >= 300) {
      throw new AuditNavigationError(navStatus);
    }

    // Everything below reads the page as it is now, so settle it first. One retry,
    // same bound: a page still loading at the first window usually finishes inside
    // a second one, and the critic once read the first frame as missing content.
    let settle = navigation.settle;
    const settleAgain = async () => {
      const again = await settleForCapture(page);
      settle = { ...again, settle_ms: settle.settle_ms + again.settle_ms };
    };
    const retried = !settle.settled;
    if (retried) await settleAgain();
    const color_scheme = await probeColorScheme(page, isMobile ? null : outputDir, settleAgain);
    const readiness: ViewportReadiness = { ...settle, retried };

    const text_issues = scanTextIssues(await readBodyText(page));
    const rawImages = await collectRawImages(page);

    const images = summarizeImages(
      rawImages,
      failedImageResponses,
      daemonOrigin,
      egressLockdown,
    );

    // Page-level horizontal overflow is a mobile-only concern (the artifact is
    // phone-first and desktop is roomy), so only measure it on the mobile pass.
    const mobile_layout = isMobile ? await evaluateMobileOverflow(page) : null;

    // Element-level sideways scrollers, same mobile-only scope.
    const horizontal_scrollers = isMobile
      ? await evaluateHorizontalScrollers(page)
      : [];

    // Controls the user cannot reach at this viewport: occluded by an overlay,
    // invisible up the ancestor chain, or clipped outside a scrollport that
    // cannot scroll to them. This is deterministic and costs one in-page pass,
    // which is the point: in production these defects reached users within 90
    // seconds of delivery while `mobile_layout.overflow_px` read 0 (the clip is
    // INSIDE a scroller, not on the document) and no model loop found them.
    // The page-derived interactive-node count travels with the unreachable set
    // from the same walk. It is a property of the rendered page, not of anything
    // the builder did, so the completion gate can trust it as ground truth for
    // "this artifact offers N controls" even when the builder never drove one.
    let interactive_nodes = 0;
    // Text runs the same walk measured as cut off. Not gating (unlike mobile
    // unreachable), so a single walk is enough; refreshed from the settled walk
    // below when a double-take runs.
    let clipped: ClippedNode[] = [];
    let unreachable_controls = await observeNodes(page)
      .then((walk) => {
        interactive_nodes = walk.interactive_nodes;
        clipped = clippedNodes(walk);
        return walk.unreachable;
      })
      // Fail open: an instrumentation pass must never fail the audit it observes.
      .catch(() => []);
    if (unreachable_controls.length > 0) {
      // Double take before reporting. Mobile entries BLOCK the audit, and a
      // control sampled mid-way through a CSS transition (opacity fade-in,
      // slide-in) would fail a page that is fine 800ms later; anything real —
      // still invisible, occluded or clipped after the wait — survives both
      // walks. A failed re-walk keeps the first walk's findings rather than
      // inventing a clean bill.
      try {
        await page.waitForTimeout(TRANSITION_DOUBLE_TAKE_MS);
        const second = await observeNodes(page);
        unreachable_controls = confirmTransientUnreachable(
          unreachable_controls,
          second.unreachable,
        );
        // The page has settled; take clipping from the confirmed walk too.
        clipped = clippedNodes(second);
      } catch {
        // fail open — the first walk stands
      }
    }

    const screenshotPath = join(outputDir, fileName);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    // The screenshot above is the fold only. On the authoritative desktop pass,
    // also capture the whole scrolled page in one image (so below-the-fold
    // defects are reviewable) and snapshot the accessibility tree (semantic
    // structure for the builder). Both are desktop-only: mobile is a
    // screenshot-plus-overflow side check and a full mobile page would be
    // extremely tall. Best-effort — neither ever fails the audit.
    let fullpage_screenshot_path: string | null = null;
    let aria_snapshot: string | null = null;
    let blocked_affordances: BlockedAffordance[] = [];
    if (!isMobile) {
      const fullPagePath = join(outputDir, FULLPAGE_SCREENSHOT_FILENAME);
      try {
        await page.screenshot({ path: fullPagePath, fullPage: true });
        fullpage_screenshot_path = fullPagePath;
      } catch {
        // the fold screenshot is already captured; a full-page failure is non-fatal
      }
      aria_snapshot = capAriaSnapshot(await ariaSnapshot(page));
      blocked_affordances = await detectBlockedAffordances(page);
    }

    if (captureTransportFailed) {
      throw new AuditNavigationError(null, "capture_transport");
    }
    await context.close();
    return {
      screenshot_path: screenshotPath,
      images,
      text_issues,
      nav_status: navStatus,
      mobile_layout,
      horizontal_scrollers,
      unreachable_controls,
      clipped,
      interactive_nodes,
      fullpage_screenshot_path,
      aria_snapshot,
      blocked_affordances,
      readiness,
      color_scheme,
      launch_ms,
    };
  } catch (error) {
    if (captureTransportFailed) {
      throw new AuditNavigationError(null, "capture_transport");
    }
    throw error;
  } finally {
    // Only close a browser this pass owns; a shared browser is closed by runAudit.
    if (ownsBrowser) {
      await browser.close();
    }
  }
}

async function runAudit(args: CliArgs): Promise<AuditReport> {
  const started = performance.now();
  navRetriesThisRun = 0;
  const report = emptyReport(args);
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const blockedRequests: string[] = [];
  const externalRequests = newExternalRequestLog();
  const brokenAssets: FailedAssetRequest[] = [];
  const externalFetchFailures = { count: 0, samples: [] as string[] };
  const outputDir = args.outputDir;
  // Fallback/decision flags surfaced in report.diagnostics for validation.
  let sharedLaunchFailed = false;
  let concurrentDesktopRetried = false;
  let concurrentMobileRetried = false;
  logAuditEvent("start", {
    slug: args.slug,
    capture: args.captureMode,
  });
  await mkdir(outputDir, { recursive: true });

  // Resolution order: prefer the image-baked Meta Chromium on Hatch VMs over
  // a runtime download.
  // The runtime download path tends to fail in the build daemon's namespace
  // (HOME / cache permissions, CDN egress under Sentinel), and a present
  // image/system browser makes the download unnecessary regardless.
  let executablePath: string | null = findSystemChrome();
  if (executablePath === null && !args.skipInstall) {
    try {
      await ensureChromium();
    } catch (err) {
      report.ok = false;
      report.error = `chromium install failed: ${(err as Error).message}`;
      report.duration_ms = performance.now() - started;
      report.console_errors = consoleErrors;
      return report;
    }
  }

  let pw: typeof import("playwright");
  try {
    pw = await loadPlaywright();
  } catch (err) {
    report.ok = false;
    report.error = `playwright module not loadable: ${(err as Error).message}`;
    report.duration_ms = performance.now() - started;
    report.console_errors = consoleErrors;
    return report;
  }

  // Launch ONE browser for desktop + mobile + tests instead of three cold
  // launches. On launch failure, fall back to per-pass launches (sharedBrowser
  // stays null) — the audit is never failed by this.
  let sharedBrowser: Browser | null = null;
  let sharedLaunchMs = 0;
  try {
    const sharedLaunchStartedAt = performance.now();
    sharedBrowser = await pw.chromium.launch(
      buildLaunchOptions(
        executablePath,
        args.proxyServer,
        args.proxyAuthToken,
        args.proxyAuthUsername,
      ),
    );
    sharedLaunchMs = performance.now() - sharedLaunchStartedAt;
    logAuditEvent("shared_browser_launched", { launch_ms: sharedLaunchMs });
  } catch (err) {
    sharedLaunchFailed = true;
    consoleErrors.push(
      `shared browser launch failed; using per-pass launches: ${(err as Error).message}`,
    );
    logAuditEvent("shared_browser_launch_failed", {
      error: (err as Error).message?.slice(0, 160),
    });
    sharedBrowser = null;
  }
  // Blast-radius guard: hand a pass the shared browser only while it is still
  // connected; if a prior pass crashed it, the next pass gets null and launches
  // its own browser (fall back to the legacy path) instead of failing.
  const liveShared = (): Browser | null =>
    sharedBrowser !== null && sharedBrowser.isConnected() ? sharedBrowser : null;

  // Orphan-leak guard: whatever happens below (including an unexpected throw
  // from a viewport pass), the single shared browser is always closed once.
  let concurrentViewportsRan = false;
  try {
    // Desktop is the authoritative pass (image/text scan + nav_status); mobile
    // is a screenshot-only side check plus the overflow probe. Each is its own
    // guarded closure so they can run serially (default) or concurrently (Fix 2).
    // The merge is explicit: desktop owns images/text/nav_status,
    // mobile owns mobile_layout — mobile's nav_status is intentionally ignored.
    const runDesktop = async (): Promise<boolean> => {
      const desktopStartedAt = performance.now();
      try {
        const desktop = await captureViewport(
          pw,
          args.url,
          args.slug,
          args.routeSlug,
          DESKTOP_VIEWPORT,
          outputDir,
          SCREENSHOT_FILENAME,
          consoleErrors,
          consoleWarnings,
          blockedRequests,
          externalRequests,
          brokenAssets,
          externalFetchFailures,
          false,
          executablePath,
          args.notaryToken,
          args.auditSessionId,
          args.proxyServer,
          args.proxyAuthToken,
          args.proxyAuthUsername,
          args.egressLockdown,
          liveShared(),
          args.sandboxApiSocket ?? null,
        );
        report.viewports.desktop.screenshot_path = desktop.screenshot_path;
        report.viewports.desktop.fullpage_screenshot_path =
          desktop.fullpage_screenshot_path;
        report.unreachable_controls.desktop = desktop.unreachable_controls;
        report.clipped.desktop = desktop.clipped;
        report.aria_snapshot = desktop.aria_snapshot;
        report.blocked_affordances = desktop.blocked_affordances;
        report.interactive_nodes = Math.max(
          report.interactive_nodes,
          desktop.interactive_nodes,
        );
        report.nav_status = desktop.nav_status;
        report.images = desktop.images;
        report.text_issues = desktop.text_issues;
        report.readiness.desktop = desktop.readiness;
        // Desktop is authoritative for the scheme; a mobile pass that finished
        // first only held the slot until now.
        report.color_scheme = desktop.color_scheme;
        // In shared mode the launch is counted once (sharedLaunchMs); the
        // per-pass desktop.launch_ms is 0 because it reused the shared browser.
        report.cold_launch_ms =
          sharedBrowser !== null ? sharedLaunchMs : desktop.launch_ms;
        return true;
      } catch (err) {
        report.ok = false;
        report.error = `desktop capture failed: ${(err as Error).message}`;
        if (err instanceof AuditNavigationError) {
          report.nav_status = err.status;
          report.error_kind = err.error_kind;
        }
        return false;
      } finally {
        report.desktop_ms = performance.now() - desktopStartedAt;
      }
    };
    const runMobile = async (): Promise<boolean> => {
      if (args.captureMode === CAPTURE_MODE_DESKTOP_ONLY) return true;
      const mobileStartedAt = performance.now();
      try {
        const mobile = await captureViewport(
          pw,
          args.url,
          args.slug,
          args.routeSlug,
          MOBILE_VIEWPORT,
          outputDir,
          MOBILE_SCREENSHOT_FILENAME,
          consoleErrors,
          consoleWarnings,
          blockedRequests,
          externalRequests,
          brokenAssets,
          externalFetchFailures,
          true,
          executablePath,
          args.notaryToken,
          args.auditSessionId,
          args.proxyServer,
          args.proxyAuthToken,
          args.proxyAuthUsername,
          args.egressLockdown,
          liveShared(),
          args.sandboxApiSocket ?? null,
        );
        report.viewports.mobile.screenshot_path = mobile.screenshot_path;
        report.mobile_layout = mobile.mobile_layout;
        report.horizontal_scrollers = mobile.horizontal_scrollers;
        report.unreachable_controls.mobile = mobile.unreachable_controls;
        report.clipped.mobile = mobile.clipped;
        report.interactive_nodes = Math.max(
          report.interactive_nodes,
          mobile.interactive_nodes,
        );
        report.readiness.mobile = mobile.readiness;
        report.color_scheme ??= mobile.color_scheme;
        return true;
      } catch (err) {
        // Mobile failure is non-fatal — desktop is the primary signal — but the
        // caller retries it serially once under concurrency (below) so a
        // SQLITE_BUSY collision doesn't silently drop mobile coverage.
        consoleErrors.push(`mobile capture failed: ${(err as Error).message}`);
        return false;
      } finally {
        report.mobile_ms = performance.now() - mobileStartedAt;
      }
    };

    // Run desktop + mobile concurrently on the shared browser (two contexts).
    // Requires the shared browser and full capture mode; desktop-only or a
    // failed shared launch ⇒ the serial fallback below.
    const runConcurrentViewports =
      sharedBrowser !== null &&
      args.captureMode !== CAPTURE_MODE_DESKTOP_ONLY;
    if (runConcurrentViewports) {
      // Promise.all here never rejects: each closure catches its own errors, so
      // a failing pass can't cancel the other.
      const [desktopOk, mobileOk] = await Promise.all([runDesktop(), runMobile()]);
      concurrentViewportsRan = true;
      // SQLITE_BUSY / concurrency guard: a concurrent on-load write can collide
      // on the sandbox DB and fail a pass; retry the failed pass SERIALLY once
      // now that the other has settled, before accepting the result.
      if (!desktopOk) {
        concurrentDesktopRetried = true;
        logAuditEvent("concurrent_desktop_retry", {
          reason: "desktop failed under concurrency; retrying serially",
        });
        report.ok = true;
        report.error = undefined;
        report.error_kind = undefined;
        await runDesktop();
      }
      // Mobile is non-fatal, so a concurrency collision would otherwise leave it
      // silently un-audited (no screenshot/layout) while the build still passes;
      // retry it serially once to recover the coverage.
      if (!mobileOk) {
        concurrentMobileRetried = true;
        logAuditEvent("concurrent_mobile_retry", {
          reason: "mobile failed under concurrency; retrying serially",
        });
        await runMobile();
      }
    } else {
      await runDesktop();
      await runMobile();
    }
  } finally {
    // Close the shared browser we launched (Fix 1), exactly once.
    if (sharedBrowser !== null) {
      await sharedBrowser.close().catch(() => {});
    }
  }

  // Phase-0 telemetry: how many cold chromium.launch() calls this audit paid and
  // which browser strategy ran. Shared mode is a single launch; the legacy path
  // pays desktop + (mobile unless desktop-only).
  report.browser_launches =
    sharedBrowser !== null
      ? 1
      : 1 + (args.captureMode !== CAPTURE_MODE_DESKTOP_ONLY ? 1 : 0);
  report.audit_path = concurrentViewportsRan
    ? "shared-concurrent"
    : sharedBrowser !== null
      ? "shared"
      : "current";
  report.console_errors = consoleErrors;
  report.console_warnings = consoleWarnings;
  report.external_fetch_failures = externalFetchFailures.count;
  report.external_fetch_failure_samples = externalFetchFailures.samples;
  report.blocked_requests = blockedRequests;
  report.external_requests = externalRequests.requests;
  report.external_requests_dropped = externalRequests.dropped;
  report.external_requests_dropped_data_bearing =
    externalRequests.dropped_data_bearing;
  // Transport snapshot + cross-check: every ledger destination must be
  // explained by a captured request (or be the audit's own daemon origin).
  // An unexplained host means the page reached it through a channel the
  // content capture cannot inspect -- including hosts a capture-cap flood
  // tried to hide, which land here instead of disappearing.
  const ledger = args.transport;
  report.transport_ledger_active = ledger !== null;
  report.egress_lockdown = args.egressLockdown;
  if (ledger !== null) {
    report.transport_connections = [...ledger.state.entries.values()];
    report.transport_udp_attempts = ledger.state.udp_attempts;
    report.transport_overflow = ledger.state.overflow;
    // Explained set keys on host:port (same key the lockdown matches on), so
    // one captured request cannot explain a covert channel on another port of
    // the same host. An unparseable or non-TCP captured URL keys nothing and
    // therefore explains nothing.
    const explained = new Set<string>();
    const auditDestination = ledgerDestinationKey(args.url);
    if (auditDestination !== null) {
      explained.add(auditDestination);
    }
    for (const request of externalRequests.requests) {
      const destination = ledgerDestinationKey(request.url);
      if (destination !== null) {
        explained.add(destination);
      }
    }
    report.unexplained_transport_hosts = unexplainedTransportHosts(
      ledger.state,
      explained,
    );
  }
  report.broken_assets = dedupeBrokenAssets(brokenAssets);
  report.duration_ms = performance.now() - started;

  // Per-fix decision record for validation — durable in report.json alongside
  // the phase timers, and echoed to stderr for journald.
  report.diagnostics = {
    audit_path: report.audit_path ?? "current",
    concurrent_ran: concurrentViewportsRan,
    concurrent_desktop_retry: concurrentDesktopRetried,
    concurrent_mobile_retry: concurrentMobileRetried,
    shared_launch_failed: sharedLaunchFailed,
    nav_retries: navRetriesThisRun,
    // Counted from the records the shipped images came from, so a pass the
    // concurrency guard re-ran serially is counted once, for its final run.
    settle_retries:
      (report.readiness.desktop?.retried ? 1 : 0) +
      (report.readiness.mobile?.retried ? 1 : 0),
  };
  logAuditEvent("done", {
    ok: report.ok,
    duration_ms: report.duration_ms,
    audit_path: report.audit_path,
    browser_launches: report.browser_launches,
    cold_launch_ms: report.cold_launch_ms,
    desktop_ms: report.desktop_ms,
    mobile_ms: report.mobile_ms,
    interactive_nodes: report.interactive_nodes,
    diagnostics: report.diagnostics,
  });
  return report;
}

export type ProxyAuthRelay = { server: string; close: () => Promise<void> };

const RELAY_START_FAILURE_MARKER = "hatch-egress-relay-start-failure";
const RELAY_START_FAILURE_MESSAGE =
  "proxy-auth relay failed to start; refusing to pass egress token to Chromium";

const LEDGER_START_FAILURE_MARKER = "hatch-transport-ledger-start-failure";
const LEDGER_START_FAILURE_MESSAGE =
  "transport ledger failed to start; audit aborted (retryable)";

// Loopback CONNECT relay that injects the runtime egress token as
// `Proxy-Authorization` on EVERY forwarded CONNECT, then tunnels to the real
// Sentinel proxy.
//
// Why this exists: Chromium is pointed at this credential-free loopback relay,
// while the relay injects the runtime egress token into every forwarded CONNECT.
// Chromium does NOT reliably replay Playwright proxy credentials on cross-origin
// SUBRESOURCE CONNECTs — in particular the `fonts.googleapis.com` /
// `fonts.gstatic.com` fetches a Space's CSS `@import` triggers at render time.
// Those CONNECTs reach Sentinel unattributed (`policy_subject =
// runtime.unknown`), so the per-Space managed allow (which is scoped to the
// `space.<slug>` subject) can't match and the user gets a mid-build "access
// fonts.googleapis.com" egress card. Injecting the credential at the transport
// layer here makes attribution deterministic for every connection the render
// opens, independent of Chromium's challenge/replay behavior, and keeps the
// token out of Chromium's DEBUG=pw:protocol output.
//
// Listens on IPv6 loopback (`[::1]`) on purpose: pointing Chromium at an
// IPv4-literal proxy endpoint makes it issue a NAT64 `ipv4only.arpa` probe
// that hangs on the cell's (deliberately dead) DNS — the audit-timeout class
// of bug. An IPv6 literal triggers no such probe. The relay dials the upstream
// Sentinel proxy at whatever address the runner passed (v4 or v6); only the
// Chromium-facing endpoint must be v6.
//
// Threat model: the relay injects the egress token for any client that reaches
// its loopback port during the render window, so loopback reachability + the
// ephemeral port stand in for token knowledge. This is acceptable and not
// hardened further because: the listener is IPv6-loopback-only (off-host
// unreachable), the port is ephemeral and disclosed only to the render's
// Chromium, the relay lives only for the render and is torn down after, the
// token already resides in-cell (piped to this process over stdin), and
// Sentinel still enforces the `space.<slug>` subject's policy — injecting the
// token only sets attribution, it never widens what that subject may reach.
//
// `connectOnly` narrows that further where the caller can prove only CONNECT
// is legitimate (the one-shot audit, whose Chromium reaches this hop through
// the transport ledger, which speaks CONNECT and nothing else): an origin-form
// request is then some other in-cell client trying to borrow the credential,
// and gets a 405 instead of a credentialed forward. Callers whose Chromium
// talks to the relay directly (the resident probe) must leave it off — Chromium
// proxies plain http as an absolute-form GET.
export async function startProxyAuthRelay(
  upstreamProxyUrl: string,
  username: string,
  token: string,
  options?: { connectOnly?: boolean },
): Promise<ProxyAuthRelay> {
  const connectOnly = options?.connectOnly === true;
  const upstream = new URL(upstreamProxyUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`unsupported proxy protocol: ${upstream.protocol}`);
  }
  const upstreamIsHttps = upstream.protocol === "https:";
  const upstreamHost = upstream.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const upstreamPort =
    upstream.port.length > 0 ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;
  const upstreamRequest = upstreamIsHttps ? httpsRequest : httpRequest;
  const credential =
    "Basic " + Buffer.from(`${username}:${token}`).toString("base64");

  const server = createServer((clientReq, clientRes) => {
    if (connectOnly) {
      // Refuse before dialing upstream and before the credential is composed:
      // nothing legitimate sends an origin-form request to this relay.
      try {
        clientRes.writeHead(405, { connection: "close" });
        clientRes.end();
      } catch {
        /* client already gone */
      }
      return;
    }
    // Plain HTTP through the proxy is rare for the render (it speaks HTTPS via
    // CONNECT), but forward it with the injected credential for completeness.
    const upstreamReq = upstreamRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, "proxy-authorization": credential },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    upstreamReq.on("error", () => {
      try {
        clientRes.writeHead(502);
        clientRes.end();
      } catch {
        /* client already gone */
      }
    });
    clientReq.pipe(upstreamReq);
  });

  // Track live sockets so close() can force them shut and never block on a
  // lingering connection.
  const sockets = new Set<Duplex>();
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    const connectRequest =
      `CONNECT ${target} HTTP/1.1\r\n` +
      `Host: ${target}\r\n` +
      `Proxy-Authorization: ${credential}\r\n` +
      `\r\n`;
    const upstreamSocket = upstreamIsHttps
      ? tlsConnect({
          host: upstreamHost,
          port: upstreamPort,
          servername: isIP(upstreamHost) ? undefined : upstreamHost,
        })
      : netConnect(upstreamPort, upstreamHost);
    upstreamSocket.once(upstreamIsHttps ? "secureConnect" : "connect", () => {
      upstreamSocket.write(connectRequest);
    });
    sockets.add(clientSocket);
    sockets.add(upstreamSocket);
    // Symmetric teardown: destroy BOTH ends whenever either closes or errors,
    // so a client abort before the tunnel is established can't leak the dangling
    // upstream socket (Chromium routinely cancels speculative subresource
    // CONNECTs). Idempotent — destroy() on an already-destroyed socket is a
    // no-op.
    const teardown = () => {
      sockets.delete(clientSocket);
      sockets.delete(upstreamSocket);
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
    upstreamSocket.on("close", teardown);
    // Chromium waits for our tunnel response before sending TLS bytes, so pause
    // the client read side until the tunnel is established to avoid dropping any
    // early data on the floor.
    clientSocket.pause();
    let established = false;
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      if (established) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      established = true;
      upstreamSocket.removeListener("data", onData);
      const statusLine = buffer
        .subarray(0, buffer.indexOf("\r\n"))
        .toString("latin1");
      // Forward the upstream CONNECT response verbatim: a 200 establishes the
      // tunnel, and a 407/403/5xx is surfaced to Chromium unchanged. Any tunnel
      // bytes the upstream already sent after the header ride along in `buffer`.
      clientSocket.write(buffer);
      // Match the status CODE token exactly (not a substring) so a reason phrase
      // that merely contains "200" can't be misread as an established tunnel.
      if (statusLine.split(/\s+/)[1] === "200") {
        if (head.length > 0) {
          upstreamSocket.write(head);
        }
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      } else {
        clientSocket.end();
        upstreamSocket.end();
      }
    };
    upstreamSocket.on("data", onData);
    upstreamSocket.on("error", () => {
      if (!established) {
        try {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          /* client already gone */
        }
      }
      teardown();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : 0;
  return {
    server: `http://[::1]:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close any live tunnels first so server.close()'s callback fires
        // promptly (it otherwise waits on lingering connections, which could
        // hang the audit's teardown).
        for (const socket of [...sockets]) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  // Pull the notary endorsement and runtime egress proxy-auth token off
  // stdin (Rust runner writes both lines then closes the pipe). Both fall
  // back to null when the caller provides no stdin, which is fine for the
  // few test/dev paths that hit unauthenticated routes from the host.
  const tokens = await readAuditTokensFromStdin();
  args = {
    ...args,
    notaryToken: tokens.notaryToken,
    proxyAuthToken: tokens.proxyAuthToken,
  };
  // Route Chromium's egress through a loopback relay that injects the runtime
  // egress token as `Proxy-Authorization` on every forwarded CONNECT (see
  // startProxyAuthRelay). This attributes the render's cross-origin subresource
  // CONNECTs (e.g. Google Fonts) to the Space subject instead of
  // `runtime.unknown`, so the per-Space managed allow applies and no mid-build
  // egress card is raised. If the relay cannot start, fail closed with a
  // token-free error rather than handing credentials to Playwright/Chromium.
  let proxyRelay: ProxyAuthRelay | null = null;
  let relayStartFailure: string | null = null;
  // The pre-relay upstream (the Sentinel forward proxy): the observe-mode
  // ledger-failure fallback below restarts the relay against it.
  const upstreamProxyServer = args.proxyServer;
  if (args.proxyServer !== null && args.proxyAuthToken !== null) {
    try {
      proxyRelay = await startProxyAuthRelay(
        args.proxyServer,
        args.proxyAuthUsername ?? "hatch-runtime",
        args.proxyAuthToken,
        // The transport ledger below is the only client of this relay, and it
        // speaks CONNECT exclusively; anything else on the port is another
        // in-cell process reaching for the credential.
        { connectOnly: true },
      );
      args = { ...args, proxyServer: proxyRelay.server, proxyAuthToken: null };
    } catch {
      process.stderr.write(
        `playwright-audit: ${RELAY_START_FAILURE_MARKER}: ${RELAY_START_FAILURE_MESSAGE}\n`,
      );
      proxyRelay = null;
      relayStartFailure = RELAY_START_FAILURE_MESSAGE;
    }
  }
  // Front Chromium with the loopback SOCKS5 transport ledger so every TCP
  // connection the browser process makes is recorded at host:port
  // granularity, chained to the same egress path (the relay injects the
  // credential; the ledger stays token-free). A ledger start failure IS
  // reachable from inside the cell -- a builder can exhaust ephemeral ports or
  // file descriptors before invoking the audit -- and running without it would
  // hand back the pre-lockdown posture (audit-time egress to policy-allowed
  // hosts, mid-build approval prompts) on demand. So it fails the audit closed,
  // exactly like a relay start failure, and the caller retries.
  let transportLedger: TransportLedgerHandle | null = null;
  let ledgerStartFailure: string | null = null;
  if (args.proxyServer !== null && relayStartFailure === null) {
    try {
      // Audit egress lockdown: only the artifact's own daemon origin
      // (exact host AND port) may tunnel out. Every other destination is recorded + refused at the
      // ledger, so the render generates zero Sentinel traffic (and zero
      // approval prompts); the attempts still feed the capture cross-check,
      // the egress screen, and the critique. Viewers' browsers run the
      // published page ungated, so an external fetch denied here is an
      // audit-only condition the result guidance explains to the builder.
      const auditDestination = ledgerDestinationKey(args.url);
      if (auditDestination === null) {
        throw new Error(`audit url has no TCP destination: ${args.url}`);
      }
      // Lockdown only for the audit caller (--egress-lockdown). Preview and
      // inspection captures keep observe-and-forward: enforcement stays with
      // Sentinel upstream exactly as at base, so share-card and thumbnail
      // frames keep their external assets while the ledger still records.
      transportLedger = await startTransportLedger(
        args.proxyServer,
        args.egressLockdown
          ? { allowedDestinations: new Set([auditDestination]) }
          : {},
      );
      args = {
        ...args,
        proxyServer: transportLedger.server,
        transport: transportLedger,
      };
    } catch {
      transportLedger = null;
      if (args.egressLockdown) {
        // Fixed message, like the relay's: this string becomes the report's
        // builder-visible `error`, and the thrown detail can echo the upstream
        // proxy endpoint into it. Fail closed: running the AUDIT without the
        // ledger would hand back the pre-lockdown posture on demand.
        process.stderr.write(
          `playwright-audit: ${LEDGER_START_FAILURE_MARKER}: ${LEDGER_START_FAILURE_MESSAGE}\n`,
        );
        ledgerStartFailure = LEDGER_START_FAILURE_MESSAGE;
      } else {
        // Observe-mode capture (preview/inspection): a missing ledger only
        // loses the transport record — degrade to base behavior, and reopen
        // the relay's origin-form path since Chromium now talks to it
        // directly as its HTTP proxy.
        process.stderr.write(
          "playwright-audit: transport ledger failed to start; continuing unobserved (no lockdown requested)\n",
        );
        if (
          proxyRelay !== null &&
          upstreamProxyServer !== null &&
          tokens.proxyAuthToken !== null
        ) {
          try {
            await proxyRelay.close();
          } catch {
            /* replaced below either way */
          }
          proxyRelay = await startProxyAuthRelay(
            upstreamProxyServer,
            args.proxyAuthUsername ?? "hatch-runtime",
            tokens.proxyAuthToken,
          );
          args = { ...args, proxyServer: proxyRelay.server };
        }
      }
    }
  }
  const startFailure = relayStartFailure ?? ledgerStartFailure;
  let report: AuditReport;
  try {
    if (startFailure !== null) {
      throw new Error(startFailure);
    }
    report = await runAudit(args);
  } catch (err) {
    report = {
      ok: false,
      url: args.url,
      duration_ms: 0,
      output_dir: args.outputDir,
      nav_status: null,
      viewports: {
        desktop: { ...DESKTOP_VIEWPORT, screenshot_path: null, fullpage_screenshot_path: null },
        mobile: { ...MOBILE_VIEWPORT, screenshot_path: null },
      },
      mobile_layout: null,
      horizontal_scrollers: [],
      unreachable_controls: { desktop: [], mobile: [] },
      images: {
        total: 0,
        broken: [],
        duplicate: [],
        unstable: [],
        failed_requests: [],
        external_blocked: { count: 0, sample: [] },
        sample_urls: [],
        verdict: "pass",
      },
      text_issues: [],
      clipped: { desktop: [], mobile: [] },
      console_errors: [],
      console_warnings: [],
      external_fetch_failures: 0,
      external_fetch_failure_samples: [],
      blocked_requests: [],
      external_requests: [],
      external_requests_dropped: 0,
      external_requests_dropped_data_bearing: 0,
      transport_ledger_active: false,
      egress_lockdown: args.egressLockdown,
      transport_connections: [],
      transport_udp_attempts: 0,
      transport_overflow: 0,
      unexplained_transport_hosts: [],
      broken_assets: [],
      blocked_affordances: [],
      aria_snapshot: null,
      interactive_nodes: 0,
      audit_session_id: args.auditSessionId,
      readiness: { desktop: null, mobile: null },
      color_scheme: null,
      error:
        startFailure !== null
          ? startFailure
          : `unexpected: ${(err as Error).message}`,
    };
  } finally {
    if (transportLedger !== null) {
      try {
        await transportLedger.close();
      } catch {
        /* best-effort teardown */
      }
    }
    if (proxyRelay !== null) {
      try {
        await proxyRelay.close();
      } catch {
        /* best-effort teardown */
      }
    }
  }
  const reportPath = join(args.outputDir, "report.json");
  await mkdir(args.outputDir, { recursive: true });
  const reportBytes = JSON.stringify(report, null, 2) + "\n";
  await writeFile(reportPath, reportBytes);
  // The audit dir lives in the builder-writable workspace, so report.json on
  // disk is not by itself an authenticated record of what the harness observed.
  // Print the digest of the exact bytes written on the process's own stdout —
  // a channel the audited page and the builder seat cannot reach — so the
  // daemon can refuse a report that does not hash to it. Emitted BEFORE the
  // report path so the path stays the last stdout line.
  process.stdout.write(
    `report-sha256:${createHash("sha256").update(reportBytes).digest("hex")}\n`,
  );
  process.stdout.write(reportPath + "\n");
  return 0;
}

// Only execute when invoked as a script (e.g. `bun run playwright-audit.js`).
// Without this gate, importing the module from a test runner would fire
// `main()` at import time and `process.exit()` would kill the runner before
// any tests ran.
if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`playwright-audit fatal: ${String(err)}\n`);
      process.exit(1);
    },
  );
}

// Suppress unused warnings on helpers referenced through the export below.
export type { AuditReport, CliArgs, MobileLayoutAudit };
export { dedupeAndSample, parseArgs, parseCaptureMode };
// `classifyImageSource` and `summarizeImages` are exported at their declarations.
