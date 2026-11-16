// What an agent leans on: errors that name the fix, notes as text, the project diff, and renders it can compare.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nearest, didYouMean, nearestNumber, findChannel, findPattern, sanitizeParams, INSTRUMENTS, getEffectDef, makeInstrument,
  parsePosition, formatPositionText, parseDuration, formatDuration, parseNoteText, formatNoteText, STEP, PPQ,
  createProjectFromTemplate, createEffect, applyOps, prepareOps, diffProjects, diffNotes,
  audioFingerprint, maskingReport, describeMasking, compareRenders, createLevelMeter, analyzeAudio, BARK_EDGES_HZ, BARK_BANDS, nullTest, toPcm16, SAME_AUDIO_DB
} from '../src/index.js';

test('did you mean: the nearest names, and nothing when nothing is near', () => {
  assert.deepEqual(nearest('Led', ['Kick', 'Lead', 'Pad']), ['Lead']);
  assert.deepEqual(nearest('cutof', ['f1Cutoff', 'f2Cutoff', 'oscAPos', 'level']), ['f1Cutoff', 'f2Cutoff']);
  assert.deepEqual(nearest('sqare', ['sine', 'square', 'saw']), ['square']);
  assert.deepEqual(nearest('lenght', ['note', 'start', 'length', 'velocity']), ['length']);
  assert.deepEqual(nearest('zzz', ['Kick', 'Lead']), []);
  assert.deepEqual(nearest('', ['Kick']), []);
  assert.deepEqual(nearest('KICK', ['Kick', 'kick']), ['Kick'], 'case does not matter, and the same name is offered once');
  assert.equal(didYouMean('Led', ['Kick', 'Lead']), ' Did you mean "Lead"?');
  assert.equal(didYouMean('pat', ['Pattern 1', 'Pattern 2', 'Path']), ' Did you mean "Path", "Pattern 1" or "Pattern 2"?');
  assert.equal(didYouMean('xyz', ['Kick']), '');
  assert.equal(nearestNumber(20, [16, 24]), 16);
  assert.equal(nearestNumber(21, [16, 24]), 24);
  assert.equal(nearestNumber(5, []), null);
});

test('errors say what is valid and what is nearest', () => {
  const p = { channels: [{ id: 'c1', name: 'Lead' }, { id: 'c2', name: 'Kick' }], patterns: [{ id: 'p1', name: 'Verse' }] };
  assert.throws(() => findChannel(p, 'Led'), /Channel "Led" not found\. Did you mean "Lead"\? Available: Lead \(c1\), Kick \(c2\)/);
  assert.throws(() => findPattern(p, 'Vers'), /Did you mean "Verse"\?/);
  assert.throws(() => findChannel(p, 'Trumpet'), /Channel "Trumpet" not found\. Available:/, 'nothing near: no guess');
  const ggs = INSTRUMENTS.ggs.params;
  assert.throws(() => sanitizeParams(ggs, { f1Cutof: 500 }, { strict: true }), /Unknown parameter "f1Cutof"\. Did you mean "f1Cutoff" or "f2Cutoff"\? There are \d+ parameters$/);
  assert.throws(() => sanitizeParams(ggs, { f1Cutoff: 30000 }, { strict: true }), /"f1Cutoff" must be between 20 and 20000 Hz \(got 30000; the nearest valid value is 20000\)/);
  assert.throws(() => sanitizeParams(ggs, { f1Cutoff: 3 }, { strict: true }), /the nearest valid value is 20\)/);
  assert.throws(() => sanitizeParams(ggs, { f1Cutoff: 'high' }, { strict: true }), /must be a number between 20 and 20000 Hz \(got "high"\)/);
  assert.throws(() => sanitizeParams(ggs, { f1Type: 'lader24' }, { strict: true }), /"f1Type" must be one of: lp12[^)]*\(got "lader24"\)\. Did you mean "ladder24"\?/);
  // a short list is still given whole
  const kick = INSTRUMENTS.kick.params;
  assert.throws(() => sanitizeParams(kick, { tun: 1 }, { strict: true }), /Unknown parameter "tun"\. Did you mean "tune"\? Valid: /);
  assert.throws(() => makeInstrument('ggs', 'Velvet Pd', {}, { strict: true }), /Unknown preset "Velvet Pd" for ggs\. Did you mean "Velvet Pad"\?/);
  assert.throws(() => getEffectDef('revreb'), /Unknown effect "revreb"\. Did you mean "reverb"\?/);
  // not strict: clamped, never thrown
  assert.equal(sanitizeParams(ggs, { f1Cutoff: 30000, nope: 1 }).f1Cutoff, 20000);
});

