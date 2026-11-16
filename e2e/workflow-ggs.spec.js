// The GGS Synth and per-note expression in a real browser: the AudioWorklet loads, notes play live, offline renders
// follow every note's own pitch / pressure / slide curve, repeat sample for sample, and Claude designs sounds and
// performances over MCP.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
const errors = [];

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /GGS Synth/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  claude = await connectMcp(baseURL);
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

/**
 * Render the open project's first pattern offline in the page and measure it there: the level (dB re full scale)
 * of each frequency in `probe` (Goertzel over the window from..to seconds), plus the peak and a checksum.
 */
function renderAndProbe(probe, { from = 0.25, to = 0.7, mode = 'pattern' } = {}) {
  return page.evaluate(async ({ probe, from, to, mode }) => {
    const { store, render } = window.greanteadawy;
    const project = store.getState().project;
    const r = await render(project, { mode, patternId: project.patterns[0].id, loops: 1, tail: 0.3, encode: false, sampleRate: 44100 });
    const x = r.buffer.getChannelData(0);
    const sr = r.buffer.sampleRate;
    const a = Math.round(from * sr);
    const b = Math.min(x.length, Math.round(to * sr));
    const levels = {};
    for (const [name, hz] of Object.entries(probe)) {
      const w = (2 * Math.PI * hz) / sr;
      let re = 0;
      let im = 0;
      for (let i = a; i < b; i++) {
        const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
        re += x[i] * win * Math.cos(w * i);
        im += x[i] * win * Math.sin(w * i);
      }
      levels[name] = Math.round(20 * Math.log10((Math.hypot(re, im) * 4) / (b - a) + 1e-9) * 10) / 10;
    }
    let peak = 0;
    let sum = 0;
    let bad = 0;
    for (let i = 0; i < x.length; i++) {
      if (!Number.isFinite(x[i])) bad++;
      peak = Math.max(peak, Math.abs(x[i]));
      sum = (sum * 31 + Math.round(x[i] * 1e6)) % 2147483647;
    }
    return { levels, peak, sum, bad, seconds: x.length / sr };
  }, { probe, from, to, mode });
}

const hz = (key) => 440 * Math.pow(2, (key - 69) / 12);
/** Edit the open project the way the UI does (ops through the store: optimistic, synced, undoable). */
const dispatch = (ops) => page.evaluate((o) => window.greanteadawy.store.getState().dispatch(o), ops);
const ids = () => page.evaluate(() => {
  const p = window.greanteadawy.store.getState().project;
  return { pattern: p.patterns[0].id, channels: Object.fromEntries(p.channels.map((c) => [c.name, c.id])) };
});

test('the GGS Synth is in the catalog with its presets', async () => {
  const list = await claude.call('list_instruments', { category: 'synth' });
  expect(list).toMatch(/^ggs \(GGS Synth, melodic\): presets Init, Velvet Pad, Glass Horizon/m);
});

test('a GGS channel loads its worklet and plays live, each note with its own expression inputs', async () => {
  await claude.call('create_project', { name: 'E2E GGS', bpm: 120 });
  await expect(page).toHaveTitle(/E2E GGS/);
  expect(await claude.call('add_channel', { name: 'Lead', instrument: 'ggs', preset: 'Touch Lead' })).toMatch(/ggs\/Touch Lead/);
  const live = await page.evaluate(async () => {
    const { store } = window.greanteadawy;
    const eng = await store.getState().unlockAudio();
    const ch = store.getState().project.channels.find((c) => c.name === 'Lead');
    let v = null;
    // the first notes are skipped while the worklet module loads
    for (let i = 0; i < 100 && !v; i++) { v = eng.noteOn(ch.id, 60, 0.9); if (!v) await new Promise((r) => setTimeout(r, 50)); }
    if (!v) return { started: false };
    const second = eng.noteOn(ch.id, 67, 0.9);
    // bend only the second note and press only the first: per-note AudioParams
    second.expr.pitch.setTargetAtTime(2, eng.ctx.currentTime, 0.01);
    v.expr.pressure.setTargetAtTime(1, eng.ctx.currentTime, 0.01);
    await new Promise((r) => setTimeout(r, 400));
    const level = Math.max(...eng.getLevels());
    const fx = !!eng.strips.get(ch.id).ggs?.fx;
    eng.noteOff(v);
    eng.noteOff(second);
    await new Promise((r) => setTimeout(r, 900));
    return { started: true, expr: !!v.expr && v.expr.pitch !== second.expr.pitch, level, fx, done: v.done && second.done, voices: eng.voices.size };
  });
  expect(live.started).toBe(true);
  expect(live.expr).toBe(true);
  expect(live.fx, 'the channel effects processor is attached').toBe(true);
  expect(live.level).toBeGreaterThan(0.01);
  expect(live.done, 'voices end after their release').toBe(true);
  expect(live.voices).toBe(0);
});

test('offline render: bending one note of a chord moves only that note', async () => {
  await claude.call('update_channel', { channel: 'Lead', preset: 'Init', params: { oscAPos: 0, oscARand: 0 } });
  const { pattern, channels } = await ids();
  const notes = [60, 64, 67].map((key, i) => ({ id: `chord${i}`, key, start: 0, length: 192, velocity: 0.8 }));
  await dispatch([{ type: 'notes/set', patternId: pattern, channelId: channels.Lead, notes }]);
  const probe = { C4: hz(60), E4: hz(64), F4: hz(65), G4: hz(67) };
  const plain = await renderAndProbe(probe);
  expect(plain.bad).toBe(0);
  expect(plain.levels.E4).toBeGreaterThan(-40);
  expect(plain.levels.F4).toBeLessThan(plain.levels.E4 - 25);
  // the E gets a pitch curve: up a semitone within the first tenth of the note, then held
  await dispatch([{ type: 'notes/expression', patternId: pattern, channelId: channels.Lead, notes: [{ id: 'chord1', expression: { pitch: [{ t: 0, v: 0 }, { t: 0.1, v: 1 }] } }] }]);
  const bent = await renderAndProbe(probe);
  expect(bent.levels.F4).toBeGreaterThan(plain.levels.E4 - 3);
  expect(bent.levels.E4).toBeLessThan(bent.levels.F4 - 25);
  expect(Math.abs(bent.levels.C4 - plain.levels.C4)).toBeLessThan(1);
  expect(Math.abs(bent.levels.G4 - plain.levels.G4)).toBeLessThan(1);
});

