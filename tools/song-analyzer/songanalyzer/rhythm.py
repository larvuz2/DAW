"""Tempo, beats, downbeats, meter, swing, tempo stability.

Primary tracker: Beat This! (CPJKU, ISMIR 2024, MIT). Second opinion: madmom RNN + DBN downbeat tracker.
Third opinion (when the structure stage ran): All-In-One (allin1) beats.
Decision rule: if the beats are steady (a constant-tempo grid explains them within 25 ms), the grid
fitted to the primary tracker's beats is used for the whole song (this also fills intros/outros where
no beat was detected); otherwise the detected beats are used as they are.
"""
from __future__ import annotations

import numpy as np

from .common import item, ver


def _fmeasure(ref, est, win=0.07):
    if len(ref) == 0 or len(est) == 0:
        return 0.0
    import mir_eval
    return float(mir_eval.beat.f_measure(np.asarray(ref), np.asarray(est), f_measure_threshold=win))


def track_beat_this(path, fast: bool):
    from beat_this.inference import File2Beats
    ck = "small0" if fast else "final0"
    b, d = File2Beats(checkpoint_path=ck, device="cpu", dbn=False)(str(path))
    return np.asarray(b, float), np.asarray(d, float), f"beat_this {ver('beat-this')} ({ck})"


def track_madmom(path):
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor, RNNDownBeatProcessor
    act = RNNDownBeatProcessor()(str(path))
    res = DBNDownBeatTrackingProcessor(beats_per_bar=[2, 3, 4], fps=100)(act)
    beats = res[:, 0]
    downs = res[res[:, 1] == 1, 0]
    bpb = int(np.max(res[:, 1])) if len(res) else 4
    return beats, downs, bpb, f"madmom {ver('madmom')} (RNNDownBeat + DBN)"


def fit_grid(beats: np.ndarray):
    """Least-squares constant-tempo grid through the beats, robust to missing, extra and off-beat detections.
    The period comes from the most common inter-beat interval; the phase from the circular mean of beat phases."""
    beats = np.asarray(beats, float)
    if len(beats) < 8:
        return None
    ibi = np.diff(beats)
    hist, edges = np.histogram(ibi, bins=np.arange(0.2, 2.0, 0.01))
    k = int(np.argmax(np.convolve(hist, np.ones(3), mode="same")))
    near = ibi[np.abs(ibi - (edges[k] + 0.005)) < 0.03]
    period = float(np.median(near)) if len(near) else float(np.median(ibi))
    ang = 2 * np.pi * beats / period
    off = (np.angle(np.mean(np.exp(1j * ang))) / (2 * np.pi)) * period
    idx = np.round((beats - off) / period)
    keep = np.abs(beats - (off + period * idx)) < 0.07
    for _ in range(3):
        if keep.sum() < 8:
            return None
        A = np.vstack([np.ones(keep.sum()), idx[keep]]).T
        (a, p), *_ = np.linalg.lstsq(A, beats[keep], rcond=None)
        idx = np.round((beats - a) / p)
        keep = np.abs(beats - (a + p * idx)) < 0.07
    resid = beats[keep] - (a + p * idx[keep])
    n_grid = int(np.round((beats[keep].max() - beats[keep].min()) / p)) + 1
    return {"offset": float(a), "period": float(p), "resid_ms": float(np.std(resid) * 1000),
            "inlier_share": float(keep.mean()), "coverage": float(len(np.unique(idx[keep])) / max(n_grid, 1))}


