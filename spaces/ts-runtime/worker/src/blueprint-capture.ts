/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// A Space has no URL routes, so its top-level routes are its first screen and
// each control of its navigation: a link or button inside a navigation
// landmark (a `nav` element or role `navigation`), or an element with role
// `tab`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

const BLUEPRINT_MAX_ROUTES = 8;
/** Written by the daemon into the output directory before each capture. */
const BLUEPRINT_REPLACEMENTS_FILENAME = "replacements.json";

const NAV_SELECTOR =
  "nav a[href], nav button, [role='navigation'] a[href], [role='navigation'] button, [role='tab']";
const MAX_SLUG_CHARS = 40;
/**
 * A letter or digit of a script that spaces its words: below U+2E80, where
 * the East Asian scripts, which do not, begin. `match_span` in
 * `space_template/blueprint.rs` matches the same way.
 */
const SPACED_WORD = "(?:(?![\\u{2E80}-\\u{10FFFF}])[\\p{Alphabetic}\\p{N}])";

export interface Replacement {
  found: string;
  placeholder: string;
}

export interface BlueprintShot {
  viewport: string;
  file: string;
  /** Hex sha256 of the PNG bytes, so the daemon reads the file this capture wrote. */
  sha256: string;
}

export interface BlueprintRoute {
  /**
   * The position of the first screen's control that opened this route, `null`
   * for the first screen; the same in the first and final passes, whose slugs
   * differ once a found string in a name is replaced, so the daemon pairs the
   * passes' screens by it.
   */
  index: number | null;
  slug: string;
  shots: BlueprintShot[];
  /** The daemon refuses a found string no route in either state matched. */
  matched: string[];
  unreplaced: string[];
}

export interface PageReplacement {
  matched: string[];
  unreplaced: string[];
}

export interface BlueprintReport {
  ok: boolean;
  error?: string;
  duration_ms: number;
  routes: BlueprintRoute[];
  /**
   * Targets of the first screen that could not be found again or opened, each
   * named with every found string replaced.
   */
  missed: { viewport: string; name: string }[];
}

export interface NavTarget {
  index: number;
  /** With every found string replaced. */
  name: string;
  /**
   * The control's text before any replacement, without digits: the same in
   * both viewports, on every load of the first screen and in both passes, and
   * two names one placeholder replaces stay two. A text of digits alone keeps
   * them, as `""` is the first screen's key. It never leaves the worker. Not
   * the slug, which is `route` for every name in a script without Latin
   * letters.
   */
  key: string;
}

/** The daemon writes this file before every capture, so a missing or malformed one fails it. */
export async function readReplacements(outputDir: string): Promise<Replacement[]> {
  const raw = await readFile(join(outputDir, BLUEPRINT_REPLACEMENTS_FILENAME), "utf8");
  const parsed: unknown = JSON.parse(raw);
  const valid =
    Array.isArray(parsed) &&
    parsed.every((item) => typeof item?.found === "string" && typeof item?.placeholder === "string");
  if (!valid) throw new Error("the replacements file is not a list of replacements");
  return parsed as Replacement[];
}

/** Not inside a word of a script that spaces its words, so `Li` leaves `List` be. */
function foundPattern(found: string): string {
  const chars = Array.from(found.trim());
  const spaced = (char: string | undefined) =>
    char !== undefined && new RegExp(SPACED_WORD, "u").test(char);
  const body = found
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("\\s+");
  const before = spaced(chars[0]) ? `(?<!${SPACED_WORD})` : "";
  const after = spaced(chars.at(-1)) ? `(?!${SPACED_WORD})` : "";
  return `${before}${body}${after}`;
}

function longestFirst(replacements: Replacement[]): Replacement[] {
  return [...replacements].sort((left, right) => right.found.length - left.found.length);
}

