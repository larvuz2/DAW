// The modal engine, measured: the modes are where the physics of each object puts them, they fade as the knobs say,
// and a strike comes out at the level it promises. (The class is imported directly: no registration needed.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Modal, modalSpectrum, MODAL_STRUCTURES, STRIKE_PEAK, BOW_RMS } from '../src/engines/modal.js';
import { note, engineChecks, centsFrom, levelAt, FS, db, peakOf, rmsOf, strongest } from './engine-helpers.js';

const keyHz = (key) => 440 * 2 ** ((key - 69) / 12);
/** One long-ringing strike with every mode alive, for looking at where the modes are. */
const ring = (params, opts = {}) => note(Modal, { decay: 8, damping: 0, brightness: 1, position: 0.13, inharmonic: 0, spread: 0, release: 8, modes: 12, ...params }, { key: 57, velocity: 1, hold: 2, seconds: 2, ...opts });

test('modal: the checks every engine has to pass, in every structure and with every exciter', () => {
  engineChecks(Modal);
  for (const structure of MODAL_STRUCTURES) {
    for (const exciter of ['mallet', 'pluck', 'noise', 'bow']) {
      const { L, R } = note(Modal, { structure, exciter }, { key: 48, hold: 0.4 });
      assert.ok(L.every(Number.isFinite) && R.every(Number.isFinite), `${structure}, ${exciter}`);
      assert.ok(peakOf(L) > 1e-3 && peakOf(L) < 1, `${structure}, ${exciter}: peak ${db(peakOf(L)).toFixed(1)} dB`);
    }
  }
});

test('modal: the modes are where the object puts them — harmonics on a string, 1 : 2.76 : 5.40 on a bar, Bessel zeros on a drum head', () => {
  const expected = {
    string: [1, 2, 3, 4, 5],
    bar: [1, 2.7565, 5.4039, 8.9330],
    membrane: [1, 1.5933, 2.1355, 2.2954],
    stiff: [1, 2 * Math.sqrt(1.008 / 1.002), 3 * Math.sqrt(1.018 / 1.002)]
  };
  for (const [structure, ratios] of Object.entries(expected)) {
    const { L } = ring({ structure });
    for (const ratio of ratios) {
      const hz = 220 * ratio;
      const found = strongest(L, 4800, 65536, hz * 0.985, hz * 1.015);
      assert.ok(Math.abs(1200 * Math.log2(found.hz / hz)) < 3, `${structure}: a mode at ${hz.toFixed(1)} Hz (found ${found.hz.toFixed(1)})`);
      assert.ok(found.amp > 1e-4, `${structure}: the mode at ×${ratio} sounds (${db(found.amp).toFixed(0)} dB)`);
    }
    // and what the editor is told is what sounds
    modalSpectrum({ structure, modes: 12 }).slice(0, ratios.length).forEach((m, k) => assert.ok(Math.abs(m.ratio / ratios[k] - 1) < 1e-4, `${structure}: mode ${k + 1} is told as ×${m.ratio}`));
  }
  // a tubular bell: its modes 3, 4, 5 stand about 2 : 3 : 4 (as measured chimes do: a little narrow, then a little
  // wide), which is where a chime's strike note comes from
  const bell = modalSpectrum({ structure: 'bell', modes: 12 }).map((m) => m.ratio);
  assert.ok(Math.abs(bell[3] / bell[2] - 1.5) < 0.04 && Math.abs(bell[4] / bell[2] - 2) < 0.04, `${(bell[3] / bell[2]).toFixed(3)}, ${(bell[4] / bell[2]).toFixed(3)}`);
  // morph slides the overtones from one object to the next, as intervals: half-way from string to stiff
  const half = modalSpectrum({ structure: 'string', morph: 0.5, modes: 12 })[5].ratio;
  const [a, b] = [modalSpectrum({ structure: 'string', modes: 12 })[5].ratio, modalSpectrum({ structure: 'stiff', modes: 12 })[5].ratio];
  assert.ok(Math.abs(half - Math.sqrt(a * b)) < 1e-6);
});

