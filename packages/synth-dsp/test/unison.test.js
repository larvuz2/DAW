// Unison: the laws that space the copies, the stacks, sixteen copies, and a table position per copy — measured on
// the sound, and on the promise that a patch made before any of this plays exactly as it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderPatch, GGS_PARAMS } from '../src/index.js';
import { MAX_UNISON, UNISON_LAWS, UNISON_STACKS, unisonCents, stackSemis, supersawDetune, spreadOf } from '../src/unison.js';
import { FS, db, peakOf, rmsOf, spectrum } from './fx-helpers.js';

/** One held note of a patch that is nothing but oscillator A through no filter and no effects. */
function note(params, { key = 57, seconds = 2 } = {}) {
  const r = renderPatch({ params: { f1On: false, oscARand: 1, env1Attack: 0.001, ...params }, notes: [{ key, velocity: 1, start: 0, duration: seconds }], sampleRate: FS, seconds, fx: false });
  return r.channels || [r.left, r.right];
}
/** The partials of a held note between two frequencies, strongest first: [{ hz, amp }]. */
function partials(x, lo, hi, floor = 0.002) {
  const { mag, binHz } = spectrum(x, FS / 2, 65536);
  const out = [];
  for (let k = Math.max(2, Math.floor(lo / binHz)); k < Math.min(mag.length - 2, Math.ceil(hi / binHz)); k++) {
    if (mag[k] > floor && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
      const [a, b, c] = [Math.log(mag[k - 1] + 1e-30), Math.log(mag[k]), Math.log(mag[k + 1] + 1e-30)];
      out.push({ hz: (k + (0.5 * (a - c)) / (a - 2 * b + c)) * binHz, amp: mag[k] });
    }
  }
  return out;
}
const cents = (hz, ref) => 1200 * Math.log2(hz / ref);

test('unison laws: the places of the copies — even, the supersaw\'s, crowded round the centre, uneven but fixed', () => {
  assert.deepEqual(UNISON_LAWS, ['linear', 'super', 'exp', 'random']);
  for (let n = 1; n <= MAX_UNISON; n++) {
    for (let law = 0; law < 4; law++) {
      const c = Array.from({ length: n }, (_, u) => unisonCents(law, u, n, 40));
      // the centre copy of an odd stack is on the note; nothing stands further out than the knob says; low to high
      if (n % 2) assert.equal(c[(n - 1) / 2], 0, `law ${law}, ${n} copies`);
      assert.ok(c.every((v) => Math.abs(v) <= 40 + 1e-9), `law ${law}, ${n}: ${c}`);
      if (law !== 3) for (let u = 1; u < n; u++) assert.ok(c[u] > c[u - 1], `law ${law}, ${n} copies rise: ${c}`);
      for (let u = 0; u < n; u++) assert.ok(Math.sign(c[u]) === Math.sign(spreadOf(u, n)), `law ${law}: each copy on its side`);
    }
    // linear is what it always was
    for (let u = 0; u < n; u++) assert.equal(unisonCents(0, u, n, 37), spreadOf(u, n) * 37);
  }
  // the JP-8000: seven saws at −1 : −0.572 : −0.177 : 0 : 0.181 : 0.565 : 0.977 of the full detune (Szabo's figures)
  const full = 100 * supersawDetune(1);
  const seven = Array.from({ length: 7 }, (_, u) => unisonCents(1, u, 7, 100) / full);
  [-1, -0.57156, -0.17745, 0, 0.18098, 0.56502, 0.97664].forEach((want, u) => assert.ok(Math.abs(seven[u] - want) < 1e-9, `saw ${u}: ${seven[u]}`));
  // its knob: gentle for most of the way, then it runs away
  assert.equal(supersawDetune(0), 0);
  assert.ok(Math.abs(supersawDetune(1) - 1) < 1e-12);
  assert.ok(supersawDetune(0.5) < 0.12 && supersawDetune(0.9) < 0.5 && supersawDetune(0.9) > 0.25, `${supersawDetune(0.5)}, ${supersawDetune(0.9)}`);
  // (the published polynomial has a ripple of a hundredth of a cent near 0.04: it never falls by more than that)
  for (let x = 0.01; x <= 1; x += 0.01) assert.ok(supersawDetune(x) > supersawDetune(x - 0.01) - 1e-4, `the curve rises at ${x}`);
  // exp: the inner copies closer to the centre than evenly spaced ones
  assert.ok(Math.abs(unisonCents(2, 4, 7, 40)) < Math.abs(unisonCents(0, 4, 7, 40)) * 0.5);
  // random: the same every time, the two sides alike, the widest pair at the full detune
  const r = Array.from({ length: 9 }, (_, u) => unisonCents(3, u, 9, 40));
  assert.deepEqual(r, Array.from({ length: 9 }, (_, u) => unisonCents(3, u, 9, 40)));
  for (let u = 0; u < 4; u++) assert.ok(Math.abs(r[u] + r[8 - u]) < 1e-9);
  assert.ok(Math.abs(Math.max(...r) - 40) < 1e-9);
});

