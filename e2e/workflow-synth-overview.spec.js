// The GGS Synth editor's Overview tab: the whole patch on one screen as pictures, and modules that can be moved,
// resized, hidden, brought back and saved as layouts (for a screen that shows just what a video needs). The other
// tabs stay as they were.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
let lead;
const errors = [];

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  claude = await connectMcp(baseURL);
  await claude.call('create_project', { name: 'Overview', template: 'expressive' });
  await expect(page).toHaveTitle(/Overview/);
  await page.mouse.click(700, 400); // the first click unlocks audio
  lead = await openEditor();
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

/** Select the Lead channel and open its settings window; returns the channel id. */
async function openEditor() {
  const id = await page.evaluate(() => {
    const { store } = window.greanteadawy;
    const st = store.getState();
    const ch = st.project.channels.find((c) => c.name === 'Lead');
    store.setState({ selectedChannelId: ch.id, browserOpen: false }); // the whole width for the editor
    st.closeWindow('pianoRoll');
    st.openWindow('channelSettings', { x: 8, y: 8, w: 1480, h: 920 });
    return ch.id;
  });
  await expect(page.locator('.ggs')).toBeVisible();
  return id;
}

const params = () => page.evaluate((cid) => window.greanteadawy.store.getState().project.channels.find((c) => c.id === cid).instrument.params, lead);
const modules = () => page.locator('.ovw-mod').evaluateAll((els) => els.map((el) => el.dataset.module));
const tab = (name) => page.locator('.ggs-tabs button', { hasText: name }).click();

test('a new Overview tab after the others, which stay as they were', async () => {
  await expect(page.locator('.ggs-tabs button')).toHaveText(['Oscillators', 'Filters', 'Modulators', /^Matrix/, 'Effects', 'All parameters', 'Overview']);
  // the other tabs keep the head (preset, macros) and the source bar on top
  await expect(page.locator('.ggs-head')).toBeVisible();
  await expect(page.locator('.ggs-sources')).toBeVisible();
  const sources = await page.locator('.ggs-src').count();
  expect(sources).toBeGreaterThan(20);
  await tab('Overview');
  // there, they are modules of their own instead
  await expect(page.locator('.ggs-head')).toHaveCount(0);
  await expect(page.locator('.ggs-sources')).toHaveCount(0);
  await expect.poll(modules).toEqual(['header', 'oscA', 'oscB', 'oscC', 'subnoise', 'filter1', 'routing', 'filter2', 'amp', 'envelopes', 'lfos', 'chaos', 'sources', 'fx', 'scope', 'matrix', 'pad']);
  // pictures, not just knobs: every canvas has something drawn on it
  const blank = await page.locator('.ovw-display:not(.scope) canvas').evaluateAll((cs) => cs.filter((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }).length);
  expect(blank).toBe(0);
  await expect(page.locator('.ovw-routing')).toBeVisible();
  await expect(page.locator('.ovw-src')).toHaveCount(sources); // the same sources as the bar of the other tabs
  await tab('Oscillators');
  await expect(page.locator('.ggs-head')).toBeVisible();
  await tab('Overview');
});

test('it edits the patch: the routing diagram, a knob, a source dropped on a knob — each one undo step', async () => {
  const before = await params();
  // click oscillator A in the diagram: it goes to the next place (filter 1 → filter 2)
  await page.locator('.ovw-node.src[data-source=oscA]').click();
  await expect.poll(async () => (await params()).oscADest).toBe('f2');
  await page.locator('.ovw-route-toggle').click();
  await expect.poll(async () => (await params()).filterRoute).toBe(before.filterRoute === 'serial' ? 'parallel' : 'serial');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await params()).filterRoute ?? 'serial').toBe(before.filterRoute ?? 'serial');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await params()).oscADest ?? 'f1').toBe(before.oscADest ?? 'f1');
  // a knob in a module is the same control as in the other tabs
  const res = page.locator('[data-module=filter1] .knob', { hasText: 'Resonance' });
  await res.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await params()).f1Res).toBeGreaterThan(before.f1Res ?? 0);
  // and the module shows the new value (modules redraw when their channel changes)
  await expect(res).toHaveAttribute('aria-valuenow', String((await params()).f1Res));
  // and takes a dragged source like any other (the LFOs sit just above the sources: no scrolling during the drag)
  const routes = (p) => [...Array(64)].map((_, i) => i + 1).filter((i) => p[`mod${i}Src`] === 'chaos2' && p[`mod${i}Dst`] === 'lfo1Rate');
  expect(routes(await params())).toHaveLength(0);
  await page.locator('[data-module=lfos]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.locator('.ovw-src[data-source="chaos2"]').dragTo(page.locator('[data-module=lfos] .knob', { hasText: 'Rate' }));
  await expect.poll(async () => routes(await params()).length).toBe(1);
  await expect(page.locator('.ovw-matrix li', { hasText: 'Chaos 2' })).toHaveCount(1);
  // Space on the diagram reroutes a source; it does not also start the song
  const dest = (await params()).oscBDest ?? 'f1';
  await page.locator('.ovw-node.src[data-source=oscB]').focus();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await params()).oscBDest).not.toBe(dest);
  expect(await page.evaluate(() => window.greanteadawy.store.getState().playing)).toBe(false);
});

