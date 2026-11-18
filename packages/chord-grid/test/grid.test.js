import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createChordGrid, gridScales, gridScaleFor, chordKey, cellFromId, TUPLE_SOURCE, VOICINGS, TENSIONS } from '../src/index.js';

const labels = (g) => g.view().columns.map((c) => c.cells.map((x) => x.label));
/** Play a cell and let go: what sounded, and what was let go. */
function strike(g, heard, cell) {
  heard.length = 0;
  assert.equal(g.press(cell), true, `${cell} plays`);
  const on = heard.filter((n) => n.on);
  g.release();
  return { on, off: heard.filter((n) => !n.on) };
}

test('the engine is Tuple\'s own file, untouched, and says where it came from', () => {
  const text = fs.readFileSync(new URL('../src/tuple-engine.js', import.meta.url), 'utf8');
  const from = text.indexOf('verbatim from here\n') + 'verbatim from here\n'.length;
  const to = text.indexOf('// ======================================================================== tuple_chord_engine.js: to here');
  assert.ok(from > 100 && to > from);
  assert.equal(crypto.createHash('sha256').update(text.slice(from, to)).digest('hex'), TUPLE_SOURCE.sha256, 'the copy between the marks is the file that was vendored');
  assert.match(text, /MIT License/);
  assert.match(text, /Copyright \(c\) 2026 c0remusic/);
  assert.match(fs.readFileSync(new URL('../LICENSE-tuple.txt', import.meta.url), 'utf8'), /Permission is hereby granted/);
  assert.equal(TUPLE_SOURCE.license, 'MIT');
  assert.match(TUPLE_SOURCE.commit, /^[0-9a-f]{40}$/);
});

test('C major: the grid of Tuple\'s own screenshot', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  assert.deepEqual(labels(g), [
    ['C', 'CM7', 'CM9', 'Csus4', 'Csus2', 'Cadd9', 'C6', 'C6/9'],
    ['Dm', 'Dm7', 'Dm9', 'Dsus4', 'Dsus2', 'Dmadd9', 'Dm6', 'Dm6/9'],
    ['Em', 'Em7', 'Esus4', 'E7sus4'],
    ['F', 'FM7', 'FM9', 'Fsus2', 'Fadd9', 'F6', 'F6/9'],
    ['G', 'G7', 'G9', 'Gsus4', 'Gsus2', 'Gadd9', 'G6', 'G6/9'],
    ['Am', 'Am7', 'Am9', 'Asus4', 'Asus2', 'Amadd9', 'A7sus4'],
    ['Bdim', 'Bø7']
  ]);
  const v = g.view();
  assert.deepEqual(v.columns.map((c) => c.roman), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  assert.deepEqual(v.columns.map((c) => c.name), ['Tonic', 'Supertonic', 'Mediant', 'Subdominant', 'Dominant', 'Submediant', 'Leading tone']);
  // borrowed chords are spelled by their numeral: bIII of C is Eb, not the D# the engine writes
  assert.deepEqual(v.borrowed.cells.map((c) => `${c.label} ${c.roman}`), ['Eb bIII', 'Fm iv', 'Ab bVI', 'Bb bVII', 'D7 V/V', 'A7 V/ii', 'E7 V/vi']);
  assert.deepEqual(v.borrowed.pages, [0, 1, 2, 3]);
  assert.equal(v.key.name, 'C');
  assert.equal(v.sounding, null);
});

test('a key spells its own notes: the caller\'s speller names the roots', () => {
  const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const g = createChordGrid({ root: 3, scale: 'major', spell: (pc) => flats[pc] });
  assert.deepEqual(g.view().columns.map((c) => c.cells[0].label), ['Eb', 'Fm', 'Gm', 'Ab', 'Bb', 'Cm', 'Ddim']);
  assert.equal(g.view().key.name, 'Eb');
  // minor: the seventh a whole tone under the tonic is a subtonic, and the leading-tone chord keeps its sharp
  const m = createChordGrid({ root: 9, scale: 'minor' });
  assert.equal(m.view().columns[6].name, 'Subtonic');
  assert.ok(m.view().borrowed.cells.some((c) => c.label === 'G#dim7' && c.roman === 'vii°'));
});

