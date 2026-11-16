// The GGS Synth's per-voice filter: 21 models behind one small class. A voice owns two of them; the editor and the
// tests use the same class to measure a setting's real frequency response (filterResponse) instead of drawing a
// formula that the audio might not follow.
//
// Families
//   clean     trapezoidal (zero-delay-feedback) state-variable filter — linear, exact cutoff, stable under any sweep
//   ladder    4-pole transistor ladder with a saturating input stage and a delay-free feedback loop (Zavalishin,
//             "The Art of VA Filter Design"); self-oscillates as a sine that tracks the cutoff
//   acid      4-pole diode ladder (TB-303 family): spread poles, rubbery resonance that saturates instead of whistling
//   ms20      Sallen-Key 2-pole with the resonance clipped inside the loop (Korg-35): screams, keeps its bass
//   formant   five parallel band-passes placed like a tenor's vowels (Csound "Formant Values" table)
//   phaser    2…12 first-order all-passes summed with the dry signal, feedback solved without a unit delay
//   comb      tuned feedback delay with a damped, saturating loop (Karplus-Strong strings, flanger colours)
//
// Coefficients are computed once per control block (set) and ramped per sample (process): no zipper noise, and a
// filter stays valid at every point of a sweep. Nothing here allocates while rendering.
import { Rng, softClip } from './util.js';

/**
 * The catalogue. `morph` names what the Morph knob does for a type ('' = unused); `nonlinear` types make harmonics of
 * their own, so "auto" quality oversamples them.
 */
export const FILTER_INFO = {
  lp12: { label: 'Low-pass 12 dB', family: 'clean', morph: '', desc: 'Clean 2-pole low-pass: a gentle slope that leaves some air. For pads, plucks and bright leads.' },
  lp24: { label: 'Low-pass 24 dB', family: 'clean', morph: '', desc: 'Clean 4-pole low-pass: firm and neutral with a precise resonance. The modern default for basses and sweeps.' },
  hp12: { label: 'High-pass 12 dB', family: 'clean', morph: '', desc: 'Clean 2-pole high-pass: thins a sound and keeps it out of the bass.' },
  hp24: { label: 'High-pass 24 dB', family: 'clean', morph: '', desc: 'Clean 4-pole high-pass: steep; glassy and weightless, for risers and noise hats.' },
  bp12: { label: 'Band-pass 12 dB', family: 'clean', morph: '', desc: 'Clean band-pass: nasal, telephone- or wah-like; resonance narrows it into a whistle.' },
  bp24: { label: 'Band-pass 24 dB', family: 'clean', morph: '', desc: 'Tighter band-pass: picks single harmonics out of a sound when swept.' },
  notch: { label: 'Notch', family: 'clean', morph: '', desc: 'Removes one narrow band: almost invisible when still, a soft hollow motion when swept.' },
  peak: { label: 'Peak', family: 'clean', morph: '', desc: 'Passes everything and adds a resonant bump at the cutoff: emphasises one harmonic without losing bass or highs.' },
  comb: { label: 'Comb +', family: 'comb', morph: 'Damping', nonlinear: true, desc: 'Tuned feedback delay: peaks at the cutoff and all its harmonics. Low resonance = metallic flanger colour; near 1 it rings like a plucked string (key track 1, a noise burst in). Morph damps the string.' },
  allpass: { label: 'All-pass', family: 'clean', morph: '', desc: 'Flat response; only the phase turns around the cutoff. Smears transients, and makes moving notches when run in parallel with the other filter.' },
  morph: { label: 'Morph LP-BP-HP', family: 'clean', morph: 'Shape', desc: 'Clean 2-pole filter whose shape slides from low-pass (0) through band-pass (0.5) to high-pass (1), the resonant peak held level. Modulate Morph for timbres that change character.' },
  ladder24: { label: 'Ladder 24 dB', family: 'ladder', morph: '', nonlinear: true, desc: 'Transistor-ladder low-pass (Moog style): warm, round and fat. Resonance sings, thins the bass a little and self-oscillates as a clean sine above ~0.9. Drive thickens it.' },
  ladder12: { label: 'Ladder 12 dB', family: 'ladder', morph: '', nonlinear: true, desc: 'The 2-pole tap of the ladder: same warmth and singing resonance, brighter and more open. Vintage polysynth pads, brass, keys.' },
  ladderBp: { label: 'Ladder band-pass', family: 'ladder', morph: '', nonlinear: true, desc: 'Band-pass mix of the ladder: a warm, gritty band with a vocal resonance. Wah and talking sweeps.' },
  ladderHp: { label: 'Ladder high-pass', family: 'ladder', morph: '', nonlinear: true, desc: 'High-pass mix of the ladder: removes lows with an analog edge and a resonance that screams near maximum.' },
  acid: { label: 'Acid (diode ladder)', family: 'acid', morph: '', nonlinear: true, desc: 'TB-303 style diode ladder: darker than its cutoff suggests, with a rubbery, squelching resonance. For acid lines: resonance 0.7–0.95, a fast envelope on the cutoff, drive to taste (drive sits after the filter, so the sweep itself screams).' },
  ms20Lp: { label: 'MS-20 low-pass', family: 'ms20', morph: '', nonlinear: true, desc: 'Korg-35 style 2-pole low-pass: full bass at any resonance, and a resonance that is clipped inside the loop — it screams and distorts instead of whistling. Snarling basses, raw leads.' },
  ms20Hp: { label: 'MS-20 high-pass', family: 'ms20', morph: '', nonlinear: true, desc: 'Korg-35 style high-pass with the same clipped, screaming resonance. Abrasive thin leads; in series before MS-20 low-pass for the classic pair.' },
  formant: { label: 'Formant (vowel)', family: 'formant', morph: 'Vowel', desc: 'Five resonances placed like a tenor voice: a bright source sings A (morph 0), E, I, O, U (1). Cutoff 1000 Hz = natural size, lower = bigger throat; resonance narrows the formants until they ring.' },
  phaser: { label: 'Phaser', family: 'phaser', morph: 'Stages', desc: 'All-pass chain mixed with the dry signal: notches around the cutoff that sweep together, per note. Resonance sharpens the peaks between them; Morph adds stages (2 … 12).' },
  combNeg: { label: 'Comb −', family: 'comb', morph: 'Damping', nonlinear: true, desc: 'Comb with inverted feedback: only odd harmonics of a tone an octave below the cutoff — hollow, woody, clarinet-like. Morph damps it.' }
};
export const FILTER_TYPES = Object.keys(FILTER_INFO);
const TYPE_INDEX = Object.fromEntries(FILTER_TYPES.map((id, i) => [id, i]));

