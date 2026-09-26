"""Screenplay contract + validation + rendering to compose blocks.

v20: the pipeline is story-driven. The VO transcript is CANON — the story the
creator chose to tell. The screenplay dramatizes it: user asks, Muse replies,
skills run, visuals appear. Real artifacts upgrade a beat when they exist;
synthetic visuals from the fact sheet fill in when they don't.

A screenplay is a plain dict:

    {
      "duration": 32.0,     # the VO's length in seconds, and the denominator
                            # of the coverage floor. ./mm supplies the
                            # transcript's measurement instead when there is
                            # one; with neither, the screenplay is rejected
                            # rather than the gate being skipped.
      "facts": {            # ONE invented world state; every synthetic detail
        "flight_no": "DL 1487",   # on any card/bubble comes from here, so the
        "conf_code": "QXK4TP",    # seat map can never disagree with the receipt
        ...
      },
      "canon": ["San Francisco", "Tuesday", "SkyMiles"],  # must appear in VO
      "beats": [
        {"type": "bubble", "speaker": "user"|"muse", "text": "...",
         "start": 3.6, "end": 6.4},
        {"type": "visual", "html": "<html>…receipt…</html>",  # synthetic beat:
         "start": 24.6, "end": 28.6},                          # authored fresh
        {"type": "visual", "image": "/path/real_crop.png",   # grounded beat:
         "start": 9.4, "end": 13.0},                          # real material wins
      ],
    }

validate_script() is the lint — the generator is never trusted:
  canon strings appear in the transcript; invented-looking tokens trace to the
  fact sheet or the transcript; timing obeys the pacing bounds, the live-beat
  depth cap, and the coverage floor.
render_script() turns a valid screenplay into compose() blocks, rendering
each visual and reporting per-visual provenance (real | synthetic-html).
"""

import os
import re

from PIL import Image

# pacing bounds (seconds) — the craft rules, mechanically enforced
BUBBLE_MIN, BUBBLE_MAX = 1.2, 4.5
VISUAL_MIN, VISUAL_MAX = 2.2, 5.0
MAX_STACKED_BUBBLES = 3  # concurrent LIVE beats of any type
# The scene should RARELY be empty: beats may OVERLAP (a reply pops while
# the ask is still up; older messages ride up the stack), so a screenplay
# can keep the lane alive without flooding the stage.
MIN_COVERAGE = 0.65  # fraction of the video with something on screen
# The renderer ends every video with the full-screen Muse finisher
# (compose owns it): the frame fades to the lockup's white for the final
# FINISHER_SECS and the video runs a short extension tail past the
# footage. The validator keeps that window clear of authored beats, and
# the coverage denominator excludes it.
FINISHER_SECS = 4.5

# tokens that look like invented specifics: flight numbers, codes, prices,
# card last-4s, times. These must trace to facts or transcript.
# The confirmation-code pattern REQUIRES at least one digit: plain 6-letter
# caps words (AMOUNT, BOOKED, FLIGHT, TRAVEL) are English, not codes — an
# agent run burned a cycle appeasing that false positive.
_SPECIFIC = re.compile(
    r"\b[A-Z]{2}\s?\d{2,4}\b|\b(?=[A-Z0-9]{6}\b)[A-Z]*\d[A-Z0-9]*\b"
    r"|\$\d[\d,.]*|•{3,}\s?\d{2,4}|\b\d{1,2}:\d{2}\b"
)


def _norm(s):
    """Normalize before fact matching: any bullet run -> one bullet, collapse
    whitespace. '•••• 1006' in a card must match fact '••• 1006' — an agent
    run tripped on the bullet COUNT differing."""
    return re.sub(r"\s+", " ", re.sub(r"•+", "•", s))


class ScriptError(ValueError):
    """The screenplay violates canon, consistency, or pacing."""


# Bubbles are MESSAGES, not captions. The VO narrates ABOUT the
# conversation ("all I did was tell it I needed a flight"); a bubble
# quoting that narration ("I just told it…") shipped in a real video and
# read as a caption wearing a bubble. Deliberately narrow — only the
# unambiguous third-person-narration shapes; the send test in the
# builder's seat prompt owns the rest.
_NARRATION = re.compile(
    r"\bI\s+(?:just\s+)?(?:told|asked|said\s+to)\s+(?:it|muse)\b"
    r"|\bit\s+was\s+able\s+to\b",
    re.IGNORECASE,
)

# Cards are glanced at PHONE size for ~3s: at the fixed 1240px authoring
# width everything lands at roughly half scale on the canvas, so
# web-instinct 22px captions render as invisible clutter (shipped once).
# px only (the authoring width is fixed, so px values are comparable).
#
# The floors are anchored to the thread chrome, not taste: bubbles draw at
# overlay px(36) (36/720 of canvas width) and a card's 1240px authoring
# width lands at card.CARD_W=640 base (640/720), so authored card px render
# at 640/1240 of bubble scale. Bubble parity is 36 * 1240 / 640 = 69.75.
# A card whose biggest line sits under conversation scale reads "web-shrunk"
# next to the bubbles around it — that shipped, and it is the failure these
# two gates exist for: nothing tiny, and at least one line at or above the
# scale of the conversation it sits in.
_FONT_SIZE = re.compile(r"font-size\s*:\s*([\d.]+)\s*([a-z%]*)", re.IGNORECASE)
_STYLE_BLOCK = re.compile(r"<style[^>]*>(.*?)</style>", re.IGNORECASE | re.DOTALL)
# `body` as a whole selector token only: `[^-\w.#]` rejects `.body`,
# `#body`, and `tbody`.
_BODY_RULE = re.compile(r"(?:^|[^-\w.#])body\s*(?:,[^{]*)?\{([^}]*)\}",
                        re.IGNORECASE | re.DOTALL)
