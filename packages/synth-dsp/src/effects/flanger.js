// Flanger: the sound mixed with a very short, sweeping copy of itself. The two cancel at evenly spaced frequencies —
// a comb of notches at the odd multiples of 1 / (2 × delay) — and the sweep moves that comb up and down the
// spectrum: the jet-plane whoosh. Feedback sharpens the comb into a pitched, metallic ring.
//
// The delay moves exponentially around its centre, delay × 2^(1.5 × depth × sin), so the notches travel a constant
// number of octaves per second (up to 1.5 either side). "Through zero" delays the dry signal by the centre delay as
// well: the swept copy then passes through perfect alignment, as two tape machines did.
//
// A port of the `flanger` of GGS Composer's classic effect rack (Rust), with its constants.
import { StudioFx, DelayLine, Smoothed, num, choice, flag, safe, TAU, DIVISIONS, divisionBeats } from './base.js';

// ---- shared by the colour effects: lofi, tremolo, ringmod and utility import these from here
//
// How their process() loops are written: nothing in them calls a function that takes or returns a fraction. Such a
// call is only free while the engine inlines it, and in a loop with many of them it does not inline them all — the
// number is then boxed, which is an allocation per sample (measured: a few collections per second of audio). So the
// smoothers are stepped by hand (value += c × (target − value), written back after the loop), the delay lines are
// read through their buffers, and the last line of defence that base.js calls safe() is written out with CEILING —
// read into a local first, as `+CEILING`: a number imported from another module and picked as a result inside the
// loop is boxed too (measured the same way), a local that is known to be a number is not.

/** The loudest sample an effect passes on: the ceiling of base.js's safe(). */
export const CEILING = safe(Infinity);

const BEATS = DIVISIONS.map(divisionBeats);
/** Length in beats of one of DIVISIONS — looked up, because divisionBeats parses text and this runs with the audio. */
export const beatsOf = (division) => BEATS[Math.max(0, DIVISIONS.indexOf(division))];

/**
 * Puts a smoother that has all but arrived on its target (once per block). Unity is then exactly unity and off
 * exactly off — what makes "mix 0" and "width 1" bit-transparent again after a knob came back — and a value on its
 * way to zero does not creep on into denormal numbers, which are slow to compute.
 */
export function settle(s) {
  if (s.value !== s.target && Math.abs(s.target - s.value) < 1e-7) s.value = s.target;
}

/**
 * Dry and wet gains of a mix knob, gliding. Linear (dry = 1 − mix, wet = mix): what these effects add is correlated
 * with the dry signal, so levels add, not powers. At 0 the dry gain is exactly 1 and the wet gain exactly 0.
 */
export class DryWet {
  constructor(fs) {
    this.dry = new Smoothed(1, 10, fs);
    this.wet = new Smoothed(0, 10, fs);
  }

  set(mix) { this.dry.set(1 - mix); this.wet.set(mix); }
  snap(mix) { this.dry.snap(1 - mix); this.wet.snap(mix); }
  settle() { settle(this.dry); settle(this.wet); }
}

/**
 * Where an LFO stands. Free, it runs from its own phase at `hz`. Synced with the song playing, its phase is the song
 * position and nothing else — beat ÷ `beats`, the length of the division — so a bar sounds the same every time it
 * comes round, a loop restarts in phase and a render started anywhere lands on the same sweep. Synced with the song
 * stopped, it runs on from where it was, at the speed the tempo gives.
 */
export class LfoClock {
  constructor() {
    this.hz = 1;
    this.sync = false;
    this.beats = 1;
    this.phase = 0;
    this.start = 0;
    this.inc = 0;
  }

  reset() { this.phase = 0; }

  /**
   * Prepares a block of n samples: sample i is at phase `start + i × inc` (in cycles; wrap it). Moves on by n.
   * fx: the effect — its fs and what clock() told it (beat, bpm, playing).
   */
  begin(n, fx) {
    let start = this.phase;
    let inc;
    if (this.sync) {
      const bpm = fx.bpm > 1 ? fx.bpm : 1; // (a tempo that is not a number counts as 1, too)
      inc = bpm / 60 / fx.fs / this.beats;
      if (fx.playing && fx.beat - fx.beat === 0) {
        const at = fx.beat / this.beats;
        start = at - Math.floor(at);
      }
    } else inc = (this.hz > 0 ? this.hz : 0) / fx.fs;
    const end = start + inc * n;
    this.phase = end - Math.floor(end);
    this.start = start;
    this.inc = inc;
  }
}

// ---- the flanger

/** Octaves the delay sweeps either side of its centre at depth 1. */
const SWEEP_OCTAVES = 1.5;
// room for the longest delay at the bottom of the deepest sweep (20 ms × 2^1.5 = 57 ms), and for the dry path's 20 ms
const WET_SECONDS = 0.06;
const DRY_SECONDS = 0.021;
// the signal coming back round is untouched up to ±2 and then bent towards ±4: ordinary levels pass as they are, a
// resonance that runs away is held
const FEEDBACK_KNEE = 2;
const FEEDBACK_SPAN = 2;