/** Does this filter type make new harmonics (so it should be oversampled)? */
export const filterIsNonlinear = (type) => !!FILTER_INFO[type]?.nonlinear;

const SVF = 0, MIX = 1, LADDER = 2, ACID = 3, MS20 = 4, FORMANT = 5, PHASER = 6, COMB = 7;
const FAMILY = { lp12: SVF, lp24: SVF, hp12: SVF, hp24: SVF, bp12: SVF, bp24: SVF, notch: SVF, peak: SVF, comb: COMB, allpass: MIX, morph: MIX,
  ladder24: LADDER, ladder12: LADDER, ladderBp: LADDER, ladderHp: LADDER, acid: ACID, ms20Lp: MS20, ms20Hp: MS20, formant: FORMANT, phaser: PHASER, combNeg: COMB };

export const NC = 20; // coefficient slots (the formant bank needs 17)
export const NS = 24; // state slots (the phaser needs 12 stages × 2 channels)
export const MIN_CUTOFF = 16;
const COMB_MIN_HZ = 27;

// ---- fast tanh and the two delay-free loops ------------------------------------------------------------------
// Lambert's continued fraction for tanh as a [7/6] rational: |error| < 1e-4, odd, monotonic and bounded by ±1, so it
// is safe as the saturator inside a feedback loop — and the same on every machine, which Math.tanh need not be.
const TN1 = 17325 / 135135, TN2 = 378 / 135135, TN3 = 1 / 135135;
const TD1 = 62370 / 135135, TD2 = 3150 / 135135, TD3 = 28 / 135135;
const TANH_CLAMP = 4.97;

export function tanhFast(x) {
  if (x > TANH_CLAMP) x = TANH_CLAMP; else if (x < -TANH_CLAMP) x = -TANH_CLAMP;
  const x2 = x * x;
  const x4 = x2 * x2;
  return (x * ((1 + TN1 * x2) + x4 * (TN2 + TN3 * x2))) / ((1 + TD1 * x2) + x4 * (TD2 + TD3 * x2));
}

// tangents of tanh at 0.75, 1.4 and 2.2 (slope, intercept): tanh is concave for v > 0, so each is an upper bound
const T0S = 0.5965858, T0I = 0.1877096, T1S = 0.21615246, T1I = 0.5827382, T2S = 0.047925344, T2I = 0.8703074;

/**
 * Solves u = tanh(a − b·u), b ≥ 0: the instantaneous loop of a ladder whose input stage saturates. The start value
 * is the best of five lower bounds of the root (from tanh v ≤ v, ≤ 1 and three tangents); one Halley step then
 * leaves an error below 1e-4 of full scale for any level. i0…i3 are the reciprocals that depend only on b.
 */
function solveFeedback(a, b, i0, i1, i2, i3) {
  const aa = a < 0 ? -a : a;
  let v = aa * i0;
  let q = aa - b; if (q > v) v = q;
  q = (aa - b * T0I) * i1; if (q > v) v = q;
  q = (aa - b * T1I) * i2; if (q > v) v = q;
  q = (aa - b * T2I) * i3; if (q > v) v = q;
  const x = v > TANH_CLAMP ? TANH_CLAMP : v;
  const x2 = x * x;
  const x4 = x2 * x2;
  const p = x * ((1 + TN1 * x2) + x4 * (TN2 + TN3 * x2));
  const d = (1 + TD1 * x2) + x4 * (TD2 + TD3 * x2);
  const d2 = d * d;
  const e = d2 - p * p;
  const h = d2 + b * e;
  const f = (v - aa) * d + b * p;
  const dv = -(f * h * d) / (h * h + b * p * e * f);
  const r = 1 / d;
  const t = p * r;
  let u = t + e * r * r * dv * (1 - t * dv);
  if (u < 0) u = 0; else if (u > 1) u = 1;
  return a < 0 ? -u : u;
}

/** Solves w = α + β·tanh(w), 0 ≤ β < 1, and returns tanh(w): the clipped resonance path of the MS-20 filter. */
function solveForward(alpha, beta, i0, i1, i2, i3) {
  const aa = alpha < 0 ? -alpha : alpha;
  let w = aa * i0;
  let q = aa + beta; if (q < w) w = q;
  q = (aa + beta * T0I) * i1; if (q < w) w = q;
  q = (aa + beta * T1I) * i2; if (q < w) w = q;
  q = (aa + beta * T2I) * i3; if (q < w) w = q;
  const x = w > TANH_CLAMP ? TANH_CLAMP : w;
  const x2 = x * x;
  const x4 = x2 * x2;
  const p = x * ((1 + TN1 * x2) + x4 * (TN2 + TN3 * x2));
  const d = (1 + TD1 * x2) + x4 * (TD2 + TD3 * x2);
  const d2 = d * d;
  const e = d2 - p * p;
  const h = d2 - beta * e;
  const f = (w - aa) * d - beta * p;
  const dw = -(f * h * d) / (h * h - beta * p * e * f);
  const r = 1 / d;
  const t = p * r;
  let u = t + e * r * r * dw * (1 - t * dw);
  if (u < 0) u = 0; else if (u > 1) u = 1;
  return alpha < 0 ? -u : u;
}

// ---- drive -----------------------------------------------------------------------------------------------------
// The newer models share one drive law: up to +24 dB into a tanh, with a make-up gain that keeps a signal at the
// reference level (0.35) as loud as it was — so Drive adds grit, not volume. At drive 0 the stage is exactly linear.
const DRIVE_KNEE = 4;
const driveGain = (drive) => Math.pow(10, (24 * drive) / 20);
function driveMakeup(curv) {
  const u = curv * 0.35;
  return u < 0.05 ? 1 + (u * u) / 3 : u / Math.tanh(u);
}
const driveCurv = (drive, knee, floor) => (driveGain(drive) - 1) / knee + floor;

