"""Deterministic message-thread renderer: bubbles, typing,
reactions, photo/video messages, receipt cards — all as blocks in ONE
bottom-pinned DEPTH STAGE with slide-up physics and z-decay.

The stage (v22, the rail): the newest message is crisp at the bottom;
every older message recedes INTO the scene along one 3D rail that bows
up-and-to-the-right toward a vanishing point below the header — and its
scale/alpha are continuous functions of its own position on that rail,
so each block shrinks exactly as it travels. The
agent's identity is a pinned header at the top of the frame: a large
circular avatar (animated from the product's own avatar status loops
when they exist) with a frosted name pill kissing under it. Content
respects Reels/TikTok safe zones so platform chrome never covers it.

Locked craft (each line guards a bug that actually shipped):
- 36px type, getbbox wrapping (never len*0.6 estimates)
- real agent name from ~/IDENTITY.md in the pinned header pill
- recede is POSITION-driven and ANIMATED: a newcomer appears in 0.3s
  but pushes the thread up the rail over 0.85s, so the crawl glides
- pop 0.88->1.04->1 easeOutBack over 0.33s; stack slides up 0.30s

Zero deps beyond Pillow.
"""
import os, math
from typing import List, Dict, Any, Tuple
from PIL import Image, ImageDraw, ImageChops

FPS = 30
SLIDE_SECS = 0.30  # stack push-up animation length
DEPTH_SECS = 0.85  # z-decay depth-shift animation length
AVATAR_CROSSFADE_SECS = 0.3  # pinned-avatar state-switch blend
# Muse finisher (full-screen variant): over the video's final seconds the
# frame fades to white, the lockup animation plays centered on the white,
# and the pinned avatar header stays on top playing its celebration loop.
FINISHER_FADE_SECS = 0.5
FINISHER_LOCKUP_CY = 0.50   # lockup band center: dead center of the frame
# the avatar's celebration starts a beat AFTER the white transition
# finishes, so the switch reads as a reaction to the close, not part of
# the wipe
FINISHER_CELEBRATE_DELAY = 0.1

# ---- the rail (Lucas-tuned in the depth-rail-options artifact, 2026-09-01) --
# One 3D rail from the stack's bottom anchor to a vanishing point
# up-and-right; NO plateau. The x-path converges with an eased curve so the
# trajectory bows RIGHT before it climbs, and alpha reaches zero exactly at
# the horizon (before the rail can reach the avatar).
# The left/right identity lives in the RAIL, not the resting pose: user
# messages vanish into a lane slightly right of the assistant lane.
RAIL_VANISH_X = 0.64   # vanish-point x as a fraction of W (cards' lane)
RAIL_LANE_SEP = 0.07   # user lane = +sep, assistant/typing lane = -sep
RAIL_HORIZON_Y = 0.33  # vanish-point y as a fraction of H (below the pill)
TAP_RAIL_SHOVE = 260   # extra rail distance (720-base px) during a tap

# Tap effect timing (seconds): the card lands normally, presses in like a
# touch, springs up to fill the thread stage, holds, and settles back into
# its slot before the beat ends. iOS photo-modal cadence.
TAP_PRESS_AT = 0.9
TAP_PRESS = 0.12
TAP_GROW = 0.38
TAP_SHRINK = 0.38


def _tap_phase(b, t):
    """(mode, progress) for a tap block at time t, or (None, 0).

    press -> grow -> hold -> shrink; the window needs enough beat time
    to complete, otherwise the tap is skipped and the card stays a
    normal thread card (never a half-finished morph).
    """
    t0 = b["start"] + b.get("tap_press_at", TAP_PRESS_AT)
    t1 = t0 + TAP_PRESS
    t2 = t1 + TAP_GROW
    # A tap_hold block (the Muse finisher) never settles back: it grows
    # and holds the stage to the video's last frame.
    t3 = b["end"] if b.get("tap_hold") else b["end"] - TAP_SHRINK
    if t3 <= t2 or t < t0 or t >= b["end"]:
        return None, 0.0
    if t < t1:
        return "press", (t - t0) / TAP_PRESS
    if t < t2:
        return "grow", (t - t1) / TAP_GROW
    if t < t3:
        return "hold", 1.0
    return "shrink", (t - t3) / TAP_SHRINK

# ---- chrome scale ----------------------------------------------------------
# Every pixel constant in this renderer (and in templates.py / card.py) was
# measured and locked at 720x1280. The render canvas is no longer fixed there:
# `./mm render` encodes at delivery resolution (1080x1920 by default), because
# rendering 720p and upscaling threw away two thirds of the source pixels and
# added a lossy generation. px() maps a 720-calibrated value onto the active
# canvas so the chrome stays proportionally identical at any size — and is
# bit-identical at 720, where px() is the identity.
#
# The canvas is always 9:16 (the CLI enforces it), so W/720 == H/1280 and one
# factor is enough. It is process-global on purpose: the constants are
# consumed across three modules, and a render is single-flight (compose holds
# an exclusive flock), so threading a scale through every make_* call buys
# nothing. MessageOverlayRenderer.__init__ — always the first chrome
# constructed for a render — pins it from its canvas width.
BASE_W, BASE_H = 720, 1280

_ui_scale = 1.0


def set_ui_scale(width):
    """Pin the chrome scale from the canvas width (720 -> 1.0)."""
    global _ui_scale
    _ui_scale = width / BASE_W


def px(v):
    """A 720x1280-calibrated pixel value, scaled to the active canvas."""
    return int(round(v * _ui_scale))


def ease_out_cubic_f(x):
    return 1 - pow(1 - x, 3)

# Fonts ship WITH the skill and the BUNDLED COPY IS THE ONLY ONE. Every
# geometry number in this renderer — bubble widths, wrap points, the 620px
# inner card width — was measured against these exact files, so resolving the
# face from anywhere else makes an identical screenplay render differently on
# different machines, which is the one property "locked visuals" means.
#
# The face is Optimistic AI (the product's own variable font,
# set_variation_by_axes for the 400/500/600 weights); the locked geometry
# numbers were re-measured against it when the Muse-native redesign
# swapped it in. A system font is deliberately NOT a fallback: builds
# differ in metrics, and a stripped assets/ should fail loudly
# (FontUnavailableError) rather than quietly re-flow every bubble.
_SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLED_FONT_DIR = os.path.join(_SKILL_ROOT, "assets", "fonts")

# Thread chrome renders in the product's own face — Optimistic AI VF,
# mirrored from the shipping Muse clients — so bubbles and the
# sender pill read as the same product as the cards and the app itself.
# The VF carries Dark Mode / Optical Size / Weight / Italic axes; weight
# comes from the wght axis (500 body: 400 reads thin at bubble size over
# video; 700 bold).
_FONT_FILES = {
    "regular": ("OptimisticAIVF_A_DrkmOpszWghtItal.ttf", 500),
    "bold": ("OptimisticAIVF_A_DrkmOpszWghtItal.ttf", 700),
}


class FontUnavailableError(RuntimeError):
    """No usable font file was found. Never silently fall back."""


def font_search_paths(weight="regular"):
    name, _ = _FONT_FILES["bold" if weight == "bold" else "regular"]
    return [os.path.join(BUNDLED_FONT_DIR, name)]


