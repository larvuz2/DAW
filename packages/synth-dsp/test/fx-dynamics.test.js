// The dynamics effects ported from the GGS Composer rack (Rust, crates/fx-classic) — multiband compressor (OTT),
// transient shaper, trance gate — measured: what each one promises is checked on its output, and each is held
// against numbers the Rust reference itself gave for the same audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ott } from '../src/effects/ott.js';
import { TransientShaper } from '../src/effects/transient.js';
import { TranceGate } from '../src/effects/trancegate.js';
import { Biquad, DIVISIONS, divisionBeats, onepole } from '../src/effects/base.js';
import { fft } from '../src/index.js';
import { FS, db, peakOf, rmsOf, sine, mixOf, noise, run, basicChecks, cost } from './fx-helpers.js';

const lin = (dB) => 10 ** (dB / 20);
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} (expected ${want} ± ${tol})`);
const sameSamples = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const largestDifference = (a, b, from = 0, to = Math.min(a.length, b.length)) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const largestStep = (y, from = 0, to = y.length) => { let m = 0; for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1])); return m; };
const lowestOf = (y, from = 0, to = y.length) => { let m = Infinity; for (let i = from; i < to; i++) m = Math.min(m, y[i]); return m; };
const constant = (seconds, value = 1) => new Float32Array(Math.round(seconds * FS)).fill(value);
/** The largest step a sine of this amplitude takes from one sample to the next: anything much larger is a click. */
const ownStep = (hz, amp) => amp * 2 * Math.sin((Math.PI * hz) / FS);

/** Amplitude of the partial at exactly `hz` between two samples (the stretch must hold a whole number of its cycles). */
function toneAmp(x, hz, from, to) {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const p = (2 * Math.PI * hz * i) / FS;
    re += x[i] * Math.cos(p);
    im += x[i] * Math.sin(p);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

/** The lowest and the highest gain (dB) between 20 Hz and 20 kHz of an effect that is linear at these settings: its impulse response, transformed. */
function levelRange(Fx, params, fs = FS) {
  const n = 65536;
  const x = new Float32Array(n);
  x[0] = 1;
  const re = Float64Array.from(run(Fx, params, [x, x], { fs }).channels[0]);
  const im = new Float64Array(n);
  fft(re, im);
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = Math.ceil((20 * n) / fs); (k * fs) / n <= 20000 && k < n / 2; k++) {
    const d = db(Math.hypot(re[k], im[k]));
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}

/** Run an effect in blocks as the worklet does, with new settings arriving at one block boundary. Returns the left channel. */
function stepped(Fx, before, after, x, at, { block = 128, bpm = 120 } = {}) {
  assert.equal(at % block, 0);
  const fx = new Fx(FS);
  fx.set(before);
  const L = Float32Array.from(x);
  const R = Float32Array.from(x);
  for (let p = 0; p < L.length; p += block) {
    if (p === at) fx.set(after);
    fx.clock((p / FS) * (bpm / 60), bpm, true);
    const n = Math.min(block, L.length - p);
    fx.process(L.subarray(p, p + n), R.subarray(p, p + n), n);
  }
  return L;
}

/** Two bars of a small mix at 120 bpm: a kick on every beat, noise hats between, a chord that swells, half a second of near silence, hiss. */
function programme() {
  const n = FS * 4;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const hiss = noise(4, 1, 1);
  const hiss2 = noise(4, 1, 18);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const kt = ((t * 2) % 1) / 2; // seconds since the last kick
    const kick = Math.exp(-kt / 0.09) * Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-kt / 0.02)) * kt);
    const hat = Math.exp(-((t * 2 + 0.5) % 1) / 2 / 0.03);
    const swell = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 4);
    const pad = 0.12 * swell * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t + 1) + Math.sin(2 * Math.PI * 329.6 * t + 2));
    const on = t > 2.5 && t < 3 ? 0 : 1;
    L[i] = on * (0.7 * kick + 0.2 * hat * hiss[i] + pad) + 0.002 * hiss2[i];
    R[i] = on * (0.6 * kick + 0.25 * hat * hiss2[i] + 0.8 * pad) + 0.002 * hiss[i];
  }
  return [L, R];
}

// What the Rust reference (ggs-fx-classic: `multiband`, `transient`, `gate` in pattern mode) puts out for programme()
// at these settings: the level (dB RMS) of each half second of both channels, and six samples of the left one.
// Made by building the crate and running it over the same audio, in blocks of 512 with the transport playing.
// The ports land within 0.001 dB of every window; sample by sample they differ by at most 3e-4 — the reference
// computes in single precision (against a double-precision all-pass its crossover is right to −74 dB, the port's
// to −150 dB).
const REFERENCE_SAMPLES = [1234, 30000, 61234, 99999, 130001, 165432];
const REFERENCE = [
  [Ott, { params: {}, clock: {}, left: [-18.311, -18.468, -17.651, -17.205, -17.31, -46.322, -18.23, -19.25], right: [-19.473, -19.721, -19.028, -18.631, -18.75, -47.923, -19.456, -20.363], samples: [-0.39686, -0.13291, -0.08831, -0.12185, 0.00074, 0.00504] }],
  [Ott, { params: { depth: 1 }, clock: {}, left: [-18.989, -20.273, -20.158, -20.374, -20.535, -46.361, -19.763, -21.571], right: [-20.015, -21.38, -21.302, -21.489, -21.689, -47.518, -20.798, -22.345], samples: [-0.29744, -0.0973, -0.06293, -0.07603, 0.00136, 0.00523] }],
  [Ott, { params: { depth: 0.8, time: 4, lowMid: 300, midHigh: 5000, lowGain: -3, midGain: 2, highGain: 4, upward: 0.6, downward: 0.4, output: -3, mix: 0.7 }, clock: {}, left: [-17.811, -17.937, -16.537, -15.459, -15.58, -39.886, -18.165, -18.839], right: [-18.824, -19.028, -17.857, -16.893, -17.033, -41.71, -19.21, -19.753], samples: [-0.40619, -0.06929, 0.28339, 0.1745, 0.00317, -0.02594] }],
  [Ott, { params: { depth: 1, time: 0.1, upward: 0.3 }, clock: {}, left: [-22.136, -20.747, -20.448, -20.23, -20.312, -42.079, -20.992, -22.213], right: [-23.069, -22.02, -21.761, -21.632, -21.705, -43.39, -22.249, -23.212], samples: [-0.15838, -0.147, -0.04447, -0.07464, 0.00149, 0.01693] }],
  [TransientShaper, { params: { attack: 1 }, clock: {}, left: [-9.27, -10.553, -11.521, -11.571, -11.634, -55.421, -9.674, -10.742], right: [-10.58, -11.876, -12.91, -13.044, -13.127, -56.273, -11.012, -12.038], samples: [-0.65196, 0.06063, -0.19257, 0.17334, 0.00005, 0.0419] }],
  [TransientShaper, { params: { sustain: 1 }, clock: {}, left: [-14.37, -13.246, -12.72, -10.949, -10.869, -37.078, -13.313, -14.417], right: [-15.543, -14.612, -14.238, -12.555, -12.511, -37.048, -14.619, -15.57], samples: [-0.39503, 0.09884, -0.19132, 0.2264, 0.00049, 0.17623] }],
  [TransientShaper, { params: { attack: -0.6, sustain: -0.4, output: 3 }, clock: {}, left: [-16.813, -15.498, -13.618, -12.539, -12.547, -56.107, -15.709, -15.95], right: [-18.076, -16.813, -15.085, -14.091, -14.106, -57.394, -17.025, -17.222], samples: [-0.37479, 0.07044, -0.18931, 0.22004, 0.00003, 0.03332] }],
  [TranceGate, { params: {}, clock: {}, left: [-16.755, -16.423, -15.371, -14.4, -14.331, -59.25, -16.382, -16.752], right: [-18.008, -17.721, -16.8, -15.918, -15.858, -59.42, -17.684, -18.003], samples: [-0.37626, 0.01918, -0.16044, 0.15394, 0.00005, 0.04094] }],
  // (the reference's "range" is in dB: −12.04 dB closed is a depth of 0.75)
  [TranceGate, { params: { rate: '1/8t', duty: 0.7, attack: 30, release: 300, depth: 0.75 }, clock: { bpm: 133, beat: 7.3 }, left: [-16.756, -16.098, -14.955, -13.973, -13.819, -55.795, -16.285, -16.505], right: [-18.006, -17.417, -16.409, -15.516, -15.375, -56.608, -17.593, -17.763], samples: [-0.35062, 0.0568, -0.16044, 0.17306, 0.00005, 0.04158] }],
  [TranceGate, { params: { rate: '1/16', duty: 0.25, attack: 0.1, release: 5 }, clock: { bpm: 174, beat: 1000.5 }, left: [-19.632, -20.969, -21.077, -20.588, -20.179, -64.242, -20.945, -23.088], right: [-20.893, -22.315, -22.619, -22.291, -21.638, -64.282, -22.29, -24.415], samples: [-0.0285, 0.06063, 0, 0.17334, 0, 0] }]
];

test('ott, transient, trancegate: the checks all studio effects share, at a cost a mix can afford', () => {
  for (const Fx of [Ott, TransientShaper, TranceGate]) {
    basicChecks(Fx);
    assert.equal(new Fx(FS).latency, 0, `${Fx.type}: no look-ahead, no latency`);
  }
  assert.deepEqual([Ott.type, TransientShaper.type, TranceGate.type], ['ott', 'transient', 'trancegate']);
  // milliseconds of CPU per second of stereo audio, with everything at work
  for (const [Fx, params] of [[Ott, { depth: 1 }], [TransientShaper, { attack: 1, sustain: -1 }], [TranceGate, {}]]) {
    const ms = cost(Fx, params);
    assert.ok(ms < 30, `${Fx.type}: ${ms.toFixed(1)} ms of CPU for a second of audio`);
  }
});

test('ported effects: the same audio as the Rust reference', () => {
  const input = programme();
  for (const [Fx, ref] of REFERENCE) {
    const [L, R] = run(Fx, ref.params, input, ref.clock).channels;
    const what = `${Fx.type} ${JSON.stringify(ref.params)}`;
    for (let w = 0; w < 8; w++) {
      near(db(rmsOf(L, w * 24000, (w + 1) * 24000)), ref.left[w], 0.02, `${what}: left, half second ${w}`);
      near(db(rmsOf(R, w * 24000, (w + 1) * 24000)), ref.right[w], 0.02, `${what}: right, half second ${w}`);
    }
    REFERENCE_SAMPLES.forEach((at, k) => near(L[at], ref.samples[k], 1e-3, `${what}: sample ${at}`));
  }
});

// ---------------------------------------------------------------------------------------------------------- OTT

test('ott: with no compression acting, the three bands add up to the input — every frequency at its level, its phase turned by two all-passes', () => {
  // depth 0 is a gain of exactly 1 in every band: what is left is the crossover. Flat from 20 Hz to 20 kHz…
  for (const [params, fs] of [[{}, FS], [{ lowMid: 800, midHigh: 1200 }, FS], [{ lowMid: 1000, midHigh: 1000 }, FS], [{ lowMid: 40, midHigh: 12000 }, FS], [{}, 44100], [{}, 96000], [{ mix: 0.5 }, FS]]) {
    const [lo, hi] = levelRange(Ott, { depth: 0, ...params }, fs);
    assert.ok(lo > -0.01 && hi < 0.01, `depth 0, ${JSON.stringify(params)} at ${fs} Hz: ${lo.toFixed(6)} … ${hi.toFixed(6)} dB`);
  }
  // …but not the input itself: a 24 dB/oct Linkwitz-Riley split sums to a second-order all-pass (Q = 0.707) at its
  // frequency, and there are two splits. Against exactly that, nothing is left.
  const x = mixOf(sine(60, 0.3, 1), sine(700, 0.3, 1), sine(5000, 0.2, 1), noise(1, 0.2, 5));
  for (const amp of [1, 0.001]) {
    const quiet = Float32Array.from(x, (v) => v * amp); // the same at any level: nothing here depends on it
    const y = run(Ott, { depth: 0 }, [quiet, quiet]).channels[0];
    const first = new Biquad().design('allpass', FS, 120);
    const second = new Biquad().design('allpass', FS, 2500);
    const expected = Float32Array.from(quiet, (v) => second.tick(first.tick(v)));
    assert.ok(largestDifference(y, expected) < 2e-7 * amp, `depth 0 against two all-passes, level ${amp}: ${largestDifference(y, expected)}`);
    assert.ok(largestDifference(y, quiet) > 0.5 * amp, 'the phase is turned: sample by sample it is not the input');
  }
  // A mix blends with the dry signal through the same crossover, so half a mix of "nothing" is still nothing
  // (the dry signal itself would cancel at the crossover frequencies, where the bands arrive half a turn late)
  const blended = run(Ott, { depth: 0, mix: 0.5 }, [x, x]).channels[0];
  assert.ok(largestDifference(blended, run(Ott, { depth: 0 }, [x, x]).channels[0]) < 1e-6);
  // Only a mix of exactly 0 is the input itself — bit for bit, whatever the other settings
  const [bypassL, bypassR] = run(Ott, { depth: 1, mix: 0, lowGain: 12, output: -6 }, programme()).channels;
  assert.ok(sameSamples(bypassL, programme()[0]) && sameSamples(bypassR, programme()[1]), 'mix 0 is the input');
  // With different gains per band (here the make-up gains alone: +8, +5, +8 dB) the bands still meet in phase: the
  // response goes from one gain to the next without a dip at either crossover
  const [lo, hi] = levelRange(Ott, { depth: 1, upward: 0, downward: 0 });
  assert.ok(lo > 4.99 && hi < 8.01, `make-up only: ${lo.toFixed(3)} … ${hi.toFixed(3)} dB`);
});

// What the reference documents, written as numbers: gain (dB) of a band whose level has settled at `level` dB, at
// full depth, before make-up. Knee of 6 dB around both thresholds.
const knee = (x) => (x <= -3 ? 0 : x < 3 ? (x + 3) ** 2 / 12 : x);
const curve = (level) => Math.min(0.76 * knee(-40 - level), 30) - 0.95 * knee(level + 27);

test('ott: the static curve — 20:1 above −27 dB, 4.2:1 below −40 dB, at most 30 dB of lift, 8 / 5 / 8 dB of make-up', () => {
  // Two signals whose power does not ripple, so a band's follower reads exactly their level: a constant (all of it
  // in the low band) and the alternation +a −a +a… at half the sample rate (all of it in the high band).
  // [level in, gain] — each gain can be worked out by hand: −60 dB is 20 dB under the threshold, lifted by
  // 0.76 × 20 = 15.2 dB, plus 8 dB of make-up.
  const table = [[-80, 38], [-60, 23.2], [-50, 15.6], [-40, 8.57], [-33.5, 8], [-27, 7.2875], [-20, 1.35], [-10, -8.15], [0, -17.65]];
  const out = { low: {}, high: {} };
  for (const [band, shape] of [['low', () => 1], ['high', (i) => (i & 1 ? -1 : 1)]]) {
    for (const [level, gain] of table) {
      const x = Float32Array.from({ length: FS * 3 }, (_, i) => shape(i) * lin(level));
      const { channels: [y], meter } = run(Ott, { depth: 1 }, [x, x]);
      const got = db(Math.abs(y[y.length - 1] / x[x.length - 1]));
      near(got, gain, 0.01, `${band} band at ${level} dB`);
      near(got, curve(level) + 8, 0.01, `${band} band at ${level} dB, by the formula`);
      near(meter, Math.min(0, -0.95 * knee(level + 27)), 0.01, `meter at ${level} dB: the downward reduction`);
      out[band][level] = level + got;
    }
    // the ratios, read off the output: 10 dB more in is 0.5 dB more out above the upper threshold (20:1) and
    // 2.4 dB more out below the lower one (4.2:1)
    near(out[band][-10] - out[band][-20], 0.5, 0.01, `${band}: 20:1`);
    near(out[band][-50] - out[band][-60], 2.4, 0.01, `${band}: 4.2:1`);
    assert.ok(out[band][0] < 0 - 17 && out[band][-60] > -60 + 23, 'the loud comes down, the quiet comes up');
  }
  // the same curve at other sample rates
  for (const fs of [44100, 96000]) {
    for (const [level, gain] of [[-60, 23.2], [0, -17.65]]) {
      const x = new Float32Array(fs * 3).fill(lin(level));
      const y = run(Ott, { depth: 1 }, [x, x], { fs }).channels[0];
      near(db(y[y.length - 1] / lin(level)), gain, 0.01, `${level} dB at ${fs} Hz`);
    }
  }
});

/** Where a follower that rises with `up` and falls with `down` settles on the power of a sine of peak 1: above its mean (0.5), since it rises faster than it falls. */
function settledPower(up, down) {
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 40; it++) {
    const e = (lo + hi) / 2;
    let above = 0;
    let below = 0;
    for (let k = 0; k < 2048; k++) {
      const p = Math.sin((Math.PI * (k + 0.5)) / 2048) ** 2;
      if (p > e) above += p - e;
      else below += e - p;
    }
    if (up * above > down * below) lo = e;
    else hi = e;
  }
  return (lo + hi) / 2;
}

/**
 * The gain (dB) the documented design gives a steady sine: each band holds the share of it that its crossover
 * slopes let through (24 dB/oct, the frequency warped as the bilinear transform warps it), its follower settles on
 * that, the curve and the make-up give the band's gain — and the bands add in phase.
 */
function predictedGain(hz, level, { lowMid = 120, midHigh = 2500, time = 1, depth = 1 } = {}) {
  const warped = (f) => Math.tan((Math.PI * f) / FS);
  const r1 = (warped(hz) / warped(lowMid)) ** 4;
  const r2 = (warped(hz) / warped(midHigh)) ** 4;
  const share = [1 / (1 + r1), r1 / (1 + r1) / (1 + r2), ((r1 / (1 + r1)) * r2) / (1 + r2)];
  const attack = [48, 22, 13.5];
  const release = [282, 282, 132];
  const makeup = [8, 5, 8];
  let sum = 0;
  for (let b = 0; b < 3; b++) {
    const power = (lin(level) * share[b]) ** 2 * settledPower(onepole(attack[b] * time, FS), onepole(release[b] * time, FS));
    sum += share[b] * lin(depth * (curve(10 * Math.log10(power + 1e-12)) + makeup[b]));
  }
  return db(sum);
}

/** Gain (dB) of a steady sine through the effect, once everything has settled. */
function sineGain(params, hz, level, seconds = 3) {
  const x = sine(hz, lin(level), seconds);
  const y = run(Ott, params, [x, x]).channels[0];
  return db(toneAmp(y, hz, x.length - FS, x.length) / lin(level));
}

test('ott: a sine in any band gets the gain the curve gives the level its follower settles at', () => {
  // in each band, near both crossovers, from far under the lower threshold to far over the upper one
  let worst = 0;
  for (const hz of [61, 131, 1009, 2503, 7919]) {
    for (const level of [-60, -45, -33.5, -20, 0]) {
      const got = sineGain({ depth: 1 }, hz, level);
      const want = predictedGain(hz, level);
      worst = Math.max(worst, Math.abs(got - want));
      near(got, want, 0.25, `${hz} Hz at ${level} dB`);
    }
  }
  assert.ok(worst > 0, 'measured');
  // the numbers the reference's own test asks for, at 1 kHz
  const lift = sineGain({ depth: 1 }, 1000, -60);
  const cut = sineGain({ depth: 1 }, 1000, 0);
  assert.ok(sineGain({ depth: 1 }, 1000, -40) > 4 && lift > 15 && cut < -10, `1 kHz: −60 dB by ${lift.toFixed(1)} dB, 0 dB by ${cut.toFixed(1)} dB`);
  assert.ok(lift - cut > 35, '60 dB of range in, far less out');
  // depth scales the change in dB: half the depth, half the change
  near(sineGain({ depth: 0.5 }, 1000, -60), lift / 2, 0.5, 'half depth');
  near(sineGain({ depth: 0.5 }, 1000, -60), predictedGain(1000, -60, { depth: 0.5 }), 0.25, 'half depth, predicted');
  // upward and downward act alone: with one off, what is left for a signal on its side is the make-up (5 dB in the mid band)
  near(sineGain({ depth: 1, upward: 0 }, 1000, -60), 5, 0.3, 'upward off, quiet signal');
  near(sineGain({ depth: 1, downward: 0 }, 1000, 0), 5, 0.3, 'downward off, loud signal');
  near(sineGain({ depth: 1, upward: 0.5 }, 1000, -60), (lift + 5) / 2, 0.5, 'upward at half');
  // band gains and the output are plain gains
  near(sineGain({ depth: 0, lowGain: -6, midGain: -6, highGain: -6, output: 2 }, 1000, -20), -4, 0.01, 'trims');
  near(sineGain({ depth: 0, lowGain: 6 }, 40, -20) - sineGain({ depth: 0, midGain: 6 }, 40, -20), 6, 0.2, 'the low gain is the low band\'s');
  near(sineGain({ depth: 0, highGain: -9 }, 9000, -20), -9, 0.2, 'the high gain is the high band\'s');
});

test('ott: a band reacts to the energy in its own band, not to its neighbours', () => {
  // a tone in the middle of each band, far from both splits (what leaks next door is 48 dB down or more), all three
  // at −33.5 dB: between the thresholds, where nothing acts and each band is at its make-up gain
  const params = { depth: 1, lowMid: 100, midHigh: 8000 };
  const tones = [25, 900, 20000];
  const gains = (levels) => {
    const x = mixOf(...tones.map((hz, b) => sine(hz, lin(levels[b]), 4, b)));
    const y = run(Ott, params, [x, x]).channels[0];
    return tones.map((hz, b) => db(toneAmp(y, hz, 3 * FS, 4 * FS) / lin(levels[b])));
  };
  const idle = gains([-33.5, -33.5, -33.5]);
  [8, 5, 8].forEach((makeup, b) => near(idle[b], makeup, 0.1, `band ${b} at rest`));
  for (let b = 0; b < 3; b++) {
    const levels = [-33.5, -33.5, -33.5];
    levels[b] = -6;
    const loud = gains(levels);
    levels[b] = -60;
    const quiet = gains(levels);
    assert.ok(loud[b] < idle[b] - 15, `band ${b} loud: its gain falls (${loud[b].toFixed(2)} dB)`);
    assert.ok(quiet[b] > idle[b] + 12, `band ${b} quiet: its gain rises (${quiet[b].toFixed(2)} dB)`);
    for (let other = 0; other < 3; other++) {
      if (other === b) continue;
      near(loud[other], idle[other], 0.15, `band ${other} while band ${b} is loud`);
      near(quiet[other], idle[other], 0.15, `band ${other} while band ${b} is quiet`);
    }
  }
});

test('ott: one follower for both channels — the gain is the same left and right', () => {
  // loud on the left, the same tone 30 dB down on the right: the right is turned down with the left, not lifted
  const L = sine(1000, 1, 3);
  const R = sine(1000, lin(-30), 3);
  const [yl, yr] = run(Ott, { depth: 1 }, [L, R]).channels;
  const gl = db(toneAmp(yl, 1000, 2 * FS, 3 * FS));
  const gr = db(toneAmp(yr, 1000, 2 * FS, 3 * FS) / lin(-30));
  near(gr, gl, 0.01, 'right gain against left gain');
  assert.ok(gl < -10 && sineGain({ depth: 1 }, 1000, -30) > 4, 'alone, the quiet channel would have been raised');
});

test('ott: the bands follow with their own attack and release times, and time scales them', () => {
  const rest = lin(-33.5);
  /** The gain (dB), sample by sample, of a signal of constant power that steps from rest to full scale at 1 s and back at 4 s. */
  const track = (shape, time) => {
    const x = Float32Array.from({ length: FS * 6 }, (_, i) => shape(i) * (i >= FS && i < 4 * FS ? 1 : rest));
    const y = run(Ott, { depth: 1, time }, [x, x]).channels[0];
    return (i) => db(Math.abs(y[i] / x[i]));
  };
  // [band, a signal that is constant in it, attack ms, release ms, the settings of time to try]. With the fastest
  // times the step itself (the crossover takes a few milliseconds to pass it) would be part of what is measured.
  for (const [band, shape, attack, release, times] of [['low', () => 1, 48, 282, [1, 4]], ['high', (i) => (i & 1 ? -1 : 1), 13.5, 132, [4, 8]]]) {
    for (const time of times) {
      const gain = track(shape, time);
      const settled = gain(4 * FS - 1);
      near(settled, -17.65, 0.02, `${band}: settled`);
      // Attack: the follower's power closes in on its end as exp(−t/τ). It is 6 dB and then 1 dB short of it
      // (the gain 0.95 × that above where it settles) at two moments that are τ·ln(0.749/0.206) apart.
      let six = -1;
      let one = -1;
      for (let i = FS + 480; i < 4 * FS && one < 0; i++) {
        if (six < 0 && gain(i) <= settled + 0.95 * 6) six = i;
        if (gain(i) <= settled + 0.95 * 1) one = i;
      }
      const tau = (((one - six) / FS) * 1000) / Math.log((1 - 10 ** -0.6) / (1 - 10 ** -0.1));
      near(tau, attack * time, attack * time * 0.02, `${band} attack at time ${time} (ms)`);
      // Release: the power falls by a factor e per τ — 4.34 dB — so over one τ the gain comes back 0.95 × 4.34 dB
      const from = 4 * FS + Math.round(0.05 * FS);
      const tauSamples = Math.round(release * (time > 2 ? 1 : time) * 0.001 * FS);
      const back = track(shape, time > 2 ? 1 : time);
      near(back(from + tauSamples) - back(from), (0.95 * 10) / Math.LN10, 0.05, `${band} release (dB regained in one release time)`);
    }
  }
  // the mid band's release, on a 1 kHz tone that drops to rest (the splits moved out of its way, so that no
  // neighbour's leak is in the measurement): while the follower is far above the new level it only falls
  for (const time of [0.5, 1]) {
    const x = Float32Array.from({ length: FS * 6 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / FS) * (i < 3 * FS ? 1 : rest));
    const y = run(Ott, { depth: 1, time, lowMid: 40, midHigh: 12000 }, [x, x]).channels[0];
    const gain = (i) => db(toneAmp(y, 1000, i - 240, i + 240) / rest);
    const from = 3 * FS + Math.round(0.05 * FS);
    near(gain(from + Math.round(282 * time * 0.001 * FS)) - gain(from), (0.95 * 10) / Math.LN10, 0.05, `mid release at time ${time}`);
  }
  // …and faster is faster: 20 ms after a loud tone starts, the gain is further down the shorter the time
  const early = (time) => {
    const x = Float32Array.from({ length: FS * 2 }, (_, i) => (i < FS ? rest : 1) * Math.sin((2 * Math.PI * 1000 * i) / FS));
    const y = run(Ott, { depth: 1, time }, [x, x]).channels[0];
    return db(rmsOf(y, FS + 912, FS + 1008) / Math.SQRT1_2);
  };
  assert.ok(early(0.1) < early(1) - 1 && early(1) < early(10) - 3, `20 ms in: ${early(0.1).toFixed(1)} / ${early(1).toFixed(1)} / ${early(10).toFixed(1)} dB at time 0.1 / 1 / 10`);
});

test('ott: full-scale noise at any setting stays bounded, and the default leaves the loudness about where it was', () => {
  const L = noise(3, 1, 9);
  const R = noise(3, 1, 11);
  // At full depth the level ends up far below full scale; the loudest moment is the first, when sound follows silence
  // and the followers have not yet risen (the punch OTT is known for)
  for (const time of [0.1, 1, 10]) {
    const [yl, yr] = run(Ott, { depth: 1, time }, [L, R]).channels;
    const peak = Math.max(peakOf(yl), peakOf(yr));
    assert.ok(peak < 4, `depth 1, time ${time}: peak ${peak.toFixed(2)} (${db(peak).toFixed(1)} dB)`);
    assert.ok(Math.max(peakOf(yl, FS), peakOf(yr, FS)) < 1, `…and under full scale once settled: ${Math.max(peakOf(yl, FS), peakOf(yr, FS)).toFixed(2)}`);
    assert.ok(db(rmsOf(yl, FS)) < db(rmsOf(L)) - 10, 'loud noise comes out quieter');
  }
  // every number at its maximum (band gains and output at +24 dB): the safety ceiling of every studio effect, +24 dB
  const max = run(Ott, Object.fromEntries(Ott.defs.map((d) => [d.key, d.max])), [L, R]).channels;
  assert.ok(max[0].every(Number.isFinite) && max[1].every(Number.isFinite) && Math.max(peakOf(max[0]), peakOf(max[1])) <= 15.8500004, `everything at its maximum: ${peakOf(max[0])}`);
  // a full-scale tone after silence: its first cycle comes through above full scale, then the gain is there
  const burst = Float32Array.from({ length: 2 * FS }, (_, i) => (i < FS ? 0 : Math.cos((2 * Math.PI * 1000 * (i - FS)) / FS)));
  const hit = run(Ott, { depth: 1 }, [burst, burst]).channels[0];
  assert.ok(peakOf(hit) < 2 && peakOf(hit, FS + FS / 2) < 0.2, `burst: ${peakOf(hit).toFixed(2)} at the start, ${peakOf(hit, FS + FS / 2).toFixed(3)} settled`);
  // at its defaults (depth 0.5) a mix at an ordinary level keeps its loudness within 4 dB — pink-ish noise at −18 and −12 dB RMS
  for (const level of [-18, -12]) {
    const pink = [3, 4].map((seed) => {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      const x = noise(2, 1, seed).map((w) => {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        return b0 + b1 + b2 + w * 0.1848;
      });
      const scale = lin(level) / rmsOf(x);
      return x.map((v) => v * scale);
    });
    const y = run(Ott, {}, pink).channels;
    const change = db(Math.hypot(rmsOf(y[0], FS / 2), rmsOf(y[1], FS / 2)) / Math.hypot(rmsOf(pink[0], FS / 2), rmsOf(pink[1], FS / 2)));
    assert.ok(Math.abs(change) < 4, `defaults on pink noise at ${level} dB: ${change.toFixed(2)} dB`);
  }
});

test('ott: settings glide — amounts, gains, the mix, and a crossover that is moved', () => {
  const at = 24064;
  const x = sine(200, 0.25, 1.5);
  // a step in any amount or gain arrives without a jump: no step between two samples larger than the sine itself
  // takes at the louder of the two levels it has before and after
  for (const [before, after] of [[{ depth: 0 }, { depth: 1 }], [{ depth: 1 }, { mix: 0 }], [{ depth: 1, mix: 0 }, { mix: 1 }], [{}, { output: 12 }], [{}, { lowGain: 24, midGain: -24 }], [{ depth: 1 }, { upward: 0, downward: 0 }], [{ depth: 1 }, { time: 0.1 }]]) {
    const y = stepped(Ott, before, after, x, at);
    const louder = Math.max(peakOf(y, at - 4800, at), peakOf(y, at + 24000)) / 0.25;
    const step = largestStep(y, at - 1, at + 24000) / ownStep(200, 0.25);
    assert.ok(step < louder * 1.1, `${JSON.stringify(before)} → ${JSON.stringify(after)}: a step ${step.toFixed(2)} × the sine's own (level ${louder.toFixed(2)} ×)`);
    // …and it arrives: the output ends where an effect that had these settings all along is
    const settled = run(Ott, { ...before, ...after }, [x, x]).channels[0];
    near(db(rmsOf(y, 60000) / rmsOf(settled, 60000)), 0, 0.05, `${JSON.stringify(after)} arrives`);
  }
  // A crossover that jumps would ring (a filter remembers the frequency it had); it glides instead. With no
  // compression acting only the crossover is heard: a low tone passes the moving split without a step larger than
  // its own (a split that jumped there gave steps 8 to 90 times larger when this was tried).
  for (const hz of [60, 100, 500]) {
    const tone = sine(hz, 0.5, 1.5);
    for (const [before, after] of [[{}, { lowMid: 1000 }], [{ lowMid: 1000, midHigh: 1000 }, { lowMid: 40, midHigh: 12000 }]]) {
      const y = stepped(Ott, { depth: 0, ...before }, after, tone, at);
      const step = largestStep(y, at - 1, at + 24000) / ownStep(hz, 0.5);
      assert.ok(step < 1.3, `${hz} Hz while the split moves ${JSON.stringify(after)}: ${step.toFixed(2)} × its own step`);
      // half a second later it is where a split that was always there is: the same all-pass
      const there = run(Ott, { depth: 0, ...before, ...after }, [tone, tone]).channels[0];
      assert.ok(largestDifference(y, there, at + 24000) < 1e-3, `${hz} Hz: the split arrives (${largestDifference(y, there, at + 24000)})`);
    }
  }
  // settings given before the first sample are where it starts: nothing glides in from the defaults
  const loud = sine(1000, 0.5, 0.01);
  const first = run(Ott, { depth: 0, output: -12, lowMid: 400 }, [loud, loud]).channels[0];
  const steady = run(Ott, { depth: 0, output: -12, lowMid: 400 }, [sine(1000, 0.5, 1), sine(1000, 0.5, 1)]).channels[0];
  near(db(peakOf(first, 240) / peakOf(steady, 24000)), 0, 0.05, 'the first milliseconds are at the level of the rest');
});

