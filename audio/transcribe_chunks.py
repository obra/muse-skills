"""Bounded CPU transcription with atomic, resumable chunk receipts."""

from __future__ import annotations

import argparse
from collections import deque
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from typing import BinaryIO, Iterator

SAMPLE_RATE = 16_000
OVERLAP_SAMPLES = 2 * SAMPLE_RATE


def read_chunk(stream: BinaryIO, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        block = stream.read(size - len(result))
        if not block:
            break
        result.extend(block)
    return bytes(result)


def audio_windows(stream: BinaryIO, cursor: int, chunk_samples: int, overlap_samples: int) -> Iterator[tuple[int, int, int, bytes]]:
    window_start = max(0, cursor - overlap_samples)
    pcm = b""
    while True:
        target = (cursor + chunk_samples + overlap_samples - window_start) * 2
        pcm += read_chunk(stream, target - len(pcm))
        if len(pcm) % 2:
            raise ValueError("decoder returned an incomplete PCM sample")
        available_end = window_start + len(pcm) // 2
        if available_end <= cursor:
            return
        end = min(cursor + chunk_samples, available_end)
        yield cursor, end, window_start, pcm
        next_start = max(0, end - overlap_samples)
        pcm = pcm[(next_start - window_start) * 2:]
        window_start, cursor = next_start, end


def transcript_words(segments, window_start: int) -> list[dict]:
    result = []
    offset = window_start / SAMPLE_RATE
    for segment in segments:
        if segment.text.strip() and not segment.words:
            raise ValueError("transcription did not return word timestamps")
        result.extend({"start": offset + word.start, "end": offset + word.end, "text": word.word}
                      for word in segment.words or [] if word.word.strip())
    return result


def word_middle(word: dict) -> float:
    return (word["start"] + word["end"]) / 2


def stitch_words(previous: list[dict], current: list[dict], boundary: float) -> tuple[list[dict], dict | None]:
    if not previous or not current:
        return previous + current, None
    if previous[-1]["end"] <= current[0]["start"]:
        return previous + current, None
    head = [word for word in current if word["start"] < boundary + OVERLAP_SAMPLES / SAMPLE_RATE]
    def normalized(word: dict) -> str:
        return "".join(char for char in word["text"].casefold() if char.isalnum())

    left, right = [normalized(word) for word in previous], [normalized(word) for word in head]
    matches = []
    for i, token in enumerate(left):
        if not token:
            continue
        for j in range(len(right)):
            size = 0
            while (i + size < len(left) and j + size < len(right)
                   and left[i + size] == right[j + size]
                   and abs(word_middle(previous[i + size]) - word_middle(head[j + size])) <= 1):
                size += 1
            if size:
                anchor = min(range(size), key=lambda k: abs(word_middle(previous[i + k]) - boundary))
                a, b = i + anchor, j + anchor
                matches.append((size, -abs(word_middle(previous[a]) - word_middle(head[b])),
                                -abs(word_middle(previous[a]) - boundary), a, b))
    if matches:
        size, _, _, a, b = max(matches)
        joined = previous[:a + 1] + current[b + 1:]
        if size > 1 or left == right:
            return joined, None
    else:
        joined = ([word for word in previous if word_middle(word) < boundary]
                  + [word for word in current if word_middle(word) >= boundary])
    review = {"start": max(0, boundary - OVERLAP_SAMPLES / SAMPLE_RATE),
              "end": boundary + OVERLAP_SAMPLES / SAMPLE_RATE,
              "previous": previous, "current": head}
    return joined, review


def word_segments(words: list[dict]) -> list[dict]:
    segments: list[dict] = []
    for word in words:
        if (not segments or word["start"] - segments[-1]["end"] > 1
                or word["end"] - segments[-1]["start"] > 30):
            segments.append(dict(word))
        else:
            segments[-1]["end"] = word["end"]
            segments[-1]["text"] += word["text"]
    return segments


def checkpoint_window(previous: list[dict], current: list[dict], start: int, end: int) -> dict:
    words, review = stitch_words(previous, current, start / SAMPLE_RATE)
    cutoff = (end - OVERLAP_SAMPLES) / SAMPLE_RATE
    split = next((i for i, word in enumerate(words) if word["end"] > cutoff), len(words))
    return {"start_sample": start, "end_sample": end, "segments": word_segments(words[:split]),
            "pending_words": words[split:], "boundary_review": review}


def atomic_json(directory: Path, name: str, value: dict) -> None:
    pending = directory / f".{name}.pending"
    with pending.open("w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(pending, directory / name)
    with directory_fd(directory) as fd:
        os.fsync(fd)


@contextmanager
def directory_fd(directory: Path) -> Iterator[int]:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        yield fd
    finally:
        os.close(fd)


def source_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def bind_manifest(directory: Path, manifest: dict) -> None:
    path = directory / "manifest.json"
    if path.exists():
        if json.loads(path.read_text()) != manifest:
            raise ValueError("checkpoint inputs changed; use a new output directory")
    else:
        if any(directory.iterdir()):
            raise ValueError("new transcription requires an empty output directory")
        atomic_json(directory, "manifest.json", manifest)


def committed_chunks(directory: Path, chunk_samples: int) -> Iterator[dict]:
    cursor = 0
    count = 0
    while (path := directory / f"chunk-{cursor:016d}.json").exists():
        chunk = json.loads(path.read_text())
        if not isinstance(chunk, dict):
            raise ValueError(f"invalid checkpoint at sample {cursor}")
        end = chunk.get("end_sample")
        if (
            chunk.get("start_sample") != cursor
            or type(end) is not int
            or not cursor < end <= cursor + chunk_samples
            or not isinstance(chunk.get("segments"), list)
            or not isinstance(chunk.get("pending_words"), list)
        ):
            raise ValueError(f"invalid checkpoint at sample {cursor}")
        yield chunk
        cursor = end
        count += 1
    saved_count = sum(
        entry.name.startswith("chunk-") and entry.name.endswith(".json")
        for entry in directory.iterdir()
    )
    if saved_count != count:
        raise ValueError("checkpoint sequence has a gap or an unexpected chunk; preserve it for repair")


def render_transcript(directory: Path, chunk_samples: int) -> tuple[int, int]:
    pending = directory / ".transcript.pending"
    count = end = 0
    with pending.open("w", encoding="utf-8") as output:
        tail: list[dict] = []
        for chunk in committed_chunks(directory, chunk_samples):
            if review := chunk.get("boundary_review"):
                output.write(f'[{review["start"]:.3f} - {review["end"]:.3f}] [Boundary needs review; see chunk-{chunk["start_sample"]:016d}.json]\n')
            for segment in chunk["segments"]:
                output.write(f'[{segment["start"]:.3f} - {segment["end"]:.3f}] {segment["text"]}\n')
            tail = chunk["pending_words"]
            count += 1
            end = chunk["end_sample"]
        for segment in word_segments(tail):
            output.write(f'[{segment["start"]:.3f} - {segment["end"]:.3f}] {segment["text"]}\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(pending, directory / "transcript.txt")
    return count, end


def transcribe(args: argparse.Namespace) -> None:
    source = args.input.expanduser().resolve(strict=True)
    source_identity = source.stat()
    model_path = args.model.expanduser().resolve(strict=True)
    weights = (model_path / "model.bin").stat()
    directory = args.output_dir.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    chunk_samples = args.chunk_seconds * SAMPLE_RATE
    manifest = {
        "format": 2, "source_sha256": source_digest(source),
        "model": str(model_path), "model_bytes": weights.st_size,
        "model_mtime_ns": weights.st_mtime_ns,
        "model_config_sha256": source_digest(model_path / "config.json"),
        "tokenizer_sha256": source_digest(model_path / "tokenizer.json"),
        "language": args.language, "chunk_samples": chunk_samples,
        "overlap_samples": OVERLAP_SAMPLES,
    }
    with directory_fd(directory) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("another transcription owns this output directory") from error
        bind_manifest(directory, manifest)
        cursor = count = 0
        context = ""
        pending_words: list[dict] = []
        boundary_reviews = 0
        for chunk in committed_chunks(directory, chunk_samples):
            cursor = chunk["end_sample"]
            count += 1
            context = (context + " " + " ".join(segment["text"] for segment in chunk["segments"]))[-1000:]
            pending_words = chunk["pending_words"]
            boundary_reviews += int(chunk.get("boundary_review") is not None)
        if (directory / "complete.json").exists():
            complete = json.loads((directory / "complete.json").read_text())
            if (
                complete.get("end_sample") != cursor
                or complete.get("chunks") != count
                or complete.get("source_sha256") != manifest["source_sha256"]
                or complete.get("boundary_reviews") != boundary_reviews
            ):
                raise ValueError("completion receipt disagrees with committed chunks")
            render_transcript(directory, chunk_samples)
            print(json.dumps({"status": "needs_review" if boundary_reviews else "completed",
                              "boundary_reviews": boundary_reviews, "reused": True, "output_dir": str(directory)}))
            return

        import numpy as np
        from faster_whisper import WhisperModel

        model = WhisperModel(
            str(model_path), device="cpu", compute_type="int8",
            cpu_threads=1, num_workers=1,
            local_files_only=True,
        )
        # Output-side seek decodes/discards the prefix without retaining it,
        # preserving sample offsets even in recordings with inaccurate seek tables.
        command = [
            "/usr/bin/ffmpeg", "-nostdin", "-v", "error", "-threads", "1",
            "-i", str(source), "-ss", f"{max(0, cursor - OVERLAP_SAMPLES) / SAMPLE_RATE:.6f}",
            "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
        ]
        errors: deque[bytes] = deque(maxlen=8)
        with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as decoder:
            assert decoder.stdout is not None and decoder.stderr is not None

            def drain_errors() -> None:
                while block := decoder.stderr.read(1024):
                    errors.append(block)

            reader = threading.Thread(target=drain_errors, daemon=True)
            reader.start()
            try:
                for start, end, window_start, pcm in audio_windows(decoder.stdout, cursor, chunk_samples, OVERLAP_SAMPLES):
                    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
                    audio *= 1.0 / 32768.0
                    segments, info = model.transcribe(
                        audio, language=args.language, beam_size=5, vad_filter=True,
                        word_timestamps=True, initial_prompt=context or None,
                    )
                    receipt = checkpoint_window(pending_words, transcript_words(segments, window_start), start, end)
                    receipt["language"] = info.language
                    atomic_json(directory, f"chunk-{start:016d}.json", receipt)
                    pending_words = receipt["pending_words"]
                    boundary_reviews += int(receipt["boundary_review"] is not None)
                    context = (context + " " + " ".join(segment["text"] for segment in receipt["segments"]))[-1000:]
                    cursor = end
                    print(json.dumps({"status": "checkpointed", "seconds": cursor / SAMPLE_RATE}), flush=True)
                if decoder.wait() != 0:
                    reader.join()
                    raise RuntimeError("audio decode failed: " + b"".join(errors).decode(errors="replace"))
            finally:
                if decoder.poll() is None:
                    decoder.kill()
                    decoder.wait()
                reader.join()
        if cursor == 0:
            raise ValueError("decoder produced no audio; no completed transcript was published")
        current_identity = source.stat()
        if (source_identity.st_size, source_identity.st_mtime_ns) != (current_identity.st_size, current_identity.st_mtime_ns):
            raise ValueError("source changed during transcription; use a new output directory")
        count, end = render_transcript(directory, chunk_samples)
        atomic_json(directory, "complete.json", {"chunks": count, "end_sample": end,
                    "source_sha256": manifest["source_sha256"], "boundary_reviews": boundary_reviews})
        print(json.dumps({"status": "needs_review" if boundary_reviews else "completed",
                          "boundary_reviews": boundary_reviews, "chunks": count,
                          "seconds": end / SAMPLE_RATE, "output_dir": str(directory)}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True, help="existing local CTranslate2 model directory")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--language")
    parser.add_argument("--chunk-seconds", type=int, default=60)
    args = parser.parse_args()
    if not 5 <= args.chunk_seconds <= 120:
        parser.error("--chunk-seconds must be between 5 and 120")
    try:
        transcribe(args)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print(f"transcription incomplete: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
