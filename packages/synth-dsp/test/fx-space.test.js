// The space effects — the algorithmic reverb and the shimmer — measured: what each one promises is checked on its
// output. (The classes are imported directly: these tests do not need them to be registered.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlgoVerb } from '../src/effects/algoverb.js';
import { Shimmer } from '../src/effects/shimmer.js';
import { FS, db, peakOf, rmsOf, sine, noise, impulse, toneAt, run, basicChecks, cost } from './fx-helpers.js';

const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/**
 * The decay time of a tail, as acousticians measure it: the energy still to come at every moment (Schroeder's
 * backward integral), and the time it takes to fall from −5 to −35 dB, doubled — seconds per 60 dB.
 */
function rt60(x, fs = FS) {
  const left = new Float64Array(x.length + 1);
  for (let i = x.length - 1; i >= 0; i--) left[i] = left[i + 1] + x[i] * x[i];
  const at = (level) => { const want = left[0] * 10 ** (level / 10); let i = 0; while (i < x.length && left[i] > want) i++; return i / fs; };
  return 2 * (at(-35) - at(-5));
}

/** The reverb's answer to a short burst of noise, wet only. */
function tail(Fx, params, seconds, burst = noise(0.05, 0.5, 11)) {
  const x = new Float32Array(Math.round(seconds * FS));
  x.set(burst);
  return run(Fx, { mix: 1, ...params }, [x, Float32Array.from(x)]).channels;
}

test('space effects: the checks all studio effects share, at a cost a mix can afford', () => {
  for (const Fx of [AlgoVerb, Shimmer]) {
    basicChecks(Fx);
    const ms = cost(Fx);
    assert.ok(ms < 120, `${Fx.type}: ${ms.toFixed(1)} ms of CPU for a second of audio`);
  }
});

test('algoverb: the decay time on the knob is the decay time measured, in every voicing', (t) => {
  for (const voicing of ['room', 'hall', 'plate', 'cathedral', 'cosmic']) {
    for (const decay of [1, 3]) {
      // (no damping to speak of, no modulation: the knob is the mid-band decay)
      const [l] = tail(AlgoVerb, { voicing, decay, damping: 20000, lowCut: 20, modDepth: 0, early: 0, predelay: 0 }, decay * 1.6 + 1);
      const measured = rt60(l);
      t.diagnostic(`${voicing}, ${decay} s: ${measured.toFixed(2)} s`);
      assert.ok(Math.abs(measured / decay - 1) < 0.2, `${voicing}, ${decay} s on the knob: ${measured.toFixed(2)} s measured`);
    }
  }
  // twice the knob, twice the tail — with the default colour too
  const short = rt60(tail(AlgoVerb, { decay: 1.5 }, 5)[0]);
  const long = rt60(tail(AlgoVerb, { decay: 3 }, 8)[0]);
  assert.ok(long / short > 1.6 && long / short < 2.4, `1.5 s → ${short.toFixed(2)} s, 3 s → ${long.toFixed(2)} s`);
});

test('algoverb: pre-delay, damping, width, the mix and freeze do what they say', () => {
  // nothing wet before the pre-delay has passed (100 ms = 4800 samples; the burst starts at 0)
  const click = impulse(0.01, 0);
  const [late] = tail(AlgoVerb, { predelay: 100, early: 1 }, 1, click);
  assert.ok(peakOf(late, 0, 4700) < 1e-6, `silent for 100 ms: ${peakOf(late, 0, 4700)}`);
  assert.ok(peakOf(late, 4700, 9600) > 1e-3, 'and then it speaks');
  // damping: the highs of the tail die sooner than its lows
  const band = (x, hz) => { let s = 0; for (const f of [0.8, 0.9, 1, 1.1, 1.25]) s += toneAt(x, hz * f, FS, 16384) ** 2; return Math.sqrt(s); };
  const dark = tail(AlgoVerb, { decay: 4, damping: 1500, modDepth: 0 }, 2.5)[0];
  const bright = tail(AlgoVerb, { decay: 4, damping: 20000, modDepth: 0 }, 2.5)[0];
  const lossDark = db(band(dark, 6000) / band(dark, 300));
  const lossBright = db(band(bright, 6000) / band(bright, 300));
  assert.ok(lossDark < lossBright - 12, `a second in, 6 kHz against 300 Hz: ${lossDark.toFixed(1)} dB damped at 1.5 kHz, ${lossBright.toFixed(1)} dB open`);
  // width 0: the same wet signal on both sides; width 1: two different ones
  const [ml, mr] = tail(AlgoVerb, { width: 0 }, 1);
  let off = 0;
  for (let i = 0; i < ml.length; i++) off = Math.max(off, Math.abs(ml[i] - mr[i]));
  assert.ok(off < 1e-6, `mono at width 0 (off by ${off})`);
  const [wl, wr] = tail(AlgoVerb, { width: 1 }, 1);
  let dot = 0;
  for (let i = 4800; i < wl.length; i++) dot += wl[i] * wr[i];
  const corr = dot / ((wl.length - 4800) * rmsOf(wl, 4800) * rmsOf(wr, 4800));
  assert.ok(Math.abs(corr) < 0.5, `two sides at width 1 (correlation ${corr.toFixed(2)})`);
  // mix 0 is the input, bit for bit
  const x = noise(0.5, 0.4, 2);
  const y = noise(0.5, 0.4, 3);
  const dry = run(AlgoVerb, { mix: 0 }, [x, y]).channels;
  assert.ok(same(dry[0], x) && same(dry[1], y));
  // freeze: the tail that is there stays, at its level, and new sound does not enter
  const fx = new AlgoVerb(FS);
  fx.set({ mix: 1, decay: 2, modDepth: 0 });
  const feed = (seconds, input) => {
    const l = input ? Float32Array.from(input) : new Float32Array(Math.round(seconds * FS));
    const r = Float32Array.from(l);
    for (let at = 0; at < l.length; at += 128) fx.process(l.subarray(at, at + 128), r.subarray(at, at + 128), Math.min(128, l.length - at));
    return l;
  };
  feed(0, noise(0.5, 0.5, 5));
  fx.set({ freeze: true });
  feed(0.5);
  const early = rmsOf(feed(1));
  const later = rmsOf(feed(1, sine(3000, 0.5, 1)).subarray(0), 0);
  feed(6);
  const muchLater = rmsOf(feed(1));
  assert.ok(early > 1e-3 && Math.abs(db(muchLater / early)) < 3, `frozen: ${db(early).toFixed(1)} dB, eight seconds on ${db(muchLater).toFixed(1)} dB`);
  assert.ok(Math.abs(db(later / early)) < 3, 'a tone played into the frozen reverb does not add to it');
  fx.set({ freeze: false });
  feed(6);
  assert.ok(rmsOf(feed(0.5)) < early * 0.01, 'released, it fades');
});

