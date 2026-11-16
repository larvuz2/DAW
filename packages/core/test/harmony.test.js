// Harmony and tuning: the dictionaries, reading chords in a key, proposing chords, voice leading, pattern
// generators and tuning systems.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALES, SCALE_INFO, SCALE_FAMILIES, scaleGroups, resolveScale, requireScale, sevenNoteScale, scalePitchClasses,
  CHORD_INFO, CHORD_SYMBOLS, CHORD_TYPES, chordType, parseChord, chordNotes, romanToChord, isRomanNumeral, chordToneName,
  PROGRESSIONS, keyContext, makeChord, readChord, numeralFor, functionOf, analyzeChord, chordTension, tensionCurve,
  detectChords, detectKey, chordsFromNotes, suggestNext, substitutions, negativeHarmony, neoRiemannian, modulationPaths,
  findProgressions, progressionByName, progressionTags, identifyProgression,
  voiceLead, arpCycle, arpeggiate, ARP_MODES, euclid, euclidString, drumPattern, DRUM_STYLES, DRUM_STYLE_INFO, DRUM_ROLES, createRng, seedOf,
  TUNING_IDS, normalizeTuning, isStandardTuning, tuningDegrees, tunedFrequency, tuningCents, tuningTable, chordPurity, describeTuning, approximateRatio,
  createDefaultProject, applyOps, normalizeProject, diffProjects, summarizeProject, followsTuning, midiToFreq, PPQ, STEP
} from '../src/index.js';