_BODY_TAG_STYLE = re.compile(r"<body[^>]*\bstyle\s*=\s*[\"']([^\"']*)[\"']",
                             re.IGNORECASE)
_SURFACE_DECL = re.compile(
    r"\b(background(?:-color|-image)?\s*:\s*(?!\s*(?:transparent|none)\b)"
    r"[^;}\"']+|border\s*:[^;}\"']+|box-shadow\s*:[^;}\"']+)",
    re.IGNORECASE)


def _body_surface_declaration(html):
    """First surface declaration (background/border/box-shadow) on the page
    body, or None. The body must stay bare: any surface there renders as a
    full-bleed wrapper behind the components' own cards."""
    blobs = [m.group(1) for style in _STYLE_BLOCK.finditer(html)
             for m in _BODY_RULE.finditer(style.group(1))]
    blobs += [m.group(1) for m in _BODY_TAG_STYLE.finditer(html)]
    for blob in blobs:
        m = _SURFACE_DECL.search(blob)
        if m:
            return m.group(1).strip()
    return None


_CLASS_RULE = re.compile(r"\.([\w-]+)\s*\{([^}]*)\}", re.DOTALL)
_PAD_TOP = re.compile(r"padding(?:-top)?\s*:\s*([\d.]+)px", re.IGNORECASE)
_RADIUS_PX = re.compile(r"border-radius\s*:\s*([\d.]+)px", re.IGNORECASE)


def _find_nested_card_surface(html):
    """(nested, bare) surface violations in authored card HTML.

    nested: a card-sized filled element sitting INSIDE another filled
    element — the double-background failure in its class-based form
    (the body-level form is caught separately): a wrapper card holding
    message bubbles or a full-width tinted panel. 'Card-sized' means
    filled + border-radius >= 40px + vertical padding >= 30px at 1240
    authoring width, which admits chips, pills, tabs, and buttons
    (small padding) on a card.

    bare: visible text with NO filled element anywhere above it —
    content sitting directly on the video, which washes out on real
    footage. Every component is one solid card."""
    from html.parser import HTMLParser

    class_styles = {}
    body_decl = ""
    for style in _STYLE_BLOCK.finditer(html):
        for m in _CLASS_RULE.finditer(style.group(1)):
            class_styles[m.group(1)] = class_styles.get(m.group(1), "") \
                + ";" + m.group(2)
        for m in _BODY_RULE.finditer(style.group(1)):
            body_decl += ";" + m.group(1)

    def has_fill(decl):
        m = re.search(r"background(?:-color)?\s*:\s*([^;]+)", decl,
                      re.IGNORECASE)
        return bool(m) and not re.match(r"\s*(transparent|none)\b",
                                        m.group(1), re.IGNORECASE)

    def cardish(decl):
        # Card-sized: filled, meaningfully padded, card-range radius. The
        # radius has an UPPER bound because pills are their own idiom: a
        # kit card scales to ~75px radius while pill chips and buttons
        # declare 999px, and kit button padding (8px x3.75 = 30px) sits
        # right at the padding floor — without the upper bound, Approve /
        # Not now buttons on a card read as nested cards.
        pads = [float(v) for v in _PAD_TOP.findall(decl)]
        radii = [float(v) for v in _RADIUS_PX.findall(decl)]
        return (has_fill(decl) and pads and max(pads) >= 30
                and radii and 40 <= max(radii) < 200)

    hits = []
    bare = []

    class Walker(HTMLParser):
        def __init__(self):
            super().__init__()
            self.fill_depth = 0
            self.stack = []
            self.skip_text = 0

        def handle_starttag(self, tag, attrs):
            if tag in ("br", "img", "hr", "meta", "link", "input"):
                return
            if tag in ("style", "script", "title"):
                self.skip_text += 1
            a = dict(attrs)
            decl = a.get("style", "")
            if tag == "body":
                decl += ";" + body_decl
            for cls in (a.get("class") or "").split():
                decl += ";" + class_styles.get(cls, "")
            filled = has_fill(decl)
            if self.fill_depth > 0 and cardish(decl):
                label = (a.get("class") or tag).split()[0]
                hits.append(label)
            self.stack.append(filled)
            if filled:
                self.fill_depth += 1

        def handle_endtag(self, tag):
            if tag in ("br", "img", "hr", "meta", "link", "input"):
                return
            if tag in ("style", "script", "title"):
                self.skip_text -= 1
            if self.stack and self.stack.pop():
                self.fill_depth -= 1

        def handle_data(self, data):
            if self.skip_text == 0 and self.fill_depth == 0 and data.strip():
                bare.append(data.strip()[:40])

    Walker().feed(html)
    return (hits[0] if hits else None), (bare[0] if bare else None)
_CSS_RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")
_CLASS_ATTR = re.compile(
    r"class\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", re.IGNORECASE)
# Match the whole attribute by its OPENING quote: style values legally
# contain the other quote kind (font-family:'Nunito').
_INLINE_STYLE = re.compile(
    r"style\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", re.IGNORECASE)
