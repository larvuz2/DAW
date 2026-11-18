// The audio → visual bridge in a real browser: "Send to visuals" in the File menu, a song that plays, and what a visual
// app hears on its OSC port (a UDP socket in this test) — the transport about 60 times a second, notes at the moment
// they sound, the markers' sections, a visual lane Claude drew, levels and a spectrum that move, the map — and the
// music stopping for the visuals when the studio stops or the bridge goes off.
import { test, expect } from '@playwright/test';
import dgram from 'node:dgram';
import { decodeOsc } from '@ggs/core';
import { ADMIN, OSC_PORT, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
let udp;
const got = []; // { t (ms), addr, args }
const errors = [];
const store = (fn) => page.evaluate(fn);

test.beforeAll(async ({ browser, baseURL }) => {
  udp = dgram.createSocket('udp4');
  udp.on('message', (buf) => { const [addr, ...args] = decodeOsc(buf); got.push({ t: Date.now(), addr, args }); });
  await new Promise((r) => udp.bind(OSC_PORT, '127.0.0.1', r));
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  claude = await connectMcp(baseURL);
  await claude.call('create_project', { name: 'Visuals e2e', template: 'empty', key: 'A', scale: 'minor', bpm: 120 });
  await expect(page).toHaveTitle(/Visuals e2e/);
  await claude.call('add_channel', { name: 'Kick', instrument: 'kick' });
  await claude.call('add_channel', { name: 'Lead Synth', instrument: 'synth' });
  await claude.call('add_channel', { name: 'Pad', instrument: 'ggs', preset: 'Velvet Pad' });
  await claude.call('create_pattern', { name: 'A', bars: 1 });
  await claude.call('write_drums', { pattern: 'A', tracks: { Kick: 'x---x---x---x---' } });
  await claude.call('add_notes', { pattern: 'A', channel: 'Lead Synth', text: '1.1 A4 1/4; 1.3 C5 1/4' });
  await claude.call('add_notes', { pattern: 'A', channel: 'Pad', text: '1.1 A3+C4+E4 3/4' });
  await claude.call('place_pattern', { pattern: 'A', startBar: 1, bars: 8 });
  await claude.call('set_markers', { add: [{ bar: 1, name: 'Intro' }, { bar: 3, name: 'Drop' }] });
  await claude.call('add_automation', { name: 'Glow', target: { type: 'user', lane: 2 }, points: [{ bar: 0, value: 0 }, { bar: 4, value: 1 }], startBar: 1 });
  // phase 2: an effect whose mix the song moves
  await claude.call('add_effect', { insert: 1, type: 'delay', params: { mix: 0.1 } });
  await claude.call('add_automation', { name: 'Echo', target: { type: 'effect', insert: 1, effectId: 'delay', param: 'mix' }, points: [{ bar: 0, value: 0 }, { bar: 4, value: 1 }], startBar: 1 });
  // phase 3: the lead is a 3D object that circles the room, and its A4 bends up two semitones
  await claude.call('set_note_expression', { pattern: 'A', channel: 'Lead Synth', note: 'A4', pitch: { shape: 'bend', from: 0, to: 2, start: 0, end: 1 } });
  await claude.call('set_spatial', { enabled: true, monitor: 'stereo' });
  await claude.call('place_object', { insert: 'Lead Synth', position: 'front' });
  await claude.call('move_object', { insert: 'Lead Synth', path: 'circle', startBar: 1, bars: 4, turns: 1 });
  await expect.poll(() => store(() => window.ggs.store.getState().project.automations.length)).toBe(4);
});
test.afterAll(async () => {
  await store(() => window.ggs.store.getState().stop()).catch(() => {});
  await claude?.close();
  await page?.close();
  udp?.close();
});

test('Send to visuals: switched on from the File menu, remembered, and it says where the frames go', async () => {
  await page.locator('.tbtn.logo').click();
  const item = page.getByRole('menuitemcheckbox', { name: /Send to visuals/ });
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await item.click();
  await expect(page.locator('.toast').filter({ hasText: `OSC to 127.0.0.1:${OSC_PORT}` })).toBeVisible();
  expect(await store(() => JSON.parse(localStorage.getItem('ggs.ui.v1')).avBridge)).toBe(true);
  // frames start at once, stopped: the playhead at bar 1, the map, the intro marker
  await expect.poll(() => got.some((m) => m.addr === '/gtd/map'), { timeout: 5000 }).toBe(true);
  const map = JSON.parse(got.find((m) => m.addr === '/gtd/map').args[0]);
  expect(map.channels.map((c) => c.slug)).toEqual(['kick', 'lead_synth', 'pad']);
  expect(map.effects.map((e) => `${e.insert}/${e.slug}`)).toContain('1/delay');
  expect(map.markers.map((m) => m.name)).toEqual(['Intro', 'Drop']);
  expect(got.find((m) => m.addr === '/gtd/transport/playing').args[0]).toBe(0);
  expect(got.find((m) => m.addr === '/gtd/marker').args[0]).toBe('Intro');
  await expect.poll(() => store(() => window.ggs.store.getState().avStatus?.state)).toBe('osc');
  // the menu shows the port now
  await page.locator('.tbtn.logo').click();
  await expect(page.getByRole('menuitemcheckbox', { name: new RegExp(`Send to visuals \\(OSC → 127\\.0\\.0\\.1:${OSC_PORT}\\)`) })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
});

let playFrom = 0;
test('a song plays: transport at ~60 Hz, notes when they sound, the drop, the visual lane, levels and spectrum', async () => {
  const from = got.length;
  playFrom = from;
  const t0 = Date.now();
  await store(() => window.ggs.store.getState().play({ mode: 'song' }));
  // bar 3 is 4 s in at 120 bpm
  await expect.poll(() => got.slice(from).some((m) => m.addr === '/gtd/marker' && m.args[0] === 'Drop'), { timeout: 12000 }).toBe(true);
  await page.waitForTimeout(500);
  const frames = got.slice(from);
  // playback starts at once, and the drop comes when it sounds: 4 s in
  expect(frames.find((m) => m.addr === '/gtd/transport/playing' && m.args[0] === 1).t - t0).toBeLessThan(1000);
  expect(Math.abs(frames.find((m) => m.addr === '/gtd/marker' && m.args[0] === 'Drop').t - t0 - 4000)).toBeLessThan(600);
  const seconds = (Date.now() - t0) / 1000;
  const of = (addr) => frames.filter((m) => m.addr === addr);
  const ticks = of('/gtd/transport/tick');
  expect(ticks.length / seconds).toBeGreaterThan(30);
  expect(ticks.length / seconds).toBeLessThan(75);
  const playingFrames = of('/gtd/transport/playing').filter((m) => m.args[0] === 1);
  expect(playingFrames.length).toBeGreaterThan(60);
  expect(of('/gtd/transport/bpm').at(-1).args[0]).toBe(120);
  expect(of('/gtd/transport/bar').at(-1).args[0]).toBeGreaterThanOrEqual(3);
  // the position only moves forward while it plays
  const pos = ticks.map((m) => m.args[0]).filter((v, i) => i >= ticks.length - playingFrames.length);
  expect(pos.every((v, i) => i === 0 || v >= pos[i - 1])).toBe(true);

  // notes: four kicks a bar, two lead notes, each sent in the frame whose clock is the moment it sounds
  const kicks = of('/gtd/ch/kick/note');
  const leads = of('/gtd/ch/lead_synth/note');
  expect(kicks.length).toBeGreaterThanOrEqual(8);
  expect(leads.length).toBeGreaterThanOrEqual(4);
  expect(new Set(leads.map((m) => m.args[0]))).toEqual(new Set([69, 72]));
  const idx = frames.indexOf(kicks[2]);
  const clock = frames.slice(0, idx).reverse().find((m) => m.addr === '/gtd/transport/time').args[0];
  expect(Math.abs(clock - kicks[2].args[3])).toBeLessThan(0.05);
  const gaps = kicks.slice(1).map((m, i) => m.args[3] - kicks[i].args[3]);
  for (const g of gaps) expect(Math.abs(g - 0.5)).toBeLessThan(0.01); // a beat at 120 bpm, on the audio clock
  expect(of('/gtd/ch/lead_synth/off').length).toBeGreaterThanOrEqual(3);

  // the visual lane rises across its clip; the sound is measured
  const lane = of('/gtd/user/2').map((m) => m.args[0]);
  expect(lane.at(-1)).toBeGreaterThan(0.4);
  expect(lane.at(-1)).toBeGreaterThan(lane[Math.floor(lane.length / 4)]);
  expect(Math.max(...of('/gtd/master/peak').map((m) => m.args[0]))).toBeGreaterThan(0.05);
  expect(Math.max(...of('/gtd/ch/kick/level').map((m) => m.args[0]))).toBeGreaterThan(0.05);
  const spectrum = of('/gtd/master/spectrum').at(-1).args;
  expect(spectrum).toHaveLength(32);
  expect(spectrum.some((v) => v > 0)).toBe(true);
  expect(of('/gtd/master/bands').at(-1).args).toHaveLength(6);
  expect(of('/gtd/master/onset').length).toBeGreaterThan(2);
  expect(of('/gtd/latency').length).toBeGreaterThan(1);
  // nothing in the frames is out of range
  expect(frames.filter((m) => /peak|level|user|rms|spectrum|bands/.test(m.addr) && m.args.some((v) => !(v >= 0 && v <= 1))).map((m) => m.addr)).toEqual([]);
});

test('phase 2: controls as they stand, the automated delay, and the GGS pad\'s live modulation', async () => {
  const frames = got.slice(playFrom);
  const of = (addr) => frames.filter((m) => m.addr === addr).map((m) => m.args);
  // every control once a second at least, in 0 … 1
  const vol = of('/gtd/ch/kick/param/volume');
  expect(vol.length).toBeGreaterThanOrEqual(3);
  expect(vol.at(-1)[0]).toBeGreaterThan(0);
  expect(of('/gtd/ch/pad/param/macro1').length).toBeGreaterThan(0);
  expect(of('/gtd/bus/0/param/volume').at(-1)[0]).toBeCloseTo(0.8, 3);
  // the delay's mix follows its automation up through the clip
  const mix = of('/gtd/fx/1/delay/mix').map((a) => a[0]);
  expect(mix.length).toBeGreaterThan(10);
  expect(mix.at(-1)).toBeGreaterThan(0.5);
  expect(mix.at(-1)).toBeGreaterThan(mix[1]);
  expect(of('/gtd/fx/1/delay/enabled').at(-1)[0]).toBe(1);
  // the pad: voices, its amp envelope moving, every target in its unit and 0 … 1
  expect(Math.max(...of('/gtd/ggs/pad/voices').map((a) => a[0]))).toBeGreaterThanOrEqual(3);
  const env = of('/gtd/ggs/pad/src/env1').map((a) => a[0]);
  expect(env.length).toBeGreaterThan(20);
  expect(Math.max(...env)).toBeGreaterThan(0.2);
  const cutoff = of('/gtd/ggs/pad/dst/f1Cutoff');
  expect(cutoff.length).toBeGreaterThan(0);
  expect(cutoff.every(([hz]) => hz >= 16 && hz <= 21000)).toBe(true);
  expect(of('/gtd/ggs/pad/dst/f1Cutoff/n').every(([n]) => n >= 0 && n <= 1)).toBe(true);
  // not 60 times a second for what doesn't move: the master's volume goes about once a second
  const seconds = (frames.at(-1).t - frames[0].t) / 1000;
  expect(of('/gtd/bus/0/param/volume').length).toBeLessThan(seconds * 3 + 3);
  // the synth editor opened and closed on the pad doesn't switch the bridge's reports off
  const padId = await store(() => window.ggs.store.getState().project.channels.find((c) => c.name === 'Pad').id);
  await page.evaluate((id) => window.ggs.store.getState().openChannelSettings(id), padId);
  await page.waitForTimeout(400);
  await store(() => window.ggs.store.getState().closeWindow('channelSettings'));
  await page.waitForTimeout(300);
  const after = got.length;
  await expect.poll(() => got.slice(after).filter((m) => m.addr === '/gtd/ggs/pad/src/env1').length, { timeout: 4000 }).toBeGreaterThan(5);
});

test('phase 3: the lead circles the room in room units, and its bent note sends its pitch as it moves', async () => {
  const frames = got.slice(playFrom);
  const map = JSON.parse(got.findLast((m) => m.addr === '/gtd/map').args[0]);
  const lead = map.channels.find((c) => c.slug === 'lead_synth');
  expect(map.objects.map((o) => o.insert)).toEqual([lead.insert]);
  const pos = frames.filter((m) => m.addr === `/gtd/spatial/${lead.insert}`).map((m) => m.args);
  expect(pos.length).toBeGreaterThan(60); // it moves: a message nearly every frame
  // clockwise from the front: right first, then behind (about half a turn in the 4.5 s played)
  expect(pos[0][1]).toBeGreaterThan(0.9);
  expect(Math.max(...pos.map(([x]) => x))).toBeGreaterThan(0.9);
  expect(Math.min(...pos.map(([, y]) => y))).toBeLessThan(-0.5);
  expect(pos.every(([x, y, z]) => Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= 0 && z <= 1)).toBe(true);
  // the A4 (half a second) bends 0 → +2 semitones; the C5 has no curve and sends none
  const bend = frames.filter((m) => m.addr === '/gtd/ch/lead_synth/expr/pitch');
  expect(bend.length).toBeGreaterThan(10);
  expect(bend.every((m) => m.args[0] === 69)).toBe(true);
  expect(Math.max(...bend.map((m) => m.args[1]))).toBeGreaterThan(1.5);
  expect(Math.min(...bend.map((m) => m.args[1]))).toBeLessThan(0.5);
});

test('stop: the visuals hear it at once; switching off sends the last frame and then nothing', async () => {
  const from = got.length;
  await store(() => window.ggs.store.getState().stop());
  await expect.poll(() => got.slice(from).some((m) => m.addr === '/gtd/transport/playing' && m.args[0] === 0), { timeout: 2000 }).toBe(true);
  await store(() => window.ggs.store.getState().setAvBridge(false));
  await page.waitForTimeout(400);
  const n = got.length;
  await page.waitForTimeout(600);
  expect(got.length).toBe(n);
  expect(errors).toEqual([]);
});
