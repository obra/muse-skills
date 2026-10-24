/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
// Renderer only. Icon geometry is never part of this package: a template's build
// resolves the names an artifact imports from `@space/icons` and generates only
// those glyphs on top of these primitives.
export { Icon, createIcon } from "./icon.js";
export type { IconAccessibility, IconAppearance, IconGlyph, IconPath, IconProps, IconSize, IconWeight } from "./types.js";
