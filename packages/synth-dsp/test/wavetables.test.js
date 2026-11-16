// The wavetable bank on its own: every table builds into finite, levelled, DC-free, band-limited frames, the same
// ones on every build — and the tables that existing presets and songs were made with keep their ids, their order
// and their sound.
//
// This file imports wavetables.js itself, not the package index: the bank only needs util.js, so these tests say
// something about the tables whatever state the voice, the params or the patch code are in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bank from '../src/wavetables.js';
import { hashBipolar } from '../src/util.js';

const { WAVETABLE_IDS, describeWavetables, getWavetable, tableLevel, wavetablePreview, wavetableSpectrum, FRAME, STRIDE, LEVELS, MAX_HARMONICS } = bank;

/** The bank as it was before the tables of the Rust synth were added. Patches store these ids: never edit this list. */
const ORIGINAL = [
  'basic', 'tilt', 'pwm', 'resonant', 'formant', 'glass', 'fmbell', 'fmgrowl', 'drawbar', 'sync', 'fold', 'metal',
  'airy', 'ladder', 'primes', 'octaves', 'comb', 'staircase', 'tine', 'bowed', 'reed', 'dust', 'hollow', 'supersine'
];

/**
 * What the original tables sounded like when the list above was frozen: fingerprint() of each. A number that moves
 * means existing presets changed their sound — if that was the intention, it belongs in the changelog (and the presets
 * need levelling again); only then replace the number.
 */
const FINGERPRINTS = {
  basic: -17.067461, tilt: -18.575775, pwm: -7.814969, resonant: 5.53804, formant: -18.143513, glass: 27.318476,
  fmbell: 41.801036, fmgrowl: -70.271997, drawbar: -21.307408, sync: 29.281171, fold: -60.20411, metal: 37.4922,
  airy: -31.76762, ladder: 7.852756, primes: -26.09789, octaves: -18.186203, comb: -2.603785, staircase: 25.069635,
  tine: -7.475691, bowed: -33.261196, reed: -35.682541, dust: 8.656962, hollow: -36.079995, supersine: -24.541181
};

