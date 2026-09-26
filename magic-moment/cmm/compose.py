"""Compose a Magic Moment video: creator clip + the message-thread overlay.

This is the assembly step that used to be re-written from prose in every
thread: extract frames, build the thread stack, composite, mix the message
sounds, arm the Muse finisher, encode, verify. The bubbles and cards were
locked in overlay.py / card.py long ago; this locks the thing that
assembles them.

The stage is a MESSAGE THREAD on a DEPTH STAGE (v21): every block —
bubble, typing, receipt card, photo, video — pops in at the bottom and
slides the stack up; older messages recede into the scene (smaller, more
transparent, drifting to center) and finally dissolve under the pinned
identity header. There is no exclusivity; the screenplay validator caps
concurrent live beats instead.

Rules enforced here, not merely documented:
- Fail-closed proofs: every proof card is verified (verify_card) before the
  frame loop starts.
- Single writer: an exclusive flock on `<output root>/.compose.lock` is held
  for the duration (kernel-released, so a killed render leaves nothing stale).
- Output verification: clean decode, exact geometry, and the VIDEO stream's
  duration must equal the footage length plus the finisher's extension
  tail (the full-screen close lasts through the lockup and avatar
  reaction; nothing is concat-appended).
"""

import datetime
import fcntl
import math
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

from .card import ArtifactCardRenderer, CardVerificationError, verify_card
from .overlay import DEPTH_SECS, MessageOverlayRenderer, load_font, px

# Media binaries: the cell image ships ffmpeg/ffprobe at /usr/bin (6.1+,
# with zscale/libx264/aac), so PATH resolution is the production path and
# nothing is vendored. vendor_bin still honors an MM_FFMPEG/MM_FFPROBE
# override (dev machines) and a legacy vendor/bin copy if a pre-shipped-
# stack install left one; install.sh verifies presence and reclaims the
# legacy layer.
from .vendor_path import vendor_bin as _tool

FFMPEG = _tool("ffmpeg")
FFPROBE = _tool("ffprobe")


class ComposeError(RuntimeError):
    """Pipeline-level failure: bad blocks, missing proof, encode failure."""


def output_root():
    """Directory holding every run dir, and the single-writer lock.

    `~/workspace/.output` on a Muse VM (hidden from workspace listings),
    `./.output` elsewhere.
    """
    ws = os.path.expanduser("~/workspace")
    return os.path.join(ws, ".output") if os.path.isdir(ws) else ".output"


def run_dir(name):
    """Create and return the working directory for one magic-moment run.

    Every file a run generates — transcript json, the run script, normalized
    video, rendered assets, the final mp4 — lives under ONE directory:
    `<output root>/<name>/`. The only step that writes outside it is the
    final copy of the finished video into `~/workspace/your_files/`. Never
    scatter run files across /tmp or the workspace root.
    """
    path = os.path.join(output_root(), name)
    os.makedirs(path, exist_ok=True)
    return path


def lock_path():
    """Path of the single-writer lock, inside the caller's own output root.

    Deliberately NOT a fixed /tmp name. /tmp is shared and world-writable, so
    a fixed name there is owned by whoever touches it first: one render run
    as the wrong user (root, most easily) leaves a lock file every later
    render dies on at open() with a bare EACCES that names a path nothing
    documents. The output root is per-user and already the home for
    everything else a run writes.
    """
    root = output_root()
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, ".compose.lock")


def _run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ComposeError(f"{cmd[0]} failed: {proc.stderr.strip()[-400:]}")
    return proc


def _ffmpeg(*args):
    return _run([FFMPEG, "-y", "-v", "error", *args])


