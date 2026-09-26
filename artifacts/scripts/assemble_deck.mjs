#!/usr/bin/env bun
// Assemble the authored per-slide deck (.src/slides/) into the combined deck the
// rest of the pipeline consumes:
//
//   .src/slides/deck.json   authored manifest, slides in deck order (the ordering authority)
//   .src/slides/deck.css    the deck's shared stylesheet, authored once
//   .src/slides/<id>.html   one standalone slide, its own inlined images
//        ->  .src/index.html   one self-contained document, N <section class="slide">
//        ->  .src/slides/deck.json   rewritten with the derived fields the client reads
//
// The per-slide files are the deck's source; this derives everything else from
// them. Downstream (render_audit.mjs, validate_pdf.sh, build_pptx.py, the
// promoted `html` deliverable) still reads one combined file and is unchanged.
//
// A deck cannot be validated or shipped without its combined document, so every
// failure here exits non-zero.
//
// Inputs (all inert, so the untrusted deck title never reaches the shell; it is
// read from the DOM):
//   --slides <abs dir>  the authored .src/slides/ directory (required)
//   --out <abs file>    the combined document to write, normally .src/index.html (required)
//
// Prints one JSON object on stdout: { ok, out, count, manifest, deck_css_bytes,
// bytes, slides:[{id, path}] }, or { ok:false, error } plus a non-zero exit.

import { mkdir, readdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadBrowserAuditRuntime } from "./browser_audit_runtime.mjs";
import { fileUrlWithinRoots, realRootsFor } from "./deck_asset_scope.mjs";

// The deck contract: one <section class="slide"> per file, N of them combined.
const SLIDE_SELECTOR = "section.slide";
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const MANIFEST_NAME = "deck.json";
const DECK_CSS_NAME = "deck.css";
const FORMAT_VERSION = 1;
// Kebab-case only. A `.` in an id serializes escaped in a CSSOM selector
// (`#q\.3`), which the scope check below can never match, while the naive
// `#q.3` reads as id + class and selects nothing in either view.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// A slide file named index.html would be indistinguishable from the combined
// document this writes beside it.
const RESERVED_ID = "index";
// Absolute only, and free of anything that could terminate the url() token, so a
// model-authored href cannot inject CSS or markup into the combined document.
const IMPORTABLE_HREF = /^(?:https?:)?\/\/[^\s"'()\\<>{}]+$/;
// A hoisted <link> becomes deck-global, so a slide file may only link the theme's
// font sheet. IMPORTABLE_HREF stays broad for deck.css's own @import, which the
// author controls in one place.
const FONTS_HOST = /^https:\/\/fonts\.googleapis\.com\//;
// Refused in any URL a slide or deck.css names. Both loops here and in
// render_audit.mjs open these documents in a real browser, and render_audit's page
// PNGs are client-readable, so a slide naming a local path is a file-read primitive
// with a screenshot attached. Remote http(s) is deliberately NOT refused: every
// non-file/data/about request is aborted at the route, a cited source link fetches
// nothing, and refusing one would cost a user their whole deck.
//
// Two rules, because they apply to different parts of a URL. The scheme rule holds
// whatever follows it: these read or execute.
const UNSAFE_SCHEME = /^(?:file|javascript|vbscript):|^data:text\/html/i;
// The path rule holds only for a URL that addresses a path: a leading `/` resolves
// to the filesystem ROOT on a `file://` document, and a `..` segment climbs out of
// the deck directory. It must NOT be applied to a `data:` URI, which has no path and
// whose payload can legitimately contain `/../` (an inline SVG carrying a path).
const UNSAFE_PATH = /^\/|(?:^|\/)\.\.(?:\/|$)/;
const DATA_URI = /^data:/i;
// Elements a slide may not carry at all: they execute, they navigate, or they pull
// a subresource that no url() check can see (`srcdoc`, a `<base>` that rewrites
// every relative path, a `<meta http-equiv=refresh>`).
const FORBIDDEN_SLIDE_TAGS = ["script", "iframe", "object", "embed", "frame", "frameset", "base", "form"];
// Attributes whose value is a URL the browser resolves.
const URL_ATTRIBUTES = [
  "src", "srcset", "href", "xlink:href", "poster", "data", "background",
  "action", "formaction", "ping", "cite", "longdesc", "manifest", "profile",
  "codebase", "archive",
];
// Of those, the ones holding a LIST of URLs. Only these are split into tokens, and
// the split matters: a dangerous candidate must not hide behind a safe first one.
// Splitting anything else is not just unnecessary, it is wrong. A JPEG data URI is
// `data:image/jpeg;base64,/9j/4AAQ…`, and splitting that on the comma leaves a
// payload starting with `/`, which the path rule would read as the filesystem root.
// That refused an honest deck.
const LIST_URL_ATTRIBUTES = ["srcset", "imagesrcset", "ping"];

// Every url() target in a stylesheet or a style attribute. Quoted forms are matched
// as strings so an escaped `)` inside them cannot end the token early: reading
// `url("x\)/../../etc/passwd")` as the target `x` was a way to hide a path.
const CSS_URL_TOKEN = /url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^)]*?))\s*\)/gi;