// self-oscillation needs something to start from: noise 130 dB below the knee, the same in both channels
const SEED_LEVEL = 3e-7;
const SEED = 0x1adde12f;

const LADDER_KNEE = 3;
// ladder pole mixes: weights of (u, y1, y2, y3, y4), pass-band compensation, output trim
const LADDER_MIX = {
  ladder24: [0, 0, 0, 0, 1, 0.5, 0],
  ladder12: [0, 0, 1, 0, 0, 0.5, 0],
  ladderBp: [0, 2, -2, 0, 0, 0, 0.5],
  ladderHp: [1, -2, 1, 0, 0, 0, 0.25]
};
const ACID_KNEE = 3;
const MS20_KNEE = 1.5;

// Csound manual, appendix "Formant Values", tenor: frequency (Hz), level (dB), bandwidth (Hz) of five formants
const VOWELS = [
  { f: [650, 1080, 2650, 2900, 3250], db: [0, -6, -7, -8, -22], bw: [80, 90, 120, 130, 140] }, // A
  { f: [400, 1700, 2600, 3200, 3580], db: [0, -14, -12, -14, -20], bw: [70, 80, 100, 120, 120] }, // E
  { f: [290, 1870, 2800, 3250, 3540], db: [0, -15, -18, -20, -30], bw: [40, 90, 100, 120, 120] }, // I
  { f: [400, 800, 2600, 2800, 3000], db: [0, -10, -12, -12, -26], bw: [40, 80, 100, 120, 120] }, // O
  { f: [350, 600, 2700, 2900, 3300], db: [0, -20, -17, -14, -26], bw: [40, 60, 100, 120, 120] } // U
];
const FORMANTS = 5;
const PHASER_STAGES = 12;

export class VoiceFilter {
  /**
   * sampleRate: the rate the filter runs at (the voice's internal, possibly oversampled, rate).
   * mem: an Arena to take the state from (a voice passes its own; see Arena in util.js).
   */
  constructor(sampleRate, mem = null) {
    this.fs = sampleRate;
    this.c = mem ? mem.f64(NC) : new Float64Array(NC); // coefficients now
    this.t = mem ? mem.f64(NC) : new Float64Array(NC); // … and at the end of the block being rendered
    this.d = mem ? mem.f64(NC) : new Float64Array(NC); // per-sample steps (formant bank)
    this.s = mem ? mem.f64(NS) : new Float64Array(NS);
    this.rng = new Rng(SEED);
    this.line = null;
    this.linePos = 0;
    this.lp = [0, 0];
    this.type = -1;
    this.setType('lp24');
  }

  /** Choose the model (an id of FILTER_TYPES). Clears the filter's memory: the caller fades around a live switch. */
  setType(id) {
    const type = TYPE_INDEX[id] ?? 1;
    if (type === this.type) return;
    this.type = type;
    this.id = FILTER_TYPES[type];
    this.family = FAMILY[this.id];
    this.two = type === 1 || type === 3 || type === 5;
    this.mix = LADDER_MIX[this.id] || LADDER_MIX.ladder24;
    this.hp = this.id === 'ms20Hp';
    this.neg = this.id === 'combNeg';
    if (this.family === COMB && !this.line) {
      const size = 1 << Math.ceil(Math.log2(this.fs / COMB_MIN_HZ + 8));
      this.line = [new Float32Array(size), new Float32Array(size)];
    }
    this.reset();
  }

  reset() {
    this.s.fill(0);
    if (this.line) { this.line[0].fill(0); this.line[1].fill(0); }
    this.lp[0] = this.lp[1] = 0;
    this.linePos = 0;
    this.rng = new Rng(SEED);
    this.first = true;
    this.fc = -1;
  }

