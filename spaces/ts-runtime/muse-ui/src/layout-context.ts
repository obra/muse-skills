/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
// What `Sidebar.Layout` tells the components inside it, kept apart from both
// so the toolbar can read it without importing the sidebar.
import { createContext, useContext } from "react";

export type SidebarLayoutState = {
  /** Whether the phone drawer is open. */
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const SidebarLayoutContext = createContext<SidebarLayoutState | null>(null);

/** Where a `Sidebar` is drawn: beside the content (md and up) or in the drawer. */
export type SidebarPlacement = "inline" | "drawer";

export const SidebarPlacementContext = createContext<SidebarPlacement>("inline");

export function useSidebarLayout(): SidebarLayoutState | null {
  return useContext(SidebarLayoutContext);
}

/**
 * Order inside the toolbar's leading slot: `Toolbar.Back` first, then
 * `Sidebar.Toggle`, then anything else, whatever order they are passed in.
 */
export type LeadingRanked = { leadingRank?: number };