// ------------------------------------------------------------------------------------------------ transient shaper

/** A 1 kHz note (the reference's test signal): 0.2 s of silence, an instant onset, 0.3 s held, then a 120 ms decay. */
function note(amp) {
  return Float32Array.from({ length: 72000 }, (_, i) => {
    const t = i / FS - 0.2;
    return t < 0 ? 0 : amp * (t < 0.3 ? 1 : Math.exp(-(t - 0.3) / 0.12)) * Math.sin(2 * Math.PI * 1000 * t);
  });
}
/** A drum-like burst at 0.25 s: 1 ms up, 60 ms down; a low tone and noise. */
function drum(amp) {
  const hiss = noise(1, 1, 3);
  return Float32Array.from({ length: FS }, (_, i) => {
    const t = i / FS - 0.25;
    return t < 0 ? 0 : amp * Math.min(1, t / 0.001) * Math.exp(-t / 0.06) * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.4 * hiss[i]);
  });
}
/** Gain (dB) of the effect over a stretch of the signal, counted from `origin`. */
const stretchGain = (y, x, origin, from, to) => db(rmsOf(y, origin + from, origin + to) / rmsOf(x, origin + from, origin + to));

test('transient: with both amounts at 0 nothing changes, bit for bit; the output is a plain gain', () => {
  const [L, R] = programme();
  const [yl, yr] = run(TransientShaper, {}, [L, R]).channels;
  assert.ok(sameSamples(yl, L) && sameSamples(yr, R), 'attack 0, sustain 0: the input');
  const x = sine(1000, 0.3, 0.5);
  const y = run(TransientShaper, { output: -6 }, [x, x]).channels[0];
  near(db(rmsOf(y, 4800) / rmsOf(x, 4800)), -6, 0.01, 'output −6 dB');
});

