# Studio effects and the engine instruments

Fourteen effects and three instruments that run as the studio's own DSP code in the audio thread — the same code in
the browser, in an offline render and in Node, which is where they are measured. They sit next to the effects and
instruments that were there before: nothing existing changed its sound.

Nothing here has been tuned by ear by a person: every figure on this page was measured by the tests
(`packages/synth-dsp/test`). What they sound like is for you to judge.

## The effects

In the mixer, *+ Add effect…* lists every effect by what it is for. Each is an insert like any other: it can be
reordered, switched off, automated (the knobs marked as automatable), and Claude sets it with `add_effect` /
`update_effect`.

| Type | Name | Group | Settings |
| --- | --- | --- | --- |
| `maximizer` | **True-peak Limiter** | Dynamics | `gain`, `ceiling`, `release`, `lookahead`, `truePeak` |
| `ott` | **Multiband (OTT)** | Dynamics | `depth`, `time`, `lowMid`, `midHigh`, `lowGain`, `midGain`, `highGain`, `upward`, `downward`, `output`, `mix` |
| `transient` | **Transient Shaper** | Dynamics | `attack`, `sustain`, `output` |
| `trancegate` | **Trance Gate** | Dynamics | `rate`, `duty`, `attack`, `release`, `depth` |
| `algoverb` | **Algorithmic Reverb** | Space | `voicing`, `size`, `decay`, `predelay`, `damping`, `lowCut`, `diffusion`, `modRate`, `modDepth`, `early`, `width`, `freeze`, `mix` |
| `shimmer` | **Shimmer Reverb** | Space | `shiftA`, `shiftB`, `blend`, `amount`, `decay`, `size`, `damping`, `modDepth`, `predelay`, `mix` |
| `resonator` | **Resonator** | Space | `root`, `chord`, `decay`, `damping`, `detune`, `spread`, `drive`, `mix` |
| `flanger` | **Flanger** | Modulation | `rate`, `sync`, `division`, `depth`, `delay`, `feedback`, `stereo`, `throughZero`, `mix` |
| `tremolo` | **Tremolo / Auto-pan** | Modulation | `rate`, `sync`, `division`, `depth`, `shape`, `stereo`, `smooth` |
| `ringmod` | **Ring Modulator** | Modulation | `freq`, `shape`, `lfoRate`, `lfoDepth`, `stereo`, `mix` |
| `freqshift` | **Frequency Shifter** | Modulation | `range`, `amount`, `feedback`, `fbDelay`, `stereo`, `lfoRate`, `lfoDepth`, `mix` |
| `lofi` | **Vintage Lo-fi** | Colour | `bits`, `rate`, `noise`, `wow`, `flutter`, `tone`, `mix` |
| `disperser` | **Disperser** | Colour | `freq`, `amount`, `pinch`, `mix` |
| `utility` | **Utility** | Tools | `gain`, `pan`, `width`, `monoBelow`, `invertL`, `invertR`, `swap`, `delayL`, `delayR`, `dcBlock` |

What each one is, and what was measured:

- **True-peak Limiter** — looks a few milliseconds ahead and has the gain down when the peak arrives. With
  *True peak* on it also holds what the wave does **between** the samples, which is what "−1 dBTP" asks for and what
  the older limiter cannot do. Measured on a mix pushed 12 dB into it: no sample above the ceiling, and the true peak
  within 0.1 dB of it at ceilings of −0.1, −1 and −6 dB. It delays the insert by its look-ahead (5 ms by default).
- **Multiband (OTT)** — three bands, each squashing what is loud and lifting what is quiet. With `depth` 0 the three
  bands add up to the input to within 0.01 dB from 20 Hz to 20 kHz.
- **Transient Shaper** — more or less attack, more or less sustain, with no threshold: it behaves the same at any
  level, and with both at 0 it passes the input bit for bit.
- **Trance Gate** — opens and closes on the song's grid (1/4 to 1/32, triplets and dotted). The gate is a function
  of the song position and nothing else: a bar sounds the same every time it comes round, and a render started
  anywhere lands on the same pattern.
- **Algorithmic Reverb** — sixteen delay lines feeding each other through a matrix that loses no energy (a feedback
  delay network), in five voicings: room, hall, plate, cathedral, cosmic. The decay knob is a time: measured, a 1 s
  setting decays in 0.85–0.94 s and a 3 s setting in 2.6–2.9 s across the voicings (6–15 % short of the knob).
  *Freeze* holds the tail for as long as it is on; a tone played into a frozen reverb does not add to it.
- **Shimmer Reverb** — the same reverb with two pitch shifters inside its loop, so the tail climbs by the interval
  again on every trip (an octave by default; a second interval can be blended in). It stays as stable as the plain
  reverb at full amount.
- **Resonator** — five strings tuned to a chord (eleven chord shapes on any root) that ring with whatever is played
  through them: drums or noise come out as a chord. A plucked string is within 0.12 cents of its note from A1 to A6.
- **Flanger** — a short, sweeping copy mixed with the sound; the first notch of a 2 ms delay is at 250 Hz, as it
  should be. *Through zero* delays the dry side too, for the tape effect. It can sweep in time with the song.
- **Tremolo / Auto-pan** — the level swings between 1 − depth and 1; with *Stereo* at 0.5 the two sides move
  opposite to each other (left + right stays constant). Free or tied to the song position.
- **Ring Modulator** — the sound times an oscillator: a 1 kHz tone and a 300 Hz carrier come out as 700 Hz and
  1300 Hz at half the level each, and the 1 kHz is gone (90 dB down).
