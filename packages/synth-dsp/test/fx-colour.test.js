// The colour effects — lo-fi, tremolo / auto-pan, ring modulator, flanger, utility — measured: what each one promises
// is checked on its output. (The classes are imported directly: these tests do not need them to be registered.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lofi } from '../src/effects/lofi.js';
import { Tremolo } from '../src/effects/tremolo.js';
import { RingMod } from '../src/effects/ringmod.js';
import { Flanger } from '../src/effects/flanger.js';
import { Utility } from '../src/effects/utility.js';
import { FS, db, peakOf, rmsOf, sine, noise, impulse, levelAt, toneAt, run, basicChecks, cost } from './fx-helpers.js';

const ALL = [Lofi, Tremolo, RingMod, Flanger, Utility];
const flat = (value, seconds) => new Float32Array(Math.round(seconds * FS)).fill(value);
const same = (a, b, from = 0) => { for (let i = from; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
/** The gain an effect applies to a constant input, sample by sample. */
const gainOf = (Fx, params, opts, seconds = 2) => run(Fx, params, [flat(1, seconds), flat(1, seconds)], opts).channels;

test('colour effects: the checks all studio effects share, at a cost a mix can afford', () => {
  for (const Fx of ALL) {
    basicChecks(Fx);
    const ms = cost(Fx);
    assert.ok(ms < 60, `${Fx.type}: ${ms.toFixed(1)} ms of CPU for a second of audio`);
  }
});

test('colour effects: with the mix at 0 (or everything at rest) the input passes bit for bit', () => {
  const x = noise(0.5, 0.4, 3);
  const y = noise(0.5, 0.4, 9);
  for (const [Fx, params] of [[Lofi, { mix: 0 }], [RingMod, { mix: 0 }], [Flanger, { mix: 0 }], [Tremolo, { depth: 0 }], [Utility, {}]]) {
    const { channels: [l, r] } = run(Fx, params, [x, y]);
    assert.ok(same(l, x) && same(r, y), `${Fx.type} ${JSON.stringify(params)}`);
  }
});

test('colour effects: the loudest input at the most extreme settings stays finite and bounded', () => {
  const hot = noise(1, 2, 5);
  for (const Fx of ALL) {
    for (const edge of ['min', 'max']) {
      const params = Object.fromEntries(Fx.defs.map((d) => [d.key, d.type === 'number' ? d[edge] : d.type === 'bool' ? edge === 'max' : d.options[edge === 'max' ? d.options.length - 1 : 0]]));
      const { channels: [l, r] } = run(Fx, params, [hot, Float32Array.from(hot, (v) => -v)], { tail: 0.5 });
      assert.ok(l.every(Number.isFinite) && r.every(Number.isFinite), `${Fx.type} at its ${edge}`);
      // (base.js: nothing leaves an effect above +24 dB)
      assert.ok(peakOf(l) <= 15.86 && peakOf(r) <= 15.86, `${Fx.type} at its ${edge}: peak ${peakOf(l)}`);
    }
  }
});

test('colour effects: a knob turned under a held note glides', () => {
  const x = sine(220, 0.5, 1);
  for (const [Fx, from, to] of [[Lofi, { mix: 0 }, { mix: 1 }], [Tremolo, { depth: 0 }, { depth: 1, rate: 0.05 }], [RingMod, { mix: 0, freq: 2 }, { mix: 1, freq: 2 }], [Flanger, { mix: 0 }, { mix: 1 }], [Utility, { gain: 0 }, { gain: -12 }], [Utility, { pan: 0 }, { pan: 1 }], [Utility, { width: 1 }, { width: 0 }]]) {
    const fx = new Fx(FS);
    fx.set(from);
    const l = Float32Array.from(x);
    const r = Float32Array.from(x);
    for (let at = 0; at < l.length; at += 128) {
      if (at === 128 * 180) fx.set(to);
      fx.process(l.subarray(at, at + 128), r.subarray(at, at + 128), 128);
    }
    // the largest step between two samples around the change, against the largest step of the sine itself
    const own = 0.5 * 2 * Math.PI * 220 / FS;
    let step = 0;
    for (let i = 128 * 180 - 4; i < 128 * 180 + 400; i++) step = Math.max(step, Math.abs(l[i] - l[i - 1]), Math.abs(r[i] - r[i - 1]));
    assert.ok(step < own * 2.5, `${Fx.type} ${JSON.stringify(from)} → ${JSON.stringify(to)}: a step of ${(step / own).toFixed(1)} times the sine's own`);
  }
});

// ---- lo-fi

test('lofi: N bits leave the noise floor of an N-bit converter; the sample rate puts images where theory says', () => {
  const x = sine(997, 0.9, 1);
  const clean = { rate: 48000, wow: 0, flutter: 0, tone: 20000, noise: 0 };
  for (const bits of [6, 8, 12]) {
    const y = run(Lofi, { ...clean, bits }, [x, x]).channels[0];
    const err = Float32Array.from(y, (v, i) => v - x[i]);
    // a full-scale sine against quantisation noise: 6.02 N + 1.76 dB (this sine is 0.9 of full scale: −0.9 dB)
    const snr = db(rmsOf(x, 4800) / rmsOf(err, 4800));
    assert.ok(Math.abs(snr - (6.02 * bits + 1.76 - 0.9)) < 3, `${bits} bits: ${snr.toFixed(1)} dB`);
  }
  // 1 kHz held at 12 kHz: images at 12 ± 1 kHz (and 24 ± 1), none in a clean copy
  const tone = sine(1000, 0.5, 1);
  const held = run(Lofi, { ...clean, bits: 16, rate: 12000 }, [tone, tone]).channels[0];
  const straight = run(Lofi, { ...clean, bits: 16 }, [tone, tone]).channels[0];
  for (const hz of [11000, 13000]) {
    assert.ok(db(levelAt(held, hz, 8192, 16384)) > -45, `image at ${hz} Hz: ${db(levelAt(held, hz, 8192, 16384)).toFixed(1)} dB`);
    assert.ok(db(levelAt(straight, hz, 8192, 16384)) < -80, `no image at ${hz} Hz without the reduction`);
  }
  assert.ok(Math.abs(db(levelAt(held, 1000, 8192, 16384) / 0.5)) < 1, 'the tone itself stays');
});

test('lofi: the tone filter takes the highs, the hiss is there on silence and the same every time, wow bends the pitch', () => {
  const clean = { bits: 16, rate: 48000, wow: 0, flutter: 0, noise: 0 };
  const high = sine(8000, 0.5, 0.5);
  const dark = run(Lofi, { ...clean, tone: 1000 }, [high, high]).channels[0];
  const open = run(Lofi, { ...clean, tone: 20000 }, [high, high]).channels[0];
  // one pole at 1 kHz: 8 kHz is three octaves up, about 18 dB down
  const loss = db(rmsOf(dark, 4800) / rmsOf(open, 4800));
  assert.ok(loss < -14 && loss > -22, `8 kHz through a 1 kHz tone filter: ${loss.toFixed(1)} dB`);
  const silence = new Float32Array(FS / 2);
  const hiss = run(Lofi, { ...clean, tone: 20000, noise: 0.5 }, [silence, silence]).channels[0];
  assert.ok(rmsOf(hiss) > 1e-4 && rmsOf(hiss) < 0.1, `hiss at ${db(rmsOf(hiss)).toFixed(1)} dB`);
  assert.deepEqual(run(Lofi, { ...clean, tone: 20000, noise: 0.5 }, [silence, silence]).channels[0], hiss);
  assert.equal(peakOf(run(Lofi, { ...clean, tone: 20000 }, [silence, silence]).channels[0]), 0, 'and none when it is off');
  // wow moves the delay, which bends the pitch: a steady tone is no longer one line in the spectrum
  const tone = sine(2000, 0.5, 3);
  const steady = run(Lofi, { ...clean, tone: 20000 }, [tone, tone]).channels[0];
  const bent = run(Lofi, { ...clean, tone: 20000, wow: 1, flutter: 1 }, [tone, tone]).channels[0];
  const skirt = (y) => db(Math.max(levelAt(y, 1960, FS, 65536), levelAt(y, 2040, FS, 65536)) / levelAt(y, 2000, FS, 65536));
  assert.ok(skirt(steady) < -60 && skirt(bent) > skirt(steady) + 20, `±40 Hz from the tone: ${skirt(steady).toFixed(0)} dB steady, ${skirt(bent).toFixed(0)} dB bent`);
});

// ---- tremolo

test('tremolo: the gain swings between 1 − depth and 1 at the rate, in every shape', () => {
  for (const shape of ['sine', 'triangle', 'square', 'ramp']) {
    for (const depth of [0.3, 1]) {
      const [g] = gainOf(Tremolo, { rate: 4, depth, shape, smooth: 0.2 });
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = FS / 2; i < g.length; i++) { lo = Math.min(lo, g[i]); hi = Math.max(hi, g[i]); }
      assert.ok(Math.abs(hi - 1) < 0.02 && Math.abs(lo - (1 - depth)) < 0.02, `${shape}, depth ${depth}: ${lo.toFixed(3)}…${hi.toFixed(3)}`);
      // one cycle later the gain is the same: 4 Hz is 12000 samples
      let off = 0;
      for (let i = FS / 2; i < g.length - 12000; i++) off = Math.max(off, Math.abs(g[i] - g[i + 12000]));
      assert.ok(off < 0.01, `${shape}: repeats every 12000 samples (off by ${off})`);
    }
  }
});

test('tremolo: synced, the gain is a function of the song position; half a cycle between the channels is an auto-pan', () => {
  // 120 BPM, 1/4 = one beat = 24000 samples: the same gain a beat later, and the same render from beat 0 or beat 16
  const params = { sync: true, division: '1/4', depth: 1, shape: 'sine' };
  const [g] = gainOf(Tremolo, params, { bpm: 120, beat: 0 });
  let off = 0;
  for (let i = 0; i < g.length - 24000; i++) off = Math.max(off, Math.abs(g[i] - g[i + 24000]));
  assert.ok(off < 0.01, `repeats every beat (off by ${off})`);
  const [later] = gainOf(Tremolo, params, { bpm: 120, beat: 16 });
  const [elsewhere] = gainOf(Tremolo, params, { bpm: 120, beat: 16.5 });
  let a = 0;
  let b = 0;
  for (let i = 0; i < g.length; i++) { a = Math.max(a, Math.abs(g[i] - later[i])); b = Math.max(b, Math.abs(g[i] - elsewhere[i])); }
  assert.ok(a < 1e-3, `beat 16 is beat 0 (off by ${a})`);
  assert.ok(b > 0.5, 'half a beat on, the gain is somewhere else');
  // twice the tempo, twice as fast
  const [fast] = gainOf(Tremolo, params, { bpm: 240, beat: 0 });
  off = 0;
  for (let i = 0; i < fast.length - 12000; i++) off = Math.max(off, Math.abs(fast[i] - fast[i + 12000]));
  assert.ok(off < 0.01);
  // the auto-pan: when one side is loud the other is quiet
  const [l, r] = gainOf(Tremolo, { rate: 2, depth: 1, stereo: 0.5, shape: 'sine' });
  let sum = 0;
  for (let i = FS / 2; i < l.length; i++) sum = Math.max(sum, Math.abs(l[i] + r[i] - 1));
  assert.ok(sum < 0.02, `left + right stays 1 (off by ${sum})`);
  const [ml, mr] = gainOf(Tremolo, { rate: 2, depth: 1, stereo: 0 });
  assert.ok(same(ml, mr), 'no offset: both sides alike');
});

// ---- ring modulator

test('ringmod: a 1 kHz sine and a 300 Hz carrier give 700 and 1300 Hz at half the level each, and no 1 kHz', () => {
  const x = sine(1000, 0.5, 1);
  const [l, r] = run(RingMod, { freq: 300 }, [x, x]).channels;
  for (const hz of [700, 1300]) assert.ok(Math.abs(toneAt(l, hz, 8192, 16384) - 0.25) < 0.01, `${hz} Hz at ${toneAt(l, hz, 8192, 16384)}`);
  assert.ok(db(toneAt(l, 1000, 8192, 16384)) < -90, `1 kHz at ${db(toneAt(l, 1000, 8192, 16384)).toFixed(0)} dB`);
  assert.ok(same(l, r), 'no stereo offset: mono');
  // half the mix keeps half the dry sound
  const half = run(RingMod, { freq: 300, mix: 0.5 }, [x, x]).channels[0];
  assert.ok(Math.abs(toneAt(half, 1000, 8192, 16384) - 0.25) < 0.01 && Math.abs(toneAt(half, 700, 8192, 16384) - 0.125) < 0.01);
  // a square carrier has odd harmonics: sidebands around 900 Hz too, a third as loud
  const sq = run(RingMod, { freq: 300, shape: 'square' }, [x, x]).channels[0];
  const ratio = toneAt(sq, 1900, 8192, 16384) / toneAt(sq, 1300, 8192, 16384);
  assert.ok(Math.abs(ratio - 1 / 3) < 0.03, `the third harmonic's sideband: ${ratio.toFixed(3)} of the first`);
  // a quarter of a cycle between the channels: the same sidebands, a different wave
  const [wl, wr] = run(RingMod, { freq: 300, stereo: 0.25 }, [x, x]).channels;
  assert.ok(!same(wl, wr) && Math.abs(toneAt(wr, 700, 8192, 16384) - 0.25) < 0.01);
});

// ---- flanger

test('flanger: a click comes back after the delay; standing still it is a comb with its first notch at 1 / (2 × delay)', () => {
  // 2 ms = 96 samples
  const still = { delay: 2, depth: 0, feedback: 0, stereo: 0 };
  const echo = run(Flanger, { ...still, mix: 1 }, [impulse(0.1, 100), impulse(0.1, 100)]).channels[0];
  let at = 0;
  for (let i = 0; i < echo.length; i++) if (Math.abs(echo[i]) > Math.abs(echo[at])) at = i;
  assert.ok(Math.abs(at - 196) <= 1 && Math.abs(echo[at]) > 0.9, `the click at sample ${at}, ${echo[at]}`);
  // dry + delayed: notches at 250, 750, 1250 Hz…, crests (twice the level, halved by the mix: unity) at 500, 1000…
  for (const [hz, want] of [[250, 'notch'], [500, 'crest'], [750, 'notch'], [1000, 'crest']]) {
    const x = sine(hz, 0.5, 0.5);
    const y = run(Flanger, { ...still, mix: 0.5 }, [x, x]).channels[0];
    const level = db(rmsOf(y, 12000) / rmsOf(x, 12000));
    if (want === 'notch') assert.ok(level < -40, `${hz} Hz: ${level.toFixed(1)} dB`);
    else assert.ok(Math.abs(level) < 0.2, `${hz} Hz: ${level.toFixed(2)} dB`);
  }
});

test('flanger: feedback sharpens the crests, the most feedback stays bounded and dies away, the sweep moves the comb', () => {
  const still = { delay: 2, depth: 0, stereo: 0, mix: 1 };
  // at a crest of the comb the copies add up: 1 / (1 − feedback)
  const x = sine(500, 0.1, 1);
  for (const feedback of [0.5, 0.8]) {
    const y = run(Flanger, { ...still, feedback }, [x, x]).channels[0];
    const gain = rmsOf(y, 24000) / rmsOf(x, 24000);
    assert.ok(Math.abs(gain - 1 / (1 - feedback)) < 0.1 / (1 - feedback), `feedback ${feedback}: ×${gain.toFixed(2)}`);
  }
  const burst = Float32Array.from(noise(0.25, 2, 4));
  const ring = run(Flanger, { ...still, feedback: 0.98, depth: 1, rate: 3 }, [burst, burst], { tail: 3 }).channels[0];
  assert.ok(peakOf(ring) < 15.86 && ring.every(Number.isFinite));
  assert.ok(rmsOf(ring, ring.length - 4800) < 1e-3, `silent three seconds later: ${db(rmsOf(ring, ring.length - 4800)).toFixed(0)} dB`);
  // sweeping: a tone at a standing notch is no longer cancelled all the time
  const tone = sine(250, 0.5, 2);
  const swept = run(Flanger, { delay: 2, depth: 1, feedback: 0, stereo: 0, rate: 1, mix: 0.5 }, [tone, tone]).channels[0];
  let lo = Infinity;
  let hi = 0;
  for (let at = 24000; at < swept.length - 2400; at += 1200) { const v = rmsOf(swept, at, at + 2400); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(db(hi / lo) > 12, `the level moves by ${db(hi / lo).toFixed(1)} dB as the comb passes`);
  // synced, the sweep is where the song is: a render from beat 8 is the second half of a render from beat 0
  const long = noise(4, 0.3, 8);
  const whole = run(Flanger, { sync: true, division: '1/1', feedback: 0, stereo: 0 }, [long, long], { bpm: 120 }).channels[0];
  const tail = long.subarray(FS * 2);
  const part = run(Flanger, { sync: true, division: '1/1', feedback: 0, stereo: 0 }, [tail, tail], { bpm: 120, beat: 4 }).channels[0];
  let off = 0;
  for (let i = 4800; i < part.length; i++) off = Math.max(off, Math.abs(part[i] - whole[FS * 2 + i]));
  assert.ok(off < 1e-3, `off by ${off}`);
});

// ---- utility

test('utility: gain, pan, width, polarity, swap and delays do exactly what they say', () => {
  const l = noise(0.25, 0.3, 1);
  const r = noise(0.25, 0.3, 2);
  const settled = 6000;
  const out = (params) => run(Utility, params, [l, r]).channels;
  const ratio = (y, x) => rmsOf(y, settled) / rmsOf(x, settled);
  assert.ok(Math.abs(db(ratio(out({ gain: -6 })[0], l)) + 6) < 0.01);
  assert.ok(Math.abs(db(ratio(out({ gain: 12 })[1], r)) - 12) < 0.01);
  assert.ok(peakOf(out({ gain: -80 })[0], settled) < 1e-6, '−80 dB is silence');
  // pan is a balance: the centre at unity, the far side fading out
  const [pl, pr] = out({ pan: 1 });
  assert.ok(peakOf(pl, settled) < 1e-6 && Math.abs(ratio(pr, r) - 1) < 1e-3);
  const [hl, hr] = out({ pan: 0.5 });
  assert.ok(Math.abs(ratio(hl, l) - 0.5) < 1e-3 && Math.abs(ratio(hr, r) - 1) < 1e-3);
  // width: 0 is mono, 2 doubles the side signal
  const [ml, mr] = out({ width: 0 });
  for (let i = settled; i < ml.length; i++) assert.ok(Math.abs(ml[i] - mr[i]) < 1e-6 && Math.abs(ml[i] - (l[i] + r[i]) / 2) < 1e-6);
  const [wl, wr] = out({ width: 2 });
  for (let i = settled; i < wl.length; i += 97) assert.ok(Math.abs((wl[i] - wr[i]) - 2 * (l[i] - r[i])) < 1e-5 && Math.abs((wl[i] + wr[i]) - (l[i] + r[i])) < 1e-5);
  // polarity and swap
  const [il, ir] = out({ invertL: true });
  for (let i = 0; i < il.length; i += 53) assert.ok(il[i] === -l[i] && ir[i] === r[i]);
  const [sl, sr] = out({ swap: true });
  assert.ok(same(sl, r) && same(sr, l));
  // a delay of whole samples on one side: 1 ms = 48 samples
  const [dl, dr] = out({ delayL: 1 });
  for (let i = 100; i < dl.length; i += 61) assert.ok(Math.abs(dl[i] - l[i - 48]) < 1e-6 && dr[i] === r[i]);
});

test('utility: mono below a frequency takes the side signal out of the bass only; the DC filter removes an offset', () => {
  // out of phase on the two sides: pure side signal
  for (const [hz, kept] of [[50, false], [4000, true]]) {
    const x = sine(hz, 0.5, 1);
    const [l, r] = run(Utility, { monoBelow: 300 }, [x, Float32Array.from(x, (v) => -v)]).channels;
    const level = db(rmsOf(l, 24000) / rmsOf(x, 24000));
    if (kept) assert.ok(Math.abs(level) < 0.5 && rmsOf(r, 24000) > 0.3, `${hz} Hz keeps its width: ${level.toFixed(2)} dB`);
    else assert.ok(level < -20, `${hz} Hz loses its side signal: ${level.toFixed(1)} dB`);
  }
  // …and a mono signal passes whole at any frequency
  for (const hz of [50, 300, 4000]) {
    const x = sine(hz, 0.5, 1);
    const [l] = run(Utility, { monoBelow: 300 }, [x, x]).channels;
    assert.ok(Math.abs(db(rmsOf(l, 24000) / rmsOf(x, 24000))) < 0.1, `${hz} Hz in the middle`);
  }
  const offset = Float32Array.from(sine(440, 0.3, 2), (v) => v + 0.25);
  const [y] = run(Utility, { dcBlock: true }, [offset, offset]).channels;
  let mean = 0;
  for (let i = FS; i < y.length; i++) mean += y[i];
  mean /= y.length - FS;
  assert.ok(Math.abs(mean) < 1e-3, `mean ${mean}`);
  assert.ok(Math.abs(toneAt(y, 440, FS, 32768) - 0.3) < 0.003, 'and leaves the tone');
});
