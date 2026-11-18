// The widget: a separate, glanceable view of this artifact. `main.tsx`
// renders it instead of `App` when the host opens the page with
// `#hatch_view=widget`, inside the same frame (QueryClient, root wrapper), so
// read data through the same hooks and `api` calls `App` uses rather than
// duplicating them. Replace this placeholder.
//
// One artifact can offer several widgets, declared in space.json
// (`"widgets": [{"id": "today", "name": "Today", "refreshMinutes": 15}]`);
// `widgetId` says which one to draw, and `widgetInstance` which placement of
// it, so the same widget can show different content in each place.
// `widgetSize` is the approximate box the host gave it: pick the layout from
// it and let CSS fill the real box. Fill the whole area; never scroll.

import { widgetId, widgetSize } from "./spaceTarget";

export function Widget() {
  return (
    <div
      className="grid h-screen w-screen place-items-center p-3 text-center text-sm"
      data-widget={widgetId ?? "default"}
      data-widget-size={widgetSize ?? "small"}
    >
      <p>Setting up…</p>
    </div>
  );
}
