// The synth page's arrangement (src/components/synth/pageLayout.js): rows of modules at the heights they are drawn for,
// moves that keep everything else where it was, a scale that fits any window, storage that survives anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULES, MODULE_IDS, BUILT_IN_LAYOUTS, MIN_W, MAX_W, MAX_SAVED, STORAGE_KEY, GAP, PAD, normalizeLayout, defaultLayout, modulesOf, hiddenModules,
  moveModule, nudgeModule, shiftRow, resizeModule, hideModule, showModule, sameRows, rowHeight, naturalSize, fitScale, moduleWidth, fromGrid, loadLayouts, storeLayouts, saveAs
} from '../src/components/synth/pageLayout.js';

const ids = (l) => l.rows.map((row) => row.map((it) => it.id));
const memory = (init = {}) => {
  const data = { ...init };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};

test('the default layout is the /synth editor: its rows, its heights, every module but the optional ones', () => {
  assert.deepEqual(ids(defaultLayout()), [['header'], ['oscA', 'oscB', 'oscC', 'subnoise'], ['filter1', 'routing', 'filter2', 'amp'], ['envelopes', 'lfos', 'chaos'], ['sources'], ['dock']]);
  assert.deepEqual(defaultLayout().rows.map(rowHeight), [62, 306, 148, 150, 48, 120]);
  assert.deepEqual(hiddenModules(defaultLayout()), ['scope', 'pad']);
  // it is drawn for a 1440 × 900 screen: wide enough for its widest row, and as tall as its rows
  const n = naturalSize(defaultLayout());
  assert.ok(n.width <= 1440 && n.width >= 1300, `width ${n.width}`);
  assert.equal(n.height, 62 + 306 + 148 + 150 + 48 + 120 + GAP * 5 + PAD * 2);
  assert.ok(n.height <= 900);
  for (const l of BUILT_IN_LAYOUTS) {
    assert.deepEqual(normalizeLayout(l, l.name).rows, l.rows, l.name);
    assert.ok(modulesOf(l).every((id) => MODULES[id]), l.name);
  }
  assert.equal(new Set(BUILT_IN_LAYOUTS.map((l) => l.name)).size, BUILT_IN_LAYOUTS.length);
});

test('fitScale: the page fills a window without scrolling, whichever side is short', () => {
  const l = defaultLayout();
  const n = naturalSize(l);
  assert.equal(fitScale(l, n.width, n.height), 1);
  assert.ok(Math.abs(fitScale(l, n.width / 2, 2000) - 0.5) < 1e-9, 'a narrow window scales to its width');
  assert.ok(Math.abs(fitScale(l, 5000, n.height * 0.8) - 0.8) < 1e-9, 'a short window scales to its height');
  assert.ok(Math.abs(fitScale(l, 100, 100) - 100 / n.width) < 1e-9, 'as small as it takes: nothing is ever cut off');
  assert.equal(fitScale(l, 10000, 10000), 1.75, 'never larger than 1.75');
  assert.equal(fitScale(l, 0, 0), 1);
});

test('narrower never goes below the width the controls of a module need', () => {
  for (const id of MODULE_IDS) {
    const m = MODULES[id];
    const w = moduleWidth({ id, w: MIN_W });
    if (m.px) assert.ok(w.px >= m.min, id);
    else assert.equal(w.min, m.min, id);
  }
  // and the page is never drawn narrower than its widest row needs, however its modules are sized
  const squeezed = resizeModule(resizeModule(defaultLayout(), 'oscA', -9), 'chaos', -9);
  assert.equal(naturalSize(squeezed).width, naturalSize(defaultLayout()).width);
});

