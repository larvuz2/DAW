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

## Not measured here

- Listening tests on reference monitors (transients, stereo image, filter character) — numbers do not replace ears.
- Realtime dropouts on specific hardware and browsers; the CPU table is the proxy.
- Browsers other than Chromium (the end-to-end suite runs there).