def analyze(mix_path, duration: float, drum_path=None, allin1=None, fast=False, downbeat_shift: int = 0):
    out = {}
    b1, d1, src1 = track_beat_this(mix_path, fast)
    try:
        b2, d2, bpb2, src2 = track_madmom(mix_path)
    except Exception as e:  # pragma: no cover
        b2, d2, bpb2, src2 = np.array([]), np.array([]), None, f"madmom failed: {e}"
    opinions = {"beat_this": {"beats": len(b1), "downbeats": len(d1), "source": src1},
                "madmom": {"beats": len(b2), "downbeats": len(d2), "beats_per_bar": bpb2, "source": src2}}
    agree = {"beat_this_vs_madmom_F": _fmeasure(b1, b2)}
    if allin1 is not None and len(allin1.get("beats", [])):
        b3 = np.asarray(allin1["beats"])
        opinions["allin1"] = {"beats": len(b3), "bpm": allin1.get("bpm"), "source": allin1.get("source")}
        agree["beat_this_vs_allin1_F"] = _fmeasure(b1, b3)
        agree["madmom_vs_allin1_F"] = _fmeasure(b2, b3)

    grids = {"beat_this": fit_grid(b1), "madmom": fit_grid(b2) if len(b2) else None}
    def good(g):
        return g is not None and g["resid_ms"] < 25 and g["inlier_share"] > 0.7 and g["coverage"] > 0.8
    ok = [k for k, g in grids.items() if good(g)]
    steady = bool(ok)
    if steady:
        best = min(ok, key=lambda k: grids[k]["resid_ms"] / grids[k]["inlier_share"])
        grid = grids[best]
        beats_detected = b1 if best == "beat_this" else b2
        P, a = grid["period"], grid["offset"]
        n0 = int(np.floor((0 - a) / P))
        n1 = int(np.ceil((duration - a) / P))
        beats = a + P * np.arange(n0, n1 + 1)
        beats = beats[(beats > -P / 2) & (beats < duration)]
        beat_choice = f"constant-tempo grid fitted to {best} beats"
    else:
        # moving tempo: the DBN-decoded madmom beats are continuous (no extra/missing beats), which bars need
        grid = grids["madmom"] or grids["beat_this"]
        beats_detected = b2 if len(b2) >= 8 else b1
        beats = beats_detected
        beat_choice = "madmom DBN beats (tempo moves)" if beats_detected is b2 else "beat_this beats"
    out["grids"] = grids
    # meter: beats per bar from downbeat spacing (beat_this), cross-checked with madmom's DBN choice
    def bpb_from(downs, bts):
        if len(downs) < 3:
            return None, 0.0
        ii = [int(np.argmin(np.abs(bts - d))) for d in downs]
        diffs = np.diff(ii)
        diffs = diffs[(diffs >= 2) & (diffs <= 7)]
        if not len(diffs):
            return None, 0.0
        vals, cnt = np.unique(diffs, return_counts=True)
        return int(vals[np.argmax(cnt)]), float(cnt.max() / cnt.sum())

    bpb1, share1 = bpb_from(d1, beats)
    bpb = bpb1 or bpb2 or 4
    if bpb1 and bpb2 and bpb1 != bpb2 and share1 < 0.7:
        bpb = bpb2
    meter_conf = share1 * (1.0 if bpb2 in (None, bpb) else 0.6)
    # downbeat phase: which beat index (mod bpb) the downbeats fall on
    votes = {}
    for w, dd in ((1.0, d1), (1.0, d2)):
        for d in dd:
            j = int(np.argmin(np.abs(beats - d)))
            if abs(beats[j] - d) < 0.1:
                votes[j % bpb] = votes.get(j % bpb, 0) + w
    if votes:
        phase = max(votes, key=votes.get)
        phase_share = votes[phase] / sum(votes.values())
    else:
        phase, phase_share = 0, 0.0
    agree["downbeat_phase_vote_share"] = round(phase_share, 3)
    # the listener's correction (--downbeat-shift N): bar lines N beats later than the vote put them. Use it when the
    # vote share is low and the chords change in the middle of the bars instead of on the bar lines.
    if downbeat_shift:
        phase = (phase + int(downbeat_shift)) % bpb
        agree["downbeat_shift_beats"] = int(downbeat_shift)
    # Bar 1 starts on the first downbeat; beats before it (a pickup) get virtual beats prepended on the
    # grid so that bar 1 is complete (its start may then be slightly before t = 0).
    P = grid["period"] if steady else float(np.median(np.diff(beats)))
    f = phase % bpb
    if f > 0:
        pre = beats[0] - P * np.arange(bpb - f, 0, -1)
        beats = np.concatenate([pre, beats])
    downbeats = beats[::bpb]
    bars = []
    for i, s in enumerate(downbeats):
        e = downbeats[i + 1] if i + 1 < len(downbeats) else s + bpb * P
        bars.append({"bar": i + 1, "start": float(s), "end": float(e)})

    # tempo curve from detected beats
    ibi = np.diff(beats_detected)
    loc = 60.0 / np.maximum(ibi, 1e-3)
    if len(loc) >= 5:
        from scipy.signal import medfilt
        loc_s = medfilt(loc, 5)
    else:
        loc_s = loc
    curve = [[float(t), float(v)] for t, v in zip(beats_detected[1:], loc_s)]
    bpm = 60.0 / P if steady else 60.0 / float(np.median(np.diff(beats_detected)))
    cv = float(np.std(loc_s) / np.mean(loc_s)) if len(loc_s) else None
    if steady:
        stability = "steady (click-tracked or quantized)"
    elif cv is not None and cv < 0.03:
        stability = "nearly steady (live band with a stable pulse)"
    else:
        stability = "free / varying tempo"

    tempo_conf = min(1.0, 0.5 + 0.5 * agree["beat_this_vs_madmom_F"]) if len(b2) else 0.6
    out["tempo_bpm"] = item(round(bpm, 2), tempo_conf, src1 if steady else src1,
                            method="grid fit through tracked beats" if steady else "median inter-beat interval",
                            alternatives={"half": round(bpm / 2, 2), "double": round(bpm * 2, 2),
                                          "madmom": round(60 / np.median(np.diff(b2)), 2) if len(b2) > 2 else None,
                                          "allin1": (allin1 or {}).get("bpm")})
    out["tempo_curve"] = item(curve, None, src1, unit="[time_s, bpm]")
    out["tempo_stability"] = item(stability, 0.8, src1, ibi_cv=cv, grid=grid)
    out["time_signature"] = item(f"{bpb}/4", meter_conf, f"{src1} + {src2}",
                                 note="x/4 assumed for the beat unit; compound meters (6/8, 12/8) show as 2/4 or 4/4 with triplet swing")
    out["beats"] = item([float(b) for b in beats], min(1.0, tempo_conf), beat_choice)
    out["downbeats"] = item([float(d) for d in downbeats], min(1.0, 0.3 + 0.7 * phase_share), src1)
    out["bars"] = bars
    out["detected_beats"] = {"beat_this": b1.tolist(), "madmom": b2.tolist(),
                             "beat_this_downbeats": d1.tolist(), "madmom_downbeats": d2.tolist()}
    out["opinions"] = opinions
    out["agreement"] = agree
    out["lead_in_s"] = float(max(0.0, beats_detected[0])) if len(beats_detected) else None
    out["swing"] = swing(drum_path or mix_path, beats, P)
    return out


