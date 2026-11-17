// Algorithmic reverb: sixteen delay lines that feed each other through a matrix that loses no energy (a feedback
// delay network, Jot & Chaigne 1991). The only thing that makes the tail fade is the loss each line carries, and
// that loss is worked out from the decay time and the line's own length — so every echo path fades at the same
// rate, nothing rings on after the rest, and the decay time on the knob is the decay time you measure.
//
//   in ─ low cut ─ pre-delay ─┬─ early-reflection taps ───────────────────────────┐
//                             └─ 4 all-passes ─ bloom ─► 16 lines ⇄ matrix ─► + ─ width ─ wet
//
// Line lengths are different primes spread over a range the voicing chooses (and `size` scales); the matrix is a
// Hadamard matrix (every line feeds every other equally) followed by eight slowly turning rotations, which keep it
// lossless while it moves (Schlecht & Habets 2015); every line length drifts on its own slow sine, which is the
// chorused tail of a good hall (Dattorro 1997).
//
// A port of the reverb of GGS Composer (Rust: fx-space/fdn.rs + reverb.rs), with its constants: voicing tables,
// tap vectors, the early-reflection pattern, the line lengths. What differs is said where it differs.
import { StudioFx, num, choice, flag, TAU, onepole, clamp } from './base.js';

const LINES = 16;
const PAIRS = LINES / 2;
const ER_TAPS = 10;
const DIFF_STAGES = 4;
const BLOOM_STAGES = 3;
const MAX_SCALE = 2; // the delay scale at size 1
const MAX_PREDELAY_MS = 250;
const MAX_EXCURSION_S = 0.003; // the furthest a line length drifts, whatever the rate
const ROT_MAX = 0.6; // the furthest the matrix rotations turn at modDepth 1, radians
// the wet power for a 2 s decay, relative to the input (−3 dB); longer decays are let half-way louder: √(decay / 2)
const LATE_LEVEL = 0.5;
const BLOOM_SPLIT_HZ = 1200;
const LN1000 = Math.log(1000); // a gain of exp(−LN1000 · t / T) has lost 60 dB after T
const LIMIT = 15.85; // what may enter the network: +24 dB, as `safe` in base.js
// What is written into a delay is kept sane: smaller than TINY it is silence (numbers that fade towards nothing get
// slow on some CPUs), a NaN is silence, and nothing is larger than HUGE (+120 dB: never reached unless something is
// broken). The test is on the size of the number, not its sign: a branch on the sign of audio cannot be predicted,
// and costs ten times the arithmetic it guards (measured).
const TINY = 1e-15;
const HUGE = 1e6;
const F32_MAX = 3.4028234663852886e38;
const f32 = Math.fround;

/**
 * What makes a voicing: where its delays sit, how the input is smeared, how the tail moves. Times are in ms at
 * size 0.5. lines: shortest and longest of the sixteen · diff: the input all-passes (left; the right ones are 7 %
 * longer) and their gain at diffusion 1 · er: the span of the early reflections and their level · hf / lf: the decay
 * above `damping` / below `lowCut` as a share of `decay` · cents: the peak detune of the drifting lines at modDepth 1 ·
 * bloom: 1 = the highs arrive late, through the bloom all-passes (two for the highs, one for the lows).
 */
export const VOICINGS = [
  { name: 'room', lines: [14, 71], diff: [1.9, 3.1, 4.9, 7.3], diffGain: 0.62, er: [3, 32], erLevel: 1, hf: 0.45, lf: 0.7, cents: 5, bloom: 0, bloomMs: [19, 29, 13] },
  { name: 'hall', lines: [29, 97], diff: [3.7, 6.1, 9.7, 14.3], diffGain: 0.7, er: [9, 78], erLevel: 0.9, hf: 0.35, lf: 0.6, cents: 8, bloom: 0, bloomMs: [31, 47, 23] },
  { name: 'plate', lines: [13, 57], diff: [1.3, 2.3, 3.7, 5.9], diffGain: 0.75, er: [1.5, 18], erLevel: 0.5, hf: 0.55, lf: 0.8, cents: 5, bloom: 0, bloomMs: [19, 29, 13] },
  { name: 'cathedral', lines: [47, 163], diff: [5.3, 8.9, 14.9, 23.3], diffGain: 0.7, er: [18, 120], erLevel: 0.8, hf: 0.3, lf: 0.7, cents: 9, bloom: 0, bloomMs: [37, 53, 29] },
  { name: 'cosmic', lines: [59, 211], diff: [3.1, 5.3, 8.3, 12.7], diffGain: 0.75, er: [25, 150], erLevel: 0.4, hf: 0.33, lf: 0.55, cents: 22, bloom: 1, bloomMs: [43, 67, 29] },
  // not a choice of the reverb: the space the shimmer effect is built on
  { name: 'shimmer', lines: [37, 131], diff: [4.3, 7.1, 11.3, 16.7], diffGain: 0.72, er: [12, 90], erLevel: 0.6, hf: 0.5, lf: 0.55, cents: 10, bloom: 0, bloomMs: [31, 47, 23] }
];
export const VOICING_NAMES = VOICINGS.slice(0, 5).map((v) => v.name);
export const SHIMMER_VOICING = 5;

/** Row `row` of the Walsh–Hadamard matrix, with the signs of the lines named in `flips` turned. */
function signVector(row, flips) {
  const out = new Float64Array(LINES);
  for (let i = 0; i < LINES; i++) {
    let odd = 0;
    for (let bits = row & i; bits; bits >>= 1) odd ^= bits & 1;
    out[i] = (odd ? -1 : 1) * ((flips >> i) & 1 ? -1 : 1);
  }
  return out;
}
// How the two inputs enter the sixteen lines and how the two outputs are picked from them. Left and right are at
// right angles (unrelated tails), and the sign flips keep any of them from being a direction the Hadamard matrix
// would send into a single line.
export const OUT_L = signVector(5, 0b1011001011100100);
export const OUT_R = signVector(10, 0b1011001011100100);
export const IN_L = signVector(3, 0b0110100100111010);
export const IN_R = signVector(12, 0b0110100100111010);

// Numbers in 0…1 that never line up (the golden ratio's multiples): they spread the lines' lengths, rates and phases.
// (Rounded as 32-bit floats wherever a length comes out of them, as the reference computes them: the same primes.)
const spread = (i, offset) => {
  const x = f32(f32(i * f32(0.618034)) + f32(offset));
  return x - Math.floor(x);
};
/** Where line i sits between the shortest (0) and the longest (1): even steps on a log scale, a little irregular. */
const LINE_AT = Float64Array.from({ length: LINES }, (_, i) => {
  const jitter = i === 0 || i === LINES - 1 ? 0 : f32(f32(0.36) * f32(spread(i, 0.37) - 0.5));
  return f32(f32(i + jitter) / (LINES - 1));
});
/** Each line drifts at 0.6…1.4 × modRate, each rotation of the matrix at 0.25…0.75 × modRate. */
const LFO_RATE = Float64Array.from({ length: LINES }, (_, i) => f32(f32(0.6) + f32(f32(0.8) * spread(i, 0.3))));
const ROT_RATE = Float64Array.from({ length: PAIRS }, (_, p) => f32(0.25 + f32(0.5 * spread(p, 0.55))));

