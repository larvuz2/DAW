# GGS Synth

The GGS Synth is the studio's sound-design instrument: a wavetable / FM hybrid with a modulation matrix, built so
that **every note can be played on its own** — its own pitch bend, pressure and slide. It is an original engine
(`packages/synth-dsp`, plain JavaScript, MIT) that runs in an AudioWorklet in the browser and in Node on the server.

[![The GGS Synth editor](screenshots/ggs-synth.png)](screenshots/ggs-synth.png)

Add one from the Browser (**Synths → GGS Synth**), or ask Claude: *"create a warm evolving pad with the GGS Synth"*.

## Signal path

```
oscillators A · B · C ─┐                       ┌─ filter 1 ─┐ serial or
sub oscillator ────────┼─ each routed to ──────┤            ├─ parallel ─→ amp (envelope 1 × velocity) ─→ pan
noise ─────────────────┘  f1 / f2 / both /     └─ filter 2 ─┘                       │
                          direct                                    per note ───────┘
                                                                    per channel ↓
                                                    drive → chorus → delay → reverb → gain → channel strip → mixer
```

| Section | What it has |
|---------|-------------|
| **Oscillators A, B, C** | 46 wavetables scanned by *Position*; level, pan, octave/semi/fine; **unison** 1–8 with detune, blend and stereo spread; start phase and phase randomness; **warp** (bend, pulse-width, sync, mirror, fold, quantize); **FM** — phase modulation from another oscillator, the sub, noise or itself (feedback) |
| **Sub / Noise** | Sine, triangle, saw or square 0–3 octaves down; white, pink or brown noise with a colour control. Each routed like an oscillator |
| **Filters 1 & 2** | 21 models (see [Filters](#filters)): clean low-, high- and band-pass at 12 or 24 dB/octave, notch, peak, all-pass and a morphing shape; analog-style **ladder**, **acid** and **MS-20**; **formant**, **phaser** and two tuned **combs**. Cutoff, resonance, drive, key tracking and a *Morph* control whose job depends on the model |
| **Envelopes 1–4** | Delay, attack, hold, decay, sustain, release, and a curve for each slope (attack, decay, release). Envelope 1 is the amp envelope |
| **LFOs 1–4** | Sine, triangle, saw, ramp, square, random steps, random glide; rate in Hz or tempo-synced (1/32 … 8 bars); per note or free-running; fade-in; phase |
| **Macros 1–4** | Four knobs a patch assigns in the matrix. They can be automated over the song |
| **Matrix** | 16 routes: source → target × amount, optionally × a second source ("via") |
| **Effects** | Drive (soft, hard, tube, fold — oversampled), chorus, tempo-synced ping-pong delay, reverb, output gain |
| **Voice** | Polyphony 1–32, mono, legato, glide, velocity and release-velocity sensitivity, quality |

### Modulation

Sources: `env1`–`env4`, `lfo1`–`lfo4`, `velocity`, **`pressure`**, **`timbre`** (slide), **`bend`** (the note's pitch
curve), `key`, `random` (one value per note), `releaseVel`, `macro1`–`macro4`.

Targets: `pitch`, `pitchFine`, `level`, `pan`; per oscillator `oscAPitch`, `oscAPos`, `oscALevel`, `oscAPan`,
`oscAWarpAmt`, `oscAFm`, `oscADetune` (and B, C); `subLevel`, `noiseLevel`; `f1Cutoff`, `f1Res`, `f1Drive`, `f1Morph` (and f2);
`lfo1Rate`–`lfo4Rate`.

**An amount of 1 moves the target across its whole range**: `f1Cutoff` 0.3 = 3 octaves, `oscAPos` 0.5 = half the
table, `pitch` 0.5 = 12 semitones, `pitchFine` 0.3 = 0.3 semitones. A route with `via: pressure` is scaled by the
note's pressure — e.g. `lfo1 → pitchFine 0.3 via pressure` is a vibrato that deepens as a note is pressed.

Everything except the macros and "free" LFOs is **per note**: pressure on one note changes that note's filter and
nobody else's. See [expression-engine.md](expression-engine.md).

The Matrix tab and every tool reply spell each route out in the units of its target, from where the target's knob
stands: *"Filter 1 cutoff 850 Hz → 4.49 kHz as pressure goes 0 → 1"*, *"Pitch −30 ct ↔ +30 ct as LFO 1 swings
−1 ↔ 1, depth scaled by pressure"* (`describeRoute` in `packages/synth-dsp/src/patch.js`).

[![The modulation matrix](screenshots/ggs-matrix.png)](screenshots/ggs-matrix.png)

### Filters

| Model | Character | Morph |
|-------|-----------|-------|
| `lp12` `lp24` `hp12` `hp24` `bp12` `bp24` `notch` `peak` | Clean: a zero-delay-feedback state-variable filter. Exact cutoff, linear, stable under any sweep; Butterworth at zero resonance | — |
| `allpass` | Flat response, the phase turns around the cutoff: moving notches when run in parallel with the other filter | — |
| `morph` | One clean 2-pole filter whose shape slides low-pass → band-pass → high-pass with the resonant peak held level | shape |
| `ladder24` `ladder12` `ladderBp` `ladderHp` | Transistor ladder (Moog style) with a saturating input stage: warm and fat; the resonance sings, thins the bass a little and **self-oscillates as a sine exactly on the cutoff** above about 0.9 | — |
| `acid` | Diode ladder (TB-303 style): a soft slope that is darker than its cutoff suggests and a rubbery, squelching resonance. Drive sits after the filter, so the sweep itself screams | — |
| `ms20Lp` `ms20Hp` | Sallen-Key (Korg-35 style) with the resonance clipped inside the loop: it screams instead of whistling, keeps its bass at any resonance and ducks under a loud input | — |
| `formant` | Five resonances placed like a tenor's vowels. Cutoff moves the size of the throat (1000 Hz = natural), resonance narrows the formants | vowel A · E · I · O · U |
| `phaser` | 2–12 all-pass stages mixed with the dry signal, per note; resonance sharpens the peaks between the notches | stages |
| `comb` `combNeg` | A tuned feedback delay: cutoff is its pitch (key track 1 tunes it to the note), resonance its ring time. With a noise burst it is a plucked string; `combNeg` gives the hollow, odd-harmonic set an octave down | damping |

The analog-style models are ports of the GGS Composer filter crate: the delay-free loops are solved per sample
(Zavalishin's topology-preserving forms, one Halley step around a rational `tanh`), not approximated with a unit
delay — which is why the self-oscillation is in tune (within 0.1 cent for the ladder) at any cutoff and sample rate.
They make harmonics of their own, so quality `auto` renders them at 2×.

The curve in the editor is **measured**: `filterResponse` feeds the real filter an impulse and transforms what comes
out, so it is right for every model and shows what drive and resonance compensation actually do.

### Wavetables

`basic` (sine → triangle → saw → square → pulse), `tilt`, `pwm`, `resonant`, `formant` (vowels), `glass`, `fmbell`,
`fmgrowl`, `drawbar`, `sync`, `fold`, `metal`, `airy`, `ladder` (one overtone per frame), `primes`, `octaves`, `comb`,
`staircase`, `tine`, `bowed`, `reed`, `dust`, `hollow`, `supersine` — and, ported from the GGS Composer factory set:
`oddeven`, `lofi`, `phasedist` (CZ-style), `cheby`, `pluck`, `sawstack`, `hiss`, `drift`, `aurora`, `brass`, `reese`,
`acid`, `overdrive`, `vowelbass`, `crystal`, `bitlogic`, `talkbox`, `whisper`, `ringmod`, `trifold`, `vosim`,
`darkmatter`. The wavetable picker in the editor shows all 46 with their waves; `describe_synth` topic "wavetables"
describes each.

Tables are stored as harmonic series, not samples. The engine builds band-limited copies on demand — three per
octave — and a note only ever reads a copy whose highest harmonic is below Nyquist, so the oscillators themselves
cannot alias. Frames of a table share a phase convention, so scanning between them cross-fades without cancelling.

### Presets

30 presets in six families, each with four named macros and a stated response to pressure and slide:

| Family | Presets |
|--------|---------|
| Pads | Velvet Pad, Glass Horizon, Cinema Atmos, Choir of Air, Solar Drift |
| Leads | Touch Lead, Crystal Lead, Mono Titan, Sync Razor, Overtone Flute |
| Bass | Deep Sub, Analog Bass, Neuro Bass, Reese Engine, Acid Line |
| Keys | Glass Keys, Tine Electric, Pluck Garden, Dream EP, Hollow Mallet |
| Sequences | Arp Prism, Pulse Runner, Poly Rhythm, Bell Sequence, Chip Stepper |
| Experimental | Spectral Motion, Metal Resonator, Nova Stack, Vowel Morph, Fold Drone |

Presets built on the analog-style and special filters: *Acid Line* (`acid`), *Analog Bass* and *Mono Titan*
(`ladder24`), *Neuro Bass* (`ms20Lp`), *Vowel Morph* (`formant`), *Solar Drift* (a `phaser` after its low-pass),
*Pluck Garden* and *Metal Resonator* (`comb`).

Presets are **levelled by measurement** (`node packages/synth-dsp/scripts/level-presets.mjs`): one note at velocity
0.8 peaks at −18 LUFS (loudest 400 ms), unless its sample peak would pass −9 dBFS — sharp attacks are capped by
their peak instead. Swapping presets does not upset a mix. The **Expressive synths** project template (File → New
from template) is a 24-bar piece on six of them with a full performance written into the notes.

## The editor

Select a GGS channel and open **Channel settings** (F8).

- **Presets**: the name in the header opens a browser — categories, and a search that looks at names, descriptions,
  macro names and tags worked out from each patch (`acid`, `fm`, `unison`, `mono glide`, `tempo-synced` …). ↑ ↓ load
  the next preset as they move, so you can audition with one hand on a keyboard; ‹ › step without opening it.
- **Oscillators**: waveform and harmonic spectrum of each oscillator at its position. The wavetable name opens a grid
  of all 46 tables drawn at the start, middle and end of each; search it, or walk it with the arrow keys.
- **Filters**: the measured response of each filter. **Drag the handle**: left/right is the cutoff, up/down the
  resonance. The menu is grouped (clean, analog, special) and a line under the knobs says what the chosen model is for.
- **Envelopes & LFOs**: envelopes are shaped by hand — square nodes for the delay, the attack, the hold, decay +
  sustain and the release; **round handles bend a slope** (press one twice to reset it). Attack and hold share a
  node while the hold is zero: drag it right to add a hold. Sections that are not routed yet are dashed.
- **Matrix**: every route with a sentence underneath saying what it does in real units.
- **Effects**, and **All parameters**: every parameter of the patch in one searchable table — value, range and what it
  does — with a *Changed* filter that shows what makes this patch different from the init patch. The same
  descriptions are the tooltips of every control.

The header also has the four macros with their names, gain, and **Export / Import** of a patch as a `.json` document.

| | |
|---|---|
| [![Filters](screenshots/ggs-filters.png)](screenshots/ggs-filters.png) **Filters** — the measured response; drag the handle | [![Envelopes](screenshots/ggs-envelopes.png)](screenshots/ggs-envelopes.png) **Envelopes** — nodes for the times, round handles for the curves |
| [![Preset browser](screenshots/ggs-presets.png)](screenshots/ggs-presets.png) **Presets** — search, categories, tags | [![Wavetables](screenshots/ggs-wavetables.png)](screenshots/ggs-wavetables.png) **Wavetables** — all 46, drawn |

The **touch pad** at the bottom plays the patch the way an MPE controller would: hold it to sound the step note,
move up for pressure and right for slide.

A knob turned while notes sound changes them immediately. Changes to what a voice is made of — switching an
oscillator, picking another wavetable or filter model, changing the routing — are **click-free**: that part of the
voice fades out for 4 ms, is swapped while silent and fades back in. A drag on a graph is one undo step. Everything
is undoable and syncs live to other tabs.

## Patch documents

Inside a project a patch is the instrument's flat `params` (like every instrument). For files and agents the same
patch reads as a document (`paramsToPatch` / `patchToParams` in `packages/synth-dsp/src/patch.js`):

```json
{
  "format": "ggs-synth-patch", "version": 1, "name": "Glass Horizon",
  "oscillators": [{ "id": "A", "table": "glass", "position": 0.35, "unison": 3, "detune": 7 }],
  "filters": [{ "id": 1, "type": "lp12", "cutoff": 5200 }],
  "envelopes": [{ "id": 1, "attack": 1.2, "release": 3 }],
  "modulation": [{ "source": "pressure", "target": "oscAPos", "amount": 0.42 }],
  "voice": { "polyphony": 16 },
  "effects": { "reverb": { "mix": 0.5, "size": 0.85 } }
}
```

A document may be partial; an oscillator or filter it describes is switched on. A `modulation` list replaces the
whole matrix. Envelopes take `delay`, `attack`, `hold`, `decay`, `sustain`, `release`, `attackCurve`, `decayCurve`,
`releaseCurve`; filters also take `morph`. Documents and projects saved by 0.8.0, whose envelopes had one `curve`,
load unchanged: the single curve is converted to the three stage curves that draw exactly the same envelope.

## For Claude (MCP)

| Tool | Does |
|------|------|
| `describe_synth` | The reference: overview, every field with its range and what it does, the filter models, wavetables, modulation sources/targets, presets |
| `create_synth_patch` | A GGS channel from a preset and/or a patch document |
| `get_synth_patch` / `update_synth_patch` | Read a patch (summary or document) / apply a document |
| `set_synth_oscillator`, `set_synth_filter`, `set_synth_envelope`, `set_synth_lfo`, `set_synth_modulation`, `set_synth_effect` | Edit one section, strictly validated. `set_synth_filter` replies with the measured response of the setting; every reply lists the modulation routes in real units |
| `analyze_synth_patch` | Render a note or chord **on the server** (no browser) and measure pitch, loudness, spectrum, envelope — optionally with pressure / slide / pitch curves and macro values |

Macros are automated with `add_automation` (target `channel`, param `macro1`…`macro4`).

## Engineering notes

- **One AudioWorklet processor per note** (`ggs-voice`). The patch arrives with the note (`processorOptions`); gate,
  kill, pitch, pressure, timbre and the four macros are AudioParams. Nothing depends on message timing, so realtime
  playback and offline renders share one deterministic path; two renders of a song are the same audio.
- A per-channel `ggs-fx` processor runs the effects after the voices are summed, and four constant sources feed
  every voice's macro inputs (that is what automation moves).
- Modulation is evaluated every 16 samples and every audible control is ramped across the block: no zipper noise.
- **Oversampling is selective** (quality `auto`): a patch that makes new harmonics after the oscillators — FM,
  warp, filter drive, the ladder / acid / MS-20 filters, the combs — runs at 2× with a polyphase half-band decimator; a plain patch, which cannot alias,
  runs at 1×. `high` forces 2×, `eco` never oversamples.
- Random parts of a note (unison phases, noise, random LFOs) are seeded from the note's time and key: renders repeat.
- A channel's wavetables are built by its effects processor when the channel appears or its patch changes — never
  on a note's first block, where the tens of milliseconds it takes would be a dropout.
- The effects rest by **level**, not by a timer: processing stops once nothing has come in and nothing audible has
  come out for longer than one echo, so a long feedback delay is never cut off.
- **Structural edits wait for a fade** (`SWAP_KEYS` in `voice.js`): each oscillator is its own unit, everything on
  the buses (filter models, routing, sub and noise) another. `setParams` applies knob moves at once and holds the
  structural part back until its unit's gate has closed.
- Filters live in `packages/synth-dsp/src/filters.js` (`VoiceFilter`): coefficients are computed per control block and
  ramped per sample; the nine original clean types run the same code as before.
- Measured quality and CPU numbers: [audio-benchmarks.md](audio-benchmarks.md).

To change the engine see `.claude/skills/ggs-synth/SKILL.md`.
