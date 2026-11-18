"""Instrument recognition with PANNs Cnn14 (AudioSet clip tagger, mAP 0.431, 527 classes, MIT code) on 10 s
windows every 5 s. Run on the full mix and on each stem; window probabilities are averaged per bar and a
label is "present" in a bar when its mean probability is >= 0.08 on the mix (0.10 on stems). The frame-level
sound-event model (Cnn14_DecisionLevelMax) was tried first and rejected: on mixes its instrument
probabilities stayed below 0.02. Electronic vs acoustic and genre hints are derived from the same output.
"""
from __future__ import annotations

import numpy as np

from .common import item, load, ver

INSTRUMENTS = [
    "Singing", "Male singing", "Female singing", "Child singing", "Choir", "Rapping", "Speech", "Humming", "Whistling",
    "Guitar", "Electric guitar", "Bass guitar", "Acoustic guitar", "Steel guitar, slide guitar", "Banjo", "Mandolin",
    "Ukulele", "Sitar", "Plucked string instrument", "Strum",
    "Piano", "Electric piano", "Organ", "Hammond organ", "Electronic organ", "Harpsichord", "Keyboard (musical)",
    "Synthesizer", "Sampler", "Theremin",
    "Drum kit", "Drum machine", "Drum", "Snare drum", "Bass drum", "Timpani", "Tabla", "Hi-hat", "Cymbal",
    "Percussion", "Rimshot", "Drum roll", "Tambourine", "Maraca", "Cowbell", "Gong", "Wood block", "Clapping",
    "Mallet percussion", "Marimba, xylophone", "Glockenspiel", "Vibraphone", "Steelpan", "Bell", "Tubular bells",
    "Orchestra", "Bowed string instrument", "String section", "Violin, fiddle", "Cello", "Double bass", "Harp",
    "Brass instrument", "Trumpet", "Trombone", "French horn",
    "Wind instrument, woodwind instrument", "Flute", "Saxophone", "Clarinet", "Harmonica", "Accordion", "Bagpipes",
    "Scratching (performance technique)", "Beatboxing",
]
GENRES = ["Pop music", "Hip hop music", "Rock music", "Heavy metal", "Punk rock", "Rhythm and blues", "Soul music",
          "Reggae", "Country", "Funk", "Folk music", "Jazz", "Disco", "Classical music", "Electronic music",
          "House music", "Techno", "Dubstep", "Drum and bass", "Electronica", "Electronic dance music",
          "Ambient music", "Trance music", "Music of Latin America", "Blues", "New-age music", "Vocal music",
          "A capella", "Soundtrack music", "Video game music", "Christian music", "Gospel music", "Lo-fi music" if False else "Independent music"]
ELECTRONIC = ["Synthesizer", "Drum machine", "Sampler", "Electronic music", "Techno", "House music", "Dubstep",
              "Electronica", "Electronic dance music", "Trance music", "Drum and bass"]
ACOUSTIC = ["Acoustic guitar", "Piano", "Drum kit", "Violin, fiddle", "Cello", "Double bass", "Saxophone", "Trumpet",
            "Flute", "Clarinet", "Orchestra", "String section", "Harp", "Trombone", "Banjo", "Mandolin", "Choir"]

_MODEL = None
FPS = 2  # probability frames per second after window averaging


def model():
    global _MODEL
    if _MODEL is None:
        import contextlib
        import io
        from pathlib import Path
        from panns_inference import AudioTagging
        ck = Path.home() / "panns_data" / "Cnn14_mAP=0.431.pth"
        with contextlib.redirect_stdout(io.StringIO()):
            _MODEL = AudioTagging(checkpoint_path=str(ck), device="cpu")
    return _MODEL


