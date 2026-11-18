"""Timbre and production per stem, plus a synthesizer rebuild hint derived from the measurements.

Measures (librosa + numpy): spectral centroid (mean and per bar), rolloff, flatness; attack time (10 % -> 90 %
of the onset's peak level), level 250 ms after the peak (decay / sustain shape); for pitched stems with a
trackable fundamental (pYIN): harmonic-to-noise ratio, odd/even harmonic balance, inharmonicity, vibrato rate
and depth; a reverb estimate (energy 150-400 ms after onsets relative to the onset peak, measured in the
quietest gaps); beat-synchronous ducking depth (sidechain pumping).
"""
from __future__ import annotations

import numpy as np

from .common import SR, item, load, ver


def _env(y, hop=220):
    import librosa
    return librosa.feature.rms(y=y, frame_length=hop * 4, hop_length=hop)[0], hop


def envelope_shape(y):
    import librosa
    e, hop = _env(y)
    fps = SR / hop
    edb = 20 * np.log10(e + 1e-9)
    on = librosa.onset.onset_detect(y=y, sr=SR, hop_length=hop, units="frames", backtrack=True)
    att, dec, tail = [], [], []
    for o in on:
        seg = e[o:o + int(0.3 * fps)]
        if len(seg) < 5:
            continue
        pk = int(np.argmax(seg))
        p = seg[pk]
        if p < 1e-4:
            continue
        lo = np.argmax(seg >= 0.1 * p)
        hi = np.argmax(seg >= 0.9 * p)
        att.append((hi - lo) / fps)
        j = o + pk + int(0.25 * fps)
        if j < len(e):
            dec.append(edb[j] - 20 * np.log10(p))
        j1, j2 = o + pk + int(0.15 * fps), o + pk + int(0.4 * fps)
        if j2 < len(e):
            tail.append(edb[j1:j2].mean() - 20 * np.log10(p))
    if not att:
        return {}
    return {"attack_ms": round(1000 * float(np.median(att)), 1),
            "level_250ms_after_peak_db": round(float(np.median(dec)), 1) if dec else None,
            "onsets": len(on), "tail_db": float(np.median(tail)) if tail else None}


def harmonic_features(y):
    import librosa
    y = y[: SR * 90]
    f0, vf, vp = librosa.pyin(y, fmin=40, fmax=1200, sr=SR, frame_length=4096, hop_length=1024)
    if vf.sum() < 20:
        return {}
    hop, n_fft = 1024, 4096
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=n_fft)
    odd, even, inh, hnr = [], [], [], []
    for i in np.where(vf)[0][::3]:
        if i >= S.shape[1] or not np.isfinite(f0[i]):
            continue
        spec = S[:, i]
        tot = np.sum(spec ** 2) + 1e-12
        amps, devs, hpow = [], [], 0.0
        for k in range(1, 11):
            fk = k * f0[i]
            if fk > SR / 2 - 500:
                break
            band = (freqs > fk * 0.97) & (freqs < fk * 1.03)
            if not band.any():
                break
            j = np.argmax(spec * band)
            amps.append(spec[j])
            devs.append(abs(freqs[j] / fk - 1))
            hpow += np.sum(spec[(freqs > fk * 0.985) & (freqs < fk * 1.015)] ** 2)
        if len(amps) >= 6:
            a = np.array(amps)
            odd.append(np.sum(a[2::2] ** 2))  # harmonics 3,5,7,9
            even.append(np.sum(a[1::2] ** 2))  # 2,4,6,8
            inh.append(float(np.mean(devs[1:])))
            hnr.append(10 * np.log10(hpow / max(tot - hpow, 1e-12)))
    if not odd:
        return {}
    # vibrato: inside stable notes only (voiced runs >= 0.4 s whose pitch stays within +-150 cents)
    vib = {}
    fps = SR / 1024
    rates, depths = [], []
    run = []
    for i in range(len(f0) + 1):
        if i < len(f0) and vf[i] and np.isfinite(f0[i]):
            run.append(i)
            continue
        if len(run) >= int(0.4 * fps):
            c = 1200 * np.log2(f0[run] / np.median(f0[run]))
            if np.ptp(c) < 300:
                c = c - np.polyval(np.polyfit(np.arange(len(c)), c, 1), np.arange(len(c)))
                sp = np.abs(np.fft.rfft(c * np.hanning(len(c)), n=256))
                fr = np.fft.rfftfreq(256, 1 / fps)
                m = (fr > 3.5) & (fr < 8.5)
                if m.any() and sp[m].max() > 2 * np.median(sp[1:]):
                    rates.append(fr[m][np.argmax(sp[m])])
                    depths.append(np.percentile(np.abs(c), 90))
        run = []
    if len(rates) >= 3:
        vib = {"rate_hz": round(float(np.median(rates)), 1), "depth_cents": round(float(np.median(depths)), 1),
               "notes_with_vibrato": len(rates)}
    return {"f0_median_hz": round(float(np.nanmedian(f0[vf])), 1), "voiced_share": round(float(vf.mean()), 2),
            "odd_even_ratio_db": round(float(10 * np.log10((np.mean(odd) + 1e-12) / (np.mean(even) + 1e-12))), 1),
            "inharmonicity": round(float(np.median(inh)), 4), "hnr_db": round(float(np.median(hnr)), 1),
            "vibrato": vib}


