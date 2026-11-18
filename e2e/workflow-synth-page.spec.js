// The GGS Synth page: the whole patch on one screen, arranged and coloured like the /synth editor, scaled to its
// window so nothing scrolls and nothing overlaps; modules that can be rearranged and saved as layouts; the dock with
// the FX rack, the matrix and every parameter; the classic tabs a click away.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
let lead;
const errors = [];

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  claude = await connectMcp(baseURL);
  await claude.call('create_project', { name: 'Synth page', template: 'expressive' });
  await expect(page).toHaveTitle(/Synth page/);
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
    const { store } = window.ggs;
    const st = store.getState();
    const ch = st.project.channels.find((c) => c.name === 'Lead');
    store.setState({ selectedChannelId: ch.id, browserOpen: false });
    st.closeWindow('pianoRoll');
    st.openWindow('channelSettings');
    return ch.id;
  });
  await expect(page.locator('.ggs')).toBeVisible();
  return id;
}

const params = () => page.evaluate((cid) => window.ggs.store.getState().project.channels.find((c) => c.id === cid).instrument.params, lead);
const slots = () => page.locator('.gsp-row').evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll(':scope > .gsp-slot')].map((s) => s.dataset.slot)));
const menu = async (item) => {
  await page.locator('.sp-menu-btn').first().click();
  await page.locator('.context-menu .cm-item', { hasText: item }).first().click();
};

/** Every control inside its module, none on another or on a picture, every module inside the page. */
function layoutProblems() {
  return page.evaluate(() => {
    const out = [];
    const r = (el) => el.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const root = r(document.querySelector('.gsp'));
    for (const mod of document.querySelectorAll('.gsp [data-module]')) {
      const m = r(mod);
      const name = mod.dataset.module;
      if (m.left < root.left - 1 || m.right > root.right + 1 || m.top < root.top - 1 || m.bottom > root.bottom + 1) out.push(`${name} is outside the page`);
      const controls = [...mod.querySelectorAll('.knob, .vbox, .sp-sel, .sp-led')].filter((c) => r(c).width > 0);
      const screens = [...mod.querySelectorAll('.sp-screen')];
      for (const c of controls) {
        const b = r(c);
        const label = c.getAttribute('aria-label') || c.textContent.slice(0, 12);
        if (b.left < m.left - 1 || b.right > m.right + 1 || b.top < m.top - 1 || b.bottom > m.bottom + 1) out.push(`${name}: ${label} sticks out`);
        for (const s of screens) if (!s.contains(c) && hit(b, r(s))) out.push(`${name}: ${label} is on a picture`);
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
          if (hit(r(controls[i]), r(controls[j]))) out.push(`${name}: ${controls[i].getAttribute('aria-label')} × ${controls[j].getAttribute('aria-label')}`);
        }
      }
    }
    return out;
  });
}

test('the synth page is the editor; the classic tabs are a click away and back', async () => {
  await expect(page.locator('.gsp')).toBeVisible();
  await expect(page.locator('.ggs-tabs')).toHaveCount(0);
  await expect.poll(slots).toEqual([['header'], ['oscA', 'oscB', 'oscC', 'subnoise'], ['filter1', 'routing', 'filter2', 'amp'], ['envelopes', 'lfos', 'chaos'], ['sources'], ['dock']]);
  // the channel's own settings fold into the title bar
  await expect(page.locator('.window-toolbar .cs-strip')).toBeVisible();
  await expect(page.locator('.cs-top')).toHaveCount(0);
  await page.locator('.cs-strip button', { hasText: 'Channel settings' }).click();
  await expect(page.locator('.cs-top')).toBeVisible();
  await page.locator('.cs-strip button', { hasText: 'Hide channel settings' }).click();
  // classic view, and back
  await menu('Classic view');
  await expect(page.locator('.ggs-tabs button')).toHaveText(['Oscillators', 'Filters', 'Modulators', /^Matrix/, 'Effects', 'All parameters']);
  await expect(page.locator('.gsp')).toHaveCount(0);
  await page.locator('.ggs-to-page').click();
  await expect(page.locator('.gsp')).toBeVisible();
});