def frame_probs(path, win=10.0, hop=5.0):
    """Clip-level tagging on 10 s windows every 5 s, spread to FPS frames (overlapping windows averaged)."""
    import librosa
    y, _ = load(path, mono=True)
    y = librosa.resample(y, orig_sr=44100, target_sr=32000)
    m = model()
    n = len(y) / 32000
    starts = np.arange(0, max(n - win, 0) + hop, hop)
    segs = []
    for s in starts:
        seg = y[int(s * 32000):int((s + win) * 32000)]
        if len(seg) < 32000 * 2:
            seg = np.pad(seg, (0, 32000 * 2 - len(seg)))
        segs.append(seg)
    out = []
    for i in range(0, len(segs), 8):
        L = max(len(x) for x in segs[i:i + 8])
        batch = np.stack([np.pad(x, (0, L - len(x))) for x in segs[i:i + 8]])
        c, _ = m.inference(batch)
        out.append(np.asarray(c))
    C = np.concatenate(out, 0)
    nf = int(np.ceil(n * FPS))
    P = np.zeros((nf, C.shape[1]))
    W = np.zeros(nf)
    for s, c in zip(starts, C):
        a, b = int(s * FPS), min(nf, int((s + win) * FPS))
        P[a:b] += c
        W[a:b] += 1
    return P / np.maximum(W, 1)[:, None]


def per_bar(P, bars, fps=FPS):
    from panns_inference import labels
    idx = {l: i for i, l in enumerate(labels)}
    res = np.zeros((len(bars), len(labels)))
    for j, b in enumerate(bars):
        a, e = int(max(b["start"], 0) * fps), int(np.ceil(b["end"] * fps))
        a = min(a, len(P) - 1)
        res[j] = P[a:max(a + 1, min(e, len(P)))].mean(0)
    return res, idx


def ranges(active, bars):
    out, start = [], None
    for j, a in enumerate(list(active) + [False]):
        if a and start is None:
            start = j
        if not a and start is not None:
            out.append([start + 1, j, round(max(bars[start]["start"], 0), 2), round(bars[j - 1]["end"], 2)])
            start = None
    return out


def summarize(P, bars, thr, names):
    B, idx = per_bar(P, bars)
    res = []
    for n in names:
        if n not in idx:
            continue
        col = B[:, idx[n]]
        act = col >= thr
        if act.sum() == 0 and float(P[:, idx[n]].mean()) < thr:
            continue
        res.append({"label": n, "mean_prob": round(float(P[:, idx[n]].mean()), 3),
                    "max_bar_prob": round(float(col.max()), 3), "bars_present": int(act.sum()),
                    "share_of_song": round(float(act.mean()), 2), "ranges_bars": ranges(act, bars)})
    return sorted(res, key=lambda r: -r["max_bar_prob"])


def analyze(mix_path, stems: dict, bars, fast=False):
    src = f"PANNs Cnn14 clip tagger, 10 s windows / 5 s hop (panns_inference {ver('panns-inference')}, AudioSet)"
    P = frame_probs(mix_path)
    out = {"mix": item(summarize(P, bars, 0.08, INSTRUMENTS), None, src, threshold=0.08),
           "genre_hints": item(summarize(P, bars, 0.08, GENRES)[:6], None, src)}
    from panns_inference import labels
    idx = {l: i for i, l in enumerate(labels)}
    e = float(sum(P[:, idx[n]].mean() for n in ELECTRONIC if n in idx))
    a = float(sum(P[:, idx[n]].mean() for n in ACOUSTIC if n in idx))
    share = e / (e + a + 1e-9)
    out["electronic_vs_acoustic"] = item({"electronic_share": round(share, 2),
                                          "verdict": "mostly electronic" if share > 0.65 else "mostly acoustic" if share < 0.35 else "mixed"},
                                         min(1.0, abs(share - 0.5) * 2 + 0.3), src)
    per_stem = {}
    for name, p in stems.items():
        Ps = frame_probs(p)
        per_stem[name] = summarize(Ps, bars, 0.10, INSTRUMENTS)[:8]
        if name == "vocals":
            vi = [idx[n] for n in ("Singing", "Male singing", "Female singing", "Choir", "Rapping", "Speech")]
            out["vocal_frame_prob"] = Ps[:, vi].max(1)
    out["stems"] = item(per_stem, None, src, threshold=0.10)
    return out
