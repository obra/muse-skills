/// <reference lib="dom" />
// Target views: the extra captures the one-shot audit takes when a Space
// declares device targets beyond phone and desktop (`space.json` `targets`).
// Each view loads the same page with the URL fragment a host sends, at that
// device's size, and measures what does not fit. The capture itself lives in
// playwright-audit.ts beside the other passes; this module holds the specs and
// the in-page measurement so both the audit and the probe share them.

export type TargetViewName = "tv" | "widget-small" | "widget-medium" | "widget-large";

export const TARGET_VIEW_NAMES: readonly TargetViewName[] = [
  "tv",
  "widget-small",
  "widget-medium",
  "widget-large",
];

export type ColorScheme = "dark" | "light";

export interface TargetViewSpec {
  name: TargetViewName;
  viewport: { width: number; height: number };
  /** Fragment the host sends, without the leading `#`. */
  hash: string;
  colorScheme: ColorScheme;
  /** The surface a host paints behind a widget, which shows through a
   *  transparent page; null for views that own their whole screen (TV). */
  backdrop: string | null;
  /** Content inside this inset from each edge is safe (the TV overscan margin). */
  inset: { x: number; y: number };
  /** TV views start with a focused control for the D-pad. */
  checkFocus: boolean;
  fileName: string;
}

const TV_VIEWPORT = { width: 960, height: 540 } as const;
// What a home-screen host paints behind a widget in each mode.
const WIDGET_BACKDROPS: Record<ColorScheme, string> = { light: "#ffffff", dark: "#1c1c1e" };
const WIDGET_VIEWPORTS = {
  "widget-small": { size: "small", width: 168, height: 168 },
  "widget-medium": { size: "medium", width: 360, height: 168 },
  "widget-large": { size: "large", width: 360, height: 360 },
} as const;

/** A Space-declared widget id, as the catalog accepts it; anything else falls
 *  back to the default widget. */
export function normalizeWidgetId(raw: string | null | undefined): string {
  const id = (raw ?? "").trim();
  return /^[a-z0-9_-]{1,64}$/.test(id) ? id : "default";
}

/** A view's label in reports: its name, plus the mode when it is dark. */
export function targetViewLabel(spec: Pick<TargetViewSpec, "name" | "colorScheme">): string {
  return spec.name !== "tv" && spec.colorScheme === "dark" ? `${spec.name}-dark` : spec.name;
}

export function targetViewSpec(
  name: TargetViewName,
  widgetId: string,
  colorScheme: ColorScheme = "light",
): TargetViewSpec {
  if (name === "tv") {
    return {
      name,
      viewport: { ...TV_VIEWPORT },
      hash: "hatch_target=tv&hatch_theme=dark",
      colorScheme: "dark",
      backdrop: null,
      inset: { x: Math.round(TV_VIEWPORT.width * 0.05), y: Math.round(TV_VIEWPORT.height * 0.05) },
      checkFocus: true,
      fileName: "screenshot-tv.png",
    };
  }
  const widget = WIDGET_VIEWPORTS[name];
  const params = new URLSearchParams({
    hatch_view: "widget",
    hatch_widget: normalizeWidgetId(widgetId),
    hatch_size: widget.size,
    hatch_theme: colorScheme,
  });
  const spec = {
    name,
    viewport: { width: widget.width, height: widget.height },
    hash: params.toString(),
    colorScheme,
    backdrop: WIDGET_BACKDROPS[colorScheme],
    inset: { x: 0, y: 0 },
    checkFocus: false,
  };
  return { ...spec, fileName: `screenshot-${targetViewLabel(spec)}.png` };
}

/** The views a Space's declared targets ask for, in capture order. */
export function targetViewSpecs(targets: readonly string[], widgetId: string): TargetViewSpec[] {
  const specs: TargetViewSpec[] = [];
  if (targets.includes("tv")) specs.push(targetViewSpec("tv", widgetId));
  if (targets.includes("widget")) {
    for (const scheme of ["light", "dark"] as const) {
      for (const name of ["widget-small", "widget-medium", "widget-large"] as const) {
        specs.push(targetViewSpec(name, widgetId, scheme));
      }
    }
  }
  return specs;
}

export interface OutsideNode {
  selector: string;
  text: string;
}

export interface LowContrastNode extends OutsideNode {
  /** WCAG contrast ratio of the text against what is behind it. */
  ratio: number;
}