function cssUrlTargets(css) {
  const targets = [];
  for (const match of String(css ?? "").matchAll(CSS_URL_TOKEN)) {
    targets.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }
  return targets;
}

// CSS lets any character be written as `\` plus one to six hex digits (with one
// optional trailing space), or as `\` plus the character itself. The CSS parser
// decodes those BEFORE the URL is resolved, so a check reading the raw text sees a
// different string from the one the browser fetches. `f\69le:` is `file:`, and it
// defeated every URL rule below, because `normalizeUrl` maps a backslash to a
// slash and turned it into the harmless-looking `f/69le:`.
//
// Verified on a VM, with a control: the escaped form assembled cleanly, reached
// `.src/index.html`, and Chromium then issued a real request for
// `file:///etc/hostname` that only the resolved-path handler refused.
//
// This runs on CSS-derived values ONLY. In an HTML attribute a backslash is a path
// separator on the `file:` scheme, not an escape introducer, and decoding there
// would be wrong.
function decodeCssEscapes(value) {
  return String(value ?? "").replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\f\r]?|([\s\S]))/g,
    (whole, hex, literal) => {
      if (literal !== undefined) return literal;
      const point = parseInt(hex, 16);
      // Per CSS Syntax, a zero or out-of-range escape is U+FFFD, never a NUL that
      // could truncate a later comparison.
      if (!Number.isFinite(point) || point === 0 || point > 0x10ffff) return "\uFFFD";
      try {
        return String.fromCodePoint(point);
      } catch {
        return "\uFFFD";
      }
    },
  );
}

// Fold a URL to the form the browser's resolver sees, so the test above cannot be
// spelled around. Three rewrites, each one a rule in the URL standard: whitespace
// and control characters are ignored, so `java\tscript:` reaches the same scheme;
// `%2e` IS a dot inside a path segment ("a double-dot path segment must be '..' or
// an ASCII case-insensitive match for '.%2e', '%2e.' or '%2e%2e'"), so
// `media/%2e%2e/etc/passwd` climbs out exactly like `media/../etc/passwd`; and
// `file:` is a special scheme, where a backslash is a path separator, so
// `media\..\..\etc\passwd` escapes too. Percent-decoding stops at `%2e` on purpose:
// decoding everything would let an encoded `%00` or `%2f` change how the rest parses.
function normalizeUrl(value) {
  return String(value ?? "").replace(/[\u0000-\u0020]/g, "")
    .replace(/%2e/gi, ".")
    .replace(/\\/g, "/");
}

// deck.css is authored, is NOT scope-checked, and is the one file the client's theme
// picker rewrites, so its url() targets get the same refusal a slide's do.
function urlIsUnsafe(raw) {
  const url = normalizeUrl(raw);
  if (url === "") return false;
  if (UNSAFE_SCHEME.test(url)) return true;
  if (DATA_URI.test(url)) return false;
  return UNSAFE_PATH.test(url);
}

// CSS-derived values are decoded first; see `decodeCssEscapes`.
function cssUrlIsUnsafe(raw) {
  return urlIsUnsafe(decodeCssEscapes(raw));
}

function firstUnsafeCssUrl(css) {
  return cssUrlTargets(css).find(cssUrlIsUnsafe);
}

// An `@import` can name its sheet as a bare string, with no `url()` around it, so
// the check above cannot see that form. It is still valid CSS after an `@charset` or
// an `@layer` statement, which is past the point `liftFontImports` stops reading, and
// only the Google host is stripped further down the file. So deck.css gets this check
// in either form, wherever the import sits.
const CSS_IMPORT_TARGET = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)/gi;

function firstUnsafeCssImport(css) {
  for (const match of String(css ?? "").matchAll(CSS_IMPORT_TARGET)) {
    const target = (match[2] ?? match[4] ?? "").trim();
    if (target !== "" && cssUrlIsUnsafe(target)) return target;
  }
  return undefined;
}

// This browser reads the DOM and never rasterizes, so it needs no network. Route
// aborts below cover only page requests; Chromium's startup probes are
// browser-level, and failing name resolution is what closes them. localhost stays
// resolvable for Playwright's control connection.
const HERMETIC_LAUNCH_ARGS = [
  "--disable-quic",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
];

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const eq = argv[i].indexOf("=");
    if (eq >= 0) {
      flags.set(argv[i].slice(2, eq), argv[i].slice(eq + 1));
    } else if (typeof argv[i + 1] === "string" && !argv[i + 1].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[(i += 1)]);
    } else {
      flags.set(argv[i].slice(2), "");
    }
  }
  const slides = (flags.get("slides") ?? "").trim();
  const out = (flags.get("out") ?? "").trim();
  if (!slides || !out) {
    throw new Error(
      "assemble_deck: --slides (the authored .src/slides dir) and --out (the combined .src/index.html) are both required",
    );
  }
  for (const [name, value] of [
    ["slides", slides],
    ["out", out],
  ]) {
    const parts = value.split("/").filter(Boolean);
    const idx = parts.lastIndexOf("workspace");
    if (idx === -1 || idx === parts.length - 1) {
      throw new Error(`assemble_deck: --${name} must be under the workspace (got: ${value})`);
    }
  }
  if (resolve(dirname(out)) === resolve(slides)) {
    throw new Error(
      `assemble_deck: refusing to write the combined deck into the authored slides directory ${slides}`,
    );
  }
  return { slides, out };
}

