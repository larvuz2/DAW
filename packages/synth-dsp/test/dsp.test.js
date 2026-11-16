// Signal-quality tests of the GGS Synth engine. These measure the audio (spectra, tuning, levels) instead of
// trusting the design: an oversampling switch that doesn't lower aliasing would fail here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPatch, GgsVoice, GgsFx, WAVETABLE_IDS, getWavetable, tableLevel, levelFor, levelHarmonics, LEVELS, FRAME, STRIDE,
  describeWavetables, wavetablePreview, wavetableSpectrum, halfbandCoefs, Decimator2, fft, completeParams, ggsDefaults,
  GGS_PARAMS, releaseTail, needsOversampling, syncBeats, MOD_SOURCES, MOD_TARGETS
} from '../src/index.js';

const freq = (key) => 440 * Math.pow(2, (key - 69) / 12);
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/** Magnitude spectrum of n samples from `start` (Blackman-Harris: side lobes at -92 dB). */
function spectrum(x, start, n) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / (n - 1);
    re[i] = x[start + i] * (0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a));
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** Strongest component that is NOT a harmonic of f0 (dB below the strongest harmonic), and the peak frequency. */
function purity(x, fs, f0, n = 32768, start = 8192) {
  const mag = spectrum(x, start, n);
  const bin = fs / n;
  let top = 0;
  let pk = 1;
  for (let i = 2; i < n / 2 - 1; i++) if (mag[i] > top) { top = mag[i]; pk = i; }
  let worst = 0;
  for (let i = 8; i < n / 2; i++) {
    const f = i * bin;
    const h = Math.round(f / f0);
    if (h >= 1 && Math.abs(f - h * f0) < bin * 6) continue;
    if (mag[i] > worst) worst = mag[i];
  }
  const [a, b, c] = [Math.log(mag[pk - 1]), Math.log(mag[pk]), Math.log(mag[pk + 1])];
  return { worstDb: db(worst / top), peakHz: (pk + (0.5 * (a - c)) / (a - 2 * b + c)) * bin };
}

/** Level (dB re the strongest bin) of the component nearest to `hz`. */
function levelAt(mag, fs, hz) {
  const bin = fs / (mag.length * 2);
  let top = 0;
  for (const m of mag) if (m > top) top = m;
  const i = Math.round(hz / bin);
  let v = 0;
  for (let k = i - 3; k <= i + 3; k++) v = Math.max(v, mag[k] || 0);
  return db(v / top);
}

const voiceOnly = (params, notes, opts = {}) => renderPatch({ params: { oscARand: 0, oscBRand: 0, oscCRand: 0, ...params }, notes, fx: false, ...opts });

test('every wavetable builds: finite, levelled, band-limited copies', () => {
  assert.ok(WAVETABLE_IDS.length >= 20);
  assert.equal(describeWavetables().length, WAVETABLE_IDS.length);
  for (const id of WAVETABLE_IDS) {
    const t = getWavetable(id);
    const full = tableLevel(t, 0);
    assert.equal(full.length, t.frames * STRIDE);
    for (let f = 0; f < t.frames; f++) {
      let peak = 0;
      let sq = 0;
      for (let n = 0; n < FRAME; n++) {
        const v = full[f * STRIDE + 1 + n];
        assert.ok(Number.isFinite(v), `${id} frame ${f}`);
        peak = Math.max(peak, Math.abs(v));
        sq += v * v;
      }
      const rms = Math.sqrt(sq / FRAME);
      assert.ok(peak <= 1.0001, `${id} frame ${f} peak ${peak}`);
      assert.ok(rms > 0.05 && rms < 0.34, `${id} frame ${f} rms ${rms}`);
      // the padding repeats the cycle, so a 4-point read never sees a seam
      assert.equal(full[f * STRIDE], full[f * STRIDE + FRAME]);
      assert.equal(full[f * STRIDE + 1 + FRAME], full[f * STRIDE + 1]);
    }
    assert.equal(wavetablePreview(id, 0.5, 64).length, 64);
    const spec = wavetableSpectrum(id, 0.3, 32);
    assert.ok(Math.max(...spec) <= 1.0001 && Math.max(...spec) > 0.999);
  }
  assert.equal(getWavetable('nope').id, 'basic', 'an unknown table falls back instead of failing');
});

