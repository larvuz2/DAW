---
name: song-study
description: Study a song the user uploads (MP3/WAV/…) — "understand this song", "analyze this audio", "take it to the studio as a preset" — by running tools/song-analyzer here (stems, tempo, key, chords, structure, grooves, sounds, mix), interpreting the result, and taking it into GreanTeaDawy as a template ("New from template → Study: …") plus a private bundle (transcription project, stems, one-shots, report).
---

# Song study

The user uploads audio in the chat and asks to understand it and take it to the studio. **You do the whole thing in
this session**: analyze, interpret, build the preset, hand over. It is not a feature of the app. Full reference:
`docs/song-studies.md`; the method and its measured accuracy: `docs/song-analysis-method.pdf`.

## Rules (read first)

- **The audio stays here.** Copy the upload to `uploads/<slug>.<ext>` (git-ignored; a neutral slug). Separation runs
  locally by default. Use `--stems fal` only when the user says so in this conversation: it uploads the audio to fal.ai
  and spends their `FAL_KEY` (about $0.0007 per second of audio). Never print the key. No other service, ever.
- **Never commit** `uploads/`, stems, MIDI transcriptions, reports or the bundle. What goes into the repository is the
  template (`packages/core/src/templates/studies/<id>.js`) and its study card (`docs/studies/<id>.md`).
- **A template keeps the style, not the song**: tempo, feel, key, form, chord progressions, drum grooves, bass rhythm,
  kinds of sound, mix moves. No melody, no lyrics, no audio. Never put lyrics in a card or a blueprint.
- **Say what you could not determine.** Every claim follows the checks below; the study card's "What to trust" is
  part of the deliverable.

## Steps

1. **Set up (once per session, ~10 min, 2.2 GB).** `npm install` if `node_modules` is missing; then, if
   `tools/song-analyzer/.venv` is missing: `bash tools/song-analyzer/setup.sh` (run it in the background).
   `npm run build` once for the audition step.
2. **Analyze** (in the background; about 4–5× the song's length on 4 cores — a 4-minute song ≈ 19 min):
   `tools/song-analyzer/analyze uploads/<slug>.mp3 --out uploads/analysis/<slug> --stems local`
   Always the full mode for a study; `--fast` only for a first look (its bar lines and sections are weaker).
3. **Check before you believe** (`report.md` first, then `analysis.json`; every item has `value`, `confidence`, `source`):
   - *Tempo*: trust when `rhythm.agreement.beat_this_vs_madmom_F ≥ 0.9` and stability is "steady"/"nearly steady";
     otherwise read the tempo curve and the half/double alternatives.
   - *Bar lines*: `downbeat_phase_vote_share < 0.7`, or most bars showing two chords (`halves`), means the downbeat is
     off → re-run with `--downbeat-shift N --reuse-stems` (N = 1…beats-per-bar−1; under a minute in `--fast`, longer
     in full) until chords change on the bar lines.
   - *Key*: fewer than 3 of 4 votes → state the tonal centre/mode and the relative key; a vi–IV–I–V loop is the
     relative minor as often as the major — decide by where phrases rest, and pass `--key "A minor"` to `to-daw.mjs`.
   - *Chords*: bars marked `?` are "approximately"; trust roots over qualities.
   - *Sections*: boundaries are measured, names are guesses — rename them by what plays (the stem activity).
   - *Drums*: kick and hats are good; a snare row equal to the kick row is the kick leaking, not a snare.
   - *Instruments*: name only tags present on the mix and on a matching stem.
4. **Draft**: `node tools/song-analyzer/to-daw.mjs uploads/analysis/<slug> --name "Study: <title>" [--key "…"]`
   → `study/blueprint.json`, `preset-preview.gtd.json`, `study.gtd.json` (the transcription), `study.md`.
5. **Interpret — this is your part.** Edit `study/blueprint.json` by hand:
   - `sections`: real names (Intro, Verse, Pre, Chorus, Drop, Bridge, Outro), `play` per section.
   - `parts.<letter>.chords`: the loop as a musician would write it (drop the `?` once decided, fix inversions that
     are noise); `drums`: rows as steps (`x...x...`), the snare/clap where the song's style puts it when the row is
     unreliable; `bass`: the one-bar rhythm.
   - `sounds`: an instrument and preset for each role, from the rebuild hints in `study.md` (waveform, envelope,
     vibrato, width) — `list_instruments` names them all; GGS presets for synths. `reverb`, `pump`, `swing`.
   Then run step 4 again (it keeps your blueprint; `--redo` drafts it afresh) to rebuild the preview and the card.
6. **Audition and compare**:
   `E2E_CHROMIUM=/opt/pw-browsers/chromium node tools/song-analyzer/audition.mjs uploads/analysis/<slug>/study/preset-preview.gtd.json --wav uploads/analysis/<slug>/study/preset-preview.wav --compare uploads/analysis/<slug>`
   prints `render_mix` and the preset's loudness and band balance beside the original's (same meter). Adjust
   (`sounds.<role>.volume`, a different preset) and repeat — two or three rounds, not a mastering session.
7. **Write the study card** (`study/study.md`): one paragraph (length, tempo, meter, feel, key/mode, form,
   instruments, energy arc, loudness), the section table, production notes (loudness, stereo, balance, reverb,
   sidechain), rebuild hints per stem, and what could not be determined.
8. **Save the preset**: `node tools/song-analyzer/to-daw.mjs uploads/analysis/<slug> --save-template <id> --label "Study: <title>"`
   → the template and `docs/studies/<id>.md`. `npm run lint && npm test`, commit those two (plus the regenerated
   `studies/index.js`), push.
9. **Hand over**: `node tools/song-analyzer/bundle.mjs uploads/analysis/<slug>` and send the zip (and the preview
   WAV) to the user. Tell them: `git pull` → *New from template → Study: …*; *File → Import project file* opens
   `study.gtd.json` (the transcription) or the preview; stems and one-shots go into *Samples*.
10. **Report** in plain words: what the song is, what the preset holds, how sure each part is, what was not found.

## What the tools are

| File | Does |
|---|---|
| `tools/song-analyzer/analyze` | the measurement: stems (Demucs), beats (Beat This! + madmom), structure (allin1 + novelty), key and chords (madmom, Essentia, templates), instruments (PANNs), notes (Basic Pitch), timbre, lyrics (Whisper) → `analysis.json`, `report.md/pdf`, `stems/`, `midi/` |
| `tools/song-analyzer/measure.mjs` | loudness, true peak, bands with the studio's own meter (so original and rebuild compare) |
| `tools/song-analyzer/to-daw.mjs` | analysis → blueprint, preview project, transcription project, study card; `--save-template` |
| `tools/song-analyzer/audition.mjs` | renders a project in a throwaway studio, reports it against the original, saves a WAV |
| `tools/song-analyzer/bundle.mjs` | the zip to hand over (FLAC stems, MIDI, projects, report, drum one-shots) |
| `packages/core/src/templates/blueprint.js` | blueprint → template spec (what a saved study is made of) |