test('normalizeLayout repairs whatever it is given', () => {
  const l = normalizeLayout({ name: `${'a'.repeat(39)} b`, rows: [[{ id: 'oscA', w: 9 }, { id: 'nope' }, { id: 'constructor' }], [], 'x', [{ id: 'oscA' }, { id: 'fx', w: 0.1 }, { id: 'scope', w: 'wide' }]] });
  assert.equal(l.name, 'a'.repeat(39));
  assert.deepEqual(l.rows, [[{ id: 'oscA', w: MAX_W }], [{ id: 'scope', w: 1 }]]);
  assert.deepEqual(normalizeLayout(null, 'X'), { name: 'X', rows: [] });
  assert.deepEqual(normalizeLayout({ rows: 'oops' }).rows, []);
  assert.equal(normalizeLayout({ rows: [[{ id: 'oscA', w: 0 }]] }).rows[0][0].w, 1, 'no width = the usual width');
  assert.equal(normalizeLayout({ rows: [[{ id: 'oscA', w: 0.3 }]] }).rows[0][0].w, MIN_W);
});

test('moving, nudging, changing rows, resizing, hiding and showing keep everything else where it was', () => {
  const l = defaultLayout();
  assert.deepEqual(ids(moveModule(l, 'scope', { before: 'oscA' })), ids(l), 'a hidden module does not move');
  assert.deepEqual(ids(moveModule(l, 'amp', { before: 'oscA' }))[1], ['amp', 'oscA', 'oscB', 'oscC', 'subnoise']);
  assert.deepEqual(ids(moveModule(l, 'amp', { before: 'oscA' }))[2], ['filter1', 'routing', 'filter2']);
  assert.deepEqual(ids(moveModule(l, 'routing', { row: 0 }))[0], ['header', 'routing']);
  assert.deepEqual(ids(moveModule(l, 'header', { row: 99 })).at(-1), ['header'], 'a row past the end is a new row');
  assert.deepEqual(ids(moveModule(l, 'header', { row: 99 }))[0], ['oscA', 'oscB', 'oscC', 'subnoise'], 'an emptied row goes away');
  assert.equal(moveModule(l, 'oscA', { before: 'oscA' }), l);
  assert.equal(moveModule(l, 'oscA', {}), l);
  // nudge within the row, and stop at its ends
  assert.deepEqual(ids(nudgeModule(l, 'oscB', -1))[1], ['oscB', 'oscA', 'oscC', 'subnoise']);
  assert.equal(nudgeModule(l, 'oscA', -1), l);
  assert.equal(nudgeModule(l, 'subnoise', 1), l);
  // up and down a row; below the last row a new one, unless it is alone there already
  assert.deepEqual(ids(shiftRow(l, 'amp', -1))[1], ['oscA', 'oscB', 'oscC', 'subnoise', 'amp']);
  assert.deepEqual(ids(shiftRow(l, 'chaos', 1))[4], ['sources', 'chaos']);
  assert.equal(shiftRow(l, 'header', -1), l);
  assert.equal(shiftRow(l, 'dock', 1), l);
  // widths stay in range
  assert.equal(resizeModule(l, 'oscA', 9).rows[1][0].w, MAX_W);
  assert.equal(resizeModule(l, 'oscA', -9).rows[1][0].w, MIN_W);
  // hide, and bring back: in a row of its own above the dock
  const hidden = hideModule(hideModule(l, 'chaos'), 'sources');
  assert.deepEqual(ids(hidden).slice(-2), [['envelopes', 'lfos'], ['dock']], 'an emptied row goes away');
  assert.deepEqual(hiddenModules(hidden), ['chaos', 'sources', 'scope', 'pad']);
  assert.deepEqual(ids(showModule(hidden, 'scope')).slice(-2), [['scope'], ['dock']]);
  assert.deepEqual(ids(showModule(hideModule(l, 'dock'), 'scope')).at(-1), ['scope']);
  assert.equal(showModule(l, 'oscA'), l, 'a module already shown is not added twice');
  assert.equal(showModule(l, 'constructor'), l);
  assert.ok(sameRows(l, defaultLayout()) && !sameRows(l, hidden));
  assert.deepEqual(l, defaultLayout(), 'the original is never changed');
});

