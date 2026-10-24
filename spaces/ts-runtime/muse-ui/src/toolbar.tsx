/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import {
  Children,
  Fragment,
  isValidElement,
  type ComponentPropsWithRef,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";
import type { IconGlyph } from "@hatch/space-sdk/icons";
import { buttonClasses, iconButtonBox, iconButtonClasses } from "./button.js";
import { Glyph } from "./glyph.js";
import { BackGlyph } from "./glyphs.js";
import { useSidebarLayout, type LeadingRanked } from "./layout-context.js";
import { cx } from "./styles.js";
import { Toolbar as BaseToolbar } from "@hatch/base-ui/toolbar";

export type ToolbarProps = {
  /**
   * The current view or selection, such as the open note's title or
   * "Archive", drawn after `leading`. Never the app's name: Hatch's header
   * already shows it. Omit it and the actions sit on their own.
   */
  title?: ReactNode;
  /** `Toolbar.Back` and `Sidebar.Toggle` (in that order), or other controls before the title. */
  leading?: ReactNode;
  /** Controls at the end of the bar. */
  children?: ReactNode;
  /** Accessible name of the toolbar; defaults to a string `title`. */
  label?: string;
  /** `sticky` (default) pins the bar to the top while the page scrolls. */
  position?: "sticky" | "static";
  className?: string;
};

function flattenLeading(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flattenLeading(child.props.children)
      : [child],
  );
}

function leadingRank(child: ReactNode): number {
  if (!isValidElement(child) || typeof child.type === "string") return 2;
  return (child.type as LeadingRanked).leadingRank ?? 2;
}

/** The leading controls with `Toolbar.Back` first and `Sidebar.Toggle` second. */
function orderLeading(leading: ReactNode): ReactNode[] {
  return flattenLeading(leading)
    .map((child, index) => ({ child, index }))
    .sort((a, b) => leadingRank(a.child) - leadingRank(b.child) || a.index - b.index)
    .map(({ child }, index) => <Fragment key={index}>{child}</Fragment>);
}

/**
 * A top app bar with the geometry of the Muse web app's artifact title bar,
 * which sits directly above a Space on desktop: a 60px row, 20px start and
 * 12px end padding, a leading group with 12px gaps and an actions group with
 * 8px gaps, so a trailing 36px icon button lines up under Hatch's close
 * button. Arrow keys move between its buttons. It pads for the top and side
 * safe-area insets itself, so use it instead of `SafeAreaTopScrim`, never with
 * it. Inside `Sidebar.Layout` on md and up it sits beside the sidebar, away
 * from the screen's start edge, so it drops the start inset there.
 */
function ToolbarRoot({
  title,
  leading,
  children,
  label,
  position = "sticky",
  className,
}: ToolbarProps): ReactElement {
  const besideSidebar = useSidebarLayout() != null;
  return (
    // tailwindcss-safe-area: pt-safe draws the bar beneath the status bar and
    // keeps its 60px row below it; the row's start and end padding (20px and
    // 12px, as in Hatch's title bar) are offsets on top of the side insets.
    <header
      className={cx(
        "z-30 w-full shrink-0 border-b border-border bg-background pt-safe text-foreground",
        position === "sticky" && "sticky top-0",
        className,
      )}
    >
      <BaseToolbar.Root
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        className={cx(
          "flex h-15 items-center gap-2 ps-safe-offset-5 pe-safe-offset-3",
          besideSidebar && "md:ps-5",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {leading == null ? null : orderLeading(leading)}
          {title == null ? null : (
            <h1 className="min-w-0 truncate text-title-2 font-semibold">{title}</h1>
          )}
        </div>
        {children == null ? null : <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </BaseToolbar.Root>
    </header>
  );
}

export type ToolbarButtonProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  /** Accessible name; also the visible text when there is no icon or `showLabel` is set. */
  label: string;
  /** A glyph from `@space/icons`. With an icon and no `showLabel`, the button is icon-only. */
  icon?: IconGlyph;
  showLabel?: boolean;
  /** `primary` fills the button with the accent color. */
  variant?: "plain" | "primary";
};

/**
 * A toolbar control with the same look as `Button` and `IconButton` (36px).
 * Pass it as a `Menu` or `Dialog` trigger to open one.
 */
function ToolbarButton({
  label,
  icon,
  showLabel = false,
  variant = "plain",
  className,
  type = "button",
  ...rest
}: ToolbarButtonProps): ReactElement {
  const iconOnly = icon != null && !showLabel;
  return (
    <BaseToolbar.Button
      {...rest}
      type={type}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={
        iconOnly
          ? iconButtonClasses({ variant, size: "36", className })
          : buttonClasses({ variant, size: "36", leadingIcon: icon != null, className })
      }
    >
      {icon == null ? null : <Glyph glyph={icon} box={iconOnly ? iconButtonBox("36") : 20} className="m-0.5" />}
      {iconOnly ? null : <span className="truncate">{label}</span>}
    </BaseToolbar.Button>
  );
}

export type ToolbarBackProps =
  | { label?: string; onClick: MouseEventHandler<HTMLButtonElement>; href?: never }
  | { label?: string; href: string; onClick?: never };

/**
 * The icon-only back button for the leading slot: the 36px plain icon button
 * with the Muse web app's back chevron, mirrored in right-to-left layouts. A
 * `href` renders a real link.
 */
function ToolbarBack({ label = "Back", onClick, href }: ToolbarBackProps): ReactElement {
  const className = iconButtonClasses({ variant: "plain", size: "36", className: "text-muted-foreground" });
  const glyph = <Glyph glyph={BackGlyph} box={iconButtonBox("36")} className="m-0.5 rtl:-scale-x-100" />;
  if (href != null) {
    return (
      <BaseToolbar.Link href={href} aria-label={label} title={label} className={className}>
        {glyph}
      </BaseToolbar.Link>
    );
  }
  return (
    <BaseToolbar.Button type="button" onClick={onClick} aria-label={label} title={label} className={className}>
      {glyph}
    </BaseToolbar.Button>
  );
}
(ToolbarBack as LeadingRanked).leadingRank = 0;

function ToolbarSeparator(): ReactElement {
  return <BaseToolbar.Separator className="h-4 w-px shrink-0 self-center bg-border" />;
}

export const Toolbar = Object.assign(ToolbarRoot, {
  Back: ToolbarBack,
  Button: ToolbarButton,
  Separator: ToolbarSeparator,
});
