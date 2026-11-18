// Harmony and tuning through the tools: analysis and suggestions, the library, voice-led chords, arpeggios, drum
// grooves, Euclidean rhythms, and the tuning of the project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readChord } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool } from './helpers.js';

let srv;
let user;
let client;
let call;
let pid;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'agent', password: 'agent-pass-1' });
  client = await mcpClient(srv.base, (await user.post('/api/me/token')).body.token);
  call = callTool(client);
  // (a scale goes by any of its names)
  assert.match(await call('create_project', { name: 'Harmony', template: 'empty', key: 'A', scale: 'aeolian', bpm: 100 }), /A minor/);
  pid = (await user.get('/api/active')).body.projectId;
  for (const [name, instrument, preset] of [['Keys', 'piano'], ['Lead', 'ggs', 'Touch Lead'], ['Kick', 'kick'], ['Bass', 'bass808']]) await call('add_channel', { name, instrument, ...(preset ? { preset } : {}) });
  await call('create_pattern', { name: 'Verse', bars: 4 });
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const chan = (p, name) => p.channels.find((c) => c.name === name);
const notesOf = (p, channel, pattern = 'Verse') => p.patterns.find((x) => x.name === pattern).notes[chan(p, channel).id] || [];
const fails = (pr, re) => pr.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));
async function unchanged(fn) {
  const was = await project();
  await fn();
  assert.deepEqual(await project(), was, 'the project is as it was');
}

test('the tools are there: 104 of them, the new editing ones with a dry run', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 104);
  for (const name of ['add_arpeggio', 'add_drum_groove', 'set_tuning']) assert.ok(tools.find((t) => t.name === name).inputSchema.properties.dryRun, name);
  for (const name of ['harmony', 'describe_tuning', 'music_theory']) assert.equal(tools.find((t) => t.name === name).annotations.readOnlyHint, true, name);
});

test('harmony: what the chords are, what could follow, what could stand in, and the way to another key', async () => {
  await unchanged(async () => {
    const read = await call('harmony', { action: 'analyze', chords: ['Am', 'F', 'C', 'G', 'E7'] });
    assert.match(read, /Am – F – C – G – E7 in A minor:/);
    assert.match(read, / 1\. Am {8}i {10}tonic {14}tension 0\.09/);
    assert.match(read, / 5\. E7 {8}V7 {9}dominant {11}tension 0\.59 {2}— borrowed from A harmonic minor/);
    assert.match(read, /highest on chord 5 \(E7\), and it ends on the dominant/);
    assert.match(await call('harmony', { action: 'analyze', chords: ['vi', 'IV', 'I', 'V'], key: 'C', scale: 'major' }), /Known as: "Sensitive \(vi-IV-I-V\)"/);
    assert.match(await call('harmony', { action: 'analyze', chords: ['IV', 'I', 'V', 'vi'], key: 'C', scale: 'major' }), /Known as: "House lift \(IV-I-V-vi\)", "Axis \(I-V-vi-IV\)" \(started on another chord\)/);

    const next = await call('harmony', { action: 'suggest', chords: ['Am', 'G', 'F'], count: 3 });
    assert.match(next, /After Am – G – F in A minor:\nIn the key:\n {2}E {8}V {9}0\.\d\d {2}tension 0\.\d\d — [^\n]*continues "Andalusian cadence"/);
    assert.match(next, /Borrowed from parallel modes:\n[^\n]*borrowed from A /);
    assert.match(next, /Chromatic:\n/);
    assert.match(await call('harmony', { action: 'suggest', pools: ['diatonic'], count: 2 }), /^To start in A minor:\nIn the key:\n {2}Am /);
    assert.doesNotMatch(await call('harmony', { action: 'suggest', chords: ['i'], pools: ['diatonic'] }), /Borrowed|Chromatic:/);

    const subs = await call('harmony', { action: 'substitute', chord: 'V7' });
    assert.match(subs, /^E7 is V7 in A minor \(dominant\)/);
    assert.match(subs, /Tritone substitute:\n\s+Bb7\s+bII7\s+shares the tritone of E7/);
    assert.match(subs, /Approach:\n\s+B7\s+V7\/v\s+its own dominant/);
    assert.match(await call('harmony', { action: 'negative', chords: ['C', 'F', 'G7'], key: 'C', scale: 'major' }), /Mirrored progression: Cm – Gm – Fm6/);
    const away = await call('harmony', { action: 'modulate', toKey: 'C', toScale: 'minor', count: 3 });
    assert.match(away, /From A minor to C minor, best first:\n1\. borrowed pivot \(0\.\d\d\): Am – Dm – G7 – Cm\n {3}Dm is iv in A minor and ii in C minor/);

    const found = await call('harmony', { action: 'progressions', query: 'andalusian' });
    assert.match(found, /"Andalusian cadence" — minor: i VII VI V {2}= {2}Am G F E/);
    assert.match(await call('harmony', { action: 'progressions', tags: ['lo-fi'], count: 20 }), /\d+ progressions, written in A/);
    assert.match(await call('harmony', { action: 'progressions', query: 'zzzz' }), /No progression in the library fits that\. Tags: cinematic \(25\)/);
    await fails(call('harmony', { action: 'progressions', tags: ['lofi'] }), /No progression is tagged "lofi"\. Did you mean "lo-fi"\?/);
    await fails(call('harmony', { action: 'substitute' }), /chord is required for action "substitute"/);
    await fails(call('harmony', { action: 'analyze' }), /chords is required/);
    await fails(call('harmony', { action: 'modulate' }), /toKey is required/);
    await fails(call('harmony', { action: 'suggest', chords: ['Xm'] }), /Invalid chord "Xm"/);
    await fails(call('harmony', { action: 'suggest', scale: 'lidian' }), /Unknown scale "lidian"\. Did you mean "lydian"/);
    await fails(call('harmony', { action: 'guess' }), /action is "guess": it must be one of "analyze", "suggest"/);
  });
});