test('0.14 layouts (a 12-column grid) become rows', () => {
  const old = { name: 'Clip', items: [{ id: 'header', w: 12 }, { id: 'oscA', w: 6 }, { id: 'filter1', w: 6 }, { id: 'fx', w: 9 }, { id: 'matrix', w: 3 }, { id: 'scope', w: 12 }] };
  assert.deepEqual(ids(fromGrid(old)), [['header'], ['oscA', 'filter1'], ['dock'], ['scope']]);
  const store = memory({ 'gtd.ggs.overview': JSON.stringify({ current: old, saved: [old, { name: 'Bad', items: 'x' }] }) });
  const back = loadLayouts(store);
  assert.deepEqual(back.saved.map((l) => l.name), ['Clip']);
  assert.deepEqual(ids(back.current), ids(defaultLayout()), 'the page starts on its own layout');
  // a 0.14 layout called like a new built-in one is kept under another name
  const same = memory({ 'gtd.ggs.overview': JSON.stringify({ saved: [{ name: 'Synth', items: [{ id: 'oscA', w: 12 }] }] }) });
  assert.deepEqual(loadLayouts(same).saved.map((x) => x.name), ['Synth (0.14)']);
});

test('saved layouts: a name is needed, built-in names are refused, at most 30, nothing empty', () => {
  const l = moveModule(defaultLayout(), 'amp', { before: 'oscA' });
  assert.throws(() => saveAs([], l, '  '), /name/);
  assert.throws(() => saveAs([], l, 'SYNTH'), /built-in/);
  assert.throws(() => saveAs([], { name: 'x', rows: [] }, 'Empty'), /hidden/);
  let saved = saveAs([], { ...l, edited: true }, ' Video 1 ');
  assert.equal(saved[0].name, 'Video 1');
  assert.equal(saved[0].edited, undefined);
  assert.equal(saved[0].builtIn, undefined);
  saved = saveAs(saved, defaultLayout(), 'Video 1');
  assert.equal(saved.length, 1);
  assert.deepEqual(ids(saved[0]), ids(defaultLayout()));
  let many = [];
  for (let i = 0; i < MAX_SAVED; i++) many = saveAs(many, l, `L${i}`);
  assert.throws(() => saveAs(many, l, 'One more'), /delete one/);
  assert.equal(saveAs(many, defaultLayout(), 'L3').length, MAX_SAVED);
});

test('storage: round trip, and anything broken or hostile falls back to the default', () => {
  const store = memory();
  assert.deepEqual(loadLayouts(store), { current: defaultLayout(), saved: [] });
  const current = { ...hideModule(defaultLayout(), 'chaos'), edited: true };
  const saved = saveAs([], current, 'Clip');
  storeLayouts({ current, saved }, store);
  assert.ok(store.data[STORAGE_KEY]);
  const back = loadLayouts(store);
  assert.deepEqual(ids(back.current), ids(current));
  assert.equal(back.current.edited, true);
  assert.deepEqual(back.saved, saved);
  for (const junk of ['{', 'null', '42', '{"current":"x","saved":"y"}', '{"current":{"rows":[]},"saved":[{"name":"Synth","rows":[[{"id":"oscA"}]]},{"name":"A","rows":[]}]}']) {
    const r = loadLayouts(memory({ [STORAGE_KEY]: junk }));
    assert.equal(r.saved.length, 0, junk);
    assert.ok(r.current.rows.length > 0, junk);
  }
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.deepEqual(loadLayouts(throwing), { current: defaultLayout(), saved: [] });
  assert.doesNotThrow(() => storeLayouts({ current, saved }, throwing));
  assert.deepEqual(loadLayouts(null), { current: defaultLayout(), saved: [] });
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.deepEqual(loadLayouts(), { current: defaultLayout(), saved: [] });
    assert.doesNotThrow(() => storeLayouts({ current, saved }));
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
  assert.ok(MODULE_IDS.length >= 16);
});
