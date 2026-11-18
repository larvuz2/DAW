"""Audio-to-MIDI per stem.

Pitched stems: Spotify Basic Pitch 0.4 (Apache-2.0, ONNX runtime, polyphonic, instrument-agnostic).
Bass and vocals are reduced to one line (lowest note for bass, loudest for vocals).
Drums: band-wise spectral-flux onsets on the drum stem -> kick (36), snare (38), closed hat (42), with
per-section 16th-step patterns. MIDI files carry a tempo map taken from the beat grid, so bar lines in a
DAW line up with the song's bars (bar 1 = first downbeat).
"""
from __future__ import annotations

import contextlib
import io
from pathlib import Path

import numpy as np

from .common import SR, item, load, ver

RANGES = {"bass": (28, 400), "vocals": (70, 1400), "other": (40, 4200), "piano": (27, 4200), "guitar": (70, 1400)}
GM = {"bass": 33, "vocals": 54, "other": 0, "piano": 0, "guitar": 25}


def basic_pitch(path, name):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from basic_pitch.inference import predict
        lo, hi = RANGES.get(name, (30, 4200))
        _, _, events = predict(str(path), onset_threshold=0.5 if name != "other" else 0.55, frame_threshold=0.3,
                               minimum_note_length=80 if name != "bass" else 100, minimum_frequency=lo,
                               maximum_frequency=hi, melodia_trick=True)
    notes = [{"start": float(s), "end": float(e), "pitch": int(p), "velocity": float(a)} for s, e, p, a, _ in events]
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    if name in ("bass", "vocals"):
        notes = monophonic(notes, lowest=(name == "bass"))
    return notes


def monophonic(notes, lowest=True):
    out = []
    for n in notes:
        if out and n["start"] < out[-1]["end"] - 0.03:
            prev = out[-1]
            better = n["pitch"] < prev["pitch"] if lowest else n["velocity"] > prev["velocity"]
            if abs(n["start"] - prev["start"]) < 0.06:
                if better:
                    out[-1] = n
                continue
            prev["end"] = n["start"]
        out.append(n)
    return [n for n in out if n["end"] - n["start"] > 0.04]


def drums(path, beats, bars):
    import librosa
    y, _ = load(path, mono=True)
    hop = 256
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    f = librosa.fft_frequencies(sr=SR, n_fft=2048)
    bands = {"kick": (30, 120), "snare": (180, 2500), "hat": (6000, 16000)}
    env = {}
    for k, (lo, hi) in bands.items():
        m = (f >= lo) & (f < hi)
        e = np.log1p(100 * S[m].sum(0))
        flux = np.maximum(0, np.diff(e, prepend=e[0]))
        env[k] = flux / (np.percentile(flux, 99.5) + 1e-9)
    hits = {}
    for k in bands:
        on = librosa.onset.onset_detect(onset_envelope=env[k], sr=SR, hop_length=hop, units="frames",
                                        delta=0.12 if k != "hat" else 0.1, wait=4)
        hits[k] = on
    # snare onsets need broadband noise (not just a kick's upper harmonics); hats must not coincide with snare
    kick_f = set(hits["kick"].tolist())
    snare = [o for o in hits["snare"] if env["hat"][max(0, o - 2):o + 3].max() > 0.15 or not any(abs(o - k) < 4 for k in kick_f)]
    hat = [o for o in hits["hat"] if not any(abs(o - s) < 3 for s in snare)]
    t = lambda fr: librosa.frames_to_time(np.asarray(fr), sr=SR, hop_length=hop)
    vel = lambda k, fr: float(min(1.0, env[k][fr] * 0.9 + 0.1))
    notes = []
    for k, frs, p in (("kick", hits["kick"], 36), ("snare", snare, 38), ("hat", hat, 42)):
        for fr, tt in zip(frs, t(frs)):
            notes.append({"start": float(tt), "end": float(tt) + 0.1, "pitch": p, "velocity": vel(k, fr), "drum": k})
    notes.sort(key=lambda n: n["start"])
    return notes


def drum_patterns(notes, bars, sections, steps=16):
    """Per section: the most common bar pattern on a 16-step grid per drum (x = hit)."""
    grid = {}
    for b in bars:
        L = b["end"] - b["start"]
        g = {"kick": ["."] * steps, "snare": ["."] * steps, "hat": ["."] * steps}
        for n in notes:
            if b["start"] - L / steps / 2 <= n["start"] < b["end"] - L / steps / 2:
                s = int(round((n["start"] - b["start"]) / L * steps)) % steps
                g[n["drum"]][s] = "x"
        grid[b["bar"]] = {k: "".join(v) for k, v in g.items()}
    out = []
    for s in sections:
        from collections import Counter
        pats = {}
        for k in ("kick", "snare", "hat"):
            c = Counter(grid[bn][k] for bn in range(s["bar_start"] + 1, s["bar_end"] + 1) if bn in grid)
            if c:
                p, n = c.most_common(1)[0]
                pats[k] = {"pattern": p, "bars_matching": n}
        out.append({"section": s["label"], "bars": s["bar_range"], "patterns": pats})
    return out, grid