test('a mip level never holds a harmonic above Nyquist for the pitches that read it', () => {
  for (let l = 1; l < LEVELS; l++) assert.ok(levelHarmonics(l) <= levelHarmonics(l - 1));
  for (const inc of [1e-5, 0.0003, 0.001, 0.01, 0.02, 0.1, 0.2, 0.3, 0.45]) {
    const l = levelFor(inc);
    assert.ok(levelHarmonics(l) * inc <= 0.5 || l === LEVELS - 1, `inc ${inc}: ${levelHarmonics(l)} harmonics`);
    // and it is the richest such copy: the one above would cross Nyquist
    if (l > 0) assert.ok(levelHarmonics(l - 1) * inc > 0.5, `inc ${inc} could have used a brighter copy`);
  }
  // the highest harmonic of a level really is absent from the level below it
  const t = getWavetable('basic');
  const data = tableLevel(t, 12); // 32 harmonics
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let n = 0; n < FRAME; n++) re[n] = data[2 * STRIDE + 1 + n]; // the saw frame
  fft(re, im);
  assert.ok(Math.hypot(re[32], im[32]) > 1, 'harmonic 32 is there');
  assert.ok(Math.hypot(re[33], im[33]) < 1e-3, 'harmonic 33 is not');
});

test('half-band filter: flat pass band, > 80 dB rejection', () => {
  const coefs = halfbandCoefs(6, 0.08);
  const gain = (f) => {
    const d = new Decimator2(coefs);
    const n = 8192;
    const inL = new Float64Array(2 * n);
    const out = new Float64Array(n);
    for (let i = 0; i < 2 * n; i++) inL[i] = Math.sin((2 * Math.PI * f * i) / 88200);
    d.process(inL, inL, out, new Float64Array(n), n);
    let pk = 0;
    for (let i = n / 2; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
    return db(pk);
  };
  for (const f of [100, 5000, 15000, 18000]) assert.ok(Math.abs(gain(f)) < 0.05, `${f} Hz: ${gain(f)} dB`);
  for (const f of [25700, 30000, 40000]) assert.ok(gain(f) < -80, `${f} Hz: ${gain(f)} dB`);
});

test('tuning: within a tenth of a cent across the keyboard', () => {
  for (const key of [33, 57, 69, 81, 93]) {
    const r = voiceOnly({ oscAPos: 0 }, [{ key, duration: 2 }], { seconds: 1.2 });
    const cents = 1200 * Math.log2(purity(r.channels[0], 44100, freq(key)).peakHz / freq(key));
    assert.ok(Math.abs(cents) < 0.1, `key ${key}: ${cents} cents`);
  }
});

test('oscillators do not alias: a saw has nothing but harmonics, at every rate and quality', () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    for (const quality of ['eco', 'high']) {
      for (const key of [60, 84, 96, 108]) {
        const r = voiceOnly({ quality }, [{ key, duration: 2 }], { seconds: 1.2, sampleRate });
        const { worstDb } = purity(r.channels[0], sampleRate, freq(key));
        assert.ok(worstDb < -80, `${sampleRate} Hz ${quality} key ${key}: ${worstDb.toFixed(1)} dB`);
      }
    }
  }
});

test('oversampling lowers the aliasing of patches that make new harmonics (measured, not assumed)', () => {
  const cases = {
    sync: { oscAWarp: 'sync', oscAWarpAmt: 0.6 },
    'driven resonant filter': { f1Cutoff: 2000, f1Res: 0.9, f1Drive: 0.6 },
    pwm: { oscAWarp: 'pwm', oscAWarpAmt: 0.7, oscAPos: 0.75 }
  };
  for (const [name, params] of Object.entries(cases)) {
    const worst = (quality) => purity(voiceOnly({ ...params, quality }, [{ key: 84, duration: 2 }], { seconds: 1.2 }).channels[0], 44100, freq(84)).worstDb;
    const eco = worst('eco');
    const high = worst('high');
    assert.ok(high < eco - 8, `${name}: eco ${eco.toFixed(1)} dB, high ${high.toFixed(1)} dB`);
    assert.equal(worst('auto'), high, `${name}: "auto" oversamples it`);
  }
  // "auto" spends the CPU only where it helps
  const os = (params) => new GgsVoice({ sampleRate: 48000, params }).os;
  assert.equal(os({}), 1);
  assert.equal(os({ quality: 'high' }), 2);
  assert.equal(os({ oscAWarp: 'fold' }), 2);
  assert.equal(os({ oscBFmFrom: 'A' }), 1, 'an oscillator that is off does not count');
  assert.equal(os({ oscBOn: true, oscBFmFrom: 'A' }), 2);
  assert.equal(os({ mod1Src: 'pressure', mod1Dst: 'f1Drive', mod1Amt: 0.5 }), 2);
  assert.equal(new GgsVoice({ sampleRate: 96000, params: { quality: 'high' } }).os, 1, 'no oversampling above 80 kHz');
  assert.equal(needsOversampling(completeParams({})), false);
});