def pumping(y, beats):
    e, hop = _env(y, 441)
    fps = SR / hop
    if len(beats) < 9:
        return None
    fold = []
    for a, b in zip(beats[:-1], beats[1:]):
        ia, ib = int(a * fps), int(b * fps)
        if ib - ia < 8 or ib >= len(e) or ia < 0:
            continue
        seg = e[ia:ib]
        if seg.mean() < 1e-4:
            continue
        idx = np.linspace(0, len(seg) - 1, 16).astype(int)
        fold.append(20 * np.log10(seg[idx] / (seg.mean() + 1e-9) + 1e-9))
    if len(fold) < 8:
        return None
    f = np.median(np.array(fold), 0)
    depth = float(f.max() - f.min())
    dip_phase = int(np.argmin(f)) / 16
    return {"beat_folded_depth_db": round(depth, 1), "dip_phase": round(dip_phase, 2),
            "likely_sidechain": bool(depth > 4 and dip_phase < 0.3 and int(np.argmax(f)) / 16 > 0.4)}


def hint(name, sp, env, harm, pump, width):
    """Plain synth rebuild hint from measurements (waveform family, filter, envelope, effects)."""
    if name == "drums":
        return None
    parts = []
    att = env.get("attack_ms")
    dec = env.get("level_250ms_after_peak_db")
    oe = harm.get("odd_even_ratio_db") if harm else None
    inh = harm.get("inharmonicity") if harm else None
    cen = sp["centroid_hz"]
    f0 = harm.get("f0_median_hz") if harm else None
    if inh is not None and inh > 0.012:
        wave = "inharmonic (FM bell / metallic / modal)"
    elif f0 and cen < 2.2 * f0:
        wave = "sine or triangle (few harmonics)"
    elif oe is not None and oe > 6:
        wave = "square / pulse (odd harmonics dominate)"
    elif sp["flatness"] > 0.2:
        wave = "noise-rich (noise oscillator, breath, distortion)"
    else:
        wave = "sawtooth-like (full harmonic series)"
    parts.append(f"waveform: {wave}")
    parts.append(f"low-pass around {int(min(18000, max(200, sp['rolloff_hz'] * 1.2)))} Hz (85 % rolloff {int(sp['rolloff_hz'])} Hz)")
    if att is not None:
        shape = ("pluck (fast attack, decays within 250 ms)" if att < 15 and dec is not None and dec < -12 else
                 "pad / swell (slow attack)" if att > 80 else
                 "sustained (fast attack, holds)" if dec is not None and dec > -6 else "percussive-to-sustained")
        parts.append(f"amp envelope: attack ~{att:.0f} ms, {shape}")
    if harm and harm.get("vibrato", {}).get("depth_cents", 0) > 15:
        v = harm["vibrato"]
        parts.append(f"vibrato ~{v['rate_hz']} Hz, ±{v['depth_cents']:.0f} cents (LFO to pitch)")
    if width is not None and width > 0.35:
        parts.append("wide stereo: unison detune / chorus")
    if env.get("tail_db") is not None and env["tail_db"] > -12:
        parts.append("long tail: reverb or long release")
    if pump and pump.get("likely_sidechain"):
        parts.append(f"sidechain ducking ~{pump['beat_folded_depth_db']} dB per beat")
    if name == "bass" and f0 and f0 < 70 and cen < 3 * f0:
        parts.append("sub bass: sine + light saturation")
    return "; ".join(parts)


