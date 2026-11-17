// The studio's DSP effects and the engine instruments in a real browser: added from the mixer and by Claude, heard
// in a render (the worklet runs them), and measured there — a true-peak ceiling that holds, notes that are in tune.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
const errors = [];
const project = () => page.evaluate(() => window.greanteadawy.store.getState().project);
const STUDIO = ['maximizer', 'ott', 'transient', 'trancegate', 'algoverb', 'shimmer', 'resonator', 'flanger', 'tremolo', 'ringmod', 'freqshift', 'lofi', 'disperser', 'utility'];
/** "…, peak -5.8 dBFS, true peak -5.8 dBTP, …" → { lufs, peak, truePeak }. */
function levels(report) {
  const num = (re) => Number((re.exec(report) || [])[1]);
  return { lufs: num(/Loudness: (-?[\d.]+) LUFS/), peak: num(/peak (-?[\d.]+) dBFS/), truePeak: num(/true peak (-?[\d.]+) dBTP/) };
}

test.beforeAll(async ({ browser, baseURL }) => {
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
  await claude.call('create_project', { name: 'Studio fx e2e', template: 'empty', key: 'A', scale: 'minor', bpm: 120 });
  await expect(page).toHaveTitle(/Studio fx e2e/);
  await claude.call('add_channel', { name: 'Keys', instrument: 'synth' });
  await claude.call('add_channel', { name: 'Kick', instrument: 'kick' });
  await claude.call('create_pattern', { name: 'A', bars: 2 });
  await claude.call('add_notes', { pattern: 'A', channel: 'Keys', text: '1.1 A3+C4+E4 1/2; 1.3 F3+A3+C4 1/2; 2.1 G3+B3+D4 1/1' });
  await claude.call('write_drums', { pattern: 'A', tracks: { Kick: 'x---x---x---x---x---x---x---x---' } });
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

test('the mixer lists the effects by purpose; one added from the menu has its controls, and undo takes it away', async () => {
  await page.evaluate(() => window.greanteadawy.store.getState().openWindow('mixer'));
  const mixer = page.locator('.window.mixer');
  await expect(mixer).toBeVisible();
  await mixer.locator('.strip').nth(1).click();
  const add = mixer.locator('select.add-fx');
  expect(await add.locator('optgroup').evaluateAll((els) => els.map((e) => e.label))).toEqual(['Dynamics', 'EQ & filter', 'Space', 'Modulation', 'Colour', 'Tools']);
  expect(await add.locator('optgroup[label="Space"] option').allTextContents()).toEqual(['Reverb', 'Algorithmic Reverb', 'Shimmer Reverb', 'Delay', 'Resonator']);
  await add.selectOption('algoverb');
  const slot = mixer.locator('.fx-slot').filter({ hasText: 'Algorithmic Reverb' });
  await expect(slot).toBeVisible();
  await expect.poll(async () => (await project()).mixer[1].effects.map((e) => e.type)).toEqual(['algoverb']);
  // its settings come from the effect's own definitions: a voicing to choose, a decay in seconds, a freeze switch
  await expect(slot).toContainText('Voicing');
  await expect(slot).toContainText('Decay');
  await expect(slot).toContainText('Freeze');
  await slot.locator('select').first().selectOption('cathedral');
  await expect.poll(async () => (await project()).mixer[1].effects[0].params.voicing).toBe('cathedral');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await project()).mixer[1].effects[0].params.voicing).toBe('hall');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await project()).mixer[1].effects.length).toBe(0);
});

