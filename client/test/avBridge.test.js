// The tab end of the audio → visual bridge (src/lib/avBridge.js) with a stand-in engine: notes go out in the frame of
// the moment they are heard, a stop drops what never sounded and ends what was sounding, a new play replaces the
// old one's notes, keys held by hand end with their key, the map comes again every 2 s, and switching off says so.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, PPQ, AV_FPS, avFrameToOsc } from '@greanteadawy/core';
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
