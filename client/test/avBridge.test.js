// The tab end of the audio → visual bridge (src/lib/avBridge.js) with a stand-in engine: notes go out in the frame of
// the moment they are heard, a stop drops what never sounded and ends what was sounding, a new play replaces the
// old one's notes, keys held by hand end with their key, the map comes again every 2 s, and switching off says so.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, createChannel, applyOps, PPQ, AV_FPS, avFrameToOsc } from '@greanteadawy/core';
import { MOD_SOURCES, MOD_TARGETS } from '@greanteadawy/synth-dsp';
import { AvBridge } from '../src/lib/avBridge.js';

function fakeEngine() {
  const ctx = {
    currentTime: 10, sampleRate: 48000, outputLatency: 0.02, baseLatency: 0.005,
    createAnalyser: () => ({ fftSize: 0, frequencyBinCount: 1024, smoothingTimeConstant: 0, getFloatTimeDomainData: (b) => b.fill(0.25), getFloatFrequencyData: (b) => b.fill(-60) })
  };
  const transport = {
    playing: false, mode: 'song', segments: [], t0: 0,
    beatAt(t) { return this.playing ? ((t - this.t0) * 120) / 60 : null; },
    play(at) { this.playing = true; this.t0 = at; this.segments = [{}]; },
    stop() { this.playing = false; }
  };
  return {
    ctx, transport, bpm: 120, noteTap: null, connected: 0, released: 0,
    out: { connect() { this.n = 1; }, disconnect() {} },
    getLevels: () => new Array(17).fill(0.5),
    channelPeak: () => 0.3,
    releaseChannelMeters() { this.released++; }
  };
}

/** Every phase 2/3 value a frame carries, as "address" strings. */
function phase2Values(f) {
  const out = [];
  for (const [ch, v] of Object.entries(f.param || {})) for (const k in v) out.push(`ch/${ch}/${k}`);
  for (const [n, v] of Object.entries(f.busParam || {})) for (const k in v) out.push(`bus/${n}/${k}`);
  for (const [n, fx] of Object.entries(f.fx || {})) for (const [e, v] of Object.entries(fx)) for (const k in v) out.push(`fx/${n}/${e}/${k}`);
  for (const [ch, g] of Object.entries(f.ggs || {})) {
    if (g.voices !== undefined) out.push(`ggs/${ch}/voices`);
    for (const k in g.src || {}) out.push(`ggs/${ch}/src/${k}`);
    for (const k in g.dst || {}) out.push(`ggs/${ch}/dst/${k}`);
  }
  for (const n in f.spatial || {}) out.push(`spatial/${n}`);
  return out;
}

function setup() {
  mock.timers.enable({ apis: ['setInterval'] });
  const engine = fakeEngine();
  const project = createDefaultProject();
  const sent = [];
  const state = { project, songStart: 0 };
  const bridge = new AvBridge({ engine, getState: () => state, send: (f) => sent.push(f) });
  bridge.start();
  const step = (dt = 1 / AV_FPS) => { engine.ctx.currentTime += dt; bridge.tick(); return sent.at(-1); };
  return { engine, project, sent, state, bridge, step };
}

test('a frame: transport, levels, spectrum, used buses, every channel by slug, lanes; the map and latency at once', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step, bridge } = setup();
  assert.equal(engine.noteTap, bridge);
  engine.transport.play(10);
  const f = step();
  assert.equal(f.playing, 1);
  assert.equal(f.ppq, PPQ);
  assert.ok(f.tick > 0 && f.tick < PPQ, `tick ${f.tick}`);
  assert.equal(f.master.peak, 0.25);
  assert.equal(f.master.bands.length, 6);
  assert.equal(f.master.spectrum.length, 32);
  assert.ok(f.map && f.map.channels.length === project.channels.length);
  assert.equal(typeof f.latency, 'number');
  assert.ok(Object.keys(f.buses).length < 17 && f.buses[0] === 0.5, 'the master and the inserts in use');
  assert.equal(Object.keys(f.ch).length, project.channels.length);
  assert.equal(f.user.length, 8);
  // the next frames: no map, no latency, until 2 s (1 s) have gone by
  const g = step();
  assert.ok(!g.map && g.latency === undefined);
  let mapAgain = 0;
  for (let i = 0; i < AV_FPS * 2; i++) if (step().map) mapAgain++;
  assert.equal(mapAgain, 1);
  // a renamed channel: the map at once
  const renamed = { ...project, channels: project.channels.map((c, i) => (i === 0 ? { ...c, name: 'Big Kick' } : c)) };
  bridge.getState = () => ({ project: renamed, songStart: 0 });
  const h = step();
  assert.ok(h.map.channels.some((c) => c.slug === 'big_kick'));
  assert.ok('big_kick' in h.ch);
});

