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

// ---------------------------------------------------------------------------------------------- the editors

const noteState = (id) => page.evaluate((noteId) => {
  const p = window.greanteadawy.store.getState().project;
  for (const pt of p.patterns) for (const list of Object.values(pt.notes)) { const n = list.find((x) => x.id === noteId); if (n) return n; }
  return null;
}, id);

test('piano roll: shape one note of a chord in the expression lane (shape, freehand, points, undo)', async () => {
  await claude.call('update_channel', { channel: 'Lead', preset: 'Touch Lead' });
  const { pattern, channels } = await ids();
  await dispatch([{ type: 'notes/set', patternId: pattern, channelId: channels.Lead, notes: [60, 64, 67].map((key, i) => ({ id: `ui${i}`, key, start: 0, length: 192, velocity: 0.8 })) }]);
  await page.evaluate((cid) => {
    const { store } = window.greanteadawy;
    store.setState({ selectedChannelId: cid, pianoRollChannelId: cid });
    for (const w of ['playlist', 'channelRack', 'channelSettings', 'mixer']) store.getState().closeWindow(w);
    store.getState().openWindow('pianoRoll', { x: 8, y: 8, w: 1100, h: 620 });
  }, channels.Lead);
  const grid = page.locator('.pr-grid');
  await expect(grid).toBeVisible();
  await expect(page.locator('.pr-note')).toHaveCount(3);
  // pick the lane, then select the E (1 px per tick, 14 px per key by default)
  await page.locator('.pr-lane').selectOption('pitch');
  await expect(page.locator('.pr-expr-lane')).toBeVisible();
  await grid.click({ position: { x: 60, y: (127 - 64) * 14 + 7 } });
  await expect(page.locator('.pr-note.sel')).toHaveCount(1);
  await expect(page.locator('.pr-lane-hint')).toHaveText(/editing 1 selected note/);
  // a ready-made gesture goes to the selected note only
  await page.locator('.pr-shape').selectOption('bend-up');
  await expect.poll(async () => (await noteState('ui1')).expression?.pitch?.at(-1).v).toBe(2);
  expect((await noteState('ui0')).expression).toBeUndefined();
  expect((await noteState('ui2')).expression).toBeUndefined();
  await expect(page.locator('.pr-note.expr')).toHaveCount(1);
  await expect(page.locator('.pr-bends polyline')).toHaveCount(1);
  // freehand: draw the E's pressure, rising across the note
  await page.locator('.pr-lane').selectOption('pressure');
  const lane = page.locator('.pr-expr-lane');
  const box = await lane.boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height - 12);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 8 + i * 14, box.y + box.height - 12 - i * 8);
  await page.mouse.up();
  await expect.poll(async () => !!(await noteState('ui1')).expression?.pressure).toBe(true);
  const drawn = (await noteState('ui1')).expression;
  expect(drawn.pitch, 'drawing pressure keeps the pitch curve').toBeTruthy();
  expect(drawn.pressure.at(-1).v).toBeGreaterThan(drawn.pressure[0].v + 0.4);
  expect(drawn.pressure.length).toBeLessThanOrEqual(64);
  expect((await noteState('ui0')).expression).toBeUndefined();
  // points: add one, move nothing, delete it with a right-click
  await page.locator('.pr-lane').selectOption('timbre');
  await page.locator('.pr-lane-bar button', { hasText: 'Points' }).click();
  await page.mouse.click(box.x + 96, box.y + 30);
  await expect.poll(async () => (await noteState('ui1')).expression?.timbre?.length).toBe(2); // a rest point at the start + the new one
  await expect(page.locator('.pr-expr-svg .pt')).toHaveCount(2);
  const pt = (await noteState('ui1')).expression.timbre[1];
  expect(pt.t).toBeCloseTo(0.5, 1);
  expect(pt.v).toBeGreaterThan(0.6);
  await page.mouse.click(box.x + 96, box.y + 30, { button: 'right' });
  await expect.poll(async () => (await noteState('ui1')).expression?.timbre).toBeUndefined();
  // release velocity lane
  await page.locator('.pr-lane').selectOption('release');
  const rel = await page.locator('.pr-rel-lane').boundingBox();
  await page.mouse.click(rel.x + 191, rel.y + rel.height * 0.2);
  await expect.poll(async () => (await noteState('ui1')).releaseVelocity).toBeGreaterThan(0.7);
  // undo steps back through the edits (focus the grid: Ctrl+Z belongs to the project)
  await page.locator('.pr-lane-bar button', { hasText: 'Clear' }).click();
  await expect.poll(async () => (await noteState('ui1')).releaseVelocity).toBeUndefined();
  await page.evaluate(() => window.greanteadawy.store.getState().undo());
  await expect.poll(async () => (await noteState('ui1')).releaseVelocity).toBeGreaterThan(0.7);
  // a copy of the note keeps its performance (Ctrl+D duplicates the selection)
  await grid.focus();
  await page.keyboard.press('Control+d');
  await expect(page.locator('.pr-note')).toHaveCount(4);
  const copy = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    return Object.values(p.patterns[0].notes).flat().find((n) => n.key === 64 && n.start > 0);
  });
  expect(copy.expression.pitch.at(-1).v).toBe(2);
  expect(copy.expression.pressure).toBeTruthy();
});

