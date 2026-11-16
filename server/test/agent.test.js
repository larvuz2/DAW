// The tools an agent leans on: errors that say how to fix the call, dry runs, batches, notes as text, the diff
// between versions, and renders that are compared with the one before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, audioFingerprint, nullTest, toPcm16 } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool, openSocket } from './helpers.js';
import { MORE_THAN_EDITS } from '../src/mcp/tools.js';

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
  await call('create_project', { name: 'Agent', template: 'empty', key: 'A', scale: 'minor', bpm: 120 });
  pid = (await user.get('/api/active')).body.projectId;
  for (const [name, instrument, preset] of [['Kick', 'kick'], ['Bass', 'bass808'], ['Lead', 'ggs', 'Touch Lead']]) await call('add_channel', { name, instrument, ...(preset ? { preset } : {}) });
  await call('create_pattern', { name: 'Verse', bars: 2 });
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const chan = (p, name) => p.channels.find((c) => c.name === name);
const pat = (p, name) => p.patterns.find((x) => x.name === name);
const notesOf = (p, channel, pattern = 'Verse') => pat(p, pattern).notes[chan(p, channel).id] || [];
const fails = (pr, re) => pr.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));
/** Run fn and assert that the project did not change at all. */
async function unchanged(fn) {
  const was = await project();
  const out = await fn();
  assert.deepEqual(await project(), was, 'the project is as it was');
  return out;
}

test('a wrong call is told how to be right — and changes nothing', async () => {
  await unchanged(async () => {
    // a mistyped argument is named (it used to be dropped silently), before the "required" it caused
    await fails(call('add_notes', { patern: 'Verse', channel: 'Lead', text: '1 C4 1/4' }), /Invalid arguments for add_notes:\n- unknown argument "patern"\. Did you mean "pattern"\? The arguments are: projectId, pattern, channel, text, notes, unit, replace, dryRun\n- pattern is required\nNothing was changed\./);
    // …also inside a list of objects
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', notes: [{ note: 'C4', start: 0 }, { note: 'D4', start: 4, lenght: 2 }] }), /unknown field "lenght" in notes\[1\]\. Did you mean "length"\? Its fields are: note, start, length, velocity, pan, releaseVelocity, expression/);
    // ranges: the value, the limit, the nearest valid value, and what the field means
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', notes: [{ note: 'C4', start: 0, velocity: 300 }] }), /notes\[0\]\.velocity is 300: the maximum is 127 — nearest valid value: 127 \(0\.\.1 \(1 = full\), or MIDI 2\.\.127\)/);
    await fails(call('set_mixer', { insert: 0, pan: -3 }), /pan is -3: the minimum is -1 — nearest valid value: -1/);
    await fails(call('add_roll', { pattern: 'Verse', channel: 'Kick', start: 0, length: 4, pitchRamp: 2.5 }), /pitchRamp must be a whole number, got 2\.5 — nearest: 3/);
    // choices: the list and the nearest
    await fails(call('render_mix', { mode: 'sng' }), /mode is "sng": it must be one of "song", "pattern"\. Did you mean "song"\?/);
    await fails(call('render_mix', { bitDepth: 20 }), /bitDepth is 20: it must be one of 16, 24\. Nearest: 16\./);
    // types
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', notes: 'C4' }), /notes must be a list, got a string \("C4"\)/);
    await fails(call('update_channel', { channel: 'Lead', mute: 'yes' }), /mute must be true or false, got a string \("yes"\)/);
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', notes: [] }), /notes has 0 items: at least 1 is needed/);
    // names: the nearest ones
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Led', text: '1 C4 1/4' }), /Channel "Led" not found\. Did you mean "Lead"\? Available: Kick/);
    await fails(call('add_notes', { pattern: 'Vers', channel: 'Lead', text: '1 C4 1/4' }), /Pattern "Vers" not found\. Did you mean "Verse"\?/);
    await fails(call('update_channel', { channel: 'Lead', params: { f1Cutof: 900 } }), /Unknown parameter "f1Cutof"\. Did you mean "f1Cutoff" or "f2Cutoff"\?/);
    await fails(call('update_channel', { channel: 'Lead', params: { f1Cutoff: 99999 } }), /must be between 20 and 20000 Hz \(got 99999; the nearest valid value is 20000\)/);
    await fails(call('add_channel', { name: 'Y', instrument: 'ggs', preset: 'Velvet Pd' }), /Unknown preset "Velvet Pd" for ggs\. Did you mean "Velvet Pad"\?/);
    await fails(call('add_effect', { insert: 1, type: 'revreb' }), /type is "revreb": it must be one of [^\n]*\. Did you mean "reverb"\?/);
    // a tool that does not exist
    const r = await client.callTool({ name: 'add_note', arguments: {} });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'Error: Tool "add_note" not found. Did you mean "add_notes"?');
    // many problems: the first eight, and how many more
    const many = await client.callTool({ name: 'add_notes', arguments: { pattern: 'Verse', channel: 'Lead', notes: Array.from({ length: 12 }, () => ({ note: 'C4', start: -1 })) } });
    assert.match(many.content[0].text, /(\n- notes\[\d+\]\.start is -1: the minimum is 0[^\n]*){8}\n- … and 4 more\nNothing was changed\.$/);
  });
  // no arguments at all is fine where none are needed
  assert.match(await call('get_studio_status'), /agent/);
});

