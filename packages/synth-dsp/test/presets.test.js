import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GGS_PRESETS, GGS_PRESET_INFO, GGS_PRESET_CATEGORIES, ggsParamDef, ggsDefaults, renderPatch, modulationRoutes,
  paramsToPatch, patchToParams, sectionToParams, paramsToSection, routesToParams, describeSynth, PATCH_FORMAT, WAVETABLE_IDS
} from '../src/index.js';
// a development-only dependency of the tests: the studio's own loudness meter
import { analyzeAudio } from '../../core/src/analysis.js';

const NAMES = Object.keys(GGS_PRESETS).filter((n) => n !== 'Init');

test('the library: 30 presets in six families, every value valid', () => {
  assert.equal(NAMES.length, 30);
  const families = new Map(GGS_PRESET_CATEGORIES.map(([id]) => [id, 0]));
  for (const name of NAMES) {
    const info = GGS_PRESET_INFO[name];
    assert.ok(info && info.description && info.expression, `${name} is documented`);
    assert.equal(info.macros.length, 4, `${name} names its four macros`);
    assert.ok(families.has(info.category), `${name}: category ${info.category}`);
    families.set(info.category, families.get(info.category) + 1);
    for (const [key, value] of Object.entries(GGS_PRESETS[name])) {
      const def = ggsParamDef(key);
      assert.ok(def, `${name}: unknown param ${key}`);
      if (def.type === 'number') assert.ok(typeof value === 'number' && value >= def.min && value <= def.max, `${name}.${key} = ${value}`);
      else if (def.type === 'select') assert.ok(def.options.includes(value), `${name}.${key} = ${value}`);
      else assert.equal(typeof value, 'boolean', `${name}.${key}`);
    }
    // every preset answers to a performance: pressure and slide are routed somewhere
    const sources = new Set(modulationRoutes({ ...ggsDefaults(), ...GGS_PRESETS[name] }).flatMap((r) => [r.source, r.via]));
    assert.ok(sources.has('pressure'), `${name} uses pressure`);
    assert.ok(sources.has('timbre'), `${name} uses slide`);
    assert.ok(['macro1', 'macro2', 'macro3', 'macro4'].some((m) => sources.has(m)), `${name} assigns macros`);
  }
  for (const [id, count] of families) assert.equal(count, 5, `five ${id} presets`);
});

// The levelling policy (scripts/level-presets.mjs): one note at velocity 0.8 peaks at -18 LUFS (loudest 400 ms),
// unless its sample peak would pass -9 dBFS — sharp attacks are capped by their peak instead.
test('presets are levelled: one note lands at -18 LUFS or at the peak cap, and pressure/slide are audible', () => {
  for (const name of NAMES) {
    const params = GGS_PRESETS[name];
    const key = GGS_PRESET_INFO[name].test?.key ?? 60;
    const duration = (params.env1A ?? 0.005) > 0.3 ? 5 : 2;
    const note = { key, velocity: 0.8, start: 0.05, duration, seed: 2 };
    const plain = renderPatch({ params, notes: [note], seconds: duration + 0.6, sampleRate: 48000 });
    assert.ok(plain.channels[0].every(Number.isFinite), `${name}: finite`);
    const a = analyzeAudio(plain, { lite: true });
    assert.ok(a.momentaryMaxLufs < -16, `${name}: ${a.momentaryMaxLufs} LUFS is too loud`);
    assert.ok(a.momentaryMaxLufs > -20 || a.peakDb > -12, `${name}: ${a.momentaryMaxLufs} LUFS (peak ${a.peakDb} dBFS) is too quiet`);
    assert.ok(a.peakDb < -8, `${name}: peak ${a.peakDb} dBFS`);
    // the same note played with pressure and slide must not be the same audio
    const up = [{ t: 0, v: 0 }, { t: 0.5, v: 1 }];
    const pressed = renderPatch({ params, notes: [{ ...note, pressure: up, timbre: up }], seconds: 1.2, sampleRate: 48000 });
    let diff = 0;
    let peak = 0;
    for (let i = 4800; i < 48000; i++) {
      diff = Math.max(diff, Math.abs(pressed.channels[0][i] - plain.channels[0][i]));
      peak = Math.max(peak, Math.abs(plain.channels[0][i]));
    }
    assert.ok(diff > peak * 0.03, `${name}: expression changes the sound (${(diff / peak).toFixed(3)} of its level)`);
  }
});