test('one screen: nothing scrolls and nothing overlaps, and the pictures are drawn', async () => {
  const gsp = page.locator('.gsp');
  expect(await gsp.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await layoutProblems()).toEqual([]);
  // the page is scaled to fit, not cut: its bottom edge is inside the window
  const page_ = await page.locator('.gsp-page').boundingBox();
  const box = await gsp.boundingBox();
  expect(page_.y + page_.height).toBeLessThanOrEqual(box.y + box.height + 1);
  expect(Number(await page.locator('.gsp-page').getAttribute('data-scale'))).toBeGreaterThan(0.8);
  const blank = await page.locator('.gsp .sp-screen canvas').evaluateAll((cs) => cs.filter((c) => {
    if (!c.width || c.closest('.sp-scope')) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }).length);
  expect(blank).toBe(0);
  await expect(page.locator('.sp-src')).toHaveCount(25);
});

test('it edits the patch: the signal flow, knobs, value boxes, sources dropped on knobs — each one undo step', async () => {
  const before = await params();
  await page.locator('.sp-flow-src[data-source=oscA]').click();
  await expect.poll(async () => (await params()).oscADest).toBe('f2');
  await page.locator('.sp-route-toggle').click();
  await expect.poll(async () => (await params()).filterRoute).toBe(before.filterRoute === 'serial' ? 'parallel' : 'serial');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await params()).oscADest ?? 'f1').toBe(before.oscADest ?? 'f1');
  // Space on the diagram changes the routing only (the song does not start)
  await page.locator('.sp-flow-src[data-source=oscB]').focus();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await params()).oscBDest).not.toBe(before.oscBDest ?? 'f1');
  expect(await page.evaluate(() => window.ggs.store.getState().playing)).toBe(false);
  // a knob shows its value while touched, and changes
  const res = page.locator('[data-module=filter1]').getByRole('slider', { name: 'Resonance', exact: true });
  await res.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await params()).f1Res).toBeGreaterThan(before.f1Res ?? 0);
  await expect(res).toHaveAttribute('aria-valuenow', String((await params()).f1Res));
  await expect(res.locator('.knob-readout .v')).toBeVisible();
  // a value box
  const oct = page.locator('[data-module=oscB]').getByRole('slider', { name: 'Oct', exact: true });
  await oct.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await params()).oscBOct).toBe((before.oscBOct ?? 0) + 1);
  // a source from the strip onto the LFO's rate (the strip sits just under the LFOs: no scrolling during the drag)
  const routed = (p, s, t) => [...Array(64)].map((_, i) => i + 1).filter((i) => p[`mod${i}Src`] === s && p[`mod${i}Dst`] === t).length;
  await page.locator('.sp-src[data-source="chaos2"]').dragTo(page.locator('[data-module=lfos]').getByRole('slider', { name: 'Rate', exact: true }));
  await expect.poll(async () => routed(await params(), 'chaos2', 'lfo1Rate')).toBe(1);
  // a macro's number onto a knob
  await page.locator('[data-macro="6"] .sp-macro-n').dragTo(page.locator('[data-module=filter2]').getByRole('slider', { name: 'Cutoff', exact: true }));
  await expect.poll(async () => routed(await params(), 'macro6', 'f2Cutoff')).toBe(1);
});

