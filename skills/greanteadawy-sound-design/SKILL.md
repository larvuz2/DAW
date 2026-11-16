---
name: greanteadawy-sound-design
description: Design original synth sounds with GreanTeaDawy's GGS Synth and make parts expressive with per-note pitch, pressure and slide curves — patches from scratch or from presets, modulation routing, macros, and measuring the result with analyze_synth_patch. Use when the user asks for a custom or original sound (pad, lead, bass, pluck, keys, arp, texture), for a synth patch, for expressive / MPE-style / bending / vibrato / swelling notes, or to make a synth line sound human in GreanTeaDawy.
---

# Sound design & expressive performance in GreanTeaDawy

Two tools make a part sound made, not generated: a patch designed for the part (the **GGS Synth**) and a performance
written into the notes (**per-note expression**). You can't hear — `analyze_synth_patch` measures a patch on the
server (pitch, LUFS, spectrum, envelope) with no browser needed. Work in a loop: **change → analyze → compare**.

## 1. Know the instrument

`describe_synth` (overview), then the topic you need: `filters`, `wavetables`, `modulation` (sources, targets, the
chaos generators), `parameters`, `presets`.

Signal path per note: oscillators A/B/C (46 wavetables + unison + warp + FM) + sub + noise → filter 1 / filter 2
(21 models) → amp (envelope 1). Per channel: drive → chorus → delay → reverb → gain. Movement: 4 envelopes, 4 LFOs,
2 chaos generators, 8 macros, 64 modulation routes. Amounts are fractions of the target's range: `f1Cutoff 0.3` = 3 octaves, `oscAPos 0.5` = half
the table, `pitch 0.5` = 12 semitones, `pitchFine 0.3` = 0.3 semitones.

## 2. Start close, then shape

- `create_synth_patch name="Pad" preset="Velvet Pad"` when a preset is near (30 presets; each says what its macros,
  pressure and slide do). Then adjust with the `set_synth_*` tools.
- From scratch: `create_synth_patch` with a `patch` document, or Init + section tools. Recipes: [recipes.md](recipes.md).

One section per call, only the fields that change:

| Goal | Call |
|------|------|
| Timbre | `set_synth_oscillator oscillator="A" table=… position=… unison=… detune=…` |
| Tone / sweep | `set_synth_filter filter=1 type="lp24" cutoff=… resonance=…` (the reply shows the measured response) |
| Shape in time | `set_synth_envelope envelope=1 attack=… decay=… sustain=… release=…` (+ `delay`, `hold`, `attackCurve`, `decayCurve`, `releaseCurve`) |
| Motion | `set_synth_lfo lfo=1 …` + `set_synth_modulation routes=[{source:"lfo1", target:"oscAPos", amount:0.2}]` |
| A rhythm inside the note | `set_synth_lfo lfo=2 steps=[1,0,0.5,0,1,-1,0.5,0] sync="1bar" trigger="free"` → `level` or `f1Cutoff` |
| Movement that never loops | `set_synth_chaos chaos=1 type="lorenz" rate=0.1 path="same"` + a route from `chaos1` |
| Space | `set_synth_effect chorus={mix} delay={mix, sync} reverb={mix, size}` |

Choosing a filter — the model is half the sound:

| You want | Filter |
|----------|--------|
| Neutral, precise, modern | `lp24` / `lp12` (clean) |
| Warm, fat, singing — classic analog bass and lead | `ladder24` (brighter: `ladder12`); resonance > 0.9 self-oscillates in tune |
| Acid squelch | `acid`, resonance 0.75–0.95, cutoff 300–600 Hz (it sounds darker than the number), a fast envelope on `f1Cutoff` |
| Snarl and scream that keeps its bass | `ms20Lp` (resonance 0.5–0.8, drive to taste) |
| Vowels, talking, choirs | `formant`, cutoff 1000, `keyTrack 0`; move `f1Morph` (0 A · 0.25 E · 0.5 I · 0.75 O · 1 U) |
| Swirl inside each note | `phaser` after a low-pass, a slow LFO on its cutoff; `morph` = stages |
| Plucked string, metal, pipes | `comb` with `keyTrack 1`, cutoff 261.63, a noise burst in; resonance = ring time, `morph` = damping (`combNeg` = hollow) |
| A shape that moves | `morph` (low-pass → band-pass → high-pass on `f1Morph`) |

