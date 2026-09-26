// The `observe` primitive behind `probe-ui.js`: one atomic look at a live
// artifact page.
//
// Why this exists at all: the previous verification path handed the builder a
// raw Playwright `page` and asked it to author test files. That makes the model
// *predict* a selector that will be both unique and visible in a rendered state
// it cannot see, and prediction is where it fails — a Tailwind responsive
// layout renders the same content twice (one copy hidden per breakpoint), so
// `getByText("…")` legitimately matches two nodes and which one is visible
// depends on the viewport the test will later run at.
//
// `observe` removes the prediction. It returns only nodes that are *currently
// visible and hit-testable at this viewport*, numbered, and `act` addresses them
// by number against a single-use snapshot id. There is nothing left to guess and
// no timeout for the model to write.
//
// Three channels come back from the SAME frame, because a tree captured at a
// different instant than its screenshot makes a reader hallucinate
// disagreements (a live timer reading 150:08 in the tree and 150:58 in the
// image is the same page, half a minute apart):
//   - `aria`   Playwright's accessibility snapshot — visible nodes only, so the
//              hidden breakpoint twin is simply absent. Identity + semantics.
//   - `nodes`  this module's hit-tested walk — instance numbering and geometry,
//              which the aria tree has no way to express.
//   - screenshot  the only channel that shows whether it *looks* right.

import type { Page } from "playwright";

/** Roles/tags worth offering the auditor as addressable targets. */
const NODE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[role]",
  "[onclick]",
  "[contenteditable='true']",
  "h1",
  "h2",
  "h3",
  "li",
  "td",
  "th",
].join(",");

/** Attribute the walk stamps so `act` can re-find a node it offered. */
export const OBSERVE_ATTR = "data-hatch-obs";

/** Tags that count as an interaction the artifact offers its user. */
const INTERACTIVE_TAGS = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "summary",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "combobox",
  "textbox",
  "slider",
  "option",
]);

/** How long a settle poll waits for the artifact's queries to go idle. */
export const SETTLE_POLL_TIMEOUT_MS = 8_000;
const SETTLE_POLL_INTERVAL_MS = 100;
/** Consecutive idle polls required before a frame is called settled. */
const SETTLE_STABLE_POLLS = 2;

/** Cap on nodes returned in one observe, so a dense grid can't flood context. */
export const MAX_OBSERVE_NODES = 120;
/** Bound on the clipping scan, which walks far more elements than the node list.
 *  Same reason the page-level probe is bounded: an unbounded per-element layout
 *  read is the one thing in this harness that can stall without limit. */
const MAX_CLIP_SCAN = 4000;
/** Ignore sub-pixel and rounding noise; report real loss only. */
const CLIP_MIN_PX = 3;

export interface ObservedNode {
  /** 1-based index the model passes back to `act`. */
  i: number;
  role: string | null;
  /** Accessible name, or trimmed text, capped. */
  name: string;
  tag: string;
  /** [x, y, w, h] in CSS px at the current viewport, rounded. */
  bbox: [number, number, number, number];
  enabled: boolean;
  /** True when this node is something a user can operate. */
  interactive: boolean;
}

/** A visible element whose own text is cut off. */
export interface ClippedNode {
  tag: string;
  text: string;
  kind: "text_truncated" | "past_viewport";
  overflow_px: number;
  bbox: [number, number, number, number];
}