const close = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('scales: 57 of them, found by any of their names; older projects keep their ids and their order', () => {
  assert.equal(Object.keys(SCALES).length, 57);
  assert.deepEqual(Object.keys(SCALES).slice(0, 12), ['major', 'minor', 'harmonicMinor', 'melodicMinor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'majorPentatonic', 'minorPentatonic', 'blues']);
  for (const id of ['hirajoshi', 'inSen', 'iwato', 'yo', 'bhairav', 'todi', 'purvi', 'marwa', 'chromatic']) assert.ok(SCALES[id], id);
  for (const [name, id] of [['aeolian', 'minor'], ['Jazz Minor', 'melodicMinor'], ['phrygian-dominant', 'phrygianDominant'], ['Ionian #5', 'ionianSharp5'], ['octatonic', 'diminishedHalfWhole'], ['super locrian', 'altered'], ['in-sen', 'inSen'], ['harmonic minor', 'harmonicMinor'], ['byzantine', 'doubleHarmonic'], ['lydianDominant', 'lydianDominant']]) assert.equal(resolveScale(name), id, name);
  assert.equal(resolveScale('nope'), null);
  assert.throws(() => requireScale('lidian'), /Unknown scale "lidian"\. Did you mean "lydian"/);
  // every scale starts on its tonic, rises, stays inside an octave and says what it sounds like
  for (const [id, steps] of Object.entries(SCALES)) {
    assert.equal(steps[0], 0, id);
    assert.ok(steps.every((x, i) => x < 12 && (i === 0 || x > steps[i - 1])), id);
    assert.ok(SCALE_INFO[id].description.length > 20 && SCALE_FAMILIES.includes(SCALE_INFO[id].family), id);
  }
  assert.equal(scaleGroups().reduce((n, g) => n + g.scales.length, 0), 57);
  assert.deepEqual(scalePitchClasses('E', 'phrygian dominant'), [4, 5, 8, 9, 11, 0, 2]);
  // chords of a scale without seven notes are read in the mode that holds it
  assert.deepEqual(['minorPentatonic', 'bebopDominant', 'kumoi', 'inSen', 'wholeTone'].map(sevenNoteScale), ['minor', 'mixolydian', 'dorian', 'phrygian', 'major']);
});

test('chords: 65 types, every spelling people use, and "C6/9" is not a slash chord', () => {
  assert.equal(CHORD_INFO.length, 65);
  assert.equal(new Set(CHORD_SYMBOLS).size, 65);
  // what worked before still does, with the same notes
  const before = { '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], 5: [0, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], mMaj7: [0, 3, 7, 11], mMaj9: [0, 3, 7, 11, 14], aug7: [0, 4, 8, 10], '+7': [0, 4, 8, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], '7sus4': [0, 5, 7, 10], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 11: [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 21], maj13: [0, 4, 7, 11, 14, 21], m13: [0, 3, 7, 10, 14, 21] };
  for (const [q, iv] of Object.entries(before)) assert.deepEqual(CHORD_TYPES[q], iv, `"${q}"`);
  for (const [symbol, quality, bass] of [['C6/9', '6/9', null], ['Cm6/9/E', 'm6/9', 4], ['CM7', 'maj7', null], ['CMAJ7', 'maj7', null], ['Cmin7b5', 'm7b5', null], ['C-7', 'm7', null], ['CM9#11', 'maj9#11', null], ['CMadd9', 'add9', null], ['C7(b9)', '7b9', null], ['Cm(maj7)', 'mMaj7', null], ['Cø', 'm7b5', null], ['C°7', 'dim7', null], ['Csus', 'sus4', null], ['C7alt', '7#5#9', null], ['cmaj7', 'maj7', null], ['C7#5', 'aug7', null], ['CDIM', 'dim', null], ['Cm/maj7', 'mMaj7', null], ['am/g', 'm', 7], ['bbm7', 'm7', null], ['C♭maj7', 'maj7', null]]) {
    const p = parseChord(symbol);
    assert.deepEqual([p.quality, p.bass], [quality, bass], symbol);
  }
  assert.equal(parseChord('bbm7').root, 10);
  assert.deepEqual(chordNotes('C6/9'), [60, 64, 67, 69, 74]);
  assert.throws(() => parseChord('Cmaj7#9'), /Unknown chord quality "maj7#9" in "Cmaj7#9"\. Did you mean "maj7#5"/);
  // a note name is not a chord: "C4" used to be an error and still is
  assert.throws(() => parseChord('C4'), /Unknown chord quality "4"/);
  assert.equal(chordType('nope'), null);
  // every type is found by its symbol and by each of its aliases
  for (const c of CHORD_INFO) for (const k of [c.symbol, ...c.aliases]) assert.equal(chordType(k)?.symbol, c.symbol, `"${k}"`);
});

test('roman numerals: any quality, applied chords, bass degrees, inversions, the Neapolitan', () => {
  const C = (n) => romanToChord(n, 'C', 'major');
  const a = (n) => romanToChord(n, 'A', 'minor');
  assert.deepEqual(['I', 'ii7', 'iiø7', 'V7#9', 'V13', 'III(add9)', 'i(maj7)', 'Imaj9', 'I6/9', 'vsus4', 'VII°', 'bVII', '#iv°7', 'I+', 'I+7', 'V7(b9)'].map(C),
    ['C', 'Dm7', 'Dm7b5', 'G7#9', 'G13', 'Eadd9', 'CmMaj7', 'Cmaj9', 'C6/9', 'Gsus4', 'Bdim', 'Bb', 'F#dim7', 'Caug', 'Caug7', 'G7b9']);
  assert.deepEqual(['V7/V', 'vii°7/ii', 'V/vi', 'IV/1', 'I/3', 'V/7', 'V7/b7', 'IVsus2/1', 'N', 'N6', 'I64', 'V65', 'V43', 'V42', 'V6/5'].map(C),
    ['D7', 'C#dim7', 'E', 'F/C', 'C/E', 'G/B', 'G7/Bb', 'Fsus2/C', 'Db', 'Db/F', 'C/G', 'G7/B', 'G7/D', 'G7/F', 'G7/B']);
  // the degree is the key's own; an accidental moves it unless the key already has it
  assert.deepEqual(['i', 'VI', 'III', 'VII', 'bVII', 'bVI', 'bII', 'V7', 'vii°', 'vi°', 'bvii°', '#vi', '#iv°', 'V7/iv', 'i/5', 'N6'].map(a),
    ['Am', 'F', 'C', 'G', 'G', 'F', 'Bb', 'E7', 'G#dim', 'F#dim', 'Gdim', 'F#m', 'D#dim', 'A7', 'Am/E', 'Bb/D']);
  assert.deepEqual(['I', 'bII', 'bvii', 'iv'].map((n) => romanToChord(n, 'E', 'phrygianDominant')), ['E', 'F', 'Dm', 'Am']);
  assert.deepEqual(['II', '#IV', 'vii'].map((n) => romanToChord(n, 'F', 'lydian')), ['G', 'B', 'Em']);
  assert.equal(romanToChord('vii°7', 'D', 'harmonicMinor'), 'C#dim7', 'spelled by letter: the raised seventh is a sharp in a flat key');
  for (const yes of ['V7', 'bVII', 'ii°', 'IV/1', 'N6', 'V7/V', 'I64', 'i(maj7)', 'V7#9']) assert.equal(isRomanNumeral(yes), true, yes);
  for (const no of ['Dm', 'C4', 'I7x', 'IX', 'V/', 'bbm7', 'b', 'N7', 'i/8', 'xV', '', 7, null]) assert.equal(isRomanNumeral(no), false, String(no));
  assert.throws(() => romanToChord('IX', 'C'), /Invalid roman numeral "IX"\. Write a degree/);
  assert.deepEqual([chordToneName('Db', 4), chordToneName('F#', 4), chordToneName('G', 10), chordToneName('Bb', 7), chordToneName('G#', 3)], ['F', 'A#', 'F', 'F', 'B']);
  // every numeral of the library is a chord in its mode
  for (const p of PROGRESSIONS) for (const n of p.numerals) assert.doesNotThrow(() => chordNotes(romanToChord(n, 'C', p.scale)), `${p.name}: ${n}`);
});

test('a chord and its numeral are the same thing: every type on every root reads back, in twelve kinds of key', () => {
  let n = 0;
  for (const [key, scale] of [['C', 'major'], ['A', 'minor'], ['F#', 'major'], ['Eb', 'dorian'], ['E', 'phrygian'], ['F', 'lydian'], ['G', 'mixolydian'], ['D', 'harmonicMinor'], ['B', 'locrian'], ['E', 'phrygianDominant'], ['C', 'melodicMinor'], ['A', 'minorPentatonic']]) {
    const ctx = keyContext(key, scale);
    for (const type of CHORD_INFO) for (let root = 0; root < 12; root++) for (const bass of [null, (root + 4) % 12, (root + 6) % 12]) {
      const chord = makeChord(root, type.symbol, bass);
      const numeral = numeralFor(chord, ctx);
      const back = parseChord(romanToChord(numeral, key, scale));
      assert.deepEqual([back.root, back.quality, back.bass], [chord.root, chord.quality, chord.bass], `${chord.name} in ${ctx.label} → ${numeral}`);
      n++;
    }
  }
  assert.equal(n, 12 * 65 * 12 * 3);
});

test('reading a chord in a key: numeral, function, and where it comes from', () => {
  const read = (c, k = 'C', s = 'major') => { const x = analyzeChord(c, k, s); return [x.numeral, x.function, x.kind, x.borrowedFrom || x.secondaryOf || '']; };
  assert.deepEqual(read('C'), ['I', 'tonic', 'diatonic', '']);
  assert.deepEqual(read('Am'), ['vi', 'tonic', 'diatonic', '']);
  assert.deepEqual(read('F'), ['IV', 'subdominant', 'diatonic', '']);
  assert.deepEqual(read('G7'), ['V7', 'dominant', 'diatonic', '']);
  assert.deepEqual(read('D7'), ['V7/V', 'secondary dominant', 'secondary dominant', 'V']);
  assert.deepEqual(read('E'), ['V/vi', 'secondary dominant', 'secondary dominant', 'vi']);
  assert.deepEqual(read('C#dim7'), ['vii°7/ii', 'secondary dominant', 'applied diminished', 'ii']);
  assert.deepEqual(read('Fm'), ['iv', 'subdominant', 'borrowed', 'C minor']);
  assert.deepEqual(read('Bb'), ['bVII', 'subdominant', 'borrowed', 'C minor']);
  assert.deepEqual(read('Db'), ['bII', 'subdominant', 'borrowed', 'C phrygian']);
  assert.deepEqual(read('Db7'), ['bII7', 'dominant', 'tritone substitute', 'I']);
  assert.deepEqual(read('G7#5#9'), ['V7#5#9', 'dominant', 'altered dominant', '']);
  assert.deepEqual(read('C/E'), ['I/3', 'tonic', 'diatonic', '']);
  // a minor key: its major V is borrowed on paper (harmonic minor), a major IV is the dorian colour
  assert.deepEqual(read('E7', 'A', 'minor'), ['V7', 'dominant', 'borrowed', 'A harmonic minor']);
  assert.deepEqual(read('G#dim', 'A', 'minor'), ['vii°', 'dominant', 'borrowed', 'A harmonic minor']);
  assert.deepEqual(read('D', 'A', 'minor'), ['IV', 'subdominant', 'borrowed', 'A melodic minor']);
  assert.deepEqual(read('Bb7', 'A', 'minor'), ['bII7', 'dominant', 'tritone substitute', 'i']);
  assert.equal(functionOf('bVI', 'C', 'major'), 'subdominant');
  assert.equal(readChord('bVII', keyContext('A', 'minor')).name, 'G');
  // tension rises from home to the dominant to chords from outside
  const t = (c) => chordTension(c, 'C', 'major').tension;
  assert.ok(t('C') < t('Am') && t('Am') < t('F') && t('F') < t('G7') && t('G7') < t('D7') && t('D7') < t('C#dim7'), [t('C'), t('Am'), t('F'), t('G7'), t('D7'), t('C#dim7')].join(' '));
  assert.ok(t('C') < 0.15 && t('C#dim7') > 0.7);
  assert.deepEqual(tensionCurve(['Am', '-', 'F', 'E7'], 'A', 'minor').map((x) => x.numeral), ['i', 'VI', 'V7']);
});

test('naming what sounds: chords from pitches, the key from notes, the chords of a part', () => {
  const names = (p) => detectChords(p).map((c) => c.name);
  assert.equal(names([60, 64, 67])[0], 'C');
  assert.equal(names([64, 67, 72])[0], 'C/E');
  assert.deepEqual(names([57, 60, 64, 67]).slice(0, 2), ['Am7', 'C6/A']);
  assert.equal(names([55, 59, 62, 65, 68])[0], 'G7b9');
  assert.equal(names([60, 67])[0], 'C5');
  assert.deepEqual(names([60]), []);
  assert.deepEqual(names([]), []);
  const best = detectChords([62, 60, 64, 67, 71])[0];
  assert.ok(best.score > 0.8 && best.missing.length === 0);
  // (a fifth left out is cheap: C–E–B is still Cmaj7)
  assert.equal(names([60, 64, 71])[0], 'Cmaj7');
  const twinkle = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60].map((key) => ({ key, length: 96 }));
  assert.deepEqual([detectKey(twinkle)[0].key, detectKey(twinkle)[0].scale, detectKey(twinkle)[0].relative], ['C', 'major', 'A minor']);
  const sad = [57, 60, 64, 57, 62, 65, 64, 56, 57].map((key) => ({ key, length: 96 }));
  assert.deepEqual([detectKey(sad)[0].key, detectKey(sad)[0].scale], ['A', 'minor']);
  assert.deepEqual(detectKey([]), []);
  const bar = PPQ * 4;
  const part = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]].flatMap((ch, i) => ch.map((key) => ({ key, start: i * bar, length: bar })));
  assert.deepEqual(chordsFromNotes(part, { segment: bar }).map((c) => [c.start, c.chord]), [[0, 'Am'], [bar, 'F'], [2 * bar, 'C'], [3 * bar, 'G']]);
  // the same chord over two bars is one entry; silence is an entry of its own
  const held = [...[57, 60, 64].map((key) => ({ key, start: 0, length: 2 * bar })), ...[55, 59, 62].map((key) => ({ key, start: 3 * bar, length: bar }))];
  assert.deepEqual(chordsFromNotes(held, { segment: bar }).map((c) => [c.start, c.length, c.chord]), [[0, 2 * bar, 'Am'], [2 * bar, bar, null], [3 * bar, bar, 'G']]);
});

