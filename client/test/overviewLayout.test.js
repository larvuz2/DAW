// The Overview tab's arrangements (src/components/synth/overviewLayout.js): every module placed once on a grid of 12,
// moves that keep the rest in order, and storage that survives anything a browser might hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULES, MODULE_IDS, BUILT_IN_LAYOUTS, COLUMNS, MIN_WIDTH, normalizeLayout, defaultLayout, hiddenModules, moveModule, nudgeModule, resizeModule,
  hideModule, showModule, sameItems, loadLayouts, storeLayouts, saveAs, MAX_SAVED, STORAGE_KEY
} from '../src/components/synth/overviewLayout.js';

const ids = (l) => l.items.map((it) => it.id);
const memory = (init = {}) => {
  const data = { ...init };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};

test('the built-in layouts name only real modules, each once, with widths on the grid; the first shows everything', () => {
  for (const l of BUILT_IN_LAYOUTS) {
    assert.deepEqual(normalizeLayout(l, l.name).items, l.items, l.name);
    for (const { w } of l.items) assert.ok(w >= MIN_WIDTH && w <= COLUMNS, `${l.name}: ${w}`);
  }
  assert.deepEqual(ids(defaultLayout()).sort(), [...MODULE_IDS].sort());
  assert.equal(new Set(BUILT_IN_LAYOUTS.map((l) => l.name)).size, BUILT_IN_LAYOUTS.length);
  // the rows of "Whole patch" fill the 12 columns exactly, so nothing is left ragged
  let row = 0;
  for (const { w } of defaultLayout().items) {
    row += w;
    if (row === COLUMNS) row = 0;
    assert.ok(row < COLUMNS, 'a row overflows');
  }
  assert.equal(row, 0);
});

test('normalizeLayout repairs whatever it is given', () => {
  const l = normalizeLayout({ name: '  Mine  ', items: [{ id: 'oscA', w: 40 }, { id: 'nope', w: 3 }, { id: 'oscA', w: 2 }, { id: 'fx', w: 0.4 }, null, { id: 'scope' }] });
  assert.equal(l.name, 'Mine');
  assert.deepEqual(l.items, [{ id: 'oscA', w: COLUMNS }, { id: 'fx', w: MIN_WIDTH }, { id: 'scope', w: MODULES.scope.w }]);
  assert.deepEqual(normalizeLayout(null, 'X'), { name: 'X', items: [] });
  // names of the object's own machinery are not modules
  assert.deepEqual(normalizeLayout({ items: [{ id: 'constructor' }, { id: '__proto__' }, { id: 'toString' }, { id: 'oscA' }] }).items.map((it) => it.id), ['oscA']);
  assert.equal(showModule(defaultLayout(), 'constructor').items.length, MODULE_IDS.length);
  // a name cut to 40 characters loses the space it was cut at
  assert.equal(normalizeLayout({ name: `${'a'.repeat(39)} b`, items: [] }).name, 'a'.repeat(39));
  assert.deepEqual(normalizeLayout({ items: 'oops' }).items, []);
});

test('move, nudge, resize, hide and show keep every other module where it was', () => {
  const l = defaultLayout();
  assert.ok(sameItems(l, defaultLayout()));
  assert.ok(sameItems(moveModule(l, 'oscA', 'oscB'), l), 'dropped on its next neighbour: nothing moved');
  assert.ok(!sameItems(moveModule(l, 'oscB', 'oscA'), l));
  const moved = moveModule(l, 'scope', 'header');
  assert.deepEqual(ids(moved), ['scope', ...ids(l).filter((id) => id !== 'scope')]);
  assert.deepEqual(ids(moveModule(l, 'header', null)), [...ids(l).slice(1), 'header']);
  assert.equal(moveModule(l, 'nope', 'header'), l);
  assert.equal(moveModule(l, 'scope', 'scope'), l);
  // nudge swaps with the neighbour, and stops at the ends
  assert.deepEqual(ids(nudgeModule(l, 'oscB', -1)).slice(0, 4), ['header', 'oscB', 'oscA', 'oscC']);
  assert.equal(nudgeModule(l, 'header', -1), l);
  assert.equal(nudgeModule(l, ids(l).at(-1), 1), l);
  // widths stay on the grid
  assert.equal(resizeModule(l, 'oscA', 99).items.find((it) => it.id === 'oscA').w, COLUMNS);
  assert.equal(resizeModule(l, 'oscA', -99).items.find((it) => it.id === 'oscA').w, MIN_WIDTH);
  // hidden modules come back at their usual width, at the end or before the one named
  const hidden = hideModule(hideModule(l, 'chaos'), 'pad');
  assert.deepEqual(hiddenModules(hidden), ['chaos', 'pad']);
  assert.deepEqual(ids(showModule(hidden, 'chaos')).at(-1), 'chaos');
  const before = showModule(hidden, 'pad', 'oscA');
  assert.equal(ids(before)[ids(before).indexOf('oscA') - 1], 'pad');
  assert.equal(before.items.find((it) => it.id === 'pad').w, MODULES.pad.w);
  assert.equal(showModule(l, 'oscA'), l, 'a module already shown is not added twice');
  assert.equal(showModule(l, 'nope'), l);
  // the original is never changed
  assert.deepEqual(l, defaultLayout());
});

