// Chaos sources, the 64-route matrix and the eight macros, measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chaos, CHAOS_TYPES, CHAOS_INFO, chaosPreview } from '../src/chaos.js';
import { GgsVoice } from '../src/voice.js';
import { renderPatch } from '../src/render.js';
import { ggsDefaults, MOD_SLOTS, MACRO_COUNT, MOD_SOURCES, GGS_PARAMS } from '../src/params.js';
import { routesToParams, modulationRoutes, modulationRanges, macroLabel, macroUsed, describeRoute, paramsToPatch, patchToParams, summarizePatch, sectionToParams } from '../src/patch.js';

const T = Object.fromEntries(CHAOS_TYPES.map((t, i) => [t, i]));
/** `seconds` of a generator sampled every `dt`. */
function run(type, { rate = 1, character = 0.5, steps = 16, seed = 7, seconds = 60, dt = 1 / 500 } = {}) {
  const c = new Chaos(seed);
  const out = new Float64Array(Math.round(seconds / dt));
  for (let i = 0; i < out.length; i++) out[i] = c.advance(dt, T[type], rate, character, steps);
  return out;
}
const maxima = (x) => { let n = 0; for (let i = 1; i < x.length - 1; i++) if (x[i] > x[i - 1] && x[i] >= x[i + 1]) n++; return n; };
const stats = (x) => {
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (const v of x) { lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
  return { lo, hi, mean: sum / x.length };
};

test('every generator stays in −1…1, uses its range and is described', () => {
  assert.deepEqual(CHAOS_TYPES, ['lorenz', 'rossler', 'drift', 'turing']);
  for (const type of CHAOS_TYPES) {
    assert.ok(CHAOS_INFO[type].desc.length > 40 && CHAOS_INFO[type].character);
    for (const character of [0, 0.5, 1]) {
      const x = run(type, { character, seconds: 120 });
      const s = stats(x);
      assert.ok(x.every((v) => Number.isFinite(v) && v >= -1 && v <= 1), `${type} at character ${character} stays inside −1…1`);
      const reach = type === 'drift' ? 0.45 : 0.6;
      assert.ok(s.hi > reach && s.lo < -reach, `${type} at character ${character} uses its range (${s.lo.toFixed(2)} … ${s.hi.toFixed(2)})`);
    }
  }
});

test('a path is fixed by its seed, whatever the block size', () => {
  for (const type of CHAOS_TYPES) {
    const a = run(type, { seconds: 20 });
    const b = run(type, { seconds: 20 });
    assert.deepEqual(a, b, `${type}: same seed, same path`);
    const other = run(type, { seconds: 20, seed: 8 });
    let differ = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - other[i]) > 0.05) differ++;
    assert.ok(differ > a.length * 0.3, `${type}: another seed is another path`);
    // the same moments reached in blocks four times as long: the same values (it is a tape that the rate scans).
    // (A rate that keeps the steps off the sampling instants: exactly on one, rounding decides which side it falls.)
    const fine = run(type, { seconds: 20, rate: 0.9731 });
    const coarse = run(type, { seconds: 20, rate: 0.9731, dt: 4 / 500 });
    let worst = 0;
    for (let i = 0; i < coarse.length; i++) worst = Math.max(worst, Math.abs(coarse[i] - fine[i * 4 + 3]));
    assert.ok(worst < 1e-6, `${type}: independent of the block size (largest difference ${worst.toExponential(1)})`);
  }
});

test('rate means what it says: swings, orbits and steps per second', () => {
  for (const rate of [0.5, 3]) {
    const seconds = 240 / rate;
    const lorenz = maxima(run('lorenz', { rate, seconds, dt: 1 / (rate * 200) })) / seconds;
    assert.ok(Math.abs(lorenz / rate - 1) < 0.12, `lorenz at ${rate} Hz swings ${lorenz.toFixed(2)} times a second`);
    const rossler = maxima(run('rossler', { rate, seconds, dt: 1 / (rate * 200) })) / seconds;
    assert.ok(Math.abs(rossler / rate - 1) < 0.1, `rossler at ${rate} Hz makes ${rossler.toFixed(2)} orbits a second`);
  }
  // turing holds each step for exactly 1/rate
  const x = run('turing', { rate: 4, seconds: 10, dt: 1 / 400, character: 1 });
  let changes = 0;
  for (let i = 1; i < x.length; i++) if (x[i] !== x[i - 1]) { changes++; assert.ok(i % 100 === 99 || i % 100 === 0, `a step starts on the grid (sample ${i})`); }
  assert.ok(changes > 25 && changes <= 40, `about 40 steps in 10 s at 4 Hz, most of them a new value (${changes})`);
});

