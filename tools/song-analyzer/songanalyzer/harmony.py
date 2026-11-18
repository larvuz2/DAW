"""Tuning, key (global and per section), chords per bar, bass notes, harmonic rhythm.

Key voters: madmom CNN key classifier (mix), Essentia KeyExtractor (EDMA profile, harmonic stems) and a key
inferred from the detected chords. Majority wins; confidence reflects agreement.
Chord estimators: madmom CNN + CRF (major/minor vocabulary, trained) and an extended-vocabulary template
matcher (7ths, sus, dim) on beat-synchronous chroma of the harmonic stems with the bass stem's pitch class,
smoothed with a Viterbi pass. The extended label is used when its root and major/minor quality agree with
madmom; otherwise madmom's triad is reported and the template label is kept as an alternative.
"""
from __future__ import annotations

import numpy as np

from .common import SR, item, load, ver

NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
SHARP = {"A#": "Bb", "D#": "Eb", "G#": "Ab", "Db": "C#", "Gb": "F#", "Cb": "B", "Fb": "E", "E#": "F", "B#": "C"}

# quality -> (intervals, weights, suffix, triad family)
QUALS = {
    "maj": ([0, 4, 7], [1, 1, 1], "", "maj"),
    "min": ([0, 3, 7], [1, 1, 1], "m", "min"),
    "7": ([0, 4, 7, 10], [1, 1, 1, .8], "7", "maj"),
    "maj7": ([0, 4, 7, 11], [1, 1, 1, .8], "maj7", "maj"),
    "min7": ([0, 3, 7, 10], [1, 1, 1, .8], "m7", "min"),
    "sus4": ([0, 5, 7], [1, 1, 1], "sus4", "sus"),
    "sus2": ([0, 2, 7], [1, 1, 1], "sus2", "sus"),
    "dim": ([0, 3, 6], [1, 1, 1], "dim", "dim"),
    "hdim7": ([0, 3, 6, 10], [1, 1, 1, .8], "m7b5", "dim"),
    "aug": ([0, 4, 8], [1, 1, 1], "aug", "aug"),
}
PRIOR = {"maj": 0.0, "min": 0.0, "7": -0.02, "maj7": -0.02, "min7": -0.02, "sus4": -0.04, "sus2": -0.05,
         "dim": -0.06, "hdim7": -0.05, "aug": -0.08}


def pc(name: str) -> int:
    name = SHARP.get(name, name)
    return NOTES.index(name)


def chord_name(root: int, q: str, bass: int | None = None) -> str:
    s = NOTES[root] + QUALS[q][2]
    if bass is not None and bass != root:
        s += "/" + NOTES[bass]
    return s


def _templates():
    labels, T = [], []
    for r in range(12):
        for q, (iv, w, _, _) in QUALS.items():
            v = np.zeros(12)
            for i, ww in zip(iv, w):
                v[(r + i) % 12] = ww
            T.append(v / np.linalg.norm(v))
            labels.append((r, q))
    return labels, np.array(T)


def harmonic_signal(stems: dict, mix_path):
    """Mono sum of pitched stems without drums and vocals (vocals confuse chord templates)."""
    keys = [k for k in ("bass", "other", "piano", "guitar") if k in stems]
    if not keys:
        return load(mix_path, mono=True)[0], "mix"
    y = None
    for k in keys:
        x, _ = load(stems[k], mono=True)
        y = x if y is None else y[: len(x)] + x[: len(y)]
    return y, "+".join(keys)


def tuning(y):
    import librosa
    cents = float(librosa.estimate_tuning(y=y[: SR * 120], sr=SR, bins_per_octave=36)) * (1200 / 36)
    a4 = 440.0 * 2 ** (cents / 1200)
    out = {"a4_hz": round(a4, 2), "cents_from_440": round(cents, 1)}
    conf = 0.7
    try:
        import essentia.standard as es
        freq, _ = es.TuningFrequencyExtractor()(y[: SR * 120].astype(np.float32))
        ess = float(np.median(freq))
        out["essentia_a4_hz"] = round(ess, 2)
        conf = 0.9 if abs(1200 * np.log2(ess / a4)) < 5 else 0.5
    except Exception:
        pass
    return item(out, conf, f"librosa {ver('librosa')} estimate_tuning + essentia TuningFrequencyExtractor")


def key_madmom(path):
    from madmom.features.key import CNNKeyRecognitionProcessor
    p = CNNKeyRecognitionProcessor()(str(path))[0]
    # madmom order: A major, Bb major, ..., then A minor ... (see key_prediction_to_label)
    from madmom.features.key import KEY_LABELS
    i = int(np.argmax(p))
    lab = KEY_LABELS[i]
    tonic, mode = lab.split(" ")
    return NOTES[pc(tonic)] + " " + mode, float(p[i])


