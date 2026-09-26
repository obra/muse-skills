"""Thread chrome — the deterministic message-thread furniture.

Everything here is app UI, not content: the reaction badge, the typing
indicator, and the photo/video-message treatment. Custom visuals
are agent-authored HTML rendered by `html_assets.render_html`; nothing in
this module composes a card.
"""

from PIL import Image, ImageDraw

# Every pixel value in this module is calibrated at 720x1280 and passed
# through overlay.px(), which scales it to the active canvas (pinned by
# MessageOverlayRenderer from the render width) — identity at 720.
from .overlay import load_font, px

INK = (17, 17, 18)          # product text-primary #111112
CHIP_BG = (255, 255, 255)


def _f(sz, bold=False):
    return load_font(sz, bold=bold)


_EMOJI_FONT = None


def _emoji_font():
    """Noto Color Emoji ships with the skill (bitmap strikes: size 109 only)."""
    global _EMOJI_FONT
    if _EMOJI_FONT is None:
        from PIL import ImageFont
        import os as _os
        path = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
                             "assets", "fonts", "NotoColorEmoji.ttf")
        _EMOJI_FONT = ImageFont.truetype(path, 109)
    return _EMOJI_FONT


def make_reaction_badge(emoji, size=None):
    """iOS-style tapback badge: white pill with the emoji + two tail dots.

    Rendered at 2x and downscaled so the emoji stays crisp; the caller
    animates scale/alpha per frame. `size` defaults to the canvas-scaled
    equivalent of the locked 64px badge.
    """
    if size is None:
        size = px(64)
    S = size * 2
    im = Image.new("RGBA", (S + px(20), S + px(26)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((px(6), px(10), S + px(2), S + px(6)), fill=(0, 0, 0, 40))  # shadow
    d.ellipse((px(2), px(2), S - px(2), S - px(2)), fill=(255, 255, 255, 255))
    # emoji drawn at native 109 bitmap size then fitted into the circle
    e = Image.new("RGBA", (140, 140), (0, 0, 0, 0))
    ImageDraw.Draw(e).text((8, 8), emoji, font=_emoji_font(), embedded_color=True)
    bbox = e.getbbox()
    if bbox:
        e = e.crop(bbox)
    inner = int(S * 0.62)
    e = e.resize((inner, inner), Image.LANCZOS)
    im.paste(e, ((S - inner) // 2, (S - inner) // 2 - px(2)), e)
    # tail: two shrinking dots toward the bubble corner
    d.ellipse((S - px(26), S - px(6), S - px(2), S + px(18)), fill=(255, 255, 255, 255))
    d.ellipse((S + px(2), S + px(12), S + px(14), S + px(24)), fill=(255, 255, 255, 255))
    return im.resize(((S + px(20)) // 2, (S + px(26)) // 2), Image.LANCZOS)


def make_typing_bubble(phase=0.0):
    """The three bouncing dots — Muse is typing. `phase` in seconds."""
    import math
    w, h = px(140), px(76)
    im = Image.new("RGBA", (w + px(4), h + px(3)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((px(2), px(4), w + px(2), h), radius=px(24), fill=(0, 0, 0, 30))
    d.rounded_rectangle((0, 0, w, h - px(3)), radius=px(24), fill="#FFFFFF")
    for i in range(3):
        pulse = 0.5 + 0.5 * math.sin(phase * 5.2 - i * 0.9)
        r = px(7) + int(px(3) * pulse)
        alpha = 120 + int(120 * pulse)
        cx = px(34) + i * px(36)
        cy = (h - px(3)) // 2
        d.ellipse((cx - r, cy - r, cx + r, cy + r),
                  fill=(95, 103, 118, alpha))
    return im


# Media caps (720-base; consumers pass them through px() like everything
# else). 640 wide centers with 40px margins — media is deliberately wider
# than the 14%-inset text-safe lane; 370 tall (310 pre-rail: the rail
# stage is far taller than the old clipped band, and photos are the most
# looked-at thing in the thread) still keeps a fresh full-height photo in
# the lower half of the frame before the rail shrinks it. render_html's tall-card gate (600px at
# 1240 authoring width) is this cap divided by the width-fit scale
# (640/1240), so tall cards stay width-limited instead of shrinking.
PHOTO_MAX_W, PHOTO_MAX_H = 640, 370
# The tap stage (720-base): the thread region a tap window clears and
# the box a tapped card grows within. Shared by compose (stage-res
# canvas) and overlay (slot expansion + centering). Anchored to the
# stack's BOTTOM_Y and sized to stay clear of the creator's face and the
# pinned header: 640 wide (media margins), 470 tall (~37% of the frame).
TAP_STAGE_W, TAP_STAGE_H = 640, 470
_SHADOW_PAD = 28          # canvas padding that holds the drop shadow
_SHADOW_OFFSET = (0, 10)
_SHADOW_BLUR = 12
_SHADOW_ALPHA = 90
PHOTO_RADIUS = 24


def make_photo(img, max_w=None, max_h=None):
    """A photo/video-frame message: rounded corners + soft drop shadow,
    sitting directly on the video — NO white receipt shell. (Real images in
    white card shells read as 'weird white backgrounds'.)

    The shadow follows the content's OWN alpha, never a full rectangle: a
    transparent-rooted HTML component used to get a rounded-rect shadow
    baked behind it, which read as a grey card/bubble under elements that
    were designed to stand alone on the footage. An opaque photo's alpha
    IS the rounded rectangle, so its look is unchanged.

    max_w/max_h override the thread-slot cap (720-base units) for callers
    that need a larger canvas — the tap effect renders its enlarged state
    from a stage-sized canvas so the apex is crisp, never an upscale.

    Returns an RGBA canvas with the shadow pre-baked, ready to paste.
    """
    from PIL import ImageChops, ImageFilter
    img = img.convert("RGBA")
    scale = min(px(max_w or PHOTO_MAX_W) / img.width,
                px(max_h or PHOTO_MAX_H) / img.height, 1.0)
    w, h = max(1, int(img.width * scale)), max(1, int(img.height * scale))
    img = img.resize((w, h), Image.LANCZOS)

    rmask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(rmask).rounded_rectangle((0, 0, w - 1, h - 1),
                                            radius=px(PHOTO_RADIUS), fill=255)
    alpha = ImageChops.multiply(img.getchannel("A"), rmask)
    img.putalpha(alpha)
    P = px(_SHADOW_PAD)
    ox, oy = px(_SHADOW_OFFSET[0]), px(_SHADOW_OFFSET[1])
    canvas = Image.new("RGBA", (w + 2 * P, h + 2 * P), (0, 0, 0, 0))
    sil = Image.new("L", canvas.size, 0)
    sil.paste(alpha, (P + ox, P + oy))
    sil = sil.filter(ImageFilter.GaussianBlur(px(_SHADOW_BLUR)))
    sil = sil.point(lambda a: a * _SHADOW_ALPHA // 255)
    black = Image.new("L", canvas.size, 0)
    canvas.alpha_composite(Image.merge("RGBA", (black, black, black, sil)))
    canvas.alpha_composite(img, (P, P))
    return canvas


# ---- the browser-session component (first-class, renderer-owned) ------
# One browser stays on stage for a whole journey: the shell chrome is
# drawn once, and make_browser_frame paints the page, the touring
# cursor, the click ring, and the load-flash swap for any moment in
# the beat. Pages arrive as pre-rendered stills (rebuilt 1240x640 site
# viewports, captured once each at compose time), so the session can
# span the full 5-20s browser beat instead of the 6s capture ceiling
# that used to force one card per page.
BROWSER_BAR_H = 56          # 720-base; address bar + dots
BROWSER_THREAD_W = 520      # thread-size card width (stage is 640)

def _browser_shell(w, vp_h, address, k=1.0):
    """Rounded white shell with mac dots + address pill; returns
    (canvas, viewport_box). `k` scales every chrome dimension uniformly so
    a stage-size shell is geometrically SIMILAR to the thread-size one —
    the tap then reads as one card scaling, never a re-layout."""
    def S(v):
        return max(1, int(px(v) * k))
    bar = S(BROWSER_BAR_H)
    hgt = bar + vp_h
    im = Image.new("RGBA", (w, hgt), (255, 255, 255, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w, bar], fill=(243, 244, 245, 255))
    for i, col in enumerate(((255, 95, 87), (254, 188, 46), (40, 200, 64))):
        cx = S(22) + i * S(20)
        d.ellipse([cx, bar // 2 - S(5), cx + S(10), bar // 2 + S(5)],
                  fill=col)
    ax0 = S(88)
    d.rounded_rectangle([ax0, S(10), w - S(16), bar - S(10)],
                        radius=(bar - S(20)) // 2, fill=(255, 255, 255, 255))
    f = load_font(S(20))
    tb = d.textbbox((0, 0), address, font=f)
    d.text((ax0 + S(18), (bar - (tb[3] - tb[1])) // 2 - tb[1]), address,
           font=f, fill=(0, 7, 17, 150))
    return im, (0, bar, w, hgt)


def make_browser_frame(shots, clicks, address, w, vp_h, t_rel, dur, k=1.0):
    """The browser session at time t_rel within a beat of length dur.

    shots: list of PIL images already resized/cropped to (w, vp_h).
    clicks: per-transition (x_frac, y_frac) click points in viewport
    space; len == len(shots)-1 (padded/defaulted by the caller).
    Timeline: each shot owns dur/len(shots); within a segment the cursor
    tours to the click point (15-55%), the ring pulses (55-75%), and the
    page crossfades into the next (80-100%). The last segment holds with
    the cursor easing away. Returns the full card as RGBA (shell + page),
    NOT yet rounded/shadowed — the caller wraps it in the photo
    treatment so browser cards sit on footage like every other visual.
    """
    import math as _m
    def S(v):
        return max(1, int(px(v) * k))
    n = len(shots)
    seg = dur / n
    ki = min(n - 1, int(t_rel / seg))
    p = (t_rel - ki * seg) / seg  # progress within segment
    addr = address[min(ki, len(address) - 1)] \
        if isinstance(address, (list, tuple)) and address else address
    shell, (vx0, vy0, vx1, vy1) = _browser_shell(w, vp_h, addr or "", k=k)
    # Page swap reads as a LOAD, not a dissolve: a fast white flash with a
    # thin progress bar sweeping the top of the viewport, then the next
    # page is just there (a slow crossfade read as weird/slow — Lucas
    # 2026-09-02). The whole swap lives in ~14% of the segment.
    page = shots[ki]
    loadbar = None
    if ki < n - 1 and p > 0.66:
        if p < 0.72:
            flash = (p - 0.66) / 0.06
            white = Image.new("RGB", page.size, (255, 255, 255))
            page = Image.blend(shots[ki], white, min(1.0, flash))
        else:
            page = shots[ki + 1]
        if p < 0.86:
            loadbar = min(1.0, (p - 0.66) / 0.17)
    shell.paste(page, (vx0, vy0))
    d = ImageDraw.Draw(shell)
    if loadbar is not None:
        d.rectangle([vx0, vy0, vx0 + int((vx1 - vx0) * loadbar),
                     vy0 + S(5)], fill=(0, 100, 212, 255))
    # cursor path: from previous click point (or a rest spot) to this
    # segment's click point
    def pt(i):
        if 0 <= i < len(clicks):
            fx, fy = clicks[i]
        else:
            fx, fy = 0.7, 0.85
        return (vx0 + fx * (vx1 - vx0), vy0 + fy * (vy1 - vy0))
    if ki < n - 1:
        sx, sy = pt(ki - 1)
        ex, ey = pt(ki)
        tour = min(1.0, max(0.0, (p - 0.12) / 0.38))
        tour = 1 - pow(1 - tour, 3)
        cx, cy = sx + (ex - sx) * tour, sy + (ey - sy) * tour
        r = S(9)
        d.ellipse([cx - r, cy - r, cx + r, cy + r],
                  fill=(17, 17, 18, 230), outline=(255, 255, 255, 255),
                  width=S(3))
        if 0.52 <= p <= 0.68:
            rp = (p - 0.52) / 0.16
            rr = S(16) + S(22) * rp
            alpha = int(220 * (1 - rp))
            ring = Image.new("RGBA", shell.size, (0, 0, 0, 0))
            ImageDraw.Draw(ring).ellipse(
                [ex - rr, ey - rr, ex + rr, ey + rr],
                outline=(0, 100, 212, alpha), width=S(5))
            shell.alpha_composite(ring)
    else:
        # final page: cursor rests near the last click, fading out
        fade = max(0.0, 1.0 - p * 2.5)
        if fade > 0:
            sx, sy = pt(ki - 1)
            r = S(9)
            cur = Image.new("RGBA", shell.size, (0, 0, 0, 0))
            ImageDraw.Draw(cur).ellipse(
                [sx - r, sy - r, sx + r, sy + r],
                fill=(17, 17, 18, int(230 * fade)))
            shell.alpha_composite(cur)
    return shell


__all__ = ["make_reaction_badge", "make_photo", "make_typing_bubble",
           "make_browser_frame", "PHOTO_MAX_W", "PHOTO_MAX_H",
           "BROWSER_BAR_H", "BROWSER_THREAD_W"]
