#!/usr/bin/env bash
# Verify the magic-moment render stack on this VM (or any Linux box).
#
# The skill tar ships CODE + fonts (~11MB; no avatar — that is per-user and
# is read off the VM at compose time). Everything else the renders need
# already ships with the VM, so this script installs and downloads NOTHING:
# python imaging is the cell image's own PIL, video work is the cell's own
# ffmpeg/ffprobe, and capture.mjs runs on the cell's node against the
# bundle's own playwright-core (the spaces ts-runtime ships it at
# /opt/hatch/skills/spaces/ts-runtime/dist/node_modules as bundle contract) and the
# image-baked /opt/meta-chromium/chrome. Transcription goes through the
# daemon and inference-proxy to the host ASR service. What remains here is
# verification, a smoke render, and reclaiming the pip-era vendor layer
# that older installs left on the home volume.
#
# Run as: bash install.sh           verify + reclaim + smoke render, run by
#                                   the AGENT itself, as the same identity
#                                   that renders. No sudo, no root.
#                                   Seconds, idempotent.
#         bash install.sh --check   sub-second usability probe: checks the
#                                   shipped stack; exit 0 = ready, exit 1 =
#                                   run this script for the full diagnosis.
#                                   Per-request preflight; never mutates.
set -euo pipefail
cd "$(dirname "$0")"
SKILL_DIR="$(pwd)"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1
IN_CELL=0
[ "$(systemd-detect-virt --container 2>/dev/null)" = "systemd-nspawn" ] && IN_CELL=1

# No root outside the cell. In-cell "root" IS the runtime identity (the
# cell's uid 0 maps to the runtime uid on the host), so that is fine; host
# root is a different user, and a sudo run scatters root-owned files through
# trees the runtime must own.
if [ "$(id -u)" = "0" ] && [ "$IN_CELL" = "0" ]; then
  echo "Run this WITHOUT sudo, as the user who will run the renders." >&2
  echo "    bash $SKILL_DIR/install.sh" >&2
  exit 1
fi

