/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { IconGlyph } from "@hatch/space-sdk/icons";
import { Glyph } from "./glyph.js";
import { MenuGlyph, SearchGlyph } from "./glyphs.js";
import {
  SidebarLayoutContext,
  SidebarPlacementContext,
  useSidebarLayout,
  type LeadingRanked,
  type SidebarLayoutState,
} from "./layout-context.js";
import { cx, ELEVATION_3, FOCUS_RING, HOVER_FILL } from "./styles.js";
import { Toolbar } from "./toolbar.js";
import { Drawer as BaseDrawer } from "@hatch/base-ui/drawer";

// Geometry and treatment follow the Muse web app's Library sidebar
// (par-msl/hatch app/_router/routes/hatch/LibrarySidebarNav.react.tsx and
// nav/): a 240px column on the page background with a divider on its end
// edge, a 60px header row, 12px side padding, 36px rows with 12px corners, a
// 24px icon box, subheadline labels, caption trailing text, and the same
// translucent fill for hover and the selected row.

/** Tailwind's `md` breakpoint, where the sidebar moves out of the drawer. */
const DESKTOP_QUERY = "(min-width: 48rem)";

const SIDEBAR_SURFACE = "flex flex-col overflow-hidden border-e border-border bg-background text-foreground";

// 240px plus the start inset, padded by it, so the column keeps 240px of
// content beside a landscape notch.
const SIDEBAR_WIDTH = "w-[calc(240px+var(--twsa-safe-area-inset-left,0px))] pt-safe pb-safe ps-safe";

export type SidebarLayoutProps = {
  /** A `Sidebar`: beside the content on md and up, a drawer from the start edge below. */
  sidebar: ReactNode;
  /** The content column: its `Toolbar`, then the page. */
  children?: ReactNode;
  className?: string;
};

/**
 * The shell for a sidebar app. On md and up the sidebar runs the full
 * viewport height on the start side and the content column (with its sticky
 * `Toolbar`) scrolls beside it. Below md the sidebar opens as a modal drawer
 * from `Sidebar.Toggle`: it traps focus, closes on Escape, an outside tap or
 * choosing an item, and returns focus to the toggle.
 */
function SidebarLayout({ sidebar, children, className }: SidebarLayoutProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<"left" | "right">("left");
  const state = useMemo<SidebarLayoutState>(() => ({ open, setOpen }), [open]);

  // Widening past the breakpoint shows the inline sidebar; drop the drawer.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const close = () => {
      if (query.matches) setOpen(false);
    };
    close();
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, [open]);

  return (
    <SidebarLayoutContext.Provider value={state}>
      <BaseDrawer.Root
        open={open}
        swipeDirection={swipeDirection}
        onOpenChange={(next) => {
          if (next && typeof document !== "undefined") {
            setSwipeDirection(getComputedStyle(document.documentElement).direction === "rtl" ? "right" : "left");
          }
          setOpen(next);
        }}
      >
        <div className={cx("flex min-h-dvh w-full", className)}>
          {sidebar}
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </div>
        <BaseDrawer.Portal>
          <BaseDrawer.Backdrop className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none dark:bg-black/40" />
          <BaseDrawer.Viewport className="fixed inset-0 z-50">
            <SidebarPlacementContext.Provider value="drawer">{sidebar}</SidebarPlacementContext.Provider>
          </BaseDrawer.Viewport>
        </BaseDrawer.Portal>
      </BaseDrawer.Root>
    </SidebarLayoutContext.Provider>
  );
}

export type SidebarProps = {
  /** The navigation landmark's name, such as "Notes" or "Folders". */
  label: string;
  /** `Sidebar.Header`, `Sidebar.Content` and `Sidebar.Footer`. */
  children?: ReactNode;
  className?: string;
};

/** The sidebar column: a `<nav>` with a header, a scrolling list and a footer. */
function SidebarRoot({ label, children, className }: SidebarProps): ReactElement {
  const placement = useContext(SidebarPlacementContext);
  if (placement === "drawer") {
    return (
      <BaseDrawer.Popup
        aria-label={label}
        className={cx(
          "fixed inset-y-0 start-0 flex outline-none",
          "translate-x-[var(--drawer-swipe-movement-x,0px)] transition-transform duration-200 ease-out data-swiping:transition-none motion-reduce:transition-none",
          "data-starting-style:-translate-x-full data-ending-style:-translate-x-full rtl:data-starting-style:translate-x-full rtl:data-ending-style:translate-x-full",
          ELEVATION_3,
        )}
      >
        <nav aria-label={label} className={cx(SIDEBAR_SURFACE, SIDEBAR_WIDTH, "h-full", className)}>
          {children}
        </nav>
      </BaseDrawer.Popup>
    );
  }
  return (
    <nav
      aria-label={label}
      className={cx(SIDEBAR_SURFACE, SIDEBAR_WIDTH, "sticky top-0 hidden h-dvh shrink-0 md:flex", className)}
    >
      {children}
    </nav>
  );
}

