// The special effects — disperser, frequency shifter, resonator — measured: what each one promises is checked on its
// output. (The classes are imported directly: these tests do not need them to be registered.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Disperser } from '../src/effects/disperser.js';
import { FreqShifter } from '../src/effects/freqshift.js';
import { Resonator } from '../src/effects/resonator.js';
import { FS, db, peakOf, rmsOf, sine, mixOf, noise, impulse, spectrum, strongest, toneAt, run, basicChecks, cost } from './fx-helpers.js';

const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const midiHz = (key) => 440 * 2 ** ((key - 69) / 12);

test('special effects: the checks all studio effects share, at a cost a mix can afford', () => {
  for (const Fx of [Disperser, FreqShifter, Resonator]) {
    basicChecks(Fx);
    const ms = cost(Fx);
    assert.ok(ms < 80, `${Fx.type}: ${ms.toFixed(1)} ms of CPU for a second of audio`);
  }
});

// ---- disperser

test('disperser: every frequency keeps its level — only the time it arrives changes, most around the centre', () => {
  // an all-pass: steady tones come out as loud as they went in, at any amount
  for (const amount of [0.3, 1]) {
    for (const hz of [60, 300, 1000, 8000]) {
      const x = sine(hz, 0.5, 1);
      const y = run(Disperser, { freq: 300, amount }, [x, x]).channels[0];
      const level = db(rmsOf(y, 24000) / rmsOf(x, 24000));
      assert.ok(Math.abs(level) < 0.1, `amount ${amount}, ${hz} Hz: ${level.toFixed(3)} dB`);
    }
  }
  // …and a click keeps its energy, spread over time
  const click = impulse(0.5, 100);
  const smeared = run(Disperser, { freq: 300, amount: 1 }, [click, click]).channels[0];
  const energy = rmsOf(smeared) ** 2 * smeared.length;
  assert.ok(Math.abs(energy - 1) < 0.02, `the energy of the click: ${energy.toFixed(4)}`);
  assert.ok(peakOf(smeared) < 0.7, `no longer a click: its peak is ${peakOf(smeared).toFixed(3)}`);
  // when a band arrives: the centre of its energy in time
  const arrival = (params, hz) => {
    const burst = new Float32Array(FS);
    // a short windowed burst of the frequency, centred on sample 4800
    for (let i = 0; i < 1920; i++) burst[3840 + i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / FS) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 1920));
    const y = run(Disperser, params, [burst, burst]).channels[0];
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < y.length; i++) { sum += i * y[i] * y[i]; weight += y[i] * y[i]; }
    return (sum / weight - 4800) / FS * 1000;
  };
  const atCentre = arrival({ freq: 1000, amount: 1 }, 1000);
  const away = arrival({ freq: 1000, amount: 1 }, 8000);
  const little = arrival({ freq: 1000, amount: 0.3 }, 1000);
  assert.ok(atCentre > 10 && atCentre > away * 4, `1 kHz is held back ${atCentre.toFixed(1)} ms, 8 kHz ${away.toFixed(2)} ms`);
  assert.ok(little < atCentre / 3 && little > 0, `less amount, less delay: ${little.toFixed(1)} ms`);
  // amount 0 and mix 0 are the input
  const x = noise(0.25, 0.4, 3);
  assert.ok(same(run(Disperser, { mix: 0 }, [x, x]).channels[0], x));
  const none = run(Disperser, { amount: 0 }, [x, x]).channels[0];
  let off = 0;
  for (let i = 0; i < x.length; i++) off = Math.max(off, Math.abs(none[i] - x[i]));
  assert.ok(off < 1e-4, `amount 0 changes nothing (off by ${off})`);
});