test('per-note expression: bending one note of a chord leaves the others alone', () => {
  const notes = (bendE) => [
    { key: 60, duration: 2, seed: 1 },
    { key: 64, duration: 2, seed: 2, pitch: bendE ? [{ t: 0, v: 0 }, { t: 0.1, v: 1 }] : null },
    { key: 67, duration: 2, seed: 3 }
  ];
  const fs = 44100;
  const plain = spectrum(voiceOnly({ oscAPos: 0 }, notes(false), { seconds: 1.3 }).channels[0], 16384, 32768);
  const bent = spectrum(voiceOnly({ oscAPos: 0 }, notes(true), { seconds: 1.3 }).channels[0], 16384, 32768);
  assert.ok(levelAt(plain, fs, freq(64)) > -6, 'E4 sounds in the plain chord');
  assert.ok(levelAt(bent, fs, freq(64)) < -60, 'E4 is gone once it is bent');
  assert.ok(levelAt(bent, fs, freq(65)) > -6, 'it sounds a semitone higher');
  assert.ok(levelAt(bent, fs, freq(60)) > -6 && levelAt(bent, fs, freq(67)) > -6, 'C4 and G4 did not move');
});

test('voices are independent: a chord is exactly the sum of its notes, each with its own pressure and slide', () => {
  const params = {
    oscAUnison: 3, f1Cutoff: 900, f1Res: 0.4, noiseLevel: 0.1,
    mod1Src: 'pressure', mod1Dst: 'f1Cutoff', mod1Amt: 0.4, mod2Src: 'timbre', mod2Dst: 'oscAPos', mod2Amt: 0.5,
    mod3Src: 'pressure', mod3Dst: 'level', mod3Amt: -0.4, mod4Src: 'lfo1', mod4Dst: 'pitchFine', mod4Amt: 0.3
  };
  const a = { key: 55, duration: 0.5, seed: 11, pressure: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] };
  const b = { key: 62, start: 0.05, duration: 0.5, seed: 22, timbre: [{ t: 0, v: 1 }, { t: 0.3, v: 0 }], pitch: [{ t: 0, v: -2 }, { t: 0.2, v: 0 }] };
  const c = { key: 70, start: 0.1, duration: 0.4, seed: 33 };
  const run = (notes) => renderPatch({ params, notes, fx: false, seconds: 0.9 }).channels;
  const all = run([a, b, c]);
  const parts = [run([a]), run([b]), run([c])];
  let maxDiff = 0;
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < all[ch].length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(all[ch][i] - (parts[0][ch][i] + parts[1][ch][i] + parts[2][ch][i])));
      peak = Math.max(peak, Math.abs(all[ch][i]));
    }
  }
  assert.ok(peak > 0.05);
  assert.ok(maxDiff < 1e-6, `chord differs from the sum of its notes by ${maxDiff}`);
  // and the pressure really did something to its own note
  const flat = run([{ ...a, pressure: null }]);
  let changed = 0;
  for (let i = 0; i < flat[0].length; i++) changed = Math.max(changed, Math.abs(flat[0][i] - parts[0][0][i]));
  assert.ok(changed > 0.01);
});

test('renders repeat exactly (seeded randomness), and the seed matters', () => {
  const params = { oscAUnison: 5, noiseLevel: 0.3, lfo1Shape: 'sh', lfo1Rate: 12, mod1Src: 'lfo1', mod1Dst: 'oscAPos', mod1Amt: 0.5, mod2Src: 'random', mod2Dst: 'pan', mod2Amt: 1, reverbMix: 0.4, chorusMix: 0.4, delayMix: 0.3 };
  const run = (seed) => renderPatch({ params, notes: [{ key: 60, duration: 0.4, seed }, { key: 67, start: 0.1, duration: 0.4, seed: seed + 1 }], seconds: 1 }).channels;
  const one = run(7);
  const two = run(7);
  assert.deepEqual(one[0], two[0]);
  assert.deepEqual(one[1], two[1]);
  const other = run(8);
  let diff = 0;
  for (let i = 0; i < one[0].length; i++) diff = Math.max(diff, Math.abs(one[0][i] - other[0][i]));
  assert.ok(diff > 0.01, 'another seed gives another take');
});