/**
 * The reference's random numbers (xorshift64* seeded through SplitMix64), 0…1 with 24 bits: its early-reflection
 * pattern is drawn from them with a fixed seed, and the same numbers are drawn here, once, when the module loads.
 */
function referenceRng(seed) {
  const M = (1n << 64n) - 1n;
  let z = (BigInt(seed) + 0x9e3779b97f4a7c15n) & M;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
  z ^= z >> 31n;
  let s = z === 0n ? 0x2545f4914f6cdd1dn : z;
  return () => {
    s ^= s >> 12n;
    s = (s ^ (s << 25n)) & M;
    s ^= s >> 27n;
    return Number(((s * 0x2545f4914f6cdd1dn) & M) >> 40n) / 16777216;
  };
}

// The early reflections: ten taps a side, at times that rise a little faster than evenly (`unit`: 0…1 inside the
// voicing's span), levels that fall with time, some upside down; six from the same side, four from the other
// (ER_OTHER, below).
const ER = (() => {
  const draw = referenceRng(0x5eede417);
  const unit = new Float64Array(2 * ER_TAPS);
  const gain = new Float64Array(2 * ER_TAPS);
  for (let ch = 0; ch < 2; ch++) {
    let norm = 0;
    for (let k = 0; k < ER_TAPS; k++) {
      const u = f32(Math.pow(f32(f32(f32(k + f32(0.15)) + f32(f32(0.7) * draw())) / ER_TAPS), f32(1.3)));
      unit[ch * ER_TAPS + k] = u;
      const g = (draw() < f32(0.35) ? -1 : 1) * (1 - 0.65 * u);
      gain[ch * ER_TAPS + k] = g;
      norm += g * g;
    }
    for (let k = 0; k < ER_TAPS; k++) gain[ch * ER_TAPS + k] /= Math.sqrt(norm);
  }
  return { unit, gain };
})();

// Everything the sample loops read and write lives in two blocks — `st` (numbers) and `mem` (audio) — at the places
// named below. A loop that keeps track of two arrays instead of thirty runs a fifth faster (measured); the code that
// runs at control rate reaches the same numbers through named views (this.rc, this.g, …).
//
// Every length that can move is a ramp: st[r] now, st[RS + r] its step per sample. The first GLIDES of them follow a
// length that glides to its target, the rest are the matrix rotations (cos, sin) and the bloom amount.
const R_PRE = 0;
const R_ER = 1; // 2 × ER_TAPS
const R_DIFF = R_ER + 2 * ER_TAPS; // 2 × DIFF_STAGES
const R_BLOOM = R_DIFF + 2 * DIFF_STAGES; // 2 × BLOOM_STAGES
const R_LINE = R_BLOOM + 2 * BLOOM_STAGES; // LINES
const GLIDES = R_LINE + LINES;
const R_ROTC = GLIDES;
const R_ROTS = R_ROTC + PAIRS;
const R_BMIX = R_ROTS + PAIRS;
const RAMPS = R_BMIX + 1;
const RS = RAMPS;
// per line: its gain, the two shelves that make highs and lows fade faster (state Z, coefficient A, depth K / C), what
// it gives this sample (Y), and how it is tapped and fed (the sign vectors)
const G = RS + RAMPS;
const K_HF = G + LINES;
const A_HF = K_HF + LINES;
const A_LF = A_HF + LINES;
const C_LF = A_LF + LINES;
const Z_HF = C_LF + LINES;
const Z_LF = Z_HF + LINES;
const Y = Z_LF + LINES;
const TAP_L = Y + LINES;
const TAP_R = TAP_L + LINES;
const FEED_L = TAP_R + LINES;
const FEED_R = FEED_L + LINES;
const ER_GAIN = FEED_R + LINES; // 2 × ER_TAPS
const DIFF_G = ER_GAIN + 2 * ER_TAPS;
const BLOOM_G = DIFF_G + DIFF_STAGES;
const BLOOM_LP = BLOOM_G + BLOOM_STAGES; // 2
// …then four numbers per sample between two control steps: early reflections L R, diffused input L R
const FRONT = BLOOM_LP + 2;
// taps 2, 4, 7 and 9 of each side's early reflections come from the other side
const ER_OTHER = 0b1010010100;
const WRAP = 0x3fffffff; // where the write position starts again: a multiple of every buffer size

// Smoothed values: the first eight move at control rate, the rest per sample.
const S_DECAY = 0;
const S_DAMP = 1;
const S_LOWCUT = 2;
const S_DIFF = 3;
const S_RATE = 4;
const S_LFO = 5;
const S_ROT = 6;
const S_BLOOM = 7;
const S_IN = 8;
const S_OUT = 9;
const S_EARLY = 10;
const S_WIDTH = 11;
const S_DRY = 12;
const S_WET = 13;
const SMOOTHS = 14;

/** size 0…1 → every delay × 0.5…2 (1 in the middle). */
const sizeScale = (size) => f32(Math.pow(2, f32(2 * clamp(f32(size), 0, 1) - 1)));

/** The prime nearest to `centre` (at least `min`, inside the sieve) that is not among the first `count` of `used`. */
function nearestFreePrime(sieve, centre, min, used, count) {
  const top = sieve.length - 1;
  centre = Math.min(Math.max(centre, min), top);
  for (let offset = 0; offset <= top; offset++) {
    for (let side = 0; side < 2; side++) {
      const c = side ? centre - offset : centre + offset;
      if (c < min || c > top || !sieve[c]) continue;
      let free = true;
      for (let u = 0; u < count; u++) if (used[u] === c) free = false;
      if (free) return c;
    }
  }
  return centre;
}

/**
 * The reverberator itself — shared with the shimmer effect, which puts pitch shifters in its loop.
 *
 * Settings are plain fields (voicing … freeze, and setMix): set them at any time, they are picked up at the next
 * control step (every 32 samples at 48 kHz, counted in samples — so the host's block size is never heard) and
 * glide from there. Nothing here takes or returns a number per sample across a call, and all state lives in typed
 * arrays: processing allocates nothing.
 */
