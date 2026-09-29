#!/usr/bin/env bun
// CVM (Confidential-VM) hermetic client builder.
//
// Produces a single self-contained `index.html` for rendering a Space inside
// an opaque-origin sandboxed iframe whose only egress is the parent window's
// Noise websocket.
//
// It does NOT re-bundle the Space: it POST-PROCESSES an already-built, staged
// client. The default TypeScript input is a closed, single-chunk production
// bundle. `--rewrite-html-scripts` supports lite static artifacts by rewriting
// executable inline scripts and inlining referenced local scripts in document
// order while preserving third-party resources for direct browser loading. We:
//   1. AST-rewrite the bundle's JS so every URL-bearing call site routes
//      through the runtime `__tunnel` (incl. react-dom's setAttribute/style/
//      innerHTML internals).
//   2. CSS-rewrite every stylesheet's `url(...)` to a tunnel placeholder.
//   3. Strip local `<script src>`/`<link rel=stylesheet>` tags, preserve secure
//      external scripts and stylesheets, HTML-rewrite the body, and inline the
//      prelude + rewritten JS + rewritten CSS directly.
//
// Reusing the canonical output avoids a second bundler invocation (and its
// native Tailwind dependency) and guarantees the CVM artifact is byte-faithful
// to the normal bundle. Binary assets (images, fonts) are copied through and
// resolved at runtime by the tunnel.
//
//   bun <ts-runtime/dist>/build-cvm-client.js \
//     --space-dir <abs space dir> --out <abs out dir> [--prelude <path>] \
//     [--in <staged dir>] [--rewrite-html-scripts]

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  EVAL_DYNAMIC_CODE_ERROR,
  FUNCTION_DYNAMIC_CODE_ERROR,
  NEW_FUNCTION_DYNAMIC_CODE_ERROR,
  rewriteAst,
  type RewriteStats,
} from "./ast-rewrite";
import { checkStaticScripts } from "./check-static-scripts";
import { rewriteCss } from "./css-rewrite";
import { rewriteHtml } from "./html-rewrite";
import {
  MODULE_SCRIPT_REFUSAL,
  type ScriptElement,
  countScriptTagStarts,
  findScriptElements,
  isExecutableScript,
  isExternalUrl,
  isMarkedExternalScript,
  isModuleScript,
  isSecureExternalScriptUrl,
  rejectScriptsInInertHtml,
  resolveLocalScript,
  scriptAttribute,
  stripExternalScriptMarker,
} from "./script-scan";
import {
  EXIT_UNSUPPORTED_DOCUMENT,
  UNSUPPORTED_DOCUMENT_SENTINEL,
  UnsupportedDocumentError,
} from "./unsupported-document";

interface Args {
  spaceDir: string;
  out: string;
  prelude: string;
  input: string;
  rewriteHtmlScripts: boolean;
  /// Report whether the authored page's JavaScript would be admitted, write
  /// nothing, and exit 0 either way. A pre-build advisory, not a gate.
  checkScripts: boolean;
}

function parseArgs(argv: string[]): Args {
  const map: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rewrite-html-scripts" || a === "--check-scripts") {
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`missing value for --${key}`);
      }
      map[key] = val;
      i++;
    }
  }
  const checkScripts = argv.includes("--check-scripts");
  if (!map["space-dir"]) throw new Error("missing required --space-dir");
  // The check writes nothing, so it needs no output directory. Requiring one
  // anyway would make the caller invent a path it never uses.
  if (!map["out"] && !checkScripts) throw new Error("missing required --out");
  const spaceDir = path.resolve(map["space-dir"]);
  return {
    spaceDir,
    out: map["out"] ? path.resolve(map["out"]) : "",
    prelude: map["prelude"]
      ? path.resolve(map["prelude"])
      : path.join(import.meta.dir, "cvm-prelude.js"),
    // Default input is the canonical staged build.
    // The build reads the staged client; the check reads what the author
    // actually wrote, which is the space root itself.
    input: map["in"]
      ? path.resolve(map["in"])
      : checkScripts
        ? spaceDir
        : path.join(spaceDir, ".space-build"),
    rewriteHtmlScripts: argv.includes("--rewrite-html-scripts"),
    checkScripts,
  };
}