test('stacks: from the centre outwards the pairs take the stack\'s notes in turn, the same on both sides', () => {
  assert.deepEqual(UNISON_STACKS, ['off', 'octave', 'fifth', 'octave+fifth']);
  const of = (stack, n) => Array.from({ length: n }, (_, u) => stackSemis(UNISON_STACKS.indexOf(stack), u, n));
  assert.deepEqual(of('off', 7), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(of('octave', 7), [12, 0, 12, 0, 12, 0, 12]);
  assert.deepEqual(of('octave', 5), [0, 12, 0, 12, 0]);
  assert.deepEqual(of('fifth', 4), [7, 0, 0, 7]);
  assert.deepEqual(of('octave+fifth', 7), [0, 12, 7, 0, 7, 12, 0]);
  assert.deepEqual(of('octave', 1), [0], 'one copy keeps the note');
  assert.deepEqual(of('octave', 2), [0, 0], 'the innermost pair keeps the note');
});

test('in the sound: the copies are where the law puts them, and a stack adds its notes', () => {
  // the partials around the note's own frequency are the copies (A5, 880 Hz: 20 cents are 10 Hz there, which a
  // 1.4 s window tells apart)
  const places = (params) => partials(note({ oscAUnison: 7, oscADetune: 60, oscABlend: 1, oscASpread: 0, ...params }, { key: 81 })[0], 880 * 0.935, 880 * 1.065).map((p) => cents(p.hz, 880)).sort((a, b) => a - b);
  const linear = places({});
  assert.equal(linear.length, 7, `seven copies: ${linear.map((c) => c.toFixed(1))}`);
  [-60, -40, -20, 0, 20, 40, 60].forEach((want, i) => assert.ok(Math.abs(linear[i] - want) < 1.5, `linear copy ${i} at ${linear[i].toFixed(2)} cents`));
  // (the knob at its end, where the supersaw is as wide as the linear stack: at 60 its copies are within 14 cents)
  const sup = places({ oscAUniLaw: 'super', oscADetune: 100 });
  const depth = 100 * supersawDetune(1);
  assert.equal(sup.length, 7, `seven copies: ${sup.map((c) => c.toFixed(1))}`);
  [-1, -0.57156, -0.17745, 0, 0.18098, 0.56502, 0.97664].forEach((share, i) => assert.ok(Math.abs(sup[i] - share * depth) < 1.5, `supersaw copy ${i} at ${sup[i].toFixed(2)} cents (${(share * depth).toFixed(2)} expected)`));
  // sixteen copies sound, and stay at the level of one (the stack is levelled by its power)
  const one = rmsOf(note({ oscAUnison: 1 }, { key: 81 })[0], FS / 2);
  const sixteen = note({ oscAUnison: 16, oscADetune: 90, oscABlend: 1 }, { key: 81 });
  assert.ok(partials(sixteen[0], 880 * 0.94, 880 * 1.06, 0.001).length >= 14, `sixteen copies can be told apart: ${partials(sixteen[0], 880 * 0.94, 880 * 1.06, 0.001).length}`);
  assert.ok(Math.abs(db(rmsOf(sixteen[0], FS / 2) / one)) < 3.5, `sixteen copies against one: ${db(rmsOf(sixteen[0], FS / 2) / one).toFixed(1)} dB`);
  assert.ok(peakOf(sixteen[0]) < 1.5);
  // a stack: with five copies and no detune, three play the note and two the octave (or the fifth)
  const at = (x, hz) => partials(x, hz * 0.99, hz * 1.01, 0.0005).reduce((m, p) => Math.max(m, p.amp), 0);
  const plain = note({ oscAUnison: 5, oscADetune: 0, oscABlend: 1 })[0];
  const octave = note({ oscAUnison: 5, oscADetune: 0, oscABlend: 1, oscAStack: 'octave' })[0];
  const fifth = note({ oscAUnison: 5, oscADetune: 0, oscABlend: 1, oscAStack: 'fifth' })[0];
  const f5 = 220 * 2 ** (7 / 12);
  assert.ok(at(fifth, f5) > 10 * at(plain, f5) && at(fifth, f5) > 0.02, `the fifth: ${at(fifth, f5).toFixed(4)} against ${at(plain, f5).toFixed(4)}`);
  assert.ok(at(octave, f5) < 2 * at(plain, f5) + 1e-3, 'and no fifth in an octave stack');
  // (the octave copies add their fundamental to the note's second harmonic: random phases, so only "more" is sure)
  const energy = (x) => rmsOf(x, FS / 2);
  assert.ok(Math.abs(db(energy(octave) / energy(plain))) < 4, 'a stack keeps the level');
});

test('a table position per copy: the copies read different frames, and with the knob at 0 nothing changes', () => {
  // a table that changes along its length: find one whose first and last frames differ
  const table = GGS_PARAMS.find((d) => d.key === 'oscATable').options.find((id) => {
    const lo = note({ oscATable: id, oscAPos: 0 }, { seconds: 0.6 })[0];
    const hi = note({ oscATable: id, oscAPos: 1 }, { seconds: 0.6 })[0];
    const tone = (x) => { const { mag } = spectrum(x, 4800, 16384); let hiE = 0; let all = 0; for (let k = 0; k < mag.length; k++) { all += mag[k] ** 2; if (k > 400) hiE += mag[k] ** 2; } return hiE / all; };
    return Math.abs(tone(lo) - tone(hi)) > 0.05;
  });
  assert.ok(table, 'a table that moves');
  const base = { oscATable: table, oscAPos: 0.5, oscAUnison: 7, oscADetune: 15, oscASpread: 1, oscARand: 0 };
  const [l0, r0] = note(base, { seconds: 1 });
  const [l1, r1] = note({ ...base, oscAUniPos: 1 }, { seconds: 1 });
  // spread hard left and right, the two sides now read opposite ends of the table: their spectra part
  const bright = (x) => { const { mag } = spectrum(x, 9600, 32768); let hiE = 0; let all = 0; for (let k = 0; k < mag.length; k++) { all += mag[k] ** 2; if (k > 800) hiE += mag[k] ** 2; } return hiE / all; };
  const apart0 = Math.abs(bright(l0) - bright(r0));
  const apart1 = Math.abs(bright(l1) - bright(r1));
  assert.ok(apart1 > apart0 * 3 && apart1 > 0.005, `left against right: ${apart0.toFixed(4)} without, ${apart1.toFixed(4)} with a position per copy`);
  // one copy has no stack to spread
  assert.deepEqual(note({ ...base, oscAUnison: 1, oscAUniPos: 1 }, { seconds: 0.3 })[0], note({ ...base, oscAUnison: 1 }, { seconds: 0.3 })[0]);
});

test('patches made before the laws, the stacks and sixteen copies play exactly as they did', () => {
  // what these patches rendered before unison.js existed (0.12.1): a change in a single sample changes the hash
  const before = {
    uni5: '38d1819f682c3248', uni8: '06702fd05928fa3f', uni2: 'eb2a37a67b7f22c6'
  };
  const print = (params) => {
    const r = renderPatch({ params, notes: [{ key: 57, velocity: 0.8, start: 0, duration: 0.6 }, { key: 64, velocity: 0.6, start: 0.3, duration: 0.5 }], sampleRate: 48000, seconds: 1.6 });
    const h = createHash('sha1');
    for (const c of r.channels || [r.left, r.right]) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
    return h.digest('hex').slice(0, 16);
  };
  assert.equal(print({ oscAUnison: 5, oscADetune: 30 }), before.uni5);
  assert.equal(print({ oscAUnison: 8, oscADetune: 60, oscABlend: 0.4, oscASpread: 1, oscAPos: 0.37 }), before.uni8);
  assert.equal(print({ oscAUnison: 2, oscADetune: 12, oscBOn: true, oscBUnison: 7, oscBDetune: 22 }), before.uni2);
  // the new settings at rest are the same patch
  assert.equal(print({ oscAUnison: 5, oscADetune: 30, oscAUniLaw: 'linear', oscAStack: 'off', oscAUniPos: 0 }), before.uni5);
  assert.notEqual(print({ oscAUnison: 5, oscADetune: 30, oscAUniLaw: 'super' }), before.uni5);
  // a law or a stack changed under a held note fades (no click): nothing louder than the note itself
  const held = renderPatch({ params: { oscAUnison: 7, oscADetune: 30 }, notes: [{ key: 57, velocity: 1, start: 0, duration: 1 }], sampleRate: FS, seconds: 1.2, fx: false });
  assert.ok(peakOf((held.channels || [held.left])[0]) < 1.2);
});

test('found by the review: a stacked copy above the reach of the sample rate is left out instead of folding back', () => {
  // the highest key, eight copies, every second pair an octave up: 25 kHz does not exist at 44.1 kHz
  const fs = 44100;
  const render = (params) => { const r = renderPatch({ params: { f1On: false, oscAUnison: 8, oscADetune: 0, oscABlend: 1, ...params }, notes: [{ key: 127, velocity: 1, start: 0, duration: 1 }], sampleRate: fs, seconds: 1, fx: false }); return (r.channels || [r.left])[0]; };
  const strayAt = (x) => {
    const { mag, binHz } = spectrum(x, 8192, 16384, fs);
    const f0 = 440 * 2 ** ((127 - 69) / 12);
    let note = 0;
    let stray = 0;
    for (let k = 4; k < mag.length; k++) { const hz = k * binHz; if (Math.abs(hz - f0) < 40) note += mag[k] ** 2; else stray += mag[k] ** 2; }
    return 10 * Math.log10(stray / note);
  };
  const plain = strayAt(render({}));
  const stacked = strayAt(render({ oscAStack: 'octave' }));
  assert.ok(stacked < -40, `an octave stack on key 127: ${stacked.toFixed(1)} dB of anything but the note (it was −6.5 dB: a 19 kHz tone)`);
  assert.ok(Math.abs(stacked - plain) < 12, `like the stack switched off (${plain.toFixed(1)} dB)`);
  // an octave lower everything fits, and the stack is there
  const lower = renderPatch({ params: { f1On: false, oscAUnison: 8, oscADetune: 0, oscABlend: 1, oscAStack: 'octave' }, notes: [{ key: 103, velocity: 1, start: 0, duration: 1 }], sampleRate: fs, seconds: 1, fx: false });
  const { mag, binHz } = spectrum((lower.channels || [lower.left])[0], 8192, 16384, fs);
  const at = (hz) => { let m = 0; for (let k = Math.round(hz / binHz) - 3; k <= Math.round(hz / binHz) + 3; k++) m = Math.max(m, mag[k]); return m; };
  const g7 = 440 * 2 ** ((103 - 69) / 12);
  assert.ok(at(2 * g7) > 0.05 * at(g7), 'the octave copies sound where they fit');
});