test('synth editor: preset browser, wavetable grid, draggable filter and envelopes, matrix in words, every parameter', async () => {
  const { channels } = await ids();
  await page.evaluate(() => {
    const st = window.greanteadawy.store.getState();
    st.closeWindow('pianoRoll');
    st.openWindow('channelSettings', { x: 8, y: 8, w: 1060, h: 880 });
  });
  const ggs = page.locator('.ggs');
  await expect(ggs).toBeVisible();
  const instrument = () => page.evaluate((cid) => window.greanteadawy.store.getState().project.channels.find((c) => c.id === cid).instrument, channels.Lead);
  const param = async (key) => (await instrument()).params[key];
  const tab = (name) => ggs.locator('.ggs-tabs button', { hasText: name }).click();

  // ---- presets: search finds a patch by what it sounds like, a click loads it, arrow keys walk the list
  await ggs.locator('.ggs-presets-name').click();
  const search = ggs.locator('.ggs-browser input[type=search]');
  await expect(search).toBeFocused();
  await expect(ggs.locator('.ggs-browser li')).toHaveCount(31);
  await search.fill('glassy partials');
  await expect(ggs.locator('.ggs-browser li')).toHaveCount(1);
  await ggs.locator('.ggs-browser li', { hasText: 'Glass Horizon' }).click();
  await expect.poll(async () => (await instrument()).preset).toBe('Glass Horizon');
  expect(await param('oscATable')).toBe('glass');
  await expect(ggs.locator('.ggs-head')).toContainText('Shimmer');
  await expect(ggs.locator('.ggs-head')).toContainText('Pressure scans the glass table');
  // tags come from the patch itself: the acid preset is found by its filter
  await search.fill('acid');
  await expect(ggs.locator('.ggs-browser li b').first()).toHaveText('Acid Line');
  await search.fill('');
  await ggs.locator('.ggs-browser .chip', { hasText: 'Pads' }).click();
  await expect(ggs.locator('.ggs-browser li')).toHaveCount(5);
  await search.press('ArrowDown');
  await expect.poll(async () => (await instrument()).preset).toBe('Cinema Atmos');
  await search.press('ArrowUp');
  await expect.poll(async () => (await instrument()).preset).toBe('Glass Horizon');
  await search.press('Escape');
  await expect(ggs.locator('.ggs-browser')).toHaveCount(0);
  await ggs.locator('button[aria-label="Next preset"]').click();
  await expect.poll(async () => (await instrument()).preset).toBe('Cinema Atmos');
  await ggs.locator('button[aria-label="Previous preset"]').click();
  await expect.poll(async () => (await instrument()).preset).toBe('Glass Horizon');

  // ---- oscillators: scopes are drawn, the wavetable is picked from a grid of 46 thumbnails
  await expect(ggs.locator('.ggs-osc > .ggs-osc-top canvas')).toHaveCount(3);
  await ggs.locator('.ggs-osc').first().locator('.ggs-wt-name').click();
  const cells = ggs.locator('.ggs-wt-grid button');
  await expect(cells).toHaveCount(46);
  await cells.filter({ hasText: 'FM Bell' }).click();
  await expect.poll(() => param('oscATable')).toBe('fmbell');
  await ggs.locator('.ggs-wt-panel input[type=search]').fill('acid');
  await expect(cells).toHaveCount(1);
  await ggs.locator('.ggs-wt-panel input[type=search]').fill('');
  await ggs.locator('.ggs-wt-grid').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => param('oscATable')).not.toBe('fmbell');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => param('oscATable')).toBe('fmbell');
  await page.keyboard.press('Escape');
  await expect(ggs.locator('.ggs-wt-panel')).toHaveCount(0);
  // every control explains itself
  await expect(ggs.locator('.ggs-osc').first().locator('.knob').first()).toHaveAttribute('title', /Where in the wavetable/);

  // ---- matrix: add a route with one click, read what it does in real units, remove it
  await tab('Matrix');
  const rows = ggs.locator('.ggs-matrix tbody tr:not(.ggs-route-says)');
  const before = await rows.count();
  await ggs.locator('.ggs-matrix-quick button', { hasText: 'Vibrato by pressure' }).click();
  await expect(rows).toHaveCount(before + 1);
  await expect(ggs.locator('.ggs-route-says').last()).toHaveText('Pitch −30 ct ↔ +30 ct as LFO 1 swings −1 ↔ 1, depth scaled by pressure');
  await expect(ggs.locator('.ggs-route-says', { hasText: /^Filter 1 cutoff [\d.]+ k?Hz → [\d.]+ kHz as slide goes 0 → 1/ })).toHaveCount(1);
  const added = (await instrument()).params;
  const slot = [...Array(64)].map((_, i) => i + 1).find((i) => added[`mod${i}Src`] === 'lfo1' && added[`mod${i}Dst`] === 'pitchFine' && added[`mod${i}Via`] === 'pressure');
  expect(slot).toBeTruthy();
  await rows.last().locator('button').click();
  await expect(rows).toHaveCount(before);
  expect(await param(`mod${slot}Src`)).toBe('none');

  // ---- filters: the curve is the real response; its handle sets cutoff (x) and resonance (y); one undo per drag
  await tab('Filters');
  await expect(ggs.locator('.ggs-filter canvas')).toHaveCount(2);
  const graph = ggs.locator('.ggs-filter').first().locator('canvas');
  const g = await graph.boundingBox();
  const cutoffBefore = await param('f1Cutoff');
  const resBefore = await param('f1Res');
  await page.mouse.move(g.x + g.width / 3, g.y + 60);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + 40, { steps: 6 });
  await page.mouse.up();
  // the middle of a 20 Hz – 20 kHz log axis is 632 Hz; 20 px up of 100 adds 0.22 resonance
  await expect.poll(() => param('f1Cutoff')).toBeGreaterThan(600);
  expect(await param('f1Cutoff')).toBeLessThan(670);
  expect(await param('f1Res')).toBeCloseTo(resBefore + 0.222, 1);
  await page.evaluate(() => window.greanteadawy.store.getState().undo());
  await expect.poll(() => param('f1Cutoff')).toBe(cutoffBefore);
  expect(await param('f1Res')).toBe(resBefore);
  await graph.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => param('f1Res')).toBeCloseTo(resBefore + 0.02, 5);
  // the new models are in the menu; Morph appears under the name it has for the type
  const f1 = ggs.locator('.ggs-filter').first();
  await expect(f1.locator('.knob-label', { hasText: 'Vowel' })).toHaveCount(0);
  await f1.locator('select').selectOption('formant');
  await expect.poll(() => param('f1Type')).toBe('formant');
  await expect(f1.locator('.knob-label', { hasText: 'Vowel' })).toHaveCount(1);
  await expect(f1.locator('.ggs-filter-desc')).toContainText('tenor voice');
  await f1.locator('select').selectOption('ladder24');
  await expect(f1.locator('.ggs-filter-desc')).toContainText('Moog');
  expect(await f1.locator('select option').count()).toBe(21);

  // ---- envelopes: nodes set times and sustain, round handles bend a slope, the picture is the patch
  await tab('Modulators');
  await expect(ggs.locator('.ggs-envedit svg')).toHaveCount(4);
  await expect(ggs.locator('.ggs-lfo canvas')).toHaveCount(4);
  const env = ggs.locator('.ggs-env').first();
  const centre = async (node) => { const r = await env.locator(`[data-node="${node}"]`).boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const dragNode = async (node, dx, dy) => {
    const c = await centre(node);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + dx, c.y + dy, { steps: 5 });
    await page.mouse.up();
  };
  const [d0, s0, a0] = [await param('env1D'), await param('env1S'), await param('env1A')];
  await dragNode('decay', 25, 30);
  await expect.poll(() => param('env1D')).toBeGreaterThan(d0);
  expect(await param('env1S')).toBeLessThan(s0 - 0.2);
  expect(await param('env1A')).toBe(a0); // the stages to the left did not move
  // the node is where the pointer left it: the envelope is drawn from the same numbers
  const s1 = await param('env1S');
  await page.evaluate(() => window.greanteadawy.store.getState().undo());
  await expect.poll(() => param('env1S')).toBe(s0); // the whole drag was one step
  expect(await param('env1D')).toBe(d0);
  expect(s1).toBeLessThan(s0);
  // attack and hold share a spot while the hold is zero: dragging right adds a hold, dragging left shortens the attack
  expect(await param('env1Hold')).toBe(0);
  await dragNode('attack', 30, 0);
  await expect.poll(() => param('env1Hold')).toBeGreaterThan(0.005);
  expect(await param('env1A')).toBe(a0);
  // bending the decay: up = slower first (positive curve); double-click puts the default back
  expect(await param('env1DCurve')).toBe(-0.5);
  await dragNode('decayCurve', 0, -14);
  await expect.poll(() => param('env1DCurve')).toBeGreaterThan(-0.3);
  await env.locator('[data-node="decayCurve"]').dblclick();
  await expect.poll(() => param('env1DCurve')).toBe(-0.5);
  await env.locator('[data-node="release"]').focus();
  const r0 = await param('env1R');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => param('env1R')).toBeCloseTo(r0 * 1.1, 3);
  await expect(env.locator('.knob-label', { hasText: 'Delay' })).toHaveCount(1);

  // ---- every parameter in one table: search by what it does, type a value, see what makes the patch
  await tab('All parameters');
  const table = ggs.locator('.ggs-ptable');
  await table.locator('input[type=search]').fill('slide from the previous note');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr code')).toHaveText('glide');
  await table.locator('tbody input[type=number]').fill('0.25');
  await table.locator('tbody input[type=number]').press('Enter');
  await expect.poll(() => param('glide')).toBe(0.25);
  await expect(table.locator('tbody tr')).toHaveClass(/changed/);
  await table.locator('button[aria-label="Reset Voice Glide"]').click();
  await expect.poll(() => param('glide')).toBe(0);
  await table.locator('input[type=search]').fill('');
  await table.locator('.chip', { hasText: 'Changed' }).click();
  const changed = await table.locator('tbody tr').count();
  expect(changed).toBeGreaterThan(10);
  expect(changed).toBeLessThan(120);
  await expect(table.locator('tbody tr code', { hasText: /^f1Type$/ })).toHaveCount(1);
  await tab('Effects');
  await expect(ggs.locator('fieldset', { hasText: 'Reverb' })).toBeVisible();
  // back to a preset whose tail the next step listens to
  await page.evaluate((cid) => window.greanteadawy.store.getState().dispatch([{ type: 'channel/update', id: cid, patch: { instrument: { preset: 'Glass Horizon' } } }]), channels.Lead);
  // the touch pad plays a note whose pressure and slide follow the pointer
  const pad = ggs.locator('.ggs-pad');
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height - 10);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.greanteadawy.engine().voices.size)).toBe(1);
  await page.mouse.move(b.x + b.width - 30, b.y + 10, { steps: 5 });
  await page.waitForTimeout(250);
  const level = await page.evaluate(() => Math.max(...window.greanteadawy.engine().getLevels()));
  expect(level).toBeGreaterThan(0.005);
  await page.mouse.up();
  // Glass Horizon rings out for seconds: the voice is released, then gone
  await expect.poll(() => page.evaluate(() => [...window.greanteadawy.engine().voices].every((v) => v.noteEnd !== null))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.greanteadawy.engine().voices.size), { timeout: 15000 }).toBe(0);
});