export interface TargetViewMeasure {
  /** How far the document scrolls past the view, in CSS px (0 when it fits). */
  scroll_x_px: number;
  scroll_y_px: number;
  /** Visible text and controls that sit past the safe area (cut off, or in
   *  the TV overscan margin). Capped. */
  outside: OutsideNode[];
  /** The focused control on load (TV only), or null when nothing is focused. */
  focused: string | null;
  /** Widget views: text that reads below 3:1 against what is behind it, the
   *  host's surface where the page is transparent. Capped. */
  low_contrast: LowContrastNode[];
  /** Widget views: the page paints its own opaque background over the host's
   *  surface (`selector #rrggbb`), or null when it stays transparent. */
  opaque_background: string | null;
}

export interface TargetViewReport extends TargetViewMeasure {
  name: TargetViewName;
  color_scheme: ColorScheme;
  width: number;
  height: number;
  screenshot_path: string | null;
  /** Text runs the walk measured as visibly cut off. */
  clipped: unknown[];
  error: string | null;
}

export const OUTSIDE_LIMIT = 6;

/** Runs in the page before measuring: paints the host's surface behind the
 *  page, where a transparent widget shows it. It sits under the body and the
 *  SDK root, so a page that paints its own background still covers it. */
export function paintHostBackdrop(color: string): void {
  const style = document.createElement("style");
  style.id = "hatch-audit-host-backdrop";
  style.textContent = `html::before{content:"";position:fixed;inset:0;z-index:-2147483647;pointer-events:none;background:${color}}`;
  document.head.append(style);
}