test('drawn LFO steps follow the pointer, and the warp and FM menus are reachable by name', async () => {
  await page.evaluate((cid) => window.ggs.store.getState().dispatch([{ type: 'channel/update', id: cid, patch: { instrument: { params: { lfo1Shape: 'steps', lfo1Steps: 8 } } } }]), lead);
  const steps = page.locator('[data-module=lfos] .ggs-steps');
  await expect(steps).toBeVisible();
  const b = await steps.boundingBox();
  // press at the very top of the third step: that step goes to (nearly) +1
  await page.mouse.click(b.x + b.width * (2.5 / 8), b.y + 2);
  await expect.poll(async () => (await params()).lfo1S3).toBeGreaterThan(0.9);
  await page.mouse.click(b.x + b.width * (5.5 / 8), b.y + b.height - 2);
  await expect.poll(async () => (await params()).lfo1S6).toBeLessThan(-0.9);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.evaluate((cid) => window.ggs.store.getState().dispatch([{ type: 'channel/update', id: cid, patch: { instrument: { params: { lfo1Shape: 'sine' } } } }]), lead);
  // the warp mode under the Warp knob is a menu of its own, with a name
  await page.getByLabel('Oscillator A warp mode').selectOption('bend');
  await expect.poll(async () => (await params()).oscAWarp).toBe('bend');
  await page.getByLabel('Oscillator A warp mode').selectOption('off');
  await expect(page.getByLabel('Oscillator B FM source')).toBeVisible();
});

test('the dock: the FX rack, the matrix and every parameter open over the page and close again', async () => {
  await expect(page.locator('[data-module=dock] .sp-fx')).toHaveCount(4);
  await page.locator('[data-module=dock] [data-dock-tab=matrix]').click();
  await expect(page.locator('.sp-dock-over .ggs-matrix')).toBeVisible();
  await expect(page.locator('.sp-dock-over .ggs-matrix tbody tr').first()).toBeVisible();
  await page.locator('.sp-dock-over [data-dock-tab=params]').click();
  await expect(page.locator('.sp-dock-over .ggs-ptable')).toBeVisible();
  await page.locator('.sp-dock-close').click();
  await expect(page.locator('.sp-dock-over')).toHaveCount(0);
  // a knob's "Show in the matrix" opens it, filtered
  await page.locator('[data-module=filter2]').getByRole('slider', { name: 'Cutoff', exact: true }).click({ button: 'right' });
  await page.locator('.context-menu .cm-item', { hasText: 'Show in the matrix' }).click();
  await expect(page.locator('.sp-dock-over .ggs-matrix input[type=search]')).toHaveValue('f2Cutoff');
  await page.locator('.sp-dock-close').click();
});

test('arrange: hide, bring back, move within and between rows, resize, drag — and save a layout that survives a reload', async () => {
  await menu('Arrange modules');
  await expect(page.locator('.gsp.arranging')).toBeVisible();
  await page.getByRole('button', { name: 'Hide Chaos' }).click();
  await expect.poll(async () => (await slots()).flat()).not.toContain('chaos');
  await page.locator('.gsp-add').selectOption('chaos');
  await expect.poll(async () => (await slots()).slice(-2)).toEqual([['chaos'], ['dock']]);
  await page.getByRole('button', { name: 'Move Chaos up' }).click();
  await expect.poll(async () => (await slots())[4]).toEqual(['sources', 'chaos']);
  await page.getByRole('button', { name: 'Move Chaos earlier' }).click();
  await expect.poll(async () => (await slots())[4]).toEqual(['chaos', 'sources']);
  await page.getByRole('button', { name: 'Move Chaos up' }).click();
  await expect.poll(async () => (await slots())[3]).toEqual(['envelopes', 'lfos', 'chaos']);
  const width = () => page.locator('[data-slot=amp]').evaluate((el) => el.getBoundingClientRect().width);
  const w0 = await width();
  await page.getByRole('button', { name: 'Make Amp wider' }).click();
  await expect.poll(width).toBeGreaterThan(w0);
  // drag Amp by its grip onto Routing: it goes just before it
  await page.locator('[data-slot=amp] .gsp-grip').dragTo(page.locator('[data-slot=routing]'));
  await expect.poll(async () => (await slots())[2]).toEqual(['filter1', 'amp', 'routing', 'filter2']);
  expect(await layoutProblems()).toEqual([]);
  // narrower never takes a module below what its controls need
  await page.getByRole('button', { name: 'Make Oscillator A narrower' }).click();
  await page.getByRole('button', { name: 'Make Oscillator A narrower' }).click();
  expect(await layoutProblems()).toEqual([]);
  await page.getByRole('button', { name: 'Make Oscillator A wider' }).click();
  await page.getByRole('button', { name: 'Make Oscillator A wider' }).click();
  // save it, leave arrange mode, reload: the same arrangement
  await page.locator('.gsp-arrange-bar').getByRole('button', { name: 'Save as…' }).click();
  await page.locator('.modal input').fill('Video: amp first');
  await page.locator('.modal input').press('Enter');
  await page.locator('.gsp-arrange-bar').getByRole('button', { name: 'Done' }).click();
  const saved = await slots();
  await page.reload();
  await expect(page.locator('.toolbar')).toBeVisible();
  await openEditor();
  await expect.poll(slots).toEqual(saved);
  // the layout menu knows it, and can delete it
  await page.locator('.sp-menu-btn').first().click();
  await expect(page.locator('.context-menu .cm-item', { hasText: 'Delete "Video: amp first"' })).toBeVisible();
  await page.locator('.context-menu .cm-item', { hasText: 'Delete "Video: amp first"' }).click();
  await expect.poll(async () => (await slots())[2]).toEqual(['filter1', 'routing', 'filter2', 'amp']);
});

