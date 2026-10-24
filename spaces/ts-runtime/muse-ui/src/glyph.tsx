/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import type { ReactElement } from "react";
import { Icon, type IconGlyph } from "@hatch/space-sdk/icons";
import { cx } from "./styles.js";

/**
 * The box sizes the components give a glyph, as the Muse web app's
 * `HatchIcon` does: XMDS glyphs fill their viewBox edge to edge, so Hatch lays
 * out a `size` box and paints the glyph at round(size × 0.75), centered.
 */
export type GlyphBox = 20 | 24 | 28;

const BOX: Record<GlyphBox, string> = { 20: "size-5", 24: "size-6", 28: "size-7" };
// round(box × 0.75): 15, 18 and 21px. The SDK draws only 12/16/20/24/32/40/48,
// so the painted size comes from CSS width/height, which override the SVG's
// width/height attributes; the viewBox scales the paths.
const PAINT: Record<GlyphBox, string> = { 20: "size-3.75", 24: "size-4.5", 28: "size-5.25" };
const SDK_SIZE: Record<GlyphBox, 20 | 24> = { 20: 20, 24: 24, 28: 24 };

/** A decorative glyph in its Hatch box. */
export function Glyph({
  glyph,
  box,
  className,
}: {
  glyph: IconGlyph;
  box: GlyphBox;
  className?: string;
}): ReactElement {
  return (
    <span aria-hidden="true" className={cx("inline-flex shrink-0 items-center justify-center", BOX[box], className)}>
      <Icon glyph={glyph} size={SDK_SIZE[box]} decorative className={PAINT[box]} />
    </span>
  );
}

/** A loading spinner in a glyph box, sized to the painted glyph. */
export function GlyphSpinner({ box, className }: { box: GlyphBox; className?: string }): ReactElement {
  return (
    <span aria-hidden="true" className={cx("inline-flex shrink-0 items-center justify-center", BOX[box], className)}>
      <span
        className={cx(
          "inline-block animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none",
          PAINT[box],
        )}
      />
    </span>
  );
}
