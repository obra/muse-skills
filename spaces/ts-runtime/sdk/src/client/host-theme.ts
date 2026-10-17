// New templates opt in with `data-hatch-host-theme` on <html>. An SDK
// refresh alone must not take over an older Space's custom appearance.
// The parent frame sends the viewer's light/dark choice and accent family;
// this mirrors them onto <html> as
// `data-hatch-color-scheme` and `data-hatch-accent`, which the Space's
// CSS keys on. It also keeps the conventional `dark` class on <html> in step
// with the effective scheme, so shadcn-style `.dark { ... }` CSS works. A
// Space with no host message (standalone, or an older shell) keeps both
// attributes unset and follows the browser's appearance.

export const SPACE_THEME_MESSAGE_TYPE = "hatch:space:theme";

const COLOR_SCHEMES = ["light", "dark"] as const;
const ACCENT_COLORS = [
  "blue",
  "green",
  "red",
  "purple",
  "pink",
  "orange",
  "monochrome",
] as const;

export type SpaceColorScheme = (typeof COLOR_SCHEMES)[number];
export type SpaceAccentColor = (typeof ACCENT_COLORS)[number];

export interface SpaceTheme {
  colorScheme: SpaceColorScheme;
  accentColor: SpaceAccentColor;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function parseSpaceThemeMessage(data: unknown): SpaceTheme | null {
  if (data == null || typeof data !== "object") {
    return null;
  }
  const message = data as Record<string, unknown>;
  if (message.type !== SPACE_THEME_MESSAGE_TYPE || message.version !== 1) {
    return null;
  }
  if (
    !isOneOf(COLOR_SCHEMES, message.colorScheme) ||
    !isOneOf(ACCENT_COLORS, message.accentColor)
  ) {
    return null;
  }
  return { colorScheme: message.colorScheme, accentColor: message.accentColor };
}

function syncDarkClass(root: HTMLElement): void {
  const hostScheme = root.dataset.hatchColorScheme;
  const dark = isOneOf(COLOR_SCHEMES, hostScheme)
    ? hostScheme === "dark"
    : window.matchMedia(DARK_QUERY).matches;
  root.classList.toggle("dark", dark);
}

export function applySpaceTheme(theme: SpaceTheme, root: HTMLElement): void {
  root.dataset.hatchColorScheme = theme.colorScheme;
  root.dataset.hatchAccent = theme.accentColor;
  syncDarkClass(root);
}

let spaceThemeListenerInstalled = false;

export function installSpaceThemeListener(): void {
  if (spaceThemeListenerInstalled || typeof window === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (!root.hasAttribute("data-hatch-host-theme")) {
    return;
  }
  spaceThemeListenerInstalled = true;

  // Until (or unless) the host sends a theme, the `dark` class follows the
  // browser.
  window.matchMedia(DARK_QUERY).addEventListener("change", () => syncDarkClass(root));

  // The template's inline <head> script applies the theme Hatch passes in
  // the initial URL (or stamps on <html>) before the first paint; messages
  // carry changes after that.
  if (window.parent !== window) {
    window.addEventListener("message", (event) => {
      // Only the frame that embeds this Space may set its appearance. Spaces
      // are served from their own origin, so the source check (not an origin
      // check) is what scopes this, as for query invalidation.
      if (event.source !== window.parent) {
        return;
      }
      const theme = parseSpaceThemeMessage(event.data);
      if (theme == null) {
        return;
      }
      applySpaceTheme(theme, root);
    });
  }

  syncDarkClass(root);
}
