// The synth engines beside the GGS Synth, measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNTH_ENGINES, renderEngine } from '../src/engines/index.js';
import { Additive, additiveSpectrum, MAX_PARTIALS } from '../src/engines/additive.js';
import { engineChecks, note, FS, db, peakOf, rmsOf, levelAt, strongest } from './engine-helpers.js';

const hz = (key) => 440 * 2 ** ((key - 69) / 12);

test('every engine in the registry passes the checks all of them share', () => {
  assert.ok(Object.keys(SYNTH_ENGINES).length >= 1);
  for (const [type, Engine] of Object.entries(SYNTH_ENGINES)) {
    assert.equal(Engine.type, type);
    engineChecks(Engine);
  }
});

test('additive: the knobs shape the spectrum as they say', () => {
  const base = Object.fromEntries(Additive.defs.map((d) => [d.key, d.default]));
  const amps = new Float64Array(MAX_PARTIALS);
  // a tilt of −6 dB per octave: every doubling of the partial number is 6 dB down (a saw's 1/k, near enough)
  additiveSpectrum({ ...base, partials: 16, tilt: -6 }, amps);
  for (const k of [2, 4, 8, 16]) assert.ok(Math.abs(db(amps[k - 1] / amps[0]) + 6 * Math.log2(k)) < 0.01, `partial ${k}`);
  additiveSpectrum({ ...base, partials: 16, tilt: 0 }, amps);
  assert.ok(Math.abs(amps[15] - amps[0]) < 1e-9, 'tilt 0: every partial equally loud');
  // the loudness is the same whatever the spectrum
  for (const p of [{ tilt: -24 }, { tilt: 6, partials: 64 }, { oddEven: -1 }, { windowGain: 24, windowWidth: 0.1 }, { windowGain: -24 }, { partials: 1 }]) {
    additiveSpectrum({ ...base, ...p }, amps);
    assert.ok(Math.abs(Math.sqrt(amps.reduce((s, a) => s + a * a, 0) / 2) - 0.5) < 1e-6, JSON.stringify(p));
  }
  // odd / even: −1 keeps partials 1, 3, 5…; +1 keeps 1, 2, 4, 6…
  additiveSpectrum({ ...base, partials: 8, oddEven: -1 }, amps);
  assert.deepEqual([...amps.slice(0, 8)].map((a) => a > 1e-9), [true, false, true, false, true, false, true, false]);
  additiveSpectrum({ ...base, partials: 8, oddEven: 1 }, amps);
  assert.deepEqual([...amps.slice(0, 8)].map((a) => a > 1e-9), [true, true, false, true, false, true, false, true]);
  // the emphasis window boosts where it sits and nowhere else
  const flat = new Float64Array(MAX_PARTIALS);
  additiveSpectrum({ ...base, partials: 32, tilt: 0 }, flat);
  additiveSpectrum({ ...base, partials: 32, tilt: 0, windowCenter: 0.6, windowWidth: 0.05, windowGain: 18 }, amps);
  const centre = Math.round(2 ** (0.6 * Math.log2(32))) - 1;
  assert.ok(db(amps[centre] / amps[0]) > 15 && Math.abs(amps[0] - amps[31]) < 1e-9, `partial ${centre + 1} is ${db(amps[centre] / amps[0]).toFixed(1)} dB over the rest`);

  // …and what is heard is what the spectrum says: partial levels of a rendered note
  const { L } = note(Additive, { partials: 8, tilt: -6, spread: 0, velBright: 0, sustain: 1, attack: 0.005 }, { key: 45, hold: 1, seconds: 1.1, velocity: 0.8 });
  const f0 = hz(45);
  const first = levelAt(L, f0, 9600, 32768);
  for (const k of [2, 3, 5, 8]) assert.ok(Math.abs(db(levelAt(L, f0 * k, 9600, 32768) / first) + 6 * Math.log2(k)) < 0.4, `heard partial ${k}: ${db(levelAt(L, f0 * k, 9600, 32768) / first).toFixed(2)} dB`);
  assert.ok(db(levelAt(L, f0 * 9, 9600, 32768) / first) < -70, 'and no ninth partial');
  // stretch: partial k sounds at f0 · k^(1 + stretch/4)
  const bell = note(Additive, { partials: 4, tilt: 0, stretch: 1, spread: 0, sustain: 1 }, { key: 45, hold: 1, seconds: 1.1 }).L;
  for (const k of [2, 3, 4]) {
    const want = f0 * k ** 1.25;
    const got = strongest(bell, 9600, 32768, want * 0.97, want * 1.03).hz;
    assert.ok(Math.abs(1200 * Math.log2(got / want)) < 3, `stretched partial ${k}: ${got.toFixed(1)} Hz for ${want.toFixed(1)}`);
  }
});