test('notes: out when they are heard, not when scheduled; ends at their end', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step } = setup();
  const kick = project.channels[0];
  engine.transport.play(10);
  const now = engine.ctx.currentTime;
  // the transport schedules 120 ms ahead
  engine.noteTap.on(kick.id, 36, 0.9, now + 0.1, 0.05, {});
  let f = step();
  assert.equal(f.notes, undefined, 'not yet: it is heard in 100 ms');
  let note = null;
  let off = null;
  for (let i = 0; i < 12 && !(note && off); i++) {
    f = step();
    note ||= f.notes?.[0] ? { ...f.notes[0], when: engine.ctx.currentTime } : null;
    off ||= f.offs?.[0] ? { ...f.offs[0], when: engine.ctx.currentTime } : null;
  }
  assert.ok(note, 'the note went out');
  assert.equal(note.key, 36);
  assert.equal(note.ch, 'kick');
  assert.ok(Math.abs(note.when - (now + 0.1)) <= 0.5 / AV_FPS + 1e-9, `sent ${note.when - now} s after scheduling`);
  assert.ok(Math.abs(note.at - (now + 0.1)) < 1e-3, 'at = when it is heard, on the AudioContext clock');
  assert.ok(off && off.key === 36 && Math.abs(off.when - (now + 0.15)) <= 0.5 / AV_FPS + 1e-9);
});

test('a stop drops notes that never sounded and ends the ones sounding; a new play replaces the old notes', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step } = setup();
  const [a, b] = project.channels;
  engine.transport.play(10);
  step();
  const now = engine.ctx.currentTime;
  engine.noteTap.on(a.id, 40, 0.8, now + 0.005, 1, {}); // sounding for a second
  engine.noteTap.on(b.id, 50, 0.8, now + 0.11, 0.2, {}); // not heard yet
  const f1 = step();
  assert.equal(f1.notes.length, 1);
  engine.transport.stop();
  const f2 = step();
  assert.equal(f2.playing, 0);
  assert.equal(f2.notes, undefined, 'the note that never sounded is dropped');
  assert.deepEqual(f2.offs.map((o) => o.key), [40], 'the sounding one ends now');
  for (let i = 0; i < 90; i++) assert.equal(step().notes, undefined);

  // play again while notes of the last play are waiting: they are replaced
  engine.transport.play(engine.ctx.currentTime);
  const t0 = engine.ctx.currentTime;
  engine.noteTap.on(a.id, 41, 0.8, t0 + 0.1, 0.1, {});
  engine.transport.play(t0 + 0.01); // stop + play (a new session)
  engine.noteTap.on(a.id, 42, 0.8, t0 + 0.08, 0.1, {});
  const keys = [];
  for (let i = 0; i < 20; i++) for (const n of step().notes || []) keys.push(n.key);
  assert.deepEqual(keys, [42]);
});

test('keys held by hand end with their key; switching off frees the meters and says the music stopped', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step, sent, bridge } = setup();
  const voice = {};
  engine.noteTap.on(project.channels[0].id, 60, 0.7, engine.ctx.currentTime + 0.005, null, voice);
  const f = step();
  assert.deepEqual(f.notes.map((n) => [n.key, n.dur]), [[60, 0]], 'dur 0: held until its off');
  for (let i = 0; i < 10; i++) assert.equal(step().offs, undefined);
  engine.noteTap.off(voice, 0.9);
  assert.deepEqual(step().offs, [{ ch: 'kick', key: 60, rel: 0.9 }]);
  engine.noteTap.off(voice, 0.9);
  assert.equal(step().offs, undefined, 'once');
  bridge.stop();
  assert.equal(engine.noteTap, null);
  assert.equal(engine.released, 1);
  const last = sent.at(-1);
  assert.equal(last.final, true);
  assert.equal(last.playing, 0);
  assert.equal(bridge.running, false);
});