test('every cell of every scale in every key plays, with at most six voices, and every note is let go', () => {
  let cells = 0;
  for (const scale of gridScales()) {
    for (const root of [0, 1, 6, 10]) {
      const heard = [];
      const g = createChordGrid({ root, scale: scale.id, onNotes: (n) => heard.push(...n) });
      const v = g.view();
      assert.equal(v.key.scale, scale.id);
      const all = [...v.columns.flatMap((c) => c.cells), ...v.borrowed.cells];
      assert.ok(all.length >= 7, `${scale.id}: a grid to play (${all.length} cells)`);
      for (const c of all) {
        const { on, off } = strike(g, heard, c.id);
        assert.ok(on.length >= 3 && on.length <= 6, `${scale.id} ${c.label}: ${on.length} notes`);
        assert.deepEqual(off.map((n) => n.pitch).sort(), on.map((n) => n.pitch).sort(), `${scale.id} ${c.label}: what sounded is let go`);
        assert.ok(on.every((n) => n.pitch >= 24 && n.pitch <= 108 && n.velocity === 100 && n.delay === 0));
        cells++;
      }
      assert.deepEqual(g.log.filter((l) => /error|invalid|inconnu|hors/i.test(l)), [], `${scale.id}: the engine refused nothing`);
    }
  }
  assert.ok(cells > 4000, `${cells} cells played`);
});

test('pentatonic scales keep five columns, and nothing in them leaves the scale', () => {
  const g = createChordGrid({ root: 0, scale: 'pentamaj' });
  const v = g.view();
  assert.deepEqual(v.columns.map((c) => c.cells.length > 0), [true, true, false, false, true, true, false]);
  assert.deepEqual(v.key.notes.slice().sort((a, b) => a - b), [0, 2, 4, 7, 9]);
  for (const c of v.columns.flatMap((x) => x.cells)) for (const n of g.preview(c.id)) assert.ok(v.key.notes.includes(n % 12), `${c.label} stays in the scale`);
});

test('the studio\'s scales find their grid: exact when the notes are the same, the closest otherwise', () => {
  assert.deepEqual(gridScaleFor([0, 2, 4, 5, 7, 9, 11]), { id: 'major', exact: true });
  assert.deepEqual(gridScaleFor([0, 2, 3, 5, 7, 8, 10]), { id: 'minor', exact: true });
  assert.deepEqual(gridScaleFor([0, 1, 4, 5, 7, 8, 10]), { id: 'phrygdom', exact: true });
  assert.deepEqual(gridScaleFor([0, 2, 4, 7, 9]), { id: 'pentamaj', exact: true });
  assert.deepEqual(gridScaleFor([0, 3, 5, 7, 10]), { id: 'pentamin', exact: true });
  assert.deepEqual(gridScaleFor([0, 3, 5, 6, 7, 10]), { id: 'minor', exact: false }, 'the blues scale plays on the minor grid');
  assert.equal(gridScaleFor([0, 2, 4, 6, 8, 10]).exact, false);
  assert.equal(gridScaleFor([]).exact, false);
  assert.equal(gridScales().length, 30);
  assert.ok(gridScales().every((s) => s.label && s.intervals.length === 7));
});