  /**
   * Where the filter should be at the end of the next block. cutoff in Hz (already modulated and key-tracked);
   * resonance, drive and morph 0..1.
   */
  set(cutoff, res, drive, morph) {
    if (cutoff === this.fc && res === this.res && drive === this.drive && morph === this.morph) return;
    const fs = this.fs;
    const fc = cutoff < MIN_CUTOFF ? MIN_CUTOFF : cutoff > fs * 0.45 ? fs * 0.45 : cutoff;
    this.fc = cutoff; this.res = res; this.drive = drive; this.morph = morph;
    const t = this.t;
    const g = Math.tan((Math.PI * fc) / fs);
    switch (this.family) {
      case SVF:
        // damping k = 1/Q. 12 dB types: Q 0.707 (flat) … 40. 24 dB types: the second stage of a Butterworth pair
        // (Q 1.31 … 40); the first stage stays gentle (k1), so at zero resonance the pair is a 4-pole Butterworth
        t[0] = g;
        t[1] = this.two ? 1 / (1.3066 * Math.pow(30, res)) : 1 / (0.7071 * Math.pow(56, res));
        t[2] = drive;
        this.k1 = 1.848 - 0.6 * res;
        break;
      case MIX: {
        t[0] = g;
        t[1] = 1 / (0.7071 * Math.pow(56, res));
        t[2] = drive;
        if (this.id === 'allpass') {
          // all-pass = input − 2k·band
          t[3] = 1; t[4] = 0; t[5] = 2; t[6] = 0;
        } else {
          // equal-power low → band → high; the high-pass is input − k·band − low, so |H(fc)| = Q everywhere
          const sn = Math.sin(Math.PI * morph);
          const co = Math.cos(Math.PI * morph);
          const high = co < 0 ? -co : 0;
          t[3] = high; t[4] = sn; t[5] = high; t[6] = (co > 0 ? co : 0) - high;
        }
        break;
      }
      case LADDER: {
        const pre = driveGain(drive) / LADDER_KNEE;
        t[0] = g;
        t[1] = 4.4 * res; // self-oscillation starts at k = 4
        t[2] = pre;
        t[3] = driveMakeup(pre) / driveMakeup(1 / LADDER_KNEE);
        break;
      }
      case ACID: {
        const curv = driveCurv(drive, DRIVE_KNEE, 0);
        t[0] = g;
        t[1] = 17.5 * res; // a diode ladder needs k = 17 to self-oscillate
        t[2] = curv;
        t[3] = driveMakeup(curv);
        break;
      }
      case MS20: {
        const curv = driveCurv(drive, DRIVE_KNEE, 0);
        const r2 = res * res;
        t[0] = g;
        // Q 0.5 at 0, 2 at 0.5, 10 at 0.75; the loop self-oscillates (K > 2) above 0.83
        t[1] = 2 - 2 * (1 - res) * (1 - res) + 0.3 * r2 * r2 * r2 * r2;
        t[2] = curv;
        t[3] = driveMakeup(curv);
        break;
      }
      case FORMANT: {
        const pos = morph * (VOWELS.length - 1);
        const i = Math.min(VOWELS.length - 2, Math.floor(pos));
        const f = pos - i;
        const va = VOWELS[i];
        const vb = VOWELS[i + 1];
        const shift = cutoff / 1000; // 1000 Hz = the table as published
        const narrowing = Math.pow(0.2, res);
        const makeup = Math.pow(10, 12 / 20) / Math.sqrt(narrowing);
        for (let n = 0; n < FORMANTS; n++) {
          const tableHz = va.f[n] * Math.pow(vb.f[n] / va.f[n], f);
          const hz = Math.min(fs * 0.45, Math.max(MIN_CUTOFF, tableHz * shift));
          const level = Math.pow(10, (va.db[n] + (vb.db[n] - va.db[n]) * f) / 20);
          // constant Q under transposition: k = 1/Q = bandwidth / centre
          const k = ((va.bw[n] + (vb.bw[n] - va.bw[n]) * f) * narrowing) / tableHz;
          t[n] = Math.tan((Math.PI * hz) / fs);
          t[FORMANTS + n] = k;
          // k·band has unity gain at its centre; alternating signs keep neighbouring skirts from cancelling
          t[2 * FORMANTS + n] = (n % 2 ? -1 : 1) * level * k * makeup;
        }
        const curv = driveCurv(drive, DRIVE_KNEE, 0);
        t[15] = curv;
        t[16] = driveMakeup(curv);
        break;
      }
      case PHASER: {
        const fb = 0.85 * res;
        const curv = driveCurv(drive, DRIVE_KNEE, 0);
        t[0] = g;
        t[1] = fb;
        t[2] = morph * (PHASER_STAGES / 2 - 1); // 0 = 2 stages … 5 = 12
        // feedback raises the pass-bands and the loudness: split the difference
        const keepLoudness = Math.sqrt((2 * (1 - fb * fb)) / (2 - fb * fb));
        const keepPeaks = (2 * (1 - fb)) / (2 - fb);
        t[3] = 0.5 * Math.sqrt(keepLoudness * keepPeaks);
        t[4] = curv;
        t[5] = driveMakeup(curv);
        break;
      }
      default: { // COMB
        const hz = cutoff < COMB_MIN_HZ ? COMB_MIN_HZ : fc;
        const period = fs / hz;
        const fb = 0.3 + 0.695 * (1 - (1 - res) * (1 - res));
        // damping: a one-pole low-pass in the loop, open at morph 0, down to 250 Hz at 1 — never below twice the
        // comb's pitch, so the fundamental always rings
        const mm = morph < 1e-3 ? 1e-3 : morph;
        const dampHz = Math.max(250 / (mm * mm * mm), 2 * hz);
        const a = 1 - Math.exp((-2 * Math.PI * dampHz) / fs);
        // that low-pass delays the loop: take its phase delay at the first peak out of the delay line, so the
        // fundamental stays in tune for any damping
        const omega = (2 * Math.PI * (this.neg ? 0.5 : 1)) / period;
        const pole = 1 - a;
        const lpDelay = Math.atan2(pole * Math.sin(omega), 1 - pole * Math.cos(omega)) / omega;
        const curv = driveCurv(drive, DRIVE_KNEE, 1 / 8);
        t[0] = Math.min(this.line[0].length - 4, Math.max(2, period - lpDelay));
        t[1] = this.neg ? -fb : fb;
        t[2] = a;
        t[3] = Math.sqrt(1 - fb * fb); // keeps broadband loudness constant as the feedback rises
        t[4] = curv;
        t[5] = driveMakeup(curv) / driveMakeup(1 / 8);
      }
    }
  }

  /** Filter m samples of a stereo bus in place. */
  process(L, R, m) {
    const c = this.c;
    const t = this.t;
    if (this.first) { c.set(t); this.first = false; }
    switch (this.family) {
      case SVF: this.svf(L, R, m); break;
      case MIX: this.svfMix(L, R, m); break;
      case LADDER: this.ladder(L, R, m); break;
      case ACID: this.acid(L, R, m); break;
      case MS20: this.ms20(L, R, m); break;
      case FORMANT: this.formant(L, R, m); break;
      case PHASER: this.phaser(L, R, m); break;
      default: this.comb(L, R, m);
    }
    c.set(t);
    // a filter fed with silence decays into denormal numbers, which are many times slower to compute: stop there
    const s = this.s;
    for (let i = 0; i < NS; i++) if (s[i] < 1e-30 && s[i] > -1e-30) s[i] = 0;
  }

