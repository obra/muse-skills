"""Source identity and review binding for one Magic Moment build."""
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path


def digest(path):
    h = hashlib.sha256()
    with open(os.path.expanduser(str(path)), "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path, value, exclusive=False):
    path = Path(path)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".mm-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        if exclusive:
            os.link(temp, path)
        else:
            os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def run_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", name):
        raise ValueError("run name must be 1-120 letters, digits, underscores or hyphens")
    return name


def transcript(run, sp):
    path = Path(run) / "mm_transcript.json"
    if not path.is_file():
        raise ValueError("transcribe this source into this run before validating")
    data = json.loads(path.read_text())
    if data.get("video_sha256") != digest(sp["video"]):
        raise ValueError("transcript is not bound to this footage; transcribe into a new run")
    corrected = sp.get("transcript_correction")
    if corrected is not None:
        if not isinstance(corrected, dict) or not corrected.get("text") or not corrected.get("source"):
            raise ValueError("transcript_correction needs text and the user message/source that supplied it")
        data = dict(data, text=corrected["text"], words=[], timing="unavailable after correction")
    if not data.get("text", "").strip():
        raise ValueError("ASR is empty; provide user-supplied transcript_correction with text and source")
    return data


def fingerprint(sp, run):
    assets = {sp["video"]: digest(sp["video"])}
    for b in sp["beats"]:
        paths = [b.get("image"), b.get("video")]
        refs = b.get("reference", [])
        paths.extend([refs] if isinstance(refs, str) else refs)
        for html in [b.get("html", "")] + [p.get("html", "") for p in b.get("pages", [])]:
            from urllib.parse import unquote
            paths.extend(unquote(p) for p in re.findall(r"file://([^\s'\"<>\)]+)", html))
        for path in paths:
            if path:
                assets[str(path)] = digest(path)
    skill = Path(__file__).resolve().parent.parent
    renderer = {str(p.relative_to(skill)): digest(p) for p in sorted(skill.rglob("*"))
                if p.is_file() and p.suffix in (".py", ".mjs", ".ttf", ".otf")}
    renderer["mm"] = digest(skill / "mm")
    payload = {"renderer": renderer, "screenplay": sp, "assets": assets,
               "transcript": digest(Path(run) / "mm_transcript.json")}
    value = hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()
    return value, assets


def semantic_review(sp, run, value):
    path = Path(run) / "script_review.json"
    if not path.is_file():
        raise ValueError(f"write {path} with fingerprint {value}, verdict pass, and one claim row per content beat")
    review = json.loads(path.read_text())
    if review.get("fingerprint") != value or review.get("verdict") != "pass":
        raise ValueError("semantic review is missing, failed, or stale; review the current fingerprint")
    claims = review.get("claims", [])
    expected = {i for i, b in enumerate(sp["beats"]) if b["type"] not in ("typing", "reaction")}
    if not isinstance(claims, list) or {c.get("beat") for c in claims if isinstance(c, dict)} != expected:
        raise ValueError("review claims must cover every content beat by zero-based beat index")
    for c in claims:
        if any(not isinstance(c.get(k), str) or not c[k].strip()
               for k in ("source_span", "actor", "action", "tense", "evidence", "depiction")):
            raise ValueError("each review claim needs source_span, actor, action, tense, evidence and depiction")
    if not review.get("source_coverage"):
        raise ValueError("review needs source_coverage explaining how every important narration claim is represented")
    return review


def review_times(sp, output):
    times = {0.0, max(0, sp["duration"] - 0.1), sp["duration"] + 0.1,
             sp["duration"] + 0.7}
    for beat in sp["beats"]:
        if beat["type"] in ("visual", "video", "browser", "bubble"):
            times.update((beat["start"] + 0.1, beat["start"] + 0.7, beat["end"] - 0.1))
    import subprocess
    from .vendor_path import vendor_bin
    duration = float(subprocess.check_output(
        [vendor_bin("ffprobe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=duration", "-of", "csv=p=0", output], text=True))
    times.update(((sp["duration"] + duration) / 2, max(0, duration - 0.1)))
    return sorted({round(min(t, max(0, duration - 0.1)), 2) for t in times})


def inspection_sheets(sp, manifest, run, ffmpeg):
    """Expose the actual encoded initial, transition and terminal states."""
    import subprocess
    from PIL import Image, ImageDraw
    output = manifest["output"]
    if digest(output) != manifest["output_sha256"]:
        raise ValueError("output changed before inspection; render again")
    times = review_times(sp, output)
    sheets = []
    with tempfile.TemporaryDirectory(prefix="mm-review-") as temp:
        for offset in range(0, len(times), 12):
            batch = times[offset:offset + 12]
            sheet = Image.new("RGB", (1080, 664 * ((len(batch) + 2) // 3)), "white")
            draw = ImageDraw.Draw(sheet)
            for i, t in enumerate(batch):
                frame = str(Path(temp) / f"{offset + i}.png")
                subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", str(t), "-i", output,
                                "-frames:v", "1", "-vf", "scale=360:640", frame], check=True)
                if not Path(frame).is_file():
                    raise ValueError(f"no encoded frame at {t:.2f}s; inspection failed")
                with Image.open(frame) as image:
                    x, y = (i % 3) * 360, (i // 3) * 664
                    sheet.paste(image, (x, y + 24))
                    draw.text((x + 8, y + 5), f"{t:.2f}s", fill="black")
            path = Path(run) / f"review-{offset // 12 + 1}.jpg"
            sheet.save(path, quality=92)
            sheets.append(str(path))
    return {"output_sha256": manifest["output_sha256"], "times": times, "sheets": sheets}
