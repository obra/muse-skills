/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import { iconLabel, iconSize, type IconAccessibility, type IconAppearance, type IconGlyph } from "./types.js";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Materialize a selected glyph as inline markup; no React, script, image or font loader. */
export function renderIconSvg(props: Omit<IconAppearance, "color"> & IconAccessibility & { glyph: IconGlyph }): string {
  const label = iconLabel(props);
  const size = iconSize(props.size);
  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"',
    `viewBox="${escape(props.glyph.viewBox)}"`,
    `width="${size}"`, `height="${size}"`, 'fill="none"', 'focusable="false"',
    label == null ? 'aria-hidden="true"' : `role="img" aria-label="${escape(label)}"`,
  ];
  if (props.className != null) attrs.push(`class="${escape(props.className)}"`);
  const paths = props.glyph.paths.map((path) => {
    const attrs = Object.entries(path)
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${escape(String(value))}"`);
    return `<path ${attrs.join(" ")}/>`;
  });
  return `<svg ${attrs.join(" ")}>${paths.join("")}</svg>`;
}

export type { IconGlyph, IconPath, IconProps, IconSize, IconWeight } from "./types.js";