test('disperser: an amount, a frequency or a pinch that jumps under a loud note never makes it louder', () => {
  const x = mixOf(sine(55, 0.4, 2), sine(440, 0.2, 2));
  for (const [from, to] of [[{ amount: 1 }, { amount: 0.05 }], [{ amount: 0.05 }, { amount: 1 }], [{ freq: 80 }, { freq: 12000 }], [{ pinch: 10 }, { pinch: 0.1 }]]) {
    const fx = new Disperser(FS);
    fx.set(from);
    const l = Float32Array.from(x);
    const r = Float32Array.from(x);
    for (let at = 0; at < l.length; at += 128) {
      if (at === 128 * 300) fx.set(to);
      fx.process(l.subarray(at, at + 128), r.subarray(at, at + 128), 128);
    }
    assert.ok(peakOf(l) < 0.6 * 1.6, `${JSON.stringify(from)} → ${JSON.stringify(to)}: peak ${peakOf(l).toFixed(3)} from a 0.6 peak signal`);
  }
});

// ---- frequency shifter

test('freqshift: every partial moves by the same number of Hz, and the other sideband is 60 dB down', () => {
  const x = mixOf(sine(1000, 0.4, 1), sine(2000, 0.2, 1));
  // range 100 × amount 0.5 = +50 Hz
  const up = run(FreqShifter, { range: '100', amount: 0.5 }, [x, x]).channels[0];
  assert.ok(Math.abs(toneAt(up, 1050, 16384, 16384) - 0.4) < 0.01 && Math.abs(toneAt(up, 2050, 16384, 16384) - 0.2) < 0.01, `1050 Hz at ${toneAt(up, 1050, 16384, 16384).toFixed(3)}, 2050 Hz at ${toneAt(up, 2050, 16384, 16384).toFixed(3)}`);
  assert.ok(db(toneAt(up, 950, 16384, 16384) / 0.4) < -60, `the lower sideband: ${db(toneAt(up, 950, 16384, 16384) / 0.4).toFixed(0)} dB`);
  assert.ok(db(toneAt(up, 1000, 16384, 16384) / 0.4) < -60, 'and nothing left where it was');
  // (2050 / 1050 is no longer an octave: a harmonic sound has turned inharmonic)
  const down = run(FreqShifter, { range: '1000', amount: -0.3 }, [x, x]).channels[0];
  assert.ok(Math.abs(toneAt(down, 700, 16384, 16384) - 0.4) < 0.01 && db(toneAt(down, 1300, 16384, 16384) / 0.4) < -60);
  // the whole audio band: a low and a high partial are shifted as cleanly
  for (const hz of [60, 12000]) {
    const tone = sine(hz, 0.4, 1);
    const y = run(FreqShifter, { range: '100', amount: 0.2 }, [tone, tone]).channels[0];
    assert.ok(Math.abs(toneAt(y, hz + 20, 16384, 16384) - 0.4) < 0.01 && db(toneAt(y, hz - 20, 16384, 16384) / 0.4) < -55, `${hz} Hz: the other sideband at ${db(toneAt(y, hz - 20, 16384, 16384) / 0.4).toFixed(0)} dB`);
  }
});

