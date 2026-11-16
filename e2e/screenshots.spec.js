// Regenerates the README screenshots in docs/screenshots/. Skipped during normal test runs.
//   npm run screenshots
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { packPlugin } from '../scripts/pack-plugin.mjs';
import { ADMIN, connectMcp, makeWav, menuItem, voiceWav, chromiumPath } from './helpers.js';

const OUT = 'docs/screenshots';
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 (npm run screenshots) to regenerate README images');
test.describe.configure({ mode: 'serial' });
test.use({
  viewport: { width: 1600, height: 940 },
  deviceScaleFactor: 1,
  // the recorder screenshot records from Chromium's fake microphone
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...chromiumPath }
});

/** Lay out the studio windows (x, y, w, h) and close the rest. */
async function layout(page, wins, extra = {}) {
  await page.evaluate(({ wins, extra }) => {
    const s = window.greanteadawy.store;
    const st = s.getState();
    const windows = { ...st.windows };
    for (const k of Object.keys(windows)) windows[k] = { ...windows[k], open: false, max: false };
    let z = 1;
    for (const [k, [x, y, w, h]] of Object.entries(wins)) windows[k] = { ...windows[k], open: true, x, y, w, h, z: z++, max: false };
    s.setState({ windows, zTop: z, ...extra });
  }, { wins, extra });
  await page.waitForTimeout(350);
}