test('what could come next: the usual moves first, each with its reason; the same question, the same answer', () => {
  const top = (prog, k, s, o) => suggestNext(prog, k, s, o).map((x) => x.chord);
  assert.equal(top([], 'C', 'major')[0], 'C');
  assert.equal(top(['Dm7', 'G7'], 'C', 'major', { sevenths: true })[0], 'Cmaj7');
  assert.equal(top(['C', 'Am', 'F'], 'C', 'major')[0], 'G7');
  assert.equal(top(['C', 'A7'], 'C', 'major')[0], 'Dm', 'a secondary dominant resolves to its target');
  assert.deepEqual(top(['Am', 'G', 'F'], 'A', 'minor').slice(0, 2), ['E', 'E7'], 'the Andalusian cadence ends on the major V');
  assert.deepEqual(suggestNext(['C', 'G'], 'C', 'major'), suggestNext(['C', 'G'], 'C', 'major'));
  const after = suggestNext(['C', 'G', 'Am'], 'C', 'major', { count: 40 });
  assert.equal(after[0].chord, 'F');
  assert.match(after[0].why, /continues "Axis \(I-V-vi-IV\)"/);
  assert.ok(after.every((x) => x.score >= 0 && x.score <= 1 && x.why.length > 5 && x.tension >= 0));
  assert.ok(after.every((x, i) => i === 0 || x.score <= after[i - 1].score), 'best first');
  // the pools: what belongs to the key, what is borrowed, what is chromatic
  assert.ok(suggestNext(['C'], 'C', 'major', { pools: ['diatonic'], count: 40 }).every((x) => x.pool === 'diatonic' && x.kind === 'diatonic'));
  const colours = suggestNext(['C'], 'C', 'major', { pools: ['borrowed'], count: 40 });
  assert.ok(colours.length > 3 && colours.every((x) => x.pool === 'borrowed' && /borrowed from C /.test(x.why)));
  const chromatic = suggestNext(['C'], 'C', 'major', { pools: ['chromatic'], count: 40 });
  assert.ok(chromatic.some((x) => x.numeral === 'V7/V' && /expect V next/.test(x.why)) && chromatic.some((x) => x.kind === 'tritone substitute'));
  // in a minor key the major V and its seventh are at home, not "borrowed"
  assert.ok(suggestNext(['Am'], 'A', 'minor', { pools: ['diatonic'], count: 40 }).some((x) => x.chord === 'E7'));
  assert.throws(() => suggestNext([], 'C', 'major', { pools: ['jazz'] }), /Unknown pool "jazz"\. Use: diatonic, borrowed, chromatic/);
  // the chord just played is not what comes next
  assert.notEqual(top(['C', 'F'], 'C', 'major')[0], 'F');
});

