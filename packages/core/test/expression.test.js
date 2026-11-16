import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCurve, sanitizeExpression, curveValueAt, flattenCurve, simplifyCurve, sliceCurve, transformCurve, makeCurve,
  describeExpression, expressionFields, MAX_EXPRESSION_POINTS, CURVE_SHAPES,
  createDefaultProject, applyOps, prepareOps, normalizeProject, sanitizeNote, describeOps,
  patternNotesInRange, songNotesInRange, quantizeNotes, humanizeNotes, legatoNotes, PPQ
} from '../src/index.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('curves are cleaned: sorted, clamped, bounded, flat-at-rest removed', () => {
  const c = sanitizeCurve('pitch', [{ t: 1, v: 99 }, { t: 0, v: -1 }, { t: 0.5, v: 'x' }, null, { t: 2, v: 1, c: 'smooth' }]);
  assert.deepEqual(c, [{ t: 0, v: -1 }, { t: 1, v: 48 }, { t: 1, v: 1 }]);
  assert.equal(sanitizeCurve('pressure', [{ t: 0, v: 0 }, { t: 1, v: 0 }]), null, 'all at rest = no curve');
  assert.equal(sanitizeCurve('pressure', []), null);
  assert.equal(sanitizeCurve('nope', [{ t: 0, v: 1 }]), null);
  assert.deepEqual(sanitizeCurve('pressure', [{ t: 0, v: 2, c: 'hold' }, { t: 1, v: -3, c: 'hold' }]), [{ t: 0, v: 1, c: 'hold' }, { t: 1, v: 0 }], 'the last point has no segment type');
  const dense = Array.from({ length: 500 }, (_, i) => ({ t: i / 499, v: Math.sin(i / 20) }));
  const kept = sanitizeCurve('pitch', dense);
  assert.ok(kept.length <= MAX_EXPRESSION_POINTS);
  for (let i = 0; i <= 50; i++) near(curveValueAt(kept, i / 50), Math.sin((i / 50) * 499 / 20), 0.08);
});

test('expression objects accept both shapes and drop empties', () => {
  assert.equal(sanitizeExpression(null), undefined);
  assert.equal(sanitizeExpression({ pitch: [] }), undefined);
  const e = sanitizeExpression({ pitch: { unit: 'semitones', points: [{ t: 0, v: 0 }, { t: 1, v: 2 }] }, timbre: [{ t: 0, v: 0.2 }], junk: [1] });
  assert.deepEqual(Object.keys(e), ['pitch', 'timbre']);
  assert.equal(e.pitch[1].v, 2);
});

test('curve evaluation: linear, smooth, hold, edges', () => {
  const lin = [{ t: 0.2, v: 0 }, { t: 0.6, v: 4 }];
  assert.equal(curveValueAt(lin, 0), 0, 'holds the first value before it');
  near(curveValueAt(lin, 0.4), 2);
  assert.equal(curveValueAt(lin, 1), 4, 'holds the last value after it');
  const sm = [{ t: 0, v: 0, c: 'smooth' }, { t: 1, v: 1 }];
  near(curveValueAt(sm, 0.5), 0.5);
  assert.ok(curveValueAt(sm, 0.1) < 0.1, 'eases in');
  const hold = [{ t: 0, v: 1, c: 'hold' }, { t: 0.5, v: 0.25 }];
  assert.equal(curveValueAt(hold, 0.49), 1);
  assert.equal(curveValueAt(hold, 0.5), 0.25);
  assert.equal(curveValueAt(null, 0.3), 0);
});

test('flattening reproduces every curve type with straight segments', () => {
  const c = sanitizeCurve('pressure', [{ t: 0, v: 0, c: 'smooth' }, { t: 0.4, v: 1, c: 'hold' }, { t: 0.7, v: 0.2 }, { t: 1, v: 0.6 }]);
  const flat = flattenCurve(c);
  assert.ok(flat.every((p) => p.c === undefined));
  const lin = (t) => {
    for (let i = 1; i < flat.length; i++) {
      if (t < flat[i].t) { const a = flat[i - 1]; const b = flat[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1)); }
    }
    return flat[flat.length - 1].v;
  };
  for (let i = 0; i < 200; i++) {
    const t = i / 200;
    if (Math.abs(t - 0.7) < 0.006) continue; // the jump itself
    near(lin(t), curveValueAt(c, t), 0.01);
  }
});

test('simplify keeps the shape within tolerance', () => {
  const stroke = Array.from({ length: 300 }, (_, i) => ({ t: i / 299, v: i < 150 ? i / 150 : 1 }));
  const s = simplifyCurve(stroke, 0.01);
  assert.ok(s.length <= 4, `a ramp and a plateau need few points, got ${s.length}`);
  for (const p of stroke) near(curveValueAt(s, p.t), p.v, 0.011);
});