test('every tool that edits the project offers dryRun, and only those', async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const name of MORE_THAN_EDITS) assert.ok(names.has(name), `${name} (listed as more than an edit) exists`);
  const offered = tools.filter((t) => t.inputSchema.properties?.dryRun).map((t) => t.name).sort();
  const expected = tools.filter((t) => !t.annotations?.readOnlyHint && !MORE_THAN_EDITS.has(t.name)).map((t) => t.name).sort();
  assert.deepEqual(offered, expected);
  assert.ok(offered.length >= 55 && offered.includes('batch') && offered.includes('add_notes') && offered.includes('set_synth_filter'), `${offered.length} tools`);
  for (const t of tools) if (t.inputSchema.properties?.dryRun) assert.match(t.inputSchema.properties.dryRun.description, /without changing anything/);
});

test('dryRun: the call is checked, the answer and the changes are shown, nothing is changed', async () => {
  const out = await unchanged(() => call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '1.1 D3+A3+F4 1/2 v0.7; 1.3 A4 1/8t; > C5 1/8t; > E5 1/8t; 3 A2 1bar', dryRun: true }));
  assert.match(out, /^DRY RUN — nothing was changed\. add_notes is valid; it would answer:\n {2}Added 7 notes to "Lead" in "Verse" \(D3 A3 F4 A4 C5 E5 A2\)\.\nIt would change:\n {2}~ Pattern "Verse": length 2 bars → 3 bars\n {4}Lead: \+7 notes\n {6}\+ 1 D3\+A3\+F4 1\/2 v0\.7\n {6}\+ 1\.3 A4 1\/8t\n {6}\+ > C5 1\/8t\n {6}\+ > E5 1\/8t\n {6}\+ 3 A2 1bar$/);
  // across the kinds of tools: sound, mixer, arrangement, synth, effects, spatial, production
  const tries = [
    ['update_channel', { channel: 'Lead', volume: 0.5, params: { f1Cutoff: 900 } }, /~ Channel "Lead": volume 78 % → 50 %; sound: f1Cutoff \d+ → 900 Hz/],
    ['set_mixer', { insert: 0, volumeDb: -3 }, /~ Master: volume 0 dB → -3 dB/],
    ['add_effect', { insert: 1, type: 'reverb' }, /effects \+ reverb \[fx_/],
    ['place_pattern', { pattern: 'Verse', startBar: 5 }, /\+ clip "Verse" at bar 5, 2bar, track 1/],
    ['set_synth_filter', { channel: 'Lead', type: 'ladder24', cutoff: 700 }, /sound: [^\n]*f1Type "\w+" → "ladder24"/],
    ['remove_channel', { channel: 'Bass' }, /− Channel "Bass" \(bass808\)/],
    ['write_drums', { pattern: 'Verse', tracks: { Kick: 'x---x---x---x---' } }, /Kick: \+4 notes/],
    ['update_project', { bpm: 98 }, /Project: tempo 120 → 98 BPM/],
    ['set_markers', { add: [{ name: 'Hook', bar: 9 }] }, /\+ Marker "Hook" at bar 9/]
  ];
  for (const [name, args, re] of tries) {
    const text = await unchanged(() => call(name, { ...args, dryRun: true }));
    assert.match(text, new RegExp(`^DRY RUN — nothing was changed\\. ${name} is valid; it would answer:`), name);
    assert.match(text, re, name);
  }
  // an invalid call is refused the same way with or without dryRun
  await unchanged(() => fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '1.5 C4 1/4', dryRun: true }), /a bar has 4 beats here/));
  // a call that would do nothing says so
  assert.match(await call('clear_notes', { pattern: 'Verse', dryRun: true }), /It would change:\n {2}nothing — the call makes no edit/);
  assert.match(await call('update_project', { bpm: 120, dryRun: true }), /It would change:\n {2}nothing — the project already is that way/);
  // dryRun: false is the normal call
  assert.match(await call('update_project', { swing: 10, dryRun: false }), /swing 10%/);
  assert.equal((await project()).swing, 0.1);
  await call('update_project', { swing: 0 });
  // tools that do more than edit the project cannot be tried — and say so before doing anything
  await unchanged(async () => {
    await fails(call('render_mix', { dryRun: true }), /render_mix does more than edit the project .* cannot be tried with dryRun/);
    await fails(call('save_version', { name: 'no', dryRun: true }), /save_version does more than edit the project/);
    await fails(call('get_project', { dryRun: true }), /get_project only reads: there is nothing to try/);
    assert.equal((await user.get(`/api/projects/${pid}/versions`)).body.length, 0);
  });
  assert.match(await call('get_project', { dryRun: false }), /PROJECT "Agent"/, 'dryRun: false on a tool without dry run is not an error');
});

