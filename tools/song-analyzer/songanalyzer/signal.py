"""File and signal measurements. Loudness, true peak, crest, band balance and stereo come from one
standard-conformant source: GreanTeaDawy's own meter (ITU-R BS.1770-4 / EBU R128 integrated loudness with
gating, 4x-oversampled true peak, EBU loudness range) through measure.mjs — the meter render_mix uses, so the
original and a rebuild in the studio compare like for like."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from .common import METER, SR, ffprobe, item, load, measure_call


def file_info(src: Path) -> dict:
    p = ffprobe(src)
    a = next((s for s in p["streams"] if s.get("codec_type") == "audio"), {})
    fmt = p.get("format", {})
    return {"file": src.name, "container": fmt.get("format_name"), "codec": a.get("codec_name"),
            "duration_s": round(float(fmt.get("duration", a.get("duration", 0)) or 0), 3),
            "sample_rate": int(a.get("sample_rate", 0) or 0), "channels": a.get("channels"),
            "bit_rate_kbps": round(int(fmt.get("bit_rate", 0) or 0) / 1000) or None,
            "bits_per_sample": a.get("bits_per_raw_sample") or a.get("bits_per_sample") or None,
            "size_mb": round(int(fmt.get("size", 0) or 0) / 1e6, 2),
            "tags": {k: v for k, v in (fmt.get("tags") or {}).items() if k.lower() in ("title", "artist", "album", "date", "genre")}}


def measure(wav: Path) -> dict:
    """The studio meter's report for one WAV (16/24-bit int or 32-bit float)."""
    return measure_call(wav)


def analyze(src: Path, mix_wav: Path) -> dict:
    info = file_info(src)
    rep = measure(mix_wav)
    src_name = METER
    lv, ld, st, tm, sp = rep["levels"], rep["loudness"], rep["stereo"], rep["time"], rep["spectrum"]
    x, sr = load(mix_wav)
    # clipping runs: consecutive samples at or above -0.1 dBFS (decoded file; MP3 decoding can exceed 0 dBFS)
    thr = 10 ** (-0.1 / 20)
    over = np.abs(x).max(0) >= thr
    runs = int(np.sum(np.diff(over.astype(int)) == 1))
    out = {
        "file": item(info, 1.0, "ffprobe"),
        "loudness": item({"integrated_lufs": ld["integrated_lufs"], "loudness_range_lu": ld["loudness_range_lu"],
                          "short_term_max_lufs": ld["short_term_max_lufs"], "momentary_max_lufs": ld["momentary_max_lufs"]},
                         0.98, src_name),
        "levels": item({"true_peak_dbtp": lv["true_peak_dbtp"], "sample_peak_dbfs": lv["peak_dbfs"],
                        "rms_dbfs": lv["rms_dbfs"], "crest_factor_db": lv["crest_factor_db"],
                        "dc_offset": lv["dc_offset"], "clipped_samples": lv["clipped_samples"],
                        "near_full_scale_runs": runs}, 0.98, src_name),
        "short_term_loudness_curve": item([[p["t_s"], p["lufs_short"]] for p in tm.get("timeline", [])], 0.95,
                                          src_name, unit="[time_s, LUFS short-term (mean of three 1 s blocks, read every second)]"),
        "spectral_balance": item({"bands": sp["bands"], "centroid_hz": sp["centroid_hz"], "flatness": sp.get("flatness")},
                                 0.95, src_name,
                                 bands_hz="sub 20-60, low 60-250, lowMid 250-500, mid 500-2k, highMid 2-6k, high 6-20k (the studio's six bands)"),
        "stereo": item(st, 0.95, src_name),
        "silence": item({"lead_in_s": tm["silence"]["leading_s"], "tail_s": tm["silence"]["trailing_s"],
                         "silent_fraction": tm["silence"]["silent_fraction"]}, 0.95, src_name),
        "findings": item(rep.get("findings", []), 0.9, src_name),
        "timeline": tm.get("timeline", []),
    }
    return out
