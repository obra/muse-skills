"""HTML-on-the-fly visual synthesis — the primary asset path.

The screenplay's visual beats are authored as HTML/CSS fresh per story — the
model's native visual language. Rendering is a single PIPELINE-OWNED
headless Chromium: full browser CSS (grid, gradients, filters, variable
fonts), so Muse Moments Kit components render exactly as designed, static
or animated. A component that carries CSS `@keyframes` is captured
frame-by-frame (animations force-paused and seeked through the Web
Animations API, transparent background) and plays inside the thread; a
static one is screenshot once. The result enters the thread STANDALONE
(the photo treatment; drop shadows follow each element's own alpha).
Every component in the markup carries its own solid card surface and
sits directly on the video — never an enclosing wrapper background
behind a group of components, and never surfaceless floating content.
The white proof shell exists only when the beat opts in with
`"shell": true`.

The capture stack is entirely what the VM already ships — nothing is
installed for it. Each render batch spawns cmm/capture.mjs under the
cell's node, which drives the bundle's own Playwright (the spaces
ts-runtime ships playwright-core at /opt/hatch/skills/spaces/ts-runtime/dist/
node_modules as bundle contract) against the image-baked
/opt/meta-chromium/chrome. Dev machines override with
MM_PLAYWRIGHT_MODULES / JARVIS_CHROMIUM_BINARY.

The MODEL never launches a browser (the 2026-08-20 render-storm OOM rule
stands). This module owns the one sanctioned instance: serialized, one
capture process at a time, fixed viewport, hard-capped, gone when the
batch ends.

Authoring rules for the HTML (the magic-moment builder's seat prompt
carries the full rubric):
- self-contained: inline CSS only, no external fetches, no JS (none runs)
- body width RENDER_WIDTH px; cards land crisp after make_card's 2x downscale
- flexbox is fine; avoid CSS grid edge cases; fonts come from
  the Muse Moments Kit faces (shipped in assets/fonts
  and registered per render below — web font stacks silently fall back
  to DejaVu on the VM)
- every specific detail (codes, prices, flight numbers, times) interpolated
  from the screenplay fact sheet — validate_script lints the HTML source with
  the same rule as bubbles
"""

import json
import os
import re
import shutil
import statistics
import subprocess
import tempfile

from PIL import Image

RENDER_WIDTH = 1240   # 2x make_card's 620px inner target
MAX_HEIGHT = 2600
_PAD_BOTTOM = 20
DEVICE_SCALE = 2      # capture at 2x for crisp downscale in make_card

# Rebuilt browser pages are captured as a fixed desktop VIEWPORT, not a
# full-page card: 1240x640 is the aspect of the browser tool's own
# ~1919x992 action captures, so rebuilt pages sit in the browser card's
# viewport exactly like the real screenshots they replace. Content below
# the fold is cut, the way a real browser cuts it.
PAGE_WIDTH = 1240
PAGE_VIEWPORT_H = 640

_CAPTURE_MJS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "capture.mjs")

# Cards render in the product's own faces — Optimistic AI VF and
# Optimistic Mono, mirrored from the shipping Muse clients — shipped in
# assets/fonts/ exactly like the bubble fonts. Inter stays registered for
# older authored HTML; the kit itself names only the Optimistic faces.
# The @font-face rules are code-owned and injected per render, so authored
# HTML just says font-family:'Inter' and never carries machine paths.
# Missing font files raise instead of silently falling back — a fallback
# face reflows and un-brands every card at once (the bubble-font rule).
_FONT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "assets", "fonts")
_INTER_WEIGHTS = {
    400: "Inter-Regular.ttf",
    600: "Inter-SemiBold.ttf",
    700: "Inter-Bold.ttf",
    800: "Inter-ExtraBold.ttf",
}
# The Muse Moments Kit faces (reference/design-system/): the product's
# Optimistic AI variable font (weights 400/500/600 are the only ones the
# design language uses) and Optimistic Mono for codes/amounts/meta.
_KIT_FACES = [
    ("Optimistic AI", None, "OptimisticAIVF_A_DrkmOpszWghtItal.ttf", "100 900"),
    ("Optimistic Mono", None, "OptimisticMono_W_TextRegular.woff2", "400"),
    # The letter widget's handwriting face, mirrored from the shipping web
    # client (public/fonts/Caveat-Latin.woff2, OFL).
    ("MuseLetterCaveat", None, "Caveat-Latin.woff2", "400 700"),
]


def _font_face_rule(family, path, weight, style=None):
    rule = f"@font-face{{font-family:'{family}';font-weight:{weight};"
    if style:
        rule += f"font-style:{style};"
    return rule + f"src:url('file://{path}')}}"