test('markers when the section changes; automation and lanes at the playhead while stopped', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, state, step } = setup();
  const bar = PPQ * 4;
  state.project = {
    ...state.project,
    markers: [{ id: 'm2', name: 'Drop', tick: bar }, { id: 'm1', name: 'Intro', tick: 0 }],
    automations: [{ id: 'au_1', name: 'Visual 2', target: { type: 'user', index: 2 }, length: bar, points: [{ t: 0, v: 0 }, { t: bar, v: 1 }] }],
    playlist: { ...state.project.playlist, clips: [...state.project.playlist.clips, { id: 'cl_v', kind: 'automation', refId: 'au_1', track: 5, start: 0, length: bar, offset: 0 }] }
  };
  state.songStart = bar / 2;
  let f = step();
  assert.equal(f.marker.name, 'Intro');
  assert.ok(Math.abs(f.user[1] - 0.5) < 0.01);
  assert.equal(step().marker, undefined, 'only when it changes');
  engine.transport.play(engine.ctx.currentTime);
  // half a second at 120 bpm = one beat; the drop is four beats in
  const names = [];
  for (let i = 0; i < AV_FPS * 2.2; i++) { f = step(); if (f.marker) names.push(f.marker.name); }
  assert.deepEqual(names, ['Drop'], 'playing from the start stays in the intro (already sent), then the drop');
  assert.ok(Math.abs(f.user[1] - 1) < 0.02, 'lane 2 holds the end of its clip');
});

test('a key struck again: its end goes out before the new note; a note shorter than a frame ends in the next one', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step } = setup();
  const hats = project.channels.find((c) => c.name === 'Hat') || project.channels[2];
  engine.transport.play(10);
  step();
  const now = engine.ctx.currentTime;
  engine.noteTap.on(hats.id, 42, 0.8, now + 0.05, 0.1, {});
  engine.noteTap.on(hats.id, 42, 0.8, now + 0.15, 0.004, {});
  const frames = [];
  for (let i = 0; i < 20; i++) { const f = step(); if (f.notes || f.offs) frames.push(f); }
  const events = frames.map((f) => avFrameToOsc(f).filter(([a]) => /\/(note|off)$/.test(a)).map(([a]) => a.split('/').pop()));
  assert.deepEqual(events, [['note'], ['off', 'note'], ['off']], JSON.stringify(events));
});

test('a note cut short (choke, mono) ends when it is cut; switching off ends exactly the notes the visuals heard', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step, sent, bridge } = setup();
  const [a, b] = project.channels;
  engine.transport.play(10);
  step();
  const t0 = engine.ctx.currentTime;
  // an open hat (0.6 s) choked 0.1 s in by the closed one
  const open = {};
  engine.noteTap.on(a.id, 46, 0.8, t0 + 0.02, 0.6, open);
  engine.noteTap.on(b.id, 42, 0.8, t0 + 0.12, 0.05, {});
  engine.noteTap.cut(open, t0 + 0.12);
  const events = [];
  for (let i = 0; i < 20; i++) {
    const f = step();
    for (const n of f.notes || []) events.push(['note', n.key, Math.round((engine.ctx.currentTime - t0) * 1000)]);
    for (const o of f.offs || []) events.push(['off', o.key, Math.round((engine.ctx.currentTime - t0) * 1000)]);
  }
  const offOpen = events.find(([k, key]) => k === 'off' && key === 46);
  assert.ok(offOpen && offOpen[2] <= 140, `the open hat ends at the cut, not 0.6 s later: ${JSON.stringify(events)}`);
  // mono, the same key again: the old note ends, then the new one sounds (in that order)
  const t1 = engine.ctx.currentTime;
  const first = {};
  engine.noteTap.on(a.id, 60, 0.8, t1 + 0.02, 1, first);
  for (let i = 0; i < 4; i++) step();
  engine.noteTap.cut(first, t1 + 0.1);
  engine.noteTap.on(a.id, 60, 0.8, t1 + 0.1, 1, {});
  const order = [];
  for (let i = 0; i < 10; i++) for (const [addr] of avFrameToOsc(step())) if (/\/(note|off)$/.test(addr)) order.push(addr.split('/').pop());
  assert.deepEqual(order, ['off', 'note']);
  // a key held by hand, and a note not yet heard, when the bridge goes off
  const held = {};
  engine.noteTap.on(b.id, 64, 0.7, engine.ctx.currentTime + 0.001, null, held);
  step();
  engine.noteTap.on(b.id, 65, 0.7, engine.ctx.currentTime + 0.1, 0.2, {});
  bridge.stop();
  const last = sent.at(-1);
  assert.equal(last.final, true);
  assert.ok(last.offs.some((o) => o.key === 64), 'the held key ends');
  assert.ok(!last.offs.some((o) => o.key === 65), 'a note the visuals never heard gets no end');
  assert.equal(held.avNote, null);
});

