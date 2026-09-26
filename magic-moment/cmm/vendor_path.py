"""Legacy vendor-dir resolution, kept only for pre-shipped-stack installs.

The render stack ships with the VM (cell PIL, cell ffmpeg/ffprobe, node +
the bundle's playwright-core, the baked browser), so current installs have
NO vendor dir at all — install.sh reclaims the old one. These helpers keep
the toolkit working on a VM whose old vendor still exists, and resolve
tools to PATH everywhere else.

Two legal legacy homes, first match wins:
1. `<skill>/vendor` — workspace-skill installs, dev checkouts.
2. `~/workspace/.magic-moment/vendor` — older bundled installs redirected
   their derived layer here so it survived product-skill updates.
"""

import os

_SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# dict.fromkeys: ~ can expand to /home/hatch, collapsing candidates 2 and 3
_CANDIDATES = list(dict.fromkeys([
    os.path.join(_SKILL_ROOT, "vendor"),
    os.path.join(os.path.expanduser("~"), "workspace", ".magic-moment", "vendor"),
    "/home/hatch/workspace/.magic-moment/vendor",
]))


def vendor_dir():
    """First existing candidate, else the first (for error messages)."""
    for c in _CANDIDATES:
        if os.path.isdir(c):
            return c
    return _CANDIDATES[0]


def vendor_dirs():
    return list(_CANDIDATES)


def vendor_bin(name):
    """Resolve a tool: env override (MM_FFMPEG etc.), then a legacy vendor
    copy, then PATH — where the VM's own /usr/bin build lives."""
    override = os.environ.get(f"MM_{name.upper()}")
    if override and os.path.isfile(override):
        return override
    for c in _CANDIDATES:
        p = os.path.join(c, "bin", name)
        if os.path.exists(p):
            return p
    return name  # PATH: the cell image ships ffmpeg/ffprobe at /usr/bin


__all__ = ["vendor_dir", "vendor_dirs", "vendor_bin"]