test('transient: attack shapes the hit and sustain the tail, each leaving the rest alone — at any level', () => {
  const onset = 9600;
  const measure = (attack, sustain, amp) => {
    const x = note(amp);
    const y = run(TransientShaper, { attack, sustain }, [x, x]).channels[0];
    return {
      hit: stretchGain(y, x, onset, 48, 480), // 1 to 10 ms after the onset
      body: stretchGain(y, x, onset, 9600, 14400), // 200 to 300 ms: the held part
      tail: stretchGain(y, x, onset, 24000, 28800) // 200 to 300 ms into the decay
    };
  };
  const results = [0.5, 0.02].map((amp) => {
    const up = measure(1, 0, amp);
    assert.ok(up.hit > 6 && up.hit <= 12.1, `attack +1 at ${amp}: the hit by ${up.hit.toFixed(2)} dB (at most the 12 dB of its range)`);
    assert.ok(Math.abs(up.body) < 0.5 && Math.abs(up.tail) < 1, `attack +1 at ${amp}: body ${up.body.toFixed(3)}, tail ${up.tail.toFixed(3)} dB`);
    const down = measure(-1, 0, amp);
    assert.ok(down.hit < -6 && Math.abs(down.body) < 0.5 && Math.abs(down.tail) < 1, `attack −1 at ${amp}: the hit by ${down.hit.toFixed(2)} dB`);
    near(measure(0.5, 0, amp).hit, up.hit / 2, 0.3, `attack +0.5 at ${amp}: half of it`);
    const longer = measure(0, 1, amp);
    assert.ok(longer.tail > 6 && Math.abs(longer.hit) < 1 && Math.abs(longer.body) < 0.5, `sustain +1 at ${amp}: the tail by ${longer.tail.toFixed(2)} dB, hit ${longer.hit.toFixed(3)}, body ${longer.body.toFixed(3)}`);
    const shorter = measure(0, -1, amp);
    assert.ok(shorter.tail < -6 && Math.abs(shorter.hit) < 1 && Math.abs(shorter.body) < 0.5, `sustain −1 at ${amp}: the tail by ${shorter.tail.toFixed(2)} dB`);
    return [up.hit, down.hit, longer.tail, shorter.tail];
  });
  // no threshold: a note 28 dB quieter is shaped by the same number of dB (the tail a little less: it sinks towards
  // the −60 dB floor of the detector sooner)
  results[0].forEach((v, k) => near(results[1][k], v, 1, `the same at 0.5 and at 0.02 (measure ${k})`));
});