test('with nobody to hear it the bridge slows down; a tab that plays is always heard', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, state, bridge } = setup();
  assert.equal(bridge.idle(), false, 'before the server has said anything');
  state.avStatus = { state: 'osc', listeners: 0 };
  assert.equal(bridge.idle(), false);
  state.avStatus = { state: 'off', listeners: 0 };
  assert.equal(bridge.idle(), true);
  state.avStatus = { state: 'admin', listeners: 1 };
  assert.equal(bridge.idle(), false, 'a WebSocket listener is there');
  state.avStatus = { state: 'busy', listeners: 0 };
  assert.equal(bridge.idle(), true, 'another tab is heard and this one is stopped');
  engine.transport.play(10);
  assert.equal(bridge.idle(), false, 'it plays: it must keep sending to take over');
});

test('phase 2: every control and the GGS Synth on the first frame, then only what changes, everything again each second', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, state, step, bridge } = setup();
  state.project = applyOps(state.project, [{ type: 'channel/add', channel: createChannel({ id: 'ch_lead', name: 'Lead', kind: 'ggs' }) }]);
  const watched = [];
  let live = null;
  engine.watchGgs = (id, on, who) => watched.push([id, on, who]);
  engine.ggsLive = (id) => (id === 'ch_lead' ? live : null);
  engine.ggsVoices = (id) => (id === 'ch_lead' && live ? 2 : 0);
  const first = step();
  assert.equal(first.full, 1);
  assert.equal(Object.keys(first.param).length, state.project.channels.length);
  assert.ok(first.param.lead.macro1 !== undefined && first.param.kick.volume > 0);
  assert.ok(first.busParam[0] && first.fx[0].limiter.enabled === 1);
  assert.equal(Object.keys(first.ggs.lead.src).length, MOD_SOURCES.length - 1);
  assert.equal(Object.keys(first.ggs.lead.dst).length, MOD_TARGETS.length - 1);
  assert.equal(first.ggs.lead.voices, 0);
  assert.deepEqual(watched[0], ['ch_lead', true, 'av'], 'the voices of every GGS channel report while the bridge is on');
  const all = phase2Values(first);
  // nothing changed: only the few values whose turn it is to be sent again (each once a second, spread out)
  const quiet = step();
  assert.ok(!quiet.full);
  assert.ok(phase2Values(quiet).length < all.length / 10, `${phase2Values(quiet).length} of ${all.length}`);
  // a note sounds: only its moving values go out
  live = new Float32Array(MOD_SOURCES.length + MOD_TARGETS.length);
  live[MOD_SOURCES.indexOf('env1')] = 0.7;
  live[MOD_SOURCES.length + MOD_TARGETS.indexOf('f1Cutoff')] = 0.2;
  const moving = step();
  assert.equal(moving.ggs.lead.src.env1, 0.7);
  assert.ok(moving.ggs.lead.dst.f1Cutoff[0] > first.ggs.lead.dst.f1Cutoff[0]);
  assert.equal(moving.ggs.lead.voices, 2);
  assert.ok(phase2Values(moving).length < all.length / 10);
  // an edit: that one value
  state.project = applyOps(state.project, [{ type: 'channel/update', id: state.project.channels[0].id, patch: { pan: 1 } }]);
  const edited = step();
  assert.equal(edited.param.kick.pan, 1);
  // within a second, everything again (for a visual app that starts listening late) — spread over the second's
  // frames, never all in one (a burst of hundreds of UDP messages that a small receive buffer would cut short)
  const seen = new Set();
  let biggest = 0;
  for (let i = 0; i < AV_FPS; i++) {
    const f = step();
    assert.ok(!f.full);
    const v = phase2Values(f);
    v.forEach((k) => seen.add(k));
    biggest = Math.max(biggest, v.length);
  }
  assert.deepEqual(all.filter((k) => !seen.has(k)), []);
  assert.ok(biggest < all.length / 5, `the biggest frame: ${biggest} of ${all.length}`);
  bridge.stop();
  assert.deepEqual(watched.at(-1), ['ch_lead', false, 'av'], 'and they stop when it goes off');
});