const FOUR = { timeSig: [4, 4] };
const THREE = { timeSig: [3, 4] };
const SIX8 = { timeSig: [6, 8] };

test('positions: bars, beats, sixteenths, ticks, steps and beats', () => {
  const cases = [['1', 0], ['1.1', 0], ['1.1.1', 0], ['2', 384], ['5.3', 1728], ['5.3.2', 1752], ['5.3.2.12', 1764], ['70s', 1680], ['70.5s', 1692], ['17.5b', 1680], ['0s', 0], [' 2.3 ', 576], ['3 steps', 72], ['2 beats', 192]];
  for (const [text, ticks] of cases) assert.equal(parsePosition(text, FOUR), ticks, text);
  assert.equal(parsePosition(6, FOUR), 6 * STEP, 'a number is steps, as in every tool');
  assert.equal(parsePosition(2.5, FOUR), 60);
  // bars follow the time signature
  assert.equal(parsePosition('2', THREE), 3 * PPQ);
  assert.equal(parsePosition('2.3', THREE), 5 * PPQ);
  assert.equal(parsePosition('3', SIX8), 6 * PPQ);
  // the shortest text that says it — and it reads back
  for (const [ticks, text] of [[0, '1'], [96, '1.2'], [120, '1.2.2'], [121, '1.2.2.1'], [384, '2'], [1764, '5.3.2.12']]) {
    assert.equal(formatPositionText(ticks, FOUR), text);
    assert.equal(parsePosition(text, FOUR), ticks);
  }
  for (const project of [FOUR, THREE, SIX8]) for (let t = 0; t < 2000; t += 7) assert.equal(parsePosition(formatPositionText(t, project), project), t, `tick ${t} in ${project.timeSig.join('/')}`);
  // wrong positions say what is wrong and how to write one
  assert.throws(() => parsePosition('0', FOUR), /"0" is not a position: bars start at 1\. Write a position as "bar", "bar\.beat"/);
  assert.throws(() => parsePosition('5.5', FOUR), /a bar has 4 beats here, so the beat is 1–4/);
  assert.throws(() => parsePosition('1.4', THREE), /a bar has 3 beats here/);
  assert.throws(() => parsePosition('5.3.480', FOUR), /the third number is the sixteenth inside the beat, 1–4 .*add ticks as a fourth number, 0–23/);
  assert.throws(() => parsePosition('5.3.2.24', FOUR), /the fourth number is ticks inside the sixteenth, 0–23/);
  for (const bad of ['abc', '', '1.2.3.4.5', '-1', '1,5', '5.3x', -1, NaN, Infinity, null, undefined, '999999999']) assert.throws(() => parsePosition(bad, FOUR), /is not a position/, String(bad));
});

test('durations: note values, triplets, dotted, ties, bars, beats, steps', () => {
  const cases = [['1/4', 96], ['1/8', 48], ['1/16', 24], ['1/32', 12], ['1/2', 192], ['1/1', 384], ['1/8t', 32], ['1/4t', 64], ['1/16t', 16], ['1/4d', 144], ['1/8d', 72], ['1/4+1/16', 120], ['1bar+1/8', 432], ['2bar', 768], ['1.5b', 144], ['3s', 72], ['0.5s', 12], ['3/8', 144], ['2 bars', 768]];
  for (const [text, ticks] of cases) assert.equal(parseDuration(text, FOUR), ticks, text);
  assert.equal(parseDuration(2, FOUR), 48, 'a number is steps');
  assert.equal(parseDuration('1bar', THREE), 288);
  assert.equal(parseDuration('1/64t', FOUR), 4);
  assert.equal(parseDuration(0.001, FOUR), 1, 'never shorter than a tick');
  for (const [ticks, text] of [[96, '1/4'], [144, '1/4d'], [64, '1/4t'], [32, '1/8t'], [384, '1bar'], [768, '2bar'], [192, '1/2'], [120, '5s'], [1, '0.042s'], [576, '1/1d']]) {
    assert.equal(formatDuration(ticks, FOUR), text);
    assert.equal(parseDuration(text, FOUR), ticks, `${text} reads back`);
  }
  for (const project of [FOUR, THREE, SIX8]) for (let t = 1; t < 1500; t += 5) assert.equal(parseDuration(formatDuration(t, project), project), t, `${t} ticks in ${project.timeSig.join('/')}`);
  assert.throws(() => parseDuration('1/0', FOUR), /"1\/0" is not a duration: a note value needs numbers above zero\. Write a duration as a note value/);
  for (const bad of ['x', '', '1/4x', '1/', '+', '1/4+', 0, -1, NaN, null, '0s', '99999999bar']) assert.throws(() => parseDuration(bad, FOUR), /is not a duration/, String(bad));
});