  svf(L, R, m) {
    const c = this.c, t = this.t, s = this.s;
    const type = this.type;
    let g = c[0], k = c[1], drive = c[2];
    const dg = (t[0] - g) / m, dk = (t[1] - k) / m, dd = (t[2] - drive) / m;
    const driven = drive > 0.001 || t[2] > 0.001;
    const two = this.two;
    const k1 = this.k1;
    let a1L = s[0], a2L = s[1], a1R = s[2], a2R = s[3], b1L = s[4], b2L = s[5], b1R = s[6], b2R = s[7];
    const mode = type >> 1; // 0 lp · 1 hp · 2 bp · 3 notch(6)/peak(7)
    for (let i = 0; i < m; i++) {
      g += dg; k += dk;
      let xl = L[i];
      let xr = R[i];
      if (driven) {
        drive += dd;
        const pre = 1 + drive * 7;
        const post = 1 / Math.sqrt(pre);
        xl = softClip(xl * pre) * post;
        xr = softClip(xr * pre) * post;
      }
      const kk = two ? k1 : k;
      let c1 = 1 / (1 + g * (g + kk));
      let c2 = g * c1;
      let c3 = g * c2;
      let v3 = xl - a2L;
      let v1 = c1 * a1L + c2 * v3;
      let v2 = a2L + c2 * a1L + c3 * v3;
      a1L = 2 * v1 - a1L; a2L = 2 * v2 - a2L;
      let yl = mode === 0 ? v2 : mode === 1 ? xl - kk * v1 - v2 : mode === 2 ? kk * v1 : type === 6 ? xl - kk * v1 : 2 * v2 - xl + kk * v1;
      v3 = xr - a2R;
      v1 = c1 * a1R + c2 * v3;
      v2 = a2R + c2 * a1R + c3 * v3;
      a1R = 2 * v1 - a1R; a2R = 2 * v2 - a2R;
      let yr = mode === 0 ? v2 : mode === 1 ? xr - kk * v1 - v2 : mode === 2 ? kk * v1 : type === 6 ? xr - kk * v1 : 2 * v2 - xr + kk * v1;
      if (two) {
        c1 = 1 / (1 + g * (g + k));
        c2 = g * c1;
        c3 = g * c2;
        v3 = yl - b2L;
        v1 = c1 * b1L + c2 * v3;
        v2 = b2L + c2 * b1L + c3 * v3;
        b1L = 2 * v1 - b1L; b2L = 2 * v2 - b2L;
        yl = mode === 0 ? v2 : mode === 1 ? yl - k * v1 - v2 : k * v1;
        v3 = yr - b2R;
        v1 = c1 * b1R + c2 * v3;
        v2 = b2R + c2 * b1R + c3 * v3;
        b1R = 2 * v1 - b1R; b2R = 2 * v2 - b2R;
        yr = mode === 0 ? v2 : mode === 1 ? yr - k * v1 - v2 : k * v1;
      }
      L[i] = yl;
      R[i] = yr;
    }
    s[0] = a1L; s[1] = a2L; s[2] = a1R; s[3] = a2R; s[4] = b1L; s[5] = b2L; s[6] = b1R; s[7] = b2R;
  }

  /** One clean section with a moving output mix: output = cx·input + (cb − hk·k)·band + cl·low. */
  svfMix(L, R, m) {
    const c = this.c, t = this.t, s = this.s;
    let g = c[0], k = c[1], drive = c[2], cx = c[3], cb = c[4], hk = c[5], cl = c[6];
    const dg = (t[0] - g) / m, dk = (t[1] - k) / m, dd = (t[2] - drive) / m;
    const dcx = (t[3] - cx) / m, dcb = (t[4] - cb) / m, dhk = (t[5] - hk) / m, dcl = (t[6] - cl) / m;
    const driven = drive > 0.001 || t[2] > 0.001;
    let a1L = s[0], a2L = s[1], a1R = s[2], a2R = s[3];
    for (let i = 0; i < m; i++) {
      g += dg; k += dk; cx += dcx; cb += dcb; hk += dhk; cl += dcl;
      let xl = L[i];
      let xr = R[i];
      if (driven) {
        drive += dd;
        const pre = 1 + drive * 7;
        const post = 1 / Math.sqrt(pre);
        xl = softClip(xl * pre) * post;
        xr = softClip(xr * pre) * post;
      }
      const c1 = 1 / (1 + g * (g + k));
      const c2 = g * c1;
      const c3 = g * c2;
      const band = cb - hk * k;
      let v3 = xl - a2L;
      let v1 = c1 * a1L + c2 * v3;
      let v2 = a2L + c2 * a1L + c3 * v3;
      a1L = 2 * v1 - a1L; a2L = 2 * v2 - a2L;
      L[i] = cx * xl + band * v1 + cl * v2;
      v3 = xr - a2R;
      v1 = c1 * a1R + c2 * v3;
      v2 = a2R + c2 * a1R + c3 * v3;
      a1R = 2 * v1 - a1R; a2R = 2 * v2 - a2R;
      R[i] = cx * xr + band * v1 + cl * v2;
    }
    s[0] = a1L; s[1] = a2L; s[2] = a1R; s[3] = a2R;
  }

  /**
   * Transistor ladder: four buffered one-pole stages in a loop, u = tanh(x·pre − k·y4). Each stage output is
   * y_i = G^i·u + c_i (G = g/(1+g), c_i from the states alone), which leaves one scalar equation for u.
   */
  ladder(L, R, m) {
    const c = this.c, t = this.t, s = this.s, mix = this.mix, rng = this.rng;
    let g = c[0], k = c[1], pre = c[2], post = c[3];
    const dg = (t[0] - g) / m, dk = (t[1] - k) / m, dpre = (t[2] - pre) / m, dpost = (t[3] - post) / m;
    const moving = dg !== 0 || dk !== 0 || dpre !== 0;
    const m0 = mix[0], m1 = mix[1], m2 = mix[2], m3 = mix[3], m4 = mix[4], comp = mix[5], trim = mix[6];
    let l0 = s[0], l1 = s[1], l2 = s[2], l3 = s[3], r0 = s[4], r1 = s[5], r2 = s[6], r3 = s[7];
    let g1 = 0, d = 0, g2 = 0, g3 = 0, g4 = 0, b = 0, i0 = 0, i1 = 0, i2 = 0, i3 = 0, pin = 0, pout = 0;
    for (let i = 0; i < m; i++) {
      if (moving || i === 0) {
        g += dg; k += dk; pre += dpre; post += dpost;
        g1 = g / (1 + g);
        d = 1 - g1;
        g2 = g1 * g1; g3 = g2 * g1; g4 = g2 * g2;
        b = k * g4;
        i0 = 1 / (1 + b); i1 = 1 / (1 + b * T0S); i2 = 1 / (1 + b * T1S); i3 = 1 / (1 + b * T2S);
        // resonance takes level from the pass-band: the low-pass modes get half of it back at the input, the
        // pole-mixed band- and high-pass are trimmed at the output instead
        pin = pre * (1 + comp * k);
        pout = post / (pre * (1 + trim * k));
      }
      const seed = k >= 4 ? rng.next() * SEED_LEVEL : 0;
      let c4 = d * ((g3 * l0 + g2 * l1) + (g1 * l2 + l3));
      let c1 = d * l0;
      let c2 = g1 * c1 + d * l1;
      let c3 = g1 * c2 + d * l2;
      let u = solveFeedback(L[i] * pin + seed - k * c4, b, i0, i1, i2, i3);
      let y1 = g1 * u + c1, y2 = g2 * u + c2, y3 = g3 * u + c3, y4 = g4 * u + c4;
      l0 = 2 * y1 - l0; l1 = 2 * y2 - l1; l2 = 2 * y3 - l2; l3 = 2 * y4 - l3;
      L[i] = (m0 * u + m1 * y1 + m2 * y2 + m3 * y3 + m4 * y4) * pout;
      c4 = d * ((g3 * r0 + g2 * r1) + (g1 * r2 + r3));
      c1 = d * r0;
      c2 = g1 * c1 + d * r1;
      c3 = g1 * c2 + d * r2;
      u = solveFeedback(R[i] * pin + seed - k * c4, b, i0, i1, i2, i3);
      y1 = g1 * u + c1; y2 = g2 * u + c2; y3 = g3 * u + c3; y4 = g4 * u + c4;
      r0 = 2 * y1 - r0; r1 = 2 * y2 - r1; r2 = 2 * y3 - r2; r3 = 2 * y4 - r3;
      R[i] = (m0 * u + m1 * y1 + m2 * y2 + m3 * y3 + m4 * y4) * pout;
    }
    s[0] = l0; s[1] = l1; s[2] = l2; s[3] = l3; s[4] = r0; s[5] = r1; s[6] = r2; s[7] = r3;
  }