def load_font(sz: int, bold: bool=False, weight: str="regular"):
    """Load a font at exactly `sz`. Raises rather than degrading.

    The historical bug: PIL fell through to `load_default()`, a ~10px bitmap
    face, and the render silently continued — a 589px bubble came out 192px
    wide. A hard failure is strictly better than shipping that, so there is no
    silent fallback here.
    """
    from PIL import ImageFont
    # `bold` used to be accepted and ignored, so the pill's "Muse" label asked
    # for Bold and rendered regular. Honor it by promoting the weight.
    if bold and weight not in ("bold", "semibold"):
        weight = "bold"
    resolved = "bold" if weight in ("bold", "semibold") else "regular"

    _, wght = _FONT_FILES[resolved]
    for path in font_search_paths(resolved):
        if not os.path.exists(path):
            continue
        try:
            f = ImageFont.truetype(path, sz)
            axes = f.get_variation_axes()
            vals = []
            for ax in axes:
                nm = ax.get("name", b"")
                nm = nm.decode() if isinstance(nm, bytes) else str(nm)
                if "Weight" in nm:
                    vals.append(min(max(wght, ax["minimum"]), ax["maximum"]))
                elif "Optical" in nm:
                    vals.append(min(max(sz, ax["minimum"]), ax["maximum"]))
                else:
                    vals.append(ax["default"])
            f.set_variation_by_axes(vals)
        except Exception:
            continue
        if getattr(f, "size", sz) >= sz * 0.9:
            return f

    raise FontUnavailableError(
        f"no usable {resolved} font at size {sz}. Looked in "
        f"{font_search_paths(resolved)}. The skill ships its own fonts under "
        f"assets/fonts/ — if that directory is missing, the skill was not "
        f"copied whole."
    )

# Global fonts initialized lazily in renderer
def wrap_text(text: str, font, max_w: int, draw: ImageDraw.ImageDraw) -> List[str]:
    words = text.split()
    lines=[]; cur=""
    for w in words:
        test = (cur+" "+w) if cur else w
        bb = draw.textbbox((0,0), test, font=font)
        ww = bb[2]-bb[0]
        if ww <= max_w:
            cur=test
        else:
            if cur: lines.append(cur)
            # handle long word breaking
            if draw.textbbox((0,0), w, font=font)[2] <= max_w:
                cur=w
            else:
                # char-level break
                ch_line=""
                for ch in w:
                    tb = draw.textbbox((0,0), ch_line+ch, font=font)
                    if tb[2]-tb[0] <= max_w: ch_line+=ch
                    else:
                        if ch_line: lines.append(ch_line)
                        ch_line=ch
                cur=ch_line
    if cur: lines.append(cur)
    return lines

def measure_bubble(text: str, font, max_w=None) -> Tuple[List[str], int, int, int]:
    # Default text width fits the safe-zone stage: SAFE_LEFT..SAFE_RIGHT is
    # 72% of the canvas (518 at 720) and the bubble carries 28px padding a
    # side, so text wraps at 460 and the bubble caps at the stage width.
    if max_w is None:
        max_w = px(460)
    tmp = Image.new("RGBA",(10,10),(0,0,0,0)); d=ImageDraw.Draw(tmp)
    lines = wrap_text(text, font, max_w, d)
    # line-height 1.32× font.size (fall back 47 for 36px, canvas-scaled)
    try: lh = int(font.size*1.32)
    except: lh = px(47)
    max_line_w=0
    for l in lines:
        bb=d.textbbox((0,0), l, font=font)
        max_line_w=max(max_line_w, bb[2]-bb[0])
    bw = min(max_line_w+px(56), max_w+px(56))  # inner 28*2
    bh = len(lines)*lh + px(48)                # inner 24*2
    return lines, lh, bw, bh

