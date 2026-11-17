// Frequency shifter (single sideband, after Bode): every partial of the sound moves by the same number of Hz —
// not by the same ratio, as a pitch shifter moves them — so a harmonic sound turns inharmonic; and a shift of a
// fraction of a Hz against the dry signal is a phaser that only ever travels one way ("barber pole").
//
// Ported from the Rust reference (fx-space/freq_shifter.rs). A Hilbert transformer splits the input into two
// signals that are 90° apart at every frequency, I and Q; the output is I·cos φ − Q·sin φ with φ turning at the
// shift frequency: the wanted sideband adds up, the other one cancels as exactly as the 90° are 90°.
// The Hilbert transformer is a pair of all-pass chains (10 and 11 first-order sections, double precision),
// designed here for the actual sample rate as the reference does: the poles of an elliptic half-band filter
// (closed form after Valenzuela & Constantinides, as in Laurent de Soras' HIIR — the same formula as this package's
// halfbandCoefs, which is used) are symmetric on a log-frequency axis; scaled to the middle of the wanted band
// (20 Hz to 21 kHz, or 0.47 of the sample rate) and through the bilinear transform they are first-order digital
// all-passes. The phase error is below 0.01° from 30 Hz to 20 kHz: more than 80 dB of sideband rejection.
// A pair of all-passes has no latency to report, but it is not the dry signal either: at shift 0 the wet signal is
// the input with its phases turned, and mixed with the dry signal the two do not simply add.
//
// Kept from the reference: `range` × `amount` instead of one shift in Hz (a knob from −5 to 5 kHz could not set
// the fraction of a Hz that barber-pole phasing needs), feedback through a delay, opposite shifts left and right,
// a sine LFO on the shift (free-running, in Hz: not tied to the tempo). Changed: keys and units — and the feedback
// loop has a zero at half the sample rate and one at 0 Hz. A partial at either is its own mirror image: shifted, its
// two sidebands land on one frequency and add up, a gain of √2 on that hop. With a shift of +5 kHz, 19 kHz goes to
// 24 kHz and 24 kHz comes back to 19 kHz, and feedback above 0.84 made that pair a tone that never ended (measured:
// +12 dBFS for as long as one waited, from 0.2 s of quiet noise). The low-pass that holds the zero is 1 dB down at
// 19 kHz; the high-pass is at 5 Hz.
import { StudioFx, DelayLine, Smoothed, num, choice, safe, TAU } from './base.js';
import { halfbandCoefs } from '../util.js';

/** Full scale of `amount`, in Hz. */
const RANGES = ['10', '100', '1000', '5000'];
/** The half-band prototype has 10 coefficients: 5 two-pole sections per path, and a unit delay in one of them. */
const HALFBAND_COEFS = 10;
const PATH_A = HALFBAND_COEFS;
const PATH_B = HALFBAND_COEFS + 1;
const MAX_FEEDBACK_DELAY_MS = 500;
/** The pole of the loop's low-pass (1 + z⁻¹) / (1 + LOOP_POLE·z⁻¹): the closer to 1, the later it starts to fall. */
const LOOP_POLE = 0.7;
const LOOP_GAIN = (1 + LOOP_POLE) / 2;
/** The oscillator's frequency (shift, LFO, stereo) is set once per this many samples. */
const CONTROL = 16;

/** A Smoothed that arrives: within `eps` of its target it is the target (mix 0 is the dry signal; a delay ends on a whole sample). */
class Glide extends Smoothed {
  constructor(value, ms, rate, eps) {
    super(value, ms, rate);
    this.eps = eps;
  }

  next() {
    const d = this.target - this.value;
    this.value = d > this.eps || d < -this.eps ? this.value + this.c * d : this.target;
    return this.value;
  }
}

/** Linear up to ±t, then bending towards ±2t; nothing for what is not a number. On the feedback path: an overload stays bounded, a normal level is not touched. */
const guard = (x, t) => {
  const a = x < 0 ? -x : x;
  if (a <= t) return x;
  if (!(a < Infinity)) return 0;
  const over = (a - t) / t;
  return (x < 0 ? -t : t) * (1 + over / (1 + over));
};

/**
 * The two all-pass chains of a Hilbert transformer for lo…hi Hz: { a, b } hold the g of first-order sections
 * (g + z⁻¹) / (1 + g·z⁻¹); chain a leads chain b by 90°.
 */
