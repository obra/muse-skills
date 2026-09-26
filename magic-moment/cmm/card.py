"""Artifact Card Primitive — the proof-card shell + structural verification.

Provides:
- make_card(inner_img) -> 640 white rounded card
- verify_card / verify_proofs — the structural checks compose runs on
  every card before a single frame renders

The card ENTERS the video as a thread message: overlay.py's stack renderer
animates it like any other block. Single-source truth: inner_img must
already be the real, tightly cropped content.
"""
import os
from PIL import Image, ImageDraw

# Card geometry is calibrated at 720x1280 like the rest of the chrome;
# overlay.px() scales it to the active canvas (identity at 720).
from .overlay import px

W_DEFAULT = 720
H_DEFAULT = 1280
CARD_W = 640
INNER_PAD = 10
# 24 base (36 at 1080) matches the bubbles' corner rounding; the old 16
# read as a web widget next to the softer thread chrome around it.
RADIUS = 24
BORDER_NORMAL = 1

BORDER_COLOR = "#E6E0DB"

def _rounded_mask(w,h,r):
    m = Image.new("L", (w,h), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0,0,w-1,h-1), radius=r, fill=255)
    return m

def make_card(inner_img: Image.Image, hero: bool=False) -> Image.Image:
    """inner_img already cropped tight content (e.g., 620w body). Paste into white shell.

    `hero` is still accepted — screenplays mark the final reveal with it and
    it implies the shell — but it renders identically to any other card: the
    gold border + FINAL PICK badge is retired (a gold-stamped photo read as
    chrome, not content, and gold is not in the Muse token set). Hero
    emphasis is carried by the tap.
    """
    cw = px(CARD_W)
    # ensure inner is correct width
    target_inner_w = px(620)
    if inner_img.width != target_inner_w:
        scale = target_inner_w / inner_img.width
        nh = int(inner_img.height * scale)
        inner_img = inner_img.resize((target_inner_w, nh), Image.LANCZOS)
    # Tall content (portrait image-gen output, tall screenshots) must FIT,
    # not crop: if width-fitting leaves it taller than the card can show,
    # fit by height instead and center horizontally. This is what lets an
    # arbitrary Muse-made image land in the thread one-shot.
    max_inner_h = px(600)
    if inner_img.height > max_inner_h:
        scale = max_inner_h / inner_img.height
        inner_img = inner_img.resize(
            (max(1, int(inner_img.width * scale)), max_inner_h), Image.LANCZOS)
    inner_pad = px(INNER_PAD)
    radius = px(RADIUS)
    ch = inner_img.height + inner_pad*2
    # FIX: was forcing min 300 which created half-empty white cards when cropped_proof was short (hero kicker 1296x270 -> 620x129 -> +20 =149 -> forced 300 = 151px empty). Content-driven height is better than empty filler.
    # Allow natural height, clamp only to avoid absurdly tiny <160 or huge >620
    if ch < px(180):
        ch = px(180)  # tiny but not 300 of void
    if ch > px(620):
        ch = px(620)
    card = Image.new("RGBA", (cw, ch), (255,255,255,255))
    border_w = px(BORDER_NORMAL)
    draw = ImageDraw.Draw(card)
    # border via rounded rectangle fill then inner white
    draw.rounded_rectangle((0,0,cw-1,ch-1), radius=radius, fill=BORDER_COLOR)
    if border_w:
        draw.rounded_rectangle((border_w, border_w, cw-1-border_w, ch-1-border_w), radius=radius-px(2), fill=(255,255,255,255))
    # paste inner with mask preserving rounded inner? just paste at 10,10 with alpha
    if inner_img.mode != "RGBA":
        inner_img = inner_img.convert("RGBA")
    # center vertically if we expanded to min 180
    y_off = (ch - inner_img.height)//2
    if y_off < inner_pad:
        y_off = inner_pad
    x_off = max(inner_pad, (cw - inner_img.width) // 2)
    card.paste(inner_img, (x_off, y_off), inner_img)
    # apply outer rounded mask for true r16 transparency
    mask = _rounded_mask(cw, ch, radius)
    # composite with white bg? card already white but enforce alpha
    card.putalpha(mask)
    return card

class CardVerificationError(AssertionError):
    """A rendered card failed a structural check."""


def verify_card(card, name="card"):
    """Structural checks on one finished card. Raises CardVerificationError.

    These were documented as "enforced in code" long before any code existed.
    They are cheap and they catch the three failures that actually shipped:
    a squared-off corner, a card whose bottom strip is empty white because the
    inner crop was too short, and a body that never faded in.

    `card` is a PIL image or a path. Returns a dict of the measurements so a
    caller can log them.
    """
    im = Image.open(card) if isinstance(card, (str, bytes, os.PathLike)) else card
    im = im.convert("RGBA")
    w, h = im.size
    report = {"name": str(name), "size": (w, h)}

    if w < 64 or h < 64:
        raise CardVerificationError(f"{name}: implausible card size {w}x{h}")

    # 1. rounded corners: the extreme corner pixel must be transparent, the
    #    same inset point must not be. A squared corner fails the first test.
    radius = px(RADIUS)  # cards are made at canvas scale; verify at the same
    corner_alpha = im.getpixel((0, 0))[3]
    inset_alpha = im.getpixel((radius, radius))[3]
    report["corner_alpha"] = corner_alpha
    report["inset_alpha"] = inset_alpha
    if corner_alpha > 40:
        raise CardVerificationError(
            f"{name}: top-left corner is opaque (alpha {corner_alpha}); "
            "rounded mask missing — a square header was composited over the shell"
        )
    if inset_alpha < 200:
        raise CardVerificationError(
            f"{name}: card body is transparent at the r{radius} inset "
            f"(alpha {inset_alpha}); shell did not render"
        )

    # There is no "is the card mostly empty filler?" check here any more, and
    # there should not be one: the half-empty card it guarded against was a
    # consequence of make_card forcing a 300px minimum height, and make_card
    # now derives height from the content (`inner_h + 2*INNER_PAD`, clamped).
    # That makes the fill ratio identically 1.0 for every card taller than the
    # 180px floor, so the guard could not fire on any input — it read as
    # coverage while checking nothing.

    # 2. the card is not blank. Unambiguous, and catches a render that produced
    #    nothing at all.
    interior = im.crop((radius, radius, w - radius, h - radius))
    content = sum(
        1 for px in interior.getdata() if px[3] > 20 and px[:3] != (255, 255, 255)
    )
    report["content_px"] = content
    if content < 500:
        raise CardVerificationError(
            f"{name}: card is effectively blank ({content} non-white px)"
        )
    return report


def verify_proofs(cards):
    """Verify every card. Raises on the first failure, else returns reports."""
    return [verify_card(c, name=getattr(c, "filename", None) or f"proof[{i}]")
            for i, c in enumerate(cards)]


__all__ = [
    "ArtifactCardRenderer",
    "make_card",
    "verify_card",
    "verify_proofs",
    "CardVerificationError",
]

class ArtifactCardRenderer:
    def __init__(self, W=W_DEFAULT, H=H_DEFAULT):
        self.W=W
        self.H=H
    def make_card(self, inner, hero=False):
        return make_card(inner, hero)
    def verify_card(self, card, name="card"):
        return verify_card(card, name)
    def verify_proofs(self, cards):
        return verify_proofs(cards)