test('character does what each generator promises', () => {
  // lorenz: it visits both sides, and stays on one side longer when calm
  const stay = (character) => {
    const x = run('lorenz', { character, seconds: 600, dt: 1 / 100 });
    let flips = 0;
    for (let i = 1; i < x.length; i++) if (x[i] > 0 !== x[i - 1] > 0) flips++;
    return x.length / 100 / Math.max(1, flips);
  };
  assert.ok(stay(0) > stay(1) * 1.3, `calm stays ${stay(0).toFixed(1)} s on a side, restless ${stay(1).toFixed(1)} s`);
  // rossler: nearly periodic when calm (its peaks are alike), spiky when not
  const spread = (character) => {
    const x = run('rossler', { character, seconds: 300, dt: 1 / 100 });
    const peaks = [];
    for (let i = 1; i < x.length - 1; i++) if (x[i] > x[i - 1] && x[i] >= x[i + 1]) peaks.push(x[i]);
    const m = peaks.reduce((a, b) => a + b, 0) / peaks.length;
    return Math.sqrt(peaks.reduce((a, b) => a + (b - m) * (b - m), 0) / peaks.length);
  };
  assert.ok(spread(1) > spread(0) * 1.5, `peak heights vary more when spiky (${spread(0).toFixed(3)} → ${spread(1).toFixed(3)})`);
  // drift: comes home (no offset), and character smooths it
  const rough = run('drift', { character: 0, seconds: 300, dt: 1 / 100 });
  const smooth = run('drift', { character: 1, seconds: 300, dt: 1 / 100 });
  assert.ok(Math.abs(stats(rough).mean) < 0.08 && Math.abs(stats(smooth).mean) < 0.08, 'drift has no offset');
  const jitter = (x) => { let s = 0; for (let i = 2; i < x.length; i++) s += Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]); return s / x.length; };
  assert.ok(jitter(rough) > jitter(smooth) * 3, 'character 0 is jittery, 1 is rounded');
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  assert.ok(Math.abs(rms(rough) / rms(smooth) - 1) < 0.25, 'and the level stays the same');
  // turing: character 0 is a locked loop of `steps` values; 1 never repeats
  const steps = (character, len) => { const x = run('turing', { rate: 10, character, steps: len, seconds: 20, dt: 1 / 10 }); return Array.from(x); };
  const locked = steps(0, 5);
  for (let i = 5; i < locked.length; i++) assert.equal(locked[i], locked[i - 5], 'a locked 5-step loop repeats every 5 steps');
  assert.ok(new Set(locked).size >= 2, 'and is not stuck on one value');
  const free = steps(1, 5);
  let repeats = 0;
  for (let i = 5; i < free.length; i++) if (free[i] === free[i - 5]) repeats++;
  assert.ok(repeats < free.length * 0.2, 'full mutation does not loop');
});

test('the preview draws what the generator does', () => {
  for (const type of CHAOS_TYPES) {
    const p = chaosPreview({ type, character: 0.5, steps: 8 }, 200, 10);
    assert.equal(p.length, 200);
    assert.ok(p.every((v) => v >= -1 && v <= 1) && Math.max(...p) - Math.min(...p) > 0.5, type);
  }
  assert.deepEqual(chaosPreview({ type: 'lorenz' }), chaosPreview({ type: 'lorenz' }));
});

// a plain sine whose pitch is the only thing that moves: what comes out shows the modulation
const SINE = { ...ggsDefaults(), f1On: false, oscATable: 'basic', oscAPos: 0, oscARand: 0, velSens: 0, env1A: 0.001 };
const voiceRun = (params, seed, blocks = 400) => {
  const v = new GgsVoice({ sampleRate: 48000, params, key: 60, velocity: 0.8, seed, bpm: 120 });
  const L = new Float32Array(128 * blocks);
  const R = new Float32Array(128 * blocks);
  for (let b = 0; b < blocks; b++) v.process(L, R, b * 128, 128, { pitch: 0, pressure: 0, timbre: 0 });
  return { L, v };
};
const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