test('substitutes, mirrors and ways to another key', () => {
  const subs = substitutions('G7', 'C', 'major');
  const kind = (k) => subs.filter((x) => x.kind === k).map((x) => x.chord);
  assert.deepEqual(kind('tritone substitute'), ['Db7']);
  assert.deepEqual(kind('relative'), ['Bdim']);
  assert.deepEqual(kind('approach'), ['D7', 'F#dim7', 'Ab7']);
  assert.ok(kind('extension').includes('G13') && kind('extension').includes('G7b9'));
  const forF = substitutions('F', 'C', 'major');
  assert.ok(forF.some((x) => x.chord === 'Dm' && x.kind === 'relative') && forF.some((x) => x.chord === 'Fm' && x.kind === 'borrowed'));
  assert.deepEqual(['P', 'L', 'R', 'RLP', 'LPR', 'LPL'].map((m) => neoRiemannian('C', m).name), ['Cm', 'Em', 'Am', 'Fm', 'Dbm', 'Abm']);
  assert.equal(neoRiemannian(neoRiemannian('Am', 'R'), 'R').name, 'Am', 'every move undoes itself');
  assert.throws(() => neoRiemannian('C7', 'P'), /major and minor triads/);
  // negative harmony: the dominant becomes the minor plagal chord
  assert.deepEqual(negativeHarmony(['C', 'F', 'G7', 'Am', 'Dm7'], 'C').map((x) => x.mirrored), ['Cm', 'Gm', 'Fm6', 'Eb', 'Bb6']);
  assert.deepEqual(negativeHarmony(negativeHarmony(['C', 'F', 'G'], 'C').map((x) => x.mirrored), 'C').map((x) => x.mirrored), ['C', 'F', 'G'], 'mirrored twice is where it started');
  const toG = modulationPaths('C', 'major', 'G', 'major');
  assert.deepEqual([toG[0].kind, toG[0].chords], ['pivot chord', ['C', 'Am', 'D7', 'G']]);
  assert.match(toG[0].why, /Am is vi in C major and ii in G major/);
  const far = modulationPaths('C', 'major', 'E', 'major', { count: 20 });
  assert.ok(far.some((p) => p.kind === 'borrowed pivot') && far.some((p) => p.kind === 'dominant preparation' && p.chords.join(' ') === 'C B7 E') && far.some((p) => p.kind === 'common tone'));
  assert.ok(far.every((p) => p.chords[0] === 'C' && p.chords[p.chords.length - 1] === 'E' && p.roles.length === p.chords.length));
  assert.ok(modulationPaths('C', 'major', 'F#', 'major', { count: 20 }).some((p) => p.kind === 'direct'), 'no note in common between C and F#');
  assert.throws(() => modulationPaths('C', 'major', 'C', 'major'), /the same key/);
});