def key_essentia(y, profile="edma"):
    import essentia.standard as es
    k, scale, strength = es.KeyExtractor(profileType=profile, sampleRate=SR)(y.astype(np.float32))
    return NOTES[pc(k)] + " " + scale, float(strength)


def key_from_chords(chords):
    """Score the 24 keys by how much chord time is diatonic, weighting tonic and dominant chords."""
    if not chords:
        return None, 0.0
    best, scores = None, {}
    maj_scale = [0, 2, 4, 5, 7, 9, 11]
    for tonic in range(12):
        for mode in ("major", "minor"):
            sc = [(tonic + i) % 12 for i in maj_scale] if mode == "major" else [(tonic + i) % 12 for i in [0, 2, 3, 5, 7, 8, 10]]
            s = 0.0
            for c in chords:
                d = c["end"] - c["start"]
                r, fam = c["root"], c["family"]
                if r is None:
                    continue
                tones = [(r + i) % 12 for i in QUALS[c["quality"]][0]]
                inside = np.mean([t in sc for t in tones])
                s += d * inside
                if r == tonic and ((mode == "major" and fam == "maj") or (mode == "minor" and fam == "min")):
                    s += d * 0.6
                if r == (tonic + 7) % 12 and fam == "maj":
                    s += d * 0.2
            scores[f"{NOTES[tonic]} {mode}"] = s
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    tot = ranked[0][1] + 1e-9
    return ranked[0][0], float((ranked[0][1] - ranked[1][1]) / tot + 0.5)


def relative(k: str) -> str:
    t, m = k.split(" ")
    i = pc(t)
    return f"{NOTES[(i + 3) % 12]} major" if m == "minor" else f"{NOTES[(i - 3) % 12]} minor"


def chords_madmom(path):
    from madmom.features.chords import CNNChordFeatureProcessor, CRFChordRecognitionProcessor
    seg = CRFChordRecognitionProcessor()(CNNChordFeatureProcessor()(str(path)))
    out = []
    for s, e, lab in seg:
        if lab == "N":
            out.append({"start": float(s), "end": float(e), "root": None, "quality": None, "family": None, "label": "N"})
            continue
        r, q = lab.split(":")
        q = "maj" if q == "maj" else "min"
        out.append({"start": float(s), "end": float(e), "root": pc(r), "quality": q, "family": q,
                    "label": chord_name(pc(r), q)})
    return out


def chords_template(y, beats, bass_y=None, cents=0.0):
    import librosa
    hop = 512
    C = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=hop, tuning=cents / 100, n_chroma=12, bins_per_octave=36)
    fr = librosa.time_to_frames(np.asarray(beats), sr=SR, hop_length=hop)
    fr = np.clip(fr, 0, C.shape[1] - 1)
    Cs = librosa.util.sync(C, fr, aggregate=np.median)  # segments between beats
    bounds = np.concatenate([[0], beats, [len(y) / SR]]) if False else None
    # beat-synchronous segments: [beats[i], beats[i+1]]
    seg_t = list(zip([0.0] + list(beats), list(beats) + [len(y) / SR]))
    Cs = Cs[:, : len(seg_t)]
    if bass_y is not None:
        B = librosa.feature.chroma_cqt(y=bass_y, sr=SR, hop_length=hop, fmin=librosa.note_to_hz("C1"), n_octaves=4,
                                       tuning=cents / 100)
        Bs = librosa.util.sync(B, fr, aggregate=np.median)[:, : len(seg_t)]
    else:
        Bs = None
    labels, T = _templates()
    energy = Cs.sum(0)
    Cn = Cs / (np.linalg.norm(Cs, axis=0, keepdims=True) + 1e-9)
    S = T @ Cn  # (n_labels, n_beats)
    S += np.array([PRIOR[q] for _, q in labels])[:, None]
    if Bs is not None:
        bpc = np.argmax(Bs, axis=0)
        bstr = Bs.max(0) / (Bs.sum(0) + 1e-9)
        for j, (r, q) in enumerate(labels):
            S[j] += 0.08 * (bpc == r) * (bstr > 0.15)
    # Viterbi with a strong self-transition
    n, m = S.shape
    beta = 25.0
    logp = beta * S
    stay, move = np.log(0.92), np.log(0.08 / (n - 1))
    D = logp[:, 0].copy()
    bp = np.zeros((n, m), int)
    for t in range(1, m):
        best_prev = int(np.argmax(D))
        cand_move = D[best_prev] + move
        stay_v = D + stay
        choose_stay = stay_v >= cand_move
        bp[:, t] = np.where(choose_stay, np.arange(n), best_prev)
        D = np.where(choose_stay, stay_v, cand_move) + logp[:, t]
    path = [int(np.argmax(D))]
    for t in range(m - 1, 0, -1):
        path.append(bp[path[-1], t])
    path = path[::-1]
    out = []
    for i, j in enumerate(path):
        r, q = labels[j]
        s, e = seg_t[i]
        silent = energy[i] < 1e-3 * (energy.max() + 1e-9)
        lab = {"start": float(s), "end": float(e), "root": None if silent else r, "quality": None if silent else q,
               "family": None if silent else QUALS[q][3], "label": "N" if silent else chord_name(r, q),
               "score": float(S[j, i]),
               "bass_pc": None if Bs is None else int(np.argmax(Bs[:, i]))}
        if out and out[-1]["label"] == lab["label"]:
            out[-1]["end"] = lab["end"]
        else:
            out.append(lab)
    return out