  /**
   * Diode ladder: the four stages load each other (a tridiagonal system, eliminated from the last stage upwards:
   * y_i = a_i·y_(i−1) + b_i), which spreads the poles and gives the soft knee and the low, rubbery resonance.
   * The integrator gain is √2·g, which puts the self-oscillation exactly on the cutoff.
   */
  acid(L, R, m) {
    const c = this.c, t = this.t, s = this.s, rng = this.rng;
    let gc = c[0], k = c[1], curv = c[2], makeup = c[3];
    const dg = (t[0] - gc) / m, dk = (t[1] - k) / m, dcurv = (t[2] - curv) / m, dmk = (t[3] - makeup) / m;
    const moving = dg !== 0 || dk !== 0;
    const driven = curv > 1e-3 || t[2] > 1e-3;
    let l0 = s[0], l1 = s[1], l2 = s[2], l3 = s[3], r0 = s[4], r1 = s[5], r2 = s[6], r3 = s[7];
    let g = 0, h = 0, r4 = 0, a4 = 0, r3c = 0, a3 = 0, r2c = 0, a2 = 0, r1c = 0, a1 = 0, ga2 = 0, ga3 = 0, ga4 = 0;
    let w0 = 0, w1 = 0, w2 = 0, w3 = 0, b = 0, i0 = 0, i1 = 0, i2 = 0, i3 = 0, post = 0;
    for (let i = 0; i < m; i++) {
      if (moving || i === 0) {
        gc += dg; k += dk;
        g = Math.SQRT2 * gc;
        h = 0.5 * g;
        r4 = 1 / (1 + g); a4 = h * r4;
        r3c = 1 / (1 + g - h * a4); a3 = h * r3c;
        r2c = 1 / (1 + g - h * a3); a2 = h * r2c;
        r1c = 1 / (1 + g - g * a2); a1 = g * r1c;
        ga2 = a2 * a1; ga3 = a3 * ga2; ga4 = a4 * ga3;
        // the weights of the four states in y4, so the feedback signal is one dot product
        const a43 = a4 * a3;
        const q2 = ga4 + a43;
        const q3 = a2 * q2 + a4;
        const q4 = a3 * q3 + 1;
        w0 = a43 * a2 * r1c; w1 = r2c * q2; w2 = r3c * q3; w3 = r4 * q4;
        b = k * ga4;
        i0 = 1 / (1 + b); i1 = 1 / (1 + b * T0S); i2 = 1 / (1 + b * T1S); i3 = 1 / (1 + b * T2S);
        // the raw circuit loses 1/(1+k) of its pass-band; 40 % of k comes back as output gain
        post = ACID_KNEE * (1 + 0.4 * k);
      }
      curv += dcurv; makeup += dmk;
      const seed = k >= 17 ? rng.next() * SEED_LEVEL : 0;
      let sigma = (w0 * l0 + w1 * l1) + (w2 * l2 + w3 * l3);
      let u = solveFeedback(L[i] * (1 / ACID_KNEE) + seed - k * sigma, b, i0, i1, i2, i3);
      let b4 = l3 * r4;
      let b3 = (h * b4 + l2) * r3c;
      let b2 = (h * b3 + l1) * r2c;
      let b1 = (g * b2 + l0) * r1c;
      let c2 = a2 * b1 + b2;
      let c3 = a3 * c2 + b3;
      let y4 = ga4 * u + sigma;
      l0 = 2 * (a1 * u + b1) - l0; l1 = 2 * (ga2 * u + c2) - l1; l2 = 2 * (ga3 * u + c3) - l2; l3 = 2 * y4 - l3;
      let y = y4 * post;
      L[i] = driven && curv > 1e-3 ? tanhFast(curv * y) * (makeup / curv) : y;
      sigma = (w0 * r0 + w1 * r1) + (w2 * r2 + w3 * r3);
      u = solveFeedback(R[i] * (1 / ACID_KNEE) + seed - k * sigma, b, i0, i1, i2, i3);
      b4 = r3 * r4;
      b3 = (h * b4 + r2) * r3c;
      b2 = (h * b3 + r1) * r2c;
      b1 = (g * b2 + r0) * r1c;
      c2 = a2 * b1 + b2;
      c3 = a3 * c2 + b3;
      y4 = ga4 * u + sigma;
      r0 = 2 * (a1 * u + b1) - r0; r1 = 2 * (ga2 * u + c2) - r1; r2 = 2 * (ga3 * u + c3) - r2; r3 = 2 * y4 - r3;
      y = y4 * post;
      R[i] = driven && curv > 1e-3 ? tanhFast(curv * y) * (makeup / curv) : y;
    }
    s[0] = l0; s[1] = l1; s[2] = l2; s[3] = l3; s[4] = r0; s[5] = r1; s[6] = r2; s[7] = r3;
  }