test('modulation on the knobs: rings, a source dropped on a knob, Alt-drag for the depth, live dots, chaos, eight macros', async () => {
  const { channels } = await ids();
  const ggs = page.locator('.ggs');
  const instrument = () => page.evaluate((cid) => window.greanteadawy.store.getState().project.channels.find((c) => c.id === cid).instrument, channels.Lead);
  const routesNow = async () => {
    const p = (await instrument()).params;
    return [...Array(64)].map((_, i) => i + 1).filter((i) => p[`mod${i}Src`] !== 'none' && p[`mod${i}Dst`] !== 'none' && p[`mod${i}Amt`]).map((i) => ({ slot: i, source: p[`mod${i}Src`], target: p[`mod${i}Dst`], amount: p[`mod${i}Amt`] }));
  };
  const find = async (source, target) => (await routesNow()).find((r) => r.source === source && r.target === target);
  const tab = (name) => ggs.locator('.ggs-tabs button', { hasText: name }).click();
  await page.evaluate((cid) => window.greanteadawy.store.getState().dispatch([{ type: 'channel/update', id: cid, patch: { instrument: { preset: 'Init' } } }]), channels.Lead);
  await expect.poll(async () => (await routesNow()).length).toBe(0);

  // ---- eight macros; the ones a patch does not use are dimmed and say so
  const macros = ggs.locator('.ggs-head .knob');
  await expect(macros).toHaveCount(9); // 8 macros + gain
  await expect(ggs.locator('.ggs-head .knob.unused')).toHaveCount(8);
  // ---- the source bar: every source as a chip, none routed yet
  await expect(ggs.locator('.ggs-src')).toHaveCount(25);
  await expect(ggs.locator('.ggs-src.used')).toHaveCount(0);

  // ---- drop a source on a knob: a route appears, the knob gets a ring, its own value stays
  await tab('Filters');
  const cutoff = ggs.locator('.ggs-filter').first().locator('.knob').first();
  await expect(cutoff).toHaveClass(/assignable/);
  await expect(cutoff.locator('.knob-ring')).toHaveCount(0);
  const before = (await instrument()).params.f1Cutoff;
  await ggs.locator('.ggs-src[data-source="lfo1"]').dragTo(cutoff);
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff'))?.amount).toBe(0.25);
  await expect(cutoff.locator('.knob-ring')).toHaveCount(1);
  await expect(cutoff).toHaveAttribute('title', /Modulated by LFO 1\. Alt-drag: depth of LFO 1/);
  await expect(ggs.locator('.ggs-src[data-source="lfo1"]')).toHaveClass(/used/);
  expect((await instrument()).params.f1Cutoff).toBe(before);
  // dropping the same source again does not add a second route
  await ggs.locator('.ggs-src[data-source="lfo1"]').dragTo(cutoff);
  expect((await routesNow()).length).toBe(1);

  // ---- Alt-drag changes the depth of that route, a plain drag still turns the knob
  const box = await cutoff.locator('svg').boundingBox();
  const drag = async (dy, alt) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 4 });
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  };
  await drag(-32, true); // 32 px of 160 = 0.2 of the knob's travel
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff')).amount).toBeCloseTo(0.45, 2);
  expect((await instrument()).params.f1Cutoff).toBe(before);
  await drag(-140, true);
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff')).amount).toBe(1); // it stops at the end
  await drag(250, true); // through zero and out the other side: the route does not vanish on the way
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff'))?.amount).toBeLessThan(-0.4);
  await page.evaluate(() => window.greanteadawy.store.getState().undo());
  // moves of one control in a row are one undo step, as for every knob: back to the depth it was dropped with
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff')).amount).toBe(0.25);
  await drag(-160, true);
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff')).amount).toBe(1);
  await drag(20, false);
  await expect.poll(async () => (await instrument()).params.f1Cutoff).toBeLessThan(before);

  // ---- the knob's menu: add a second source, pick which one Alt-drag moves, remove one
  await cutoff.click({ button: 'right' });
  const menu = page.locator('.context-menu');
  await expect(menu.locator('.cm-header')).toHaveText('Filter 1 cutoff');
  await menu.locator('.cm-item', { hasText: 'Modulate with' }).hover();
  await menu.locator('.cm-item', { hasText: /^Chaos$/ }).hover();
  await menu.locator('.cm-item', { hasText: 'Chaos 1' }).click();
  await expect.poll(async () => (await find('chaos1', 'f1Cutoff'))?.amount).toBe(0.25);
  await expect(cutoff.locator('.knob-ring')).toHaveCount(2);
  await drag(-16, true); // the route just added is the one Alt-drag moves
  await expect.poll(async () => (await find('chaos1', 'f1Cutoff')).amount).toBeCloseTo(0.35, 2);
  expect((await find('lfo1', 'f1Cutoff')).amount).toBe(1);
  await cutoff.click({ button: 'right' });
  await menu.locator('.cm-item', { hasText: 'LFO 1' }).hover();
  await menu.locator('.cm-item', { hasText: 'Remove' }).click();
  await expect.poll(async () => (await find('lfo1', 'f1Cutoff'))).toBeUndefined();
  await expect(cutoff.locator('.knob-ring')).toHaveCount(1);
  // a control that is not a modulation target has no ring, no drop zone
  await expect(ggs.locator('.ggs-filter').first().locator('.knob', { hasText: 'Key track' })).not.toHaveClass(/assignable/);

  // ---- a macro: route macro 5 from its chip; it is named after what it moves and is no longer dimmed
  await ggs.locator('.ggs-src[data-source="macro5"]').dragTo(ggs.locator('.ggs-filter').first().locator('.knob', { hasText: 'Resonance' }));
  await expect.poll(async () => (await find('macro5', 'f1Res'))?.amount).toBe(0.25);
  await expect(ggs.locator('.ggs-head .knob .knob-label', { hasText: 'F1 res' })).toHaveCount(1);
  await expect(ggs.locator('.ggs-head .knob.unused')).toHaveCount(7);

  // ---- live: hold a note and the dot on the modulated knob follows the chaos, the chips show their sources
  await page.evaluate((cid) => window.greanteadawy.store.getState().dispatch([{ type: 'channel/update', id: cid, patch: { instrument: { params: { chaos1Type: 'rossler', chaos1Rate: 8 } } } }]), channels.Lead);
  const live = () => page.evaluate((cid) => { const v = window.greanteadawy.engine().ggsLive(cid); return v ? Array.from(v) : null; }, channels.Lead);
  expect(await live()).toBeNull();
  const dot = cutoff.locator('.knob-live');
  await expect(dot).toBeHidden();
  const pad = ggs.locator('.ggs-pad');
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.2);
  await page.mouse.down();
  await expect.poll(async () => (await live())?.length).toBe(26 + 40); // every source, then every target
  await expect(dot).toBeVisible();
  const where = async () => `${await dot.getAttribute('cx')},${await dot.getAttribute('cy')}`;
  const first = await where();
  await expect.poll(where).not.toBe(first); // it moves: chaos at 8 Hz
  // the report says what the voice is doing: velocity 0.8, pressure from the pad, the chaos value in −1…1
  const SRC = { velocity: 9, pressure: 10, chaos1: 24 };
  const v = await live();
  expect(v[SRC.velocity]).toBeCloseTo(0.8, 2);
  expect(v[SRC.pressure]).toBeGreaterThan(0.6);
  expect(Math.abs(v[SRC.chaos1])).toBeLessThanOrEqual(1);
  const meter = ggs.locator('.ggs-src[data-source="pressure"] .ggs-meter i');
  await expect.poll(async () => parseFloat(await meter.evaluate((el) => el.style.width))).toBeGreaterThan(60);
  await page.mouse.up();
  await expect.poll(live, { timeout: 8000 }).toBeNull(); // the note ends: nothing is live any more
  await expect(dot).toBeHidden();

  // ---- modulators: two chaos generators with their own controls
  await tab('Modulators');
  await expect(ggs.locator('.ggs-chaos')).toHaveCount(2);
  const chaos2 = ggs.locator('.ggs-chaos').nth(1);
  await expect(chaos2).toHaveClass(/idle/);
  await expect(chaos2.locator('.knob-label', { hasText: 'Steps' })).toHaveCount(0);
  await chaos2.locator('select').first().selectOption('turing');
  await expect(chaos2.locator('.knob-label', { hasText: 'Steps' })).toHaveCount(1);
  await expect(chaos2.locator('.knob-label', { hasText: 'Mutation' })).toHaveCount(1);
  await expect(chaos2.locator('.cs-desc')).toContainText('shift register');

  // ---- the matrix: a chip opens it filtered to that source; 64 slots
  await ggs.locator('.ggs-src[data-source="chaos1"]').click();
  await expect(ggs.locator('.ggs-tabs button.on')).toHaveText(/Matrix/);
  const rows = ggs.locator('.ggs-matrix tbody tr:not(.ggs-route-says)');
  await expect(rows).toHaveCount(1);
  await expect(ggs.locator('.ggs-matrix .ggs-ptable-count')).toHaveText('1 of 2 routes · 2/64 slots');
  await expect(ggs.locator('.ggs-route-says')).toContainText('as Chaos 1 swings −1 ↔ 1');
  await ggs.locator('.ggs-matrix input[type=search]').fill('');
  await expect(rows).toHaveCount(2);
  await ggs.locator('.ggs-matrix-quick button', { hasText: 'Analog drift' }).click();
  await expect.poll(async () => (await find('chaos2', 'pitchFine'))?.amount).toBe(0.06);
  await page.evaluate((cid) => window.greanteadawy.store.getState().dispatch([{ type: 'channel/update', id: cid, patch: { instrument: { preset: 'Glass Horizon' } } }]), channels.Lead);
});