test('phase 2 recovers: a lost frame or a takeover sends everything next; a channel that goes away gets a last value', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, state, step, sent, bridge } = setup();
  state.project = applyOps(state.project, [{ type: 'channel/add', channel: createChannel({ id: 'ch_lead', name: 'Lead', kind: 'ggs' }) }]);
  const watched = new Map();
  engine.watchGgs = (id, on, who) => watched.set(`${id}/${who}`, on);
  engine.ggsLive = () => null;
  engine.ggsVoices = () => 0;
  step();
  assert.ok(!step().full, 'nothing changed');
  // the connection was down for a frame: the next one carries everything
  bridge.send = (f) => { sent.push(f); return false; };
  step();
  bridge.send = (f) => { sent.push(f); return true; };
  const after = step();
  assert.equal(after.full, 1);
  assert.equal(Object.keys(after.param).length, state.project.channels.length);
  assert.ok(!step().full);
  // this tab takes over the OSC port from another: everything again
  state.avStatus = { state: 'busy', listeners: 0 };
  step();
  state.avStatus = { state: 'osc', listeners: 0 };
  assert.equal(step().full, 1);
  // nobody hears this tab: the voices stop reporting
  assert.equal(watched.get('ch_lead/av'), true);
  state.avStatus = { state: 'off', listeners: 0 };
  step();
  assert.equal(watched.get('ch_lead/av'), false, 'no reports for nobody');
  state.avStatus = { state: 'osc', listeners: 0 };
  step();
  assert.equal(watched.get('ch_lead/av'), true);
  // the GGS channel becomes a kick, and a channel is deleted: their last values say so
  const kickId = state.project.channels[0].id;
  state.project = applyOps(state.project, [
    { type: 'channel/update', id: 'ch_lead', patch: { instrument: { kind: 'kick' } } },
    { type: 'channel/remove', id: kickId }
  ]);
  const gone = step();
  assert.equal(gone.ggs.lead.voices, 0);
  assert.ok(Object.values(gone.ggs.lead.src).every((v) => v === 0));
  assert.deepEqual(gone.param.kick, { mute: 1 });
  assert.equal(watched.get('ch_lead/av'), false);
  const next = step();
  assert.ok(!next.ggs?.lead && !next.param?.kick, 'once');
});

test('phase 3: a note with curves sends its expression as it moves; a finger on a held key too; a cut ends it', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step } = setup();
  const lead = project.channels[1];
  engine.transport.play(10);
  step();
  const t0 = engine.ctx.currentTime;
  // a 1 s note bending up an octave, with a pressure that holds
  const curves = { pitch: [{ t: 0, v: 0 }, { t: 1, v: 12 }], pressure: [{ t: 0, v: 0.8 }, { t: 1, v: 0.8 }] };
  engine.noteTap.on(lead.id, 64, 0.8, t0 + 0.02, 1, {}, { curves, seconds: 1 });
  const seen = [];
  for (let i = 0; i < 70; i++) {
    const f = step();
    for (const e of f.expr || []) seen.push({ ...e, at: engine.ctx.currentTime - t0 });
  }
  const pitch = seen.filter((e) => e.dim === 'pitch');
  assert.ok(pitch.length > 40, `${pitch.length} pitch values`);
  assert.ok(pitch.every((e, i) => i === 0 || e.v >= pitch[i - 1].v), 'it only rises');
  assert.ok(Math.abs(pitch.at(-1).v - 12) < 0.5);
  assert.equal(pitch[0].key, 64);
  assert.ok(seen.filter((e) => e.dim === 'pressure').length <= 2, 'a value that holds goes once (and with the full frame each second)');
  assert.ok(seen.every((e) => e.at <= 1.03 + 1 / AV_FPS), 'nothing after the note ends');
  // a key held by hand, played with an MPE controller
  const voice = {};
  engine.noteTap.on(lead.id, 60, 0.7, engine.ctx.currentTime + 0.001, null, voice);
  step();
  engine.noteTap.expr(voice, 'pressure', 0.4);
  const slug = lead.name.toLowerCase();
  assert.deepEqual(step().expr, [{ ch: slug, key: 60, dim: 'pressure', v: 0.4 }]);
  engine.noteTap.expr(voice, 'pitch', -2);
  assert.deepEqual(step().expr, [{ ch: slug, key: 60, dim: 'pitch', v: -2 }]);
  assert.equal(step().expr, undefined, 'no movement, nothing');
  engine.noteTap.off(voice, 0.5);
  step();
  engine.noteTap.expr(voice, 'pressure', 0.9);
  assert.equal(step().expr, undefined, 'after its end, the key says nothing more');
  // a choked note's curve stops at the cut
  const choked = {};
  engine.noteTap.on(lead.id, 67, 0.8, engine.ctx.currentTime + 0.01, 2, choked, { curves, seconds: 2 });
  step(); step();
  engine.noteTap.cut(choked, engine.ctx.currentTime + 0.02);
  for (let i = 0; i < 3; i++) step();
  const later = [];
  for (let i = 0; i < 10; i++) later.push(...(step().expr || []));
  assert.equal(later.length, 0);
});