# Where the RETIRED pip-era vendor layer lived (same derivation the old
# builds used): next to the skill, except for bundled installs, where it
# redirected to the persistent workspace. Only used for reclaim.
OLD_VENDOR="$SKILL_DIR/vendor"
case "$SKILL_DIR" in
  /opt/hatch/skills/*)
    OLD_VENDOR="${HOME:?HOME must be set}/workspace/.magic-moment/vendor"
    ;;
  /home/*/skills/*)
    MAYBE_HOME="${SKILL_DIR%%/skills/*}"
    if [ "$MAYBE_HOME/skills/$(basename "$SKILL_DIR")" = "$SKILL_DIR" ] \
       && [ "$(dirname "$MAYBE_HOME")" = "/home" ]; then
      OLD_VENDOR="$MAYBE_HOME/workspace/.magic-moment/vendor"
    fi
    ;;
esac
echo "skill: $SKILL_DIR"

# Probes, no writes. Each leg has a dev-machine override (MM_NODE /
# MM_PLAYWRIGHT_MODULES / JARVIS_CHROMIUM_BINARY / MM_FFMPEG) honored by
# the toolkit.
PW_BUNDLE="/opt/hatch/skills/spaces/ts-runtime/dist/node_modules"
ffmpeg_ok() {
  command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1
}
render_python_ok() {  # the cell image's own python ships PIL
  python3 -c "import PIL.Image, PIL.ImageDraw, PIL.ImageFont" 2>/dev/null
}
capture_stack_present() {
  { command -v node >/dev/null 2>&1 || [ -x "${MM_NODE:-/nonexistent}" ]; } \
    && { [ -d "$PW_BUNDLE/playwright-core" ] || [ -d "$PW_BUNDLE/playwright" ] \
         || [ -d "${MM_PLAYWRIGHT_MODULES:-/nonexistent}" ]; } \
    && { [ -f /opt/meta-chromium/chrome ] \
         || [ -f "${JARVIS_CHROMIUM_BINARY:-/nonexistent}" ]; }
}
capture_stack_report() {
  command -v node >/dev/null 2>&1 || [ -x "${MM_NODE:-/nonexistent}" ] \
    || echo "  - node missing (the runtime cell ships /usr/bin/node)" >&2
  [ -d "$PW_BUNDLE/playwright-core" ] || [ -d "$PW_BUNDLE/playwright" ] \
    || [ -d "${MM_PLAYWRIGHT_MODULES:-/nonexistent}" ] \
    || echo "  - bundled playwright missing at $PW_BUNDLE (bundle contract)" >&2
  [ -f /opt/meta-chromium/chrome ] \
    || [ -f "${JARVIS_CHROMIUM_BINARY:-/nonexistent}" ] \
    || echo "  - image-baked browser missing at /opt/meta-chromium/chrome" >&2
}
# Transcription uses the daemon's in-cell socket, never model files/Python deps.
# This checks transport presence only; mm transcribe reports service failures.
asr_service_present() {
  [ -S "${JARVIS_SANDBOX_API_SOCK:-/run/hatch/sandbox-api/api.sock}" ]
}

diagnose_state() {
  if ! ffmpeg_ok; then
    echo "ffmpeg/ffprobe missing from PATH — the runtime cell ships both" >&2
    echo "at /usr/bin; run this from inside the cell." >&2
  fi
  if ! render_python_ok; then
    echo "this python does not import PIL — run from inside the runtime" >&2
    echo "cell, whose image ships it (python3-pil)." >&2
  fi
  if ! capture_stack_present; then
    echo "capture stack incomplete (ships with the VM, nothing to install):" >&2
    capture_stack_report
  fi
}

if [ "$CHECK_ONLY" = 1 ]; then
  if ffmpeg_ok && render_python_ok && capture_stack_present; then
    echo "render stack complete — ready to render"
    exit 0
  fi
  diagnose_state
  echo "Diagnose it by running (from right here is fine, seconds):" >&2
  echo "    bash $SKILL_DIR/install.sh" >&2
  echo "Do NOT install pieces by hand." >&2
  exit 1
fi

echo "== 1/2 render stack (ships with the VM — verify only) =="
if ffmpeg_ok && render_python_ok && capture_stack_present; then
  echo "   cell PIL + ffmpeg + node + bundled playwright + baked browser: present"
else
  diagnose_state
  echo "This VM image does not ship the full render stack, so rendering" >&2
  echo "is not possible here. Report that to the user as 'magic-moment" >&2
  echo "setup is not possible on this VM' — do not improvise by" >&2
  echo "installing browsers or packages by hand." >&2
  exit 1
fi

echo "== 2/2 reclaim the pip-era vendor layer =="
# Older installs built a per-VM vendor dir (WeasyPrint and its dep tree,
# then pip playwright + a downloaded browser shell + a static ffmpeg, up to
# ~500MB). Everything now ships with the VM, so the whole layer is dead
# weight; remove it wherever a previous build put it.
for v in "$OLD_VENDOR" "$SKILL_DIR/vendor"; do
  if [ -d "$v" ]; then
    echo "   removing $v ($(du -sh "$v" 2>/dev/null | cut -f1))"
    rm -rf "$v"
  fi
done
rmdir "$(dirname "$OLD_VENDOR")" 2>/dev/null || true

echo "== smoke =="
python3 - <<PY
import re
import subprocess
import sys
sys.path.insert(0, "$SKILL_DIR")
from cmm.overlay import MessageOverlayRenderer
from cmm.html_assets import render_html
from cmm.html_assets import _Capture
from cmm.compose import FFMPEG
print("capture browser:", _Capture._chromium_binary() or "playwright store")
subprocess.run([FFMPEG, "-version"], stdout=subprocess.DEVNULL, check=True)
print("ffmpeg:", FFMPEG)
r = MessageOverlayRenderer(W=720, H=1280)
# Render the SHIPPED example card, not an ad-hoc div: three docs tell
# builders to copy ./mm example, so the smoke proves the exemplar itself
# clears every render gate (this caught a cap change that silently put
# the example 116px over the height limit).
src = open("$SKILL_DIR/mm").read()
ns = {}
exec(compile(re.search(r"EXAMPLE = \\{.*?\\n\\}", src, re.S).group(0),
             "mm-example", "exec"), ns)
html = next(b["html"] for b in ns["EXAMPLE"]["beats"] if b.get("html"))
im = render_html(html)
print("example card:", im.size)
# And the exemplar SCREENPLAY clears every validator gate (the rhythm
# gates once rejected the shipped example — an exemplar that fails
# validation burns a build iteration for every agent that copies it).
import copy, tempfile, os as _os
from cmm.script import validate_script
ex = copy.deepcopy(ns["EXAMPLE"])
_tmp = tempfile.mkdtemp()
def _stub(p):
    q = _os.path.join(_tmp, _os.path.basename(p))
    open(q, "wb").write(b"x")
    return q
ex["video"] = _stub(ex["video"])
for b in ex["beats"]:
    if "image" in b:
        b["image"] = _stub(b["image"])
    if b["type"] == "video":
        b["video"] = _stub(b["video"])
_vo = ("I needed a return flight to San Francisco on Tuesday and Muse "
       "found the 7:40am DL 1487 for $123.45, booked with confirmation "
       "QXK4TP.")
validate_script(ex, _vo, None, ex["duration"])
print("example screenplay: validates | ALL GOOD")
PY
if asr_service_present; then
  echo "daemon ASR socket: present (service readiness checked by ./mm transcribe)"
else
  echo "WARNING: daemon ASR socket is unavailable; ./mm transcribe needs" >&2
  echo "the running daemon, inference-proxy, and host local-models service." >&2
  echo "Run inside the runtime cell and check the VM services." >&2
fi
echo "verification complete — nothing installed, nothing to install"