test('compact note text: chords, runs, velocity, release, pan — and it reads back', () => {
  const notes = parseNoteText('1.1 D3+A3+F4 1/2 v0.7\n> C5 1/8t\n> D5 1/8t  # a comment\n> E5 1/8t r0.9 p-0.3; 2 A2 1bar v100\n= E3 1/4\n\n# only a comment\n3.2.3 60 1/16', FOUR);
  assert.deepEqual(notes.map((n) => [n.key, n.start, n.length]), [[50, 0, 192], [57, 0, 192], [65, 0, 192], [72, 192, 32], [74, 224, 32], [76, 256, 32], [45, 384, 384], [52, 384, 96], [60, 912, 24]]);
  assert.deepEqual(notes.slice(0, 3).map((n) => n.velocity), [0.7, 0.7, 0.7]);
  assert.equal(notes[3].velocity, 0.8, 'no velocity: 0.8');
  assert.deepEqual([notes[5].releaseVelocity, notes[5].pan], [0.9, -0.3]);
  assert.ok(Math.abs(notes[6].velocity - 100 / 127) < 1e-9, 'v100 is a MIDI velocity');
  assert.equal(parseNoteText('1 C4 1/4 v1.5', FOUR)[0].velocity, 1);
  assert.equal(parseNoteText('1 C4 1/4', FOUR, { velocity: 0.5 })[0].velocity, 0.5);
  assert.equal(parseNoteText('1 C4 1/4 p0', FOUR)[0].pan, undefined, 'a centred pan is no pan');
  // sharps are not comments
  assert.deepEqual(parseNoteText('1 F#3+C#4 1/4 #c; 1.2 G#2 1/8  # ids', FOUR).map((n) => n.key), [54, 61, 44]);

  const withIds = notes.map((n, i) => ({ id: `n${i}`, ...n }));
  const text = formatNoteText(withIds, FOUR, { ids: true });
  assert.equal(text, [
    '1 D3+A3+F4 1/2 v0.7  # n0,n1,n2',
    '1.3 C5 1/8t  # n3',
    '> D5 1/8t  # n4',
    '> E5 1/8t r0.9 p-0.3  # n5',
    '2 A2 1bar v0.787  # n6',
    '2 E3 1/4  # n7',
    '3.2.3 C4 1/16  # n8'
  ].join('\n'));
  assert.equal(formatNoteText([{ key: 60, start: 0, length: 96, velocity: 0.8, expression: {} }], FOUR, { tag: () => 'expr: pitch' }), '1 C4 1/4  # expr: pitch');
  assert.equal(formatNoteText([], FOUR), '');

  // any notes at all survive the trip through text
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (const project of [FOUR, THREE, SIX8]) {
    const wild = Array.from({ length: 300 }, () => ({ key: 24 + rnd(72), start: rnd(4000), length: 1 + rnd(600), velocity: (1 + rnd(1000)) / 1000, ...(rnd(4) ? {} : { pan: (rnd(200) - 100) / 100 }), ...(rnd(5) ? {} : { releaseVelocity: rnd(1001) / 1000 }) }));
    const back = parseNoteText(formatNoteText(wild, project), project);
    const sig = (list) => list.map((n) => `${n.key}|${n.start}|${n.length}|${Math.round(n.velocity * 1000)}|${Math.round((n.pan || 0) * 1000)}|${n.releaseVelocity === undefined ? '' : Math.round(n.releaseVelocity * 1000)}`).sort().join(' ');
    // (a release velocity of exactly 0.5 is the default and is not printed)
    assert.equal(sig(back), sig(wild.map((n) => (n.releaseVelocity === 0.5 ? (({ releaseVelocity: _r, ...rest }) => rest)(n) : n))), project.timeSig.join('/'));
  }
});

test('note text errors name the line and the fix', () => {
  const bad = (text, re) => assert.throws(() => parseNoteText(text, FOUR), re, text);
  bad('1.1 C4', /Line 1 \("1\.1 C4"\): a note line needs a start, a pitch and a duration — one note or chord per line/);
  bad('1 C4 1/4\n1.1 H4 1/4', /Line 2 \("1\.1 H4 1\/4"\): Invalid note "H4"/);
  bad('> C4 1/4', /Line 1 .*">" refers to the line before, and this is the first line/);
  bad('1 C4 1/4; = D4 1/x', /Line 2 .*"1\/x" is not a duration/);
  bad('1.5 C4 1/4', /Line 1 .*a bar has 4 beats here/);
  bad('1 C4 1/4 x9', /"x9" is not understood — after the duration come v<velocity>, r<release velocity> and p<pan>/);
  bad('1 C4 1/4 v200', /velocity "v200" must be 0–1 \(1 = full\) or a MIDI velocity 2–127/);
  bad('1 C4 1/4 r2', /release velocity "r2" must be 0–1/);
  bad('1 C4 1/4 p3', /pan "p3" must be −1 \(left\) … 1 \(right\)/);
  bad('1 C4+ 1/4', /"C4\+" has an empty pitch/);
  bad('1 C4 1/4 v', /"v" is not understood/);
  bad('# nothing here\n\n', /The text holds no notes\. One note or chord per line/);
  bad('', /The text holds no notes/);
});