def stats(notes, duration):
    if not notes:
        return {"notes": 0}
    p = np.array([n["pitch"] for n in notes])
    import librosa
    ts = np.linspace(0, duration, int(duration * 20))
    poly = np.array([sum(1 for n in notes if n["start"] <= t < n["end"]) for t in ts]) if len(notes) < 5000 else np.array([0])
    return {"notes": len(notes), "range": [librosa.midi_to_note(int(p.min()), unicode=False), librosa.midi_to_note(int(p.max()), unicode=False)],
            "median_pitch": librosa.midi_to_note(int(np.median(p)), unicode=False),
            "notes_per_second": round(len(notes) / max(duration, 1e-9), 2),
            "max_polyphony": int(poly.max()), "mean_polyphony_when_sounding": round(float(poly[poly > 0].mean()) if (poly > 0).any() else 0, 2)}


def time_to_tick(times, beats, ppq=960):
    """Map seconds to ticks through the beat grid (beat i at tick i*ppq; bar 1 starts at beats[0])."""
    beats = np.asarray(beats)
    idx = np.arange(len(beats)) * ppq
    t = np.asarray(times, float)
    P0 = beats[1] - beats[0]
    P1 = beats[-1] - beats[-2]
    out = np.interp(t, beats, idx)
    out = np.where(t < beats[0], (t - beats[0]) / P0 * ppq, out)
    out = np.where(t > beats[-1], idx[-1] + (t - beats[-1]) / P1 * ppq, out)
    return np.round(out).astype(int)


def write_midi(path: Path, tracks: dict, beats, bpb: int, ppq=960):
    """tracks: name -> notes. Tempo map: one tempo event per beat (exact for live tempo drift)."""
    import mido
    mid = mido.MidiFile(type=1, ticks_per_beat=ppq)
    meta = mido.MidiTrack()
    mid.tracks.append(meta)
    meta.append(mido.MetaMessage("time_signature", numerator=bpb, denominator=4, time=0))
    ibi = np.diff(beats)
    steady = np.std(ibi) / np.mean(ibi) < 0.01
    last = 0
    tempos = [(0, float(np.median(ibi)))] if steady else [(i * ppq, float(d)) for i, d in enumerate(ibi)]
    prev_us = None
    for tick, d in tempos:
        us = int(round(d * 1e6))
        if us == prev_us:
            continue
        meta.append(mido.MetaMessage("set_tempo", tempo=us, time=tick - last))
        last, prev_us = tick, us
    for ch_i, (name, notes) in enumerate(tracks.items()):
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        ch = 9 if name == "drums" else [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11][ch_i % 11]
        if name != "drums":
            tr.append(mido.Message("program_change", program=GM.get(name, 0), channel=ch, time=0))
        ev = []
        st = time_to_tick([n["start"] for n in notes], beats, ppq) if notes else []
        en = time_to_tick([n["end"] for n in notes], beats, ppq) if notes else []
        for n, a, b in zip(notes, st, en):
            if a < 0:
                continue
            b = max(b, a + 30)
            v = int(np.clip(round(n["velocity"] * 127), 1, 127))
            ev.append((a, 1, mido.Message("note_on", note=n["pitch"], velocity=v, channel=ch)))
            ev.append((b, 0, mido.Message("note_off", note=n["pitch"], velocity=0, channel=ch)))
        ev.sort(key=lambda e: (e[0], e[1]))
        cur = 0
        for tk, _, m in ev:
            m.time = int(tk - cur)
            cur = tk
            tr.append(m)
    mid.save(str(path))


def analyze(stems: dict, beats, bars, sections, duration, midi_dir: Path, bpb: int, fast=False):
    midi_dir.mkdir(parents=True, exist_ok=True)
    src = f"basic-pitch {ver('basic-pitch')} (ONNX)"
    res, tracks = {}, {}
    for name in ("bass", "vocals", "piano", "guitar", "other"):
        if name not in stems:
            continue
        x, _ = load(stems[name], mono=True)
        if np.sqrt(np.mean(x ** 2)) < 10 ** (-50 / 20):
            continue
        notes = basic_pitch(stems[name], name)
        tracks[name] = notes
        write_midi(midi_dir / f"{name}.mid", {name: notes}, beats, bpb)
        res[name] = item({"stats": stats(notes, duration), "midi": f"midi/{name}.mid"}, 0.5 if name != "other" else 0.35,
                         src + (" + monophonic reduction" if name in ("bass", "vocals") else ""))
    if "drums" in stems:
        dn = drums(stems["drums"], beats, bars)
        tracks["drums"] = dn
        write_midi(midi_dir / "drums.mid", {"drums": dn}, beats, bpb)
        pats, grid = drum_patterns(dn, bars, sections)
        counts = {k: sum(1 for n in dn if n["drum"] == k) for k in ("kick", "snare", "hat")}
        res["drums"] = item({"counts": counts, "patterns_per_section": pats, "midi": "midi/drums.mid"}, 0.45,
                            "band-wise spectral-flux onsets on drum stem (librosa)")
        res["drum_grid_per_bar"] = grid
    if tracks:
        write_midi(midi_dir / "all.mid", tracks, beats, bpb)
    return res, tracks