/** Runs in the page. Self-contained: Playwright serializes it. */
export function measureTargetView(args: {
  inset: { x: number; y: number };
  checkFocus: boolean;
  limit: number;
  backdrop: string | null;
}): TargetViewMeasure {
  const doc = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const slack = 2;
  // Full-stack Spaces scroll inside the SDK root, not the document, so take
  // the larger overflow of the two.
  const root = document.querySelector("[data-generated-space-root]");
  const overflow = (content: number, box: number): number => {
    const px = Math.round(content - box);
    return px > slack ? px : 0;
  };
  const scroll_x_px = Math.max(
    overflow(doc.scrollWidth, vw),
    root ? overflow(root.scrollWidth, root.clientWidth) : 0,
  );
  const scroll_y_px = Math.max(
    overflow(doc.scrollHeight, vh),
    root ? overflow(root.scrollHeight, root.clientHeight) : 0,
  );
  const left = args.inset.x - slack;
  const top = args.inset.y - slack;
  const right = vw - args.inset.x + slack;
  const bottom = vh - args.inset.y + slack;

  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    return `${tag}${id}${cls}`.slice(0, 80);
  };
  const visible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const isOutside = (rect: DOMRect): boolean =>
    rect.width > 0 &&
    rect.height > 0 &&
    (rect.left < left || rect.top < top || rect.right > right || rect.bottom > bottom);

  const outside: OutsideNode[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body ?? doc, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && outside.length < args.limit; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (!text || !parent || seen.has(parent) || !visible(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (isOutside(range.getBoundingClientRect())) {
      seen.add(parent);
      outside.push({ selector: describe(parent), text: text.slice(0, 60) });
    }
  }
  const controls = document.querySelectorAll("button, a[href], input, select, textarea, [tabindex]");
  for (const el of Array.from(controls)) {
    if (outside.length >= args.limit) break;
    if (seen.has(el) || !visible(el)) continue;
    if (isOutside(el.getBoundingClientRect())) {
      seen.add(el);
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
      outside.push({ selector: describe(el), text: label.slice(0, 60) });
    }
  }

  let focused: string | null = null;
  if (args.checkFocus) {
    const active = document.activeElement;
    if (active && active !== document.body && active !== doc) {
      const label = (active.getAttribute("aria-label") ?? active.textContent ?? "").trim();
      focused = `${describe(active)}${label ? ` "${label.slice(0, 40)}"` : ""}`;
    }
  }
  let low_contrast: LowContrastNode[] = [];
  let opaque_background: string | null = null;
  if (args.backdrop !== null) {
    // Resolve any CSS color (oklch, color-mix, named) to sRGB by painting it.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (color: string): [number, number, number, number] => {
      if (!ctx) return [0, 0, 0, 0];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const hex = ([r, g, b]: [number, number, number]): string =>
      `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    const [br, bg, bb] = rgba(args.backdrop);
    const host: [number, number, number] = [br, bg, bb];

    // The page background: the page-level containers, or one element that
    // covers nearly the whole view.
    const area = vw * vh;
    const shells = [doc, document.body, root, document.querySelector(".hatch-space-root")];
    for (const el of shells) {
      if (!el || opaque_background) continue;
      const fill = rgba(window.getComputedStyle(el).backgroundColor);
      if (fill[3] >= 0.9) opaque_background = `${describe(el)} ${hex(over(fill, host))}`;
    }
    if (!opaque_background) {
      for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
        const rect = el.getBoundingClientRect();
        if (rect.width * rect.height < area * 0.9 || !visible(el)) continue;
        const fill = rgba(window.getComputedStyle(el).backgroundColor);
        if (fill[3] >= 0.9) {
          opaque_background = `${describe(el)} ${hex(over(fill, host))}`;
          break;
        }
      }
    }

    // What can sit behind an element: its painted ancestors composited over
    // the host's surface. A gradient contributes each of its color stops, so
    // a gradient card yields one candidate per stop; an image yields null,
    // since its pixels cannot be read here.
    const STOP = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
    const behind = (el: Element): [number, number, number][] | null => {
      const layers: [number, number, number, number][][] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        const image = style.backgroundImage;
        if (image.includes("url(")) return null;
        const fill = rgba(style.backgroundColor);
        const stops = image === "none" ? [] : (image.match(STOP) ?? []).map(rgba);
        // Top to bottom: an element's gradient paints over its own color.
        if (stops.length > 0) layers.push(stops);
        if (fill[3] > 0) layers.push([fill]);
        if (fill[3] >= 0.99 || (stops.length > 0 && stops.every((stop) => stop[3] >= 0.99))) break;
      }
      let candidates: [number, number, number][] = [host];
      for (const layer of layers.reverse()) {
        candidates = candidates
          .flatMap((under) => layer.map((top) => over(top, under)))
          .slice(0, 16);
      }
      return candidates;
    };
    // Text drawn over an image, video, or canvas (a caption on a photo) has
    // pixels behind it the colors above cannot see, so it is not judged,
    // unless an opaque layer between the text and the media hides the media.
    // Geometric rather than hit-testing, which skips `pointer-events: none`.
    const media = Array.from(document.body?.querySelectorAll("*") ?? []).filter(
      (el) =>
        visible(el) &&
        (/^(img|video|canvas|picture|iframe|object|embed)$/i.test(el.tagName) ||
          window.getComputedStyle(el).backgroundImage.includes("url(")),
    );
    const overMedia = (el: Element, rect: DOMRect): boolean => {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return media.some((item) => {
        const box = item.getBoundingClientRect();
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
        // Up from the text to the media or the ancestor that holds it: an
        // opaque layer on the way hides the media.
        for (
          let node: Element | null = el;
          node && node !== item && !node.contains(item);
          node = node.parentElement
        ) {
          if (rgba(window.getComputedStyle(node).backgroundColor)[3] >= 0.99) return false;
        }
        return true;
      });
    };
    const ratioOf = (ink: [number, number, number], back: [number, number, number]): number => {
      const [hi, lo] = [luminance(ink), luminance(back)].sort((a, b) => b - a) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const flagged = new Set<Element>();
    const texts = document.createTreeWalker(document.body ?? doc, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node && low_contrast.length < args.limit; node = texts.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const parent = node.parentElement;
      if (!text || !parent || flagged.has(parent) || !visible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > vh) continue;
      const style = window.getComputedStyle(parent);
      if (style.backgroundClip === "text" || style.getPropertyValue("-webkit-background-clip") === "text") continue;
      const backs = behind(parent);
      if (backs === null || overMedia(parent, rect)) continue;
      const color = rgba(style.color);
      // Flag only when the text fails against every candidate background,
      // so a gradient's light end does not condemn text on its dark end.
      const best = Math.max(...backs.map((back) => ratioOf(over(color, back), back)));
      const ratio = Math.round(best * 10) / 10;
      if (ratio < 3) {
        flagged.add(parent);
        low_contrast.push({ selector: describe(parent), text: text.slice(0, 60), ratio });
      }
    }
    low_contrast = low_contrast.slice(0, args.limit);
  }
  return { scroll_x_px, scroll_y_px, outside, focused, low_contrast, opaque_background };
}