test('project diff: every kind of change in words, and the same music is no change', () => {
  const a = createProjectFromTemplate('trap', { name: 'T', bpm: 140 });
  assert.equal(diffProjects(a, a).changed, false);
  assert.equal(diffProjects(a, JSON.parse(JSON.stringify(a))).summary, 'No difference.');
  const [kick, clap] = a.channels;
  const pat = a.patterns[0];
  const before = pat.notes[clap.id][0];
  const b = applyOps(a, prepareOps([
    { type: 'project/update', patch: { bpm: 150, swing: 0.2, key: 'D' } },
    { type: 'channel/update', id: kick.id, patch: { volume: 0.9, name: 'Boom', instrument: { params: { decay: 0.6 } } } },
    { type: 'notes/add', patternId: pat.id, channelId: kick.id, notes: [{ id: 'new1', key: 62, start: 96, length: 96, velocity: 0.8 }, { id: 'new2', key: 65, start: 96, length: 96, velocity: 0.8 }] },
    { type: 'notes/update', patternId: pat.id, channelId: clap.id, notes: [{ id: before.id, start: before.start + 24, velocity: 0.3 }] },
    { type: 'effect/add', index: 1, effect: createEffect('reverb') },
    { type: 'mixer/update', index: 0, patch: { volume: 0.8 } },
    { type: 'pattern/add', pattern: { id: 'pat_new', name: 'Break', length: 768, notes: { [kick.id]: [{ key: 60, start: 0, length: 24, velocity: 1 }] } } },
    { type: 'marker/add', marker: { id: 'mk1', name: 'Hook', tick: 1536 } }
  ]));
  const d = diffProjects(a, b);
  assert.equal(d.changed, true);
  const text = d.lines.join('\n');
  assert.match(text, /^Project: tempo 140 → 150 BPM, key \w+ \w+ → D \w+, swing 0 % → 20 %/m);
  assert.match(text, /^~ Channel "Boom": name "Kick" → "Boom"; volume \d+ % → 90 %; sound: decay [\d.]+ → 0\.6 s$/m);
  assert.match(text, /^ {2}Boom: \+2 notes\n {4}\+ 1\.2 D4\+F4 1\/4$/m);
  assert.match(text, /^ {4}~ .* → .* \(later, softer\)$/m);
  assert.match(text, /^\+ Pattern "Break" \[pat_new\]: 2 bars, 1 note \(Boom 1\)$/m);
  assert.match(text, /^\+ Marker "Hook" at bar 5$/m);
  assert.match(text, /^~ Master: volume 0 dB → -1\.9 dB$/m);
  assert.match(text, /^~ Insert 1[^\n]*: effects \+ reverb \[fx_/m);
  assert.deepEqual([d.counts.project, d.counts.channels, d.counts.patterns, d.counts.notesAdded, d.counts.notesChanged, d.counts.markers, d.counts.mixer, d.counts.effects], [3, 1, 2, 3, 1, 1, 2, 1]);
  assert.match(d.summary, /^Changed: project settings; 1 channel; 2 patterns; 3 notes added, 1 changed; 1 marker; 2 mixer inserts \(1 effect change\)\.$/);
  // the other way round, the same things are removed
  const back = diffProjects(b, a).lines.join('\n');
  assert.match(back, /^− Pattern "Break" \(2 bars, 1 note\)$/m);
  assert.match(back, /^− Marker "Hook"$/m);
  assert.match(back, /effects − reverb/);

  // a part rewritten note for note (new ids, same music) is not a change
  const rewritten = applyOps(a, prepareOps([{ type: 'notes/set', patternId: pat.id, channelId: clap.id, notes: pat.notes[clap.id].map(({ id: _id, ...n }) => n) }]));
  assert.notEqual(rewritten.patterns[0].notes[clap.id][0].id, before.id);
  assert.equal(diffProjects(a, rewritten).changed, false);
  assert.deepEqual(diffNotes([{ id: 'a', key: 60, start: 0, length: 24, velocity: 0.8 }], [{ id: 'b', key: 60, start: 0, length: 24, velocity: 0.8 }, { id: 'c', key: 60, start: 0, length: 24, velocity: 0.8 }]).added.map((n) => n.id), ['c'], 'a doubled note is one added note');

  // clips, automation, long lists
  const c = applyOps(a, prepareOps([
    { type: 'clip/add', clips: Array.from({ length: 20 }, (_, i) => ({ id: `clip${i}`, kind: 'pattern', refId: pat.id, track: 0, start: i * 384, length: 384 })) },
    { type: 'automation/add', automation: { id: 'au1', name: 'Rise', target: { type: 'master', param: 'volume' }, length: 384, points: [{ t: 0, v: 0 }, { t: 384, v: 1 }] } }
  ]));
  const dc = diffProjects(a, c);
  assert.match(dc.lines.join('\n'), /^Playlist: 20 clips added, 0 removed, 0 changed\n {2}\+ clip "\w+" at bar 1, 1bar, track 1/m);
  assert.match(dc.lines.join('\n'), /… 12 more/);
  assert.match(dc.lines.join('\n'), /^\+ Automation "Rise" \[au1\] of master volume: 1bar, 2 points$/m);
  assert.match(dc.lines.join('\n'), /^Song length \d+ → \d+ bars$/m);
  const moved = applyOps(c, [{ type: 'clip/update', id: 'clip3', patch: { start: 40 * 384, track: 2 } }]);
  assert.match(diffProjects(c, moved).lines.join('\n'), /^~ clip "\w+" \(bar 4\): start bar 4 → bar 41, track 1 → 3$/m);
  // a long diff is cut, and says by how much
  const many = applyOps(a, prepareOps([{ type: 'notes/add', patternId: pat.id, channelId: kick.id, notes: Array.from({ length: 80 }, (_, i) => ({ key: 30 + i, start: i * 24 + 7, length: 24, velocity: 0.8 })) }]));
  const dm = diffProjects(a, many, { maxNotes: 5, maxLines: 6 });
  assert.equal(dm.lines.length, 7);
  assert.match(dm.lines[6], /^… and \d+ more lines$/);
  assert.match(diffProjects(a, many, { maxNotes: 5 }).lines.join('\n'), /\+ … 75 more/);
});

const sine = (hz, amp, seconds, fs = 44100, from = 0) => Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => (i / fs >= from ? amp * Math.sin((2 * Math.PI * hz * i) / fs) : 0));