test('in a voice: free until routed, its own path per note or the same for all, locked to the tempo', () => {
  assert.equal(voiceRun(SINE, 1, 4).v.chaos[0], null, 'an unrouted chaos source is never built');
  const routed = { ...SINE, chaos1Type: 'lorenz', chaos1Rate: 6, mod1Src: 'chaos1', mod1Dst: 'pitch', mod1Amt: 0.1 };
  const a = voiceRun(routed, 1).L;
  assert.ok(!same(a, voiceRun(SINE, 1).L), 'routed chaos moves the pitch');
  assert.ok(same(a, voiceRun(routed, 1).L), 'the same note renders the same wander');
  assert.ok(!same(a, voiceRun(routed, 2).L), 'path "note": another note wanders its own way');
  const shared = { ...routed, chaos1Path: 'same' };
  assert.ok(same(voiceRun(shared, 1).L, voiceRun(shared, 2).L), 'path "same": every note replays one path');
  // every type works as a source, including via
  for (const type of CHAOS_TYPES) {
    const x = voiceRun({ ...routed, chaos1Type: type, mod2Src: 'velocity', mod2Dst: 'level', mod2Amt: 0.2, mod2Via: 'chaos2' }, 3).L;
    assert.ok(x.every(Number.isFinite) && x.some((v) => Math.abs(v) > 0.05), `${type} drives a voice`);
  }
  // tempo sync: the same division at twice the tempo is the same path at twice the speed
  const turing = { ...SINE, chaos1Type: 'turing', chaos1Sync: '1/16', chaos1Char: 0, chaos1Steps: 4, chaos1Path: 'same', mod1Src: 'chaos1', mod1Dst: 'level', mod1Amt: 0.5, level: 0.5 };
  const levels = (bpm) => {
    const v = new GgsVoice({ sampleRate: 48000, params: turing, key: 60, velocity: 0.8, seed: 1, bpm });
    const out = [];
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let b = 0; b < 1500; b++) { v.process(L, R, 0, 128, { pitch: 0, pressure: 0, timbre: 0 }); out.push(v.src[MOD_SOURCES.indexOf('chaos1')]); }
    return out;
  };
  const slow = levels(120);
  const fast = levels(240);
  const firstChange = (x) => x.findIndex((v, i) => i > 0 && v !== x[i - 1]);
  assert.ok(Math.abs(firstChange(slow) / firstChange(fast) - 2) < 0.1, 'a sixteenth at 240 bpm is half as long as at 120');
});

// a voice's chaos1 once per 128-frame block; `beat` = where in the song the note starts
const CH1 = MOD_SOURCES.indexOf('chaos1');
const chaosTrace = (params, { beat = 0, blocks = 600, seed = 1, bpm = 120, size = 128, tempoAt = -1, tempo = 0, fs = 48000 } = {}) => {
  const v = new GgsVoice({ sampleRate: fs, params, key: 60, velocity: 0.8, seed, bpm, beat });
  const L = new Float32Array(size), R = new Float32Array(size);
  const out = [];
  for (let b = 0; b < blocks; b++) {
    if (b === tempoAt) v.setTempo(tempo);
    v.process(L, R, 0, size, { pitch: 0, pressure: 0, timbre: 0 });
    out.push(v.src[CH1]);
  }
  return out;
};
const LOCKED = { ...SINE, chaos1Type: 'turing', chaos1Sync: '1/16', chaos1Char: 0.3, chaos1Steps: 8, chaos1Path: 'same', mod1Src: 'chaos1', mod1Dst: 'level', mod1Amt: 0.5, level: 0.5 };
const BEATS_PER_BLOCK = (128 / 48000) * 2; // at 120 bpm