export class ReverbCore {
  constructor(sampleRate) {
    const fs = sampleRate;
    this.fs = fs;
    this.voicing = 1;
    this.size = 0.5;
    this.decay = 2.5; // s
    this.predelay = 10; // ms
    this.damping = 6000; // Hz
    this.lowCut = 80; // Hz
    this.diffusion = 0.85;
    this.modRate = 0.5; // Hz
    this.modDepth = 0.35;
    this.early = 0.5;
    this.width = 1;
    this.freeze = false;

    this.ctl = Math.max(8, Math.round(fs / 1500));
    this.ctlPhase = 0;
    const ctlRate = fs / this.ctl;

    // memory for the largest voicing at the largest size
    const ms = (v) => Math.ceil(v * 0.001 * fs);
    const pow2 = (n) => 1 << Math.ceil(Math.log2(n + 4));
    let lineMax = 0;
    let diffMax = 0;
    let bloomMax = 0;
    let erMax = 0;
    for (const v of VOICINGS) {
      lineMax = Math.max(lineMax, v.lines[1]);
      diffMax = Math.max(diffMax, v.diff[DIFF_STAGES - 1]);
      bloomMax = Math.max(bloomMax, ...v.bloomMs);
      erMax = Math.max(erMax, v.er[1]);
    }
    this.lineCap = ms(lineMax * MAX_SCALE + 1000 * MAX_EXCURSION_S + 2) + 16;
    this.lineSize = pow2(this.lineCap);
    this.inSize = pow2(ms(MAX_PREDELAY_MS + erMax * MAX_SCALE + 4) + 16);
    this.diffSize = pow2(ms(diffMax * MAX_SCALE * 1.07 + 2) + 16);
    this.bloomSize = pow2(ms(bloomMax * MAX_SCALE * 1.07 + 2) + 16);
    // mem: 16 lines, then the two pre-delay lines, the 8 diffuser all-passes, the 6 bloom all-passes — rings, each
    // a power of two long
    this.inBase = LINES * this.lineSize;
    this.diffBase = this.inBase + 2 * this.inSize;
    this.bloomBase = this.diffBase + 2 * DIFF_STAGES * this.diffSize;
    this.mem = new Float32Array(this.bloomBase + 2 * BLOOM_STAGES * this.bloomSize);
    this.w = 0; // one write position for every ring: each is written once per sample
    this.st = new Float64Array(FRONT + 4 * this.ctl);
    const view = (at, n) => this.st.subarray(at, at + n);

    this.sieve = new Uint8Array(this.lineCap + 1).fill(1);
    this.sieve[0] = this.sieve[1] = 0;
    for (let i = 2; i * i <= this.lineCap; i++) {
      if (this.sieve[i]) for (let j = i * i; j <= this.lineCap; j += i) this.sieve[j] = 0;
    }
    this.used = new Int32Array(LINES);
    this.appliedVoicing = -1;
    this.appliedSize = -1;

    // a length glides to its target at control rate and lands on it exactly (gc → gt); between two control steps it
    // moves in a straight line, per sample (rc += rs, towards rn)
    this.gc = new Float64Array(GLIDES);
    this.gt = new Float64Array(GLIDES);
    this.rc = view(0, RAMPS);
    this.rs = view(RS, RAMPS);
    this.rn = new Float64Array(RAMPS);
    this.glideCoeff = onepole(250, ctlRate);
    this.preCoeff = onepole(60, ctlRate);

    // smoothed values: one pole towards the target, and onto it exactly once it is within eps (so mix 0 is the dry
    // signal to the last bit, and a settled value costs nothing to keep)
    this.sCur = new Float64Array(SMOOTHS);
    this.sTgt = new Float64Array(SMOOTHS);
    this.sC = new Float64Array(SMOOTHS);
    this.sEps = new Float64Array(SMOOTHS);
    const smooth = (k, timeMs, rate, eps) => { this.sC[k] = onepole(timeMs, rate); this.sEps[k] = eps; };
    smooth(S_DECAY, 60, ctlRate, 1e-4);
    smooth(S_DAMP, 40, ctlRate, 0.01);
    smooth(S_LOWCUT, 40, ctlRate, 0.001);
    smooth(S_DIFF, 40, ctlRate, 1e-4);
    smooth(S_RATE, 200, ctlRate, 1e-4);
    smooth(S_LFO, 80, ctlRate, 1e-4);
    smooth(S_ROT, 80, ctlRate, 1e-4);
    smooth(S_BLOOM, 80, ctlRate, 1e-4);
    smooth(S_IN, 8, fs, 1e-5);
    smooth(S_OUT, 30, fs, 1e-6);
    smooth(S_EARLY, 15, fs, 1e-5);
    smooth(S_WIDTH, 15, fs, 1e-5);
    smooth(S_DRY, 12, fs, 1e-5);
    smooth(S_WET, 12, fs, 1e-5);
    this.sTgt[S_DRY] = 1;

    this.hp = new Float64Array(5); // the low cut: b0 b1 b2 a1 a2
    this.hpz = new Float64Array(4);
    this.hpFreq = -1;
    this.erGain = view(ER_GAIN, 2 * ER_TAPS);
    this.diffG = view(DIFF_G, DIFF_STAGES);
    this.bloomG = view(BLOOM_G, BLOOM_STAGES);
    this.bloomOn = false;
    this.moving = false;
    this.bloomLp = view(BLOOM_LP, 2);
    this.bloomA = 1 - Math.exp((-TAU * BLOOM_SPLIT_HZ) / fs);
    this.lfoPhase = new Float64Array(LINES);
    this.lfo = new Float64Array(LINES); // where each line's slow sine has it now, in samples from its resting length
    this.rotPhase = new Float64Array(PAIRS);
    this.g = view(G, LINES);
    this.kHf = view(K_HF, LINES).fill(1);
    this.aHf = view(A_HF, LINES);
    this.aLf = view(A_LF, LINES);
    this.cLf = view(C_LF, LINES);
    this.zHf = view(Z_HF, LINES);
    this.zLf = view(Z_LF, LINES);
    view(TAP_L, LINES).set(OUT_L);
    view(TAP_R, LINES).set(OUT_R);
    view(FEED_L, LINES).set(IN_L);
    view(FEED_R, LINES).set(IN_R);
    this.key = new Float64Array(5).fill(-1); // what the coefficients were last worked out for
    this.clear();
    this.snap();
  }

  /** Dry/wet, equal power (a reverb tail is unrelated to the dry signal: this keeps the loudness). Exact at both ends. */
  setMix(mix) {
    const m = clamp(mix, 0, 1);
    this.sTgt[S_DRY] = m >= 1 ? 0 : Math.cos(m * Math.PI * 0.5);
    this.sTgt[S_WET] = m <= 0 ? 0 : m >= 1 ? 1 : Math.sin(m * Math.PI * 0.5);
  }

  /** Forget everything that rings, and start the slow movements where they always start (so a render repeats). */
  clear() {
    this.mem.fill(0);
    this.hpz.fill(0);
    this.zHf.fill(0);
    this.zLf.fill(0);
    this.bloomLp.fill(0);
    for (let i = 0; i < LINES; i++) this.lfoPhase[i] = spread(i, 0.123);
    for (let p = 0; p < PAIRS; p++) this.rotPhase[p] = spread(p, 0.71);
    this.ctlPhase = 0;
    this.w = 0;
  }

