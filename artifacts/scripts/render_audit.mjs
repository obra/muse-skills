#!/usr/bin/env bun
// Render + audit an artifact's HTML source with Playwright, then emit a PDF
// and/or per-page PNGs plus a deterministic JSON report. Replaces the legacy
// `browser goto` / `browser pdf` calls in the artifacts skill so PDF and slide
// deck rendering uses Playwright with the Hatch image-provisioned Chromium.
//
// Browser bring-up and general page diagnostics come from the shared web
// artifact audit runtime. This file adds only document/deck probes and export.
//
// Inputs (CLI flags):
//   --html <abs path>          absolute path to the source index.html (required)
//   --pdf <abs path>           optional; absolute output path for the rendered PDF
//   --png-dir <abs dir>        optional; absolute directory for per-page PNGs
//   --fonts "F:w,F:w,..."      optional; comma-separated Family:weight faces to
//                              gate on. When omitted, the deck's own
//                              `--slide-font-display` / `--slide-font-body`
//                              `:root` values are used, so the gate is armed
//                              even for callers that pass no faces.
//   --require-webfonts         optional; require every expected face to resolve
//                              through a downloaded @font-face. Slide callers
//                              use this so a local Liberation/Noto substitute
//                              cannot satisfy a Google Fonts theme.
//   --page-selector "<css>"    optional; CSS selector matching each page/slide
//                              element. Default: ".slide-container, .page,
//                              section.slide". Overflow checks + PNG screenshots
//                              run over these elements. Console errors, broken
//                              images, and non-2xx sub-resources always fail the
//                              run (`browser_failures` in the report, ok:false),
//                              evaluated at exit so the probes and PNG/PDF
//                              outputs still land.
//   --structure-check          optional; run the slide-deck image checks (cover
//                              hero present, no broken images), the per-slide
//                              canvas-fill measurement, and the authoring-restraint
//                              read. Off by default so the shared PDF/DOCX path is
//                              untouched.
//   --style-plan <abs path>    optional; the deck's `.src/style_plan.json`. Adds
//                              `plan` conformance advisories. A missing file is a
//                              documented state and skips them; a file that does
//                              not parse is an error.
//   --require-fill <pct>       optional; fail a slide whose content stops above
//                              this share of its canvas (default 75 when passed
//                              bare) AND is top-packed rather than centred. A
//                              centred slide is sparse on purpose; a top-packed
//                              one has dead canvas under it.
//   --require-cover-image      optional; make a coverless deck a failure. Off by
//                              default because a brief can forbid synthetic
//                              imagery, and then a coverless deck is correct.
//   --require-generated-imagery optional; fail a deck where the media image tool
//                              generated nothing, counted by the JSON sidecar it
//                              writes rather than by the pixels, which cannot tell
//                              a drawn rectangle from a flat-vector illustration.
//                              Needs --structure-check. Off by default, same
//                              reason as --require-cover-image.
//   --require-restraint        optional; fail a slide carrying eyebrow/kicker
//                              furniture, `text-transform:uppercase`, or positive
//                              letter tracking. Needs --structure-check (that is
//                              what populates `restraint`). Off by default so the
//                              shared PDF/DOCX path and every pre-existing caller
//                              are untouched.
//   --require-geometry         optional; reconcile the EMITTED PDF's page count
//                              and paper size against the authored page boxes.
//                              Sees the page splits `overflow` cannot; why, in
//                              pdf_geometry_gate.mjs.
//   --require-text-floor       optional; fail text rendered below the 8pt
//                              readability floor, and advise when body text
//                              sits mostly below 10pt. Catches the
//                              crush-to-fit resolution of an overflow, which
//                              passes every fit gate; why, in
//                              pdf_text_floor.mjs.
//   --require-image-resolution optional; fail an image rendered wider than
//                              its own pixels (upscaled, blurry on every
//                              surface) and advise below twice its rendered
//                              width (soft in print and on retina). The
//                              150 DPI read-back upsamples low-resolution
//                              images instead of exposing them; why, in
//                              pdf_image_resolution.mjs.
//   --gate                     optional; turn findings into a verdict — sets
//                              `ok:false`, fills `gate_failures`, exits non-zero.
//                              Without it this stays a pure reporter, which is
//                              what every pre-existing caller relies on.
//   --report-out <abs path>    optional; also write the report here. stdout is
//                              lost when the runtime backgrounds a slow exec, so
//                              the verdict needs somewhere durable to live.
//   --hermetic                 optional; render with no network at all. Every
//                              request that is not the document, a `data:` URI or
//                              a file inside the artifact is aborted. For a
//                              client-driven rebuild, where no model reviews the
//                              markup first. A local file OUTSIDE the artifact is
//                              refused with or without this flag.
//
// Output: a single JSON object on stdout:
//   {
//     "ok": true | false,
//     "pdf": "<abs pdf path or empty>",
//     "pages": <count of page-selector elements screenshotted, 0 when no --png-dir>,
//     "pngs": ["<abs png path>", ...],
//     "fonts": {
//       "missing":  ["<face>", ...],   // GATE: requested policy not satisfied
//       "unused":   ["<face>", ...],   // policy satisfied, but no element resolved to it
//       "used":     ["<family actually rasterized>", ...],
//       "expected": ["<face>", ...]    // what the gate checked
//     },
//     "overflow": [ { "index": N, "overflowY_px": N, "overflowX_px": N }, ... ],
//     "cover_no_image": true | false,               // only with --structure-check
//     "broken_images": [ { "index": N, "src_head": "<first chars of src>" }, ... ],  // only with --structure-check
//     "fill": [ { "index": N, "top_gap_pct": N, "v_fill_pct": N, "h_fill_pct": N }, ... ],  // only with --structure-check
//     "restraint": [ { "index": N, "findings": ["<rule broken>", ...] }, ... ],  // only with --structure-check
//     "plan": {                                     // only with a readable --style-plan
//       "missing_slides": ["<id the plan asked for and the deck lacks>", ...],
//       "extra_slides":   ["<id in the deck and not in the plan>", ...]
//     },
//     "geometry": {                                 // only with --require-geometry
//       "failures":   ["<reason>", ...],
//       "advisories": ["<reason>", ...]
//     },
//     "text_floor": [                               // only with --require-text-floor
//       { "index": N, "runs": [ { "pt": N, "chars": N, "max_node_chars": N, "sample": "<head>" }, ... ] }, ...
//     ],
//     "image_resolution": [                         // only with --require-image-resolution
//       { "index": N, "images": [ { "rendered_w": N, "natural_w": N, "src_head": "<head>" }, ... ] }, ...
//     ],
//     "blocked_requests": { "local": ["<url>", ...], "remote": N },  // only when something was refused
//     "gate_failures": ["<reason>", ...],           // only with --gate; non-empty => ok:false
//     "advisories": ["<reason>", ...],              // only with --gate; never gates
//     "error": "<populated only when ok=false>"
//   }
// All diagnostics go to stderr. The process exits non-zero on a hard failure
// (browser not found, playwright unresolvable, goto failed) after writing a
// `{ ok:false, error }` line to stdout, so the caller can both branch on the
// exit code and parse the reason.
//
// Runtime provisioning (BOTH must be present on the VM):
//   - The Spaces bundle provides the shared browser-audit runtime and its
//     external Playwright package under `skills/spaces/ts-runtime/dist/`.
//   - Browser discovery, launch hardening, diagnostics, and proxy attribution
//     come from that shared runtime; this file owns only artifact rendering.

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadBrowserAuditRuntime } from "./browser_audit_runtime.mjs";
import { fileUrlWithinRoots, realRootsFor } from "./deck_asset_scope.mjs";
import { probePdfFacts } from "./pdf_geometry_probe.mjs";
import { evaluatePdfGeometry } from "./pdf_geometry_gate.mjs";
import { evaluateTextFloor } from "./pdf_text_floor.mjs";
import { evaluateImageResolution } from "./pdf_image_resolution.mjs";

// --- Constants -------------------------------------------------------------

const DEFAULT_PAGE_SELECTOR = ".slide-container, .page, section.slide";

// Default `--require-fill`. Separates two prod decks built from the same prompt:
// a rejected one at 66.7% median fill (13/16 slides under 70%, worst 48.1%) from
// an accepted one at 83.3%, without flagging a sparse statement or closing slide.
const DEFAULT_REQUIRE_FILL_PCT = 75;

// Page-load + settle budgets. file:// loads are local so these are generous.
const PAGE_LOAD_TIMEOUT_MS = 30_000;
// document.fonts.ready can hang if a font face never resolves; cap the wait.
const FONTS_READY_TIMEOUT_MS = 10_000;
// Small settle so Chart.js (and any other rAF-driven canvas paint) finishes
// before we screenshot. Mirrors the "small settle for Chart.js" requirement.
const CHART_SETTLE_MS = 600;

// 16:9 slide canvas (1280x720 px at 96dpi) / 13.333in x 7.5in. Used as the
// render viewport size only; overflow is measured per element against its own
// client box (see probeOverflow), not against this fixed canvas.
const PAGE_BOX_PX = { width: 1280, height: 720 };