  /**
   * Sallen-Key (Korg-35): two one-poles with positive feedback of their difference through a tanh —
   * u = x + clip(K·(y1 − y2)), low-pass = y2, high-pass = u − 2·y1 + y2. The pass-band stays at unity for any
   * resonance, and a loud input leaves the limiter less room, so the resonance ducks under the signal.
   */
  ms20(L, R, m) {
    const c = this.c, t = this.t, s = this.s, rng = this.rng;
    let g = c[0], k = c[1], curv = c[2], makeup = c[3];
    const dg = (t[0] - g) / m, dk = (t[1] - k) / m, dcurv = (t[2] - curv) / m, dmk = (t[3] - makeup) / m;
    const moving = dg !== 0 || dk !== 0;
    const driven = curv > 1e-3 || t[2] > 1e-3;
    const hp = this.hp;
    let l0 = s[0], l1 = s[1], r0 = s[2], r1 = s[3];
    let g1 = 0, d = 0, g2 = 0, beta = 0, kd = 0, i0 = 0, i1 = 0, i2 = 0, i3 = 0;
    for (let i = 0; i < m; i++) {
      if (moving || i === 0) {
        g += dg; k += dk;
        g1 = g / (1 + g);
        d = 1 - g1;
        g2 = g1 * g1;
        beta = k * g1 * d; // ≤ 0.58
        kd = k * d;
        i0 = 1 / (1 - beta); i1 = 1 / (1 - beta * T0S); i2 = 1 / (1 - beta * T1S); i3 = 1 / (1 - beta * T2S);
      }
      curv += dcurv; makeup += dmk;
      const seed = k >= 2 ? rng.next() * SEED_LEVEL : 0;
      let x = L[i];
      const shape = driven && curv > 1e-3; // a drive that ramps down to zero ends exactly linear
      if (shape) x = tanhFast(curv * x) * (makeup / curv);
      // everything inside the loop is in knee units
      let xin = x * (1 / MS20_KNEE) + seed;
      let c1 = d * l0;
      let c2 = g1 * c1 + d * l1;
      let u = xin + solveForward(beta * xin + kd * (c1 - l1), beta, i0, i1, i2, i3);
      let y1 = g1 * u + c1;
      let y2 = g2 * u + c2;
      l0 = 2 * y1 - l0; l1 = 2 * y2 - l1;
      L[i] = (hp ? u - 2 * y1 + y2 : y2) * MS20_KNEE;
      x = R[i];
      if (shape) x = tanhFast(curv * x) * (makeup / curv);
      xin = x * (1 / MS20_KNEE) + seed;
      c1 = d * r0;
      c2 = g1 * c1 + d * r1;
      u = xin + solveForward(beta * xin + kd * (c1 - r1), beta, i0, i1, i2, i3);
      y1 = g1 * u + c1;
      y2 = g2 * u + c2;
      r0 = 2 * y1 - r0; r1 = 2 * y2 - r1;
      R[i] = (hp ? u - 2 * y1 + y2 : y2) * MS20_KNEE;
    }
    s[0] = l0; s[1] = l1; s[2] = r0; s[3] = r1;
  }

  /** Five parallel band-passes: per formant a cutoff gain, a damping and a (signed) level, all ramped. */
  formant(L, R, m) {
    const c = this.c, t = this.t, s = this.s, d = this.d;
    for (let j = 0; j < 17; j++) d[j] = (t[j] - c[j]) / m;
    const driven = c[15] > 1e-3 || t[15] > 1e-3;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < 17; j++) c[j] += d[j];
      let xl = L[i];
      let xr = R[i];
      if (driven && c[15] > 1e-3) {
        const curv = c[15];
        const gain = c[16] / curv;
        xl = tanhFast(curv * xl) * gain;
        xr = tanhFast(curv * xr) * gain;
      }
      let ol = 0;
      let or = 0;
      for (let n = 0; n < FORMANTS; n++) {
        const g = c[n];
        const k = c[FORMANTS + n];
        const a = c[2 * FORMANTS + n];
        const a1 = 1 / (1 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        const o = n * 4;
        let ic1 = s[o];
        let ic2 = s[o + 1];
        let v3 = xl - ic2;
        let v1 = a1 * ic1 + a2 * v3;
        s[o] = 2 * v1 - ic1;
        s[o + 1] = 2 * (ic2 + a2 * ic1 + a3 * v3) - ic2;
        ol += a * v1;
        ic1 = s[o + 2];
        ic2 = s[o + 3];
        v3 = xr - ic2;
        v1 = a1 * ic1 + a2 * v3;
        s[o + 2] = 2 * v1 - ic1;
        s[o + 3] = 2 * (ic2 + a2 * ic1 + a3 * v3) - ic2;
        or += a * v1;
      }
      L[i] = ol;
      R[i] = or;
    }
  }

  /**
   * Phaser: each stage is a first-order all-pass y = a·x + (1 − a)·s, s = (1 + a)·x − a·s with a = (g − 1)/(g + 1).
   * The wet signal cross-fades between the taps after 2n and 2n + 2 stages, so Morph never clicks, and the
   * resonance loop is solved exactly (the chain is linear: wet = gain·in + what the states contribute).
   */
  phaser(L, R, m) {
    const c = this.c, t = this.t, s = this.s;
    let g = c[0], fb = c[1], pos = c[2], norm = c[3], curv = c[4], makeup = c[5];
    const dg = (t[0] - g) / m, dfb = (t[1] - fb) / m, dpos = (t[2] - pos) / m, dnorm = (t[3] - norm) / m;
    const dcurv = (t[4] - curv) / m, dmk = (t[5] - makeup) / m;
    const driven = curv > 1e-3 || t[4] > 1e-3;
    let used = 0;
    for (let i = 0; i < m; i++) {
      g += dg; fb += dfb; pos += dpos; norm += dnorm; curv += dcurv; makeup += dmk;
      const a = (g - 1) / (g + 1);
      const c1 = 1 - a;
      const ap1 = 1 + a;
      let n = pos > 0 ? pos | 0 : 0;
      if (n > PHASER_STAGES / 2 - 2) n = PHASER_STAGES / 2 - 2;
      let frac = pos - n;
      frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      const nLo = 2 * n + 2;
      const nHi = nLo + 2;
      if (nHi > used) used = nHi;
      // zero-delay gain of the chain up to each tap: a^n
      const a2 = a * a;
      let gainLo = a2;
      for (let j = 1; j < nLo / 2; j++) gainLo *= a2;
      const inv = 1 / (1 - fb * gainLo * (1 + frac * (a2 - 1)));
      for (let ch = 0; ch < 2; ch++) {
        const io = ch ? R : L;
        let x = io[i];
        if (driven && curv > 1e-3) x = tanhFast(curv * x) * (makeup / curv);
        // pass 1: what the states alone contribute to each tap
        let acc = 0;
        let sLo = 0;
        for (let j = 0; j < nHi; j++) {
          acc = acc * a + c1 * s[j * 2 + ch];
          if (j + 1 === nLo) sLo = acc;
        }
        // solve in = x + fb·(gain·in + tap), then run the chain
        let y = (x + fb * (sLo + frac * (acc - sLo))) * inv;
        let yLo = 0;
        for (let j = 0; j < nHi; j++) {
          const st = s[j * 2 + ch];
          const next = a * y + c1 * st;
          s[j * 2 + ch] = ap1 * y - a * st;
          y = next;
          if (j + 1 === nLo) yLo = y;
        }
        io[i] = (x + yLo + frac * (y - yLo)) * norm;
      }
    }
    // stages that Morph has left start from silence when they come back
    for (let j = used * 2; j < NS; j++) s[j] = 0;
  }

  /** y[n] = sat(g_in·x[n] ± fb·LP(y[n − D])), the delay read with 4-point Hermite interpolation. */
  comb(L, R, m) {
    const c = this.c, t = this.t, lp = this.lp;
    const size = this.line[0].length;
    const mask = size - 1;
    const dd = (t[0] - c[0]) / m, dfb = (t[1] - c[1]) / m, dda = (t[2] - c[2]) / m, dgi = (t[3] - c[3]) / m;
    const dcurv = (t[4] - c[4]) / m, dpost = (t[5] - c[5]) / m;
    let pos = this.linePos;
    for (let ch = 0; ch < 2; ch++) {
      const buf = this.line[ch];
      const io = ch ? R : L;
      let delay = c[0], fb = c[1], damp = c[2], gin = c[3], curv = c[4], post = c[5];
      let z = lp[ch];
      let w = this.linePos;
      for (let i = 0; i < m; i++) {
        delay += dd; fb += dfb; damp += dda; gin += dgi; curv += dcurv; post += dpost;
        const rd = w - delay + size;
        const ri = rd | 0;
        const fr = rd - ri;
        const ym = buf[(ri - 1) & mask], ya = buf[ri & mask], yb = buf[(ri + 1) & mask], yc = buf[(ri + 2) & mask];
        const echo = ((((0.5 * (yc - ym) + 1.5 * (ya - yb)) * fr + (ym - 2.5 * ya + 2 * yb - 0.5 * yc)) * fr + 0.5 * (yb - ym)) * fr) + ya;
        z += damp * (echo - z);
        const y = tanhFast(curv * (gin * io[i] + fb * z)) / curv;
        buf[w] = y;
        io[i] = y * post;
        w = (w + 1) & mask;
      }
      lp[ch] = z < 1e-30 && z > -1e-30 ? 0 : z;
      pos = w;
    }
    this.linePos = pos;
  }
}