test('a tempo-synced turing pattern on the shared path follows the song: late notes are in step, on the grid', () => {
  // the pattern as two voices hear it: one from the start of the song, one that begins 37.4 s (74.8 beats) later
  const lateBlocks = Math.round((37.4 * 48000) / 128);
  const early = chaosTrace(LOCKED, { blocks: lateBlocks + 600 });
  const joined = chaosTrace(LOCKED, { beat: lateBlocks * BEATS_PER_BLOCK, seed: 99 });
  for (let b = 0; b < 600; b++) assert.equal(joined[b], early[lateBlocks + b], `block ${b}: the late note hears the step the early one hears`);
  assert.ok(new Set(joined).size >= 3, 'and the pattern is moving');
  // the steps sit on the sixteenth grid of the song (a sixteenth at 120 bpm = 0.125 s = 46.875 blocks)
  const onGrid = (x, beat0, what) => {
    let changes = 0;
    for (let b = 1; b < x.length; b++) {
      if (x[b] === x[b - 1]) continue;
      changes++;
      // the value of block b is the one at its end: the step's edge lies inside that block
      const steps = (beat0 + (b + 1) * BEATS_PER_BLOCK) * 4;
      const into = steps - Math.floor(steps + 1e-6);
      assert.ok(into < BEATS_PER_BLOCK * 4 + 1e-6, `${what}: the step heard at block ${b} began ${into.toFixed(4)} steps earlier`);
    }
    assert.ok(changes > 20, `${what}: ${changes} steps`);
  };
  onGrid(early.slice(0, 3000), 0, 'from the start');
  // wherever in the song a note begins — on a bar line, between two frames, far in — its steps are the song's
  for (const beat of [16, 3.3337, 1 / 3, 12345.678]) onGrid(chaosTrace(LOCKED, { beat, blocks: 1500 }), beat, `a note at beat ${beat}`);
  // a step whose edge falls exactly on a block's end: every voice counts it in, however it got there
  const exact = { ...LOCKED, chaos1Sync: '1/4' }; // a beat = 24000 frames = 187.5 blocks of 128, 1500 blocks of 16
  const a = chaosTrace(exact, { size: 16, blocks: 6100 });
  const b = chaosTrace(exact, { size: 16, blocks: 3100, beat: 2 });
  for (let i = 0; i < 3100; i++) assert.equal(b[i], a[3000 + i], `control block ${i}`);
  assert.notEqual(a[1499], a[1498], 'the step that begins on beat 1 is heard in the block that ends there');
  // …also where the sums do not come out even: at 44.1 kHz and 90 bpm a note that starts on frame 1200 reaches the
  // edge at frame 58 800 as step 7.999999999999999, a note from the start as step 8
  const from0 = chaosTrace(LOCKED, { fs: 44100, bpm: 90, size: 16, blocks: 3700 });
  const from1200 = chaosTrace(LOCKED, { fs: 44100, bpm: 90, size: 16, blocks: 3625, beat: ((1200 / 44100) * 90) / 60, seed: 4 });
  for (let i = 0; i < 3625; i++) assert.equal(from1200[i], from0[75 + i], `44.1 kHz, control block ${i}`);
  assert.notEqual(from0[3674], from0[3673], 'that edge is a step of the pattern');
  // a note asked for a hair before the song's start waits on the first step
  assert.equal(chaosTrace(LOCKED, { beat: -0.01, blocks: 1 })[0], early[0]);
  // not synced, or path "note": each note has its own clock again
  assert.equal(new GgsVoice({ sampleRate: 48000, params: { ...LOCKED, chaos1Path: 'note' }, key: 60, velocity: 0.8, seed: 1, bpm: 120 }).chaosc[0].locked, false);
  assert.equal(new GgsVoice({ sampleRate: 48000, params: { ...LOCKED, chaos1Sync: 'off' }, key: 60, velocity: 0.8, seed: 1 }).chaosc[0].locked, false);
  assert.equal(new GgsVoice({ sampleRate: 48000, params: { ...LOCKED, chaos1Type: 'lorenz' }, key: 60, velocity: 0.8, seed: 1 }).chaosc[0].locked, false);
});

