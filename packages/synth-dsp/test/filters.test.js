// The filter models, measured: responses against what each model promises, self-oscillation tuning, stability under
// abuse, and behaviour inside a voice (determinism, silence, oversampling).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceFilter, filterResponse, filterIsNonlinear, FILTER_TYPES, FILTER_INFO } from '../src/filters.js';
import { renderPatch } from '../src/render.js';
import { needsOversampling, ggsDefaults, MOD_TARGETS } from '../src/params.js';
import { Rng } from '../src/util.js';

const FS = 48000;
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual.toFixed(3)} (expected ${expected} ± ${tol})`);
const resp = (settings, freqs, opts) => Array.from(filterResponse({ cutoff: 1000, resonance: 0, ...settings }, freqs, { sampleRate: FS, ...opts }));

/** Run a filter on its own for `seconds` after one click; returns the left channel. */
function ring(type, settings, seconds = 2, click = 0.01) {
  const f = new VoiceFilter(FS);
  f.setType(type);
  f.set(settings.cutoff ?? 1000, settings.resonance ?? 0, settings.drive ?? 0, settings.morph ?? 0);
  const n = Math.round(FS * seconds / 64) * 64;
  const out = new Float32Array(n);
  const L = new Float32Array(64);
  const R = new Float32Array(64);
  for (let i = 0; i < n; i += 64) {
    L.fill(0); R.fill(0);
    if (i === 0) L[0] = R[0] = click;
    f.process(L, R, 64);
    out.set(L, i);
  }
  return out;
}

/** Frequency (from interpolated zero crossings) and peak of the second half of a signal. */
function pitchOf(x) {
  let count = 0, first = -1, last = -1, peak = 0;
  for (let i = x.length >> 1; i < x.length - 1; i++) {
    if (x[i] <= 0 && x[i + 1] > 0) {
      const t = i + x[i] / (x[i] - x[i + 1]);
      if (first < 0) first = t;
      last = t;
      count++;
    }
    peak = Math.max(peak, Math.abs(x[i]));
  }
  return { hz: count > 1 ? (count - 1) / ((last - first) / FS) : 0, peak };
}
const cents = (hz, ref) => 1200 * Math.log2(hz / ref);

test('the catalogue: 21 types, the original nine first and unchanged, every one described', () => {
  assert.deepEqual(FILTER_TYPES.slice(0, 9), ['lp12', 'lp24', 'hp12', 'hp24', 'bp12', 'bp24', 'notch', 'peak', 'comb']);
  assert.equal(FILTER_TYPES.length, 21);
  for (const id of FILTER_TYPES) {
    const info = FILTER_INFO[id];
    assert.ok(info.label && info.desc.length > 40, `${id} has a label and a description`);
    assert.equal(typeof info.morph, 'string');
  }
  assert.ok(MOD_TARGETS.includes('f1Morph') && MOD_TARGETS.includes('f2Morph'));
  // contiguous groups the voice addresses by index
  assert.equal(MOD_TARGETS.indexOf('f2Cutoff') - MOD_TARGETS.indexOf('f1Cutoff'), 3);
  assert.equal(MOD_TARGETS.indexOf('f2Morph') - MOD_TARGETS.indexOf('f1Morph'), 1);
});

test('clean types are what they were: Butterworth at zero resonance, exact cutoff', () => {
  const [lp12a, lp12b, lp12c] = resp({ type: 'lp12' }, [1000, 4000, 8000]);
  near(lp12a, -3.01, 0.05, 'lp12 at the cutoff');
  near(lp12c - lp12b, -12.9, 1, 'lp12 slope per octave (a little steeper near Nyquist)');
  const [lp24a, lp24b, lp24c] = resp({ type: 'lp24' }, [1000, 2000, 4000]);
  near(lp24a, -3.01, 0.05, 'lp24 at the cutoff');
  near(lp24c - lp24b, -24.5, 1, 'lp24 slope per octave');
  const [hp, hpLow] = resp({ type: 'hp24' }, [1000, 250]);
  near(hp, -3.01, 0.05, 'hp24 at the cutoff');
  near(hpLow, -48.2, 0.5, 'hp24 two octaves down');
  near(resp({ type: 'bp12' }, [1000])[0], 0, 0.05, 'bp12 peak');
  assert.ok(resp({ type: 'notch' }, [1000])[0] < -60, 'notch is deep');
  // resonance: Q = 0.7071·56^res at the cutoff for the 12 dB types
  near(resp({ type: 'lp12', resonance: 0.5 }, [1000])[0], 20 * Math.log10(0.7071 * Math.pow(56, 0.5)), 0.1, 'lp12 resonance peak');
});

test('all-pass is flat; morph is a low-pass at 0, a high-pass at 1 and keeps its peak in between', () => {
  const freqs = [50, 200, 1000, 5000, 15000];
  for (const res of [0, 0.5, 0.9]) for (const db of resp({ type: 'allpass', resonance: res }, freqs)) near(db, 0, 0.01, `all-pass at resonance ${res}`);
  const lp = resp({ type: 'lp12', resonance: 0.4 }, freqs);
  const m0 = resp({ type: 'morph', resonance: 0.4, morph: 0 }, freqs);
  const hp = resp({ type: 'hp12', resonance: 0.4 }, freqs);
  const m1 = resp({ type: 'morph', resonance: 0.4, morph: 1 }, freqs);
  for (let i = 0; i < freqs.length; i++) { near(m0[i], lp[i], 0.01, `morph 0 = lp12 at ${freqs[i]} Hz`); near(m1[i], hp[i], 0.01, `morph 1 = hp12 at ${freqs[i]} Hz`); }
  const q = 20 * Math.log10(0.7071 * Math.pow(56, 0.4));
  for (const morph of [0, 0.2, 0.5, 0.8, 1]) near(resp({ type: 'morph', resonance: 0.4, morph }, [1000])[0], q, 0.05, `peak level at morph ${morph}`);
  // in the middle it is a band-pass: both ends fall away
  const mid = resp({ type: 'morph', resonance: 0.4, morph: 0.5 }, [50, 15000]);
  assert.ok(mid[0] < -20 && mid[1] < -15, 'morph 0.5 is a band-pass');
});

test('ladder: unity pass-band, 24 dB slope, a little bass loss with resonance, self-oscillation in tune', () => {
  const [dc, hi1, hi2] = resp({ type: 'ladder24' }, [30, 4000, 8000]);
  near(dc, 0, 0.1, 'pass-band at zero resonance');
  near(hi2 - hi1, -25, 2, 'slope two to three octaves above the cutoff');
  const bass = resp({ type: 'ladder24', resonance: 0.9 }, [30])[0];
  assert.ok(bass < -3 && bass > -7, `bass at resonance 0.9 is thinned a little, not lost: ${bass.toFixed(2)} dB`);
  // 12 dB tap: half the slope
  const [a, b] = resp({ type: 'ladder12' }, [4000, 8000]);
  near(b - a, -12.5, 1.5, 'ladder12 slope');
  assert.ok(resp({ type: 'ladderHp' }, [50])[0] < -45, 'ladder high-pass removes the lows');
  assert.ok(pitchOf(ring('ladder24', { resonance: 0.85 })).peak < 1e-4, 'no self-oscillation at 0.85');
  for (const cutoff of [110, 1000, 8000]) {
    for (const type of ['ladder24', 'ladder12', 'ladderBp', 'ladderHp']) {
      const { hz, peak } = pitchOf(ring(type, { cutoff, resonance: 1 }));
      near(cents(hz, cutoff), 0, 1, `${type} self-oscillation at ${cutoff} Hz (cents)`);
      assert.ok(peak > 0.2 && peak < 1.2, `${type} oscillates at a usable level (${peak.toFixed(2)})`);
    }
  }
});

test('acid: dark and soft below resonance, squelch at the cutoff, self-oscillates on pitch only at the very top', () => {
  const [dc, mid] = resp({ type: 'acid' }, [20, 250]);
  near(dc, 0, 0.5, 'pass-band');
  assert.ok(mid < -6, `already rolling off two octaves below the cutoff (${mid.toFixed(1)} dB): darker than its cutoff suggests`);
  const peak = resp({ type: 'acid', resonance: 0.9 }, [500, 1000, 2000]);
  assert.ok(peak[1] > peak[0] + 10 && peak[1] > peak[2] + 20, 'resonance peak sits on the cutoff');
  assert.ok(pitchOf(ring('acid', { resonance: 0.93 })).peak < 1e-3, 'no self-oscillation at 0.93');
  for (const cutoff of [200, 1000]) near(cents(pitchOf(ring('acid', { cutoff, resonance: 1 })).hz, cutoff), 0, 2, `acid self-oscillation at ${cutoff} Hz (cents)`);
});

test('MS-20: the bass stays whatever the resonance, and the clipped loop screams a few cents flat', () => {
  for (const res of [0, 0.4, 0.75]) near(resp({ type: 'ms20Lp', resonance: res }, [30])[0], 0, 0.1, `low-pass pass-band at resonance ${res}`);
  for (const res of [0, 0.4, 0.75]) near(resp({ type: 'ms20Hp', resonance: res }, [16000])[0], 0, 0.6, `high-pass pass-band at resonance ${res}`);
  near(resp({ type: 'ms20Lp', resonance: 0.5 }, [1000])[0], 20 * Math.log10(2), 0.1, 'Q = 2 at resonance 0.5');
  assert.ok(pitchOf(ring('ms20Lp', { resonance: 0.8 })).peak < 1e-3, 'no self-oscillation at 0.8');
  const { hz, peak } = pitchOf(ring('ms20Lp', { resonance: 1 }));
  const flat = cents(hz, 1000);
  assert.ok(flat < -2 && flat > -15, `self-oscillation a few cents flat, like the hardware: ${flat.toFixed(1)} ct`);
  assert.ok(peak > 0.2 && peak < 1.5);
  // the resonance ducks under a loud input: the peak is lower for a loud sine than the small-signal response says
  const loud = new VoiceFilter(FS);
  loud.setType('ms20Lp');
  loud.set(1000, 0.75, 0, 0);
  const L = new Float32Array(64), R = new Float32Array(64);
  let peakOut = 0;
  for (let b = 0; b < 400; b++) {
    for (let i = 0; i < 64; i++) L[i] = R[i] = Math.sin((2 * Math.PI * 1000 * (b * 64 + i)) / FS);
    loud.process(L, R, 64);
    if (b > 200) for (let i = 0; i < 64; i++) peakOut = Math.max(peakOut, Math.abs(L[i]));
  }
  const small = Math.pow(10, resp({ type: 'ms20Lp', resonance: 0.75 }, [1000])[0] / 20);
  assert.ok(peakOut < small * 0.5, `a full-scale sine at the cutoff comes out at ${peakOut.toFixed(2)}, not ×${small.toFixed(1)}`);
});

test('formant: the vowels of the table, moved by cutoff and morph', () => {
  const freqs = Array.from({ length: 400 }, (_, i) => 150 * Math.pow(4000 / 150, i / 399));
  const peaks = (settings) => {
    const r = resp({ type: 'formant', ...settings }, freqs);
    const out = [];
    for (let i = 1; i < r.length - 1; i++) if (r[i] > r[i - 1] && r[i] >= r[i + 1] && r[i] > -20) out.push(freqs[i]);
    return out;
  };
  const hasPeak = (list, hz) => list.some((p) => Math.abs(cents(p, hz)) < 40);
  const a = peaks({ morph: 0, resonance: 0.5 });
  assert.ok(hasPeak(a, 650) && hasPeak(a, 1080), `A: formants at 650 and 1080 Hz (found ${a.map(Math.round)})`);
  const i = peaks({ morph: 0.5, resonance: 0.5 });
  assert.ok(hasPeak(i, 290) && hasPeak(i, 1870), `I: formants at 290 and 1870 Hz (found ${i.map(Math.round)})`);
  const u = peaks({ morph: 1, resonance: 0.5 });
  assert.ok(hasPeak(u, 350) && hasPeak(u, 600), `U: formants at 350 and 600 Hz (found ${u.map(Math.round)})`);
  const big = peaks({ morph: 0, resonance: 0.5, cutoff: 500 });
  assert.ok(hasPeak(big, 325) && hasPeak(big, 540), 'cutoff 500 Hz: the same vowel an octave lower');
});

test('phaser: one notch on the cutoff with two stages, six with twelve; resonance sharpens the peaks', () => {
  const freqs = Array.from({ length: 600 }, (_, i) => 40 * Math.pow(18000 / 40, i / 599));
  const notches = (settings) => {
    const r = resp({ type: 'phaser', ...settings }, freqs);
    let count = 0;
    for (let i = 1; i < r.length - 1; i++) if (r[i] < r[i - 1] && r[i] <= r[i + 1] && r[i] < -18) count++;
    return count;
  };
  assert.equal(notches({ morph: 0 }), 1);
  assert.equal(notches({ morph: 0.4 }), 3);
  assert.equal(notches({ morph: 1 }), 6);
  assert.ok(resp({ type: 'phaser', morph: 0 }, [1000])[0] < -60, 'the single notch sits on the cutoff');
  near(resp({ type: 'phaser' }, [20])[0], 0, 0.1, 'unity between the notches without feedback');
  const flat = resp({ type: 'phaser', morph: 1, resonance: 0 }, freqs);
  const sharp = resp({ type: 'phaser', morph: 1, resonance: 0.9 }, freqs);
  assert.ok(Math.max(...sharp) > Math.max(...flat) + 2, 'feedback raises the pass-bands');
});

test('combs: peaks on the harmonics (in tune for any damping), inverted feedback gives the odd set an octave down', () => {
  const peakNear = (settings, hz) => {
    // search ±60 cents around hz for the top of the peak
    const freqs = Array.from({ length: 241 }, (_, i) => hz * Math.pow(2, (i - 120) / 2400));
    const r = resp(settings, freqs, { maxSeconds: 1 });
    let best = 0;
    for (let i = 1; i < r.length; i++) if (r[i] > r[best]) best = i;
    return { cents: cents(freqs[best], hz), db: r[best] };
  };
  for (const morph of [0, 0.5, 1]) {
    const p = peakNear({ type: 'comb', cutoff: 220, resonance: 0.8, morph }, 220);
    near(p.cents, 0, 1.5, `comb fundamental at damping ${morph} (cents)`);
    assert.ok(p.db > (morph < 1 ? 10 : 4), `a real peak at damping ${morph} (${p.db.toFixed(1)} dB)`);
  }
  near(peakNear({ type: 'comb', cutoff: 220, resonance: 0.8 }, 440).cents, 0, 1.5, 'second harmonic');
  // damping takes the upper harmonics away and leaves the fundamental
  const bright = resp({ type: 'comb', cutoff: 220, resonance: 0.8, morph: 0 }, [220, 2200], { maxSeconds: 1 });
  const dull = resp({ type: 'comb', cutoff: 220, resonance: 0.8, morph: 1 }, [220, 2200], { maxSeconds: 1 });
  assert.ok(bright[1] - dull[1] > bright[0] - dull[0] + 10, 'morph damps the upper harmonics far more than the fundamental');
  for (const k of [0.5, 1.5]) near(peakNear({ type: 'combNeg', cutoff: 220, resonance: 0.8 }, 220 * k).cents, 0, 1.5, `comb − peak at ${k}× the cutoff`);
  assert.ok(resp({ type: 'combNeg', cutoff: 220, resonance: 0.8 }, [220], { maxSeconds: 1 })[0] < -10, 'comb − has a notch where comb + has its peak');
  // ring time grows with resonance
  const energyAfter = (res) => { const x = ring('comb', { cutoff: 220, resonance: res }, 1.5, 0.5); let e = 0; for (let i = FS; i < x.length; i++) e += x[i] * x[i]; return e; };
  assert.ok(energyAfter(1) > energyAfter(0.6) * 1000, 'a comb at full resonance still rings after a second');
});

test('every model survives abuse: full-scale noise, wild sweeps of every control, both sample rates', () => {
  for (const fs of [44100, 96000]) {
    const rng = new Rng(11);
    for (const type of FILTER_TYPES) {
      const f = new VoiceFilter(fs);
      f.setType(type);
      const L = new Float32Array(32), R = new Float32Array(32);
      let peak = 0;
      for (let b = 0; b < 3000; b++) {
        for (let i = 0; i < 32; i++) { L[i] = rng.next() * 2; R[i] = rng.next() * 2; }
        f.set(10 * Math.pow(4000, rng.unit()), rng.unit(), rng.unit() < 0.5 ? 0 : rng.unit(), rng.unit());
        f.process(L, R, 32);
        for (let i = 0; i < 32; i++) {
          assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${type} at ${fs} Hz stays finite`);
          peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
        }
      }
      assert.ok(peak < 40, `${type} at ${fs} Hz stays bounded (peak ${peak.toFixed(1)})`);
    }
  }
});

