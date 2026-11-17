// Disperser: a long chain of identical all-pass filters. An all-pass leaves the level of every frequency alone but
// holds back the frequencies around its centre; dozens of them in a row hold that region back by tens of
// milliseconds while the rest passes almost at once. A click or a drum hit is pulled apart into a short sweep down
// to the centre (and up to it from below) — the liquid "pew" on a kick — while a sustained sound keeps its tone
// and only its attack changes.
//
// Ported from the Rust reference (fx-space/disperser.rs): up to 64 second-order all-pass sections, all with the
// same centre and Q (the RBJ cookbook all-pass: the response of N whole stages is the reference's, to rounding).
// A fractional number of stages is not made by crossfading two taps of the chain — that would comb-filter — but
// by one more section whose centre slides between the common centre and a place where a section does nothing
// audible. Every section is an all-pass at every setting, so the magnitude stays flat whatever the amount.
//
// What is not the reference's, and why — its sections are direct-form biquads whose stages enter and leave at 4 Hz,
// and measured, a step of the amount (64 → 4 stages) on a 0.6 peak signal came out at 5.2 with +2 dBFS below 15 Hz;
// a sweep of the frequency or of the Q did the same on a smaller scale:
//  - the sections are state-variable filters (trapezoidal integrators; the same transfer function). Their two
//    states are signals — the band-pass and the low-pass — where a direct form's states are mixtures scaled by the
//    coefficients, which a change of coefficients turns into a thump;
//  - while centre or Q move, the coefficients move every sample, and the states are scaled so that what a section
//    stores never grows by the move (stored energy = k/g · (s1² + s2²): it is kept when the move would raise it and
//    left alone when the move lowers it). The chain is then an all-pass that only ever loses energy by being
//    moved: nothing that is automated, however fast, can make it louder than what went in;
//  - a stage enters and leaves through the top of the band (0.499 of the sample rate), not through 4 Hz. Up there
//    a section forgets within a few samples and is nothing to anything audible, so it can be dropped without a
//    step; at 4 Hz it still turns the phase of a bass note by a fifth of a radian (a step when it is dropped) and
//    takes a twentieth of a second to settle;
//  - the number of stages moves at a set speed, one stage at a time (200 stages a second: 64 in a third of a
//    second; slower when a stage rings long, so that what the leaving stages hold does not come out all at once);
//  - `amount` is 0–1 (stages = 64 · amount², the taper of the reference's knob; its count started at one stage,
//    here 0 is none), and the chain runs stage by stage over the samples between two control updates instead of
//    sample by sample (the same arithmetic in another order: several times faster in JS).
import { StudioFx, Smoothed, num, safe } from './base.js';

const MAX_STAGES = 64;
/** Centre, Q and the number of stages are decided once per this many samples (counted in samples, not in blocks). */
const CONTROL = 16;
/** Where a stage enters and leaves the chain, as a fraction of the sample rate. */
const TOP = 0.499;
/** How fast the number of stages moves, stages per second — and the slowest it gets when the stages ring long. */
const STAGE_RATE = 200;
const SLOWEST_RATE = 32;
/** States are checked for numbers too small to matter once per this many control updates. */
const SWEEP = 64;

/** A Smoothed that arrives: within `eps` of its target it is the target (mix 0 is the dry signal, bit for bit). */
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