_TAG = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)")
MIN_HTML_FONT_PX = 32
MIN_HTML_DOMINANT_FONT_PX = 56  # kit titles (~15-16px at 330) scaled x3.75


def _placeholder_marker(html):
    """The first unfilled placeholder signature in authored card HTML, or None.

    Every media slot in the Muse Moments Kit carries data-ph="image|
    screenshot"; copied markup keeps the attribute until the slot is filled
    with real media, so its presence means the card ships a placeholder. The
    striped+dashed look of older kits is caught as a second signature.
    """
    low = html.lower()
    m = re.search(r'data-ph\s*=\s*["\']?([a-z-]+)', low)
    if m:
        return f'data-ph="{m.group(1)}"'
    if "repeating-linear-gradient" in low and "dashed" in low:
        return "striped/dashed placeholder block"
    return None


def _font_sizes_in(css_text, where):
    """px font-sizes in a CSS declaration blob; non-px is an authoring error."""
    out = []
    for m in _FONT_SIZE.finditer(css_text):
        size, unit = float(m.group(1)), (m.group(2) or "px").lower()
        if unit != "px":
            raise ScriptError(
                f"{where}: font-size in '{unit}' — use px only (the 1240px "
                "authoring width is fixed, so px sizes are comparable)"
            )
        out.append(size)
    return out


def _used_font_sizes_px(html, beat_start):
    """Font sizes that actually reach the screen: inline styles, plus
    <style> rules whose selector matches the markup (a used class, a tag
    present in the body, or body/html/*). An unused rule's
    declarations therefore do not count toward the size gates."""
    where = f"visual beat @{beat_start}"
    markup = _STYLE_BLOCK.sub("", html)
    used_classes = set()
    for m in _CLASS_ATTR.finditer(markup):
        used_classes.update((m.group(1) or m.group(2) or "").split())
    used_tags = {t.lower() for t in _TAG.findall(markup)}

    sizes = []
    for m in _INLINE_STYLE.finditer(markup):
        sizes.extend(_font_sizes_in(m.group(1) or m.group(2) or "", where))
    for style in _STYLE_BLOCK.finditer(html):
        for rule in _CSS_RULE.finditer(style.group(1)):
            selectors, body = rule.group(1), rule.group(2)
            rule_sizes = _font_sizes_in(body, where)
            if not rule_sizes:
                continue
            applies = False
            for sel in selectors.split(","):
                sel = re.sub(r"::?[\w-]+(\([^)]*\))?", "", sel).strip()
                if not sel:
                    continue
                tokens = re.findall(r"[.#]?[\w-]+", sel)
                if not tokens:
                    continue
                ok = True
                for tok in tokens:
                    if tok.startswith("."):
                        ok = ok and tok[1:] in used_classes
                    elif tok.startswith("#"):
                        ok = ok and ('id="' + tok[1:]) in markup.replace("\'", '"')
                    elif tok in ("body", "html", "*"):
                        pass
                    else:
                        ok = ok and tok.lower() in used_tags
                if ok:
                    applies = True
                    break
            if applies:
                sizes.extend(rule_sizes)
    return sizes


# Em-dashes are out of Muse's user-facing copy, and bubble/chip text IS
# user-facing copy — it is burned into the video. Models reach for one in
# roughly every other generated reply, so this is a lint, not a note.
_EM_DASH = re.compile(r"—")

# Fields every beat kind must carry before anything indexes them.
_REQUIRED_FIELDS = {
    "bubble": ("start", "end", "speaker", "text"),
    "typing": ("start", "end"),
    "visual": ("start", "end"),
    "video": ("start", "end", "video"),
    "browser": ("start", "end", "pages"),
    "reaction": ("start", "target", "emoji"),
}


def _blank(v):
    return v is None or (isinstance(v, str) and not v.strip())


def _beat_bounds(beat):
    kind = beat["type"]
    dur = beat["end"] - beat["start"]
    lo, hi = {
        "bubble": (BUBBLE_MIN, BUBBLE_MAX),
        "typing": (0.6, 3.0),
        "visual": (VISUAL_MIN, VISUAL_MAX),
        "video": (1.5, 12.0),
        # one browser owns a whole journey: far past the visual cap on
        # purpose (the renderer, not a capture, animates the session)
        "browser": (5.0, 20.0),
    }[kind]
    return dur, lo, hi


def _beat_strings(beat):
    if beat["type"] == "bubble":
        yield beat.get("text", "")
    if beat.get("html"):
        from .html_assets import strip_tags
        yield strip_tags(beat["html"])
    # rebuilt browser pages carry the same invented-specifics burden as
    # cards: every price, product name, and time on them is lintable
    for page in beat.get("pages") or []:
        if isinstance(page, dict) and page.get("html"):
            from .html_assets import strip_tags
            yield strip_tags(page["html"])