test('a four-note chord of every preset stays within 1 dB of full scale', () => {
  for (const name of NAMES) {
    const info = GGS_PRESET_INFO[name];
    const root = info.test?.key ?? 60;
    const keys = info.category === 'bass' ? [root] : [root, root + 4, root + 7, root + 11];
    const r = renderPatch({ params: GGS_PRESETS[name], notes: keys.map((key, i) => ({ key, velocity: 0.8, start: 0.02, duration: 1.5, seed: i })), seconds: 2, sampleRate: 44100 });
    let peak = 0;
    for (const ch of r.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak < 1.12, `${name}: the chord peaks at ${peak.toFixed(2)}`);
  }
});

test('patch documents: round trip, partial documents and helpful errors', () => {
  for (const name of Object.keys(GGS_PRESETS)) {
    const full = { ...ggsDefaults(), ...GGS_PRESETS[name] };
    const doc = paramsToPatch(full, { name });
    assert.equal(doc.format, PATCH_FORMAT);
    assert.equal(doc.name, name);
    assert.equal(doc.oscillators.length, 3);
    const back = { ...ggsDefaults(), ...patchToParams(JSON.parse(JSON.stringify(doc))) };
    // routes are repacked into the first slots; everything else is identical
    assert.deepEqual(modulationRoutes(back).map(({ slot: _s, ...r }) => r), modulationRoutes(full).map(({ slot: _s, ...r }) => r), name);
    for (const key of Object.keys(full)) if (!key.startsWith('mod')) assert.equal(back[key], full[key], `${name}.${key}`);
  }
  // the example from the product plan
  const params = patchToParams({
    format: 'ggs-synth-patch', version: 1, name: 'Glass Horizon',
    oscillators: [{ id: 'osc_a', table: 'glass', position: 0.35, unison: 3, detune: 7 }],
    modulation: [{ source: 'pressure', target: 'oscAPos', amount: 0.42 }],
    voice: { polyphony: 32 }
  });
  assert.equal(params.oscATable, 'glass');
  assert.equal(params.oscAPos, 0.35);
  assert.equal(params.mod1Src, 'pressure');
  assert.equal(params.mod2Src, 'none', 'a modulation list replaces all slots');
  assert.equal(params.polyphony, 32);
  assert.equal(params.oscBOn, undefined, 'what the document does not mention is left alone');

  assert.deepEqual(sectionToParams('filter', 2, { cutoff: 800, keyTrack: 0.5 }), { f2Cutoff: 800, f2Key: 0.5 });
  assert.equal(paramsToSection(ggsDefaults(), 'envelope', 1).sustain, 1);
  assert.throws(() => sectionToParams('filter', 1, { frequency: 800 }), /Unknown filter field "frequency". Valid: on, type, cutoff/);
  assert.throws(() => patchToParams({ oscillators: [{ id: 'D' }] }), /Unknown oscillator "D"/);
  assert.throws(() => patchToParams({ format: 'serum' }), /Not a GGS Synth patch/);
  assert.throws(() => patchToParams({ version: 99 }), /version 99/);
  assert.throws(() => patchToParams({ effects: { phaser: {} } }), /Unknown effect "phaser"/);
  assert.throws(() => routesToParams([{ source: 'lfo9', target: 'pitch', amount: 0.1 }]), /Unknown modulation source "lfo9"/);
  assert.throws(() => routesToParams([{ source: 'lfo1', target: 'cutoff', amount: 0.1 }]), /Unknown modulation target "cutoff".*f1Cutoff/);
  assert.throws(() => routesToParams([{ source: 'lfo1', target: 'pitch', amount: 3 }]), /-1 to 1/);
  assert.throws(() => routesToParams(new Array(17).fill({ source: 'lfo1', target: 'pitch', amount: 0.1 })), /16 modulation slots/);
  const ref = describeSynth();
  assert.match(ref.oscillator.table, new RegExp(WAVETABLE_IDS[0]));
  assert.match(ref.filter.cutoff, /20\.\.20000 Hz/);
  assert.equal(ref.counts.modulationSlots, 16);
});
