// Lo-fi: the sound of a worn medium — tape that drifts and flutters, a converter with too few bits and too low a
// sample rate, hiss, and a dull tone on top.
//
// In order: wow and flutter (a delay that moves) → sample-rate reduction (sample and hold) → bit reduction (a
// quantiser that clips at 0 dBFS, as a converter does) → hiss → a one-pole low-pass → mix.
//
//  - Wow is two slow sines (0.6 and 1.03 Hz), flutter two faster ones (6.7 and 11.3 Hz); both channels share them,
//    as on one tape transport. The delay grows from nothing with the two amounts: at 0 the path adds no delay.
//  - The aliasing of the sample-rate reducer and the noise of the quantiser are the effect: nothing is oversampled.
//  - The hiss is seeded noise, restarted by reset(): the same render every time. It is there on silence, too.
//
// The wow/flutter delay (up to 8 ms) is part of the sound and is not reported as latency.
//
// A port of the `lofi` of GGS Composer's classic effect rack (Rust), with its constants. Changed: each stage is out
// of the path at the clean end of its knob — the reference keeps quantising (and clipping) at 16 bits, and at project
// rates above 48 kHz it keeps reducing with the rate knob at its top — so that "everything clean" is the input, bit
// for bit, at any sample rate. The hiss comes from this package's generator (white, the same level, other samples).
import { StudioFx, DelayLine, Smoothed, num, TAU } from './base.js';
import { Rng } from '../util.js';
import { DryWet, CEILING, settle } from './flanger.js';

const BITS_CLEAN = 16;
const RATE_CLEAN = 48000;
const TONE_OPEN = 20000;
const SEED = 0x10f1c0de;
// wow and flutter are each a main sine and a weaker one that never lines up with it twice the same way
const WOW_HZ = 0.6;
const WOW_HZ_2 = 1.03;
const FLUTTER_HZ = 6.7;
const FLUTTER_HZ_2 = 11.3;
/** Pitch deviation the main sine of each pair would give alone, at full amount. */
const WOW_PITCH = 0.015;
const FLUTTER_PITCH = 0.005;
/** Peak of the hiss at noise = 1 (about −31 dBFS RMS). */
const NOISE_PEAK = 0.05;
const LINE_SECONDS = 0.012;