test('add_chords: a progression from the library, voiced for four voices that move as little as they can', async () => {
  assert.match(await call('add_chords', { pattern: 'Verse', channel: 'Keys', progression: 'Andalusian cadence', voices: 4 }), /Wrote "Andalusian cadence" = Am – G – F – E \(16 notes, block, 4 voices led smoothly\) to "Keys" in "Verse"/);
  const notes = notesOf(await project(), 'Keys');
  const bars = [0, 1, 2, 3].map((b) => notes.filter((n) => n.start === b * 384).map((n) => n.key).sort((x, y) => x - y));
  assert.deepEqual(bars.map((b) => b.length), [4, 4, 4, 4]);
  ['Am', 'G', 'F', 'E'].forEach((name, i) => {
    const chord = readChord(name);
    assert.ok(bars[i].every((k) => chord.pcs.includes(k % 12)), `${name}: ${bars[i]}`);
    assert.equal(bars[i][0] % 12, chord.root, `${name}: the root in the bass`);
  });
  const moved = bars.slice(1).map((b, i) => b.reduce((sum, k, v) => sum + Math.abs(k - bars[i][v]), 0));
  // (root position chords an octave apart would move 8, 8 and 4 in parallel — and in parallel fifths; this does not)
  assert.ok(moved.every((m) => m <= 12), `semitones moved per change: ${moved}`);
  for (let i = 1; i < bars.length; i++) for (let x = 0; x < 4; x++) for (let y = x + 1; y < 4; y++) {
    const was = (bars[i - 1][y] - bars[i - 1][x]) % 12;
    assert.ok(!((was === 7 || was === 0) && (bars[i][y] - bars[i][x]) % 12 === was && bars[i][x] !== bars[i - 1][x] && Math.sign(bars[i][x] - bars[i - 1][x]) === Math.sign(bars[i][y] - bars[i - 1][y])), `parallel motion into bar ${i + 1}`);
  }
  // the pattern says what it holds
  const read = await call('harmony', { action: 'analyze', pattern: 'Verse' });
  assert.match(read, /Chords of "Verse", one reading per bar: Am {2}G {2}F {2}E\nKey by the notes: [^\n]*A minor/);
  assert.match(read, /Known as: "Andalusian cadence"/);
  assert.match(await call('harmony', { action: 'analyze', pattern: 'Verse', channel: 'Keys', per: 'half' }), /one reading per half: Am ×2 {2}G ×2/);
  await unchanged(async () => {
    await fails(call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Am'], progression: 'Axis' }), /either chords[^\n]*or progression[^\n]*one of the two/);
    await fails(call('add_chords', { pattern: 'Verse', channel: 'Keys' }), /either chords/);
    await fails(call('add_chords', { pattern: 'Verse', channel: 'Keys', progression: 'no such thing' }), /No progression is called "no such thing"/);
    await fails(call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: ['C'], voices: 9 }), /voices is 9: the maximum is 6/);
    await fails(call('harmony', { action: 'analyze', pattern: 'Verse', channel: 'Lead' }), /"Verse" has no notes on "Lead" to read chords from/);
  });
  // every new chord quality is playable
  assert.match(await call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Am6/9', 'G7#9', 'Fmaj7#11', 'E7b9', 'IV/1', 'N6', 'V65', '-'], stepsPerChord: 8 }), /Wrote Am6\/9 – G7#9 – Fmaj7#11 – E7b9 – D\/A – Bb\/D – E7\/G# – -/);
});