test('silence in, silence out — and the memory really reaches zero (no denormals left to slow the CPU)', () => {
  for (const type of FILTER_TYPES) {
    const f = new VoiceFilter(FS);
    f.setType(type);
    f.set(800, 0.6, 0.3, 0.5); // below every self-oscillation threshold
    const L = new Float32Array(64), R = new Float32Array(64);
    for (let b = 0; b < 40; b++) {
      for (let i = 0; i < 64; i++) L[i] = R[i] = Math.sin(i * 0.3 + b);
      f.process(L, R, 64);
    }
    let last = 1;
    for (let b = 0; b < 30000 && last > 0; b++) {
      L.fill(0); R.fill(0);
      f.process(L, R, 64);
      last = 0;
      for (let i = 0; i < 64; i++) last = Math.max(last, Math.abs(L[i]), Math.abs(R[i]));
    }
    assert.equal(last, 0, `${type} falls completely silent`);
    for (const v of f.s) assert.equal(v, 0, `${type} state is flushed`);
  }
});

test('in a voice: every type renders, repeats exactly, follows key tracking, and analog types are oversampled', () => {
  for (const type of FILTER_TYPES) {
    const params = { ...ggsDefaults(), oscATable: 'basic', oscAPos: 0.66, f1Type: type, f1Cutoff: 900, f1Res: 0.5, f1Morph: 0.3, f1Key: 0.5 };
    const notes = [{ key: 48, start: 0, duration: 0.25, seed: 5 }, { key: 67, start: 0.05, duration: 0.2, seed: 6 }];
    const a = renderPatch({ params, notes, seconds: 0.5, fx: false }).channels[0];
    const b = renderPatch({ params, notes, seconds: 0.5, fx: false }).channels[0];
    let peak = 0;
    for (let i = 0; i < a.length; i++) {
      assert.ok(Number.isFinite(a[i]), `${type} renders finite audio`);
      assert.equal(a[i], b[i], `${type} renders repeat exactly`);
      peak = Math.max(peak, Math.abs(a[i]));
    }
    assert.ok(peak > 0.01 && peak < 8, `${type} is audible and sane (peak ${peak.toFixed(2)})`);
    assert.equal(needsOversampling(params), filterIsNonlinear(type), `${type}: oversampling follows the model`);
  }
  assert.deepEqual(FILTER_TYPES.filter(filterIsNonlinear), ['comb', 'ladder24', 'ladder12', 'ladderBp', 'ladderHp', 'acid', 'ms20Lp', 'ms20Hp', 'combNeg']);
});

