// The studio's DSP effects, measured: what each one promises is checked on its output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_FX, renderEffect } from '../src/index.js';
import { Maximizer } from '../src/effects/index.js';
import { FS, db, peakOf, sine, mixOf, basicChecks, cost } from './fx-helpers.js';

/** The peak of the wave between the samples: 8 points per sample from a long windowed sinc (not the limiter's own). */
function truePeak(x) {
  const HALF = 32;
  let peak = 0;
  for (let i = HALF; i < x.length - HALF; i++) {
    for (let ph = 0; ph < 8; ph++) {
      const frac = ph / 8;
      let y = 0;
      for (let k = -HALF + 1; k <= HALF; k++) {
        const t = k - frac;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / HALF);
        y += x[i + k] * (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
      }
      if (Math.abs(y) > peak) peak = Math.abs(y);
    }
  }
  return peak;
}

test('every studio effect in the registry passes the checks all of them share, at a cost a mix can afford', () => {
  assert.ok(Object.keys(STUDIO_FX).length >= 1);
  for (const [type, Fx] of Object.entries(STUDIO_FX)) {
    assert.equal(Fx.type, type);
    basicChecks(Fx);
    const ms = cost(Fx);
    assert.ok(ms < 150, `${type}: ${ms.toFixed(1)} ms of CPU for a second of audio`);
  }
});

test('maximizer: nothing above the ceiling — not at the samples, and not between them', () => {
  // a mix pushed 12 dB into the limiter: bass, mids, a bright partial, pumping
  const n = FS * 3;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const beat = 0.25 + 0.75 * Math.abs(Math.sin(2 * Math.PI * 1.7 * t));
    L[i] = beat * (0.6 * Math.sin(2 * Math.PI * 55 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t + 1) + 0.25 * Math.sin(2 * Math.PI * 9973 * t));
    R[i] = beat * (0.6 * Math.sin(2 * Math.PI * 55 * t + 0.4) + 0.3 * Math.sin(2 * Math.PI * 554 * t) + 0.25 * Math.sin(2 * Math.PI * 11003 * t));
  }
  for (const ceiling of [-0.1, -1, -6]) {
    const { channels: [yl, yr], meter } = renderEffect('maximizer', { gain: 12, ceiling }, [L, R], FS);
    const c = 10 ** (ceiling / 20);
    assert.ok(peakOf(yl) <= c && peakOf(yr) <= c, `samples at ${ceiling} dB: ${db(peakOf(yl))}`);
    assert.ok(db(Math.max(truePeak(yl), truePeak(yr))) <= ceiling + 0.1, `true peak at ${ceiling} dB: ${db(truePeak(yl))} / ${db(truePeak(yr))}`);
    assert.ok(db(peakOf(yl, FS)) > ceiling - 0.5, 'and it is used: the peaks reach the ceiling');
    assert.ok(meter < -3, `the meter shows the reduction (${meter} dB)`);
  }
});

test('maximizer: the peak between the samples is what "true peak" is for', () => {
  // a sine at a quarter of the sample rate, caught half-way between its crests: every sample is at 0.707, the wave
  // reaches 1.0 — 3 dB above anything a sample shows
  const x = sine(FS / 4, 1, 1, Math.PI / 4);
  assert.ok(Math.abs(peakOf(x) - Math.SQRT1_2) < 1e-3 && Math.abs(truePeak(x) - 1) < 0.01);
  const blind = renderEffect('maximizer', { ceiling: -1, truePeak: false }, [x, x], FS).channels[0];
  assert.ok(db(truePeak(blind.subarray(FS / 2))) > -0.2, `looking at samples only, it passes: ${db(truePeak(blind.subarray(FS / 2)))} dBTP over a −1 dB ceiling`);
  const seen = renderEffect('maximizer', { ceiling: -1, truePeak: true }, [x, x], FS).channels[0];
  assert.ok(db(truePeak(seen.subarray(FS / 2))) <= -0.95, `measured between the samples, it holds: ${db(truePeak(seen.subarray(FS / 2)))} dBTP`);
});

