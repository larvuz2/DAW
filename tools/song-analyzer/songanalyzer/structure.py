"""Song structure: sections with labels, repeats, bar counts, energy arc, builds and drops.

Primary: All-In-One (allin1 1.1, MIT; Kim & Nam, WASPAA 2023) - trained on the Harmonix Set, predicts
functional labels (intro, verse, chorus, bridge, inst, solo, outro, break, start, end) plus beats.
Second opinion: a bar-synchronous self-similarity novelty segmentation (chroma + MFCC + loudness) that
also groups repeated sections into letters (A, B, C ...). Boundaries are snapped to bar lines.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from .common import SR, item, load, log, ver


def _patch_natten():
    """allin1 1.1 calls the NATTEN <0.17 API; map it onto natten 0.17's functional ops (same layout)."""
    import torch
    if not torch.cuda.is_available():
        torch.cuda.get_device_capability = lambda *a, **k: (0, 0)
    import natten.functional as F
    if not hasattr(F, "natten1dqkrpb"):
        F.natten1dqkrpb = lambda q, k, rpb, ks, d: F.na1d_qk(q, k, ks, d, rpb=rpb)
        F.natten2dqkrpb = lambda q, k, rpb, ks, d: F.na2d_qk(q, k, ks, d, rpb=rpb)
        F.natten1dav = lambda a, v, ks, d: F.na1d_av(a, v, ks, d)
        F.natten2dav = lambda a, v, ks, d: F.na2d_av(a, v, ks, d)


def run_allin1(mix_path: Path, stems: dict, work: Path, fast: bool):
    _patch_natten()
    import allin1
    import soundfile as sf
    name = mix_path.stem
    demix = work / "allin1_demix"
    d = demix / "htdemucs" / name
    if all(k in stems for k in ("vocals", "drums", "bass", "other")):
        d.mkdir(parents=True, exist_ok=True)
        for k in ("vocals", "drums", "bass"):
            x, sr = load(stems[k])
            sf.write(str(d / f"{k}.wav"), x.T, sr)
        o = None
        for k in ("other", "guitar", "piano"):
            if k in stems:
                x, sr = load(stems[k])
                o = x if o is None else o[:, : x.shape[1]] + x[:, : o.shape[1]]
        sf.write(str(d / "other.wav"), o.T, sr)
    model = "harmonix-fold0" if fast else "harmonix-all"
    cache = work / f"allin1_{model}" / f"{name}.json"
    if cache.exists():  # allin1 1.1 crashes when its own result cache is hit, so read the JSON ourselves
        import json
        j = json.loads(cache.read_text())
        segs = [{"start": float(s["start"]), "end": float(s["end"]), "label": s["label"]} for s in j["segments"]]
        return {"bpm": j["bpm"], "beats": j["beats"], "downbeats": j["downbeats"], "segments": segs,
                "source": f"allin1 {ver('allin1')} ({model})"}
    r = allin1.analyze(str(mix_path), model=model, device="cpu", out_dir=str(work / f"allin1_{model}"),
                       demix_dir=str(demix), spec_dir=str(work / "allin1_spec"), keep_byproducts=False)
    segs = [{"start": float(s.start), "end": float(s.end), "label": s.label} for s in r.segments]
    return {"bpm": r.bpm, "beats": list(map(float, r.beats)), "downbeats": list(map(float, r.downbeats)),
            "segments": segs, "source": f"allin1 {ver('allin1')} ({model})"}


def bar_features(mix_path, bars):
    import librosa
    y, _ = load(mix_path, mono=True)
    hop = 1024
    C = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=hop)
    M = librosa.feature.mfcc(y=y, sr=SR, hop_length=hop, n_mfcc=13)
    t = librosa.times_like(C, sr=SR, hop_length=hop)
    F, E = [], []
    for b in bars:
        m = (t >= b["start"]) & (t < b["end"])
        if m.sum() == 0:
            F.append(np.zeros(25 + 1))
            E.append(-90)
            continue
        c = C[:, m].mean(1)
        c = c / (np.linalg.norm(c) + 1e-9)
        mf = M[1:, m].mean(1)
        a, bb = int(max(b["start"], 0) * SR), int(b["end"] * SR)
        e = 20 * np.log10(np.sqrt(np.mean(y[a:bb] ** 2)) + 1e-9) if bb > a else -90
        F.append(np.concatenate([c, mf / 50.0, [e / 20.0]]))
        E.append(e)
    return np.array(F), np.array(E)