// The authored manifest owns deck ORDER; everything else in it is derived below,
// so a stale or absent derived field is not an error here.
async function readAuthoredManifest(slidesDir) {
  const path = join(slidesDir, MANIFEST_NAME);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `assemble_deck: no ${MANIFEST_NAME} in ${slidesDir}; the authored manifest lists the deck's slides in order`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`assemble_deck: ${path} is not valid JSON: ${err?.message ?? err}`);
  }
  if (!Array.isArray(manifest?.slides) || manifest.slides.length === 0) {
    throw new Error(`assemble_deck: ${path} needs a non-empty "slides" array in deck order`);
  }
  const seen = new Set();
  const slides = manifest.slides.map((slide, index) => {
    const id = typeof slide?.id === "string" ? slide.id.trim() : "";
    if (!SAFE_ID.test(id) || id === RESERVED_ID) {
      throw new Error(
        `assemble_deck: ${path} slide ${index + 1} has an unusable id ${JSON.stringify(slide?.id)}`,
      );
    }
    if (seen.has(id)) throw new Error(`assemble_deck: ${path} repeats the slide id "${id}"`);
    seen.add(id);
    // Take the filename from the id, not from the manifest: a model-authored
    // path is the one field here that could escape the slides directory.
    const declared = typeof slide?.path === "string" ? slide.path.trim() : "";
    if (declared && basename(declared) !== declared) {
      throw new Error(
        `assemble_deck: ${path} slide "${id}" path must be a bare filename in the slides directory (got: ${declared})`,
      );
    }
    const file = declared || `${id}.html`;
    if (basename(file, ".html") !== id) {
      throw new Error(
        `assemble_deck: ${path} slide "${id}" must live in ${id}.html (got: ${file})`,
      );
    }
    return { id, path: file };
  });
  return { mainTitle: typeof manifest?.main_title === "string" ? manifest.main_title.trim() : "", slides };
}

// --- page-side functions (serialized into Chromium, no closures) -------------