/** A 60px row level with the `Toolbar` row, for search and a primary action. */
function SidebarHeader({ children, className }: { children?: ReactNode; className?: string }): ReactElement {
  return <div className={cx("flex h-15 shrink-0 items-center gap-2 px-3", className)}>{children}</div>;
}

export type SidebarSearchProps = Omit<ComponentPropsWithRef<"input">, "type" | "children"> & {
  /** Accessible name of the field. */
  label: string;
  onValueChange?: (value: string) => void;
};

/** The search field for `Sidebar.Header`. */
function SidebarSearch({ label, onValueChange, onChange, className, ...rest }: SidebarSearchProps): ReactElement {
  return (
    <div
      className={cx(
        "flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border bg-background ps-2.5 pe-4",
        "focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-ring",
        className,
      )}
    >
      <Glyph glyph={SearchGlyph} box={24} className="pointer-events-none text-muted-foreground" />
      <input
        {...rest}
        type="search"
        aria-label={label}
        onChange={(event) => {
          onChange?.(event);
          onValueChange?.(event.target.value);
        }}
        className="min-w-0 flex-1 bg-transparent text-subheadline font-medium text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/** The scrolling list of items between the header and the footer. */
function SidebarContent({ children, className }: { children?: ReactNode; className?: string }): ReactElement {
  return (
    <div className={cx("min-h-0 flex-1 overflow-y-auto px-3", className)}>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

/** Items pinned below the list, such as settings. */
function SidebarFooter({ children, className }: { children?: ReactNode; className?: string }): ReactElement {
  return <div className={cx("flex shrink-0 flex-col gap-px px-3 py-4.5", className)}>{children}</div>;
}

export type SidebarItemProps = {
  /** The row's text and accessible name. */
  label: string;
  /** A glyph from `@space/icons`. */
  icon?: IconGlyph;
  /** Short trailing text or a badge, such as a count or a date. */
  trailing?: ReactNode;
  /** The current page or selection; sets `aria-current="page"`. */
  selected?: boolean;
  /** Renders a link instead of a button. */
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  className?: string;
};

/** A navigation row. Choosing it closes the drawer on phones. */
function SidebarItem({
  label,
  icon,
  trailing,
  selected = false,
  href,
  onClick,
  disabled = false,
  className,
}: SidebarItemProps): ReactElement {
  const layout = useSidebarLayout();
  const classes = cx(
    "flex h-9 w-full shrink-0 cursor-pointer items-center gap-0.5 rounded-lg px-2 text-start",
    selected ? "bg-foreground/5 dark:bg-foreground/12" : HOVER_FILL,
    disabled && "cursor-default opacity-50",
    FOCUS_RING,
    className,
  );
  const content = (
    <>
      {icon == null ? null : (
        <Glyph glyph={icon} box={24} className={selected ? "text-foreground" : "text-muted-foreground"} />
      )}
      <span className="min-w-0 flex-1 truncate px-1 text-subheadline text-foreground">{label}</span>
      {trailing == null ? null : (
        <span className="me-1 shrink-0 whitespace-nowrap text-caption-1 text-muted-foreground">{trailing}</span>
      )}
    </>
  );
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
    layout?.setOpen(false);
  };
  if (href != null) {
    return (
      <a
        href={href}
        aria-current={selected ? "page" : undefined}
        aria-disabled={disabled || undefined}
        onClick={handleClick}
        className={classes}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      className={classes}
    >
      {content}
    </button>
  );
}

/**
 * The toolbar button that opens the sidebar drawer on phones; hidden on md
 * and up, where the sidebar is always shown. Put it in `Toolbar`'s `leading`.
 */
function SidebarToggle({ label = "Open navigation" }: { label?: string }): ReactElement {
  return <BaseDrawer.Trigger render={<Toolbar.Button icon={MenuGlyph} label={label} className="md:hidden" />} />;
}
(SidebarToggle as LeadingRanked).leadingRank = 1;

export const Sidebar = Object.assign(SidebarRoot, {
  Layout: SidebarLayout,
  Header: SidebarHeader,
  Search: SidebarSearch,
  Content: SidebarContent,
  Footer: SidebarFooter,
  Item: SidebarItem,
  Toggle: SidebarToggle,
});
