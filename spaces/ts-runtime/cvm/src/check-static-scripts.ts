// Answers one question about an authored static artifact, before it is built:
// will private rendering accept this page's JavaScript?
//
// The build already asks it -- `rewriteAuthoredScripts` parses every classic
// script and refuses the document when one will not parse. But it asks at
// `web_artifacts.build` time, so a syntax error the author could have fixed in
// place costs a whole build round trip: measured in production, a build that
// fails at `BuildStage::CvmClientBundle` runs a mean of 3.9 build attempts
// against 2.11 for an ordinary static success. The page's own JavaScript
// failing to parse is the largest single cause of those failures.
//
// So this module asks the same question against the AUTHORED space directory,
// cheaply and with no output, so the answer can ride back on the write that
// introduced the defect. It shares `script-scan.ts` with the builder rather
// than restating the rules: a checker that disagreed with the build would
// either wave through a page the build refuses or refuse one it accepts, and
// both are worse than not checking.
//
// It is advisory. Nothing here refuses a write, fails a build, or changes what
// is admissible; the build remains the only gate.

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  EVAL_DYNAMIC_CODE_ERROR,
  FUNCTION_DYNAMIC_CODE_ERROR,
  NEW_FUNCTION_DYNAMIC_CODE_ERROR,
  rewriteAst,
} from "./ast-rewrite";
import {
  MODULE_SCRIPT_REFUSAL,
  countScriptTagStarts,
  documentWithoutScriptBodies,
  findScriptElements,
  isExecutableScript,
  isModuleScript,
  isSecureExternalScriptUrl,
  rejectScriptsInInertHtml,
  resolveLocalScript,
  scriptAttribute,
} from "./script-scan";
import { UnsupportedDocumentError } from "./unsupported-document";

/// Why the page would be refused. Low-cardinality and code-owned: the caller
/// promotes it to telemetry, so it must never carry authored text.
export type StaticScriptDefectKind =
  | "script_syntax"
  | "module_script"
  | "dynamic_code"
  | "unreadable_script"
  | "inert_script"
  | "local_script";

export interface StaticScriptDefect {
  kind: StaticScriptDefectKind;
  /// Model-facing, bounded, and already located: the whole point is that the
  /// author can act on it without re-deriving where the defect is.
  message: string;
}

export interface StaticScriptReport {
  ok: boolean;
  defect?: StaticScriptDefect;
}

interface Position {
  line: number;
  column: number;
}

/// 1-based line, 0-based column of `offset` in `text`, matching Babel's `loc`.
function offsetToPosition(text: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/// Babel reports a position inside the script body; the author edits a
/// document. Line 1 of the body starts partway along the line carrying the
/// opening tag, so only that line's column needs shifting.
function bodyPositionToDocument(bodyStart: Position, inBody: Position): Position {
  if (inBody.line === 1) {
    return { line: bodyStart.line, column: bodyStart.column + inBody.column };
  }
  return { line: bodyStart.line + inBody.line - 1, column: inBody.column };
}

/// True only for the author's own JavaScript failing to parse -- the same test
/// `build-cvm-client.ts` applies, for the same reason: a `JSON.parse` or
/// `new RegExp` fault inside the rewriter is also a `SyntaxError`, and calling
/// our own fault the document's would tell an author to fix a page that is
/// fine.
function parseErrorLocation(error: unknown): Position | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    pos?: unknown;
    loc?: { line?: unknown; column?: unknown } | null;
  };
  const located =
    candidate.code === "BABEL_PARSER_SYNTAX_ERROR" ||
    (error instanceof SyntaxError && typeof candidate.pos === "number");
  if (!located) return null;
  const loc = candidate.loc;
  if (typeof loc?.line !== "number" || typeof loc?.column !== "number") return null;
  return { line: loc.line, column: loc.column };
}

/// Babel's message carries its own `(line:column)` suffix, which would sit
/// beside a document position and contradict it.
function bareReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s*\(\d+:\d+\)\s*$/, "").trim();
}

function dynamicCodeDefect(message: string, where: string): StaticScriptDefect | null {
  if (message.includes(EVAL_DYNAMIC_CODE_ERROR)) {
    return {
      kind: "dynamic_code",
      message:
        `${where} uses eval(), which private rendering refuses. Replace the dynamic ` +
        "evaluation with ordinary JavaScript.",
    };
  }
  if (
    message.includes(FUNCTION_DYNAMIC_CODE_ERROR) ||
    message.includes(NEW_FUNCTION_DYNAMIC_CODE_ERROR)
  ) {
    return {
      kind: "dynamic_code",
      message:
        `${where} builds code out of a string with Function(), which private rendering ` +
        "refuses. Replace it with ordinary JavaScript.",
    };
  }
  return null;
}

