// The audio → visual bridge's shared parts (src/av.js): slugs, the map, automation and visual-lane values the way the
// engine plays them, spectrum features, onsets, and the frame → OSC mapping with its encoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultProject, applyOps, normalizeProject, PPQ, AV_USER_LANES, AV_BANDS, AV_SPECTRUM_BANDS, avSlug, channelSlugs, avMap, usedInserts,
  automationValuesAt, markerIndexAt, levelsOf, spectrumFeatures, createOnsetDetector, avFrameToOsc, encodeOsc, decodeOsc
} from '../src/index.js';

const BAR = PPQ * 4;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('slugs: lower case, a–z 0–9 and _, accents folded, the same name twice gets _2', () => {
  assert.equal(avSlug('Lead Synth'), 'lead_synth');
  assert.equal(avSlug('  Bajo (sub) #2 '), 'bajo_sub_2');
  assert.equal(avSlug('Canción Ñ'), 'cancion_n');
  assert.equal(avSlug('***'), 'channel');
  assert.equal(avSlug(''), 'channel');
  assert.ok(avSlug('x'.repeat(100)).length <= 40);
  const p = createDefaultProject();
  p.channels[0].name = 'Kick';
  p.channels[1].name = 'kick';
  p.channels[2].name = 'KICK!';
  const slugs = channelSlugs(p);
  assert.deepEqual([0, 1, 2].map((i) => slugs.get(p.channels[i].id)), ['kick', 'kick_2', 'kick_3']);
  assert.equal(new Set(slugs.values()).size, p.channels.length, 'every channel has its own address');
});

test('the map: channels with slug, colour, instrument and insert; used buses only; markers in order', () => {
  let p = createDefaultProject();
  p = applyOps(p, [
    { type: 'marker/add', marker: { id: 'm2', name: 'Drop', tick: BAR * 8 } },
    { type: 'marker/add', marker: { id: 'm1', name: 'Intro', tick: 0 } }
  ]);
  const map = avMap(p);
  assert.equal(map.ppq, PPQ);
  assert.equal(map.ticksPerBar, BAR);
  assert.equal(map.channels.length, p.channels.length);
  for (const c of map.channels) assert.ok(/^[a-z0-9_]+$/.test(c.slug) && c.id && c.kind && Number.isInteger(c.insert));
  assert.deepEqual(map.markers.map((m) => m.name), ['Intro', 'Drop']);
  const used = usedInserts(p);
  assert.equal(used[0], 0, 'the master is always there');
  for (const c of p.channels) assert.ok(used.includes(c.mixerTrack));
  assert.ok(used.length < p.mixer.length, 'empty "Insert N"s are left out');
  assert.deepEqual(map.buses.map((b) => b.index), used);
  assert.equal(avMap(null), null);
});

test('automation values: inside a clip the curve, after it the last value is held, visual lanes default to 0', () => {
  let p = createDefaultProject();
  const ch = p.channels[0].id;
  p = applyOps(p, [
    { type: 'automation/add', automation: { id: 'a_vol', name: 'Vol', target: { type: 'channel', id: ch, param: 'volume' }, length: BAR, points: [{ t: 0, v: 0 }, { t: BAR, v: 1 }] } },
    { type: 'automation/add', automation: { id: 'a_u3', name: 'Visual 3', target: { type: 'user', index: 3 }, length: BAR * 2, points: [{ t: 0, v: 0.2 }, { t: BAR * 2, v: 0.8 }] } },
    { type: 'clip/add', clips: [
      { id: 'c1', kind: 'automation', refId: 'a_vol', track: 3, start: BAR, length: BAR },
      { id: 'c2', kind: 'automation', refId: 'a_u3', track: 4, start: BAR * 2, length: BAR * 2 }
    ] }
  ]);
  let v = automationValuesAt(p, 0);
  assert.deepEqual(v.auto, {}, 'nothing has played yet');
  assert.deepEqual(v.user, new Array(AV_USER_LANES).fill(0));
  v = automationValuesAt(p, BAR + BAR / 2);
  assert.ok(near(v.auto.a_vol, 0.5));
  v = automationValuesAt(p, BAR * 3);
  assert.ok(near(v.auto.a_vol, 1, 0.01), 'held after its clip');
  assert.ok(near(v.auto.a_u3, 0.5), 'halfway through lane 3');
  assert.ok(near(v.user[2], 0.5));
  assert.equal(v.user[0], 0);
  v = automationValuesAt(p, BAR * 40);
  assert.ok(near(v.user[2], 0.8, 0.01), 'a visual lane holds its last value too');
  // a muted clip plays nothing
  const muted = applyOps(p, [{ type: 'clip/update', id: 'c2', patch: { mute: true } }]);
  assert.equal(automationValuesAt(muted, BAR * 3).user[2], 0);
});

