// Envelopes (delay · attack · hold · decay · sustain · release with a curve per stage) and click-free live edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GgsVoice } from '../src/voice.js';
import { renderPatch } from '../src/render.js';
import { ggsDefaults, completeParams, migrateParams, envelopeAt, envShape, envCurveK, ggsParamDef } from '../src/params.js';
import { paramsToPatch, patchToParams } from '../src/patch.js';

const FS = 48000;
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual.toFixed(4)} (expected ${expected.toFixed(4)} ± ${tol})`);
// a pure sine through no filter: what comes out is the amp envelope times a constant
const SINE = { ...ggsDefaults(), f1On: false, oscATable: 'basic', oscAPos: 0, oscARand: 0, oscALevel: 1, velSens: 0 };

/** Peak of |x| in a 2 ms window centred on t seconds (the sine is at 1760 Hz: several cycles per window). */
function levelAt(x, t) {
  const c = Math.round(t * FS);
  let peak = 0;
  for (let i = Math.max(0, c - 48); i < Math.min(x.length, c + 48); i++) peak = Math.max(peak, Math.abs(x[i]));
  return peak;
}

test('six stages, each where it should be, each with its own curve', () => {
  const env = { delay: 0.05, attack: 0.04, hold: 0.06, decay: 0.12, sustain: 0.4, release: 0.15, attackCurve: 0.6, decayCurve: -0.7, releaseCurve: 0 };
  const params = { ...SINE, env1Delay: env.delay, env1A: env.attack, env1Hold: env.hold, env1D: env.decay, env1S: env.sustain, env1R: env.release, env1ACurve: env.attackCurve, env1DCurve: env.decayCurve, env1RCurve: env.releaseCurve };
  const held = 0.4;
  const x = renderPatch({ params, notes: [{ key: 93, start: 0, duration: held, seed: 1 }], sampleRate: FS, seconds: 0.7, fx: false }).channels[0];
  const full = levelAt(x, env.delay + env.attack + env.hold / 2); // the hold plateau = level 1
  assert.ok(full > 0.3, 'the note sounds');
  assert.ok(levelAt(x, 0.02) < 1e-4, 'silent during the delay');
  for (const t of [0.06, 0.07, 0.085, 0.1, 0.13, 0.16, 0.19, 0.24, 0.3, 0.38, 0.42, 0.46, 0.5, 0.54]) {
    // (the measurement looks at ±1 ms, so on a steep stretch it is held to the range the formula covers in that time)
    const around = [-0.001, 0, 0.001].map((d) => envelopeAt(env, t + d, held));
    const got = levelAt(x, t) / full;
    assert.ok(got > Math.min(...around) - 0.03 && got < Math.max(...around) + 0.03, `level at ${t} s: ${got.toFixed(3)}, formula ${around[1].toFixed(3)}`);
  }
  assert.ok(levelAt(x, 0.6) < 1e-4, 'over after the release');
  // the hold really holds
  near(levelAt(x, env.delay + env.attack + 0.01) / full, 1, 0.01, 'start of the hold');
  near(levelAt(x, env.delay + env.attack + env.hold - 0.005) / full, 1, 0.01, 'end of the hold');
});

test('stage curves: 0 is a straight line, negative is fast first, positive is slow first', () => {
  near(envShape(0.5, envCurveK(0)), 0.5, 1e-12, 'straight');
  assert.ok(envShape(0.5, envCurveK(-0.5)) > 0.85, 'negative: most of the way after half the time');
  assert.ok(envShape(0.5, envCurveK(0.5)) < 0.15, 'positive: hardly started after half the time');
  for (const c of [-1, -0.3, 0, 0.4, 1]) { near(envShape(0, envCurveK(c)), 0, 1e-12, 'starts at 0'); near(envShape(1, envCurveK(c)), 1, 1e-12, 'ends at 1'); }
  // heard, not only computed: a linear attack is half-way at half time
  const x = renderPatch({ params: { ...SINE, env1A: 0.2, env1ACurve: 0 }, notes: [{ key: 93, start: 0, duration: 0.5, seed: 1 }], sampleRate: FS, seconds: 0.5, fx: false }).channels[0];
  near(levelAt(x, 0.1) / levelAt(x, 0.3), 0.5, 0.02, 'linear attack at half time');
  for (const key of ['env1Delay', 'env1Hold', 'env3ACurve', 'env4DCurve', 'env2RCurve']) assert.ok(ggsParamDef(key), `${key} is a parameter`);
});

test('patches from before the per-stage curves keep their exact shape', () => {
  for (const c of [-1, -0.4, 0, 0.3, 1]) {
    const m = migrateParams({ env2Curve: c, env2A: 0.1 });
    assert.equal(m.env2Curve, undefined, 'the old key is dropped');
    assert.equal(m.env2A, 0.1, 'other values are kept');
    const ka = 1.5 * Math.pow(3, c);
    const kd = 4.6 * Math.pow(4, c);
    for (const x of [0.1, 0.35, 0.8]) {
      near(envShape(x, envCurveK(m.env2ACurve)), (1 - Math.exp(-ka * x)) / (1 - Math.exp(-ka)), 1e-9, `attack at ${x}, old curve ${c}`);
      near(1 - envShape(x, envCurveK(m.env2DCurve)), (Math.exp(-kd * x) - Math.exp(-kd)) / (1 - Math.exp(-kd)), 1e-9, `decay at ${x}, old curve ${c}`);
      assert.equal(m.env2RCurve, m.env2DCurve);
    }
    assert.ok(m.env2ACurve >= -1 && m.env2DCurve >= -1, 'inside the range of the new controls');
  }
  // the defaults are (within a hair for the attack) the old default shape
  const d = ggsDefaults();
  assert.equal(d.env1DCurve, migrateParams({ env1Curve: 0 }).env1DCurve);
  near(d.env1ACurve, migrateParams({ env1Curve: 0 }).env1ACurve, 0.02, 'default attack curve');
  // every way in: voices, complete params, patch files
  assert.equal(completeParams({ env3Curve: 1 }).env3DCurve, -1);
  assert.equal(completeParams({ env3Curve: 1 }).env3Curve, undefined);
  assert.equal(patchToParams({ envelopes: [{ id: 3, curve: 1, attack: 0.2 }] }).env3RCurve, -1);
  assert.equal(completeParams({ env3Curve: 1, env3DCurve: 0.2 }).env3DCurve, 0.2, 'an explicit stage curve wins');
  const doc = paramsToPatch({ ...d, env2Delay: 0.3, env2Hold: 0.1, env2ACurve: 0.5 });
  assert.deepEqual([doc.envelopes[1].delay, doc.envelopes[1].hold, doc.envelopes[1].attackCurve], [0.3, 0.1, 0.5]);
  assert.equal(patchToParams(doc).env2Hold, 0.1);
});

test('a key let go during the delay never sounds; a long delay does not end the note early', () => {
  const quiet = renderPatch({ params: { ...SINE, env1Delay: 0.3 }, notes: [{ key: 93, start: 0, duration: 0.1, seed: 1 }], sampleRate: FS, seconds: 0.8, fx: false }).channels[0];
  assert.ok(quiet.every((v) => v === 0), 'released before the delay was over: silence');
  const late = renderPatch({ params: { ...SINE, env1Delay: 0.3 }, notes: [{ key: 93, start: 0, duration: 0.6, seed: 1 }], sampleRate: FS, seconds: 0.8, fx: false }).channels[0];
  assert.ok(levelAt(late, 0.2) === 0 && levelAt(late, 0.5) > 0.3, 'silent, then there');
});

/** One second of a voice with an edit half-way; returns { x, at } (left channel, sample index of the edit). */
function edited(base, delta, opts = {}) {
  const v = new GgsVoice({ sampleRate: FS, params: { ...SINE, oscALevel: 0.8, env1A: 0.001, ...base }, key: 45, velocity: 0.8, seed: 3 });
  const n = FS;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const at = 24064;
  for (let i = 0; i < n; i += 128) {
    if (i === at) v.setParams(delta);
    if (opts.then && i === at + opts.then.after) v.setParams(opts.then.delta);
    v.process(L, R, i, 128, { pitch: 0, pressure: 0, timbre: 0, time: i / FS });
  }
  return { x: L, at, voice: v };
}
/** Largest second difference (what a click is made of) in a range. */
function curvature(x, a, b) {
  let m = 0;
  for (let i = Math.max(2, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
}
function rms(x, a, b) {
  let e = 0;
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return Math.sqrt(e / (b - a));
}

test('live structural edits do not click: oscillators fade in and out, the voice dips around a filter swap', () => {
  const B = { oscBTable: 'basic', oscBPos: 0, oscBOct: 1, oscBRand: 1 };
  const cases = [
    ['oscillator switched on', B, { oscBOn: true }, 0.002],
    ['oscillator switched off', { ...B, oscBOn: true }, { oscBOn: false }, 0.002],
    ['unison 1 → 5', {}, { oscAUnison: 5 }, 0.002],
    ['routing serial → parallel', { f1On: true, f1Cutoff: 300, f2On: true, f2Type: 'hp12', f2Cutoff: 2000 }, { filterRoute: 'parallel' }, 0.002],
    ['filter lp24 → hp24', { f1On: true, f1Cutoff: 100 }, { f1Type: 'hp24' }, 0.002],
    ['filter lp24 → ladder24', { f1On: true, f1Cutoff: 400 }, { f1Type: 'ladder24' }, 0.002],
    ['filter switched off', { f1On: true, f1Type: 'hp12', f1Cutoff: 600 }, { f1On: false }, 0.002]
  ];
  for (const [label, base, delta, limit] of cases) {
    const { x, at, voice } = edited(base, delta);
    // 0.8.0 measured 0.05 … 0.15 here (a step); a fade leaves well under a hundredth of that
    const c = curvature(x, at - 10, at + 2400);
    assert.ok(c < limit, `${label}: curvature ${c.toExponential(2)} at the edit (limit ${limit})`);
    assert.equal(voice.next, null, `${label}: the edit has been applied`);
    for (const k of Object.keys(delta)) assert.equal(voice.p[k], delta[k], `${label}: ${k} took effect`);
    assert.ok(rms(x, FS - 4800, FS) > 0.01, `${label}: the note is still sounding afterwards`);
  }
  // the result is the patch that was asked for: same level as a note that started that way
  const swapped = edited({ f1On: true, f1Cutoff: 100 }, { f1Type: 'hp24' }).x;
  const fresh = edited({ f1On: true, f1Cutoff: 100, f1Type: 'hp24' }, {}).x;
  near(rms(swapped, FS - 9600, FS), rms(fresh, FS - 9600, FS), rms(fresh, FS - 9600, FS) * 0.02, 'level after the filter swap');
});

test('an oscillator that modulates another (FM) fades with its edits too, and leaves nothing behind when switched off', () => {
  // the "FM bell" layout: A is heard, B is only its modulator (level 0)
  const bell = { oscAFmFrom: 'B', oscAFm: 0.35, oscBOn: true, oscBTable: 'basic', oscBPos: 0, oscBLevel: 0, oscBOct: 1, oscBRand: 0 };
  for (const [label, delta] of [['unison of the modulator 1 → 4', { oscBUnison: 4 }], ['warp of the modulator', { oscBWarp: 'sync' }], ['table of the modulator', { oscBTable: 'tilt' }], ['modulator switched off', { oscBOn: false }]]) {
    const { x, at } = edited(bell, delta);
    const steady = Math.max(curvature(x, at - 9600, at - 10), curvature(x, FS - 9600, FS));
    const c = curvature(x, at - 10, at + 2400);
    // 0.9.0 measured 0.24 … 0.36 here: the modulator was swapped at full depth. Now the FM depth sweeps down and
    // back up in a few milliseconds — a quick change of timbre, a few times the steady curvature, not a step.
    assert.ok(c < Math.max(0.012, steady * 4), `${label}: curvature ${c.toExponential(2)} at the edit (steady ${steady.toExponential(2)})`);
  }
  // switched off, the modulator is gone: the note is the same as one that never had it
  const off = edited(bell, { oscBOn: false }).x;
  const never = edited({ oscAFmFrom: 'B', oscAFm: 0.35 }, {}).x;
  let worst = 0;
  for (let i = FS - 9600; i < FS; i++) worst = Math.max(worst, Math.abs(off[i] - never[i]));
  assert.ok(worst < 1e-6, `no trace of the modulator after it is switched off (difference ${worst.toExponential(1)})`);
  // and switched on under a held note it arrives without a step
  const on = edited({ oscAFmFrom: 'B', oscAFm: 0.35, oscBTable: 'basic', oscBPos: 0, oscBLevel: 0, oscBOct: 1, oscBRand: 0 }, { oscBOn: true });
  assert.ok(curvature(on.x, on.at - 10, on.at + 2400) < 0.004);
  assert.ok(rms(on.x, FS - 4800, FS) > 0.05);
});

test('an edit elsewhere on the buses does not cut off a filter that is still ringing', () => {
  // a comb ringing after a pluck: the sub's wave is changed (its level is 0), the noise type, the routing
  const pluck = { oscALevel: 0, noiseLevel: 0, f1On: true, f1Type: 'comb', f1Cutoff: 220, f1Res: 0.95, f1Morph: 0.2, env1D: 6, env1S: 1, env2D: 0.03, env2S: 0, mod1Src: 'env2', mod1Dst: 'noiseLevel', mod1Amt: 1 };
  const plain = edited(pluck, {}).x;
  assert.ok(rms(plain, FS - 9600, FS) > 1e-3, 'the comb is still ringing at the end');
  for (const delta of [{ subWave: 'square' }, { noiseType: 'pink' }, { subDest: 'f2' }, { filterRoute: 'parallel' }]) {
    const x = edited(pluck, delta).x;
    const ratio = rms(x, FS - 9600, FS) / rms(plain, FS - 9600, FS);
    assert.ok(ratio > 0.7 && ratio < 1.4, `${Object.keys(delta)[0]}: the comb rings on (${ratio.toFixed(2)} of the unedited level)`);
  }
  // a filter that is switched on does start from silence, and a new model from its own
  const cold = edited({ ...pluck, f2On: false, f2Type: 'lp12', f2Cutoff: 300 }, { f2On: true });
  assert.ok(curvature(cold.x, cold.at - 10, cold.at + 2400) < 0.02);
  assert.equal(edited(pluck, { f1Type: 'combNeg' }).voice.p.f1Type, 'combNeg');
});

test('a wavetable swap fades through silence; knob moves do not dip; an edit taken back leaves no trace', () => {
  const { x, at } = edited({}, { oscATable: 'formant' });
  const steady = Math.max(curvature(x, at - 9600, at - 10), curvature(x, FS - 9600, FS));
  assert.ok(curvature(x, at - 10, at + 2400) <= steady * 1.05, 'no curvature beyond what the two waves have themselves');
  let low = 1;
  for (let i = at; i < at + 480; i += 24) low = Math.min(low, rms(x, i, i + 24));
  assert.ok(low < 0.02 * rms(x, at - 4800, at), 'the oscillator is silent at the moment of the swap');
  // the fade is short: back to full level within 12 ms
  near(rms(x, at + 600, at + 5400), rms(x, FS - 4800, FS), rms(x, FS - 4800, FS) * 0.05, 'level right after the swap');

  const knob = edited({ f1On: true, f1Cutoff: 4000 }, { f1Cutoff: 3000, oscALevel: 0.7, f1Res: 0.2 }).x;
  let dip = 1;
  for (let i = at; i < at + 960; i += 48) dip = Math.min(dip, rms(knob, i, i + 436) / rms(knob, at - 4800, at));
  assert.ok(dip > 0.8, `a knob move is applied at once, without a fade (lowest level ${dip.toFixed(2)})`);

  const back = edited({ oscBTable: 'basic', oscBPos: 0, oscBOct: 1 }, { oscBOn: true }, { then: { after: 128, delta: { oscBOn: false } } });
  assert.equal(back.voice.next, null);
  assert.equal(back.voice.p.oscBOn, false);
  near(rms(back.x, FS - 4800, FS), rms(back.x, at - 4800, at), 1e-3, 'same sound as before');
  // several edits in a row end in the last state
  const many = edited({ f1On: true }, { f1Type: 'acid' }, { then: { after: 256, delta: { f1Type: 'phaser', oscBOn: true } } });
  assert.equal(many.voice.p.f1Type, 'phaser');
  assert.equal(many.voice.p.oscBOn, true);
  assert.equal(many.voice.next, null);
});
