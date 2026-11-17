// Utility: the mixing toolbox, with no sound of its own — gain, balance, stereo width, mono bass, polarity, channel
// swap, a short delay per channel (Haas) and a DC filter.
//
// In order: swap → polarity → mono below a frequency → width (mid/side) → channel delays → balance and gain → DC.
//
//  - Pan is a balance control: the centre leaves both channels at unity (no dip), turning fades the other side out.
//  - "Mono below" splits each channel with a 24 dB/octave Linkwitz-Riley crossover and replaces the two low bands by
//    their mean: the highs keep their image, and the result still sums flat (with the crossover's all-pass phase).
//    Under 20 Hz it is off and the crossover is out of the path.
//  - The channel delays are whole samples (in between only while a change glides): exact, and without colour.
//
// At its defaults the output is the input, bit for bit.
//
// A port of the `utility` of GGS Composer's classic effect rack (Rust), with its constants.
import { StudioFx, DelayLine, Smoothed, Biquad, num, flag, dbToLin, TAU } from './base.js';
import { CEILING, settle } from './flanger.js';

const MUTE_DB = -80;
const MONO_OFF_BELOW = 20; // Hz
const DC_HZ = 10;
const MAX_DELAY_MS = 30;
const GLIDE_SECONDS = 0.02;
/** An input sample beyond this (120 dB over full scale) is a fault upstream, not audio: it is dropped. */
const INSANE = 1e6;

/** A value that moves to its target in a straight line over a set number of samples, and lands on it exactly. */
class Glide {
  constructor(value) {
    this.value = value;
    this.target = value;
    this.step = 0;
    this.left = 0;
  }

  snap(value) {
    this.value = value;
    this.target = value;
    this.step = 0;
    this.left = 0;
  }

  set(target, samples) {
    this.target = target;
    this.step = (target - this.value) / samples;
    this.left = samples;
  }
}

