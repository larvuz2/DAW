// The Analog engine, measured: the oscillators are in tune and band-limited, hard sync keeps the pitch of
// oscillator 1 while oscillator 2 shapes the tone, and the ladder does what a four-pole low-pass does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analog, ANALOG_WAVES } from '../src/engines/analog.js';
import { fft } from '../src/index.js';
import { note, engineChecks, centsFrom, levelAt, FS, db, peakOf, rmsOf, strongest } from './engine-helpers.js';

const keyHz = (key) => 440 * 2 ** ((key - 69) / 12);
/** One oscillator, steady, wide open: what the oscillator itself makes. */
const RAW = { mix: 0, fine2: 0, drift: 0, cutoff: 20000, resonance: 0, envAmount: 0, keyTrack: 0, velCutoff: 0, attack: 0.001, sustain: 1, level: 0 };
const tone = (params, opts = {}) => note(Analog, { ...RAW, ...params }, { key: 69, velocity: 0.8, hold: 1.5, seconds: 1.5, ...opts }).L;

/** Power under 20 kHz that is not on a harmonic of `hz`, against the power of the harmonics (dB) — Blackman–Harris. */
function foldBack(y, hz) {
  const n = 32768;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    re[i] = y[9600 + i] * (0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a));
  }
  fft(re, im);
  const binHz = FS / n;
  let harmonic = 0;
  let other = 0;
  for (let k = 16; k < 20000 / binHz; k++) {
    const f = k * binHz;
    const nearest = Math.round(f / hz) * hz;
    const power = re[k] * re[k] + im[k] * im[k];
    if (nearest > 0 && Math.abs(f - nearest) < 8 * binHz) harmonic += power; else other += power;
  }
  return 10 * Math.log10(other / harmonic);
}

test('analog: the checks every engine has to pass, with every wave and with sync', () => {
  engineChecks(Analog, { cents: 9 });
  for (const wave1 of ANALOG_WAVES) {
    for (const wave2 of ANALOG_WAVES) {
      for (const sync of [false, true]) {
        const { L } = note(Analog, { wave1, wave2, sync, semi2: 7 }, { key: 48, hold: 0.3 });
        assert.ok(L.every(Number.isFinite) && peakOf(L) > 1e-3 && peakOf(L) < 1, `${wave1}, ${wave2}, sync ${sync}: peak ${db(peakOf(L)).toFixed(1)} dB`);
      }
    }
  }
});

test('analog: the waves are the waves — in tune, with the harmonics theory gives them', () => {
  for (const key of [33, 57, 81, 105]) {
    for (const wave1 of ANALOG_WAVES) {
      const y = tone({ wave1 }, { key });
      const f = strongest(y, 9600, 32768, keyHz(key) * 0.97, keyHz(key) * 1.03);
      assert.ok(Math.abs(centsFrom(f.hz, key)) < 1, `${wave1}, key ${key}: ${centsFrom(f.hz, key).toFixed(2)} cents`);
    }
  }
  // A4: harmonic n of a saw at 1/n, of a square at 1/n (odd only), of a triangle at 1/n² (odd only)
  const h = (y, n) => levelAt(y, 440 * n, 9600, 32768);
  const saw = tone({ wave1: 'saw' });
  const square = tone({ wave1: 'square', pw: 0.5 });
  const tri = tone({ wave1: 'triangle' });
  const sine = tone({ wave1: 'sine' });
  for (const n of [2, 3, 5, 8]) assert.ok(Math.abs(db(h(saw, n) / h(saw, 1)) + db(n)) < 0.6, `saw harmonic ${n}: ${db(h(saw, n) / h(saw, 1)).toFixed(2)} dB`);
  for (const n of [3, 5, 7]) assert.ok(Math.abs(db(h(square, n) / h(square, 1)) + db(n)) < 0.6, `square harmonic ${n}`);
  for (const n of [2, 4]) assert.ok(db(h(square, n) / h(square, 1)) < -50, `a square has no harmonic ${n}`);
  // (through the ladder, whose soft clip adds a little third harmonic of its own at full level — under 1 %, as an
  // analog filter does: a sine comes out with its third harmonic 42 dB down, and a triangle's are 0.7 dB off)
  for (const n of [3, 5]) assert.ok(Math.abs(db(h(tri, n) / h(tri, 1)) + 2 * db(n)) < 1.2, `triangle harmonic ${n}: ${db(h(tri, n) / h(tri, 1)).toFixed(2)} dB`);
  assert.ok(db(h(sine, 2) / h(sine, 1)) < -70 && db(h(sine, 3) / h(sine, 1)) < -38 && db(h(sine, 5) / h(sine, 1)) < -70, `a sine: ${db(h(sine, 3) / h(sine, 1)).toFixed(1)} dB of third harmonic`);
  // the pulse width removes every 1/width-th harmonic: at a quarter, the fourth
  const quarter = tone({ wave1: 'square', pw: 0.25 });
  assert.ok(db(h(quarter, 4) / h(quarter, 1)) < -45 && db(h(quarter, 2) / h(quarter, 1)) > -6);
});