// The compiled prelude and the bundled user code are emitted by Bun as ESM.
// Both get inlined into a single classic <script>, so strip any top-level empty
// `export {}` marker that would otherwise be a syntax error there.
function stripEsmExportMarker(code: string): string {
  return code.replace(/^[ \t]*export\s*\{\s*\}\s*;?[ \t]*$/gm, "");
}

// Subdirectories of the staged build that are NOT servable assets and must
// never be carried into the CVM artifact (the per-Space DB build sandbox, the
// bun install cache, etc.).
const SKIP_DIRS = new Set(["node_modules", ".bun-cache"]);
const SKIP_ROOT_DIRS = new Set([
  "data-workspaces",
  "cloudflare-db-snapshots",
  "cloudflare-blob-snapshots",
  "cloudflare-blob-manifests",
]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (d === dir && SKIP_ROOT_DIRS.has(e.name))) continue;
        await rec(path.join(d, e.name));
      } else if (e.isFile()) {
        out.push(path.join(d, e.name));
      }
    }
  }
  await rec(dir);
  return out;
}

function renderScript(element: ScriptElement, attrs: string): string {
  return `<script${attrs}>${element.full.slice(element.openTagLength)}`;
}

function markExternalScript(element: ScriptElement): string {
  return renderScript(
    element,
    `${stripExternalScriptMarker(element.attrs)} data-hatch-cvm-external`,
  );
}

function stripLocalStylesheets(html: string): string {
  return html.replace(/<link\b([^>]*)\/?\s*>/gi, (tag, attrs: string) => {
    const href = scriptAttribute(attrs, "href");
    if (href === null) return tag;
    const rel = scriptAttribute(attrs, "rel")?.trim().toLowerCase() ?? "";
    const pathname = href.split(/[?#]/, 1)[0].toLowerCase();
    const isStylesheet = rel.split(/\s+/).includes("stylesheet") || pathname.endsWith(".css");
    if (!isStylesheet || isExternalUrl(href)) return tag;
    return "";
  });
}

function rewriteStaticScript(source: string, label: string): string {
  try {
    return stripEsmExportMarker(rewriteAst(source).code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(EVAL_DYNAMIC_CODE_ERROR)) {
      throw new UnsupportedDocumentError(
        `Static artifact ${label} uses eval(), which is not supported in private rendering. ` +
          "Replace dynamic evaluation with ordinary JavaScript and rebuild.",
      );
    }
    if (
      message.includes(FUNCTION_DYNAMIC_CODE_ERROR) ||
      message.includes(NEW_FUNCTION_DYNAMIC_CODE_ERROR)
    ) {
      throw new UnsupportedDocumentError(
        `Static artifact ${label} uses dynamic function construction, which is not supported in private ` +
          "rendering. Replace dynamic evaluation with ordinary JavaScript and rebuild.",
      );
    }
    // A parse failure is the document's own JavaScript refusing to parse:
    // deterministic, author-fixable, and never cured by a retry. Anything
    // else reaching here is an unrecognized rewriter fault -- possibly a bug
    // or a transient condition on our side, not a statement about the page --
    // so it stays an ordinary retryable Error. Latching a convertible Space
    // as unconvertible on our own fault is the worse failure: it is silent
    // and persists until the author happens to rebuild.
    if (isParseError(error)) {
      throw new UnsupportedDocumentError(
        `Static artifact ${label} could not be parsed: ${message}`,
      );
    }
    throw new Error(`Static artifact ${label} could not be rewritten: ${message}`);
  }
}

/// True only for the author's own JavaScript failing to parse.
///
/// Measured shape of what `@babel/parser` throws: a `SyntaxError` carrying
/// `code: "BABEL_PARSER_SYNTAX_ERROR"`, `reasonCode`, and a parser position in
/// `pos`/`loc`. The code alone is the primary test; the position-bearing
/// fallback keeps a Babel rename from silently turning every unparseable
/// document retryable, which would put the sweep back in the retry loop.
///
/// A bare `instanceof SyntaxError` is deliberately NOT enough. A `JSON.parse`
/// or `new RegExp` failure inside the rewriter is also a `SyntaxError`, and
/// carries no parser position -- treating our own fault as the document's
/// would latch a convertible page as unconvertible, silently, until its author
/// happened to rebuild.
function isParseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; pos?: unknown; loc?: unknown };
  if (candidate.code === "BABEL_PARSER_SYNTAX_ERROR") return true;
  return (
    error instanceof SyntaxError &&
    typeof candidate.pos === "number" &&
    typeof candidate.loc === "object" &&
    candidate.loc !== null
  );
}