test('algoverb: the loudest input at the most extreme settings stays bounded, and a long tail ends in silence', () => {
  const hot = noise(1, 2, 7);
  for (const params of [{ decay: 60, size: 1, diffusion: 1, modDepth: 1, modRate: 5, mix: 1 }, { decay: 0.1, size: 0, diffusion: 0, modDepth: 0, mix: 1 }, { voicing: 'cosmic', decay: 60, damping: 20000, lowCut: 20, mix: 1 }]) {
    const { channels: [l, r] } = run(AlgoVerb, params, [hot, Float32Array.from(hot, (v) => -v)], { tail: 2 });
    assert.ok(l.every(Number.isFinite) && r.every(Number.isFinite) && peakOf(l) <= 15.86 && peakOf(r) <= 15.86, `${JSON.stringify(params)}: peak ${peakOf(l)}`);
  }
  const [l] = tail(AlgoVerb, { decay: 0.5 }, 6);
  assert.ok(peakOf(l, l.length - FS) < 1e-6, `silent after ten times the decay: ${peakOf(l, l.length - FS)}`);
});

test('shimmer: the tail climbs — an octave above the note, then two — and only as much as the amount says', () => {
  // half a second of A3 (220 Hz), then listen to the tail
  const note = sine(220, 0.5, 0.5);
  const partial = (params, hz) => {
    const [l] = tail(Shimmer, { decay: 6, damping: 20000, modDepth: 0, predelay: 0, ...params }, 4, note);
    return toneAt(l, hz, FS, 65536);
  };
  const plain = { own: partial({ amount: 0 }, 220), octave: partial({ amount: 0 }, 440) };
  const up = { own: partial({ amount: 0.7, shiftA: 12 }, 220), octave: partial({ amount: 0.7, shiftA: 12 }, 440), two: partial({ amount: 0.7, shiftA: 12 }, 880) };
  assert.ok(db(plain.octave / plain.own) < -40, `no shimmer, no octave: ${db(plain.octave / plain.own).toFixed(0)} dB`);
  assert.ok(db(up.octave / up.own) > -25, `the octave above the note: ${db(up.octave / up.own).toFixed(1)} dB against the note`);
  assert.ok(db(up.two / up.own) > -45 && up.two < up.octave, `two octaves above, quieter: ${db(up.two / up.own).toFixed(1)} dB`);
  // a fifth: 220 → 330 Hz (shiftB is the second shifter, blended in)
  const fifth = partial({ amount: 0.7, shiftA: 12, shiftB: 7, blend: 1 }, 329.63);
  assert.ok(db(fifth / up.own) > -30, `blend 1 shifts by the second interval: ${db(fifth / up.own).toFixed(1)} dB at 330 Hz`);
  // down an octave: 110 Hz
  assert.ok(db(partial({ amount: 0.7, shiftA: -12 }, 110) / up.own) > -30);
});

test('shimmer: it stays as stable as a plain reverb — bounded at full amount, and the tail ends', () => {
  const hot = noise(1, 2, 9);
  for (const params of [{ amount: 1, decay: 60, shiftA: 24, shiftB: 24, size: 1, modDepth: 1, mix: 1 }, { amount: 1, decay: 60, shiftA: -24, shiftB: -24, damping: 20000, mix: 1 }]) {
    const { channels: [l, r] } = run(Shimmer, params, [hot, Float32Array.from(hot)], { tail: 4 });
    assert.ok(l.every(Number.isFinite) && r.every(Number.isFinite) && peakOf(l) <= 15.86 && peakOf(r) <= 15.86, `${JSON.stringify(params)}: peak ${peakOf(l)}`);
  }
  const [l] = tail(Shimmer, { amount: 0.5, decay: 0.5 }, 8);
  assert.ok(peakOf(l, l.length - FS) < 1e-5, `silent well after the decay: ${peakOf(l, l.length - FS)}`);
  const x = noise(0.5, 0.4, 2);
  assert.ok(same(run(Shimmer, { mix: 0 }, [x, x]).channels[0], x), 'mix 0 is the input');
});