def normalize_script(script):
    """Resolve authoring defaults once, before mechanical validation."""
    import copy
    import math
    if not isinstance(script, dict):
        raise ScriptError("screenplay must be a JSON object")
    script = copy.deepcopy(script)
    beats = script.get("beats")
    if not isinstance(beats, list) or not beats:
        raise ScriptError("beats must be a nonempty array")
    if not isinstance(script.get("facts", {}), dict):
        raise ScriptError("facts must be an object of sourced details")
    for i, b in enumerate(beats):
        if not isinstance(b, dict):
            raise ScriptError(f"beat #{i} must be an object")
        for field in ("start", "end", "target"):
            if field in b and (type(b[field]) not in (int, float)
                              or not math.isfinite(b[field]) or b[field] < 0):
                raise ScriptError(f"beat #{i}: {field} must be finite nonnegative seconds")
        if b.get("type") == "bubble":
            if b.get("speaker") not in ("user", "muse"):
                raise ScriptError(f"beat #{i}: speaker must be user or muse")
            if not isinstance(b.get("text"), str):
                raise ScriptError(f"beat #{i}: text must be a string")
        for field in ("tap", "shell", "hero"):
            if field in b and type(b[field]) is not bool:
                raise ScriptError(f"beat #{i}: {field} must be boolean")
        if b.get("type") == "visual" and bool(b.get("html")) == bool(b.get("image")):
            raise ScriptError(f"beat #{i}: choose exactly one of html or image")
        if b.get("html") and (b.get("shell") or b.get("hero")):
            raise ScriptError(f"beat #{i}: authored HTML already supplies its surface; remove shell/hero")
        if b.get("image") or b.get("type") == "video":
            origin = b.get("provenance")
            if not isinstance(origin, dict) or origin.get("kind") not in (
                    "original-media", "historical-capture", "current-capture",
                    "reconstructed-ui", "synthetic-illustration") or not origin.get("source"):
                raise ScriptError(f"beat #{i}: file media needs provenance kind and source/state")
        pages = b.get("pages", [])
        if not isinstance(pages, list):
            raise ScriptError(f"beat #{i}: pages must be an array")
        for page in pages:
            if not isinstance(page, dict):
                raise ScriptError(f"beat #{i}: each page must be an object")
            click = page.get("click")
            if isinstance(click, (list, tuple)) and (len(click) != 2 or any(
                    type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1
                    for v in click)):
                raise ScriptError(f"beat #{i}: click coordinates must be between 0 and 1")
        for html in [b.get("html", "")] + [p.get("html", "") for p in pages]:
            if not isinstance(html, str):
                raise ScriptError(f"beat #{i}: html must be a string")
            if re.search(r"<script\b|\bon\w+\s*=|javascript:|<iframe\b", html, re.I):
                raise ScriptError(f"beat #{i}: authored cards support HTML/CSS only; remove executable content")
            if re.search(r"<style[^>]*>(?:(?!</style>).)*<style", html, re.I | re.S):
                raise ScriptError(f"beat #{i}: nested style tag breaks animation rules")
    for b in beats:
        if "tap" not in b and b.get("type") in ("visual", "video", "browser"):
            b["tap"] = bool((b.get("image") or b["type"] in ("video", "browser"))
                and "start" in b and "end" in b and b["end"] - b["start"] >= 3.2
                and not any(o is not b and o.get("type") != "reaction"
                    and b["start"] < o.get("start", -1) < b["end"] for o in beats))
    return script