test('transient: on a drum-like burst, attack raises or lowers the first milliseconds and leaves the tail; sustain does the reverse', () => {
  const origin = FS / 4;
  for (const amp of [0.8, 0.05]) {
    const x = drum(amp);
    const measure = (attack, sustain) => {
      const y = run(TransientShaper, { attack, sustain }, [x, x]).channels[0];
      return { first: stretchGain(y, x, origin, 24, 240), tail: stretchGain(y, x, origin, 4800, 9600), peak: db(peakOf(y) / peakOf(x)) };
    };
    const punch = measure(1, 0);
    assert.ok(punch.first > 9 && punch.peak > 9 && Math.abs(punch.tail) < 1, `attack +1: first 5 ms ${punch.first.toFixed(2)} dB, peak ${punch.peak.toFixed(2)} dB, tail ${punch.tail.toFixed(2)} dB`);
    const soft = measure(-1, 0);
    assert.ok(soft.first < -9 && soft.peak < -5 && Math.abs(soft.tail) < 1, `attack −1: first 5 ms ${soft.first.toFixed(2)} dB, peak ${soft.peak.toFixed(2)} dB, tail ${soft.tail.toFixed(2)} dB`);
    const long = measure(0, 1);
    assert.ok(long.tail > 4 && Math.abs(long.first) < 0.1 && Math.abs(long.peak) < 0.1, `sustain +1: tail ${long.tail.toFixed(2)} dB, first 5 ms ${long.first.toFixed(3)} dB`);
    const tight = measure(0, -1);
    assert.ok(tight.tail < -4 && Math.abs(tight.first) < 0.1 && Math.abs(tight.peak) < 0.1, `sustain −1: tail ${tight.tail.toFixed(2)} dB, first 5 ms ${tight.first.toFixed(3)} dB`);
  }
});