test('slice, transform and shapes', () => {
  const c = sanitizeCurve('pitch', [{ t: 0, v: 0 }, { t: 1, v: 4 }]);
  const half = sanitizeCurve('pitch', sliceCurve(c, 0.5, 1));
  near(half[0].v, 2);
  near(half[half.length - 1].v, 4);
  assert.deepEqual(transformCurve('pitch', c, { scale: 0.5 }).map((p) => p.v), [0, 2]);
  assert.deepEqual(transformCurve('pitch', c, { invert: true }).map((p) => p.v), [0, -4]);
  assert.deepEqual(transformCurve('pitch', c, { reverse: true }), [{ t: 0, v: 4 }, { t: 1, v: 0 }]);
  assert.deepEqual(transformCurve('pressure', [{ t: 0, v: 0.2 }, { t: 1, v: 1 }], { invert: true }).map((p) => p.v), [0.8, 0]);
  // a reversed hold still sounds like the mirror image
  const held = sanitizeCurve('pressure', [{ t: 0, v: 1, c: 'hold' }, { t: 0.25, v: 0.5, c: 'smooth' }, { t: 1, v: 0.1 }]);
  const rev = transformCurve('pressure', held, { reverse: true });
  for (let i = 1; i < 40; i++) {
    const t = i / 40;
    if (Math.abs(t - 0.75) < 0.03) continue;
    near(curveValueAt(rev, t), curveValueAt(held, 1 - t), 1e-3);
  }
  const smoothed = transformCurve('pressure', [{ t: 0, v: 0, c: 'hold' }, { t: 0.5, v: 1 }, { t: 1, v: 1 }], { smooth: 1 });
  const mid = curveValueAt(smoothed, 0.5);
  assert.ok(mid > 0.3 && mid < 0.7, `the step became a slope (${mid})`);

  for (const shape of CURVE_SHAPES) {
    for (const dim of ['pitch', 'pressure', 'timbre']) {
      const curve = makeCurve(dim, shape, {});
      assert.ok(curve && curve.length >= 2 && curve.length <= MAX_EXPRESSION_POINTS, `${dim} ${shape}`);
    }
  }
  const vib = makeCurve('pitch', 'vibrato', { depth: 0.5, cycles: 4, delay: 0.5, fade: 0 });
  assert.equal(curveValueAt(vib, 0.3), 0, 'no vibrato before the delay');
  const vs = Array.from({ length: 200 }, (_, i) => curveValueAt(vib, 0.5 + i / 400));
  near(Math.max(...vs), 0.5, 0.02);
  near(Math.min(...vs), -0.5, 0.02);
  assert.throws(() => makeCurve('pitch', 'wobble'), /Unknown curve shape/);
  assert.throws(() => makeCurve('volume', 'bend'), /Unknown expression dimension/);
});

function projectWithNote(extra = {}) {
  const p = createDefaultProject();
  const ch = p.channels[0].id;
  const pat = p.patterns[0].id;
  const after = applyOps(p, prepareOps([{ type: 'notes/add', patternId: pat, channelId: ch, notes: [{ id: 'n1', key: 60, start: 0, length: 96, velocity: 0.8, ...extra }, { id: 'n2', key: 64, start: 0, length: 96 }] }]));
  return { p: after, ch, pat };
}

test('notes keep their expression through add, update, normalize and JSON', () => {
  const expression = { pitch: [{ t: 0, v: 0 }, { t: 0.45, v: 0.35 }, { t: 1, v: 0 }], pressure: [{ t: 0, v: 0.1 }, { t: 0.3, v: 0.85 }, { t: 1, v: 0.2 }] };
  const { p, ch, pat } = projectWithNote({ expression, releaseVelocity: 0.42 });
  const note = () => p2.patterns[0].notes[ch].find((n) => n.id === 'n1');
  let p2 = p;
  assert.deepEqual(note().expression, expression);
  assert.equal(note().releaseVelocity, 0.42);
  assert.equal(p.patterns[0].notes[ch].find((n) => n.id === 'n2').expression, undefined, 'plain notes stay plain');
  // moving / resizing (what the piano roll sends) keeps the performance
  p2 = applyOps(p2, [{ type: 'notes/update', patternId: pat, channelId: ch, notes: [{ id: 'n1', key: 62, start: 48, length: 200, velocity: 0.5 }] }]);
  assert.deepEqual(note().expression, expression);
  assert.equal(note().releaseVelocity, 0.42);
  assert.equal(note().key, 62);
  // save → load
  p2 = normalizeProject(JSON.parse(JSON.stringify(p2)));
  assert.deepEqual(note().expression, expression);
  // garbage is repaired at the boundary
  const raw = JSON.parse(JSON.stringify(p2));
  raw.patterns[0].notes[ch][0].expression = { pitch: 'nope', pressure: [{ t: 0, v: 9 }], extra: 1 };
  raw.patterns[0].notes[ch][0].releaseVelocity = 7;
  const fixed = normalizeProject(raw).patterns[0].notes[ch][0];
  assert.deepEqual(fixed.expression, { pressure: [{ t: 0, v: 1 }] });
  assert.equal(fixed.releaseVelocity, 1);
});

