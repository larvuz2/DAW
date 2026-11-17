// Signals, measurements and the checks every studio effect has to pass. Used by the effect tests.
import assert from 'node:assert/strict';
import { fft } from '../src/index.js';
import { renderEffect as renderRegistered } from '../src/effects/index.js';

export const FS = 48000;
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
export const peakOf = (x, from = 0, to = x.length) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i])); return m; };
export const rmsOf = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, to - from)); };
export const sine = (hz, amp, seconds, phase = 0, fs = FS) => Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / fs + phase));
export const mixOf = (...parts) => Float32Array.from(parts[0], (_, i) => parts.reduce((s, p) => s + (p[i] || 0), 0));
/** White noise that is the same every time (a small LCG). */
export function noise(seconds, amp = 0.5, seed = 1, fs = FS) {
  let s = seed >>> 0 || 1;
  return Float32Array.from({ length: Math.round(seconds * fs) }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return amp * (s / 2147483648 - 1);
  });
}
/** One sample of 1 at `at`, silence around it. */
export function impulse(seconds, at = 0, fs = FS) {
  const x = new Float32Array(Math.round(seconds * fs));
  x[at] = 1;
  return x;
}

/** Magnitude spectrum of n samples (a power of two) from `start`, Hann-windowed: { mag, binHz }. */
export function spectrum(x, start, n, fs = FS) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = (Math.hypot(re[i], im[i]) * 4) / n; // a sine of amplitude A reads A
  return { mag, binHz: fs / n };
}
/** The frequency (interpolated between bins) and level of the strongest partial between lo and hi Hz. */
export function strongest(x, start, n, lo = 20, hi = FS / 2 - 100, fs = FS) {
  const { mag, binHz } = spectrum(x, start, n, fs);
  let pk = Math.max(2, Math.floor(lo / binHz));
  for (let i = pk; i < Math.min(mag.length - 1, Math.ceil(hi / binHz)); i++) if (mag[i] > mag[pk]) pk = i;
  const [a, b, c] = [Math.log(mag[pk - 1] + 1e-30), Math.log(mag[pk] + 1e-30), Math.log(mag[pk + 1] + 1e-30)];
  return { hz: (pk + (0.5 * (a - c)) / (a - 2 * b + c)) * binHz, amp: mag[pk] };
}
/** The level of the partial at (about) `hz`: the largest bin within two bins of it. */
export function levelAt(x, hz, start, n, fs = FS) {
  const { mag, binHz } = spectrum(x, start, n, fs);
  const k = Math.round(hz / binHz);
  let m = 0;
  for (let i = Math.max(0, k - 2); i <= Math.min(mag.length - 1, k + 2); i++) m = Math.max(m, mag[i]);
  return m;
}

/** Amplitude of the partial at exactly `hz` in n samples from `start`, under a Hann window (no bin to fall between). */
export function toneAt(x, hz, start = 0, n = x.length - start, fs = FS) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const ph = (2 * Math.PI * hz * i) / fs;
    re += x[start + i] * w * Math.cos(ph);
    im += x[start + i] * w * Math.sin(ph);
  }
  return (4 * Math.hypot(re, im)) / n;
}

/** Run an effect class over stereo audio in blocks of 128, as the worklet does: { channels: [L, R], latency, meter, fx }. */
export function run(Fx, params, [L, R], { fs = FS, bpm = 120, beat = 0, playing = true, tail = 0, block = 128 } = {}) {
  const fx = new Fx(fs);
  fx.set(params || {});
  const extra = Math.round(tail * fs);
  const outL = new Float32Array(L.length + extra);
  const outR = new Float32Array(L.length + extra);
  outL.set(L);
  outR.set(R || L);
  for (let at = 0; at < outL.length; at += block) {
    const n = Math.min(block, outL.length - at);
    fx.clock(beat + (at / fs) * (bpm / 60), bpm, playing);
    fx.process(outL.subarray(at, at + n), outR.subarray(at, at + n), n);
  }
  return { channels: [outL, outR], latency: fx.latency, meter: fx.meter, fx };
}
export { renderRegistered };