test('modal: the note is on its key in every structure, follows a bend and the tuning, and Inharmonic leaves the pitch alone', () => {
  for (const structure of MODAL_STRUCTURES) {
    for (const key of [36, 60, 84]) {
      const { L } = ring({ structure }, { key });
      const found = strongest(L, 4800, 65536, keyHz(key) * 0.97, keyHz(key) * 1.03);
      assert.ok(Math.abs(centsFrom(found.hz, key)) < 1.5, `${structure}, key ${key}: ${centsFrom(found.hz, key).toFixed(2)} cents`);
    }
  }
  const bent = strongest(ring({}, { bend: 2 }).L, 4800, 65536, 230, 260);
  assert.ok(Math.abs(centsFrom(bent.hz, 59)) < 1.5, `two semitones up: ${centsFrom(bent.hz, 59).toFixed(2)} cents from B3`);
  const tuned = strongest(ring({}, { tune: -31 }).L, 4800, 65536, 210, 226);
  assert.ok(Math.abs(centsFrom(tuned.hz, 57) + 31) < 1.5, `31 cents down: ${centsFrom(tuned.hz, 57).toFixed(2)}`);
  const rough = ring({ structure: 'string', inharmonic: 1 });
  assert.ok(Math.abs(centsFrom(strongest(rough.L, 4800, 65536, 213, 227).hz, 57)) < 1.5, 'the lowest mode stays');
  const second = strongest(rough.L, 4800, 65536, 400, 480).hz;
  assert.ok(Math.abs(1200 * Math.log2(second / 440)) > 3 && Math.abs(1200 * Math.log2(second / 440)) <= 101, `the second mode is off by ${(1200 * Math.log2(second / 440)).toFixed(1)} cents`);
});

test('modal: Decay is the time the lowest mode takes to fall 60 dB; Damping takes the high modes first', () => {
  for (const decay of [0.5, 2]) {
    const { L } = note(Modal, { structure: 'string', modes: 4, decay, damping: 0, release: 30, brightness: 0.2, spread: 0 }, { key: 57, velocity: 1, hold: decay, seconds: decay });
    // a quarter and three quarters of the way: half the decay time is 30 dB
    const at = (share) => levelAt(L, 220, Math.round(share * decay * FS), 4096);
    const fall = db(at(0.2) / at(0.7));
    assert.ok(Math.abs(fall - 30) < 2.5, `decay ${decay} s: ${fall.toFixed(1)} dB in half of it`);
  }
  // the eighth harmonic against the first, half a second in: equal with no damping, far down with it
  const eighth = (damping) => {
    const { L } = note(Modal, { structure: 'string', modes: 8, decay: 4, damping, release: 30, brightness: 1, position: 0.06, spread: 0 }, { key: 45, velocity: 1, hold: 1, seconds: 1 });
    return db(levelAt(L, 880, 24000, 8192) / levelAt(L, 110, 24000, 8192)) - db(levelAt(L, 880, 2400, 8192) / levelAt(L, 110, 2400, 8192));
  };
  assert.ok(Math.abs(eighth(0)) < 2, `no damping: the eighth harmonic keeps up (${eighth(0).toFixed(1)} dB)`);
  assert.ok(eighth(0.5) < -15, `damping 0.5: it falls ${eighth(0.5).toFixed(1)} dB behind in 0.45 s`);
  // what the editor is told: T60 = decay × ratio^(−2 × damping)
  const told = modalSpectrum({ structure: 'string', modes: 8, decay: 4, damping: 0.5 });
  assert.ok(Math.abs(told[0].t60 - 4) < 1e-6 && Math.abs(told[7].t60 - 4 / 8) < 1e-3);
});