// Every option handed to Chromium's PDF export, named rather than inlined so
// the render configuration is one reviewable value instead of an argument
// literal buried in the export call.
const PDF_EXPORT_OPTIONS = {
  preferCSSPageSize: true,
  printBackground: true,
  // Emit a structure tree. Without it a PDF has no reading order and no
  // accessibility surface: a screen reader gets glyph positions, not
  // headings, lists, and table cells. Resumes are the sharpest case (the
  // artifacts skill asks for "logical reading order" on ATS resumes and
  // nothing was producing it), but it costs nothing on any document.
  tagged: true,
  // Emit bookmarks from the heading structure. Multi-section documents were
  // shipping with a hand-authored table of contents on page one and no
  // navigable outline behind it.
  outline: true,
};

// --- Arg parsing -----------------------------------------------------------

// Every flag this script reads. Used only to warn on an unrecognized one:
// a misspelled `--require-geomtry` is silently ignored, and the render then
// exits 0 looking exactly like a gated pass, which is the silent-disarm shape
// this gate exists to close. Warn rather than reject, because unknown-key
// tolerance predates this script's current callers.
const KNOWN_FLAGS = new Set([
  "html", "pdf", "png-dir", "fonts", "require-webfonts", "page-selector",
  "structure-check", "style-plan", "require-fill", "require-cover-image",
  "require-generated-imagery",
  "require-restraint", "require-geometry", "require-text-floor",
  "require-image-resolution", "gate", "report-out", "hermetic",
]);

// The directories the rendered document may read a local file from: its own
// directory, plus the artifact root when it sits in `.src/`, so a page can still
// reach a sibling under `.src/media/` or a file promoted to the slug root.
function artifactAssetRoots(html) {
  const own = dirname(html);
  return basename(own) === ".src" ? [own, dirname(own)] : [own];
}

function parseArgs(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    // Space-separated form: --flag value
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, "");
    }
  }
  for (const key of map.keys()) {
    if (!KNOWN_FLAGS.has(key)) {
      process.stderr.write(
        `render_audit: unknown flag --${key} ignored; check the spelling before trusting this run\n`,
      );
    }
  }
  const html = (map.get("html") ?? "").trim();
  const pdf = (map.get("pdf") ?? "").trim();
  const pngDir = (map.get("png-dir") ?? "").trim();
  if (!html || (!pdf && !pngDir)) {
    throw new Error(
      "render_audit: --html and at least one of --pdf or --png-dir are required (all absolute paths)",
    );
  }
  // Geometry is measured off the emitted PDF, so without --pdf the flag has
  // nothing to read and would otherwise pass silently, which reads as a gated
  // run that found nothing.
  if (map.has("require-geometry") && !pdf) {
    throw new Error(
      "render_audit: --require-geometry measures the emitted PDF and needs --pdf",
    );
  }
  // Image widths are meaningful only at the paper width the PDF is set at,
  // which is read back from the emitted file; same guard shape as geometry.
  if (map.has("require-image-resolution") && !pdf) {
    throw new Error(
      "render_audit: --require-image-resolution measures at the emitted PDF's paper width and needs --pdf",
    );
  }
  // Same shape as the geometry guard above: the restraint gate reads a probe
  // that only runs under --structure-check, so on its own the flag would exit 0
  // on a deck full of tracked all-caps eyebrows and read as a gated run.
  if (map.has("require-restraint") && !map.has("structure-check")) {
    throw new Error(
      "render_audit: --require-restraint reads the restraint probe and needs --structure-check",
    );
  }
  // Same shape again: the imagery check reads `generated_imagery`, which only the
  // structure block populates, so alone the flag would exit 0 on a deck of
  // hand-drawn rectangles and read as a gated run.
  if (map.has("require-generated-imagery") && !map.has("structure-check")) {
    throw new Error(
      "render_audit: --require-generated-imagery reads the imagery probe and needs --structure-check",
    );
  }
  const pageSelector = (map.get("page-selector") ?? "").trim() || DEFAULT_PAGE_SELECTOR;
  const fontsRaw = (map.get("fonts") ?? "").trim();
  const fonts = parseFonts(fontsRaw);
  const requireWebfonts = map.has("require-webfonts");
  // Opt-in; emitted only under the flag so the shared PDF/DOCX path and the
  // native artifact report parser never see the extra fields (see probeStructure).
  const structureCheck = map.has("structure-check");
  const stylePlan = (map.get("style-plan") ?? "").trim();
  const reportOut = (map.get("report-out") ?? "").trim();
  // Bare `--require-fill` means "use the default threshold"; a value overrides it.
  // Anything unparseable is a caller error, not a silently-disabled gate.
  let requireFillPct = null;
  if (map.has("require-fill")) {
    const raw = (map.get("require-fill") ?? "").trim();
    if (raw === "") {
      requireFillPct = DEFAULT_REQUIRE_FILL_PCT;
    } else {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        throw new Error(`render_audit: --require-fill expects 0-100, got '${raw}'`);
      }
      requireFillPct = parsed;
    }
  }
  return {
    html,
    pdf,
    pngDir,
    pageSelector,
    fonts,
    requireWebfonts,
    structureCheck,
    stylePlan,
    reportOut,
    requireFillPct,
    requireCoverImage: map.has("require-cover-image"),
    requireGeneratedImagery: map.has("require-generated-imagery"),
    requireRestraint: map.has("require-restraint"),
    // Measure the emitted PDF's geometry (page-box fit, pagination match,
    // blank pages). Opt-in like the deck checks so every pre-existing caller
    // is untouched.
    requireGeometry: map.has("require-geometry"),
    // Fail unreadably small text (the crush-to-fit overflow resolution).
    // Opt-in for the same reason, and so the native artifact report parser
    // never sees the extra field.
    requireTextFloor: map.has("require-text-floor"),
    // Fail upscaled images (the blurry-hero class the read-back cannot
    // expose). Same opt-in discipline.
    requireImageResolution: map.has("require-image-resolution"),
    gate: map.has("gate"),
    // Render with no network at all: abort every request that is not the document
    // itself, a `data:` URI, or a file inside the artifact's own directory. For a
    // client-driven rebuild, where no model reviews the markup before it renders.
    // Opt-in, because a document that legitimately hotlinks an image would lose it
    // (an aborted <img> reads as `broken_images`, since it really did not decode).
    // The local half of this containment is NOT opt-in; see runAudit.
    hermetic: map.has("hermetic"),
  };
}

// "Inter:600,Inter:400,Space Grotesk:700" -> [{family:"Inter",weight:"600"},...]
function parseFonts(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0) {
      // No weight given — default to 400.
      out.push({ family: trimmed, weight: "400" });
      continue;
    }
    const family = trimmed.slice(0, colon).trim();
    const weight = trimmed.slice(colon + 1).trim() || "400";
    if (family) out.push({ family, weight });
  }
  return out;
}

// Parse the runtime egress proxy from the environment: the proxy server URL
// (credentials stripped) and the basic-auth username/token if present. Returns
// null when no proxy is configured.
function parseProxyConfig() {
  const rawProxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (typeof rawProxyUrl !== "string" || rawProxyUrl.trim().length === 0) {
    return null;
  }
  const raw = rawProxyUrl.trim();
  let username;
  let token;
  const credsMatch = raw.match(/^https?:\/\/([^@/]+)@/);
  if (credsMatch) {
    const [rawUser, ...rest] = credsMatch[1].split(":");
    username = decodeURIComponent(rawUser);
    token = rest.length > 0 ? decodeURIComponent(rest.join(":")) : undefined;
  }
  const server = raw.replace(/^(https?:\/\/)[^@]*@/, "$1");
  return { server, username, token };
}

// Token-free marker emitted when the relay cannot reach the Sentinel proxy at
// all. The exec runner uses it to distinguish transport failure from policy.
const RELAY_TRANSPORT_FAILURE_MARKER = "hatch-egress-relay-transport-failure";
const RELAY_START_FAILURE_MARKER = "hatch-egress-relay-start-failure";
const RELAY_START_FAILURE_MESSAGE =
  "proxy-auth relay failed to start; refusing to pass egress token to Chromium";