test('the library: 82 progressions, found by words, tags, mode and length — and recognised in what was written', () => {
  assert.equal(PROGRESSIONS.length, 82);
  assert.equal(new Set(PROGRESSIONS.map((p) => p.name)).size, 82);
  for (const p of PROGRESSIONS) assert.ok(SCALES[p.scale] && p.numerals.length >= 2 && p.tags.length && p.description.length > 10, p.name);
  assert.deepEqual(findProgressions({ query: 'andalusian', key: 'A' }).map((p) => p.chords.join(' ')), ['Am G F E']);
  assert.ok(findProgressions({ tags: ['lo-fi'], limit: 50 }).length >= 5);
  assert.ok(findProgressions({ tags: ['lo-fi', 'jazz'], limit: 50 }).every((p) => p.tags.includes('lo-fi') && p.tags.includes('jazz')));
  assert.ok(findProgressions({ scale: 'dorian', limit: 50 }).every((p) => p.scale === 'dorian'));
  assert.ok(findProgressions({ mood: 'minor', limit: 100 }).every((p) => SCALES[p.scale].includes(3)));
  assert.ok(findProgressions({ length: 2, limit: 100 }).every((p) => p.chords.length === 2));
  assert.deepEqual(findProgressions({ query: 'zzzz' }), []);
  assert.throws(() => findProgressions({ tags: ['lofi'] }), /No progression is tagged "lofi"\. Did you mean "lo-fi"\?/);
  assert.equal(progressionTags()[0].tag, 'cinematic');
  assert.equal(progressionByName('Axis', 'G').chords.join(' '), 'G D Em C');
  assert.equal(progressionByName('andalusian cadence', 'E').chords.join(' '), 'Em D C B');
  assert.throws(() => progressionByName('nothing like this'), /No progression is called "nothing like this"/);
  const ids = identifyProgression(['C', 'G', 'Am', 'F'], 'C', 'major');
  assert.deepEqual([ids[0].name, ids[0].match], ['Axis (I-V-vi-IV)', 'exact']);
  assert.ok(ids.some((x) => x.name.startsWith('Sensitive') && x.match === 'rotation'));
  assert.deepEqual(identifyProgression(['C', 'F#'], 'C', 'major'), []);
});

test('voice leading: the whole progression at once, least movement, no parallel fifths or octaves', () => {
  const r = voiceLead(['C', 'Am', 'F', 'G']);
  assert.deepEqual(r.voicings, [[48, 60, 64, 67], [45, 60, 64, 69], [41, 60, 65, 69], [43, 59, 62, 67]]);
  assert.deepEqual(r.movement, [5, 5, 8]);
  assert.equal(r.total, 18);
  // every voicing holds its chord, low to high, inside the range
  for (const [chords, opts] of [[['Dm7', 'G7', 'Cmaj7', 'A7'], {}], [['Cmaj9', 'Fmaj7', 'G13', 'C/E'], { voices: 5 }], [['Am', 'F', 'C', 'G'], { voices: 3, low: 48, high: 72 }], [['C', 'F', 'G', 'C'], { voices: 6, style: 'open' }], [['Dm7', 'G7', 'Cmaj7'], { bass: 'smooth' }]]) {
    const out = voiceLead(chords, opts);
    out.voicings.forEach((v, i) => {
      const chord = readChord(chords[i]);
      assert.equal(v.length, opts.voices || 4);
      assert.ok(v.every((p, j) => p >= (opts.low ?? 40) && p <= (opts.high ?? 79) && (j === 0 || p > v[j - 1])), `${chords[i]}: ${v}`);
      assert.ok(v.every((p) => chord.pcs.includes(p % 12) || p % 12 === chord.bass), `${chords[i]}: ${v}`);
      if (opts.bass !== 'smooth') assert.equal(v[0] % 12, chord.bass ?? chord.root, `${chords[i]}: the bass`);
    });
    // no two voices move in parallel fifths or octaves (six voices on a triad double so much that some must: there
    // parallels only cost, they are not ruled out)
    for (let t = 1; t < out.voicings.length && (opts.voices || 4) < 6; t++) {
      const [a, b] = [out.voicings[t - 1], out.voicings[t]];
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
        const before = (a[j] - a[i]) % 12;
        const parallel = (before === 0 || before === 7) && (b[j] - b[i]) % 12 === before && b[i] !== a[i] && Math.sign(b[i] - a[i]) === Math.sign(b[j] - a[j]);
        assert.ok(!parallel, `${chords[t - 1]} → ${chords[t]}: voices ${i} and ${j}`);
      }
    }
  }
  // letting the bass take any chord tone moves less than holding it to the root
  assert.ok(voiceLead(['Dm7', 'G7', 'Cmaj7', 'A7'], { bass: 'smooth' }).total < voiceLead(['Dm7', 'G7', 'Cmaj7', 'A7']).total);
  // a rest keeps its place; a loop is as smooth the hundredth time
  assert.deepEqual(voiceLead(['C', '-', 'G']).voicings.map((v) => v && v.length), [4, null, 4]);
  const loop = voiceLead(Array.from({ length: 240 }, (_, i) => ['Am', 'F', 'C', 'G'][i % 4]));
  assert.deepEqual(loop.voicings.slice(8, 12), loop.voicings.slice(200, 204));
  assert.throws(() => voiceLead(['C'], { voices: 7 }), /voices must be 3–6/);
  assert.throws(() => voiceLead(['C'], { voices: 6, low: 60, high: 72 }), /No 6-voice voicing of C fits between MIDI 60 and 72: widen the range or use fewer voices/);
  assert.deepEqual(voiceLead([]).voicings, []);
});

