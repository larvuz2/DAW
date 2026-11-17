// The Overview tab of the synth editor is a grid of modules (an oscillator, a filter, the routing, the envelopes…)
// that can be put in any order, made wider or narrower, hidden and brought back — and the arrangement saved under a
// name. This file is the arrangement alone, as plain data and pure functions; Overview.jsx draws it.
//
// A layout is { name, items: [{ id, w }] }: the modules in reading order, each `w` columns wide on a grid of 12.
// What is not in `items` is hidden.

export const COLUMNS = 12;
export const MIN_WIDTH = 2;

/** Every module there is: its label in menus and the width it takes when it is added. */
export const MODULES = {
  header: { label: 'Preset & macros', w: 12 },
  oscA: { label: 'Oscillator A', w: 3 },
  oscB: { label: 'Oscillator B', w: 3 },
  oscC: { label: 'Oscillator C', w: 3 },
  subnoise: { label: 'Sub & noise', w: 3 },
  filter1: { label: 'Filter 1', w: 4 },
  routing: { label: 'Routing', w: 2 },
  filter2: { label: 'Filter 2', w: 4 },
  amp: { label: 'Amp & voice', w: 2 },
  envelopes: { label: 'Envelopes', w: 4 },
  lfos: { label: 'LFOs', w: 4 },
  chaos: { label: 'Chaos', w: 4 },
  sources: { label: 'Mod sources', w: 12 },
  matrix: { label: 'Mod matrix', w: 5 },
  fx: { label: 'Effects', w: 9 },
  scope: { label: 'Output scope', w: 3 },
  pad: { label: 'Touch pad', w: 7 }
};
export const MODULE_IDS = Object.keys(MODULES);

const L = (name, ...rows) => ({ name, builtIn: true, items: rows.flat().map(([id, w]) => ({ id, w })) });

/** The arrangements that come with the studio; the first is where everyone starts. */
export const BUILT_IN_LAYOUTS = [
  L('Whole patch',
    [['header', 12]],
    [['oscA', 3], ['oscB', 3], ['oscC', 3], ['subnoise', 3]],
    [['filter1', 4], ['routing', 2], ['filter2', 4], ['amp', 2]],
    [['envelopes', 4], ['lfos', 4], ['chaos', 4]],
    [['sources', 12]],
    [['fx', 9], ['scope', 3]],
    [['matrix', 5], ['pad', 7]]),
  L('Oscillators',
    [['oscA', 4], ['oscB', 4], ['oscC', 4]],
    [['subnoise', 4], ['scope', 8]],
    [['pad', 12]]),
  L('Filters, routing & envelopes',
    [['filter1', 5], ['routing', 2], ['filter2', 5]],
    [['envelopes', 6], ['amp', 3], ['scope', 3]]),
  L('Modulation',
    [['sources', 12]],
    [['envelopes', 4], ['lfos', 4], ['chaos', 4]],
    [['matrix', 12]]),
  L('Sound & scope',
    [['oscA', 4], ['filter1', 4], ['scope', 4]],
    [['envelopes', 6], ['fx', 6]]),
  L('Minimal',
    [['header', 12]],
    [['oscA', 6], ['filter1', 6]],
    [['scope', 12]])
];

const clampWidth = (w) => Math.max(MIN_WIDTH, Math.min(COLUMNS, Math.round(Number(w)) || 0));

/** A copy of a layout as it should be: known modules only, each once, widths on the grid. */
export function normalizeLayout(raw, name = 'Custom') {
  const out = { name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : name, items: [] };
  const seen = new Set();
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    if (!it || !MODULES[it.id] || seen.has(it.id)) continue;
    seen.add(it.id);
    out.items.push({ id: it.id, w: clampWidth(it.w ?? MODULES[it.id].w) });
  }
  if (raw?.builtIn) out.builtIn = true;
  if (raw?.edited) out.edited = true; // moved, resized or hidden since it was chosen
  return out;
}

export const defaultLayout = () => normalizeLayout(BUILT_IN_LAYOUTS[0]);
export const hiddenModules = (layout) => MODULE_IDS.filter((id) => !layout.items.some((it) => it.id === id));

/** Put module `id` just before `beforeId` (or at the end when beforeId is null). */
export function moveModule(layout, id, beforeId = null) {
  const item = layout.items.find((it) => it.id === id);
  if (!item || id === beforeId) return layout;
  const rest = layout.items.filter((it) => it.id !== id);
  const at = beforeId ? rest.findIndex((it) => it.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, item);
  return { ...layout, items: rest };
}

/** One place earlier (dir −1) or later (+1) in reading order. */
export function nudgeModule(layout, id, dir) {
  const i = layout.items.findIndex((it) => it.id === id);
  const j = i + Math.sign(dir);
  if (i < 0 || j < 0 || j >= layout.items.length) return layout;
  const items = [...layout.items];
  [items[i], items[j]] = [items[j], items[i]];
  return { ...layout, items };
}

export function resizeModule(layout, id, delta) {
  return { ...layout, items: layout.items.map((it) => (it.id === id ? { ...it, w: clampWidth(it.w + delta) } : it)) };
}

export function hideModule(layout, id) {
  return { ...layout, items: layout.items.filter((it) => it.id !== id) };
}

/** Bring a hidden module back, at the end (or before `beforeId`), at its usual width. */
export function showModule(layout, id, beforeId = null) {
  if (!MODULES[id] || layout.items.some((it) => it.id === id)) return layout;
  return moveModule({ ...layout, items: [...layout.items, { id, w: MODULES[id].w }] }, id, beforeId);
}

// ---- remembered in this browser: the arrangement being used, and the ones saved under a name
const KEY = 'gtd.ggs.overview';

/** { current, saved: [layouts] } from storage — whatever is there, read safely. */
export function loadLayouts(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = JSON.parse(storage?.getItem(KEY) || 'null'); } catch { raw = null; }
  const saved = (Array.isArray(raw?.saved) ? raw.saved : []).map((l) => normalizeLayout(l)).filter((l) => l.items.length)
    .filter((l, i, all) => all.findIndex((x) => x.name === l.name) === i && !BUILT_IN_LAYOUTS.some((b) => b.name === l.name)).slice(0, 30);
  const current = Array.isArray(raw?.current?.items) ? normalizeLayout(raw.current, raw.current.name) : defaultLayout();
  return { current, saved };
}

export function storeLayouts({ current, saved }, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify({ current, saved })); } catch { /* private mode or full: the layout lives for this visit only */ }
}

/** Save `layout` under `name`: a new entry, or the one of that name replaced. Built-in names are not overwritten. */
export function saveAs(saved, layout, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Give the layout a name');
  if (BUILT_IN_LAYOUTS.some((b) => b.name.toLowerCase() === clean.toLowerCase())) throw new Error(`"${clean}" is one of the built-in layouts: choose another name`);
  const entry = normalizeLayout({ ...layout, name: clean, builtIn: false, edited: false }, clean);
  return [...saved.filter((l) => l.name !== clean), entry];
}