  /** Put every length, level and coefficient on its target at once (nothing is ringing: there is nothing to click). */
  snap() {
    const { sCur, sTgt, gc, gt, rc, rs, rn } = this;
    this.layout();
    const v = VOICINGS[this.voicing];
    sTgt[S_DECAY] = this.decay;
    sTgt[S_DAMP] = this.damping;
    sTgt[S_LOWCUT] = this.lowCut;
    sTgt[S_DIFF] = this.diffusion;
    sTgt[S_RATE] = this.modRate;
    sTgt[S_LFO] = this.freeze ? 0 : this.modDepth;
    sTgt[S_ROT] = this.modDepth;
    sTgt[S_BLOOM] = v.bloom;
    sTgt[S_IN] = this.freeze ? 0 : 1;
    sTgt[S_EARLY] = this.early * v.erLevel;
    sTgt[S_WIDTH] = this.width;
    sCur.set(sTgt);
    gt[R_PRE] = this.predelayTarget();
    gc.set(gt);
    rs.fill(0);
    this.lfoOffsets();
    for (let k = 0; k < GLIDES; k++) rc[k] = rn[k] = k < R_LINE ? gc[k] : gc[k] + this.lfo[k - R_LINE];
    for (let p = 0; p < PAIRS; p++) {
      const angle = sCur[S_ROT] * ROT_MAX * Math.sin(TAU * this.rotPhase[p]);
      rc[R_ROTC + p] = rn[R_ROTC + p] = Math.cos(angle);
      rc[R_ROTS + p] = rn[R_ROTS + p] = Math.sin(angle);
    }
    rc[R_BMIX] = rn[R_BMIX] = sCur[S_BLOOM];
    this.bloomOn = sCur[S_BLOOM] > 0;
    this.moving = false;
    this.key.fill(-1);
    this.updateCoefficients();
    sCur[S_OUT] = sTgt[S_OUT];
  }

  predelayTarget() {
    return Math.round(clamp(this.predelay, 0, MAX_PREDELAY_MS) * 0.001 * this.fs);
  }

  /** Every delay length the voicing and the size ask for → the glide targets. */
  layout() {
    const v = VOICINGS[this.voicing];
    const { gt, used, sieve } = this;
    const perMs = f32(f32(f32(0.001) * this.fs) * sizeScale(this.size));
    const ratio = f32(v.lines[1] / v.lines[0]);
    for (let i = 0; i < LINES; i++) {
      const lineMs = f32(v.lines[0] * f32(Math.pow(ratio, LINE_AT[i])));
      used[i] = nearestFreePrime(sieve, Math.round(f32(lineMs * perMs)), 8, used, i);
      gt[R_LINE + i] = used[i];
    }
    for (let ch = 0; ch < 2; ch++) {
      const side = ch ? f32(1.07) : 1;
      for (let k = 0; k < DIFF_STAGES; k++) {
        used[k] = nearestFreePrime(sieve, Math.round(f32(f32(f32(v.diff[k]) * side) * perMs)), 2, used, k);
        gt[R_DIFF + ch * DIFF_STAGES + k] = used[k];
      }
      for (let k = 0; k < BLOOM_STAGES; k++) {
        const n = DIFF_STAGES + k;
        used[n] = nearestFreePrime(sieve, Math.round(f32(f32(f32(v.bloomMs[k]) * side) * perMs)), 2, used, n);
        gt[R_BLOOM + ch * BLOOM_STAGES + k] = used[n];
      }
      for (let k = 0; k < ER_TAPS; k++) {
        const erMs = f32(f32(v.er[0]) + f32(f32(v.er[1] - v.er[0]) * ER.unit[ch * ER_TAPS + k]));
        gt[R_ER + ch * ER_TAPS + k] = Math.max(1, Math.round(f32(erMs * perMs)));
      }
    }
    this.appliedVoicing = this.voicing;
    this.appliedSize = this.size;
    this.key.fill(-1);
  }

  /**
   * The drift of every line → this.lfo. The depth is a peak detune in cents (the slope of a moving delay is a pitch
   * change: excursion · 2π · rate / fs), so the character does not change with the rate.
   */
  lfoOffsets() {
    const { lfo, gc, lfoPhase, fs } = this;
    const depth = this.sCur[S_LFO];
    const detune = Math.exp(depth * VOICINGS[this.voicing].cents * (Math.LN2 / 1200)) - 1;
    for (let i = 0; i < LINES; i++) {
      if (depth <= 0) { lfo[i] = 0; continue; }
      const rate = Math.max(this.sCur[S_RATE] * LFO_RATE[i], 0.01);
      const excursion = Math.min((detune * fs) / (TAU * rate), MAX_EXCURSION_S * fs, 0.2 * gc[R_LINE + i]);
      lfo[i] = excursion * Math.sin(TAU * lfoPhase[i]);
    }
  }

