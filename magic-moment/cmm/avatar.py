"""Resolve the user's real avatar media for Magic Moment videos

The renderer used to draw a beige placeholder circle when no avatar file
was handed in, and that placeholder shipped in real videos. This module
finds the user's actual media for the animated identity header and for
avatar content (e.g. the image-picker options).

Search order, most specific first:

1. an explicit path the caller passed
2. the user's own generated avatar under ``~/workspace/avatars`` — this is the
   face they actually see in the product, regenerated as their avatar evolves
3. the product-default Muse character installed on the host
   (``~/assets/avatar/reference/hatch.jpg``, also at ``/opt/hatch/...``) —
   what a user who hasn't generated an avatar sees in the product

A source image is a chest-up portrait at 1080x1080, so scaling the whole frame
into a 28px circle leaves the face tiny inside a lot of body. ``head_square``
finds the subject and frames its head.
"""

import glob
import os
import re
import statistics

from PIL import Image, ImageChops, ImageDraw

# Home roots to search, in order. `~` is included but NOT relied on: this code
# also runs under contexts where HOME is not the runtime user's home (a chroot,
# a privsep worker, cron), and an unexpanded `~` silently degraded the whole
# resolver to the drawn placeholder. The literal path is the dependable one.
HOME_ROOTS = ["/home/hatch", os.path.expanduser("~")]

# Relative globs under each home root. Most recently modified match wins, which
# is how the user's current avatar beats older generated frames.
USER_AVATAR_RELATIVE_GLOBS = [
    "workspace/avatars/avatar-*.webp",
    "workspace/avatars/avatar-*.png",
    "workspace/avatars/.frames/static-*.webp",
    "workspace/avatars/.frames/static-*.png",
    "workspace/avatars/*.webp",
    "workspace/avatars/*.png",
    "workspace/profile-images/*.png",
    "workspace/profile-images/*.webp",
]

REFERENCE_AVATAR_RELATIVE = "assets/avatar/reference/hatch.jpg"
REFERENCE_AVATAR_ABSOLUTE = ["/opt/hatch/assets/avatar/reference/hatch.jpg"]

# Avatar STATUS videos: short seamless loops of the avatar doing something
# (the product generates a per-user set alongside each avatar; the image
# ships the default Muse character's set as the reference). Cards embed
# these as ./mm avatar flipbooks — the avatar working the moment.
# Only current generated states are advertised. Legacy spellings remain accepted
# below so existing callers can resolve an alias or an exact old user clip.
STATUS_STATES = ("idle", "working", "making_something", "milestone_level_up")
_OPTIONAL_STATUS_STATES = ("laughing",)
_LEGACY_STATUS_STATES = ("connecting", "milestone_achievement")
_STATUS_STATE_ALIASES = {
    "connecting": "idle",
}
_STATUS_REFERENCE_DIRS = [
    os.path.join(r, "assets", "avatar", "reference") for r in HOME_ROOTS
] + ["/opt/hatch/assets/avatar/reference"]


def find_status_video(state):
    """Newest per-user status video for `state`, else the product default.

    Per-user naming (status-video-specs.json): avatar-<ts>.mp4 for idle,
    avatar-<ts>-<state>.mp4 otherwise. Returns (path, origin) with origin
    user/reference, or (None, None) when the state has no video anywhere.
    """
    accepted = STATUS_STATES + _OPTIONAL_STATUS_STATES + _LEGACY_STATUS_STATES
    if state not in accepted:
        raise ValueError(f"unknown avatar state {state!r}; one of "
                         + ", ".join(accepted))
    state = _STATUS_STATE_ALIASES.get(state, state)
    pattern = ("avatar-*[0-9].mp4" if state == "idle"
               else f"avatar-*-{state}.mp4")
    hits = []
    for root in HOME_ROOTS:
        hits.extend(glob.glob(os.path.join(root, "workspace", "avatars",
                                           pattern)))
    # The dark-mode variant family lands in the same folder and would win
    # on mtime after a dark-mode backfill; its black background reads as a
    # black badge on a white card, so it never qualifies here.
    hits = [p for p in _dedup(hits)
            if os.path.isfile(p) and "darkmode" not in os.path.basename(p)]
    if hits:
        return max(hits, key=os.path.getmtime), "user"
    if state in ("laughing", "milestone_achievement"):
        return None, None
    ref = "hatch.mp4" if state == "idle" else f"hatch_{state}.mp4"
    for d in _STATUS_REFERENCE_DIRS:
        p = os.path.join(d, ref)
        if os.path.isfile(p):
            return p, "reference"
    return None, None


def _dedup(paths):
    seen, out = set(), []
    for p in paths:
        rp = os.path.normpath(p)
        if rp not in seen:
            seen.add(rp)
            out.append(rp)
    return out


def user_avatar_globs():
    return _dedup(
        os.path.join(root, rel)
        for root in HOME_ROOTS
        for rel in USER_AVATAR_RELATIVE_GLOBS
    )


def reference_avatars():
    return _dedup(
        [os.path.join(root, REFERENCE_AVATAR_RELATIVE) for root in HOME_ROOTS]
        + REFERENCE_AVATAR_ABSOLUTE
    )


def _user_avatar_rank(path):
    """Lower rank = better. The avatars dir holds THREE kinds of file and
    newest-mtime alone picks the wrong one (it once chose an unchosen
    `avatar-options-*` costume candidate over the user's actual avatar):

      0. `avatar-<stem>.webp`  — the canonical current portrait
         (matches runtime.avatar_state.image_path / active_stem)
      1. `static-*-idle.*`     — the idle state frame, the canonical look
      2. other `static-*`      — status frames, including legacy variants
      3. everything else EXCEPT `avatar-options-*`, which are generation
         candidates the user did NOT pick — never use them.
    """
    name = os.path.basename(path)
    if name.startswith("avatar-options-"):
        return None  # excluded
    if re.match(r"avatar-\d+[-\d]*\.(webp|png)$", name):
        return 0
    if name.startswith("static-") and "-idle" in name:
        return 1
    if name.startswith("static-"):
        return 2
    return 3


