// Readability-floor evaluation for a rendered PDF's text.
//
// The overflow and geometry gates check FIT, so the cheapest way to satisfy
// them is to shrink type and spacing until the content squeezes in: a
// recovered production build resolved a 268px overflow by dropping body text
// to 9.3pt, source lines to 6.6pt, and list margins to 0.45mm, and the gates
// then passed. Builders treat the gate verdict as authoritative, so the fix
// has to live in the verdict: a page that fits at an unreadable size fails
// here, and the only remaining moves are cutting content or adding a page,
// which is what the workflow copy asks for.
//
// Findings follow the geometry gate's split:
//
//   failures   — text rendered below MIN_TEXT_PT. Computed from the runs'
//                measured sizes alone; no interpretation. Single-glyph runs
//                (decorative bullets, icon characters) are exempt via
//                GATED_MIN_CHARS so a 7pt "•" cannot fail a build.
//   advisories — a document whose body text sits mostly below BODY_TARGET_PT.
//                Reported, never gated: a deliberately compact reference card
//                at 9.5pt body is a judgment call the builder owns.

const PT_PER_CSS_PX = 72 / 96;
// The workflow copy's floor: nothing anywhere below 8pt.
export const MIN_TEXT_PT = 8;
// The workflow copy's body target: 10pt or larger.
export const BODY_TARGET_PT = 10;
// Sub-pixel slack: computed style reports px floats, and exactly-8pt text can
// round-trip to 7.98pt. Text at the floor passes; text meaningfully below
// fails.
const FLOOR_TOLERANCE_PT = 0.05;
// The LARGEST SINGLE TEXT NODE at the size must carry at least this many
// non-whitespace characters to gate. Judged per node, not per summed run:
// three separate one-glyph markers (footnote superscripts, bullet
// separators) sum to three characters but remain individually decorative.
export const GATED_MIN_CHARS = 2;

export function cssPxToPt(px) {
  return px * PT_PER_CSS_PX;
}

/**
 * @param {Array<{index:number, runs:Array<{pt:number, chars:number, max_node_chars?:number, sample:string}>}>} pages
 *   One entry per page-selector element, `runs` aggregated per computed size:
 *   `pt` the computed font size in points, `chars` the non-whitespace
 *   character count rendered at that size, `max_node_chars` the largest
 *   single text node's count (defaults to `chars` when absent), `sample`
 *   the head of one such run.
 * @returns {{failures: Finding[], advisories: Finding[]}} where a Finding is
 *   `{kind, message}`. The `kind` is the stable contract: tests assert on it,
 *   because the message is model-facing copy this repo tunes, and pinning
 *   wording turns a copy edit into a red suite with no behavior change.
 */
export function evaluateTextFloor(pages) {
  const failures = [];
  const advisories = [];
  const perPageViolations = [];
  let totalChars = 0;
  const charsByPt = new Map();

  for (const page of pages || []) {
    const violations = [];
    for (const run of page.runs || []) {
      if (!Number.isFinite(run.pt) || run.chars <= 0) continue;
      totalChars += run.chars;
      charsByPt.set(run.pt, (charsByPt.get(run.pt) ?? 0) + run.chars);
      const largestNode = run.max_node_chars ?? run.chars;
      if (run.pt < MIN_TEXT_PT - FLOOR_TOLERANCE_PT && largestNode >= GATED_MIN_CHARS) {
        violations.push(run);
      }
    }
    if (violations.length > 0) {
      violations.sort((a, b) => a.pt - b.pt);
      perPageViolations.push({ index: page.index, violations });
    }
  }

  if (perPageViolations.length > 0) {
    const shown = perPageViolations.slice(0, 3).map((entry) => {
      const worst = entry.violations[0];
      const sample = worst.sample ? ` e.g. "${worst.sample.slice(0, 40)}"` : "";
      return `${entry.index + 1}: ${worst.pt}pt${sample}`;
    });
    const omitted = perPageViolations.length - shown.length;
    const pageList = perPageViolations.map((entry) => entry.index + 1).join(", ");
    failures.push({
      kind: "text_below_floor",
      message:
        `text below the ${MIN_TEXT_PT}pt readability floor on page(s) ${pageList} ` +
        `(${shown.join("; ")}${omitted > 0 ? `; ${omitted} more` : ""}); ` +
        "fix by cutting content or adding a page, never by shrinking further",
    });
  }

  // Char-weighted median across every measured run: the size a typical
  // character is set at. Headings pull it up a little; a crushed document
  // sits clearly below the target.
  if (totalChars > 0) {
    const buckets = [...charsByPt.entries()].sort((a, b) => a[0] - b[0]);
    let seen = 0;
    let median = buckets[buckets.length - 1][0];
    for (const [pt, chars] of buckets) {
      seen += chars;
      if (seen >= totalChars / 2) {
        median = pt;
        break;
      }
    }
    if (median < BODY_TARGET_PT) {
      advisories.push({
        kind: "body_below_target",
        message:
          `most text renders at ${median}pt, below the ${BODY_TARGET_PT}pt body target; ` +
          "acceptable only when the brief asks for a compact document",
      });
    }
  }

  return { failures, advisories };
}
