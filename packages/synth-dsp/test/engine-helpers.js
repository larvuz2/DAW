// The checks every synth engine has to pass, and ways to render and measure a note. Used by the engine tests.
import assert from 'node:assert/strict';
import { FS, db, peakOf, rmsOf, strongest, spectrum } from './fx-helpers.js';

export { FS, db, peakOf, rmsOf, strongest };
export { spectrum } from './fx-helpers.js';

/**
 * The amplitude of the partial at (about) `hz`, wherever it falls between two bins: the power of the five bins around
 * it, which for a Hann window is the same for a partial on a bin and for one half-way between two.
 */
export function levelAt(x, hz, start, n, fs = FS) {
  const { mag, binHz } = spectrum(x, start, n, fs);
  const near = Math.round(hz / binHz);
  let k = near;
  // (the bounds are fixed first: a search that follows its own best bin climbs the skirt of the next partial)
  for (let i = Math.max(2, near - 2); i <= Math.min(mag.length - 3, near + 2); i++) if (mag[i] > mag[k]) k = i;
  let power = 0;
  for (let i = k - 2; i <= k + 2; i++) power += mag[i] * mag[i];
  return Math.sqrt(power / 1.5);
}

/**
 * One note of an engine class: { L, R, engine, endedAt (sample where it reported finished, or null) }.
 * opts: key (60), velocity (0.8), hold (seconds the key is down, 0.5), seconds (total, default hold + tail + 0.2),
 * bend (semitones), tune (cents), seed, block (128), fs.
 */
export function note(Engine, params = {}, { key = 60, velocity = 0.8, hold = 0.5, seconds = null, bend = 0, tune = 0, seed = 12345, block = 128, fs = FS } = {}) {
  const engine = new Engine(fs, seed);
  engine.set(params);
  const total = Math.round((seconds ?? hold + Engine.tail({ ...Object.fromEntries(Engine.defs.map((d) => [d.key, d.default])), ...params }) + 0.2) * fs);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  engine.noteOn(key, velocity, tune);
  const off = Math.round(hold * fs);
  let released = false;
  let endedAt = null;
  for (let at = 0; at < total;) {
    // the key is let go on its exact sample, wherever that falls in a block (as the worklet does)
    if (!released && at >= off) { engine.noteOff(0.5); released = true; }
    if (engine.finished) { endedAt ??= at; break; }
    let n = Math.min(block, total - at);
    if (!released && at + n > off) n = off - at;
    engine.render(L.subarray(at, at + n), R.subarray(at, at + n), n, typeof bend === 'function' ? bend(at / fs) : bend);
    at += n;
  }
  if (endedAt === null && engine.finished) endedAt = total;
  return { L, R, engine, endedAt };
}

/** Cents between a measured frequency and the frequency of a MIDI key. */
export const centsFrom = (hz, key) => 1200 * Math.log2(hz / (440 * 2 ** ((key - 69) / 12)));

/**
 * What every engine promises: a label, a description, parameters whose defaults are in range and say what they do,
 * presets that only use those parameters; a note that is finite, starts without a click, is not too loud, ends by
 * itself after the key is let go (within the tail it declares), and is the same note every time.
 * opts.pitched (true): also checks that keys, tuning and bends land on their frequencies (to `cents`).
 */
