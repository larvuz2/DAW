"""song-analyzer: analyze <audio> --out <dir> [--stems fal|local|mureka|mureka-direct|none] [--fast]"""
from __future__ import annotations

import argparse
import json
import os
import resource
import shutil
import sys
import time
import traceback
from pathlib import Path

import numpy as np

from . import __version__
from .common import SR, decode, item, load, log, stage, write_json


def stem_stats(stems, bars):
    from .signal import measure
    out, act = {}, {}
    for name, p in stems.items():
        x, _ = load(p)
        if np.sqrt(np.mean(x ** 2)) < 10 ** (-60 / 20):
            out[name] = {"silent": True}
            continue
        r = measure(p)
        m = x.mean(0)
        e = []
        for b in bars:
            a, bb = int(max(b["start"], 0) * SR), int(b["end"] * SR)
            seg = m[a:bb]
            e.append(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9) if len(seg) else -120)
        e = np.array(e)
        thr = max(-50.0, e.max() - 30)
        act[name] = (e > thr).tolist()
        out[name] = {"integrated_lufs": r["loudness"]["integrated_lufs"], "true_peak_dbtp": r["levels"]["true_peak_dbtp"],
                     "stereo": r["stereo"], "pan": "left" if r["stereo"]["balance_db"] > 1.5 else "right" if r["stereo"]["balance_db"] < -1.5 else "centre",
                     "bands": {k: v["share"] for k, v in r["spectrum"]["bands"].items()},
                     "bar_level_db": [round(float(v), 1) for v in e], "active_bars": int(np.sum(e > thr))}
    return out, act