export function hilbertDesign(sampleRate, lo, hi) {
  const w1 = Math.tan((Math.PI * lo) / sampleRate);
  const w2 = Math.tan((Math.PI * hi) / sampleRate);
  const centre = Math.sqrt(w1 * w2);
  // the half-band prototype covers a band that is symmetric around 1 rad/s after the bilinear transform: its
  // transition width is chosen so that the band is as wide (in octaves) as the one wanted
  const transition = (2 / Math.PI) * Math.atan(1 / Math.sqrt(w2 / w1));
  const coefs = halfbandCoefs(HALFBAND_COEFS, transition);
  const a = new Float64Array(PATH_A);
  const b = new Float64Array(PATH_B);
  const toDigital = (pole) => (pole * centre - 1) / (pole * centre + 1);
  let na = 0;
  let nb = 0;
  // the unit delay of the half-band structure is an analog pole at the middle of the band
  b[nb++] = toDigital(1);
  for (let i = 0; i < coefs.length; i++) {
    // a z⁻² section has its poles at ±√c: a reciprocal pair of analog poles
    const r = Math.sqrt(coefs[i]);
    const low = toDigital((1 - r) / (1 + r));
    const high = toDigital((1 + r) / (1 - r));
    if (i % 2 === 0) { a[na++] = low; a[na++] = high; } else { b[nb++] = low; b[nb++] = high; }
  }
  return { a, b };
}

/** What goes round the feedback loop: nothing too small to matter (those numbers are slow), nothing absurd. */
const flush = (x) => (x > 1e-15 || x < -1e-15 ? (x > 1e6 ? 1e6 : x < -1e6 ? -1e6 : x) : 0);