test('arpeggios, Euclidean rhythms and drum grooves: the same seed, the same part', () => {
  const cyc = (m, o = 1) => arpCycle([60, 64, 67, 71], m, o);
  assert.deepEqual(cyc('up'), [60, 64, 67, 71]);
  assert.deepEqual(cyc('down'), [71, 67, 64, 60]);
  assert.deepEqual(cyc('updown'), [60, 64, 67, 71, 67, 64]);
  assert.deepEqual(cyc('downup'), [71, 67, 64, 60, 64, 67]);
  assert.deepEqual(cyc('converge'), [60, 71, 64, 67]);
  assert.deepEqual(cyc('diverge'), [64, 67, 60, 71]);
  assert.deepEqual(cyc('pinky'), [60, 71, 64, 71, 67, 71]);
  assert.deepEqual(cyc('thumb'), [60, 64, 60, 67, 60, 71]);
  assert.deepEqual(arpCycle([67, 60, 64], 'asplayed'), [67, 60, 64]);
  assert.deepEqual(arpCycle([60, 64], 'up', 3), [60, 64, 72, 76, 84, 88]);
  assert.equal(ARP_MODES.length, 10);
  assert.throws(() => arpCycle([60], 'upp'), /Unknown arpeggio mode "upp"\. Did you mean "up"/);
  const ev = [{ pitches: [60, 64, 67], start: 0, length: PPQ * 4 }, { pitches: [57, 60, 65], start: PPQ * 4, length: PPQ * 4 }];
  const up = arpeggiate(ev);
  assert.deepEqual(up.slice(0, 5).map((n) => [n.key, n.start, n.length]), [[60, 0, 38], [64, 48, 38], [67, 96, 38], [60, 144, 38], [64, 192, 38]]);
  assert.equal(up.length, 16);
  assert.ok(up.every((n) => n.start + n.length <= (n.start < PPQ * 4 ? PPQ * 4 : PPQ * 8)), 'a gate up to 1 never rings past its chord');
  // swing moves every second note; accents come round; a velocity pattern overrides both
  assert.deepEqual(arpeggiate([ev[0]], { rate: STEP, swing: 0.5, accentEvery: 4 }).slice(0, 5).map((n) => [n.start, n.velocity]), [[0, 1], [30, 0.8], [48, 0.8], [78, 0.8], [96, 1]]);
  assert.deepEqual(arpeggiate([ev[0]], { rate: PPQ, velocities: [1, 0.5] }).map((n) => n.velocity), [1, 0.5, 1, 0.5]);
  const rand = (seed) => arpeggiate(ev, { mode: 'random', seed }).map((n) => n.key).join(' ');
  assert.equal(rand(3), rand(3));
  assert.notEqual(rand(3), rand(4));
  assert.ok(arpeggiate(ev, { mode: 'random', seed: 9 }).every((n, i, all) => i === 0 || n.start >= PPQ * 4 !== all[i - 1].start >= PPQ * 4 || n.key !== all[i - 1].key), 'never the same note twice in a row');

  assert.deepEqual([euclidString(8, 3), euclidString(8, 5), euclidString(16, 5), euclidString(12, 7), euclidString(5, 2)], ['x--x--x-', 'x-xx-xx-', 'x--x--x--x--x---', 'x-xx-x-xx-x-', 'x-x--']);
  assert.deepEqual([euclidString(4, 0), euclidString(4, 4), euclidString(8, 9), euclidString(0, 3)], ['----', 'xxxx', 'xxxxxxxx', '']);
  assert.equal(euclidString(8, 3, 1), '--x--x-x');
  assert.equal(euclidString(8, 3, 0, { accentFirst: true }), 'X--x--x-');
  for (let n = 1; n <= 32; n++) for (let k = 0; k <= n; k++) assert.equal(euclid(n, k).filter(Boolean).length, k, `${n}, ${k}`);

  assert.equal(DRUM_STYLES.length, 16);
  for (const style of DRUM_STYLES) {
    const hits = drumPattern(style, { bars: 2 });
    assert.ok(hits.length > 4 && hits.every((h) => DRUM_ROLES.includes(h.role) && h.tick >= 0 && h.tick < 2 * PPQ * 4 && Number.isInteger(h.tick) && h.velocity > 0 && h.velocity <= 1), style);
    assert.ok(hits.some((h) => h.role === 'kick' && h.tick === 0), `${style}: a kick on the one`);
    assert.deepEqual(DRUM_STYLE_INFO[style].roles.sort(), [...new Set(hits.map((h) => h.role))].sort(), style);
  }
  const groove = (seed, o = {}) => JSON.stringify(drumPattern('trap', { bars: 4, variation: 0.7, fill: true, seed, ...o }));
  assert.equal(groove('verse'), groove('verse'));
  assert.notEqual(groove('verse'), groove('chorus'));
  assert.equal(JSON.stringify(drumPattern('house', { bars: 2, seed: 1 })), JSON.stringify(drumPattern('house', { bars: 2, seed: 2 })), 'no variation asked: the seed changes nothing');
  // a fill takes the last quarter of the last bar; the kick stays
  const filled = drumPattern('backbeat', { bars: 2, fill: true, seed: 5 }).filter((h) => h.tick >= PPQ * 4 + PPQ * 3);
  assert.ok(filled.length >= 4 && filled.every((h) => ['snare', 'tom', 'kick'].includes(h.role)));
  assert.deepEqual(drumPattern('shuffle').filter((h) => h.role === 'hat').map((h) => h.tick), [0, 64, 96, 160, 192, 256, 288, 352], 'twelve steps to the bar');
  assert.equal(drumPattern('boomBap').find((h) => h.role === 'hat' && h.tick > 0 && h.tick < 48), undefined);
  assert.ok(drumPattern('boomBap', { swing: 0 }).some((h) => h.tick === 168) && drumPattern('boomBap').some((h) => h.tick === 172), 'the style brings its own swing');
  assert.throws(() => drumPattern('trapp'), /Unknown drum style "trapp"\. Did you mean "trap"\?/);
  assert.equal(seedOf('verse'), seedOf('verse'));
  const rng = createRng(1);
  assert.ok(Array.from({ length: 1000 }, () => rng.unit()).every((x) => x >= 0 && x < 1));
});