// The shared audit's relay does not emit the transport marker consumed by the
// exec runner, so this renderer keeps its marker-aware relay local.
function startProxyAuthRelay(upstreamProxyUrl, username, token) {
  const upstream = new URL(upstreamProxyUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`unsupported proxy protocol: ${upstream.protocol}`);
  }
  const upstreamIsHttps = upstream.protocol === "https:";
  const upstreamHost = upstream.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const upstreamPort =
    upstream.port.length > 0 ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;
  const upstreamRequest = upstreamIsHttps ? httpsRequest : httpRequest;
  const credential = "Basic " + Buffer.from(`${username}:${token}`).toString("base64");

  const server = createServer((clientReq, clientRes) => {
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
    upstreamReq.on("error", (err) => {
      process.stderr.write(
        `render_audit: ${RELAY_TRANSPORT_FAILURE_MARKER}: proxy unreachable: ${String(err)}\n`,
      );
      try {
        clientRes.writeHead(502);
        clientRes.end();
      } catch {
        /* client already gone */
      }
    });
    clientReq.pipe(upstreamReq);
  });

  const sockets = new Set();
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
    const teardown = () => {
      sockets.delete(clientSocket);
      sockets.delete(upstreamSocket);
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
    upstreamSocket.on("close", teardown);
    clientSocket.pause();
    let established = false;
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      if (established) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.indexOf("\r\n\r\n") === -1) return;
      established = true;
      upstreamSocket.removeListener("data", onData);
      const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
      clientSocket.write(buffer);
      if (statusLine.split(/\s+/)[1] === "200") {
        if (head.length > 0) upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      } else {
        clientSocket.end();
        upstreamSocket.end();
      }
    };
    upstreamSocket.on("data", onData);
    upstreamSocket.on("error", (err) => {
      if (!established) {
        process.stderr.write(
          `render_audit: ${RELAY_TRANSPORT_FAILURE_MARKER}: proxy unreachable: ${String(err)}\n`,
        );
        try {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          /* client already gone */
        }
      }
      teardown();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      resolve({
        server: `http://[::1]:${port}`,
        close: () =>
          new Promise((res) => {
            for (const socket of [...sockets]) socket.destroy();
            sockets.clear();
            server.close(() => res());
          }),
      });
    });
  });
}

// --- Page probes (page.evaluate, plus CDP where the DOM cannot answer) -----

// Normalize a CSS family token for comparison: strip quotes, collapse inner
// whitespace, lowercase. `"Plus Jakarta Sans"` and `Plus  Jakarta  Sans` are the
// same family.
function normalizeFamily(raw) {
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const CSS_GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
]);

function weightNumber(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === "normal") return 400;
  if (value === "bold") return 700;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// FontFace.weight is either one weight ("400") or a variable-font range
// ("100 900"). Keep the CLI's Family:weight contract real instead of silently
// reducing it to a family-only check.
function weightDescriptorIncludes(descriptor, requested) {
  if (!String(requested ?? "").trim()) return true;
  const wanted = weightNumber(requested);
  if (wanted === null) return false;
  const values = String(descriptor)
    .trim()
    .split(/\s+/)
    .map(weightNumber)
    .filter((value) => value !== null);
  if (values.length === 1) return values[0] === wanted;
  if (values.length === 2) return wanted >= values[0] && wanted <= values[1];
  return false;
}

function fontUsageKey(font) {
  return [font.familyName, font.postScriptName, String(font.isCustomFont)].join("\u0000");
}

function normalizePlatformFont(font) {
  return {
    familyName: String(font.familyName ?? "").trim(),
    postScriptName: String(font.postScriptName ?? "").trim(),
    isCustomFont: font.isCustomFont === true,
    glyphCount: Number(font.glyphCount ?? 0),
  };
}

// The families the deck itself declares, read off `:root`. Used as the gate's
// expected set when the caller passes no --fonts, so the native artifact build
// path (which passes none) is still gated. Only the FIRST family of each var is
// taken: that is the theme face, and anything after it is by definition a
// fallback we do not want to bless.
async function probeThemeFamilies(page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return ["--slide-font-display", "--slide-font-body"]
      .map((name) => root.getPropertyValue(name).split(",")[0].trim())
      .filter(Boolean);
  });
}

// `document.fonts.check()` and computed font-family both stay green when the
// requested face silently falls back. CDP reports what Chromium rasterized.
async function openUsedFontProbe(context, page, selector) {
  const session = await context.newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1 });
    const matched = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector,
    });
    let nodeIds = matched.nodeIds ?? [];
    let scopeSelector = selector;
    if (nodeIds.length === 0) {
      const body = await session.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "body",
      });
      if (body.nodeId) nodeIds = [body.nodeId];
      scopeSelector = "body";
    }
    // CDP reports glyphs painted directly by the queried element, not an
    // aggregate for its whole subtree. Slide containers normally hold their
    // text in descendant headings, paragraphs, and spans, so querying only the
    // container can return an empty list for a visibly populated slide.
    const usageNodeIds = new Set(nodeIds);
    for (const nodeId of nodeIds) {
      const descendants = await session.send("DOM.querySelectorAll", {
        nodeId,
        selector: "*",
      });
      for (const descendantId of descendants.nodeIds ?? []) {
        usageNodeIds.add(descendantId);
      }
    }

    const usageByFace = new Map();
    for (const nodeId of usageNodeIds) {
      const platform = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const font of platform.fonts ?? []) {
        const normalized = normalizePlatformFont(font);
        if (!normalized.familyName) continue;
        const key = fontUsageKey(normalized);
        const previous = usageByFace.get(key);
        normalized.glyphCount += previous?.glyphCount ?? 0;
        usageByFace.set(key, normalized);
      }
    }
    const hasText = await page.evaluate((sel) =>
      Array.from(document.querySelectorAll(sel)).some((node) =>
        String(node.innerText ?? "").trim().length > 0), scopeSelector);
    if (hasText && usageByFace.size === 0) {
      throw new Error("CDP returned no platform fonts for rendered text");
    }
    return {
      session,
      rootNodeId: root.nodeId,
      usages: [...usageByFace.values()].sort((a, b) => b.glyphCount - a.glyphCount),
    };
  } catch (err) {
    await session.detach().catch(() => {});
    throw err;
  }
}

// Resolve one CSS family+weight to Chromium's exact platform identity by
// rendering a small off-canvas probe. This learns aliases such as CSS `DM Sans`
// -> platform `DM Sans 9pt` without accepting unrelated prefix families such as
// `Roboto Condensed` for `Roboto`.
async function resolveExpectedFace(page, fontProbe, face, index, requireWebfonts) {
  const probeId = `hatch-font-probe-${index}`;
  const declaredFaces = await page.evaluate(async ({
    family,
    weight,
    probeIdIn,
    offsetY,
    timeoutMs,
  }) => {
    const spec = `${weight || "400"} 16px "${family.replaceAll('"', '\\"')}"`;
    await Promise.race([
      document.fonts.load(spec, "Hatch Font Probe 0123").catch(() => []),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(
          `font load timed out after ${timeoutMs}ms: ${family}:${weight || "400"}`,
        )),
        timeoutMs,
      )),
    ]);
    const normalize = (value) => String(value)
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    const entries = [];
    document.fonts.forEach((font) => {
      if (normalize(font.family) === normalize(family)) {
        entries.push({ weight: String(font.weight), status: String(font.status) });
      }
    });
    const span = document.createElement("span");
    span.id = probeIdIn;
    Object.assign(span.style, {
      position: "fixed",
      left: "-10000px",
      top: `${offsetY}px`,
      fontFamily: `"${family.replaceAll('"', '\\"')}"`,
      fontWeight: weight || "400",
      fontSize: "16px",
    });
    span.textContent = "Hatch Font Probe 0123";
    document.body.appendChild(span);
    // A newly inserted second probe can otherwise have no recorded glyphs yet.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return entries;
  }, {
    family: face.family,
    weight: face.weight,
    probeIdIn: probeId,
    offsetY: index * 24,
    timeoutMs: FONTS_READY_TIMEOUT_MS,
  });

  const probeNode = await fontProbe.session.send("DOM.querySelector", {
    nodeId: fontProbe.rootNodeId,
    selector: `#${probeId}`,
  });
  if (!probeNode.nodeId) throw new Error(`could not inspect font probe for ${face.family}`);
  const platform = await fontProbe.session.send("CSS.getPlatformFontsForNode", {
    nodeId: probeNode.nodeId,
  });
  const aliases = (platform.fonts ?? [])
    .map(normalizePlatformFont)
    .filter((font) => font.familyName);
  await page.evaluate((id) => document.getElementById(id)?.remove(), probeId);

  const declaredWeightLoaded = declaredFaces.some((entry) =>
    weightDescriptorIncludes(entry.weight, face.weight) && entry.status === "loaded");
  const customResolved = declaredWeightLoaded && aliases.some((font) => font.isCustomFont);
  const localResolved = !requireWebfonts && aliases.some((font) =>
    !font.isCustomFont && normalizeFamily(font.familyName) === normalizeFamily(face.family));
  const available = customResolved || localResolved;
  const actualKeys = new Set(fontProbe.usages.map(fontUsageKey));
  const rendered = face.weight
    ? aliases.some((alias) => actualKeys.has(fontUsageKey(alias)))
    : aliases.some((alias) => fontProbe.usages.some((used) =>
        normalizeFamily(used.familyName) === normalizeFamily(alias.familyName)
        && used.isCustomFont === alias.isCustomFont));

  return { available, rendered };
}