test('analog: band-limited — what folds back from a high note is far below a naive oscillator\'s', (t) => {
  // C7 (2093 Hz): a naive saw folds back at about −30 dB; the corrected steps bring that down by 20 dB and more
  const hz = keyHz(96);
  const naive = (wave) => {
    const y = new Float32Array(FS * 1.5);
    let p = 0;
    for (let i = 0; i < y.length; i++) { p += hz / FS; if (p >= 1) p -= 1; y[i] = wave === 'saw' ? 2 * p - 1 : p < 0.5 ? 1 : -1; }
    return foldBack(y, hz);
  };
  for (const wave1 of ['saw', 'square']) {
    const clean = foldBack(tone({ wave1 }, { key: 96 }), hz);
    t.diagnostic(`${wave1} at C7: fold-back ${clean.toFixed(1)} dB (naive ${naive(wave1).toFixed(1)} dB)`);
    assert.ok(clean < naive(wave1) - 20 && clean < -35, `${wave1}: ${clean.toFixed(1)} dB against a naive ${naive(wave1).toFixed(1)} dB`);
  }
  // hard sync, the hard case: oscillator 2 restarted mid-cycle, a fifth and a bit above oscillator 1
  const hz1 = keyHz(84);
  const synced = foldBack(tone({ wave1: 'saw', wave2: 'saw', sync: true, semi2: 7.0, fine2: 31, mix: 1 }, { key: 84 }), hz1);
  t.diagnostic(`sync at C6: fold-back ${synced.toFixed(1)} dB`);
  assert.ok(synced < -35, `sync: ${synced.toFixed(1)} dB`);
});

test('analog: hard sync keeps the pitch of oscillator 1 while oscillator 2 moves the tone', () => {
  const sync = (semi2) => tone({ wave1: 'saw', wave2: 'saw', sync: true, semi2, mix: 1 }, { key: 57 });
  const centroid = (y) => { let a = 0; let b = 0; for (let n = 1; n <= 40; n++) { const v = levelAt(y, 220 * n, 9600, 32768) ** 2; a += n * v; b += v; } return a / b; };
  const low = sync(5);
  const high = sync(19);
  // every partial is a harmonic of the note oscillator 1 plays, whatever oscillator 2 is tuned to
  for (const y of [low, high]) assert.ok(foldBack(y, 220) < -40, `only harmonics of 220 Hz: ${foldBack(y, 220).toFixed(1)} dB of anything else`);
  assert.ok(Math.abs(centsFrom(strongest(low, 9600, 32768, 200, 240).hz, 57)) < 1);
  // …and the higher oscillator 2 is tuned, the higher the weight of the spectrum
  assert.ok(centroid(high) > centroid(low) * 1.5, `the centre of the spectrum: harmonic ${centroid(low).toFixed(1)} → ${centroid(high).toFixed(1)}`);
  // without sync the same setting is two notes: a fifth above sounds as itself
  const free = tone({ wave1: 'saw', wave2: 'saw', sync: false, semi2: 7, mix: 1 }, { key: 57 });
  assert.ok(Math.abs(centsFrom(strongest(free, 9600, 32768, 300, 360).hz, 64)) < 1);
  // the envelope sweeps the tone of a synced note: brighter at the start than a second later
  const sweep = note(Analog, { ...RAW, wave1: 'saw', wave2: 'saw', sync: true, mix: 1, env2Pitch: 24, fDecay: 3, fSustain: 0 }, { key: 57, hold: 3.5, seconds: 3.5 }).L;
  const weight = (y, at) => { let a = 0; let b = 0; for (let n = 1; n <= 40; n++) { const v = levelAt(y, 220 * n, at, 4096) ** 2; a += n * v; b += v; } return a / b; };
  assert.ok(weight(sweep, 2400) > weight(sweep, 3 * FS) * 1.3, `the centre of the spectrum falls with the envelope: harmonic ${weight(sweep, 2400).toFixed(1)} → ${weight(sweep, 3 * FS).toFixed(1)}`);
});

