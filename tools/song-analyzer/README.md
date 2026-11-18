# song-analyzer

Analyses a full song (any format ffmpeg reads) and takes what is worth keeping into GreanTeaDawy. How it is used —
by Claude, in a session, when you upload a song — is in [`docs/song-studies.md`](../../docs/song-studies.md) and the
`song-study` skill; the method, tool choices, validation scores and decision rules are in
[`docs/song-analysis-method.pdf`](../../docs/song-analysis-method.pdf).

Ported from the GGS Composer repository (`tools/song-analyzer` there). Differences here: loudness, true peak, stereo
and band balance come from the studio's own meter (`measure.mjs`, the one `render_mix` uses) instead of the `ggs`
binary; the result goes into GreanTeaDawy (`to-daw.mjs`) instead of a GGS Composer project; `--downbeat-shift` was
added; the validation script (which needs GGS Composer projects) stayed behind.

```
tools/song-analyzer/analyze <audio file> --out <dir> [--stems local|fal|mureka|mureka-direct|none] [--fast]
       [--stem-model htdemucs_6s|htdemucs|htdemucs_ft] [--start S --duration D] [--reuse-stems] [--downbeat-shift N]
       [--no-lyrics] [--no-pdf]
node tools/song-analyzer/to-daw.mjs <dir> [--name "…"] [--key "A minor"] [--redo] | --save-template <id> [--label "…"]
node tools/song-analyzer/audition.mjs <project.gtd.json> [--wav out.wav] [--compare <dir>]
node tools/song-analyzer/bundle.mjs <dir> [--no-stems]
```

## Output of `analyze` (`<dir>`)

| File | Content |
|---|---|
| `analysis.json` | every result as `{"value", "confidence" (0-1), "source" (tool and version), ...}` |
| `report.md`, `report.pdf`, `report.html` | readable report with figures |
| `figures/*.png` | overview (waveform, loudness, sections), tempo curve, spectrogram, chords over chroma, stem activity, instrument tags, piano roll |
| `stems/*.wav` | separated stems (32-bit float, 44.1 kHz) |
| `midi/*.mid` | one file per stem plus `all.mid`; tempo map follows the beats, bar 1 = first downbeat |
| `study/…` | written by `to-daw.mjs`: `blueprint.json`, `preset-preview.gtd.json`, `study.gtd.json`, `study.md` |

## Setup from scratch

Requirements: Linux x86-64, `uv` (`pip install uv`), `ffmpeg`, a C++ compiler and `cmake`, Node.js with the
repository's `npm install` (the meter), ~4 GB of disk (environment 1.9 GB, model weights ~1.2 GB).

```
bash tools/song-analyzer/setup.sh     # creates .venv (Python 3.11), installs pinned packages (~10 min)
export FAL_KEY=...                    # only for --stems fal / mureka
```

`setup.sh` installs every package at the version in `requirements.lock.txt` (used as constraints), downloads the
PANNs weights (`~/panns_data/Cnn14_mAP=0.431.pth`) and installs headless Chromium for the PDF unless one exists under
`/opt/pw-browsers` or `CHROMIUM_PATH` is set. Other model weights (Demucs, Beat This!, allin1, faster-whisper)
download on first run, so the first analysis needs network access. Check the install with a short excerpt:
`tools/song-analyzer/analyze <audio> --out /tmp/check --fast --duration 30`.

## Privacy

Audio is sent only to the stem service you choose (fal / Mureka) under the neutral name `_upload.mp3`; by default
nothing leaves the machine. Never commit `uploads/` or analysis output (git-ignored).