test('fingerprint: the same audio or not, to the bit', () => {
  const L = sine(220, 0.5, 0.5);
  const R = sine(330, 0.5, 0.5);
  const h = audioFingerprint([L, R]);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(audioFingerprint([Float32Array.from(L), Float32Array.from(R)]), h, 'the same samples, the same fingerprint');
  const one = Float32Array.from(L);
  const bits = new Uint32Array(one.buffer);
  bits[1234] ^= 1; // the smallest change there is
  assert.notEqual(audioFingerprint([one, R]), h);
  assert.notEqual(audioFingerprint([R, L]), h, 'left and right swapped is other audio');
  assert.notEqual(audioFingerprint([L]), audioFingerprint([L.subarray(0, L.length - 1)]));
  const joined = new Float32Array(L.length * 2);
  joined.set(L); joined.set(R, L.length);
  assert.notEqual(audioFingerprint([joined]), h, 'two channels are not one long one');
  assert.notEqual(audioFingerprint([new Float32Array(100)]), audioFingerprint([new Float32Array(100).fill(-0)]), '0 and −0 differ');
  assert.equal(audioFingerprint([]), audioFingerprint([]));
  // a view that does not start on a 4-byte boundary of its buffer
  const odd = new Float32Array(new ArrayBuffer(4 * 101), 4, 100);
  odd.set(L.subarray(0, 100));
  assert.equal(audioFingerprint([odd]), audioFingerprint([L.slice(0, 100)]));
  // many different renders, no two alike
  const seen = new Set(Array.from({ length: 500 }, (_, i) => audioFingerprint([Float32Array.of(i / 1000, 0.25)])));
  assert.equal(seen.size, 500);
});

/** Band frames of a signal, as a stem meter fed in half-second chunks collects them. */
function framesOf(left, right = left, fs = 44100) {
  const meter = createLevelMeter(fs, { bands: true });
  const chunk = Math.round(fs / 2);
  for (let at = 0; at + chunk <= left.length; at += chunk) meter.push([left.subarray(at, at + chunk), right.subarray(at, at + chunk)]);
  return meter.result();
}