  /** Every `ctl` samples: smooth the settings, move the lengths, turn the matrix, refresh the coefficients. */
  control() {
    if (this.voicing !== this.appliedVoicing || this.size !== this.appliedSize) this.layout();
    const { sCur, sTgt, sC, sEps, gc, gt, rc, rs, rn, lfoPhase, rotPhase, zHf, zLf, hpz, bloomLp } = this;
    const v = VOICINGS[this.voicing];
    const invN = 1 / this.ctl;
    const frozen = this.freeze;

    sTgt[S_DECAY] = this.decay;
    sTgt[S_DAMP] = this.damping;
    sTgt[S_LOWCUT] = this.lowCut;
    sTgt[S_DIFF] = this.diffusion;
    sTgt[S_RATE] = this.modRate;
    // frozen, the lines rest on whole samples (an interpolated read loses a little, a whole-sample read nothing)
    sTgt[S_LFO] = frozen ? 0 : this.modDepth;
    sTgt[S_ROT] = this.modDepth;
    sTgt[S_BLOOM] = v.bloom;
    for (let k = 0; k < S_IN; k++) {
      const d = sTgt[k] - sCur[k];
      sCur[k] = d <= sEps[k] && d >= -sEps[k] ? sTgt[k] : sCur[k] + sC[k] * d;
    }
    sTgt[S_IN] = frozen ? 0 : 1;
    sTgt[S_EARLY] = this.early * v.erLevel;
    sTgt[S_WIDTH] = this.width;

    // lengths: each ramp starts exactly where the last one aimed, so rounding never adds up
    gt[R_PRE] = this.predelayTarget();
    const dphi = (sCur[S_RATE] * this.ctl) / this.fs;
    for (let i = 0; i < LINES; i++) {
      const p = lfoPhase[i] + dphi * LFO_RATE[i];
      lfoPhase[i] = p - Math.floor(p);
    }
    for (let k = 0; k < GLIDES; k++) {
      const d = gt[k] - gc[k];
      gc[k] = d <= 1e-3 && d >= -1e-3 ? gt[k] : gc[k] + (k === R_PRE ? this.preCoeff : this.glideCoeff) * d;
    }
    this.lfoOffsets();
    for (let k = 0; k < GLIDES; k++) {
      const target = k < R_LINE ? gc[k] : gc[k] + this.lfo[k - R_LINE];
      rc[k] = rn[k];
      rn[k] = target;
      rs[k] = (target - rc[k]) * invN;
    }
    for (let p = 0; p < PAIRS; p++) {
      const ph = rotPhase[p] + dphi * ROT_RATE[p];
      rotPhase[p] = ph - Math.floor(ph);
      const angle = sCur[S_ROT] * ROT_MAX * Math.sin(TAU * rotPhase[p]);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      rc[R_ROTC + p] = rn[R_ROTC + p];
      rn[R_ROTC + p] = c;
      rs[R_ROTC + p] = (c - rc[R_ROTC + p]) * invN;
      rc[R_ROTS + p] = rn[R_ROTS + p];
      rn[R_ROTS + p] = s;
      rs[R_ROTS + p] = (s - rc[R_ROTS + p]) * invN;
    }

    // the bloom stage only runs while it is heard; it starts empty
    const bloom = sCur[S_BLOOM];
    if (bloom > 0 && !this.bloomOn) {
      this.mem.fill(0, this.bloomBase);
      bloomLp.fill(0);
    }
    this.bloomOn = bloom > 0;
    rc[R_BMIX] = rn[R_BMIX];
    rn[R_BMIX] = bloom;
    rs[R_BMIX] = (bloom - rc[R_BMIX]) * invN;

    this.updateCoefficients();

    // The pre-delay, tap and all-pass lengths rest on whole samples and only move while the size, the voicing or the
    // pre-delay changes: at rest they are read without interpolating (the same samples, at half the cost).
    let moving = false;
    for (let k = 0; k < R_LINE; k++) if (rs[k] !== 0) moving = true;
    this.moving = moving;

    // numbers that have faded to nothing: end the fade (very small numbers are slow on some CPUs)
    for (let i = 0; i < LINES; i++) {
      if (zHf[i] < 1e-20 && zHf[i] > -1e-20) zHf[i] = 0;
      if (zLf[i] < 1e-20 && zLf[i] > -1e-20) zLf[i] = 0;
    }
    for (let i = 0; i < 4; i++) if (hpz[i] < 1e-20 && hpz[i] > -1e-20) hpz[i] = 0;
    for (let i = 0; i < 2; i++) if (bloomLp[i] < 1e-20 && bloomLp[i] > -1e-20) bloomLp[i] = 0;
  }

  /** The gain and the shelves of every line, the diffuser gains, the early-reflection gains, the output level. */
  updateCoefficients() {
    const { sCur, key, gt, fs } = this;
    const frozen = this.freeze ? 1 : 0;
    if (key[0] === sCur[S_DECAY] && key[1] === sCur[S_DAMP] && key[2] === sCur[S_LOWCUT] && key[3] === sCur[S_DIFF] && key[4] === frozen) return;
    key[0] = sCur[S_DECAY];
    key[1] = sCur[S_DAMP];
    key[2] = sCur[S_LOWCUT];
    key[3] = sCur[S_DIFF];
    key[4] = frozen;
    const v = VOICINGS[this.voicing];
    const tMid = Math.max(key[0], 0.05);
    const damp = clamp(key[1], 100, 0.45 * fs);
    const lowcut = clamp(key[2], 10, 0.2 * fs);
    const diffusion = clamp(key[3], 0, 1);

    if (Math.abs(lowcut - this.hpFreq) > 1e-3) {
      // a 12 dB/octave Butterworth high-pass (RBJ)
      this.hpFreq = lowcut;
      const w0 = (TAU * lowcut) / fs;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const a0 = 1 + alpha;
      this.hp[0] = (1 + cos) / 2 / a0;
      this.hp[1] = -(1 + cos) / a0;
      this.hp[2] = this.hp[0];
      this.hp[3] = (-2 * cos) / a0;
      this.hp[4] = (1 - alpha) / a0;
    }

    // Each line loses 60 dB in `decay` seconds of travelling: a line of length τ has the gain 10^(−3·τ/T). Above
    // `damping` and below `lowCut` T is shorter, which is a shelf per line whose depth in dB grows with its length.
    const extraHf = (1 / v.hf - 1) / tMid; // the extra decay rate (1/T) outside the mid band
    const extraLf = (1 / v.lf - 1) / tMid;
    const fRef2 = damp * lowcut;
    const w = TAU / fs;
    for (let i = 0; i < LINES; i++) {
      if (frozen) {
        // nothing is lost: the loop only turns its state round, and holds its energy
        this.g[i] = 1;
        this.kHf[i] = 1;
        this.cLf[i] = 0;
        continue;
      }
      const tau = gt[R_LINE + i] / fs;
      const gMid = Math.exp((-LN1000 * tau) / tMid);
      const gHf = Math.exp(-LN1000 * tau * extraHf);
      const gLf = Math.exp(-LN1000 * tau * extraLf);
      // the shelves are half-way down (in dB) at damping / lowCut
      const fcH = Math.min(damp * Math.sqrt(gHf), 0.45 * fs);
      const fcL = Math.min(lowcut / Math.sqrt(gLf), 0.25 * fs);
      // what their skirts take away at the frequency between the two is given back to the line's gain, so the decay
      // there is exactly `decay` (but the lows are never let ring more than twice as long)
      const mHf = Math.sqrt((gHf * gHf * fRef2 + fcH * fcH) / (fRef2 + fcH * fcH));
      const mLf = Math.sqrt((fRef2 + gLf * gLf * fcL * fcL) / (fRef2 + fcL * fcL));
      this.g[i] = Math.min(gMid / (mHf * mLf), Math.sqrt(gMid), 0.99999);
      this.kHf[i] = gHf;
      this.aHf[i] = 1 - Math.exp(-w * fcH);
      this.aLf[i] = 1 - Math.exp(-w * fcL);
      this.cLf[i] = 1 - gLf;
    }

    // the diffusers must not ring longer than a third of the decay
    const cap = (LN1000 / fs) / (0.35 * tMid);
    for (let k = 0; k < DIFF_STAGES; k++) this.diffG[k] = Math.min(diffusion * v.diffGain, Math.exp(-cap * gt[R_DIFF + DIFF_STAGES + k]));
    for (let k = 0; k < BLOOM_STAGES; k++) this.bloomG[k] = Math.min(0.72, Math.exp(-cap * gt[R_BLOOM + BLOOM_STAGES + k]));
    // the early reflections follow the same decay as the tail
    for (let k = 0; k < 2 * ER_TAPS; k++) this.erGain[k] = ER.gain[k] * Math.exp((-LN1000 * gt[R_ER + k]) / fs / tMid);
    // The wet level. What is put into the network comes out through the taps once per trip, each time scaled by the
    // mean squared line gain m: a unit of energy in puts m / (1 − m) into each output. That is brought to
    // LATE_LEVEL · √(decay / 2) — and for decays much shorter than the lines the make-up gain is capped.
    let m = 0;
    for (let i = 0; i < LINES; i++) m += Math.exp((-2 * LN1000 * gt[R_LINE + i]) / fs / tMid);
    m = clamp(m / LINES, 0.02, 0.99999);
    this.sTgt[S_OUT] = Math.sqrt((LATE_LEVEL * Math.sqrt(0.5 * tMid) * (1 - m)) / (2 * m));
  }

