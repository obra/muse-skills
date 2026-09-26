import { createElement } from "react";
import type { CSSProperties, HTMLAttributes } from "react";

const TOP_SAFE_AREA_SCRIM_HEIGHT =
  "calc(var(--twsa-safe-area-inset-top) + min(2rem, var(--twsa-safe-area-inset-top)))";
const TOP_SAFE_AREA_INSET_HEIGHT = "var(--twsa-safe-area-inset-top)";
const TOP_SAFE_AREA_GRADIENT_MASK =
  "linear-gradient(to bottom, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 0.99) 10%, rgba(0, 0, 0, 0.96) 20%, rgba(0, 0, 0, 0.90) 30%, rgba(0, 0, 0, 0.80) 40%, rgba(0, 0, 0, 0.67) 50%, rgba(0, 0, 0, 0.52) 60%, rgba(0, 0, 0, 0.36) 70%, rgba(0, 0, 0, 0.20) 80%, rgba(0, 0, 0, 0.08) 90%, rgba(0, 0, 0, 0) 100%)";

export type SafeAreaTopScrimVariant = "gradient" | "blur" | "solid";

export interface SafeAreaTopScrimProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /**
   * Visual treatment for the protected top inset. The component always owns
   * the fixed positioning, z-index, pointer-events behavior, and height.
   */
  variant?: SafeAreaTopScrimVariant;
  /**
   * Background used to keep status-bar text readable. Defaults to `var(--bg)`.
   */
  backgroundColor?: CSSProperties["backgroundColor"];
  /**
   * Stacking layer for the fixed scrim. Defaults to 40 to match z-40.
   */
  zIndex?: CSSProperties["zIndex"];
}

/**
 * Fixed top safe-area protection for Spaces without a top-extending header.
 *
 * It covers the device status-bar inset and, for the default gradient, adds a
 * small fade whose height collapses to zero on desktop. Use `className`,
 * `backgroundColor`, or non-layout `style` values for visual customization;
 * the component intentionally controls the fragile safe-area geometry.
 */
export function SafeAreaTopScrim({
  variant = "gradient",
  backgroundColor,
  zIndex = 40,
  className,
  style,
  ...props
}: SafeAreaTopScrimProps) {
  const resolvedBackgroundColor =
    backgroundColor ?? style?.backgroundColor ?? "var(--bg)";
  const managedStyle: CSSProperties = {
    ...style,
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex,
    pointerEvents: "none",
    height:
      variant === "gradient"
        ? TOP_SAFE_AREA_SCRIM_HEIGHT
        : TOP_SAFE_AREA_INSET_HEIGHT,
    backgroundColor: resolvedBackgroundColor,
  };

  if (variant === "gradient") {
    managedStyle.maskImage = TOP_SAFE_AREA_GRADIENT_MASK;
    managedStyle.WebkitMaskImage = TOP_SAFE_AREA_GRADIENT_MASK;
  } else if (variant === "blur") {
    managedStyle.backdropFilter = style?.backdropFilter ?? "blur(12px)";
    managedStyle.WebkitBackdropFilter =
      style?.WebkitBackdropFilter ?? "blur(12px)";
  }

  return createElement("div", {
    ...props,
    "aria-hidden": props["aria-hidden"] ?? true,
    className,
    style: managedStyle,
  });
}