export class Disperser extends StudioFx {
  static type = 'disperser';
  static label = 'Disperser';
  static description = 'Smears the timing of the frequencies around one point without changing the tone (a chain of up to 64 all-pass filters): sharp attacks turn into short liquid chirps — the "pew" laser zap on kicks, snares, plucks and bass attacks of modern bass music. Sustained sounds are barely changed, attacks are completely reshaped. Low frequency settings (50–200 Hz) give a kick its downward sweep; more amount makes the sweep longer.';
  static defs = [
    num('freq', 'Frequency', 20, 20000, 300, { unit: 'Hz', curve: 'log', automatable: true, description: 'Centre of the smear: the frequencies around it are held back the most. Low settings (50–200 Hz) turn kick and bass attacks into a deep "pew" sweep; mid settings (500–3000 Hz) give a watery, zappy transient on drums and plucks.' }),
    num('amount', 'Amount', 0, 1, 0.5, { automatable: true, description: 'How many all-pass stages the sound runs through: stages = 64 × amount², so 0 is none (the sound is untouched), 0.25 is 4, 0.5 is 16, 0.7 is about 32 and 1 is 64. More stages stretch the transient into a longer, more obvious chirp: 0.25–0.35 softens an attack, 0.5–0.7 is a clear laser-like sweep, 1 a long liquid drop. Moves smoothly; the CPU cost grows with it.' }),
    num('pinch', 'Pinch', 0.1, 10, 0.7, { curve: 'log', description: 'Sharpness (Q) of every stage. Low values spread the smear over a wide band for a short, broad sweep; high values concentrate it in a narrow band that rings and whistles at the centre frequency. 0.7 is the classic sound.' }),
    num('mix', 'Mix', 0, 1, 1, { automatable: true, description: 'Balance between the dry signal (0) and the dispersed signal (1). At 1 the tone is unchanged and only the timing of the frequencies moves; in between the two interfere and carve phaser-like notches around the centre frequency.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    // per channel: the two states of every stage, side by side
    this.z = [new Float64Array(MAX_STAGES * 2), new Float64Array(MAX_STAGES * 2)];
    this.work = [new Float64Array(CONTROL), new Float64Array(CONTROL)];
    // a1, a2, a3 and 2k for each sample between two control updates: of the whole stages, of the sliding one
    this.ca = new Float64Array(CONTROL * 4);
    this.pa = new Float64Array(CONTROL * 4);
    const controlRate = sampleRate / CONTROL;
    // centre and Q glide on a log scale, as the ear hears them
    this.sFreq = new Glide(0, 30, controlRate, 1e-5);
    this.sPinch = new Glide(0, 30, controlRate, 1e-5);
    this.dry = new Glide(0, 12, sampleRate, 1e-5);
    this.wet = new Glide(1, 12, sampleRate, 1e-5);
    this.perTick = CONTROL / sampleRate;
    this.hTop = 1 / Math.tan(Math.PI * TOP);
    this.update();
    this.reset();
  }

  update() {
    const p = this.p;
    this.sFreq.set(Math.log(p.freq));
    this.sPinch.set(Math.log(p.pinch));
    this.want = MAX_STAGES * p.amount * p.amount;
    this.dry.set(1 - p.mix);
    this.wet.set(p.mix);
  }

  reset() {
    this.z[0].fill(0);
    this.z[1].fill(0);
    this.lastL = 0;
    this.lastR = 0;
    this.phase = 0;
    this.sweep = 0;
    this.fresh = true;
  }

  /** Settings made before the first sample are where it starts: there is nothing yet to glide from. */
  begin() {
    this.fresh = false;
    this.sFreq.snap(this.sFreq.target);
    this.sPinch.snap(this.sPinch.target);
    this.dry.snap(this.dry.target);
    this.wet.snap(this.wet.target);
    this.count = this.want;
    this.h = this.cot(Math.exp(this.sFreq.value));
    this.k = 1 / Math.exp(this.sPinch.value);
    this.ph = this.slide(Math.exp(this.sFreq.value), this.h, this.count - Math.floor(this.count));
    this.enter = false;
    this.still = false;
    this.pstill = false;
  }

  /** cot(π·f / fs) = 1 / g of a section centred on f: large for a low centre, 0 at half the sample rate. */
  cot(freq) {
    const a = (Math.PI * Math.min(Math.max(freq, 1), 0.49 * this.fs)) / this.fs;
    return Math.cos(a) / Math.sin(a);
  }

  /** …of the sliding stage: `along` = 0 at the top of the band, 1 at the common centre (whose cot is `h`), a straight line in octaves. */
  slide(freq, h, along) {
    if (along <= 0) return this.hTop;
    if (along >= 1) return h;
    const top = TOP * this.fs;
    const a = (Math.PI * top * Math.pow(Math.min(freq, 0.49 * this.fs) / top, along)) / this.fs;
    return Math.cos(a) / Math.sin(a);
  }

  /**
   * The coefficients for each sample of a control period in which a section moves from (h0, k0) to (h1, k1), in
   * equal ratios per sample. Returns what its states are multiplied by after every sample so that the move never
   * raises what they hold (k·h·(s1² + s2²)): 1 when the move lowers it. A centre that comes down keeps the energy
   * (unless `free`); a Q that comes down keeps the level of what rings (k·s1), which is less: it fades, it is not
   * thrown out as a burst.
   */
  ramp(out, h0, k0, h1, k1, free) {
    const hs = Math.pow(h1 / h0, 1 / CONTROL);
    const ks = Math.pow(k1 / k0, 1 / CONTROL);
    let h = h0;
    let k = k0;
    for (let i = 0; i < CONTROL * 4; i += 4) {
      const d = 1 / (h * h + h * k + 1);
      out[i] = h * h * d;
      out[i + 1] = h * d;
      out[i + 2] = d;
      out[i + 3] = 2 * k;
      h *= hs;
      k *= ks;
    }
    return (hs > 1 && !free ? 1 / Math.sqrt(hs) : 1) * (ks > 1 ? 1 / ks : 1);
  }

  /** Once per CONTROL samples: where centre, Q and the number of stages go during the next CONTROL samples. */
  control() {
    const freq = Math.exp(this.sFreq.next());
    const h0 = this.h;
    const k0 = this.k;
    const h1 = this.cot(freq);
    const k1 = 1 / Math.exp(this.sPinch.next());
    this.moving = h1 !== h0 || k1 !== k0;
    // (while nothing moves the table stays as it is: sixteen times the same four numbers)
    if (this.moving || !this.still) this.rho = this.ramp(this.ca, h0, k0, h1, k1, false);
    this.still = !this.moving;
    // the number of stages moves at a fixed speed, and stops at every whole number for one update: a stage that
    // arrives at the centre becomes one of the whole ones there, a stage that arrives at the top is dropped there
    // (not faster than two stages in the time one stage holds a note at the centre, 4Q/ω = 2 / (π·f·k): what a
    // stage holds comes out when it leaves, and many of them at once would be a burst)
    const c0 = this.count;
    const step = this.perTick * Math.min(STAGE_RATE, Math.max(SLOWEST_RATE, Math.PI * freq * k1));
    let c1 = c0 + Math.min(step, Math.max(-step, this.want - c0));
    if (c1 > c0) c1 = Math.min(c1, Math.floor(c0) + 1);
    else if (c1 < c0) c1 = Math.max(c1, Math.ceil(c0) - 1);
    const whole = c1 < c0 ? Math.ceil(c0) - 1 : Math.floor(c0);
    this.whole = whole;
    this.sliding = c0 !== c1 || c0 > whole;
    if (this.sliding) {
      const along = c0 - whole;
      // it comes from the top (and starts in step with its input), from the centre, or from where it was
      this.enter = along === 0;
      const from = along === 0 ? this.hTop : along === 1 ? h0 : this.ph;
      const to = this.slide(freq, h1, c1 - whole);
      const moves = to !== from || k1 !== k0;
      // (above a quarter of the sample rate it holds next to nothing, and scaling its states there would only
      // shake the one that follows its input)
      if (moves || !this.pstill) this.prho = this.ramp(this.pa, from, k0, to, k1, from < 1);
      this.pstill = !moves;
      this.ph = to;
    }
    this.count = c1;
    this.h = h1;
    this.k = k1;
    if (++this.sweep === SWEEP) {
      this.sweep = 0;
      // (on a sample count, not per block: the block size must not change a single bit)
      const zl = this.z[0];
      const zr = this.z[1];
      for (let j = 0; j < 2 * MAX_STAGES; j++) {
        const a = Math.abs(zl[j]);
        const b = Math.abs(zr[j]);
        if (!(a > 1e-30 && a < 1e30)) zl[j] = 0;
        if (!(b > 1e-30 && b < 1e30)) zr[j] = 0;
      }
    }
  }

  /**
   * `len` samples of both channels through every running stage, in place; `at` = how far into the control period.
   * (Both channels in one loop: a section waits for its own last result, so two that do not wait for each other
   * run almost as fast as one.)
   */
  chain(bl, br, len, at) {
    const zl = this.z[0];
    const zr = this.z[1];
    const whole = this.whole;
    let j = 0;
    if (this.moving) {
      const c = this.ca;
      const r = this.rho;
      for (let s = 0; s < whole; s++, j += 2) {
        let l1 = zl[j];
        let l2 = zl[j + 1];
        let r1 = zr[j];
        let r2 = zr[j + 1];
        for (let i = 0, q = at * 4; i < len; i++, q += 4) {
          const a1 = c[q];
          const a2 = c[q + 1];
          const a3 = c[q + 2];
          const k2 = c[q + 3];
          const xl = bl[i];
          const xr = br[i];
          const dl = xl - l2;
          const dr = xr - r2;
          const pl = a1 * l1 + a2 * dl;
          const pr = a1 * r1 + a2 * dr;
          const ql = l2 + a2 * l1 + a3 * dl;
          const qr = r2 + a2 * r1 + a3 * dr;
          l1 = (pl + pl - l1) * r;
          r1 = (pr + pr - r1) * r;
          l2 = (ql + ql - l2) * r;
          r2 = (qr + qr - r2) * r;
          bl[i] = xl - k2 * pl;
          br[i] = xr - k2 * pr;
        }
        zl[j] = l1;
        zl[j + 1] = l2;
        zr[j] = r1;
        zr[j + 1] = r2;
      }
    } else {
      // (the usual case: nothing moves, the coefficients are the first of the period)
      const a1 = this.ca[0];
      const a2 = this.ca[1];
      const a3 = this.ca[2];
      const k2 = this.ca[3];
      for (let s = 0; s < whole; s++, j += 2) {
        let l1 = zl[j];
        let l2 = zl[j + 1];
        let r1 = zr[j];
        let r2 = zr[j + 1];
        for (let i = 0; i < len; i++) {
          const xl = bl[i];
          const xr = br[i];
          const dl = xl - l2;
          const dr = xr - r2;
          // band-pass and low-pass of this section; its all-pass is the input minus 2k band-passes
          const pl = a1 * l1 + a2 * dl;
          const pr = a1 * r1 + a2 * dr;
          const ql = l2 + a2 * l1 + a3 * dl;
          const qr = r2 + a2 * r1 + a3 * dr;
          l1 = pl + pl - l1;
          r1 = pr + pr - r1;
          l2 = ql + ql - l2;
          r2 = qr + qr - r2;
          bl[i] = xl - k2 * pl;
          br[i] = xr - k2 * pr;
        }
        zl[j] = l1;
        zl[j + 1] = l2;
        zr[j] = r1;
        zr[j + 1] = r2;
      }
    }
    if (this.sliding) {
      const c = this.pa;
      const r = this.prho;
      // a stage that enters starts as if it had always been there: at the top its low-pass state is its input
      // (half a sample back, as a trapezoidal integrator holds it — and its input was what came out of the chain)
      let l1 = this.enter ? 0 : zl[j];
      let l2 = this.enter ? 0.5 * (bl[0] + this.lastL) : zl[j + 1];
      let r1 = this.enter ? 0 : zr[j];
      let r2 = this.enter ? 0.5 * (br[0] + this.lastR) : zr[j + 1];
      for (let i = 0, q = at * 4; i < len; i++, q += 4) {
        const a1 = c[q];
        const a2 = c[q + 1];
        const a3 = c[q + 2];
        const k2 = c[q + 3];
        const xl = bl[i];
        const xr = br[i];
        const dl = xl - l2;
        const dr = xr - r2;
        const pl = a1 * l1 + a2 * dl;
        const pr = a1 * r1 + a2 * dr;
        const ql = l2 + a2 * l1 + a3 * dl;
        const qr = r2 + a2 * r1 + a3 * dr;
        l1 = (pl + pl - l1) * r;
        r1 = (pr + pr - r1) * r;
        l2 = (ql + ql - l2) * r;
        r2 = (qr + qr - r2) * r;
        bl[i] = xl - k2 * pl;
        br[i] = xr - k2 * pr;
      }
      zl[j] = l1;
      zl[j + 1] = l2;
      zr[j] = r1;
      zr[j + 1] = r2;
    }
    this.lastL = bl[len - 1];
    this.lastR = br[len - 1];
    this.enter = false;
  }

  process(L, R, n) {
    const { dry, wet } = this;
    const wl = this.work[0];
    const wr = this.work[1];
    if (this.fresh) this.begin();
    let at = 0;
    while (at < n) {
      if (this.phase === 0) this.control();
      const len = Math.min(CONTROL - this.phase, n - at);
      for (let i = 0; i < len; i++) {
        wl[i] = safe(L[at + i]);
        wr[i] = safe(R[at + i]);
      }
      this.chain(wl, wr, len, this.phase);
      this.phase = (this.phase + len) % CONTROL;
      for (let i = 0; i < len; i++) {
        const dg = dry.next();
        const wg = wet.next();
        L[at + i] = safe(L[at + i]) * dg + wl[i] * wg;
        R[at + i] = safe(R[at + i]) * dg + wr[i] * wg;
      }
      at += len;
    }
  }
}