export class Utility extends StudioFx {
  static type = 'utility';
  static label = 'Utility';
  static description = 'The mixing toolbox, with no sound of its own: level, left/right balance, stereo width (down to mono, or wider than the source), mono bass below a chosen frequency, polarity per channel, channel swap, a short delay per channel for Haas widening, and a DC filter. Reach for it for gain staging, for fixing phase or mono-compatibility problems, and for shaping the stereo image. At its defaults it changes nothing at all.';
  static defs = [
    num('gain', 'Gain', MUTE_DB, 24, 0, { unit: 'dB', automatable: true, description: 'Level change in decibels. 0 is unity, −6 halves the amplitude, and the minimum (−80) mutes completely.' }),
    num('pan', 'Pan', -1, 1, 0, { automatable: true, description: 'Left/right balance: −1 is hard left, 0 the centre, +1 hard right. The centre stays at full level; turning one way fades the other channel out (half-way, it is 6 dB down).' }),
    num('width', 'Width', 0, 2, 1, { automatable: true, description: 'Stereo width by mid/side: 0 folds down to mono, 1 leaves the image alone, 2 doubles the side (difference) signal for an exaggerated width that may not survive mono playback.' }),
    num('monoBelow', 'Mono below', 0, 500, 0, { unit: 'Hz', description: 'Makes everything below this frequency mono and leaves the highs stereo. 80–150 Hz keeps bass and kick solid and centred on any system. 0 (anything under 20 Hz) is off.' }),
    flag('invertL', 'Invert left', false, { description: 'Flips the polarity of the left channel. For fixing phase problems between layered sounds or microphones.' }),
    flag('invertR', 'Invert right', false, { description: 'Flips the polarity of the right channel. Inverting one side only makes a mono source sound wide and hollow — and vanish in mono.' }),
    flag('swap', 'Swap', false, { description: 'Swaps the left and right channels (before the polarity switches, which then act on the swapped channels).' }),
    num('delayL', 'Delay left', 0, MAX_DELAY_MS, 0, { unit: 'ms', description: 'Delays the left channel. 5–25 ms on one side only is the Haas effect: the sound seems wider and pulled towards the side that is not delayed. Check it in mono.' }),
    num('delayR', 'Delay right', 0, MAX_DELAY_MS, 0, { unit: 'ms', description: 'Delays the right channel, as "Delay left" does the left one: use one side only for Haas widening, and check it in mono.' }),
    flag('dcBlock', 'DC block', false, { description: 'Removes any constant offset (and everything below about 10 Hz). Useful after asymmetric distortion or on sampled material, to get headroom back.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    const fs = sampleRate;
    // The crossover: per channel, two low-passes in a row and two high-passes in a row (Butterworth twice is
    // Linkwitz-Riley). The two Biquads hold the coefficients; the eight filters' memories are in `cross`, two
    // numbers each: [low 1, low 2, high 1, high 2] of the left channel, then of the right.
    this.lowpass = new Biquad();
    this.highpass = new Biquad();
    this.cross = new Float64Array(16);
    this.crossHz = 0;
    // (the two lines are always written together, so they share one write position in process())
    this.lineL = new DelayLine(Math.ceil(fs * MAX_DELAY_MS * 0.001) + 4);
    this.lineR = new DelayLine(Math.ceil(fs * MAX_DELAY_MS * 0.001) + 4);
    this.delayL = new Glide(0); // in samples
    this.delayR = new Glide(0);
    this.glide = Math.max(1, Math.floor(GLIDE_SECONDS * fs));
    // the DC filter: per channel, the last input and the last output
    this.dc = new Float64Array(4);
    this.dcPole = 1 - (TAU * DC_HZ) / fs;
    this.dcOn = false;
    // (switches are faded over a few milliseconds: a swap or a polarity flip under a held note does not click)
    this.polL = new Smoothed(1, 5, fs);
    this.polR = new Smoothed(1, 5, fs);
    this.swap = new Smoothed(0, 5, fs);
    this.width = new Smoothed(1, 10, fs);
    this.gainL = new Smoothed(1, 10, fs);
    this.gainR = new Smoothed(1, 10, fs);
    // settings given before the first sample are where it starts — nothing glides in from the defaults
    this.fresh = true;
    this.update();
  }

  update() {
    const p = this.p;
    const fs = this.fs;
    this.polL.set(p.invertL ? -1 : 1);
    this.polR.set(p.invertR ? -1 : 1);
    this.swap.set(p.swap ? 1 : 0);
    this.width.set(p.width);
    const dl = Math.round(p.delayL * 0.001 * fs);
    const dr = Math.round(p.delayR * 0.001 * fs);
    if (dl !== this.delayL.target) this.delayL.set(dl, this.glide);
    if (dr !== this.delayR.target) this.delayR.set(dr, this.glide);
    const gain = p.gain <= MUTE_DB + 0.01 ? 0 : dbToLin(p.gain);
    this.gainL.set(gain * Math.min(1, 1 - p.pan));
    this.gainR.set(gain * Math.min(1, 1 + p.pan));
    // the crossover starts from rest when it is switched in, and is retuned in place when it moves
    const hz = p.monoBelow >= MONO_OFF_BELOW ? p.monoBelow : 0;
    if (hz > 0 && hz !== this.crossHz) {
      if (this.crossHz === 0) this.cross.fill(0);
      this.lowpass.design('lowpass', fs, hz);
      this.highpass.design('highpass', fs, hz);
    }
    this.crossHz = hz;
    if (p.dcBlock && !this.dcOn) this.dc.fill(0);
    this.dcOn = p.dcBlock;
    if (this.fresh) {
      this.polL.snap(this.polL.target);
      this.polR.snap(this.polR.target);
      this.swap.snap(this.swap.target);
      this.width.snap(p.width);
      this.delayL.snap(dl);
      this.delayR.snap(dr);
      this.gainL.snap(this.gainL.target);
      this.gainR.snap(this.gainR.target);
    }
  }

  reset() {
    this.cross.fill(0);
    this.crossHz = 0;
    this.lineL.clear();
    this.lineR.clear();
    this.dcOn = false;
    this.fresh = true;
    this.update();
  }

  process(L, R, n) {
    this.fresh = false;
    const { polL, polR, swap, width, gainL, gainR, delayL, delayR, cross, dc, dcPole, dcOn } = this;
    const mono = this.crossHz > 0;
    const { b0: lb0, b1: lb1, b2: lb2, a1: la1, a2: la2 } = this.lowpass;
    const { b0: hb0, b1: hb1, b2: hb2, a1: ha1, a2: ha2 } = this.highpass;
    const bufL = this.lineL.buf;
    const bufR = this.lineR.buf;
    const mask = this.lineL.mask;
    const size = this.lineL.size;
    let at = this.lineL.w;
    // (the smoothers and the glides are stepped by hand: see flanger.js for why nothing is called per sample)
    let pl = polL.value;
    const plTo = polL.target;
    let pr = polR.value;
    const prTo = polR.target;
    let sw = swap.value;
    const swTo = swap.target;
    const switchBy = swap.c;
    let w = width.value;
    const wTo = width.target;
    let gl = gainL.value;
    const glTo = gainL.target;
    let gr = gainR.value;
    const grTo = gainR.target;
    const knobBy = width.c;
    let dl = delayL.value;
    let dlLeft = delayL.left;
    let dr = delayR.value;
    let drLeft = delayR.left;
    const top = +CEILING; // (a local: see flanger.js)
    for (let i = 0; i < n; i++) {
      let l = L[i];
      let r = R[i];
      // not a number, or an explosion upstream: it must not get into the filters and the delay lines, which would
      // keep it. (No ceiling here, unlike at the output: this is the tool that turns a signal that is too hot down.)
      if (!(l > -INSANE && l < INSANE)) l = 0;
      if (!(r > -INSANE && r < INSANE)) r = 0;
      sw += switchBy * (swTo - sw);
      if (sw >= 1) {
        const t = l;
        l = r;
        r = t;
      } else if (sw !== 0) {
        const t = l;
        l += sw * (r - l);
        r += sw * (t - r);
      }
      pl += switchBy * (plTo - pl);
      pr += switchBy * (prTo - pr);
      l *= pl;
      r *= pr;
      if (mono) {
        // each filter: y = b0·x + z1; z1 = b1·x − a1·y + z2; z2 = b2·x − a2·y
        let lows = 0;
        for (let ch = 0; ch < 2; ch++) {
          const x = ch === 0 ? l : r;
          const o = ch * 8;
          let y = lb0 * x + cross[o];
          cross[o] = lb1 * x - la1 * y + cross[o + 1];
          cross[o + 1] = lb2 * x - la2 * y;
          const low = lb0 * y + cross[o + 2];
          cross[o + 2] = lb1 * y - la1 * low + cross[o + 3];
          cross[o + 3] = lb2 * y - la2 * low;
          y = hb0 * x + cross[o + 4];
          cross[o + 4] = hb1 * x - ha1 * y + cross[o + 5];
          cross[o + 5] = hb2 * x - ha2 * y;
          const high = hb0 * y + cross[o + 6];
          cross[o + 6] = hb1 * y - ha1 * high + cross[o + 7];
          cross[o + 7] = hb2 * y - ha2 * high;
          lows += low;
          if (ch === 0) l = high;
          else r = high;
        }
        // both sides get the mean of the two lows under their own highs
        l += 0.5 * lows;
        r += 0.5 * lows;
      }
      w += knobBy * (wTo - w);
      if (w !== 1) {
        const mid = 0.5 * (l + r);
        const side = 0.5 * (l - r) * w;
        l = mid + side;
        r = mid - side;
      }
      // the lines are always fed, so a delay that is switched in has its past; they are read `delay` samples
      // behind the sample just written, on a line between two samples while the delay glides
      if (dlLeft > 0) dl = --dlLeft === 0 ? delayL.target : dl + delayL.step;
      if (drLeft > 0) dr = --drLeft === 0 ? delayR.target : dr + delayR.step;
      bufL[at] = l;
      bufR[at] = r;
      if (dl !== 0) {
        const pos = at - dl + size;
        const k = Math.floor(pos);
        const y1 = bufL[k & mask];
        l = y1 + (bufL[(k + 1) & mask] - y1) * (pos - k);
      }
      if (dr !== 0) {
        const pos = at - dr + size;
        const k = Math.floor(pos);
        const y1 = bufR[k & mask];
        r = y1 + (bufR[(k + 1) & mask] - y1) * (pos - k);
      }
      at = (at + 1) & mask;
      gl += knobBy * (glTo - gl);
      gr += knobBy * (grTo - gr);
      l *= gl;
      r *= gr;
      if (dcOn) {
        // y = x − x[−1] + pole·y[−1]: a zero at DC and a pole just inside it
        let y = l - dc[0] + dcPole * dc[1];
        dc[0] = l;
        dc[1] = y;
        l = y;
        y = r - dc[2] + dcPole * dc[3];
        dc[2] = r;
        dc[3] = y;
        r = y;
      }
      L[i] = l > top ? top : l < -top ? -top : l === l ? l : 0;
      R[i] = r > top ? top : r < -top ? -top : r === r ? r : 0;
    }
    this.lineL.w = at;
    this.lineR.w = at;
    // (silence after sound: end the filters' decay before it reaches numbers that are slow to compute)
    for (let k = 0; k < 16; k++) if (cross[k] < 1e-30 && cross[k] > -1e-30) cross[k] = 0;
    for (let k = 0; k < 4; k++) if (dc[k] < 1e-30 && dc[k] > -1e-30) dc[k] = 0;
    polL.value = pl;
    polR.value = pr;
    swap.value = sw;
    width.value = w;
    gainL.value = gl;
    gainR.value = gr;
    delayL.value = dl;
    delayL.left = dlLeft;
    delayR.value = dr;
    delayR.left = drLeft;
    settle(polL);
    settle(polR);
    settle(swap);
    settle(width);
    settle(gainL);
    settle(gainR);
  }
}
