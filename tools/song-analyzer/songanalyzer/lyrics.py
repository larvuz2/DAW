"""Lyrics with timestamps: faster-whisper (CTranslate2 Whisper, MIT) on the vocal stem, int8 on CPU.
Runs only when the vocal stem carries singing (PANNs singing probability and stem level)."""
from __future__ import annotations

from .common import item, ver


def analyze(vocals_path, fast=False):
    from faster_whisper import WhisperModel
    name = "base" if fast else "small"
    m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=4)
    segs, info = m.transcribe(str(vocals_path), vad_filter=True, word_timestamps=False, beam_size=1 if fast else 5,
                              condition_on_previous_text=False)
    lines = []
    for s in segs:
        txt = s.text.strip()
        if not txt:
            continue
        lines.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": txt,
                      "avg_logprob": round(s.avg_logprob, 2), "no_speech_prob": round(s.no_speech_prob, 2)})
    good = [l for l in lines if l["avg_logprob"] > -1.0 and l["no_speech_prob"] < 0.6]
    conf = min(1.0, max(0.0, 1 + sum(l["avg_logprob"] for l in good) / max(len(good), 1))) if good else 0.1
    return item({"language": info.language, "language_prob": round(info.language_probability, 2), "lines": lines,
                 "reliable_lines": len(good)}, conf, f"faster-whisper {ver('faster-whisper')} ({name}, int8)",
                note="singing is harder than speech: treat words as a draft; wordless vocals produce no or garbage lines")
