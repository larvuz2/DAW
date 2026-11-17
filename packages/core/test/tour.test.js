// The "Effects & Engines Tour" template: a song that uses everything the studio's own DSP has, and the things the
// review of 0.13.0 found around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectFromTemplate, TEMPLATES, EFFECTS, INSTRUMENTS, sanitizeParams, sanitizeValue, describeInstruments, normalizeTuning, chordPurity, scalePitchClasses,
  songLength, songTail, ticksPerBar, evaluateComposition, createEffect, applyOps
} from '../src/index.js';
import tour from '../src/templates/tour.js';

test('the tour: every studio effect, the three engines, a supersaw of unison copies — and every setting it names is real', () => {
  const p = createProjectFromTemplate('tour');
  assert.equal(TEMPLATES.tour.label.includes('(122 BPM'), true);
  assert.deepEqual([p.bpm, p.key, p.scale, songLength(p) / ticksPerBar(p)], [122, 'A', 'minor', 40]);
  const used = new Set(p.mixer.flatMap((m) => m.effects.map((e) => e.type)));
  for (const [type, def] of Object.entries(EFFECTS)) if (def.dsp) assert.ok(used.has(type), `the song uses ${type}`);
  const kinds = new Set(p.channels.map((c) => c.instrument.kind));
  for (const [kind, def] of Object.entries(INSTRUMENTS)) if (def.engine) assert.ok(kinds.has(kind), `the song uses ${kind}`);
  const saw = p.channels.find((c) => c.name === 'Supersaw').instrument.params;
  assert.deepEqual([saw.oscAUnison, saw.oscAUniLaw, saw.oscAStack, saw.driveOs], [9, 'super', 'octave', '4x']);
  // the true-peak limiter is the last thing on the master, after the limiter that was always there
  assert.deepEqual(p.mixer[0].effects.map((e) => e.type), ['limiter', 'maximizer']);
  // more parts than a new project has inserts: it got the inserts it needs, and every send arrives somewhere
  assert.ok(p.mixer.length >= 19);
  for (const m of p.mixer) for (const s of m.sends) assert.ok(p.mixer[s.to].effects.length, `a send to ${p.mixer[s.to].name}`);
  // a setting that does not exist would be dropped without a word when the project is built: check the spec itself
  const spec = tour.spec();
  for (const c of spec.channels) {
    if (c.params) sanitizeParams(INSTRUMENTS[c.kind].params, c.params, { strict: true });
    assert.ok(INSTRUMENTS[c.kind].presets[c.preset], `${c.name}: preset ${c.preset}`);
    for (const fx of c.fx || []) sanitizeParams(EFFECTS[fx.type].params, Object.fromEntries(Object.entries(fx.params).filter(([k]) => k !== 'source')), { strict: true });
  }
  for (const fx of [...spec.buses.flatMap((b) => b.fx), ...spec.masterEnd]) sanitizeParams(EFFECTS[fx.type].params, fx.params, { strict: true });
  // every part is inside its pattern, every channel plays, and nothing is outside A minor but the G# of the E chord
  const pcs = new Set([...scalePitchClasses('A', 'minor'), 8]);
  for (const pt of p.patterns) {
    for (const [cid, notes] of Object.entries(pt.notes)) {
      const ch = p.channels.find((c) => c.id === cid);
      for (const n of notes) {
        assert.ok(n.start + n.length <= pt.length, `${pt.name}: ${ch.name} runs past its end`);
        if (INSTRUMENTS[ch.instrument.kind].melodic) assert.ok(pcs.has(n.key % 12), `${pt.name}: ${ch.name} plays ${n.key}`);
      }
    }
  }
  const placed = p.patterns.filter((pt) => p.playlist.clips.some((c) => c.refId === pt.id));
  for (const c of p.channels) assert.ok(placed.some((pt) => pt.notes[c.id]?.length), `${c.name} plays`);
  assert.equal(evaluateComposition(p).counts.issue, 0);
  assert.equal(evaluateComposition(p).counts.warning, 0);
});

test('the tour is in just intonation on its key, and every chord it holds is beatless there', () => {
  const p = createProjectFromTemplate('tour');
  assert.deepEqual(p.tuning, { system: 'just', root: 'A', a4: 440 });
  const tuning = normalizeTuning(p.tuning);
  for (const name of ['Glass', 'Gate Pad', 'Supersaw']) {
    const ch = p.channels.find((c) => c.name === name);
    for (const pt of p.patterns) {
      const chords = new Map();
      for (const n of pt.notes[ch.id] || []) chords.set(n.start, [...(chords.get(n.start) || []), n.key]);
      for (const keys of chords.values()) assert.ok(chordPurity(tuning, keys).worstBeatsHz < 0.05, `${name} in ${pt.name}: ${keys} beats`);
    }
  }
  // moved to another key, the tuning moves with it: the chords stay the ratios they were
  const inD = createProjectFromTemplate('tour', { key: 'D' });
  assert.deepEqual([inD.key, inD.tuning.root], ['D', 'D']);
  // (a template without a tuning has none)
  assert.equal(createProjectFromTemplate('house').tuning?.system ?? 'equal', 'equal');
});

test('an export leaves room for what still rings: the tail of a song, from its instruments and its effects', () => {
  assert.equal(songTail(createProjectFromTemplate('house')), 2, 'short sounds: the two seconds there always were');
  assert.equal(songTail(createProjectFromTemplate('empty')), 2);
  assert.equal(songTail(createProjectFromTemplate('tour')), 8, 'a tubular bell into a shimmer: as long as it gets');
  // a long hall on a short sound: most of its decay
  let p = createProjectFromTemplate('empty');
  p = applyOps(p, [{ type: 'effect/add', index: 0, effect: { ...createEffect('algoverb', { decay: 6 }), id: 'fx_a' } }]);
  assert.ok(Math.abs(songTail(p) - 0.67 * 6) < 0.01, String(songTail(p)));
  // …frozen or switched off, it adds nothing
  assert.equal(songTail(applyOps(p, [{ type: 'effect/update', index: 0, effectId: 'fx_a', patch: { enabled: false } }])), 2);
  assert.equal(songTail(applyOps(p, [{ type: 'effect/update', index: 0, effectId: 'fx_a', patch: { params: { freeze: true } } }])), 2);
  assert.equal(songTail(null), 2);
});

test('found by the review of 0.13.0: instrument settings are described to Claude, and a switch takes true or false', () => {
  for (const kind of ['analog', 'additive', 'modal']) {
    const d = describeInstruments().find((i) => i.kind === kind);
    for (const param of d.params) assert.ok(param.description && param.description.length > 20, `${kind}.${param.key} says what it does`);
  }
  const freeze = EFFECTS.algoverb.params.find((d) => d.key === 'freeze');
  for (const bad of ['yes', 'on', 1, 0, null, 'true']) assert.throws(() => sanitizeValue(freeze, bad, true), /is a switch: it must be true or false/, JSON.stringify(bad));
  assert.equal(sanitizeValue(freeze, true, true), true);
  assert.equal(sanitizeValue(freeze, false, true), false);
  // (what is loaded from a file is still read leniently)
  assert.equal(sanitizeValue(freeze, 'true'), true);
  assert.equal(sanitizeValue(freeze, 'yes'), false);
});