def swing(path, beats, period):
    """Swing from where off-beat onsets fall inside the beat (0.50 straight, 0.67 triplet shuffle)."""
    import librosa
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    y = librosa.effects.preemphasis(y)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=256, fmin=3000, fmax=10000) if hasattr(librosa.onset, "onset_strength") else None
    on = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=256, units="time", backtrack=False)
    res = {}
    for level, div in (("8th", 1.0), ("16th", 2.0)):
        ph = []
        for t in on:
            i = np.searchsorted(beats, t) - 1
            if i < 0 or i + 1 >= len(beats):
                continue
            f = (t - beats[i]) / (beats[i + 1] - beats[i]) * div
            f = f - np.floor(f)
            if 0.38 <= f <= 0.8:
                ph.append(f)
        if len(ph) >= 8:
            res[level] = {"ratio": round(float(np.median(ph)), 3), "offbeat_onsets": len(ph)}
    if not res:
        return item(None, 0.0, f"librosa {ver('librosa')} onsets", note="too few off-beat onsets")
    lvl = max(res, key=lambda k: res[k]["offbeat_onsets"])
    r = res[lvl]["ratio"]
    desc = "straight" if r < 0.54 else ("light swing" if r < 0.6 else ("triplet shuffle" if r < 0.7 else "hard swing"))
    conf = min(1.0, res[lvl]["offbeat_onsets"] / 60)
    return item({"level": lvl, "ratio": r, "feel": desc, "percent": round(r * 100)}, conf,
                f"librosa {ver('librosa')} onset phases (3-10 kHz)", levels=res)