/// Parse one script the way the build will. `origin` names the file the
/// position belongs to, and `toDocument` lifts a body position into it.
function checkOneScript(
  source: string,
  origin: string,
  where: string,
  toDocument: (inSource: Position) => Position,
): StaticScriptDefect | null {
  try {
    rewriteAst(source);
    return null;
  } catch (error) {
    const dynamic = dynamicCodeDefect(
      error instanceof Error ? error.message : String(error),
      where,
    );
    if (dynamic !== null) return dynamic;

    const inSource = parseErrorLocation(error);
    // No parser position means the rewriter itself faulted rather than the
    // page being wrong. Stay quiet: the build is still the gate, and inventing
    // an author-facing defect here would send them editing correct code.
    if (inSource === null) return null;

    const at = toDocument(inSource);
    // Location and the parser's own reason only -- never the offending line.
    // This text becomes a developer message, which the model reads as
    // instruction rather than data, and a page's bytes can be anything it
    // scraped. The repository's rule for that channel is paths, not content
    // (the AGENTS.md reminder carries paths and tells the model to read the
    // file itself); the builder can open the line at tool-output trust.
    return {
      kind: "script_syntax",
      message:
        `${origin} line ${at.line}, column ${at.column + 1}: this page's JavaScript ` +
        `will not parse (${bareReason(error)}). Private rendering parses the page's ` +
        "scripts, so the build will refuse this document until it is valid " +
        `JavaScript. Read that line of ${origin} and fix it before calling ` +
        "web_artifacts.build.",
    };
  }
}

/// Inspect the authored artifact at `spaceRoot`. Returns the FIRST defect: the
/// author fixes one thing at a time, and a parse error routinely cascades, so
/// a list would mostly be noise derived from the same mistake.
export async function checkStaticScripts(spaceRoot: string): Promise<StaticScriptReport> {
  const entry = path.join(spaceRoot, "index.html");
  const html = await readFile(entry, "utf8");

  try {
    rejectScriptsInInertHtml(html);
  } catch (error) {
    if (error instanceof UnsupportedDocumentError) {
      return { ok: false, defect: { kind: "inert_script", message: error.message } };
    }
    throw error;
  }

  const elements = findScriptElements(html);
  // Ask the count question the way the build asks it. `assertOnlyApprovedScripts`
  // runs over the REWRITTEN document, whose script data is gone, so a `<script`
  // the author merely wrote inside a string is not a second element there and
  // must not be one here either -- counting it over the raw page refuses a
  // document every browser renders and the build accepts.
  //
  // This projection is marginally quieter than the build in one case: the build
  // re-renders a non-executable script WITH its body, so a `text/template`
  // holding `<script` text still trips its count. That is the safe direction --
  // the build refuses the page and the check simply had nothing to say.
  const withoutScriptBodies = documentWithoutScriptBodies(html);
  if (countScriptTagStarts(withoutScriptBodies) !== elements.length) {
    return {
      ok: false,
      defect: {
        kind: "unreadable_script",
        message:
          "index.html contains a <script> element private rendering cannot read to its " +
          "end -- usually an unterminated tag, or a literal </script> inside a string. " +
          "A browser would not close it either, so the page is broken as written.",
      },
    };
  }

  for (const element of elements) {
    const attrs = element.attrs;
    const src = scriptAttribute(attrs, "src");

    // A secure external script is preserved as-is by the build and never
    // parsed, so there is nothing here to check.
    if (
      src !== null &&
      isSecureExternalScriptUrl(src) &&
      (isExecutableScript(attrs) || isModuleScript(attrs))
    ) {
      continue;
    }

    if (!isExecutableScript(attrs)) {
      if (isModuleScript(attrs)) {
        return { ok: false, defect: { kind: "module_script", message: MODULE_SCRIPT_REFUSAL } };
      }
      // A non-executable script (a `text/template` holding markup) is carried
      // through untouched and is not JavaScript to begin with.
      continue;
    }

    if (src !== null) {
      let resolved: string;
      try {
        resolved = resolveLocalScript(spaceRoot, src);
      } catch (error) {
        if (error instanceof UnsupportedDocumentError) {
          return { ok: false, defect: { kind: "local_script", message: error.message } };
        }
        throw error;
      }
      let source: string;
      try {
        source = await readFile(resolved, "utf8");
      } catch {
        return {
          ok: false,
          defect: {
            kind: "local_script",
            message:
              `index.html references ${src}, which is not in the artifact. Write or ` +
              "download the script to that path and rebuild. Keep the requested " +
              "feature instead of removing it.",
          },
        };
      }
      const defect = checkOneScript(source, src, `${src}`, (inSource) => inSource);
      if (defect !== null) return { ok: false, defect };
      continue;
    }

    const bodyStart = offsetToPosition(html, element.index + element.openTagLength);
    const defect = checkOneScript(
      element.body,
      "index.html",
      "this page's inline script",
      (inSource) => bodyPositionToDocument(bodyStart, inSource),
    );
    if (defect !== null) return { ok: false, defect };
  }

  return { ok: true };
}
