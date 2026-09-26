// Poppler-backed measurements of an emitted PDF, for the geometry gate.
//
// The impure half: this produces the facts, `pdf_geometry_gate.mjs` judges
// them and carries the why. That module is pure so it unit-tests without
// poppler; the split is the reason this one exists separately.
//
// Poppler binaries (`pdfinfo`, `pdftoppm`, `pdftotext`) are preinstalled alongside
// other PDF validation tools. Every probe degrades to an empty result rather
// than throwing: a missing binary must not fail a render that otherwise
// succeeded.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Marker a failed probe returns in place of stdout, so callers can tell an
// error from an empty result without exceptions crossing the boundary.
const ERR_PREFIX = "__ERR__ ";

async function poppler(bin, args) {
  try {
    const { stdout } = await run(bin, args, { timeout: 30_000 });
    return stdout;
  } catch (err) {
    return `${ERR_PREFIX}${(err && err.message) || String(err)}`;
  }
}

/**
 * Page count, paper size, and markup that reached the page as visible text.
 */
export async function probePdfFacts(pdfPath) {
  const facts = { pdf_pages: null, page_sizes: [], markup_leaks: [], errors: [] };
  const info = await poppler("pdfinfo", ["-f", "1", "-l", "9999", pdfPath]);
  if (info.startsWith(ERR_PREFIX)) {
    // Surfaced, not swallowed: a silent failure here leaves pdf_pages and the
    // paper height null, which disarms two checks and reads as a clean pass.
    facts.errors.push(`pdfinfo: ${info.slice(ERR_PREFIX.length)}`);
  }
  if (!info.startsWith(ERR_PREFIX)) {
    const pages = /^Pages:\s+(\d+)/m.exec(info);
    if (pages) facts.pdf_pages = Number(pages[1]);
    for (const m of info.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+ x [\d.]+)/gm)) {
      facts.page_sizes.push(m[1]);
    }
    if (!facts.page_sizes.length) {
      const single = /^Page size:\s+([\d.]+ x [\d.]+)/m.exec(info);
      if (single) facts.page_sizes.push(single[1]);
    }
  }
  const text = await poppler("pdftotext", ["-layout", pdfPath, "-"]);
  if (text.startsWith(ERR_PREFIX)) {
    facts.errors.push(`pdftotext: ${text.slice(ERR_PREFIX.length)}`);
  } else {
    facts.markup_leaks = detectMarkupLeaks(text);
  }
  return facts;
}

/**
 * Find markup fragments rendered as body copy.
 *
 * Heuristic and advisory by design. Legitimate prose uses `>` as a comparison
 * (`>212F`, `<4 hr`), so a bare angle bracket is not evidence; the signals
 * here are a word abutting a closing bracket, a whole HTML tag, and an
 * unresolved entity.
 */
export function detectMarkupLeaks(text) {
  const patterns = [
    // A closing bracket welded to a word, not introducing a number: the
    // truncated-tag shape (`gasketed>`), excluding `>= 5` and `>212F`. The
    // lookahead must not span a newline, or a fragment at end-of-line is
    // wrongly excused by whatever digit begins the next line.
    { kind: "truncated_tag", re: /[A-Za-z]{2,}>(?![ \t]*[\d=])/g },
    // A complete HTML tag surviving into the text layer.
    { kind: "html_tag", re: /<\/?(?:div|span|p|li|ul|ol|td|tr|table|section|h[1-6]|br|img)\b[^>]*>/gi },
    // An entity the renderer never resolved.
    { kind: "entity", re: /&(?:amp|lt|gt|nbsp|quot|#\d{2,4});/g },
  ];
  const found = [];
  for (const { kind, re } of patterns) {
    // Per kind, not overall. A shared budget returned from inside the first
    // pattern's loop, so a CSS cheat sheet full of `ul>li` saturated it on
    // `truncated_tag` alone and the genuine `<li>` and `&amp;` behind it were
    // never looked for.
    let perKind = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      found.push({ kind, sample: text.slice(Math.max(0, at - 30), at + 20).replace(/\s+/g, " ") });
      perKind += 1;
      if (perKind >= 4) break;
    }
  }
  return found;
}