/**
 * Small-signal magnitude response (dB) of a filter setting at each of `freqs` (Hz) — measured, not derived: a fresh
 * filter is fed a −60 dBFS impulse and the Fourier transform of what comes out is evaluated at exactly those
 * frequencies. So it is right for every model, comb, formant and phaser included, and it shows what the drive stage
 * and the resonance compensation really do. A setting that still rings after `maxSeconds` (a comb at high feedback,
 * a self-oscillating ladder) is faded out, which lowers and widens its peaks slightly.
 * settings: { type, cutoff, resonance, drive, morph }.
 */
export function filterResponse(settings, freqs, { sampleRate = 48000, maxSeconds = 0.4 } = {}) {
  const f = new VoiceFilter(sampleRate);
  f.setType(settings.type);
  f.set(settings.cutoff ?? 1000, settings.resonance ?? 0, settings.drive ?? 0, settings.morph ?? 0);
  const IMPULSE = 1e-3;
  const BLOCK = 64;
  // "has it decayed?" is asked of 50 ms at a time: the response of a comb is a row of echoes with silence between
  const WINDOW = Math.ceil((sampleRate * 0.05) / BLOCK);
  const maxLen = Math.max(2 * WINDOW, Math.ceil((sampleRate * maxSeconds) / BLOCK / WINDOW) * WINDOW) * BLOCK;
  const h = new Float64Array(maxLen);
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  let len = 0;
  let peak = 0;
  let windowPeak = 0;
  let decayed = false;
  for (let b = 1; len < maxLen; b++) {
    L.fill(0); R.fill(0);
    if (len === 0) L[0] = R[0] = IMPULSE;
    f.process(L, R, BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const v = Number.isFinite(L[i]) ? L[i] : 0;
      h[len + i] = v;
      if (v > windowPeak) windowPeak = v; else if (-v > windowPeak) windowPeak = -v;
    }
    len += BLOCK;
    if (b % WINDOW) continue;
    if (windowPeak > peak) peak = windowPeak;
    if (b >= 2 * WINDOW && windowPeak <= peak * 1e-6) { decayed = true; break; }
    windowPeak = 0;
  }
  if (!decayed) {
    for (let i = 0; i < len; i++) {
      const w = Math.cos((Math.PI / 2) * (i / len));
      h[i] *= w * w;
    }
  }
  const out = new Float32Array(freqs.length);
  for (let n = 0; n < freqs.length; n++) {
    const hz = Number.isFinite(freqs[n]) ? Math.min(sampleRate / 2, Math.max(0, freqs[n])) : 0;
    const omega = (2 * Math.PI * hz) / sampleRate;
    const rc = Math.cos(omega);
    const rs = Math.sin(omega);
    let cr = 1, sr = 0, re = 0, im = 0;
    for (let i = 0; i < len; i++) {
      const v = h[i];
      re += v * cr;
      im -= v * sr;
      const next = cr * rc - sr * rs;
      sr = sr * rc + cr * rs;
      cr = next;
    }
    out[n] = 20 * Math.log10(Math.max(1e-10, Math.sqrt(re * re + im * im) / IMPULSE));
  }
  return out;
}