test('voicings: eight ways to spread the same chord, all the same pitch classes (rootless drops the root)', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  const seen = new Set();
  for (const v of VOICINGS) {
    g.set({ voicing: v.id });
    assert.equal(g.view().settings.voicing, v.id);
    const notes = g.preview('d:4:seven');
    const pcs = [...new Set(notes.map((n) => n % 12))].sort((a, b) => a - b);
    if (v.id === 'rootless') assert.ok(!pcs.includes(7) && pcs.includes(11) && pcs.includes(5), `rootless G7 has no G: ${notes}`);
    else assert.deepEqual(pcs, [2, 5, 7, 11], `${v.id}: G B D F`);
    seen.add(notes.join(' '));
  }
  assert.ok(seen.size >= 6, `${seen.size} different spreads of G7`);
  assert.throws(() => g.set({ voicing: 'nope' }), /unknown voicing/);
  assert.throws(() => g.set({ nope: 1 }), /unknown setting/);
});

test('voice leading: Follow moves less from chord to chord than Off', () => {
  const travel = (leading) => {
    const heard = [];
    const g = createChordGrid({ root: 0, scale: 'major', onNotes: (n) => heard.push(...n) });
    g.set({ leading });
    let total = 0;
    let prev = null;
    for (const id of ['d:0:seven', 'd:5:seven', 'd:1:seven', 'd:4:seven', 'd:0:seven', 'd:3:seven', 'd:1:seven', 'd:4:seven']) {
      const now = strike(g, heard, id).on.map((n) => n.pitch).sort((a, b) => a - b);
      if (prev) total += now.reduce((s, p, i) => s + Math.abs(p - (prev[i] ?? p)), 0);
      prev = now;
    }
    return total;
  };
  assert.ok(travel('follow') < travel('off'), `follow ${travel('follow')} < off ${travel('off')}`);
  assert.equal(travel('anchor'), travel('anchor'), 'anchor repeats');
});

test('smart chords: after ii the dominant glows brightest, and the mode can follow voice leading instead', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  g.set({ smart: 'function' });
  g.press('d:1:seven'); g.release();
  const lit = (v) => [...v.columns.flatMap((c) => c.cells), ...v.borrowed.cells].filter((c) => c.smart);
  const a = lit(g.view());
  assert.ok(a.length >= 4, `${a.length} suggestions`);
  const dominant = a.find((c) => c.kind === 'd' && c.degree === 4);
  assert.ok(dominant && dominant.smart.level === 3 && dominant.smart.kind === 'dominant', 'V after ii');
  assert.ok(a.every((c) => c.smart.level >= 1 && c.smart.level <= 3 && c.smart.score > 0 && c.smart.score <= 1));
  assert.ok(!a.some((c) => c.id === 'd:1:seven'), 'the chord just played is not suggested');
  g.set({ smart: 'voiceleading' });
  const b = lit(g.view());
  assert.deepEqual(b.map((c) => c.id).sort(), a.map((c) => c.id).sort(), 'the same candidates');
  assert.notDeepEqual(b.map((c) => c.smart.level), a.map((c) => c.smart.level), 'ranked another way');
  g.set({ smart: 'off' });
  assert.equal(lit(g.view()).length, 0);
});

test('the borrowed column has four pages; Tritone and Ext follow what was played', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  g.setBorrowedPage(2);
  assert.deepEqual(g.view().borrowed.cells.map((c) => `${c.label} ${c.roman}`), ['E III', 'A VI']);
  g.setBorrowedPage(1);
  const tri = g.view().borrowed.cells;
  assert.equal(tri.length, 4);
  assert.deepEqual([tri[0].label, tri[0].roman, tri[0].target], ['Db7', 'subV7', 'C'], 'before anything is played: the substitute of the dominant');
  g.press('d:3:triad'); g.release();
  g.setBorrowedPage(3);
  const ext = g.view().borrowed.cells.map((c) => c.label);
  assert.ok(ext.includes('FM13') && ext.includes('FM7#11'), `Ext of IV after F: ${ext}`);
  // a mode that is neither major nor minor has no chromatic mediants: the page is not offered
  const d = createChordGrid({ root: 2, scale: 'dorian' });
  assert.deepEqual(d.view().borrowed.pages, [0, 1, 3]);
  d.setBorrowedPage(2);
  assert.equal(d.view().borrowed.page, 0);
  // EXT enriches the borrowed column only
  const before = labels(g);
  g.setBorrowedPage(0);
  g.set({ extended: true });
  assert.deepEqual(labels(g), before);
  assert.notDeepEqual(g.view().borrowed.cells.map((c) => c.label), ['Eb', 'Fm', 'Ab', 'Bb', 'D7', 'A7', 'E7']);
});