def main(argv=None):
    ap = argparse.ArgumentParser(prog="analyze", description=__doc__)
    ap.add_argument("audio")
    ap.add_argument("--out", required=True)
    ap.add_argument("--stems", default="local", choices=["fal", "local", "mureka", "mureka-direct", "none"])
    ap.add_argument("--stem-model", default=None, help="htdemucs_6s (default), htdemucs, htdemucs_ft; mureka: audio-separation-1/2/3")
    ap.add_argument("--fast", action="store_true", help="skip lyrics and per-bar bass pitch; single structure model; small beat model")
    ap.add_argument("--start", type=float, default=None, help="analyze an excerpt: start (s)")
    ap.add_argument("--duration", type=float, default=None, help="analyze an excerpt: length (s)")
    ap.add_argument("--downbeat-shift", type=int, default=0,
                    help="move every bar line N beats later (when the downbeat vote was wrong: chords changing mid-bar)")
    ap.add_argument("--no-lyrics", action="store_true")
    ap.add_argument("--no-pdf", action="store_true")
    ap.add_argument("--reuse-stems", action="store_true", help="reuse stems already in <out>/stems")
    a = ap.parse_args(argv)

    src = Path(a.audio).resolve()
    out = Path(a.out).resolve()
    for d in ("stems", "midi", "figures", "work"):
        (out / d).mkdir(parents=True, exist_ok=True)
    work = out / "work"
    timings, errors = {}, {}
    t_all = time.time()
    A = {"analyzer": {"name": "song-analyzer", "version": __version__, "command": " ".join(sys.argv),
                      "options": {"stems": a.stems, "fast": a.fast, "start": a.start, "duration": a.duration,
                                  "downbeat_shift": a.downbeat_shift}}}

    def guarded(name, fn):
        try:
            with stage(timings, name):
                return fn()
        except Exception as e:
            errors[name] = f"{type(e).__name__}: {e}"
            log(f"stage {name} FAILED: {e}")
            traceback.print_exc()
            return None

    mix = work / "mix.wav"
    with stage(timings, "decode"):
        decode(src, mix, SR, 2, a.start, a.duration)
    duration = len(load(mix, mono=True)[0]) / SR

    from . import signal as sig
    A["signal"] = guarded("signal", lambda: sig.analyze(src, mix))

    from . import stems as st
    stems, sinfo = {}, {"backend": a.stems}
    if a.reuse_stems and any((out / "stems").glob("*.wav")):
        stems = {p.stem: p for p in sorted((out / "stems").glob("*.wav")) if not p.stem.startswith("_")}
        sinfo = json.loads((work / "stems_info.json").read_text()) if (work / "stems_info.json").exists() else {"backend": "reused"}
    elif a.stems != "none":
        def _sep():
            try:
                return st.separate(mix, out / "stems", a.stems, a.stem_model)
            except Exception as e:
                if a.stems == "local":
                    raise
                log(f"{a.stems} separation failed ({e}); falling back to local Demucs")
                p, i = st.separate(mix, out / "stems", "local", None)
                i["fallback_from"] = {"backend": a.stems, "error": str(e)}
                return p, i
        r = guarded("stems", _sep)
        if r:
            stems, sinfo = r
            write_json(work / "stems_info.json", sinfo)
    A["stems"] = {"info": sinfo}

    from . import rhythm
    drum = stems.get("drums")
    R = guarded("rhythm", lambda: rhythm.analyze(mix, duration, drum, None, a.fast, a.downbeat_shift))
    A["rhythm"] = R
    bars = R["bars"] if R else []

    from . import structure
    S = guarded("structure", lambda: structure.analyze(mix, stems, R, work, a.fast)) if R else None
    if S and S.get("allin1") and R:
        b3 = np.asarray(S["allin1"]["beats"])
        from .rhythm import _fmeasure
        R["agreement"]["beat_this_vs_allin1_F"] = _fmeasure(np.asarray(R["detected_beats"]["beat_this"]), b3)
        R["agreement"]["madmom_vs_allin1_F"] = _fmeasure(np.asarray(R["detected_beats"]["madmom"]), b3)
        R["opinions"]["allin1"] = {"bpm": S["allin1"]["bpm"], "beats": len(b3), "source": S["allin1"]["source"]}
    A["structure"] = S

    from . import harmony
    H = guarded("harmony", lambda: harmony.analyze(mix, stems, R, a.fast)) if R else None
    if H and S:
        def _sk():
            y, _ = harmony.harmonic_signal(stems, mix)
            ks = harmony.section_keys(y, S["sections"]["value"], H["key"]["value"])
            for s, k in zip(S["sections"]["value"], ks):
                s["key"] = k
            mods = [s["bar_range"] for s, k in zip(S["sections"]["value"], ks) if k and k["modulation"]]
            H["modulations"] = item(mods, 0.5, "essentia KeyExtractor per section")
        guarded("section_keys", _sk)
    A["harmony"] = H

    if stems and bars:
        r = guarded("stem_stats", lambda: stem_stats(stems, bars))
        if r:
            A["stems"]["per_stem"], A["stems"]["activity_per_bar"] = r

    from . import instruments
    I = guarded("instruments", lambda: instruments.analyze(mix, stems, bars, a.fast)) if bars else None
    vocal_prob = I.pop("vocal_frame_prob", None) if I else None
    A["instruments"] = I

    from . import transcribe
    secs = S["sections"]["value"] if S else [{"label": "song", "bar_start": 0, "bar_end": len(bars), "bar_range": f"1-{len(bars)}"}]
    T = guarded("transcription", lambda: transcribe.analyze(stems or {"other": mix}, R["beats"]["value"], bars, secs,
                                                             duration, out / "midi", int(R["time_signature"]["value"][0]), a.fast)) if R else None
    A["notes"], note_tracks = (T if T else (None, {}))

    from . import timbre
    A["timbre"] = guarded("timbre", lambda: timbre.analyze(stems, mix, R["beats"]["value"], bars,
                                                          A["stems"].get("per_stem", {}))) if R else None

    if not a.fast and not a.no_lyrics and "vocals" in stems:
        ps = A["stems"].get("per_stem", {}).get("vocals", {})
        sing = vocal_prob is not None and float(np.mean(vocal_prob > 0.2)) > 0.05
        if ps and not ps.get("silent") and ps.get("integrated_lufs", -99) > -40 and sing:
            from . import lyrics
            A["lyrics"] = guarded("lyrics", lambda: lyrics.analyze(stems["vocals"], a.fast))
        else:
            A["lyrics"] = item(None, None, "skipped", note="no sustained singing detected in the vocal stem")

    from . import summary
    A["summary"] = guarded("summary", lambda: summary.build(A))
    A["run"] = {"seconds_total": round(time.time() - t_all, 1), "stage_seconds": timings, "errors": errors,
                "peak_rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 2),
                "audio_seconds": round(duration, 2)}
    write_json(out / "analysis.json", A)

    from . import report
    guarded("report", lambda: report.build(A, out, mix, stems, note_tracks, pdf=not a.no_pdf))
    A["run"]["seconds_total"] = round(time.time() - t_all, 1)
    A["run"]["stage_seconds"] = timings
    write_json(out / "analysis.json", A)
    shutil.rmtree(work / "allin1_demix", ignore_errors=True)
    shutil.rmtree(work / "allin1_spec", ignore_errors=True)
    log(f"done in {A['run']['seconds_total']} s -> {out}")
    if errors:
        log(f"stages with errors: {list(errors)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