def _font_face_css():
    rules = []
    for weight, name in sorted(_INTER_WEIGHTS.items()):
        path = os.path.join(_FONT_DIR, name)
        if not os.path.isfile(path):
            raise HtmlRenderError(
                f"bundled card font missing: {path} — the skill ships Inter "
                "in assets/fonts/; a partial checkout or sync dropped it"
            )
        rules.append(_font_face_rule("Inter", path, weight))
    for family, style, name, weight in _KIT_FACES:
        path = os.path.join(_FONT_DIR, name)
        if not os.path.isfile(path):
            raise HtmlRenderError(
                f"bundled card font missing: {path} — the skill ships the "
                "Muse Moments Kit faces in assets/fonts/; a partial "
                "checkout or sync dropped it"
            )
        rules.append(_font_face_rule(family, path, weight, style))
    return "".join(rules)


class HtmlRenderError(RuntimeError):
    """Renderer unavailable or the render produced nothing usable."""


def _node_binary():
    """The cell's node — capture.mjs runs on it. MM_NODE overrides for
    dev machines with node somewhere unusual."""
    for candidate in (os.environ.get("MM_NODE"), shutil.which("node"),
                      "/usr/bin/node"):
        if candidate and os.path.isfile(candidate):
            return candidate
    raise HtmlRenderError(
        "node not found — the runtime cell ships /usr/bin/node; on a dev "
        "machine set MM_NODE to a node binary"
    )


def _capture_process(command, input, stdout, stderr, timeout):
    """Own the worker and its browser process group through cancellation."""
    import signal
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout,
                            stderr=stderr, start_new_session=True)
    try:
        out, err = proc.communicate(input, timeout=timeout)
        return subprocess.CompletedProcess(command, proc.returncode, out, err)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()