test('chaos renders the same every time, and macro 8 automates', async () => {
  const { channels } = await ids();
  await claude.call('update_channel', { channel: 'Lead', preset: 'Init', params: { oscAPos: 0, oscARand: 0, f1On: false } });
  await claude.call('set_synth_chaos', { channel: 'Lead', chaos: 1, type: 'lorenz', rate: 6 });
  await claude.call('set_synth_modulation', { channel: 'Lead', mode: 'replace', routes: [{ source: 'chaos1', target: 'pitch', amount: 0.25 }] });
  const render = () => page.evaluate(async () => {
    const { store, render } = window.greanteadawy;
    const project = store.getState().project;
    const r = await render(project, { mode: 'pattern', patternId: project.patterns[0].id, loops: 1, tail: 0.2, encode: false, sampleRate: 44100 });
    return Array.from(r.buffer.getChannelData(0).subarray(0, 44100));
  });
  const a = await render();
  const b = await render();
  let worst = 0;
  let peak = 0;
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(a[i])); }
  expect(peak).toBeGreaterThan(0.05);
  expect(worst).toBeLessThan(1e-6);
  // without the chaos the same notes are a different sound
  await claude.call('set_synth_modulation', { channel: 'Lead', mode: 'replace', routes: [{ source: 'macro8', target: 'pitch', amount: 0.5 }] });
  const plain = await render();
  let differs = 0;
  for (let i = 0; i < a.length; i++) differs = Math.max(differs, Math.abs(a[i] - plain[i]));
  expect(differs).toBeGreaterThan(0.05);
  // macro 8 is an automation target like the first four: held at 1 it lifts the pitch an octave
  expect(await claude.call('add_automation', { name: 'Eight', target: { type: 'channel', channel: 'Lead', param: 'macro8' }, startBar: 1, bars: 1, points: [{ bar: 0, value: 1 }, { bar: 1, value: 1 }] })).toMatch(/Added automation "Eight"/);
  const key = await page.evaluate((cid) => { const p = window.greanteadawy.store.getState().project; return Object.values(p.patterns[0].notes[cid])[0].key; }, channels.Lead);
  const up = await renderAndProbe({ base: hz(key), octave: hz(key + 12) }, { mode: 'song', from: 0.05, to: 0.3 });
  expect(up.levels.octave).toBeGreaterThan(up.levels.base + 20);
  await page.evaluate(() => { const st = window.greanteadawy.store.getState(); st.dispatch(st.project.automations.map((x) => ({ type: 'automation/remove', id: x.id }))); });
});