// Returns [{index, overflowY_px, overflowX_px}, ...] for any page-selector
// element whose content overflows its own client box.
async function probeOverflow(page, selector) {
  return page.evaluate(
    (sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      const overflows = [];
      els.forEach((el, index) => {
        const scrollH = el.scrollHeight;
        const scrollW = el.scrollWidth;
        const clientH = el.clientHeight;
        const clientW = el.clientWidth;
        // Overflow = content spilling past the element's OWN box
        // (scrollHeight > clientHeight). A fixed-height / overflow:hidden slide
        // that overflows reports the spill; a flowing page (height:auto) grows
        // to fit its content so scrollH == clientH and reports zero — so
        // paginated/A4 PDFs do NOT false-positive (a hard-coded 1280x720
        // reference box made every taller-than-720 page look overflowing).
        const overflowY = Math.max(0, scrollH - clientH);
        const overflowX = Math.max(0, scrollW - clientW);
        // Allow 1px of sub-pixel rounding slack.
        if (overflowY > 1 || overflowX > 1) {
          overflows.push({
            index,
            overflowY_px: Math.round(overflowY),
            overflowX_px: Math.round(overflowX),
          });
        }
      });
      return overflows;
    },
    selector,
  );
}

// Slide-deck image checks (only run with --structure-check), mirroring
// probeOverflow's slide-selector iteration. Returns:
//   cover_no_image: the first slide has no decoded <img> and no data:image
//     background — a text/flat/gradient cover.
//   broken_images: [{index, src_head}] for an <img> that did not decode
//     (naturalWidth 0), e.g. a src holding the generate_image tool's JSON result
//     instead of the image file.
// Prose alone did not prevent these on the VM (the builder skips or mis-embeds
// the image); clearing them requires real, decoded images.
async function probeStructure(page, selector) {
  return page.evaluate((sel) => {
    const slides = Array.from(document.querySelectorAll(sel));
    const hasImage = (root) =>
      Array.from(root.querySelectorAll("img")).some((i) => i.complete && i.naturalWidth > 0) ||
      [root, ...root.querySelectorAll("*")].some((el) =>
        (getComputedStyle(el).backgroundImage || "").includes("data:image"));
    const broken_images = [];
    slides.forEach((slide, index) => {
      slide.querySelectorAll("img").forEach((img) => {
        if (img.complete && img.naturalWidth === 0) {
          broken_images.push({ index, src_head: (img.getAttribute("src") || "").slice(0, 24) });
        }
      });
    });
    return { cover_no_image: slides.length > 0 && !hasImage(slides[0]), broken_images };
  }, selector);
}

// Deck imagery by provenance instead of pixels, read off disk rather than the page.
//
// A rectangle drawn with PIL is valid image bytes, so it decodes and clears both
// checks above; a prod deck shipped two that way. Pixels cannot separate them
// either, since `image-directive.md` approves flat vector as an art direction.
// `media.generate_image` writes a JSON sidecar next to its output and drawing
// cannot fake one, so the sidecar is the provenance marker.
//
// Counting sidecars alone would NOT work. media-generation's `client.rs` calls
// `write_payload_to_disk` before it downloads anything and without inspecting the
// result, so a refused or empty generation leaves a sidecar with no image behind
// it. A refusal is the most likely reason a builder starts drawing rectangles, so
// a bare count would pass exactly the deck this exists to fail. The payload's
// `attachments` array is what carries the returned media, so a sidecar counts only
// when it has one.
//
// Everything without a sidecar is `drawn`: a chart, a sourced photo, a hand-made
// placeholder. Reported for the failure message, never counted, and provenance
// genuinely cannot tell a sourced photo from a drawn one.
async function probeGeneratedImagery(html) {
  // `--html` is the deck's `.src/index.html`, so media is its sibling. Absent means
  // no imagery, which is a real state rather than an error.
  const mediaDir = join(dirname(html), "media");
  let entries = [];
  try {
    entries = await readdir(mediaDir);
  } catch { /* no media directory */ }
  let generated = 0;
  for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
    try {
      const payload = JSON.parse(await readFile(join(mediaDir, name), "utf8"));
      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) generated += 1;
    } catch { /* unreadable or non-JSON: not evidence of a generated image */ }
  }
  const images = entries.filter((name) => /\.(webp|png|jpe?g|gif)$/i.test(name)).length;
  return { generated, drawn: Math.max(0, images - generated) };
}

// Slide authoring restraint (only with --structure-check). Three rules from
// `authoring.md` that prose alone does not hold: no eyebrow/kicker furniture
// (:36-37), sentence case, and no letter tracking (:77-78). Measured over 176
// prod deck-building turns in 7 days, with the rules in scope the whole time:
// furniture 35.8%, `text-transform:uppercase` 36.9%, positive tracking 52.8%.
//
// Read from COMPUTED STYLE, not from the source text. Computed style catches the
// property whatever selector path applied it, and it cannot be fooled by a deck
// that restates the rule in a CSS comment (a compliant deck writes
// "/* No pills, no badges, no eyebrows */" into its own deck.css, and a
// source-text grep scores that as the violation).
//
// Reports at most one finding per rule per slide, so a 6-slide deck with an
// eyebrow on every slide reads as 6 findings rather than 60.
async function probeRestraint(page, selector) {
  return page.evaluate((sel) => {
    // Furniture is named by a class token's HEAD, not by the word appearing
    // anywhere in it. Matching anywhere failed a valid deck that used
    // `<div class="kicker-title">` as the grid wrapper around its heading, with
    // no kicker on the slide at all; the gate then made that deck unshippable.
    // Three shapes, because CSS names the head in three places:
    //   head-final compound  `stat-chip` IS a chip      -> flag
    //                        `kicker-title` IS a title  -> pass
    //   BEM block            `chip--small`, `chip__text` are still a chip
    //   modified head        `badge-sm`, `pill-2` are still a badge and a pill
    // Only a modifier tail licenses the head-initial read, so `kicker-title`
    // stays passing: `title` is a noun, not a size or an index.
    const FURNITURE = /^(kicker|eyebrow|pill|badge|chip|tag)$/i;
    const MODIFIER =
      /^(xs|sm|md|lg|xl|small|medium|large|alt|primary|secondary|dark|light|outline|solid|\d+)$/i;
    const isHead = (piece) => {
      const parts = piece.split(/[-_]/).filter(Boolean);
      if (parts.length === 0) return false;
      if (FURNITURE.test(parts[parts.length - 1])) return true;
      return FURNITURE.test(parts[0]) && parts.slice(1).every((p) => MODIFIER.test(p));
    };
    // Test every BEM piece, not just the block: the furniture noun sits on the
    // block in `chip--small` but on the element in `slide__kicker`.
    const isFurniture = (cls) =>
      cls.split(/\s+/).some((token) => token.split(/--|__/).filter(Boolean).some(isHead));
    // Computed letter-spacing is px. The rule bans letter-spacing outright, but
    // gating that literally would fail the 63% of decks using `-0.01em` optical
    // tightening on display type, which is not the defect. Gate the tracked-caps
    // case: positive, and past half a pixel (`0.08em` at 12px is 0.96px).
    const TRACK_PX = 0.5;
    const out = [];
    Array.from(document.querySelectorAll(sel)).forEach((slide, index) => {
      const findings = [];
      const seen = new Set();
      const add = (key, msg) => {
        if (!seen.has(key)) { seen.add(key); findings.push(msg); }
      };
      for (const el of slide.querySelectorAll("*")) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const cls = (el.getAttribute("class") || "").trim();
        if (cls && isFurniture(cls)) {
          add("furniture", `furniture class "${cls.slice(0, 40)}"`);
        }
        // Type rules apply to the element that actually holds the text, so a
        // wrapper does not report on behalf of its children.
        const own = Array.from(el.childNodes)
          .some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const text = (el.textContent || "").trim().slice(0, 24);
        if (style.textTransform === "uppercase") {
          add("uppercase", `text-transform:uppercase on "${text}"`);
        }
        const spacing = Number.parseFloat(style.letterSpacing);
        if (Number.isFinite(spacing) && spacing > TRACK_PX) {
          add("tracking", `letter-spacing ${style.letterSpacing} on "${text}"`);
        }
      }
      if (findings.length > 0) out.push({ index, findings });
    });
    return out;
  }, selector);
}

