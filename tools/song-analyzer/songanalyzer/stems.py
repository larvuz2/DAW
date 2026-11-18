"""Stem separation behind one interface.

separate(mix_wav, out_dir, backend) -> {stem_name: Path}, info

backends:
  local      Demucs v4 (htdemucs_6s by default) on this machine's CPU. Free, ~0.4-0.6x real time on 4 cores.
  fal        fal.ai `fal-ai/demucs` (same model family, run on fal GPUs). Needs FAL_KEY. $0.0007 per second of audio.
  mureka     Mureka stem separation hosted on fal (`mureka/api/song/stem`). Needs FAL_KEY. $0.06-0.70 per song.
  mureka-direct  Mureka's own API (POST https://api.mureka.ai/v1/song/stem). Needs MUREKA_API_KEY.
  none       no stems; later stages run on the mix only.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf

from .common import SR, decode, load, log, ver

FAL_DEMUCS = "fal-ai/demucs"
FAL_MUREKA = "mureka/api/song/stem"


def _download(url: str, dst: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": "song-analyzer/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dst, "wb") as f:
        f.write(r.read())
    return dst


def _to_wav(src: Path, dst: Path) -> Path:
    decode(src, dst, SR, 2, codec="pcm_s24le")
    if src != dst and src.suffix != ".wav":
        src.unlink(missing_ok=True)
    return dst


# ---- local Demucs ------------------------------------------------------------------------------

def separate_local(mix: Path, out: Path, model_name: str = "htdemucs_6s", shifts: int = 1) -> tuple[dict, dict]:
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    t0 = time.time()
    model = get_model(model_name)
    model.eval()
    x, sr = load(mix)
    if sr != model.samplerate:
        raise RuntimeError("mix must be decoded at the model sample rate")
    wav = torch.from_numpy(x)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        est = apply_model(model, ((wav - mean) / std)[None], shifts=shifts, split=True, overlap=0.25,
                          progress=False, device="cpu")[0]
    est = est * std + mean
    paths = {}
    for name, s in zip(model.sources, est):
        p = out / f"{name}.wav"
        sf.write(str(p), np.clip(s.numpy().T, -1, 1), sr, subtype="PCM_24")
        paths[name] = p
    info = {"backend": "local", "tool": f"demucs {ver('demucs')} ({model_name}, shifts={shifts})",
            "seconds": round(time.time() - t0, 1), "cost_usd": 0.0}
    return paths, info


# ---- fal.ai ------------------------------------------------------------------------------------

def _fal_client():
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set: export FAL_KEY=<your fal.ai key> (https://fal.ai/dashboard/keys)")
    import fal_client
    return fal_client


def _upload_mp3(fal_client, mix: Path, out: Path, max_mb: float | None = None) -> str:
    """Encode to MP3 (smaller upload; Mureka accepts only MP3/M4A <= 10 MB) and upload to fal storage."""
    mp3 = out / "_upload.mp3"
    for br in ("320k", "192k", "128k"):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mix), "-c:a", "libmp3lame", "-b:a", br,
                        str(mp3)], check=True)
        if max_mb is None or mp3.stat().st_size <= max_mb * 1e6:
            break
    url = fal_client.upload_file(str(mp3))
    mp3.unlink(missing_ok=True)
    return url


def _fal_queue(fal_client, app: str, arguments: dict) -> tuple[dict, str]:
    handle = fal_client.submit(app, arguments=arguments)
    last = None
    while True:
        st = handle.status(with_logs=False)
        name = type(st).__name__
        if name != last:
            log(f"fal {app}: {name}")
            last = name
        if name == "Completed":
            break
        time.sleep(2)
    return handle.get(), handle.request_id


def separate_fal(mix: Path, out: Path, model_name: str = "htdemucs_6s") -> tuple[dict, dict]:
    fal_client = _fal_client()
    t0 = time.time()
    url = _upload_mp3(fal_client, mix, out)
    t_up = time.time() - t0
    result, rid = _fal_queue(fal_client, FAL_DEMUCS, {"audio_url": url, "model": model_name, "output_format": "wav",
                                                       # fal's default stem list includes guitar/piano, which 4-stem models reject
                                                       "stems": (["vocals", "drums", "bass", "other", "guitar", "piano"] if model_name.endswith("6s")
                                                                 else ["vocals", "drums", "bass", "other"])})
    paths = {}
    for name in ("vocals", "drums", "bass", "other", "guitar", "piano"):
        f = result.get(name)
        if f and f.get("url"):
            raw = out / f"_{name}.download"
            _download(f["url"], raw)
            paths[name] = _to_wav(raw, out / f"{name}.wav")
            raw.unlink(missing_ok=True)
    dur = sf.info(str(mix)).duration
    info = {"backend": "fal", "tool": f"fal.ai {FAL_DEMUCS} ({model_name})", "request_id": rid,
            "seconds": round(time.time() - t0, 1), "upload_seconds": round(t_up, 1),
            "cost_usd": round(0.0007 * dur, 4), "cost_basis": "$0.0007 per second of input audio (fal price list, Nov 2026)"}
    return paths, info


def _unzip_stems(zbytes: bytes, out: Path) -> dict:
    paths = {}
    with zipfile.ZipFile(io.BytesIO(zbytes)) as z:
        for n in z.namelist():
            if n.endswith("/") or not n.lower().endswith((".wav", ".mp3", ".flac", ".m4a")):
                continue
            stem = Path(n).stem.lower().replace(" ", "_")
            raw = out / f"_{stem}{Path(n).suffix}"
            raw.write_bytes(z.read(n))
            paths[stem] = _to_wav(raw, out / f"{stem}.wav")
            if raw.exists() and raw != paths[stem]:
                raw.unlink()
    return paths


def separate_mureka_fal(mix: Path, out: Path, model_name: str = "audio-separation-1") -> tuple[dict, dict]:
    fal_client = _fal_client()
    t0 = time.time()
    url = _upload_mp3(fal_client, mix, out, max_mb=9.5)
    result, rid = _fal_queue(fal_client, FAL_MUREKA, {"audio_url": url, "model": model_name})
    zreq = urllib.request.Request(result["zip_url"], headers={"User-Agent": "song-analyzer/1.0"})
    paths = _unzip_stems(urllib.request.urlopen(zreq, timeout=600).read(), out)
    if result.get("midi_zip_url"):
        (out / "mureka_midi.zip").write_bytes(urllib.request.urlopen(result["midi_zip_url"], timeout=600).read())
    price = {"audio-separation-1": 0.06, "audio-separation-2": 0.70, "audio-separation-3": 0.20}.get(model_name)
    info = {"backend": "mureka", "tool": f"fal.ai {FAL_MUREKA} ({model_name})", "request_id": rid,
            "seconds": round(time.time() - t0, 1), "cost_usd": price}
    return paths, info


def separate_mureka_direct(mix: Path, out: Path) -> tuple[dict, dict]:
    """Mureka's own API. Untested here (no key): POST {base}/v1/song/stem, Bearer MUREKA_API_KEY,
    JSON {"url": <public mp3 url>} -> JSON with a zip url of stems. The audio must be reachable by URL, so it is
    uploaded through fal storage when FAL_KEY is set, or MUREKA_AUDIO_URL can name an already-public copy."""
    key = os.environ.get("MUREKA_API_KEY")
    if not key:
        raise RuntimeError("MUREKA_API_KEY is not set (create one at https://platform.mureka.ai, API Keys)")
    base = os.environ.get("MUREKA_API_BASE", "https://api.mureka.ai")
    url = os.environ.get("MUREKA_AUDIO_URL") or _upload_mp3(_fal_client(), mix, out, max_mb=9.5)
    t0 = time.time()
    req = urllib.request.Request(f"{base}/v1/song/stem", data=json.dumps({"url": url}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=900).read())
    zurl = resp.get("zip_url") or resp.get("url")
    if not zurl:
        raise RuntimeError(f"unexpected Mureka response keys: {sorted(resp)}")
    paths = _unzip_stems(urllib.request.urlopen(zurl, timeout=600).read(), out)
    return paths, {"backend": "mureka-direct", "tool": "api.mureka.ai /v1/song/stem", "seconds": round(time.time() - t0, 1)}


# ---- canonical names ---------------------------------------------------------------------------

CANON = {"vocal": "vocals", "vocals": "vocals", "voice": "vocals", "drum": "drums", "drums": "drums",
         "bass": "bass", "other": "other", "guitar": "guitar", "piano": "piano", "keys": "piano"}


def separate(mix: Path, out: Path, backend: str, model: str | None = None) -> tuple[dict, dict]:
    out.mkdir(parents=True, exist_ok=True)
    if backend == "none":
        return {}, {"backend": "none"}
    if backend == "local":
        paths, info = separate_local(mix, out, model or "htdemucs_6s")
    elif backend == "fal":
        paths, info = separate_fal(mix, out, model or "htdemucs_6s")
    elif backend == "mureka":
        paths, info = separate_mureka_fal(mix, out, model or "audio-separation-1")
    elif backend == "mureka-direct":
        paths, info = separate_mureka_direct(mix, out)
    else:
        raise ValueError(f"unknown stems backend {backend}")
    # Mureka also returns the full mix ("song") and an "instrumental" (= all but vocals): not stems, would double count
    for extra in ("song", "instrumental", "mix", "original", "accompaniment"):
        if extra in paths and len(paths) > 2:
            paths.pop(extra).unlink(missing_ok=True)
    # Drop silent stems (e.g. guitar on a song without guitar) from later stages but keep the files.
    info["stems"] = {}
    for name, p in sorted(paths.items()):
        x, _ = load(p)
        r = float(np.sqrt(np.mean(x ** 2)) + 1e-12)
        info["stems"][name] = {"path": f"stems/{p.name}", "rms_dbfs": round(20 * np.log10(r), 1)}
    return paths, info