  /**
   * The part before the network, for samples i0 … i1 of the block (at most one control step's worth): low cut,
   * pre-delay, early reflections, diffusion, bloom. Nothing here depends on what the network does, so it runs ahead
   * and leaves four numbers per sample at st[FRONT…]. A NaN or an infinity in the input is put out as silence — in
   * L and R themselves, so the dry path is clean too.
   */
  front(L, R, i0, i1) {
    const { st, mem, inSize, diffSize, bloomSize, inBase, diffBase, bloomBase, hp, hpz, sCur, moving, bloomOn, bloomA } = this;
    const inMask = inSize - 1;
    const diffMask = diffSize - 1;
    const bloomMask = bloomSize - 1;
    const inR = inBase + inSize;
    const b0 = hp[0];
    const b1 = hp[1];
    const b2 = hp[2];
    const a1 = hp[3];
    const a2 = hp[4];
    let zl1 = hpz[0];
    let zl2 = hpz[1];
    let zr1 = hpz[2];
    let zr2 = hpz[3];
    let inG = sCur[S_IN];
    const inT = this.sTgt[S_IN];
    const inC = this.sC[S_IN];
    const inE = this.sEps[S_IN];
    let w = this.w;
    for (let i = i0, fr = FRONT; i < i1; i++, fr += 4) {
      let xl = L[i];
      let xr = R[i];
      if (!(xl >= -F32_MAX && xl <= F32_MAX)) L[i] = xl = 0;
      if (!(xr >= -F32_MAX && xr <= F32_MAX)) R[i] = xr = 0;
      if (inG !== inT) {
        const e = inT - inG;
        inG = e <= inE && e >= -inE ? inT : inG + inC * e;
      }
      // in: muted when frozen, low cut, into the pre-delay line
      let v = (xl > LIMIT ? LIMIT : xl < -LIMIT ? -LIMIT : xl) * inG;
      let o = b0 * v + zl1;
      zl1 = b1 * v - a1 * o + zl2;
      zl2 = b2 * v - a2 * o;
      const at = w & inMask;
      mem[inBase + at] = o;
      v = (xr > LIMIT ? LIMIT : xr < -LIMIT ? -LIMIT : xr) * inG;
      o = b0 * v + zr1;
      zr1 = b1 * v - a1 * o + zr2;
      zr2 = b2 * v - a2 * o;
      mem[inR + at] = o;
      const wn = w + 1; // the sample just written is 1 behind this
      const pre = st[R_PRE] + 1;
      if (moving) st[R_PRE] += st[RS + R_PRE];

      // early reflections: taps on the pre-delay lines (a length that is gliding is read between two samples)
      let earlyL = 0;
      let earlyR = 0;
      for (let k = 0; k < ER_TAPS; k++) {
        const other = (ER_OTHER >> k) & 1;
        let r = R_ER + k;
        let len = pre + st[r];
        let q = len | 0;
        let from = other ? inR : inBase;
        let a = mem[from + ((wn - q) & inMask)];
        if (moving) {
          st[r] += st[RS + r];
          a += (mem[from + ((wn - q - 1) & inMask)] - a) * (len - q);
        }
        earlyL += st[ER_GAIN + k] * a;
        r += ER_TAPS;
        len = pre + st[r];
        q = len | 0;
        from = other ? inBase : inR;
        a = mem[from + ((wn - q) & inMask)];
        if (moving) {
          st[r] += st[RS + r];
          a += (mem[from + ((wn - q - 1) & inMask)] - a) * (len - q);
        }
        earlyR += st[ER_GAIN + ER_TAPS + k] * a;
      }
      st[fr] = earlyL;
      st[fr + 1] = earlyR;

      // diffusion: four all-passes a side smear the input before it reaches the network
      const q0 = pre | 0;
      for (let ch = 0; ch < 2; ch++) {
        const from = ch ? inR : inBase;
        let x = mem[from + ((wn - q0) & inMask)];
        if (moving) x += (mem[from + ((wn - q0 - 1) & inMask)] - x) * (pre - q0);
        for (let k = 0; k < DIFF_STAGES; k++) {
          const r = R_DIFF + ch * DIFF_STAGES + k;
          const len = st[r];
          const q = len | 0;
          const base = diffBase + (ch * DIFF_STAGES + k) * diffSize;
          let back = mem[base + ((w - q) & diffMask)];
          if (moving) {
            st[r] = len + st[RS + r];
            back += (mem[base + ((w - q - 1) & diffMask)] - back) * (len - q);
          }
          const gain = st[DIFF_G + k];
          let u = x + gain * back;
          const size = Math.abs(u);
          if (!(size > TINY && size < HUGE)) u = size >= HUGE ? (u > 0 ? HUGE : -HUGE) : 0;
          mem[base + (w & diffMask)] = u;
          x = back - gain * u;
        }
        st[fr + 2 + ch] = x;
      }
      // bloom (cosmic): the highs go through two long all-passes, the lows through a shorter one — the tail swells
      // in and opens from dark to bright
      const bloom = st[R_BMIX];
      st[R_BMIX] = bloom + st[RS + R_BMIX];
      if (bloomOn) {
        for (let ch = 0; ch < 2; ch++) {
          const x = st[fr + 2 + ch];
          const lo = st[BLOOM_LP + ch] + bloomA * (x - st[BLOOM_LP + ch]);
          st[BLOOM_LP + ch] = lo;
          const hi = x - lo;
          // stages 0 and 1 in a row for the highs, stage 2 for the lows; what each band gained is added to x
          let through = hi;
          let gained = 0;
          for (let k = 0; k < BLOOM_STAGES; k++) {
            if (k === 2) {
              gained = through - hi;
              through = lo;
            }
            const r = R_BLOOM + ch * BLOOM_STAGES + k;
            const len = st[r];
            const q = len | 0;
            const base = bloomBase + (ch * BLOOM_STAGES + k) * bloomSize;
            let back = mem[base + ((w - q) & bloomMask)];
            if (moving) {
              st[r] = len + st[RS + r];
              back += (mem[base + ((w - q - 1) & bloomMask)] - back) * (len - q);
            }
            const gain = st[BLOOM_G + k];
            let u = through + gain * back;
            const size = Math.abs(u);
            if (!(size > TINY && size < HUGE)) u = size >= HUGE ? (u > 0 ? HUGE : -HUGE) : 0;
            mem[base + (w & bloomMask)] = u;
            through = back - gain * u;
          }
          st[fr + 2 + ch] = x + bloom * (gained + (through - lo));
        }
      }
      w = (w + 1) & WRAP;
    }
    hpz[0] = zl1;
    hpz[1] = zl2;
    hpz[2] = zr1;
    hpz[3] = zr2;
    sCur[S_IN] = inG;
  }