test('the turing tape can be entered anywhere: seeking gives what stepping gives, at no cost that grows', () => {
  const TURING = CHAOS_TYPES.indexOf('turing');
  for (const character of [0, 0.004, 0.1, 0.5, 1]) {
    for (const len of [2, 3, 8, 16, 31, 32]) {
      // one generator walks the tape a step at a time; fresh ones jump straight to a step
      // (far enough that every step of a short loop has been renewed by the turn count alone: 256 turns)
      const last = len <= 3 ? 1700 : 700;
      const walker = new Chaos(11);
      const walked = [];
      const regs = [];
      for (let step = 0; step <= last; step++) { walked.push(walker.at(step + 0.5, character, len)); regs.push(walker.reg); }
      for (const step of [0, 1, len - 1, len, len + 1, 33, 64, 257, 700, last - 1, last]) {
        const jumper = new Chaos(11);
        assert.equal(jumper.at(step + 0.5, character, len), walked[step], `character ${character}, ${len} steps: step ${step}`);
        assert.equal(jumper.reg, regs[step], `character ${character}, ${len} steps: the whole register at step ${step}, not only the bits that sound`);
      }
      // backwards, and a change of the settings: the answer depends on the position and the settings alone
      assert.equal(walker.at(100.5, character, len), walked[100]);
      const other = new Chaos(11);
      other.at(50.5, 0.9, 5);
      assert.equal(other.at(300.5, character, len), walked[300]);
    }
  }
  // the stepping the per-note path does (advance) is the same tape
  const adv = new Chaos(11);
  const viaAt = new Chaos(11);
  for (let step = 1; step <= 200; step++) assert.equal(adv.advance(1, TURING, 1, 0.4, 7), viaAt.at(step + 1e-3, 0.4, 7), `step ${step}`);
  // a locked loop is the starting pattern, turning; full mutation never loops
  const lockedLoop = Array.from({ length: 64 }, (_, k) => new Chaos(5).at(k + 0.5, 0, 5));
  for (let k = 5; k < 64; k++) assert.equal(lockedLoop[k], lockedLoop[k - 5]);
  assert.ok(new Set(lockedLoop).size >= 2);
  // the slowest mutation there is still renews every step of the loop within 256 turns: a pattern that mutates at
  // all is not the starting pattern for ever, and no bit is older than that
  const turns = (character) => Array.from({ length: 2 * 256 + 8 }, (_, turn) => new Chaos(5).at(turn * 4 + 0.5, character, 4));
  assert.ok(new Set(turns(1e-12)).size > 2, 'the loop has changed');
  assert.equal(new Set(turns(0)).size, 1, 'a locked loop has not: the same step of every turn');
  // bar 250 000 of a song, days into a jam, mutations so rare that the walk back is as long as it gets: no wait
  const t0 = process.hrtime.bigint();
  let sum = 0;
  for (let i = 0; i < 150; i++) {
    for (const [character, len] of [[0, 16], [1e-9, 32], [0.001, 2], [0.3, 16]]) sum += new Chaos(i).at(4e6 + i * 977.5, character, len);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(Number.isFinite(sum));
  assert.ok(ms < 400, `600 notes entering the tape four million steps in took ${ms.toFixed(1)} ms (stepping there would take seconds)`);
  // different seeds, different tapes; positions before the start are the start
  assert.notDeepEqual(Array.from({ length: 32 }, (_, k) => new Chaos(1).at(k + 0.5, 0.5, 8)), Array.from({ length: 32 }, (_, k) => new Chaos(2).at(k + 0.5, 0.5, 8)));
  assert.equal(new Chaos(3).at(-7.2, 0.5, 8), new Chaos(3).at(0, 0.5, 8));
});

test('the song clock of a voice: a tempo change never jumps, a turned knob moves every note to the same tape', () => {
  // the tempo doubles under a held note: the pattern carries on from where it was, at twice the speed
  const steady = chaosTrace(LOCKED, { blocks: 2000 });
  const doubled = chaosTrace(LOCKED, { blocks: 2000, tempoAt: 1000, tempo: 240 });
  for (let b = 0; b < 1000; b++) assert.equal(doubled[b], steady[b]);
  const changesIn = (x, from, to) => { let n = 0; for (let b = from + 1; b < to; b++) if (x[b] !== x[b - 1]) n++; return n; };
  assert.ok(Math.abs(changesIn(doubled, 1000, 2000) / changesIn(steady, 1000, 2000) - 2) < 0.25, 'twice the steps per second after the change');
  // …and a note that starts after the change, at the same place in the song, hears the same steps
  const beatAtChange = 1000 * BEATS_PER_BLOCK;
  const after = chaosTrace(LOCKED, { beat: beatAtChange, blocks: 1000, bpm: 240, seed: 5 });
  for (let b = 0; b < 1000; b++) assert.equal(after[b], doubled[1000 + b], `block ${b} after the tempo change`);
  // slowing down does not send the tape backwards (no step is heard twice, none skipped)
  const slowed = chaosTrace({ ...LOCKED, chaos1Char: 0 }, { blocks: 3000, tempoAt: 900, tempo: 60 });
  const lockedTape = chaosTrace({ ...LOCKED, chaos1Char: 0 }, { blocks: 3000 });
  const seq = (x) => x.filter((v, i) => i === 0 || v !== x[i - 1]);
  const s = seq(slowed);
  assert.deepEqual(s, seq(lockedTape).slice(0, s.length), 'the same steps in the same order, only later');
  // the mutation knob turned under a held note: from then on it hears what a new note hears
  const v = new GgsVoice({ sampleRate: 48000, params: LOCKED, key: 60, velocity: 0.8, seed: 1, bpm: 120 });
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let b = 0; b < 700; b++) v.process(L, R, 0, 128, {});
  for (const edit of [{ chaos1Char: 0.05, chaos1Steps: 11 }, { chaos1Char: 0.8, chaos1Steps: 5 }, { chaos1Char: 0 }, { chaos1Steps: 3 }]) {
    const beat = (v.frames / 48000) * 2; // where the held note stands (120 bpm)
    v.setParams(edit);
    const held = [];
    for (let b = 0; b < 300; b++) { v.process(L, R, 0, 128, {}); held.push(v.src[CH1]); }
    const fresh = chaosTrace({ ...v.p }, { beat, blocks: 300, seed: 3 });
    assert.deepEqual(held, fresh, JSON.stringify(edit));
  }
  // a "free" LFO follows the same clock: a tempo-synced one counts beats (a late note is in phase, a tempo change
  // keeps it on the grid), one in hertz counts seconds
  const lfoAt = MOD_SOURCES.indexOf('lfo1');
  const lfo = (params, opts) => {
    const voice = new GgsVoice({ sampleRate: 48000, params: { ...SINE, mod1Src: 'lfo1', mod1Dst: 'level', mod1Amt: 0.1, lfo1Trig: 'free', lfo1Shape: 'saw', ...params }, key: 60, velocity: 0.8, seed: opts.seed || 1, bpm: opts.bpm || 120, beat: opts.beat || 0 });
    const out = [];
    for (let b = 0; b < opts.blocks; b++) { if (b === opts.tempoAt) voice.setTempo(opts.tempo); voice.process(L, R, 0, 128, {}); out.push(voice.src[lfoAt]); }
    return out;
  };
  const close = (x, y, what) => { for (let i = 0; i < x.length; i++) assert.ok(Math.abs(x[i] - y[i]) < 1e-9, `${what}: block ${i} (${x[i]} / ${y[i]})`); };
  const synced = lfo({ lfo1Sync: '1/4' }, { blocks: 1200 });
  close(lfo({ lfo1Sync: '1/4' }, { blocks: 500, beat: 700 * BEATS_PER_BLOCK, seed: 9 }), synced.slice(700), 'a late note, synced');
  const hz = lfo({ lfo1Rate: 1.7 }, { blocks: 1200 });
  close(lfo({ lfo1Rate: 1.7 }, { blocks: 500, beat: 700 * BEATS_PER_BLOCK, seed: 9 }), hz.slice(700), 'a late note, in hertz');
  // after a tempo change the synced LFO is where a note that starts there finds it
  const changed = lfo({ lfo1Sync: '1/4' }, { blocks: 1200, tempoAt: 600, tempo: 90 });
  close(lfo({ lfo1Sync: '1/4' }, { blocks: 600, beat: 600 * BEATS_PER_BLOCK, bpm: 90 }), changed.slice(600), 'through a tempo change');
});

