// The chord grid through the tools: the palette of a key, what could follow, one chord explained, and a progression
// written with its voicing, voice leading, tensions, strum and humanize.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  await call('create_project', { name: 'Grid', template: 'empty', key: 'C', scale: 'major', bpm: 120 });
  pid = (await user.get('/api/active')).body.projectId;
  await call('add_channel', { name: 'Keys', instrument: 'piano' });
  await call('create_pattern', { name: 'Verse', bars: 4 });
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const notesOf = (p, channel = 'Keys', pattern = 'Verse') => p.patterns.find((x) => x.name === pattern).notes[p.channels.find((c) => c.name === channel).id] || [];
const fails = (pr, re) => pr.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));
async function unchanged(fn) {
  const was = await project();
  await fn();
  assert.deepEqual(await project(), was, 'the project is as it was');
}
const pcs = (notes) => [...new Set(notes.map((n) => n.key % 12))].sort((a, b) => a - b);
const at = (notes, tick) => notes.filter((n) => n.start <= tick && n.start + n.length > tick);

test('the tools are there: chord_grid reads, add_grid_chords edits and has a dry run', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 104);
  const read = tools.find((t) => t.name === 'chord_grid');
  const write = tools.find((t) => t.name === 'add_grid_chords');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.ok(!read.inputSchema.properties.dryRun);
  assert.ok(write.inputSchema.properties.dryRun);
  assert.match(write.description, /rootless/);
});