def find_avatar_source(explicit_path=None):
    """Return (path, origin) for the best available avatar, or (None, "drawn")."""
    if explicit_path and os.path.exists(explicit_path):
        return explicit_path, "explicit"

    best = None  # (rank, -mtime, path)
    for pattern in user_avatar_globs():
        for candidate in glob.glob(pattern):
            rank = _user_avatar_rank(candidate)
            if rank is None:
                continue
            try:
                mtime = os.path.getmtime(candidate)
            except OSError:
                continue
            key = (rank, -mtime, candidate)
            if best is None or key < best:
                best = key
    if best:
        return best[2], "user"

    for path in reference_avatars():
        if os.path.exists(path):
            return path, "reference"

    # No bundled fallback ON PURPOSE. Every avatar is per-user and must be
    # read from THIS VM at compose time (tier 2 = the user's generated
    # avatar; tier 3 = the image-installed product default for users who
    # haven't generated one). A generic face shipped inside the skill would
    # silently put the WRONG identity in a user's video on a misconfigured
    # host — a failed render is strictly better than a wrong face. On a dev
    # machine with no Muse install, pass avatar_path explicitly.
    return None, "drawn"


def _background_mask(im, tol=30):
    """Mask of non-background pixels.

    Background is the median of a strip along the TOP edge. Corners are wrong
    twice over: the bottom two are body on a chest-up portrait, and the top two
    can sit in a vignette that reads several levels darker than the true plate.
    """
    rgb = im.convert("RGB")
    w, h = rgb.size
    strip = [
        rgb.getpixel((x, y))
        for y in range(1, max(2, h // 100) + 1)
        for x in range(0, w, max(1, w // 64))
    ]
    bg = tuple(int(statistics.median(p[i] for p in strip)) for i in range(3))
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg))
    return diff.convert("L").point(lambda p: 255 if p > tol else 0)


def head_square(im, band=0.45, pad=0.06):
    """Square crop framing the head of a chest-up portrait.

    The full-subject bbox gives the top of the head, but its WIDTH is measured
    only across the top `band` of that bbox. Measuring the whole subject lets
    widening shoulders inflate the square, which pushes the face down to a few
    unreadable pixels once it lands in a 28px circle.
    """
    mask = _background_mask(im)
    bbox = mask.getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    band_h = max(1, int((y1 - y0) * band))
    head_bbox = mask.crop((0, y0, im.width, min(y1, y0 + band_h))).getbbox()
    hx0, hx1 = (head_bbox[0], head_bbox[2]) if head_bbox else (x0, x1)

    side = int((hx1 - hx0) * (1 + pad * 2))
    if side <= 0:
        return im
    cx = (hx0 + hx1) // 2
    sx0 = max(0, min(cx - side // 2, im.width - side))
    sy0 = max(0, min(int(y0 - side * pad), im.height - side))
    side = min(side, im.width - sx0, im.height - sy0)
    return im.crop((sx0, sy0, sx0 + side, sy0 + side))


def _drawn_placeholder(size):
    av = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(av)
    s = size / 28.0
    d.ellipse([0, 0, size - 1, size - 1], fill="#E8D5B5", outline="#D8C4A0", width=1)
    d.ellipse([7 * s, 9 * s, 12 * s, 14 * s], fill="#2B2B2B")
    d.ellipse([16 * s, 9 * s, 21 * s, 14 * s], fill="#2B2B2B")
    return av


def resolve_avatar(size=28, explicit_path=None, crop_head=True):
    """Circular avatar at `size`px. Returns (RGBA image, origin).

    `origin` is one of explicit / user / reference / drawn. Anything other than
    "drawn" means a real image was found; callers should surface "drawn" rather
    than shipping the placeholder silently.
    """
    path, origin = find_avatar_source(explicit_path)
    if path is None:
        return _drawn_placeholder(size), origin

    try:
        src = Image.open(path)
        src.load()
    except Exception:
        return _drawn_placeholder(size), "drawn"

    if crop_head:
        try:
            src = head_square(src)
        except Exception:
            pass  # an un-croppable source still beats the placeholder

    # head_square returns a square; this guards the paths that don't (bbox
    # failure above, crop_head=False) so a portrait source is center-cropped
    # instead of squashed by the square resize below.
    if src.width != src.height:
        side = min(src.width, src.height)
        left = (src.width - side) // 2
        top = (src.height - side) // 2
        src = src.crop((left, top, left + side, top + side))

    av = src.convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    # Intersect with any alpha the source already had, so a cut-out PNG does
    # not get its transparent corners painted back in.
    existing = av.split()[-1]
    av.putalpha(ImageChops.darker(existing, mask))
    return av, origin


def agent_name(default="Muse"):
    """The agent's real name from ~/IDENTITY.md (e.g. `- **Name:** Coop`).

    Use the product agent's per-user name in the video, with Muse as the default.
    """
    for root in HOME_ROOTS:
        path = os.path.join(root, "IDENTITY.md")
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        m = re.search(r"\*\*Name:?\*\*[:\s]*([^\n*]+)", text)
        if not m:
            m = re.search(r"^[-*\s]*Name[:\s]+([^\n]+)", text, re.M)
        if m:
            name = m.group(1).strip().strip("*_`")
            if name:
                return name
    return default


__all__ = ["resolve_avatar", "find_avatar_source", "head_square", "agent_name"]
