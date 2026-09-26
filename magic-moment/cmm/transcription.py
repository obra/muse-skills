"""Compact caller-owned audio for daemon -> inference-proxy -> host ASR."""

import http.client
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import tempfile

# Kept with hatch-protocol::model_inference and the sandbox transcription route.
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024 + 1024  # model response plus daemon envelope
ASR_TIMEOUT_SECONDS = 305


def _media_command(command):
    try:
        return subprocess.run(command, capture_output=True, check=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f"{command[0]} timed out while preparing source audio") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace").strip()[:512]
        raise ValueError(f"{command[0]} could not prepare source audio: {detail}") from error


def clip_duration(video):
    # Use the container duration, including trailing silence/video. Audio's
    # last word (or even its stream duration) is not the coverage denominator.
    probe = _media_command([
        "/usr/bin/ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "json", str(Path(video).resolve()),
    ])
    value = json.loads(probe.stdout).get("format", {}).get("duration")
    return positive_duration(value)


def positive_duration(value):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds) or seconds <= 0:
        return None
    return round(seconds, 2)


def transcribe(video, language):
    """Send one lossless 16 kHz mono track, never the large source video."""
    with tempfile.TemporaryDirectory(prefix="mm-asr-") as directory:
        audio_path = Path(directory) / "audio.flac"
        _media_command([
            "/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", str(Path(video).resolve()), "-map", "0:a:0", "-vn", "-sn", "-dn",
            "-ac", "1", "-ar", "16000", "-c:a", "flac",
            # Stop oversized extraction, then reject it; never transcribe a
            # silently truncated track or leave an unbounded scratch file.
            "-fs", str(MAX_AUDIO_BYTES + 1), str(audio_path),
        ])
        with audio_path.open("rb") as audio_file:
            audio = audio_file.read(MAX_AUDIO_BYTES + 1)
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise ValueError("extracted audio exceeds the 8 MiB ASR limit; use a shorter source clip")
    socket_path = os.environ.get("JARVIS_SANDBOX_API_SOCK", "").strip() or "/run/hatch/sandbox-api/api.sock"
    connection = http.client.HTTPConnection("localhost", timeout=ASR_TIMEOUT_SECONDS)
    try:
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(ASR_TIMEOUT_SECONDS)
        connection.sock.connect(socket_path)
        connection.request("POST", "/audio/transcriptions", body=audio, headers={
            "Content-Type": "application/octet-stream",
            "x-hatch-asr-options": json.dumps({"language": language, "word_timestamps": True}),
        })
        response = connection.getresponse()
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("ASR service response exceeds its size limit")
        try:
            envelope = json.loads(body)
        except (ValueError, UnicodeError) as error:
            raise ValueError(f"ASR service returned an invalid response (HTTP {response.status})") from error
        if not isinstance(envelope, dict):
            raise ValueError(f"ASR service returned an invalid envelope (HTTP {response.status})")
        if response.status != 200 or envelope.get("ok") is not True:
            failure = envelope.get("error", {})
            if not isinstance(failure, dict):
                failure = {}
            detail = str(failure.get("message", "request failed"))[:512]
            raise ValueError(f"ASR service failed (HTTP {response.status}): {detail}")
        result = envelope["result"]
        if not isinstance(result, dict) or not isinstance(result.get("segments"), list):
            raise ValueError("ASR service did not return the requested word timestamps")
        return result
    except (OSError, http.client.HTTPException) as error:
        raise ValueError(f"daemon ASR service unavailable at {socket_path}: {error}") from error
    finally:
        connection.close()