test('a chaos path chosen while the source is not routed is the path it takes when it is', () => {
  const base = { ...SINE, chaos1Type: 'drift', chaos1Rate: 5 };
  const route = { mod1Src: 'chaos1', mod1Dst: 'pitch', mod1Amt: 0.2 };
  const heard = (seed, edits) => {
    const v = new GgsVoice({ sampleRate: 48000, params: { ...base, ...route }, key: 60, velocity: 0.8, seed, bpm: 120 });
    const L = new Float32Array(128), R = new Float32Array(128);
    for (const e of edits) { v.setParams(e); for (let b = 0; b < 40; b++) v.process(L, R, 0, 128, {}); }
    const out = [];
    for (let b = 0; b < 200; b++) { v.process(L, R, 0, 128, {}); out.push(v.src[CH1]); }
    return out;
  };
  // route off → path "same" → route on: two different notes now wander together, exactly as far apart as in time
  const off = { mod1Src: 'none' };
  const a = heard(1, [off, { chaos1Path: 'same' }, { mod1Src: 'chaos1' }]);
  const b = heard(2, [off, { chaos1Path: 'same' }, { mod1Src: 'chaos1' }]);
  assert.deepEqual(a, b);
  // …and back to "note": each its own way again
  const c = heard(1, [{ chaos1Path: 'same' }, off, { chaos1Path: 'note' }, { mod1Src: 'chaos1' }]);
  const d = heard(2, [{ chaos1Path: 'same' }, off, { chaos1Path: 'note' }, { mod1Src: 'chaos1' }]);
  assert.notDeepEqual(c, d);
});

test('the preview survives settings that are not numbers', () => {
  for (const type of CHAOS_TYPES) {
    for (const bad of [{ character: NaN }, { character: 'x' }, { steps: NaN }, { character: Infinity, steps: -Infinity }]) {
      const p = chaosPreview({ type, ...bad }, 120, 8);
      assert.ok(p.every((v) => v >= -1 && v <= 1), `${type} ${JSON.stringify(bad)}`);
      assert.ok(Math.max(...p) - Math.min(...p) > 0.1, `${type} still moves`);
    }
  }
});

