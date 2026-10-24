/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import type { ReactElement, ReactNode } from "react";
import { Glyph } from "./glyph.js";
import { CloseGlyph } from "./glyphs.js";
import { cx, ELEVATION_1, ELEVATION_3, FILLED_HOVER, FOCUS_RING, POPUP_TRANSITION } from "./styles.js";
import { Dialog as BaseDialog } from "@hatch/base-ui/dialog";

export type DialogSize = "sm" | "md" | "lg";

export type DialogProps = {
  /** The dialog's heading and accessible name. */
  title: ReactNode;
  /** Supporting text under the title, announced with it. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons along the bottom edge, end-aligned. */
  actions?: ReactNode;
  /** A button element that opens the dialog; omit to control it with `open`. */
  trigger?: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Maximum width: 24rem, 32rem (default) or 42rem. */
  size?: DialogSize;
  /** Accessible name of the close button. */
  closeLabel?: string;
  /** Hide the close button, for dialogs whose actions own every way out. */
  hideCloseButton?: boolean;
  className?: string;
};

const WIDTH: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

/**
 * A modal dialog after the Muse web app's: a 32px-radius sheet over a dim
 * backdrop, title and close button on top, scrolling body, actions below.
 * Focus moves into the dialog, stays there while it is open, and returns to
 * the trigger on close; Escape and an outside click dismiss it.
 */
function DialogRoot({
  title,
  description,
  children,
  actions,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  size = "md",
  closeLabel = "Close",
  hideCloseButton = false,
  className,
}: DialogProps): ReactElement {
  return (
    <BaseDialog.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange == null ? undefined : (next) => onOpenChange(next)}
    >
      {trigger == null ? null : <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none dark:bg-black/40" />
        {/* Centers the dialog in the safe viewport: 16px plus each inset
            (tailwindcss-safe-area offsets), so on a phone it clears the
            status bar and the home indicator. */}
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center pt-safe-offset-4 pb-safe-offset-4 px-safe-offset-4">
          <BaseDialog.Popup
            className={cx(
              "flex max-h-full w-full flex-col overflow-hidden rounded-[32px] bg-popover text-popover-foreground outline-none",
              ELEVATION_3,
              POPUP_TRANSITION,
              WIDTH[size],
              className,
            )}
          >
            <div className="flex shrink-0 items-start gap-2 pt-4 pe-4 pb-4 ps-6">
              <div className="flex min-h-7 min-w-0 flex-1 flex-col justify-center gap-1">
                <BaseDialog.Title className="text-title-3 font-semibold">{title}</BaseDialog.Title>
                {description == null ? null : (
                  <BaseDialog.Description className="text-body text-muted-foreground">
                    {description}
                  </BaseDialog.Description>
                )}
              </div>
              {hideCloseButton ? null : (
                <BaseDialog.Close
                  aria-label={closeLabel}
                  className={cx(
                    "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-secondary text-secondary-foreground",
                    ELEVATION_1,
                    FILLED_HOVER,
                    FOCUS_RING,
                  )}
                >
                  <Glyph glyph={CloseGlyph} box={20} className="m-0.5" />
                </BaseDialog.Close>
              )}
            </div>
            {children == null ? null : (
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 text-body">{children}</div>
            )}
            {actions == null ? null : (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 pb-6">{actions}</div>
            )}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export type DialogCloseProps = {
  /** A button element that closes the dialog when activated. */
  render: ReactElement;
};

/** Closes the surrounding dialog: `<Dialog.Close render={<button>Done</button>} />`. */
function DialogClose({ render }: DialogCloseProps): ReactElement {
  return <BaseDialog.Close render={render} />;
}

export const Dialog = Object.assign(DialogRoot, { Close: DialogClose });