test('a dry run and a real call at the same moment do not see each other', async () => {
  const before = (await project()).rev;
  const [dry, real, dry2] = await Promise.all([
    call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '1 C5 1/4; 1.2 D5 1/4', dryRun: true }),
    call('add_notes', { pattern: 'Verse', channel: 'Bass', text: '1 A1 1bar' }),
    call('write_drums', { pattern: 'Verse', tracks: { Kick: 'x-x-x-x-' }, dryRun: true })
  ]);
  assert.match(real, /^Added 1 notes to "Bass"/);
  assert.match(dry, /Lead: \+2 notes/);
  assert.doesNotMatch(dry, /Bass|Kick/, 'the dry run reports its own change only');
  assert.doesNotMatch(dry2, /Bass|Lead/);
  const p = await project();
  assert.equal(p.rev, before + 1, 'one real change');
  assert.deepEqual([notesOf(p, 'Lead').length, notesOf(p, 'Bass').length, notesOf(p, 'Kick').length], [0, 1, 0]);
  await call('undo');
});

test('batch: several calls are one change — one undo — and later calls see earlier ones', async () => {
  const was = await project();
  const out = await call('batch', { calls: [
    { tool: 'create_pattern', args: { name: 'Hook', bars: 2 } },
    { tool: 'add_notes', args: { pattern: 'Hook', channel: 'Lead', text: '1.1 A3+C4+E4 1/2; 1.3 G4 1/4; 2 F4 1bar' } },
    { tool: 'write_drums', args: { pattern: 'Hook', tracks: { Kick: 'x---x---x---x---' } } },
    { tool: 'place_pattern', args: { pattern: 'Hook', startBar: 1, repeat: 2 } },
    { tool: 'set_mixer', args: { insert: 0, volumeDb: -2 } },
    { tool: 'get_pattern', args: { pattern: 'Hook', channel: 'Lead', format: 'text' } }
  ] });
  assert.match(out, /^Applied 6 calls as ONE change \(undo reverts all of it\):\n1\. create_pattern: Created pattern "Hook" \[(pat_\w+)\]/);
  assert.match(out, /\n2\. add_notes: Added 5 notes to "Lead" in "Hook"/);
  assert.match(out, /\n4\. place_pattern: Placed "Hook" on track \d+ at bar 1/);
  // a read inside the batch sees what the batch has done so far
  assert.match(out, /\n6\. get_pattern: Pattern "Hook" \[pat_\w+\] — 32 steps \(2 bars\)\n {3}\n {3}Lead \[ch_\w+\] — 5 notes\n {3}1 A3\+C4\+E4 1\/2 {2}# n_\w+,n_\w+,n_\w+\n {3}1\.3 G4 1\/4/);
  const p = await project();
  assert.equal(p.rev, was.rev + 1, 'one revision for the whole batch');
  // the ids the batch reported are the ids in the project
  const patId = /Created pattern "Hook" \[(pat_\w+)\]/.exec(out)[1];
  assert.equal(pat(p, 'Hook').id, patId);
  const noteIds = /1 A3\+C4\+E4 1\/2 {2}# (\S+)/.exec(out)[1].split(',');
  assert.deepEqual(notesOf(p, 'Lead', 'Hook').filter((n) => n.start === 0).map((n) => n.id).sort(), noteIds.sort());
  assert.equal(p.playlist.clips.length, 2);
  assert.ok(Math.abs(p.mixer[0].volume - Math.pow(10, -2 / 20)) < 1e-3);
  // one undo takes all of it back
  assert.match(await call('undo'), /^Undid: /);
  const back = await project();
  assert.deepEqual({ ...back, rev: 0, updatedAt: '' }, { ...was, rev: 0, updatedAt: '' });
});

test('batch: one failing call and nothing is changed; the answer says which call and why', async () => {
  const projects = (await user.get('/api/projects')).body.length;
  await unchanged(async () => {
    await fails(call('batch', { calls: [
      { tool: 'create_pattern', args: { name: 'Bridge', bars: 2 } },
      { tool: 'add_notes', args: { pattern: 'Bridge', channel: 'Lead', text: '1 C4 1/4' } },
      { tool: 'add_notes', args: { pattern: 'Bridge', channel: 'Led', text: '1 C4 1/4' } },
      { tool: 'place_pattern', args: { pattern: 'Bridge', startBar: 3 } }
    ] }), /Call 3 of 4 \(add_notes\) failed: Channel "Led" not found\. Did you mean "Lead"\?[^\n]*\nThe batch changed nothing \(calls 1–2 were fine but are not applied; call 4 was not tried\)\. Fix call 3 and send the batch again\./);
    // wrong arguments of a call: the same words as on its own
    await fails(call('batch', { calls: [{ tool: 'set_mixer', args: { insert: 0, pan: 5 } }] }), /Call 1 of 1 \(set_mixer\) failed: Invalid arguments for set_mixer:\n- pan is 5: the maximum is 1 — nearest valid value: 1\nThe batch changed nothing\. Fix call 1/);
    await fails(call('batch', { calls: [{ tool: 'set_mixer', args: { insert: 0, volumeDb: -1 } }, { tool: 'ad_notes', args: {} }] }), /Call 2 of 2 \(ad_notes\) failed: Tool "ad_notes" not found\. Did you mean "add_notes"\?\nThe batch changed nothing \(call 1 was fine but is not applied\)/);
    // what is more than an edit cannot be in a batch
    for (const [tool, args, why] of [['save_version', { name: 'x' }, 'saves a version'], ['undo', {}, 'changes the undo history'], ['render_mix', {}, 'needs the browser'], ['play', {}, 'controls playback'], ['create_project', { name: 'Other' }, 'creates a project'], ['delete_sample', { id: 'smp_x' }, '']]) {
      await fails(call('batch', { calls: [{ tool: 'set_mixer', args: { insert: 0, volumeDb: -1 } }, { tool, args }] }), new RegExp(`Call 2 of 2 \\(${tool}\\) failed: [^\\n]*${why}`), tool);
    }
    await fails(call('batch', { calls: [{ tool: 'batch', args: { calls: [] } }] }), /a batch cannot contain a batch/);
    await fails(call('batch', { calls: [{ tool: 'set_mixer', args: { insert: 0, volumeDb: -1, dryRun: true } }] }), /set dryRun on the batch itself/);
    await fails(call('batch', { calls: [] }), /calls has 0 items: at least 1 is needed/);
    await fails(call('batch', { calls: Array.from({ length: 101 }, () => ({ tool: 'get_project' })) }), /calls has 101 items: at most 100 are allowed/);
    await fails(call('batch', { calls: [{ tol: 'get_project' }] }), /unknown field "tol" in calls\[0\]\. Did you mean "tool"\?/);
    await fails(call('batch', { projectId: 'prj_nope', calls: [{ tool: 'get_project' }] }), /not found/);
    assert.equal((await user.get('/api/projects')).body.length, projects, 'no project was created');
  });
});

test('batch: dryRun tries all of it; reads alone apply nothing; a batch works on one project', async () => {
  const out = await unchanged(() => call('batch', { dryRun: true, calls: [
    { tool: 'create_pattern', args: { name: 'Outro', bars: 1 } },
    { tool: 'add_notes', args: { pattern: 'Outro', channel: 'Bass', text: '1 A1 1bar' } },
    { tool: 'add_effect', args: { insert: 2, type: 'delay' } }
  ] }));
  assert.match(out, /^DRY RUN — nothing was changed\. All 3 calls are valid; they would answer:\n1\. create_pattern: Created pattern "Outro"[^\n]*\n2\. add_notes: Added 1 notes to "Bass" in "Outro"[^\n]*\n3\. add_effect:[^\n]*\nTogether they would change:\n {2}\+ Pattern "Outro" \[pat_\w+\]: 1 bars, 1 note \(Bass 1\)\n {2}~ Insert 2[^\n]*: effects \+ delay/);
  assert.match(await unchanged(() => call('batch', { calls: [{ tool: 'get_project' }, { tool: 'list_instruments', args: { category: 'synth' } }] })), /^None of the 2 calls edits the project, so there was nothing to apply:\n1\. get_project: PROJECT "Agent"/);
  // another project inside the batch is refused
  const other = (await user.post('/api/projects', { name: 'Other' })).body;
  await unchanged(() => fails(call('batch', { calls: [{ tool: 'set_mixer', args: { insert: 0, volumeDb: -1 } }, { tool: 'set_mixer', args: { projectId: other.id, insert: 0, volumeDb: -6 } }] }), /Call 2 of 2 \(set_mixer\) failed: a batch edits one project/));
  assert.equal((await user.get(`/api/projects/${other.id}`)).body.mixer[0].volume, 1);
  // …but a batch can be aimed at a project that is not the open one
  assert.match(await call('batch', { projectId: other.id, calls: [{ tool: 'set_mixer', args: { insert: 0, volumeDb: -6 } }, { tool: 'update_project', args: { bpm: 90 } }] }), /^Applied 2 calls as ONE change/);
  const o = (await user.get(`/api/projects/${other.id}`)).body;
  assert.deepEqual([o.bpm, Math.round(o.mixer[0].volume * 1000)], [90, 501]);
  assert.equal((await project()).bpm, 120, 'the open project is untouched');
  await user.del(`/api/projects/${other.id}`);
});

test('notes as text: written, read back, edited with musical positions', async () => {
  assert.match(await call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '1.1 D3+A3+F4 1/2 v0.7\n1.3 A4 1/8t\n> C5 1/8t\n> E5 1/8t r0.9\n2 A2 1bar p-0.5', replace: true }), /Wrote 7 notes to "Lead" in "Verse"/);
  let p = await project();
  assert.deepEqual(notesOf(p, 'Lead').map((n) => [n.key, n.start, n.length]).sort((a, b) => a[1] - b[1] || a[0] - b[0]), [[50, 0, 192], [57, 0, 192], [65, 0, 192], [69, 192, 32], [72, 224, 32], [76, 256, 32], [45, 384, 384]]);
  assert.equal(notesOf(p, 'Lead').find((n) => n.key === 76).releaseVelocity, 0.9);
  assert.equal(notesOf(p, 'Lead').find((n) => n.key === 45).pan, -0.5);
  // read as text: a third of the table, and add_notes takes it back as it is
  const table = await call('get_pattern', { pattern: 'Verse', channel: 'Lead' });
  const text = await call('get_pattern', { pattern: 'Verse', channel: 'Lead', format: 'text' });
  assert.match(text, /^Pattern "Verse" \[pat_\w+\] — 32 steps \(2 bars\)\n\nLead \[ch_\w+\] — 7 notes\n1 D3\+A3\+F4 1\/2 v0\.7 {2}# n_\w+,n_\w+,n_\w+\n1\.3 A4 1\/8t {2}# n_\w+\n> C5 1\/8t {2}# n_\w+\n> E5 1\/8t r0\.9 {2}# n_\w+\n2 A2 1bar p-0\.5 {2}# n_\w+$/);
  assert.ok(text.length < table.length * 0.6, `${text.length} vs ${table.length} characters`);
  const body = text.split('\n').slice(3).join('\n');
  await call('add_notes', { pattern: 'Verse', channel: 'Bass', text: body, replace: true });
  p = await project();
  const sig = (list) => list.map((n) => `${n.key}|${n.start}|${n.length}|${n.velocity}|${n.pan || 0}|${n.releaseVelocity ?? ''}`).sort();
  assert.deepEqual(sig(notesOf(p, 'Bass')), sig(notesOf(p, 'Lead')));
  // objects still work, and take the same positions and durations as text
  await call('add_notes', { pattern: 'Verse', channel: 'Kick', replace: true, notes: [{ note: 'C2', start: '2.3', length: '1/8' }, { note: 'C2', start: 4, length: 2 }, { note: 'C2', start: '6s', length: '1.5b' }, { note: 'C2', start: 1, length: 1, unit: undefined }] });
  p = await project();
  assert.deepEqual(notesOf(p, 'Kick').map((n) => [n.start, n.length]).sort((a, b) => a[0] - b[0]), [[24, 24], [96, 48], [144, 144], [576, 48]]);
  const first = notesOf(p, 'Kick').find((n) => n.start === 24);
  await call('update_notes', { pattern: 'Verse', channel: 'Kick', notes: [{ id: first.id, start: '1.4.3', length: '1/16t' }] });
  assert.deepEqual((({ start, length }) => [start, length])(notesOf(await project(), 'Kick').find((n) => n.id === first.id)), [336, 16]);
  assert.match(await call('add_roll', { pattern: 'Verse', channel: 'Kick', start: '2.4', length: '1/4', rate: '1/32' }), /Added a 8-hit 1\/32 roll to "Kick" at step 28 in "Verse"/);
  assert.match(await call('write_melody', { pattern: 'Verse', channel: 'Kick', melody: 'C2:1/8 D2:1/8t E2:1/8t F2:1/8t G2:1/4d', gate: 1 }), /Wrote 5 notes/);
  assert.deepEqual(notesOf(await project(), 'Kick').filter((n) => n.key !== 36 || n.start === 0).map((n) => n.start).slice(0, 5), [0, 48, 80, 112, 144]);
  // text or objects — one of them; and text errors name the line
  await unchanged(async () => {
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead' }), /Give the notes either as `text`[^\n]*or as `notes`/);
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '1 C4 1/4', notes: [{ note: 'C4', start: 0 }] }), /one of the two/);
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '1 C4 1/4\n1.2 E4' }), /Line 2 \("1\.2 E4"\): a note line needs a start, a pitch and a duration/);
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', notes: [{ note: 'C4', start: '1.9' }] }), /"1\.9" is not a position: a bar has 4 beats here/);
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', notes: [{ note: 'C4', start: 0, length: '1/x' }] }), /"1\/x" is not a duration/);
    await fails(call('add_notes', { pattern: 'Verse', channel: 'Lead', text: '70 C4 1/4' }), /64 bars/);
  });
});