test('a drawn LFO shape: steps are held in order, glide when smoothed, and travel in documents', () => {
  const at = MOD_SOURCES.indexOf('lfo1');
  const steps = [1, -1, 0.5, 0];
  const base = { ...SINE, ...sectionToParams('lfo', 1, { shape: 'steps', steps, rate: 2 }), mod1Src: 'lfo1', mod1Dst: 'level', mod1Amt: 0.1 };
  assert.equal(base.lfo1Steps, 4);
  // one value per control block for one second (2 Hz: two cycles of four steps, an eighth of a second each)
  const trace = (params, opts = {}) => {
    // (`from`: the note starts that many seconds into the song — two beats a second at 120 bpm)
    const v = new GgsVoice({ sampleRate: 48000, params, key: 60, velocity: 0.8, seed: 1, bpm: 120, beat: (opts.from || 0) * 2 });
    const L = new Float32Array(16), R = new Float32Array(16);
    const out = [];
    for (let b = 0; b < 3000; b++) { v.process(L, R, 0, 16, { pitch: 0, pressure: 0, timbre: 0 }); out.push(v.src[at]); }
    return out;
  };
  const hard = trace(base);
  const valueAt = (x, seconds) => x[Math.round((seconds * 48000) / 16) - 1];
  for (let k = 0; k < 8; k++) assert.equal(valueAt(hard, (k + 0.5) / 8), steps[k % 4], `step ${k % 4 + 1} is held in the middle of its eighth`);
  assert.equal(new Set(hard).size, 4, 'hard steps: only the drawn values ever appear');
  // smooth 1: every step glides to the next over its whole length (half-way there in the middle)
  const smooth = trace({ ...base, lfo1Smooth: 1 });
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(valueAt(smooth, (k + 0.5) / 8) - (steps[k] + steps[(k + 1) % 4]) / 2) < 0.02, `glide between step ${k + 1} and the next`);
  let jump = 0;
  for (let i = 1; i < smooth.length; i++) jump = Math.max(jump, Math.abs(smooth[i] - smooth[i - 1]));
  assert.ok(jump < 0.02, `no steps left when fully smoothed (largest move per block ${jump.toFixed(4)})`);
  // half smooth: held for the first half of a step, then gliding
  const half = trace({ ...base, lfo1Smooth: 0.5 });
  assert.equal(valueAt(half, 0.25 / 8), 1);
  assert.ok(valueAt(half, 0.9 / 8) < 0.5);
  // tempo-synced and free: every note hears the same step at the same time
  const free = { ...base, lfo1Sync: '1bar', lfo1Trig: 'free' };
  assert.equal(trace(free, { from: 1 })[10], 0.5, 'a note that starts a second in is on the third step');
  assert.equal(trace(free, { from: 1.5 })[10], 0, 'and one that starts at 1.5 s on the fourth');
  assert.equal(valueAt(trace(free), 0.25), 1, 'a bar at 120 bpm is 2 s: the first of four steps lasts half a second');
  assert.equal(valueAt(trace(free, { from: 0.5 }), 0.25), -1, 'half a second in, the second step');
  // sixteen steps, and only as many as the count says
  const sixteen = { ...SINE, ...sectionToParams('lfo', 1, { steps: Array.from({ length: 16 }, (_, k) => (k % 2 ? -0.5 : 0.5)), rate: 1 }), lfo1Shape: 'steps', mod1Src: 'lfo1', mod1Dst: 'level', mod1Amt: 0.1 };
  assert.equal(valueAt(trace(sixteen), 15.5 / 16), -0.5);
  // documents: the shape travels as a list, and only when it is in use
  const doc = paramsToPatch(base);
  assert.deepEqual(doc.lfos[0].steps, steps);
  assert.equal(doc.lfos[1].steps, undefined);
  const back = patchToParams(doc);
  assert.deepEqual([back.lfo1Shape, back.lfo1Steps, back.lfo1S1, back.lfo1S2, back.lfo1S4], ['steps', 4, 1, -1, 0]);
  assert.throws(() => sectionToParams('lfo', 1, { steps: [1] }), /2 to 16 values/);
  assert.throws(() => sectionToParams('lfo', 1, { steps: new Array(17).fill(0) }), /2 to 16 values/);
  // other shapes are what they were
  assert.equal(trace({ ...base, lfo1Shape: 'square' })[10], 1);
});

test('64 routes: all of them count, documents carry them, the 65th is refused', () => {
  assert.equal(MOD_SLOTS, 64);
  assert.equal(GGS_PARAMS.filter((d) => d.section === 'mod').length, 256);
  // 64 small pushes on the level add up to one big one
  const many = { ...SINE, level: 0.2, ...routesToParams(Array.from({ length: 64 }, () => ({ source: 'velocity', target: 'level', amount: 0.0125 }))) };
  const one = { ...SINE, level: 0.2, mod1Src: 'velocity', mod1Dst: 'level', mod1Amt: 0.8 };
  const a = voiceRun(many, 1, 40).L;
  const b = voiceRun(one, 1, 40).L;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  assert.ok(worst < 1e-6, `64 routes of 1/80 = one of 0.8 (difference ${worst.toExponential(1)})`);
  assert.equal(modulationRoutes(many).length, 64);
  assert.equal(many.mod64Src, 'velocity');
  const doc = paramsToPatch(many);
  assert.equal(doc.modulation.length, 64);
  assert.equal(modulationRoutes({ ...ggsDefaults(), ...patchToParams(doc) }).length, 64);
  assert.throws(() => routesToParams(new Array(65).fill({ source: 'lfo1', target: 'pitch', amount: 0.1 })), /64 modulation slots/);
  // a route in the last slot is found, and an empty slot in between does not hide the ones after it
  const sparse = { ...SINE, level: 0.2, mod64Src: 'velocity', mod64Dst: 'level', mod64Amt: 0.8 };
  assert.ok(same(voiceRun(sparse, 1, 40).L, b), 'slot 64 works like slot 1');
});