test('transient: a steady tone passes at unity, whatever the amounts', () => {
  // (a held low note is the hard case: its level ripples with the wave, which must not read as a stream of onsets)
  for (const hz of [50, 100, 1000, 5000]) {
    const x = sine(hz, 0.3, 3);
    for (const [attack, sustain] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      const y = run(TransientShaper, { attack, sustain }, [x, x]).channels[0];
      const gain = db(rmsOf(y, 2 * FS) / rmsOf(x, 2 * FS));
      assert.ok(Math.abs(gain) < 0.15, `${hz} Hz, attack ${attack}, sustain ${sustain}: ${gain.toFixed(3)} dB`);
    }
  }
});

test('transient: one gain for both channels, and settings that glide', () => {
  // a drum on the left, a quiet steady tone on the right: the tone gets the drum's gain, sample for sample
  const L = drum(0.8);
  const R = sine(1000, 0.05, 1);
  const [yl, yr] = run(TransientShaper, { attack: 1, sustain: -1 }, [L, R]).channels;
  let compared = 0;
  for (let i = FS / 4; i < FS / 2; i++) {
    if (Math.abs(L[i]) < 0.02 || Math.abs(R[i]) < 0.02) continue;
    compared++;
    near(yr[i] / R[i], yl[i] / L[i], 1e-4, `gain right against left at sample ${i}`);
  }
  assert.ok(compared > 1000);
  assert.ok(db(peakOf(yr, FS / 4, FS / 4 + 240) / 0.05) > 6, 'the hit on the left raised the right');
  // an amount or the output stepped on a steady tone: no jump
  const at = 24064;
  const x = sine(200, 0.25, 1.5);
  for (const [before, after] of [[{}, { attack: 1 }], [{}, { sustain: -1 }], [{ attack: 1, sustain: 1 }, { attack: -1, sustain: -1 }], [{}, { output: 12 }], [{ output: 12 }, { output: -12 }]]) {
    const y = stepped(TransientShaper, before, after, x, at);
    const louder = Math.max(peakOf(y, at - 4800, at), peakOf(y, at + 24000)) / 0.25;
    const step = largestStep(y, at - 1, at + 24000) / ownStep(200, 0.25);
    assert.ok(step < louder * 1.1, `${JSON.stringify(before)} → ${JSON.stringify(after)}: a step ${step.toFixed(2)} × the sine's own (level ${louder.toFixed(2)} ×)`);
    near(db(rmsOf(y, 60000) / rmsOf(x, 60000)), after.output ?? 0, 0.2, `${JSON.stringify(after)} arrives`);
  }
});