// The inverse of probeOverflow: how far each page element's content reaches
// inside its own box. Overflow catches content spilling PAST the canvas; only
// that direction was measured, so a deck whose slides stop half-way down (a
// fixed-height flex column with no vertical distribution) passed every check —
// valid HTML, fonts resolved, nothing overflowing.
//
// Measure INK, not element boxes. Unioning every descendant rect made a layout
// wrapper that paints nothing count as content, and the builder writes one on
// nearly every slide (`.slide-inner{width:100%;height:100%}`), so a top-packed
// slide reported 0/100 and the gate could never fire. What a reader actually
// sees is text, replaced elements, and anything carrying a background or border;
// a wrapper that only positions its children is not ink.
//
// A painted full-bleed surface (a cover photo, a gradient panel) legitimately
// reads as full. That is intended: the gate exists to catch dead space, and a
// deliberately false failure costs the user the whole deck.
//
// A flowing page (`height:auto`) grows to fit its content and so reports ~100 by
// construction, the same reason probeOverflow does not false-positive there.
async function probeFill(page, selector) {
  return page.evaluate((sel) => {
    const INK_TAGS = new Set(["IMG", "SVG", "CANVAS", "VIDEO"]);
    const opaque = (color) =>
      color !== "" && color !== "transparent"
      && !/^rgba\(.*,\s*0(?:\.0+)?\)$/.test(color);
    const paints = (style) =>
      style.visibility !== "hidden" && style.display !== "none"
      && Number.parseFloat(style.opacity || "1") > 0.01;
    // Does this element put its own marks on the slide, or does it only
    // position its children?
    const marksInk = (node, style) =>
      INK_TAGS.has(node.tagName.toUpperCase())
      || style.backgroundImage !== "none"
      || opaque(style.backgroundColor)
      || ["Top", "Right", "Bottom", "Left"].some(
        (side) => Number.parseFloat(style[`border${side}Width`]) > 0
          && opaque(style[`border${side}Color`]),
      );

    const els = Array.from(document.querySelectorAll(sel));
    return els.map((el, index) => {
      const box = el.getBoundingClientRect();
      if (box.height <= 0 || box.width <= 0) {
        return { index, top_gap_pct: 0, v_fill_pct: 100, h_fill_pct: 100 };
      }
      // Descendants only, clamped to the slide's box: the element's own
      // background is not content, and `overflow:hidden` means a child bleeding
      // past the edge is not visible ink either.
      let top = box.bottom;
      let bottom = box.top;
      let right = box.left;
      const add = (r) => {
        if (r.width <= 0 || r.height <= 0) return;
        top = Math.min(top, Math.max(r.top, box.top));
        bottom = Math.max(bottom, Math.min(r.bottom, box.bottom));
        right = Math.max(right, Math.min(r.right, box.right));
      };
      const walker = document.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          // Where the glyphs land, not where their container was allowed to
          // stretch. A hidden ancestor leaves no client rects to add.
          if (node.nodeValue.trim() === "") continue;
          const parent = node.parentElement;
          if (parent === null || !paints(getComputedStyle(parent))) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) add(r);
          continue;
        }
        const style = getComputedStyle(node);
        if (paints(style) && marksInk(node, style)) add(node.getBoundingClientRect());
      }
      const pct = (edge, start, size) =>
        Math.max(0, Math.min(100, Math.round(((edge - start) / size) * 100)));
      return {
        index,
        top_gap_pct: pct(top, box.top, box.height),
        v_fill_pct: pct(bottom, box.top, box.height),
        h_fill_pct: pct(right, box.left, box.width),
      };
    });
  }, selector);
}

// Text sizes as the PDF renders them (only with --require-text-floor):
// per page-selector element, every visible text run aggregated by computed
// font size. Measured under PRINT media, because that is the stylesheet the
// PDF is set from, and restored to screen afterwards like the geometry
// measurement. The verdict half lives in pdf_text_floor.mjs; this probe only
// collects.
async function probeTextFloor(page, selector) {
  try {
    await page.emulateMedia({ media: "print" });
  } catch {
    // An older driver still measures, just under screen media.
  }
  try {
    return await page.evaluate((sel) => {
      let scopes = Array.from(document.querySelectorAll(sel));
      if (scopes.length === 0 && document.body) scopes = [document.body];
      const paints = (style) =>
        style.visibility !== "hidden" && style.display !== "none"
        && Number.parseFloat(style.opacity || "1") > 0.01;
      return scopes.map((scope, index) => {
        const bySize = new Map();
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const glyphs = (node.nodeValue || "").replace(/\s+/g, "");
          if (glyphs.length === 0) continue;
          const parent = node.parentElement;
          if (parent === null) continue;
          const style = getComputedStyle(parent);
          if (!paints(style)) continue;
          // Glyphs that never land on the page (a hidden ancestor, a
          // zero-area box) leave no client rects and do not count.
          const range = document.createRange();
          range.selectNodeContents(node);
          const laid = Array.from(range.getClientRects())
            .some((r) => r.width > 0 && r.height > 0);
          if (!laid) continue;
          const px = Number.parseFloat(style.fontSize);
          if (!Number.isFinite(px)) continue;
          const pt = Math.round(px * (72 / 96) * 10) / 10;
          const entry = bySize.get(pt) ?? { pt, chars: 0, max_node_chars: 0, sample: "" };
          entry.chars += glyphs.length;
          // The largest single node is what the gate reads: three separate
          // one-glyph markers must not aggregate into a gateable run.
          entry.max_node_chars = Math.max(entry.max_node_chars, glyphs.length);
          if (entry.sample === "") {
            entry.sample = (node.nodeValue || "").trim().slice(0, 40);
          }
          bySize.set(pt, entry);
        }
        // Smallest first (they are what the gate reads), bounded so a
        // pathological stylesheet cannot flood the report.
        const runs = [...bySize.values()].sort((a, b) => a.pt - b.pt).slice(0, 40);
        return { index, runs };
      });
    }, selector);
  } finally {
    // Clear the emulation rather than forcing screen: this probe runs
    // BEFORE page.pdf(), and Chromium honors a lingering screen override
    // in the export, silently rendering the PDF under screen CSS.
    await page.emulateMedia({ media: null }).catch(() => {});
  }
}

// Image effective resolution (only with --require-image-resolution): per
// page-selector element, every decoded content image's rendered CSS width
// beside its embedded bitmap width. Covers <img> elements and data:-URI
// CSS backgrounds (the full-bleed cover recipe), measured under PRINT
// media like the text floor. The verdict half lives in
// pdf_image_resolution.mjs; this probe only collects.
async function probeImageResolution(page, selector, paperWidthPx) {
  const viewport = page.viewportSize() || PAGE_BOX_PX;
  try {
    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({ width: paperWidthPx, height: viewport.height });
  } catch {
    // An older driver still measures, just under screen media.
  }
  try {
    return await page.evaluate(async (sel) => {
      let scopes = Array.from(document.querySelectorAll(sel));
      if (scopes.length === 0 && document.body) scopes = [document.body];
      const out = [];
      for (let index = 0; index < scopes.length; index += 1) {
        const scope = scopes[index];
        const images = [];
        // Measure the PAINTED width, not the layout box: with the baseline
        // object-fit: contain + max-height CSS a tall photo letterboxes,
        // painting narrower than its box, and judging against the box
        // flags a sharp portrait as upscaled. contain paints at
        // min(box, height-fitted width); cover crops, so the pixels that
        // survive across the box width are naturalWidth scaled by the
        // smaller axis ratio.
        for (const img of scope.querySelectorAll("img")) {
          const rect = img.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) continue;
          const aspect = img.naturalWidth / img.naturalHeight;
          const fit = getComputedStyle(img).objectFit || "fill";
          let paintedW = rect.width;
          if (fit === "contain" || fit === "scale-down" || fit === "none") {
            paintedW = Math.min(rect.width, rect.height * aspect);
          } else if (fit === "cover") {
            paintedW = Math.max(rect.width, rect.height * aspect);
          }
          if (paintedW <= 0) continue;
          images.push({
            rendered_w: Math.round(paintedW * 10) / 10,
            natural_w: img.naturalWidth,
            src_head: (img.getAttribute("src") || "").slice(0, 40),
          });
        }
        // data:-URI backgrounds: decode each through an off-DOM Image to
        // learn the bitmap size. Bounded per scope; remote URLs are
        // already banned by the pdf source rules, so only data: is read.
        const seen = [scope, ...scope.querySelectorAll("*")];
        let decoded = 0;
        for (const el of seen) {
          if (decoded >= 12) break;
          const bg = getComputedStyle(el).backgroundImage || "";
          const match = bg.match(/url\("?(data:image[^")]+)"?\)/);
          if (!match) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0) continue;
          decoded += 1;
          const dims = await new Promise((resolve) => {
            const probe = new Image();
            probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
            probe.onerror = () => resolve(null);
            probe.src = match[1];
          });
          if (dims && dims.w > 0 && dims.h > 0) {
            // Same painted-width correction as <img>: background-size
            // contain letterboxes and cover crops.
            const size = getComputedStyle(el).backgroundSize || "auto";
            const aspect = dims.w / dims.h;
            let paintedW = rect.width;
            if (size === "contain") {
              paintedW = Math.min(rect.width, rect.height * aspect);
            } else if (size === "cover") {
              paintedW = Math.max(rect.width, rect.height * aspect);
            } else if (size === "auto" || size === "auto auto") {
              paintedW = Math.min(rect.width, dims.w);
            }
            if (paintedW > 0) {
              images.push({
                rendered_w: Math.round(paintedW * 10) / 10,
                natural_w: dims.w,
                src_head: "background-image data:",
              });
            }
          }
        }
        out.push({ index, images });
      }
      return out;
    }, selector);
  } finally {
    // Runs after page.pdf(), but clear the override and restore the
    // viewport anyway so the PNG pass sees the page it had.
    await page.emulateMedia({ media: null }).catch(() => {});
    await page.setViewportSize(viewport).catch(() => {});
  }
}

// The deck's slide ids, in document order. Empty string for a slide with no
// `id`, so the caller can tell "missing id" from "wrong id".
async function probeSlideIds(page, selector) {
  return page.evaluate(
    (sel) => Array.from(document.querySelectorAll(sel)).map((el) => el.id || ""),
    selector,
  );
}

