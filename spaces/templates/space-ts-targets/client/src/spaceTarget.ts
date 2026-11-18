// Which device target the host opened this page for. Hosts pass it in the
// URL fragment, beside `hatch_theme`:
//
//   #hatch_target=tv                      the app, adjusted for a TV
//   #hatch_view=widget&hatch_widget=today&hatch_instance=a1&hatch_size=small
//                                         one placed widget instead of the app
//
// No value means the ordinary responsive app on a phone or desktop, which the
// app's breakpoints already handle.
//
// `main.tsx` imports this module before rendering, so the values are also on
// <html> as `data-hatch-target`, `data-hatch-view`, and `data-hatch-size` for
// CSS, e.g. a Tailwind variant in your stylesheet:
//
//   @custom-variant tv (&:where([data-hatch-target="tv"], [data-hatch-target="tv"] *));

export type SpaceTarget = "tv";
export type SpaceView = "app" | "widget";
// Approximate boxes: small ≈168×168, medium ≈360×168, large ≈360×360, and the
// watch sizes ≈ small, fullscreen. Real hosts vary by a few pixels.
export type WidgetSize = "small" | "medium" | "large" | "watch" | "watch_round";

const WIDGET_SIZES: readonly WidgetSize[] = ["small", "medium", "large", "watch", "watch_round"];

const params = new URLSearchParams(window.location.hash.slice(1));

export const spaceTarget: SpaceTarget | null = params.get("hatch_target") === "tv" ? "tv" : null;

export const spaceView: SpaceView = params.get("hatch_view") === "widget" ? "widget" : "app";

// Which of the widgets declared in space.json (`widgets[].id`) to draw;
// "default" when the artifact declares none.
export const widgetId: string | null =
  spaceView === "widget" ? (params.get("hatch_widget") ?? "default") : null;

// The host's id for this placement. The same widget can be placed several
// times with different content: key per-placement settings by this id.
export const widgetInstance: string | null =
  spaceView === "widget" ? params.get("hatch_instance") : null;

export const widgetSize: WidgetSize | null =
  spaceView === "widget"
    ? (WIDGET_SIZES.find((size) => size === params.get("hatch_size")) ?? "small")
    : null;

const root = document.documentElement;
if (spaceTarget) root.dataset.hatchTarget = spaceTarget;
root.dataset.hatchView = spaceView;
if (widgetId) root.dataset.hatchWidget = widgetId;
if (widgetSize) root.dataset.hatchSize = widgetSize;

// The host paints a widget's surface and picks light or dark, so by default
// the page is transparent and lets it show through. Prepended so a stylesheet
// rule of the same specificity overrides it, e.g. in theme.css:
//
//   html[data-hatch-view="widget"] { --bg: #fff8e1; }
if (spaceView === "widget") {
  const style = document.createElement("style");
  style.id = "hatch-widget-background";
  style.textContent =
    'html[data-hatch-view="widget"] { --bg: transparent; background: transparent; }\n' +
    'html[data-hatch-view="widget"] body { background: transparent; }';
  document.head.prepend(style);
}
