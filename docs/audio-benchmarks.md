# Audio benchmarks: GGS Synth

Numbers are measured, not assumed. Each one is reproduced by a command or asserted by a test, so a regression
fails CI rather than a listening session. Measurements below: Node 22, one core of an Intel Xeon @ 2.1 GHz (a
virtual machine — treat CPU figures as relative; a recent laptop core is 2–3× faster).

## Signal quality

| What | Result | Where it is checked |
|------|--------|---------------------|
| Tuning | within **0.1 cent** from A1 to A6 | `packages/synth-dsp/test/dsp.test.js` "tuning" |
| Oscillator aliasing (saw, C4–C8, 44.1 / 48 / 96 kHz, quality eco and high) | strongest non-harmonic component **≤ −80 dB** (measured −86 … −99 dB, the floor of the analysis window) | "oscillators do not alias" |
| Half-band decimator (2× oversampling) | flat to 18 kHz (±0.05 dB), **> 80 dB** rejection above 25.7 kHz (measured ≈ −95 dB) | "half-band filter" |
| Per-note independence | a chord is **exactly** the sum of its notes rendered alone (difference < 10⁻⁶), each with its own pressure, slide and bend | "voices are independent" |
| Bend one note of a chord | the bent note moves a semitone, its old pitch drops > 60 dB, the others do not move | "per-note expression" (also end-to-end in Chromium: `e2e/workflow-ggs.spec.js`) |
| Zipper noise | a tone at the control rate (and ×2, ×3) stays **< −75 dB** while pressure and slide sweep a resonant filter and the level | "no clicks … no zipper noise" |
| Note edges | the fastest envelope (1 ms attack, 5 ms release) never jumps more than 0.06 of full scale between samples | same test |
| Repeatability | two renders with the same seeds are **bit-identical** in Node; in the browser two offline renders differ by < 10⁻⁶ (the Web Audio graph may sum voices in a different order) | "renders repeat exactly"; e2e "offline renders repeat" |
| Reverb level vs size | a steady sound through 100 % reverb comes back within ±6 dB of its input from the smallest room to the largest hall | "effects" |
| Clean filters | lp12 / lp24 / hp24 are **−3.01 dB at the cutoff** (Butterworth) at zero resonance; the all-pass is flat within 0.01 dB; the morph filter equals lp12 at 0 and hp12 at 1 and keeps its peak level in between | `test/filters.test.js` |
| Ladder self-oscillation | a sine **within 1 cent of the cutoff** at 110 Hz, 1 kHz and 8 kHz, for all four pole mixes (measured −0.1 cent); none below resonance 0.85 | "ladder" |
| Acid / MS-20 | acid oscillates on pitch (±2 cents) only at full resonance; the MS-20 keeps its pass-band within 0.1 dB at any resonance and oscillates a few cents flat (measured −7.9), like the hardware | "acid", "MS-20" |
| Comb tuning | the fundamental peak stays **within 1.5 cents** of the cutoff for any damping (the damping filter's phase delay is taken out of the delay line) | "combs" |
| Formant / phaser | formant peaks sit on the published tenor vowels (within 40 cents) and move with cutoff and morph; the phaser has exactly 1, 3 and 6 notches at 2, 6 and 12 stages | "formant", "phaser" |
| Filter stability | every model stays finite and bounded under full-scale noise with all four controls jumping at random every 32 samples, at 44.1 and 96 kHz; after silence every model's memory reaches exactly zero | "survives abuse", "silence in, silence out" |
| Envelopes | the rendered level follows the formula (`envelopeAt`) through delay, attack, hold, decay, sustain and release within 0.03; patches with the old single curve migrate to the **same shape within 10⁻⁹** | `test/envelope.test.js` |
| Live structural edits | switching an oscillator, the unison count, a wavetable, a filter model or the routing on a sounding note leaves a curvature **< 0.002** at the edit — it was 0.05–0.15 (a step) before the fades | "live structural edits do not click" |

### What oversampling buys

Aliasing of patches that create harmonics after the oscillators, C6 at 44.1 kHz — strongest non-harmonic component
relative to the strongest harmonic:

| Patch | quality `eco` (1×) | `high` / `auto` (2×) |
|-------|-------------------:|---------------------:|
| Sync warp 0.6 | −36 dB | −52 dB |
| Pulse-width warp 0.7 | −42 dB | −59 dB |
| Low-pass, resonance 0.9, drive 0.6 | −28 dB | −57 dB |
| FM (sine → sine, amount 0.5) | −93 dB | −93 dB |

The test "oversampling lowers the aliasing…" asserts at least 8 dB of improvement per case, and that `auto` selects
2× for exactly these patches and 1× for patches that cannot alias.

Reproduce the raw numbers: the tests above print them on failure; the tables came from the same functions.

## CPU

`npm run bench:synth` — share of one core for N sustained voices (AudioWorklets run on one core):

| Patch, 44.1 kHz | 1 voice | 8 | 16 | 32 |
|-----------------|--------:|--:|---:|---:|
| Init (1 oscillator, 1 filter) | 0.3 % | 3 % | 7 % | 10 % |
| 3 oscillators | 0.5 % | 4 % | 7 % | **18 %** |
| 3 oscillators × 4 unison, 2 filters | 1.1 % | 9 % | 17 % | 35 % |
| 3 oscillators × 8 unison (worst case) | 1.7 % | 13 % | 26 % | 53 % |
| FM + warp + drive (2× oversampled) | 0.9 % | 7 % | 14 % | 28 % |
| Preset Glass Horizon (with chorus, delay, reverb) | 2.4 % | 8 % | 14 % | 24 % |
| Preset Velvet Pad | 2.0 % | 10 % | 19 % | 36 % |
| Ladder filter on one saw (2× oversampled) | 1.2 % | 7 % | 13 % | 31 % |
| Acid filter on one saw (2× oversampled) | 1.1 % | 8 % | 16 % | 31 % |
| MS-20 filter on one saw (2× oversampled) | 0.8 % | 7 % | 13 % | 26 % |
| Formant filter (five band-passes) | 0.6 % | 4 % | 6 % | 12 % |
| Phaser, 12 stages | 0.6 % | 4 % | 9 % | 17 % |

The analog-style filters cost about 0.6 % of a core per voice more than a clean filter at the same (doubled) rate,
and a little more while their cutoff is moving. They are meant for basses and leads; a 16-voice pad through a ladder
is fine, 32 voices of three unison oscillators through one is not.

At 48 kHz the figures are about 10 % higher; at 96 kHz about double (32 voices × 3 oscillators: 37 %; the
24-oscillator worst case no longer fits 32 voices on this machine — lower the unison or the polyphony there).
Effects cost about 1.5 % per channel, whatever the voice count.

The target "32 notes of 3 oscillators with pitch, pressure and slide moving at once" takes under a fifth of a core
at 44.1 and 48 kHz.

Voice stealing keeps a channel inside its `polyphony` (default 16): released notes go first, oldest first.

## Loudness policy

`node packages/synth-dsp/scripts/level-presets.mjs` measures every preset (and `--write` re-levels them):

- one note at velocity 0.8, no pressure, no slide, at the preset's typical pitch → **−18 LUFS** (loudest 400 ms,
  K-weighted), averaged over four takes (unison stacks and free LFOs beat differently each time);
- unless its sample peak would pass **−9 dBFS**: plucks and other sharp attacks are capped by their peak;
- a four-note chord at the same velocity stays within 1 dB of full scale.

`packages/synth-dsp/test/presets.test.js` asserts all three for all 30 presets, plus that pressure and slide audibly
change every one of them.

## Wavetables

All 46 tables (667 frames) build in about 0.4 s the first time they are needed (the 24 original ones: 0.12 s); the
slowest single table takes about 20 ms. `test/wavetables.test.js` pins the order and the sound of the original 24
and checks every table for level, DC, band-limiting and determinism.

## Not measured here

- Listening tests on reference monitors (transients, stereo image, filter character) — numbers do not replace ears.
- Realtime dropouts on specific hardware and browsers; the CPU table is the proxy.
- Browsers other than Chromium (the end-to-end suite runs there).