def validate_script(script, transcript_text, words=None, duration=None):
    """Raise ScriptError on the first violation; return per-check counts.

    `words` (optional) is the whisper word list [{"word","start","end"},…];
    when present it powers the anti-preempt floor: no beat may start
    before the creator's first spoken word.

    `duration` (optional) is the creator video's length as the transcript
    measured it — the canonical value, preferred over the screenplay's own
    key. One or the other must exist: it is the coverage gate's denominator.
    """
    script = normalize_script(script)
    beats = script["beats"]
    facts = script.get("facts") or {}
    if not beats:
        raise ScriptError("screenplay has no beats")
    tl = transcript_text.lower()

    # 0. shape. Everything below (and both renderers) indexes these fields
    #    directly, so an authoring typo — a beat with no "end", a bubble with
    #    no "text" — used to escape as a bare KeyError traceback. This CLI's
    #    whole contract with the agent is ONE actionable line, and a
    #    traceback is neither.
    for i, beat in enumerate(beats):
        kind = beat.get("type")
        if kind == "chip":
            raise ScriptError(
                f"beat #{i} is a chip — chip beats are RETIRED: work is "
                "depicted by cards now (the kit's driving/status "
                "components), not spinner pills. Replace it with a visual "
                "or drop it")
        if kind not in _REQUIRED_FIELDS:
            raise ScriptError(
                f"beat #{i} has type {kind!r}; expected one of "
                + ", ".join(sorted(_REQUIRED_FIELDS))
            )
        missing = [f for f in _REQUIRED_FIELDS[kind] if _blank(beat.get(f))]
        if missing:
            raise ScriptError(
                f"{kind} beat #{i} (start={beat.get('start')}) is missing "
                f"{', '.join(missing)} — run ./mm example for the shape"
            )
        for f in ("start", "end", "target"):
            if f in beat and not isinstance(beat[f], (int, float)):
                raise ScriptError(
                    f"{kind} beat #{i}: '{f}' is {beat[f]!r}; beats are plain "
                    "seconds as numbers, never strings or frame indices"
                )

    # 1. canon: everything the screenplay leans on must be in the VO
    for c in script.get("canon") or []:
        if c.lower() not in tl:
            raise ScriptError(f"canon entity '{c}' is not in the transcript; "
                              "the VO is the story — do not extend it")

    # 1b. bubbles are messages someone would SEND, not narration about the
    #     conversation
    for beat in beats:
        if beat["type"] == "bubble" and _NARRATION.search(beat.get("text", "")):
            raise ScriptError(
                f"bubble @{beat['start']} ({beat.get('text', '')!r}) narrates "
                "the conversation instead of being a message in it — CONVERT "
                "this beat to the message the creator describes sending "
                "('Need a flight on Tuesday'), never the sentence about it "
                "('I just told it…'). Do NOT delete the turn: every narrated "
                "ask still gets its user bubble"
            )

    # 1b-ii. on-screen copy follows Muse's copy rules
    for beat in beats:
        if beat["type"] == "bubble" and _EM_DASH.search(beat["text"]):
            raise ScriptError(
                f"{beat['type']} @{beat['start']} ({beat['text']!r}) uses an "
                "em-dash; Muse's user-facing copy does not. Split the "
                "sentence ('On it. Searching Delta flights') or use a colon "
                "for a label ('Booked DL 1487: Tuesday 7:40am')"
            )

    # 1c. HTML cards must be glanceable at phone size. Only sizes that
    #     REACH THE SCREEN count: inline styles, plus <style> rules whose
    #     selector matches something in the markup. Copied kit markup
    #     declares roles up to 140px, so scanning raw text would let a
    #     small-type-only card pass on unused declarations.
    for beat in beats:
        html = beat.get("html") or ""
        if not html:
            continue
        sizes = _used_font_sizes_px(html, beat["start"])
        for size in sizes:
            if size < MIN_HTML_FONT_PX:
                raise ScriptError(
                    f"visual beat @{beat['start']}: font-size {size:g}px is "
                    f"below the {MIN_HTML_FONT_PX}px floor at 1240 authoring "
                    "width — scale the kit component's px values by 3.75 "
                    "(see /opt/hatch/skills/magic-moment/reference/design.md); a "
                    "kit 9px label lands at 34px, never below 32px"
                )
        _visible_text = re.sub(r"<[^>]+>", " ", re.sub(
            r"<style[^>]*>.*?</style>", " ", html,
            flags=re.IGNORECASE | re.DOTALL))
        if not _visible_text.strip():
            # a genuinely text-free media grid (the mobile image picker is
            # a bare 2x2 of images by canon) has nothing for the font
            # gates to protect — skip them rather than demanding a caption
            # the design bans
            sizes = None
        if sizes is not None and not sizes:
            raise ScriptError(
                f"visual beat @{beat['start']}: no font-size reaches the "
                "screen (no inline style and no <style> rule matching the "
                "markup), so text renders at the 16px browser default. "
                "Copy a Muse Moments Kit component and scale it x3.75 "
                "(see /opt/hatch/skills/magic-moment/reference/design.md)"
            )
        if sizes and max(sizes) < MIN_HTML_DOMINANT_FONT_PX:
            raise ScriptError(
                f"visual beat @{beat['start']}: largest RENDERED font-size "
                f"is {max(sizes):g}px, under {MIN_HTML_DOMINANT_FONT_PX}px "
                "— every card needs one line at title scale (a kit 15px "
                "title scaled x3.75 is 56px). Unused declarations do not "
                "count. Fix by scaling the WHOLE component uniformly "
                "(inner type/padding/icons by 56/<largest px>) with the "
                "outer width capped at the 1240px canvas — never by "
                "inflating one line alone"
            )
        surface = _body_surface_declaration(html)
        if surface:
            raise ScriptError(
                f"visual beat @{beat['start']}: the page body carries a "
                f"surface ({surface}). Every component is one card that "
                "carries its own surface; the kit page's outer white frame "
                "is display chrome, not part of the component (see "
                "/opt/hatch/skills/magic-moment/reference/design.md, 'One card per "
                "component'). Remove background/border/box-shadow "
                "from body and put every surface on the component "
                "elements themselves (like ./mm example's .pad wrapper)"
            )
        nested, bare = _find_nested_card_surface(html)
        if nested:
            raise ScriptError(
                f"visual beat @{beat['start']}: card-sized filled element "
                f"('{nested}') sits inside another filled element — the "
                "double-background failure. A component is ONE card with "
                "flat content: show a message as a flat row (sender label "
                "+ text + a small status chip), never as a filled bubble "
                "or tinted panel inside the card (see /opt/hatch/skills/"
                "magic-moment/reference/design.md, 'One card per "
                "component'). Chips, tabs, and buttons (small padding) "
                "may sit on a card; a padded rounded filled panel may not"
            )
        ph = _placeholder_marker(html)
        if ph:
            raise ScriptError(
                f"visual beat @{beat['start']}: unfilled placeholder ({ph}) "
                "is still in the card. Kit placeholder slots never ship: put "
                "real media in every slot — a real screenshot or crop, or "
                "generated media — or remove the slot. No placeholder "
                "content in a final video"
            )
        if bare:
            raise ScriptError(
                f"visual beat @{beat['start']}: visible text ({bare!r}) "
                "has no filled surface anywhere above it, so it sits "
                "directly on the video and washes out on real footage. "
                "Every component is one solid card; put the content on "
                "it (see /opt/hatch/skills/magic-moment/reference/design.md, "
                "'One card per component')"
            )

    # 1d. tap mechanics: visual beats only, with enough beat time for
    #     press + grow + hold + settle, and an exclusive window — a beat
    #     landing mid-tap shifts the stack under the grown card.
    for b in beats:
        if not b.get("tap"):
            continue
        if b["type"] not in ("visual", "video", "browser"):
            raise ScriptError(
                f"beat @{b['start']}: \"tap\" belongs on a visual, video, "
                "or browser beat — it is the visual emphasis effect"
            )
        if b["end"] - b["start"] < 3.0:
            raise ScriptError(
                f"tap beat @{b['start']} runs {b['end'] - b['start']:.2f}s "
                "— the tap needs at least 3s to press, grow, hold, and "
                "settle back. Lengthen the beat or drop the tap"
            )
        for other in beats:
            if other is b or other["type"] == "reaction":
                continue
            if b["start"] < other["start"] < b["end"]:
                raise ScriptError(
                    f"beat @{other['start']} ({other['type']}) starts "
                    f"inside the tap window @{b['start']}-{b['end']} — "
                    "the grown card owns the thread for its whole beat; "
                    "a message landing mid-tap shoves it around. Move "
                    "the beat after the tap ends"
                )

    # 2. invented specifics must trace to the fact sheet or the transcript
    fact_blob = _norm(" ".join(str(v) for v in facts.values()))
    tl_norm = _norm(tl)
    for beat in beats:
        for s in _beat_strings(beat):
            for tok in _SPECIFIC.findall(_norm(s)):
                if tok in fact_blob or tok.lower() in tl_norm:
                    continue
                raise ScriptError(
                    f"'{tok}' in beat @{beat['start']} is a specific detail "
                    "that has no source; remove it or cite actual evidence "
                    "in the fact sheet"
                )

    # 2b. rhythm. Two failures that shipped in one video (2026-09-01): a
    #     payoff visual starting 0.3s BEFORE its announce bubble, and typing
    #     dots "answered" by a video instead of the reply they promise.
    #     Targeted, not blanket: chat-natural patterns stay legal — rapid
    #     double-text bubbles, and dots popping right after an ask.
    _rhythm = sorted([b for b in beats if b["type"] != "reaction"],
                     key=lambda b: b["start"])
    _payoff = ("visual", "photo", "video", "browser")
    for _prev, _nxt in zip(_rhythm, _rhythm[1:]):
        if _prev["type"] == "typing":
            if _nxt["type"] != "bubble" or _nxt.get("speaker") != "muse":
                raise ScriptError(
                    f"typing @{_prev['start']} is followed by a "
                    f"{_nxt['type']} @{_nxt['start']} — the dots promise a "
                    "Muse reply; the next beat after typing must be the "
                    "muse bubble it announces"
                )
            continue
        if _nxt["type"] == "typing":
            continue  # dots may pop right after an ask
        _gap = _nxt["start"] - _prev["start"]
        if _nxt["type"] in _payoff and _gap < 0.8:
            raise ScriptError(
                f"{_nxt['type']} @{_nxt['start']} starts {_gap:.2f}s after "
                f"the {_prev['type']} @{_prev['start']} — give the announce "
                "at least 0.8s to land before its payoff appears"
            )
        if _prev["type"] in _payoff and _nxt["type"] == "bubble" and _gap < 0.8:
            raise ScriptError(
                f"bubble @{_nxt['start']} starts {_gap:.2f}s after the "
                f"{_prev['type']} @{_prev['start']} — an announce arriving "
                "on its payoff's heels reads out of order; announce FIRST, "
                "then the visual (or give them air)"
            )

    # 3. timing. Beats may OVERLAP (conversation stacking — a reply pops
    #    while the ask is still up; older messages ride up the stack); the
    #    depth cap below keeps the stage from flooding. The lane should
    #    rarely be empty.
    reactions = [b for b in beats if b["type"] == "reaction"]
    bubble_starts = {round(b["start"], 3) for b in beats if b["type"] == "bubble"}
    for r in reactions:
        if not r.get("emoji"):
            raise ScriptError("reaction beat needs an 'emoji'")
        if round(r.get("target", -1), 3) not in bubble_starts:
            raise ScriptError(
                f"reaction @{r.get('start')} must target an existing bubble "
                "start time")
        if r["start"] < r["target"] + 0.4:
            raise ScriptError("a reaction lands >=0.4s after its bubble pops")
    ordered = sorted([b for b in beats if b["type"] != "reaction"],
                     key=lambda b: b["start"])
    # The thread REACTS to the narration, never predicts it. The mechanical
    # floor: nothing pops before the creator has said ANYTHING (a real run
    # fired its first bubble at 0.8s against an anchor spoken at 6.0s).
    # Anchoring each beat to the specific word it echoes stays authoring
    # discipline — no lint can know the anchor.
    if words:
        first_word = min(w["start"] for w in words)
        if ordered and ordered[0]["start"] < first_word - 0.05:
            raise ScriptError(
                f"beat @{ordered[0]['start']} pops before the creator starts "
                f"speaking (first word at {first_word}s) — the thread reacts "
                "to the narration; start the beat at (or just after) the "
                "word it echoes"
            )
    for beat in ordered:
        if beat["type"] == "video" and not os.path.exists(
                os.path.expanduser(str(beat.get("video", "")))):
            raise ScriptError(
                f"video beat @{beat['start']}: file not found: "
                f"{beat.get('video')}")
        if beat["type"] == "visual":
            if not (beat.get("image") or beat.get("html")):
                raise ScriptError(
                    f"visual beat @{beat['start']} needs an 'image' (real "
                    "material) or 'html' (authored card) — HTML is the only "
                    "synthetic visual path")
            if beat.get("image") and not os.path.exists(
                    os.path.expanduser(str(beat["image"]))):
                raise ScriptError(
                    f"visual beat @{beat['start']}: image not found: "
                    f"{beat['image']}")
        if beat["type"] == "browser":
            pages = beat.get("pages") or []
            if len(pages) < 2:
                raise ScriptError(
                    f"browser beat @{beat['start']} needs at least 2 "
                    "'pages' (the rebuilt pages of ONE journey — "
                    "never one card per page)")
            # Rebuilt pages are generated WITH the real site on screen:
            # every browser beat names the capture(s) it rebuilds from,
            # so fidelity is checkable and grounding is a contract, not
            # a hope. No capture and no live snap => no browser beat.
            refs = beat.get("reference") or []
            if isinstance(refs, str):
                refs = [refs]
            if not refs:
                raise ScriptError(
                    f"browser beat @{beat['start']} needs 'reference': "
                    "the real screenshot(s) these pages rebuild "
                    "(./mm webshots copies, or ./mm snap <url>). With "
                    "no reference capture there is no browser beat — "
                    "present the skill that did the work instead")
            for ref in refs:
                if not os.path.exists(os.path.expanduser(str(ref))):
                    raise ScriptError(
                        f"browser beat @{beat['start']}: reference "
                        f"capture not found: {ref}")
            for i, page in enumerate(pages):
                if not isinstance(page, dict) or _blank(page.get("html")):
                    raise ScriptError(
                        f"browser beat @{beat['start']}: pages[{i}] needs "
                        "an 'html' string — each page is a rebuilt "
                        "viewport of the site, authored at 1240px wide")
                click = page.get("click")
                if i < len(pages) - 1:
                    ok = (isinstance(click, str) and click.strip()) or (
                        isinstance(click, (list, tuple)) and len(click) == 2)
                    if not ok:
                        raise ScriptError(
                            f"browser beat @{beat['start']}: pages[{i}] "
                            "needs a 'click' (a CSS selector for the "
                            "element the cursor presses to reach the next "
                            "page, e.g. '#add-to-cart')")
            addr = beat.get("address")
            if isinstance(addr, (list, tuple)) and len(addr) != len(pages):
                raise ScriptError(
                    f"browser beat @{beat['start']}: 'address' list must "
                    "match 'pages' one-to-one (or be a single string)")
        if beat["start"] >= beat["end"]:
            raise ScriptError(f"beat @{beat['start']} has start >= end")
        dur, lo, hi = _beat_bounds(beat)
        if not (lo <= dur <= hi):
            raise ScriptError(
                f"{beat['type']} @{beat['start']} runs {dur:.2f}s; "
                f"pacing bound is {lo}-{hi}s"
            )
    # Everything is a thread message now — no exclusivity. Depth caps the
    # number of LIVE beats (any type) so the stage never floods at once;
    # older messages riding up the fade band don't count.
    for i, a in enumerate(ordered):
        depth = sum(1 for b in ordered
                    if b["start"] <= a["start"] < b["end"])
        if depth > MAX_STACKED_BUBBLES:
            raise ScriptError(
                f"{depth} bubbles stacked at t={a['start']}; max "
                f"{MAX_STACKED_BUBBLES} on screen"
            )

    # 4. coverage: the scene should rarely be empty
    report = {"beats": len(beats), "canon": len(script.get("canon") or []),
              "facts": len(facts)}
    # `duration` is the denominator, so a screenplay that omits it used to
    # skip this gate entirely and pass — silently losing the one check that
    # catches a half-empty video. The transcript's measurement wins when the
    # caller has one (it is the video's real length, not the author's guess);
    # otherwise the screenplay must carry it.
    duration = duration or script.get("duration")
    if not duration:
        raise ScriptError(
            "screenplay needs a 'duration' (the creator video's length in "
            "seconds, as ./mm transcribe reports it); it is the denominator "
            "for the coverage gate"
        )
    # The video's final FINISHER_SECS belong to the renderer's
    # full-screen Muse finisher (compose arms it on every video). Every
    # authored beat has to be over before that window opens.
    cutoff = duration
    if cutoff <= 0:
        raise ScriptError(
            f"the video is {duration:.1f}s but the final "
            f"{FINISHER_SECS:g}s belong to the Muse finisher — "
            "the footage is too short to carry a story")
    for beat in beats:
        beat_end = beat.get("end", beat.get("start", 0))
        if beat_end > cutoff + 0.01:
            raise ScriptError(
                f"{beat['type']} @{beat['start']} runs to {beat_end}s; the "
                f"video's final {FINISHER_SECS:g}s belong to the Muse "
                f"finisher — end every beat by {cutoff:.1f}s")
    spans = sorted((b["start"], b["end"]) for b in beats
                   if b["type"] != "reaction")
    covered, cur_s, cur_e = 0.0, *spans[0]
    for s, e in spans[1:]:
        if s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            covered += cur_e - cur_s
            cur_s, cur_e = s, e
    covered += cur_e - cur_s
    # The finisher window is quiet by law, so it leaves the denominator:
    # otherwise short videos could never reach the floor.
    report["coverage"] = round(covered / max(0.1, duration), 3)
    report["validation"] = "mechanical only; semantic and rendered review required"
    return report