test('no clicks at note edges and no zipper noise while a control moves', () => {
  // note on/off: the fastest envelope still ramps (a click would be a jump of the full amplitude)
  const fast = voiceOnly({ oscAPos: 0, env1A: 0.001, env1R: 0.005, gain: 1, velSens: 0 }, [{ key: 45, start: 0.01, duration: 0.2 }], { seconds: 0.4 }).channels[0];
  let jump = 0;
  for (let i = 1; i < fast.length; i++) jump = Math.max(jump, Math.abs(fast[i] - fast[i - 1]));
  assert.ok(jump < 0.06, `largest sample-to-sample jump ${jump}`);
  // a filter sweep driven by the slide curve: stepping once per control block would put a tone at the control
  // rate (sampleRate / 16) into the output
  const fs = 44100;
  const sweep = [];
  for (let i = 0; i <= 12; i++) sweep.push({ t: i * 0.1, v: i % 2 });
  const out = voiceOnly({ oscAPos: 0, f1Type: 'lp12', f1Cutoff: 300, f1Res: 0.6, mod1Src: 'timbre', mod1Dst: 'f1Cutoff', mod1Amt: 0.45, mod2Src: 'pressure', mod2Dst: 'level', mod2Amt: -0.8 },
    [{ key: 45, duration: 2, timbre: sweep, pressure: sweep }], { seconds: 1.3 }).channels[0];
  const mag = spectrum(out, 8192, 32768);
  for (const mult of [1, 2, 3]) {
    const zipper = levelAt(mag, fs, (fs / 16) * mult);
    assert.ok(zipper < -75, `control-rate tone ×${mult}: ${zipper.toFixed(1)} dB`);
  }
});

test('envelopes: sustain, release and the promised tail length', () => {
  const fs = 48000;
  const params = { env1A: 0.01, env1D: 0.05, env1S: 0.5, env1R: 0.2, oscAPos: 0, velSens: 0, oscARand: 0 };
  const v = new GgsVoice({ sampleRate: fs, params, key: 69, velocity: 1, seed: 1 });
  const L = new Float32Array(fs);
  const R = new Float32Array(fs);
  const ctl = { pitch: 0, pressure: 0, timbre: 0, macros: null, time: 0 };
  v.process(L, R, 0, fs * 0.3, ctl);
  const peakOf = (from, to) => { let p = 0; for (let i = Math.round(from * fs); i < Math.round(to * fs); i++) p = Math.max(p, Math.abs(L[i])); return p; };
  const attack = peakOf(0.005, 0.02);
  const sustain = peakOf(0.2, 0.3);
  assert.ok(Math.abs(sustain / attack - 0.5) < 0.06, `sustain is half the peak (${sustain / attack})`);
  assert.equal(v.finished, false);
  v.noteOff(0.5);
  v.process(L, R, fs * 0.3, Math.ceil(releaseTail(params) * fs), ctl);
  assert.equal(v.finished, true, 'finished within releaseTail()');
  assert.equal(peakOf(0.3 + 0.21, 0.3 + 0.22), 0, 'silent after the release');
  // release velocity: a fast release (1) is shorter, a slow one (0) longer
  const tail = (rv) => {
    const vv = new GgsVoice({ sampleRate: fs, params: { ...params, relVelSens: 1 }, key: 69, seed: 1 });
    const l = new Float32Array(fs * 2);
    vv.process(l, new Float32Array(fs * 2), 0, 4800, ctl);
    vv.noteOff(rv);
    let n = 0;
    while (!vv.finished && n < fs) { vv.process(l, R, 0, 128, ctl); n += 128; }
    return n / fs;
  };
  assert.ok(tail(1) < 0.08 && tail(0) > 0.7, `release ${tail(1)}s … ${tail(0)}s`);
  assert.ok(releaseTail({ ...params, relVelSens: 1 }, 0) >= tail(0));
  // a pluck (sustain 0) finishes by itself: it never idles silently waiting for its note-off
  const pluck = new GgsVoice({ sampleRate: fs, params: { env1D: 0.05, env1S: 0 }, key: 60, seed: 1 });
  pluck.process(new Float32Array(fs), new Float32Array(fs), 0, fs * 0.1, ctl);
  assert.equal(pluck.finished, true);
});