- **Frequency Shifter** — moves every partial by the same number of Hz (not by an interval), so harmonic sounds turn
  inharmonic; a fraction of a Hz mixed with the dry sound is a phaser that only ever rises. The unwanted sideband is
  more than 60 dB down. Its feedback always dies away (see "found while measuring" below).
- **Vintage Lo-fi** — fewer bits (the noise floor of an N-bit converter, within 3 dB), a lower sample rate (with its
  images), wow and flutter, hiss, a tone filter. The older *Lo-fi Crusher* is still there, unchanged.
- **Disperser** — a chain of up to 64 all-pass filters: every frequency keeps its level (within 0.1 dB) and only its
  arrival time changes, most around the centre — a kick's click becomes a short "pew". A knob jumped under a loud
  note never makes it louder.
- **Utility** — gain, balance, width (0 = mono, 2 = double the side signal), mono below a frequency, polarity per
  side, swap, a delay per side, a DC filter. At rest it passes the input bit for bit.

Cost: the most expensive (the two reverbs) take about 25–30 ms of one CPU core per second of audio, the others
1–12 ms.

**Found while measuring.** The frequency shifter, as ported, rang for ever with a shift of +5 kHz, the shortest
feedback delay and feedback above 0.84: a partial at 19 kHz went to half the sample rate and came back twice as
strong. Its feedback loop now has a zero at half the sample rate and one at 0 Hz, and every one of 576 settings
tried at the most feedback ends when its input ends.

## The instruments

Three instruments beside the GGS Synth, each with presets and plain knobs (in *Channel settings*, grouped). Every
note is its own little program in the audio thread; a channel plays up to 16 at once.

- **Analog** (Synths) — two oscillators (saw, square with pulse width, triangle, sine) with **hard sync**, a sub and
  noise, into a four-pole ladder low-pass with its own envelope; an amp envelope, one LFO (pitch, pulse width,
  cutoff), drift. The oscillators' steps are corrected between the samples, hard sync included: a saw at C7 folds
  back at −38 dB where a naive one folds back at −14 dB. Notes are within a cent. Presets: Saw Bass, Square Bass,
  Sync Lead, Sync Pluck, PWM Strings, Brass, Soft Pad, Fifth Stab, Resonant Pluck, Sine Sub, Wobble Bass, Wind.
- **Additive** (Synths) — up to 64 partials shaped as one spectrum: tilt, odd/even balance, stretch, a moving
  emphasis, shimmer. Presets: Glass Pad, Drawbar Organ, Hollow Reed, Bell Tones, Choir Ah, Saw Stack, Soft Sine Keys,
  Metal Plate.
- **Modal** (Keys) — a note is an object that rings: up to 32 modes of a string, a stiff string, a bar, a drum head
  or a tubular bell (or something in between), set going by a mallet, a pluck, a burst of noise or a bow. The modes
  are where the physics puts them (a bar's at 1 : 2.76 : 5.40), Decay is the time the lowest mode takes to fall 60 dB,
  and a full-velocity strike peaks at the same level whatever the object. The bow is noise rubbing the object: a held
  note wanders by a few dB, as it does under a real bow. Presets: Marimba, Vibraphone, Glockenspiel, Tubular Bell,
  Kalimba, Harp, Hammered Dulcimer, Steel Drum, Glass, Wood Block, Frame Drum, Bowed Bars, Blown Pipe.

All three follow the project's tuning and pitch bends. Their knobs apply to notes that start after the change (a
held note keeps the settings it started with).

## The GGS Synth: unison and drive

- **Unison** goes up to 16 copies per oscillator, and three settings shape the stack:
  - *Uni law* — how the copies are spaced: **linear** (even: what every patch had), **super** (the JP-8000
    supersaw: its uneven spacing, and a Detune knob that is gentle for most of its travel and runs away at the end),
    **exp** (crowded round the centre), **random** (uneven, the same for every note).
  - *Stack* — every second pair of copies an **octave** up, a **fifth** up, or a fifth and an octave in turn. The
    centre copies keep the note.
  - *Uni table* — each copy reads its own place in the wavetable, around the Position knob.
- **Drive** can run at **4x** or **8x** the sample rate instead of 2x. Measured on a hard-driven 3 kHz tone, what
  folds back under 20 kHz falls from −42 dB (2x) to −54 dB (4x) and −66 dB (8x) with *hard*, from −47 to −63 and
  −77 dB with *tube*, and from −46 to −89 dB with *soft*.

Patches made before play exactly as they did: the fingerprints of all 31 presets were compared before and after,
sample for sample.

## For Claude

- `list_effects` shows the effects by purpose; `list_effects type="algoverb"` shows one in full (ranges, defaults,
  what each setting does). `add_effect`, `update_effect` and automation work as for every effect.
- `add_channel instrument="analog" preset="Sync Lead"` (or `additive`, `modal`); `list_instruments kind="modal"` for
  the settings; `update_channel` to change them.
- `set_synth_oscillator` takes `unison` up to 16, `unisonLaw`, `stack` and `unisonTable`; `set_synth_effect` takes
  `drive.oversampling`.
- For a master that must stay under a true-peak figure: `add_effect insert=0 type="maximizer" params={"ceiling":-1}`.

## What is not here

- Wavetables defined by a list of harmonics or a formula, a granular instrument, and the grain-cloud and
  spectral-freeze effects of GGS Composer are not ported yet.
- The gain reduction of the True-peak Limiter and of the Multiband is computed but not shown as a meter.
- The two reverbs and the Resonator still make a little garbage for the browser to collect (100–150 bytes per block
  of 128 samples); the other effects and the instruments make none.
- The Analog's ladder adds under 1 % of third harmonic at full level (a sine comes out with its third harmonic 42 dB
  down), as an analog filter does; it runs at the sample rate, without oversampling of its own.