def _validate_blocks(blocks):
    proofs = [b for b in blocks if b["type"] == "proof"]
    bubbles = [b for b in blocks if b["type"] == "bubble"]
    typings = [b for b in blocks if b["type"] == "typing"]
    reactions = [b for b in blocks if b["type"] == "reaction"]
    photos = [b for b in blocks if b["type"] == "photo"]
    videos = [b for b in blocks if b["type"] == "video"]
    browsers = [b for b in blocks if b["type"] == "browser"]
    known = (len(proofs) + len(bubbles) + len(typings)
             + len(reactions) + len(photos) + len(videos)
             + len(browsers))
    if known != len(blocks):
        raise ComposeError(
            "every block must be bubble / proof / photo / video / "
            "browser / typing / reaction")
    for v in videos:
        if not os.path.exists(v.get("video", "")):
            raise ComposeError(f"video block file missing: {v.get('video')}")
    for br in browsers:
        pages = br.get("pages_img") or []
        if len(pages) < 2:
            raise ComposeError(
                "browser block needs at least 2 rendered pages")
        if len(br.get("clicks") or []) != len(pages) - 1:
            raise ComposeError(
                "browser block needs one click point per page transition")
    for b in blocks:
        if b["type"] == "reaction":
            if not b.get("emoji"):
                raise ComposeError("reaction block needs an 'emoji'")
            continue
        if not (b["start"] < b["end"]):
            raise ComposeError(f"block has start >= end: {b.get('text', b['type'])}")
    # A reaction attaches to the bubble whose start equals its 'target'.
    starts = {round(b["start"], 3) for b in bubbles}
    for r in reactions:
        if round(r.get("target", -1), 3) not in starts:
            raise ComposeError(
                f"reaction @{r.get('start')} targets {r.get('target')}, which "
                "matches no bubble start")
        if r["start"] < r["target"] + 0.4:
            raise ComposeError("a reaction lands >=0.4s after its bubble")
    # v20.3+: everything is a thread message. No exclusivity; the screenplay
    # validator caps concurrent LIVE beats instead.
    return bubbles, proofs, typings, reactions, photos, videos, browsers


def _source_color(creator_video):
    """(is_hdr, matrix) for the creator video's first video stream."""
    import json as _json
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries",
         "stream=color_space,color_transfer,color_primaries",
         "-of", "json", creator_video],
        capture_output=True, text=True)
    try:
        st = _json.loads(out.stdout)["streams"][0]
    except Exception:  # noqa: BLE001 - untagged stream; assume SDR 709
        return False, "bt709"
    transfer = st.get("color_transfer") or ""
    primaries = st.get("color_primaries") or ""
    hdr = transfer in ("arib-std-b67", "smpte2084") or "2020" in primaries
    return hdr, st.get("color_space") or "bt709"


# The close follows the complete source narration. Its silent extension
# covers the full lockup and one avatar reaction, including the entry fade.
# A missing lockup fails the render rather than shipping an unbranded video.
_LOCKUP_VIDEO = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "assets", "brand", "muse-lockup-1x1.mp4")


