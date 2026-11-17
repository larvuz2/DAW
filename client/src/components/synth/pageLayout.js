// The synth page is rows of modules, like a hardware panel: every module has a height it is drawn for (an oscillator
// 306 px, a filter 148, the mod sources strip 48 …), a row is as tall as its tallest module, and in a row the modules
// share the width — some at a fixed width, the others by weight. The whole page is then scaled to fit its window, so
// it looks the same on any screen and never scrolls.
//
// This file is the arrangement alone, as plain data and pure functions (SynthPage.jsx draws it):
// a layout is { name, rows: [[{ id, w }]] } — `w` multiplies the module's usual width (0.5 to 3).

export const GAP = 6; // between modules and rows
export const PAD = 6; // around the page
export const MIN_W = 0.5;
export const MAX_W = 3;
export const MAX_SAVED = 30;

/**
 * Every module there is. h: the height it is drawn for; px: a fixed width, or grow: its share of what is left;
 * min: the narrowest it can be before its controls would overlap (the page is scaled down instead).
 */
export const MODULES = {
  header: { label: 'Preset, macros & voice', h: 62, grow: 1, min: 1290 },
  oscA: { label: 'Oscillator A', h: 306, grow: 1, min: 364 },
  oscB: { label: 'Oscillator B', h: 306, grow: 1, min: 364 },
  oscC: { label: 'Oscillator C', h: 306, grow: 1, min: 364 },
  subnoise: { label: 'Sub & noise', h: 306, px: 286, min: 286 },
  filter1: { label: 'Filter 1', h: 148, grow: 1, min: 360 },
  routing: { label: 'Routing', h: 148, px: 214, min: 200 },
  filter2: { label: 'Filter 2', h: 148, grow: 1, min: 360 },
  amp: { label: 'Amp', h: 148, px: 232, min: 232 },
  envelopes: { label: 'Envelopes', h: 150, grow: 1.15, min: 370 },
  lfos: { label: 'LFOs', h: 150, grow: 1.25, min: 420 },
  chaos: { label: 'Chaos', h: 150, px: 400, min: 400 },
  sources: { label: 'Mod sources', h: 48, grow: 1, min: 1330 },
  dock: { label: 'FX rack · matrix · all parameters', h: 120, grow: 1, min: 640, fill: true },
  scope: { label: 'Output scope', h: 150, px: 330, min: 240 },
  pad: { label: 'Touch pad', h: 150, px: 330, min: 200 }
};
export const MODULE_IDS = Object.keys(MODULES);
const isModule = (id) => typeof id === 'string' && Object.hasOwn(MODULES, id);
const cleanName = (name) => String(name ?? '').slice(0, 40).trim();
const clampW = (w) => Math.max(MIN_W, Math.min(MAX_W, Math.round((Number(w) || 1) * 4) / 4));

const L = (name, ...rows) => ({ name, builtIn: true, rows: rows.map((row) => row.map((id) => ({ id, w: 1 }))) });

/** The arrangements that come with the studio; the first is the /synth editor's own. */
export const BUILT_IN_LAYOUTS = [
  L('Synth', ['header'], ['oscA', 'oscB', 'oscC', 'subnoise'], ['filter1', 'routing', 'filter2', 'amp'], ['envelopes', 'lfos', 'chaos'], ['sources'], ['dock']),
  L('Oscillators', ['oscA', 'oscB', 'oscC'], ['subnoise', 'scope', 'pad']),
  L('Filters, routing & envelopes', ['filter1', 'routing', 'filter2'], ['envelopes', 'amp', 'scope']),
  L('Modulation', ['sources'], ['envelopes', 'lfos', 'chaos'], ['dock']),
  L('Sound & scope', ['oscA', 'subnoise'], ['filter1', 'routing', 'amp'], ['envelopes', 'scope']),
  L('Minimal', ['header'], ['oscA', 'filter1'], ['envelopes', 'scope'])
];

/** A copy of a layout as it should be: known modules only, each once, widths in range, no empty rows. */
export function normalizeLayout(raw, name = 'Custom') {
  const out = { name: (typeof raw?.name === 'string' && cleanName(raw.name)) || name, rows: [] };
  const seen = new Set();
  for (const row of Array.isArray(raw?.rows) ? raw.rows : []) {
    const items = [];
    for (const it of Array.isArray(row) ? row : []) {
      if (!it || !isModule(it.id) || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, w: clampW(it.w ?? 1) });
    }
    if (items.length) out.rows.push(items);
  }
  if (raw?.builtIn) out.builtIn = true;
  if (raw?.edited) out.edited = true;
  return out;
}

