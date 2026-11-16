// Harmony and tuning in a real browser: the Harmony window (chords that fit, the progression being built, the
// library, the tuning table), and a tuning that is heard — a rendered note sits where its ratio says.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
const errors = [];
const project = () => page.evaluate(() => window.greanteadawy.store.getState().project);
const notesOf = async (channel, pattern = 'Verse') => {
  const p = await project();
  return p.patterns.find((x) => x.name === pattern).notes[p.channels.find((c) => c.name === channel).id] || [];
};

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
  await claude.call('create_project', { name: 'Harmony e2e', template: 'empty', key: 'A', scale: 'minor', bpm: 120 });
  await expect(page).toHaveTitle(/Harmony e2e/);
  await claude.call('add_channel', { name: 'Keys', instrument: 'synth' });
  await claude.call('add_channel', { name: 'Lead', instrument: 'ggs', preset: 'Init' });
  await claude.call('add_channel', { name: 'Grand', instrument: 'piano' });
  await claude.call('add_channel', { name: 'Kick', instrument: 'kick' });
  await claude.call('create_pattern', { name: 'Verse', bars: 4 });
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

test('Harmony window: build a progression from the chords that fit, see what it is, write it to the pattern', async () => {
  await page.locator('.toolbar button[aria-label="Harmony"]').click();
  const win = page.locator('.window.harmony');
  await expect(win).toBeVisible();
  // the chords of the key, each with its numeral, coloured by what it does
  const own = win.locator('.harmony-pool').first();
  await expect(own.locator('.harmony-pad b')).toContainText(['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
  await expect(own.locator('.harmony-pad.fn-tonic').first()).toContainText('Am');
  const pad = (name) => win.locator('.harmony-pad', { has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) }).first();
  for (const name of ['Am', 'G', 'F']) await pad(name).locator('.harmony-pad-add').click();
  await expect(win.locator('.harmony-chip b')).toHaveText(['Am', 'G', 'F']);
  await expect(win.locator('.harmony-chip span')).toHaveText(['i', 'VII', 'VI']);
  // what comes next is ranked: after Am – G – F the library knows the Andalusian cadence, and says so
  await expect(pad('E').locator('.harmony-pad-main')).toHaveAttribute('title', /continues "Andalusian cadence"/);
  await pad('E').locator('.harmony-pad-add').click();
  await expect(win.locator('.harmony-meta')).toContainText('Known as Andalusian cadence');
  await expect(win.locator('.harmony-meta')).toContainText('Tension 0.09 → 0.37 → 0.25 → 0.45');
  // a chord of the progression: what it is, and what could stand in for it
  await win.locator('.harmony-chip-main').nth(3).click();
  await expect(win.locator('.harmony-detail')).toContainText('borrowed from A harmonic minor');
  await expect(win.locator('.harmony-sub', { hasText: 'tritone substitute' })).toHaveCount(0);
  await win.locator('.harmony-sub', { has: page.locator('b', { hasText: /^E7$/ }) }).dblclick();
  await expect(win.locator('.harmony-chip b')).toHaveText(['Am', 'G', 'F', 'E7']);
  await expect(win.locator('.harmony-sub', { hasText: 'tritone substitute' })).toContainText('Bb7');
  // written to the pattern, four voices that move as little as they can
  await expect(win.locator('.harmony-write .btn.primary')).toHaveText('Write to Verse');
  await win.locator('.harmony-write .btn.primary').click();
  await expect.poll(async () => (await notesOf('Keys')).length).toBe(16);
  const notes = await notesOf('Keys');
  const bars = [0, 1, 2, 3].map((b) => notes.filter((n) => n.start === b * 384).map((n) => n.key).sort((x, y) => x - y));
  expect(bars.map((b) => b[0] % 12)).toEqual([9, 7, 5, 4]);
  expect(bars[3].map((k) => k % 12).sort((x, y) => x - y)).toEqual([2, 4, 8, 11]);
  for (let i = 1; i < 4; i++) expect(bars[i].reduce((sum, k, v) => sum + Math.abs(k - bars[i - 1][v]), 0)).toBeLessThanOrEqual(12);
  // one undo takes it back; and the window reads a pattern's chords
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await notesOf('Keys')).length).toBe(0);
  await claude.call('add_chords', { pattern: 'Verse', channel: 'Keys', chords: ['Dm', 'G', 'C', 'Am'] });
  await expect.poll(async () => (await notesOf('Keys')).length).toBe(12);
  await win.locator('.btn', { hasText: 'Read from pattern' }).click();
  await expect(win.locator('.harmony-chip b')).toHaveText(['Dm', 'G', 'C', 'Am']);
  await expect(win.locator('.harmony-chip span')).toHaveText(['iv', 'VII', 'III', 'i']);
});