test('add_arpeggio: ten ways through a chord, and the same seed plays the same notes', async () => {
  assert.match(await call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', progression: 'Andalusian cadence', mode: 'pinky', rate: '1/16', octaves: 2 }), /Arpeggiated "Andalusian cadence" = Am – G – F – E \(pinky, 64 notes, one every 1 step, 2 octaves\) on "Lead" in "Verse": \w+–\w+/);
  let lead = notesOf(await project(), 'Lead');
  assert.equal(lead.length, 64);
  const top = Math.max(...lead.filter((n) => n.start < 384).map((n) => n.key));
  assert.ok(lead.filter((n) => n.start < 384).every((n, i) => (i % 2 ? n.key === top : n.key < top)), 'the top note between all the others');
  const random = async (seed) => {
    await call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', chords: ['i', 'VI', 'III', 'VII'], mode: 'random', seed });
    return notesOf(await project(), 'Lead').map((n) => `${n.start}:${n.key}`).join(' ');
  };
  const a = await random('take 1');
  assert.equal(await random('take 1'), a);
  assert.notEqual(await random('take 2'), a);
  // swing and accents; a longer rate; the solver's voicing
  await call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', chords: ['Am7', 'Dm7'], rate: '1/8', swing: 0.5, accentEvery: 4, voices: 4, gate: 1 });
  lead = notesOf(await project(), 'Lead');
  assert.deepEqual(lead.slice(0, 5).map((n) => [n.start, n.velocity]), [[0, 0.95], [60, 0.75], [96, 0.75], [156, 0.75], [192, 0.95]]);
  assert.equal(new Set(lead.filter((n) => n.start < 384).map((n) => n.key)).size, 4);
  await unchanged(async () => {
    assert.match(await call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', chords: ['i'], dryRun: true }), /DRY RUN — nothing was changed/);
    await fails(call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', chords: ['i'], mode: 'sideways' }), /mode is "sideways": it must be one of "up", "down"/);
    await fails(call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', chords: ['-', '-'] }), /every chord is a rest/);
    await fails(call('add_arpeggio', { pattern: 'Verse', channel: 'Lead' }), /either chords/);
    await fails(call('add_arpeggio', { pattern: 'Verse', channel: 'Lead', chords: ['i'], rate: '1/x' }), /"1\/x" is not a duration/);
  });
});

test('add_drum_groove: a style on the drum channels there are, the missing ones made; write_drums takes Euclidean rhythms', async () => {
  const said = await call('add_drum_groove', { pattern: 'Verse', style: 'boomBap', variation: 0.5, fill: true, seed: 7 });
  assert.match(said, /^Boom bap groove, 4 bars, variation 0\.5, with a fill, seed 7, in "Verse" — hits: Kick \d+, Hat \d+, Snare \d+/);
  assert.match(said, /Created Hat \[ch_\w+\], Snare \[ch_\w+\]/);
  assert.match(said, /Swing 0\.3 is written into the notes/);
  let p = await project();
  assert.deepEqual([chan(p, 'Hat').instrument.kind, chan(p, 'Snare').instrument.kind], ['hat', 'snare']);
  const groove = (q) => ['Kick', 'Hat', 'Snare'].map((c) => notesOf(q, c).map((n) => `${n.start}:${n.velocity}`).join(' ')).join(' | ');
  const first = groove(p);
  assert.ok(notesOf(p, 'Kick').some((n) => n.start === 0) && notesOf(p, 'Kick').some((n) => n.start === 172), 'a kick on the one; the off-beat sixteenth swung (168 → 172)');
  // the same call again: the same groove, on the same channels, and no new ones
  assert.doesNotMatch(await call('add_drum_groove', { pattern: 'Verse', style: 'boomBap', variation: 0.5, fill: true, seed: 7 }), /Created/);
  p = await project();
  assert.equal(groove(p), first);
  await call('add_drum_groove', { pattern: 'Verse', style: 'boomBap', variation: 0.5, fill: true, seed: 8 });
  assert.notEqual(groove(await project()), first);
  // bars 3–4 only; the rest stays
  const before34 = notesOf(await project(), 'Kick').filter((n) => n.start < 768).map((n) => n.start);
  await call('add_drum_groove', { pattern: 'Verse', style: 'fourOnFloor', startBar: 3, bars: 2 });
  p = await project();
  assert.deepEqual(notesOf(p, 'Kick').filter((n) => n.start < 768).map((n) => n.start), before34);
  assert.deepEqual(notesOf(p, 'Kick').filter((n) => n.start >= 768).map((n) => n.start), [768, 864, 960, 1056, 1152, 1248, 1344, 1440]);
  // without making channels: what has no channel is left out, and said
  const channels = p.channels.length;
  assert.match(await call('add_drum_groove', { pattern: 'Verse', style: 'synthwave', createMissing: false, bars: 2 }), /hits: Kick 8, Hat 32, Snare 4/);
  assert.equal((await project()).channels.length, channels);

  assert.match(await call('write_drums', { pattern: 'Verse', tracks: { Kick: 'E(5,16)x2', Hat: 'E(7,16,2)' } }), /Kick: 10 hits, Hat: 7 hits/);
  p = await project();
  assert.deepEqual(notesOf(p, 'Kick').map((n) => n.start / 24), [0, 3, 6, 9, 12, 16, 19, 22, 25, 28]);
  assert.equal(notesOf(p, 'Kick')[0].velocity, 1, 'the first hit of a Euclidean rhythm is accented');
  assert.match(await call('music_theory', { action: 'euclid', steps: 8, pulses: 3 }), /E\(3,8\) = x--x--x-/);
  await unchanged(async () => {
    await fails(call('write_drums', { pattern: 'Verse', tracks: { Kick: 'E(9,8)' } }), /9 hits do not fit in 8 steps/);
    await fails(call('add_drum_groove', { pattern: 'Verse', style: 'trapp' }), /style is "trapp": it must be one of[^\n]*Did you mean "trap"\?/);
    await fails(call('add_drum_groove', { pattern: 'Verse', style: 'trap', startBar: 9 }), /startBar 9 is past the end of "Verse"/);
    await fails(call('music_theory', { action: 'euclid', steps: 8, pulses: 9 }), /there cannot be more hits than steps/);
  });
  // the styles are written in 4/4
  await call('create_project', { name: 'Seven', template: 'empty', timeSignature: '7/8' });
  await call('create_pattern', { name: 'P', bars: 1 });
  await fails(call('add_drum_groove', { pattern: 'P', style: 'house' }), /written in 4\/4 and this project is in 7\/8: write the steps yourself with write_drums[^\n]*E\(5,14\)/);
  await call('open_project', { projectId: pid });
});

test('tuning: set as a patch, described with exact ratios, judged on a chord — and undone', async () => {
  const table = await call('describe_tuning', { chord: 'i', compare: ['just', 'pythagorean', 'meantone'] });
  assert.match(table, /^Equal temperament \(the standard\) — the tuning of this project/);
  assert.match(table, /i \(A4 C5 E5\) in this tuning: fastest beat 23\.7 per second — A4–C5 6\/5 -15\.6 c, A4–E5 3\/2 -2\.0 c, C5–E5 5\/4 \+13\.7 c/);
  assert.match(table, /in Just intonation \(5-limit\) on A: exactly 10:12:15, beatless/);
  assert.match(table, /in Pythagorean on A: exactly 54:64:81/);
  assert.match(table, /in Quarter-comma meantone on A: fastest beat \d+\.\d per second/);

  await unchanged(async () => {
    assert.match(await call('set_tuning', { system: 'just', dryRun: true }), /DRY RUN[\s\S]*Tuning: Just intonation \(5-limit\) on A\.[\s\S]*It would change:\n {2}Project: tuning Equal temperament → Just intonation \(5-limit\) on A/);
    await fails(call('set_tuning', { a4: 600 }), /a4 is 600: the maximum is 500/);
    await fails(call('set_tuning', {}), /Nothing to set/);
    await fails(call('set_tuning', { system: 'pure' }), /system is "pure": it must be one of "equal", "just"/);
    await fails(call('set_tuning', { system: 'custom' }), /A custom tuning needs `cents`[^\n]*or `ratios`/);
    await fails(call('set_tuning', { system: 'custom', cents: [0, 100] }), /cents/);
    await fails(call('set_tuning', { root: 'H' }), /Invalid tuning root "H"/);
  });
  // a system chosen without a root is built on the song's key
  const set = await call('set_tuning', { system: 'just' });
  assert.match(set, /^Tuning: Just intonation \(5-limit\) on A\.\n/);
  assert.match(set, /\n {2}C#\s+5\/4\s+386\.3 c\s+-13\.7 c\s+275\.000 Hz\n/);
  assert.match(set, /drum channels? (is|are) not retuned/);
  assert.deepEqual((await project()).tuning, { system: 'just', root: 'A', a4: 440 });
  // only what is named changes
  assert.match(await call('set_tuning', { a4: 432 }), /Just intonation \(5-limit\) on A, A4 = 432 Hz/);
  assert.deepEqual((await project()).tuning, { system: 'just', root: 'A', a4: 432 });
  assert.match(await call('get_project', {}), /key A minor, tuning Just intonation \(5-limit\) on A, A4 = 432 Hz/);
  assert.match(await call('describe_tuning', {}), /^Just intonation \(5-limit\) on A, A4 = 432 Hz — the tuning of this project/);
  // a chord given note by note, in a tuning that is only looked at
  const seventh = await call('describe_tuning', { system: 'just7', root: 'A', a4: 440, notes: ['A3', 'C#4', 'E4', 'G4'] });
  assert.match(seventh, /These notes \(A3 C#4 E4 G4\) in this tuning: exactly 4:5:6:7, beatless/);
  assert.deepEqual((await project()).tuning, { system: 'just', root: 'A', a4: 432 }, 'looking changes nothing');
  assert.match(await call('describe_tuning', { system: 'equal', divisions: 19 }), /19 equal divisions of the octave on A[\s\S]* {2}step 18 /);
  // a table of your own; then back to the standard, in one undoable step each
  assert.match(await call('set_tuning', { system: 'custom', root: 'A', ratios: ['1/1', '16/15', '9/8', '6/5', '5/4', '4/3', '7/5', '3/2', '8/5', '5/3', '7/4', '15/8'] }), /Custom on A, A4 = 432 Hz[\s\S]* {2}G {8}7\/4 /);
  assert.match(await call('undo', {}), /tuning|Undid/i);
  assert.deepEqual((await project()).tuning, { system: 'just', root: 'A', a4: 432 });
  assert.match(await call('batch', { calls: [{ tool: 'set_tuning', args: { system: 'equal', a4: 440 } }, { tool: 'update_project', args: { scale: 'jazz minor' } }] }), /Applied 2 calls as ONE change/);
  const p = await project();
  assert.deepEqual([p.tuning.system, p.tuning.a4, p.scale], ['equal', 440, 'melodicMinor']);
});

test('music_theory: every scale and chord type listed, notes named, any scale name understood', async () => {
  const scales = await call('music_theory', { action: 'scales' });
  assert.match(scales, /^57 scales\./);
  assert.match(scales, /Harmonic minor family:\n {2}harmonicMinor \(aeolian nat7\): Minor with a leading tone/);
  assert.match(scales, /Indian thaats:\n {2}bhairav /);
  assert.match(await call('music_theory', { action: 'chord_types' }), /^65 chord types[\s\S]*altered: 7b5 \(7-5\) 0-4-6-10/);
  assert.match(await call('music_theory', { action: 'identify', notes: ['E3', 'G3', 'C4', 'Bb4'] }), /E3 G3 C4 Bb4 =\n1\. C7\/E {7}0\.91 {2}inversion 1/);
  assert.match(await call('music_theory', { action: 'identify', notes: [60] }), /one note is not a chord/);
  assert.match(await call('music_theory', { action: 'progression', progression: 'i-bVII-bVI-V7 IV/1 N6 V7/iv', key: 'A', scale: 'minor' }), /= Am – G – F – E7 – D\/A – Bb\/D – A7/);
  assert.match(await call('music_theory', { action: 'scale', scale: 'Phrygian Dominant', key: 'E' }), /E phrygian dominant: E4 F4 G#4 A4 B4 C5 D5 E5[\s\S]*flamenco/);
  assert.match(await call('music_theory', { action: 'chord', chord: 'V7/iv', key: 'A', scale: 'minor' }), /A7 \(V7\/iv in A minor\): A4 C#5 E5 G5/);
  assert.match(await call('music_theory', { action: 'chord', chord: 'C6/9' }), /C6\/9: C4 E4 G4 A4 D5/);
  await fails(call('music_theory', { action: 'scale', scale: 'lidian' }), /Unknown scale "lidian"\. Did you mean "lydian"\?/);
  await fails(call('music_theory', { action: 'progression', progression: 'i IX' }), /"IX" is not a roman numeral/);
  await fails(call('update_project', { scale: 'nonsense' }), /Unknown scale "nonsense"/);
});
