// The chord grid in a real browser: Harmony → Grid (every chord of the key, the borrowed column, smart chords, the
// track of cards, tensions, writing to a pattern, the loop) and Claude writing chords from the same grid.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
let win;
const errors = [];
const project = () => page.evaluate(() => window.greanteadawy.store.getState().project);
const notesOf = async (channel = 'Keys', pattern = 'Verse') => {
  const p = await project();
  return p.patterns.find((x) => x.name === pattern).notes[p.channels.find((c) => c.name === channel).id] || [];
};
const sounding = () => page.evaluate(() => [...(window.greanteadawy.engine()?.voices || [])].filter((v) => !v.done).length);
const cell = (name) => win.getByRole('gridcell', { name: new RegExp(`^${name.replace(/[/#()+]/g, '\\$&')}(,|$)`) });
const cards = () => win.locator('.cgrid-card b');
const pcs = (notes) => [...new Set(notes.map((n) => n.key % 12))].sort((a, b) => a - b);

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  claude = await connectMcp(baseURL);
  await claude.call('create_project', { name: 'Grid e2e', template: 'empty', key: 'C', scale: 'major', bpm: 120 });
  await expect(page).toHaveTitle(/Grid e2e/);
  await claude.call('add_channel', { name: 'Keys', instrument: 'synth' });
  await claude.call('add_channel', { name: 'Kick', instrument: 'kick' });
  await claude.call('create_pattern', { name: 'Verse', bars: 4 });
  await page.evaluate(() => {
    const s = window.greanteadawy.store;
    const p = s.getState().project;
    s.setState({ selectedPatternId: p.patterns.find((x) => x.name === 'Verse').id });
    s.getState().openWindow('harmony');
    s.getState().moveWindow('harmony', { x: 10, y: 40, w: 900, h: 820 });
  });
  win = page.locator('.window.harmony');
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