test('strum and humanize: notes arrive late in order, a seed repeats the take, and nothing uses a timer or Math.random', (t) => {
  t.mock.method(Math, 'random', () => { throw new Error('Math.random was called'); });
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('setTimeout was called'); });
  const take = (seed, settings) => {
    const heard = [];
    const g = createChordGrid({ root: 0, scale: 'major', seed, onNotes: (n) => heard.push(...n) });
    g.set(settings);
    return ['d:0:nine', 'd:4:seven'].map((id) => strike(g, heard, id).on.map((n) => ({ ...n })));
  };
  const up = take(1, { strum: 30 })[0];
  assert.deepEqual(up.map((n) => n.delay), [0, 30, 60, 90, 120], 'low to high, 30 ms apart');
  assert.deepEqual(up.map((n) => n.pitch), up.map((n) => n.pitch).slice().sort((a, b) => a - b));
  const down = take(1, { strum: -30 })[0];
  assert.deepEqual(down.slice().sort((a, b) => a.delay - b.delay).map((n) => n.pitch), up.map((n) => n.pitch).reverse(), 'a negative strum goes high to low');
  const ramp = take(1, { strum: 30, strumRamp: 100 })[0];
  assert.ok(ramp[ramp.length - 1].velocity > ramp[0].velocity, 'a positive ramp is a crescendo');
  const a = take('one', { humanize: 60 });
  assert.deepEqual(take('one', { humanize: 60 }), a, 'the same seed is the same take');
  assert.notDeepEqual(take('two', { humanize: 60 }), a, 'another seed is another take');
  assert.ok(a.flat().some((n) => n.velocity !== 100) && a.flat().some((n) => n.delay > 0), 'humanize moves velocities and timing');
  const narrow = take(1, { humanize: 100, velMin: 90, velMax: 104 }).flat();
  assert.ok(narrow.every((n) => n.velocity >= 90 && n.velocity <= 104), 'the velocity range has the last word');
});