// The StylePlan is the only machine-readable statement of what the deck was
// meant to be, so comparing against it is free signal.
function comparePlan(stylePlan, slideIds) {
  const entries = Array.isArray(stylePlan?.layout_plan) ? stylePlan.layout_plan : [];
  const planned = entries.map((entry) => (entry && entry.id) || "").filter((id) => id !== "");
  const built = new Set(slideIds.filter((id) => id !== ""));
  const plannedSet = new Set(planned);
  return {
    missing_slides: planned.filter((id) => !built.has(id)),
    extra_slides: [...built].filter((id) => !plannedSet.has(id)),
  };
}

// Turn findings into a verdict. Only called under `--gate`, so every
// pre-existing caller keeps today's pure-reporter behaviour: findings reported,
// `ok` true, exit 0.
//
// Only unambiguous defects gate. Anything a documented branch of the skill is
// allowed to produce is an advisory instead, because a false failure costs the
// user the whole deck: the builder is told not to hand back a link on a failed
// gate, so a gate it cannot satisfy means no deliverable at all.
function evaluateGate(report, args) {
  const failures = [];
  const advisories = [];
  const { fonts, overflow, broken_images: broken, fill, plan } = report;

  if (report.browser_failures !== undefined) {
    const shown = report.browser_failures.slice(0, 5);
    const omitted = report.browser_failures.length - shown.length;
    failures.push(
      `browser audit failed: ${shown.join("; ")}${omitted > 0 ? `; ${omitted} more` : ""}`,
    );
  }

  // Advisory, not gating: the face has to resolve through a downloaded
  // @font-face, so the probe depends on the Google Fonts fetch. The same deck
  // reported `Inter:400` missing on one run and clean on another, and gating a
  // network-dependent probe turns a transient fetch failure into a build
  // failure. Unchanged from today: reported, with the prose telling the builder
  // to re-render.
  if (fonts.missing.length > 0) {
    advisories.push(`fonts not rasterized: ${fonts.missing.join(", ")}`);
  }
  if (overflow.length > 0) {
    failures.push(
      `content overflows its canvas on ${unitWord(args)}(s) ${slideList(overflow)}`,
    );
  }
  // Emitted-PDF geometry, only under --require-geometry.
  if (report.geometry) {
    failures.push(...report.geometry.failures);
    advisories.push(...report.geometry.advisories);
  }
  // Readability floor, only under --require-text-floor. Why and what gates
  // versus advises: pdf_text_floor.mjs.
  if (args.requireTextFloor && Array.isArray(report.text_floor)) {
    const floor = evaluateTextFloor(report.text_floor);
    failures.push(...floor.failures.map((f) => f.message));
    advisories.push(...floor.advisories.map((f) => f.message));
  }
  // Image effective resolution, only under --require-image-resolution. Why
  // and what gates versus advises: pdf_image_resolution.mjs.
  if (args.requireImageResolution && Array.isArray(report.image_resolution)) {
    const res = evaluateImageResolution(report.image_resolution);
    failures.push(...res.failures.map((f) => f.message));
    advisories.push(...res.advisories.map((f) => f.message));
  }
  if (report.image_resolution_not_measured !== undefined) {
    advisories.push(
      `image resolution could not be measured (${report.image_resolution_not_measured}); ` +
        "this check did not run",
    );
  }
  if (broken?.length > 0) {
    failures.push(`broken image(s) on ${unitWord(args)}(s) ${slideList(broken)}`);
  }
  // Step 6 lets a deck ship coverless when the brief forbids synthetic imagery,
  // so this gates only when the caller says imagery was in scope.
  if (args.requireCoverImage && report.cover_no_image === true) {
    failures.push("cover has no decoded image");
  }
  // Says only what provenance proves. A sidecar-less file is a chart, a sourced
  // photo, OR a hand-drawn placeholder, and nothing on disk separates the three,
  // so the message must not accuse the builder of drawing real sourced photos. It
  // names both legitimate exits instead. Why provenance and not pixels:
  // probeGeneratedImagery.
  if (args.requireGeneratedImagery && report.generated_imagery?.generated === 0) {
    const drawn = report.generated_imagery.drawn;
    failures.push(
      "the media image tool generated no image for this deck"
      + (drawn > 0
        ? `, and the ${drawn} image(s) present carry no generation sidecar, so they are charts, `
          + "sourced photos, or hand-drawn placeholders"
        : "")
      + ". If imagery was meant to be generated, generate it; if this deck is "
      + "deliberately chart-only or fully sourced, drop --require-generated-imagery",
    );
  }
  // Authoring restraint, only under --require-restraint. Named per slide so the
  // re-edit knows where to look, capped so one bad deck.css does not bury the
  // rest of the gate output.
  if (args.requireRestraint && Array.isArray(report.restraint)
      && report.restraint.length > 0) {
    const shown = report.restraint.slice(0, 3)
      .map((r) => `${r.index + 1}: ${r.findings.join(", ")}`);
    const omitted = report.restraint.length - shown.length;
    failures.push(
      `banned slide furniture, uppercase, or letter tracking on `
      + `${unitWord(args)}(s) ${slideList(report.restraint)} `
      + `(${shown.join("; ")}${omitted > 0 ? `; ${omitted} more` : ""})`,
    );
  }
  if (args.requireFillPct !== null && Array.isArray(fill)) {
    // Underfilled is not the defect on its own — a deliberately sparse slide is
    // CENTRED (a big gap above the content as well as below it), while the defect
    // is TOP-PACKED (content jammed against the top with the remainder dead).
    // Measured: the rejected deck's slides sat at 6-9% top gap, and an accepted
    // deck's centred statement slide at 33%. Requiring the bottom gap to beat the
    // top gap 2:1 catches the defect without needing to know a slide's intent, so
    // a self-designed deck with no StylePlan is judged correctly too.
    //
    const topPacked = (f) => 100 - f.v_fill_pct > 2 * f.top_gap_pct;
    const short = fill.filter((f) => f.v_fill_pct < args.requireFillPct && topPacked(f));
    if (short.length > 0) {
      const detail = short.map((f) => `${f.index + 1}:${f.v_fill_pct}%`).join(", ");
      failures.push(
        `content stops short of the canvas (need >=${args.requireFillPct}% vertical fill) `
          + `on slide(s) ${detail}`,
      );
    }
  }
  // Plan drift is advisory: on a shorten edit the saved plan still lists the
  // slides the user just asked to delete (`editing.md` resyncs it after this
  // runs), and `preferred_charts` is an archetype-level preference, not a
  // per-deck requirement. Gating either would fail a deck that is correct.
  if (plan !== undefined) {
    if (plan.missing_slides.length > 0) {
      advisories.push(`StylePlan slide(s) not built: ${plan.missing_slides.join(", ")}`);
    }
  }

  report.gate_failures = failures;
  report.advisories = advisories;
  if (failures.length > 0) report.ok = false;
}

// "1, 4, 9" from [{index:0}, {index:3}, {index:8}] — 1-based, matching the
// page-NN.png a reader opens next.
function slideList(findings) {
  return findings.map((f) => f.index + 1).join(", ");
}

// Deck callers get "slide", document callers get "page". The PDF path reaches
// evaluateGate for the first time with --require-geometry, and a report that
// says "slide(s) 3" next to the geometry gate's "page 2" hands the builder two
// nouns for one sheet.
function unitWord(args) {
  return args.requireGeometry && !args.structureCheck ? "page" : "slide";
}