// ------------------------------------------------------------------------------------------------------ trance gate

/** The gain of the gate, sample by sample: what it does to a constant 1. */
const gateGain = (params, seconds, opts) => run(TranceGate, params, [constant(seconds), constant(seconds)], opts).channels[0];
const risingEdges = (g) => { let n = 0; for (let i = 1; i < g.length; i++) if (g[i - 1] < 0.5 && g[i] >= 0.5) n++; return n; };

test('trancegate: open for the first part of every step and closed for the rest, to the sample', () => {
  // 120 bpm, 1/8 notes (12000 samples), open for half of each, 1 ms (48 samples) of fade either way
  const g = gateGain({ rate: '1/8', duty: 0.5, attack: 1, release: 1 }, 1.5);
  for (let step = 0; step < 6; step++) {
    const s = step * 12000;
    assert.ok(lowestOf(g, s + 60, s + 5990) > 1 - 1e-6, `step ${step}: open once it has faded in`);
    assert.ok(peakOf(g, s + 6060, s + 11990) < 1e-6, `step ${step}: closed once it has faded out`);
    // the edges: half-way after half a fade
    let rise = s;
    while (g[rise] < 0.5) rise++;
    let fall = s + 6000;
    while (g[fall] > 0.5) fall++;
    assert.ok(Math.abs(rise - s - 24) <= 1 && Math.abs(fall - s - 6024) <= 1, `step ${step}: opens at +${rise - s}, closes at +${fall - s}`);
  }
});