test('additive: nothing above the audible range, two stacks beat, the stereo is where it says', () => {
  // a high note with 64 partials asked for: only those under 0.45 of the sample rate sound (no aliasing below)
  const { L } = note(Additive, { partials: 64, tilt: 0, spread: 0, sustain: 1 }, { key: 96, hold: 0.8, seconds: 0.9 });
  const f0 = hz(96);
  const sounding = Math.floor((0.4 * FS) / f0);
  assert.ok(levelAt(L, f0 * sounding, 9600, 16384) > 1e-3, `partial ${sounding} sounds`);
  // between the partials there is nothing: an aliased partial would land off the harmonic grid
  let worst = 0;
  for (let k = 1; k < sounding; k++) worst = Math.max(worst, levelAt(L, f0 * (k + 0.5), 9600, 16384));
  assert.ok(db(worst / levelAt(L, f0, 9600, 16384)) < -60, `between the partials: ${db(worst / levelAt(L, f0, 9600, 16384)).toFixed(1)} dB`);

  // detune 1: two fundamentals 50 cents apart, and the level beats at their difference
  const two = note(Additive, { partials: 1, detune: 1, spread: 0, sustain: 1 }, { key: 69, hold: 2, seconds: 2.1 });
  const lo = strongest(two.L, 9600, 65536, 425, 439.5).hz;
  const hi = strongest(two.R, 9600, 65536, 440.5, 455).hz;
  assert.ok(Math.abs(1200 * Math.log2(hi / lo) - 50) < 2, `${lo.toFixed(2)} and ${hi.toFixed(2)} Hz are ${(1200 * Math.log2(hi / lo)).toFixed(1)} cents apart`);
  // spread 0 is mono; spread 1 puts the even partials on one side and the odd ones on the other
  const mono = note(Additive, { partials: 8, spread: 0, sustain: 1 }, { key: 45, hold: 0.6, seconds: 0.7 });
  assert.deepEqual(mono.L, mono.R);
  const wide = note(Additive, { partials: 8, spread: 1, tilt: 0, sustain: 1 }, { key: 45, hold: 0.6, seconds: 0.7 });
  const f = hz(45);
  assert.ok(db(levelAt(wide.R, f * 2, 9600, 16384) / levelAt(wide.L, f * 2, 9600, 16384)) > 40, 'partial 2 on the right');
  assert.ok(db(levelAt(wide.L, f * 3, 9600, 16384) / levelAt(wide.R, f * 3, 9600, 16384)) > 40, 'partial 3 on the left');
  assert.ok(Math.abs(db(levelAt(wide.L, f, 9600, 16384) / levelAt(wide.R, f, 9600, 16384))) < 0.1, 'the fundamental in the middle');
});

test('additive: shimmer moves the partials and not the loudness; softer notes are darker; a note is a note in Node too', () => {
  const still = note(Additive, { partials: 16, shimmer: 0, sustain: 1, spread: 0 }, { key: 48, hold: 4, seconds: 4.1 }).L;
  const alive = note(Additive, { partials: 16, shimmer: 1, sustain: 1, spread: 0 }, { key: 48, hold: 4, seconds: 4.1 }).L;
  const f = hz(48);
  const wander = (x, k) => { const levels = [1, 2, 3].map((s) => levelAt(x, f * k, s * FS, 16384)); return db(Math.max(...levels) / Math.min(...levels)); };
  assert.ok(wander(still, 5) < 0.05 && wander(alive, 5) + wander(alive, 7) + wander(alive, 9) > 1.5, `partials wander by ${wander(alive, 5).toFixed(2)}, ${wander(alive, 7).toFixed(2)}, ${wander(alive, 9).toFixed(2)} dB`);
  assert.ok(Math.abs(db(rmsOf(alive, FS, 3 * FS) / rmsOf(still, FS, 3 * FS))) < 1.5, 'the loudness stays');
  // velocity → brightness: the fifth partial is further under the fundamental on a soft note
  const tilt = (velocity, velBright) => { const x = note(Additive, { partials: 8, velBright, sustain: 1, spread: 0 }, { key: 48, hold: 0.8, seconds: 0.9, velocity }).L; return db(levelAt(x, f * 5, 9600, 16384) / levelAt(x, f, 9600, 16384)); };
  assert.ok(tilt(0.3, 1) < tilt(0.8, 1) - 5, `${tilt(0.3, 1).toFixed(1)} against ${tilt(0.8, 1).toFixed(1)} dB`);
  assert.ok(Math.abs(tilt(0.3, 0) - tilt(0.8, 0)) < 0.2, 'and not when the knob is at 0');
  // chords in Node: three notes are three notes
  const { channels: [L] } = renderEngine('additive', { partials: 4, sustain: 1, spread: 0 }, [{ key: 48, duration: 1 }, { key: 52, duration: 1 }, { key: 55, duration: 1 }], { sampleRate: FS });
  for (const key of [48, 52, 55]) assert.ok(levelAt(L, hz(key), 9600, 32768) > 0.01, `key ${key} sounds`);
  assert.ok(peakOf(L) < 0.5);
});