function zeroPad(n, width) {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

// Remove stale page-*.png from a prior render so a re-edit that reduces the page
// count cannot leave orphaned PNGs behind (which would corrupt both the visual
// review and the image-based PPTX export that globs page-*.png).
async function clearStalePagePngs(pngDir) {
  let entries;
  try {
    entries = await readdir(pngDir);
  } catch {
    return; // dir doesn't exist yet — nothing to clear
  }
  await Promise.all(
    entries
      .filter((name) => /^page-\d+\.png$/.test(name))
      .map((name) => rm(join(pngDir, name), { force: true })),
  );
}

// --- Main audit ------------------------------------------------------------

async function runAudit(args) {
  if (!existsSync(args.html)) {
    throw new Error(`--html file not found: ${args.html}`);
  }
  if (args.pngDir) {
    await mkdir(args.pngDir, { recursive: true });
  }
  if (args.pdf) {
    await mkdir(dirname(args.pdf), { recursive: true });
  }

  const { audit, playwright, executablePath } = await loadBrowserAuditRuntime();
  process.stderr.write(
    executablePath === null
      ? "render_audit: using Playwright-managed chromium\n"
      : `render_audit: using system chrome at ${executablePath}\n`,
  );

  // A hermetic render has no reason to inherit the exec process's egress path:
  // skip proxy parsing and relay startup entirely. Network-capable callers keep
  // the loopback auth relay so the runtime egress token is attached to every
  // CONNECT without ever entering Chromium.
  const proxyConfig = args.hermetic ? null : parseProxyConfig();
  let proxyRelay = null;
  let effectiveProxy = proxyConfig?.server ?? null;
  if (proxyConfig !== null) {
    if (proxyConfig.username !== undefined && proxyConfig.token !== undefined) {
      try {
        proxyRelay = await startProxyAuthRelay(
          proxyConfig.server,
          proxyConfig.username,
          proxyConfig.token,
        );
        effectiveProxy = proxyRelay.server;
      } catch {
        process.stderr.write(
          `render_audit: ${RELAY_START_FAILURE_MARKER}: ${RELAY_START_FAILURE_MESSAGE}\n`,
        );
        throw new Error(RELAY_START_FAILURE_MESSAGE);
      }
    }
  }
  const launchOptions = audit.buildLaunchOptions(
    executablePath,
    effectiveProxy,
    null,
    proxyConfig?.username ?? null,
  );
  if (args.hermetic) {
    // Name resolution fails for everything, so nothing can be reached even if a
    // request escaped the handler below, and script in the page cannot read a
    // local file. Neither flag is a substitute for the handler: measured on a VM,
    // `--disable-file-access-from-file-urls` does NOT stop a `file://` page from
    // rendering `file:///tmp/x.png` into a screenshot.
    launchOptions.args = [
      ...(launchOptions.args ?? []),
      "--disable-quic",
      "--proxy-server=direct://",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
      "--disable-file-access-from-file-urls",
    ];
  }
  const browser = await playwright.chromium.launch(launchOptions);

  const report = {
    ok: true,
    pdf: args.pdf,
    pages: 0,
    pngs: [],
    fonts: { missing: [], unused: [], used: [], expected: [] },
    overflow: [],
  };

  try {
    const context = await browser.newContext({
      viewport: { width: PAGE_BOX_PX.width, height: PAGE_BOX_PX.height },
      deviceScaleFactor: 2,
    });
    // This page is authored markup and its screenshots are readable by whoever can
    // read the artifact, so a slide naming a local path outside the artifact is a
    // file-read primitive with a picture attached. Containing `file:` is therefore
    // unconditional: no artifact has a reason to read another one's files, and
    // `pdf.md` already forbids a `file://` reference outright. Blocking REMOTE
    // requests is opt-in (`--hermetic`), because a document that hotlinks an image
    // would visibly lose it.
    const assetRoots = realRootsFor(artifactAssetRoots(args.html));
    const blockedRequests = { local: [], remote: 0 };
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/^(data|about|blob):/.test(url)) return route.continue();
      if (url.startsWith("file:")) {
        if (fileUrlWithinRoots(url, assetRoots)) return route.continue();
        if (blockedRequests.local.length < 20) blockedRequests.local.push(url.slice(0, 200));
        return route.abort();
      }
      if (!args.hermetic) return route.continue();
      blockedRequests.remote += 1;
      return route.abort();
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const failedImageResponses = [];
    const brokenAssets = [];

    const fileUrl = pathToFileURL(args.html).href;
    audit.installPageDiagnostics(
      page,
      consoleErrors,
      failedImageResponses,
      new URL(fileUrl).origin,
      [],
      brokenAssets,
    );
    await page.goto(fileUrl, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });

    // Wait for webfonts to resolve, but never hang on a face that never loads.
    const fontsReady = await page
      .evaluate(
        (timeoutMs) =>
          Promise.race([
            document.fonts.ready.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
          ]),
        FONTS_READY_TIMEOUT_MS,
      )
      .catch(() => null);
    // false => a face was STILL PENDING when the race elapsed. Per the CSS
    // Font Loading spec `document.fonts.ready` settles on load failure too, so
    // this does NOT catch a face that failed fast; `fonts.missing` covers the
    // ones named in --fonts. What it catches is a face that hangs, where the
    // page rasterizes mid-load.
    //
    // stderr only, deliberately. The natural home is `report.fonts`, but
    // hatch-artifacts' FontReport is `#[serde(deny_unknown_fields)]`, so a new
    // key there fails deserialization on every PDF the Rust renderer builds.
    // Surfacing it properly is a lockstep change with that struct.
    if (fontsReady === false) {
      process.stderr.write(
        `render_audit: a webfont was still loading after ${FONTS_READY_TIMEOUT_MS}ms; the page rasterized mid-load\n`,
      );
    }

    // Small settle for Chart.js / rAF-driven canvas paint.
    await page.waitForTimeout(CHART_SETTLE_MS);

    await page.evaluate(
      (timeoutMs) => {
        for (const image of document.images) image.loading = "eager";
        return Promise.all(
          Array.from(document.images, (image) => {
            if (image.complete) return Promise.resolve();
            return Promise.race([
              new Promise((resolve) => {
                image.addEventListener("load", resolve, { once: true });
                image.addEventListener("error", resolve, { once: true });
              }),
              new Promise((resolve) => setTimeout(resolve, timeoutMs)),
            ]);
          }),
        );
      },
      PAGE_LOAD_TIMEOUT_MS,
    );
    const imageAudit = audit.summarizeImages(
      await audit.collectRawImages(page),
      failedImageResponses,
    );
    const browserFailures = [
      ...consoleErrors,
      ...imageAudit.broken.map(
        ({ src, reason }) => `broken image: ${src.slice(0, 80)} (${reason})`,
      ),
      ...imageAudit.unstable.map(
        ({ src, reason }) => `unstable image: ${src.slice(0, 80)} (${reason})`,
      ),
      ...audit.dedupeBrokenAssets(brokenAssets).map(
        ({ url, status, resource_type }) =>
          `broken ${resource_type}: ${url.slice(0, 80)} (${status})`,
      ),
    ];
    // A browser failure fails the run, but only at exit: the font probe,
    // overflow probe, and PNG/PDF outputs below still run, so the report
    // carries the diagnosis and the screenshots exist for review.
    if (browserFailures.length > 0) {
      report.browser_failures = browserFailures;
    }
    // Reported only when something was actually refused, so a clean run's report
    // keeps the exact shape every existing caller parses. A refused image also
    // shows up in `broken_images`, because it genuinely did not decode; this field
    // is how a reader tells "the deck is broken" from "we would not fetch it".
    if (blockedRequests.local.length > 0 || blockedRequests.remote > 0) {
      report.blocked_requests = blockedRequests;
      for (const url of blockedRequests.local) {
        process.stderr.write(`render_audit: refused a local request outside the artifact: ${url}\n`);
      }
      if (blockedRequests.remote > 0) {
        process.stderr.write(
          `render_audit: hermetic render refused ${blockedRequests.remote} remote request(s)\n`,
        );
      }
    }

    // Font gate. Expected faces come from --fonts, or from the deck's own
    // `:root` theme vars when the caller passed none. Resolve each expected face
    // through a small off-canvas probe, then compare the exact platform identity
    // against the fonts used by the real page. The probe is fail-closed: if CDP
    // cannot inspect rendered text, the audit itself fails instead of silently
    // disabling the gate.
    let fontProbe = null;
    try {
      const requested =
        args.fonts.length > 0
          ? args.fonts.map((face) => ({
              family: face.family,
              weight: face.weight,
              label: `${face.family}:${face.weight}`,
            }))
          : (await probeThemeFamilies(page)).map((raw) => {
              const family = raw.trim().replace(/^["']|["']$/g, "");
              return { family, weight: null, label: family };
            });
      // De-dupe: a theme may pair a family with itself, and --fonts commonly
      // lists several weights of one family.
      const seen = new Set();
      const gated = requested.filter((face) => {
        const familyKey = normalizeFamily(face.family);
        const key = `${familyKey}:${face.weight ?? "*"}`;
        if (familyKey.length === 0 || CSS_GENERIC_FAMILIES.has(familyKey) || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      report.fonts.expected = gated.map((face) => face.label);
      if (gated.length > 0) {
        fontProbe = await openUsedFontProbe(context, page, args.pageSelector);
        report.fonts.used = [...new Set(fontProbe.usages.map((font) => font.familyName))];
        for (let index = 0; index < gated.length; index += 1) {
          const face = gated[index];
          const result = await resolveExpectedFace(
            page,
            fontProbe,
            face,
            index,
            args.requireWebfonts,
          );
          if (!result.available) {
            report.fonts.missing.push(face.label);
          } else if (!result.rendered) {
            report.fonts.unused.push(face.label);
          }
        }
      }
    } catch (err) {
      throw new Error(`font probe failed: ${(err && err.message) || String(err)}`);
    } finally {
      if (fontProbe !== null) {
        await fontProbe.session.detach().catch(() => {});
      }
    }

    // Per-element overflow detection.
    try {
      report.overflow = await probeOverflow(page, args.pageSelector);
    } catch (err) {
      throw new Error(`overflow probe failed: ${(err && err.message) || String(err)}`);
    }

    // Readability floor (opt-in). Same field discipline as the deck checks:
    // added only under the flag.
    if (args.requireTextFloor) {
      try {
        report.text_floor = await probeTextFloor(page, args.pageSelector);
      } catch (err) {
        throw new Error(`text floor probe failed: ${(err && err.message) || String(err)}`);
      }
    }

    // Slide-deck structural checks (opt-in). Fields are added ONLY under the
    // flag so the shared PDF/DOCX path and the native artifact report parser
    // never see them.
    if (args.structureCheck) {
      try {
        const structure = await probeStructure(page, args.pageSelector);
        report.cover_no_image = structure.cover_no_image;
        report.restraint = await probeRestraint(page, args.pageSelector);
        report.broken_images = structure.broken_images;
        report.fill = await probeFill(page, args.pageSelector);
        report.generated_imagery = await probeGeneratedImagery(args.html);
      } catch (err) {
        throw new Error(`structure probe failed: ${(err && err.message) || String(err)}`);
      }
    }

    // StylePlan conformance (opt-in; the field is absent unless a plan was
    // passed). A deck built before the plan was persisted, or one built while the
    // style CLI was unavailable, has no plan file — that is a documented state,
    // so an absent plan skips the comparison. A plan that exists but does not
    // parse is a real error and still fails.
    if (args.stylePlan) {
      let raw = null;
      try {
        raw = await readFile(args.stylePlan, "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw new Error(
            `style plan unreadable at ${args.stylePlan}: ${(err && err.message) || String(err)}`,
          );
        }
        process.stderr.write(
          `render_audit: no style plan at ${args.stylePlan}; skipping plan comparison and the `
            + "sparse-slide fill exemption\n",
        );
      }
      if (raw !== null) {
        let plan;
        try {
          plan = JSON.parse(raw);
        } catch (err) {
          throw new Error(
            `style plan malformed at ${args.stylePlan}: ${(err && err.message) || String(err)}`,
          );
        }
        try {
          report.plan = comparePlan(plan, await probeSlideIds(page, args.pageSelector));
        } catch (err) {
          throw new Error(`plan probe failed: ${(err && err.message) || String(err)}`);
        }
      }
    }

    if (args.pdf) {
      // PDF: honor @page CSS size so deck/page geometry matches the source.
      await page.pdf({ path: args.pdf, ...PDF_EXPORT_OPTIONS });
      process.stderr.write(`render_audit: wrote PDF ${args.pdf}\n`);

      if (args.requireImageResolution) {
        // Measured at the emitted PDF's paper width under print media, the
        // layout Chromium actually paginated; at the screen viewport a
        // fluid page wrapper is wider and every ratio reads too strict.
        const facts = await probePdfFacts(args.pdf);
        const firstSize = (facts.page_sizes || [])[0] || "";
        const paperWidthPt = Number.parseFloat((firstSize.split(" x ")[0] || "").trim());
        if (Number.isFinite(paperWidthPt)) {
          try {
            report.image_resolution = await probeImageResolution(
              page,
              args.pageSelector,
              Math.round((paperWidthPt / 72) * 96),
            );
          } catch (err) {
            throw new Error(
              `image resolution probe failed: ${(err && err.message) || String(err)}`,
            );
          }
        } else {
          // A probe that cannot measure must not read as a clean pass;
          // mirror the geometry gate's not-measured advisory.
          report.image_resolution_not_measured = `paper width unreadable (${(
            facts.errors || []
          ).join("; ")})`;
        }
      }

      if (args.requireGeometry) {
        const facts = await measureEmittedPdf(args.pdf, page, args.pageSelector);
        const geometry = evaluatePdfGeometry(facts);
        // Flatten to strings: `geometry` in the stdout report is a documented
        // string[] contract, and the `kind` tags exist for the tests.
        report.geometry = {
          failures: geometry.failures.map((f) => f.message),
          advisories: geometry.advisories.map((f) => f.message),
        };
        for (const finding of [...geometry.failures, ...geometry.advisories]) {
          process.stderr.write(`render_audit geometry: ${finding.message}\n`);
        }
      }
    }

    if (args.pngDir) {
      // Screenshots: one PNG per page-selector element, zero-padded to the count
      // width (page-01.png ... page-NN.png). Falls back to a single full-page
      // screenshot when the selector matches nothing. Clear stale page-*.png first
      // so a re-render with fewer pages doesn't leave orphans behind.
      await clearStalePagePngs(args.pngDir);
      const handles = await page.$$(args.pageSelector);
      if (handles.length > 0) {
        const width = String(handles.length).length;
        for (let i = 0; i < handles.length; i += 1) {
          const pngPath = join(args.pngDir, `page-${zeroPad(i + 1, width)}.png`);
          try {
            await handles[i].screenshot({ path: pngPath });
            report.pngs.push(pngPath);
          } catch (err) {
            throw new Error(
              `element ${i} screenshot failed: ${(err && err.message) || String(err)}`,
            );
          }
        }
        report.pages = report.pngs.length;
      } else {
        process.stderr.write(
          `render_audit: page selector '${args.pageSelector}' matched no elements; ` +
            "falling back to a full-page screenshot\n",
        );
        const pngPath = join(args.pngDir, "page-1.png");
        await page.screenshot({ path: pngPath, fullPage: true });
        report.pngs.push(pngPath);
        report.pages = 1;
      }
    }

    await context.close();
  } finally {
    await browser.close();
    if (proxyRelay !== null) {
      try {
        await proxyRelay.close();
      } catch {
        /* best-effort teardown */
      }
    }
  }

  return report;
}

// Read the emitted PDF back and pair it with the rendered page boxes, so the
// geometry gate can compare authored structure against produced pages.
async function measureEmittedPdf(pdfPath, page, selector) {
  const pdfFacts = await probePdfFacts(pdfPath);
  const firstSize = (pdfFacts.page_sizes || [])[0] || "";
  const widthPt = Number.parseFloat((firstSize.split(" x ")[0] || "").trim());
  const heightPt = Number.parseFloat((firstSize.split(" x ")[1] || "").trim());
  // Measure the wrappers under PRINT media at the paper's own width. The page
  // is still sitting at the 1280px screen viewport, and text reflows between
  // the two, so a screen measurement compares a different layout than the one
  // Chromium actually paginated.
  const wrappers = await measureWrappersInPrintMedia(page, selector, widthPt);
  return {
    paperHeightPt: Number.isFinite(heightPt) ? heightPt : null,
    pdfPages: pdfFacts.pdf_pages,
    markupLeaks: pdfFacts.markup_leaks,
    // Both probes' failures, so the gate can say "not measured" instead of
    // reporting empty findings that look identical to a clean document.
    probeErrors: [...(pdfFacts.errors || [])],
    wrappers,
  };
}

// Wrapper heights as the PDF saw them: print media, paper width. Restores
// both afterwards so the PNG pass and any later probe see the page it had.
async function measureWrappersInPrintMedia(page, selector, paperWidthPt) {
  const widthPx = Number.isFinite(paperWidthPt)
    ? Math.round((paperWidthPt / 72) * 96)
    : PAGE_BOX_PX.width;
  const viewport = page.viewportSize() || PAGE_BOX_PX;
  try {
    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({ width: widthPx, height: viewport.height });
  } catch {
    // An older driver without one of these still measures, just under screen.
  }
  try {
    return await page.evaluate(
      (sel) =>
        Array.from(document.querySelectorAll(sel)).map((el, index) => ({
          index,
          rectH: Math.round(el.getBoundingClientRect().height),
        })),
      selector,
    );
  } finally {
    await page.emulateMedia({ media: "screen" }).catch(() => {});
    await page.setViewportSize(viewport).catch(() => {});
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || String(err)}\n`);
    process.stdout.write(
      JSON.stringify({ ok: false, error: (err && err.message) || String(err) }) + "\n",
    );
    return 2;
  }

  try {
    const report = await runAudit(args);
    // Without --gate this is a no-op and `ok` stays true, so the exit code below
    // is 0 for every pre-existing caller.
    if (args.gate) {
      evaluateGate(report, args);
      for (const failure of report.gate_failures) {
        process.stderr.write(`render_audit gate: ${failure}\n`);
      }
      for (const advisory of report.advisories) {
        process.stderr.write(`render_audit advisory: ${advisory}\n`);
      }
    }
    // Browser failures are hard failures with or without --gate; under
    // --gate they already arrived through gate_failures above.
    if (!args.gate && report.browser_failures !== undefined) {
      report.ok = false;
      for (const failure of report.browser_failures) {
        process.stderr.write(`render_audit browser: ${failure}\n`);
      }
    }
    process.stdout.write(JSON.stringify(report) + "\n");
    await writeReport(args.reportOut, report);
    return report.ok ? 0 : 1;
  } catch (err) {
    const message = (err && err.message) || String(err);
    process.stderr.write(`render_audit fatal: ${message}\n`);
    const failed = {
      ok: false,
      pdf: args.pdf,
      pages: 0,
      pngs: [],
      fonts: { missing: [], unused: [], used: [], expected: [] },
      overflow: [],
      error: message,
    };
    process.stdout.write(JSON.stringify(failed) + "\n");
    await writeReport(args.reportOut, failed);
    return 1;
  }
}

// Best-effort mirror of the report to disk. stdout is the authoritative copy, so
// a write failure is reported but does not change the deck's verdict.
async function writeReport(path, report) {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(
      `render_audit: could not write --report-out ${path}: ${(err && err.message) || String(err)}\n`,
    );
  }
}

// Run only when invoked directly, so importing this module for its browser
// bootstrap does not start an audit.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`render_audit unexpected: ${String(err)}\n`);
      process.stdout.write(
        JSON.stringify({ ok: false, error: `unexpected: ${String(err)}` }) + "\n",
      );
      process.exit(1);
    },
  );
}