test('visual lanes: user targets are 1..8, survive normalizeProject, and are refused out of range', () => {
  const p = createDefaultProject();
  for (const index of [0, 9, 1.5, '2']) {
    assert.throws(() => applyOps(p, [{ type: 'automation/add', automation: { id: 'x', target: { type: 'user', index }, points: [{ t: 0, v: 0 }] } }]), /1\.\.8/, String(index));
  }
  const q = applyOps(p, [{ type: 'automation/add', automation: { id: 'x', target: { type: 'user', index: 8, extra: 1 }, points: [{ t: 0, v: 0 }] } }]);
  assert.deepEqual(q.automations.at(-1).target, { type: 'user', index: 8 });
  const back = normalizeProject(JSON.parse(JSON.stringify(q)));
  assert.deepEqual(back.automations.at(-1).target, { type: 'user', index: 8 });
  const bad = JSON.parse(JSON.stringify(q));
  bad.automations.at(-1).target.index = 12;
  assert.equal(normalizeProject(bad).automations.some((a) => a.id === 'x'), false, 'a broken lane is dropped on load');
});

test('markers: the section a tick is in', () => {
  const m = [{ tick: 0 }, { tick: 384 }, { tick: 1536 }];
  assert.equal(markerIndexAt(m, 0), 0);
  assert.equal(markerIndexAt(m, 383), 0);
  assert.equal(markerIndexAt(m, 384), 1);
  assert.equal(markerIndexAt(m, 99999), 2);
  assert.equal(markerIndexAt([{ tick: 96 }], 0), -1);
});

test('levels and spectrum: a sine lands in its band, the centroid finds it, silence is 0', () => {
  const sr = 48000;
  const n = 2048;
  const sine = (hz, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
  const lv = levelsOf(sine(440, 0.5));
  assert.ok(near(lv.peak, 0.5, 0.01));
  assert.ok(near(lv.rms, 0.5 / Math.SQRT2, 0.01));
  assert.deepEqual(levelsOf(new Float32Array(16)), { peak: 0, rms: 0 });
  // an analyser's spectrum (dB per bin) of a 1 kHz tone at −10 dB, everything else at −120
  const bins = 1024;
  const db = new Float32Array(bins).fill(-120);
  const k = Math.round(1000 / (sr / 2 / bins));
  db[k] = -10;
  const f = spectrumFeatures(db, sr);
  assert.equal(f.bands.length, AV_BANDS.length);
  assert.equal(f.spectrum.length, AV_SPECTRUM_BANDS);
  const mid = AV_BANDS.findIndex(([name]) => name === 'mid');
  assert.equal(f.bands.indexOf(Math.max(...f.bands)), mid, `bands ${f.bands}`);
  assert.ok(f.bands.every((v, i) => i === mid || v === 0));
  assert.ok(Math.abs(f.centroid - 1000) < 30, `centroid ${f.centroid}`);
  const top = f.spectrum.indexOf(Math.max(...f.spectrum));
  const edge = (i) => 20 * Math.pow(1000, i / AV_SPECTRUM_BANDS);
  assert.ok(edge(top) <= 1000 && edge(top + 1) >= 1000, `band ${top}`);
  assert.ok(f.spectrum.every((v) => v >= 0 && v <= 1));
  const quiet = spectrumFeatures(new Float32Array(bins).fill(-Infinity), sr);
  assert.ok(quiet.bands.every((v) => v === 0) && quiet.spectrum.every((v) => v === 0) && quiet.centroid === 0);
});

test('onsets: a hit after quiet frames is one onset, a steady sound is none, never twice within 80 ms', () => {
  const detect = createOnsetDetector();
  const quiet = new Array(32).fill(0.001);
  const loud = new Array(32).fill(0.5);
  let t = 0;
  const step = (bands) => { t += 1 / 60; return detect(bands, t); };
  for (let i = 0; i < 20; i++) assert.equal(step(quiet), 0);
  const hit = step(loud);
  assert.ok(hit > 0 && hit <= 1, `hit ${hit}`);
  let more = 0;
  for (let i = 0; i < 30; i++) if (step(loud) > 0) more++;
  assert.equal(more, 0, 'a held sound is not a new onset');
  const d2 = createOnsetDetector();
  assert.ok(d2(quiet, 0) === 0 && d2(loud, 0.01) > 0);
  assert.equal(d2(new Array(32).fill(2), 0.05), 0, 'within 80 ms of the last one');
});

test('OSC encoding: OSC 1.0 bytes, padded to 4, round trip', () => {
  const bytes = encodeOsc('/gtd/ch/kick/note', [{ i: 36 }, { f: 0.8 }, { f: 0.25 }, { f: 12.5 }]);
  assert.equal(bytes.length % 4, 0);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 17)), '/gtd/ch/kick/note');
  assert.equal(new TextDecoder().decode(bytes.subarray(20, 25)), ',ifff');
  const [addr, key, vel, dur, at] = decodeOsc(bytes);
  assert.deepEqual([addr, key], ['/gtd/ch/kick/note', 36]);
  assert.ok(near(vel, 0.8, 1e-6) && near(dur, 0.25, 1e-6) && near(at, 12.5, 1e-6));
  // strings are padded (with at least one zero), an exact multiple of 4 gets four
  assert.deepEqual(decodeOsc(encodeOsc('/gtd/map', [{ s: 'abcd' }, { i: -3 }])), ['/gtd/map', 'abcd', -3]);
  assert.equal(encodeOsc('/abc').length, 8 + 4, '"/abc" + 4 zeros, "," + 3 zeros');
});

