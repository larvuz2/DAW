"""The summary an agent can act on: one paragraph plus a per-section table."""
from __future__ import annotations

from collections import Counter

import numpy as np


def _v(d, *keys, default=None):
    for k in keys:
        if d is None:
            return default
        d = d.get(k) if isinstance(d, dict) else None
    return default if d is None else d


def section_rows(A):
    secs = _v(A, "structure", "sections", "value", default=[])
    chords = _v(A, "harmony", "chords_per_bar", "value", default=[])
    act = _v(A, "stems", "activity_per_bar", default={}) or {}
    mixi = _v(A, "instruments", "mix", "value", default=[]) or []
    by_bar = {c["bar"]: c for c in chords}
    rows = []
    for s in secs:
        a, b = s["bar_start"], s["bar_end"]
        seq = []
        for bn in range(a + 1, b + 1):
            c = by_bar.get(bn)
            if not c:
                continue
            lab = " ".join(c["halves"]) if c.get("halves") else c["chord"]
            if not seq or seq[-1] != lab:
                seq.append(lab)
        prog = " | ".join(seq[:8]) + (" ..." if len(seq) > 8 else "")
        stems_on = [n for n, v in act.items() if np.mean(v[a:b] or [0]) >= 0.5]
        labs = []
        for r in mixi[:25]:
            for rb in r["ranges_bars"]:
                if rb[0] <= b and rb[1] >= a + 1 and r["label"] not in labs:
                    labs.append(r["label"])
        rows.append({"section": s["label"], "letter": s.get("letter"), "bars": s["bar_range"], "n_bars": s["bars"],
                     "start_s": s["start"], "chords": prog, "stems": stems_on, "instruments": labs[:5],
                     "energy_rel_db": s.get("energy_rel"), "key": (s.get("key") or {}).get("key")})
    return rows


def build(A):
    R, H, S, I = A.get("rhythm") or {}, A.get("harmony") or {}, A.get("structure") or {}, A.get("instruments") or {}
    f = _v(A, "signal", "file", "value", default={})
    dur = f.get("duration_s") or _v(A, "run", "audio_seconds")
    bpm = _v(R, "tempo_bpm", "value")
    ts = _v(R, "time_signature", "value")
    key = _v(H, "key", "value")
    lufs = _v(A, "signal", "loudness", "value", "integrated_lufs")
    stab = _v(R, "tempo_stability", "value")
    sw = _v(R, "swing", "value") or {}
    secs = _v(S, "sections", "value", default=[])
    form = " - ".join(f"{s['label']} ({s['bars']})" for s in secs)
    top = [r["label"] for r in (_v(I, "mix", "value", default=[]) or []) if r["share_of_song"] >= 0.2][:6]
    ea = _v(I, "electronic_vs_acoustic", "value", "verdict")
    genres = [g["label"] for g in (_v(I, "genre_hints", "value", default=[]) or [])][:3]
    chords = _v(H, "chords_per_bar", "value", default=[]) or []
    common = [c for c, _ in Counter(c["chord"] for c in chords).most_common(5)]
    energies = [s.get("energy_rel", 0) for s in secs]
    peak = secs[int(np.argmax(energies))]["label"] + f" at bar {secs[int(np.argmax(energies))]['bar_start'] + 1}" if secs else "?"
    lyr = _v(A, "lyrics", "value")
    p = (f"A {dur/60:.1f}-minute piece at about {bpm:.0f} BPM in {ts} ({stab}"
         + (f", {sw.get('feel')} feel" if sw.get("feel") else "") + f"), most likely in {key}" + (lambda c: f" (pitch collection; the music centres on {c['tonic']}, i.e. {c['mode']})" if c and c.get("tonic") != (key or " ").split(" ")[0] else "")(_v(H, "tonal_centre", "value")) + ". "
         f"Form: {form}. The most frequent chords are {', '.join(common)}. "
         f"Instruments heard: {', '.join(top) if top else 'unclear'} ({ea}); genre hints: {', '.join(genres) or 'none'}. "
         f"Energy peaks in the {peak}. Integrated loudness {lufs} LUFS."
         + (f" Vocals with {lyr.get('reliable_lines', 0)} transcribed lyric lines ({lyr.get('language')})." if isinstance(lyr, dict) and lyr.get("lines") else ""))
    return {"paragraph": p, "sections": section_rows(A)}