  /**
   * n samples of L and R, in place: dry·in + wet·reverb. `loop` (the shimmer) is an effect inside the feedback path:
   * it is handed the two parts of the network's state that also feed the outputs (loop.io[0], [1]) and answers with
   * what to add back along them (loop.io[2], [3]) in loop.tick().
   */
  process(L, R, n, loop = null) {
    const { st, mem, lineSize, sCur, sTgt, sC, sEps } = this;
    const lineMask = lineSize - 1;
    const io = loop ? loop.io : null;
    let w = this.w;
    let i = 0;
    while (i < n) {
      if (this.ctlPhase === 0) this.control();
      const end = Math.min(n, i + this.ctl - this.ctlPhase);
      this.ctlPhase += end - i;
      if (this.ctlPhase >= this.ctl) this.ctlPhase = 0;
      // until the next control step nothing but the ramps and the per-sample smoothers moves
      this.front(L, R, i, end);
      let outG = sCur[S_OUT];
      let earlyG = sCur[S_EARLY];
      let width = sCur[S_WIDTH];
      let dry = sCur[S_DRY];
      let wet = sCur[S_WET];
      const outT = sTgt[S_OUT];
      const earlyT = sTgt[S_EARLY];
      const widthT = sTgt[S_WIDTH];
      const dryT = sTgt[S_DRY];
      const wetT = sTgt[S_WET];
      for (let fr = FRONT; i < end; i++, fr += 4) {
        if (outG !== outT) { const e = outT - outG; outG = e <= sEps[S_OUT] && e >= -sEps[S_OUT] ? outT : outG + sC[S_OUT] * e; }
        if (earlyG !== earlyT) { const e = earlyT - earlyG; earlyG = e <= sEps[S_EARLY] && e >= -sEps[S_EARLY] ? earlyT : earlyG + sC[S_EARLY] * e; }
        if (width !== widthT) { const e = widthT - width; width = e <= sEps[S_WIDTH] && e >= -sEps[S_WIDTH] ? widthT : width + sC[S_WIDTH] * e; }
        if (dry !== dryT) { const e = dryT - dry; dry = e <= sEps[S_DRY] && e >= -sEps[S_DRY] ? dryT : dry + sC[S_DRY] * e; }
        if (wet !== wetT) { const e = wetT - wet; wet = e <= sEps[S_WET] && e >= -sEps[S_WET] ? wetT : wet + sC[S_WET] * e; }

        // the network: read every line (a cubic through four points: it never adds energy, whatever the fraction),
        // take its loss, tap it. The taps sit after the loss, so the tail follows the decay from its first sample.
        let sumL = 0;
        let sumR = 0;
        for (let k = 0; k < LINES; k++) {
          const len = st[R_LINE + k];
          st[R_LINE + k] = len + st[RS + R_LINE + k];
          const q = len | 0;
          const f = len - q;
          const base = k * lineSize;
          const p = w - q;
          const y0 = mem[base + ((p + 1) & lineMask)];
          const y1 = mem[base + (p & lineMask)];
          const y2 = mem[base + ((p - 1) & lineMask)];
          const y3 = mem[base + ((p - 2) & lineMask)];
          const c1 = 0.5 * (y2 - y0);
          const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
          const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
          const x = ((c3 * f + c2) * f + c1) * f + y1;
          const zh = st[Z_HF + k] + st[A_HF + k] * (x - st[Z_HF + k]);
          st[Z_HF + k] = zh;
          const hs = zh + st[K_HF + k] * (x - zh);
          const zl = st[Z_LF + k] + st[A_LF + k] * (hs - st[Z_LF + k]);
          st[Z_LF + k] = zl;
          const out = st[G + k] * (hs - st[C_LF + k] * zl);
          st[Y + k] = out;
          sumL += st[TAP_L + k] * out;
          sumR += st[TAP_R + k] * out;
        }
        if (io !== null) {
          // OUT_L / 4 and OUT_R / 4 are two directions of unit length, at right angles, in the network's state
          io[0] = 0.25 * sumL;
          io[1] = 0.25 * sumR;
          loop.tick();
          const al = 0.25 * io[2];
          const ar = 0.25 * io[3];
          for (let k = 0; k < LINES; k++) st[Y + k] += al * st[TAP_L + k] + ar * st[TAP_R + k];
        }

        // feedback: the Hadamard matrix (the transform of 16 is the transform of 4 done twice: on neighbours, then on
        // every fourth), then the slowly turning planes, plus the input
        for (let j = Y; j < Y + LINES; j += 4) {
          const p = st[j] + st[j + 1];
          const q = st[j] - st[j + 1];
          const r = st[j + 2] + st[j + 3];
          const s = st[j + 2] - st[j + 3];
          st[j] = p + r;
          st[j + 1] = q + s;
          st[j + 2] = p - r;
          st[j + 3] = q - s;
        }
        for (let j = Y; j < Y + 4; j++) {
          const p = st[j] + st[j + 4];
          const q = st[j] - st[j + 4];
          const r = st[j + 8] + st[j + 12];
          const s = st[j + 8] - st[j + 12];
          st[j] = p + r;
          st[j + 4] = q + s;
          st[j + 8] = p - r;
          st[j + 12] = q - s;
        }
        const il = 0.25 * st[fr + 2];
        const ir = 0.25 * st[fr + 3];
        const at = w & lineMask;
        for (let k = 0; k < LINES; k += 2) {
          const r = R_ROTC + (k >> 1);
          const c = st[r];
          st[r] = c + st[RS + r];
          const s = st[r + PAIRS];
          st[r + PAIRS] = s + st[RS + r + PAIRS];
          const p0 = 0.25 * st[Y + k]; // (the 1/4 makes the Hadamard matrix lossless)
          const p1 = 0.25 * st[Y + k + 1];
          let u = c * p0 - s * p1 + st[FEED_L + k] * il + st[FEED_R + k] * ir;
          let size = Math.abs(u);
          if (!(size > TINY && size < HUGE)) u = size >= HUGE ? (u > 0 ? HUGE : -HUGE) : 0;
          mem[k * lineSize + at] = u;
          u = s * p0 + c * p1 + st[FEED_L + k + 1] * il + st[FEED_R + k + 1] * ir;
          size = Math.abs(u);
          if (!(size > TINY && size < HUGE)) u = size >= HUGE ? (u > 0 ? HUGE : -HUGE) : 0;
          mem[(k + 1) * lineSize + at] = u;
        }

        // out: late field + early reflections, width, dry/wet
        const wl = sumL * outG + st[fr] * earlyG;
        const wr = sumR * outG + st[fr + 1] * earlyG;
        const mid = 0.5 * (wl + wr);
        const side = 0.5 * (wl - wr) * width;
        L[i] = wet === 0 ? L[i] * dry : L[i] * dry + (mid + side) * wet;
        R[i] = wet === 0 ? R[i] * dry : R[i] * dry + (mid - side) * wet;
        w = (w + 1) & WRAP;
      }
      sCur[S_OUT] = outG;
      sCur[S_EARLY] = earlyG;
      sCur[S_WIDTH] = width;
      sCur[S_DRY] = dry;
      sCur[S_WET] = wet;
      this.w = w;
    }
  }