function assertOnlyApprovedScripts(html: string): void {
  const elements = findScriptElements(html);
  for (const element of elements) {
    const attrs = element.attrs;
    if ((isExecutableScript(attrs) || isModuleScript(attrs)) && !isMarkedExternalScript(attrs)) {
      // Our own output invariant, not a statement about the page: every
      // executable script was either bundled, preserved as marked-external,
      // or left non-executable, so one surviving here means the rewrite loop
      // failed. Retryable on purpose -- latching a convertible Space on our
      // bug is silent and outlives the fix.
      throw new Error("Static artifact rewrite left an executable <script> outside its bundle.");
    }
  }
  // Every `<script` the document contains must have resolved to a scanned
  // element; a leftover is an unterminated or otherwise unreadable one.
  if (countScriptTagStarts(html) !== elements.length) {
    throw new UnsupportedDocumentError(
      "Static artifact contains a <script> element the private renderer cannot parse safely.",
    );
  }
}

async function rewriteAuthoredScripts(
  html: string,
  inputRoot: string,
  prelude: string,
): Promise<{ code: string; bundleJs: string; scriptCount: number; inlineScriptCount: number }> {
  rejectScriptsInInertHtml(html);
  let code = "";
  let cursor = 0;
  let scriptCount = 0;
  let inlineScriptCount = 0;
  const rewrittenScripts: string[] = [];

  for (const element of findScriptElements(html)) {
    const attrs = element.attrs;
    code += html.slice(cursor, element.index);
    cursor = element.index + element.full.length;

    const src = scriptAttribute(attrs, "src");
    if (
      src !== null &&
      isSecureExternalScriptUrl(src) &&
      (isExecutableScript(attrs) || isModuleScript(attrs))
    ) {
      code += markExternalScript(element);
      continue;
    }

    if (!isExecutableScript(attrs)) {
      if (isModuleScript(attrs)) {
        throw new UnsupportedDocumentError(MODULE_SCRIPT_REFUSAL);
      }
      code += renderScript(element, stripExternalScriptMarker(attrs));
      continue;
    }

    let source = element.body;
    if (src !== null) {
      const sourcePath = resolveLocalScript(inputRoot, src);
      source = await readFile(sourcePath, "utf8");
      rewrittenScripts.push(rewriteStaticScript(source, `script ${JSON.stringify(src)}`));
    } else {
      inlineScriptCount++;
      rewrittenScripts.push(rewriteStaticScript(source, "inline script"));
    }
    scriptCount++;
  }
  code += html.slice(cursor);
  assertOnlyApprovedScripts(code);

  return {
    code,
    bundleJs: [stripEsmExportMarker(prelude), ...rewrittenScripts].join("\n;\n"),
    scriptCount,
    inlineScriptCount,
  };
}

/// Index of the first `</body>` a browser would treat as the end of the body,
/// or -1 if there is none.
///
/// Authored markup carries that literal text in places the parser does not
/// read as a tag: inside a preserved non-executable script (a `text/template`
/// holding an HTML fragment) and inside an HTML comment. Injecting at a naive
/// first match puts the bundle inside one of them, which fails two different
/// ways -- a template swallows the tag so the count check trips and the sweep
/// retries a page it can never convert, while a comment silently swallows it
/// and ships an artifact whose `__tunnel` never installs. Both are the
/// document's shape rather than a builder fault, so the injection point has to
/// see them rather than the error path having to classify them.
function bodyCloseIndex(html: string): number {
  const shadowed: Array<[number, number]> = [];
  // Script ranges come from the shared scanner rather than a local pattern, so
  // the spans skipped here are exactly the elements the rest of the builder
  // sees -- including a start tag whose attribute value contains `>` and the
  // browser-tolerated closing forms.
  for (const element of findScriptElements(html)) {
    shadowed.push([element.index, element.index + element.full.length]);
  }
  // Unterminated comments run to end of document, matching parser behaviour.
  for (const match of html.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    const start = match.index ?? 0;
    shadowed.push([start, start + match[0].length]);
  }

  for (const match of html.matchAll(/<\/body>/gi)) {
    const at = match.index ?? 0;
    if (!shadowed.some(([start, end]) => at >= start && at < end)) return at;
  }
  return -1;
}