test('mono glide starts from the previous pitch; legato keeps the envelope open', () => {
  const fs = 44100;
  const glide = renderPatch({ params: { oscAPos: 0, oscARand: 0, mono: true, legato: true, glide: 0.3, env1A: 0.2 }, notes: [{ key: 57, duration: 0.6 }, { key: 69, start: 0.5, duration: 1 }], fx: false, seconds: 1.5 }).channels[0];
  // right after the second note starts the pitch is still near A3, not A4
  const early = purity(glide, fs, 220, 2048, Math.round(0.51 * fs)).peakHz;
  const late = purity(glide, fs, 440, 8192, Math.round(1.0 * fs)).peakHz;
  assert.ok(early < 300, `glide starts low (${early} Hz)`);
  assert.ok(Math.abs(late - 440) < 2, `and arrives (${late} Hz)`);
  // legato: no new 200 ms attack on the second note — it is already loud 20 ms in
  let level = 0;
  for (let i = Math.round(0.52 * fs); i < Math.round(0.54 * fs); i++) level = Math.max(level, Math.abs(glide[i]));
  assert.ok(level > 0.1, `legato note is at full level at once (${level})`);
});

test('effects: silent in, silent out; tails end; level does not depend on reverb size', () => {
  const fs = 48000;
  const fx = new GgsFx({ sampleRate: fs, params: { reverbMix: 0.5, delayMix: 0.4, chorusMix: 0.5, driveAmt: 0.5, driveType: 'tube' }, bpm: 120 });
  const n = fs;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  fx.process(L, R, L, R, n);
  assert.ok(L.every((v) => v === 0), 'nothing in, nothing out');
  assert.equal(fx.idle, true);
  for (let i = 0; i < 2400; i++) L[i] = R[i] = Math.sin(i * 0.05) * 0.5;
  fx.process(L, R, L, R, n);
  assert.equal(fx.idle, false);
  let tail = 0;
  for (let i = fs / 2; i < n; i++) tail = Math.max(tail, Math.abs(L[i]));
  assert.ok(tail > 1e-4, 'the delay and reverb ring on after the input stops');
  assert.ok(L.every(Number.isFinite));
  // it comes to rest once the tail is over
  const quiet = new Float32Array(fs);
  for (let s = 0; s < 60 && !fx.idle; s++) { quiet.fill(0); fx.process(quiet, quiet.slice(), quiet, new Float32Array(fs), fs); }
  assert.equal(fx.idle, true);
  // steady sound through 100% reverb: about as loud as it went in, in a room and in a hall
  for (const size of [0, 0.5, 1]) {
    const rv = new GgsFx({ sampleRate: fs, params: { reverbMix: 1, reverbSize: size, gain: 1 } });
    const len = fs * 14;
    const a = new Float32Array(len);
    const b = new Float32Array(len);
    let s = 1;
    for (let i = 0; i < len; i++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; a[i] = b[i] = (s / 2147483648) * 0.25; }
    let inSq = 0;
    for (let i = len - fs; i < len; i++) inSq += a[i] * a[i];
    rv.process(a, b, a, b, len);
    let outSq = 0;
    for (let i = len - fs; i < len; i++) outSq += a[i] * a[i];
    const gain = 10 * Math.log10(outSq / inSq);
    assert.ok(Math.abs(gain) < 6, `reverb size ${size}: ${gain.toFixed(1)} dB`);
  }
  // tempo-synced delay: an impulse comes back after exactly a dotted eighth
  const dl = new GgsFx({ sampleRate: fs, params: { delayMix: 1, delaySync: '1/8d', delayFb: 0, delayPing: false, gain: 1 }, bpm: 120 });
  const x = new Float32Array(fs);
  const y = new Float32Array(fs);
  x[0] = y[0] = 1;
  dl.process(x, y, x, y, fs);
  let at = 0;
  for (let i = 100; i < fs; i++) if (Math.abs(x[i]) > Math.abs(x[at] || 0) || at === 0) at = Math.abs(x[i]) > 0.2 && !at ? i : at;
  assert.ok(Math.abs(at - 0.375 * fs) < 3, `echo after ${at / fs}s (expected 0.375)`);
  assert.equal(syncBeats('1/8d'), 0.75);
  assert.equal(syncBeats('2bar'), 8);
  assert.equal(syncBeats('1/4t'), 2 / 3);
});

