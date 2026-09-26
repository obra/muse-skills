// Effective-resolution evaluation for a rendered PDF's images.
//
// The prose used to legislate embed widths (source 1600px+, embed at twice
// the rendered CSS width) because nothing downstream could see a blurry
// hero: the 150 DPI read-back UPSAMPLES a low-resolution image rather than
// exposing it, so the builder's own review shows a crisper page than the
// one that ships. Measured on the PR 18400 A/B waves, roughly 1 in 6
// sourced photos was below 800px. This gate makes the ratio observable so
// judgment can move back to the builder.
//
// Findings follow the geometry/text-floor split:
//
//   failures   — an image UPSCALED past its own pixels (embedded width
//                meaningfully below its rendered CSS width). Blurry on
//                every surface, print and 1x screens included; no design
//                intent produces it. Small decorative slots are exempt via
//                MIN_GATED_RENDER_PX so an icon cannot fail a build.
//   advisories — an image below the sharp target (twice its rendered CSS
//                width: retina displays paint two physical pixels per CSS
//                pixel and print rasterizes near 150 DPI). Reported, never
//                gated: the next-best available source may simply be
//                smaller than ideal, and an honest slightly-soft real
//                photo beats a fabricated sharp one.

// Below this rendered width the slot is decorative (an icon, a favicon, a
// list marker); upscaling there is invisible at reading distance.
export const MIN_GATED_RENDER_PX = 100;
// The sharp target: embedded pixels per rendered CSS pixel.
export const TARGET_RATIO = 2;
// Upscale tolerance: sub-pixel layout rounding must not fail an exact-fit
// image, so an image gates only when it is meaningfully short of its box.
const UPSCALE_TOLERANCE = 0.98;

/**
 * @param {Array<{index:number, images:Array<{rendered_w:number, natural_w:number, src_head:string}>}>} pages
 *   One entry per page-selector element; `images` carries every decoded
 *   content image: `rendered_w` its CSS layout width, `natural_w` the
 *   embedded bitmap's width, `src_head` the head of its src for naming.
 * @returns {{failures: Finding[], advisories: Finding[]}} where a Finding
 *   is `{kind, message}`. Assert on `kind` in tests, never wording.
 */
export function evaluateImageResolution(pages) {
  const failures = [];
  const advisories = [];
  const upscaled = [];
  const soft = [];

  for (const page of pages || []) {
    for (const img of page.images || []) {
      if (!Number.isFinite(img.rendered_w) || !Number.isFinite(img.natural_w)) continue;
      if (img.rendered_w < MIN_GATED_RENDER_PX || img.natural_w <= 0) continue;
      const ratio = img.natural_w / img.rendered_w;
      if (ratio < UPSCALE_TOLERANCE) {
        upscaled.push({ page: page.index, ...img, ratio });
      } else if (ratio < TARGET_RATIO) {
        soft.push({ page: page.index, ...img, ratio });
      }
    }
  }

  if (upscaled.length > 0) {
    upscaled.sort((a, b) => a.ratio - b.ratio);
    const worst = upscaled[0];
    const pageList = [...new Set(upscaled.map((u) => u.page + 1))].join(", ");
    failures.push({
      kind: "image_upscaled",
      message:
        `${upscaled.length} image(s) render wider than their own pixels on page(s) ${pageList} ` +
        `(worst: ${worst.natural_w}px shown at ${Math.round(worst.rendered_w)}px, ` +
        `"${(worst.src_head || "").slice(0, 40)}"); they print blurry. ` +
        "Source a larger image or render the slot smaller; never stretch pixels",
    });
  }
  if (soft.length > 0) {
    soft.sort((a, b) => a.ratio - b.ratio);
    const worst = soft[0];
    advisories.push({
      kind: "image_below_target",
      message:
        `${soft.length} image(s) sit below the sharp target of ${TARGET_RATIO}x their rendered ` +
        `width (worst ${worst.natural_w}px at ${Math.round(worst.rendered_w)}px); fine if no ` +
        "larger source exists, soft in print and on retina screens otherwise",
    });
  }
  return { failures, advisories };
}