test('maximizer: under the ceiling it is a delay and nothing else; over it, the gain moves without steps', () => {
  const x = mixOf(sine(110, 0.3, 1), sine(1870, 0.2, 1));
  for (const truePeakOn of [true, false]) {
    const { channels: [y], latency, meter } = renderEffect('maximizer', { ceiling: -1, truePeak: truePeakOn }, [x, x], FS);
    assert.equal(latency, Math.round(0.005 * FS) + (truePeakOn ? 6 : 0));
    for (let i = latency; i < x.length; i += 97) assert.equal(y[i], x[i - latency], `sample ${i}`);
    assert.equal(meter, 0);
  }
  assert.equal(renderEffect('maximizer', { lookahead: 10, truePeak: false }, [x, x], FS).latency, 480);
  // a burst 12 dB over: the gain is down before the burst leaves the delay (no sample is clipped: the output is the
  // delayed input times a gain that changes a little per sample)
  const burst = new Float32Array(FS);
  for (let i = FS / 4; i < FS / 2; i++) burst[i] = 2 * Math.sin((2 * Math.PI * 80 * i) / FS);
  const { channels: [z], latency } = renderEffect('maximizer', { ceiling: -6, truePeak: false }, [burst, burst], FS);
  let worstStep = 0;
  let last = null;
  for (let i = FS / 4 + latency; i < FS / 2 + latency; i++) {
    const dry = burst[i - latency];
    if (Math.abs(dry) < 0.2) continue;
    const g = z[i] / dry;
    if (last !== null) worstStep = Math.max(worstStep, Math.abs(g - last.g) / (i - last.i));
    last = { g, i };
  }
  assert.ok(worstStep < 0.01, `gain steps of at most ${worstStep} per sample`);
  assert.ok(peakOf(z) <= 10 ** (-6 / 20));
  // the release: 100 ms after the burst the gain is most of the way back
  const tail = mixOf(burst, Float32Array.from(burst, (_, i) => (i >= FS / 2 ? 0.1 * Math.sin((2 * Math.PI * 1000 * i) / FS) : 0)));
  const quick = renderEffect('maximizer', { ceiling: -6, release: 20, truePeak: false }, [tail, tail], FS).channels[0];
  const slow = renderEffect('maximizer', { ceiling: -6, release: 500, truePeak: false }, [tail, tail], FS).channels[0];
  const at = FS / 2 + latency + Math.round(0.1 * FS);
  assert.ok(peakOf(quick, at, at + 480) > 0.095 && peakOf(slow, at, at + 480) < 0.06, `${peakOf(quick, at, at + 480)} vs ${peakOf(slow, at, at + 480)}`);
});

test('maximizer: the input gain glides, and the same audio gives the same audio', () => {
  const x = sine(200, 0.25, 0.5);
  const fx = new Maximizer(FS);
  const y = Float32Array.from(x);
  fx.process(y.subarray(0, 12000), Float32Array.from(x).subarray(0, 12000), 12000);
  fx.set({ gain: 6 });
  const rest = y.subarray(12000);
  fx.process(rest, Float32Array.from(rest), rest.length);
  let jump = 0;
  for (let i = 12001; i < y.length; i++) jump = Math.max(jump, Math.abs(y[i] - y[i - 1]));
  assert.ok(jump < 0.25 * 2 * Math.sin((Math.PI * 200) / FS) * 2.2, `no click when the gain changes (largest step ${jump})`);
  assert.ok(peakOf(y, 20000) > 0.45, 'and it arrives: 6 dB louder');
  const a = renderEffect('maximizer', { gain: 9 }, [x, x], FS).channels[0];
  const b = renderEffect('maximizer', { gain: 9 }, [x, x], FS).channels[0];
  assert.deepEqual(a, b);
});