test('modal: where it is struck and how hard — the middle removes every second mode, a harder note is brighter', () => {
  const second = (position) => {
    const { L } = ring({ structure: 'string', position });
    return db(levelAt(L, 440, 4800, 32768) / levelAt(L, 220, 4800, 32768));
  };
  assert.ok(second(0.5) < second(0.2) - 30, `the second harmonic: ${second(0.2).toFixed(1)} dB struck at a fifth, ${second(0.5).toFixed(1)} dB in the middle`);
  const tilt = (velocity) => {
    const { L } = note(Modal, { structure: 'string', modes: 16, brightness: 0.4, damping: 0, decay: 4, spread: 0 }, { key: 45, velocity, hold: 0.5, seconds: 0.5 });
    return db(levelAt(L, 880, 2400, 16384) / levelAt(L, 110, 2400, 16384));
  };
  assert.ok(tilt(1) > tilt(0.3) + 4, `the eighth harmonic against the first: ${tilt(0.3).toFixed(1)} dB soft, ${tilt(1).toFixed(1)} dB hard`);
  // a full-velocity strike peaks at STRIKE_PEAK before the Level knob, whatever the object
  for (const [name, params] of Object.entries(Modal.presets)) {
    if (params.exciter === 'bow' || params.exciter === 'noise') continue;
    const { L, R } = note(Modal, { ...params, level: 0, spread: 0 }, { key: 60, velocity: 1, hold: 0.5 });
    const peak = Math.max(peakOf(L), peakOf(R));
    assert.ok(Math.abs(db(peak / STRIKE_PEAK)) < 2.5, `${name}: a strike peaks at ${db(peak).toFixed(1)} dB (${db(STRIKE_PEAK).toFixed(1)} promised)`);
  }
});

test('modal: the damper stops the note when the key is let go, the bow holds it while it is down, and the note ends', () => {
  // a vibraphone-long ring, let go after 0.3 s with a 0.1 s damper: gone 0.3 s later
  const damped = note(Modal, { structure: 'bar', decay: 8, damping: 0.1, release: 0.1 }, { key: 57, hold: 0.3, seconds: 2 });
  const before = rmsOf(damped.L, 0.2 * FS, 0.3 * FS);
  const after = rmsOf(damped.L, 0.6 * FS, 0.7 * FS);
  assert.ok(db(after / before) < -50, `0.3 s after the key: ${db(after / before).toFixed(0)} dB`);
  assert.ok(damped.endedAt !== null && damped.endedAt < 0.3 * FS + Modal.tail({ decay: 8, release: 0.1 }) * FS + 256, `it reports the end (${damped.endedAt})`);
  // held with a long damper it rings on
  const open = note(Modal, { structure: 'bar', decay: 8, damping: 0.1, release: 8 }, { key: 57, hold: 0.3, seconds: 2 });
  assert.ok(db(rmsOf(open.L, 0.6 * FS, 0.7 * FS) / rmsOf(open.L, 0.2 * FS, 0.3 * FS)) > -6);
  // the bow is noise rubbing the object: the level wanders by a few dB as it does under a real bow, around the level
  // Drive sets — BOW_RMS (−12 dBFS) at Drive 1 and full velocity — for as long as the key is down
  const bowed = (drive) => note(Modal, { structure: 'bar', exciter: 'bow', drive, decay: 1, level: 0, spread: 0 }, { key: 57, velocity: 1, hold: 8, seconds: 8 }).L;
  const strong = bowed(1);
  const held = rmsOf(strong, FS, 8 * FS);
  assert.ok(Math.abs(db(held / BOW_RMS)) < 2.5, `a held bow: ${db(held).toFixed(1)} dB over seven seconds (${db(BOW_RMS).toFixed(1)} promised)`);
  assert.ok(Math.abs(db(rmsOf(strong, 5 * FS, 8 * FS) / rmsOf(strong, FS, 4 * FS))) < 3, 'and it does not fade while the key is down');
  const weak = rmsOf(bowed(0.3), FS, 8 * FS);
  assert.ok(db(held / weak) > 6, `more Drive, more level: ${db(held / weak).toFixed(1)} dB between 0.3 and 1`);
  // every preset: a note that sounds, stays under full scale at full velocity, and is the same note twice
  for (const [name, params] of Object.entries(Modal.presets)) {
    const a = note(Modal, params, { key: 60, velocity: 1, hold: 0.5 });
    const b = note(Modal, params, { key: 60, velocity: 1, hold: 0.5 });
    assert.ok(peakOf(a.L) > 0.02 && peakOf(a.L) < 0.9 && peakOf(a.R) < 0.9, `${name}: peak ${db(peakOf(a.L)).toFixed(1)} dB`);
    assert.deepEqual(a.L, b.L, `${name}: repeats`);
  }
});