test('the grid: every chord of the key by degree, the borrowed column and its pages', async () => {
  await expect(win.locator('.ggs-tabs button.on')).toHaveText('Grid');
  await expect(win.locator('.cgrid-grid')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.cgrid-col').nth(0).locator('.cgrid-cell b')).toHaveText(['C', 'CM7', 'CM9', 'Csus4', 'Csus2', 'Cadd9', 'C6', 'C6/9']);
  await expect(win.locator('.cgrid-col').nth(6).locator('.cgrid-cell b')).toHaveText(['Bdim', 'Bø7']);
  await expect(win.locator('.cgrid-head b')).toHaveText(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  const borrowed = win.locator('.cgrid-col.deg-b .cgrid-cell b');
  await expect(borrowed).toHaveText(['Eb', 'Fm', 'Ab', 'Bb', 'D7', 'A7', 'E7']);
  await win.getByRole('tab', { name: 'Mediants' }).click();
  await expect(borrowed).toHaveText(['E', 'A']);
  await win.getByRole('tab', { name: 'Tritone' }).click();
  await expect(borrowed.first()).toHaveText('Db7');
  await expect(win.locator('.cgrid-col.deg-b .cgrid-cell span').first()).toHaveText('→ C');
  await win.getByRole('tab', { name: 'Borrowed' }).click();
  await expect(borrowed).toHaveCount(7);
  await expect(win.locator('.cgrid-credit')).toContainText('Tuple');
});

test('a chord sounds while it is held, and what could follow lights up', async () => {
  await expect(win.locator('.cgrid-cell.smart')).toHaveCount(0);
  await cell('Dm9').hover();
  await page.mouse.down();
  await expect(cell('Dm9')).toHaveClass(/sounding/);
  await expect(win.locator('.cgrid-now b')).toHaveText('Dm9');
  await expect(win.locator('.cgrid-now i')).toHaveText('D3 E3 F3 A3 C4');
  await expect.poll(sounding).toBe(5);
  await expect(win.locator('.cgrid-keys .on')).toHaveCount(5);
  await page.mouse.up();
  await expect(cell('Dm9')).not.toHaveClass(/sounding/);
  await expect.poll(sounding, { timeout: 8000 }).toBe(0);
  // Smart is on for a first visit: after ii the dominant is the strongest suggestion
  await expect(cell('G7')).toHaveClass(/smart-3/);
  expect(await win.locator('.cgrid-cell.smart').count()).toBeGreaterThanOrEqual(4);
  await expect(cell('Dm9')).toHaveClass(/last/);
  await win.getByRole('radio', { name: 'Off' }).nth(1).click();
  await expect(win.locator('.cgrid-cell.smart')).toHaveCount(0);
  await win.getByRole('radio', { name: 'Function' }).click();
  // the keyboard plays too: arrows move, Enter sounds while it is down
  await cell('C').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(cell('Dm7')).toBeFocused();
  await page.keyboard.down('Enter');
  await expect(win.locator('.cgrid-now b')).toHaveText('Dm7');
  await page.keyboard.up('Enter');
  await expect(cell('Dm7')).not.toHaveClass(/sounding/);
});

test('Capture puts what is played on the track; a card takes tensions, a voicing, an inversion', async () => {
  await win.getByRole('radio', { name: 'Follow' }).click();
  await win.getByRole('button', { name: 'Capture' }).click();
  for (const name of ['Dm9', 'G7', 'CM9']) await cell(name).click();
  await expect(cards()).toHaveText(['Dm9', /^G7/, /^CM9/]);
  await win.getByRole('button', { name: 'Capture' }).click();
  await cell('Am7').click();
  await expect(cards()).toHaveCount(3);
  // the second card: G7 with a 13 and a flat 9; the 11th is an avoid note there
  await win.locator('.cgrid-card').nth(1).click();
  const detail = win.locator('.cgrid-detail');
  await expect(detail.locator('.cgrid-detail-row > b').first()).toHaveText('G7');
  await expect(detail.getByRole('button', { name: '11', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '13', exact: true }).click();
  await detail.getByRole('button', { name: '♭9', exact: true }).click();
  await expect(cards().nth(1)).toHaveText(/^G13b9/);
  await expect(detail.getByRole('button', { name: '13', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await detail.locator('select').selectOption('rootless');
  await expect(detail.locator('.cgrid-notes')).not.toContainText('G');
  await detail.getByRole('button', { name: 'Higher inversion' }).click();
  await expect(detail.getByRole('button', { name: 'Free' })).toBeVisible();
  await detail.getByRole('button', { name: 'Free' }).click();
  await expect(detail.getByRole('button', { name: 'Free' })).toHaveCount(0);
  // what could stand in for it: the tritone substitute is one double-click away, and one Undo back
  await expect(detail.locator('.cgrid-opt b')).toContainText(['Bø7', 'Db7']);
  await detail.locator('.cgrid-opt', { hasText: 'Db7' }).dblclick();
  await expect(cards().nth(1)).toHaveText(/^Db7/);
  await win.getByRole('button', { name: 'Undo track change' }).click();
  await expect(cards().nth(1)).toHaveText(/^G13b9/);
});

test('a chord dragged to the track lands where it is dropped; cards move, stretch and go by keyboard', async () => {
  const track = win.locator('.cgrid-track');
  const box = await track.boundingBox();
  await cell('FM7').hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height / 2, { steps: 8 });
  await expect(win.locator('.cgrid-carry')).toHaveText('FM7');
  await page.mouse.up();
  await expect(cards()).toHaveText(['Dm9', /^G13b9/, /^CM9/, /^FM7/]);
  await expect(win.locator('.cgrid-card').nth(3)).toHaveAttribute('aria-label', /Card 4: FM7, IV, bar 4, 1 bar/);
  // keyboard: Alt+arrows change the length, arrows move, Delete removes
  await win.locator('.cgrid-card').nth(3).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(win.locator('.cgrid-card').nth(3)).toHaveAttribute('aria-label', /0\.5 bars/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(win.locator('.cgrid-card').nth(3)).toHaveAttribute('aria-label', /bar 4\.5, 0\.5 bars/);
  // a card dragged by the mouse: back to the start of bar 4
  const card = await win.locator('.cgrid-card').nth(3).boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 - box.width / 8, card.y + card.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(win.locator('.cgrid-card').nth(3)).toHaveAttribute('aria-label', /bar 4, 0\.5 bars/);
  await expect.poll(sounding, { timeout: 8000 }).toBe(0);
});

test('Write to pattern: the track becomes notes on the channel, in one undo step', async () => {
  await expect(win.locator('.window-toolbar select').nth(2)).toHaveValue(/.+/);
  await win.getByRole('button', { name: 'Write to Verse' }).click();
  await expect(page.locator('.toast').last()).toContainText('Dm9 – G13b9 – CM9 – FM7 written to Keys in Verse');
  const notes = await notesOf();
  const at = (tick) => notes.filter((n) => n.start <= tick && n.start + n.length > tick);
  expect(pcs(at(10))).toEqual([0, 2, 4, 5, 9]);
  expect(pcs(at(384 + 10))).toEqual([2, 4, 5, 8, 9, 11]); // rootless G13b9: F A B D (the 9th where the root was) + Ab + E, no G
  expect(pcs(at(768 + 10))).toEqual([0, 2, 4, 7, 11]);
  expect(pcs(at(1152 + 10))).toEqual([0, 4, 5, 9]);
  expect(at(1152 + 200)).toHaveLength(0); // FM7 is half a bar
  await page.evaluate(() => window.greanteadawy.store.getState().undo());
  expect(await notesOf()).toHaveLength(0);
  await page.evaluate(() => window.greanteadawy.store.getState().redo());
  expect(await notesOf()).toHaveLength(notes.length);
});

test('Play loops the track on the audio clock, alone or with the song', async () => {
  await win.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(win.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(win.locator('.cgrid-playhead')).toBeVisible();
  await expect.poll(sounding).toBeGreaterThan(2);
  await expect(win.locator('.cgrid-card.playing')).toHaveCount(1);
  await win.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(win.locator('.cgrid-playhead')).toBeHidden();
  await expect.poll(sounding, { timeout: 8000 }).toBe(0);
  // with the song: the transport starts with the loop, and stopping it stops both
  await win.getByRole('button', { name: 'With the song' }).click();
  await win.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().playing)).toBe(true);
  await expect(win.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.evaluate(() => window.greanteadawy.store.getState().stop());
  await expect(win.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await win.getByRole('button', { name: 'With the song' }).click();
});

test('the grid follows the song\'s key, and comes back after a reload', async () => {
  await claude.call('update_project', { key: 'D' });
  await expect(win.locator('.cgrid-col').nth(0).locator('.cgrid-cell b').first()).toHaveText('D');
  await expect(cards()).toHaveText(['Em9', /^A13b9/, /^DM9/, /^GM7/]);
  await claude.call('update_project', { key: 'C' });
  await expect(cards()).toHaveText(['Dm9', /^G13b9/, /^CM9/, /^FM7/]);
  await page.waitForTimeout(700); // (the grid is saved a moment after its last change)
  await page.reload();
  await expect(page.locator('.toolbar')).toBeVisible();
  await page.evaluate(() => window.greanteadawy.store.getState().openWindow('harmony'));
  await expect(cards()).toHaveText(['Dm9', /^G13b9/, /^CM9/, /^FM7/], { timeout: 15000 });
  await expect(win.getByRole('radio', { name: 'Follow' })).toHaveAttribute('aria-checked', 'true');
  // a scale the grid does not have: it says which one it shows instead (the cards follow, as in any key change)
  await claude.call('update_project', { scale: 'blues' });
  await expect(win.locator('.cgrid-note')).toContainText(/The grid has no chords for .*: it shows C Minor/);
  await expect(win.locator('.cgrid-col').nth(0).locator('.cgrid-cell b').first()).toHaveText('Cm');
  await claude.call('update_project', { scale: 'major' });
  await expect(win.locator('.cgrid-note')).toHaveCount(0);
  await expect(cards()).toHaveCount(4);
});

test('Claude reads the same grid and writes chords from it', async () => {
  const palette = await claude.call('chord_grid', { after: ['Dm9', 'G7'] });
  expect(palette).toMatch(/Chord grid of C major/);
  expect(palette).toMatch(/●●● C\S*\s+I\s+comes to rest/);
  const reply = await claude.call('add_grid_chords', { pattern: 'Verse', channel: 'Keys', chords: ['FM9', { chord: 'Fm', bars: 0.5 }, { chord: 'Bb', bars: 0.5 }, { chord: 'CM7', bars: 2, tensions: ['9'] }], voicing: 'drop2', strum: 20 });
  expect(reply).toMatch(/Wrote FM9 – Fm – Bb – CM9 \(IV – iv – bVII – I\) to "Keys" in "Verse", bars 1–4/);
  await expect.poll(async () => pcs((await notesOf()).filter((n) => n.start < 384))).toEqual([0, 4, 5, 7, 9]);
  const notes = await notesOf();
  expect(notes.some((n) => n.start % 96 !== 0)).toBe(true); // strummed
  expect(pcs(notes.filter((n) => n.start >= 384 && n.start < 576))).toEqual([0, 5, 8]);
  expect(errors).toEqual([]);
});