Envelope curves: negative = fast first (a natural decay; `decayCurve -0.8` is a sharp pluck), 0 = straight, positive
= slow first (`attackCurve 0.5` is a swell that arrives late). `hold` keeps a pluck's body before it falls.

Chaos — which one when:

| You want | Chaos |
|----------|-------|
| Analog life: every voice a few cents off, differently | `drift`, rate 0.2–0.5, path `note` → `pitchFine` 0.04–0.08 (and a little → `oscADetune`) |
| A pad that keeps moving without an LFO you can hear cycling | `lorenz` or `rossler`, rate 0.05–0.2, path `same` → `oscAPos` 0.2, `f1Cutoff` 0.08 |
| A generative step pattern in time with the song | `turing`, `sync "1/16"`, path `same`, `steps` 8 or 16, character 0–0.15 (0 locks the loop) → `f1Cutoff` or `pitch` |

A render is the same audio every time, whatever chaos you use: a path is fixed by its note.

Macros: presets name and route macros 1–4; **5–8 are free** — route them (`macro5` → …) for the moves this song
needs and automate them with `add_automation` (param `macro5`).

Rules that save a patch:
- Envelopes 2–4 and LFOs do **nothing** until routed in the matrix.
- Bass, plucks, anything percussive: `phaseRandom 0` (same attack every note), sub `to "direct"`.
- Mono lines: `update_synth_patch patch={voice:{mono:true, legato:true, glide:0.05}}`; never write chords on a mono patch.
- Leave `quality` on `auto`. Unison multiplies CPU: 2–5 voices is plenty; keep `polyphony` at what the part needs.

## 3. Measure it

`analyze_synth_patch channel="Pad" notes=["C3","G3","E4"]` → pitch, LUFS, peak, spectrum bands, attack/decay.
- Presets sit near **−18 LUFS per note**: match that with `set_synth_effect gain=…` so the mix doesn't jump.
- Check the envelope against the part: a pad attack of 1 s on 1-beat chords never opens; a pluck that takes 3 s to
  reach −40 dB smears fast lines.
- Compare with and without a gesture: `pressure={points:[{at:0,value:1}]}` vs none — the spectrum centroid should
  move if pressure is routed to brightness.

## 4. Make it respond to touch

A patch is expressive when the matrix listens to the note:

```
set_synth_modulation channel="Lead" routes=[
  {source:"pressure", target:"f1Cutoff", amount:0.3},
  {source:"lfo1", target:"pitchFine", amount:0.3, via:"pressure"},
  {source:"timbre", target:"oscAPos", amount:0.45},
  {source:"velocity", target:"f1Cutoff", amount:0.15}]
```

Assign the macros (`macro1..4`) to the two or three moves a player would reach for, set them with
`set_synth_modulation macros=[…]`, and automate them over sections with `add_automation target={type:"channel",
channel:"Pad", param:"macro1"}`.

## 5. Write the performance

`set_note_expression` shapes notes by id, pitch name, step range or `all`. Curves are relative to each note
(0 = start, 1 = end). Pitch is in semitones; pressure and slide are 0..1.

| Musical idea | Call |
|--------------|------|
| Slide up into a note | `pitch={shape:"scoop", depth:1}` |
| Bend one note of a chord | `noteIds=[that note] pitch={shape:"bend", to:1, end:0.4}` |
| Vibrato that arrives late | `pitch={shape:"vibrato", rateHz:5.5, depth:0.25, delay:0.35}` |
| A note that swells | `pressure={shape:"swell", peak:0.85, at:0.6}` |
| Open the sound through a phrase | `timbre={shape:"ramp", to:0.9}` |
| Fall off at the end of a phrase | `pitch={shape:"fall", depth:3}` |

- Pitch curves bend **any** instrument; pressure and slide only do something on a GGS Synth whose patch routes them
  (the tool tells you when a curve changes nothing).
- Shape the notes that matter: phrase starts, long notes, the highest note, the last note. Leave the rest plain.
- `add_notes` takes `expression` inline; `copy_note_expression` moves a gesture to other notes;
  `transform_note_expression scale=0.5` tames an overdone one.

## 6. Check, then listen

`evaluate_composition` → fix every issue (chords on a mono patch, curves nothing hears, notes off the key).
Then `render_mix` for the sound in the mix, and `play`.