export const defaultLayout = () => normalizeLayout(BUILT_IN_LAYOUTS[0]);
export const modulesOf = (layout) => layout.rows.flat().map((it) => it.id);
export const hiddenModules = (layout) => MODULE_IDS.filter((id) => !modulesOf(layout).includes(id));
const where = (layout, id) => {
  for (let r = 0; r < layout.rows.length; r++) {
    const i = layout.rows[r].findIndex((it) => it.id === id);
    if (i >= 0) return [r, i];
  }
  return null;
};
const tidy = (layout, rows) => ({ ...layout, rows: rows.filter((row) => row.length) });

/** The same modules in the same rows at the same widths. */
export const sameRows = (a, b) => JSON.stringify(a.rows) === JSON.stringify(b.rows);

/** Put `id` just before `beforeId` (in that module's row), or at the end of row `row` (a new last row when row = rows). */
export function moveModule(layout, id, { before = null, row = null } = {}) {
  const at = where(layout, id);
  if (!at || id === before) return layout;
  const item = layout.rows[at[0]][at[1]];
  const rows = layout.rows.map((r) => r.filter((it) => it.id !== id));
  if (before) {
    const target = where({ rows }, before);
    if (!target) return layout;
    rows[target[0]].splice(target[1], 0, item);
  } else if (row !== null) {
    if (row >= rows.length) rows.push([item]);
    else rows[Math.max(0, row)].push(item);
  } else return layout;
  return tidy(layout, rows);
}

/** One place earlier (−1) or later (+1) in its row. */
export function nudgeModule(layout, id, dir) {
  const at = where(layout, id);
  if (!at) return layout;
  const [r, i] = at;
  const j = i + Math.sign(dir);
  if (j < 0 || j >= layout.rows[r].length) return layout;
  const rows = layout.rows.map((row) => [...row]);
  [rows[r][i], rows[r][j]] = [rows[r][j], rows[r][i]];
  return { ...layout, rows };
}

/** To the row above (−1) or below (+1), at its end; below the last row it starts a new one. */
export function shiftRow(layout, id, dir) {
  const at = where(layout, id);
  if (!at) return layout;
  const target = at[0] + Math.sign(dir);
  if (target < 0) return layout;
  if (target >= layout.rows.length && layout.rows[at[0]].length === 1) return layout; // alone in the last row already
  return moveModule(layout, id, { row: target });
}

export function resizeModule(layout, id, delta) {
  return { ...layout, rows: layout.rows.map((row) => row.map((it) => (it.id === id ? { ...it, w: clampW(it.w + delta) } : it))) };
}

export function hideModule(layout, id) {
  return tidy(layout, layout.rows.map((row) => row.filter((it) => it.id !== id)));
}

/** Bring a hidden module back: in a row of its own, above the dock when there is one, else at the end. */
export function showModule(layout, id) {
  if (!isModule(id) || modulesOf(layout).includes(id)) return layout;
  const rows = layout.rows.map((row) => [...row]);
  const dock = rows.findIndex((row) => row.some((it) => it.id === 'dock'));
  rows.splice(dock >= 0 && id !== 'dock' ? dock : rows.length, 0, [{ id, w: 1 }]);
  return { ...layout, rows };
}

// ---- sizes -------------------------------------------------------------------------------------------------------

export const rowHeight = (row) => Math.max(...row.map((it) => MODULES[it.id].h));
/**
 * How a module takes its row's width: a fixed `px`, or a `grow` share never narrower than `min` — the width its controls
 * need. "Narrower" (w < 1) only gives away space a module has beyond that; it never makes controls overlap.
 */
export function moduleWidth(it) {
  const m = MODULES[it.id];
  return m.px ? { px: Math.max(m.min, m.px * it.w) } : { grow: m.grow * it.w, min: m.min };
}
const rowMinWidth = (row) => row.reduce((sum, it) => { const w = moduleWidth(it); return sum + (w.px ?? w.min); }, 0) + GAP * (row.length - 1);