def novelty_segments(F, min_len=None, kernel=8):
    n = len(F)
    if min_len is None:
        min_len = 8 if n >= 64 else 4
    if n < 2 * min_len:
        return [0, n], np.zeros(n)
    Fn = (F - F.mean(0)) / (F.std(0) + 1e-9)
    Fn /= np.linalg.norm(Fn, axis=1, keepdims=True) + 1e-9
    S = Fn @ Fn.T
    k = min(kernel, n // 2)
    g = np.outer(np.r_[-np.ones(k), np.ones(k)], np.r_[-np.ones(k), np.ones(k)]) * -1
    g *= np.outer(np.hanning(2 * k), np.hanning(2 * k))
    Sp = np.pad(S, k, mode="edge")
    nov = np.array([np.sum(Sp[i:i + 2 * k, i:i + 2 * k] * g) for i in range(n)])
    nov = np.maximum(nov, 0)
    th = nov.mean() + 0.5 * nov.std()
    max_peaks = max(2, int(round(n / 12)))
    peaks = []
    for i in np.argsort(-nov):
        if len(peaks) >= max_peaks:
            break
        if nov[i] < th or i < min_len or i > n - min_len // 2:
            continue
        if all(abs(i - p) >= min_len for p in peaks):
            peaks.append(int(i))
    # prefer multiples of 4 bars: snap a boundary by one bar when that lands on a 4-bar line
    snapped = []
    for p in sorted(peaks):
        for cand in (p, p - 1, p + 1):
            if cand % 4 == 0:
                p = cand
                break
        snapped.append(p)
    return sorted(set([0] + snapped + [n])), nov


def group_segments(F, bounds, thresh=0.6):
    """Letters by cosine similarity of standardized mean bar features (z-scored across the song)."""
    Z = (F - F.mean(0)) / (F.std(0) + 1e-9)
    means = [Z[a:b].mean(0) for a, b in zip(bounds[:-1], bounds[1:])]
    letters, protos = [], []
    for m in means:
        mn = m / (np.linalg.norm(m) + 1e-9)
        sims = [float(mn @ p) for p in protos]
        if sims and max(sims) > thresh:
            letters.append(int(np.argmax(sims)))
        else:
            protos.append(mn)
            letters.append(len(protos) - 1)
    return [chr(65 + l) for l in letters]


def heuristic_labels(letters, energies):
    n = len(letters)
    lab = [None] * n
    from collections import Counter
    cnt = Counter(letters)
    e = np.array(energies)
    rep = [l for l in cnt if cnt[l] > 1]
    chorus = max(rep, key=lambda l: np.mean([e[i] for i in range(n) if letters[i] == l])) if rep else None
    for i, l in enumerate(letters):
        if l == chorus:
            lab[i] = "chorus"
        elif cnt[l] > 1:
            lab[i] = "verse"
        else:
            lab[i] = "bridge"
    if n > 2 and e[0] < np.median(e) - 2 and letters[0] != chorus:
        lab[0] = "intro"
    if n > 2 and e[-1] < np.median(e) - 2 and letters[-1] != chorus:
        lab[-1] = "outro"
    return lab


def analyze(mix_path, stems, rhythm, work, fast=False, use_allin1=True):
    bars = rhythm["bars"]
    F, E = bar_features(mix_path, bars)
    bounds, nov = novelty_segments(F)
    letters = group_segments(F, bounds)
    out = {"bar_energy_db": item([round(float(x), 1) for x in E], 0.95, "RMS per bar (mix)")}
    a1 = None
    if use_allin1:
        try:
            a1 = run_allin1(mix_path, stems, work, fast)
        except Exception as e:
            log(f"allin1 failed: {e}")
            out["allin1_error"] = str(e)

    def bar_at(t):
        starts = np.array([b["start"] for b in bars])
        return int(np.argmin(np.abs(starts - t)))

    sections = []
    if a1:
        # allin1's own segment boundaries are kept (they usually fall on 4/8-bar phrases); "start"/"end"
        # segments (silence or a pickup) shorter than 4 bars join their neighbour.
        for s in a1["segments"]:
            a, b = bar_at(s["start"]), bar_at(s["end"])
            if b <= a:
                continue
            lbl = s["label"]
            if lbl in ("start", "end") and b - a < 4:
                if sections and lbl == "end":
                    sections[-1]["bar_end"] = b
                    continue
                if lbl == "start":
                    pending_start = a
                    continue
            if lbl in ("start", "end"):
                lbl = "intro" if lbl == "start" else "outro"
            sections.append({"label": lbl, "bar_start": a, "bar_end": b, "source": a1["source"]})
        if sections:
            sections[-1]["bar_end"] = max(sections[-1]["bar_end"], len(bars))
            sections[0]["bar_start"] = 0
        # Decision rule: allin1 is trained on pop songs and can return a few very long sections on other
        # material. Novelty boundaries inside an allin1 section of 16+ bars that are 4+ bars from its edges
        # split it; the parts keep the label (marked "split_by": "novelty").
        refined = []
        for s in sections:
            cuts = [c for c in bounds[1:-1] if s["bar_start"] + 4 <= c <= s["bar_end"] - 4] if s["bar_end"] - s["bar_start"] >= 16 else []
            edges = [s["bar_start"]] + cuts + [s["bar_end"]]
            for k, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
                d = dict(s, bar_start=a, bar_end=b)
                if cuts:
                    d["split_by"] = "novelty"
                refined.append(d)
        sections = refined
    novelty_secs = [{"bar_start": a, "bar_end": b, "letter": l} for a, b, l in zip(bounds[:-1], bounds[1:], letters)]
    if not sections:
        seg_e = [float(np.mean(E[a:b])) for a, b in zip(bounds[:-1], bounds[1:])]
        labs = heuristic_labels(letters, seg_e)
        sections = [{"label": lb, "bar_start": a, "bar_end": b, "source": "SSM novelty + heuristics"}
                    for (a, b), lb in zip(zip(bounds[:-1], bounds[1:]), labs)]
    # letters for the chosen sections via feature similarity
    sb = [s["bar_start"] for s in sections] + [sections[-1]["bar_end"]]
    sl = group_segments(F, sb)
    # agreement of boundaries
    b1 = set(s["bar_start"] for s in sections[1:])
    b2 = set(bounds[1:-1])
    hit = sum(1 for b in b1 if any(abs(b - c) <= 1 for c in b2))
    agree = hit / max(len(b1), 1) if b1 else 1.0
    med = float(np.median(E))
    for i, s in enumerate(sections):
        a, b = s["bar_start"], s["bar_end"]
        s["bars"] = b - a
        s["bar_range"] = f"{a + 1}-{b}"
        s["start"] = round(max(bars[a]["start"], 0.0), 3)
        s["end"] = round(bars[b - 1]["end"], 3)
        s["letter"] = sl[i]
        s["energy_db"] = round(float(np.mean(E[a:b])), 1)
        s["energy_rel"] = round(float(np.mean(E[a:b]) - med), 1)
    # repeats
    from collections import defaultdict
    groups = defaultdict(list)
    for i, s in enumerate(sections):
        groups[s["letter"]].append(i + 1)
    # builds and drops from bar energy
    events = []
    dE = np.diff(E)
    for i in range(1, len(E)):
        prev = np.mean(E[max(0, i - 2):i])
        if E[i] - prev >= 6:
            events.append({"bar": i + 1, "type": "drop/impact", "delta_db": round(float(E[i] - prev), 1)})
        elif prev - E[i] >= 6 and E[i] > -60:
            events.append({"bar": i + 1, "type": "breakdown", "delta_db": round(float(E[i] - prev), 1)})
    i = 0
    while i < len(dE):
        j = i
        while j < len(dE) and dE[j] > 0.3:
            j += 1
        if j - i >= 3 and E[j] - E[i] >= 4:
            events.append({"bar": i + 1, "type": "build", "to_bar": j + 1, "delta_db": round(float(E[j] - E[i]), 1)})
        i = max(j, i + 1)
    out["sections"] = item(sections, (0.55 if a1 else 0.35) + 0.3 * agree,
                           (a1["source"] if a1 else "SSM novelty") + " ; letters by bar-feature similarity",
                           boundary_agreement_with_novelty=round(agree, 2))
    out["novelty_sections"] = novelty_secs
    out["repeats"] = {k: v for k, v in groups.items()}
    out["energy_events"] = events
    out["allin1"] = a1
    return out