test('notes/expression patches one dimension and leaves the others alone', () => {
  const { p, ch, pat } = projectWithNote({ expression: { pitch: [{ t: 0, v: 0 }, { t: 1, v: 2 }] } });
  const get = (proj, id = 'n1') => proj.patterns[0].notes[ch].find((n) => n.id === id);
  const op = (notes) => [{ type: 'notes/expression', patternId: pat, channelId: ch, notes }];
  let q = applyOps(p, op([{ id: 'n1', expression: { pressure: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } }]));
  assert.deepEqual(Object.keys(get(q).expression).sort(), ['pitch', 'pressure']);
  assert.equal(get(q).expression.pitch[1].v, 2, 'the pitch curve was not touched');
  assert.notEqual(q, p);
  assert.equal(get(p).expression.pressure, undefined, 'the original project is unchanged (immutable ops)');
  // removing one curve, then the last one
  q = applyOps(q, op([{ id: 'n1', expression: { pitch: null } }]));
  assert.deepEqual(Object.keys(get(q).expression), ['pressure']);
  q = applyOps(q, op([{ id: 'n1', expression: { pressure: [] } }]));
  assert.equal(get(q).expression, undefined);
  // release velocity on its own; unknown ids are ignored; several notes at once
  q = applyOps(q, op([{ id: 'n1', releaseVelocity: 0.9 }, { id: 'ghost', expression: { pitch: [{ t: 0, v: 1 }] } }, { id: 'n2', expression: { timbre: [{ t: 0, v: 0.15 }, { t: 1, v: 0.9 }] } }]));
  assert.equal(get(q).releaseVelocity, 0.9);
  assert.equal(get(q, 'n2').expression.timbre[1].v, 0.9);
  q = applyOps(q, op([{ id: 'n1', releaseVelocity: null }, { id: 'n2', expression: null }]));
  assert.equal(get(q).releaseVelocity, undefined);
  assert.equal(get(q, 'n2').expression, undefined);
  assert.match(describeOps(op([{ id: 'n1' }]), p)[0], /expression of 1 note/);
  assert.throws(() => applyOps(p, [{ type: 'notes/expression', patternId: 'nope', channelId: ch, notes: [] }]), /not found/);
});

test('the same ops give the same project everywhere (deterministic replay)', () => {
  const { p, ch, pat } = projectWithNote();
  const ops = prepareOps([{ type: 'notes/expression', patternId: pat, channelId: ch, notes: [{ id: 'n1', expression: { pitch: makeCurve('pitch', 'vibrato', {}) } }] }]);
  assert.deepEqual(applyOps(p, ops), applyOps(JSON.parse(JSON.stringify(p)), JSON.parse(JSON.stringify(ops))));
});

test('playback events and note transforms carry the performance', () => {
  const expression = { pitch: [{ t: 0, v: 0 }, { t: 1, v: 1 }] };
  const { p, pat } = projectWithNote({ expression, releaseVelocity: 0.3 });
  const ev = patternNotesInRange(p.patterns[0], 0, 96).find((n) => n.noteId === 'n1');
  assert.deepEqual(ev.expression, expression);
  assert.equal(ev.releaseVelocity, 0.3);
  assert.equal(ev.fullLength, 96);
  // a clip that cuts the note: the event is shorter but knows the note's real length
  const withClip = applyOps(p, prepareOps([{ type: 'clip/add', clip: { kind: 'pattern', refId: pat, track: 0, start: 0, length: 48 } }]));
  const cut = songNotesInRange(withClip, 0, PPQ * 4).find((n) => n.noteId === 'n1');
  assert.equal(cut.length, 48);
  assert.equal(cut.fullLength, 96);
  assert.deepEqual(cut.expression, expression);
  const note = sanitizeNote({ id: 'a', key: 60, start: 5, length: 90, velocity: 0.7, expression, releaseVelocity: 0.3 });
  for (const fn of [(l) => quantizeNotes(l, 24), (l) => humanizeNotes(l, { rand: () => 0.5 }), legatoNotes]) {
    const [out] = fn([note]);
    assert.deepEqual(out.expression, expression);
    assert.equal(out.releaseVelocity, 0.3);
  }
  assert.deepEqual(expressionFields(note), { expression, releaseVelocity: 0.3 });
  assert.notEqual(expressionFields(note).expression.pitch, expression.pitch, 'a copy, not a shared reference');
  assert.match(describeExpression(note), /pitch 0→\+1 st/);
});
