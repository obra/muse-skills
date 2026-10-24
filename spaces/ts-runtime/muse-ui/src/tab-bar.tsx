/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import { createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import type { IconGlyph } from "@hatch/space-sdk/icons";
import { cx, ELEVATION_1 } from "./styles.js";
import { Glyph } from "./glyph.js";

type TabBarState = { selected: string | undefined; select: (value: string) => void; showLabels: boolean };

const TabBarContext = createContext<TabBarState | null>(null);

export type TabBarProps = {
  /** The selected item's `value`; omit to let the bar track it. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Accessible name of the navigation landmark. */
  label: string;
  /** Show each item's label under its icon. Icons only by default, as in Muse. */
  showLabels?: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * A bottom tab bar after the Muse mobile app's: equal-width icon tabs on the
 * page background with a soft shadow. The selected tab is drawn in the
 * foreground color and marked `aria-current="page"`.
 */
function TabBarRoot({
  value,
  defaultValue,
  onValueChange,
  label,
  showLabels = false,
  children,
  className,
}: TabBarProps): ReactElement {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const selected = value ?? uncontrolled;
  const select = (next: string) => {
    if (value === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };
  return (
    <>
      {/* Reserves the bar's 52px row in the page. Not the inset: the SDK root
          (`.hatch-space-root`) already pads the page bottom by it. */}
      <div aria-hidden="true" className="h-13 shrink-0" />
      {/* pb-safe and px-safe (tailwindcss-safe-area): the bar runs under the
          home indicator and keeps its tabs clear of it and of side insets. */}
      <nav
        aria-label={label}
        className={cx(
          "fixed inset-x-0 bottom-0 z-30 bg-background pb-safe px-safe text-foreground",
          ELEVATION_1,
          className,
        )}
      >
        <div className="mx-auto flex w-full max-w-lg items-stretch">
          <TabBarContext.Provider value={{ selected, select, showLabels }}>{children}</TabBarContext.Provider>
        </div>
      </nav>
    </>
  );
}

export type TabBarItemProps = {
  value: string;
  /** A glyph from `@space/icons`. */
  icon: IconGlyph;
  /** Accessible name, and the visible label with `showLabels`. */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
};

function TabBarItem({ value, icon, label, onClick, disabled }: TabBarItemProps): ReactElement {
  const bar = useContext(TabBarContext);
  if (bar == null) throw new Error("TabBar.Item must be inside a TabBar");
  const isSelected = bar.selected === value;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={isSelected ? "page" : undefined}
      aria-label={bar.showLabels ? undefined : label}
      onClick={() => {
        bar.select(value);
        onClick?.();
      }}
      className={cx(
        "flex h-13 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50",
        isSelected ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {bar.showLabels ? (
        <>
          <Glyph glyph={icon} box={28} />
          <span className="max-w-full truncate px-1 text-caption-2 font-medium">{label}</span>
        </>
      ) : (
        <Glyph glyph={icon} box={28} />
      )}
    </button>
  );
}

export const TabBar = Object.assign(TabBarRoot, { Item: TabBarItem });