test('trancegate: the gate is a function of the song position and nothing else', () => {
  const params = { rate: '1/8', duty: 0.5, attack: 5, release: 40 };
  const whole = gateGain(params, 1.5);
  // a render that starts later in the song, cut into other blocks, gives the samples the first one has there
  for (const [beat, offset] of [[1, 24000], [0.8125, 19500], [2.3, 55200]]) {
    const late = gateGain(params, 1.5 - offset / FS, { beat, block: 77 });
    assert.ok(largestDifference(late, whole.subarray(offset)) < 1e-6, `started at beat ${beat}: differs by ${largestDifference(late, whole.subarray(offset))}`);
  }
  // …and four bars, or a thousand, further on the gate is the one of bar 1 (every step starts on a bar line)
  for (const beat of [16, 4000]) {
    const later = gateGain(params, 1.5, { beat });
    assert.ok(largestDifference(later, whole) < 1e-6, `started at beat ${beat}: differs by ${largestDifference(later, whole)}`);
  }
  assert.ok(largestDifference(gateGain(params, 1.5, { beat: 0.25 }), whole) > 0.9, 'elsewhere in the step it is elsewhere in the gate');
  // on real audio too: the same bar, the same samples
  const [L, R] = programme();
  const a = run(TranceGate, {}, [L, R], { beat: 0 }).channels;
  const b = run(TranceGate, {}, [L, R], { beat: 16, block: 500 }).channels;
  assert.ok(largestDifference(a[0], b[0]) < 1e-6 && largestDifference(a[1], b[1]) < 1e-6, 'bar 1 and bar 5');
  // a loop: the clock jumps back, the gate is back where it was
  const fx = new TranceGate(FS);
  fx.set(params);
  const passes = [0, 1].map(() => {
    const y = constant(2);
    for (let at = 0; at < y.length; at += 128) {
      fx.clock((at / FS) * 2, 120, true);
      fx.process(y.subarray(at, at + 128), new Float32Array(128), 128);
    }
    return y;
  });
  assert.ok(sameSamples(passes[0], passes[1]) && largestDifference(passes[0].subarray(0, 72000), whole) < 1e-6, 'the second pass of a loop is the first');
  // stopped, the studio's clock still runs and the gate follows it; with no clock at all it runs on by itself
  assert.ok(largestDifference(gateGain(params, 1.5, { playing: false }), whole) < 1e-6, 'transport stopped');
  const alone = new TranceGate(FS);
  alone.set(params);
  const free = constant(1.5);
  for (let at = 0; at < free.length; at += 128) alone.process(free.subarray(at, at + 128), new Float32Array(128), 128);
  assert.ok(largestDifference(free, whole) < 1e-6, `without clock(): differs by ${largestDifference(free, whole)}`);
});