test('saved layouts: a name is needed, a built-in name is refused, the same name replaces', () => {
  const l = moveModule(defaultLayout(), 'scope', 'header');
  assert.throws(() => saveAs([], l, '   '), /name/);
  assert.throws(() => saveAs([], l, 'whole PATCH'), /built-in/);
  let saved = saveAs([], { ...l, edited: true }, ' Video 1 ');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Video 1');
  assert.equal(saved[0].builtIn, undefined);
  assert.equal(saved[0].edited, undefined);
  saved = saveAs(saved, defaultLayout(), 'Video 1');
  assert.equal(saved.length, 1);
  assert.equal(ids(saved[0])[0], 'header');
  saved = saveAs(saved, l, 'Video 2');
  assert.deepEqual(saved.map((s) => s.name), ['Video 1', 'Video 2']);
  // the same name however it is cut: one entry
  saved = saveAs([], l, `${'b'.repeat(39)} x`);
  saved = saveAs(saved, l, `${'b'.repeat(39)} y`);
  assert.equal(saved.length, 1);
  // nothing to save, and a limit that is the same whether saving or loading
  assert.throws(() => saveAs([], { name: 'x', items: [] }, 'Empty'), /hidden/);
  let many = [];
  for (let i = 0; i < MAX_SAVED; i++) many = saveAs(many, l, `L${i}`);
  assert.throws(() => saveAs(many, l, 'One more'), /delete one/);
  assert.equal(saveAs(many, defaultLayout(), 'L3').length, MAX_SAVED, 'replacing one is still allowed');
  const store = memory();
  storeLayouts({ current: many.at(-1), saved: many }, store);
  assert.deepEqual(loadLayouts(store).saved.map((x) => x.name), many.map((x) => x.name));
});

test('storage: round trip, and anything broken or hostile falls back to the default', () => {
  const store = memory();
  assert.deepEqual(loadLayouts(store), { current: defaultLayout(), saved: [] });
  const current = { ...hideModule(defaultLayout(), 'pad'), edited: true };
  const saved = saveAs([], current, 'Clip');
  storeLayouts({ current, saved }, store);
  const back = loadLayouts(store);
  assert.deepEqual(ids(back.current), ids(current));
  assert.equal(back.current.edited, true, 'a changed layout still says so after a reload');
  assert.deepEqual(back.saved, saved);
  for (const junk of ['{', 'null', '42', '{"current":"x","saved":"y"}', '{"saved":[{"name":"Whole patch","items":[{"id":"oscA"}]},{"name":"A","items":[]},{"name":"B","items":[{"id":"x"}]}]}']) {
    const s = memory({ 'gtd.ggs.overview': junk });
    const r = loadLayouts(s);
    assert.ok(Array.isArray(r.saved) && r.saved.length === 0, junk);
    assert.ok(Array.isArray(r.current.items), junk);
  }
  // a storage that throws (private mode, quota) is no error
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.deepEqual(loadLayouts(throwing), { current: defaultLayout(), saved: [] });
  assert.doesNotThrow(() => storeLayouts({ current, saved }, throwing));
  // and no storage at all
  assert.deepEqual(loadLayouts(null), { current: defaultLayout(), saved: [] });
  // localStorage that throws as soon as it is touched (site data blocked)
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.deepEqual(loadLayouts(), { current: defaultLayout(), saved: [] });
    assert.doesNotThrow(() => storeLayouts({ current, saved }));
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
  assert.equal(STORAGE_KEY, 'gtd.ggs.overview');
});