test('diff_versions: what changed since a version, between versions, and before a restore', async () => {
  await fails(call('diff_versions'), /No versions are saved for this project yet[^\n]*save_version makes one/);
  assert.match(await call('save_version', { name: 'Before the bridge' }), /Saved version/);
  assert.match(await call('diff_versions'), /^From version "Before the bridge" \[ver_\w+\] \([^)]+\) to the project as it is now:\nNo difference/);
  await call('batch', { calls: [
    { tool: 'update_project', args: { bpm: 126 } },
    { tool: 'update_channel', args: { channel: 'Lead', params: { f1Cutoff: 900 } } },
    { tool: 'add_notes', args: { pattern: 'Verse', channel: 'Lead', text: '2.3 B4 1/4' } },
    { tool: 'add_effect', args: { insert: 3, type: 'reverb' } }
  ] });
  const d = await call('diff_versions');
  assert.match(d, /to the project as it is now:\nChanged: project settings; 1 channel; 1 pattern; 1 note added; 1 mixer insert \(1 effect change\)\.\nProject: tempo 120 → 126 BPM\n~ Channel "Lead": sound: f1Cutoff \d+ → 900 Hz\n~ Pattern "Verse"\n {2}Lead: \+1 note\n {4}\+ 2\.3 B4 1\/4\n~ Insert 3[^\n]*: effects \+ reverb/);
  await call('save_version', { name: 'With the bridge' });
  // by name (any case) or id, in either direction; what a restore would bring back
  const back = await call('diff_versions', { from: 'with the bridge', to: 'Before the bridge' });
  assert.match(back, /^From version "With the bridge" \[ver_\w+\] \([^)]+\) to version "Before the bridge" \[ver_\w+\]/);
  assert.match(back, /tempo 126 → 120 BPM[\s\S]*− 2\.3 B4 1\/4[\s\S]*effects − reverb/);
  const id = /\[(ver_\w+)\]/.exec(back)[1];
  assert.match(await call('diff_versions', { from: id }), /No difference/);
  assert.match(await call('diff_versions', { maxLines: 5, from: 'Before the bridge' }), /… and \d+ more lines$/);
  await fails(call('diff_versions', { from: 'Before the brige' }), /Version "Before the brige" not found\. Did you mean "Before the bridge"\? Versions, newest first: With the bridge \[ver_/);
  // a version is its owner's: another account gets "not found", never the project
  const stranger = agent(srv.base);
  await user.post('/api/admin/users', { username: 'other', password: 'other-pass-1' });
  await stranger.post('/api/auth/login', { username: 'other', password: 'other-pass-1' });
  assert.equal((await stranger.get(`/api/projects/${pid}/versions/${id}`)).status, 404);
  const mine = await user.get(`/api/projects/${pid}/versions/${id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.project.bpm, 126);
  assert.equal((await user.get(`/api/projects/${pid}/versions/..%2F..%2Fusers`)).status >= 400, true);
});

test('render_mix: every render has an id, and is compared with the one before', async () => {
  let level = 0.25;
  let masking = null;
  let jobs = 0;
  let jitter = 0; // the last bit of a browser's mixer: not the same from run to run
  const kept = new Map(); // what the tab remembers: the last render of each thing
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  sock.ws.on('message', async (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type !== 'job') return;
    jobs++;
    const sr = 22050;
    jitter++;
    const L = Float32Array.from({ length: sr * 4 }, (_, i) => level * Math.sin((2 * Math.PI * 55 * i) / sr) + ((i + jitter) % 5 === 0 ? 6e-8 : 0));
    const mix = analyzeAudio({ channels: [L, L], sampleRate: sr }, { segmentSeconds: 1, segmentLabel: '4 bars' });
    const hash = audioFingerprint([L, L]);
    const key = `${msg.job.projectId}|${msg.job.mode}|${msg.job.patternId}|${msg.job.loops}`;
    const earlier = kept.get(key);
    const nulled = earlier ? { against: earlier.hash, ...nullTest(earlier.pcm, [L, L], sr) } : null;
    kept.set(key, { hash, pcm: [toPcm16(L), toPcm16(L)] });
    const stems = [{ name: 'Kick', lufs: -14, peakDb: -6, centroidHz: 70, bandsPercent: { sub: 70, low: 25 } }, { name: 'Bass', lufs: level > 0.3 ? -8 : -12, peakDb: -5, centroidHz: 60, bandsPercent: { sub: 80, low: 15 } }];
    const fd = new FormData();
    fd.append('result', JSON.stringify({ mix, stems, limiter: { avgDb: -1, maxDb: -2, activePercent: 20 }, hash, nullTest: nulled, masking: msg.job.masking ? masking : null, mode: msg.job.mode }));
    await fetch(`${srv.base}/api/jobs/${msg.jobId}/result`, { method: 'POST', headers: { cookie: user.cookie }, body: fd });
  });
  try {
    const first = await call('render_mix', { mode: 'pattern', pattern: 'Verse' });
    assert.match(first, /^MIX ANALYSIS — "Agent" \(pattern, 4s\) · render r1\n/);
    assert.doesNotMatch(first, /fingerprint/, 'a fingerprint a browser cannot keep from run to run is not shown');
    assert.match(first, /No earlier render of this pattern to compare with: render again after a change and this report says what the change did \(this one is r1\)\./);
    // nothing changed — though not one sample is the same to the bit: the null test says so
    const second = await call('render_mix', { mode: 'pattern', pattern: 'Verse' });
    assert.match(second, /· render r2\n/);
    assert.match(second, /Compared with render r1 \(\d+ s ago, the same project revision\) — this render is:\n- The same audio: subtracting the earlier render leaves (nothing at 16 bits|-\d+(\.\d)? dB relative to the mix) — the last bit of a browser's mixer[^\n]*Whatever changed in between is not heard in this render\.(\n|$)/);
    // a change that is heard: by how much, and which stem moved
    await call('set_mixer', { insert: 0, volumeDb: -1 });
    level = 0.5;
    masking = { frames: 16, stems: [], overlaps: [{ a: 'Kick', b: 'Bass', lowHz: 20, highHz: 100, shareOfTime: 0.82, overlapDb: -19.5, yield: 'Bass', yieldShare: 0.4, keepShare: 0.9, suggestion: 'duck "Bass" under "Kick" (a pump effect on "Bass" with source "Kick"), or high-pass / cut "Bass" below 100 Hz' }] };
    const third = await call('render_mix', { mode: 'pattern', pattern: 'Verse' });
    assert.match(third, /Compared with render r2 \(\d+ s ago, project revision \d+ → \d+\) — this render is:\n- 6(\.\d)? LU louder \(-?[\d.]+ → -?[\d.]+ LUFS\)\n- peaks 6(\.\d)? dB higher[^\n]*\n- stems: "Bass" \+4 LU\n- null test: a clear change — what is left after subtracting the earlier render is at -6(\.\d)? dB relative to the mix[^\n]*, most of it around 0:0\d/);
    assert.match(third, /\nMasking — stems that are strong in the same band at the same moment \(worst first\):\n {2}"Kick" × "Bass" {2}20 Hz–100 Hz {2}82% of the time, contested energy -19\.5 dB — that range is 40% of "Bass" and 90% of the other: duck "Bass" under "Kick"/);
    const data = JSON.parse((await client.callTool({ name: 'render_mix', arguments: { mode: 'pattern', pattern: 'Verse', compareTo: 'r1' } })).content[1].text);
    assert.deepEqual([data.render.id, data.comparison.against, data.comparison.identical, data.comparison.same], ['r4', 'r1', false, false]);
    // (r4 was subtracted from r3 in the tab, not from r1: against r1 there are the meters only)
    assert.ok(Math.abs(data.comparison.deltas.lufs - 6) < 0.2 && data.masking.overlaps.length === 1 && data.comparison.nullTest === null);
    assert.equal(data.render.fingerprint, undefined);
    // "none": no comparison; stems off: no masking asked of the browser
    const alone = await call('render_mix', { mode: 'pattern', pattern: 'Verse', compareTo: 'none', stems: false });
    assert.doesNotMatch(alone, /Compared with|No earlier render|Masking/);
    // a render of something else is not what "previous" means
    const other = await call('render_mix', { mode: 'pattern', pattern: 'Verse', loops: 4 });
    assert.match(other, /No earlier render of this pattern to compare with/);
    // an unknown render is refused before anything is rendered
    const before = jobs;
    await fails(call('render_mix', { compareTo: 'r99' }), /Render "r99" is not known\. Renders of this project: r1 \(pattern, \d+ s ago\), r2 [^\n]* — or use "previous" or "none"\./);
    await fails(call('render_mix', { compareTo: 'r' }), /Render "r" is not known\./);
    assert.equal(jobs, before, 'no render was started');
    // the log is the project's and the account's: a new project starts at r1
    await call('create_project', { name: 'Fresh', template: 'empty' });
    await call('add_channel', { name: 'Kick', instrument: 'kick' });
    assert.match(await call('render_mix', {}), /· render r1\n/);
    await call('open_project', { projectId: pid });
  } finally {
    sock.ws.close();
  }
});