// One slide file: prove it holds exactly the slide the manifest promised, then
// hand back the parts the combined document is built from. Returns { error } for
// anything the caller should refuse to assemble.
function readAuthoredSlide([
  selector,
  expectedId,
  scopePrefixSource,
  cssLinkName,
  importableHrefSource,
  fontsHostSource,
  unsafeSchemeSource,
  unsafePathSource,
  forbiddenTags,
  urlAttributeNames,
  listUrlAttributeNames,
]) {
  const fontsHost = new RegExp(fontsHostSource);
  const sections = Array.from(document.querySelectorAll(selector));
  if (sections.length !== 1) {
    return { error: `expected exactly one '${selector}', found ${sections.length}` };
  }
  const section = sections[0];
  const id = (section.id || "").trim();
  if (id !== expectedId) {
    return { error: `its '${selector}' has id "${id}", but the manifest calls it "${expectedId}"` };
  }

  // Untrusted markup. This file is opened in a real browser here, and again by
  // render_audit.mjs, whose page PNGs are readable over /fs/read, so a slide that
  // can name a local path or run script is a file-read primitive with a screenshot
  // attached. A rebuild route would pull that trigger deterministically, with no
  // model in the loop, so the refusal belongs here rather than in a caller. Cheap,
  // because authoring.md already requires every asset to be an embedded data: URI.
  const unsafeScheme = new RegExp(unsafeSchemeSource, "i");
  const unsafePath = new RegExp(unsafePathSource);
  const forbidden = new Set(forbiddenTags.map((tag) => tag.toUpperCase()));
  const urlNames = new Set(urlAttributeNames);
  const listUrlNames = new Set(listUrlAttributeNames);
  // Same fold as `normalizeUrl` on the node side, which cannot be imported here: the
  // browser ignores whitespace and control characters, reads `%2e` as a dot inside a
  // path segment, and treats a backslash as a separator on the `file:` scheme.
  //
  // Only a list attribute is split into tokens, and not even that when the value is
  // itself a data URI, whose base64 payload holds commas' worth of nothing a path
  // rule should read. What a split could still hide there is caught at the render,
  // where the handler sees resolved URLs.
  const namesUnsafeUrl = (value, isList) => {
    const text = String(value);
    const parts =
      isList && !/^\s*data:/i.test(text) ? [text, ...text.split(/[,\s]+/)] : [text];
    return parts.some((part) => {
      const url = part
        .replace(/[\x00-\x20]/g, "")
        .replace(/%2e/gi, ".")
        .replace(/\\/g, "/");
      if (url === "") return false;
      if (unsafeScheme.test(url)) return true;
      // A `data:` URI has no path, and its payload can hold `/../` legitimately.
      if (/^data:/i.test(url)) return false;
      return unsafePath.test(url);
    });
  };
  // Quoted forms are matched as strings, so an escaped `)` inside one cannot end
  // the token early and hide the rest of the path.
  const urlTargets = (css) => {
    const found = [];
    const token = /url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^)]*?))\s*\)/gi;
    for (const match of String(css).matchAll(token)) {
      found.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
    }
    return found;
  };
  // Same fold as `decodeCssEscapes` on the node side, which cannot be imported
  // here. CSS decodes `\` plus one to six hex digits before resolving the URL, so
  // `f\69le:` is `file:`; without this the backslash rule below turns it into the
  // harmless-looking `f/69le:` and every check passes.
  const decodeCss = (value) =>
    String(value ?? "").replace(
      /\\(?:([0-9a-fA-F]{1,6})[ \t\n\f\r]?|([\s\S]))/g,
      (whole, hex, literal) => {
        if (literal !== undefined) return literal;
        const point = parseInt(hex, 16);
        if (!Number.isFinite(point) || point === 0 || point > 0x10ffff) return "\uFFFD";
        try {
          return String.fromCodePoint(point);
        } catch {
          return "\uFFFD";
        }
      },
    );
  // A CSS url() holds exactly one URL, so it is never split.
  const unsafeStyleUrl = (css) =>
    urlTargets(css).find((target) => namesUnsafeUrl(decodeCss(target), false));
  for (const node of Array.from(document.querySelectorAll("*"))) {
    const tag = (node.tagName || "").toUpperCase();
    if (forbidden.has(tag)) {
      return {
        error: `carries <${tag.toLowerCase()}>, which a slide may not: it executes or pulls a subresource, and this file is rendered in a browser twice`,
      };
    }
    if (tag === "META" && node.hasAttribute("http-equiv")) {
      return { error: "carries a <meta http-equiv>, which can navigate the page away mid-render" };
    }
    if (tag === "STYLE" && unsafeStyleUrl(node.textContent || "") !== undefined) {
      return {
        error: `has a <style> url() the deck cannot carry: ${unsafeStyleUrl(node.textContent || "").slice(0, 120)} (embed the asset as a data: URI)`,
      };
    }
    for (const name of node.getAttributeNames()) {
      const lower = name.toLowerCase();
      // `lower in node` keeps this to the handlers that really fire. A made-up
      // `only=` attribute starts with "on" and is not one of them.
      if (lower.startsWith("on") && lower in node) {
        return { error: `sets the inline handler ${lower}=, which runs script during the render` };
      }
      if (lower === "srcdoc") {
        return { error: "sets srcdoc, which carries a whole nested document the checks below cannot see" };
      }
      const value = node.getAttribute(name) || "";
      if (urlNames.has(lower) && namesUnsafeUrl(value, listUrlNames.has(lower))) {
        return {
          error: `points ${lower} at ${value.slice(0, 120)}, which a slide may not name (no file:, no javascript:, no absolute path, no ..)`,
        };
      }
      if (lower === "style" && unsafeStyleUrl(value) !== undefined) {
        return {
          error: `has a style="" url() the deck cannot carry: ${unsafeStyleUrl(value).slice(0, 120)} (embed the asset as a data: URI)`,
        };
      }
    }
  }

  // Stylesheet links: the shared deck.css is expected and dropped (the combined
  // document inlines it once), the theme's font sheet is hoisted, and anything
  // else is refused. A hoisted link becomes deck-GLOBAL and lands ahead of
  // deck.css, so one slide's CDN reset would restyle every other slide in the
  // combined document while its own standalone view looks untouched.
  const importable = new RegExp(importableHrefSource);
  const fontHrefs = [];
  for (const node of Array.from(document.querySelectorAll("link"))) {
    const rel = (node.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const href = (node.getAttribute("href") || "").trim();
    if (href === cssLinkName || href.endsWith(`/${cssLinkName}`)) continue;
    // `media` decides where a sheet applies, and hoisting carries only the href,
    // so a print-only sheet would become always-on.
    const media = (node.getAttribute("media") || "").trim();
    if (importable.test(href) && fontsHost.test(href) && media === "") {
      fontHrefs.push(href);
      continue;
    }
    return {
      error: `links a stylesheet the combined deck cannot carry: ${href.slice(0, 120) || "<empty href>"}${media ? ` (media="${media.slice(0, 40)}")` : ""} (only the theme's fonts.googleapis.com sheet is hoisted, and shared CSS belongs in ${cssLinkName})`,
    };
  }

  // A slide's own rules are concatenated into one document with every other
  // slide's, so an unscoped selector would restyle the whole deck and make the
  // per-slide render and the combined render disagree. Require every selector to
  // name this slide.
  const scoped = new RegExp(scopePrefixSource);
  const unscoped = [];
  const styles = [];
  const walk = (rules) => {
    for (const rule of rules) {
      // An @import loads a sheet whose rules nothing here can scope-check, and
      // each hoisted <style> is its own stylesheet, so the import leads again in
      // the combined document and fetches for real.
      if (typeof rule.href === "string" && rule.cssRules === undefined) {
        unscoped.push(`@import ${rule.href.slice(0, 60)}`);
        continue;
      }
      if (typeof rule.selectorText === "string") {
        // A bare `@page` has an empty selectorText, so its rules would apply to
        // every page of the combined PDF with nothing to scope.
        const parts = rule.selectorText.split(",").map((part) => part.trim());
        if (parts.every((part) => part === "")) {
          unscoped.push(`${rule.constructor.name} with no selector`);
          continue;
        }
        for (const part of parts) {
          if (part && !scoped.test(part)) unscoped.push(part.slice(0, 80));
        }
        continue;
      }
      // Any grouping rule carries selectors inside it, including a named one like
      // @layer. Only @keyframes is exempt: its children are keyframe steps, not
      // selectors. Exempting by type rather than by "has a name" is what keeps a
      // future grouping rule from opening the same hole @layer did.
      if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) walk(Array.from(rule.cssRules));
    }
  };
  for (const node of Array.from(document.querySelectorAll("style"))) {
    // Hoisting carries the rules, not the element's `media`, so a print-only
    // block would become always-on. Refuse it and let the author move the
    // condition into an `@media` inside the block, which survives verbatim.
    const styleMedia = (node.getAttribute("media") || "").trim();
    if (styleMedia !== "") {
      return {
        error: `has a <style media="${styleMedia.slice(0, 40)}">, which the combined deck cannot carry: put the condition in an @media block inside the <style> instead`,
      };
    }
    // Only <head> styles are hoisted; one inside the section already travels with
    // it in outerHTML, and hoisting that too would emit the rules twice. Both are
    // scope-checked, since both end up in the combined document.
    if (node.closest(selector) === null) styles.push(node.textContent || "");
    let rules;
    try {
      rules = Array.from(node.sheet?.cssRules || []);
    } catch {
      continue;
    }
    walk(rules);
  }
  if (unscoped.length > 0) {
    return {
      error: `has <style> rules that are not scoped to #${expectedId}: ${unscoped.slice(0, 5).join(", ")} (put shared CSS in ${cssLinkName}, and scope a slide's own rules to #${expectedId})`,
    };
  }

  const heading = section.querySelector("h1, .title, h2, h3");
  return {
    html: section.outerHTML,
    styles,
    fontHrefs,
    pageTitle: heading ? (heading.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) : "",
  };
}