test('trancegate: the gain repeats with exactly the step — which the rate and the tempo set', () => {
  // 1/16 at 120 bpm: 6000 samples
  const g = gateGain({ rate: '1/16' }, 2);
  assert.ok(largestDifference(g, g.subarray(6000)) < 1e-6, `one step on: ${largestDifference(g, g.subarray(6000))}`);
  assert.ok(largestDifference(g, g.subarray(3000)) > 0.5 && largestDifference(g, g.subarray(5999)) > 0.01, 'and by no other length');
  // …12000 at 60 bpm
  const slow = gateGain({ rate: '1/16' }, 2, { bpm: 60 });
  assert.ok(largestDifference(slow, slow.subarray(12000)) < 1e-6 && largestDifference(slow, slow.subarray(6000)) > 0.5, '60 bpm');
  // every note length: in two bars (8 beats) the gate opens once per step that starts in them
  for (const rate of DIVISIONS) {
    const beats = divisionBeats(rate);
    const opens = risingEdges(gateGain({ rate, attack: 1, release: 1 }, 4));
    assert.equal(opens, Math.ceil(8 / beats - 1e-9), `${rate}: opened ${opens} times in 8 beats`);
  }
  assert.equal(TranceGate.defs.find((d) => d.key === 'rate').default, '1/16');
});

test('trancegate: duty is the open part of the step; depth is how far it closes, and 0 is the input', () => {
  for (const duty of [0.1, 0.25, 0.5, 0.9]) {
    const g = gateGain({ rate: '1/16', duty, attack: 1, release: 1 }, 1.5);
    const open = g.reduce((n, v) => n + (v > 0.5 ? 1 : 0), 0) / g.length;
    near(open, duty, 0.005, `duty ${duty}: open for this part of the time`);
    assert.equal(risingEdges(g), 12, '12 steps in 1.5 s, each opening from closed');
  }
  const [L, R] = programme();
  const dry = run(TranceGate, { depth: 0 }, [L, R]).channels;
  assert.ok(sameSamples(dry[0], L) && sameSamples(dry[1], R), 'depth 0: the input, bit for bit');
  for (const depth of [0.25, 0.5, 0.9, 1]) {
    const { channels: [g], meter } = run(TranceGate, { depth, attack: 1, release: 1 }, [constant(1), constant(1)]);
    near(lowestOf(g), 1 - depth, 1e-6, `depth ${depth}: closed is ${1 - depth}`);
    near(peakOf(g), 1, 1e-6, 'open is 1');
    // the meter: the lowest gain of the last block, in dB (the render ends in the closed part of a step)
    near(meter, Math.max(-80, db(1 - depth)), 0.01, `meter at depth ${depth}`);
  }
  assert.equal(run(TranceGate, { attack: 1, release: 1 }, [constant(1.03), constant(1.03)]).meter, 0, 'meter when the last block is in the open part');
  // both channels get the same gain
  const [yl, yr] = run(TranceGate, {}, [constant(1), constant(1, -0.5)]).channels;
  assert.ok(yl.every((v, i) => Math.abs(v + 2 * yr[i]) < 1e-6));
});

test('trancegate: the edges are fades — no step in the gain larger than the fade allows, at any setting', () => {
  // a fade is an S-curve over its length: at its steepest it moves 1.5 / (its length in samples) per sample
  const cases = [
    { attack: 0.1, release: 1 }, // (no fade is shorter than 0.2 ms, whatever is asked)
    { attack: 1, release: 1 },
    { attack: 1, release: 100 }, // the default: the fade-out is still going when the next step opens
    { attack: 100, release: 2000, duty: 0.95 }, // fades far longer than the step
    { attack: 50, release: 5, duty: 0.05 }, // a fade-in longer than the open part: it never gets fully open
    { attack: 10, release: 500, rate: '1/32', duty: 0.3 },
    { attack: 0.5, release: 30, rate: '1/16t', duty: 0.6 },
    { attack: 2, release: 2, rate: '1/4d', depth: 0.6 }
  ];
  for (const params of cases) {
    const g = gateGain(params, 3, { bpm: 137 });
    const shortest = Math.max(0.0002, Math.min(params.attack, params.release) * 0.001);
    const bound = (1.5 / (shortest * FS)) * (params.depth ?? 1);
    assert.ok(largestStep(g) <= bound * 1.0001, `${JSON.stringify(params)}: a step of ${largestStep(g)} (the fade allows ${bound})`);
    assert.ok(lowestOf(g) >= 1 - (params.depth ?? 1) - 1e-6 && peakOf(g) <= 1 + 1e-6);
  }
  // the default at 120 bpm: a 100 ms fade-out does not fit in the 62.5 ms gap, so the gate closes to about a third
  near(lowestOf(gateGain({}, 2), 6000), 0.3115, 0.001, 'default settings: the lowest gain');
  // a fade-in longer than the open part stops where it has got to, and the fade-out starts from there
  near(peakOf(gateGain({ attack: 50, release: 5, duty: 0.05 }, 2)), 3 * 0.125 ** 2 - 2 * 0.125 ** 3, 1e-3, 'an eighth of the way up an S-curve');
});

test('trancegate: depth, duty and the fade lengths glide when they are changed', () => {
  // whenever in the step the change comes (94 block boundaries: more than two steps), the gain never moves faster
  // than its own 1 ms edges do
  const one = constant(2);
  const edge = 1.5 / 48;
  for (const [before, after] of [[{ depth: 1 }, { depth: 0 }], [{ depth: 0 }, { depth: 1 }], [{ duty: 0.5 }, { duty: 0.9 }], [{ duty: 0.9 }, { duty: 0.1 }], [{ attack: 1 }, { attack: 100 }], [{ attack: 100 }, { attack: 1 }], [{ release: 100 }, { release: 1 }], [{ release: 1 }, { release: 1000 }]]) {
    let worst = 0;
    for (let k = 0; k < 94; k++) {
      const at = 24064 + k * 128;
      worst = Math.max(worst, largestStep(stepped(TranceGate, before, after, one, at), at - 10, at + 24000));
    }
    assert.ok(worst <= edge * 1.02, `${JSON.stringify(before)} → ${JSON.stringify(after)}: a step of ${worst}`);
  }
  // and they arrive
  const y = stepped(TranceGate, { depth: 1, attack: 1, release: 1 }, { depth: 0.5, duty: 0.25 }, one, 24064);
  near(lowestOf(y, 60000), 0.5, 1e-4, 'depth arrives');
  near(y.subarray(60000, 96000).reduce((n, v) => n + (v > 0.75 ? 1 : 0), 0) / 36000, 0.25, 0.01, 'duty arrives');
});