export class FreqShifter extends StudioFx {
  static type = 'freqshift';
  static label = 'Frequency Shifter';
  static description = 'Moves every frequency by the same number of Hz instead of by a musical interval, which breaks the harmonic relationships in a sound. A few tenths of a Hz to a few Hz mixed with the dry signal is slow, endless one-way phasing and stereo drift; tens of Hz gives detuned, seasick tones; hundreds to thousands of Hz gives metallic, bell-like, robotic timbres. With feedback it spirals upward or downward for ever. The shift in Hz is amount × range.';
  static defs = [
    choice('range', 'Range', RANGES, '100', { description: 'Full-scale shift in Hz for the amount control: 10, 100, 1000 or 5000. Pick the smallest range that reaches the shift you want: 10 for slow phaser-like beating, 100 for detune and tremolo-like roughness, 1000 and 5000 for metallic, bell-like and ring-modulator-like tones.' }),
    num('amount', 'Amount', -1, 1, 0.1, { automatable: true, description: 'Shift as a fraction of the range: shift in Hz = amount × range (range 100 and amount 0.05 is +5 Hz). Positive moves every frequency up by that many Hz, negative down; 0 leaves the pitch alone. Unlike a pitch shift, harmonics do not stay in tune with each other.' }),
    num('feedback', 'Feedback', 0, 0.95, 0, { automatable: true, description: 'Feeds the shifted output back to the input so it is shifted again and again: with small shifts an endlessly rising or falling spiral (barber-pole phasing and flanging), with large shifts cascades of inharmonic echoes. 0.3–0.6 is clearly audible, 0.9 rings for a long time.' }),
    num('fbDelay', 'Feedback delay', 0, 500, 20, { unit: 'ms', curve: 'cube', description: 'Delay in the feedback path. Under 15 ms gives comb and flanger colours that sweep with the shift; 50–500 ms gives distinct echoes that each step further up or down in frequency. Only heard with feedback above 0.' }),
    num('stereo', 'Stereo', -1, 1, 0, { automatable: true, description: 'Makes the two channels shift differently. 0: both the same. 1: the right channel shifts by the opposite amount (left up, right down), which sounds very wide; -1: the left channel is the opposite one. In between, that channel\'s shift is scaled from full, through none at 0.5, to opposite.' }),
    num('lfoRate', 'LFO rate', 0.01, 20, 0.5, { unit: 'Hz', curve: 'log', automatable: true, description: 'Speed of the built-in sine LFO that sweeps the shift up and down around its set value (free-running, not tied to the tempo). Only heard with an LFO depth above 0.' }),
    num('lfoDepth', 'LFO depth', 0, 500, 0, { unit: 'Hz', curve: 'cube', automatable: true, description: 'How far the LFO sweeps the shift, in Hz either side of the set value. 0 is off; 1–5 Hz gives a slow drifting, vibrato-like wobble, 50 Hz and more a siren-like warble.' }),
    num('mix', 'Mix', 0, 1, 1, { automatable: true, description: 'Balance between the dry signal (0) and the shifted signal (1). Around 0.5 with a shift of a few Hz the two beat against each other like a phaser that only ever moves one way.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    const { a, b } = hilbertDesign(sampleRate, 20, Math.min(0.47 * sampleRate, 21000));
    this.ga = a;
    this.gb = b;
    // the states of the two all-pass chains, left and right
    this.al = new Float64Array(PATH_A);
    this.bl = new Float64Array(PATH_B);
    this.ar = new Float64Array(PATH_A);
    this.br = new Float64Array(PATH_B);
    const maxDelay = Math.floor(MAX_FEEDBACK_DELAY_MS * 0.001 * sampleRate) + 8;
    this.lineL = new DelayLine(maxDelay);
    this.lineR = new DelayLine(maxDelay);
    this.dcR = 1 - (TAU * 5) / sampleRate; // a 5 Hz high-pass
    const controlRate = sampleRate / CONTROL;
    this.sShift = new Glide(0, 20, controlRate, 1e-4);
    this.sStereo = new Glide(0, 20, controlRate, 1e-5);
    this.sDepth = new Glide(0, 20, controlRate, 1e-4);
    this.sFb = new Glide(0, 20, sampleRate, 1e-5);
    this.sDelay = new Glide(1, 80, sampleRate, 1e-3);
    this.dry = new Glide(0, 12, sampleRate, 1e-5);
    this.wet = new Glide(1, 12, sampleRate, 1e-5);
    this.update();
    this.reset();
  }

  update() {
    const p = this.p;
    this.sShift.set(p.amount * Number(p.range));
    this.sStereo.set(p.stereo);
    this.sDepth.set(p.lfoDepth);
    this.sFb.set(p.feedback);
    // (the loop always holds one sample of delay; a whole number of samples when it has settled)
    this.sDelay.set(Math.max(1, Math.round(p.fbDelay * 0.001 * this.fs)));
    this.dry.set(1 - p.mix);
    this.wet.set(p.mix);
  }

  reset() {
    this.al.fill(0);
    this.bl.fill(0);
    this.ar.fill(0);
    this.br.fill(0);
    this.lineL.clear();
    this.lineR.clear();
    // the DC blockers
    this.x1l = 0; this.y1l = 0; this.x1r = 0; this.y1r = 0;
    // the loop's filters: what was read from the line last, its low-passed and its high-passed self
    this.fzl = 0; this.fll = 0; this.fhl = 0; this.fzr = 0; this.flr = 0; this.fhr = 0;
    // the oscillators: a point on the unit circle each (cos, sin), and how far it turns per sample
    this.cl = 1; this.sl = 0; this.cr = 1; this.sr = 0;
    this.rcl = 1; this.rsl = 0; this.rcr = 1; this.rsr = 0;
    this.phase = 0;
    this.sweep = 0;
    this.lfo = 0;
    this.fresh = true;
  }

  /** Once per CONTROL samples: the LFO moves on, and each channel's oscillator gets its frequency. */
  control() {
    const shift = this.sShift.next();
    const stereo = this.sStereo.next();
    const depth = this.sDepth.next();
    this.lfo += (this.p.lfoRate * CONTROL) / this.fs;
    this.lfo -= Math.floor(this.lfo);
    const w = (TAU * (shift + depth * Math.sin(TAU * this.lfo))) / this.fs;
    // stereo above 0 turns the right channel towards the opposite shift, below 0 the left
    const wl = w * (1 - 2 * Math.max(-stereo, 0));
    const wr = w * (1 - 2 * Math.max(stereo, 0));
    this.rcl = Math.cos(wl);
    this.rsl = Math.sin(wl);
    this.rcr = Math.cos(wr);
    this.rsr = Math.sin(wr);
    // back onto the unit circle: rounding lets the points drift
    const nl = 1 / Math.sqrt(this.cl * this.cl + this.sl * this.sl);
    const nr = 1 / Math.sqrt(this.cr * this.cr + this.sr * this.sr);
    this.cl *= nl;
    this.sl *= nl;
    this.cr *= nr;
    this.sr *= nr;
    if (++this.sweep === 64) {
      this.sweep = 0;
      this.tidy(this.al);
      this.tidy(this.bl);
      this.tidy(this.ar);
      this.tidy(this.br);
    }
  }

  /** Numbers too small to matter, once in a while (and anything that is not a number, should it ever get in). */
  tidy(z) {
    for (let k = 0; k < z.length; k++) {
      const v = Math.abs(z[k]);
      if (!(v > 1e-30 && v < 1e30)) z[k] = 0;
    }
  }

  process(L, R, n) {
    const { ga, gb, al, bl, ar, br, lineL, lineR, dcR, sFb, sDelay, dry, wet } = this;
    if (this.fresh) {
      // settings made before the first sample are where it starts: there is nothing yet to glide from
      this.fresh = false;
      this.sShift.snap(this.sShift.target);
      this.sStereo.snap(this.sStereo.target);
      this.sDepth.snap(this.sDepth.target);
      sFb.snap(sFb.target);
      sDelay.snap(sDelay.target);
      dry.snap(dry.target);
      wet.snap(wet.target);
    }
    let phase = this.phase;
    let { x1l, y1l, x1r, y1r, cl, sl, cr, sr, rcl, rsl, rcr, rsr, fzl, fll, fhl, fzr, flr, fhr } = this;
    for (let i = 0; i < n; i++) {
      if (phase === 0) {
        this.cl = cl; this.sl = sl; this.cr = cr; this.sr = sr;
        this.control();
        ({ cl, sl, cr, sr, rcl, rsl, rcr, rsr } = this);
      }
      phase = (phase + 1) % CONTROL;
      const fb = sFb.next();
      const delay = sDelay.next();
      const xl = safe(L[i]);
      const xr = safe(R[i]);
      // no DC into the shifter: shifted, it would be a tone at the shift frequency
      const hl = xl - x1l + dcR * y1l;
      const hr = xr - x1r + dcR * y1r;
      x1l = xl;
      x1r = xr;
      y1l = hl > 1e-20 || hl < -1e-20 ? hl : 0;
      y1r = hr > 1e-20 || hr < -1e-20 ? hr : 0;
      // what came out `delay` samples ago is shifted again — without what stands at half the sample rate or at 0 Hz
      const zl = lineL.read(delay);
      const zr = lineR.read(delay);
      const ll = LOOP_GAIN * (zl + fzl) - LOOP_POLE * fll;
      const lr = LOOP_GAIN * (zr + fzr) - LOOP_POLE * flr;
      const gl = ll - fll + dcR * fhl;
      const gr = lr - flr + dcR * fhr;
      fzl = zl;
      fzr = zr;
      fll = ll > 1e-20 || ll < -1e-20 ? ll : 0;
      flr = lr > 1e-20 || lr < -1e-20 ? lr : 0;
      fhl = gl > 1e-20 || gl < -1e-20 ? gl : 0;
      fhr = gr > 1e-20 || gr < -1e-20 ? gr : 0;
      let il = hl + fb * guard(gl, 4);
      let ir = hr + fb * guard(gr, 4);
      let ql = il;
      let qr = ir;
      // the Hilbert pair of each channel — four chains in one loop: none of them waits for another
      for (let k = 0; k < PATH_A; k++) {
        const g = ga[k];
        const h = gb[k];
        const yil = g * il + al[k];
        const yql = h * ql + bl[k];
        const yir = g * ir + ar[k];
        const yqr = h * qr + br[k];
        al[k] = il - g * yil;
        bl[k] = ql - h * yql;
        ar[k] = ir - g * yir;
        br[k] = qr - h * yqr;
        il = yil;
        ql = yql;
        ir = yir;
        qr = yqr;
      }
      const h = gb[PATH_A];
      const yql = h * ql + bl[PATH_A];
      const yqr = h * qr + br[PATH_A];
      bl[PATH_A] = ql - h * yql;
      br[PATH_A] = qr - h * yqr;
      // I·cos − Q·sin: the upper sideband for an oscillator that turns forwards
      const yl = il * cl - yql * sl;
      const yr = ir * cr - yqr * sr;
      const tl = cl * rcl - sl * rsl;
      const tr = cr * rcr - sr * rsr;
      sl = cl * rsl + sl * rcl;
      sr = cr * rsr + sr * rcr;
      cl = tl;
      cr = tr;
      lineL.push(flush(yl));
      lineR.push(flush(yr));
      const dg = dry.next();
      const wg = wet.next();
      L[i] = xl * dg + safe(yl) * wg;
      R[i] = xr * dg + safe(yr) * wg;
    }
    this.phase = phase;
    this.x1l = x1l; this.y1l = y1l; this.x1r = x1r; this.y1r = y1r;
    this.cl = cl; this.sl = sl; this.cr = cr; this.sr = sr;
    this.fzl = fzl; this.fll = fll; this.fhl = fhl; this.fzr = fzr; this.flr = flr; this.fhr = fhr;
  }
}