test('Harmony window: the library is searched by words, tags and mood, and a progression loads in the key', async () => {
  const win = page.locator('.window.harmony');
  await win.locator('.ggs-tabs button', { hasText: 'Library' }).click();
  await expect(win.locator('.harmony-prog').first()).toBeVisible();
  const all = await win.locator('.harmony-prog').count();
  expect(all).toBeGreaterThan(20);
  await win.locator('input[type=search]').fill('andalusian');
  await expect(win.locator('.harmony-prog')).toHaveCount(1);
  await expect(win.locator('.harmony-prog-chords')).toHaveText('Am  G  F  E');
  await win.locator('input[type=search]').fill('');
  await win.locator('.harmony-tag', { hasText: /^jazz$/ }).click();
  const jazz = await win.locator('.harmony-prog').count();
  expect(jazz).toBeGreaterThan(0);
  expect(jazz).toBeLessThan(all);
  await win.locator('.harmony-list').locator('..').locator('select').selectOption('any');
  expect(await win.locator('.harmony-prog').count()).toBeGreaterThan(jazz);
  await win.locator('input[type=search]').fill('ii-V-I');
  await win.locator('.harmony-prog-main', { hasText: 'ii-V-I' }).first().click();
  // back on the Chords tab, in A
  await expect(win.locator('.harmony-chip b')).toHaveText(['Bm7', 'E7', 'Amaj7']);
});

test('the scale picker lists the scales by family; a scale with no chords of its own still shows the key\'s', async () => {
  const win = page.locator('.window.harmony');
  const scale = win.locator('.window-toolbar select, .window-title select').nth(1);
  const groups = await scale.locator('optgroup').evaluateAll((els) => els.map((e) => e.label));
  expect(groups).toEqual(['Modes', 'Harmonic minor family', 'Melodic minor family', 'Pentatonic & blues', 'Symmetric', 'Harmonic colours', 'Japan & gamelan', 'Bebop', 'Indian thaats']);
  expect(await scale.locator('option').count()).toBe(57);
  await scale.selectOption('phrygianDominant');
  await expect.poll(async () => (await project()).scale).toBe('phrygianDominant');
  await expect(win.locator('.harmony-pool').first().locator('.harmony-pad b').first()).toHaveText('A');
  await scale.selectOption('minorPentatonic');
  await expect(win.locator('.harmony-pool').first().locator('.harmony-pad b').first()).toHaveText('Am');
  await scale.selectOption('minor');
});