test('arrange: hide, add back, move, resize — and save the layout under a name that survives a reload', async () => {
  await page.locator('.ovw-bar').getByRole('button', { name: 'Arrange' }).click();
  await expect(page.locator('.ovw.arranging')).toBeVisible();
  // hide two modules
  await page.getByRole('button', { name: 'Hide Chaos' }).click();
  await page.getByRole('button', { name: 'Hide Touch pad' }).click();
  await expect.poll(modules).not.toContain('chaos');
  await expect(page.locator('.ovw-changed')).toBeVisible();
  // bring one back from the menu: it comes at the end
  await page.locator('.ovw-add').selectOption('chaos');
  await expect.poll(async () => (await modules()).at(-1)).toBe('chaos');
  // one place earlier
  await page.getByRole('button', { name: 'Move Chaos earlier' }).click();
  await expect.poll(async () => (await modules()).slice(-2)).toEqual(['chaos', 'matrix']);
  // wider
  const width = () => page.locator('[data-module=chaos]').evaluate((el) => el.style.gridColumn);
  const w0 = await width();
  await page.getByRole('button', { name: 'Make Chaos wider' }).click();
  await page.getByRole('button', { name: 'Make Chaos wider' }).click();
  expect(await width()).not.toBe(w0);
  expect(await width()).toMatch(/span 6/);
  // drag the scope by its grip onto the effects: it goes just before them
  await page.locator('[data-module=fx]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.locator('[data-module=scope] .ovw-grip').dragTo(page.locator('[data-module=fx]'));
  await expect.poll(async () => (await modules()).slice(-5)).toEqual(['sources', 'scope', 'fx', 'chaos', 'matrix']);
  // save it under a name
  await page.locator('.ovw-bar').getByRole('button', { name: 'Save as…' }).click();
  await page.locator('.modal input').fill('Video: drift');
  await page.locator('.modal input').press('Enter');
  await expect(page.locator('.ovw-bar .ui-select').first()).toHaveValue('Video: drift');
  await page.locator('.ovw-bar').getByRole('button', { name: 'Done' }).click();
  const saved = await modules();
  // after a reload the editor opens on the same arrangement
  await page.reload();
  await expect(page.locator('.toolbar')).toBeVisible();
  await openEditor();
  await tab('Overview');
  await expect.poll(modules).toEqual(saved);
  await expect(page.locator('.ovw-bar .ui-select').first()).toHaveValue('Video: drift');
});

test('built-in layouts: a few modules for a clip, and back to the whole patch', async () => {
  const pick = page.locator('.ovw-bar .ui-select').first();
  await pick.selectOption('Filters, routing & envelopes');
  await expect.poll(modules).toEqual(['filter1', 'routing', 'filter2', 'envelopes', 'amp', 'scope']);
  await pick.selectOption('Video: drift');
  await expect.poll(async () => (await modules()).slice(-5)).toEqual(['sources', 'scope', 'fx', 'chaos', 'matrix']);
  // a saved layout can be deleted; the editor goes back to the first built-in one
  await page.locator('.ovw-bar').getByRole('button', { name: 'Delete' }).click();
  await expect(pick).toHaveValue('Whole patch');
  await expect.poll(async () => (await modules()).length).toBe(17);
  await expect(pick.locator('option', { hasText: 'Video: drift' })).toHaveCount(0);
  // a built-in name cannot be taken
  await page.locator('.ovw-bar').getByRole('button', { name: 'Save as…' }).click();
  await page.locator('.modal input').fill('Whole patch');
  await page.locator('.modal input').press('Enter');
  await expect(page.locator('.toast', { hasText: 'built-in' })).toBeVisible();
});

test('full screen: only the modules, over the whole page — and dialogs still show above them', async () => {
  await page.locator('.ovw-bar').getByRole('button', { name: 'Full screen' }).click();
  await expect(page.locator('body > .ovw.solo')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  const box = await page.locator('.ovw.solo').boundingBox();
  expect(box.width).toBeGreaterThan(1400);
  // a dialog opened from full screen is seen and answered there
  await page.locator('.ovw.solo .ovw-bar').getByRole('button', { name: 'Save as…' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  // a knob's right-click menu too
  await page.locator('.ovw.solo [data-module=filter1] .knob', { hasText: 'Cutoff' }).click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
  await page.locator('.ovw.solo [data-module=filter1] .ovw-mod-head').click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(page.locator('.ovw.solo')).toBeVisible();
  // and back
  await page.locator('.ovw.solo .ovw-bar').getByRole('button', { name: 'Exit full screen' }).click();
  await expect(page.locator('.ovw.solo')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(page.locator('.ggs .ovw')).toBeVisible();
});

test('the scope listens to the channel while a note plays, and lets go when it closes', async () => {
  const scopeNode = () => page.evaluate((cid) => !!window.greanteadawy.engine()?.strips.get(cid)?.scope, lead);
  await expect.poll(scopeNode).toBe(true); // the module asked for it
  const pad = page.locator('.ovw .ggs-pad');
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.4);
  await page.mouse.down();
  // its canvas draws the wave: lit pixels in the top half
  const lit = () => page.locator('.ovw-display.scope canvas').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.floor(c.height / 2)).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++;
    return n;
  });
  await expect.poll(lit, { timeout: 5000 }).toBeGreaterThan(200);
  await page.mouse.up();
  // another tab: the analyser is disconnected
  await tab('Filters');
  await expect.poll(scopeNode).toBe(false);
  await tab('Overview');
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