test('chord_grid: the palette of the project key, page by page', async () => {
  const text = await call('chord_grid', {});
  assert.match(text, /^Chord grid of C major \(engine: Tuple 1\.\d+\.\d+\)/);
  assert.match(text, /I\s+Tonic\s+C {2}CM7 {2}CM9 {2}Csus4 {2}Csus2 {2}Cadd9 {2}C6 {2}C6\/9/);
  assert.match(text, /vii°\s+Leading tone\s+Bdim {2}Bø7/);
  assert.match(text, /Borrowed \(modal interchange, secondary dominants\): Eb bIII · Fm iv · Ab bVI · Bb bVII · D7 V\/V · A7 V\/ii · E7 V\/vi/);
  assert.match(text, /Chromatic mediants: E III · A VI/);
  assert.match(text, /Tritone substitutes .*Db7 → C · Eb7 → Dm · F7 → Em · Gb7 → F · Ab7 → G · Bb7 → Am/);
  assert.match(text, /IV\s+FM9#11 {2}FM13/);
  assert.doesNotMatch(text, /^After /m);
  // another key without a project's: flats where the key has them, and a scale the grid does not have says so
  const eb = await call('chord_grid', { key: 'Eb', scale: 'dorian' });
  assert.match(eb, /Chord grid of Eb dorian/);
  assert.match(eb, /i\s+Tonic\s+Ebm {2}Ebm7/);
  const blues = await call('chord_grid', { key: 'A', scale: 'blues' });
  assert.match(blues, /The grid has no chords for .*[Bb]lues.*: this is minor, the closest scale it knows/);
  await fails(call('chord_grid', { key: 'H' }), /not a key/);
});

test('chord_grid after chords: where the progression could go, strongest first', async () => {
  const text = await call('chord_grid', { after: ['Dm9', 'G7'] });
  const lines = text.slice(text.indexOf('After Dm9 – G7, strongest first:')).split('\n').slice(1).filter((l) => /^ {2}[●○]{3}/.test(l));
  assert.ok(lines.length >= 4, text);
  assert.match(lines[0], /^ {2}●●● /);
  assert.ok(lines.some((l) => /●●● C\S*\s+I\s+comes to rest/.test(l)), `V goes home: ${lines.join(' | ')}`);
  assert.deepEqual(lines.map((l) => l.indexOf('○')).map((i) => (i < 0 ? 9 : i)), lines.map((l) => l.indexOf('○')).map((i) => (i < 0 ? 9 : i)).slice().sort((a, b) => b - a), 'sorted by strength');
  const smooth = await call('chord_grid', { after: ['Cmaj7'], smart: 'voiceleading' });
  assert.match(smooth, /After CM7, smoothest first:/);
  await fails(call('chord_grid', { after: ['Dm9', 'C5'] }), /"C5" is not a chord the grid can spell in C major\..*Did you mean.*add_chords/s);
});

test('chord_grid chord: one chord explained — voicings, tensions and why some are avoided, substitutes, what follows', async () => {
  const text = await call('chord_grid', { chord: 'G7' });
  assert.match(text, /^G7 in C major: V, in the key\./);
  assert.match(text, /rootless\s+F\d A\d B\d D\d\s+Rootless/, 'no G; the ninth in its place');
  assert.match(text, /classic\s+G\d B\d D\d F\d\s+Closed/);
  assert.match(text, /Tensions it takes: b9 \(outside the scale\), 9, #9 \(outside the scale\), #11 \(outside the scale\), b13 \(outside the scale\), 13\./);
  assert.match(text, /Avoided: 11 \(on a dominant the 11th makes it a 7sus4/);
  assert.match(text, /Instead of it: Bø7 \(vii°\).*Db7 \(subV7\)/);
  assert.match(text, /After it: /);
  assert.match(await call('chord_grid', { chord: 'Db7' }), /^Db7 in C major: tritone substitute \(subV7\)/);
  assert.match(await call('chord_grid', { chord: 'FM13' }), /an extension of IV/);
  assert.match(await call('chord_grid', { chord: 'Cm7' }), /^Cm7 in C major: i, from outside the grid/);
});

test('add_grid_chords: a ii–V–I with colour, voiced and led by the grid', async () => {
  const text = await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Dm9', { chord: 'G7', tensions: ['b9', '13'] }, { chord: 'Cmaj9', bars: 2 }] });
  assert.match(text, /^Wrote Dm9 – G13b9 – CM9 \(ii – V – I\) to "Keys" in "Verse", bars 1–4: \d+ notes, closed voicing, voice leading follow\./);
  assert.match(text, /bar 3 \(2 bars\): CM9/);
  const notes = notesOf(await project());
  assert.deepEqual(pcs(at(notes, 10)), [0, 2, 4, 5, 9], 'Dm9: D F A C E');
  assert.deepEqual(pcs(at(notes, 384 + 10)), [2, 4, 5, 7, 8, 11], 'G13b9: G B D F + Ab + E');
  assert.deepEqual(pcs(at(notes, 768 + 10)), [0, 2, 4, 7, 11], 'CM9: C E G B D');
  assert.ok(notes.every((n) => n.start % 384 === 0 && n.velocity > 0.78 && n.velocity < 0.8), 'together, at the default velocity');
  assert.deepEqual([...new Set(notes.filter((n) => n.start === 768).map((n) => n.length))], [768], 'the last chord lasts its two bars');
});

test('add_grid_chords: voice leading "follow" moves the hands less than "off"', async () => {
  const travel = async (leading) => {
    await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['CM7', 'Am7', 'Dm7', 'G7'], leading });
    const notes = notesOf(await project());
    const chords = [0, 384, 768, 1152].map((t) => notes.filter((n) => n.start === t).map((n) => n.key).sort((x, y) => x - y));
    return chords.slice(1).reduce((sum, c, i) => sum + c.reduce((s2, k, j) => s2 + Math.abs(k - chords[i][j]), 0), 0);
  };
  const [follow, off] = [await travel('follow'), await travel('off')];
  assert.ok(follow < off, `follow ${follow} semitones, off ${off}`);
});

test('add_grid_chords: rootless over a bass, strummed and humanized — and the same call writes the same notes', async () => {
  const args = { pattern: 'Verse', channel: 'Keys', chords: ['Dm9', 'Db7', 'CM9', { chord: 'A7', bars: 0.5 }, { chord: 'A7', bars: 0.5, tensions: ['b13'] }], voicing: 'rootless', strum: 30, humanize: 20, velocity: 0.6 };
  const text = await call('add_grid_chords', args);
  assert.match(text, /Wrote Dm9 – Db7 – CM9 – A7 – A7b13 \(ii – subV7 – I – V\/ii – V\/ii\)/);
  assert.match(text, /rootless voicing, voice leading follow, strummed 30 ms upward, humanized 20%/);
  const first = notesOf(await project());
  assert.ok(!at(first, 60).some((n) => n.key % 12 === 2), 'Dm9 without its root');
  assert.ok(first.some((n) => n.start % 96 !== 0), 'the strum moves starts off the grid');
  assert.ok(first.every((n) => n.start + n.length <= 1536), 'nothing runs past the bars written');
  for (const bar of [384, 768, 1152, 1344, 1536]) assert.ok(!first.some((n) => n.start < bar && n.start + n.length > bar), `no note crosses ${bar}`);
  const vel = first.map((n) => n.velocity);
  assert.ok(Math.min(...vel) < Math.max(...vel) && Math.max(...vel) < 0.8, 'humanized around 0.6');
  await call('add_grid_chords', args);
  assert.deepEqual(notesOf(await project()).map(({ id: _id, ...n }) => n), first.map(({ id: _id, ...n }) => n));
});

test('add_grid_chords: where it writes — a later bar, a rest, added instead of replaced, the pattern growing', async () => {
  await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['C', '-', 'F'], barsPerChord: 0.5 });
  let notes = notesOf(await project());
  assert.deepEqual([...new Set(notes.filter((n) => n.start < 576).map((n) => n.start))].sort((a, b) => a - b), [0, 384], 'two chords and a silence between');
  assert.ok(notes.some((n) => n.start >= 576), 'the bars after the part are kept');
  const before = notes.length;
  await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Am7'], startBar: 1, replace: false });
  notes = notesOf(await project());
  assert.equal(notes.length, before + 4);
  const text = await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['FM7', 'G7'], startBar: 5 });
  assert.match(text, /bars 5–6/);
  const p = await project();
  assert.equal(p.patterns.find((x) => x.name === 'Verse').length, 6 * 384, 'the pattern grew to hold bar 6');
  assert.ok(notesOf(p).some((n) => n.start === 4 * 384));
  // a bar of 3/4 is three beats
  await call('create_project', { name: 'Waltz', template: 'empty', key: 'A', scale: 'minor', bpm: 90, timeSignature: '3/4' });
  const waltz = (await user.get('/api/active')).body.projectId;
  await call('add_channel', { name: 'Keys', instrument: 'piano' });
  await call('create_pattern', { name: 'A', bars: 2 });
  await call('add_grid_chords', { pattern: 'A', channel: 'Keys', chords: ['Am9', 'E7'] });
  const w = (await user.get(`/api/projects/${waltz}`)).body;
  assert.deepEqual([...new Set(notesOf(w, 'Keys', 'A').map((n) => `${n.start}+${n.length}`))], ['0+288', '288+288']);
  await call('open_project', { projectId: pid });
});