test('tuning: the table shows exact ratios, and a rendered note sits where its ratio says — on every kind of instrument', async () => {
  test.setTimeout(120_000);
  const win = page.locator('.window.harmony');
  await win.locator('.ggs-tabs button', { hasText: 'Tuning' }).click();
  await expect(win.locator('.harmony-about')).toContainText('Equal temperament.');
  const cents = async (channel, note) => Number(/([+-]?\d+(?:\.\d+)?) cents/.exec(await claude.call('analyze_sound', { channel, note, lengthSteps: 12, seconds: 1.5 }))[1]);
  // (measured before: in standard tuning every instrument is on the note)
  const before = { Keys: await cents('Keys', 'C#4'), Lead: await cents('Lead', 'C#4'), Grand: await cents('Grand', 'C#4') };
  // (a piano string is a little sharp of its note by nature — its stiffness — so the model is, too)
  for (const [name, c] of Object.entries(before)) expect(Math.abs(c), `${name} in standard tuning`).toBeLessThan(name === 'Grand' ? 12 : 4);

  await win.locator('.harmony-tuning select').first().selectOption('just');
  await expect.poll(async () => (await project()).tuning).toEqual({ system: 'just', root: 'A', a4: 440 });
  await expect(win.locator('.harmony-about')).toContainText('Just intonation (5-limit) on A.');
  await expect(win.locator('.ggs-tabs button', { hasText: 'Tuning' })).toHaveText('Tuning •');
  const row = (note) => win.locator('.harmony-tr', { has: page.locator('b', { hasText: new RegExp(`^${note.replace('#', '\\#')}$`) }) });
  await expect(row('C#')).toContainText('5/4');
  await expect(row('C#')).toContainText('386.3');
  await expect(row('C#')).toContainText('-13.7');
  await expect(row('C#')).toContainText('275.000');
  await expect(row('E')).toContainText('3/2');
  await expect(win.locator('.harmony-tuning')).toContainText('exactly 10:12:15, beatless');
  // the major third above the root is 13.7 cents flat of the tempered one — on a synth, the GGS worklet and a
  // physical model played from a rendered buffer alike; the root itself has not moved
  for (const name of ['Keys', 'Lead', 'Grand']) {
    const now = await cents(name, 'C#4');
    expect(Math.abs(now - before[name] + 13.7), `${name}: ${before[name]} → ${now} cents`).toBeLessThan(2.5);
  }
  expect(Math.abs(await cents('Keys', 'A3'))).toBeLessThan(4);
  // a drum is not a pitch: the kick renders the same audio in any tuning
  const kick = async () => (await claude.call('analyze_sound', { channel: 'Kick' })).split('\n').slice(0, 4).join('\n');
  const tunedKick = await kick();

  // A4 = 432 Hz moves everything, the root included (−31.8 cents)
  await claude.call('set_tuning', { a4: 432 });
  await expect(win.locator('.harmony-about')).toContainText('A4 = 432 Hz');
  expect(Math.abs(await cents('Keys', 'A3') + 31.8)).toBeLessThan(3);
  await claude.call('set_tuning', { system: 'equal', a4: 440 });
  await expect(win.locator('.harmony-about')).toContainText('Equal temperament.');
  expect(await kick()).toBe(tunedKick);
  expect(Math.abs(await cents('Lead', 'C#4') - before.Lead)).toBeLessThan(1);
  // undo brings a tuning back like any other edit
  await win.locator('.harmony-tuning select').first().selectOption('pythagorean');
  await expect(row('C#')).toContainText('81/64');
  await win.locator('.btn', { hasText: 'Standard' }).click();
  await expect.poll(async () => (await project()).tuning.system).toBe('equal');
});

test('Claude writes harmony: a library progression voice-led, an arpeggio, a groove by style, and reads it back', async () => {
  await claude.call('create_pattern', { name: 'Chorus', bars: 4 });
  expect(await claude.call('add_chords', { pattern: 'Chorus', channel: 'Keys', progression: 'Andalusian cadence', voices: 4 })).toMatch(/Wrote "Andalusian cadence" = Am – G – F – E/);
  expect(await claude.call('add_arpeggio', { pattern: 'Chorus', channel: 'Lead', progression: 'Andalusian cadence', mode: 'converge', rate: '1/16', octaves: 2 })).toMatch(/64 notes/);
  expect(await claude.call('add_drum_groove', { pattern: 'Chorus', style: 'reggaeton', variation: 0.3, seed: 'chorus' })).toMatch(/Reggaeton \(dembow\) groove, 4 bars[\s\S]*Created Hat/);
  await expect.poll(async () => (await project()).channels.map((c) => c.name)).toContain('Snare');
  expect(await claude.call('harmony', { action: 'analyze', pattern: 'Chorus' })).toMatch(/one reading per bar: Am {2}G {2}F {2}E[\s\S]*Known as: "Andalusian cadence"/);
  // the mix it makes is real audio
  const report = await claude.call('render_mix', { mode: 'pattern', pattern: 'Chorus', loops: 1, stems: false });
  expect(report).toMatch(/LUFS/);
});

test('no uncaught errors in the browser', async () => {
  expect(errors).toEqual([]);
});