test('the track: cards from cells, placed, sized, coloured with tensions, undone', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  let changes = 0;
  g.subscribe(() => changes++);
  assert.deepEqual(g.add('d:1:nine'), { index: 0, refused: [] });
  assert.deepEqual(g.add('d:4:seven', { tensions: ['13', 'b9'], bars: 0.5 }), { index: 1, refused: [] });
  assert.deepEqual(g.add('d:0:nine', { bars: 2 }), { index: 2, refused: [] });
  assert.equal(g.add('b:9:dom7', { at: 3.5, bars: 0.5 }).index, 3);
  assert.ok(changes >= 4);
  let p = g.view().progression;
  assert.deepEqual(p.cards.map((c) => [c.name, c.roman, c.start, c.bars]), [['Dm9', 'ii', 0, 1], ['G13b9', 'V', 1, 0.5], ['CM9', 'I', 1.5, 2], ['A7', 'V/ii', 3.5, 0.5]]);
  assert.deepEqual(p.cards[1].tensions, ['b9', '13']);
  assert.equal(p.cards[1].notes.length, 6);
  assert.equal(p.cards[3].borrowed, true);
  assert.equal(p.loopBars, 4);
  assert.equal(p.endBars, 4);
  // what a chord does not take is said, with the reason, and is not added
  const r = g.add('d:5:seven', { tensions: ['b9', '9'] });
  assert.deepEqual(r.refused, [{ tension: 'b9', state: 'avoid', why: 'not a colour of a minor chord' }]);
  assert.deepEqual(g.view().progression.cards[r.index].tensions, ['9']);
  assert.equal(g.view().progression.cards[r.index].name, 'Am9');
  assert.equal(g.view().progression.loopBars, 8, 'the loop grows by blocks of four bars');
  const offer = Object.fromEntries(g.view().progression.cards[1].offer.map((o) => [o.name, o.state]));
  assert.deepEqual(offer, { b9: 'on', 9: 'off', '#9': 'off', 11: 'avoid', '#11': 'off', b13: 'off', 13: 'on' });
  assert.equal(g.setTension(1, '11', true), false, 'an avoided tension is refused');
  assert.equal(g.setTension(1, 'b9', false), true);
  assert.equal(g.view().progression.cards[1].name, 'G13');
  assert.throws(() => g.setTension(1, '7'), /unknown tension/);
  assert.deepEqual(TENSIONS, ['b9', '9', '#9', '11', '#11', 'b13', '13']);
  // editing a card
  g.setVoicing(0, 'rootless');
  assert.equal(g.view().progression.cards[0].voicing, 'rootless');
  assert.ok(!g.view().progression.cards[0].notes.some((n) => n % 12 === 2), 'Dm9 without its D');
  const closed = g.view().progression.cards[2].notes;
  g.setInversion(2, 1);
  p = g.view().progression;
  assert.equal(p.cards[2].pinned, true);
  assert.notDeepEqual(p.cards[2].notes, closed);
  assert.deepEqual([...new Set(p.cards[2].notes.map((n) => n % 12))].sort((a, b) => a - b), [...new Set(closed.map((n) => n % 12))].sort((a, b) => a - b));
  assert.ok(p.cards[2].bass, 'an inverted card says its bass');
  g.resetInversion(2);
  assert.equal(g.view().progression.cards[2].pinned, false);
  g.setOctave(3, 1);
  assert.equal(g.view().progression.cards[3].octave, 1);
  g.move(3, 6);
  assert.deepEqual(g.view().progression.cards.map((c) => c.name), ['Dm9', 'G13', 'CM9', 'Am9', 'A7']);
  assert.equal(g.view().progression.cards[4].start, 6);
  g.resize(0, 0.5);
  assert.equal(g.view().progression.cards[0].bars, 0.5);
  g.remove(0);
  assert.equal(g.view().progression.cards.length, 4);
  assert.equal(g.view().progression.canUndo, true);
  g.undo();
  assert.equal(g.view().progression.cards.length, 5);
  // a card is the same card through every edit (a screen keys its element on this)
  const ids = g.view().progression.cards.map((c) => c.uid);
  assert.equal(new Set(ids).size, ids.length);
  g.resize(1, 2);
  g.setTension(2, '13', true);
  g.undo();
  assert.deepEqual(g.view().progression.cards.map((c) => c.uid), ids);
  g.undo();
  g.select(2);
  assert.equal(g.view().progression.selected, 2);
  g.select(null);
  assert.equal(g.view().progression.selected, -1);
  assert.throws(() => g.remove(9), /no card 9/);
  g.clear();
  assert.equal(g.view().progression.cards.length, 0);
  g.undo();
  assert.equal(g.view().progression.cards.length, 5);
});