test('freqshift: opposite shifts left and right, an LFO on the shift, feedback that stays bounded, and mix 0', () => {
  const x = sine(1000, 0.4, 1);
  // stereo 1: the right channel goes the other way
  const [l, r] = run(FreqShifter, { range: '100', amount: 0.5, stereo: 1 }, [x, x]).channels;
  assert.ok(Math.abs(toneAt(l, 1050, 16384, 16384) - 0.4) < 0.01 && Math.abs(toneAt(r, 950, 16384, 16384) - 0.4) < 0.01, `left at 1050 Hz, right at 950 Hz (${toneAt(r, 950, 16384, 16384).toFixed(3)})`);
  // the LFO moves the shift: the partial is no longer one line
  const wobble = run(FreqShifter, { range: '100', amount: 0.5, lfoDepth: 40, lfoRate: 2 }, [x, x]).channels[0];
  assert.ok(toneAt(wobble, 1050, 0, 32768) < 0.3, `spread by the LFO: ${toneAt(wobble, 1050, 0, 32768).toFixed(3)} left at 1050 Hz`);
  // feedback: each trip shifts again — a staircase of partials 50 Hz apart
  const stairs = run(FreqShifter, { range: '100', amount: 0.5, feedback: 0.7, fbDelay: 5 }, [x, x]).channels[0];
  const second = toneAt(stairs, 1100, 24000, 16384);
  const third = toneAt(stairs, 1150, 24000, 16384);
  assert.ok(second > 0.1 && third > 0.05 && third < second, `the staircase: ${second.toFixed(3)} at 1100 Hz, ${third.toFixed(3)} at 1150 Hz`);
  // The most feedback, on the loudest input, ends when the input ends — at every shift. (A shift of +5 kHz with
  // the shortest loop used to ring for ever: 19 kHz went to half the sample rate and came back twice as strong.)
  const hot = noise(0.5, 2, 5);
  for (const params of [{ range: '5000', amount: 1, fbDelay: 0 }, { range: '5000', amount: 1, fbDelay: 0, lfoDepth: 500 }, { range: '5000', amount: -1, fbDelay: 0 }, { range: '5000', amount: 0.8, fbDelay: 0.05 }, { range: '1000', amount: -1, fbDelay: 0 }, { range: '10', amount: 0, fbDelay: 1 }]) {
    const loud = run(FreqShifter, { ...params, feedback: 0.95 }, [hot, hot], { tail: 4 }).channels[0];
    assert.ok(loud.every(Number.isFinite) && peakOf(loud) <= 15.86, JSON.stringify(params));
    assert.ok(rmsOf(loud, loud.length - 4800) < 1e-4, `${JSON.stringify(params)}: ${db(rmsOf(loud, loud.length - 4800)).toFixed(0)} dB four seconds after the input`);
  }
  const dry = noise(0.25, 0.4, 3);
  assert.ok(same(run(FreqShifter, { mix: 0 }, [dry, dry]).channels[0], dry));
});

// ---- resonator

test('resonator: noise comes out as the chord, and a plucked string is on its note to a fraction of a cent', (t) => {
  const x = noise(3, 0.3, 21);
  const wet = (params) => run(Resonator, { mix: 1, detune: 0, spread: 0, damping: 0.2, decay: 4, ...params }, [x, x]).channels[0];
  // A2 major: A2, C#3, E3, A3, C#4 — each note stands well above the noise between the notes
  const y = wet({ root: 45, chord: 'major' });
  const { mag, binHz } = spectrum(y, FS, 65536);
  for (const semis of [0, 4, 7, 12, 16]) {
    const hz = midiHz(45 + semis);
    const peak = strongest(y, FS, 65536, hz * 0.97, hz * 1.03);
    assert.ok(Math.abs(1200 * Math.log2(peak.hz / hz)) < 6, `the peak near ${hz.toFixed(1)} Hz is at ${peak.hz.toFixed(2)} Hz`);
    const between = mag[Math.round((hz * 1.03) / binHz)];
    assert.ok(db(peak.amp / between) > 15, `${hz.toFixed(1)} Hz stands ${db(peak.amp / between).toFixed(1)} dB above its surroundings`);
  }
  // another chord, other peaks: a minor third instead of the major one
  const minor = wet({ root: 45, chord: 'minor' });
  const third = (z, semis) => toneAt(z, midiHz(45 + semis), FS, 65536);
  assert.ok(third(minor, 3) > third(minor, 4) * 2 && third(y, 4) > third(y, 3) * 2);
  // the tuning, measured where it can be measured: one string, plucked, ringing long — from A1 to A6, dull or bright
  const cents = [];
  for (const root of [33, 45, 57, 69, 81, 93]) {
    for (const damping of [0, 0.5]) {
      const pluck = impulse(4, 10);
      const ring = run(Resonator, { mix: 1, chord: 'unison', root, detune: 0, spread: 0, damping, decay: 10 }, [pluck, pluck]).channels[0];
      const hz = midiHz(root);
      cents.push(1200 * Math.log2(strongest(ring, 9600, 131072, hz * 0.97, hz * 1.03).hz / hz));
    }
  }
  t.diagnostic(`cents off the note, A1 to A6: ${cents.map((c) => c.toFixed(3)).join(', ')}`);
  assert.ok(cents.every((c) => Math.abs(c) < 0.3), `cents off: ${cents.map((c) => c.toFixed(3)).join(', ')}`);
  // detune moves the other voices, not the root's
  const wide = run(Resonator, { mix: 1, chord: 'unison', root: 57, detune: 50, spread: 0, damping: 0, decay: 10 }, [impulse(4, 10), impulse(4, 10)]).channels[0];
  const side = strongest(wide, 9600, 131072, 220 * 1.02, 220 * 1.04);
  assert.ok(Math.abs(1200 * Math.log2(side.hz / 220) - 50) < 2, `a voice 50 cents up: ${(1200 * Math.log2(side.hz / 220)).toFixed(1)}`);
});

