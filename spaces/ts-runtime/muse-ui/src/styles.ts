/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
// Shared class names and safe-area geometry. Colors are the Muse template's
// semantic roles (bg-popover, text-foreground, bg-primary, ...), so components
// follow the shell's light/dark and accent and any color a Space pins. Type uses
// the Muse ramp (text-subheadline, text-title-3, ...). The Space's Tailwind
// build sees these strings through the `@source` line in the Muse theme.css.

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** One side's safe-area inset as CSS, with the SDK's variable first. */
function inset(side: "top" | "right" | "bottom" | "left"): string {
  return `var(--twsa-safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;
}

// UM elevation shadows (Hatch --shadow-elevation-1 and -3).
export const ELEVATION_1 =
  "shadow-[0_2px_8px_0_rgba(17,17,18,0.08),0_2px_16px_0_rgba(17,17,18,0.04)]";
export const ELEVATION_3 =
  "shadow-[0_6px_16px_0_rgba(17,17,18,0.16),0_8px_32px_0_rgba(17,17,18,0.12)]";

/** Hover and keyboard highlight for unfilled controls and menu rows. */
export const HOVER_FILL = "hover:bg-foreground/5 dark:hover:bg-foreground/12";
export const HIGHLIGHT_FILL =
  "data-highlighted:bg-foreground/5 dark:data-highlighted:bg-foreground/12";

/** Hover feedback for controls that already have a fill. */
export const FILLED_HOVER = "hover:brightness-95 dark:hover:brightness-110";

export const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Open and close transition shared by popups. */
export const POPUP_TRANSITION =
  "transition-[opacity,scale] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:ease-in motion-reduce:transition-none";

export type SafeAreaInsets = { top: number; right: number; bottom: number; left: number };

export const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The current safe-area insets in CSS pixels, measured through the same
 * variables the layout uses. Popups add them to their collision padding so a
 * menu never opens under the status bar or the home indicator.
 */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === "undefined" || document.body == null) return NO_INSETS;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:0",
    "height:0",
    "visibility:hidden",
    "pointer-events:none",
    `padding-top:${inset("top")}`,
    `padding-right:${inset("right")}`,
    `padding-bottom:${inset("bottom")}`,
    `padding-left:${inset("left")}`,
  ].join(";");
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}