test('substitutes, what could follow, and other voicings of a card', () => {
  const heard = [];
  const g = createChordGrid({ root: 0, scale: 'major', onNotes: (n) => heard.push(...n) });
  g.add('d:1:seven'); g.add('d:4:seven'); g.add('d:0:seven');
  const subs = g.options(1, 'subs');
  assert.ok(subs.some((o) => o.name === 'Bø7' && o.kind === 'func'), 'the other dominant-function chord');
  assert.ok(subs.some((o) => o.name === 'Db7' && o.roman === 'subV7'), 'the tritone substitute, named');
  assert.ok(subs.every((o) => o.notes.length >= 3 && o.name && o.name !== '·'));
  const next = g.options(0, 'next');
  assert.ok(next.length >= 4 && next[0].level >= next[next.length - 1].level, 'best first');
  assert.deepEqual(g.options(1, 'voicings').map((o) => o.name), VOICINGS.map((v) => v.label));
  heard.length = 0;
  g.auditionOption(1, 'subs', subs.findIndex((o) => o.name === 'Db7'));
  assert.ok(heard.some((n) => n.on && n.pitch % 12 === 1), 'the substitute sounds');
  g.release();
  assert.deepEqual(g.view().progression.cards.map((c) => c.name), ['Dm7', 'G7', 'CM7'], 'hearing changes nothing');
  assert.equal(g.applyOption(1, 'subs', subs.findIndex((o) => o.name === 'Db7')), 1);
  g.release();
  assert.deepEqual(g.view().progression.cards.map((c) => [c.name, c.start, c.bars]), [['Dm7', 0, 1], ['Db7', 1, 1], ['CM7', 2, 1]], 'the substitute takes the card\'s place and length');
  const k = g.options(2, 'next').findIndex((o) => o.name.startsWith('F'));
  assert.equal(g.applyOption(2, 'next', k), 3, 'a next chord goes in after the card');
  g.release();
  assert.equal(g.view().progression.cards.length, 4);
  assert.equal(g.view().settings.capture, false, 'the capture switch is left as it was');
  assert.throws(() => g.options(0, 'nope'), /unknown options/);
});

test('the track as notes: one note per voice, in its card, ending with it; strum pushes starts, never ends', () => {
  const g = createChordGrid({ root: 0, scale: 'major', bpm: 120 });
  g.set({ leading: 'follow' });
  g.add('d:1:nine'); g.add('d:4:seven', { bars: 0.5 }); g.add('d:0:nine', { at: 2, bars: 2 });
  const clean = g.notes();
  assert.equal(clean.loopBars, 4);
  assert.equal(clean.notes.length, g.view().progression.cards.reduce((s, c) => s + c.notes.length, 0));
  assert.ok(clean.notes.every((n) => n.offset === 0 && n.velocity === 100));
  assert.deepEqual([...new Set(clean.notes.map((n) => `${n.card}@${n.bar}+${n.bars}`))], ['0@0+1', '1@1+0.5', '2@2+2']);
  g.set({ strum: 25, humanize: 30 });
  const played = g.notes();
  assert.deepEqual(g.notes(), played, 'writing twice writes the same notes');
  assert.ok(played.notes.some((n) => n.offset > 0));
  for (const n of played.notes) {
    assert.ok(n.offset >= 0 && n.offset <= n.bars * 4 * 0.5 + 1e-9, 'a late note stays in the first half of its card');
    assert.ok(n.velocity >= 1 && n.velocity <= 127);
  }
  // 25 ms at 120 BPM is a twentieth of a beat; at 60 BPM half of that
  const second = played.notes.filter((n) => n.card === 1).map((n) => n.offset);
  g.set({ humanize: 0 });
  assert.ok(Math.abs(g.notes().notes[1].offset - 0.05) < 1e-9);
  g.setTempo(60);
  assert.ok(Math.abs(g.notes().notes[1].offset - 0.025) < 1e-9);
  assert.equal(second.length, 4);
  assert.deepEqual(createChordGrid().notes(), { loopBars: 4, notes: [] });
});

