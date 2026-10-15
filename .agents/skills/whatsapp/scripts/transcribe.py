"""Transcribe a local export manifest offline, preserving source identity and raw evidence."""

import argparse
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


DEFAULT_MODEL = Path.home() / ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/snapshots/49e6aa286ad60c14352c404340ded53710378a11"
MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 30 * 60
SAMPLE_RATE = 16000


def read_manifest(path):
    """Validate every file and checksum before any recognition or output is attempted."""
    notes = json.loads(path.read_text())
    if not isinstance(notes, list) or not 1 <= len(notes) <= 100:
        raise ValueError("Manifest must contain 1–100 recordings.")
    seen = set()
    validated = []
    for note in notes:
        if not isinstance(note, dict):
            raise ValueError("Each manifest entry must be an object.")
        for field in ("messageId", "chatId", "senderId", "sentAt", "path", "sha256"):
            if field not in note:
                raise ValueError(f"Missing manifest field: {field}")
        message_id = note["messageId"]
        if not isinstance(message_id, str) or len(message_id) != 64 or any(c not in "0123456789abcdef" for c in message_id):
            raise ValueError("Invalid stable message ID.")
        if message_id in seen:
            raise ValueError("Duplicate message ID in manifest.")
        seen.add(message_id)
        if not isinstance(note["path"], str) or Path(note["path"]).is_absolute():
            raise ValueError("Audio path must be relative to the manifest directory.")
        audio = (path.parent / note["path"]).resolve(strict=True)
        if not audio.is_relative_to(path.parent.resolve()) or not audio.is_file():
            raise ValueError("Audio must be a file within the manifest directory.")
        if not 0 < audio.stat().st_size <= MAX_BYTES:
            raise ValueError("Audio must be nonempty and at most 25 MiB.")
        if hashlib.sha256(audio.read_bytes()).hexdigest() != note["sha256"]:
            raise ValueError("Audio checksum mismatch; retrieve the original again.")
        validated.append((note, audio))
    return validated


def decode_audio(encoded, ffmpeg):
    header = encoded[:16]
    if header.startswith(b"OggS"):
        container = "ogg"
    elif header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        container = "wav"
    elif header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224):
        container = "mp3"
    elif header[4:8] == b"ftyp":
        container = "mov"
    else:
        raise ValueError("Unsupported audio container; expected Ogg/Opus, WAV, MP3, or M4A.")
    # M4A can require seeking; force the container and disable external MOV references.
    with tempfile.TemporaryDirectory(prefix="whatsapp-decode-") as directory:
        snapshot = Path(directory) / "input.audio"
        snapshot.write_bytes(encoded)
        snapshot.chmod(0o600)
        options = ["-enable_drefs", "0", "-use_absolute_path", "0"] if container == "mov" else []
        result = subprocess.run(
            [ffmpeg, "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-f", container,
             *options, "-i", str(snapshot), "-t", str(MAX_SECONDS + 1), "-f", "s16le", "-ac", "1",
             "-ar", str(SAMPLE_RATE), "pipe:1"],
            capture_output=True, timeout=60, check=False,
        )
    if result.returncode or result.stderr or not result.stdout:
        raise ValueError("Audio decoding failed or produced no samples.")
    if len(result.stdout) > MAX_SECONDS * SAMPLE_RATE * 2:
        raise ValueError("Recording exceeds 30 minutes; split it explicitly before transcription.")
    import numpy as np
    return np.frombuffer(result.stdout, np.int16).astype(np.float32) / 32768.0


def quality_flags(result):
    flags = []
    if not result.get("text", "").strip():
        flags.append({"reason": "no_recognized_speech"})
    for segment in result.get("segments", []):
        reasons = []
        if segment.get("avg_logprob", 0) < -1:
            reasons.append("low_decoder_score")
        if segment.get("compression_ratio", 0) > 2.4:
            reasons.append("possible_repetition")
        if reasons:
            flags.append({"start": segment["start"], "end": segment["end"], "reasons": reasons})
    return flags


def validate_working_directory(manifest, data_dir):
    root = data_dir.expanduser().resolve(strict=True)
    folder = manifest.parent.resolve(strict=True)
    if folder.parent != root / "voice-notes" or not folder.name.startswith("export-"):
        raise ValueError("Manifest must be inside an export directory under the approved data directory's voice-notes/.")
    for directory in (root, folder.parent, folder):
        if stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise ValueError("Data and export directories must have private mode 0700.")


def transcribe_manifest(manifest, model, language, context_check=False, *, data_dir):
    validate_working_directory(manifest, data_dir)
    notes = read_manifest(manifest)
    model = model.expanduser().resolve(strict=True)
    if not (model / "config.json").is_file() or not any((model / name).is_file() for name in ("weights.npz", "weights.safetensors")):
        raise ValueError("Model needs local config.json and weights.npz or weights.safetensors; no download attempted.")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ValueError("FFmpeg is missing from PATH; select the existing installation.")
    # Set these before importing the runtime so missing cache files cannot trigger downloads.
    os.environ.update(HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import mlx_whisper
    settings = {"language": None if language in ("auto", "mixed") else language,
                "task": "transcribe", "condition_on_previous_text": context_check,
                "word_timestamps": True, "initial_prompt": None, "temperature": 0}
    report = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
              "modelPath": str(model), "runtimeVersion": version("mlx-whisper"),
              "languageMode": language, "settings": settings, "notes": []}
    for source, path in notes:
        encoded = path.read_bytes()
        if len(encoded) > MAX_BYTES or hashlib.sha256(encoded).hexdigest() != source["sha256"]:
            raise ValueError("Audio changed after validation; retrieve the original again.")
        audio = decode_audio(encoded, ffmpeg)
        start = time.monotonic()
        result = mlx_whisper.transcribe(audio, path_or_hf_repo=str(model), verbose=None, **settings)
        report["notes"].append({"source": source, "durationSeconds": len(audio) / SAMPLE_RATE,
                                "elapsedSeconds": round(time.monotonic() - start, 3),
                                "result": result, "qualityFlags": quality_flags(result)})
    output = manifest.parent / f"transcript-{uuid.uuid4().hex}.json"
    encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    stream = output.open("x", encoding="utf-8")
    try:
        with stream:
            os.chmod(output, 0o600)
            stream.write(encoded)
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--data-dir", type=Path, required=True, help="Approved private data directory from the WhatsApp config.")
    parser.add_argument("--language", choices=("en", "es", "auto", "mixed"), required=True)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help=f"Local MLX model directory (default: {DEFAULT_MODEL})")
    parser.add_argument("--context-check", action="store_true", help="Retain previous-window text in a separate comparison pass.")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        output = transcribe_manifest(args.manifest.resolve(strict=True), args.model, args.language, args.context_check, data_dir=args.data_dir)
        print(json.dumps({"transcriptPath": str(output)}))
    except (ValueError, OSError, ImportError, subprocess.TimeoutExpired) as error:
        print(f"Transcription failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
