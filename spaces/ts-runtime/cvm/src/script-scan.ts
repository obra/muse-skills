// How this builder reads a document's `<script>` elements, and which of them
// private rendering will admit.
//
// Extracted from `build-cvm-client.ts` so the pre-build checker
// (`check-static-scripts.ts`) can ask the same questions without importing the
// builder, which runs `main()` on import. There must be exactly one answer to
// "is this script admissible": a checker that told the author their page was
// fine and a build that then refused it would be worse than no checker at all.

import path from "node:path";

import { UnsupportedDocumentError } from "./unsupported-document";

// Script elements are scanned, not regex-matched. A `[^>]*` attribute group
// ends the start tag at its first `>`, but the HTML tokenizer ends it at the
// first `>` OUTSIDE a quoted attribute value — so `<script data-tip="a > b">`
// is one tag, and the regex split it at the inner `>`, leaking tag text into
// the script body. That body then failed to parse and failed the whole build
// on a page every browser renders correctly.

// Tab, LF, FF, CR, space, `/` and `>` are the characters that can terminate a
// tag name, so `<script-viewer>` is a custom element rather than a script.
const TAG_NAME_END = "[\\t\\n\\f\\r />]";
const SCRIPT_TAG_START_SOURCE = `<script(?=${TAG_NAME_END}|$)`;
const SCRIPT_END_TAG_SOURCE = `</script(?=${TAG_NAME_END}|$)`;

/// The refusal a `<script type="module">` earns, named once so the pre-build
/// check and the build itself say the same sentence to the same author.
export const MODULE_SCRIPT_REFUSAL =
  'This page cannot use <script type="module"> in private rendering. ' +
  "Convert it to a classic script. If the page genuinely needs ES modules, finish " +
  'with web_artifacts.exit_build (status: "failure") saying it needs the ' +
  "server-backed builder. Keep the requested feature instead of removing it.";

type TagScanState =
  | "beforeAttributeName"
  | "attributeName"
  | "afterAttributeName"
  | "beforeAttributeValue"
  | "doubleQuotedValue"
  | "singleQuotedValue"
  | "unquotedValue";

function isHtmlSpace(ch: string): boolean {
  return ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ";
}

// Index of the `>` that closes the tag whose name ends at `from`, or -1 when
// the document ends first. Follows the tokenizer's attribute states, so only a
// quote opened in attribute-value position can hide a `>`; a stray quote in an
// unquoted value does not.
function findTagClose(html: string, from: number): number {
  let state: TagScanState = "beforeAttributeName";
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    switch (state) {
      case "doubleQuotedValue":
        if (ch === '"') state = "beforeAttributeName";
        break;
      case "singleQuotedValue":
        if (ch === "'") state = "beforeAttributeName";
        break;
      case "beforeAttributeValue":
        if (ch === '"') state = "doubleQuotedValue";
        else if (ch === "'") state = "singleQuotedValue";
        else if (ch === ">") return i;
        else if (!isHtmlSpace(ch)) state = "unquotedValue";
        break;
      case "attributeName":
        if (ch === "=") state = "beforeAttributeValue";
        else if (ch === ">") return i;
        else if (isHtmlSpace(ch) || ch === "/") state = "afterAttributeName";
        break;
      case "afterAttributeName":
        if (ch === "=") state = "beforeAttributeValue";
        else if (ch === ">") return i;
        else if (!isHtmlSpace(ch) && ch !== "/") state = "attributeName";
        break;
      case "unquotedValue":
        if (ch === ">") return i;
        else if (isHtmlSpace(ch)) state = "beforeAttributeName";
        break;
      case "beforeAttributeName":
        if (ch === ">") return i;
        else if (!isHtmlSpace(ch) && ch !== "/") state = "attributeName";
        break;
    }
  }
  return -1;
}

export interface ScriptElement {
  // Index of the opening `<`.
  index: number;
  // The whole element, opening tag through closing tag.
  full: string;
  // Text between `<script` and the `>` that closes the opening tag.
  attrs: string;
  // Script data between the opening and closing tags.
  body: string;
  // Length of the opening tag, so a rewrite can replace exactly it.
  openTagLength: number;
}

// The first appropriate end tag at or after `from`: `</script` followed by a
// tag-name terminator, then everything up to that tag's own `>`.
function findScriptEndTag(
  html: string,
  from: number,
): { tagStart: number; tagEnd: number } | null {
  const ends = new RegExp(SCRIPT_END_TAG_SOURCE, "gi");
  ends.lastIndex = from;
  const match = ends.exec(html);
  if (match === null) return null;
  const close = findTagClose(html, match.index + match[0].length);
  if (close < 0) return null;
  return { tagStart: match.index, tagEnd: close + 1 };
}