test('save and load: the track, its key and the settings come back; the key can then move and the cards follow', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  g.set({ voicing: 'drop2', leading: 'follow', smart: 'function', strum: 20, octave: 1, extended: true, avoidNotes: false });
  g.add('d:1:nine', { tensions: ['11'] }); g.add('d:4:seven', { bars: 2 }); g.add('b:8:maj');
  g.setLoop(8);
  g.setBorrowedPage(2);
  const saved = g.save();
  const h = createChordGrid({ root: 7, scale: 'minor' });
  assert.equal(h.load(saved), true);
  const a = g.view();
  const b = h.view();
  assert.deepEqual(b.settings, a.settings);
  assert.deepEqual(b.key, a.key);
  assert.equal(b.borrowed.page, 2);
  assert.deepEqual(b.progression.cards.map((c) => [c.name, c.start, c.bars, c.notes, c.tensions, c.voicing]), a.progression.cards.map((c) => [c.name, c.start, c.bars, c.notes, c.tensions, c.voicing]));
  assert.equal(b.progression.loopBars, 8);
  assert.equal(b.progression.canUndo, false, 'a restored track starts a new history');
  assert.deepEqual(h.notes(), g.notes());
  h.setKey({ root: 2 });
  assert.deepEqual(h.view().progression.cards.map((c) => c.roman), a.progression.cards.map((c) => c.roman), 'the same degrees');
  assert.deepEqual(h.view().progression.cards.map((c) => c.name.slice(0, 2)), ['Em', 'A7', 'Bb'], 'a tone higher');
  assert.equal(h.load('not json'), false);
  assert.equal(h.load('{"chordGrid":2}'), false);
  assert.equal(h.load(JSON.stringify({ chordGrid: 1, track: '{"v":9}' })), false);
  assert.equal(h.view().progression.cards.length, 3, 'a save that does not read changes nothing');
  const empty = createChordGrid();
  assert.equal(h.load(empty.save()), true);
  assert.equal(h.view().progression.cards.length, 0);
});

test('a card whose chord the new key does not have keeps playing and says so', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  g.add('d:0:nine');
  assert.equal(g.view().progression.cards[0].offGrid, false);
  g.setKey({ scale: 'phrygian' });
  const card = g.view().progression.cards[0];
  assert.equal(card.offGrid, true, 'the ninth of a phrygian tonic is flat: the grid has no ninth chord there');
  assert.ok(card.notes.length >= 3);
});

test('a chord by its name: the many ways to write one find the same cell', () => {
  assert.deepEqual(chordKey('Cmaj7'), chordKey('CM7'));
  assert.deepEqual(chordKey('C♯m7♭5'), chordKey('Dbø7'));
  assert.deepEqual(chordKey('Am(maj7)'), chordKey('AmMaj7'));
  assert.deepEqual(chordKey('c69'), { pc: 0, suffix: '6/9' });
  assert.deepEqual(chordKey('Gsus'), chordKey('Gsus4'));
  assert.notDeepEqual(chordKey('CM7'), chordKey('Cm7'));
  assert.equal(chordKey('H7'), null);
  assert.equal(chordKey(''), null);
  const g = createChordGrid({ root: 0, scale: 'major' });
  const where = (t) => { const f = g.find(t); return f && `${f.id} ${f.group}`; };
  assert.equal(where('Dm9'), 'd:1:nine ii');
  assert.equal(where('Cmaj7'), 'd:0:seven I');
  assert.equal(where('Bm7b5'), 'd:6:seven vii°');
  assert.equal(where('Eb'), 'b:3:maj borrowed');
  assert.equal(where('D#'), 'b:3:maj borrowed');
  assert.equal(where('E'), 'b:4:maj mediants');
  assert.equal(where('Db7'), 'b:1:sub7 tritone');
  assert.equal(where('F7'), 'b:5:sub7 tritone', 'a substitute the Tritone page is not showing');
  assert.equal(g.find('FM13').group, 'ext');
  assert.equal(g.find('G13').roman, 'V');
  assert.equal(where('nonsense'), null);
  assert.equal(where('C5'), null, 'a bare fifth is not a chord the engine spells');
  assert.equal(g.view().borrowed.page, 0, 'looking leaves the page where it was');
  assert.equal(g.view().settings.extended, false);
  // found cells are playable and become cards, whatever page shows
  for (const name of ['Db7', 'FM13', 'E', 'Dm9']) assert.ok(g.add(g.find(name).cell).index >= 0, name);
  assert.deepEqual(g.view().progression.cards.map((c) => c.name), ['Db7', 'FM13', 'E', 'Dm9']);
  assert.deepEqual(cellFromId('b:5:x.t4.f7.s11.n2.h9'), { kind: 'b', semis: 5, type: 'x.t4.f7.s11.n2.h9' });
  assert.equal(cellFromId('x'), null);
  assert.equal(g.press('d:2:nine'), false, 'E minor has no ninth chord in C major: not a cell');
  assert.throws(() => g.add('d:2:nine'), /not on the grid/);
  assert.throws(() => g.add({ kind: 'b', semis: 3, type: 'banana' }), /not on the grid/);
});