test('resonator: the note fades by 60 dB in the decay time; a tone on the resonance stays bounded; mix 0 is the input', (t) => {
  // one string (unison, no detune), plucked by a click
  const pluck = impulse(6, 10);
  for (const decay of [0.5, 2]) {
    const y = run(Resonator, { mix: 1, chord: 'unison', root: 57, detune: 0, spread: 0, damping: 0, decay }, [pluck, pluck]).channels[0];
    // the level a quarter and three quarters of the way through the decay: half the decay = 30 dB
    const a = rmsOf(y, Math.round(decay * 0.25 * FS), Math.round(decay * 0.25 * FS) + 2400);
    const b = rmsOf(y, Math.round(decay * 0.75 * FS), Math.round(decay * 0.75 * FS) + 2400);
    t.diagnostic(`decay ${decay} s: ${db(a / b).toFixed(1)} dB in half of it`);
    assert.ok(Math.abs(db(a / b) - 30) < 4, `decay ${decay} s: ${db(a / b).toFixed(1)} dB in half the decay time (30 expected)`);
  }
  // a loud tone exactly on the string, a long decay: the limiter in the loop holds it
  const tone = sine(midiHz(57), 1, 3);
  const held = run(Resonator, { mix: 1, chord: 'unison', root: 57, detune: 0, decay: 20, damping: 0, drive: 24 }, [tone, tone]).channels[0];
  assert.ok(held.every(Number.isFinite) && peakOf(held) <= 15.86, `peak ${peakOf(held).toFixed(2)}`);
  // noise comes out at about its own level, whatever the decay
  const x = noise(3, 0.3, 4);
  // (measured once the strings have filled: a string that rings for 3 s takes about a second to get there)
  for (const decay of [0.2, 1, 3]) {
    const y = run(Resonator, { mix: 1, decay }, [x, x]).channels[0];
    assert.ok(Math.abs(db(rmsOf(y, FS * 2) / rmsOf(x, FS * 2))) < 8, `decay ${decay} s: noise ${db(rmsOf(y, FS * 2) / rmsOf(x, FS * 2)).toFixed(1)} dB against the input`);
  }
  const dry = noise(0.25, 0.4, 3);
  assert.ok(same(run(Resonator, { mix: 0 }, [dry, dry]).channels[0], dry));
  // spread puts the voices on the two sides
  const [l, r] = run(Resonator, { mix: 1, spread: 1, detune: 0 }, [x, x]).channels;
  assert.ok(!same(l, r));
  const [ml, mr] = run(Resonator, { mix: 1, spread: 0, detune: 0 }, [x, x]).channels;
  let off = 0;
  for (let i = 0; i < ml.length; i++) off = Math.max(off, Math.abs(ml[i] - mr[i]));
  assert.ok(off < 1e-6, `no spread: the same on both sides (off by ${off})`);
});