test('damaged or partial params never break a voice', () => {
  const p = completeParams({ oscAPos: 'x', f1Cutoff: 1e9, oscATable: 'nope', mono: 'yes', mod1Src: 'lfo9', env1A: -3, junk: 1, polyphony: NaN });
  const d = ggsDefaults();
  assert.equal(p.oscAPos, d.oscAPos);
  assert.equal(p.f1Cutoff, 20000);
  assert.equal(p.oscATable, 'basic');
  assert.equal(p.mono, false);
  assert.equal(p.mod1Src, 'none');
  assert.equal(p.env1A, 0.001);
  assert.equal(p.polyphony, d.polyphony);
  assert.equal(p.junk, undefined);
  assert.equal(Object.keys(p).length, GGS_PARAMS.length);
  const extreme = Object.fromEntries(GGS_PARAMS.filter((x) => x.type === 'number').map((x) => [x.key, x.max]));
  for (const params of [extreme, { ...extreme, f1Type: 'comb', f2On: true, f2Type: 'comb', oscAWarp: 'fold', oscBOn: true, oscBFmFrom: 'A', oscAFmFrom: 'B', oscCOn: true, oscCFmFrom: 'C', oscCWarp: 'sync' }]) {
    const r = renderPatch({ params: { ...params, polyphony: 4, env1A: 0.01, env1D: 0.1, env1R: 0.1, lfo1Rate: 7, delayTime: 200, mod1Src: 'lfo1', mod1Dst: 'f1Cutoff', mod1Amt: 1, mod2Src: 'pressure', mod2Dst: 'pitch', mod2Amt: 1 }, notes: [{ key: 30, duration: 0.2, pressure: [{ t: 0, v: 0 }, { t: 0.2, v: 1 }] }, { key: 110, start: 0.05, duration: 0.2 }], seconds: 0.5 });
    assert.ok(r.channels[0].every(Number.isFinite) && r.channels[1].every(Number.isFinite), 'finite output at the limits');
  }
  assert.ok(MOD_SOURCES.length === 20 && MOD_TARGETS.includes('f1Cutoff') && MOD_TARGETS.includes('oscCDetune'));
});

test('review fixes: silent noise still modulates, long echoes are not cut, tables can be built ahead', async () => {
  const { prewarmTables } = await import('../src/engine.js');
  // noise as an FM source with its level at zero: the oscillator is modulated (it used to be bit-identical to FM off)
  const run = (params) => voiceOnly({ oscAPos: 0, ...params }, [{ key: 60, duration: 0.3, seed: 5 }], { seconds: 0.4 }).channels[0];
  const clean = run({});
  const noisy = run({ oscAFmFrom: 'noise', oscAFm: 0.5, noiseLevel: 0 });
  let diff = 0;
  for (let i = 0; i < clean.length; i++) diff = Math.max(diff, Math.abs(clean[i] - noisy[i]));
  assert.ok(diff > 0.05, `noise FM changes the sound (${diff})`);
  assert.equal(new GgsVoice({ sampleRate: 48000, params: { oscAFmFrom: 'noise', oscAFm: 0.5 } }).os, 2);
  // a long feedback delay rings until it is inaudible: 25 s after the input stopped it is still being processed
  const fs = 24000;
  const fx = new GgsFx({ sampleRate: fs, params: { delayMix: 1, delaySync: 'free', delayTime: 500, delayFb: 0.95, delayPing: false, gain: 1 }, bpm: 120 });
  const a = new Float32Array(fs);
  const b = new Float32Array(fs);
  for (let i = 0; i < 2000; i++) a[i] = b[i] = Math.sin(i * 0.2) * 0.5;
  fx.process(a, b, a, b, fs);
  let peak = 0;
  for (let s = 0; s < 25; s++) {
    a.fill(0); b.fill(0);
    fx.process(a, b, a, b, fs);
    peak = 0;
    for (let i = 0; i < fs; i++) peak = Math.max(peak, Math.abs(a[i]));
  }
  assert.equal(fx.idle, false);
  assert.ok(peak > 0.01, `the echo is still there after 25 s (${peak})`);
  // … and it does come to rest, by itself, once it has faded (-114 dBFS: about 250 more echoes)
  for (let s = 0; s < 200 && !fx.idle; s++) { a.fill(0); b.fill(0); fx.process(a, b, a, b, fs); }
  assert.equal(fx.idle, true);
  // the channel builds its tables before the first note (and shrugs at junk)
  prewarmTables({ oscATable: 'sync', oscBTable: 'nope', oscCTable: 7 });
  prewarmTables(null);
  assert.ok(getWavetable('sync').spectra.length > 1);
});
