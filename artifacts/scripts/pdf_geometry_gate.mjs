// Geometry evaluation for a rendered PDF.
//
// The pre-existing overflow probe measures element SELF-overflow
// (`scrollHeight > clientHeight`). A page wrapper declared `height: auto`
// grows to fit its content, so scrollHeight equals clientHeight and the probe
// reports zero no matter how much content there is. Whether it can fire at all
// therefore depends on whether the author happened to set a height — a gate
// armed at the model's discretion, per artifact.
//
// This module measures the thing that actually matters instead: a page wrapper
// TALLER THAN THE PAPER will be split by Chromium's paginator, wherever the
// split happens to land. That is computable from the wrapper's rendered height
// and the emitted page box, and no CSS choice can disarm it.
//
// Findings are split deliberately, and the split follows the measurement:
//
//   failures   — computed from page counts and box heights alone (pdfinfo and
//                the DOM). A wrapper that cannot fit, and an authored page
//                count that does not match the produced one. Both are integer
//                comparisons with no interpretation in them.
//   advisories — a probe that could not measure, and markup that reached the
//                page as body text. Reported, never gated.
//
// Nothing here reads the page raster. `validate_pdf.sh` already renders every
// page at full resolution and pdf.md already requires the model to look at
// those PNGs, so a second low-resolution rasterization only re-measured, less
// well, what a reader is already obliged to see.

const PT_PER_CSS_PX = 72 / 96;
// A wrapper within this much of the paper height still fits: sub-pixel
// rounding and border collapse move the measured height by a hair.
const FIT_TOLERANCE_PX = 2;

export function paperHeightCssPx(paperHeightPt) {
  if (!Number.isFinite(paperHeightPt) || paperHeightPt <= 0) return null;
  return paperHeightPt / PT_PER_CSS_PX;
}

/**
 * @param {object} facts
 * @param {number|null} facts.paperHeightPt   emitted PDF page height, points
 * @param {Array<{index:number, rectH:number}>} facts.wrappers  rendered page boxes
 * @param {number|null} facts.pdfPages        page count in the emitted PDF
 * @param {Array<object>} facts.markupLeaks   markup rendered as body text
 * @param {Array<string>} facts.probeErrors    measurement failures, if any
 * @returns {{failures: Finding[], advisories: Finding[]}} where a Finding is
 *   `{kind, message}`. The `kind` is the stable contract: tests assert on it,
 *   because the message is model-facing copy this repo tunes, and pinning
 *   wording turns a copy edit into a red suite with no behavior change.
 */
export function evaluatePdfGeometry(facts) {
  const failures = [];
  const advisories = [];
  const fail = (kind, message) => failures.push({ kind, message });
  const advise = (kind, message) => advisories.push({ kind, message });
  const wrappers = facts.wrappers || [];
  const paperPx = paperHeightCssPx(facts.paperHeightPt);

  // A probe that could not measure reports exactly like a clean document:
  // empty failures, empty advisories. Say so instead, or an ops regression
  // (poppler missing, a pdftoppm timeout) reads as a gated pass.
  const probeErrors = facts.probeErrors || [];
  if (probeErrors.length) {
    advise(
      "not_measured",
      `geometry could not be measured (${probeErrors.join("; ")}); ` +
        "these checks did not run",
    );
  }

  // A wrapper taller than the paper WILL be split. This is the real overflow.
  if (paperPx !== null) {
    for (const w of wrappers) {
      if (!Number.isFinite(w.rectH)) continue;
      const over = w.rectH - paperPx;
      if (over > FIT_TOLERANCE_PX) {
        // 1-based, matching the blank/margin findings and the page-NN.png a
        // reader opens next. The DOM index is 0-based; mixing the two had one
        // report name the same sheet "page element 6" and "blank page 7".
        fail(
          "wrapper_taller_than_paper",
          `page ${w.index + 1} is ${Math.round(over)}px taller than the ` +
            `page box (${Math.round(w.rectH)}px content vs ` +
            `${Math.round(paperPx)}px paper); it will be split across pages`,
        );
      }
    }
  }

  // The author declared N pages; the PDF has M. Something split or collapsed.
  if (
    Number.isFinite(facts.pdfPages) &&
    wrappers.length > 0 &&
    facts.pdfPages !== wrappers.length
  ) {
    fail(
      "pagination_mismatch",
      `${wrappers.length} page element(s) rendered ${facts.pdfPages} PDF ` +
        "page(s); pagination does not match the authored structure",
    );
  }

  const leaks = facts.markupLeaks || [];
  if (leaks.length) {
    const sample = leaks[0]?.sample ? ` e.g. "${leaks[0].sample.trim().slice(0, 60)}"` : "";
    advise(
      "markup_leak",
      `${leaks.length} markup fragment(s) rendered as body text${sample}; ` +
        "a reader sees these; ignore them if the document quotes code on purpose",
    );
  }

  return { failures, advisories };
}