test('phase 3: 3D objects go out when they move, all of them once a second', (t) => {
  t.after(() => mock.timers.reset());
  const { state, step } = setup();
  state.project = applyOps(state.project, [
    { type: 'project/update', patch: { spatial: { enabled: true } } },
    { type: 'mixer/update', index: 1, patch: { spatial: { enabled: true, x: 0.5, y: 0, z: 0 } } }
  ]);
  const first = step();
  assert.deepEqual(first.spatial, { 1: [0.5, 0, 0] });
  assert.ok(first.map.objects.some((o) => o.insert === 1));
  assert.equal(step().spatial, undefined);
  state.project = applyOps(state.project, [{ type: 'mixer/update', index: 1, patch: { spatial: { x: -1 } } }]);
  assert.deepEqual(step().spatial, { 1: [-1, 0, 0] });
  let again = 0;
  for (let i = 0; i < AV_FPS; i++) if (step().spatial) again++;
  assert.equal(again, 1);
});

test('phase 3: nothing about a note after its off; two notes on one key each speak for themselves; a killed voice is over', (t) => {
  t.after(() => mock.timers.reset());
  const { engine, project, step } = setup();
  const ch = project.channels[1];
  engine.transport.play(10);
  step();
  const curves = { pitch: [{ t: 0, v: 0 }, { t: 1, v: 12 }] };
  // short notes ending at every point of a frame: never an expr after (or in the same frame as) the note's off
  const frames = [];
  for (let n = 0; n < 8; n++) {
    engine.noteTap.on(ch.id, 60 + n, 0.8, engine.ctx.currentTime + 0.01, 0.05 + n * 0.0021, {}, { curves, seconds: 0.05 + n * 0.0021 });
    for (let i = 0; i < 8; i++) frames.push(avFrameToOsc(step()).filter(([a]) => /\/(off|expr\/pitch)$/.test(a)).map(([a, k]) => [a.split('/').pop(), k.i]));
  }
  // (read in the order a receiver gets them: within a frame the offs come before the expression values)
  const ended = new Set();
  for (const f of frames) {
    for (const [kind, key] of f) {
      if (kind === 'off') ended.add(key);
      else assert.ok(!ended.has(key), `expr after the off of key ${key}`);
    }
  }
  assert.ok(frames.flat().some(([kind]) => kind === 'pitch'));
  // two notes on the same key at the same moment, with different curves: each sends its own changes, not all the time
  const t0 = engine.ctx.currentTime + 0.01;
  engine.noteTap.on(ch.id, 72, 0.8, t0, 2, {}, { curves: { pressure: [{ t: 0, v: 0.2 }, { t: 1, v: 0.2 }] }, seconds: 2 });
  engine.noteTap.on(ch.id, 72, 0.8, t0, 2, {}, { curves: { pressure: [{ t: 0, v: 0.9 }, { t: 1, v: 0.9 }] }, seconds: 2 });
  let n = 0;
  for (let i = 0; i < 20; i++) n += (step().expr || []).length;
  assert.ok(n <= 4, `${n} messages for two still notes`);
  // a voice the engine has killed (a stop, a choke) takes no more expression
  const voice = {};
  engine.noteTap.on(ch.id, 50, 0.8, engine.ctx.currentTime + 0.001, null, voice);
  step();
  voice.killedAt = engine.ctx.currentTime;
  engine.noteTap.expr(voice, 'pressure', 1);
  assert.equal(step().expr, undefined);
});