def _at(chords, t0, t1):
    """Chord covering most of [t0, t1)."""
    best, bd = None, 0
    for c in chords:
        d = min(c["end"], t1) - max(c["start"], t0)
        if d > bd:
            best, bd = c, d
    return best, bd / max(t1 - t0, 1e-9)


def bass_notes(bass_y, bars):
    """Lowest sustained pitch per bar from the bass stem (pYIN)."""
    import librosa
    if bass_y is None:
        return {}
    f0, vflag, vprob = librosa.pyin(bass_y, fmin=30, fmax=400, sr=SR, frame_length=4096, hop_length=1024)
    t = librosa.times_like(f0, sr=SR, hop_length=1024)
    res = {}
    for b in bars:
        m = (t >= b["start"]) & (t < b["end"]) & vflag
        if m.sum() < 3:
            continue
        midi = np.round(librosa.hz_to_midi(f0[m])).astype(int)
        vals, cnt = np.unique(midi, return_counts=True)
        res[b["bar"]] = {"note": librosa.midi_to_note(int(vals[np.argmax(cnt)]), unicode=False),
                         "midi": int(vals[np.argmax(cnt)]), "share": float(cnt.max() / cnt.sum())}
    return res


def analyze(mix_path, stems: dict, rhythm: dict, fast=False):
    y, ysrc = harmonic_signal(stems, mix_path)
    out = {"harmonic_source": ysrc}
    tun = tuning(y)
    out["tuning"] = tun
    cents = tun["value"]["cents_from_440"]
    bass_y = load(stems["bass"], mono=True)[0] if "bass" in stems else None
    beats = np.asarray(rhythm["beats"]["value"])
    beats = beats[beats >= 0]
    bars = rhythm["bars"]
    bpb = int(rhythm["time_signature"]["value"].split("/")[0])

    ch_m = chords_madmom(mix_path)
    ch_t = chords_template(y, beats, bass_y, cents)
    bn = bass_notes(bass_y, bars) if not fast else {}

    # per bar (and per half bar when the half-bars disagree)
    per_bar, agree_n, total = [], 0, 0
    for b in bars:
        s, e = max(b["start"], 0.0), b["end"]
        cm, fm = _at(ch_m, s, e)
        ct, ft = _at(ch_t, s, e)
        if cm is None and ct is None:
            continue
        agree = cm is not None and ct is not None and cm["root"] == ct["root"] and (
            cm["family"] == ct["family"] or ct["family"] in ("sus",))
        if cm is not None and cm["label"] != "N":
            total += 1
            agree_n += int(bool(agree))
        if agree:
            final, conf = ct, 0.6 + 0.4 * min(fm, ft)
        elif cm is not None and cm["label"] != "N":
            final, conf = cm, 0.4 * fm
        else:
            final, conf = ct, 0.3 * ft
        label = final["label"]
        if agree and ct["quality"] == "sus2" and cm["family"] in ("maj", "min"):
            # a minor/major triad with an added 9th looks like sus2 to the templates when the 3rd is weak
            label = chord_name(cm["root"], cm["quality"]) + "(add9)"
            final = dict(final, family=cm["family"], quality=cm["quality"])
        bass = bn.get(b["bar"])
        if bass and final.get("root") is not None:
            bpc = bass["midi"] % 12
            tones = [(final["root"] + i) % 12 for i in QUALS[final["quality"]][0]]
            if bpc != final["root"] and bpc in tones and bass["share"] > 0.5:
                label = chord_name(final["root"], final["quality"], bpc)
        # split bar when two halves carry different chords in both estimators
        halves = None
        if bpb >= 4:
            mid = s + (e - s) / 2
            c1, _ = _at(ch_t, s, mid)
            c2, _ = _at(ch_t, mid, e)
            m1, _ = _at(ch_m, s, mid)
            m2, _ = _at(ch_m, mid, e)
            if c1 and c2 and m1 and m2 and c1["label"] != c2["label"] and m1["label"] != m2["label"]:
                halves = [c1["label"], c2["label"]]
        per_bar.append({"bar": b["bar"], "start": round(b["start"], 3), "chord": label,
                        "root": None if final["root"] is None else NOTES[final["root"]],
                        "family": final["family"], "confidence": round(conf, 2),
                        "madmom": cm["label"] if cm else None, "template": ct["label"] if ct else None,
                        "halves": halves, "bass": bass["note"] if bass else None})
    out["chords_per_bar"] = item(per_bar, agree_n / max(total, 1), f"madmom {ver('madmom')} CRF + template/Viterbi",
                                 agreement_madmom_vs_template=round(agree_n / max(total, 1), 3))
    out["chord_segments"] = {"madmom": ch_m, "template": ch_t}
    changes = sum(1 for i in range(1, len(per_bar)) if per_bar[i]["chord"] != per_bar[i - 1]["chord"])
    changes += sum(1 for p in per_bar if p["halves"])
    out["harmonic_rhythm"] = item({"changes_per_bar": round(changes / max(len(per_bar), 1), 2),
                                   "typical": "two chords per bar" if changes > len(per_bar) * 1.2 else
                                   "one chord per bar" if changes > len(per_bar) * 0.6 else "one chord per 2+ bars"},
                                  0.6, "derived from chords_per_bar")
    out["bass_notes"] = item(bn, 0.6 if bn else None, f"librosa {ver('librosa')} pyin on bass stem")

    # key voting
    votes = {}
    try:
        k, p = key_madmom(mix_path)
        votes["madmom_cnn"] = {"key": k, "strength": round(p, 3)}
    except Exception as e:
        votes["madmom_cnn"] = {"error": str(e)}
    k2, s2 = key_essentia(y, "edma")
    votes["essentia_edma"] = {"key": k2, "strength": round(s2, 3)}
    k3, s3 = key_essentia(y, "bgate")
    votes["essentia_bgate"] = {"key": k3, "strength": round(s3, 3)}
    k4, s4 = key_from_chords(ch_t)
    votes["from_chords"] = {"key": k4, "strength": round(s4, 3)}
    tally = {}
    for v in votes.values():
        if "key" in v and v["key"]:
            tally[v["key"]] = tally.get(v["key"], 0) + 1
    best = max(tally, key=lambda k: (tally[k], k == votes.get("madmom_cnn", {}).get("key")))
    n = sum(tally.values())
    rel_votes = sum(c for k, c in tally.items() if k == relative(best))
    conf = tally[best] / n
    # tonal centre / mode: the most time-weighted chord root inside the winning key's pitch collection
    centre = None
    dur = {}
    for c in ch_t:
        if c["root"] is not None and c["family"] in ("min", "maj"):
            dur[(c["root"], c["family"])] = dur.get((c["root"], c["family"]), 0) + c["end"] - c["start"]
    if dur:
        (r, fam), _ = max(dur.items(), key=lambda kv: kv[1])
        t0 = pc(best.split(" ")[0])
        ion = (t0 if best.endswith("major") else (t0 + 3) % 12)
        modes = {0: "ionian (major)", 2: "dorian", 4: "phrygian", 5: "lydian", 7: "mixolydian", 9: "aeolian (minor)", 11: "locrian"}
        deg = (r - ion) % 12
        if deg in modes:
            centre = {"tonic": NOTES[r], "mode": f"{NOTES[r]} {modes[deg]}", "chord_time_share": round(max(dur.values()) / sum(dur.values()), 2),
                      "note": "most frequent chord root, read as a mode of the detected pitch collection"}
    out["tonal_centre"] = item(centre, 0.5 if centre else None, "chord durations (template/Viterbi)")
    out["key"] = item(best, conf, "vote: madmom CNN, essentia KeyExtractor (edma, bgate), chord-derived",
                      votes=votes, relative=relative(best),
                      note=("relative major/minor also voted" if rel_votes else None))
    return out


def section_keys(y_harm, sections, global_key):
    """Key per section (sections >= 6 s) with Essentia EDMA; a different key counts as a modulation only when
    it is not the relative major/minor and the strength is above 0.6."""
    res = []
    for s in sections:
        a, b = int(max(s["start"], 0) * SR), int(s["end"] * SR)
        if (b - a) < 6 * SR:
            res.append(None)
            continue
        k, st = key_essentia(y_harm[a:b], "edma")
        mod = k != global_key and k != relative(global_key) and st > 0.6
        res.append({"key": k, "strength": round(st, 2), "modulation": bool(mod)})
    return res