test('add_grid_chords: what it refuses changes nothing and says what to do', async () => {
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Dm9', 'C5'] }), /"C5" is not a chord the grid can spell in C major/));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: [{ chord: 'G7', tensions: ['11'] }] }), /Chord 1: G7 does not take the tension 11 — the grid avoids it: on a dominant the 11th makes it a 7sus4.*avoidNotes: false/s));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['C'], barsPerChord: 0.3 }), /eighths of a bar/));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: [{ chord: 'G7', tensions: ['b9'] }], voicing: 'rootless' }), /G7 with the tension b9 in the rootless voicing would sound its natural 9th and the b9 together.*voicing: "drop2"/s));
  assert.match(await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: [{ chord: 'G7', tensions: ['b9'], voicing: 'drop2' }], voicing: 'rootless', dryRun: true }), /G7b9/);
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: Array(40).fill('C') }), /at most 32 bars/));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['-', '-'] }), /only rests/));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['C'], voicing: 'huge' }), /voicing/));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Nope', channel: 'Keys', chords: ['C'] }), /Nope/));
  await unchanged(() => fails(call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['C'], startBar: 64, barsPerChord: 2 }), /at most \d+ bars/));
  // with avoidNotes off the tension is written
  const text = await call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: [{ chord: 'G7', tensions: ['11'] }], avoidNotes: false, dryRun: true });
  assert.match(text, /DRY RUN/);
  assert.match(text, /G11|G7.*11/);
  await unchanged(() => call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Dm7', 'G7'], dryRun: true }));
});