test('the stem meter keeps Bark-band energies over time', () => {
  assert.equal(BARK_BANDS, 24);
  assert.equal(BARK_EDGES_HZ.length, 25);
  const amp = 0.5;
  const r = framesOf(sine(1000, amp, 4));
  assert.equal(r.bandFrames.length, 8, 'two frames a second');
  const band = BARK_EDGES_HZ.findIndex((hz, i) => hz <= 1000 && BARK_EDGES_HZ[i + 1] > 1000);
  for (const f of r.bandFrames) {
    assert.equal(f.length, 24);
    assert.ok(Math.abs(f[band] - (amp * amp) / 2) / ((amp * amp) / 2) < 0.03, `a sine's mean square is half its amplitude squared: ${f[band]}`);
    const rest = f.reduce((s, v, i) => (i === band ? s : s + v), 0);
    assert.ok(rest < f[band] * 1e-3, 'and almost nothing leaks into the other bands');
  }
  // without the option nothing is kept, and the other numbers are what they were
  const plain = createLevelMeter(44100);
  plain.push([sine(1000, amp, 1), sine(1000, amp, 1)]);
  assert.equal(plain.result().bandFrames, undefined);
  const { bandFrames: _frames, ...withBands } = r;
  const again = createLevelMeter(44100);
  const x = sine(1000, amp, 4);
  for (let at = 0; at + 22050 <= x.length; at += 22050) again.push([x.subarray(at, at + 22050), x.subarray(at, at + 22050)]);
  assert.deepEqual(withBands, again.result());
});

test('masking: stems that are strong in the same band at the same moment', () => {
  const kick = { name: 'Kick', frames: framesOf(sine(60, 0.5, 8)).bandFrames };
  const bass = { name: 'Bass', frames: framesOf(Float32Array.from(sine(70, 0.4, 8), (v, i) => v + 0.4 * Math.sin((2 * Math.PI * 440 * i) / 44100))).bandFrames };
  const hat = { name: 'Hat', frames: framesOf(sine(8000, 0.2, 8)).bandFrames };
  const m = maskingReport([kick, bass, hat]);
  assert.equal(m.frames, 16);
  assert.equal(m.overlaps.length, 1, 'only the two that share the bottom collide');
  const o = m.overlaps[0];
  assert.deepEqual([o.a, o.b, o.lowHz, o.highHz, o.shareOfTime], ['Kick', 'Bass', 20, 100, 1]);
  // the bass has half its energy elsewhere: it loses least by giving way
  assert.equal(o.yield, 'Bass');
  assert.ok(o.yieldShare > 0.4 && o.yieldShare < 0.6 && o.keepShare > 0.99, `${o.yieldShare} / ${o.keepShare}`);
  // contested energy: the smaller of the two in that band — the bass's 70 Hz sine, mean square 0.08 = −11 dB
  assert.ok(Math.abs(o.overlapDb - 10 * Math.log10(0.08)) < 0.5, `${o.overlapDb} dB`);
  assert.match(o.suggestion, /duck "Bass" under "Kick" \(a pump effect on "Bass" with source "Kick"\)/);
  assert.deepEqual(m.stems.map((s) => s.name), ['Kick', 'Bass', 'Hat']);
  const lines = describeMasking(m);
  assert.match(lines[0], /^Masking — stems that are strong in the same band at the same moment/);
  assert.match(lines[1], /"Kick" × "Bass" {2}20 Hz–100 Hz {2}100% of the time, contested energy -1[01](\.\d)? dB — that range is \d+% of "Bass" and 100% of the other/);

  // the same two, but never at the same time: no collision
  const early = { name: 'Early', frames: framesOf(Float32Array.from(sine(60, 0.5, 8), (v, i) => (i < 4 * 44100 ? v : 0))).bandFrames };
  const late = { name: 'Late', frames: framesOf(sine(60, 0.5, 8, 44100, 4)).bandFrames };
  assert.deepEqual(maskingReport([early, late]).overlaps, []);
  assert.match(describeMasking(maskingReport([early, late]))[0], /^Masking: no two stems are strong in the same band/);
  // …and for a quarter of the time: reported with that share
  const quarter = { name: 'Quarter', frames: framesOf(Float32Array.from(sine(60, 0.5, 8), (v, i) => (i < 2 * 44100 ? v : 0))).bandFrames };
  assert.equal(maskingReport([kick, quarter]).overlaps[0].shareOfTime, 0.25);
  // a quiet stem under a loud one is not "strong": too soft to fight (−60 dB)
  const whisper = { name: 'Whisper', frames: framesOf(sine(60, 0.0005, 8)).bandFrames };
  assert.deepEqual(maskingReport([kick, whisper]).overlaps, []);
  // mid-range collisions get the other advice, and the worst comes first
  const keys = { name: 'Keys', frames: framesOf(sine(1000, 0.3, 8)).bandFrames };
  const lead = { name: 'Lead', frames: framesOf(sine(1040, 0.3, 8)).bandFrames };
  const both = maskingReport([keys, lead, kick, bass]);
  assert.deepEqual(both.overlaps.map((x) => `${x.a}×${x.b}`), ['Kick×Bass', 'Keys×Lead']);
  assert.match(both.overlaps[1].suggestion, /cut "(Keys|Lead)" a few dB at 920 Hz–1\.1 kHz \(EQ\)/);
  // nothing to compare
  assert.equal(maskingReport([kick]), null);
  assert.equal(maskingReport([]), null);
  assert.equal(maskingReport([{ name: 'a', frames: kick.frames.slice(0, 2) }, { name: 'b', frames: kick.frames.slice(0, 2) }]), null, 'too short to say');
  assert.deepEqual(describeMasking(null), []);
});

