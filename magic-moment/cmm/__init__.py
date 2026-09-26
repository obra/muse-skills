"""Magic Moment rendering primitives.

Three deterministic modules, kept here so the visual craft has exactly one
implementation instead of being re-typed into each thread:

- overlay.py  MessageOverlayRenderer  the message-thread stack: bubbles,
                                      bubbles, typing, reactions,
                                      photo/video messages, face-safe fade
- card.py     make_card/verify_card   proof-card shell + structural checks
- avatar.py   resolve_avatar          the real Muse avatar, head-cropped

All Pillow-only. This package is the source of truth for every visual
constant; reference/overlay-spec.md and reference/card-spec.md explain intent
and point back here rather than restating numbers.
"""

from .overlay import MessageOverlayRenderer
from .card import (
    ArtifactCardRenderer,
    CardVerificationError,
    make_card,
    verify_card,
    verify_proofs,
)
from .avatar import find_avatar_source, head_square, resolve_avatar
from .compose import compose, ComposeError, run_dir
from .script import validate_script, render_script, ScriptError
from .html_assets import render_html, strip_tags, HtmlRenderError

__all__ = [
    "MessageOverlayRenderer",
    "ArtifactCardRenderer",
    "CardVerificationError",
    "make_card",
    "verify_card",
    "verify_proofs",
    "resolve_avatar",
    "find_avatar_source",
    "head_square",
    "compose",
    "ComposeError",
    "run_dir",
    "validate_script",
    "render_script",
    "ScriptError",
    "render_html",
    "strip_tags",
    "HtmlRenderError",
]
