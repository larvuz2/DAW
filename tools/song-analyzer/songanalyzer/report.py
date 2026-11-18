"""Figures, report.md and report.pdf (Markdown -> HTML -> headless Chromium page.pdf())."""
from __future__ import annotations

import html
import os
from pathlib import Path

import numpy as np

from .common import SR, load

INK, MUTED, GRID = "#1f2328", "#6b7280", "#e5e7eb"
PALETTE = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d", "#dc2626"]
SEC_COL = {"intro": "#93c5fd", "verse": "#86efac", "chorus": "#fca5a5", "bridge": "#c4b5fd", "inst": "#fde68a",
           "solo": "#fdba74", "outro": "#a5b4fc", "break": "#d1d5db", "start": "#e5e7eb", "end": "#e5e7eb"}


def _v(d, *keys, default=None):
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k)
    return default if d is None else d


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 9, "axes.edgecolor": MUTED, "axes.labelcolor": INK, "xtick.color": MUTED,
                         "ytick.color": MUTED, "axes.spines.top": False, "axes.spines.right": False,
                         "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "figure.dpi": 130})
    return plt


def _sections(ax, A, ymin=0, ymax=1, text=True):
    for s in _v(A, "structure", "sections", "value", default=[]):
        c = SEC_COL.get(s["label"], "#e5e7eb")
        ax.axvspan(s["start"], s["end"], color=c, alpha=0.35, lw=0)
        if text:
            ax.text(s["start"] + 0.5, ymax, s["label"], va="top", fontsize=7, color=INK)