test('morph can be modulated: slide walks the formant filter through its vowels without zipper noise', () => {
  const params = { ...ggsDefaults(), oscATable: 'basic', oscAPos: 0.66, f1Type: 'formant', f1Cutoff: 1000, f1Res: 0.4, mod1Src: 'timbre', mod1Dst: 'f1Morph', mod1Amt: 1 };
  const still = renderPatch({ params, notes: [{ key: 45, start: 0, duration: 0.9, seed: 3 }], seconds: 1, fx: false }).channels[0];
  const moving = renderPatch({ params, notes: [{ key: 45, start: 0, duration: 0.9, seed: 3, timbre: [{ t: 0, v: 0 }, { t: 0.9, v: 1 }] }], seconds: 1, fx: false }).channels[0];
  let diff = 0, jump = 0;
  for (let i = 4410; i < 35000; i++) { diff = Math.max(diff, Math.abs(still[i] - moving[i])); jump = Math.max(jump, Math.abs(moving[i] - moving[i - 1])); }
  assert.ok(diff > 0.05, 'the vowel changes the sound');
  let ref = 0;
  for (let i = 4410; i < 35000; i++) ref = Math.max(ref, Math.abs(still[i] - still[i - 1]));
  assert.ok(jump < ref * 2.5, `no steps while morphing (largest sample-to-sample move ${jump.toFixed(3)} vs ${ref.toFixed(3)} still)`);
});
