// The "Winter Light" template: the post-classical ambient jazz style as a piece (docs/styles/post-classical-ambient-jazz.md).
// What the study says the style is, checked on the notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectFromTemplate, TEMPLATES, EFFECTS, INSTRUMENTS, sanitizeParams, songLength, ticksPerBar, evaluateComposition, STEP
} from '../src/index.js';
import postclassical from '../src/templates/postclassical.js';

const build = () => createProjectFromTemplate('postclassical');
const channel = (p, name) => p.channels.find((c) => c.name === name);
const pattern = (p, name) => p.patterns.find((x) => x.name === name);
const notesOf = (p, pat, ch) => (pattern(p, pat).notes[channel(p, ch).id] || []).slice().sort((a, b) => a.start - b.start || a.key - b.key);

test('Winter Light: a template that is a piece — 72 bars in E minor, the same every time, with settings that exist', () => {
  const p = build();
  const bar = ticksPerBar(p);
  assert.match(TEMPLATES.postclassical.label, /^Post-classical ambient jazz \(108 BPM, E minor/);
  assert.deepEqual([p.name, p.bpm, p.key, p.scale, songLength(p) / bar], ['Winter Light', 108, 'E', 'minor', 72]);
  const plain = (x) => JSON.stringify(x.patterns.map((pt) => Object.values(pt.notes).map((ns) => ns.map(({ id: _id, ...n }) => n))));
  assert.equal(plain(build()), plain(p), 'seeded: opening the template twice gives the same notes');
  // a setting that does not exist would be dropped without a word when the project is built: check the spec itself
  const spec = postclassical.spec();
  for (const c of spec.channels) {
    if (c.params) sanitizeParams(INSTRUMENTS[c.kind].params, c.params, { strict: true });
    assert.ok(INSTRUMENTS[c.kind].presets[c.preset], `${c.name}: preset ${c.preset}`);
    for (const fx of c.fx || []) sanitizeParams(EFFECTS[fx.type].params, fx.params, { strict: true });
  }
  for (const fx of [...spec.buses.flatMap((b) => b.fx), ...spec.master]) sanitizeParams(EFFECTS[fx.type].params, fx.params, { strict: true });
  // every part is inside its pattern, every pattern is placed, every channel plays
  for (const pt of p.patterns) {
    assert.ok(p.playlist.clips.some((c) => c.refId === pt.id), `${pt.name} is in the arrangement`);
    for (const [cid, notes] of Object.entries(pt.notes)) for (const n of notes) assert.ok(n.start + n.length <= pt.length, `${pt.name}: ${p.channels.find((c) => c.id === cid).name} runs past its end`);
  }
  for (const c of p.channels) assert.ok(p.patterns.some((pt) => pt.notes[c.id]?.length), `${c.name} plays`);
  // the studio's own lint of the song as written finds nothing to warn about
  const lint = evaluateComposition(p);
  assert.deepEqual([lint.counts.issue, lint.counts.warning], [0, 0], JSON.stringify(lint.findings.filter((f) => f.level !== 'info')));
  // one room for everything: no reverb on a channel's own insert, and every send arrives at a bus that has an effect
  for (const c of p.channels) assert.ok(!p.mixer[c.mixerTrack].effects.some((e) => /verb|shimmer/.test(e.type)), `${c.name} has no reverb of its own`);
  for (const m of p.mixer) for (const s of m.sends) assert.ok(p.mixer[s.to].effects.length, `a send to ${p.mixer[s.to].name}`);
  // another key: the pitched parts move together
  const a = createProjectFromTemplate('postclassical', { key: 'A' });
  assert.equal(a.key, 'A');
  assert.equal(notesOf(a, 'Bass home', 'Bass')[0].key - notesOf(p, 'Bass home', 'Bass')[0].key, 5);
});

test('Winter Light: harmony coloured by adding — E minor throughout, and one note from outside it, kept for the borrowed chord', () => {
  const p = build();
  const bar = ticksPerBar(p);
  const minor = new Set([4, 6, 7, 9, 11, 0, 2]);
  let outside = 0;
  for (const pt of p.patterns) {
    for (const c of p.channels.filter((ch) => INSTRUMENTS[ch.instrument.kind].melodic)) {
      for (const n of pt.notes[c.id] || []) {
        if (minor.has(n.key % 12)) continue;
        outside++;
        assert.equal(n.key % 12, 1, `${pt.name}: ${c.name} plays ${n.key}`);
        assert.match(pt.name, /away/, `the C# is only heard away from home (${pt.name})`);
        // …on the last chord of the phrase (A major, the borrowed IV), or as the bass's step into what follows it
        assert.ok(n.start >= 6 * bar, `${pt.name}: C# at bar ${n.start / bar + 1}`);
      }
    }
  }
  assert.ok(outside >= 8, `${outside} C sharps`);
  // no chord has a dominant seventh's tritone: nothing asks to resolve (the home chords are Em9, CM9, Gadd9, Dadd9)
  const held = notesOf(p, 'Strings home', 'Strings');
  assert.deepEqual([0, 2, 4, 6].map((b) => held.filter((n) => n.start === b * bar).map((n) => n.key % 12).sort((x, y) => x - y)), [[2, 6, 11], [0, 2, 7], [2, 7, 9], [4, 6, 9]]);
});

test('Winter Light: the figure — eighths in 3+3+2, one change every two bars, a top line that moves by step', () => {
  const p = build();
  const bar = ticksPerBar(p);
  const fig = notesOf(p, 'Piano home', 'Piano');
  assert.equal(fig.length, 64, 'eight eighths a bar for eight bars');
  assert.ok(fig.every((n) => n.start % (STEP * 2) === 0), 'on the eighths');
  const bars = Array.from({ length: 8 }, (_, b) => fig.filter((n) => Math.floor(n.start / bar) === b));
  for (const [b, notes] of bars.entries()) {
    assert.equal(notes.length, 8);
    const lean = notes.filter((_, e) => e === 0 || e === 3 || e === 6).map((n) => n.velocity);
    const rest = notes.filter((_, e) => !(e === 0 || e === 3 || e === 6)).map((n) => n.velocity);
    assert.ok(Math.min(...lean) > Math.max(...rest), `bar ${b + 1}: the first of each group leans`);
    assert.ok(Math.max(...notes.map((n) => n.velocity)) < 0.6, 'soft');
  }
  // each chord lasts two bars; the second says the same notes with one thing changed
  for (let c = 0; c < 4; c++) {
    const [one, two] = [bars[c * 2].map((n) => n.key), bars[c * 2 + 1].map((n) => n.key)];
    assert.deepEqual([...new Set(one)].sort(), [...new Set(two)].sort(), 'the same chord');
    const moved = one.filter((k, e) => k !== two[e]).length;
    assert.ok(moved >= 2 && moved <= 3, `chord ${c + 1}: ${moved} of 8 notes differ`);
    assert.deepEqual(one.slice(0, 3), two.slice(0, 3), 'the first group is the same');
  }
  // the tune is the top of the figure: D – B – B – A, a third then steps
  const top = [0, 2, 4, 6].map((b) => Math.max(...bars[b].map((n) => n.key)));
  assert.deepEqual(top, [74, 71, 71, 69]);
  // the piece opens on the figure thinned out, not on a different idea
  const seed = notesOf(p, 'Seed', 'Piano');
  assert.equal(seed.length, 40);
  const full = new Set(fig.map((n) => `${n.start}:${n.key}`));
  assert.ok(seed.every((n) => full.has(`${n.start}:${n.key}`)), 'every note of the opening is a note of the figure');
});

test('Winter Light: the form is an additive arc — layers arrive one by one to a peak, then leave', () => {
  const p = build();
  const bar = ticksPerBar(p);
  const sounding = (from) => {
    const names = new Set();
    for (const clip of p.playlist.clips) {
      if (clip.start >= (from + 8) * bar || clip.start + clip.length <= from * bar) continue;
      const pt = p.patterns.find((x) => x.id === clip.refId);
      for (const [cid, notes] of Object.entries(pt.notes)) if (notes.length) names.add(p.channels.find((c) => c.id === cid).name);
    }
    return [...names].sort();
  };
  const sections = [0, 8, 16, 24, 32, 40, 48, 56, 64].map(sounding);
  assert.deepEqual(sections.map((s) => s.length), [1, 1, 3, 5, 8, 9, 4, 2, 2]);
  assert.deepEqual(sections[0], ['Piano']);
  assert.deepEqual(sections[2], ['Bass', 'Pad', 'Piano']);
  assert.deepEqual(sections[5], ['Bass', 'Cello', 'Pad', 'Piano', 'Rain', 'Rim', 'Shaker', 'Strings', 'Vibes']);
  assert.deepEqual(sections[8], ['Pad', 'Piano']);
  assert.deepEqual(p.markers.map((m) => m.name), ['Alone', 'Left hand', 'Bass and pad', 'Other chords', 'Rain', 'Peak', 'Leaving', 'Alone again', 'Last chord']);
  // the left hand steps back at the peak, where the bass moves and the cello has its register
  const leftHand = p.playlist.clips.filter((c) => /Left hand/.test(p.patterns.find((x) => x.id === c.refId).name));
  assert.ok(!leftHand.some((c) => c.start < 48 * bar && c.start + c.length > 32 * bar));
  // time is colour: no kick, no snare, a rim on the third beat only
  assert.ok(!p.channels.some((c) => ['kick', 'snare', 'clap'].includes(c.instrument.kind)));
  assert.ok(notesOf(p, 'Brushes', 'Rim').every((n) => n.start % bar >= 8 * STEP));
  // the second piano is two, left and right, quieter than the first
  const rain = notesOf(p, 'Rain home', 'Rain');
  assert.deepEqual([...new Set(rain.map((n) => n.pan))].sort(), [-0.55, 0.55]);
  assert.ok(Math.max(...rain.map((n) => n.velocity)) < 0.36);
  // the pad breathes (the only electronic voice, and it is made to move like a player)
  assert.ok(notesOf(p, 'Pad home', 'Pad').every((n) => n.expression?.pressure && n.expression?.timbre));
  // and the last thing heard is the first chord, rolled from the bottom and left to ring for four bars
  const last = notesOf(p, 'Last chord', 'Piano').filter((n) => n.start >= 4 * bar);
  assert.deepEqual(last.map((n) => n.key), [40, 52, 62, 66, 67, 71]);
  assert.ok(last.every((n, i) => n.start === 4 * bar + i * 36 && n.start + n.length === 8 * bar - STEP));
});
