"""Shared helpers: audio loading, result items, the studio's meter, timing."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from importlib import metadata
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
ROOT = Path(__file__).resolve().parents[3]  # repository root (tools/song-analyzer/songanalyzer -> repo)
TOOL_DIR = Path(__file__).resolve().parents[1]


def log(msg: str) -> None:
    print(f"[analyze {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def ver(pkg: str) -> str:
    try:
        return metadata.version(pkg)
    except Exception:
        return "?"


def item(value, confidence: float | None, source: str, **extra) -> dict:
    """One analysis result: the value, how sure we are (0..1), and the tool that produced it."""
    d = {"value": value, "confidence": None if confidence is None else round(float(confidence), 3), "source": source}
    d.update(extra)
    return d


def to_jsonable(o):
    if isinstance(o, dict):
        return {str(k): to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [to_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return to_jsonable(o.tolist())
    if isinstance(o, (np.floating,)):
        return round(float(o), 4)
    if isinstance(o, float):
        return round(o, 4)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, Path):
        return str(o)
    return o


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(to_jsonable(data), indent=1, ensure_ascii=False))


def ffprobe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def decode(src: Path, dst: Path, sr: int = SR, channels: int = 2, start: float | None = None,
           duration: float | None = None, codec: str = "pcm_f32le") -> Path:
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if start is not None:
        cmd += ["-ss", str(start)]
    if duration is not None:
        cmd += ["-t", str(duration)]
    cmd += ["-i", str(src), "-ac", str(channels), "-ar", str(sr), "-c:a", codec, str(dst)]
    subprocess.run(cmd, check=True)
    return dst


def load(path: Path, mono: bool = False) -> tuple[np.ndarray, int]:
    """Returns (channels, samples) float32 (or (samples,) when mono)."""
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.T
    if mono:
        x = x.mean(axis=0)
    return x, sr


def rms_db(x: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(np.square(x)) + 1e-20))
    return 20 * np.log10(r + 1e-12)


@contextmanager
def stage(timings: dict, name: str):
    t = time.time()
    log(f"stage {name} ...")
    try:
        yield
    finally:
        timings[name] = round(time.time() - t, 2)
        log(f"stage {name} done in {timings[name]:.1f} s")


# ---- the studio's meter ------------------------------------------------------------------------

METER = "GGS meter (packages/core/src/analysis.js: BS.1770-4 / EBU R128 loudness, 4x true peak, LRA)"


def measure_call(wav: Path, timeout: int = 600) -> dict:
    """Loudness, true peak, stereo and band balance of a WAV through the studio's own meter (measure.mjs), so a song
    and its rebuild in the studio (render_mix) are measured the same way. Returns the report dictionary."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node not found: the meter runs on Node.js (the repository's own runtime)")
    r = subprocess.run([node, str(TOOL_DIR / "measure.mjs"), str(wav)], capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout)["report"]
    except (json.JSONDecodeError, KeyError):
        raise RuntimeError(f"measure.mjs failed: {r.stderr[-800:]} {r.stdout[-300:]}")
