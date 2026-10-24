/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import type { CSSProperties } from "react";

export type IconWeight = 300 | 400 | 500 | 600 | 700;
export type IconSize = 12 | 16 | 20 | 24 | 32 | 40 | 48;
export type IconPath = Readonly<{
  d: string;
  fill: "none" | "currentColor";
  fillRule?: "nonzero" | "evenodd";
  clipRule?: "nonzero" | "evenodd";
  opacity?: number;
  stroke?: "currentColor";
  strokeWidth?: number;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
}>;

/** Geometry is selected by import, not by a runtime catalog lookup. */
export type IconGlyph<Name extends string = string, Weight extends IconWeight = IconWeight> = Readonly<{
  name: Name;
  weight: Weight;
  viewBox: "0 0 24 24";
  paths: readonly IconPath[];
}>;

export type IconAppearance = Readonly<{
  size?: IconSize;
  color?: CSSProperties["color"];
  className?: string;
}>;

export type IconAccessibility =
  | Readonly<{ label: string; decorative?: false }>
  | Readonly<{ label?: never; decorative?: true }>;

export type IconProps = IconAppearance & IconAccessibility & Readonly<{ glyph: IconGlyph }>;

export function iconLabel(props: IconAccessibility): string | null {
  if (props.decorative === true || props.label == null) return null;
  if (props.label.trim().length === 0) throw new Error("A meaningful icon needs a non-empty label");
  return props.label;
}

export function iconSize(size: IconSize = 24): IconSize {
  if (![12, 16, 20, 24, 32, 40, 48].includes(size)) throw new Error("Unsupported icon size");
  return size;
}