def compose(
    creator_video,
    blocks,
    out_dir="/tmp",
    # Delivery resolution by default: the chrome scales itself (overlay.px),
    # so there is no reason to author at 720 and lossily upscale afterwards.
    W=1080,
    H=1920,
    FPS=30,
    avatar_path=None,
    keep_workdir=False,
    admitted=False,
):
    """Render the full video. Returns a report dict; raises on any failure."""
    if not os.path.exists(creator_video):
        raise ComposeError(f"creator video not found: {creator_video}")
    (bubbles, proofs, typings, reactions, photos,
     videos, browsers) = _validate_blocks(blocks)

    # Single-writer lock, held as an ADVISORY FLOCK rather than as the mere
    # existence of the file. Existence is the wrong signal: a render that is
    # OOM-killed (this is a one-core VM encoding 900+ frames) or interrupted
    # never reaches the unlink, and the leftover file then bricks every future
    # render with "another compose is running" until a human deletes a path
    # nothing tells them about. The kernel drops a flock when the holding
    # process dies, so a stale lock cannot exist; the file itself is a
    # permanent zero-byte rendezvous point and is deliberately never removed
    # (unlinking races a second process onto a fresh inode and a second lock).
    lock_fd = os.open(lock_path(), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if not admitted:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        # Renders are serialized on this one-core box. Waiting here beats
        # erroring: concurrent builders were burning a whole re-render
        # cycle per collision (44 hits in one campaign). The blocking
        # flock is kernel-released if the holder dies, so this cannot
        # wedge; progress is printed so the agent knows why it is quiet.
        print("another compose is running (this box renders one at a "
              "time) — waiting for it to finish…", flush=True)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        print("previous compose finished — starting this render", flush=True)
    dec = enc = None
    workdir = tempfile.mkdtemp(prefix="mm-compose-")
    try:
        msg = MessageOverlayRenderer(W=W, H=H, avatar_path=avatar_path)
        cardr = ArtifactCardRenderer(W=W, H=H)

        # Card every proof and verify before rendering a single frame.
        proof_reports = []
        for p in proofs:
            img = p["img"]
            if isinstance(img, (str, os.PathLike)):
                img = Image.open(img)
            p["_card"] = cardr.make_card(img.convert("RGBA"), hero=p.get("hero", False))
            proof_reports.append(verify_card(p["_card"], name=f"proof@{p['start']}"))

        # EVERYTHING pops into the message thread: bubbles, (spinner
        # animated per frame), and receipt cards alike. Nothing takes over
        # the stage; older messages ride up into the fade band and vanish
        # there. Blocks never leave the stack — invisible ones above the
        # band cost nothing to skip and keep the geometry stable (no
        # downward jumps from truncation).
        # Photos: rounded + drop shadow, no shell. Videos: frames extracted
        # once here, then played inside the same treatment per output frame.
        from .templates import make_photo, PHOTO_MAX_W, PHOTO_MAX_H
        # Enlarged canvases render at stage size so every intermediate
        # frame is a downscale (crisp); the overlay owns the motion.
        from .templates import TAP_STAGE_W, TAP_STAGE_H
        photo_blocks = []
        for ph in photos:
            img = ph["img"]
            if isinstance(img, (str, os.PathLike)):
                img = Image.open(img)
            canvas = make_photo(img)
            block = dict(type="photo", img=canvas,
                         bw=canvas.width, bh=canvas.height,
                         start=ph["start"], end=ph["end"])
            if ph.get("frames_raw"):
                # Component-owned animation: photo-treat every captured
                # frame once; overlay indexes them per output frame.
                block["anim_frames"] = [make_photo(f)
                                        for f in ph["frames_raw"]]
                block["loop"] = ph["loop"]
                block["cap_fps"] = ph.get("cap_fps", 24)
                block["anim_once"] = ph.get("anim_once", False)
                block["anim_finite"] = ph.get("anim_finite", False)
            if ph.get("tap"):
                block["tap"] = True
                block["tap_img"] = make_photo(img, TAP_STAGE_W, TAP_STAGE_H)
                if ph.get("frames_raw"):
                    block["tap_frames"] = [
                        make_photo(f, TAP_STAGE_W, TAP_STAGE_H)
                        for f in ph["frames_raw"]]
            photo_blocks.append(block)
        video_blocks = []
        for vi, v in enumerate(videos):
            vdir = os.path.join(workdir, f"vid_{vi}")
            os.makedirs(vdir)
            # Native post-rotation frame size, measured from one decoded
            # frame rather than the stream probe: stream width/height are
            # PRE-rotation values, so sizing a rotation=90 phone clip from
            # them rendered it stretched sideways. A decoded frame (ffmpeg
            # autorotation on by default) is version-proof ground truth.
            probe_frame = os.path.join(vdir, "probe.jpg")
            _ffmpeg("-i", v["video"], "-frames:v", "1", probe_frame)
            try:
                with Image.open(probe_frame) as pf:
                    vw, vh = pf.size
            except FileNotFoundError:
                raise ComposeError(f"no frames from video block {v['video']}")
            os.unlink(probe_frame)
            k = min(px(PHOTO_MAX_W) / vw, px(PHOTO_MAX_H) / vh, 1.0)
            tw, th = max(2, int(vw * k) // 2 * 2), max(2, int(vh * k) // 2 * 2)
            # a tapped video extracts at TAP-STAGE fit so the grown modal
            # is a downscale of real pixels, never an upscale; the thread
            # view downscales each frame to (tw, th)
            ew, eh = tw, th
            if v.get("tap"):
                ks = min(px(TAP_STAGE_W) / vw, px(TAP_STAGE_H) / vh, 1.0)
                ew = max(tw, max(2, int(vw * ks) // 2 * 2))
                eh = max(th, max(2, int(vh * ks) // 2 * 2))
            clip_len = v["end"] - v["start"]
            _ffmpeg("-i", v["video"], "-t", f"{clip_len:.3f}",
                    "-vf", f"fps={FPS},scale={ew}:{eh}", "-q:v", "4",
                    os.path.join(vdir, "f_%05d.jpg"))
            vframes = sorted(os.listdir(vdir))
            if not vframes:
                raise ComposeError(f"no frames from video block {v['video']}")
            vb = dict(type="video", frames_dir=vdir,
                      frames=vframes, fps=FPS, vw=tw, vh=th,
                      fw=ew, fh=eh,
                      start=v["start"], end=v["end"])
            if v.get("tap"):
                vb["tap"] = True
            video_blocks.append(vb)

        # BROWSER blocks: one component owns a whole journey. Rebuilt
        # pages arrive as in-memory 1240x640 viewport renders with
        # measured click points in page space; they are pre-fit at BOTH
        # sizes (thread card + tap stage), and each fit converts the
        # clicks into that size's viewport space so the cursor lands on
        # the same component at either scale.
        from .templates import (BROWSER_BAR_H, BROWSER_THREAD_W,
                                TAP_STAGE_W, TAP_STAGE_H)
        browser_blocks = []
        for br in browsers:
            raw = br["pages_img"]
            n_trans = len(raw) - 1
            clicks_pg = [(tuple(cl) if cl else (0.62, 0.42))
                         for cl in (br.get("clicks") or [])][:n_trans]
            while len(clicks_pg) < n_trans:
                clicks_pg.append((0.62, 0.42))
            def fit(imgs, w, vp):
                # CONTAIN, never crop: the whole page stays visible
                # (clipped pages read as broken — Lucas 2026-09-02); pages
                # letterbox on white, top-anchored, when aspects differ.
                out, xf = [], None
                for im in imgs:
                    s = min(w / im.width, vp / im.height)
                    iw, ih = max(1, int(im.width * s)), max(1, int(im.height * s))
                    im2 = im.resize((iw, ih), Image.LANCZOS)
                    cv = Image.new("RGB", (w, vp), (255, 255, 255))
                    x0 = (w - iw) // 2
                    cv.paste(im2, (x0, 0))
                    out.append(cv)
                    if xf is None:
                        # page-frac -> this size's viewport-frac
                        xf = (x0, iw, ih)
                return out, xf
            def map_clicks(xf, w, vp):
                x0, iw, ih = xf
                return [((x0 + fx * iw) / w, (fy * ih) / vp)
                        for fx, fy in clicks_pg]
            w_t = px(BROWSER_THREAD_W)
            vp_t = min(px(300), max(px(120), int(w_t * raw[0].height / raw[0].width)))
            w_s = px(TAP_STAGE_W)
            # The stage render keeps the THREAD card's exact proportions
            # (viewport aspect AND chrome, via the k scale below), so the
            # tap is one card scaling up — never a second layout.
            vp_s = max(1, int(round(vp_t * w_s / w_t)))
            shots_t, xf_t = fit(raw, w_t, vp_t)
            shots_s, xf_s = fit(raw, w_s, vp_s)
            browser_blocks.append(dict(
                type="browser", start=br["start"], end=br["end"],
                shots_t=shots_t, shots_s=shots_s,
                clicks_t=map_clicks(xf_t, w_t, vp_t),
                clicks_s=map_clicks(xf_s, w_s, vp_s),
                address=br.get("address", ""),
                w_t=w_t, vp_t=vp_t, w_s=w_s, vp_s=vp_s,
                **({"tap": True} if br.get("tap") else {})))
        stack_blocks = sorted(
            [dict(type="bubble", text=b["text"], is_muse=b.get("is_muse", False),
                  start=b["start"], end=b["end"]) for b in bubbles]
            + [dict(type="typing", start=ty["start"], end=ty["end"])
               for ty in typings]
            + [dict(type="proof", card=p["_card"], bw=p["_card"].width,
                    bh=p["_card"].height, start=p["start"], end=p["end"],
                    **({"tap": True,
                        "tap_img": make_photo(p["img"] if not isinstance(
                            p["img"], (str, os.PathLike))
                            else Image.open(p["img"]).convert("RGBA"),
                            TAP_STAGE_W, TAP_STAGE_H)}
                       if p.get("tap") else {}))
               for p in proofs]
            + photo_blocks + video_blocks + browser_blocks,
            key=lambda blk: blk["start"])
        for r in reactions:
            for blk in stack_blocks:
                if blk["type"] == "bubble" and abs(blk["start"] - r["target"]) < 0.01:
                    blk.setdefault("reactions", []).append(
                        {"emoji": r["emoji"], "start": r["start"]})

        # STREAMING frame loop — no intermediate files. The old shape wrote
        # ~950 PNGs (extract), decoded each, PNG-ENCODED each composited
        # frame, and had ffmpeg re-read them all: three trips through a slow
        # codec per frame, ~85% of an 11-minute render. Raw RGB flows
        # ffmpeg-decode → PIL → ffmpeg-encode through pipes instead;
        # pixels are bit-identical to the file path.
        aud_probe = _run([FFPROBE, "-v", "error", "-show_entries",
                          "format=duration", "-of", "csv=p=0",
                          creator_video]).stdout.strip()
        try:
            est_duration = float(aud_probe)
        except ValueError:
            raise ComposeError(f"cannot probe creator video duration: {aud_probe!r}")
        est_frames = max(1, int(est_duration * FPS))

        # audio: creator VO + directional message sounds (built up front —
        # the body encoder consumes it alongside the video pipe; the wav is
        # padded past the video and -shortest trims to the video stream)
        # Muse finisher: decode the lockup once; the overlay owns the
        # full-screen close (fade to white, lockup centered, celebration
        # header). The validator already kept authored beats out of the
        # window.
        if not os.path.isfile(_LOCKUP_VIDEO):
            raise ComposeError(
                f"Muse lockup missing: {_LOCKUP_VIDEO} — the skill ships it "
                "in assets/brand/; a partial checkout or sync dropped it")
        fin_dir = os.path.join(workdir, "finisher")
        os.makedirs(fin_dir, exist_ok=True)
        # The 1080x1080 lockup asset centers a wide mark in a lot of white:
        # crop to the 1080x450 band around it (measured; the mark spans
        # y 483-599), so the card is rectangular instead of a mostly-empty
        # square. Extract at TAP-STAGE width so the grown card is crisp;
        # the thread view (FINISHER_W x FINISHER_H) is a downscale, like
        # any tapped video.
        # band width for the FULL-SCREEN white takeover: ~92% of the
        # 720-base frame width, centered on white by the overlay
        fin_fw = px(662)
        fin_fh = max(1, int(round(fin_fw * 450 / 1080)))
        _ffmpeg("-i", _LOCKUP_VIDEO,
                "-vf", (f"fps={FPS},crop=iw:ih*450/1080:0:ih*316/1080,"
                        f"scale={fin_fw}:{fin_fh}"),
                "-q:v", "3", os.path.join(fin_dir, "f_%03d.jpg"))
        fin_frames = sorted(os.listdir(fin_dir))
        if not fin_frames:
            raise ComposeError("no frames decoded from the Muse lockup")
        # "Made with" sits above the mark, baked onto the frames with its
        # own quick fade-in: it arrives just after the white settles
        # (takeover fade is 0.5s), then the mark draws in under it.
        made_font = load_font(max(8, int(fin_fw * 46 / 1080)))
        _LABEL_IN_AT, _LABEL_IN_SECS = 0.5, 0.35
        for i, name in enumerate(fin_frames):
            a = min(1.0, max(0.0, (i / FPS - _LABEL_IN_AT) / _LABEL_IN_SECS))
            if a <= 0.0:
                continue
            fp = os.path.join(fin_dir, name)
            with Image.open(fp) as fr:
                fr = fr.convert("RGBA")
                layer = Image.new("RGBA", fr.size, (0, 0, 0, 0))
                d = ImageDraw.Draw(layer)
                tb = d.textbbox((0, 0), "Made with", font=made_font)
                d.text(((fin_fw - (tb[2] - tb[0])) // 2 - tb[0],
                        int(fin_fh * 0.16)),
                       "Made with", font=made_font,
                       fill=(107, 108, 110, int(255 * a)))
                fr.alpha_composite(layer)
                fr.convert("RGB").save(fp, quality=92)
        fin_start = est_duration
        finisher_frames = math.ceil(max(
            len(fin_frames) / FPS + 0.5, msg.closing_avatar_duration()) * FPS)
        finisher_duration = finisher_frames / FPS
        # Measure the VISIBLE content (label + resolved lockup) on the
        # final frame: the band's dead space is asymmetric once the label
        # is baked above the mark, so centering the band leaves the group
        # reading high. The overlay centers the group's own midpoint.
        from PIL import ImageChops as _IC
        with Image.open(os.path.join(fin_dir, fin_frames[-1])) as _last:
            _last = _last.convert("RGB")
            _bgc = _last.getpixel((0, 0))
            _diff = _IC.difference(
                _last, Image.new("RGB", _last.size, _bgc)).convert("L")
            _bbox = _diff.point(lambda p: 255 if p > 10 else 0).getbbox()
        fin_cy = (((_bbox[1] + _bbox[3]) / 2) / fin_fh) if _bbox else 0.5
        # FULL-SCREEN finisher variant: the frame fades to white, the
        # lockup plays centered on the white, and the pinned avatar
        # header stays on top through its complete closing reaction. The renderer
        # owns the whole takeover; nothing enters the thread.
        msg.set_finisher(start=fin_start, frames_dir=fin_dir,
                         frames=fin_frames, fps=FPS, content_cy=fin_cy)

        boops = msg.render_sfx_wav(
            [b["start"] for b in bubbles if not b.get("is_muse")],
            [b["start"] for b in bubbles if b.get("is_muse")]
            + [p["start"] for p in proofs]
            + [ph["start"] for ph in photos] + [v["start"] for v in videos]
            + [br["start"] for br in browsers],
            [r["start"] for r in reactions],
            est_duration + finisher_duration,
            os.path.join(workdir, "boops.wav"))

        import re
        levels = subprocess.run([FFMPEG, "-hide_banner", "-i", creator_video,
            "-vn", "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True, check=True).stderr
        match = re.search(r"mean_volume: (-?[0-9.]+) dB", levels)
        # A failed/silent measurement mutes optional UI sounds.
        voice_db = float(match.group(1)) if match else -120.0
        sfx_gain = min(1.0, math.pow(10, (voice_db - 12 + 15.9) / 20))

        body = os.path.join(workdir, "body.mp4")
        # Fill the 9:16 canvas from ONE decode pass by COVER-CROP: scale
        # with aspect-preserving overshoot, then center-crop to the canvas.
        # Creator sources are portrait by product contract: a 9:16 phone
        # video passes through untouched, and a wider portrait source
        # (3:4 loses ~25% of width, 4:5 ~30%) center-crops its sides. No
        # stretch, no bars, and no blur-fill bands: the old fit-plus-
        # blurred-background composite read as filler on vertical short
        # form and is retired. ffmpeg's default autorotation stays ON (no
        # -noautorotate anywhere), so rotation=90 phone footage composes
        # upright. fps runs once, after the crop, so the raw pipe still
        # emits exactly WxH rgb24 frames.
        # HDR sources (iPhone HLG/PQ, BT.2020) MUST be tonemapped to SDR
        # BT.709 before the 8-bit rgb24 pipe; a naive conversion is the
        # washed-out "weird coloring" users reported. SDR sources pass
        # through with their matrix declared so the rgb conversion cannot
        # fall back to the BT.601 default.
        is_hdr, src_matrix = _source_color(creator_video)
        to_sdr = ""
        if is_hdr:
            has_zscale = "zscale" in subprocess.run(
                [FFMPEG, "-hide_banner", "-filters"],
                capture_output=True, text=True).stdout
            if has_zscale:
                to_sdr = ("zscale=t=linear:npl=203,tonemap=hable:desat=0,"
                          "zscale=p=bt709:t=bt709:m=bt709:r=tv,"
                          "format=yuv420p,")
            else:
                # Dev-box ffmpeg without libzimg: colors will be
                # approximate; the cell image's ffmpeg has zscale.
                print("WARNING: HDR source but this ffmpeg lacks zscale; "
                      "tonemapping skipped (dev fallback)", flush=True)
        # The final scale converts yuv->rgb24 for the pipe; its matrix is
        # the SOURCE's own (probed above), never a hardcoded bt709: a
        # BT.601-tagged clip (SD footage, messaging-app re-encodes)
        # decoded with the 709 recipe shifts reds and greens. After the
        # HDR tonemap the stream really is bt709, and an unknown or
        # untagged matrix falls back to bt709 rather than ffmpeg's
        # BT.601 default (modern phone footage is overwhelmingly 709).
        _SCALE_MATRICES = {"bt709", "bt601", "smpte170m", "bt470bg",
                           "smpte240m", "fcc", "bt2020"}
        in_mat = "bt709"
        if not is_hdr and src_matrix:
            m = {"bt2020nc": "bt2020", "bt2020c": "bt2020"}.get(
                src_matrix, src_matrix)
            if m in _SCALE_MATRICES:
                in_mat = m
        dec = subprocess.Popen(
            [FFMPEG, "-v", "error", "-i", creator_video,
             "-filter_complex",
             f"[0:v]{to_sdr}"
             f"scale={W}:{H}:force_original_aspect_ratio=increase,"
             f"crop={W}:{H},fps={FPS},"
             f"scale=iw:ih:in_color_matrix={in_mat}",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            stdout=subprocess.PIPE)
        enc = subprocess.Popen(
            [FFMPEG, "-y", "-v", "error",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
             "-r", str(FPS), "-i", "-",
             "-i", creator_video, "-i", boops,
             # normalize=0 is load-bearing: amix's default scales every input
             # by 1/inputs, so mixing the two tracks quietly dropped the
             # creator's narration by 6dB (measured -42.1 vs -36.1 dBFS). The
             # sfx are authored quiet already (render_sfx_wav caps at 0.16),
             # so summing without normalization is what the levels assume.
             # duration=longest, never "first": "first" is the CREATOR's audio
             # track, and a clip whose audio ends before its video (a phone
             # that keeps rolling after the mic stops) capped the mix there,
             # at which point -shortest trimmed the composed VIDEO to the
             # audio and every beat in the tail silently vanished. The sfx wav
             # is authored a second PAST the clip, so "longest" always spans
             # the frames and -shortest trims on the video pipe — which is the
             # length this function goes on to report.
             "-filter_complex",
             f"[2:a]volume={sfx_gain:.8f}[sfx];[1:a][sfx]amix=inputs=2:duration=longest:normalize=0[aout]",
             "-map", "0:v", "-map", "[aout]",
             "-vf", "scale=iw:ih:out_color_matrix=bt709:out_range=tv",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             # level 5.1: the native canvas reaches 1440x2560 = 14400
             # macroblocks, past level 4.2's 8704 cap — x264 would still
             # write level=42 with only a console warning, shipping a
             # stream that advertises a level it exceeds.
             "-profile:v", "high", "-level", "5.1",
             "-x264-params",
             "colorprim=bt709:transfer=bt709:colormatrix=bt709",
             "-colorspace", "bt709", "-color_primaries", "bt709",
             "-color_trc", "bt709",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
             "-shortest", "-movflags", "+faststart", body],
            stdin=subprocess.PIPE)

        def _read_exact(f, n):
            buf = b""
            while len(buf) < n:
                chunk = f.read(n - len(buf))
                if not chunk:
                    break
                buf += chunk
            return buf

        def _animating(blk, t):
            """True while this block still changes pixels frame to frame.
            Entry slide + pop ~0.35s; a video plays until its end (then
            holds its last frame); typing always pulses; a reaction
            springs for 0.45s after its start."""
            dt = t - blk["start"]
            if (blk["type"] == "typing"
                    and blk["end"] <= t <= blk["end"] + DEPTH_SECS):
                return True
            if dt < max(0.35, DEPTH_SECS):
                return True
            if blk.get("anim_frames") and t <= blk["end"]:
                return True
            if blk.get("tap") and t <= blk["end"]:
                # the tap press/grow/hold/shrink window re-renders every
                # frame; a cached layer here freezes the modal mid-flight
                return True
            if blk["type"] == "bubble":
                return any(0 <= t - rx["start"] < 0.5
                           for rx in blk.get("reactions", []))
            if blk["type"] == "video":
                return t < blk["end"]
            if blk["type"] == "browser":
                return t < blk["end"]  # the session animates continuously
            if blk["type"] == "typing":
                return True
            return False

        frame_bytes = W * H * 3
        n_bub = n_prf = n_blank = 0
        _report_every = max(1, est_frames // 20)
        # The layer now spans the full frame: the pinned identity header
        # lives at the top and the hero intro plays center-frame before any
        # message exists, so EVERY frame composites (there is no blank
        # pre-thread stretch any more — the avatar is already on stage).
        # During "hold" stretches (nothing animating, same stack, header
        # settled and static) the layer is pixel-identical, so it renders
        # once and is reused; an animated avatar defeats the cache by
        # design — its loop changes pixels every frame.
        first_bub_start = min(
            (blk["start"] for blk in stack_blocks if blk["type"] == "bubble"),
            default=None)
        cache_key, cached_layer = None, None
        i = 0
        while True:
            buf = _read_exact(dec.stdout, frame_bytes)
            if len(buf) < frame_bytes:
                break
            if i % _report_every == 0:
                print(f"compose: frame {i}/~{est_frames} "
                      f"({min(99, 100*i//est_frames)}%)", flush=True)
            t = i / FPS
            base = Image.frombytes("RGB", (W, H), buf)
            last_source_frame = base.copy()
            # Content stays on the rail; only typing slots expire after closing.
            stack = [blk for blk in stack_blocks
                     if blk["start"] <= t
                     and not (blk["type"] == "typing"
                              and t > blk["end"] + DEPTH_SECS)]
            # header motion: the 0.4s entrance, the 0.8s pin spring after
            # the first bubble (+0.1s settle guard), or a status loop
            header_live = (msg.header_animates or t < 0.5
                           or (first_bub_start is not None
                               and first_bub_start <= t < first_bub_start + 0.9))
            key = tuple(id(blk) for blk in stack)
            animating = (header_live or msg.finisher_active(t)
                         or any(_animating(b, t) for b in stack))
            if key == cache_key and not animating:
                layer = cached_layer
            else:
                layer = msg.render_frame(t, stack)
                if animating:
                    cache_key, cached_layer = None, None
                else:
                    cache_key, cached_layer = key, layer
            base = Image.alpha_composite(
                base.convert("RGBA"), layer).convert("RGB")
            if stack:
                n_bub += 1
                if any(blk["type"] == "proof" for blk in stack[-3:]):
                    n_prf += 1
            else:
                n_blank += 1
            enc.stdin.write(base.tobytes())
            i += 1
        dec.stdout.close()
        if dec.wait() != 0:
            raise ComposeError("creator video decode failed mid-stream")
        if i == 0:
            raise ComposeError("no frames decoded from creator video")
        # The extension tail: the footage is over, the takeover holds, and
        # the reaction finishes and holds. The base frame color is
        # irrelevant — the takeover surface is opaque by now — and the
        # audio side is silence (the sfx wav spans the extension, and the
        # creator track has ended).
        for _ in range(finisher_frames):
            t = i / FPS
            layer = msg.render_frame(t, stack_blocks and [
                blk for blk in stack_blocks
                if blk["start"] <= t
                and not (blk["type"] == "typing"
                         and t > blk["end"] + DEPTH_SECS)] or [])
            base = last_source_frame.copy()
            base = Image.alpha_composite(
                base.convert("RGBA"), layer).convert("RGB")
            enc.stdin.write(base.tobytes())
            i += 1
        enc.stdin.close()
        if enc.wait() != 0:
            raise ComposeError("body encode failed")
        duration = i / FPS
        # -shortest ends the body on whichever stream runs out first, so a
        # body shorter than the frames fed to it means audio truncated the
        # video. Catch it HERE, where the cause is still knowable: its only
        # downstream symptom is a short final video, and the output check
        # below would pin that on the concat instead.
        body_secs = float(_run([FFPROBE, "-v", "error", "-select_streams",
                                "v:0", "-show_entries", "stream=duration",
                                "-of", "csv=p=0", body]).stdout.strip())
        if abs(body_secs - duration) > 0.5:
            raise ComposeError(
                f"composed body is {body_secs:.2f}s but {i} frames "
                f"({duration:.2f}s) went into it — the mixed audio ran short "
                "and -shortest trimmed the video with the tail beats in it")
        raw = range(i)  # frame count for the report/progress epilogue

        # The finisher renders inside the body plus its extension tail, so
        # the body IS the finished video: no appended splash, no concat,
        # and the output length is the footage length plus
        # finisher_duration.
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        out = os.path.join(out_dir, f"magic-moment-{stamp}.mp4")
        shutil.move(body, out)

        print(f"compose: frame {len(raw)}/{len(raw)} (100%) — encoding",
              flush=True)
        # verify: clean decode, right geometry, and the duration the caller
        # was promised.
        _run([FFMPEG, "-v", "error", "-i", out, "-f", "null", "-"])
        probe = _run([FFPROBE, "-v", "error", "-select_streams", "v:0",
                      "-show_entries", "stream=width,height",
                      "-of", "csv=p=0", out]).stdout.strip()
        if probe.replace(",", "x") != f"{W}x{H}":
            raise ComposeError(f"output geometry {probe}, expected {W}x{H}")
        expected = est_duration + finisher_duration
        actual = float(_run([FFPROBE, "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "stream=duration",
                             "-of", "csv=p=0", out]).stdout.strip())
        if abs(actual - expected) > 0.5:
            raise ComposeError(
                f"output video stream is {actual:.2f}s, expected "
                f"~{expected:.2f}s; the encoder dropped frames"
            )

        return {
            "out": out,
            "duration": duration,
            "frames": len(raw),
            "bubble_frames": n_bub,
            "proof_frames": n_prf,
            "blank_frames": n_blank,
            "proof_reports": proof_reports,
        }
    finally:
        for child in (dec, enc):
            if child is not None:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                child.wait()
        os.close(lock_fd)  # releases the flock
        if not keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


__all__ = ["compose", "ComposeError", "run_dir", "output_root", "lock_path"]
