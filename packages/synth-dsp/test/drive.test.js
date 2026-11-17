// The channel drive at 2, 4 and 8 times the sample rate: what folds back into the audible band, measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch, GgsFx, completeParams, fft } from '../src/index.js';
import { FS, db, peakOf, spectrum, sine } from './fx-helpers.js';

/** A sine through the drive alone: [L]. */
function driven(hz, params, seconds = 1.5) {
  const fx = new GgsFx({ sampleRate: FS, params: completeParams({ driveAmt: 0.8, ...params }) });
  const x = sine(hz, 0.5, seconds);
  const outL = new Float32Array(x.length);
  const outR = new Float32Array(x.length);
  fx.process(x, x, outL, outR, x.length);
  return outL;
}

/**
 * Power of what folded back under 20 kHz against the power of the harmonics (dB). A folded partial of a tone at `hz`
 * stands at |k × hz − m × fs|: every such place that is not on a harmonic is read, with a window whose skirts are
 * 90 dB down (Blackman–Harris), so that the harmonics themselves do not count as fold-back.
 */
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
  const power = (k) => re[k] * re[k] + im[k] * im[k];
  let harmonic = 0;
  let other = 0;
  for (let k = 16; k < 20000 / binHz; k++) {
    const f = k * binHz;
    const nearest = Math.round(f / hz) * hz;
    if (nearest > 0 && Math.abs(f - nearest) < 8 * binHz) harmonic += power(k);
    else other += power(k);
  }
  return 10 * Math.log10(other / harmonic);
}

test('drive: each doubling of its rate pushes the fold-back down, for every shape', (t) => {
  // 3001 Hz: its harmonics do not land on each other once folded, so what folds is told apart from what belongs
  for (const driveType of ['soft', 'hard', 'tube', 'fold']) {
    const [x2, x4, x8] = ['2x', '4x', '8x'].map((driveOs) => foldBack(driven(3001, { driveType, driveOs }), 3001));
    t.diagnostic(`${driveType}: fold-back ${x2.toFixed(1)} dB at 2×, ${x4.toFixed(1)} dB at 4×, ${x8.toFixed(1)} dB at 8×`);
    // (measured: soft −46 → −89 → −92 dB, hard −42 → −54 → −66, tube −47 → −63 → −77; fold is clean from the start)
    assert.ok(x4 < x2 + 0.5 && x8 < x4 + 0.5, `${driveType}: never worse at a higher rate`);
    if (driveType !== 'fold') assert.ok(x4 < x2 - 10, `${driveType}: 4× is at least 10 dB cleaner than 2× (${x4.toFixed(1)} against ${x2.toFixed(1)} dB)`);
    if (driveType === 'hard' || driveType === 'tube') assert.ok(x8 < x4 - 8, `${driveType}: 8× is cleaner again (${x8.toFixed(1)} against ${x4.toFixed(1)} dB)`);
  }
});

test('drive: the rate changes what folds back and nothing else — the same level, the same harmonics, no latency worth a note', () => {
  const at = (y, hz) => { const { mag, binHz } = spectrum(y, 9600, 32768); let m = 0; for (let k = Math.round(hz / binHz) - 3; k <= Math.round(hz / binHz) + 3; k++) m = Math.max(m, mag[k]); return m; };
  const [y2, y4, y8] = ['2x', '4x', '8x'].map((driveOs) => driven(440, { driveType: 'soft', driveOs }));
  for (const y of [y4, y8]) {
    for (const h of [1, 3, 5]) assert.ok(Math.abs(db(at(y, 440 * h) / at(y2, 440 * h))) < 0.3, `harmonic ${h}: ${db(at(y, 440 * h) / at(y2, 440 * h)).toFixed(2)} dB`);
    assert.ok(peakOf(y) < 1.2 && y.every(Number.isFinite));
  }
  // in a patch: the setting is a parameter like any other, and "2x" is what patches had before
  const note = (params) => { const r = renderPatch({ params: { driveAmt: 0.7, ...params }, notes: [{ key: 81, velocity: 1, start: 0, duration: 0.4 }], sampleRate: FS, seconds: 0.8 }); return (r.channels || [r.left])[0]; };
  assert.deepEqual(note({ driveOs: '2x' }), note({}));
  assert.notDeepEqual(note({ driveOs: '8x' }), note({}));
  // switched while a sound is held, the extra stages start from rest: nothing louder than the sound itself
  const fx = new GgsFx({ sampleRate: FS, params: completeParams({ driveAmt: 0.8 }) });
  const x = sine(220, 0.5, 1);
  const outL = new Float32Array(x.length);
  const outR = new Float32Array(x.length);
  for (let o = 0; o < x.length; o += 4800) {
    fx.setParams(completeParams({ driveAmt: 0.8, driveOs: ['2x', '8x', '4x'][(o / 4800) % 3] }));
    fx.process(x.subarray(o, o + 4800), x.subarray(o, o + 4800), outL.subarray(o, o + 4800), outR.subarray(o, o + 4800), 4800);
  }
  assert.ok(peakOf(outL) < 1.2 && outL.every(Number.isFinite), `peak ${peakOf(outL)}`);
});