// The assembled document, read back: the shape render_audit.mjs is about to load,
// plus the derived manifest fields, so the manifest describes the document that
// was actually produced rather than the parts it was built from.
function readAssembledDeck(selector) {
  const slides = Array.from(document.querySelectorAll(selector));
  let canvas = null;
  if (slides.length > 0) {
    const width = Math.round(slides[0].offsetWidth);
    const height = Math.round(slides[0].offsetHeight);
    if (width > 0 && height > 0) canvas = { width, height };
  }
  // Theme variables as authored on :root, in cascade order. Read from the rules,
  // not the computed style, so a value referencing another variable stays as
  // authored.
  const cssVariables = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = Array.from(sheet.cssRules || []);
    } catch {
      continue; // cross-origin sheet
    }
    for (const rule of rules) {
      if (typeof rule.selectorText !== "string" || !rule.selectorText.includes(":root")) continue;
      for (let i = 0; i < rule.style.length; i += 1) {
        const prop = rule.style[i];
        if (prop.startsWith("--")) cssVariables[prop] = rule.style.getPropertyValue(prop).trim();
      }
    }
  }
  return { ids: slides.map((slide) => (slide.id || "").trim()), canvas, cssVariables };
}

// --- assembly ---------------------------------------------------------------

// `</style>` inside authored CSS would close the element and let the rest of the
// stylesheet parse as markup. `\3c` is the CSS escape for `<`, so the sequence
// stays inert CSS. Same neutralization the client applies when it inlines
// deck.css into a slide iframe.
const escapeStyleContent = (css) => css.replace(/<\/(style)/gi, "<\\/$1");