/**
 * Why an interactive control cannot be operated at this viewport.
 *
 * This is the defect class that actually reached users, and
 * neither verification arm caught any of it. Every instance is mechanically
 * decidable in one in-page pass, which is why it belongs here rather than in a
 * model loop: the model spent 244 probe operations to cause 4 app edits, while
 * users reported these within 90 seconds of delivery.
 *
 *  - `occluded`    something is painted on top at the control's centre, so a
 *                  click lands on the occluder. A fixed FAB shearing the primary
 *                  empty-state CTA; a fixed pill covering the footer.
 *  - `invisible`   effective opacity is 0 up the ancestor chain, or an ancestor
 *                  is `visibility: hidden`. The `opacity-0 group-hover:opacity-100`
 *                  pattern lands here: on a phone there is no hover, so the
 *                  control does not exist for that user.
 *  - `clipped_off` the control lies outside an ancestor that cannot scroll to it
 *                  — `overflow: hidden`, or a scrollport with no scroll range in
 *                  that axis. A reps stepper pushed outside a `position: fixed`
 *                  strip is unreachable at any document scroll offset.
 *
 * Deliberately NOT a defect, because each of these would otherwise fire on a
 * correct artifact and the gate would be worthless:
 *  - a control inside a scrollport that CAN scroll to it (a carousel, a
 *    horizontally scrollable week strip) — reported as `needs_inner_scroll`,
 *    never blocking;
 *  - anything under an open dialog (`role=dialog`, `aria-modal`, or a
 *    fixed/absolute overlay covering >60% of the viewport) — covering the page is
 *    what a modal is for;
 *  - anything inside an `aria-hidden="true"` or `inert` subtree, which is the
 *    platform's marker for a closed off-canvas drawer. A drawer that omits it is
 *    an a11y bug on its own terms, so deferring here hides nothing real.
 */
export type UnreachableReason = "occluded" | "invisible" | "clipped_off";

export interface UnreachableControl {
  name: string;
  tag: string;
  reason: UnreachableReason;
  bbox: [number, number, number, number];
  /** For `occluded`: what is painted on top, to name the fix. */
  occluder?: string;
  /** For `clipped_off`: the ancestor that cuts it, and by how much. */
  clipped_by?: string;
  overflow_px?: number;
}

export interface ObserveWalk {
  nodes: ObservedNode[];
  /** Count of interactive nodes present, BEFORE the MAX_OBSERVE_NODES cap. */
  interactive_nodes: number;
  /** Total candidates matched, so a truncated walk is honest about it. */
  total_candidates: number;
  truncated: boolean;
  /** Cut-off text found anywhere on the page, not just among act targets. */
  clipped: ClippedNode[];
  /** Interactive controls a user at this viewport cannot operate. */
  unreachable: UnreachableControl[];
  /** Off-screen but reachable by scrolling an inner scrollport. Informational. */
  needs_inner_scroll: number;
}

/**
 * True when `name` is too generic to identify a control to a reader.
 *
 * An artifact whose inputs are accessibly named `-` (a real case: a weight
 * field and a reps field both named `-`) is broken for assistive tech and
 * unreportable by the auditor, so the walk flags it rather than silently
 * handing back two indistinguishable rows.
 */
export function isUselessName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  // Punctuation-only names ("-", "—", "…", "*") carry no meaning.
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

/**
 * The in-page walk, as a string so it can be `page.evaluate`d without bundling
 * a second copy of this module into the page. Returns `ObserveWalk`.
 *
 * A control that fails the visibility or hit test is CLASSIFIED, not dropped:
 * see `UnreachableControl`. Dropping it told the model nothing, which is how a
 * fixed FAB shearing the primary CTA and a stepper pushed outside a fixed strip
 * both shipped green.
 *
 * Visibility is decided three ways, because each alone lets something through:
 * a non-zero box (rules out `display:none` and collapsed containers), computed
 * `visibility`/`opacity` (rules out a painted-but-invisible node), and
 * `elementFromPoint` containment at the box centre (rules out anything covered
 * by an overlay, which is exactly the state a screenshot shows as "there" and a
 * click fails on).
 */