test('every studio effect runs in the worklet: a render with it is sound, and each one that should change it does', async () => {
  test.setTimeout(240_000);
  const dry = levels(await claude.call('render_mix', { stems: false }));
  expect(dry.lufs).toBeLessThan(-6);
  expect(dry.lufs).toBeGreaterThan(-40);
  // settings that are heard on a chord and a kick (at rest, the transient shaper and the utility change nothing)
  const heard = {
    maximizer: { gain: 12, ceiling: -3 }, ott: { depth: 1 }, transient: { attack: 1, sustain: -1 }, trancegate: { depth: 1, rate: '1/8' },
    algoverb: { mix: 0.6, decay: 3 }, shimmer: { mix: 0.6 }, resonator: { mix: 0.8, root: 45, chord: 'minor' }, flanger: { feedback: 0.8, mix: 0.5 },
    tremolo: { depth: 1, rate: 6 }, ringmod: { freq: 300 }, freqshift: { range: '100', amount: 0.7 }, lofi: { bits: 5, rate: 4000 },
    disperser: { amount: 1, freq: 200 }, utility: { gain: -6 }
  };
  for (const type of STUDIO) {
    const added = await claude.call('add_effect', { insert: 0, type, params: heard[type] });
    const id = /\[(fx_\w+)\]/.exec(added)[1];
    const wet = levels(await claude.call('render_mix', { stems: false }));
    expect(Number.isFinite(wet.lufs) && Number.isFinite(wet.peak), `${type}: ${JSON.stringify(wet)}`).toBe(true);
    expect(wet.lufs, `${type} is sound`).toBeGreaterThan(-45);
    expect(wet.peak, `${type} does not run away`).toBeLessThan(6);
    expect(Math.abs(wet.lufs - dry.lufs) + Math.abs(wet.peak - dry.peak), `${type} changes the render: ${JSON.stringify(wet)} against ${JSON.stringify(dry)}`).toBeGreaterThan(0.15);
    await claude.call('remove_effect', { insert: 0, effectId: id });
  }
  // (the last removal reaches this tab over the socket a moment after the tool call has answered)
  await expect.poll(async () => (await project()).mixer[0].effects.map((e) => e.type).filter((t) => STUDIO.includes(t))).toEqual([]);
  // taken away again, the render is what it was
  const again = levels(await claude.call('render_mix', { stems: false }));
  expect(Math.abs(again.lufs - dry.lufs)).toBeLessThan(0.15);
});

test('the true-peak limiter holds its ceiling in a render, between the samples too', async () => {
  test.setTimeout(120_000);
  // pushed 14 dB into a ceiling of −1 dB, in place of the old limiter
  const master = (await project()).mixer[0];
  for (const fx of master.effects) await claude.call('remove_effect', { insert: 0, effectId: fx.id });
  const loud = levels(await claude.call('render_mix', { stems: false }));
  await claude.call('add_effect', { insert: 0, type: 'maximizer', params: { gain: 14, ceiling: -1 } });
  const held = levels(await claude.call('render_mix', { stems: false }));
  expect(held.truePeak, `true peak ${held.truePeak} dBTP`).toBeLessThanOrEqual(-0.8);
  expect(held.truePeak).toBeGreaterThan(-2.5);
  expect(held.lufs, 'and it is louder').toBeGreaterThan(loud.lufs + 5);
  // the same render twice is the same audio (to the tolerance a browser allows)
  const a = await claude.call('render_mix', { stems: false });
  const b = await claude.call('render_mix', { stems: false });
  expect(levels(a)).toEqual(levels(b));
  // its settings in the mixer: the list Claude reads says what each does
  const one = await claude.call('list_effects', { type: 'maximizer' });
  expect(one).toContain('"key": "ceiling"');
  expect(one).toContain('"key": "truePeak"');
  const all = await claude.call('list_effects', {});
  expect(all.length).toBeLessThan(12000);
  for (const type of STUDIO) expect(all).toContain(`${type} (`);
  expect(all).toContain('## Dynamics');
});