test('analog: the ladder is a 24 dB per octave low-pass that sings at its cutoff; the envelope and the keys move it', () => {
  // noise through the filter, cutoff at 1 kHz: two octaves up it is about 48 dB down
  const hiss = (params) => note(Analog, { ...RAW, mix: 0.5, wave1: 'sine', wave2: 'sine', noise: 1, ...params }, { key: 21, hold: 3, seconds: 3 }).L;
  const band = (y, hz) => { let s = 0; for (let f = hz * 0.9; f <= hz * 1.1; f += hz * 0.02) s += levelAt(y, f, 24000, 65536) ** 2; return Math.sqrt(s); };
  const flat = hiss({ cutoff: 20000 });
  const dark = hiss({ cutoff: 1000 });
  const slope = db(band(dark, 4000) / band(flat, 4000)) - db(band(dark, 250) / band(flat, 250));
  assert.ok(slope < -40 && slope > -56, `two octaves above the cutoff: ${slope.toFixed(1)} dB`);
  // resonance: a peak at the cutoff
  const peaky = hiss({ cutoff: 1000, resonance: 0.9 });
  assert.ok(db(band(peaky, 1000) / band(peaky, 250)) > db(band(dark, 1000) / band(dark, 250)) + 12, 'a peak at the cutoff');
  // a plucked filter: the note starts bright and ends dark
  const pluck = note(Analog, { ...RAW, wave1: 'saw', cutoff: 200, envAmount: 5, fDecay: 0.25, fSustain: 0 }, { key: 45, hold: 1.5, seconds: 1.5 }).L;
  const tilt = (y, at) => db(levelAt(y, 110 * 12, at, 4096) / levelAt(y, 110, at, 4096));
  assert.ok(tilt(pluck, 240) > tilt(pluck, 48000) + 20, `harmonic 12: ${tilt(pluck, 240).toFixed(1)} dB at the start, ${tilt(pluck, 48000).toFixed(1)} dB a second in`);
  // key tracking: with it, a note two octaves up is as bright (in harmonics); without, darker
  const h8 = (keyTrack, key) => { const y = note(Analog, { ...RAW, wave1: 'saw', cutoff: 1500, keyTrack }, { key, hold: 1, seconds: 1 }).L; return db(levelAt(y, keyHz(key) * 6, 9600, 16384) / levelAt(y, keyHz(key), 9600, 16384)); };
  assert.ok(Math.abs(h8(1, 72) - h8(1, 48)) < 3, `tracked: ${h8(1, 48).toFixed(1)} and ${h8(1, 72).toFixed(1)} dB`);
  assert.ok(h8(0, 72) < h8(0, 48) - 15, 'untracked: the high note is darker');
});

test('analog: the sub is an octave below, the LFO moves what it is sent to, every preset is a note at a sane level', () => {
  const sub = note(Analog, { ...RAW, wave1: 'sine', sub: 1 }, { key: 57, hold: 1, seconds: 1 }).L;
  assert.ok(levelAt(sub, 110, 9600, 32768) > levelAt(sub, 220, 9600, 32768) * 0.5, 'a partial at half the frequency');
  // vibrato: the pitch swings by the cents asked for, at the rate asked for
  const vib = note(Analog, { ...RAW, wave1: 'sine', lfoPitch: 50, lfoRate: 5 }, { key: 81, hold: 1.5, seconds: 1.5 }).L;
  // (a sine frequency-modulated at 5 Hz has side partials 5 Hz either side)
  assert.ok(levelAt(vib, 885, 9600, 65536) > 0.05 * levelAt(vib, 880, 9600, 65536) || levelAt(vib, 890, 9600, 65536) > 0.05 * levelAt(vib, 880, 9600, 65536));
  // pulse-width modulation: the second harmonic of a square comes and goes (none at a width of ½, the most at ¼)
  const pwm = note(Analog, { ...RAW, wave1: 'square', pw: 0.5, lfoPw: 0.25, lfoRate: 0.25 }, { key: 57, hold: 3, seconds: 3 }).L;
  // (the LFO is a sine that starts with the note: at 1 s the width is ¾, at 2 s it is ½ again)
  const wide = levelAt(pwm, 440, 1 * FS - 1024, 2048);
  const even = levelAt(pwm, 440, 2 * FS - 1024, 2048);
  assert.ok(wide > 4 * even, `the second harmonic: ${wide.toFixed(3)} at a width of ¾, ${even.toFixed(3)} at ½`);
  for (const [name, params] of Object.entries(Analog.presets)) {
    const a = note(Analog, params, { key: 57, velocity: 0.8, hold: 1 });
    const b = note(Analog, params, { key: 57, velocity: 0.8, hold: 1 });
    assert.ok(db(peakOf(a.L)) > -24 && db(peakOf(a.L)) < -6, `${name}: peak ${db(peakOf(a.L)).toFixed(1)} dB`);
    assert.deepEqual(a.L, b.L, `${name}: repeats`);
    assert.ok(a.endedAt !== null, `${name}: ends`);
    // full velocity, the highest and the lowest notes: nothing clips
    for (const key of [28, 100]) assert.ok(peakOf(note(Analog, params, { key, velocity: 1, hold: 0.5 }).L) < 1, `${name}, key ${key}`);
  }
  assert.ok(rmsOf(note(Analog, {}, { key: 57 }).L) > 1e-3);
});