export class Flanger extends StudioFx {
  static type = 'flanger';
  static label = 'Flanger';
  static description = 'Mixes the sound with a very short, sweeping delayed copy of itself, which carves a comb of evenly spaced notches that glide up and down the spectrum: the jet-plane whoosh. Feedback turns the notches into a resonant, pitched, metallic ring. More dramatic and more metallic than a phaser. Reach for it on drums, guitars, pads or whole transitions for obvious sweeping motion; "through zero" is the deepest, tape-style version. It can sweep in time with the song.';
  static defs = [
    num('rate', 'Rate', 0.01, 20, 0.25, { unit: 'Hz', curve: 'log', automatable: true, description: 'Speed of the sweep when sync is off. 0.05–0.5 Hz is the slow jet-plane whoosh; several Hz is a warbling vibrato.' }),
    flag('sync', 'Sync', false, { description: 'Lock the sweep to the song tempo, using the division instead of the rate. The sweep then always stands at the same point of the bar, however often the bar is played.' }),
    choice('division', 'Division', DIVISIONS, '1/1', { description: 'Length of one full sweep when sync is on, as a note value: 1/1 is one sweep per bar of 4/4, 2/1 one per two bars, 1/4 one per beat; d is dotted, t a triplet.' }),
    num('depth', 'Depth', 0, 1, 0.7, { automatable: true, description: 'How far the delay sweeps around its centre: at 1 the comb notches travel 1.5 octaves up and down, at 0 the comb stands still (a fixed, hollow colour).' }),
    num('delay', 'Delay', 0.1, 20, 2.5, { unit: 'ms', curve: 'log', automatable: true, description: 'Centre of the sweep. Under 1 ms the effect lives in the highs (airy, phaser-like), 1–5 ms is the classic flanger, above 10 ms it becomes a metallic chorus.' }),
    num('feedback', 'Feedback', -0.98, 0.98, 0.5, { automatable: true, description: 'Feeds the delayed signal back into itself, sharpening the comb into a resonant, pitched ring. Negative values bring out the odd harmonics for a hollow, tube-like tone; near ±0.98 it almost sings by itself.' }),
    num('stereo', 'Stereo phase', 0, 1, 0.25, { automatable: true, description: 'Offset of the right channel\'s sweep from the left, as a fraction of a cycle. 0 is mono; 0.5 makes the two sides sweep in opposite directions for a wide, swirling image.' }),
    flag('throughZero', 'Through zero', false, { description: 'Tape-style flanging: the dry signal is delayed by the centre delay, so the swept copy passes through perfect alignment — a dramatic hollow-then-full whoosh. The whole effect is then late by that delay.' }),
    num('mix', 'Mix', 0, 1, 0.5, { automatable: true, description: 'Blend between the dry signal (0) and the delayed copy (1). 0.5 gives the deepest notches; 1 leaves only the pitch-wobbling copy.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    const fs = sampleRate;
    // (the two lines of a pair are always written together, so they share one write position in process())
    this.wetL = new DelayLine(fs * WET_SECONDS + 8);
    this.wetR = new DelayLine(fs * WET_SECONDS + 8);
    this.dryL = new DelayLine(fs * DRY_SECONDS + 8);
    this.dryR = new DelayLine(fs * DRY_SECONDS + 8);
    this.lfo = new LfoClock(); // (not `clock`: that is the method the host calls)
    this.centre = new Smoothed(0, 40, fs); // in samples
    this.depth = new Smoothed(0, 20, fs); // in octaves
    this.feedback = new Smoothed(0, 10, fs);
    this.stereo = new Smoothed(0, 30, fs);
    this.mix = new DryWet(fs);
    // settings given before the first sample are where it starts — nothing glides in from the defaults
    this.fresh = true;
    this.update();
  }

  /** The centre delay in samples. Through zero it is a whole number, so the dry path is delayed exactly. */
  centreSamples() {
    const d = this.p.delay * 0.001 * this.fs;
    return this.p.throughZero ? Math.max(2, Math.round(d)) : d;
  }

  update() {
    const p = this.p;
    this.lfo.hz = p.rate;
    this.lfo.sync = p.sync;
    this.lfo.beats = beatsOf(p.division);
    this.centre.set(this.centreSamples());
    this.depth.set(p.depth * SWEEP_OCTAVES);
    this.feedback.set(p.feedback);
    this.stereo.set(p.stereo);
    this.mix.set(p.mix);
    if (this.fresh) {
      this.centre.snap(this.centre.target);
      this.depth.snap(this.depth.target);
      this.feedback.snap(p.feedback);
      this.stereo.snap(p.stereo);
      this.mix.snap(p.mix);
    }
  }

  reset() {
    this.wetL.clear();
    this.wetR.clear();
    this.dryL.clear();
    this.dryR.clear();
    this.lfo.reset();
    this.fresh = true;
    this.update();
  }

  /** Through zero, everything is late by the dry path's delay. */
  get latency() { return this.p.throughZero ? this.centreSamples() : 0; }

  process(L, R, n) {
    this.fresh = false;
    const { lfo, centre, depth, feedback, stereo, mix } = this;
    const tz = this.p.throughZero;
    lfo.begin(n, this);
    const start = lfo.start;
    const inc = lfo.inc;
    const wetBufL = this.wetL.buf;
    const wetBufR = this.wetR.buf;
    const wetMask = this.wetL.mask;
    const wetSize = this.wetL.size;
    const longest = this.wetL.max - 2;
    const dryBufL = this.dryL.buf;
    const dryBufR = this.dryR.buf;
    const dryMask = this.dryL.mask;
    const drySize = this.dryL.size;
    const dryLongest = this.dryL.max;
    let wetAt = this.wetL.w;
    let dryAt = this.dryL.w;
    let mid = centre.value;
    const midTo = centre.target;
    const midBy = centre.c;
    let octaves = depth.value;
    const octavesTo = depth.target;
    const octavesBy = depth.c;
    let fb = feedback.value;
    const fbTo = feedback.target;
    const fbBy = feedback.c;
    let offset = stereo.value;
    const offsetTo = stereo.target;
    const offsetBy = stereo.c;
    let dryGain = mix.dry.value;
    const dryTo = mix.dry.target;
    let wetGain = mix.wet.value;
    const wetTo = mix.wet.target;
    const mixBy = mix.dry.c;
    const top = +CEILING;
    for (let i = 0; i < n; i++) {
      mid += midBy * (midTo - mid);
      octaves += octavesBy * (octavesTo - octaves);
      fb += fbBy * (fbTo - fb);
      offset += offsetBy * (offsetTo - offset);
      dryGain += mixBy * (dryTo - dryGain);
      wetGain += mixBy * (wetTo - wetGain);
      const phase = start + inc * i;
      for (let ch = 0; ch < 2; ch++) {
        const io = ch === 0 ? L : R;
        const wet = ch === 0 ? wetBufL : wetBufR;
        const dry = ch === 0 ? dryBufL : dryBufR;
        let d = mid;
        if (octaves !== 0) {
          let ph = ch === 0 ? phase : phase + offset;
          ph -= Math.floor(ph);
          // 2^(octaves × sine), as exp: several times cheaper than Math.pow here, and the same to 16 digits
          d = mid * Math.exp(Math.LN2 * octaves * Math.sin(TAU * ph));
        }
        // (the four-point read needs two samples of delay)
        d = d < 2 ? 2 : d > longest ? longest : d;
        // not a number, or far too loud: it must not get into the delay lines, where the feedback would keep it
        let x = io[i];
        x = x > top ? top : x < -top ? -top : x === x ? x : 0;
        // the delayed copy, read between the samples with a cubic through four of them (a line would dull the
        // highs as the delay moves); a whole number of samples gives that sample exactly
        let pos = wetAt - d + wetSize;
        let k = Math.floor(pos);
        let f = pos - k;
        let y0 = wet[(k - 1) & wetMask];
        let y1 = wet[k & wetMask];
        let y2 = wet[(k + 1) & wetMask];
        let y3 = wet[(k + 2) & wetMask];
        const w = (((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f + y1;
        let back = w * fb;
        if (back > FEEDBACK_KNEE || back < -FEEDBACK_KNEE) {
          // past the knee, bent with a cheap tanh (Padé 3/2, flat from 3 on)
          let a = ((back < 0 ? -back : back) - FEEDBACK_KNEE) / FEEDBACK_SPAN;
          if (a > 3) a = 3;
          const bent = FEEDBACK_KNEE + (FEEDBACK_SPAN * a * (27 + a * a)) / (27 + 9 * a * a);
          back = back < 0 ? -bent : bent;
        }
        const fed = x + back;
        wet[wetAt] = fed > top ? top : fed < -top ? -top : fed;
        let direct = x;
        if (tz) {
          d = mid < 2 ? 2 : mid > dryLongest ? dryLongest : mid;
          pos = dryAt - d + drySize;
          k = Math.floor(pos);
          f = pos - k;
          y0 = dry[(k - 1) & dryMask];
          y1 = dry[k & dryMask];
          y2 = dry[(k + 1) & dryMask];
          y3 = dry[(k + 2) & dryMask];
          direct = (((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f + y1;
        }
        dry[dryAt] = x;
        const y = direct * dryGain + w * wetGain;
        io[i] = y > top ? top : y < -top ? -top : y === y ? y : 0;
      }
      wetAt = (wetAt + 1) & wetMask;
      dryAt = (dryAt + 1) & dryMask;
    }
    this.wetL.w = wetAt;
    this.wetR.w = wetAt;
    this.dryL.w = dryAt;
    this.dryR.w = dryAt;
    centre.value = mid;
    depth.value = octaves;
    feedback.value = fb;
    stereo.value = offset;
    mix.dry.value = dryGain;
    mix.wet.value = wetGain;
    settle(centre);
    settle(depth);
    settle(feedback);
    settle(stereo);
    mix.settle();
  }
}