test('Analog, Additive and Modal: in the Browser, with their presets and settings, and in tune in a render', async () => {
  test.setTimeout(180_000);
  for (const label of ['Analog', 'Additive', 'Modal']) await expect(page.locator('aside.browser').getByText(label, { exact: true }).first()).toBeVisible();
  const cents = async (channel, note) => Number(/([+-]?\d+(?:\.\d+)?) cents/.exec(await claude.call('analyze_sound', { channel, note, lengthSteps: 12, seconds: 1.5 }))[1]);
  expect(await claude.call('add_channel', { name: 'Ana', instrument: 'analog', preset: 'Sine Sub' })).toMatch(/\(analog\/Sine Sub\)/);
  expect(await claude.call('add_channel', { name: 'Glass', instrument: 'additive', preset: 'Soft Sine Keys' })).toMatch(/\(additive\/Soft Sine Keys\)/);
  expect(await claude.call('add_channel', { name: 'Bars', instrument: 'modal', preset: 'Vibraphone' })).toMatch(/\(modal\/Vibraphone\)/);
  for (const name of ['Ana', 'Glass', 'Bars']) expect(Math.abs(await cents(name, 'A3')), `${name} on A3`).toBeLessThan(5);
  // they follow the project's tuning: the major third of just intonation on A is 13.7 cents under the tempered one
  await claude.call('set_tuning', { system: 'just', root: 'A' });
  for (const name of ['Ana', 'Glass', 'Bars']) expect(Math.abs(await cents(name, 'C#4') + 13.7), `${name}: C#4 in just intonation`).toBeLessThan(4);
  await claude.call('set_tuning', { system: 'equal' });
  // channel settings: the instrument's own groups of knobs, and a preset from its list
  await page.evaluate(() => { const st = window.greanteadawy.store.getState(); st.selectChannel(st.project.channels.find((c) => c.name === 'Ana').id); st.openWindow('channelSettings'); });
  const settings = page.locator('[data-window="channelSettings"]');
  await expect(settings).toBeVisible();
  for (const text of ['Oscillators', 'Filter', 'Sync', 'Cutoff', 'Resonance']) await expect(settings).toContainText(text);
  await settings.locator('select').filter({ has: page.locator('option', { hasText: 'Sync Lead' }) }).first().selectOption({ label: 'Sync Lead' });
  await expect.poll(async () => (await project()).channels.find((c) => c.name === 'Ana').instrument.params.sync).toBe(true);
  // a hard-synced note still plays the note of oscillator 1, though oscillator 2 is tuned a fifth above and swept
  // (the preset has vibrato, and a pitch tracker reads a swept sync tone to within a quarter of a semitone)
  expect(Math.abs(await cents('Ana', 'A3'))).toBeLessThan(30);
  // a note played from the piano keys of the channel sounds without errors (live voices, not a render)
  await page.evaluate(async () => { const e = window.greanteadawy.engine(); const st = window.greanteadawy.store.getState(); for (const name of ['Ana', 'Glass', 'Bars']) e.preview(st.project.channels.find((c) => c.name === name).id, 57, 0.8, 0.3); });
  await page.waitForTimeout(700);
  // Claude changes a setting; an unknown one is refused with the valid ones
  expect(await claude.call('update_channel', { channel: 'Bars', params: { structure: 'bell', decay: 6 } })).toMatch(/Bars/);
  expect((await project()).channels.find((c) => c.name === 'Bars').instrument.params.structure).toBe('bell');
  await expect(claude.call('update_channel', { channel: 'Bars', params: { structure: 'gong' } })).rejects.toThrow(/structure/);
});

test('GGS Synth: the unison law, the stack and the drive rate are in the editor and in Claude\'s tools', async () => {
  test.setTimeout(120_000);
  await claude.call('add_channel', { name: 'Super', instrument: 'ggs', preset: 'Init' });
  const said = await claude.call('set_synth_oscillator', { channel: 'Super', oscillator: 'A', unison: 16, detune: 60, unisonLaw: 'super', stack: 'octave', unisonTable: 0.25 });
  expect(said).toMatch(/16× unison \(60 ct, super law, octave stack, spread 0\.25 over the table\)/);
  expect(await claude.call('set_synth_effect', { channel: 'Super', drive: { amount: 0.5, type: 'hard', oversampling: '8x' } })).toMatch(/drive hard 0\.5 at 8x/);
  const p = (await project()).channels.find((c) => c.name === 'Super').instrument.params;
  expect([p.oscAUnison, p.oscAUniLaw, p.oscAStack, p.oscAUniPos, p.driveOs]).toEqual([16, 'super', 'octave', 0.25, '8x']);
  await expect(claude.call('set_synth_oscillator', { channel: 'Super', oscillator: 'A', unison: 17 })).rejects.toThrow(/unison/);
  // sixteen copies in an octave stack render, in tune, at a sane level
  const report = await claude.call('analyze_sound', { channel: 'Super', note: 'A3', lengthSteps: 12, seconds: 1.5 });
  expect(Math.abs(Number(/([+-]?\d+(?:\.\d+)?) cents/.exec(report)[1]))).toBeLessThan(25);
  // the editor shows them
  await page.evaluate(() => { const st = window.greanteadawy.store.getState(); st.selectChannel(st.project.channels.find((c) => c.name === 'Super').id); st.openWindow('channelSettings'); });
  const editor = page.locator('[data-window="channelSettings"]');
  await expect(editor).toContainText('Uni law');
  await expect(editor).toContainText('Stack');
  await expect(editor).toContainText('Uni table');
});