test('Claude designs a patch, performs it note by note and the browser renders the result', async () => {
  await claude.call('create_project', { name: 'E2E Agent', bpm: 100, key: 'D', scale: 'minor' });
  await expect(page).toHaveTitle(/E2E Agent/);
  expect(await claude.call('create_synth_patch', { name: 'Glass Pad', preset: 'Glass Horizon' })).toMatch(/Created GGS Synth "Glass Pad"/);
  expect(await claude.call('create_synth_patch', {
    name: 'Agent Lead',
    patch: {
      oscillators: [{ id: 'A', table: 'tilt', position: 0.5, unison: 2, detune: 8 }, { id: 'B', table: 'fmbell', position: 0.2, level: 0.25, octave: 1 }],
      filters: [{ id: 1, type: 'lp24', cutoff: 1400, resonance: 0.2, keyTrack: 0.5 }],
      envelopes: [{ id: 1, attack: 0.01, decay: 0.4, sustain: 0.8, release: 0.3 }],
      lfos: [{ id: 1, shape: 'sine', rate: 5.5, fade: 0.2 }],
      modulation: [{ source: 'pressure', target: 'f1Cutoff', amount: 0.3 }, { source: 'timbre', target: 'oscAPos', amount: 0.4 }, { source: 'lfo1', target: 'pitchFine', amount: 0.3, via: 'pressure' }],
      effects: { delay: { mix: 0.2, sync: '1/8d' }, reverb: { mix: 0.25, size: 0.6 } }
    }
  })).toMatch(/Osc A: tilt @ 0\.5[\s\S]*pressure→f1Cutoff \+0\.3/);
  // the new channel reaches the open studio live
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().project.channels.map((c) => `${c.name}:${c.instrument.kind}`))).toEqual(['Glass Pad:ggs', 'Agent Lead:ggs']);
  expect(await claude.call('analyze_synth_patch', { channel: 'Agent Lead', notes: ['D4'] })).toMatch(/Pitch: D4/);
  await claude.call('create_pattern', { name: 'Theme', bars: 2 });
  await claude.call('add_chords', { pattern: 'Theme', channel: 'Glass Pad', chords: ['Dm', 'Bb'], octave: 4 });
  await claude.call('add_notes', {
    pattern: 'Theme', channel: 'Agent Lead',
    notes: [
      { note: 'D5', start: 0, length: 8, expression: { pitch: { shape: 'scoop', depth: 1 }, pressure: { shape: 'swell', peak: 0.9 } } },
      { note: 'F5', start: 8, length: 8 }, { note: 'A5', start: 16, length: 12, releaseVelocity: 0.8 }
    ]
  });
  const shaped = await claude.call('set_note_expression', { pattern: 'Theme', channel: 'Agent Lead', note: 'A5', pitch: { shape: 'vibrato', rateHz: 5.5, depth: 0.3 }, timbre: { shape: 'ramp', to: 0.9 } });
  expect(shaped).toMatch(/Shaped 1 note\(s\)[\s\S]*A5[\s\S]*pitch[\s\S]*timbre 0→0\.9/);
  expect(shaped).not.toMatch(/does not route/);
  await claude.call('place_pattern', { pattern: 'Theme', startBar: 1, bars: 2 });
  // the performance is in the browser's project, live
  await expect.poll(() => page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    return Object.values(p.patterns.find((x) => x.name === 'Theme').notes).flat().filter((n) => n.expression).length;
  })).toBe(2);
  expect(await claude.call('evaluate_composition')).toMatch(/0 issue\(s\)/);
  // the browser renders it: mix report with a stem per synth, and a single-note analysis through the channel strip
  const report = await claude.call('render_mix', { stems: true });
  expect(report).not.toMatch(/INVALID RENDER|NaN/);
  expect(report).toMatch(/LUFS integrated/);
  expect(report).toMatch(/Glass Pad[^\n]*LUFS/);
  expect(report).toMatch(/Agent Lead[^\n]*LUFS/);
  expect(await claude.call('analyze_sound', { channel: 'Agent Lead', note: 'A4' })).toMatch(/Pitch: A4 \(4[34]\d/);
});