class _Capture:
    """One serialized capture process per render call.

    The model never launches a browser; this class owns the single
    sanctioned path: cmm/capture.mjs on the cell's node, driving the
    bundle's playwright-core against the image-baked Chromium. One
    process, one page, gone when the call returns.
    """

    @staticmethod
    def _chromium_binary():
        """The capture browser: the image-baked Chromium the VM already
        ships (JARVIS_CHROMIUM_BINARY override, or its stable /opt path).
        None means capture.mjs lets playwright resolve its own browser
        store (dev machines)."""
        for candidate in (os.environ.get("JARVIS_CHROMIUM_BINARY"),
                          "/opt/meta-chromium/chrome"):
            if candidate and os.path.isfile(candidate):
                return candidate
        return None

    def __init__(self):
        self._node = _node_binary()
        if not os.path.isfile(_CAPTURE_MJS):
            raise HtmlRenderError(f"capture worker missing: {_CAPTURE_MJS}")

    def close(self):
        pass  # nothing persistent: each call owns its process

    def _run(self, html, width, fps, max_height, viewport_h=None,
             measure=None, seconds=None):
        """One capture.mjs run: returns (posted PIL frames, loop_seconds,
        rects). `viewport_h` switches to a fixed-viewport capture (rebuilt
        browser pages); `measure` is a list of CSS selectors whose boxes
        come back in CSS px."""
        work = tempfile.mkdtemp(prefix="mm-cap-")
        try:
            # The doc loads via file:// so the @font-face file:// sources
            # are same-origin and always load.
            bg = "transparent" if viewport_h is None else "#fff"
            doc = ("<!doctype html><html><head><meta charset='utf-8'>"
                   f"<style>{_font_face_css()}"
                   f"html,body{{margin:0;background:{bg};font-family: 'Optimistic AI',sans-serif}}</style></head>"
                   f"<body style='width:{width}px'>{html}</body></html>")
            html_file = os.path.join(work, "card.html")
            with open(html_file, "w", encoding="utf-8") as f:
                f.write(doc)
            job = {"htmlFile": html_file, "width": width,
                   "deviceScale": DEVICE_SCALE, "outDir": work, "fps": fps,
                   "mode": "authored", "seconds": seconds, "maxHeight": max_height}
            if viewport_h is not None:
                job["viewportHeight"] = viewport_h
            if measure:
                job["measure"] = list(measure)
            try:
                proc = _capture_process(
                    [self._node, _CAPTURE_MJS],
                    input=json.dumps(job).encode(),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    timeout=180,
                )
            except subprocess.TimeoutExpired:
                raise HtmlRenderError("capture timed out after 180s")
            if proc.returncode != 0:
                tail = proc.stderr.decode("utf-8", "replace")[-800:]
                raise HtmlRenderError(
                    f"capture failed (exit {proc.returncode}): {tail}"
                )
            result = json.loads(proc.stdout.decode("utf-8"))
            # Downscale each frame AS its PNG is opened: a 6s loop at
            # 24fps is 144 frames of ~18MB full-resolution RGBA, and
            # holding the full set (let alone two sets) alongside the
            # browser flirts with the cell's memory cap. Peak here is
            # one full-resolution frame plus the small downscaled list.
            frames = []
            for name in result["frames"]:
                with Image.open(os.path.join(work, name)) as im:
                    frames.append(self._post(im.convert("RGBA"),
                                             width, max_height))
            return (frames, float(result.get("loopSeconds") or 0.0),
                    result.get("rects") or {})
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _post(im, width, max_height):
        if im.width != width * DEVICE_SCALE or im.height > max_height * DEVICE_SCALE:
            raise HtmlRenderError(f"capture is {im.width}x{im.height}; refusing silent crop to {width * DEVICE_SCALE}x{max_height * DEVICE_SCALE}")
        im = im.resize((width, im.height // DEVICE_SCALE), Image.LANCZOS)
        return im

    def render(self, html, width, max_height):
        frames, _, _ = self._run(html, width, fps=None,
                                 max_height=max_height)
        return frames[0]

    def render_frames(self, html, width, max_height, fps, seconds=None):
        """Capture an animated component: (frames, loop_seconds)."""
        frames, loop, _ = self._run(html, width, fps=fps,
                                    max_height=max_height, seconds=seconds)
        return frames, loop


def strip_tags(html):
    """Visible text of an HTML string, for linting against the fact sheet."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html,
                  flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _trim_bottom(im, tol=6):
    """Cut trailing rows that match the page background.

    The page is intentionally tall and the card owns it: a body background
    propagates to the whole canvas (CSS), so the background is SAMPLED from
    the bottom row — pure canvas on any card shorter than the page — never
    assumed white. Trimming against hardcoded white made every tinted card
    measure as the full 2600px page. The kept pad rows below the content
    are canvas-colored, so a tinted card gets a matching bottom margin.
    """
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    xs = range(0, w, 8)
    bg = tuple(
        int(statistics.median(px[x, h - 1][i] for x in xs)) for i in range(3)
    )
    last = 0
    for y in range(h - 1, -1, -1):
        if any(
            abs(px[x, y][0] - bg[0]) > tol or abs(px[x, y][1] - bg[1]) > tol
            or abs(px[x, y][2] - bg[2]) > tol
            for x in xs
        ):
            last = y
            break
    return im.crop((0, 0, w, min(h, last + 1 + _PAD_BOTTOM)))


def _finish(im, width, max_card_px=600):
    trimmed = _trim_bottom(im)
    if trimmed.height < 60:
        raise HtmlRenderError("rendered HTML is effectively blank")
    if trimmed.height > max_card_px:
        raise HtmlRenderError(
            f"rendered HTML is {trimmed.height}px tall at 1240 wide — over "
            f"this card's {max_card_px}px budget (600 for a thread card, "
            "which shows at 310 thread-scale under the face-safe band; "
            "1100 for a tap hero, which previews compact and expands on "
            "the tap). Shorten the layout — and if your CSS sets height/"
            "min-height:100% or paints a full-page gradient, remove it: "
            "the card's height must come from its content."
        )
    return trimmed


def is_animated_html(html):
    """A component that ships CSS keyframes owns its own motion."""
    return "@keyframes" in html


def render_file_screenshot(path, width=760, max_height=2400, viewport_height=None):
    """Screenshot a REAL document (an artifact's own entry HTML) as-is.

    Unlike render_html, nothing is injected or wrapped: the browser loads
    the file directly, so the artifact's own relative CSS/JS/assets
    resolve and the capture shows the app exactly as it renders. Returns
    a PIL image at `width` authoring px (full page height, capped).
    """
    import shutil as _sh
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise HtmlRenderError(f"artifact document not found: {path}")
    cap = _Capture()
    work = tempfile.mkdtemp(prefix="mm-snap-")
    try:
        job = {"htmlFile": path, "width": width,
               "deviceScale": DEVICE_SCALE, "outDir": work, "fps": 0,
               "mode": "snapshot", "maxHeight": max_height,
               "viewportHeight": viewport_height}
        proc = _capture_process(
            [cap._node, _CAPTURE_MJS], input=json.dumps(job).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        if proc.returncode != 0:
            raise HtmlRenderError(
                "artifact capture failed: "
                + proc.stderr.decode("utf-8", "replace")[-500:])
        result = json.loads(proc.stdout.decode("utf-8"))
        with Image.open(os.path.join(work, result["frames"][0])) as im:
            return _Capture._post(im.convert("RGBA"), width, max_height)
    finally:
        _sh.rmtree(work, ignore_errors=True)


def render_url_screenshot(url, width=1240, max_height=2400, viewport_height=None):
    """Screenshot a LIVE web page — the real site the runtime worked on.

    The capture browser dials through the cell's egress proxy (so
    Sentinel stays in the loop for the target domain) and screenshots
    the page as loaded, full page capped at `max_height`. Use this to
    put the LITERAL page the browser drove into a card: the checkout it
    filled, the listing it found, the confirmation it reached.
    """
    if not url.startswith(("http://", "https://")):
        raise HtmlRenderError(f"not a web URL: {url}")
    import shutil as _sh
    cap = _Capture()
    work = tempfile.mkdtemp(prefix="mm-webshot-")
    try:
        job = {"url": url, "width": width,
               "deviceScale": DEVICE_SCALE, "outDir": work, "fps": 0,
               "mode": "snapshot", "maxHeight": max_height,
               "viewportHeight": viewport_height}
        proc = _capture_process(
            [cap._node, _CAPTURE_MJS], input=json.dumps(job).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        if proc.returncode != 0:
            raise HtmlRenderError(
                "live page capture failed: "
                + proc.stderr.decode("utf-8", "replace")[-500:])
        result = json.loads(proc.stdout.decode("utf-8"))
        with Image.open(os.path.join(work, result["frames"][0])) as im:
            return _Capture._post(im.convert("RGBA"), width, max_height)
    finally:
        _sh.rmtree(work, ignore_errors=True)


def render_browser_page(html, click=None, capture=None):
    """Render one REBUILT browser page as a fixed desktop viewport.

    Returns (PIL image at PAGE_WIDTH x PAGE_VIEWPORT_H, click_point).
    `click` is a CSS selector naming the element the cursor presses on
    this page (or None for the journey's last page); click_point comes
    back as (x_frac, y_frac) of the viewport, measured from the
    element's real rendered box, so the cursor lands on the component
    itself. A selector that matches nothing, or an element whose center
    sits below the 640px fold, raises with the selector named.
    """
    own = capture is None
    cap = capture or _Capture()
    try:
        frames, _, rects = cap._run(
            html, PAGE_WIDTH, fps=None, max_height=PAGE_VIEWPORT_H,
            viewport_h=PAGE_VIEWPORT_H,
            measure=[click] if isinstance(click, str) else None)
    finally:
        if own:
            cap.close()
    im = frames[0].convert("RGB")
    if im.size != (PAGE_WIDTH, PAGE_VIEWPORT_H):
        canvas = Image.new("RGB", (PAGE_WIDTH, PAGE_VIEWPORT_H),
                           (255, 255, 255))
        canvas.paste(im, (0, 0))
        im = canvas
    point = None
    if isinstance(click, str):
        rect = rects.get(click)
        if not rect or rect[2] <= 0 or rect[3] <= 0:
            raise HtmlRenderError(
                f"browser page click selector matched nothing: {click!r} — "
                "name an element that exists in this page's markup"
            )
        cx = rect[0] + rect[2] / 2
        cy = rect[1] + rect[3] / 2
        if cy > PAGE_VIEWPORT_H:
            raise HtmlRenderError(
                f"browser page click target {click!r} sits below the "
                f"{PAGE_VIEWPORT_H}px fold (center at {cy:.0f}px) — move "
                "the element above the fold; the viewport cuts like a "
                "real browser"
            )
        point = (cx / PAGE_WIDTH, cy / PAGE_VIEWPORT_H)
    elif isinstance(click, (list, tuple)) and len(click) == 2:
        point = (float(click[0]), float(click[1]))
    return im, point


def render_html(html, width=RENDER_WIDTH, max_height=MAX_HEIGHT,
                capture=None, max_card_px=600):
    """Render an HTML string to a trimmed PIL image via the capture shell."""
    own = capture is None
    cap = capture or _Capture()
    try:
        return _finish(cap.render(html, width, max_height), width,
                       max_card_px)
    finally:
        if own:
            cap.close()


def render_html_frames(html, fps, width=RENDER_WIDTH,
                       max_height=MAX_HEIGHT, capture=None,
                       max_card_px=600, seconds=None):
    """Capture an animated component as (frames, loop_seconds).

    Frames are trimmed to a COMMON height (the tallest trimmed frame) so
    the card does not jitter as the animation runs.
    """
    own = capture is None
    cap = capture or _Capture()
    try:
        frames, loop = cap.render_frames(html, width, max_height, fps, seconds=seconds)
    finally:
        if own:
            cap.close()
    trimmed = [_finish(f, width, max_card_px) for f in frames]
    h = max(t.height for t in trimmed)
    out = []
    for t in trimmed:
        if t.height == h:
            out.append(t)
        else:
            padded = Image.new("RGBA", (width, h), (0, 0, 0, 0))
            padded.paste(t, (0, 0))
            out.append(padded)
    return out, loop