test('a frame becomes OSC messages in order: transport, events (note ends before notes), continuous values, latency, map', () => {
  const frame = {
    playing: 1, bpm: 128, tick: PPQ * 4 * 2 + PPQ + PPQ / 2, ppq: PPQ, tpb: BAR, time: 3.5,
    marker: { name: 'Drop', tick: BAR * 2 },
    notes: [{ ch: 'kick', key: 36, vel: 0.9, dur: 0.1, at: 3.49 }, { ch: 'bad slug!', key: 1, vel: 1, dur: 1, at: 1 }],
    offs: [{ ch: 'lead', key: 60, rel: 0.3 }],
    master: { peak: 0.7, rms: 0.3, bands: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], spectrum: new Array(32).fill(0.5), centroid: 1800, onset: 0.6 },
    buses: { 0: 0.7, 3: 2, x: 1 },
    ch: { kick: 0.8, lead: -1 },
    auto: { auto_ab12: 0.25 },
    user: [0, 0.5, 1, 0, 0, 0, 0, 0, 0.9],
    latency: 0.02,
    map: { channels: [{ slug: 'kick', id: 'ch_1', color: '#ff0000', kind: 'drums', insert: 1 }], buses: [{ index: 0, name: 'Master' }] }
  };
  const msgs = avFrameToOsc(frame);
  const addrs = msgs.map((m) => m[0]);
  const at = (a) => addrs.indexOf(a);
  assert.deepEqual(addrs.slice(0, 8), ['/gtd/transport/playing', '/gtd/transport/bpm', '/gtd/transport/tick', '/gtd/transport/beat', '/gtd/transport/bar', '/gtd/transport/phase/beat', '/gtd/transport/phase/bar', '/gtd/transport/time']);
  const val = (a) => msgs[at(a)].slice(1).map((x) => x.i ?? x.f ?? x.s);
  assert.deepEqual(val('/gtd/transport/bar'), [3]);
  assert.deepEqual(val('/gtd/transport/beat'), [9.5]);
  assert.deepEqual(val('/gtd/transport/phase/beat'), [0.5]);
  assert.deepEqual(val('/gtd/transport/phase/bar'), [(PPQ * 1.5) / BAR]);
  assert.deepEqual(val('/gtd/marker'), ['Drop', BAR * 2]);
  assert.deepEqual(msgs[at('/gtd/ch/kick/note')].slice(1), [{ i: 36 }, { f: 0.9 }, { f: 0.1 }, { f: 3.49 }]);
  assert.ok(!addrs.some((a) => a.includes('bad')), 'a malformed slug is skipped');
  assert.deepEqual(val('/gtd/ch/lead/off'), [60, 0.3]);
  assert.equal(val('/gtd/master/bands').length, 6);
  assert.equal(val('/gtd/master/spectrum').length, 32);
  assert.deepEqual(val('/gtd/bus/3/peak'), [1], 'clamped to 0..1');
  assert.ok(!addrs.includes('/gtd/bus/x/peak'));
  assert.deepEqual(val('/gtd/ch/lead/level'), [0]);
  assert.deepEqual(val('/gtd/auto/auto_ab12'), [0.25]);
  assert.deepEqual(addrs.filter((a) => a.startsWith('/gtd/user/')), Array.from({ length: 8 }, (_, i) => `/gtd/user/${i + 1}`), 'eight lanes, not nine');
  assert.deepEqual(val('/gtd/map/ch/kick'), ['ch_1', '#ff0000', 'drums', 1]);
  assert.deepEqual(JSON.parse(val('/gtd/map')[0]).channels[0].slug, 'kick');
  // the order the visual side relies on
  const order = ['/gtd/transport/time', '/gtd/marker', '/gtd/ch/lead/off', '/gtd/ch/kick/note', '/gtd/master/onset', '/gtd/master/peak', '/gtd/bus/0/peak', '/gtd/ch/kick/level', '/gtd/auto/auto_ab12', '/gtd/user/1', '/gtd/latency', '/gtd/map'];
  assert.deepEqual(order.map(at), [...order.map(at)].sort((a, b) => a - b));
  // every message encodes
  for (const [a, ...args] of msgs) assert.equal(decodeOsc(encodeOsc(a, args))[0], a);
  // junk in, nothing thrown, transport only
  assert.deepEqual(avFrameToOsc(null), []);
  const junk = avFrameToOsc({ tick: 'x', bpm: Infinity, notes: 'no', ch: [1, 2], buses: null, master: 5, map: 'x' });
  assert.ok(junk.length >= 7 && junk.every(([a]) => a.startsWith('/gtd/')));
});