test('MPE input: each note of a chord gets its own bend, pressure and slide — live, and recorded as curves', async () => {
  const r = await page.evaluate(async () => {
    const { store, midi, engine } = window.greanteadawy;
    const st = store.getState();
    await st.unlockAudio();
    const lead = st.project.channels.find((c) => c.name === 'Agent Lead');
    const pat = st.project.patterns.find((p) => p.name === 'Theme');
    store.setState({ selectedChannelId: lead.id, selectedPatternId: pat.id, mode: 'pattern', recording: true, recordQuantize: false });
    const before = pat.notes[lead.id].length;
    store.getState().togglePlay();
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    await wait(250);
    const bend = (ch, semis) => { const v = Math.min(16383, Math.round(8192 + (semis / 48) * 8192)); return [0xe0 | ch, v & 127, (v >> 7) & 127]; };
    // an MPE controller: one note per MIDI channel (2 and 3 here)
    midi([0x91, 62, 100]);
    midi([0x92, 65, 90]);
    await wait(120);
    // held live (no note end yet), next to the pattern's own notes that are playing
    const live = [...engine().voices].filter((v) => v.expr && v.noteEnd === null).length;
    for (let i = 1; i <= 8; i++) {
      midi(bend(1, i * 0.25)); // the D bends up two semitones
      midi([0xd2, i * 15]); // the F is pressed harder
      midi([0xb2, 74, 127 - i * 12]); // … and slides back
      await wait(40);
    }
    midi([0x81, 62, 120]); // let go fast
    midi([0x82, 65, 30]); // let go slowly
    await wait(150);
    store.getState().stop();
    store.setState({ recording: false });
    const list = store.getState().project.patterns.find((p) => p.name === 'Theme').notes[lead.id];
    return { live, added: list.length - before, d: list.find((n) => n.key === 62 && n.expression?.pitch), f: list.find((n) => n.key === 65 && n.expression?.pressure) };
  });
  expect(r.live, 'both notes sound with expression inputs').toBe(2);
  expect(r.added).toBe(2);
  // the D: only a pitch curve, rising to two semitones; released fast
  expect(Object.keys(r.d.expression)).toEqual(['pitch']);
  expect(r.d.expression.pitch[0].v).toBe(0);
  expect(r.d.expression.pitch.at(-1).v).toBeCloseTo(2, 1);
  expect(r.d.releaseVelocity).toBeGreaterThan(0.9);
  // the F: pressure up, slide down, no bend; released slowly
  expect(Object.keys(r.f.expression).sort()).toEqual(['pressure', 'timbre']);
  expect(r.f.expression.pressure.at(-1).v).toBeCloseTo(120 / 127, 1);
  expect(r.f.expression.timbre.at(-1).v).toBeLessThan(0.35);
  expect(r.f.releaseVelocity).toBeLessThan(0.3);
  for (const c of [r.d.expression.pitch, r.f.expression.pressure, r.f.expression.timbre]) expect(c.length).toBeLessThanOrEqual(64);
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