function replaceIn(text: string, replacements: Replacement[]): string {
  return longestFirst(replacements).reduce(
    (current, { found, placeholder }) =>
      current.replace(new RegExp(foundPattern(found), "giu"), () => placeholder),
    text,
  );
}

interface NavControl {
  label: string | null;
  /**
   * The control's text nodes in document order, adjacent siblings grouped,
   * as swapPageText swaps a run of them as one text.
   */
  texts: string[][];
  usable: boolean;
}

/** Listed through the same locator openNavTarget clicks, so an index names one control in both. */
export async function navTargets(page: Page, replacements: Replacement[]): Promise<NavTarget[]> {
  const controls = await page.locator(NAV_SELECTOR).evaluateAll((elements) => {
    const textsOf = (control: Element) => {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      const runs: string[][] = [];
      let previous: Node | null = null;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? "";
        const run = node.previousSibling === previous ? runs.at(-1) : undefined;
        if (run === undefined) runs.push([value]);
        else run.push(value);
        previous = node;
      }
      return runs;
    };
    return elements.map((control) => {
      const external = control instanceof HTMLAnchorElement && control.origin !== location.origin;
      const box = control.getBoundingClientRect();
      const usable = !external && box.width > 0 && box.height > 0;
      return { label: control.getAttribute("aria-label"), texts: textsOf(control), usable };
    });
  });
  return pickTargets(controls, replacements);
}

/**
 * Runs of text nodes join with a space, so a name never fuses with initials or
 * a badge beside it into a word the replacement cannot match. One fewer than
 * the route cap: the first screen is a route too.
 */
function pickTargets(controls: NavControl[], replacements: Replacement[]): NavTarget[] {
  const targets: NavTarget[] = [];
  controls.forEach(({ label, texts, usable }, index) => {
    const text = (label ?? texts.map((run) => run.join("")).join(" ")).replace(/\s+/g, " ").trim();
    const name = replaceIn(text, replacements);
    const key = text.replace(/\d+/g, "") || text;
    const taken = targets.some((target) => target.key === key);
    if (!usable || !name || taken || targets.length >= BLUEPRINT_MAX_ROUTES - 1) return;
    targets.push({ index, name, key });
  });
  return targets;
}

export async function openNavTarget(page: Page, index: number): Promise<boolean> {
  const control = page.locator(NAV_SELECTOR).nth(index);
  return control
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
}

/** `aria-label`, `title` and `alt` name controls and images, so they count as page text. */
export async function replacePageText(
  page: Page,
  replacements: Replacement[],
): Promise<PageReplacement> {
  if (replacements.length === 0) return { matched: [], unreplaced: [] };
  const rules = longestFirst(replacements).map((replacement) => ({
    ...replacement,
    pattern: foundPattern(replacement.found),
  }));
  const frames = page.frames();
  const swapped = new Set(
    (await Promise.all(frames.map((frame) => frame.evaluate(swapPageText, rules)))).flat(),
  );
  return {
    matched: rules.filter((_, index) => swapped.has(index)).map(({ found }) => found),
    unreplaced: await unreplacedOn(page, replacements),
  };
}

/** Read again after the screenshot, so a render between the swap and the screenshot counts. */
export async function unreplacedOn(page: Page, replacements: Replacement[]): Promise<string[]> {
  const frames = page.frames();
  const shown = (await Promise.all(frames.map((frame) => frame.evaluate(shownText)))).join("\n");
  return replacements
    .filter(({ found }) => new RegExp(foundPattern(found), "iu").test(shown))
    .map(({ found }) => found);
}

/**
 * A run of adjacent text nodes is swapped as one text, so a string a framework
 * rendered in pieces is whole; the result goes into the run's first node and
 * the rest are emptied, never removed, as the framework still holds them.
 * Open shadow roots count as page text; script and style text does not, nor
 * does a frame with no body, such as an SVG document's. Self-contained, as
 * `page.evaluate` sends its source.
 */