/** The size the page is drawn at before it is scaled: wide enough for every row, as tall as its rows. */
export function naturalSize(layout) {
  const rows = layout.rows;
  const width = Math.max(900, ...rows.map(rowMinWidth)) + PAD * 2;
  const height = rows.reduce((sum, row) => sum + rowHeight(row), 0) + GAP * Math.max(0, rows.length - 1) + PAD * 2;
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

/** Below this the page is too small to use: it still fits (nothing is cut), and it offers the classic view. */
export const SMALL_SCALE = 0.55;

/** How much to scale the page so all of it fits a box of w × h without scrolling (never more than 1.75). */
export function fitScale(layout, w, h) {
  const n = naturalSize(layout);
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.max(0.05, Math.min(1.75, w / n.width, h / n.height));
}

// ---- remembered in this browser ---------------------------------------------------------------------------------

export const STORAGE_KEY = 'gtd.ggs.page';
const OLD_KEY = 'gtd.ggs.overview'; // 0.14: a 12-column grid of the Overview tab
const storageOf = (storage) => (storage === undefined ? globalThis.localStorage : storage);

/** A 0.14 layout (items on a 12-column grid) as rows: the items that filled a line of 12 columns become a row. */
export function fromGrid(old) {
  const rename = { fx: 'dock', matrix: 'dock' };
  const rows = [];
  let row = [];
  let used = 0;
  for (const it of Array.isArray(old?.items) ? old.items : []) {
    const id = rename[it?.id] || it?.id;
    const w = Math.max(1, Math.min(12, Number(it?.w) || 12));
    if (used + w > 12 && row.length) { rows.push(row); row = []; used = 0; }
    row.push({ id, w: 1 });
    used += w;
  }
  if (row.length) rows.push(row);
  return normalizeLayout({ name: old?.name, rows }, 'Custom');
}

/** { current, saved } from storage — whatever is there, read safely (0.14 layouts are converted). */
export function loadLayouts(storage) {
  let raw = null;
  let old = null;
  try {
    const s = storageOf(storage);
    raw = JSON.parse(s?.getItem(STORAGE_KEY) || 'null');
    if (!raw) old = JSON.parse(s?.getItem(OLD_KEY) || 'null');
  } catch { raw = null; old = null; }
  if (!raw && old) {
    raw = { saved: (Array.isArray(old.saved) ? old.saved : []).map(fromGrid).map((l) => (BUILT_IN_LAYOUTS.some((b) => b.name.toLowerCase() === l.name.toLowerCase()) ? { ...l, name: `${l.name} (0.14)` } : l)) };
  }
  const saved = (Array.isArray(raw?.saved) ? raw.saved : []).map((l) => normalizeLayout(l)).filter((l) => l.rows.length)
    .filter((l, i, all) => all.findIndex((x) => x.name === l.name) === i && !BUILT_IN_LAYOUTS.some((b) => b.name === l.name)).slice(0, MAX_SAVED);
  const current = Array.isArray(raw?.current?.rows) ? normalizeLayout(raw.current, raw.current.name) : defaultLayout();
  return { current: current.rows.length ? current : defaultLayout(), saved };
}

export function storeLayouts({ current, saved }, storage) {
  try { storageOf(storage)?.setItem(STORAGE_KEY, JSON.stringify({ current, saved })); } catch { /* blocked or full: this visit only */ }
}

/** Save `layout` under `name`: a new entry, or the one of that name replaced. Built-in names are not overwritten. */
export function saveAs(saved, layout, name) {
  const clean = cleanName(name);
  if (!clean) throw new Error('Give the layout a name');
  if (BUILT_IN_LAYOUTS.some((b) => b.name.toLowerCase() === clean.toLowerCase())) throw new Error(`"${clean}" is one of the built-in layouts: choose another name`);
  if (!layout.rows.length) throw new Error('Every module is hidden: add one before saving the layout');
  if (saved.length >= MAX_SAVED && !saved.some((l) => l.name === clean)) throw new Error(`There are already ${MAX_SAVED} saved layouts: delete one first`);
  const entry = normalizeLayout({ ...layout, name: clean, builtIn: false, edited: false }, clean);
  return [...saved.filter((l) => l.name !== clean), entry];
}