export function observeWalkScript(selector: string, attr: string, maxNodes: number): string {
  return `(() => {
  // Clear the previous walk's numbering FIRST.
  //
  // The attribute is how \`act\` addresses a node, and it is set only on the
  // elements a walk emits. An element that was node 13 last walk and drops out of
  // this one — scrolled away, covered by a modal, unmounted-but-reused — keeps
  // \`13\`, so when this walk gives 13 to something else the locator matches two
  // elements and the act fails \`stale_node\`. That is the strict-mode ambiguity
  // this probe exists to remove, reintroduced by its own bookkeeping: in
  // production it cost 4 of one run's 14 batch calls, one of them abandoning a
  // 12-step flow at step 1.
  for (const stale of Array.from(document.querySelectorAll("[" + ${JSON.stringify(attr)} + "]"))) {
    stale.removeAttribute(${JSON.stringify(attr)});
  }
  const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const interactiveTags = new Set(${JSON.stringify([...INTERACTIVE_TAGS])});
  const interactiveRoles = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
  const out = [];
  const unreachable = [];
  let needsInnerScroll = 0;
  let interactive = 0;
  let candidates = 0;

  const label = (el) => {
    const n = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      (el.textContent || "")
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    return n || el.tagName.toLowerCase();
  };
  const brief = (el) => {
    if (el === null) return "unknown";
    const cls = (el.getAttribute("class") || "").split(/\\s+/).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  // Effective, not own. getComputedStyle(el).opacity is the element's OWN
  // opacity: a child of an opacity-0 ancestor computes 1, and elementFromPoint
  // happily hits a fully transparent element. Checking only the element made the
  // walk report an 'opacity-0 group-hover:opacity-100' delete button as visible
  // AND interactive at 390px, manufacturing confidence about a control a phone
  // user cannot see.
  // aria-hidden / inert is the platform's own "not currently available" marker.
  // A closed off-canvas drawer sits outside the body's clip, so without this it
  // reports every one of its buttons as clipped_off on every audit.
  const inUnavailableSubtree = (el) => {
    for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
      if (n.getAttribute("aria-hidden") === "true") return true;
      if (n.hasAttribute("inert")) return true;
    }
    return false;
  };
  // An open dialog legitimately covers the page. Treating that as a defect would
  // flag every background control whenever an audit lands with a modal open.
  const isModalOverlay = (el) => {
    for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
      const role = n.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      if (n.getAttribute("aria-modal") === "true") return true;
      const b = n.getBoundingClientRect();
      const covers = (b.width * b.height) / Math.max(window.innerWidth * window.innerHeight, 1);
      const pos = getComputedStyle(n).position;
      if (covers > 0.6 && (pos === "fixed" || pos === "absolute")) return true;
    }
    return false;
  };
  const effectivelyInvisible = (el) => {
    for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === "hidden" || s.display === "none") return true;
      if (Number(s.opacity) === 0) return true;
    }
    return false;
  };
  // The nearest ancestor that clips or scrolls, and whether it can reach the rect.
  const clipStatus = (el, r) => {
    const area = Math.max(r.width * r.height, 1);
    for (let n = el.parentElement; n !== null && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const ox = s.overflowX, oy = s.overflowY;
      const clipsX = ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll";
      const clipsY = oy === "hidden" || oy === "clip" || oy === "auto" || oy === "scroll";
      if (!clipsX && !clipsY) continue;
      const b = n.getBoundingClientRect();
      // Fraction of the control the scrollport hides. A sliver left showing is as
      // unusable as none; a 2px trim is not a defect, so require most of it gone.
      const vw = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left));
      const vh = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
      const hiddenFrac = 1 - (vw * vh) / area;
      if (hiddenFrac < 0.5) return null;
      const offX = r.right > b.right || r.left < b.left;
      const offY = r.bottom > b.bottom || r.top < b.top;
      const scrollableX = (ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1;
      const scrollableY = (oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1;
      // A carousel the user can swipe to is not a defect; overflow hidden, or a
      // scrollport with no scroll range in the offending axis, is.
      if ((offX && scrollableX) || (offY && scrollableY)) {
        return { reachable: true, by: brief(n), px: 0 };
      }
      const px = Math.round(Math.max(
        r.right - b.right, b.left - r.left, r.bottom - b.bottom, b.top - r.top, 1));
      return { reachable: false, by: brief(n), px };
    }
    return null;
  };
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < 0 || r.top > window.innerHeight * 3) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const isInteractive =
      interactiveTags.has(tag) ||
      (role !== null && interactiveRoles.has(role)) ||
      el.hasAttribute("onclick") ||
      el.getAttribute("contenteditable") === "true";

    // Classify why a control is unusable rather than dropping it silently. A
    // dropped node tells the model nothing; "this button is under your fixed
    // FAB" tells it what to fix.
    // Not a defect and not a node: the author has marked this subtree
    // unavailable, so neither report it nor offer it as an act target.
    if (inUnavailableSubtree(el)) continue;
    if (effectivelyInvisible(el)) {
      if (isInteractive && unreachable.length < 25) {
        unreachable.push({ name: label(el), tag, reason: "invisible",
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
      continue;
    }
    const clip = clipStatus(el, r);
    if (clip !== null) {
      if (clip.reachable) {
        needsInnerScroll += 1;
      } else if (isInteractive && unreachable.length < 25) {
        unreachable.push({ name: label(el), tag, reason: "clipped_off",
          clipped_by: clip.by, overflow_px: clip.px,
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
      continue;
    }
    let hit = true;
    let occluder = null;
    if (r.top >= 0 && r.bottom <= window.innerHeight) {
      // Five samples, not one. The shipped defect was a fixed FAB shearing the
      // primary CTA: part covered, centre clear, invisible to a centre-only test.
      const probes = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
      let covered = 0;
      for (const [fx, fy] of probes) {
        const px = Math.min(Math.max(r.x + r.width * fx, 1), window.innerWidth - 1);
        const py = Math.min(Math.max(r.y + r.height * fy, 1), window.innerHeight - 1);
        const at = document.elementFromPoint(px, py);
        if (at === null || el.contains(at) || at.contains(el)) continue;
        if (isModalOverlay(at)) { covered = 0; break; }
        covered += 1;
        if (occluder === null) occluder = at;
      }
      // A majority covered is substantial; a clipped edge is not a defect.
      hit = covered < 3;
      if (hit) occluder = null;
    }
    if (!hit) {
      if (isInteractive && unreachable.length < 25) {
        unreachable.push({ name: label(el), tag, reason: "occluded",
          occluder: brief(occluder),
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
      continue;
    }
    candidates += 1;
    if (isInteractive) interactive += 1;
    if (out.length >= ${maxNodes}) continue;
    const name = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      (el.textContent || "")
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    const i = out.length + 1;
    el.setAttribute(${JSON.stringify(attr)}, String(i));
    out.push({
      i,
      role,
      name,
      tag,
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      enabled: !(el.disabled === true || el.getAttribute("aria-disabled") === "true"),
      interactive: isInteractive,
    });
  }
  // Second pass, wider scope: clipping lives on text-bearing spans, paragraphs
  // and table cells, which are not act targets and so are absent from the list
  // above. Every visual defect these audits historically missed was this shape —
  // a column truncated to "DA AP", a badge cut at its parent's edge, a heading
  // clipped at the viewport — so scan for it directly instead of leaving it to
  // whoever opens the screenshot.
  const clipped = [];
  let scanned = 0;
  for (const el of Array.from(document.body ? document.body.querySelectorAll("*") : [])) {
    if (scanned >= ${MAX_CLIP_SCAN}) break;
    scanned += 1;
    if (clipped.length >= 20) break;
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0,
    );
    if (!own) continue;
    const r2 = el.getBoundingClientRect();
    if (r2.width <= 0 || r2.height <= 0) continue;
    const cs2 = getComputedStyle(el);
    if (cs2.visibility === "hidden" || cs2.display === "none") continue;
    const truncPx = el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;
    const pastPx = r2.right - window.innerWidth;
    const kind = truncPx >= ${CLIP_MIN_PX}
      ? "text_truncated"
      : pastPx >= ${CLIP_MIN_PX}
        ? "past_viewport"
        : null;
    if (kind === null) continue;
    clipped.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      kind,
      overflow_px: Math.round(kind === "text_truncated" ? truncPx : pastPx),
      bbox: [Math.round(r2.x), Math.round(r2.y), Math.round(r2.width), Math.round(r2.height)],
    });
  }
  return {
    nodes: out,
    interactive_nodes: interactive,
    total_candidates: candidates,
    truncated: candidates > out.length,
    clipped,
    unreachable,
    needs_inner_scroll: needsInnerScroll,
  };
})()`;
}