def spectral(y):
    import librosa
    S = np.abs(librosa.stft(y[: SR * 240], n_fft=2048, hop_length=1024))
    keep = S.sum(0) > 1e-3 * S.sum(0).max()
    S = S[:, keep] if keep.any() else S
    c = librosa.feature.spectral_centroid(S=S, sr=SR)[0]
    r = librosa.feature.spectral_rolloff(S=S, sr=SR, roll_percent=0.85)[0]
    fl = librosa.feature.spectral_flatness(S=S)[0]
    return {"centroid_hz": round(float(np.median(c)), 0), "rolloff_hz": round(float(np.median(r)), 0),
            "flatness": round(float(np.median(fl)), 3)}


def centroid_per_bar(y, bars):
    import librosa
    c = librosa.feature.spectral_centroid(y=y, sr=SR, hop_length=2048)[0]
    rms = librosa.feature.rms(y=y, hop_length=2048)[0]
    t = librosa.times_like(c, sr=SR, hop_length=2048)
    out = []
    for b in bars:
        m = (t >= b["start"]) & (t < b["end"]) & (rms > 1e-3)
        out.append(round(float(np.median(c[m])), 0) if m.any() else None)
    return out


def drum_character(y):
    """Kick: decay length and pitch -> 808 (long, low, sine), 909/electronic (short punchy), acoustic (noisy, short)."""
    import librosa
    S = np.abs(librosa.stft(y[: SR * 120], n_fft=4096, hop_length=512))
    f = librosa.fft_frequencies(sr=SR, n_fft=4096)
    low = S[(f >= 30) & (f < 120)].sum(0)
    on = librosa.util.peak_pick(low, pre_max=8, post_max=8, pre_avg=20, post_avg=20, delta=low.max() * 0.2, wait=8)
    if len(on) < 4:
        return {"kick": "few kick hits found"}
    fps = SR / 512
    decays, pitches = [], []
    for o in on[:64]:
        seg = low[o:o + int(1.0 * fps)]
        if len(seg) < 10:
            continue
        below = np.where(seg < seg[0] * 10 ** (-20 / 20))[0]
        decays.append((below[0] if len(below) else len(seg)) / fps)
        spec = S[(f >= 30) & (f < 200), o + 2:o + 8].mean(1)
        pitches.append(float(f[(f >= 30) & (f < 200)][np.argmax(spec)]))
    d, p = float(np.median(decays)), float(np.median(pitches))
    hf = S[f > 5000].sum() / (S.sum() + 1e-9)
    kind = ("808-style (long low sine kick)" if d > 0.35 and p < 70 else
            "electronic punchy kick (909 / modern)" if d < 0.2 and hf < 0.12 else
            "acoustic or sampled acoustic kit" if hf >= 0.12 else "electronic kick")
    return {"kick_decay_20db_s": round(d, 3), "kick_pitch_hz": round(p, 1), "hf_share": round(float(hf), 3), "verdict": kind}


def analyze(stems: dict, mix_path, beats, bars, stem_levels: dict):
    res = {}
    targets = dict(stems) if stems else {"mix": mix_path}
    for name, p in targets.items():
        y, _ = load(p, mono=True)
        if np.sqrt(np.mean(y ** 2)) < 10 ** (-50 / 20):
            res[name] = {"silent": True}
            continue
        sp = spectral(y)
        env = envelope_shape(y)
        # pitch-based features need one dominant line: bass and vocals (polyphonic stems would give nonsense)
        harm = harmonic_features(y) if name in ("bass", "vocals") else {}
        pump = pumping(y, np.asarray(beats)) if name not in ("drums", "vocals") else None
        width = (stem_levels.get(name) or {}).get("stereo", {}).get("width")
        d = {"spectral": sp, "envelope": env, "harmonic": harm, "pumping": pump,
             "centroid_per_bar_hz": centroid_per_bar(y, bars)}
        if name == "drums":
            d["kit"] = drum_character(y)
        if env.get("tail_db") is not None:
            t = env["tail_db"]
            d["reverb_estimate"] = {"tail_db": round(t, 1),
                                    "amount": "dry" if t < -24 else "moderate" if t < -12 else "wet / long release"}
        d["synth_hint"] = hint(name, sp, env, harm, pump, width)
        res[name] = d
    return item(res, 0.5, f"librosa {ver('librosa')} measurements; heuristics in songanalyzer/timbre.py")