  /** An upper estimate, in seconds, of how long the wet signal stays audible after the input stops (60 = held). */
  get tail() {
    if (this.freeze) return 60;
    const v = VOICINGS[this.voicing];
    // the decay itself (the lows can ring a little longer), plus the time spent in the pre-delay and the first trip
    const pipeline = 0.001 * (this.predelay + sizeScale(this.size) * (v.lines[1] + v.er[1]));
    return Math.min(1.25 * this.decay + pipeline + 0.2, 60);
  }
}

export class AlgoVerb extends StudioFx {
  static type = 'algoverb';
  static label = 'Algorithmic Reverb';
  static description = 'A reverb that builds its space from a network of sixteen delay lines instead of a recording of a room: a smooth, dense, gently chorused tail with no metallic ringing, from a tight room to an endless wash, whose decay time is what the knob says (measured). Choose the space with the voicing, its length with the decay, its darkness with the damping. A little gives depth and glue; a long decay, a high mix or freeze turns notes into pads and drones.';
  static defs = [
    choice('voicing', 'Voicing', VOICING_NAMES, 'hall', { description: 'The character of the space. room: small, dense, quick to build — drums and close ambience. hall: a concert hall, smooth and neutral, the general choice. plate: bright and very dense, no distinct echoes — the classic on vocals and snares. cathedral: a very large stone space with a slow build and wide-spaced reflections. cosmic: enormous, heavily chorused, the tail swells in and opens from dark to bright — pads and drones, best with a decay of 6 s or more.' }),
    num('size', 'Size', 0, 1, 0.5, { automatable: true, description: 'Scales every delay in the space from half (0) to double (1) the voicing\'s natural size. Small is tight and coloured; large is open and takes longer to build. Moving it while sound rings bends the pitch of the tail, like a tape slowing down.' }),
    num('decay', 'Decay', 0.1, 60, 2.5, { unit: 's', curve: 'log', automatable: true, description: 'Reverberation time: the seconds the tail takes to fade by 60 dB in the mid range. 0.3–0.8 s is a room, 1.5–3 s a hall, 5–15 s a wash, 20–60 s a drone that barely fades.' }),
    num('predelay', 'Pre-delay', 0, 250, 10, { unit: 'ms', automatable: true, description: 'The gap between the dry sound and the start of the reverb. 0–10 ms glues the reverb to the source; 20–80 ms keeps the source clear and in front; above 100 ms it is heard as an echo.' }),
    num('damping', 'Damping', 200, 20000, 6000, { unit: 'Hz', curve: 'log', automatable: true, description: 'Frequencies above this fade two to three times faster than the rest of the tail (as air and soft walls make them). Lower is darker, warmer, further away; 20000 keeps the tail bright all the way down.' }),
    num('lowCut', 'Low cut', 20, 1000, 80, { unit: 'Hz', curve: 'log', automatable: true, description: 'A high-pass on what enters the reverb; frequencies below it also fade faster. Raise it (150–400 Hz) to keep bass and kick from turning the tail to mud; 20 lets everything through.' }),
    num('diffusion', 'Diffusion', 0, 1, 0.85, { automatable: true, description: 'How much the input is smeared before it reverberates. 1 turns every transient into a smooth wash; low values let single echoes and a grainy, fluttering onset through.' }),
    num('modRate', 'Mod rate', 0.05, 5, 0.5, { unit: 'Hz', curve: 'log', automatable: true, description: 'The speed of the slow pitch drift inside the tail. 0.1–1 Hz is a gentle chorus; above 2 Hz it becomes a fast wobble.' }),
    num('modDepth', 'Mod depth', 0, 1, 0.35, { automatable: true, description: 'How much the pitch drifts (chorusing) inside the tail. 0 is a static, exact tail (tuned percussion, piano); 0.3 is lush without sounding detuned; 1 is a thick ensemble detune — up to a quarter of a semitone in the cosmic voicing.' }),
    num('early', 'Early level', 0, 1, 0.5, { automatable: true, description: 'The level of the first distinct reflections off the walls. More gives the sense of a real room around the source; 0 leaves only the smooth late tail.' }),
    num('width', 'Width', 0, 1, 1, { automatable: true, description: 'The stereo width of the reverb. 1 is fully wide (the left and right tails are unrelated), 0 is mono.' }),
    flag('freeze', 'Freeze', false, { description: 'Holds the tail for ever: new input no longer enters the reverb, and what is ringing sustains at a constant level until freeze is switched off. Turns a chord into an endless pad.' }),
    num('mix', 'Mix', 0, 1, 0.3, { automatable: true, description: 'The balance between the dry signal (0) and the reverb (1), at equal power. 0.15–0.35 on an insert, 1 when the reverb sits on a send. All wet with a 2 s decay, the reverb is about 5 dB quieter than a sustained input.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    this.core = new ReverbCore(sampleRate);
    this.fresh = true; // nothing has sounded yet: settings take hold at once instead of gliding
    this.update();
  }

  update() {
    const { p, core } = this;
    core.voicing = VOICING_NAMES.indexOf(p.voicing);
    core.size = p.size;
    core.decay = p.decay;
    core.predelay = p.predelay;
    core.damping = p.damping;
    core.lowCut = p.lowCut;
    core.diffusion = p.diffusion;
    core.modRate = p.modRate;
    core.modDepth = p.modDepth;
    core.early = p.early;
    core.width = p.width;
    core.freeze = p.freeze;
    core.setMix(p.mix);
  }

  reset() {
    this.core.clear();
    this.fresh = true;
  }

  /** Seconds the reverb may still be heard after its input stops (an upper estimate; 60 while frozen). */
  get tail() { return this.core.tail; }

  process(L, R, n) {
    if (this.fresh) {
      this.core.snap();
      this.fresh = false;
    }
    this.core.process(L, R, n);
  }
}