def render_script(script, *, capture_fps=24):
    """Screenplay -> (compose blocks, provenance list).

    A visual beat with "image" set uses the real file and is reported as
    provenance "real"; HTML beats are "synthetic-html".
    """
    script = normalize_script(script)
    blocks, provenance = [], []
    beats_sorted = sorted(script["beats"], key=lambda b: b["start"])

    def _av_tap_default(beat):
        return beat.get("tap", False)

    for beat in beats_sorted:
        if beat["type"] in ("typing", "reaction"):
            blocks.append(dict(beat))
        elif beat["type"] == "bubble":
            blocks.append({
                "type": "bubble",
                "is_muse": beat.get("speaker") == "muse",
                "text": beat["text"],
                "start": beat["start"], "end": beat["end"],
            })
        elif beat["type"] == "video":
            vblock = {
                "type": "video",
                "video": os.path.expanduser(str(beat["video"])),
                "start": beat["start"], "end": beat["end"],
            }
            if beat.get("tap") or _av_tap_default(beat):
                vblock["tap"] = True
            blocks.append(vblock)
            provenance.append({"start": beat["start"], "source": beat.get("provenance", {}).get("kind", "unverified-file"),
                               "detail": os.path.basename(str(beat["video"]))})
        elif beat["type"] == "browser":
            # Rebuilt pages render here, next to the other capture-engine
            # work: each page becomes a fixed 1240x640 viewport image, and
            # each click selector is measured on its own rendered page so
            # the cursor lands on the component itself.
            from .html_assets import render_browser_page
            page_imgs, clicks = [], []
            for i, page in enumerate(beat["pages"]):
                click = page.get("click") if i < len(beat["pages"]) - 1 \
                    else None
                try:
                    im, point = render_browser_page(page["html"],
                                                    click=click)
                except Exception as e:
                    raise ScriptError(
                        f"browser beat @{beat['start']}: pages[{i}] failed "
                        f"to render: {e}")
                page_imgs.append(im)
                if i < len(beat["pages"]) - 1:
                    clicks.append(point)
            blocks.append({
                "type": "browser",
                "pages_img": page_imgs,
                "clicks": clicks,
                "address": beat.get("address", ""),
                "start": beat["start"], "end": beat["end"],
                # the driven browser is THE payoff: it taps unless
                # explicitly opted out
                "tap": beat.get("tap", False),
            })
            refs = beat.get("reference") or []
            if isinstance(refs, str):
                refs = [refs]
            provenance.append({
                "start": beat["start"], "source": "synthetic-html",
                "detail": (f"rebuilt browser journey: {len(page_imgs)} "
                           "pages, reference: "
                           + ", ".join(os.path.basename(str(r))
                                       for r in refs))})
        else:  # visual — real material first, else agent-authored HTML
            if beat.get("image"):
                img = Image.open(os.path.expanduser(str(beat["image"])))
                provenance.append({"start": beat["start"], "source": beat.get("provenance", {}).get("kind", "unverified-file"),
                                   "detail": os.path.basename(str(beat["image"]))})
            else:
                from .html_assets import (is_animated_html, render_html,
                                          render_html_frames)
                # A tap hero gets a taller authoring budget: it previews
                # compact in the thread (height-fit into the slot) and
                # expands to stage size on the tap, so tall is what makes
                # the growth dramatic. Thread cards stay flat-capped.
                card_px = 1100 if beat.get("tap") else 600
                anim_frames, anim_loop = None, 0.0
                anim_once = False
                if is_animated_html(beat["html"]):
                    anim_frames, anim_loop = render_html_frames(
                        beat["html"], fps=capture_fps, max_card_px=card_px,
                        seconds=beat["end"] - beat["start"])
                    img = anim_frames[0]
                    # Capture the entire beat on one monotonic timeline.
                    # Finite actions finish once while ambient loops continue.
                    anim_once = True
                    anim_finite = False
                else:
                    img = render_html(beat["html"], max_card_px=card_px)
                provenance.append({"start": beat["start"],
                                   "source": "synthetic-html",
                                   "detail": f"{len(beat['html'])}B html"
                                   + (" (animated)" if anim_frames else "")})
            # EVERY visual stands alone by default: rounded corners + drop
            # shadow sitting straight on the video (the photo treatment).
            # An authored HTML card IS the card — wrapping it in the white
            # proof shell double-framed it. `"shell": true` (or hero, which
            # needs the shell for its gold border) opts back in.
            if beat.get("shell") or beat.get("hero"):
                block = {
                    "type": "proof", "img": img,
                    "hero": beat.get("hero", False),
                    "start": beat["start"], "end": beat["end"],
                }
                if beat.get("tap") or _av_tap_default(beat):
                    block["tap"] = True
                blocks.append(block)
            else:
                block = {
                    "type": "photo", "img": img,
                    "start": beat["start"], "end": beat["end"],
                }
                if beat.get("tap") or _av_tap_default(beat):
                    block["tap"] = True
                if beat.get("image") is None and anim_frames and anim_loop:
                    block["frames_raw"] = anim_frames
                    block["loop"] = anim_loop
                    block["cap_fps"] = capture_fps
                    block["anim_once"] = anim_once
                    block["anim_finite"] = anim_finite
                blocks.append(block)
    return blocks, provenance


__all__ = ["validate_script", "render_script", "ScriptError",
           "BUBBLE_MIN", "BUBBLE_MAX", "VISUAL_MIN", "VISUAL_MAX",
           ]
