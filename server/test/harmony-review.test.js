// What the review of 0.12.0 found in the harmony and tuning tools, each as a test that failed before its fix.
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
  await call('create_project', { name: 'Review', template: 'empty', key: 'A', scale: 'minor', bpm: 100 });
  pid = (await user.get('/api/active')).body.projectId;
  await call('add_channel', { name: 'Keys', instrument: 'piano' });
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

test('music_theory progression: a dash separates before any numeral, lower-case v included', async () => {
  assert.match(await call('music_theory', { action: 'progression', progression: 'I-V-vi-IV', key: 'C', scale: 'major' }), /= C – G – Am – F/);
  assert.match(await call('music_theory', { action: 'progression', progression: 'I - V - vi - IV', key: 'C', scale: 'major' }), /= C – G – Am – F/);
  assert.match(await call('music_theory', { action: 'progression', progression: 'i-iv-v', key: 'A', scale: 'minor' }), /= Am – Dm – Em/);
  assert.match(await call('music_theory', { action: 'progression', progression: 'I-vi-IV-V', key: 'C', scale: 'major' }), /= C – Am – F – G/);
  await fails(call('music_theory', { action: 'progression', progression: 'I-vI', key: 'C', scale: 'major' }), /"vI" is not a roman numeral/);
});

test('a capital M is major: the chord is written as asked, or refused — never as its minor namesake', async () => {
  await call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: ['CM7(b5)'], replace: true });
  assert.deepEqual([...new Set(notesOf(await project(), 'Keys').map((n) => n.key % 12))].sort((a, b) => a - b), [0, 4, 6, 11], 'C E Gb B');
  const was = await project();
  for (const symbol of ['CM7b9', 'CM7#9', 'CM7sus4', 'CM9b5']) await fails(call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: [symbol], replace: true }), /Unknown chord quality/);
  assert.deepEqual(await project(), was);
});

test('negative harmony names every mirrored note, or says that the name is only the closest', async () => {
  const said = await call('harmony', { action: 'negative', chords: ['Cmaj7', 'C9', 'G7'], key: 'C', scale: 'major' });
  assert.match(said, /Cmaj7 +→ Abmaj7 +\(G Eb C Ab\)/);
  assert.match(said, /C9 +→ F9 /);
  assert.match(said, /G7 +→ Fm6 /);
  assert.doesNotMatch(said, /≈/);
  assert.match(await call('harmony', { action: 'negative', chords: ['C7b9'], key: 'C', scale: 'major' }), /C7b9 +→ ≈ \S+ +\(G Eb C A Gb\)[\s\S]*≈ = the closest chord name/);
});

test('analysis of a pattern: the relative key has the same notes, which is no reason to change the key', async () => {
  await call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Am', 'F', 'C', 'G'], replace: true });
  const said = await call('harmony', { action: 'analyze', pattern: 'Verse' });
  assert.match(said, /Key by the notes: /);
  assert.doesNotMatch(said, /set it with update_project/);
  assert.match(said, /(the project key A minor fits best|has the same notes as the project key A minor)/);
});

test('set_tuning: nothing is accepted and ignored, and a custom table keeps the root where it is', async () => {
  const ratios = ['1/1', '16/15', '9/8', '6/5', '5/4', '4/3', '7/5', '3/2', '8/5', '5/3', '7/4', '15/8'];
  const cents = [0, 90, 204, 294, 408, 498, 588, 702, 792, 906, 996, 1110];
  // a table says "custom" by itself
  assert.match(await call('set_tuning', { root: 'A', ratios }), /^Tuning: Custom on A/);
  assert.deepEqual((await project()).tuning.ratios, ratios);
  // cents sent to a tuning made of ratios replace them
  assert.match(await call('set_tuning', { cents }), /\n {2}Bb [^\n]* 90\.0 c/);
  const t = (await project()).tuning;
  assert.deepEqual([t.system, t.cents, t.ratios], ['custom', cents, undefined]);
  const was = await project();
  await fails(call('set_tuning', { cents, ratios }), /cents or ratios[^\n]*not both/);
  await fails(call('set_tuning', { cents: [25, ...cents.slice(1)] }), /must be 0 \(got 25\): a tuning never moves its own root/);
  await fails(call('set_tuning', { ratios: [1, 1.01, 1e6, ...ratios.slice(3)] }), /1000000 is outside/);
  await fails(call('set_tuning', { ratios: [2, ...ratios.slice(1)] }), /must be 1\/1/);
  await fails(call('set_tuning', { system: 'werckmeister', divisions: 19 }), /divisions only means something in system "equal"[^\n]*"werckmeister"/);
  await fails(call('set_tuning', { system: 'equal', fraction: 0.2 }), /fraction only means something in system "meantone"/);
  await fails(call('set_tuning', { system: 'just', cents }), /cents only means something in system "custom"/);
  await fails(call('set_tuning', { divisions: 19 }), /divisions only means something in system "equal", and the tuning of the project is "custom"/);
  await fails(call('describe_tuning', { system: 'just', fraction: 0.3 }), /fraction only means something in system "meantone"/);
  assert.deepEqual(await project(), was, 'a refused call changes nothing');
  await call('set_tuning', { system: 'equal', a4: 440 });
});

test('add_drum_groove leaves melodic channels alone, whatever they are called', async () => {
  for (const [name, instrument] of [['Kick Bass', 'ggs'], ['Snare Roll FX', 'ggs'], ['Top Hat Lead', 'piano']]) {
    await call('add_channel', { name, instrument });
    await call('add_notes', { pattern: 'Verse', channel: name, notes: [{ note: 'E4', start: 0, length: 4 }, { note: 'G4', start: 4, length: 4 }] });
  }
  const before = await project();
  const said = await call('add_drum_groove', { pattern: 'Verse', style: 'techno' });
  assert.match(said, /Created Kick \[ch_\w+\]/);
  const p = await project();
  for (const name of ['Kick Bass', 'Snare Roll FX', 'Top Hat Lead']) {
    assert.deepEqual(notesOf(p, name), notesOf(before, name), `${name} keeps its melody`);
    assert.doesNotMatch(said, new RegExp(`${name} \\d`));
  }
  assert.ok(notesOf(p, 'Kick').length >= 4);
});

test('a batch of heavy calls lets other requests through between its calls', async () => {
  const roots = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const kinds = ['maj7', 'm7', '7', 'm9', '13', 'maj9', '7b9', 'm11'];
  const chords = Array.from({ length: 64 }, (_, i) => roots[(i * 7) % 12] + kinds[(i * 3) % kinds.length]);
  const heavy = { tool: 'add_chords', args: { pattern: 'Long', channel: 'Keys', chords, stepsPerChord: 4, voices: 6, voicing: 'open', bass: 'smooth', replace: true } };
  await call('create_pattern', { name: 'Long', bars: 16 });
  // the server runs in this process: a timer here only fires when the server lets go of the thread
  let last = performance.now();
  let longest = 0;
  const probe = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 2);
  const start = performance.now();
  last = start;
  try {
    assert.match(await call('batch', { dryRun: true, calls: Array.from({ length: 8 }, () => heavy) }), /DRY RUN/);
  } finally {
    clearInterval(probe);
  }
  const whole = performance.now() - start;
  // (without the pause between calls the thread is held for the whole batch: the longest wait was all of it)
  assert.ok(longest < whole * 0.6, `longest wait ${longest.toFixed(0)} ms of a ${whole.toFixed(0)} ms batch`);
});