test('found by the review: the first note played by hand sounds, and an effect switched back on has let go of its tail', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  // a fresh page: no audio worklet loaded yet, as when the studio has just been opened
  const fresh = await browser.newPage();
  const fails = [];
  fresh.on('pageerror', (e) => fails.push(e.message));
  try {
    await fresh.goto('/');
    await fresh.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
    const other = await connectMcp(baseURL);
    await other.call('create_project', { name: 'First note', template: 'empty', bpm: 120 });
    await other.call('add_channel', { name: 'Solo', instrument: 'analog', preset: 'Saw Bass' });
    await other.call('add_effect', { insert: 1, type: 'algoverb', params: { decay: 8, mix: 1 } });
    await other.close();
    await fresh.goto('/');
    await expect(fresh).toHaveTitle(/First note/);
    const heard = await fresh.evaluate(async () => {
      const { store } = window.greanteadawy;
      const eng = await store.getState().unlockAudio();
      const buf = new Float32Array(2048);
      /** The loudest sample at the master output over `ms`. */
      const listen = async (ms) => {
        let peak = 0;
        const end = performance.now() + ms;
        while (performance.now() < end) {
          eng.analyser.getFloatTimeDomainData(buf);
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
          await new Promise((res) => setTimeout(res, 15));
        }
        return peak;
      };
      const st = () => store.getState();
      const ch = st().project.channels.find((c) => c.name === 'Solo');
      const fx = st().project.mixer[1].effects[0];
      const enable = (enabled) => st().dispatch([{ type: 'effect/update', index: 1, effectId: fx.id, patch: { enabled } }]);
      // the reverb is off for the first part: the note is heard as it is
      enable(false);
      // (the studio has had a moment to get ready, as it has before anyone reaches for a key)
      await new Promise((res) => setTimeout(res, 1500));
      const v = eng.noteOn(ch.id, 45, 0.9);
      const first = await listen(400);
      v?.release(eng.ctx.currentTime + 0.02);
      await new Promise((res) => setTimeout(res, 600));
      // now through the reverb: a note, its tail starts — the reverb is switched off, and on again 1.5 s later
      enable(true);
      await new Promise((res) => setTimeout(res, 300));
      const w = eng.noteOn(ch.id, 45, 0.9);
      await new Promise((res) => setTimeout(res, 300));
      w?.release(eng.ctx.currentTime + 0.02);
      await new Promise((res) => setTimeout(res, 500));
      const tail = await listen(200);
      enable(false);
      await new Promise((res) => setTimeout(res, 1500));
      enable(true);
      await new Promise((res) => setTimeout(res, 120));
      const after = await listen(400);
      return { first, tail, after, voice: !!v };
    });
    expect(heard.voice).toBe(true);
    expect(heard.first, 'the first note played by hand is heard').toBeGreaterThan(0.01);
    expect(heard.tail, 'the reverb rings after the note').toBeGreaterThan(0.003);
    // (it would be about a third of `tail` 1.6 s into an 8 s decay, had the reverb kept what it held)
    expect(heard.after, `switched off and on again, the old tail is gone: ${JSON.stringify(heard)}`).toBeLessThan(heard.tail * 0.05);
    expect(fails).toEqual([]);
  } finally {
    await fresh.close();
  }
});

test('no uncaught errors in the browser', async () => {
  expect(errors).toEqual([]);
});
