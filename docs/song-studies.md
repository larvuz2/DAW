# Song studies

Learning from songs you like: upload a song in a Claude session on this repository, say *"understand this song and
take it to the studio"*, and Claude analyses it there — stems, tempo, key, chords, structure, grooves, sounds, mix —
and brings what is worth keeping into GreanTeaDawy as a **preset**: a template under *New from template → Study: …*
with the song's form, chord progressions, grooves and kinds of sound. You also get a private bundle with the
transcription, the stems and the report.

It is a workflow, not a feature of the app: the analysis needs about 2 GB of machine-learning models and several
minutes per song, so it runs in the session (`tools/song-analyzer`), and only its result enters the studio.

The method — which tool measures what, how sure each result is, what fails and how to spot it — is
[`song-analysis-method.pdf`](song-analysis-method.pdf), written and measured for GGS Composer; this repository carries
the same analyzer with the studio's own loudness meter in place of GGS Composer's.

## What you do

1. In a session on this repository, attach the audio (MP3, WAV, M4A, FLAC…) and ask, e.g. *"Understand this song and
   take it to the studio as a preset."* Say the title if the file name doesn't.
2. Wait: about 10 minutes of set-up the first time in a session, then roughly four to five times the song's length
   (a 4-minute song ≈ 19 minutes on the session's 4 CPU cores).
3. You get: a short description of the song and how sure each part is, a WAV of the preset as the studio plays it, a
   zip with everything, and a commit with the preset.
4. In your studio: `git pull`, restart, then **☰ → New from template → Study: …**. To see the transcription instead:
   **☰ → Import project file** → `study.gtd.json` from the zip. Stems and drum one-shots from the zip go into
   **Samples**.

Two things to decide once and tell Claude:

- **Where the stems are separated.** By default on the session's machine (free, ~6 minutes for a 4-minute song). With
  *"use fal"* the audio is uploaded to fal.ai under a neutral name and separated there in ~35 s for about $0.0007 per
  second of audio (≈ $0.17 for 4 minutes), paid by the `FAL_KEY` of your environment. Nothing is ever sent anywhere
  else.
- **What the preset is called.** By default *Study: <title>*.

## What comes out

| | Where | What |
|---|---|---|
| **The preset** | `packages/core/src/templates/studies/<id>.js` (committed) | a template: tempo, feel, key, sections with markers, a chord pattern, a bass pattern and a drum pattern per kind of section, an instrument and preset per role, shared reverb and kick-ducking when the song has them. The style of the song — not its melody, lyrics or audio |
| **The study card** | `docs/studies/<id>.md` (committed) | what was found: the one-paragraph description, the form table with chords as symbols and as numerals in the key, the grooves, levels and rebuild hints per stem, and *what to trust* |
| **The transcription** | `study.gtd.json` in the zip (private) | a project with one channel per stem and the notes as transcribed (bass, harmony, vocal melody, drums), section by section, sections as markers |
| **The stems and one-shots** | zip (private) | each non-empty stem as FLAC; the three clearest kick, snare and hat hits as WAV |
| **The report** | `report.pdf` in the zip (private) | the full measurement with figures: loudness curve, tempo curve, spectrogram, chords over chroma, stem activity, instrument tags, piano roll |
| **A preview** | `preset-preview.wav` | the preset rendered by the studio, with its loudness and band balance beside the original's |

Private material stays out of the repository (`uploads/` is git-ignored): it holds the song's audio and melody.

## How far to trust it

From the method's validation (two pieces with every note known, three real recordings) and a check in this
repository (the 16-bar test song of `fixtures/av`, whose content is known):

| | Reliable | Not reliable |
|---|---|---|
| Tempo, meter | tempo within 0.05 BPM on steady songs (120.0 for 120); 4/4 | rubato and live drift ("free / varying": bars are approximate); slow ballads may be read at half or double |
| Bar lines | right in the full analysis of the test song | the quick mode put them half a bar off (it said so: vote share 0.5); fixed by `--downbeat-shift` |
| Key | the notes in use | major vs its relative minor (the test song's A minor was read as C major: its Am–F–C–G loop is both) |
| Chords | roots in 89–100 % of bars; all 16 bars of the test song | qualities in dense or distorted music (bars marked `?`) |
| Sections | where they change | their names; short pieces (2 of the test song's 4 sections were found) |
| Stems | drums, bass, vocals | "other" mixes everything else; guitar and piano stems carry leakage |
| Drums | kick and hats | snares, especially soft or rim snares (often a copy of the kick row) |
| Notes | bass lines (F1 0.57–0.68), lead melodies | chords of mixed parts (a sketch: reverb and leakage come out as notes) |
| Sounds | kit character, attack, brightness, vibrato, width, reverb amount, kick-ducking | exact patches: the rebuild hints are starting points |
| Lyrics | — | never stored; sung vocals transcribe poorly |

Claude checks these before stating anything (the rules are in `.claude/skills/song-study/SKILL.md`) and writes what
could not be determined into the study card.

## For the session (commands)

```bash
bash tools/song-analyzer/setup.sh        # once per session: Python 3.11 env with pinned versions, ~10 min, 2.2 GB
```

```bash
tools/song-analyzer/analyze uploads/song.mp3 --out uploads/analysis/song --stems local
```

```bash
node tools/song-analyzer/to-daw.mjs uploads/analysis/song --name "Study: Song"
```

```bash
node tools/song-analyzer/audition.mjs uploads/analysis/song/study/preset-preview.gtd.json --wav uploads/analysis/song/study/preset-preview.wav --compare uploads/analysis/song
```

```bash
node tools/song-analyzer/to-daw.mjs uploads/analysis/song --save-template song --label "Study: Song"
```

```bash
node tools/song-analyzer/bundle.mjs uploads/analysis/song
```

| Analyzer option | Meaning |
|---|---|
| `--stems local` (default) / `fal` / `none` | where stems are separated (Demucs `htdemucs_6s`: vocals, drums, bass, guitar, piano, other) |
| `--stem-model htdemucs_ft` | four cleaner stems instead of six |
| `--fast` | a quick look: small beat model, one structure model, no lyrics |
| `--downbeat-shift N` | move every bar line N beats later (when chords change mid-bar) |
| `--reuse-stems` | keep the stems of an earlier run (re-runs take a fraction of the time) |
| `--start S --duration D` | analyse an excerpt |

`to-daw.mjs` keeps a `study/blueprint.json` that was edited by hand (`--redo` drafts it again); `--key "A minor"`
overrides the detected key. `audition.mjs` needs the built client (`npm run build`) and a Chromium
(`E2E_CHROMIUM=/path/to/chromium` for an installed one).

Measured on the session's machine (4 cores, no GPU): set-up 10 min; the 35-second test song 3 min in full mode
(1.9 min with `--fast`), of which structure 1.7 min and separation 20 s; a re-run with `--reuse-stems --fast` 52 s.
The method measured 18.5–19 min for 2.7–4.8-minute songs with local separation.

## The blueprint

`study/blueprint.json` is what a saved study is made of (`packages/core/src/templates/blueprint.js` turns it into a
template):

```json
{
  "name": "Study: …", "bpm": 120, "timeSig": [4, 4], "key": "A", "scale": "minor", "swing": 0,
  "sounds": { "kick": { "kind": "kick", "preset": "Punchy" }, "snare": { "kind": "snare" }, "hat": { "kind": "hat" },
              "bass": { "kind": "ggs", "preset": "Analog Bass" }, "chords": { "kind": "ggs", "preset": "Velvet Pad", "volume": 0.6 } },
  "reverb": { "decay": 3, "send": 0.35 }, "pump": false,
  "parts": { "A": { "chords": ["Am", "F", "C", "G"], "roman": ["i", "VI", "III", "VII"],
                    "drums": { "kick": "x...x...x...x...", "snare": "....x.......x...", "hat": "..x...x...x...x." },
                    "bass": "x-----x-x-----x-" } },
  "sections": [{ "name": "Intro", "letter": "A", "bars": 4, "play": ["chords"] },
               { "name": "Drop", "letter": "A", "bars": 8, "play": ["drums", "bass", "chords"] }],
  "study": { "…": "measurements kept with the draft; not saved into the template" }
}
```

A section plays the patterns of its `letter` (sections with the same letter share them); `play` says which of drums,
bass and chords sound in it. Chords are one per bar; a symbol the studio cannot read falls back to its root triad, a
bar marked `N` repeats the bar before. Drum rows and the bass rhythm are one bar of steps.

## Privacy and rights

The audio never leaves the session unless you choose fal for the stems. Uploads, stems, transcriptions and reports are
not committed. A saved study keeps what a musician would write on a chart after listening — tempo, key, form, chords,
groove, instrumentation — and leaves out the melody, the lyrics and every sample of the recording; the stems and
one-shots in your private bundle are the song's own audio, for your study.