/**
 * Freeze the clock and the RNG for the life of the page.
 *
 * A third of shipped artifacts render live time. Without this, every screenshot
 * of those differs from the last one for reasons that mean nothing — which
 * destroys round-to-round screenshot comparison and makes any assertion about a
 * displayed time permanently unsatisfiable (a test waiting for "25:00" on a
 * countdown is waiting for text that will never appear again once it ticks).
 *
 * Installed as an init script so it lands before artifact code runs.
 */
export function freezeTimeScript(epochMs: number): string {
  return `(() => {
  const FIXED = ${epochMs};
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) { super(FIXED); } else { super(...args); }
    }
    static now() { return FIXED; }
  }
  // Keep instanceof and the prototype chain intact for libraries that check.
  Object.defineProperty(FrozenDate, "name", { value: "Date" });
  globalThis.Date = FrozenDate;
  if (globalThis.performance) {
    let t = 0;
    globalThis.performance.now = () => (t += 16);
  }
  // Deterministic LCG so seeded shuffles/ids repeat across audit rounds.
  let seed = 0x2f6e2b1;
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
})()`;
}

/**
 * Wait for the artifact's own data layer to go idle.
 *
 * 95 of 96 shipped artifacts import the SDK's single `spaceQueryClient`, so
 * "is this app done loading" is a question the platform can answer instead of
 * one the model has to guess with a sleep. `installAuditSettleProbe` in the SDK
 * exposes the in-flight count; when it is absent (an artifact that predates the
 * hook, or a non-SDK page) fall back to Playwright's network idle.
 *
 * Returns how long settling took and whether it actually reached idle, so a
 * caller can report "still fetching after 8s" as a finding rather than silently
 * screenshotting a spinner.
 */