/** Every sample of every frame (full bandwidth) against fixed white weights: any change of shape, level or size shows. */
function fingerprint(id) {
  const data = tableLevel(getWavetable(id), 0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * hashBipolar(i, 1);
  return sum;
}

/** Build every table of one copy of the module; returns [total ms, slowest ms, its id]. */
function buildAll(copy) {
  let total = 0;
  let slowest = 0;
  let which = '';
  for (const id of copy.WAVETABLE_IDS) {
    const t0 = performance.now();
    copy.getWavetable(id);
    const ms = performance.now() - t0;
    total += ms;
    if (ms > slowest) { slowest = ms; which = id; }
  }
  return [total, slowest, which];
}

/** Index of the first value that differs (-1: the arrays are identical, bit for bit). */
function firstDifference(a, b) {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

const amp = (spec, h) => Math.hypot(spec.a[h], spec.b[h]);

// first in the file on purpose: the build it times is the first one of this process
test('the whole bank builds in a moment, and a second build gives the same data', async (t) => {
  const [first] = buildAll(bank);
  // a table is built once per JS realm, so a second build needs a second copy of the module (with its own cache)
  const again = await import('../src/wavetables.js?second-build');
  assert.notEqual(again.getWavetable, getWavetable, 'the second copy is a separate module');
  const [second, slowest, which] = buildAll(again);
  const frames = describeWavetables().reduce((n, d) => n + d.frames, 0);
  t.diagnostic(`${WAVETABLE_IDS.length} tables, ${frames} frames: built in ${first.toFixed(0)} ms (the first build of the process, FFT setup included), again in ${second.toFixed(0)} ms; slowest table of the second build: ${which}, ${slowest.toFixed(1)} ms`);
  // prewarmTables() builds on the audio thread when a patch changes: a recipe may cost tens of milliseconds, not more
  assert.ok(slowest < 500, `${which} takes ${slowest.toFixed(0)} ms to build`);

  assert.deepEqual(again.WAVETABLE_IDS, WAVETABLE_IDS);
  for (const id of WAVETABLE_IDS) {
    const one = getWavetable(id);
    const two = again.getWavetable(id);
    assert.notEqual(one, two);
    assert.equal(one.frames, two.frames);
    for (let f = 0; f < one.frames; f++) {
      assert.equal(firstDifference(one.spectra[f].a, two.spectra[f].a), -1, `${id} frame ${f}: sine amplitudes differ between builds`);
      assert.equal(firstDifference(one.spectra[f].b, two.spectra[f].b), -1, `${id} frame ${f}: cosine amplitudes differ between builds`);
    }
    for (const level of [0, 9]) assert.equal(firstDifference(tableLevel(one, level), again.tableLevel(two, level)), -1, `${id} level ${level} differs between builds`);
  }
});

test('the original 24 tables keep their ids and their order; new tables come after them', () => {
  assert.equal(ORIGINAL.length, 24);
  assert.deepEqual(WAVETABLE_IDS.slice(0, ORIGINAL.length), ORIGINAL);
});

test('the original 24 tables still sound the same', () => {
  for (const id of ORIGINAL) {
    const now = fingerprint(id);
    assert.ok(Math.abs(now - FINGERPRINTS[id]) < 1e-5, `${id} changed: fingerprint ${now.toFixed(6)}, was ${FINGERPRINTS[id]}`);
  }
});

test('ids are unique and written like the others; every table is named and described', () => {
  assert.equal(new Set(WAVETABLE_IDS).size, WAVETABLE_IDS.length, 'an id is used twice');
  const described = describeWavetables();
  assert.deepEqual(described.map((d) => d.id), WAVETABLE_IDS);
  const names = new Set();
  for (const d of described) {
    // one lowercase word; the MCP listing (describe_synth, topic "wavetables") pads ids to 10 characters
    assert.match(d.id, /^[a-z][a-z0-9]{1,9}$/, `id "${d.id}"`);
    assert.ok(typeof d.name === 'string' && d.name.trim().length >= 3, `${d.id} has a name`);
    assert.ok(!names.has(d.name), `${d.id}: the name "${d.name}" is used twice`);
    names.add(d.name);
    assert.ok(typeof d.description === 'string' && d.description.trim().length >= 30, `${d.id} has a description`);
    assert.match(d.description, /[.!)]$/, `${d.id}: the description is a finished sentence`);
    // every frame is kept once per mip level in use: the cache is 48 MB, the largest table so far has 24 frames
    assert.ok(Number.isInteger(d.frames) && d.frames >= 1 && d.frames <= 24, `${d.id}: ${d.frames} frames`);
  }
});

for (const id of WAVETABLE_IDS) {
  test(`${id}: finite, levelled, DC-free frames; preview and spectrum work`, () => {
    const t = getWavetable(id);
    const info = describeWavetables().find((d) => d.id === id);
    assert.equal(t.id, id);
    assert.equal(t.frames, info.frames);
    assert.equal(t.spectra.length, t.frames);
    for (let f = 0; f < t.frames; f++) {
      const s = t.spectra[f];
      assert.equal(s.a.length, MAX_HARMONICS + 1);
      assert.ok(s.a.every(Number.isFinite) && s.b.every(Number.isFinite), `${id} frame ${f}: the harmonic series is finite`);
      assert.ok(s.a[0] === 0 && s.b[0] === 0, `${id} frame ${f}: no DC term`);
    }

    const full = tableLevel(t, 0);
    assert.equal(full.length, t.frames * STRIDE);
    for (let f = 0; f < t.frames; f++) {
      const o = f * STRIDE + 1;
      let peak = 0;
      let sq = 0;
      let sum = 0;
      for (let n = 0; n < FRAME; n++) {
        const v = full[o + n];
        assert.ok(Number.isFinite(v), `${id} frame ${f} sample ${n} is ${v}`);
        peak = Math.max(peak, Math.abs(v));
        sq += v * v;
        sum += v;
      }
      const rms = Math.sqrt(sq / FRAME);
      assert.ok(Math.abs(sum / FRAME) < 1e-6, `${id} frame ${f}: DC ${sum / FRAME}`);
      // levelled to RMS 0.32 unless that would clip: then the peak sits at 1 and the frame is quieter, never silent
      assert.ok(peak >= 0.3 && peak <= 1.0001, `${id} frame ${f}: peak ${peak}`);
      assert.ok(rms > 0.05 && rms < 0.34, `${id} frame ${f}: rms ${rms}`);
      assert.ok(Math.abs(rms - 0.32) < 0.003 || peak > 0.997, `${id} frame ${f}: neither levelled (rms ${rms}) nor at full scale (peak ${peak})`);
      // the padding repeats the cycle, so a 4-point read never sees a seam
      assert.equal(full[o - 1], full[o + FRAME - 1]);
      assert.equal(full[o + FRAME], full[o]);
      assert.equal(full[o + FRAME + 1], full[o + 1]);
    }
    // the narrower copies a high note reads, down to the one that is only the fundamental
    for (const level of [9, LEVELS - 1]) {
      const data = tableLevel(t, level);
      assert.equal(data.length, t.frames * STRIDE);
      assert.ok(data.every((v) => Number.isFinite(v) && Math.abs(v) < 1.5), `${id} level ${level}`);
    }

    assert.equal(wavetablePreview(id).length, 128);
    assert.equal(wavetableSpectrum(id).length, 64);
    for (const position of [0, 0.3, 0.5, 1]) {
      const wave = wavetablePreview(id, position, 64);
      assert.equal(wave.length, 64);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of wave) {
        assert.ok(Number.isFinite(v), `${id} preview at ${position}`);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      assert.ok(hi - lo > 0.1 && hi < 1.5 && lo > -1.5, `${id} preview at ${position} runs from ${lo} to ${hi}`);
      const spec = wavetableSpectrum(id, position, 32);
      assert.equal(spec.length, 32);
      assert.ok(spec.every((v) => v >= 0 && v <= 1.0001), `${id} spectrum at ${position}`);
      assert.ok(Math.max(...spec) > 0.999, `${id} spectrum at ${position}: the loudest harmonic reads 1`);
    }
    // a position outside 0..1 is clamped, not read past the table
    assert.deepEqual(wavetablePreview(id, 7, 32), wavetablePreview(id, 1, 32));
    assert.deepEqual(wavetableSpectrum(id, -3, 16), wavetableSpectrum(id, 0, 16));
  });
}

test('the tables that say they loop do: the last frame is the first one again', () => {
  for (const id of ['drift', 'reese']) {
    const t = getWavetable(id);
    const first = t.spectra[0];
    const last = t.spectra[t.frames - 1];
    for (let h = 1; h <= MAX_HARMONICS; h++) {
      assert.ok(Math.abs(first.a[h] - last.a[h]) < 1e-6 && Math.abs(first.b[h] - last.b[h]) < 1e-6, `${id} harmonic ${h}`);
    }
  }
});

test('ported recipes hold the harmonics they describe', () => {
  // cheby: frame n is the first n + 1 harmonics, all cosines, falling as 1/h
  const cheby = getWavetable('cheby');
  for (const f of [0, 6, 23]) {
    const s = cheby.spectra[f];
    for (let h = 1; h <= 40; h++) {
      if (h <= f + 1) assert.ok(Math.abs(s.b[h] * h / s.b[1] - 1) < 1e-9 && s.a[h] === 0, `cheby frame ${f} harmonic ${h}`);
      else assert.equal(amp(s, h), 0, `cheby frame ${f} stops at harmonic ${f + 1}`);
    }
  }
  // oddeven: no even harmonics at 0, a saw (amplitude 1/h) in the middle, the even ones leading at 1
  const oddEven = getWavetable('oddeven');
  const [square, saw, even] = [0, (oddEven.frames - 1) / 2, oddEven.frames - 1].map((f) => oddEven.spectra[f]);
  for (let h = 2; h <= 32; h++) {
    assert.ok(Math.abs(amp(saw, h) * h / amp(saw, 1) - 1) < 1e-9, `the middle frame is a saw (harmonic ${h})`);
    if (h % 2 === 0) assert.equal(amp(square, h), 0);
    else assert.ok(Math.abs(amp(even, h) * h / amp(even, 1) - 0.1) < 1e-9, `odd overtones drop to a tenth (harmonic ${h})`);
  }
  // ringmod: frame n multiplies the sine by one at n + 1 times the pitch: the sum and difference tones, and the dry sine
  const ring = getWavetable('ringmod').spectra[5];
  const loudest = Math.max(...[1, 5, 7].map((h) => amp(ring, h)));
  for (let h = 1; h <= 64; h++) {
    if ([1, 5, 7].includes(h)) assert.ok(amp(ring, h) > 0.3 * loudest, `ringmod harmonic ${h}`);
    else assert.ok(amp(ring, h) < 1e-9 * loudest, `ringmod has nothing at harmonic ${h}`);
  }
});