test('comparing two renders: identical or not, and what moved', () => {
  const analyse = (L, R = L) => analyzeAudio({ channels: [L, R], sampleRate: 44100 });
  const base = sine(110, 0.25, 3);
  const a = { hash: audioFingerprint([base, base]), mix: analyse(base), stems: [{ name: 'Bass', lufs: -20 }, { name: 'Pad', lufs: -30 }], limiter: { maxDb: -1 } };
  const same = compareRenders(a, { ...a });
  assert.equal(same.identical, true);
  assert.match(same.lines[0], /^Bit-identical: the same audio, sample for sample/);

  const louder = Float32Array.from(base, (v) => v * 2);
  const b = { hash: audioFingerprint([louder, louder]), mix: analyse(louder), stems: [{ name: 'Bass', lufs: -14 }, { name: 'Pad', lufs: -30.4 }, { name: 'Lead', lufs: -22 }], limiter: { maxDb: -4 } };
  const d = compareRenders(a, b);
  assert.equal(d.identical, false);
  assert.ok(Math.abs(d.deltas.lufs - 6) < 0.15 && Math.abs(d.deltas.truePeakDb - 6) < 0.15, JSON.stringify(d.deltas));
  const text = d.lines.join('\n');
  assert.match(text, /^6(\.\d)? LU louder \(-?[\d.]+ → -?[\d.]+ LUFS\)$/m);
  assert.match(text, /^peaks 6(\.\d)? dB higher \(true peak/m);
  assert.match(text, /^master limiter works harder \(max gain reduction -1 → -4 dB\)$/m);
  assert.match(text, /^stems: "Bass" \+6 LU, "Lead" is new \(-22 LUFS\)$/m, 'a stem that moved less than 1 LU is not news');
  assert.match(compareRenders(b, a).lines.join('\n'), /LU quieter[\s\S]*"Lead" is gone/);

  // brighter: energy moves up the spectrum
  const bright = Float32Array.from(base, (v, i) => v * 0.5 + 0.2 * Math.sin((2 * Math.PI * 3000 * i) / 44100));
  const c = compareRenders(a, { hash: 'x', mix: analyse(bright), stems: [] });
  assert.match(c.lines.join('\n'), /spectrum: [^\n]*low -\d+(\.\d)? pts[^\n]*high-mid \+\d+(\.\d)? pts/);
  assert.match(c.lines.join('\n'), /^brighter \(centroid \d+ → \d+ Hz\)$/m);
  // wider
  const wide = compareRenders(a, { hash: 'y', mix: analyse(base, Float32Array.from(base, (v, i) => 0.25 * Math.sin((2 * Math.PI * 110 * i) / 44100 + 1))), stems: [] });
  assert.match(wide.lines.join('\n'), /^wider \(stereo width 0 → [\d.]+\)$/m);
  // a change no meter can tell, and no samples to subtract: said as it is, never as "identical" or "the same"
  const nudged = Float32Array.from(base, (v) => v * 1.001);
  const tinyRender = { hash: audioFingerprint([nudged, nudged]), mix: analyse(nudged), stems: a.stems, limiter: a.limiter };
  const tiny = compareRenders(a, tinyRender);
  assert.deepEqual([tiny.identical, tiny.same], [false, false]);
  assert.match(tiny.lines[0], /^the same by every meter \(loudness \+?0(\.\d+)? LU, true peak \+?0(\.\d+)? dB, no band moved by 2 points\)\. Not bit-identical — but a browser sums its mixer in a different order from run to run/);
  // with the earlier render's samples the null test settles it: 0.1 % louder leaves −60 dB — a very small change
  const nt = { against: a.hash, ...nullTest([toPcm16(base), toPcm16(base)], [nudged, nudged], 44100) };
  const settled = compareRenders(a, { ...tinyRender, nullTest: nt });
  assert.equal(settled.same, false);
  assert.match(settled.lines.join('\n'), /^no meter moved \([^)]*\)\nnull test: a very small change — what is left after subtracting the earlier render is at -6\d(\.\d)? dB relative to the mix \(0 dB would be unrelated audio; below -80 dB is rounding\), most of it around 0:0\d$/);
  // rounding in the last bit — what a browser's mixer does from one run to the next — is the same audio
  const jitter = Float32Array.from(base, (v, i) => v + (i % 7 === 0 ? 1.2e-7 : 0));
  const noise = { against: a.hash, ...nullTest([toPcm16(base), toPcm16(base)], [jitter, jitter], 44100) };
  assert.equal(noise.same, true);
  const quiet = compareRenders(a, { hash: audioFingerprint([jitter, jitter]), mix: analyse(jitter), stems: a.stems, limiter: a.limiter, nullTest: noise });
  assert.deepEqual([quiet.identical, quiet.same], [false, true]);
  assert.match(quiet.lines[0], /^The same audio: subtracting the earlier render leaves (nothing at 16 bits|-\d+(\.\d)? dB relative to the mix) — the last bit of a browser's mixer/);
  assert.equal(quiet.lines.length, 1);
  // a null test against some other render is not used
  assert.equal(compareRenders(a, { ...tinyRender, nullTest: { ...nt, against: 'someone else' } }).nullTest, null);
  // no fingerprints: never called identical
  assert.equal(compareRenders({ mix: a.mix }, { mix: a.mix }).identical, false);
});

test('the null test: subtract the earlier render and measure what is left', () => {
  const fs = 44100;
  const x = sine(220, 0.5, 2);
  const kept = [toPcm16(x), toPcm16(x)];
  assert.ok(kept[0] instanceof Int16Array && kept[0].length === x.length);
  assert.deepEqual(Array.from(toPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5, NaN))), [0, 32767, -32767, 32767, -32768, 16384, 0]);
  // the same samples: nothing is left
  const none = nullTest(kept, [x, x], fs);
  assert.deepEqual([none.residualDb, none.residualDbfs, none.peakDb, none.worstAt, none.seconds, none.lengthDelta, none.same], [-200, -200, -200, null, 2, 0, true]);
  // 1 dB louder: the difference is 11 % of the louder of the two, −19.3 dB — and the same the other way round
  const gain = Math.pow(10, 1 / 20);
  const louder = Float32Array.from(x, (v) => v * gain);
  const one = nullTest(kept, [louder, louder], fs);
  assert.ok(Math.abs(one.residualDb - 20 * Math.log10((gain - 1) / gain)) < 0.2, `${one.residualDb} dB`);
  assert.ok(Math.abs(nullTest([toPcm16(louder)], [x], fs).residualDb - one.residualDb) < 0.1, 'louder → softer reads the same as softer → louder');
  // 6 dB down leaves half of the earlier render: −6 dB, not "unrelated audio"
  const half = Float32Array.from(x, (v) => v * 0.5);
  assert.ok(Math.abs(nullTest(kept, [half, half], fs).residualDb + 6) < 0.1);
  assert.equal(one.same, false);
  // other audio altogether: about 0 dB (+3 for two uncorrelated signals of the same level)
  const other = sine(337, 0.5, 2);
  assert.ok(Math.abs(nullTest(kept, [other, other], fs).residualDb - 3) < 0.5);
  // a change in the second second only: that is where it is found
  const late = Float32Array.from(x, (v, i) => (i >= fs ? v * 0.5 : v));
  const where = nullTest(kept, [late, late], fs);
  assert.equal(where.worstAt, 1.5);
  assert.ok(where.residualDb < -8 && where.residualDb > -10, `half the level for half the time: ${where.residualDb} dB`);
  // different lengths: the common part is compared, and the lengths are not "the same"
  const longer = new Float32Array(x.length + fs);
  longer.set(x);
  const grown = nullTest(kept, [longer, longer], fs);
  assert.deepEqual([grown.residualDb, grown.seconds, grown.lengthDelta, grown.same], [-200, 2, 1, false]);
  // a very quiet mix: the 16-bit floor counts as rounding even where −80 dB relative would not be reached
  const hush = sine(220, 0.0005, 2);
  const hushed = Float32Array.from(hush, (v, i) => v + (i % 3 === 0 ? 2e-5 : 0));
  const floor = nullTest([toPcm16(hush), toPcm16(hush)], [hushed, hushed], fs);
  assert.ok(floor.residualDb > SAME_AUDIO_DB && floor.residualDbfs <= -96 && floor.same, JSON.stringify(floor));
  // mono against stereo, silence against silence, nothing at all
  assert.equal(nullTest([toPcm16(x)], [x, x], fs).same, true);
  assert.equal(nullTest([new Int16Array(100)], [new Float32Array(100)], fs).same, true);
  assert.equal(nullTest([], [], fs).seconds, 0);
});