def draw_bubble_base(w:int, h:int, is_muse:bool) -> Image.Image:
    # Muse product bubbles, canonical default chat theme (Figma "Muse
    # Canonical – Mobile"): user = #CBE5FF with ink text, agent = white
    # with ink text. Flat fills only — no outline. Radius is the product's
    # 22 (product-scale ~px(40) here), capped at half-height so short
    # bubbles go capsule exactly like the clients. The faint offset
    # underlay is footage-legibility, not elevation.
    fill = "#FFFFFF" if is_muse else "#CBE5FF"
    img = Image.new("RGBA",(w+px(4), h+px(3)),(0,0,0,0)); d=ImageDraw.Draw(img)
    r = min(px(40), (h - px(3)) // 2)
    d.rounded_rectangle([px(2),px(4),w+px(2),h], radius=r, fill=(0,0,0,30))
    d.rounded_rectangle([0,0,w,h-px(3)], radius=r, fill=fill)
    return img

def reaction_anim(p):
    """iOS-ish tapback spring: overshoot then settle. p in [0,1] over 0.45s."""
    if p <= 0:
        return 0.0, 0.0
    if p >= 1:
        return 1.0, 1.0
    alpha = min(1.0, p * 4)
    if p < 0.55:
        scale = 1.25 * ease_out_cubic_f(p / 0.55)
    else:
        scale = 1.25 - 0.25 * ((p - 0.55) / 0.45)
    return scale, alpha


_EMOJI_RE = None


def _emoji_re():
    global _EMOJI_RE
    if _EMOJI_RE is None:
        import re
        # minimal union \u2014 no overlapping ranges: U+1F000-1FAFF covers the
        # supplemental emoji planes, U+2600-27BF covers misc symbols +
        # dingbats (incl. hearts/checks/sparkles), U+2190-21FF arrows,
        # U+2B50 the lone star
        _EMOJI_RE = re.compile(
            "([\U0001F000-\U0001FAFF\u2190-\u21FF\u2600-\u27BF\u2b50]"
            "[\uFE0F\U0001F3FB-\U0001F3FF]?)")
    return _EMOJI_RE


_NOTDEF_MASKS = {}


def _draws_glyph(font, ch):
    """True when `font` has a real glyph for `ch` rather than the .notdef
    tofu box. FreeType substitutes .notdef silently, and every unmapped
    codepoint yields the identical bitmap, so one sample taken from a
    permanently-unassigned codepoint (U+FFFF is a noncharacter) identifies
    it."""
    key = (getattr(font, "path", None), getattr(font, "size", None))
    notdef = _NOTDEF_MASKS.get(key)
    if notdef is None:
        notdef = bytes(font.getmask("￿", mode="L"))
        _NOTDEF_MASKS[key] = notdef
    return bytes(font.getmask(ch, mode="L")) != notdef


def _paste_emoji(img, x, y, part, size):
    """Paste `part` from the bundled color-emoji font, returning the x
    advance — or None when that font has no glyph for it."""
    from .templates import _emoji_font
    e = Image.new("RGBA", (140, 140), (0, 0, 0, 0))
    ImageDraw.Draw(e).text((8, 8), part, font=_emoji_font(),
                           embedded_color=True)
    bbox = e.getbbox()
    if not bbox:
        return None
    g = size + 2
    e = e.crop(bbox).resize((g, g), Image.LANCZOS)
    img.paste(e, (int(x), int(y + (size - g) // 2 + 2)), e)
    return g + 3


def draw_rich_text(img, xy, text, font, fill):
    """Draw a line mixing Optimistic AI text with inline COLOR emoji.

    The text face has no emoji glyphs — a bubble saying "Pixel 🐶" rendered a tofu
    box. Emoji segments are rasterized from the bundled Noto Color Emoji
    (fixed 109px bitmap strikes) and pasted inline at text size.
    """
    d = ImageDraw.Draw(img)
    x, y = xy
    parts = _emoji_re().split(text)
    size = getattr(font, "size", 36)
    for part in parts:
        if not part:
            continue
        if _emoji_re().fullmatch(part):
            adv = _paste_emoji(img, x, y, part, size)
            if adv is not None:
                x += adv
                continue
            # _EMOJI_RE matches whole Unicode blocks and those blocks are
            # mixed: "→" (U+2192) and "✓" (U+2713) sit beside real emoji but
            # are ordinary text characters the emoji font has no glyph for
            # and the text face draws correctly. Ask the font rather than assuming a
            # broken install — "SFO → JFK" used to abort the whole render.
            # Drop any presentation selector on the way, since the text face would
            # draw U+FE0F as a tofu box of its own.
            if _draws_glyph(font, part[0]):
                part = part[0]
            else:
                # Neither font can draw it. Still no try/except and still no
                # fall-through: this block exists BECAUSE the text face renders a
                # missing glyph as tofu, so drawing it anyway ships the exact
                # defect the function prevents — silently, in a finished video
                # nobody re-checks.
                raise FontUnavailableError(
                    f"neither bundled font can draw {part!r}: the emoji font "
                    "rendered it empty and the text face has no glyph for it. Check "
                    "assets/fonts/ is intact, or remove the character — "
                    "drawing it would ship a tofu box"
                )
        d.text((x, y), part, font=font, fill=fill)
        x += d.textbbox((0, 0), part, font=font)[2]


def ease_out_back(t, c1=1.70158):
    c3=c1+1; return 1 + c3*pow(t-1,3) + c1*pow(t-1,2)

def _anim_index(b, t, n_frames):
    """Captured-animation frame index for time t.

    - one-shot card (anim_once): play once, hold the final frame.
    - mixed card (anim_finite): replay complete cycles, but never start
      a cycle that cannot finish inside the beat — the tail holds the
      last full cycle's final frame, so a finished narrative (a cursor
      that clicked and faded) stays finished through the beat's tail,
      the tap shrink, and the ride up the thread.
    - pure loop: wrap forever.
    """
    import math as _m
    dt = t - b["start"]
    loop = b["loop"]
    fps = b.get("cap_fps", 24)
    if not b.get("anim_once"):
        if b.get("anim_finite"):
            fit = max(1, _m.floor(
                (b["end"] - b["start"]) / loop + 1e-6))
            dt = min(dt, fit * loop - 1.0 / fps)
        dt %= loop
    return min(int(dt * fps), n_frames - 1)


def pop_scale(frame_offset):
    if frame_offset<0 or frame_offset>=10: return 1.0
    t=frame_offset/10.0
    if t<0.65:
        return 0.88 + 0.16*ease_out_back(t/0.65)
    else:
        return 1.04 + (1.0-1.04)*((t-0.65)/0.35)


def rail_warp(u, rail):
    """Map cumulative RAW content length `u` (unscaled px of blocks + gaps
    below a point) to rail position tt.

    This is the closed-form integral of the scale curve: spacing at tt is
    proportional to s(tt), so d(tt)/du = s0*e^(-K*tt)/rail, giving
    tt = ln(1 + K*s0*u/rail)/K. Marching through this warp preserves the
    perspective compression EXACTLY while staying monotonic in u — the
    previous model accumulated live SCALED heights, so an older block's
    shrinking contribution could transiently outweigh a newcomer's easing
    push and the thread slid backwards for a few frames (the
    "rubber-band" Lucas saw). Raw content length only ever grows.
    """
    return math.log1p(1.6 * 0.92 * u / rail) / 1.6


def rail_decay(tt):
    """(scale, alpha) as a CONTINUOUS function of rail position tt in [0,1+].

    Scale and fade track the block's own progress along the trajectory —
    never a discrete depth index — so each message shrinks exactly as it
    travels (Lucas: "scaling as it progresses across the trajectory", not
    everything rescaling in lockstep when a new message lands). 0.92 at
    the anchor (the face is the star), ~0.70 one typical step up, an
    exponential glide to ~0.19 at the horizon with a 0.10 floor; alpha
    runs to literal zero AT the horizon, so the z-fade alone retires a
    message and the rail can never touch the avatar.
    """
    s = max(0.10, 0.92 * math.exp(-1.6 * tt))
    # Alpha holds NEAR-OPAQUE through the first half of the rail and only
    # then rolls off to zero at the horizon (the earlier (1-tt)^1.35 read
    # as ghosts one step back — Lucas 2026-09-01: too transparent).
    a = max(0.0, 1.0 - min(tt, 1.0) ** 1.6) ** 1.1
    return s, a


class MessageOverlayRenderer:
    """
    Deterministic renderer for bubble + proof blocks over vertical video.
    W,H configure canvas (720x1280 default story). BOTTOM_Y = H-80.
    """
    def __init__(self, W=720, H=1280, avatar_path=None):
        # pin the chrome scale FIRST: every px() below — and in templates.py
        # and card.py, which render later in the same pass — derives from it
        set_ui_scale(W)
        self.W, self.H = W, H

        # ── Reels/TikTok safe zones ────────────────────────────────────
        # Platform chrome eats the frame edges: username/caption/sound pill
        # across the bottom ~18%, the UFI icon stack down the right edge,
        # status bar + search at the top. Bubbles keep a 14% inset per side
        # (text is what must never sit under the UFI); the stack's bottom
        # anchor rides ~16% up from the bottom edge. Cards are wider than
        # the text-safe lane by design — they center in the frame and sit
        # HIGHER than the old H-80 anchor, so they clear the caption band
        # the old geometry sank into.
        self.SAFE_LEFT = int(W * 0.14)
        self.SAFE_RIGHT = W - int(W * 0.14)
        self.BOTTOM_Y = H - (int(H * 0.22) - px(80))

        # ── Pinned identity header + fade line ─────────────────────────
        # The agent lives at the TOP of the frame: a large circular avatar
        # (center at 24% height — breathing room above for the intro
        # spring's overshoot) with a frosted name pill kissing under it.
        # The fade band sits just below the pill: messages recede in z as
        # they age (depth_decay) and finally dissolve through this band —
        # the band protects the header, not the face; the face stays
        # legible because decayed messages are small and transparent.
        self._avatar_center_y = int(H * 0.24)
        self._avatar_size = px(80)
        _pill_probe_h = px(44)
        _av_pill_bottom = (self._avatar_center_y + self._avatar_size // 2
                           + _pill_probe_h)
        # No linear clip band: the rail's alpha tail reaches zero, so the
        # crawl alone retires messages. The HORIZON is the rail's endpoint
        # — kept below the pinned header so the trajectory can never touch
        # the avatar even at full overshoot.
        self.HORIZON_Y = max(_av_pill_bottom + px(10), int(H * RAIL_HORIZON_Y))
        self.GAP = px(18)
        self.avatar_path = avatar_path
        # 36px (at 720) is the locked readable-in-feed size: not tiny 32, not
        # shouting 46
        self.font_bubble = load_font(px(36))   # You — big enough for Stories
        self.font_muse = load_font(px(36))    # Muse — same size, tinted bubble
        # Authorship inside the thread is carried by bubble color alone,
        # exactly like the apps; the pinned header is the ONE piece of
        # avatar chrome (the product's own identity lockup). Avatar media
        # still appears as CONTENT when the moment is about the avatar.
        self._build_pinned_header()
        # temp draw for measuring
        self._tmp_draw = ImageDraw.Draw(Image.new("RGBA",(10,10),(0,0,0,0)))

    def _build_pinned_header(self):
        """Static avatar circle, frosted name pill, and the animated avatar
        status loops (product-generated per-user videos, falling back to the
        image-shipped default character's set, falling back to the static
        circle)."""
        from .avatar import resolve_avatar, agent_name, find_status_video
        AV = self._avatar_size
        av_img, _ = resolve_avatar(AV, explicit_path=self.avatar_path)
        # 4x-supersampled circle mask for clean anti-aliased edges
        _ss = 4
        m_big = Image.new("L", (AV * _ss, AV * _ss), 0)
        ImageDraw.Draw(m_big).ellipse([0, 0, AV * _ss - 1, AV * _ss - 1],
                                      fill=255)
        self._avatar_mask = m_big.resize((AV, AV), Image.LANCZOS)
        self._pinned_avatar = Image.new("RGBA", (AV, AV), (0, 0, 0, 0))
        self._pinned_avatar.paste(av_img, (0, 0), self._avatar_mask)

        # Frosted name pill under the avatar — real agent name, never a
        # hardcoded label. Two skins, same geometry: the dark frosted pill
        # reads over arbitrary footage; the light one takes over with the
        # finisher's white close, where the dark pill sat like a weight.
        label = agent_name().strip() or "Muse"
        pf = load_font(px(24), bold=True)
        tb = ImageDraw.Draw(Image.new("RGBA", (8, 8))).textbbox(
            (0, 0), label, font=pf)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        pw, ph = tw + px(40), th + px(24) + px(8)

        def _pill(fill, text_fill):
            im = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            d.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=ph // 2,
                                fill=fill)
            d.text(((pw - tw) // 2 - tb[0], (ph - th) // 2 - tb[1]), label,
                   font=pf, fill=text_fill)
            return im

        self._name_pill = _pill((40, 40, 40, 180), (255, 255, 255, 255))
        # light skin for the white close: the bubble is the product's
        # chip-on-white wash (a whisper off the lockup white, cool like
        # the wordmark), and the name is the Muse wordmark ink exactly,
        # so the name and the wordmark share one color on the close
        self._name_pill_light = _pill((237, 239, 240, 255), (26, 41, 49, 255))

        # Animated avatar: decode each status loop the host actually has.
        # States mirror the product's status-video set; the beat-driven
        # switcher (_avatar_state_for) maps thread activity onto them.
        # ONE CHARACTER ONLY: a user's generated set often covers only some
        # states, and find_status_video falls back per-state to the
        # image-shipped default character — mixing them made the header
        # open as the default Muse character and then crossfade into the
        # user's own avatar (shipped, and read as a glitch). If ANY
        # per-user loop exists, reference loops are dropped entirely;
        # states the user's set lacks fall back to the user's idle loop
        # (or the static avatar) inside _avatar_frame.
        found = {}
        for state in ("idle", "connecting", "working", "making_something",
                      "milestone_level_up", "laughing"):
            path, origin = find_status_video(state)
            if path:
                found[state] = (path, origin)
        if any(origin == "user" for _, origin in found.values()):
            found = {s: v for s, v in found.items() if v[1] == "user"}
        self._avatar_states = {}
        for state, (path, _origin) in found.items():
            try:
                self._avatar_states[state] = self._decode_avatar_loop(path, AV)
            except Exception:
                continue  # a corrupt loop must never kill a render
        self._cur_state = "idle"
        self._prev_state = "idle"
        self._state_change_t = -10.0

    def _decode_avatar_loop(self, video_path, size):
        """(frames, duration, fps) for one status loop, circle-masked at
        `size`. Frames live in memory: an 80px loop is ~100 tiny RGBA tiles."""
        import glob as _glob
        import json as _json
        import subprocess, tempfile, shutil
        from .vendor_path import vendor_bin
        tmp = tempfile.mkdtemp(prefix="mm-avloop-")
        try:
            # Center-crop to square BEFORE scaling. Status videos generated
            # before the pipeline's crop-to-square normalization (2026-05,
            # jarvis #7078) are 9:16 portrait with the square avatar centered
            # between black pad bars; a bare WxH scale squashed the face into
            # the circle. min(iw,ih) centered recovers exactly that square,
            # and is a no-op on square sources.
            subprocess.run(
                [vendor_bin("ffmpeg"), "-y", "-v", "error", "-i", video_path,
                 "-vf", ("crop='min(iw,ih)':'min(iw,ih)',"
                         f"scale={size}:{size}:flags=lanczos"),
                 os.path.join(tmp, "f_%04d.png")],
                check=True, capture_output=True)
            probe = subprocess.run(
                [vendor_bin("ffprobe"), "-v", "error", "-print_format",
                 "json", "-show_format", "-show_streams", video_path],
                check=True, capture_output=True, text=True)
            meta = _json.loads(probe.stdout)
            duration = float(meta["format"]["duration"])
            fps = 24.0
            for s in meta.get("streams", []):
                if s.get("codec_type") == "video":
                    num, den = s["r_frame_rate"].split("/")
                    if float(den):
                        fps = float(num) / float(den)
                    break
            frames = []
            for fp in sorted(_glob.glob(os.path.join(tmp, "f_*.png"))):
                with Image.open(fp) as fr:
                    masked = Image.new("RGBA", (size, size), (0, 0, 0, 0))
                    masked.paste(fr.convert("RGBA"), (0, 0), self._avatar_mask)
                    frames.append(masked)
            if not frames or duration <= 0:
                raise ValueError(f"no frames decoded from {video_path}")
            return frames, duration, fps
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @property
    def header_animates(self):
        """True when the pinned avatar plays status loops (compose must not
        reuse cached layers across frames)."""
        return bool(self._avatar_states)

    @property
    def closing_avatar_state(self):
        return ("laughing" if self._avatar_states.get("laughing")
                else "milestone_level_up")

    def closing_avatar_duration(self):
        """Time to finish the selected reaction, including its delayed entry."""
        loop = self._avatar_states.get(self.closing_avatar_state)
        duration = max(loop[1], len(loop[0]) / loop[2]) if loop else 0.0
        return (FINISHER_FADE_SECS + FINISHER_CELEBRATE_DELAY
                + AVATAR_CROSSFADE_SECS + duration + 0.5)

    def _avatar_state_for(self, t, active_blocks):
        """Map thread activity at time t onto an avatar status state."""
        fin = getattr(self, "_finisher", None)
        if fin and t >= (fin["start"] + FINISHER_FADE_SECS
                         + FINISHER_CELEBRATE_DELAY):
            return self.closing_avatar_state
        bubbles_live = [b for b in active_blocks
                        if b["type"] == "bubble" and b.get("start", 0) <= t]
        if not bubbles_live:
            return "connecting"          # cold open: dialing in
        for b in active_blocks:
            if b["type"] == "typing" and b.get("start", 0) <= t <= b.get("end", 0):
                return "working"
        for b in active_blocks:
            for rx in b.get("reactions", []):
                if 0 <= (t - rx.get("start", 0)) <= 1.5:
                    return "milestone_level_up"
        for b in active_blocks:
            if (b["type"] == "bubble" and b.get("is_muse")
                    and 0 <= (t - b.get("start", 0)) <= 0.7):
                return "making_something"
        return "idle"

    def _avatar_frame(self, t, active_blocks):
        """The pinned avatar's frame at time t: the active status loop's
        frame, crossfaded 0.3s across state switches; static circle when no
        loops exist."""
        state = self._avatar_state_for(t, active_blocks)
        fin = getattr(self, "_finisher", None)
        closing = bool(fin) and t >= (
            fin["start"] + FINISHER_FADE_SECS + FINISHER_CELEBRATE_DELAY)
        opening_close = closing and not getattr(self, "_closing_started", False)
        if opening_close:
            self._closing_started = True
        if state != self._cur_state or opening_close:
            self._prev_state = self._cur_state
            self._prev_change_t = getattr(self, "_state_change_t", 0.0)
            self._cur_state = state
            self._state_change_t = t

        def frame_for(s, tt, origin):
            # Each activation plays its loop from ITS OWN first frame
            # (anchored at the switch), never from a global-clock offset:
            # a choreographed state like the celebration must open on its
            # opening frame, not wherever the clock lands mid-cycle.
            loop = self._avatar_states.get(s) or self._avatar_states.get("idle")
            if not loop:
                return self._pinned_avatar
            frames, dur, fps = loop
            elapsed = max(0.0, tt - origin)
            fin = getattr(self, "_finisher", None)
            if fin and s == self.closing_avatar_state and tt >= (
                    fin["start"] + FINISHER_FADE_SECS + FINISHER_CELEBRATE_DELAY):
                # Play the closing reaction once, then hold its last frame.
                idx = min(int(elapsed * fps), len(frames) - 1)
            else:
                idx = int((elapsed % dur) * fps) % len(frames)
            return frames[idx]

        cur = frame_for(self._cur_state, t, self._state_change_t)
        elapsed = t - self._state_change_t
        if 0 <= elapsed < AVATAR_CROSSFADE_SECS:
            prev = frame_for(self._prev_state, t,
                             getattr(self, "_prev_change_t", 0.0))
            return Image.blend(prev, cur,
                               ease_out_cubic_f(elapsed / AVATAR_CROSSFADE_SECS))
        return cur

    def _measure_blocks(self, active_blocks: List[Dict[str,Any]]):
        """pre-compute lines/lh/bw/bh for bubbles, card/bw/bh for proofs"""
        for b in active_blocks:
            if b["type"]=="bubble" and "lines" not in b:
                is_h = b.get("is_muse", False)
                # text wraps inside the safe-zone stage (SAFE_LEFT..SAFE_RIGHT
                # minus the bubble's own 28px-a-side padding)
                max_w = self.SAFE_RIGHT - self.SAFE_LEFT - px(56)
                font = self.font_muse if is_h else self.font_bubble
                lines,lh,bw,bh = measure_bubble(b["text"], font, max_w=max_w)
                b["lines"]=lines; b["lh"]=lh; b["bw"]=bw; b["bh"]=bh; b["font"]=font
            elif b["type"]=="photo" and "bw" not in b:
                b["bw"], b["bh"] = b["img"].width, b["img"].height
            elif b["type"]=="video" and "bw" not in b:
                from .templates import _SHADOW_PAD
                b["bw"] = b["vw"] + 2*px(_SHADOW_PAD)
                b["bh"] = b["vh"] + 2*px(_SHADOW_PAD)
            elif b["type"]=="browser" and "bw" not in b:
                from .templates import _SHADOW_PAD, BROWSER_BAR_H
                b["bw"] = b["w_t"] + 2*px(_SHADOW_PAD)
                b["bh"] = (px(BROWSER_BAR_H) + b["vp_t"]) + 2*px(_SHADOW_PAD)
            elif b["type"]=="typing" and "bw" not in b:
                from .templates import make_typing_bubble
                probe = make_typing_bubble(0.0)
                b["bw"], b["bh"] = probe.width, probe.height
            elif b["type"]=="proof" and "card" not in b:
                # compose cards + verifies every proof BEFORE the frame loop;
                # an uncarded proof reaching here is a pipeline bug, and a
                # silent placeholder would ship a broken visual.
                raise ValueError(
                    "proof block reached render_frame without a verified "
                    "'card' — route proofs through cmm.compose")

    def _visible_height(self, b):
        """The block's on-screen height at scale 1 (media measured by its
        VISIBLE box, not the transparent shadow pad)."""
        if b["type"] in ("photo", "video", "browser"):
            from .templates import _SHADOW_PAD
            return b["bh"] - 2 * px(_SHADOW_PAD)
        return b["bh"]

    def render_frame(self, t: float, active_blocks: List[Dict[str,Any]]) -> Image.Image:
        """
        t: seconds
        active_blocks: chronological oldest->newest dicts — bubble /
        typing / proof (pre-carded by compose) / photo / video.
        Returns an RGBA layer W×H ready to alpha_composite over the frame.

        RAIL PHYSICS (v22): the stack marches ALONG one straight 3D rail
        from the bottom anchor to the vanishing point. Each block advances
        a cursor by its own SCALED height plus a scaled gap, so ordering
        is monotonic and overlap is impossible by construction; spacing
        compresses with perspective for free. Blocks rest in the ORIGINAL
        chat pose (assistant left inset, user right inset, media centered)
        and converge to per-speaker lanes at the vanish end. A tap doesn't
        expand any slot: it SHOVES the rest of the thread up the rail
        (extra rail distance + extra depth) while the tapped card runs its
        modal path, and everything glides back on settle.
        """
        W,H = self.W, self.H
        self._measure_blocks(active_blocks)

        blocks = [b for b in active_blocks
                  if not (b["type"] == "proof" and not b.get("visible", True))]

        def entry(b):
            grow = ease_out_cubic_f(
                min(1.0, max(0.0, (t - b.get("start", 0)) / SLIDE_SECS)))
            # A finished typing indicator leaves the way it arrived.
            if b["type"] == "typing" and t > b["end"]:
                grow *= 1.0 - ease_out_cubic_f(
                    min(1.0, max(0.0, (t - b["end"]) / SLIDE_SECS)))
            return grow

        # one block mid-tap shoves everyone else up the rail
        tap_block, tap_mode, tap_p, shove_g = None, None, 0.0, 0.0
        for b in blocks:
            if b.get("tap") and ("tap_img" in b
                                 or b["type"] in ("video", "browser")):
                mode, p = _tap_phase(b, t)
                if mode is not None:
                    tap_block, tap_mode, tap_p = b, mode, p
                    shove_g = {"press": 0.0, "grow": ease_out_cubic_f(p),
                               "hold": 1.0,
                               "shrink": 1.0 - ease_out_cubic_f(p)}[mode]
                    break

        n_blocks = len(blocks)
        rail = self.BOTTOM_Y - self.HORIZON_Y
        vanish = {
            "user": (RAIL_VANISH_X + RAIL_LANE_SEP) * W,
            "muse": (RAIL_VANISH_X - RAIL_LANE_SEP) * W,
            "center": RAIL_VANISH_X * W,
        }

        def lane_of(b):
            if b["type"] == "bubble":
                return "muse" if b.get("is_muse") else "user"
            if b["type"] == "typing":
                return "muse"
            return "center"

        def home_cx(b):
            # ORIGINAL chat pose: assistant hugs the left safe inset, user
            # the right, media centers. (Wide bubbles read near-centered.)
            lane = lane_of(b)
            if lane == "muse":
                return self.SAFE_LEFT + b["bw"] / 2
            if lane == "user":
                return self.SAFE_RIGHT - b["bw"] / 2
            return W / 2

        def push(b):
            """How much of this block's rail distance the thread above it
            currently feels. A newcomer APPEARS fast (entry, 0.3s) but
            pushes the thread up the rail on the slower DEPTH_SECS glide,
            so the crawl breathes instead of snapping. A finished typing
            indicator eases its distance shut the same way."""
            grow = ease_out_cubic_f(
                min(1.0, max(0.0, (t - b.get("start", 0)) / DEPTH_SECS)))
            if b["type"] == "typing" and t > b["end"]:
                grow *= 1.0 - ease_out_cubic_f(
                    min(1.0, max(0.0, (t - b["end"]) / DEPTH_SECS)))
            return grow

        # ── pass 1 (newest→oldest): march the cursor up the rail ──────────
        # Everything a block IS at an instant — scale, alpha, x, y — is a
        # function of its own rail position tt, so it shrinks and fades
        # exactly as it travels. The x-path converges with an eased curve
        # (faster than y), which bows the trajectory to the RIGHT before it
        # climbs — the arc, not a straight diagonal.
        placed = []
        cursor_u = 0.0  # cumulative RAW content length (monotonic in time)
        for idx in range(n_blocks - 1, -1, -1):
            b = blocks[idx]
            if b["type"] == "typing" and t > b["end"] + DEPTH_SECS:
                continue
            is_tapped = b is tap_block
            u = cursor_u
            if tap_block is not None and not is_tapped:
                u += px(TAP_RAIL_SHOVE) * shove_g
            tt = min(1.15, rail_warp(u, rail))
            z_scale, z_alpha = rail_decay(tt)
            en = entry(b)
            vis_h = self._visible_height(b) * z_scale
            y_top = self.BOTTOM_Y - rail * tt - vis_h * en
            arc = ease_out_cubic_f(min(tt, 1.0))
            cx = home_cx(b) + (vanish[lane_of(b)] - home_cx(b)) * arc
            alpha = z_alpha * en
            placed.append((b, is_tapped, z_scale, alpha, cx, y_top))
            cursor_u += (self._visible_height(b) + self.GAP) * push(b)

        content = Image.new("RGBA",(W,H),(0,0,0,0))
        tap_draw = None

        # ── pass 2 (oldest→newest): draw up the rail ──────────────────────
        for b, is_tapped, z_scale, alpha, cx, y_top in reversed(placed):
            if b["type"] == "typing" and t > b["end"]:
                continue  # dots gone; its rail distance still eases shut
            frame_offset = int((t - b.get("start", 0)) * FPS)
            scale = pop_scale(frame_offset) * z_scale
            bw = b["bw"]; bh = b["bh"]

            if is_tapped:
                # modal path: fly from the CURRENT rail rect (pad-compensated
                # photo-shaped rect, dims including the shadow pad)
                # (browser/video modals build their frame inside _draw_tap)
                from .templates import _SHADOW_PAD
                _pad = px(_SHADOW_PAD)
                if b["type"] == "proof":
                    rx = cx - (bw * z_scale) / 2 - _pad
                    rw = bw * z_scale + 2 * _pad
                    rh = bh * z_scale + 2 * _pad
                else:
                    rx = cx - (bw * z_scale) / 2
                    rw = bw * z_scale
                    rh = bh * z_scale
                tap_draw = (b, tap_mode, tap_p,
                            (int(rx), int(y_top - _pad * z_scale),
                             int(rw), int(rh)))
                continue
            if alpha <= 0.004:
                continue  # the rail finished it; its distance still counts

            def paste(img, vis_w_full, vis_h_full, pad=0):
                """Draw `img` (which may carry `pad` transparent px around
                the visible box) centered at cx with its VISIBLE top at
                y_top, scaled by the combined scale + alpha."""
                w2 = max(1, int(img.width * scale))
                h2 = max(1, int(img.height * scale))
                im2 = img.resize((w2, h2), Image.LANCZOS)
                if alpha < 1.0:
                    a_ch = im2.getchannel("A").point(
                        lambda p: int(p * alpha))
                    im2.putalpha(a_ch)
                x0 = int(cx - w2 / 2)
                y0 = int(y_top - pad * scale)
                content.paste(im2, (x0, y0), im2)
                return x0, y0, w2, h2

            if b["type"] == "bubble":
                is_muse = b.get("is_muse", False)
                # No text streaming: a bubble pops in WHOLE, like a real
                # text message (Lucas ruling 2026-09-02 — the word-by-word
                # reveal is retired). Rendered once and cached.
                if "_static" not in b:
                    bub_img = draw_bubble_base(bw, bh, is_muse)
                    py=px(24)
                    for line in b["lines"]:
                        draw_rich_text(bub_img, (px(28), py), line, b["font"],
                                       (17, 17, 18, 255))
                        py+=b["lh"]
                    b["_static"] = bub_img
                bub_img = b["_static"]

                vx0, vy0, vis_w, vis_hh = paste(bub_img, bw, bh)

                # emoji reactions ride the corner of the decayed bubble
                for rx in b.get("reactions", []):
                    rp = (t - rx["start"]) / 0.45
                    if rp <= 0:
                        continue
                    if "_badge" not in rx:
                        from .templates import make_reaction_badge
                        rx["_badge"] = make_reaction_badge(rx["emoji"])
                    badge = rx["_badge"]
                    rscale, ralpha = reaction_anim(rp)
                    rscale *= z_scale
                    ralpha *= alpha if alpha < 1.0 else 1.0
                    bw2 = max(1, int(badge.width * rscale))
                    bh2 = max(1, int(badge.height * rscale))
                    bimg = badge.resize((bw2, bh2), Image.LANCZOS)
                    if ralpha < 1.0:
                        a2 = bimg.split()[-1].point(lambda px: int(px * ralpha))
                        bimg.putalpha(a2)
                    bx = vx0 + vis_w - bw2 * 2 // 3 if is_muse else vx0 - bw2 // 3
                    by = vy0 - bh2 // 2 + px(4)
                    content.paste(bimg, (int(bx), int(by)), bimg)

            elif b["type"] == "photo":
                from .templates import _SHADOW_PAD
                ph = b["img"]
                if b.get("anim_frames"):
                    frames = b["anim_frames"]
                    ph = frames[_anim_index(b, t, len(frames))]
                paste(ph, bw, bh, pad=px(_SHADOW_PAD))

            elif b["type"] == "video":
                from .templates import PHOTO_RADIUS, _SHADOW_PAD, _SHADOW_OFFSET, _SHADOW_BLUR, _SHADOW_ALPHA
                from PIL import ImageFilter
                if "_shadow" not in b:
                    P=px(_SHADOW_PAD); w,h=b["vw"],b["vh"]
                    ox, oy = px(_SHADOW_OFFSET[0]), px(_SHADOW_OFFSET[1])
                    canvas=Image.new("RGBA",(w+2*P,h+2*P),(0,0,0,0))
                    sh=Image.new("RGBA",canvas.size,(0,0,0,0))
                    ImageDraw.Draw(sh).rounded_rectangle(
                        (P+ox,P+oy,P+w+ox,P+h+oy),
                        radius=px(PHOTO_RADIUS), fill=(0,0,0,_SHADOW_ALPHA))
                    sh=sh.filter(ImageFilter.GaussianBlur(px(_SHADOW_BLUR)))
                    canvas.alpha_composite(sh)
                    b["_shadow"]=canvas
                    m=Image.new("L",(w,h),0)
                    ImageDraw.Draw(m).rounded_rectangle((0,0,w-1,h-1),radius=px(PHOTO_RADIUS),fill=255)
                    b["_mask"]=m
                idx2 = min(int((t - b["start"]) * b["fps"]), len(b["frames"]) - 1)
                idx2 = max(0, idx2)
                import os as _os
                fr = Image.open(_os.path.join(b["frames_dir"], b["frames"][idx2])).convert("RGBA")
                if fr.size != (b["vw"], b["vh"]):
                    fr = fr.resize((b["vw"], b["vh"]), Image.LANCZOS)
                canvas = b["_shadow"].copy()
                canvas.paste(fr, ((canvas.width-b["vw"])//2, (canvas.height-b["vh"])//2), b["_mask"])
                paste(canvas, bw, bh, pad=px(_SHADOW_PAD))

            elif b["type"] == "browser":
                paste(self._browser_card(b, t), bw, bh,
                      pad=0)  # the wrap already carries the pad

            elif b["type"] == "typing":
                from .templates import make_typing_bubble
                ty = make_typing_bubble(phase=t)
                paste(ty, bw, bh)

            else:  # proof — a receipt card IS a message in the thread
                paste(b["card"], bw, bh)

        fin = getattr(self, "_finisher", None)
        fin_p = 0.0
        if fin and t >= fin["start"]:
            fin_p = ease_out_cubic_f(
                min(1.0, (t - fin["start"]) / FINISHER_FADE_SECS))

        if fin_p <= 0.0:
            self._draw_header(content, t, active_blocks)

        if tap_draw is not None:
            content = self._draw_tap(content, t, *tap_draw)

        if fin_p > 0.0:
            # ONE surface: the lockup frame is pasted opaquely onto the
            # full-frame fill (the lockup's own background color), and the
            # combined layer fades in as a single alpha — the band can
            # never read as its own card mid-transition. The header draws
            # after it so the avatar (celebration loop) rides on top.
            import os as _os
            idx = max(0, min(int((t - fin["start"]) * fin["fps"]),
                             len(fin["frames"]) - 1))
            fr = Image.open(_os.path.join(
                fin["frames_dir"], fin["frames"][idx])).convert("RGB")
            bg = fr.getpixel((0, 0))
            surface = Image.new("RGB", (self.W, self.H), bg)
            # place the band so the CONTENT group's midpoint (measured by
            # compose on the resolved frame) sits at the frame's center
            cy = fin.get("content_cy", 0.5)
            surface.paste(fr, ((self.W - fr.width) // 2,
                               int(self.H * FINISHER_LOCKUP_CY
                                   - cy * fr.height)))
            surface = surface.convert("RGBA")
            surface.putalpha(int(255 * fin_p))
            content.alpha_composite(surface)
            self._draw_header(content, t, active_blocks)
        return content

    def set_finisher(self, start, frames_dir, frames, fps, content_cy=0.5):
        """Arm the full-screen Muse finisher: from `start` the frame fades
        to white, the lockup plays centered, and the pinned header stays on
        top in its celebration state. `content_cy` is the visible content
        group's midpoint within the band (fraction), measured by compose so
        the group, not the band, centers on screen. compose arms this on
        every video; it is never screenplay-authored."""
        self._closing_started = False
        self._finisher = {"start": start, "frames_dir": frames_dir,
                          "frames": frames, "fps": fps,
                          "content_cy": content_cy}

    def finisher_active(self, t):
        fin = getattr(self, "_finisher", None)
        return bool(fin) and t >= fin["start"]

    @staticmethod
    def _shadow_wrap(b, key, w, h):
        """Cached rounded-corner mask + drop-shadow canvas for a live-drawn
        block at (w, h) visible size. Returns (canvas_copy, mask, pad)."""
        from .templates import (PHOTO_RADIUS, _SHADOW_PAD, _SHADOW_OFFSET,
                                _SHADOW_BLUR, _SHADOW_ALPHA)
        from PIL import ImageFilter
        if key not in b:
            P = px(_SHADOW_PAD)
            ox, oy = px(_SHADOW_OFFSET[0]), px(_SHADOW_OFFSET[1])
            canvas = Image.new("RGBA", (w + 2*P, h + 2*P), (0, 0, 0, 0))
            sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
            ImageDraw.Draw(sh).rounded_rectangle(
                (P + ox, P + oy, P + w + ox, P + h + oy),
                radius=px(PHOTO_RADIUS), fill=(0, 0, 0, _SHADOW_ALPHA))
            sh = sh.filter(ImageFilter.GaussianBlur(px(_SHADOW_BLUR)))
            canvas.alpha_composite(sh)
            m = Image.new("L", (w, h), 0)
            ImageDraw.Draw(m).rounded_rectangle(
                (0, 0, w - 1, h - 1), radius=px(PHOTO_RADIUS), fill=255)
            b[key] = (canvas, m)
        canvas, m = b[key]
        return canvas.copy(), m, px(_SHADOW_PAD)

    def _browser_card(self, b, t, stage=False):
        """The browser-session card at time t, shadow-wrapped: thread size
        by default, tap-stage size with stage=True."""
        from .templates import make_browser_frame, BROWSER_BAR_H
        w = b["w_s"] if stage else b["w_t"]
        vp = b["vp_s"] if stage else b["vp_t"]
        shots = b["shots_s"] if stage else b["shots_t"]
        clicks = b["clicks_s"] if stage else b["clicks_t"]
        # chrome scale: the stage shell is the thread shell scaled by k,
        # keeping the two renders geometrically similar for the tap
        k = (b["w_s"] / b["w_t"]) if stage else 1.0
        frame = make_browser_frame(
            shots, clicks, b["address"], w, vp,
            max(0.0, t - b["start"]), b["end"] - b["start"], k=k)
        canvas, m, P = self._shadow_wrap(
            b, "_shadow_s" if stage else "_shadow_t", w, frame.height)
        canvas.paste(frame, (P, P), m)
        return canvas

    def _video_stage_frame(self, b, t):
        """The playing video at tap-stage size (frames were extracted at
        stage fit when the block taps)."""
        import os as _os
        idx = min(int((t - b["start"]) * b["fps"]), len(b["frames"]) - 1)
        idx = max(0, idx)
        fr = Image.open(_os.path.join(
            b["frames_dir"], b["frames"][idx])).convert("RGBA")
        fw, fh = b.get("fw", b["vw"]), b.get("fh", b["vh"])
        if fr.size != (fw, fh):
            fr = fr.resize((fw, fh), Image.LANCZOS)
        canvas, m, P = self._shadow_wrap(b, "_shadow_stage", fw, fh)
        canvas.paste(fr, (P, P), m)
        return canvas

    def _draw_header(self, content, t, active_blocks):
        """The pinned identity header, with its HERO INTRO.

        Cold open: the avatar springs in at 2x, centered low in the frame
        (65% height) — the agent arriving in the scene. The moment the
        first message lands it spring-animates up to its pinned spot at
        24% height and settles to 1x. Position gets an ease-out-back
        spring (a fun bounce); scale gets pure cubic deceleration —
        coupling both to the spring made the size oscillate, which read
        as jitter, not bounce. Draws AFTER the fade mask: the header
        sits above the rail's horizon.
        """
        W, H = self.W, self.H
        av_frame = self._avatar_frame(t, active_blocks)
        av_sz = av_frame.size[0]

        HERO_SCALE = 2.0
        hero_center_y = int(H * 0.65)
        ENTRANCE = 0.4
        ep = min(1.0, max(0.0, t / ENTRANCE))
        entrance = ease_out_back(ep, c1=2.2) if ep < 1.0 else 1.0

        first_msg_t = None
        for blk in active_blocks:
            if blk.get("type") == "bubble":
                first_msg_t = blk.get("start", 0)
                break

        INTRO = 0.8
        if first_msg_t is None or t < first_msg_t:
            ip = 0.0
        else:
            ip = min(1.0, (t - first_msg_t) / INTRO)

        if ip <= 0.0:
            cur_scale = HERO_SCALE * entrance
            cur_cy = hero_center_y
        else:
            pos_spring = ease_out_back(ip, c1=1.2) if ip < 1.0 else 1.0
            cur_scale = HERO_SCALE + (1.0 - HERO_SCALE) * ease_out_cubic_f(ip)
            cur_cy = hero_center_y + (self._avatar_center_y
                                      - hero_center_y) * pos_spring
        if cur_scale <= 0.01:
            return

        s_av = max(1, int(av_sz * cur_scale))
        av_x = (W - s_av) // 2
        # never clip the top edge, even mid-spring-overshoot
        av_y = max(px(20), int(cur_cy) - s_av // 2)

        # the pill swaps to its light skin with the finisher's white fade
        fin = getattr(self, "_finisher", None)
        pill_src = self._name_pill
        if fin and t >= fin["start"]:
            fp = ease_out_cubic_f(
                min(1.0, (t - fin["start"]) / FINISHER_FADE_SECS))
            pill_src = (self._name_pill_light if fp >= 1.0 else
                        Image.blend(self._name_pill,
                                    self._name_pill_light, fp))
        np_w, np_h = pill_src.size
        s_pw = max(1, int(np_w * cur_scale))
        s_ph = max(1, int(np_h * cur_scale))
        pill = pill_src.resize((s_pw, s_ph), Image.LANCZOS)
        np_x = (W - s_pw) // 2
        np_y = av_y + s_av - int(px(6) * cur_scale)
        content.paste(pill, (np_x, np_y), pill)

        av = (av_frame if s_av == av_sz
              else av_frame.resize((s_av, s_av), Image.LANCZOS))
        content.paste(av, (av_x, av_y), av)

    def _draw_tap(self, content, t, b, mode, p, slot_rect):
        """The INLINE tap effect: press, grow, hold, shrink — full-screen
        inside the chat window.

        No slot expands: the tap SHOVES the rest of the thread up the
        rail (render_frame adds rail distance + depth to every other
        block), so the clearing rides the same trajectory as normal
        aging. The card then flies from its thread
        position to the CENTER of the tap stage (TAP_STAGE_W/H, anchored
        to the stack's bottom so the enlarged card stays clear of the
        creator's face and the pinned header) and grows to whatever its
        aspect allows within that box — the feel is the app going
        full-screen inside the thread, never a growth anchored to the
        card's old slot (that anchored version read as "grew a bit and
        got clipped"). This draw runs AFTER the fade mask so the grown
        card stays crisp while pushed messages dissolve. All intermediate
        sizes are downscales of the stage-resolution canvas.
        """
        from .templates import _SHADOW_PAD, TAP_STAGE_W, TAP_STAGE_H
        if b["type"] == "browser":
            big = self._browser_card(b, t, stage=True)
        elif b["type"] == "video":
            big = self._video_stage_frame(b, t)
        else:
            # dict.get evaluates its default eagerly — proof blocks carry
            # tap_img but no img, so index conditionally.
            big = b["tap_img"] if "tap_img" in b else b["img"]
            if b.get("tap_frames"):
                big = b["tap_frames"][_anim_index(b, t, len(b["tap_frames"]))]
        mx, py2, bw, bh = slot_rect
        tw, th = big.size
        pad = px(_SHADOW_PAD)
        vw1, vh1 = tw - 2 * pad, th - 2 * pad

        if mode == "press":
            g, k = 0.0, 1.0 - 0.04 * ease_out_cubic_f(p)
        elif mode == "grow":
            g, k = ease_out_back(p), 1.0
        elif mode == "hold":
            g, k = 1.0, 1.0
        else:  # shrink
            g, k = 1.0 - ease_out_cubic_f(p), 1.0

        # the tap stage: bottom-anchored so the modal never rides over the
        # creator's face or the pinned header
        aw = px(TAP_STAGE_W)
        ah = px(TAP_STAGE_H)
        stage_top = self.BOTTOM_Y - ah
        s1 = min(aw / vw1, ah / vh1)
        s0 = (bw - 2 * pad) / vw1
        s = (s0 + (s1 - s0) * g) * k
        cw, ch = max(1, int(tw * s)), max(1, int(th * s))
        vw, vh = int(vw1 * s), int(vh1 * s)
        # interpolate the visible rect from its thread slot to dead
        # center of the tap stage
        x0, y0 = mx + pad, py2 + pad
        tx = (self.W - vw) // 2
        ty = stage_top + max(0, (ah - vh) // 2)
        vx = int(x0 + (tx - x0) * g)
        vy = int(y0 + (ty - y0) * g + (bh - 2 * pad) * (1 - k) / 2)

        card = big if (cw, ch) == (tw, th) else big.resize(
            (cw, ch), Image.LANCZOS)
        content.paste(card, (vx - int(pad * s), vy - int(pad * s)), card)
        return content

    def render_sfx_wav(self, sent_times, received_times, plink_times,
                       duration, out_path):
        """Message sounds, iMessage-style directional pitches.

        - sent (the user's bubbles): quick two-tone RISE, brighter and a
          touch quieter — "swip" going out
        - received (Muse bubbles AND receipt cards): single lower "ding"
        - reaction plink: two-tone up-chirp, unchanged
        """
        import wave, struct
        SR = 44100
        N = int((duration + 1) * SR)
        samples = [0.0] * N
        def tone(ts, freq, dur, gain):
            si = int(ts * SR)
            n = int(dur * SR)
            for i in range(n):
                tt = i / SR
                env = tt / 0.005 if tt < 0.005 else math.exp(-22 * (tt - 0.005))
                v = math.sin(2 * math.pi * freq * tt) * env * gain
                if si + i < N:
                    samples[si + i] += v
        for ts in sent_times:
            tone(ts, 880, 0.05, 0.24)           # swi-
            tone(ts + 0.05, 1175, 0.09, 0.26)   # -ip (A5 -> D6 rise)
        for ts in received_times:
            tone(ts, 740, 0.13, 0.35)           # F#5 ding
        for ts in plink_times:
            tone(ts, 740, 0.07, 0.30)          # pa-
            tone(ts + 0.07, 1109, 0.12, 0.34)  # ding
        # Keep effects SUBTLE under the VO: never normalize UP, and cap the
        # peak well below the voice (0.5 made every ding as loud as speech).
        maxv = max((abs(x) for x in samples), default=1) or 1
        k = min(1.0, 0.16 / maxv)
        with wave.open(out_path, "w") as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(SR)
            for x in samples:
                wf.writeframesraw(struct.pack("<h", int(max(-32768, min(32767, x * k * 32767)))))
        return out_path