export function engineChecks(Engine, { pitched = true, cents = 5, keys = [36, 57, 81] } = {}) {
  const type = Engine.type;
  assert.ok(/^[a-z][a-z0-9]*$/.test(type), `type "${type}"`);
  assert.ok(Engine.label && Engine.description.length > 60 && Engine.category && /^#[0-9a-f]{6}$/i.test(Engine.color), `${type}: label, description, category, colour`);
  const defs = new Map();
  for (const d of Engine.defs) {
    assert.ok(!defs.has(d.key), `${type}.${d.key} twice`);
    defs.set(d.key, d);
    assert.ok(d.label && ['number', 'select', 'bool'].includes(d.type), `${type}.${d.key}`);
    if (d.type === 'number') assert.ok(d.min < d.max && d.default >= d.min && d.default <= d.max, `${type}.${d.key}: default in range`);
    if (d.type === 'select') assert.ok(d.options.includes(d.default), `${type}.${d.key}`);
    assert.ok(d.description && d.description.length > 20, `${type}.${d.key}: says what it does`);
  }
  const presets = Object.entries(Engine.presets || {});
  assert.ok(presets.length >= 4, `${type}: at least four presets`);
  for (const [name, values] of presets) {
    for (const [k, v] of Object.entries(values)) {
      const d = defs.get(k);
      assert.ok(d, `${type} preset "${name}": unknown parameter ${k}`);
      if (d.type === 'number') assert.ok(v >= d.min && v <= d.max, `${type} preset "${name}": ${k} = ${v} is out of range`);
      if (d.type === 'select') assert.ok(d.options.includes(v), `${type} preset "${name}": ${k}`);
    }
  }
  for (const [name, values] of [['(default)', {}], ...presets]) {
    const a = note(Engine, values, { velocity: 1 });
    assert.ok(a.L.every(Number.isFinite) && a.R.every(Number.isFinite), `${type} "${name}": finite`);
    assert.ok(Math.abs(a.L[0]) < 0.05 && Math.abs(a.R[0]) < 0.05, `${type} "${name}": starts without a click (${a.L[0]})`);
    const peak = Math.max(peakOf(a.L), peakOf(a.R));
    assert.ok(peak < 0.71 && peak > 0.01, `${type} "${name}": a full-velocity note peaks at ${db(peak).toFixed(1)} dBFS (wanted −40…−3)`);
    assert.ok(a.endedAt !== null, `${type} "${name}": the note ends after the key is let go (within its declared tail)`);
    const tail = Math.round(0.02 * FS);
    assert.ok(peakOf(a.L, Math.max(0, a.endedAt - tail), a.endedAt) < 0.01, `${type} "${name}": it ends in silence, not with a cut`);
    const b = note(Engine, values, { velocity: 1 });
    assert.deepEqual(b.L, a.L, `${type} "${name}": the same note every time`);
    // softer is quieter (velocity is squared: half the velocity is about a quarter of the level)
    const soft = note(Engine, values, { velocity: 0.5 });
    const ratio = Math.max(peakOf(soft.L), peakOf(soft.R)) / peak;
    assert.ok(ratio > 0.12 && ratio < 0.5, `${type} "${name}": velocity 0.5 is ${db(ratio).toFixed(1)} dB under velocity 1 (about −12 wanted)`);
  }
  // settings from anywhere are clamped or ignored, also while the note sounds
  const e = new Engine(FS, 7);
  e.noteOn(60, 0.8, 0);
  const L = new Float32Array(2048);
  const R = new Float32Array(2048);
  e.set(Object.fromEntries(Engine.defs.map((d) => [d.key, d.type === 'number' ? 1e9 : 'nonsense'])));
  e.render(L, R, 2048, 0);
  e.set(Object.fromEntries(Engine.defs.map((d) => [d.key, d.type === 'number' ? -1e9 : null])));
  e.set({ nothing: 1, [Engine.defs[0].key]: NaN });
  e.render(L, R, 2048, 0);
  assert.ok(L.every(Number.isFinite) && R.every(Number.isFinite), `${type}: finite with every setting at its extremes`);
  // it does not matter how the host cuts the note into blocks
  const one = note(Engine, {}, { block: 128 });
  const other = note(Engine, {}, { block: 128 * 3 });
  let worst = 0;
  for (let i = 0; i < one.L.length; i++) worst = Math.max(worst, Math.abs(one.L[i] - other.L[i]));
  assert.ok(worst < 2e-3, `${type}: block size changes the sound by ${worst}`);
  if (pitched) {
    const hzOf = (opts) => { const x = note(Engine, {}, { hold: 1, seconds: 1.2, ...opts }); return strongestNear(x.L, opts.key ?? 60, opts); };
    for (const key of keys) assert.ok(Math.abs(centsFrom(hzOf({ key }), key)) < cents, `${type}: key ${key} is ${centsFrom(hzOf({ key }), key).toFixed(2)} cents off`);
    assert.ok(Math.abs(centsFrom(hzOf({ key: 57, tune: 31 }), 57) - 31) < cents, `${type}: a tuning of +31 cents`);
    assert.ok(Math.abs(centsFrom(hzOf({ key: 57, bend: 2 }), 59)) < cents, `${type}: a bend of two semitones`);
  }
}

/** The frequency of the partial nearest the expected fundamental of a key (after tune and bend). */
function strongestNear(x, key, { tune = 0, bend = 0 } = {}) {
  const hz = 440 * 2 ** ((key + tune / 100 + bend - 69) / 12);
  return strongest(x, Math.round(0.2 * FS), 32768, hz * 0.94, hz * 1.06).hz;
}