function injectScriptBundle(html: string, js: string, requireSingleExecutableScript: boolean): string {
  const escapedJs = js.replace(/<\/script/gi, "<\\/script");
  for (const commentOpen of escapedJs.matchAll(/<!--/g)) {
    const suffix = escapedJs.slice((commentOpen.index ?? 0) + commentOpen[0].length);
    const commentClose = suffix.indexOf("-->");
    const scriptOpen = suffix.search(/<script(?:[\t\n\f\r />]|$)/i);
    if (scriptOpen >= 0 && (commentClose < 0 || scriptOpen < commentClose)) {
      throw new UnsupportedDocumentError(
        "The CVM bundle contains an unclosed <!-- before <script, which cannot be inlined " +
          "safely for private rendering. Rewrite the template literal, tagged template, or " +
          "regular expression that contains it and rebuild.",
      );
    }
  }
  const scriptTag = `<script data-hatch-cvm-bundle>${escapedJs}</script>`;
  const bodyClose = bodyCloseIndex(html);
  const output =
    bodyClose >= 0
      ? `${html.slice(0, bodyClose)}${scriptTag}\n${html.slice(bodyClose)}`
      : `${html}\n${scriptTag}`;
  if (!requireSingleExecutableScript) return output;

  let executableScripts = 0;
  let trustedBundles = 0;
  for (const element of findScriptElements(output)) {
    const attrs = element.attrs;
    if (isMarkedExternalScript(attrs)) continue;
    if (!isExecutableScript(attrs)) continue;
    executableScripts++;
    if (/(?:^|\s)data-hatch-cvm-bundle(?:\s|=|$)/i.test(attrs)) trustedBundles++;
  }
  if (executableScripts !== 1 || trustedBundles !== 1) {
    // Counted over the document AFTER we injected our own bundle tag, so
    // this too is an assertion about our output rather than the input.
    throw new Error(
      `Static artifact rewrite produced ${executableScripts} executable scripts and ` +
        `${trustedBundles} trusted bundles; expected one of each.`,
    );
  }
  return output;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // The pre-build advisory. It shares this entrypoint rather than shipping a
  // second `dist/` artifact because `dist/` is bundle contract: one more file
  // there is a lockstep change across the installer and its downstream
  // bootstrappers, which is a steep price for a mode that reuses this
  // module's own dependencies. It exits before every output path below.
  if (args.checkScripts) {
    process.stdout.write(`${JSON.stringify(await checkStaticScripts(args.input))}\n`);
    return;
  }

  const htmlPath = path.join(args.input, "index.html");
  if (!existsSync(htmlPath)) {
    throw new Error(
      `CVM build: staged client not found at ${htmlPath} ` +
        `(the canonical client build must run before the CVM build)`,
    );
  }
  let html = await readFile(htmlPath, "utf8");

  // Classify the staged build's files. The bundle is closed + single-chunk, so
  // there is normally exactly one JS file; anything non-JS/CSS is a binary
  // asset the runtime tunnel resolves by relative path.
  const files = await walk(args.input);
  const jsFiles: string[] = [];
  const cssFiles: string[] = [];
  const binaryAssets: Array<{ rel: string; abs: string }> = [];
  for (const f of files) {
    const rel = path.relative(args.input, f);
    if (rel === "index.html" || rel === "manifest.json") continue;
    if (!args.rewriteHtmlScripts && (f.endsWith(".js") || f.endsWith(".mjs"))) jsFiles.push(f);
    else if (f.endsWith(".css")) cssFiles.push(f);
    else binaryAssets.push({ rel, abs: f });
  }
  if (!args.rewriteHtmlScripts && jsFiles.length !== 1) {
    throw new Error(
      `CVM build: expected exactly one JS bundle in staged client at ${args.input}; ` +
        `found ${jsFiles.length}`,
    );
  }
  // CSS ordering is deterministic when Bun emits more than one stylesheet.
  jsFiles.sort();
  cssFiles.sort();

  // 1) AST-rewrite each JS chunk so every URL-bearing site routes through
  //    __tunnel, then strip ESM export markers so it runs in a classic script.
  let userJs = "";
  let astStats: RewriteStats | null = null;
  for (const f of jsFiles) {
    const rewritten = rewriteAst(await readFile(f, "utf8"));
    astStats = rewritten.stats;
    userJs += `\n${stripEsmExportMarker(rewritten.code)}\n`;
  }

  // 2) CSS url() rewrite over every emitted stylesheet.
  const cssStats = { urlTokens: 0, rewritten: 0 };
  let finalCss = "";
  for (const f of cssFiles) {
    const r = rewriteCss(await readFile(f, "utf8"));
    cssStats.urlTokens += r.stats.urlTokens;
    cssStats.rewritten += r.stats.rewritten;
    finalCss += `\n${r.code}\n`;
  }

  // 3) Prelude (installs __tunnel), then the rewritten user code, in one
  //    classic <script> (prelude first so __tunnel exists before user code).
  const prelude = await readFile(args.prelude, "utf8");
  const finalJs = `${stripEsmExportMarker(prelude)}\n;(function () {\n${userJs}\n})();\n`;

  // 4) Build the inlined document: consume local script and stylesheet
  //    references, preserve third-party ones, then rewrite authored URL
  //    attributes and inline the local JS + CSS.
  let authoredScriptStats = { scriptCount: 0, inlineScriptCount: 0 };
  let authoredBundleJs: string | null = null;
  if (args.rewriteHtmlScripts) {
    const rewritten = await rewriteAuthoredScripts(html, args.input, prelude);
    html = rewritten.code;
    html = stripLocalStylesheets(html);
    authoredBundleJs = rewritten.bundleJs;
    authoredScriptStats = {
      scriptCount: rewritten.scriptCount,
      inlineScriptCount: rewritten.inlineScriptCount,
    };
  } else {
    html = html.replace(
      /<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi,
      "",
    );
    html = html.replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi, "");
    html = html.replace(
      /<link\b[^>]*\bhref\s*=\s*["'][^"']+\.css["'][^>]*\/?>/gi,
      "",
    );
  }

  html = rewriteHtml(html).code;

  // Function replacements so String.prototype.replace does not treat `$$`/`$&`
  // in the bundle (e.g. react-dom's `$$typeof`) as replacement patterns.
  const escapedCss = finalCss.replace(/<\/style>/gi, "<\\/style>");
  const styleTag = `<style data-hatch-cvm-bundle>${escapedCss}</style>`;
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, () => `  ${styleTag}\n</head>`);
  } else {
    html = `${styleTag}\n${html}`;
  }

  html = injectScriptBundle(html, authoredBundleJs ?? finalJs, args.rewriteHtmlScripts);

  // 5) Emit the artifact: one index.html plus the binary assets.
  await rm(args.out, { recursive: true, force: true });
  await mkdir(args.out, { recursive: true });
  await writeFile(path.join(args.out, "index.html"), html, "utf8");
  for (const asset of binaryAssets) {
    const dest = path.join(args.out, asset.rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(asset.abs));
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      astRewrites: astStats,
      cssStats,
      jsFiles: jsFiles.length,
      cssFiles: cssFiles.length,
      jsBytes: finalJs.length,
      cssBytes: finalCss.length,
      assetCount: binaryAssets.length,
      authoredScriptCount: authoredScriptStats.scriptCount,
      inlineScriptCount: authoredScriptStats.inlineScriptCount,
    })}\n`,
  );
}

main().catch((err) => {
  const rejected = err instanceof UnsupportedDocumentError;
  // Sentinel FIRST, ahead of the stack trace. `process.exit` can truncate a
  // piped stderr that has not drained, and the sentinel is the one line whose
  // loss matters: without it the caller reads a terminal rejection as
  // retryable and the sweep goes back to rebuilding this page every six hours.
  // Writing it first is what makes it the line most likely to survive; the
  // reader scans every line, so leading with it costs nothing there.
  //
  // Keep the forced exit rather than setting `exitCode` and returning. The
  // caller bounds this child by cancellation alone -- there is no timeout --
  // so a lingering handle would hang the sweep against its 20-minute attempt
  // deadline, which is a worse failure than a rare lost sentinel.
  if (rejected) console.error(UNSUPPORTED_DOCUMENT_SENTINEL);
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(rejected ? EXIT_UNSUPPORTED_DOCUMENT : 1);
});
