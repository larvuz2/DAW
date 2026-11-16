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
| **Oscillators A, B, C** | 24 wavetables scanned by *Position*; level, pan, octave/semi/fine; **unison** 1–8 with detune, blend and stereo spread; start phase and phase randomness; **warp** (bend, pulse-width, sync, mirror, fold, quantize); **FM** — phase modulation from another oscillator, the sub, noise or itself (feedback) |
| **Sub / Noise** | Sine, triangle, saw or square 0–3 octaves down; white, pink or brown noise with a colour control. Each routed like an oscillator |
| **Filters 1 & 2** | Low-, high- and band-pass at 12 or 24 dB/octave, notch, peak and a tuned **comb**; resonance, drive, key tracking. Topology-preserving (zero-delay-feedback) state-variable filters: stable under any sweep |
| **Envelopes 1–4** | Attack, decay, sustain, release and a curve control. Envelope 1 is the amp envelope |
| **LFOs 1–4** | Sine, triangle, saw, ramp, square, random steps, random glide; rate in Hz or tempo-synced (1/32 … 8 bars); per note or free-running; fade-in; phase |
| **Macros 1–4** | Four knobs a patch assigns in the matrix. They can be automated over the song |
| **Matrix** | 16 routes: source → target × amount, optionally × a second source ("via") |
| **Effects** | Drive (soft, hard, tube, fold — oversampled), chorus, tempo-synced ping-pong delay, reverb, output gain |
| **Voice** | Polyphony 1–32, mono, legato, glide, velocity and release-velocity sensitivity, quality |

### Modulation

Sources: `env1`–`env4`, `lfo1`–`lfo4`, `velocity`, **`pressure`**, **`timbre`** (slide), **`bend`** (the note's pitch
curve), `key`, `random` (one value per note), `releaseVel`, `macro1`–`macro4`.

Targets: `pitch`, `pitchFine`, `level`, `pan`; per oscillator `oscAPitch`, `oscAPos`, `oscALevel`, `oscAPan`,
`oscAWarpAmt`, `oscAFm`, `oscADetune` (and B, C); `subLevel`, `noiseLevel`; `f1Cutoff`, `f1Res`, `f1Drive` (and f2);
`lfo1Rate`–`lfo4Rate`.

**An amount of 1 moves the target across its whole range**: `f1Cutoff` 0.3 = 3 octaves, `oscAPos` 0.5 = half the
table, `pitch` 0.5 = 12 semitones, `pitchFine` 0.3 = 0.3 semitones. A route with `via: pressure` is scaled by the
note's pressure — e.g. `lfo1 → pitchFine 0.3 via pressure` is a vibrato that deepens as a note is pressed.

Everything except the macros and "free" LFOs is **per note**: pressure on one note changes that note's filter and
nobody else's. See [expression-engine.md](expression-engine.md).

[![The modulation matrix](screenshots/ggs-matrix.png)](screenshots/ggs-matrix.png)

### Wavetables

`basic` (sine → triangle → saw → square → pulse), `tilt`, `pwm`, `resonant`, `formant` (vowels), `glass`, `fmbell`,
`fmgrowl`, `drawbar`, `sync`, `fold`, `metal`, `airy`, `ladder` (one overtone per frame), `primes`, `octaves`, `comb`,
`staircase`, `tine`, `bowed`, `reed`, `dust`, `hollow`, `supersine`.

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

Presets are **levelled by measurement** (`node packages/synth-dsp/scripts/level-presets.mjs`): one note at velocity
0.8 peaks at −18 LUFS (loudest 400 ms), unless its sample peak would pass −9 dBFS — sharp attacks are capped by
their peak instead. Swapping presets does not upset a mix. The **Expressive synths** project template (File → New
from template) is a 24-bar piece on six of them with a full performance written into the notes.

## The editor

Select a GGS channel and open **Channel settings** (F8). Tabs: *Oscillators* (waveform and harmonic spectrum of each
oscillator at its position), *Filters* (frequency response), *Envelopes & LFOs* (shapes; sections that are not routed
yet are dashed), *Matrix*, *Effects*. The header has the preset, the four macros with their names, gain, and
**Export / Import** of a patch as a `.json` document.

The **touch pad** at the bottom plays the patch the way an MPE controller would: hold it to sound the step note,
move up for pressure and right for slide.

A knob turned while notes sound changes them immediately. Everything is undoable and syncs live to other tabs.

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
whole matrix.

## For Claude (MCP)

| Tool | Does |
|------|------|
| `describe_synth` | The reference: overview, every field and range, wavetables, modulation sources/targets, presets |
| `create_synth_patch` | A GGS channel from a preset and/or a patch document |
| `get_synth_patch` / `update_synth_patch` | Read a patch (summary or document) / apply a document |
| `set_synth_oscillator`, `set_synth_filter`, `set_synth_envelope`, `set_synth_lfo`, `set_synth_modulation`, `set_synth_effect` | Edit one section, strictly validated |
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
  warp, filter drive, comb — runs at 2× with a polyphase half-band decimator; a plain patch, which cannot alias,
  runs at 1×. `high` forces 2×, `eco` never oversamples.
- Random parts of a note (unison phases, noise, random LFOs) are seeded from the note's time and key: renders repeat.
- Measured quality and CPU numbers: [audio-benchmarks.md](audio-benchmarks.md).

To change the engine see `.claude/skills/ggs-synth/SKILL.md`.
