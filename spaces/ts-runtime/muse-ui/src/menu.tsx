/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import { createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import type { IconGlyph } from "@hatch/space-sdk/icons";
import { CheckGlyph } from "./glyphs.js";
import {
  cx,
  ELEVATION_3,
  HIGHLIGHT_FILL,
  NO_INSETS,
  POPUP_TRANSITION,
  readSafeAreaInsets,
  type SafeAreaInsets,
} from "./styles.js";
import { Glyph } from "./glyph.js";
import { Menu as BaseMenu } from "@hatch/base-ui/menu";

const EDGE_GAP = 6;

export type MenuSide = "top" | "bottom" | "inline-start" | "inline-end";
export type MenuAlign = "start" | "center" | "end";

export type MenuProps = {
  /** A button element that opens the menu (a `Toolbar.Button` works). */
  trigger: ReactElement;
  children: ReactNode;
  side?: MenuSide;
  align?: MenuAlign;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/**
 * A dropdown menu after the Muse web app's: a translucent, blurred 16px-radius
 * panel of 14px rows. Arrow keys move between items, typing jumps to a label,
 * Escape closes and returns focus to the trigger. The panel stays inside the
 * safe viewport and scrolls when it would not fit.
 */
function MenuRoot({
  trigger,
  children,
  side = "bottom",
  align = "start",
  open,
  defaultOpen,
  onOpenChange,
  className,
}: MenuProps): ReactElement {
  const [insets, setInsets] = useState<SafeAreaInsets>(NO_INSETS);
  return (
    <BaseMenu.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(next) => {
        if (next) setInsets(readSafeAreaInsets());
        onOpenChange?.(next);
      }}
    >
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          side={side}
          align={align}
          sideOffset={EDGE_GAP}
          collisionPadding={{
            top: insets.top + EDGE_GAP,
            right: insets.right + EDGE_GAP,
            bottom: insets.bottom + EDGE_GAP,
            left: insets.left + EDGE_GAP,
          }}
          className="z-50 outline-none"
        >
          <BaseMenu.Popup
            className={cx(
              "max-h-(--available-height) min-w-56 origin-(--transform-origin) overflow-y-auto rounded-2xl bg-popover/80 p-1.5 text-popover-foreground outline-none backdrop-blur-[60px] dark:bg-secondary/80",
              ELEVATION_3,
              POPUP_TRANSITION,
              className,
            )}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

const ROW =
  "relative flex cursor-pointer items-center gap-0.5 rounded-xl px-2 py-1.5 outline-none select-none data-disabled:cursor-default data-disabled:opacity-50";

type RowContent = {
  children: ReactNode;
  /** A glyph from `@space/icons`, drawn before the label. */
  icon?: IconGlyph;
  /** A second line under the label. */
  description?: ReactNode;
};

function RowBody({ icon, children, description }: RowContent): ReactElement {
  return (
    <>
      {icon == null ? null : (
        <Glyph glyph={icon} box={20} className="m-0.5 self-center" />
      )}
      <span className="flex min-w-0 flex-1 flex-col px-1 py-0.5">
        <span className="text-subheadline">{children}</span>
        {description == null ? null : (
          <span className="-mt-0.5 text-caption-1 text-muted-foreground">{description}</span>
        )}
      </span>
    </>
  );
}

// As in the Muse web app's menu: a checkbox's check sits in a 24px box, a
// radio's in a 20px box with a 2px margin; both paint at 75%.
const CHECKBOX_MARK = "ms-auto flex shrink-0 text-primary";
const RADIO_MARK = "my-0.5 ms-auto me-0.5 flex shrink-0 text-primary";

export type MenuItemProps = RowContent & {
  onSelect?: () => void;
  disabled?: boolean;
  /** Draws the row in the destructive color, for delete and similar. */
  destructive?: boolean;
  /** Keep the menu open after selection. */
  keepOpen?: boolean;
};

function MenuItem({ onSelect, disabled, destructive, keepOpen, ...content }: MenuItemProps): ReactElement {
  return (
    <BaseMenu.Item
      onClick={onSelect == null ? undefined : () => onSelect()}
      disabled={disabled}
      closeOnClick={!keepOpen}
      className={cx(ROW, HIGHLIGHT_FILL, destructive ? "text-destructive" : "text-popover-foreground")}
    >
      <RowBody {...content} />
    </BaseMenu.Item>
  );
}

export type MenuCheckboxItemProps = RowContent & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
};

function MenuCheckboxItem({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  ...content
}: MenuCheckboxItemProps): ReactElement {
  return (
    <BaseMenu.CheckboxItem
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange == null ? undefined : (next) => onCheckedChange(next)}
      disabled={disabled}
      closeOnClick={false}
      className={cx(ROW, HIGHLIGHT_FILL)}
    >
      <RowBody {...content} />
      <BaseMenu.CheckboxItemIndicator className={CHECKBOX_MARK}>
        <Glyph glyph={CheckGlyph} box={24} />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

const RadioDisabled = createContext(false);

export type MenuRadioGroupProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** A small heading over the choices. */
  label?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
};

function MenuRadioGroup({
  value,
  defaultValue,
  onValueChange,
  label,
  disabled = false,
  children,
}: MenuRadioGroupProps): ReactElement {
  return (
    <BaseMenu.RadioGroup
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange == null ? undefined : (next: string) => onValueChange(next)}
      disabled={disabled}
    >
      {label == null ? null : <GroupLabel>{label}</GroupLabel>}
      <RadioDisabled.Provider value={disabled}>{children}</RadioDisabled.Provider>
    </BaseMenu.RadioGroup>
  );
}

export type MenuRadioItemProps = RowContent & { value: string; disabled?: boolean };

function MenuRadioItem({ value, disabled, ...content }: MenuRadioItemProps): ReactElement {
  const groupDisabled = useContext(RadioDisabled);
  return (
    <BaseMenu.RadioItem
      value={value}
      disabled={disabled ?? groupDisabled}
      closeOnClick={false}
      className={cx(ROW, HIGHLIGHT_FILL)}
    >
      <RowBody {...content} />
      <BaseMenu.RadioItemIndicator className={RADIO_MARK}>
        <Glyph glyph={CheckGlyph} box={20} />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

function GroupLabel({ children }: { children: ReactNode }): ReactElement {
  return (
    <BaseMenu.GroupLabel className="mb-0.5 px-2 py-1.5 text-caption-2 text-muted-foreground">
      {children}
    </BaseMenu.GroupLabel>
  );
}

export type MenuGroupProps = { label?: ReactNode; children: ReactNode };

function MenuGroup({ label, children }: MenuGroupProps): ReactElement {
  return (
    <BaseMenu.Group>
      {label == null ? null : <GroupLabel>{label}</GroupLabel>}
      {children}
    </BaseMenu.Group>
  );
}

function MenuSeparator(): ReactElement {
  return <BaseMenu.Separator className="mx-2 my-1.5 h-px bg-border" />;
}

export const Menu = Object.assign(MenuRoot, {
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  Group: MenuGroup,
  Separator: MenuSeparator,
});