function swapPageText(rules: { pattern: string; placeholder: string }[]): number[] {
  if (document.body === null) return [];
  const swapped = new Set<number>();
  const swap = (text: string) => {
    rules.forEach(({ pattern }, index) => {
      if (new RegExp(pattern, "iu").test(text)) swapped.add(index);
    });
    return rules.reduce(
      (current, { pattern, placeholder }) =>
        current.replace(new RegExp(pattern, "giu"), () => placeholder),
      text,
    );
  };
  const swapRoot = (root: HTMLElement | ShadowRoot) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.matches("script, style, noscript, template")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes: Node[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node);
    for (let start = 0, end = 1; start < nodes.length; start = end, end = start + 1) {
      while (end < nodes.length && nodes[end]!.previousSibling === nodes[end - 1]) end += 1;
      const run = nodes.slice(start, end);
      const text = run.map((node) => node.nodeValue ?? "").join("");
      const next = swap(text);
      if (next !== text) run.forEach((node, index) => (node.nodeValue = index === 0 ? next : ""));
    }
    const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    for (const field of Array.from(fields)) {
      field.placeholder = swap(field.placeholder);
      field.value = swap(field.value);
    }
    const named = root.querySelectorAll("[aria-label], [title], [alt]");
    for (const element of Array.from(named)) {
      for (const name of ["aria-label", "title", "alt"]) {
        const value = element.getAttribute(name);
        if (value !== null) element.setAttribute(name, swap(value));
      }
    }
  };
  const roots: (HTMLElement | ShadowRoot)[] = [document.body];
  for (const root of roots) {
    const shadows = Array.from(root.querySelectorAll("*"), (element) => element.shadowRoot);
    roots.push(...shadows.filter((shadow) => shadow !== null));
  }
  roots.forEach(swapRoot);
  return [...swapped];
}

/**
 * What the page shows in the places swapPageText reaches, plus text it cannot
 * swap (CSS generated content), which the check then reports. Self-contained.
 */
function shownText(): string {
  if (document.body === null) return "";
  const roots: (HTMLElement | ShadowRoot)[] = [document.body];
  for (const root of roots) {
    const shadows = Array.from(root.querySelectorAll("*"), (element) => element.shadowRoot);
    roots.push(...shadows.filter((shadow) => shadow !== null));
  }
  const childText = (child: ChildNode) => {
    if (child.nodeType === Node.TEXT_NODE) return child.nodeValue ?? "";
    if (!(child instanceof Element) || child.matches("script, style, template")) return "";
    return (child as HTMLElement).innerText ?? child.textContent ?? "";
  };
  const rootText = (root: HTMLElement | ShadowRoot) => {
    const rendered =
      root instanceof ShadowRoot
        ? Array.from(root.childNodes, childText)
        : [root.innerText];
    const named = Array.from(root.querySelectorAll("[aria-label], [title], [alt]"));
    const labels = named.flatMap((element) =>
      ["aria-label", "title", "alt"].map((name) => element.getAttribute(name) ?? ""),
    );
    const fields = Array.from(
      root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
      (field) => `${field.value}\n${field.placeholder}`,
    );
    const generated = Array.from(root.querySelectorAll("*"))
      .flatMap((element) =>
        ["::before", "::after"].map((pseudo) => getComputedStyle(element, pseudo).content),
      )
      .filter((content) => content !== "none" && content !== "normal");
    return [...rendered, ...labels, ...fields, ...generated];
  };
  return roots.flatMap(rootText).join("\n");
}

/**
 * Digits are left out, so a count in a name (`Inbox (0)`, `Inbox (4)`) names
 * one route in both states.
 */
export function routeSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .replace(/\d+/g, " ")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_CHARS)
      .replace(/-+$/g, "") || "route";
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix += 1) {
    slug = `${base.slice(0, MAX_SLUG_CHARS - String(suffix).length - 1)}-${suffix}`;
  }
  taken.add(slug);
  return slug;
}