test('built-in layouts, the scope listening to the channel and the play button', async () => {
  await menu('Sound & scope');
  await expect.poll(slots).toEqual([['oscA', 'subnoise'], ['filter1', 'routing', 'amp'], ['envelopes', 'scope']]);
  expect(await layoutProblems()).toEqual([]);
  // no header in this layout: the menu floats in a corner
  await expect(page.locator('.sp-menu-btn.floating')).toBeVisible();
  await expect.poll(() => page.evaluate((cid) => !!window.ggs.engine()?.strips.get(cid)?.scope, lead)).toBe(true);
  // hold a note from the play button (in the Synth layout's header)
  await menu('Synth');
  await expect(page.locator('[data-slot=header]')).toBeVisible();
  await expect.poll(() => page.evaluate((cid) => !!window.ggs.engine()?.strips.get(cid)?.scope, lead)).toBe(false);
  const play = page.locator('.sp-play');
  await play.hover();
  await page.mouse.down();
  try {
    await expect(page.locator('.sp-voices b')).not.toHaveText(/^(0|—)$/, { timeout: 5000 });
  } finally {
    await page.mouse.up();
  }
  // and from the keyboard: Space held down plays, let go stops
  await play.focus();
  await page.keyboard.down(' ');
  try {
    await expect(play).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await page.keyboard.up(' ');
  }
  await expect(play).toHaveAttribute('aria-pressed', 'false');
});

test('full screen: the page alone, scaled to the screen — and dialogs and menus still open above it', async () => {
  await menu('Full screen');
  await expect(page.locator('body > .gsp.solo')).toBeVisible();
  const box = await page.locator('.gsp.solo').boundingBox();
  expect(box.width).toBe(1440);
  expect(await layoutProblems()).toEqual([]);
  await page.locator('.gsp.solo .sp-menu-btn').click();
  await page.locator('.context-menu .cm-item', { hasText: 'Save layout as' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await page.locator('.gsp.solo [data-module=filter1]').getByRole('slider', { name: 'Cutoff', exact: true }).click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
  await page.locator('.gsp.solo [data-module=filter1] h3').click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await page.locator('.gsp.solo .sp-menu-btn').click();
  await page.locator('.context-menu .cm-item', { hasText: 'Exit full screen' }).click();
  await expect(page.locator('.gsp.solo')).toHaveCount(0);
  await expect(page.locator('.ggs .gsp')).toBeVisible();
});

test('a small window: the page shrinks to fit (nothing cut off) and offers full screen or the classic view', async () => {
  await page.setViewportSize({ width: 700, height: 480 });
  await expect.poll(() => page.evaluate(() => Number(document.querySelector('.gsp-page')?.dataset.scale))).toBeLessThan(0.55);
  expect(await layoutProblems()).toEqual([]);
  await expect(page.locator('.gsp-small')).toBeVisible();
  await expect(page.locator('.gsp-small').getByRole('button', { name: 'Classic view' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.gsp-small')).toHaveCount(0);
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