def figures(A, out: Path, mix: Path, stems: dict, notes: dict):
    plt = _plt()
    fig_dir = out / "figures"
    figs = {}
    y, _ = load(mix, mono=True)
    t = np.arange(len(y)) / SR
    dur = len(y) / SR

    # 1 overview: waveform envelope, short-term loudness, sections
    fig, ax = plt.subplots(2, 1, figsize=(10, 4.2), sharex=True, gridspec_kw={"height_ratios": [1, 1]})
    hop = SR // 20
    env = np.array([np.abs(y[i:i + hop]).max() for i in range(0, len(y), hop)])
    te = np.arange(len(env)) * hop / SR
    _sections(ax[0], A, ymax=1.0)
    ax[0].fill_between(te, -env, env, color=PALETTE[0], lw=0)
    ax[0].set_ylim(-1.05, 1.05)
    ax[0].set_ylabel("waveform")
    _sections(ax[1], A, text=False)
    curve = _v(A, "signal", "short_term_loudness_curve", "value", default=[])
    if curve:
        c = np.array(curve)
        ax[1].plot(c[:, 0], c[:, 1], color=PALETTE[1], lw=1.6, label="short-term LUFS (studio meter)")
    bars = _v(A, "rhythm", "bars", default=[])
    be = _v(A, "structure", "bar_energy_db", "value", default=[])
    if bars and be:
        ax[1].step([max(b["start"], 0) for b in bars], be, where="post", color=PALETTE[2], lw=1, label="bar RMS dBFS")
    ax[1].set_ylabel("level")
    ax[1].legend(loc="lower right", fontsize=7, frameon=False)
    ax[1].set_xlabel("time (s)")
    ax[1].set_xlim(0, dur)
    fig.tight_layout()
    figs["overview"] = fig_dir / "overview.png"
    fig.savefig(figs["overview"])
    plt.close(fig)

    # 2 tempo curve
    tc = _v(A, "rhythm", "tempo_curve", "value", default=[])
    if tc:
        c = np.array(tc)
        fig, ax = plt.subplots(figsize=(10, 2.4))
        _sections(ax, A, ymax=c[:, 1].max() + 4)
        ax.plot(c[:, 0], c[:, 1], ".", ms=2.5, color=PALETTE[0], label="local tempo (beat_this beats)")
        bpm = _v(A, "rhythm", "tempo_bpm", "value")
        ax.axhline(bpm, color=PALETTE[3], lw=1, ls="--", label=f"global {bpm:.1f} BPM")
        ax.set_ylim(min(c[:, 1].min(), bpm) - 5, max(c[:, 1].max(), bpm) + 5)
        ax.set_xlim(0, dur)
        ax.set_ylabel("BPM")
        ax.set_xlabel("time (s)")
        ax.legend(loc="lower right", fontsize=7, frameon=False)
        fig.tight_layout()
        figs["tempo"] = fig_dir / "tempo.png"
        fig.savefig(figs["tempo"])
        plt.close(fig)

    # 3 spectrogram
    import librosa
    import librosa.display
    M = librosa.power_to_db(librosa.feature.melspectrogram(y=y[: SR * 600], sr=SR, hop_length=1024, n_mels=128), ref=np.max)
    fig, ax = plt.subplots(figsize=(10, 3))
    librosa.display.specshow(M, sr=SR, hop_length=1024, x_axis="time", y_axis="mel", ax=ax, cmap="magma")
    ax.set_title("mel spectrogram (mix)", fontsize=9, loc="left")
    ax.grid(False)
    fig.tight_layout()
    figs["spectrogram"] = fig_dir / "spectrogram.png"
    fig.savefig(figs["spectrogram"])
    plt.close(fig)

    # 4 stem activity per bar
    act = _v(A, "stems", "per_stem", default={})
    if act and bars:
        names = [n for n in act if not act[n].get("silent")]
        if names:
            L = np.array([act[n]["bar_level_db"] for n in names])
            fig, ax = plt.subplots(figsize=(10, 0.45 * len(names) + 1.2))
            im = ax.imshow(L, aspect="auto", cmap="Blues", vmin=max(L.max() - 45, -80), vmax=L.max(),
                           extent=[0.5, len(bars) + 0.5, len(names) - 0.5, -0.5], interpolation="nearest")
            ax.set_yticks(range(len(names)))
            ax.set_yticklabels(names)
            ax.set_xlabel("bar")
            ax.grid(False)
            for s in _v(A, "structure", "sections", "value", default=[]):
                ax.axvline(s["bar_start"] + 0.5, color=INK, lw=0.8)
                ax.text(s["bar_start"] + 0.7, -0.6, s["label"], fontsize=7, va="bottom")
            fig.colorbar(im, ax=ax, label="dBFS", pad=0.01)
            fig.tight_layout()
            figs["stems"] = fig_dir / "stem_activity.png"
            fig.savefig(figs["stems"])
            plt.close(fig)

    # 5 instruments timeline (mix tagger)
    mixi = _v(A, "instruments", "mix", "value", default=[])
    if mixi and bars:
        rows = [r for r in mixi if r["bars_present"] > 0][:14]
        if rows:
            fig, ax = plt.subplots(figsize=(10, 0.32 * len(rows) + 1))
            for i, r in enumerate(rows):
                for a, b, _, _ in r["ranges_bars"]:
                    ax.barh(i, b - a + 1, left=a - 0.5, color=PALETTE[i % len(PALETTE)], height=0.6)
            ax.set_yticks(range(len(rows)))
            ax.set_yticklabels([r["label"] for r in rows], fontsize=7)
            ax.invert_yaxis()
            ax.set_xlabel("bar")
            ax.set_xlim(0.5, len(bars) + 0.5)
            ax.set_title("instrument / voice tags on the mix (PANNs, bar mean >= 0.15)", fontsize=9, loc="left")
            fig.tight_layout()
            figs["instruments"] = fig_dir / "instruments.png"
            fig.savefig(figs["instruments"])
            plt.close(fig)

    # 6 piano roll of transcriptions
    if notes:
        fig, ax = plt.subplots(figsize=(10, 3.6))
        for i, (n, ns) in enumerate(notes.items()):
            if n == "drums" or not ns:
                continue
            for x in ns:
                ax.plot([x["start"], x["end"]], [x["pitch"], x["pitch"]], color=PALETTE[i % len(PALETTE)], lw=1.6,
                        solid_capstyle="butt", alpha=0.85)
            ax.plot([], [], color=PALETTE[i % len(PALETTE)], label=n)
        ax.set_ylabel("MIDI pitch")
        ax.set_xlabel("time (s)")
        ax.set_xlim(0, dur)
        ax.legend(fontsize=7, frameon=False, loc="upper right", ncol=5)
        ax.set_title("transcribed notes per stem (Basic Pitch)", fontsize=9, loc="left")
        fig.tight_layout()
        figs["pianoroll"] = fig_dir / "pianoroll.png"
        fig.savefig(figs["pianoroll"])
        plt.close(fig)

    # 7 chroma per bar with chord labels
    chords = _v(A, "harmony", "chords_per_bar", "value", default=[])
    if chords and bars:
        C = librosa.feature.chroma_cqt(y=y[: SR * 600], sr=SR, hop_length=2048)
        tt = librosa.times_like(C, sr=SR, hop_length=2048)
        Cb = np.array([C[:, (tt >= b["start"]) & (tt < b["end"])].mean(1) if ((tt >= b["start"]) & (tt < b["end"])).any()
                       else np.zeros(12) for b in bars]).T
        fig, ax = plt.subplots(figsize=(10, 2.8))
        ax.imshow(Cb, aspect="auto", origin="lower", cmap="Greys", extent=[0.5, len(bars) + 0.5, -0.5, 11.5])
        ax.set_yticks(range(12))
        ax.set_yticklabels(["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"], fontsize=6)
        step = max(1, len(chords) // 40)
        for c in chords[::step]:
            ax.text(c["bar"], 11.9, c["chord"], rotation=90, fontsize=6, va="bottom", ha="center", color=PALETTE[0])
        ax.set_xlabel("bar")
        ax.grid(False)
        fig.tight_layout()
        figs["chroma"] = fig_dir / "chords_chroma.png"
        fig.savefig(figs["chroma"])
        plt.close(fig)
    if "pianoroll" not in figs and (fig_dir / "pianoroll.png").exists():
        figs["pianoroll"] = fig_dir / "pianoroll.png"
    return figs


def _tbl(headers, rows):
    s = "| " + " | ".join(headers) + " |\n|" + "---|" * len(headers) + "\n"
    for r in rows:
        s += "| " + " | ".join("" if c is None else str(c).replace("|", "/") for c in r) + " |\n"
    return s


def _c(x):
    return "" if x is None else f"{x:.2f}"


def markdown(A, figs, out: Path):
    f = _v(A, "signal", "file", "value", default={})
    R, H, S, I = A.get("rhythm") or {}, A.get("harmony") or {}, A.get("structure") or {}, A.get("instruments") or {}
    md = [f"# Song analysis: {html.escape(f.get('file', ''))}\n"]
    md.append("Generated by `tools/song-analyzer` (GGS song studies; method from GGS Composer). Every value carries a confidence (0-1) "
              "and the tool that produced it; the full data is in `analysis.json`.\n")
    sm = A.get("summary") or {}
    md.append("## Summary\n\n" + sm.get("paragraph", "") + "\n")
    rows = sm.get("sections", [])
    if rows:
        md.append(_tbl(["Section", "Bars", "Start (s)", "Chords", "Stems playing", "Tags (mix)", "Energy (dB vs median)"],
                       [[f"{r['section']} ({r['letter']})", f"{r['bars']} ({r['n_bars']})", r["start_s"], r["chords"],
                         ", ".join(r["stems"]), ", ".join(r["instruments"]), r["energy_rel_db"]] for r in rows]))
    md.append("\n## Overview\n\n![overview](figures/overview.png)\n")
    # file & signal
    lv = _v(A, "signal", "levels", "value", default={})
    ld = _v(A, "signal", "loudness", "value", default={})
    stv = _v(A, "signal", "stereo", "value", default={})
    sil = _v(A, "signal", "silence", "value", default={})
    md.append("## File and signal\n")
    md.append(_tbl(["Measure", "Value"], [
        ["Format", f"{f.get('codec')} in {f.get('container')}, {f.get('sample_rate')} Hz, {f.get('channels')} ch, {f.get('bit_rate_kbps')} kbps"],
        ["Duration", f"{f.get('duration_s')} s"],
        ["Integrated loudness", f"{ld.get('integrated_lufs')} LUFS"], ["Loudness range", f"{ld.get('loudness_range_lu')} LU"],
        ["Short-term max", f"{ld.get('short_term_max_lufs')} LUFS"], ["True peak", f"{lv.get('true_peak_dbtp')} dBTP"],
        ["Crest factor", f"{lv.get('crest_factor_db')} dB"], ["Clipped samples", lv.get("clipped_samples")],
        ["Stereo correlation / width", f"{stv.get('correlation')} / {stv.get('width')}"],
        ["Lead-in / tail silence", f"{sil.get('lead_in_s')} s / {sil.get('tail_s')} s"],
    ]))
    md.append(f"\nSource: {_v(A, 'signal', 'loudness', 'source')}.\n")
    bands = _v(A, "signal", "spectral_balance", "value", "bands", default={})
    if bands:
        md.append("\nFrequency balance (share of energy): " + ", ".join(f"{k} {v['share']:.0%}" for k, v in bands.items()) + ".\n")
    fnd = _v(A, "signal", "findings", "value", default=[])
    if fnd:
        md.append("\nFindings: " + "; ".join(x["message"] for x in fnd) + "\n")
    md.append("\n![spectrogram](figures/spectrogram.png)\n")
    # time
    md.append("\n## Time\n")
    sw = _v(R, "swing", "value") or {}
    md.append(_tbl(["Item", "Value", "Confidence", "Source"], [
        ["Tempo", f"{_v(R, 'tempo_bpm', 'value')} BPM (half {_v(R, 'tempo_bpm', 'alternatives', 'half')}, double {_v(R, 'tempo_bpm', 'alternatives', 'double')})", _c(_v(R, 'tempo_bpm', 'confidence')), _v(R, 'tempo_bpm', 'source')],
        ["Tempo stability", f"{_v(R, 'tempo_stability', 'value')} (beat-interval CV {_c(_v(R, 'tempo_stability', 'ibi_cv'))})", _c(_v(R, 'tempo_stability', 'confidence')), ""],
        ["Time signature", _v(R, "time_signature", "value"), _c(_v(R, "time_signature", "confidence")), _v(R, "time_signature", "source")],
        ["Swing", f"{sw.get('feel')} ({sw.get('level')} ratio {sw.get('ratio')})" if sw else "n/a", _c(_v(R, "swing", "confidence")), _v(R, "swing", "source")],
        ["Bars", len(_v(R, "bars", default=[])), "", ""],
        ["First beat", f"{_v(R, 'lead_in_s')} s", "", ""],
    ]))
    ag = _v(R, "agreement", default={})
    if ag:
        md.append("\nTracker agreement (F-measure, 70 ms window; 1.0 = identical): " + ", ".join(f"{k} {v:.2f}" for k, v in ag.items()) + ".\n")
    if "tempo" in figs:
        md.append("\n![tempo](figures/tempo.png)\n")
    # harmony
    md.append("\n## Pitch and harmony\n")
    kv = _v(H, "key", "votes", default={})
    tu = _v(H, "tuning", "value", default={})
    md.append(_tbl(["Item", "Value", "Confidence"], [
        ["Key", f"{_v(H, 'key', 'value')} (relative {_v(H, 'key', 'relative')})", _c(_v(H, "key", "confidence"))],
        ["Tonal centre / mode", (lambda c: f"{c['mode']} ({c['note']}; {c['chord_time_share']:.0%} of chord time)" if c else "n/a")(_v(H, "tonal_centre", "value")), _c(_v(H, "tonal_centre", "confidence"))],
        ["Key votes", "; ".join(f"{k}: {v.get('key')} ({v.get('strength')})" for k, v in kv.items()), ""],
        ["Tuning", f"A4 = {tu.get('a4_hz')} Hz ({tu.get('cents_from_440')} cents; essentia {tu.get('essentia_a4_hz')})", _c(_v(H, "tuning", "confidence"))],
        ["Harmonic rhythm", f"{_v(H, 'harmonic_rhythm', 'value', 'typical')} ({_v(H, 'harmonic_rhythm', 'value', 'changes_per_bar')} changes per bar)", _c(_v(H, "harmonic_rhythm", "confidence"))],
        ["Modulations", ", ".join(_v(H, "modulations", "value", default=[])) or "none detected", _c(_v(H, "modulations", "confidence"))],
        ["Chord estimator agreement", _c(_v(H, "chords_per_bar", "agreement_madmom_vs_template")), ""],
    ]))
    ch = _v(H, "chords_per_bar", "value", default=[])
    if ch:
        md.append("\nChords per bar (final; madmom / template alternatives; bass note from the bass stem):\n\n")
        lines = []
        for i in range(0, len(ch), 8):
            lines.append([f"{ch[i]['bar']}-{ch[min(i + 7, len(ch) - 1)]['bar']}"] +
                         [(" ".join(c["halves"]) if c.get("halves") else c["chord"]) + ("" if c["confidence"] >= 0.5 else "?") for c in ch[i:i + 8]])
        md.append(_tbl(["Bars"] + [f"+{k}" for k in range(8)], [l + [""] * (9 - len(l)) for l in lines]))
        md.append("\n`?` = confidence below 0.5 (the two estimators disagree).\n")
    if "chroma" in figs:
        md.append("\n![chroma](figures/chords_chroma.png)\n")
    # structure
    md.append("\n## Structure\n")
    secs = _v(S, "sections", "value", default=[])
    md.append(_tbl(["#", "Label", "Letter", "Bars", "Count", "Start-end (s)", "Energy dB (rel.)", "Key"],
                   [[i + 1, s["label"], s.get("letter"), s["bar_range"], s["bars"], f"{s['start']:.1f}-{s['end']:.1f}",
                     f"{s['energy_db']} ({s['energy_rel']:+})", (s.get("key") or {}).get("key")] for i, s in enumerate(secs)]))
    md.append(f"\nConfidence {_c(_v(S, 'sections', 'confidence'))}; source {_v(S, 'sections', 'source')}; boundary agreement with the novelty "
              f"segmentation {_c(_v(S, 'sections', 'boundary_agreement_with_novelty'))}. Repeats (same letter): "
              + ", ".join(f"{k}: sections {v}" for k, v in (_v(S, 'repeats', default={}) or {}).items()) + ".\n")
    ev = _v(S, "energy_events", default=[])
    if ev:
        md.append("\nEnergy events: " + "; ".join(f"{e['type']} at bar {e['bar']}" + (f"-{e['to_bar']}" if 'to_bar' in e else '') + f" ({e['delta_db']:+} dB)" for e in ev[:20]) + "\n")
    # stems
    md.append("\n## Stems\n")
    si = _v(A, "stems", "info", default={})
    md.append(f"Separation: {si.get('tool', si.get('backend'))}" + (f", {si.get('seconds')} s" if si.get("seconds") else "")
              + (f", cost ${si.get('cost_usd')}" if si.get("cost_usd") is not None else "")
              + (f" (fallback after: {si['fallback_from']['error']})" if si.get("fallback_from") else "") + ".\n\n")
    ps = _v(A, "stems", "per_stem", default={})
    if ps:
        md.append(_tbl(["Stem", "LUFS", "True peak", "Pan", "Width", "Active bars", "Main band"],
                       [[n, d.get("integrated_lufs"), d.get("true_peak_dbtp"), d.get("pan"), _v(d, "stereo", "width"), d.get("active_bars"),
                         max(d["bands"], key=d["bands"].get) if d.get("bands") else ""] if not d.get("silent") else [n, "silent", "", "", "", "", ""]
                        for n, d in ps.items()]))
    if "stems" in figs:
        md.append("\n![stems](figures/stem_activity.png)\n")
    # instruments
    md.append("\n## Instruments\n")
    mixi = _v(I, "mix", "value", default=[])
    if mixi:
        md.append(_tbl(["Tag (mix)", "Mean prob", "Max bar prob", "Share of song", "Bars"],
                       [[r["label"], r["mean_prob"], r["max_bar_prob"], r["share_of_song"],
                         ", ".join(f"{a}-{b}" for a, b, _, _ in r["ranges_bars"][:6])] for r in mixi[:15]]))
    ea = _v(I, "electronic_vs_acoustic", "value", default={})
    md.append(f"\nElectronic vs acoustic: {ea.get('verdict')} (electronic share {ea.get('electronic_share')}). Genre hints: "
              + ", ".join(f"{g['label']} ({g['mean_prob']})" for g in _v(I, "genre_hints", "value", default=[])) + ".\n")
    st = _v(I, "stems", "value", default={})
    if st:
        md.append("\nTags per stem (top 4, mean probability):\n\n" + _tbl(["Stem", "Tags"], [[n, ", ".join(f"{r['label']} {r['mean_prob']}" for r in rs[:4])] for n, rs in st.items()]))
    if "instruments" in figs:
        md.append("\n![instruments](figures/instruments.png)\n")
    # timbre
    tb = _v(A, "timbre", "value", default={})
    if tb:
        md.append("\n## Timbre, production and synth rebuild hints\n")
        rows = []
        for n, d in tb.items():
            if d.get("silent"):
                continue
            h = d.get("harmonic") or {}
            rows.append([n, d["spectral"]["centroid_hz"], _v(d, "envelope", "attack_ms"), _v(d, "envelope", "level_250ms_after_peak_db"),
                         h.get("hnr_db"), h.get("odd_even_ratio_db"), h.get("inharmonicity"),
                         f"{_v(h, 'vibrato', 'rate_hz')} Hz / {_v(h, 'vibrato', 'depth_cents')} c" if h.get("vibrato") else "",
                         _v(d, "reverb_estimate", "amount"), _v(d, "pumping", "beat_folded_depth_db")])
        md.append(_tbl(["Stem", "Centroid Hz", "Attack ms", "dB @250 ms", "HNR dB", "Odd/even dB", "Inharm.", "Vibrato", "Reverb", "Beat ducking dB"], rows))
        kit = _v(tb, "drums", "kit", default={})
        if kit:
            md.append(f"\nDrum kit character: {kit.get('verdict')} (kick decay {kit.get('kick_decay_20db_s')} s, kick pitch {kit.get('kick_pitch_hz')} Hz).\n")
        md.append("\nRebuild hints:\n\n" + "\n".join(f"- **{n}**: {d['synth_hint']}" for n, d in tb.items() if d.get("synth_hint")) + "\n")
    # notes
    nt = A.get("notes") or {}
    if nt:
        md.append("\n## Notes (MIDI)\n")
        rows = []
        for n, d in nt.items():
            if n == "drum_grid_per_bar" or not isinstance(d, dict) or "value" not in d:
                continue
            s = d["value"].get("stats") or {}
            if s:
                rows.append([n, s.get("notes"), " - ".join(s.get("range", [])), s.get("notes_per_second"), s.get("max_polyphony"), d["value"]["midi"], _c(d["confidence"])])
        md.append(_tbl(["Stem", "Notes", "Range", "Notes/s", "Max polyphony", "File", "Conf."], rows))
        dr = _v(nt, "drums", "value", default={})
        if dr:
            md.append(f"\nDrums: {dr.get('counts')} hits. Most common bar pattern per section (16 steps, x = hit):\n\n")
            md.append(_tbl(["Section", "Bars", "Kick", "Snare", "Hat"],
                           [[p["section"], p["bars"]] + [f"`{_v(p, 'patterns', k, 'pattern', default='')}`" for k in ("kick", "snare", "hat")] for p in dr.get("patterns_per_section", [])]))
        if "pianoroll" in figs:
            md.append("\n![pianoroll](figures/pianoroll.png)\n")
    ly = _v(A, "lyrics", "value")
    md.append("\n## Lyrics\n")
    if isinstance(ly, dict) and ly.get("lines"):
        md.append(f"Language {ly['language']} (p={ly['language_prob']}); confidence {_c(_v(A, 'lyrics', 'confidence'))}. Draft:\n\n")
        md.append(_tbl(["Time", "Text"], [[f"{l['start']:.1f}", l["text"] + ("" if l["avg_logprob"] > -1 else " (?)")] for l in ly["lines"][:80]]))
    else:
        md.append(str(_v(A, "lyrics", "note", default="not run")) + "\n")
    md.append("\n## Into the studio\n\nThis report and `analysis.json` are the measurement. The study in GGS "
              "(a project with the tempo, meter, key, sections as markers and one channel per stem with the transcribed "
              "notes) is built from them by `tools/song-analyzer/to-daw.mjs <this folder>`; see `docs/song-studies.md`.\n")
    run = A.get("run") or {}
    md.append("\n## Run\n\n" + f"Total {run.get('seconds_total')} s for {run.get('audio_seconds')} s of audio; peak memory {run.get('peak_rss_gb')} GB.\n\n"
              + _tbl(["Stage", "Seconds"], [[k, v] for k, v in (run.get("stage_seconds") or {}).items()]))
    if run.get("errors"):
        md.append("\nStages with errors: " + "; ".join(f"{k}: {v}" for k, v in run["errors"].items()) + "\n")
    return "\n".join(md)


CSS = """
body{font-family:'DejaVu Sans',Arial,sans-serif;color:#1f2328;font-size:10.5px;line-height:1.45;margin:0}
h1{font-size:20px;margin:0 0 6px} h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #e5e7eb;padding-bottom:3px;break-after:avoid}
table{border-collapse:collapse;margin:6px 0;width:100%;font-size:9px;break-inside:auto} th,td{border:1px solid #e5e7eb;padding:2px 4px;text-align:left;vertical-align:top}
th{background:#f3f4f6} img{max-width:100%;break-inside:avoid;margin:4px 0} code{font-family:'DejaVu Sans Mono',monospace;font-size:8.5px}
"""


def to_pdf(md_text: str, out_html: Path, out_pdf: Path, title: str):
    import markdown as mdlib
    body = mdlib.markdown(md_text, extensions=["tables", "fenced_code"])
    out_html.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title><style>{CSS}</style></head><body>{body}</body></html>")
    from playwright.sync_api import sync_playwright
    exe = os.environ.get("CHROMIUM_PATH")
    if not exe:
        import glob
        c = sorted(glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))
        exe = c[-1] if c else None
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        pg = b.new_page()
        pg.goto(out_html.resolve().as_uri())
        pg.pdf(path=str(out_pdf), format="A4", margin={"top": "14mm", "bottom": "14mm", "left": "12mm", "right": "12mm"},
               print_background=True, display_header_footer=True, header_template="<span></span>",
               footer_template="<div style='font-size:7px;width:100%;text-align:center;color:#6b7280'><span class='pageNumber'></span> / <span class='totalPages'></span></div>")
        b.close()


def build(A, out: Path, mix: Path, stems: dict, notes: dict, pdf=True):
    figs = figures(A, out, mix, stems, notes)
    md = markdown(A, figs, out)
    (out / "report.md").write_text(md)
    if pdf:
        to_pdf(md, out / "report.html", out / "report.pdf", "Song analysis")