test('tuning systems: the published numbers, exact ratios, and a root that never moves', () => {
  assert.deepEqual(TUNING_IDS, ['equal', 'just', 'just7', 'pythagorean', 'meantone', 'werckmeister', 'kirnberger', 'vallotti', 'young', 'harmonic', 'custom']);
  const cents = (t) => tuningDegrees(t).map((d) => Math.round(d.cents * 10) / 10);
  assert.deepEqual(tuningTable({ system: 'just' }).map((r) => r.ratio), ['1/1', '16/15', '9/8', '6/5', '5/4', '4/3', '45/32', '3/2', '8/5', '5/3', '9/5', '15/8']);
  assert.deepEqual(tuningTable({ system: 'just7' }).map((r) => r.ratio).filter((_, i) => [3, 6, 10].includes(i)), ['7/6', '7/5', '7/4']);
  assert.deepEqual(tuningTable({ system: 'pythagorean' }).map((r) => r.ratio), ['1/1', '2187/2048', '9/8', '32/27', '81/64', '4/3', '729/512', '3/2', '6561/4096', '27/16', '16/9', '243/128']);
  assert.deepEqual(tuningTable({ system: 'harmonic' }).map((r) => r.ratio), ['1/1', '17/16', '9/8', '19/16', '5/4', '21/16', '11/8', '3/2', '13/8', '27/16', '7/4', '15/8']);
  // Werckmeister III, Vallotti, Young II, Kirnberger III as they are printed in the tuning literature (cents)
  assert.deepEqual(cents({ system: 'werckmeister' }), [0, 90.2, 192.2, 294.1, 390.2, 498, 588.3, 696.1, 792.2, 888.3, 996.1, 1092.2]);
  assert.deepEqual(cents({ system: 'vallotti' }), [0, 94.1, 196.1, 298, 392.2, 502, 592.2, 698, 796.1, 894.1, 1000, 1090.2]);
  assert.deepEqual(cents({ system: 'young' }), [0, 90.2, 196.1, 294.1, 392.2, 498, 588.3, 698, 792.2, 894.1, 996.1, 1090.2]);
  assert.deepEqual(cents({ system: 'kirnberger' }), [0, 90.2, 193.2, 294.1, 386.3, 498, 590.2, 696.6, 792.2, 889.7, 996.1, 1088.3]);
  // quarter-comma meantone: pure major thirds, and the wolf between G# and Eb
  const mt = tuningDegrees({ system: 'meantone' });
  close(mt[4].cents, 1200 * Math.log2(5 / 4), 1e-9);
  close(mt[3].cents + 1200 - mt[8].cents, 737.6);
  close(tuningDegrees({ system: 'meantone', fraction: 0 })[4].cents, 1200 * Math.log2(81 / 64), 1e-9);
  assert.equal(tuningTable({ system: 'meantone' })[3].near, '6/5');
  assert.equal(tuningTable({})[4].near, null, 'equal temperament is near nothing in particular');

  // the root keeps its equal-tempered frequency, whatever the system and whichever the root
  for (const system of TUNING_IDS.filter((s) => s !== 'custom')) for (let pc = 0; pc < 12; pc++) {
    const root = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][pc];
    for (const key of [36 + pc, 60 + pc, 84 + pc]) close(tuningCents({ system, root }, key), 0, 1e-9);
  }
  const just = { system: 'just', root: 'C' };
  assert.equal(tunedFrequency(just, 60), midiToFreq(60));
  assert.equal(tunedFrequency(just, 69) / tunedFrequency(just, 60), 5 / 3);
  assert.equal(tunedFrequency(just, 72) / tunedFrequency(just, 60), 2);
  assert.equal(tunedFrequency(just, 48) / tunedFrequency(just, 60), 0.5);
  close(tuningCents(just, 64), -13.686, 0.001);
  close(tuningCents(just, 67), 1.955, 0.001);
  // A4: every note moves with it
  close(tunedFrequency({ a4: 432 }, 69), 432, 1e-9);
  close(tuningCents({ a4: 432 }, 60), -31.767, 0.001);
  close(tuningCents({ system: 'just', root: 'A', a4: 432 }, 69), -31.767, 0.001);
  assert.equal(tuningCents({}, 61), 0);
  assert.equal(tuningCents(null, 61), 0);
  assert.equal(isStandardTuning({ system: 'equal', root: 'D' }), true);
  assert.equal(isStandardTuning({ system: 'equal', divisions: 19 }), false);
  // other equal divisions: each key is one step
  const edo = { system: 'equal', divisions: 19, root: 'C' };
  close(tunedFrequency(edo, 79), 2 * tunedFrequency(edo, 60), 1e-9);
  assert.equal(tuningTable(edo).length, 19);
  // a table of your own, as ratios or as cents
  const own = normalizeTuning({ system: 'custom', root: 'f#', ratios: ['1/1', '16:15', '9/8', '6/5', '5/4', '4/3', '7/5', '3/2', '8/5', '5/3', 1.75, '15/8'] });
  assert.deepEqual([own.root, own.ratios[1], own.ratios[10]], ['F#', '16/15', 1.75]);
  assert.deepEqual(tuningTable(own).slice(9, 11).map((r) => r.ratio), ['5/3', null]);
  close(tuningDegrees({ system: 'custom', cents: [0, 100, 200, 300, 386.3, 500, 600, 700, 800, 900, 1000, 1100] })[4].cents, 386.3, 1e-9);

  // what a tuning does to a chord: C major beats ten times a second in equal temperament, not at all in just
  const et = chordPurity({}, [60, 64, 67]);
  close(et.pairs[0].beatsHz, 10.38, 0.01);
  assert.equal(et.ratios, null);
  const pure = chordPurity(just, [60, 64, 67]);
  assert.deepEqual([pure.ratios, pure.worstBeatsHz], ['4:5:6', 0]);
  // …and the price: the D minor chord of that same C tuning has a fifth a comma flat
  const wolf = chordPurity(just, [62, 65, 69]);
  assert.equal(wolf.ratios, '27:32:40');
  close(wolf.pairs.find((p) => p.ratio === '3/2').offCents, -21.51, 0.01);
  assert.equal(chordPurity({ system: 'just7', root: 'G' }, [55, 59, 62, 65]).ratios, '4:5:6:7');

  assert.deepEqual(approximateRatio(1.5), [3, 2]);
  assert.deepEqual(approximateRatio(Math.PI, 113), [355, 113]);
  assert.equal(describeTuning({ system: 'just', root: 'd', a4: 432 }), 'Just intonation (5-limit) on D, A4 = 432 Hz');
  assert.equal(describeTuning({ system: 'meantone', fraction: 1 / 6 }), '1/6-comma meantone on C');
  assert.equal(describeTuning({ divisions: 19 }), '19 equal divisions of the octave on C');
  assert.equal(describeTuning(null), 'Equal temperament');
  // what cannot be read falls back to the standard — or, asked strictly, says what is valid
  assert.deepEqual(normalizeTuning({ system: 'jst', a4: 'x', root: 9 }), { system: 'equal', root: 'A', a4: 440 });
  for (const [bad, re] of [[{ system: 'jst' }, /Unknown tuning system "jst"\. Did you mean "just"/], [{ a4: 900 }, /a4 is 900: the reference pitch must be 380–500 Hz/], [{ system: 'equal', divisions: 3 }, /a whole number 5–72/], [{ system: 'custom' }, /needs `cents`[^\n]*or `ratios`/], [{ root: 'H' }, /Invalid tuning root "H"/], [{ system: 'meantone', fraction: 2 }, /must be 0–0\.5/]]) {
    assert.throws(() => normalizeTuning(bad, { strict: true }), re);
  }
});