// Every `<script>` element in document order. Scanning resumes past each
// element, so `<script` text inside a script body never opens a second one; an
// unterminated element ends the scan and is caught by the count check in
// `assertOnlyApprovedScripts`.
export function findScriptElements(html: string): ScriptElement[] {
  const elements: ScriptElement[] = [];
  const starts = new RegExp(SCRIPT_TAG_START_SOURCE, "gi");
  let match: RegExpExecArray | null;
  while ((match = starts.exec(html)) !== null) {
    const index = match.index;
    const openTagClose = findTagClose(html, index + match[0].length);
    if (openTagClose < 0) break;
    const bodyStart = openTagClose + 1;
    const end = findScriptEndTag(html, bodyStart);
    if (end === null) break;
    elements.push({
      index,
      full: html.slice(index, end.tagEnd),
      attrs: html.slice(index + match[0].length, openTagClose),
      body: html.slice(bodyStart, end.tagStart),
      openTagLength: bodyStart - index,
    });
    starts.lastIndex = end.tagEnd;
  }
  return elements;
}

export function countScriptTagStarts(html: string): number {
  return html.match(new RegExp(SCRIPT_TAG_START_SOURCE, "gi"))?.length ?? 0;
}

export function scriptAttribute(attrs: string, name: string): string | null {
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

export function isExecutableScript(attrs: string): boolean {
  const rawType = scriptAttribute(attrs, "type");
  if (rawType === null) return true;
  const type = rawType.trim().toLowerCase();
  return type === "" || type === "text/javascript" || type === "application/javascript";
}

export function isExternalUrl(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
}

export function isSecureExternalScriptUrl(src: string): boolean {
  return /^(?:https:)?\/\//i.test(src);
}

export function isModuleScript(attrs: string): boolean {
  return scriptAttribute(attrs, "type")?.trim().toLowerCase() === "module";
}

export function stripExternalScriptMarker(attrs: string): string {
  return attrs.replace(
    /\sdata-hatch-cvm-external(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
    "",
  );
}

export function isMarkedExternalScript(attrs: string): boolean {
  const src = scriptAttribute(attrs, "src");
  return (
    /(?:^|\s)data-hatch-cvm-external(?:\s|=|$)/i.test(attrs) &&
    src !== null &&
    isSecureExternalScriptUrl(src)
  );
}

export function resolveLocalScript(inputRoot: string, src: string): string {
  const pathname = src.split(/[?#]/, 1)[0];
  if (!pathname || pathname.startsWith("/") || isExternalUrl(pathname)) {
    throw new UnsupportedDocumentError(
      `This page cannot load JavaScript from ${JSON.stringify(src)} in private rendering. ` +
        "Download the script into assets/, reference it with a relative path, and rebuild. " +
        "Keep the requested feature instead of removing it.",
    );
  }
  const resolved = path.resolve(inputRoot, pathname);
  const relative = path.relative(inputRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UnsupportedDocumentError(
      `CVM build: script source escapes staged client: ${JSON.stringify(src)}`,
    );
  }
  return resolved;
}

/// The document with every scanned script's DATA removed, tags kept.
///
/// Script data is not markup: a body may legitimately contain the text
/// `<script`, `<!--`, or `<template>` in a string or regex, and reading those
/// as document structure is how a valid page gets mistaken for a broken one.
/// Both the inert-HTML refusal and the scanned-vs-present count question are
/// asked over this projection rather than over the raw page.
export function documentWithoutScriptBodies(html: string): string {
  let out = "";
  let cursor = 0;
  for (const element of findScriptElements(html)) {
    const bodyStart = element.index + element.openTagLength;
    out += html.slice(cursor, bodyStart);
    cursor = bodyStart + element.body.length;
  }
  return out + html.slice(cursor);
}

export function rejectScriptsInInertHtml(html: string): void {
  const withoutScriptBodies = documentWithoutScriptBodies(html);
  for (const comment of withoutScriptBodies.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    if (/<script\b/i.test(comment[0])) {
      throw new UnsupportedDocumentError(
        "Static artifacts do not support <script> text inside HTML comments. " +
          "Remove it or move the classic script into the document body.",
      );
    }
  }
  for (const template of withoutScriptBodies.matchAll(
    /<template\b[^>]*>[\s\S]*?(?:<\/template\s*>|$)/gi,
  )) {
    if (/<script\b/i.test(template[0])) {
      throw new UnsupportedDocumentError(
        "Static artifacts do not support <script> elements inside <template>. " +
          "Move the classic script into the document body.",
      );
    }
  }
}