test('found by the review: a thirteenth keeps its seventh, and the thirty-second bar is written where it belongs', async () => {
  await call('create_project', { name: 'Review', template: 'empty', key: 'A', scale: 'minor', bpm: 100 });
  const rid = (await user.get('/api/active')).body.projectId;
  await call('add_channel', { name: 'Keys', instrument: 'piano' });
  await call('create_pattern', { name: 'Long', bars: 32 });
  const read = async () => notesOf((await user.get(`/api/projects/${rid}`)).body, 'Keys', 'Long');
  // E13 in A minor is no page's chord: it is spelled — E G# B D F# C# — not an E6 that lost its seventh
  const text = await call('add_grid_chords', { pattern: 'Long', channel: 'Keys', chords: ['Dm9', 'E13', 'Am9'] });
  assert.match(text, /Wrote Dm9 – E13 – Am9 \(iv – V – i\)/);
  assert.deepEqual(pcs(at(await read(), 384 + 10)), [1, 2, 4, 6, 8, 11]);
  await call('add_grid_chords', { pattern: 'Long', channel: 'Keys', chords: ['Dm11', 'E11', 'CΔ'] });
  const notes = await read();
  assert.deepEqual(pcs(at(notes, 384 + 10)), [2, 4, 6, 8, 9, 11], 'E11: E G# B D F# A');
  assert.deepEqual(pcs(at(notes, 768 + 10)), [0, 4, 7, 11], 'CΔ is a major seventh');
  // thirty-two bars, the last one in two halves
  const long = await call('add_grid_chords', { pattern: 'Long', channel: 'Keys', chords: [...Array(15).fill('Am'), '-', ...Array(15).fill('F'), { chord: 'G7', bars: 0.5 }, { chord: 'C', bars: 0.5 }] });
  assert.match(long, /bars 1–32/);
  const all = await read();
  assert.deepEqual(pcs(all.filter((n) => n.start === 31 * 384)), [2, 5, 7, 11], 'G7 on bar 32');
  assert.deepEqual(pcs(all.filter((n) => n.start === 31 * 384 + 192)), [0, 4, 7], 'C on its second half');
  assert.equal(all.filter((n) => n.start >= 15 * 384 && n.start < 16 * 384).length, 0, 'the rest is a rest');
  const tail = await call('add_grid_chords', { pattern: 'Long', channel: 'Keys', chords: [{ chord: '-', bars: 16 }, { chord: '-', bars: 15.5 }, { chord: 'G7', bars: 0.5 }], replace: false, dryRun: true });
  assert.match(tail, /bar 32\.5 \(0\.5 bars\): G7/);
  await call('open_project', { projectId: pid });
});

test('add_grid_chords in a batch: one change, one undo', async () => {
  const was = notesOf(await project());
  await call('batch', { calls: [
    { tool: 'add_grid_chords', args: { pattern: 'Verse', channel: 'Keys', chords: ['FM9', 'Fm', 'CM7'], voicing: 'drop2' } },
    { tool: 'add_grid_chords', args: { pattern: 'Verse', channel: 'Keys', chords: ['Ab', 'Bb'], startBar: 4, barsPerChord: 0.5 } }
  ] });
  assert.notDeepEqual(notesOf(await project()), was);
  await call('undo', {});
  assert.deepEqual(notesOf(await project()), was);
});