/**
 * What every studio effect promises, whatever it does: a label, a description, parameter definitions whose defaults
 * are in range and say what they do; no sound of its own; settings from anywhere are clamped or ignored; a NaN in is
 * not a NaN out for ever after; the same audio in gives the same audio out; block size does not matter.
 */
export function basicChecks(Fx, { silent = true, blockFree = true } = {}) {
  const type = Fx.type;
  assert.ok(/^[a-z][a-z0-9]*$/.test(type), `type "${type}"`);
  assert.ok(Fx.label && Fx.description.length > 40, `${type}: label and description`);
  const keys = new Set();
  for (const d of Fx.defs) {
    assert.ok(!keys.has(d.key), `${type}.${d.key} twice`);
    keys.add(d.key);
    assert.ok(d.label && ['number', 'select', 'bool'].includes(d.type), `${type}.${d.key}`);
    if (d.type === 'number') assert.ok(d.min < d.max && d.default >= d.min && d.default <= d.max, `${type}.${d.key}: default in range`);
    if (d.type === 'select') assert.ok(d.options.includes(d.default), `${type}.${d.key}`);
    if (d.automatable) assert.equal(d.type, 'number', `${type}.${d.key}: only numbers are automated`);
    assert.ok(d.description && d.description.length > 20, `${type}.${d.key}: says what it does`);
  }
  const fx = new Fx(FS);
  assert.ok(Number.isInteger(fx.latency) && fx.latency >= 0, `${type}: latency`);
  if (silent) {
    const quiet = run(Fx, {}, [new Float32Array(FS), new Float32Array(FS)]);
    assert.ok(peakOf(quiet.channels[0]) < 1e-6 && peakOf(quiet.channels[1]) < 1e-6, `${type}: makes no sound of its own`);
  }
  // settings out of range or of the wrong kind are clamped or ignored, never thrown at the audio thread
  fx.set(Object.fromEntries(Fx.defs.map((d) => [d.key, d.type === 'number' ? 1e9 : 'nonsense'])));
  let L = sine(220, 0.5, 0.25);
  let R = sine(331, 0.5, 0.25);
  fx.process(L, R, L.length);
  assert.ok(L.every(Number.isFinite) && R.every(Number.isFinite), `${type}: finite with every number at its maximum`);
  fx.set(Object.fromEntries(Fx.defs.map((d) => [d.key, d.type === 'number' ? -1e9 : null])));
  fx.set({ nothing: 1, [Fx.defs[0].key]: NaN });
  L = sine(220, 0.5, 0.25);
  R = sine(331, 0.5, 0.25);
  fx.process(L, R, L.length);
  assert.ok(L.every(Number.isFinite) && R.every(Number.isFinite), `${type}: finite with every number at its minimum`);
  // a NaN in is not a NaN out for ever after
  const bad = sine(220, 0.5, 0.5);
  bad[100] = NaN;
  bad[101] = Infinity;
  const survived = run(Fx, {}, [bad, Float32Array.from(bad)], { tail: 0.5 });
  assert.ok(survived.channels[0].every(Number.isFinite) && survived.channels[1].every(Number.isFinite), `${type}: survives a NaN`);
  // the same audio in, the same audio out — and it does not matter how the host cuts it into blocks
  const x = mixOf(sine(180, 0.3, 0.5), sine(2210, 0.2, 0.5), noise(0.5, 0.05, 7));
  const a = run(Fx, {}, [x, x]).channels[0];
  assert.deepEqual(run(Fx, {}, [x, x]).channels[0], a, `${type}: repeats`);
  if (blockFree) {
    const odd = run(Fx, {}, [x, x], { block: 128 * 3 }).channels[0];
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - odd[i]));
    assert.ok(worst < 1e-3, `${type}: block size changes the sound by ${worst}`);
  }
}

/** Milliseconds of CPU for one second of stereo audio at 48 kHz (the median of a few runs). */
export function cost(Fx, params = {}) {
  const x = mixOf(sine(110, 0.3, 1), sine(1870, 0.2, 1), noise(1, 0.1, 3));
  const times = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    run(Fx, params, [x, Float32Array.from(x)]);
    times.push(performance.now() - t0);
  }
  return times.sort((p, q) => p - q)[2];
}