test('offline render: pressure and slide reach only their own note (through the modulation matrix)', async () => {
  const { pattern, channels } = await ids();
  // pressure silences a note (level -1), slide lifts its pitch an octave: both easy to see in a spectrum
  await claude.call('update_channel', { channel: 'Lead', params: { mod1Src: 'pressure', mod1Dst: 'level', mod1Amt: -1, mod2Src: 'timbre', mod2Dst: 'pitch', mod2Amt: 0.5 } });
  const flat = (v) => [{ t: 0, v }, { t: 1, v }];
  await dispatch([{
    type: 'notes/expression', patternId: pattern, channelId: channels.Lead,
    notes: [{ id: 'chord0', expression: { pressure: flat(1) } }, { id: 'chord1', expression: { pitch: null } }, { id: 'chord2', expression: { timbre: flat(1) } }]
  }]);
  const r = await renderAndProbe({ C4: hz(60), E4: hz(64), G4: hz(67), G5: hz(79) });
  expect(r.levels.C4, 'the pressed note is silent').toBeLessThan(r.levels.E4 - 30);
  expect(r.levels.G4, 'the slid note left its pitch').toBeLessThan(r.levels.E4 - 25);
  expect(r.levels.G5, 'and sounds an octave up').toBeGreaterThan(r.levels.E4 - 3);
});

test('offline renders repeat: two renders of unison, noise and random LFOs are the same audio', async () => {
  await claude.call('update_channel', { channel: 'Lead', preset: 'Spectral Motion', params: { noiseLevel: 0.2, lfo3Shape: 'sh' } });
  const r = await page.evaluate(async () => {
    const { store, render } = window.greanteadawy;
    const project = store.getState().project;
    const once = async () => (await render(project, { mode: 'pattern', patternId: project.patterns[0].id, loops: 1, tail: 0.5, encode: false, sampleRate: 44100 })).buffer;
    const a = await once();
    const b = await once();
    let diff = 0;
    let peak = 0;
    let first = -1;
    for (let ch = 0; ch < 2; ch++) {
      const x = a.getChannelData(ch);
      const y = b.getChannelData(ch);
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - y[i]);
        if (d > 1e-7 && first < 0) first = i;
        if (d > diff) diff = d;
        if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
      }
    }
    return { diff, peak, first, length: a.length };
  });
  expect(r.peak).toBeGreaterThan(0.01);
  // the Web Audio graph may sum voices in a different order from run to run: allow the last bit of a float
  expect(r.diff, `renders differ by ${r.diff} from sample ${r.first}`).toBeLessThan(1e-6);
});

test('a macro can be automated: the clip moves every voice of the channel', async () => {
  await claude.call('update_channel', { channel: 'Lead', preset: 'Init', params: { oscAPos: 0, oscARand: 0, mod1Src: 'macro1', mod1Dst: 'pitch', mod1Amt: 0.5 } });
  const { pattern, channels } = await ids();
  await dispatch([
    { type: 'notes/set', patternId: pattern, channelId: channels.Lead, notes: [{ id: 'm1', key: 57, start: 0, length: 192, velocity: 0.8 }] },
    { type: 'clip/add', clip: { id: 'clipA', kind: 'pattern', refId: pattern, track: 0, start: 0, length: 384 } }
  ]);
  const probe = { A3: hz(57), A4: hz(69) };
  const still = await renderAndProbe(probe, { mode: 'song' });
  expect(still.levels.A3).toBeGreaterThan(still.levels.A4 + 25);
  // macro 1 held at 1 for the whole bar: +12 semitones through the matrix
  const added = await claude.call('add_automation', { name: 'Macro up', target: { type: 'channel', channel: 'Lead', param: 'macro1' }, startBar: 1, bars: 1, points: [{ bar: 0, value: 1 }, { bar: 1, value: 1 }] }).catch((e) => e.message);
  expect(added).toMatch(/\[auto_/);
  const moved = await renderAndProbe(probe, { mode: 'song' });
  expect(moved.levels.A4).toBeGreaterThan(moved.levels.A3 + 25);
  await claude.call('remove_automation', { automation: 'Macro up' });
});

test('every instrument follows a pitch curve (the classic synth bends per note too)', async () => {
  await claude.call('add_channel', { name: 'Classic', instrument: 'synth', preset: 'Sub Bass', params: { osc2Wave: 'off', cutoff: 20000 } });
  await claude.call('update_channel', { channel: 'Lead', mute: true });
  const { pattern, channels } = await ids();
  await dispatch([{ type: 'notes/set', patternId: pattern, channelId: channels.Classic, notes: [{ id: 'c1', key: 57, start: 0, length: 192, velocity: 0.8, expression: { pitch: [{ t: 0, v: 12 }, { t: 1, v: 12 }] } }] }]);
  const r = await renderAndProbe({ A3: hz(57), A4: hz(69) });
  expect(r.levels.A4).toBeGreaterThan(r.levels.A3 + 20);
  await claude.call('update_channel', { channel: 'Lead', mute: false });
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