test('the view is the same object until something changes, and listeners hear about changes only', () => {
  const g = createChordGrid({ root: 0, scale: 'major' });
  let calls = 0;
  const stop = g.subscribe(() => calls++);
  const a = g.view();
  assert.equal(g.view(), a);
  g.preview('d:0:seven');
  g.set({ voicing: 'classic' });
  assert.equal(g.view(), a, 'setting what is already set changes nothing');
  assert.equal(calls, 0);
  g.set({ voicing: 'open' });
  assert.notEqual(g.view(), a);
  assert.equal(calls, 1);
  stop();
  g.set({ voicing: 'classic' });
  assert.equal(calls, 1);
});

test('a chord no page offers is still spelled and voiced: E7 in A minor, Cm7 in C major', () => {
  const a = createChordGrid({ root: 9, scale: 'minor' });
  assert.ok(!a.catalog().columns.flatMap((c) => c.cells).some((c) => c.label === 'E7'), 'natural minor has no dominant seventh on its fifth degree');
  const e7 = a.find('E7');
  assert.deepEqual([e7.label, e7.roman, e7.group], ['E7', 'V', 'chromatic']);
  const seen = {};
  for (const name of ['E7', 'E7b9', 'Am6', 'F#m7b5', 'Ebmaj7', 'C7sus4', 'AmMaj7', 'A13b9', 'C7#5']) {
    const f = a.find(name);
    assert.ok(f, name);
    const { index } = a.add(f.cell);
    const card = a.view().progression.cards[index];
    seen[name] = `${card.name} ${card.roman} ${[...new Set(card.notes.map((n) => n % 12))].sort((x, y) => x - y).join(',')}`;
    assert.equal(card.name, f.label, `${name}: the card is called what was found`);
    a.remove(index);
  }
  assert.deepEqual(seen, {
    E7: 'E7 V 2,4,8,11', E7b9: 'E7b9 V 2,4,5,8,11', Am6: 'Am6 i 0,4,6,9', 'F#m7b5': 'F#ø7 #vi 0,4,6,9', Ebmaj7: 'EbM7 bV 2,3,7,10',
    C7sus4: 'C7sus4 III 0,5,7,10', AmMaj7: 'AmMaj7 i 0,4,8,9', A13b9: 'A13b9 I 1,4,6,7,9,10', 'C7#5': 'C7#5 III 0,4,8,10'
  });
  const c = createChordGrid({ root: 0, scale: 'major' });
  assert.deepEqual([c.find('Cm7').label, c.find('Cm7').roman, c.find('Cm7').group], ['Cm7', 'i', 'chromatic']);
  assert.equal(c.find('Bb7').group, 'tritone', 'a chord a page offers is that page\'s: Bb7 leads to Am');
  // tensions and voice leading work on them as on any card
  const { index, refused } = c.add(c.find('Cm7').cell, { tensions: ['9', '11'] });
  assert.deepEqual(refused, []);
  assert.equal(c.view().progression.cards[index].name, 'Cm11');
});