test('eight macros: from the patch, from the player, in documents; named after what they move', () => {
  assert.equal(MACRO_COUNT, 8);
  const p = { ...SINE, level: 0, macro8: 1, mod1Src: 'macro8', mod1Dst: 'level', mod1Amt: 1 };
  const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const fromPatch = renderPatch({ params: p, notes: [{ key: 60, start: 0, duration: 0.2, seed: 1 }], seconds: 0.3, fx: false }).channels[0];
  assert.ok(peak(fromPatch) > 0.3, 'macro 8 at 1 opens the level');
  const closed = renderPatch({ params: p, notes: [{ key: 60, start: 0, duration: 0.2, seed: 1 }], seconds: 0.3, fx: false, macros: [0, 0, 0, 0, 0, 0, 0, 0] }).channels[0];
  assert.equal(peak(closed), 0, 'the player holds macro 8 at 0: silence');
  // a short list of macro values leaves the others where the patch has them
  const short = renderPatch({ params: p, notes: [{ key: 60, start: 0, duration: 0.2, seed: 1 }], seconds: 0.3, fx: false, macros: [0, 0, 0, 0] }).channels[0];
  assert.ok(same(short, fromPatch), 'four values given: macros 5-8 keep their patch values');
  const doc = paramsToPatch(p);
  assert.equal(doc.macros.length, 8);
  assert.equal(patchToParams(doc).macro8, 1);
  assert.equal(patchToParams({ macros: [0.5, 0.25] }).macro2, 0.25, 'older documents with fewer macros still load');
  // names
  assert.equal(macroLabel(p, 8), 'Level');
  assert.equal(macroLabel(p, 7), 'Macro 7');
  assert.equal(macroLabel(p, 8, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'Swell']), 'Swell', 'a preset name wins');
  const two = { ...p, mod2Src: 'macro3', mod2Dst: 'f1Cutoff', mod2Amt: 0.4, mod3Src: 'lfo1', mod3Dst: 'oscAPos', mod3Amt: 0.2, mod3Via: 'macro3' };
  assert.equal(macroLabel(two, 3), 'F1 cutoff +1');
  assert.ok(macroUsed(two, 3) && macroUsed(two, 8) && !macroUsed(two, 1));
});

test('the rings: how far the matrix can move each target, and routes in words for the new sources', () => {
  const p = {
    ...ggsDefaults(), f1Cutoff: 1000,
    ...routesToParams([
      { source: 'env2', target: 'f1Cutoff', amount: 0.2 }, { source: 'lfo1', target: 'f1Cutoff', amount: 0.1 },
      { source: 'pressure', target: 'f1Cutoff', amount: -0.05 }, { source: 'velocity', target: 'oscAPos', amount: 0.3, via: 'chaos1' }
    ])
  };
  const r = modulationRanges(p);
  // env2 pushes up 0.2, the LFO both ways 0.1, pressure down 0.05
  assert.ok(Math.abs(r.f1Cutoff.hi - 0.3) < 1e-12 && Math.abs(r.f1Cutoff.lo + 0.15) < 1e-12 && r.f1Cutoff.routes === 3);
  // a bipolar "via" makes a one-way route swing both ways
  assert.deepEqual([r.oscAPos.lo, r.oscAPos.hi], [-0.3, 0.3]);
  assert.equal(r.f1Res, undefined);
  assert.equal(describeRoute(p, { source: 'chaos1', target: 'f1Cutoff', amount: 0.1 }), 'Filter 1 cutoff 500 Hz ↔ 2 kHz as Chaos 1 swings −1 ↔ 1');
  assert.equal(describeRoute(p, { source: 'macro7', target: 'oscAPos', amount: 0.25 }), 'Osc A position 0.5 → 0.75 as Macro 7 goes 0 → 1');
  assert.match(summarizePatch(p), /Chaos 1: lorenz, 0\.5 Hz, character 0\.5, its own path per note/);
  assert.doesNotMatch(summarizePatch(p), /Chaos 2/);
});