const escapeHtmlText = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value) => escapeHtmlText(value).replace(/"/g, "&quot;");

// deck.css carries the theme's font stylesheet as a leading `@import` (the shape
// the client renders), so the whole theme is authored in one file. The combined
// document wants it as a real <link> in <head> instead: an
// @import inside an inlined <style> defers the fetch behind the stylesheet, and
// the font gate measures what Chromium actually rasterized.
const LEADING_IMPORT = /^\s*@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/;
// The same import anywhere in the file, restricted to the font host. Same capture
// groups as LEADING_IMPORT, so one reader handles both.
const FONTS_IMPORT_ANYWHERE =
  /[^\S\n]*@import\s+(?:url\(\s*(['"]?)(https?:\/\/fonts\.googleapis\.com\/[^'")]+)\1\s*\)|(['"])(https?:\/\/fonts\.googleapis\.com\/[^'"]+)\3)\s*;[^\S\n]*\n?/gi;
// A comment above the import is the natural way to author it, and CSS still
// treats the import as leading. Skipping comments here keeps the lift working,
// so the theme reaches the combined head as a real <link> instead of staying
// deferred inside the inlined <style>, where the font gate would fail it.
const LEADING_COMMENT = /^\s*\/\*[\s\S]*?\*\//;

function liftFontImports(css) {
  const hrefs = [];
  // Comments are skipped to reach the import behind them, but they are KEPT: this
  // stylesheet is now written back to disk, so dropping them would delete the
  // author's own header notes from its source file on the first build.
  let kept = "";
  let rest = css;
  for (;;) {
    let comment;
    while ((comment = LEADING_COMMENT.exec(rest))) {
      kept += comment[0];
      rest = rest.slice(comment[0].length);
    }
    const match = LEADING_IMPORT.exec(rest);
    if (!match) break;
    const href = (match[2] ?? match[4]).trim();
    if (!IMPORTABLE_HREF.test(href)) {
      throw new Error(
        `assemble_deck: ${DECK_CSS_NAME} imports ${href.slice(0, 120)}, which is not an absolute https URL; a relative import cannot resolve once the stylesheet is inlined`,
      );
    }
    hrefs.push(href);
    rest = rest.slice(match[0].length);
  }
  // A Google import further down the file, which the leading scan above cannot
  // reach. Left in place it would survive into the assembled document and the
  // written deck.css, so the deck would still name an outside URL and the render
  // would still try to fetch a sheet it cannot get. Harvest the family from it,
  // then drop it: deleting it alone would cost the deck the face it asked for.
  for (const match of rest.matchAll(FONTS_IMPORT_ANYWHERE)) {
    const href = (match[2] ?? match[4] ?? "").trim();
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  return { hrefs, css: (kept + rest).replace(FONTS_IMPORT_ANYWHERE, "") };
}

function buildCombinedDocument({ title, deckCss, slides }) {
  const head = ['<meta charset="utf-8">'];
  if (title) head.push(`<title>${escapeHtmlText(title)}</title>`);
  if (deckCss.trim()) head.push(`<style>\n${escapeStyleContent(deckCss)}\n</style>`);
  for (const slide of slides) {
    for (const style of slide.styles) {
      if (!style.trim()) continue;
      head.push(`<style data-slide="${escapeAttribute(slide.id)}">\n${escapeStyleContent(style)}\n</style>`);
    }
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    ...head,
    "</head>",
    "<body>",
    ...slides.map((slide) => slide.html),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// --- Fonts: read only ---------------------------------------------------------
//
// This script no longer fetches or embeds anything. `embed_deck_fonts.mjs` owns the
// deck's typography and writes the faces into `deck.css`, which this document
// inlines, so the combined deck gets them for free. Two jobs are left here: refuse
// to let an external font reference survive into the rendered document, and say so
// when a deck has no faces at all.
//
// One embedded face, as embed_deck_fonts writes it. woff2-only on purpose: a face a
// model inlined itself does so as TTF, which is three times the bytes and should not
// count as done.
const FONT_EMBEDDED_FACE =
  /@font-face\s*\{[^}]*url\(\s*["']?data:font\/woff2[^}]*\}/i;

function hasEmbeddedFaces(css) {
  return FONT_EMBEDDED_FACE.test(String(css));
}


// Optional: a deck built before the StylePlan was persisted has no theme id or
// layout names.
async function readStylePlan(deckFile) {
  const plan = await readFile(join(dirname(deckFile), "style_plan.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const layouts = new Map();
  for (const entry of (plan && plan.layout_plan) || []) {
    if (typeof entry?.id === "string" && typeof entry.layout === "string") {
      layouts.set(entry.id, entry.layout);
    }
  }
  return {
    themeId: typeof plan?.theme === "string" ? plan.theme : "",
    layouts,
    fonts: plan?.fonts && typeof plan.fonts === "object" ? plan.fonts : {},
    cssVariables: plan?.css_variables && typeof plan.css_variables === "object" ? plan.css_variables : {},
  };
}

// The manifest the viewer reads.
function buildManifest({ mainTitle, slides, canvas, cssVariables, stylePlan, hasDeckCss }) {
  const manifest = { format_version: FORMAT_VERSION, main_title: mainTitle };
  if (canvas) manifest.canvas = canvas;
  if (hasDeckCss) manifest.deck_css = DECK_CSS_NAME;
  const variables = cssVariables || {};
  if (stylePlan.themeId || Object.keys(variables).length > 0) {
    manifest.theme = {};
    if (stylePlan.themeId) manifest.theme.id = stylePlan.themeId;
    manifest.theme.css_variables = variables;
  }
  manifest.slides = slides.map((slide, index) => {
    const entry = { index, id: slide.id };
    if (slide.pageTitle) entry.page_title = slide.pageTitle;
    entry.path = slide.path;
    const layout = stylePlan.layouts.get(slide.id);
    if (layout) entry.layout = layout;
    return entry;
  });
  return manifest;
}

// --- driver -----------------------------------------------------------------

async function run(args) {
  const authored = await readAuthoredManifest(args.slides);
  for (const slide of authored.slides) {
    if (!existsSync(join(args.slides, slide.path))) {
      throw new Error(`assemble_deck: ${MANIFEST_NAME} lists ${slide.path}, which does not exist`);
    }
  }
  // The manifest decides the deck, so a slide file it omits is simply not in the
  // deck. That is right for a leftover scratch copy and wrong for a slide the
  // author forgot to list, and the two are indistinguishable from here. So name
  // them instead of guessing: a build that drops real work says so, and a
  // legitimate scratch file does not fail an otherwise good deck.
  const listed = new Set(authored.slides.map((slide) => slide.path));
  const unlisted = (await readdir(args.slides))
    .filter((name) => name.endsWith(".html") && !listed.has(name))
    .sort();
  if (unlisted.length) {
    process.stderr.write(
      `assemble_deck: WARNING ${unlisted.length} file(s) in ${args.slides} are not in ${MANIFEST_NAME}, so they are NOT in the deck: ${unlisted.join(", ")}. Add each real slide to ${MANIFEST_NAME} and re-run, or delete it if it is scratch.\n`,
    );
  }
  const authoredCss = await readFile(join(args.slides, DECK_CSS_NAME), "utf8").catch(() => "");
  // deck.css escapes the per-slide checks twice over: assemble skips its <link> by
  // name and reads the file as text, and the scope walk never opens it. It is also
  // the one file the client's theme picker rewrites. So its url() targets are held
  // to the same rule a slide's are, here, where the bytes are already in hand.
  const unsafeDeckCssUrl = firstUnsafeCssUrl(authoredCss);
  if (unsafeDeckCssUrl !== undefined) {
    throw new Error(
      `assemble_deck: ${DECK_CSS_NAME} names a url() the deck cannot carry: ${unsafeDeckCssUrl.slice(0, 120)} (no file:, no javascript:, no absolute path, no ..; embed the asset as a data: URI)`,
    );
  }
  const unsafeDeckCssImport = firstUnsafeCssImport(authoredCss);
  if (unsafeDeckCssImport !== undefined) {
    throw new Error(
      `assemble_deck: ${DECK_CSS_NAME} imports ${unsafeDeckCssImport.slice(0, 120)}, which the deck cannot carry (no file:, no javascript:, no absolute path, no ..)`,
    );
  }
  // The authored @imports are lifted and DISCARDED: a deck carries its own faces
  // now, so no live font URL survives into the combined document. importedHrefs
  // is kept only to name families when the plan and the tokens are both empty.
  const { hrefs: importedHrefs, css: deckCss } = liftFontImports(authoredCss);
  const stylePlan = await readStylePlan(args.out);

  const { audit, playwright, executablePath } = await loadBrowserAuditRuntime();
  process.stderr.write(
    executablePath === null
      ? "assemble_deck: using Playwright-managed chromium\n"
      : `assemble_deck: using system chrome at ${executablePath}\n`,
  );
  const launchOptions = audit.buildLaunchOptions(executablePath, null, null, null);
  launchOptions.args = [...(launchOptions.args ?? []), ...HERMETIC_LAUNCH_ARGS];
  const browser = await playwright.chromium.launch(launchOptions);

  // Keeps the .html suffix: Chromium decides how to parse a file:// URL from the
  // extension, and pass two below has to read this back as a document.
  const temporary = `${args.out}.assembling.${process.pid}.html`;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    // A `file:` request may only reach the deck's own directories. It used to be
    // enough that the scheme was local, but the pages opened here are authored
    // markup, so `file:///etc/passwd` was in scope. Chromium normalizes the URL
    // before the handler sees it, so this catches every spelling of an escape.
    const assetRoots = realRootsFor([dirname(args.out), args.slides]);
    let blocked = 0;
    let blockedLocal = 0;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/^(data|about):/.test(url)) return route.continue();
      if (url.startsWith("file:")) {
        if (fileUrlWithinRoots(url, assetRoots)) return route.continue();
        blockedLocal += 1;
        process.stderr.write(
          `assemble_deck: refused a local request outside the deck: ${url.slice(0, 160)}\n`,
        );
        return route.abort();
      }
      blocked += 1;
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (err) =>
      process.stderr.write(`assemble_deck pageerror: ${err.message}\n`),
    );

    // Pass one: every authored slide, in deck order. deck.css's own imports come
    // first, so the theme's faces are requested ahead of any slide's addition.
    const fontHrefs = [...importedHrefs];
    const collected = [];
    for (const slide of authored.slides) {
      await page.goto(pathToFileURL(join(args.slides, slide.path)).href, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
      const read = await page.evaluate(readAuthoredSlide, [
        SLIDE_SELECTOR,
        slide.id,
        // `-` is legal in an id and special in a regex, so build the scoping
        // pattern here where the id can be escaped. The trailing guard refuses a
        // sibling combinator: `#cover ~ section` names this slide and then leaves
        // it, matching every later slide once the deck is concatenated.
        `^(?:[A-Za-z][\\w-]*)?#${slide.id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w-])(?!\\s*[~+])`,
        DECK_CSS_NAME,
        IMPORTABLE_HREF.source,
        FONTS_HOST.source,
        UNSAFE_SCHEME.source,
        UNSAFE_PATH.source,
        FORBIDDEN_SLIDE_TAGS,
        URL_ATTRIBUTES,
        LIST_URL_ATTRIBUTES,
      ]);
      if (read.error) throw new Error(`assemble_deck: ${slide.path} ${read.error}`);
      for (const href of read.fontHrefs) {
        if (!fontHrefs.includes(href)) fontHrefs.push(href);
      }
      collected.push({ ...slide, ...read });
    }

    // The deck carries its own font bytes, written into deck.css by
    // embed_deck_fonts.mjs. This document inlines that file, so the faces come with
    // it and there is nothing to fetch. Say so when they are absent: the deck still
    // ships (a deck is never blocked over typography) and the render gate reports
    // the missing face, but the cause is a skipped step, which is worth naming here.
    if (!hasEmbeddedFaces(deckCss)) {
      process.stderr.write(
        `assemble_deck: WARNING ${DECK_CSS_NAME} carries no embedded @font-face, so this deck `
          + "renders in a local fallback font. Run embed_deck_fonts.mjs --slides "
          + `${args.slides} and re-assemble.\n`,
      );
    }
    // Any font URL the author left behind was dropped from deckCss by
    // liftFontImports, so nothing external reaches the rendered document.
    if (importedHrefs.length) {
      process.stderr.write(
        `assemble_deck: dropped ${importedHrefs.length} external font reference(s) from the `
          + "assembled deck; the embedded faces replace them\n",
      );
    }

    const title = authored.mainTitle || collected[0].pageTitle;
    const document_ = buildCombinedDocument({ title, deckCss, slides: collected });
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(temporary, document_, "utf8");

    // Pass two: read back exactly what the renderer is about to load, and derive
    // the manifest from it rather than from the authored parts.
    await page.goto(pathToFileURL(temporary).href, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    const outline = await page.evaluate(readAssembledDeck, SLIDE_SELECTOR);
    const expected = collected.map((slide) => slide.id);
    if (outline.ids.length !== expected.length || outline.ids.some((id, i) => id !== expected[i])) {
      throw new Error(
        `assemble_deck: the assembled deck holds [${outline.ids.join(", ")}], expected [${expected.join(", ")}]`,
      );
    }
    await context.close();

    const manifestPath = join(args.slides, MANIFEST_NAME);
    const manifest = buildManifest({
      mainTitle: title,
      slides: collected,
      canvas: outline.canvas,
      cssVariables: outline.cssVariables,
      stylePlan,
      // Names deck.css, which carries the faces, so the client's viewer gets the
      // theme from the one file it already inlines. No client change.
      hasDeckCss: authoredCss.trim().length > 0,
    });
    await rename(temporary, args.out);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    // deck.css is NOT rewritten here. embed_deck_fonts.mjs owns that file's faces,
    // and an earlier version of this script wrote it back, which silently deleted the
    // author's own leading comments from their source file.
    process.stderr.write(
      `assemble_deck: ${collected.length} slides, deck.css ${authoredCss.length} bytes, `
        + `${hasEmbeddedFaces(deckCss) ? "faces embedded" : "NO faces embedded"}, `
        + `${blocked} remote requests blocked, ${blockedLocal} out-of-deck local requests blocked\n`,
    );

    return {
      ok: true,
      out: args.out,
      count: collected.length,
      manifest: manifestPath,
      deck_css_bytes: Buffer.byteLength(authoredCss, "utf8"),
      bytes: Buffer.byteLength(document_, "utf8"),
      slides: collected.map((slide) => ({ id: slide.id, path: slide.path })),
      // Files present but absent from the manifest, so absent from the deck.
      unlisted,
    };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    await browser.close();
  }
}

// Every outcome reports the same way: the report or the error on stdout as one
// JSON line, diagnostics on stderr. A non-zero exit means the deck has no
// combined document, so it cannot be validated, exported or delivered.
async function main() {
  try {
    process.stdout.write(JSON.stringify(await run(parseArgs(process.argv.slice(2)))) + "\n");
    return true;
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stderr.write(`${message.startsWith("assemble_deck") ? message : `assemble_deck: ${message}`}\n`);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    return false;
  }
}

main().then((succeeded) => process.exit(succeeded ? 0 : 1));
