#!/usr/bin/env bun
// Give a deck its own font bytes: download the faces its `:root` tokens name and
// write them into `.src/slides/deck.css` as `@font-face` rules carrying the bytes.
//
//   bun run embed_deck_fonts.mjs --slides <abs .src/slides dir>
//
// Run it once the slides are authored and before assembling. It needs the slide
// text, because which subsets are worth embedding is decided from the characters
// the deck actually paints.
//
// After this runs, `deck.css` is the deck's whole typography: no `@import`, no
// `<link>`, nothing to fetch. `assemble_deck.mjs` inlines that file, so the
// combined document gets the faces for free and holds no font logic of its own.
//
// Prints one JSON object on stdout: { ok, faces, bytes, families, reused,
// warnings }. Exits non-zero only when the deck cannot be read or the arguments
// are wrong. A font that will not download is a warning and exit 0: a deck is
// never blocked over typography, and the render gate reports the missing face.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const execFile = promisify(execFileCb);

const DECK_CSS_NAME = "deck.css";
// Only the font host: this decides which URL the script will fetch.
const FONTS_HOST = /^https:\/\/fonts\.googleapis\.com\//;
// A family name reaches a request URL, and it is model-authored, so bound it to
// what a Google Fonts family can actually be.
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,47}$/;
// A Google font `@import` the author may still have left behind. It is removed
// once the faces are embedded, so the deck names nothing external.
const FONTS_IMPORT_ANYWHERE =
  /[^\S\n]*@import\s+(?:url\(\s*(['"]?)(https?:\/\/fonts\.googleapis\.com\/[^'")]+)\1\s*\)|(['"])(https?:\/\/fonts\.googleapis\.com\/[^'"]+)\3)\s*;[^\S\n]*\n?/gi;

// The first family in a font stack is the webfont; the rest are local fallbacks.
const CSS_FONT_TOKEN = /--slide-font-(?:display|body)\s*:\s*([^;}]+)/g;
function fontStackHead(value) {
  return String(value).split(",")[0].trim().replace(/^["']|["']$/g, "");
}
function cssTokenFontFamilies(css) {
  return [...String(css).matchAll(CSS_FONT_TOKEN)].map((m) => fontStackHead(m[1]));
}

// --- Self-contained faces --------------------------------------------------
//
// A deck carries its own font bytes, embedded as `data:` URIs. Nothing it renders
// reaches the network, in the build's Chromium or later in the client's viewer,
// so the proxy's certificate has no say in whether the theme's face loads.
//
// WHY EMBEDDED BYTES AND NOT A FILE PATH. A path resolves only for the build.
// The client injects deck.css as text into a sandboxed iframe, where a relative
// url() resolves against the app origin and the iframe's CSP refuses it (3996
// console violations, measured). `data:` is the one shape every surface accepts,
// and it makes a downloaded deck work offline.
//
// Measured reasons this is shaped the way it is (VM 0282f0ae / 0abd6d9b):
//
// 1. We fetch out of band, never from the page. Chromium rejects the certificate
//    the egress proxy presents for fonts.googleapis.com
//    (ERR_CERT_AUTHORITY_INVALID, 3/3) because it reads a per-user NSS snapshot
//    it cannot write. curl reads the live CA file the cell exports as
//    CURL_CA_BUNDLE, so it gets a 200. Root cause and fix: jarvis #16212.
// 2. We send a browser User-Agent. Without one Google serves TTF, not woff2:
//    743 KB over 4 files against 256 KB over 9. `assertWoff2` makes a stale
//    string loud instead of silently tripling every deck.
// 3. We ask for the sheet uncached. Google retires a file when it republishes a
//    family, so a cached sheet names a URL that now 404s. Observed on the VM: a
//    fresh fetch elsewhere returned different filenames and none of the dead one.
//    The face FILES are content-addressed, so caching those is always safe.
//
// Fail soft, never throw: a deck ships even when the fetch does not. A missing
// face costs the theme's typeface; a throw would cost the user the whole deck. The
// render gate reports it as fonts.missing, which is where it belongs.
const FONT_FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/140.0.0.0 Safari/537.36";
// Every @font-face, with the `/* subset */` comment Google puts above each one
// when it is there. The comment is informational only: which faces to keep is
// decided from unicode-range against the deck's own text, so a formatting change
// upstream cannot silently drop every face.
const FONT_FACE_BLOCK = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?(@font-face\s*\{[^}]*\})/g;
// A weight is one number, or two for a variable face's range ("400 700").
const FONT_WEIGHT_RE = /font-weight:\s*(\d+)(?:\s+(\d+))?/i;
const FONT_UNICODE_RANGE_RE = /unicode-range:\s*([^;}]+)/i;
// Weight keywords a deck may use instead of a number.
const FONT_WEIGHT_KEYWORDS = { normal: "400", bold: "700" };
// A deck that declares no weight at all still paints body text at 400 and the
// design system's headings at 700, so that pair is the floor, not the whole set.
const FONT_WEIGHT_FLOOR = [400, 700];
// Refuse to embed an unbounded payload, per face and in total. Hit only by a
// pathological sheet; the deck still ships, minus the faces past the cap.
const FONT_MAX_FACE_BYTES = 400_000;
const FONT_EMBED_BUDGET_BYTES = 1_500_000;
// The whole src component, so the `format()` that followed it cannot survive and
// produce a duplicate descriptor, which is a parse error that drops the face.
const FONT_SRC_URL =
  /url\(\s*(['"]?)(https:\/\/fonts\.gstatic\.com\/[^'")\s]+)\1\s*\)(?:\s*format\([^)]*\))?/i;
// Break the base64 into CSS string continuations this wide. `bounded_text_page`
// refuses to return ANY body for a line over TOOL_OUTPUT_PREVIEW_BYTE_LIMIT
// (32 KB, hatch-tools/src/tool_output_paging.rs), so one face on one line makes
// the deck's own stylesheet unreadable to the tool that edits it. A `\` before a
// newline inside a quoted CSS string is an escape that produces nothing, so the
// wrapped form is the same string. Verified on the VM's Chromium: wrapped and
// unwrapped render byte-identical PNGs, and a corrupted control fails, so the
// check discriminates.
const FONT_DATA_URI_WRAP = 8_000;
const FONT_FETCH_TIMEOUT_S = 20;
const FONT_CACHE_DIR = join(process.env.JARVIS_HOME || homedir(), ".cache", "slide-fonts");
// Stamped beside the embedded faces by a successful embed, and read back by
// `facesAreCurrent` before it considers fetching anything. See `embedSignature`.
const FONT_EMBED_SIGNATURE_RE = /\/\* slide-fonts-embedded:([0-9a-f]{16}) \*\//;
const FONT_EMBED_SIGNATURE_ALL = /\/\* slide-fonts-embedded:[0-9a-f]{16} \*\/\s*/g;

// curl, not the runtime's fetch. See reason 1 above. `noCache` is for the
// stylesheet only; see reason 3.
async function curlBytes(url, { noCache = false } = {}) {
  const headers = ["-H", `User-Agent: ${FONT_FETCH_UA}`];
  if (noCache) headers.push("-H", "Cache-Control: no-cache", "-H", "Pragma: no-cache");
  const { stdout } = await execFile(
    "curl",
    ["-sS", "--fail", "--max-time", String(FONT_FETCH_TIMEOUT_S), ...headers, url],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}

// Cached across decks, keyed by URL. Google's font URLs carry a content hash, so
// a hit is the same bytes and every deck after the first costs no fetch.
async function cachedFontBytes(url, fetchBytes) {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 32) + ".woff2";
  const path = join(FONT_CACHE_DIR, key);
  const hit = await readFile(path).catch(() => null);
  if (hit && hit.length > 0) return hit;
  const bytes = await fetchBytes(url);
  if (!bytes.length || bytes.length > FONT_MAX_FACE_BYTES) {
    throw new Error(`${bytes.length} bytes is not a usable face`);
  }
  await mkdir(FONT_CACHE_DIR, { recursive: true }).catch(() => {});
  await writeFile(path, bytes).catch(() => {});
  return bytes;
}

// The STYLESHEET is deliberately fetched uncached (reason 3 above), but a fetch
// that fails outright is a different case from a fetch that returns something
// stale. Keep the last good copy so a caller that cannot reach Google can still
// resolve the family, and pair it with the face cache above: the URLs a stale
// sheet names are content-addressed, so they hit that cache and the whole embed
// completes with no network at all.
//
// This is what puts the daemon on parity with the model's own build. The model
// runs this script with working egress and warms both caches; a rebuild triggered
// from the browser reuses them instead of failing to the fallback typeface.
function sheetCachePath(url) {
  return join(FONT_CACHE_DIR, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.css`);
}

async function cachedSheetText(url) {
  const text = await readFile(sheetCachePath(url), "utf8").catch(() => null);
  return text && text.includes("@font-face") ? text : null;
}

async function storeSheetText(url, text) {
  if (!text.includes("@font-face")) return;
  await mkdir(FONT_CACHE_DIR, { recursive: true }).catch(() => {});
  await writeFile(sheetCachePath(url), text, "utf8").catch(() => {});
}

// Which weights the deck actually paints, read from its own CSS rather than
// assumed. A face for a weight nothing uses is pure payload.
function declaredFontWeights(cssSources) {
  const weights = new Set(FONT_WEIGHT_FLOOR);
  for (const css of cssSources) {
    for (const [, n] of String(css).matchAll(/font-weight:\s*(\d{3,4})\b/gi)) {
      weights.add(Number.parseInt(n, 10));
    }
    for (const [, kw] of String(css).matchAll(/font-weight:\s*(normal|bold)\b/gi)) {
      weights.add(Number.parseInt(FONT_WEIGHT_KEYWORDS[kw.toLowerCase()], 10));
    }
  }
  return weights;
}

// The weight span one @font-face covers. Google states a variable face as a
// range and a static one as a single value, so a face declaring `100 900` has to
// match a deck that only paints 600 (matching its first number would drop it).
function blockWeightSpan(block) {
  const match = FONT_WEIGHT_RE.exec(block);
  if (!match) return null;
  const low = Number.parseInt(match[1], 10);
  const high = match[2] === undefined ? low : Number.parseInt(match[2], 10);
  return [Math.min(low, high), Math.max(low, high)];
}

function spanCoversAny(span, weights) {
  if (!span) return true; // no weight declared means the face answers for all
  for (const weight of weights) if (weight >= span[0] && weight <= span[1]) return true;
  return false;
}

// `U+0000-00FF, U+0131, U+0152-0153` -> [[0,255],[305,305],[338,339]].
function parseUnicodeRanges(spec) {
  const ranges = [];
  for (const part of String(spec).split(",")) {
    const m = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
    if (!m) continue;
    // A `?` is a wildcard digit: U+04?? spans U+0400..U+04FF.
    const lo = parseInt(m[1].replace(/\?/g, "0"), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "F"), 16);
    if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi]);
  }
  return ranges;
}

// The codepoints the deck actually renders. data: payloads are stripped first:
// they are megabytes of ASCII that would add nothing and slow the scan.
function deckCodepoints(sources) {
  const points = new Set();
  for (const src of sources) {
    const text = String(src).replace(/data:[^\s"')]+/g, "");
    for (const ch of text) points.add(ch.codePointAt(0));
  }
  return points;
}

function rangesCoverAny(ranges, points) {
  if (!ranges.length) return true; // no range declared means the face is universal
  for (const point of points) {
    for (const [lo, hi] of ranges) if (point >= lo && point <= hi) return true;
  }
  return false;
}

// Google serves TTF to an unrecognised User-Agent. Same faces, three times the
// bytes, and no error, so check rather than trust.
function assertWoff2(sheet, sheetUrl) {
  if (/format\(\s*['"]?woff2/i.test(sheet)) return;
  process.stderr.write(
    `assemble_deck: WARNING ${sheetUrl.slice(0, 80)} returned no woff2 face; `
      + `the User-Agent is probably stale, so this deck carries the larger format\n`,
  );
}

// Ask the sheet for every weight the deck paints, not just the ones the author
// remembered. A deck that writes `font-weight: 900` but imports `wght@400;700`
// gets a browser-faked bold instead of the real face, which is the same defect as
// hardcoding the list.
//
// Rewritten ONLY when the axis value is a plain `400;700` list. Everything else is
// left exactly as authored:
//   `wght@400..700`        a range already spans every weight between its ends, so
//                          widening buys nothing, and splicing a number in yields
//                          `wght@400;700..700`, which Google answers HTTP 400
//                          (measured) and the deck loses every face.
//   `ital,wght@0,400;1,700` the model asked for italics deliberately; a rewrite of
//                          the tuple list would drop them.
// The axis value is captured up to `&` so the test sees all of it. Matching a bare
// `[\d;]+` prefix is what produced the malformed range above.
const FONT_WGHT_AXIS = /([?&]family=[^:&]+):wght@([^&]+)/g;
const FONT_WGHT_PLAIN_LIST = /^\d+(?:;\d+)*$/;
function widenSheetWeights(href, weights) {
  return href.replace(FONT_WGHT_AXIS, (whole, family, spec) => {
    if (!FONT_WGHT_PLAIN_LIST.test(spec)) return whole;
    const asked = spec.split(";").map((n) => Number.parseInt(n, 10)).filter(Number.isFinite);
    if (!asked.length) return whole;
    const merged = [...new Set([...asked, ...weights])].sort((a, b) => a - b);
    return `${family}:wght@${merged.join(";")}`;
  });
}

// A quoted, line-wrapped `url()`. See FONT_DATA_URI_WRAP.
function dataUriSrc(base64) {
  const chunks = [];
  for (let at = 0; at < base64.length; at += FONT_DATA_URI_WRAP) {
    chunks.push(base64.slice(at, at + FONT_DATA_URI_WRAP));
  }
  return `url("data:font/woff2;base64,${chunks.join("\\\n")}") format("woff2")`;
}

// Turn the Google Fonts sheets the deck asked for into embedded @font-face rules.
//
// `hrefs` are the @import URLs already lifted out of the authored deck.css, so
// whatever family, weights and subsets the model requested are what we fetch.
//
// Which faces are kept is DERIVED, not configured: a weight span the deck paints
// into, and a unicode-range covering a character the deck actually renders. One
// real deck's sheet offered 30 faces and 926 KB; the deck painted 9 of them.
//
// One file, one face. A variable family publishes one file per subset and then
// declares it once per requested weight, so inlining every block repeats the same
// base64. Measured on a real deck: 9 blocks over 3 files, 409 KB where 143 KB
// carried the same glyphs. Collapse a repeated URL and declare the whole weight
// span its blocks covered.
//
// Never throws: a deck ships even when the fetch does not.
async function embedFontSheets(hrefs, { weights, points, fetchBytes = curlBytes }) {
  const sheets = [...new Set(hrefs)]
    .filter((h) => FONTS_HOST.test(h))
    .map((h) => widenSheetWeights(h, weights));
  if (!sheets.length) return { css: "", faces: 0, errors: [], dropped: 0, bytes: 0 };

  const errors = [];
  // Keyed by face URL across EVERY sheet, not per sheet: two @imports naming the
  // same family would otherwise inline the same bytes twice.
  const byUrl = new Map();
  for (const sheetUrl of sheets) {
    let sheet;
    try {
      sheet = (await fetchBytes(sheetUrl, { noCache: true })).toString("utf8");
      await storeSheetText(sheetUrl, sheet);
    } catch (err) {
      // Fall back to the last good copy of this exact sheet. Reported as a
      // warning, not swallowed: the caller still learns the network was down,
      // A stale sheet is strictly better than no faces, because the deck
      // otherwise ships in a local fallback typeface. Note this pushes an error
      // on a run that then SUCCEEDS, which is why the signature stamp is gated on
      // family coverage and not on `errors`.
      const cached = await cachedSheetText(sheetUrl);
      if (!cached) {
        errors.push(`${sheetUrl.slice(0, 80)}: ${err.message}`);
        continue;
      }
      sheet = cached;
      errors.push(`${sheetUrl.slice(0, 80)}: ${err.message}; used the cached stylesheet`);
    }
    assertWoff2(sheet, sheetUrl);

    // Group first, so one file is fetched and inlined once however many weights
    // named it. `subset` is only for the emitted comment.
    for (const [, subset, block] of sheet.matchAll(FONT_FACE_BLOCK)) {
      const span = blockWeightSpan(block);
      if (!spanCoversAny(span, weights)) continue;
      const ranges = parseUnicodeRanges(block.match(FONT_UNICODE_RANGE_RE)?.[1] ?? "");
      if (!rangesCoverAny(ranges, points)) continue;
      const url = FONT_SRC_URL.exec(block)?.[2];
      if (!url) {
        errors.push("a face declared no fetchable src");
        continue;
      }
      const seen = byUrl.get(url);
      if (seen) seen.spans.push(span);
      else byUrl.set(url, { subset: subset ?? "", block, spans: [span] });
    }
  }

  const blocks = [];
  let dropped = 0;
  let bytes = 0;
  for (const [url, { subset, block, spans }] of byUrl) {
    if (bytes >= FONT_EMBED_BUDGET_BYTES) {
      dropped += 1;
      continue;
    }
    let raw;
    try {
      raw = await cachedFontBytes(url, fetchBytes);
    } catch (err) {
      // One retired file must not cost the deck its typography. The remaining
      // faces still carry the text.
      dropped += 1;
      errors.push(`face download failed: ${err.message}`);
      continue;
    }
    const encoded = raw.toString("base64");
    bytes += encoded.length;
    let face = block.replace(FONT_SRC_URL, dataUriSrc(encoded));
    const span = mergeWeightSpans(spans);
    if (span) face = face.replace(FONT_WEIGHT_RE, `font-weight: ${span}`);
    blocks.push(subset ? `/* ${subset} */\n${face}` : face);
  }
  if (dropped > 0) {
    process.stderr.write(
      `assemble_deck: WARNING ${dropped} face(s) not embedded; that text falls back `
        + `to a local font\n`,
    );
  }
  return { css: blocks.join("\n"), faces: blocks.length, errors, dropped, bytes };
}

// The span a collapsed file answers for: `400` when every block agreed, else
// `400 700` covering all of them.
function mergeWeightSpans(spans) {
  const present = spans.filter(Boolean);
  if (!present.length) return null;
  const low = Math.min(...present.map((s) => s[0]));
  const high = Math.max(...present.map((s) => s[1]));
  return low === high ? `${low}` : `${low} ${high}`;
}

// One embedded face, with the `/* subset */` comment above it: what this script
// writes, and the only thing it is allowed to remove from the authored file.
//
// Deliberately woff2-only. A model that inlined its own face does so as TTF (one
// real deck carried a 185 KB base64 TTF in deck.css), and that should be replaced
// with the smaller correct format rather than treated as done.
const FONT_EMBEDDED_FACE =
  /(?:\/\*[^*]*\*\/[^\S\n]*\n?)?@font-face\s*\{[^}]*url\(\s*["']?data:font\/woff2[^}]*\}[^\S\n]*\n?/gi;
const FONT_FACE_FAMILY_RE = /font-family:\s*(['"]?)([^;}'"]+)\1/i;

// What deck.css already carries: one entry per embedded face, with the three things
// that decide whether it still answers for the deck.
function embeddedFaces(css) {
  const faces = [];
  for (const [face] of String(css).matchAll(FONT_EMBEDDED_FACE)) {
    const family = FONT_FACE_FAMILY_RE.exec(face)?.[2]?.trim().toLowerCase();
    if (!family) continue;
    faces.push({
      family,
      span: blockWeightSpan(face),
      ranges: parseUnicodeRanges(FONT_UNICODE_RANGE_RE.exec(face)?.[1] ?? ""),
    });
  }
  return faces;
}

// The families deck.css already carries bytes for.
function embeddedFontFamilies(css) {
  return new Set(embeddedFaces(css).map((face) => face.family));
}

// True when deck.css already carries bytes for every family the deck NOW names,
// so a rebuild neither refetches nor rewrites it. Without this every assemble
// would churn the authored file, which is how an earlier write-back attempt
// failed.
//
// Family-aware on purpose. A re-theme swaps the `:root` tokens and leaves the old
// faces in place, so a bare "does it hold any face" check would reuse the PREVIOUS
// theme's bytes and the new headings would render in a fallback. That is the exact
// path the theme picker drives, so it has to refetch instead.
// The embedded faces are still current only when they cover everything the deck NOW
// paints: every family it names, every weight it declares, and every character it
// renders.
//
// Checking families alone was not enough. An edit that adds Cyrillic text, or a
// heavier heading, changes no family, so the gate reused a latin-400/700 set and
// those characters silently fell back to a local font. Every input here is the same
// one the fetch uses, so a gate miss and a fetch decision cannot disagree.
function facesAreCurrent(css, { families, weights, points }) {
  const faces = embeddedFaces(css);
  if (!faces.length) return false;
  // The signature short-circuit comes first, and it is the one that fires on a
  // rebuild. The coverage walk below cannot answer "is this the best obtainable
  // set", only "does it cover everything", and those differ whenever the deck
  // paints a character no published subset carries. One `→` (U+2192) is enough:
  // no Latin subset covers it, so the walk returned false forever and every
  // rebuild refetched the same stylesheet to write the same bytes. Measured on a
  // VM: 2 of the 5 face-carrying decks on the box were in exactly that state.
  //
  // So a successful embed records WHAT IT WAS ASKED FOR. Matching signature means
  // nothing the fetch depends on has changed since, so there is nothing to gain
  // by asking again. A re-theme, a new weight or a new glyph all change the
  // signature and fall through to a real fetch, which is the behaviour the
  // coverage walk was there to protect.
  if (embedSignatureOf(css) === embedSignature({ families, weights, points })) return true;
  const have = new Set(faces.map((face) => face.family));
  if (!families.every((name) => have.has(String(name).trim().toLowerCase()))) return false;
  for (const weight of weights) {
    if (!faces.some((face) => spanCoversAny(face.span, new Set([weight])))) return false;
  }
  for (const point of points) {
    if (!faces.some((face) => rangesCoverAny(face.ranges, new Set([point])))) return false;
  }
  return true;
}

// What the last successful embed was asked to satisfy: the families, the weights
// the deck declares, and the characters it paints. Not what it managed to embed,
// which is the distinction that matters, because the shortfall can be permanent.
function embedSignature({ families, weights, points }) {
  const parts = [
    [...families].map((name) => String(name).trim().toLowerCase()).sort().join(","),
    [...weights].sort((a, b) => a - b).join(";"),
    [...points].sort((a, b) => a - b).join(","),
  ].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

function embedSignatureOf(css) {
  return FONT_EMBED_SIGNATURE_RE.exec(String(css))?.[1];
}

function signatureComment(signature) {
  return `/* slide-fonts-embedded:${signature} */`;
}

// Temp + rename: this is the model's authored source, and a half-written deck.css
// would break the deck for both the render and the viewer. Returns false when the
// bytes are already what we would write, so an unchanged deck is never churned.
//
// The faces are APPENDED, not prepended, and line-wrapped. Both are for the
// reader: the model re-reads this file on every theme edit, so the authored rules
// stay on page one and no line exceeds what the file tool will return. A face
// declared after the rules that name it still applies, because CSS collects every
// @font-face before matching.
async function writeDeckCss(cssPath, next, previous) {
  if (next === previous) return false;
  const temporary = `${cssPath}.embedding.${process.pid}`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, cssPath);
  return true;
}

// Drop the faces a previous assemble wrote, so a re-theme replaces them instead of
// stacking a second set on top. Only this script's own woff2 blocks match, so a
// face the author hand-wrote in another format is left alone.
function stripEmbeddedFaces(css) {
  return css.replace(FONT_EMBEDDED_FACE, "");
}


// --- deck inputs -------------------------------------------------------------

// The families the deck asked for, from whichever record actually holds them.
//
// deck.css's own `:root` tokens come FIRST because they are what the deck
// renders: every rule says `font-family: var(--slide-font-display)`, so the token
// decides the face and the saved plan is only a record of how it got there. A
// re-theme swaps the tokens and may not rewrite `style_plan.json`, and reading the
// plan first would embed the PREVIOUS theme's faces. `hatch-slide-style` has been
// observed emitting `fonts: {display:"", body:""}` while the same plan's
// `css_variables` held the real families, so those come before `fonts`.
function deckFontFamilies(stylePlan, deckCss) {
  const vars = stylePlan.cssVariables || {};
  const fromCss = cssTokenFontFamilies(deckCss);
  const fromVars = ["--slide-font-display", "--slide-font-body"]
    .map((k) => vars[k])
    .filter((v) => v !== undefined)
    .map(fontStackHead);
  const fromPlan = [stylePlan.fonts?.display, stylePlan.fonts?.body];
  for (const set of [fromCss, fromVars, fromPlan]) {
    const usable = set.filter((n) => typeof n === "string" && FONT_FAMILY.test(String(n).trim()));
    if (usable.length) return [...new Set(usable.map((n) => String(n).trim()))];
  }
  return [];
}

// Optional: a deck built before the StylePlan was persisted has no saved plan.
async function readStylePlan(slidesDir) {
  const plan = await readFile(join(dirname(slidesDir), "style_plan.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  return {
    fonts: plan?.fonts && typeof plan.fonts === "object" ? plan.fonts : {},
    cssVariables:
      plan?.css_variables && typeof plan.css_variables === "object" ? plan.css_variables : {},
  };
}

// Every authored slide, so the embedded subsets match the text the deck paints.
// The manifest decides the deck, but a slide it forgot to list still contributes
// characters, so read every .html here rather than only the listed ones: the cost
// of one extra subset is far below the cost of a missing glyph.
async function readSlideText(slidesDir) {
  const names = await readdir(slidesDir).catch(() => []);
  const texts = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".html")) continue;
    const text = await readFile(join(slidesDir, name), "utf8").catch(() => "");
    if (text) texts.push(text);
  }
  return texts;
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const eq = argv[i].indexOf("=");
    if (eq >= 0) flags.set(argv[i].slice(2, eq), argv[i].slice(eq + 1));
    else if (typeof argv[i + 1] === "string" && !argv[i + 1].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[(i += 1)]);
    } else flags.set(argv[i].slice(2), "");
  }
  const slides = (flags.get("slides") ?? "").trim();
  if (!slides) {
    throw new Error("embed_deck_fonts: --slides (the authored .src/slides dir) is required");
  }
  const parts = slides.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("workspace");
  if (idx === -1 || idx === parts.length - 1) {
    throw new Error(`embed_deck_fonts: --slides must be under the workspace (got: ${slides})`);
  }
  return { slides };
}

// --- driver ------------------------------------------------------------------

async function run(args) {
  const cssPath = join(args.slides, DECK_CSS_NAME);
  const authoredCss = await readFile(cssPath, "utf8").catch(() => null);
  if (authoredCss === null) {
    throw new Error(
      `embed_deck_fonts: no ${DECK_CSS_NAME} in ${args.slides}; write the deck's stylesheet first (workflow.md step 4)`,
    );
  }

  const stylePlan = await readStylePlan(args.slides);
  const families = deckFontFamilies(stylePlan, authoredCss);
  if (!families.length) {
    return {
      ok: true,
      faces: 0,
      bytes: 0,
      families: [],
      reused: false,
      warnings: [
        `${DECK_CSS_NAME} names no webfont family; set --slide-font-display and --slide-font-body in its :root block`,
      ],
    };
  }

  const slideText = await readSlideText(args.slides);
  const authoredRules = stripEmbeddedFaces(authoredCss)
    .replace(FONTS_IMPORT_ANYWHERE, "")
    .replace(FONT_EMBED_SIGNATURE_ALL, "");
  const typography = {
    weights: declaredFontWeights([authoredRules, ...slideText]),
    points: deckCodepoints([authoredRules, ...slideText]),
  };

  // Already covering everything the deck paints: nothing to do. A re-theme, a new
  // script, or a heavier heading all fall through, and the old faces are replaced
  // rather than stacked.
  if (facesAreCurrent(authoredCss, { families, ...typography })) {
    return { ok: true, faces: 0, bytes: 0, families, reused: true, warnings: [] };
  }

  if (!slideText.length) {
    process.stderr.write(
      "embed_deck_fonts: WARNING no slide files yet, so subsets are chosen from deck.css alone; "
        + "re-run after authoring the slides so a non-Latin deck keeps its glyphs\n",
    );
  }

  const wght = [...typography.weights].sort((a, b) => a - b).join(";");
  const sheets = families.map(
    (name) =>
      `https://fonts.googleapis.com/css2?family=${name.replace(/ +/g, "+")}:wght@${wght}&display=swap`,
  );
  const signature = embedSignature({ families, ...typography });
  const embedded = await embedFontSheets(sheets, typography);
  for (const problem of embedded.errors) {
    process.stderr.write(`embed_deck_fonts: WARNING ${problem}\n`);
  }
  if (embedded.faces === 0) {
    // A fetch that RAN and matched nothing is this deck's permanent answer, so
    // record the signature and stop asking on every rebuild. A fetch that FAILED
    // is not an answer: leave the signature off so the next build tries again
    // once the network is back. That difference is the whole point of keying the
    // stamp on `errors` rather than on `faces`.
    if (!embedded.errors.length) {
      await writeDeckCss(cssPath, `${authoredRules.replace(/\s*$/, "")}\n\n${signatureComment(signature)}\n`, authoredCss);
    }
    return {
      ok: true,
      faces: 0,
      bytes: 0,
      families,
      reused: false,
      warnings: [
        `no face embedded for ${families.join(", ")}; this deck renders in a local fallback font`,
        ...embedded.errors,
      ],
    };
  }

  // Temp + rename: this is the model's authored source, and a half-written
  // deck.css would break the deck for both the render and the viewer.
  //
  // APPENDED, not prepended, and line-wrapped. Both are for the reader: the model
  // re-reads this file on every theme edit, so the authored rules stay on page one
  // and no line exceeds what the file tool will return. A face declared after the
  // rules that name it still applies, because CSS collects every @font-face before
  // matching.
  // Stamp only when every family the deck asked for actually got a face.
  //
  // The stamp makes later runs skip the coverage walk, so writing it on a PARTIAL
  // embed locks the deck into a fallback typeface permanently: one flaky timeout
  // on one of two families, and the missing family is never fetched again, not by
  // the re-run `workflow.md:266` prescribes and not by a user's rebuild either.
  //
  // Coverage, NOT `errors`, is the right gate. The cached-sheet fallback above
  // records an error on a run that goes on to embed everything, so an `errors`
  // gate would withhold the stamp on every daemon rebuild and put two 20s curl
  // timeouts back into a 7s build.
  //
  // Family coverage alone was NOT enough, and that was the same defect one level
  // down. A download fails per FACE, not per family, so a family whose 400 landed
  // and whose 700 did not still looked covered, got stamped, and every later run
  // short-circuited past the weight check that would have healed it. Bold headings
  // then ship in a fallback face forever.
  //
  // `dropped` is the precise signal, where full coverage would be wrong. It counts
  // faces the sheets OFFERED that did not make it in, from a download failure or
  // the byte budget, so zero means "we embedded everything obtainable". Gating on
  // coverage instead would deny the stamp to the rare-glyph deck this stamp exists
  // for: no published subset carries `->` (U+2192), so a codepoint gate never
  // passes and the 40s refetch returns on every build.
  const embeddedFamilies = new Set(embeddedFaces(embedded.css).map((face) => face.family));
  const everyFamilyCovered = families.every((name) =>
    embeddedFamilies.has(String(name).trim().toLowerCase()),
  );
  const stamp = everyFamilyCovered && embedded.dropped === 0
    ? `${signatureComment(signature)}\n`
    : "";
  // The signature rides ABOVE the faces so `facesAreCurrent` can read it without
  // parsing them, and so a human reading deck.css sees why the block is there.
  const next = `${authoredRules.replace(/\s*$/, "")}\n\n${stamp}${embedded.css}\n`;
  const changed = await writeDeckCss(cssPath, next, authoredCss);
  if (!changed) {
    return { ok: true, faces: 0, bytes: 0, families, reused: true, warnings: [] };
  }

  return {
    ok: true,
    faces: embedded.faces,
    bytes: Buffer.byteLength(embedded.css, "utf8"),
    families,
    reused: false,
    warnings: embedded.dropped > 0
      ? [`${embedded.dropped} face(s) not embedded; that text falls back to a local font`]
      : [],
  };
}

async function main() {
  try {
    const report = await run(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(report) + "\n");
    for (const warning of report.warnings) {
      process.stderr.write(`embed_deck_fonts: WARNING ${warning}\n`);
    }
    return true;
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stderr.write(
      `${message.startsWith("embed_deck_fonts") ? message : `embed_deck_fonts: ${message}`}\n`,
    );
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    return false;
  }
}

main().then((succeeded) => process.exit(succeeded ? 0 : 1));