test('a project has a tuning: set as a patch, kept through save and load, said in the summary and the diff', () => {
  const p = createDefaultProject({ name: 'T' });
  assert.deepEqual(p.tuning, { system: 'equal', root: 'C', a4: 440 });
  assert.deepEqual(normalizeProject({ ...p, tuning: undefined }).tuning, { system: 'equal', root: 'C', a4: 440 }, 'an older project is in standard tuning');
  const just = applyOps(p, [{ type: 'project/update', patch: { tuning: { system: 'just', root: 'D' } } }]);
  assert.deepEqual(just.tuning, { system: 'just', root: 'D', a4: 440 });
  const low = applyOps(just, [{ type: 'project/update', patch: { tuning: { a4: 432 } } }]);
  assert.deepEqual(low.tuning, { system: 'just', root: 'D', a4: 432 }, 'what a patch does not name stays');
  assert.deepEqual(applyOps(applyOps(low, [{ type: 'project/update', patch: { tuning: { system: 'meantone' } } }]), [{ type: 'project/update', patch: { tuning: { system: 'equal' } } }]).tuning, { system: 'equal', root: 'D', a4: 432 }, 'a system leaves nothing behind when it goes');
  assert.deepEqual(applyOps(low, [{ type: 'project/update', patch: { tuning: null } }]).tuning, { system: 'equal', root: 'C', a4: 440 });
  assert.throws(() => applyOps(p, [{ type: 'project/update', patch: { tuning: { system: 'pure' } } }]), /Unknown tuning system "pure"/);
  assert.throws(() => applyOps(p, [{ type: 'project/update', patch: { tuning: 'just' } }]), /tuning must be an object/);
  assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(low))).tuning, low.tuning);
  assert.match(summarizeProject(low), /tuning Just intonation \(5-limit\) on D, A4 = 432 Hz/);
  assert.doesNotMatch(summarizeProject(p), /tuning/);
  assert.match(diffProjects(p, low).lines.join('\n'), /tuning Equal temperament → Just intonation \(5-limit\) on D, A4 = 432 Hz/);
  // a scale is set by any of its names
  assert.equal(applyOps(p, [{ type: 'project/update', patch: { scale: 'jazz minor' } }]).scale, 'melodicMinor');
  // drums are sounds, not pitches: a tuning leaves them alone
  const kind = (k, params) => ({ kind: k, params: params || {} });
  assert.deepEqual(['kick', 'hat', 'synth', 'ggs', 'piano', 'bass808'].map((k) => followsTuning(kind(k))), [false, false, true, true, true, true]);
  assert.deepEqual([followsTuning(kind('sampler', { pitched: false })), followsTuning(kind('sampler', { pitched: true })), followsTuning(kind('nothing'))], [false, true, false]);
});