test('README screenshots', async ({ browser, baseURL }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();

  // 1. first-run setup screen
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /create the admin account/i })).toBeVisible();
  const inputs = page.locator('.auth-field input');
  await inputs.nth(0).fill(ADMIN.displayName);
  await inputs.nth(1).fill(ADMIN.username);
  await page.screenshot({ path: `${OUT}/setup.png` });
  await page.locator('input[type=password]').nth(0).fill(ADMIN.password);
  await page.locator('input[type=password]').nth(1).fill(ADMIN.password);
  await page.getByRole('button', { name: /create admin/i }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  await page.waitForFunction(() => window.greanteadawy?.store.getState().project);

  // Claude adds a sample-based layer and a melody, so the activity log has content
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.getByTestId('sample-file-input').setInputFiles([
    { name: 'Vinyl Pluck C4.wav', mimeType: 'audio/wav', buffer: makeWav({ freq: 261.63, seconds: 0.9 }) },
    { name: 'Sub Hit A1.wav', mimeType: 'audio/wav', buffer: makeWav({ freq: 55, seconds: 1.1, channels: 1 }) }
  ]);
  await expect(page.locator('.br-item.sample')).toHaveCount(2);
  const claude = await connectMcp(baseURL);
  await claude.call('get_studio_status');
  await claude.call('list_samples');
  await claude.call('set_mixer', { insert: 1, volumeDb: -1.5 });
  await claude.call('save_version', { name: 'Before mixdown' });
  await claude.call('render_mix', { stems: true });
  await claude.close();

  // 2. hero: playlist + channel rack + piano roll, playing in song mode
  const ids = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    return { hat: p.channels.find((c) => c.name === 'Hat')?.id, drums: p.patterns.find((x) => x.name === 'Drums')?.id };
  });
  await layout(page, {
    playlist: [8, 8, 1310, 370],
    channelRack: [8, 388, 800, 300],
    pianoRoll: [818, 388, 500, 470]
  }, { pianoRollChannelId: ids.hat, selectedChannelId: ids.hat, selectedPatternId: ids.drums });
  await page.mouse.click(1590, 930);
  await page.evaluate(() => window.greanteadawy.store.getState().play({ mode: 'song', position: 384 * 6 }));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/studio.png` });

  // 3. mixer
  await layout(page, { playlist: [8, 8, 1310, 300], mixer: [8, 318, 1310, 440] }, { selectedInsert: 2 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/mixer.png` });
  await page.evaluate(() => window.greanteadawy.store.getState().stop());

  // 3b. spatial: Claude places a few objects, the Spatial window next to the mixer
  const claude3d = await connectMcp(baseURL);
  const chNames = await page.evaluate(() => window.greanteadawy.store.getState().project.channels.map((c) => c.name));
  const spots = [['Hat', 'rear-left'], ['Open Hat', 'rear-right'], ['Pad', 'overhead'], ['Bell', 'top-front-right'], ['Clap', 'wide-left']];
  await claude3d.call('set_spatial', { enabled: true, monitor: 'binaural' });
  for (const [name, position] of spots) if (chNames.includes(name)) await claude3d.call('place_object', { insert: name, position });
  await claude3d.close();
  await layout(page, { mixer: [8, 8, 700, 600], spatial: [716, 8, 650, 600] }, { selectedInsert: 6 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/spatial.png` });

  // 4. piano roll on the melody
  const lead = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    const pat = p.patterns.find((x) => x.name === 'Melody') || p.patterns.at(-1);
    const chId = Object.keys(pat.notes).find((k) => pat.notes[k].length) || p.channels.at(-1).id;
    return { pat: pat.id, ch: chId };
  });
  await layout(page, { pianoRoll: [8, 8, 1310, 640] }, { pianoRollChannelId: lead.ch, selectedChannelId: lead.ch, selectedPatternId: lead.pat });
  await page.screenshot({ path: `${OUT}/piano-roll.png` });

  // 5. the sample library in folders, sample details (metadata + analysis) and Claude activity
  const folder = async (name) => (await (await page.request.post('/api/samples/folders', { data: { name } })).json()).id;
  const lib = async (name, buffer, folderId) => {
    const r = await page.request.post('/api/samples', { multipart: { file: { name: `${name}.wav`, mimeType: 'audio/wav', buffer }, ...(folderId ? { folderId } : {}) } });
    return (await r.json()).id;
  };
  const [drumsF, keysF, vocalsF] = [await folder('Drums'), await folder('Keys'), await folder('Vocals')];
  await folder('Loops');
  await lib('Kick Dusty', makeWav({ freq: 52, seconds: 0.5, channels: 1 }), drumsF);
  await lib('Snare Vinyl', makeWav({ freq: 190, seconds: 0.3, channels: 1 }), drumsF);
  await lib('Hat Closed', makeWav({ freq: 2800, seconds: 0.12, channels: 1 }), drumsF);
  const vinyl = await page.evaluate(() => window.greanteadawy.store.getState().samples.find((x) => x.name === 'Vinyl Pluck C4').id);
  await page.request.post('/api/samples/move', { data: { ids: [vinyl], folderId: keysF } });
  // a sung phrase, a little out of tune (A minor), for the editor and pitch correction
  const sung = (hz, cents) => hz * Math.pow(2, cents / 1200);
  const hook = await lib('Hook Take 3', voiceWav([
    { hz: 0, dur: 0.15 }, { hz: sung(440, 28), dur: 0.42, vib: 0.25 }, { hz: 0, dur: 0.06 }, { hz: sung(523.25, -15), dur: 0.38, vib: 0.2 },
    { hz: sung(493.88, 18), dur: 0.36 }, { hz: 0, dur: 0.08 }, { hz: sung(440, -22), dur: 0.7, vib: 0.35 }, { hz: 0, dur: 0.1 },
    { hz: sung(392, 40), dur: 0.32 }, { hz: sung(440, 12), dur: 0.9, vib: 0.4 }, { hz: 0, dur: 0.2 }
  ]), vocalsF);
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().samples.length)).toBe(6);
  await layout(page, { playlist: [8, 8, 1310, 420], channelRack: [8, 438, 800, 300] });
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.locator('.br-item.sample', { hasText: 'Vinyl Pluck' }).locator('.br-add.info').click();
  await expect(page.locator('.sample-details')).toContainText('LUFS');
  await page.screenshot({ path: `${OUT}/samples.png` });
  await page.locator('.br-item.sample', { hasText: 'Vinyl Pluck' }).locator('.br-add.info').click();

  // 5a. the wave editor on the vocal take, a phrase selected; then its Pitch tab (auto-tune to A minor)
  await page.evaluate((id) => window.greanteadawy.store.setState({ editSampleId: id, editTab: 'wave' }), hook);
  await layout(page, { playlist: [8, 8, 1310, 300], waveEditor: [60, 120, 1180, 560] }, { editSampleId: hook, editTab: 'wave' });
  await expect(page.getByTestId('wave-info')).toContainText('3.670 s');
  const wave = await page.getByTestId('wave-canvas').boundingBox();
  await page.mouse.move(wave.x + wave.width * 0.27, wave.y + 120);
  await page.mouse.down();
  await page.mouse.move(wave.x + wave.width * 0.49, wave.y + 120, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/wave-editor.png` });
  await page.locator('.we-tabs').getByRole('tab', { name: 'Pitch' }).click();
  await expect(page.getByTestId('pitch-status')).toContainText(/\d+ notes/);
  await page.locator('.pv-controls select').first().selectOption('A');
  await page.locator('.pv-controls select').nth(1).selectOption('minor');
  await page.locator('.pv-presets').getByRole('button', { name: 'Tight' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/pitch-correction.png` });
  await page.locator('[data-window="waveEditor"] .wbtn.close').click();

  // 5b. the recorder: a take from the (fake) microphone over the song, placed on the playlist
  await page.evaluate(() => { const s = window.greanteadawy.store.getState(); s.setMode('song'); s.setSongStart(384 * 4); });
  await layout(page, { playlist: [8, 8, 880, 560], recorder: [896, 8, 450, 520] });
  const rec = page.getByTestId('recorder');
  await rec.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(rec.getByRole('meter')).toBeVisible();
  await rec.locator('.rec-row.checks select').selectOption('0');
  await rec.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(2600);
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.locator('.rec-take')).toHaveCount(1, { timeout: 15000 });
  await rec.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/recorder.png` });
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.locator('.rec-take')).toHaveCount(2, { timeout: 15000 });
  await page.locator('[data-window="recorder"] .wbtn.close').click();
  await page.evaluate(() => window.greanteadawy.store.getState().setMode('pattern'));

  await layout(page, { playlist: [8, 8, 1310, 420], channelRack: [8, 438, 800, 300] });
  await page.getByRole('tab', { name: 'Claude' }).click();
  await page.screenshot({ path: `${OUT}/claude-activity.png` });

  // 5b. the world collections: the Indian Fusion template, the Browser on its new sections, the sitar's settings
  const claudeWorld = await connectMcp(baseURL);
  await claudeWorld.call('create_project', { name: 'Raga Sketch', template: 'indian' });
  await claudeWorld.close();
  await expect(page).toHaveTitle(/Raga Sketch/);
  const world = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    return { sitar: p.channels.find((c) => c.name === 'Sitar').id, theka: p.patterns.find((x) => x.name === 'Theka').id };
  });
  await layout(page, { playlist: [8, 8, 1310, 330], channelRack: [8, 346, 700, 470], channelSettings: [716, 346, 602, 470] }, { selectedChannelId: world.sitar, selectedPatternId: world.theka });
  await page.getByRole('tab', { name: 'Sounds' }).click();
  await page.locator('.br-cat', { hasText: 'East Asian' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/world.png` });

  // 6. settings → API token & MCP
  await page.locator('.avatar').click();
  await menuItem(page, 'API token & MCP');
  const s = page.locator('[data-window="settings"]');
  await s.getByRole('button', { name: /generate token/i }).click();
  await expect(s.locator('.fresh-token pre')).toBeVisible();
  await page.evaluate(() => {
    const st = window.greanteadawy.store.getState();
    window.greanteadawy.store.setState({ windows: { ...st.windows, settings: { ...st.windows.settings, x: 300, y: 40, w: 760, h: 760, z: 99 } }, zTop: 99 });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/settings-api.png` });

  // 6b. settings → audio export (ffmpeg status) and → plugins (the install review with the trust warning)
  await s.getByRole('tab', { name: 'Audio export' }).click();
  await expect(page.getByTestId('ffmpeg-status')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/settings-export.png` });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-shots-'));
  for (const name of ['chiptune', 'kalimba', 'euclid']) {
    const zip = packPlugin(path.resolve('plugins/examples', name), tmp).out;
    const r = await page.request.post('/api/plugins/inspect', { multipart: { file: { name: path.basename(zip), mimeType: 'application/zip', buffer: fs.readFileSync(zip) } } });
    await page.request.post('/api/plugins/install', { data: { token: (await r.json()).token, trust: true } });
  }
  await s.getByRole('tab', { name: 'Plugins' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('plugin-install').click()]);
  await chooser.setFiles(packPlugin(path.resolve('plugins/examples/tape-wobble'), tmp).out);
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/settings-plugins.png` });
  await page.getByTestId('plugin-review').getByRole('button', { name: 'Cancel' }).click();
  fs.rmSync(tmp, { recursive: true, force: true });

  // 6c. the About dialog (top right)
  await page.getByTestId('about-button').click();
  await expect(page.getByRole('dialog', { name: 'About GreanTeaDawy' })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/about.png` });
  await page.keyboard.press('Escape');

  // 7. sign-in screen
  await page.locator('.avatar').click();
  await menuItem(page, 'Sign out');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  await page.screenshot({ path: `${OUT}/login.png` });
  await page.close();

  // 8. phone
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await phone.goto('/');
  await phone.locator('.auth-field input').nth(0).fill(ADMIN.username);
  await phone.locator('input[type=password]').fill(ADMIN.password);
  await phone.getByRole('button', { name: /sign in/i }).click();
  await expect(phone.locator('.toolbar')).toBeVisible();
  await phone.waitForTimeout(600);
  await phone.screenshot({ path: `${OUT}/mobile.png` });
  await ctx.close();
});

// The GGS Synth and expression images. Kept apart so they can be regenerated on their own:
//   SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.js -g "GGS Synth"
test('GGS Synth screenshots', async ({ browser, baseURL }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  const claude = await connectMcp(baseURL);
  await claude.call('create_project', { name: 'Expressive Synths', template: 'expressive' });
  await expect(page).toHaveTitle(/Expressive Synths/);
  const lead = await page.evaluate(() => {
    const { store } = window.greanteadawy;
    const p = store.getState().project;
    const ch = p.channels.find((c) => c.name === 'Lead');
    store.setState({ selectedChannelId: ch.id, pianoRollChannelId: ch.id, selectedPatternId: p.patterns.find((x) => x.name === 'Lead').id, browserOpen: false });
    return ch.id;
  });
  expect(lead).toBeTruthy();

  // the synth editor with a note held, so the rings have their live dots and the source bar its meters
  await layout(page, { channelSettings: [10, 10, 1060, 870] });
  await expect(page.locator('.ggs-osc canvas').first()).toBeVisible();
  const tab = async (name) => { await page.locator('.ggs-tabs button', { hasText: name }).click(); await page.waitForTimeout(250); };
  const clip = { x: 10, y: 50, width: 1060, height: 830 };
  const edit = (params) => page.evaluate(([id, values]) => window.greanteadawy.store.getState().dispatch([{ type: 'channel/update', id, patch: { instrument: { params: values } } }]), [lead, params]);
  // a chaos generator and a drawn LFO on top of the preset's own routes
  await edit({ chaos1Type: 'lorenz', chaos1Rate: 1.5, mod13Src: 'chaos1', mod13Dst: 'oscAPos', mod13Amt: 0.3, mod14Src: 'macro5', mod14Dst: 'f1Res', mod14Amt: 0.4, lfo4Shape: 'steps', lfo4Sync: '1bar', lfo4S2: -0.6, lfo4S5: 0.9, lfo4S7: -0.2, mod15Src: 'lfo4', mod15Dst: 'oscBLevel', mod15Amt: 0.2 });
  await page.mouse.click(600, 30); // the first click unlocks audio
  const hold = async () => {
    const pad = page.locator('.ggs-pad');
    await pad.scrollIntoViewIfNeeded();
    const b = await pad.boundingBox();
    await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.3);
    await page.mouse.down();
    await page.waitForTimeout(700);
  };
  await hold();
  await page.locator('.channel-settings, .window').first().evaluate(() => {});
  await page.screenshot({ path: `${OUT}/ggs-synth.png` });
  // close-up: rings (one per route, coloured by source) and the dot where the control is right now
  const osc = await page.locator('.ggs-osc').first().boundingBox();
  const bar = await page.locator('.ggs-sources').boundingBox();
  await page.screenshot({ path: `${OUT}/ggs-rings.png`, clip: { x: bar.x - 4, y: bar.y - 4, width: Math.min(760, bar.width + 8), height: osc.y + osc.height - bar.y + 12 } });
  await page.mouse.up();
  // a second filter of another family, so the picture shows what the curves are
  await edit({ f1Type: 'ladder24', f1Res: 0.55, f2On: true, f2Type: 'formant', f2Cutoff: 1000, f2Res: 0.4, f2Morph: 0.25 });
  await tab('Filters');
  await hold();
  await page.screenshot({ path: `${OUT}/ggs-filters.png`, clip });
  await page.mouse.up();
  await tab('Modulators');
  await page.screenshot({ path: `${OUT}/ggs-envelopes.png`, clip });
  await page.locator('.ggs-lfo').nth(3).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  const chaos = await page.locator('.ggs-chaos').first().boundingBox();
  const lfo4 = await page.locator('.ggs-lfo').nth(3).boundingBox();
  await page.screenshot({ path: `${OUT}/ggs-chaos.png`, clip: { x: Math.min(chaos.x, lfo4.x) - 8, y: Math.min(chaos.y, lfo4.y) - 12, width: 1040, height: Math.max(chaos.height, lfo4.height) + 24 } });
  await tab('Matrix');
  await page.screenshot({ path: `${OUT}/ggs-matrix.png`, clip });
  // the preset browser and the wavetable grid
  await tab('Oscillators');
  await page.locator('.ggs-presets-name').click();
  await page.locator('.ggs-browser input[type=search]').fill('bass');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/ggs-presets.png`, clip: { x: 10, y: 50, width: 1060, height: 560 } });
  await page.locator('.ggs-browser input[type=search]').press('Escape');
  await page.locator('.ggs-osc').first().locator('.ggs-wt-name').click();
  await expect(page.locator('.ggs-wt-grid button')).toHaveCount(46);
  await page.waitForTimeout(900);
  await page.locator('.ggs-wt-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/ggs-wavetables.png`, clip });
  await page.keyboard.press('Escape');
  // the piano roll: pitch curves over the notes, the pitch lane underneath
  await layout(page, { pianoRoll: [10, 10, 1580, 600] });
  await page.locator('.pr-lane').selectOption('pitch');
  await page.locator('.pr-lane-bar select').nth(2).selectOption('2');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/expression.png`, clip: { x: 0, y: 44, width: 1600, height: 622 } });
  await claude.close();
  await page.close();
});

// What changed since a saved version. Regenerate on its own:
//   SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.js -g "Versions"
test('Versions screenshot', async ({ browser, baseURL }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  const claude = await connectMcp(baseURL);
  await claude.call('create_project', { name: 'Night Drive', template: 'house', bpm: 122 });
  await expect(page).toHaveTitle(/Night Drive/);
  await claude.call('save_version', { name: 'Before the bridge' });
  const names = await page.evaluate(() => { const p = window.greanteadawy.store.getState().project; return { channels: p.channels.map((c) => c.name), patterns: p.patterns.map((x) => x.name) }; });
  // one round of work by Claude, as one change: a new part, a brighter sound, a mix move
  await claude.call('batch', { calls: [
    { tool: 'update_project', args: { bpm: 124 } },
    { tool: 'add_channel', args: { name: 'Lead', instrument: 'ggs', preset: 'Touch Lead' } },
    { tool: 'create_pattern', args: { name: 'Bridge', bars: 2 } },
    { tool: 'add_notes', args: { pattern: 'Bridge', channel: 'Lead', text: '1.1 A3+C4+E4 1/2 v0.7; 1.3 G4 1/8t; > A4 1/8t; > C5 1/8t; 2 E5 1/2; 2.3 D5 1/4 v0.6' } },
    { tool: 'place_pattern', args: { pattern: 'Bridge', startBar: 9 } },
    { tool: 'update_channel', args: { channel: names.channels[0], volume: 0.7 } },
    { tool: 'add_effect', args: { insert: 1, type: 'reverb', params: { mix: 0.2 } } },
    { tool: 'set_mixer', args: { insert: 0, volumeDb: -1 } }
  ] });
  await layout(page, { versions: [10, 10, 700, 520] }, { browserOpen: false });
  const item = page.locator('.version-item', { hasText: 'Before the bridge' });
  await item.getByRole('button', { name: 'Changes' }).click();
  await expect(item.locator('.version-changes pre')).toContainText('+ Pattern "Bridge"');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/versions-changes.png`, clip: { x: 0, y: 0, width: 720, height: 540 } });
  await claude.close();
  await page.close();
});