export class Lofi extends StudioFx {
  static type = 'lofi';
  static label = 'Lo-fi';
  static description = 'Makes a sound seem old, cheap or worn: it reduces the bit depth and the sample rate like an early sampler, adds the pitch wobble of tape or vinyl (wow and flutter), a background hiss, and a dulling tone filter. Reach for it for lo-fi hip-hop keys and drums, vintage sampler grit, and nostalgic or degraded textures.';
  static defs = [
    num('bits', 'Bits', 2, BITS_CLEAN, 12, { automatable: true, description: 'Bit depth of the simulated converter. 16 is clean (the converter is out of the path), 12 is the gentle grain of early samplers, 8 is clearly gritty and noisy, 4 and below is harsh and broken. Below 16, anything over 0 dBFS is clipped.' }),
    num('rate', 'Sample rate', 500, RATE_CLEAN, 12000, { unit: 'Hz', curve: 'log', automatable: true, description: 'Simulated sample rate. Lower values remove highs and add metallic aliasing: 20–30 kHz is subtle, 8–12 kHz is the classic lo-fi sampler, under 4 kHz is a broken telephone. At the top, or at the project\'s own rate and above, it does nothing.' }),
    num('noise', 'Noise', 0, 1, 0, { automatable: true, description: 'Level of a constant background hiss, like tape or an old sampler (about −31 dBFS at 1). It is there even while the input is silent. 0 is off.' }),
    num('wow', 'Wow', 0, 1, 0.2, { automatable: true, description: 'Slow pitch drift, like a warped record or worn tape (up to about a third of a semitone at 1). The seasick, nostalgic wobble of lo-fi recordings.' }),
    num('flutter', 'Flutter', 0, 1, 0.1, { automatable: true, description: 'Fast pitch shimmer, like a cheap cassette transport. It adds a nervous roughness to held notes.' }),
    num('tone', 'Tone', 500, TONE_OPEN, 8000, { unit: 'Hz', curve: 'log', automatable: true, description: 'A gentle low-pass after the damage. Lower it for a duller, more muffled, older sound; at 20 kHz it is out of the path.' }),
    num('mix', 'Mix', 0, 1, 1, { automatable: true, description: 'Blend between the clean input (0) and the lo-fi signal (1). In between, with wow or flutter up, the two comb against each other, because the lo-fi copy is a few milliseconds late.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    const fs = sampleRate;
    // (the two lines are always written together, so they share one write position in process())
    this.lineL = new DelayLine(fs * LINE_SECONDS + 16);
    this.lineR = new DelayLine(fs * LINE_SECONDS + 16);
    // per channel: the hold clock, the value held, the last input (to place the hold between two samples), the tone
    this.clockAt = new Float64Array(2);
    this.held = new Float64Array(2);
    this.before = new Float64Array(2);
    this.toneZ = new Float64Array(2);
    // samples since the start: what the wow and flutter sines are worked out from (kept as a float from the first
    // sample on, so nothing changes under the audio thread when the count outgrows a small integer, hours in)
    this.count = new Float64Array(1);
    this.rng = new Rng(SEED);
    this.seeded = this.rng.s;
    this.wow = new Smoothed(0, 50, fs); // peak swing of the delay, in samples
    this.flutter = new Smoothed(0, 50, fs);
    this.noise = new Smoothed(0, 10, fs);
    this.tone = new Smoothed(1, 10, fs); // the low-pass coefficient
    this.mix = new DryWet(fs);
    // settings given before the first sample are where it starts — nothing glides in from the defaults
    this.fresh = true;
    this.update();
  }

  update() {
    const p = this.p;
    const fs = this.fs;
    // the swing of the delay that gives the main sine the stated pitch deviation
    this.wow.set((p.wow * WOW_PITCH * fs) / (TAU * WOW_HZ));
    this.flutter.set((p.flutter * FLUTTER_PITCH * fs) / (TAU * FLUTTER_HZ));
    this.noise.set(p.noise * p.noise * NOISE_PEAK);
    // fully open is exactly 1: the filter is then out of the path
    this.tone.set(p.tone >= TONE_OPEN || p.tone >= fs * 0.49 ? 1 : 1 - Math.exp((-TAU * p.tone) / fs));
    this.mix.set(p.mix);
    if (this.fresh) {
      this.wow.snap(this.wow.target);
      this.flutter.snap(this.flutter.target);
      this.noise.snap(this.noise.target);
      this.tone.snap(this.tone.target);
      this.mix.snap(p.mix);
    }
  }

  reset() {
    this.lineL.clear();
    this.lineR.clear();
    this.clockAt.fill(0);
    this.held.fill(0);
    this.before.fill(0);
    this.toneZ.fill(0);
    this.count[0] = 0;
    this.rng.s = this.seeded;
    this.fresh = true;
    this.update();
  }

  process(L, R, n) {
    this.fresh = false;
    const { wow, flutter, noise, tone, mix, rng, clockAt, held, before, toneZ, fs } = this;
    const p = this.p;
    const crush = p.bits < BITS_CLEAN;
    const levels = Math.pow(2, p.bits - 1);
    // the hold clock: reduced rate ÷ running rate. 1 and above is "off".
    const hold = p.rate >= RATE_CLEAN ? 1 : p.rate / fs;
    const bufL = this.lineL.buf;
    const bufR = this.lineR.buf;
    const mask = this.lineL.mask;
    const size = this.lineL.size;
    const longest = this.lineL.max - 2;
    let at = this.lineL.w;
    let t = this.count[0];
    let seed = rng.s;
    // (the smoothers are stepped by hand: see flanger.js for why nothing is called per sample)
    let wowSwing = wow.value;
    const wowTo = wow.target;
    let flutterSwing = flutter.value;
    const flutterTo = flutter.target;
    const swingBy = wow.c;
    let hiss = noise.value;
    const hissTo = noise.target;
    const hissBy = noise.c;
    let a = tone.value;
    const aTo = tone.target;
    const aBy = tone.c;
    let dryGain = mix.dry.value;
    const dryTo = mix.dry.target;
    let wetGain = mix.wet.value;
    const wetTo = mix.wet.target;
    const mixBy = mix.dry.c;
    const top = +CEILING; // (a local: see flanger.js)
    for (let i = 0; i < n; i++) {
      wowSwing += swingBy * (wowTo - wowSwing);
      flutterSwing += swingBy * (flutterTo - flutterSwing);
      hiss += hissBy * (hissTo - hiss);
      a += aBy * (aTo - a);
      dryGain += mixBy * (dryTo - dryGain);
      wetGain += mixBy * (wetTo - wetGain);
      // (1 = no delay: the sample just written. The sines are worked out from the sample count, wrapped first, so
      // they are as exact after an hour as at the start.)
      let delay = 1;
      if (wowSwing > 0) {
        let c0 = (WOW_HZ * t) / fs;
        c0 -= Math.floor(c0);
        let c1 = (WOW_HZ_2 * t) / fs;
        c1 -= Math.floor(c1);
        delay += wowSwing * (1 + 0.75 * Math.sin(TAU * c0) + 0.25 * Math.sin(TAU * c1));
      }
      if (flutterSwing > 0) {
        let c0 = (FLUTTER_HZ * t) / fs;
        c0 -= Math.floor(c0);
        let c1 = (FLUTTER_HZ_2 * t) / fs;
        c1 -= Math.floor(c1);
        delay += flutterSwing * (1 + 0.7 * Math.sin(TAU * c0) + 0.3 * Math.sin(TAU * c1));
      }
      if (delay > longest) delay = longest;
      t++;
      for (let ch = 0; ch < 2; ch++) {
        const io = ch === 0 ? L : R;
        const buf = ch === 0 ? bufL : bufR;
        // not a number, or far too loud: it must not get into the delay line or the filter, which would keep it
        let x = io[i];
        x = x > top ? top : x < -top ? -top : x === x ? x : 0;
        buf[at] = x;
        // the tape: read `delay` samples back (counting the one just written as 1) — on a line between two
        // samples while the delay is under two, with a cubic through four once there is room for it
        const pos = at + 1 - delay + size;
        const k = Math.floor(pos);
        const f = pos - k;
        const y1 = buf[k & mask];
        const y2 = buf[(k + 1) & mask];
        let v;
        if (delay < 2) v = y1 + (y2 - y1) * f;
        else {
          const y0 = buf[(k - 1) & mask];
          const y3 = buf[(k + 2) & mask];
          v = (((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f + y1;
        }
        if (hold < 1) {
          // Sample and hold without jitter. A hold that simply waits for the clock lasts N samples, then N + 1,
          // whenever the two rates do not divide — a rough buzz of its own. Here the clock ticks between two
          // samples: the input is read at that instant (on the line between its two samples), and the output
          // sample the step falls in is the mean of the old and the new value over that sample. Every hold then
          // lasts exactly 1 / hold samples.
          let clock = clockAt[ch] + hold;
          let out = held[ch];
          if (clock >= 1) {
            clock -= 1;
            let after = clock / hold; // the share of this sample that comes after the tick
            if (after > 1) after = 1;
            const taken = v + (before[ch] - v) * after;
            out += (taken - out) * after;
            held[ch] = taken;
          }
          clockAt[ch] = clock;
          before[ch] = v;
          v = out;
        } else {
          before[ch] = v;
          held[ch] = v;
          clockAt[ch] = 0;
        }
        if (crush) {
          // a quantiser with a step at zero (silence stays silence), rounding away from zero on both sides alike
          const c = v > 1 ? 1 : v < -1 ? -1 : v;
          v = (c < 0 ? -Math.round(-c * levels) : Math.round(c * levels)) / levels;
        }
        if (hiss > 0) {
          // the next number of this.rng (xorshift32, as Rng.next() draws it)
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          v += (hiss * seed) / 2147483648;
        }
        const z = a >= 1 ? v : toneZ[ch] + a * (v - toneZ[ch]);
        toneZ[ch] = z;
        const y = x * dryGain + z * wetGain;
        io[i] = y > top ? top : y < -top ? -top : y === y ? y : 0;
      }
      at = (at + 1) & mask;
    }
    this.lineL.w = at;
    this.lineR.w = at;
    this.count[0] = t;
    rng.s = seed;
    // (silence after sound: end the filter's decay before it reaches numbers that are slow to compute)
    if (toneZ[0] < 1e-30 && toneZ[0] > -1e-30) toneZ[0] = 0;
    if (toneZ[1] < 1e-30 && toneZ[1] > -1e-30) toneZ[1] = 0;
    wow.value = wowSwing;
    flutter.value = flutterSwing;
    noise.value = hiss;
    tone.value = a;
    mix.dry.value = dryGain;
    mix.wet.value = wetGain;
    settle(wow);
    settle(flutter);
    settle(noise);
    settle(tone);
    mix.settle();
  }
}
