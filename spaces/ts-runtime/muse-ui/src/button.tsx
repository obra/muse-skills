/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
// Button and IconButton adapt Dreamer's UI components
// (fbcode/third-party/dreamer/clients/web/src/components/ui/button.tsx and
// icon-button.tsx): Base UI Button, a variant that picks the fill and colors
// set as `--btn-*` custom properties, an optional link form, loading and
// tooltip support. Sizes, type and states follow the Muse web app's own
// buttons (par-msl/hatch HatchButton, HatchIconButton, HatchButtonVariants),
// and colors are the Muse template's semantic roles.
import { Children, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";
import { Button as BaseButton } from "@hatch/base-ui/button";
import { Tooltip } from "@hatch/base-ui/tooltip";
import type { IconGlyph } from "@hatch/space-sdk/icons";
import { Glyph, GlyphSpinner, type GlyphBox } from "./glyph.js";
import { cx, FILLED_HOVER, FOCUS_RING, HOVER_FILL } from "./styles.js";

export type ButtonVariant = "primary" | "secondary" | "outline" | "plain" | "destructive";
export type ButtonSize = "32" | "36" | "44";
export type IconButtonSize = "32" | "36" | "44" | "48";

// Each variant is a fill style plus the color roles it reads, as custom
// properties, so the fill recipes stay shared.
const COLORS: Record<ButtonVariant, string> = {
  primary: "[--btn-color:var(--primary)] [--btn-on-color:var(--primary-foreground)]",
  destructive: "[--btn-color:var(--destructive)] [--btn-on-color:var(--destructive-foreground)]",
  secondary: "[--btn-color:var(--secondary)] [--btn-on-color:var(--secondary-foreground)]",
  outline: "[--btn-on-color:var(--foreground)] [--btn-border:var(--border)]",
  plain: "[--btn-on-color:var(--foreground)]",
};

const FILLS: Record<ButtonVariant, string> = {
  primary: cx("bg-(--btn-color) text-(--btn-on-color)", FILLED_HOVER),
  destructive: cx("bg-(--btn-color) text-(--btn-on-color)", FILLED_HOVER),
  secondary: cx("bg-(--btn-color) text-(--btn-on-color)", FILLED_HOVER),
  outline: cx("border border-(--btn-border) text-(--btn-on-color)", HOVER_FILL),
  plain: cx("text-(--btn-on-color)", HOVER_FILL),
};

// Immediate hover and press with no scale; the ring only on keyboard focus;
// disabled reads from Base UI's data-disabled, which pairs with aria-disabled.
const BASE =
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap data-disabled:pointer-events-none data-disabled:opacity-50";

const BUTTON_SIZES: Record<ButtonSize, string> = {
  "32": "h-8 px-3 text-subheadline",
  "36": "h-9 px-3.5 text-subheadline font-medium",
  "44": "h-11 px-4 text-body-status font-medium",
};
const LEADING_ICON_PADDING: Record<ButtonSize, string> = { "32": "ps-2", "36": "ps-2.5", "44": "ps-3" };
const TRAILING_ICON_PADDING: Record<ButtonSize, string> = { "32": "pe-2", "36": "pe-2.5", "44": "pe-3" };

const ICON_BUTTON_SIZES: Record<IconButtonSize, string> = {
  "32": "size-8",
  "36": "size-9",
  "44": "size-11",
  "48": "size-12",
};
// HatchIconButton's icon box per size; the glyph paints at 75% of it.
const ICON_BUTTON_BOX: Record<IconButtonSize, GlyphBox> = { "32": 20, "36": 28, "44": 20, "48": 24 };

/** The class recipe shared by Button and Toolbar.Button. */
export function buttonClasses(options: {
  variant: ButtonVariant;
  size: ButtonSize;
  radius?: "full" | "large";
  leadingIcon?: boolean;
  trailingIcon?: boolean;
  className?: string;
}): string {
  return cx(
    BASE,
    "gap-0.5",
    options.radius === "large" ? "rounded-lg" : "rounded-full",
    COLORS[options.variant],
    FILLS[options.variant],
    BUTTON_SIZES[options.size],
    options.leadingIcon && LEADING_ICON_PADDING[options.size],
    options.trailingIcon && TRAILING_ICON_PADDING[options.size],
    FOCUS_RING,
    options.className,
  );
}

/** The class recipe shared by IconButton and icon-only Toolbar.Button. */
export function iconButtonClasses(options: {
  variant: ButtonVariant;
  size: IconButtonSize;
  className?: string;
}): string {
  return cx(
    BASE,
    "rounded-full",
    COLORS[options.variant],
    FILLS[options.variant],
    ICON_BUTTON_SIZES[options.size],
    FOCUS_RING,
    options.className,
  );
}

export function iconButtonBox(size: IconButtonSize): GlyphBox {
  return ICON_BUTTON_BOX[size];
}

const wrapStrings = (children: ReactNode) =>
  Children.map(children, (child) =>
    typeof child === "string" ? <span className="truncate">{child}</span> : child,
  );

type NativeButtonProps = Omit<ComponentPropsWithRef<"button">, "children" | "className" | "disabled">;

export type ButtonProps = NativeButtonProps & {
  children?: ReactNode;
  /** `primary` (default) fills with the accent; `secondary` a neutral fill; `outline`; `plain` (no fill); `destructive`. */
  variant?: ButtonVariant;
  /** Height in px: 32, 36 (default) or 44. */
  size?: ButtonSize;
  /** `full` (default) or `large` (12px corners). */
  radius?: "full" | "large";
  /** A glyph from `@space/icons`, drawn before the label (20px box, 15px glyph). */
  icon?: IconGlyph;
  /** A glyph from `@space/icons`, drawn after the label (20px box, 15px glyph). */
  trailingIcon?: IconGlyph;
  /** Renders a link instead of a button. */
  href?: string;
  /** With `href`, opens in a new tab with `rel="noopener noreferrer"`. */
  external?: boolean;
  disabled?: boolean;
  /** Shows a spinner, disables the button and marks it busy. */
  loading?: boolean;
  /** Replaces the label while loading. */
  loadingText?: string;
  className?: string;
};

/**
 * A button after the Muse web app's: fully round, 14 or 17px medium label,
 * 20px glyphs. Disabled and loading buttons stay focusable and announced
 * (`aria-disabled`) but do nothing.
 */
export function Button({
  variant = "primary",
  size = "36",
  radius = "full",
  icon,
  trailingIcon,
  href,
  external = false,
  disabled = false,
  loading = false,
  loadingText,
  children,
  className,
  type,
  ...rest
}: ButtonProps): ReactElement {
  const classes = buttonClasses({
    variant,
    size,
    radius,
    leadingIcon: icon != null || loading,
    trailingIcon: trailingIcon != null && !loading,
    className,
  });
  const content = loading ? (
    <>
      <GlyphSpinner box={20} className="m-0.5" />
      {loadingText == null ? wrapStrings(children) : <span className="truncate">{loadingText}</span>}
    </>
  ) : (
    <>
      {icon == null ? null : <Glyph glyph={icon} box={20} className="m-0.5" />}
      {wrapStrings(children)}
      {trailingIcon == null ? null : <Glyph glyph={trailingIcon} box={20} className="m-0.5" />}
    </>
  );
  if (href != null) {
    // A link keeps its link role (Base UI's non-native button would announce
    // a button); disabled, it drops its href and keeps the disabled look.
    const inert = disabled || loading;
    return (
      <a
        {...(rest as unknown as ComponentPropsWithRef<"a">)}
        href={inert ? undefined : href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        aria-disabled={inert || undefined}
        aria-busy={loading || undefined}
        data-disabled={inert ? "" : undefined}
        className={classes}
      >
        {content}
      </a>
    );
  }
  return (
    <BaseButton
      {...rest}
      type={type ?? "button"}
      disabled={disabled || loading}
      focusableWhenDisabled
      aria-busy={loading || undefined}
      className={classes}
    >
      {content}
    </BaseButton>
  );
}

export type IconButtonProps = Omit<NativeButtonProps, "aria-label"> & {
  /** A glyph from `@space/icons`. */
  icon: IconGlyph;
  /** The accessible name; required because the button has no text. */
  label: string;
  /** `plain` (default), `secondary`, `outline`, `primary` or `destructive`. */
  variant?: ButtonVariant;
  /** 32, 36 (default), 44 or 48: glyph boxes of 20, 28, 20 and 24px, painted at 15, 21, 15 and 18px. */
  size?: IconButtonSize;
  disabled?: boolean;
  loading?: boolean;
  /** Text shown on hover and keyboard focus. */
  tooltip?: string;
  /** Hover delay before the tooltip, in ms (default 500). */
  tooltipDelay?: number;
  className?: string;
};

/**
 * A round icon-only button after the Muse web app's. `label` names it for
 * assistive tech; `tooltip` shows a visible hint on hover and focus.
 */
export function IconButton({
  icon,
  label,
  variant = "plain",
  size = "36",
  disabled = false,
  loading = false,
  tooltip,
  tooltipDelay = 500,
  className,
  type = "button",
  ...rest
}: IconButtonProps): ReactElement {
  const box = ICON_BUTTON_BOX[size];
  const button = (
    <BaseButton
      {...rest}
      type={type}
      aria-label={label}
      disabled={disabled || loading}
      focusableWhenDisabled
      aria-busy={loading || undefined}
      className={iconButtonClasses({ variant, size, className })}
    >
      {loading ? (
        <GlyphSpinner box={box} className="m-0.5" />
      ) : (
        <Glyph glyph={icon} box={box} className="m-0.5" />
      )}
    </BaseButton>
  );
  if (tooltip == null) return button;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={button} delay={tooltipDelay} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8} collisionPadding={8} className="z-50">
          <Tooltip.Popup className="rounded-lg bg-foreground px-2 py-1 text-footnote text-background">
            {tooltip}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