export async function settlePage(
  page: Page,
  networkIdleFallbackMs: number,
): Promise<{ settled: boolean; settle_ms: number; in_flight: number | null }> {
  const startedAt = Date.now();
  const probe = async (): Promise<number | null> => {
    try {
      return (await page.evaluate(
        "typeof window.__hatchAuditSettle === 'function' ? window.__hatchAuditSettle() : null",
      )) as number | null;
    } catch {
      // A navigation mid-poll invalidates the context; treat as unknown.
      return null;
    }
  };

  const first = await probe();
  if (first === null) {
    await page
      .waitForLoadState("networkidle", { timeout: networkIdleFallbackMs })
      .catch(() => {});
    return { settled: true, settle_ms: Date.now() - startedAt, in_flight: null };
  }

  let idleStreak = 0;
  let last = first;
  while (Date.now() - startedAt < SETTLE_POLL_TIMEOUT_MS) {
    last = (await probe()) ?? 0;
    idleStreak = last === 0 ? idleStreak + 1 : 0;
    if (idleStreak >= SETTLE_STABLE_POLLS) {
      return { settled: true, settle_ms: Date.now() - startedAt, in_flight: 0 };
    }
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
  }
  return { settled: false, settle_ms: Date.now() - startedAt, in_flight: last };
}

/** Run the walk against a live page. */
export async function observeNodes(page: Page): Promise<ObserveWalk> {
  return (await page.evaluate(
    observeWalkScript(NODE_SELECTOR, OBSERVE_ATTR, MAX_OBSERVE_NODES),
  )) as ObserveWalk;
}

/**
 * Playwright's accessibility snapshot of the visible tree.
 *
 * Best-effort: an `ariaSnapshot` failure must degrade the look, never fail it —
 * the numbered walk above is what `act` binds to, so a missing tree costs
 * semantics, not addressability.
 */
export async function ariaSnapshot(page: Page): Promise<string | null> {
  try {
    return await page.locator("body").ariaSnapshot();
  } catch {
    return null;
  }
}

/** Cut-off text the walk measured, reported as findings rather than left for
 *  whoever opens the screenshot to notice. */
export function clippedNodes(walk: ObserveWalk): ClippedNode[] {
  return (walk.clipped ?? []).filter((c) => c.text.trim().length > 0);
}

/** Names in the walk that no reader could act on, for the a11y finding. */
export function unnamedInteractiveNodes(walk: ObserveWalk): ObservedNode[] {
  return walk.nodes.filter((n) => n.interactive && isUselessName(n.name));
}
