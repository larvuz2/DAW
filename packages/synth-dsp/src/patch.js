// The structured view of a GGS Synth patch. Inside a project a patch is a flat params object (like every other
// instrument); for people, files and agents the same patch reads better as a document with oscillators, filters,
// envelopes, LFOs and a list of modulation routes. These two functions convert between the forms, and
// PATCH_FIELDS — readable field name → param key suffix — is the one mapping both they and the MCP tools use.
import { GGS_PARAMS, OSC_IDS, ENV_COUNT, LFO_COUNT, LFO_STEPS, MACRO_COUNT, CHAOS_COUNT, MOD_SLOTS, MOD_SOURCES, MOD_TARGETS, ggsDefaults, ggsParamDef, migrateParams } from './params.js';
import { FILTER_INFO } from './filters.js';

export const PATCH_FORMAT = 'ggs-synth-patch';
export const PATCH_VERSION = 1;

export const PATCH_FIELDS = {
  oscillator: {
    on: 'On', table: 'Table', position: 'Pos', level: 'Level', pan: 'Pan', octave: 'Oct', semi: 'Semi', fine: 'Fine',
    unison: 'Unison', detune: 'Detune', blend: 'Blend', spread: 'Spread', phase: 'Phase', phaseRandom: 'Rand',
    warp: 'Warp', warpAmount: 'WarpAmt', fmFrom: 'FmFrom', fm: 'Fm', to: 'Dest'
  },
  sub: { level: 'subLevel', wave: 'subWave', octave: 'subOct', to: 'subDest' },
  noise: { level: 'noiseLevel', type: 'noiseType', color: 'noiseColor', to: 'noiseDest' },
  filter: { on: 'On', type: 'Type', cutoff: 'Cutoff', resonance: 'Res', drive: 'Drive', keyTrack: 'Key', morph: 'Morph' },
  envelope: {
    delay: 'Delay', attack: 'A', hold: 'Hold', decay: 'D', sustain: 'S', release: 'R',
    attackCurve: 'ACurve', decayCurve: 'DCurve', releaseCurve: 'RCurve'
  },
  // (an LFO also takes `steps`: the list of heights of the drawn shape — see sectionToParams)
  lfo: { shape: 'Shape', rate: 'Rate', sync: 'Sync', trigger: 'Trig', fade: 'Fade', phase: 'Phase', smooth: 'Smooth' },
  chaos: { type: 'Type', rate: 'Rate', sync: 'Sync', character: 'Char', steps: 'Steps', path: 'Path' },
  voice: {
    level: 'level', velocity: 'velSens', releaseVelocity: 'relVelSens', polyphony: 'polyphony', mono: 'mono', legato: 'legato',
    glide: 'glide', quality: 'quality', gain: 'gain'
  },
  drive: { amount: 'driveAmt', type: 'driveType' },
  chorus: { mix: 'chorusMix', rate: 'chorusRate', depth: 'chorusDepth' },
  delay: { mix: 'delayMix', sync: 'delaySync', time: 'delayTime', feedback: 'delayFb', tone: 'delayTone', pingPong: 'delayPing' },
  reverb: { mix: 'reverbMix', size: 'reverbSize', damping: 'reverbDamp' }
};

/** The param key of a field: sectionKey('oscillator', 'B', 'position') → "oscBPos". */
export function sectionKey(section, id, field) {
  const map = PATCH_FIELDS[section];
  const suffix = map?.[field];
  if (!suffix) throw new Error(`Unknown ${section} field "${field}". Valid: ${Object.keys(map || {}).join(', ')}`);
  if (section === 'oscillator') return `osc${id}${suffix}`;
  if (section === 'filter') return `f${id}${suffix}`;
  if (section === 'envelope') return `env${id}${suffix}`;
  if (section === 'lfo') return `lfo${id}${suffix}`;
  if (section === 'chaos') return `chaos${id}${suffix}`;
  return suffix;
}

/** { field: value } of one section → { paramKey: value }. Unknown fields throw (with the valid ones). */
export function sectionToParams(section, id, fields) {
  const out = {};
  for (const [field, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (section === 'lfo' && field === 'steps') {
      // the drawn shape as a list: its length is the step count
      if (!Array.isArray(value) || value.length < 2 || value.length > LFO_STEPS) throw new Error(`An LFO's steps must be a list of 2 to ${LFO_STEPS} values from -1 to 1`);
      out[`lfo${id}Steps`] = value.length;
      value.forEach((v, k) => { out[`lfo${id}S${k + 1}`] = v; });
      continue;
    }
    out[sectionKey(section, id, field)] = value;
  }
  return out;
}

/** One section of a flat params object as { field: value }. */
export function paramsToSection(params, section, id) {
  const out = {};
  for (const field of Object.keys(PATCH_FIELDS[section])) out[field] = params[sectionKey(section, id, field)];
  if (section === 'lfo') {
    // the drawn shape is part of the LFO while it is in use — or once something has been drawn, so that a shape is
    // not lost by trying another one before saving
    const count = params[`lfo${id}Steps`];
    const steps = Array.from({ length: count }, (_, k) => params[`lfo${id}S${k + 1}`]);
    const drawn = count !== ggsParamDef(`lfo${id}Steps`).default || steps.some((v, k) => v !== ggsParamDef(`lfo${id}S${k + 1}`).default);
    if (out.shape === 'steps' || drawn) out.steps = steps;
    else if (!out.smooth) delete out.smooth;
  }
  return out;
}

/** The active modulation routes of a flat params object: [{ slot, source, target, amount, via? }]. */
export function modulationRoutes(params) {
  const out = [];
  for (let i = 1; i <= MOD_SLOTS; i++) {
    const source = params[`mod${i}Src`];
    const target = params[`mod${i}Dst`];
    const amount = params[`mod${i}Amt`];
    if (!source || source === 'none' || !target || target === 'none' || !amount) continue;
    const via = params[`mod${i}Via`];
    out.push({ slot: i, source, target, amount, ...(via && via !== 'none' ? { via } : {}) });
  }
  return out;
}

/** Modulation routes → the flat mod params of ALL slots (unused slots are cleared). */
export function routesToParams(routes) {
  if (!Array.isArray(routes)) throw new Error('modulation must be a list of { source, target, amount, via? }');
  if (routes.length > MOD_SLOTS) throw new Error(`A patch has ${MOD_SLOTS} modulation slots; ${routes.length} routes were given`);
  const out = {};
  for (let i = 1; i <= MOD_SLOTS; i++) {
    const r = routes[i - 1];
    if (r) checkRoute(r);
    out[`mod${i}Src`] = r?.source ?? 'none';
    out[`mod${i}Dst`] = r?.target ?? 'none';
    out[`mod${i}Amt`] = r?.amount ?? 0;
    out[`mod${i}Via`] = r?.via ?? 'none';
  }
  return out;
}

export function checkRoute(r) {
  if (!r || typeof r !== 'object') throw new Error('A modulation route is { source, target, amount, via? }');
  if (!MOD_SOURCES.includes(r.source)) throw new Error(`Unknown modulation source "${r.source}". Sources: ${MOD_SOURCES.filter((s) => s !== 'none').join(', ')}`);
  if (!MOD_TARGETS.includes(r.target)) throw new Error(`Unknown modulation target "${r.target}". Targets: ${MOD_TARGETS.filter((s) => s !== 'none').join(', ')}`);
  if (typeof r.amount !== 'number' || !(r.amount >= -1 && r.amount <= 1)) throw new Error(`Modulation amount must be a number from -1 to 1 (got ${r.amount})`);
  if (r.via !== undefined && r.via !== null && !MOD_SOURCES.includes(r.via)) throw new Error(`Unknown modulation "via" source "${r.via}"`);
}

// ---- modulation routes in words ---------------------------------------------------------------------------------

const SOURCE_LABELS = {
  env1: 'Env 1 (amp)', env2: 'Env 2', env3: 'Env 3', env4: 'Env 4', lfo1: 'LFO 1', lfo2: 'LFO 2', lfo3: 'LFO 3', lfo4: 'LFO 4',
  velocity: 'velocity', pressure: 'pressure', timbre: 'slide', bend: 'pitch bend', key: 'key position', random: 'the per-note random',
  releaseVel: 'release velocity', ...Object.fromEntries(Array.from({ length: MACRO_COUNT }, (_, i) => [`macro${i + 1}`, `Macro ${i + 1}`])),
  chaos1: 'Chaos 1', chaos2: 'Chaos 2'
};
/** Sources that swing both ways (-1..1); the others run 0..1. */
export const BIPOLAR_SOURCES = new Set(['lfo1', 'lfo2', 'lfo3', 'lfo4', 'bend', 'key', 'random', 'chaos1', 'chaos2']);
export const modSourceLabel = (source) => SOURCE_LABELS[source] || source;

/**
 * What a modulation target is in real terms for a given patch: its name, where its knob stands, how an amount moves
 * it (add: + amount·scale · oct: × 2^(amount·scale) · semi: semitones) and where it stops. This mirrors what the
 * voice does with each target (GgsVoice.control) — keep the two together.
 */
export function modTargetSpec(target, params) {
  const p = params || ggsDefaults();
  const osc = /^osc([ABC])(Pitch|Pos|Level|Pan|WarpAmt|Fm|Detune)$/.exec(target);
  if (osc) {
    const [, x, what] = osc;
    const name = `Osc ${x}`;
    switch (what) {
      case 'Pitch': return { label: `${name} pitch`, kind: 'semi', scale: 24, base: p[`osc${x}Oct`] * 12 + p[`osc${x}Semi`] + p[`osc${x}Fine`] / 100 };
      case 'Pos': return { label: `${name} position`, kind: 'add', scale: 1, base: p[`osc${x}Pos`], min: 0, max: 1 };
      case 'Level': return { label: `${name} level`, kind: 'add', scale: 1, base: p[`osc${x}Level`], min: 0, max: 2 };
      case 'Pan': return { label: `${name} pan`, kind: 'add', scale: 1, base: p[`osc${x}Pan`], min: -1, max: 1 };
      case 'WarpAmt': return { label: `${name} warp`, kind: 'add', scale: 1, base: p[`osc${x}WarpAmt`], min: 0, max: 1 };
      case 'Fm': return { label: `${name} FM`, kind: 'add', scale: 1, base: p[`osc${x}Fm`], min: 0, max: 1 };
      default: return { label: `${name} detune`, kind: 'add', scale: 100, base: p[`osc${x}Detune`], min: 0, max: 200, unit: 'ct' };
    }
  }
  const filter = /^f([12])(Cutoff|Res|Drive|Morph)$/.exec(target);
  if (filter) {
    const [, i, what] = filter;
    const name = `Filter ${i}`;
    if (what === 'Cutoff') return { label: `${name} cutoff`, kind: 'oct', scale: 10, base: p[`f${i}Cutoff`], min: 16, max: 21000, unit: 'Hz' };
    if (what === 'Morph') return { label: `${name} ${(FILTER_INFO[p[`f${i}Type`]]?.morph || 'morph').toLowerCase()}`, kind: 'add', scale: 1, base: p[`f${i}Morph`], min: 0, max: 1 };
    return { label: `${name} ${what === 'Res' ? 'resonance' : 'drive'}`, kind: 'add', scale: 1, base: p[`f${i}${what}`], min: 0, max: 1 };
  }
  const lfo = /^lfo([1-4])Rate$/.exec(target);
  if (lfo) {
    const synced = p[`lfo${lfo[1]}Sync`] !== 'off';
    // a free-running LFO is tied to the clock (so that every note hears the same LFO): its speed cannot be bent
    const inert = p[`lfo${lfo[1]}Trig`] === 'free' ? `LFO ${lfo[1]} is free-running (trigger "free"), and a free LFO keeps to the clock — set its trigger to "note" to modulate its rate` : undefined;
    return { label: `LFO ${lfo[1]} rate`, kind: 'oct', scale: 4, base: synced ? 1 : p[`lfo${lfo[1]}Rate`], min: 0, max: Infinity, unit: synced ? '×' : 'Hz', inert };
  }
  switch (target) {
    case 'pitch': return { label: 'Pitch', kind: 'semi', scale: 24, base: 0 };
    case 'pitchFine': return { label: 'Pitch', kind: 'semi', scale: 1, base: 0 };
    case 'level': return { label: 'Level', kind: 'add', scale: 1, base: p.level, min: 0, max: 2 };
    case 'pan': return { label: 'Pan', kind: 'add', scale: 1, base: 0, min: -1, max: 1 };
    case 'subLevel': return { label: 'Sub level', kind: 'add', scale: 1, base: p.subLevel, min: 0, max: 2 };
    case 'noiseLevel': return { label: 'Noise level', kind: 'add', scale: 1, base: p.noiseLevel, min: 0, max: 2 };
    default: return null;
  }
}
export const modTargetLabel = (target, params) => modTargetSpec(target, params)?.label || target;

const trim = (x, digits) => String(Number(x.toFixed(digits)));
function formatTarget(spec, v) {
  if (spec.kind === 'semi') {
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    const a = Math.abs(v);
    return a > 0 && a < 1 ? `${sign}${Math.round(a * 100)} ct` : `${sign}${trim(a, 1)} st`;
  }
  if (spec.unit === 'Hz') return v >= 1000 ? `${trim(v / 1000, v >= 10000 ? 1 : 2)} kHz` : `${trim(v, v >= 100 ? 0 : v >= 10 ? 1 : 2)} Hz`;
  if (spec.unit === '×') return `×${trim(v, 2)}`;
  if (spec.unit === 'ct') return `${Math.round(v)} ct`;
  return trim(v, 2).replace('-', '−');
}

/**
 * Where a route takes its target when the source is at `x`: { value (clamped to the control's range), limited }.
 * Other routes to the same target are not counted — this is the one route alone.
 */
export function routeValue(spec, amount, x) {
  const raw = spec.kind === 'oct' ? spec.base * Math.pow(2, amount * spec.scale * x) : spec.base + amount * spec.scale * x;
  const min = spec.min ?? -Infinity;
  const max = spec.max ?? Infinity;
  const value = raw < min ? min : raw > max ? max : raw;
  return { value, limited: value !== raw };
}

/**
 * A modulation route as a sentence in the units of its target, e.g.
 * "Filter 1 cutoff 850 Hz → 4.49 kHz as pressure goes 0 → 1" or "Pitch −14 ct ↔ +14 ct as LFO 1 swings −1 ↔ 1".
 * route: { source, target, amount, via? }; params: the patch (for where the target's knob stands).
 */
export function describeRoute(params, route) {
  const spec = modTargetSpec(route.target, params);
  if (!spec || !route.amount || !SOURCE_LABELS[route.source]) return '';
  if (spec.inert) return `${spec.label}: no effect — ${spec.inert}`;
  const bipolar = BIPOLAR_SOURCES.has(route.source);
  const from = routeValue(spec, route.amount, bipolar ? -1 : 0);
  const to = routeValue(spec, route.amount, 1);
  const src = modSourceLabel(route.source);
  const how = bipolar ? `${formatTarget(spec, from.value)} ↔ ${formatTarget(spec, to.value)} as ${src} swings −1 ↔ 1` : `${formatTarget(spec, from.value)} → ${formatTarget(spec, to.value)} as ${src} goes 0 → 1`;
  const via = route.via && route.via !== 'none' ? `, depth scaled by ${modSourceLabel(route.via)}` : '';
  const end = from.limited || to.limited ? ' (stops at the end of its range)' : '';
  return `${spec.label} ${how}${via}${end}`;
}

/** Every active route of a patch as sentences. */
export const describeRoutes = (params) => modulationRoutes(params).map((r) => describeRoute(params, r));

/**
 * How far the matrix can move each target, all routes together: { target: { lo, hi } } in matrix units (what the
 * voice sums before scaling; 0 = the knob's own position). A unipolar source pushes one way, a bipolar one both;
 * "via" only scales a route down, so it does not widen the range. This is what the rings around the knobs show.
 */
export function modulationRanges(params) {
  const out = {};
  for (const r of modulationRoutes(params)) {
    const range = out[r.target] || (out[r.target] = { lo: 0, hi: 0, routes: 0 });
    const both = BIPOLAR_SOURCES.has(r.source) || (r.via && BIPOLAR_SOURCES.has(r.via));
    const a = Math.abs(r.amount);
    if (both) { range.lo -= a; range.hi += a; } else if (r.amount > 0) range.hi += a; else range.lo -= a;
    range.routes++;
  }
  return out;
}

/** Where a target stands when the matrix adds `d` (matrix units) to it — the knob's unit, clamped to its range. */
export const targetValue = (spec, d) => routeValue(spec, 1, d).value;

/**
 * What a macro is called. A preset names its macros; a macro the preset does not name (or one the player has
 * rerouted from scratch) is called after what it moves — "F1 cutoff", "F1 cutoff +2" — and "Macro n" while it moves
 * nothing. labels: the preset's names, if any.
 */
export function macroLabel(params, n, labels) {
  if (labels?.[n - 1]) return labels[n - 1];
  const routes = modulationRoutes(params).filter((r) => r.source === `macro${n}` || r.via === `macro${n}`);
  if (!routes.length) return `Macro ${n}`;
  const first = modTargetLabel(routes[0].target, params).replace(/^Filter (\d)/, 'F$1').replace(/^Osc ([ABC]) /, '$1 ').replace('position', 'pos').replace('resonance', 'res');
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return routes.length > 1 ? `${name} +${routes.length - 1}` : name;
}

/** Is a macro routed anywhere (as a source or as the "via" of a route)? */
export const macroUsed = (params, n) => modulationRoutes(params).some((r) => r.source === `macro${n}` || r.via === `macro${n}`);

/** A flat params object as a patch document. */
export function paramsToPatch(params, { name = 'Patch' } = {}) {
  const p = { ...ggsDefaults(), ...params };
  return {
    format: PATCH_FORMAT,
    version: PATCH_VERSION,
    name,
    oscillators: OSC_IDS.map((id) => ({ id, ...paramsToSection(p, 'oscillator', id) })),
    sub: paramsToSection(p, 'sub'),
    noise: paramsToSection(p, 'noise'),
    filters: [1, 2].map((id) => ({ id, ...paramsToSection(p, 'filter', id) })),
    filterRouting: p.filterRoute,
    envelopes: Array.from({ length: ENV_COUNT }, (_, i) => ({ id: i + 1, ...paramsToSection(p, 'envelope', i + 1) })),
    lfos: Array.from({ length: LFO_COUNT }, (_, i) => ({ id: i + 1, ...paramsToSection(p, 'lfo', i + 1) })),
    chaos: Array.from({ length: CHAOS_COUNT }, (_, i) => ({ id: i + 1, ...paramsToSection(p, 'chaos', i + 1) })),
    macros: Array.from({ length: MACRO_COUNT }, (_, i) => p[`macro${i + 1}`]),
    modulation: modulationRoutes(p).map(({ slot: _slot, ...r }) => r),
    voice: paramsToSection(p, 'voice'),
    effects: { drive: paramsToSection(p, 'drive'), chorus: paramsToSection(p, 'chorus'), delay: paramsToSection(p, 'delay'), reverb: paramsToSection(p, 'reverb') }
  };
}

/**
 * A patch document → flat params: only what the document mentions (merge it over the defaults or over an existing
 * patch). Unknown sections, ids or fields throw with the valid names; value ranges are checked by the caller against
 * GGS_PARAMS (the studio's usual param validation).
 */
export function patchToParams(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('A patch must be an object');
  if (patch.format !== undefined && patch.format !== PATCH_FORMAT) throw new Error(`Not a GGS Synth patch (format "${patch.format}", expected "${PATCH_FORMAT}")`);
  if (patch.version !== undefined && patch.version > PATCH_VERSION) throw new Error(`This patch is version ${patch.version}; this build reads up to version ${PATCH_VERSION}`);
  const out = {};
  const listOf = (v, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
    return v;
  };
  for (const o of listOf(patch.oscillators, 'oscillators')) {
    const id = String(o?.id || '').replace(/^osc_?/i, '').toUpperCase();
    if (!OSC_IDS.includes(id)) throw new Error(`Unknown oscillator "${o?.id}". Oscillators: ${OSC_IDS.join(', ')}`);
    const { id: _id, ...fields } = o;
    // describing an oscillator means wanting to hear it: it is switched on unless the document says otherwise
    Object.assign(out, sectionToParams('oscillator', id, { ...(Object.keys(fields).length && !('on' in fields) ? { on: true } : {}), ...fields }));
  }
  const numbered = (list, section, count) => {
    for (const item of listOf(list, section === 'chaos' ? 'chaos' : `${section}s`)) {
      const id = Number(item?.id);
      if (!(Number.isInteger(id) && id >= 1 && id <= count)) throw new Error(`Unknown ${section} "${item?.id}": use 1..${count}`);
      const { id: _id, ...fields } = item;
      const implied = section === 'filter' && Object.keys(fields).length && !('on' in fields) ? { on: true } : {};
      if (section === 'envelope' && 'curve' in fields) {
        // a patch file saved before the envelopes had a curve per stage
        if (typeof fields.curve !== 'number' || !(fields.curve >= -1 && fields.curve <= 1)) throw new Error(`Envelope ${id}: "curve" must be a number from -1 to 1 (got ${JSON.stringify(fields.curve)}) — or use attackCurve / decayCurve / releaseCurve`);
        Object.assign(out, migrateParams({ [`env${id}Curve`]: fields.curve }));
        delete fields.curve;
      }
      Object.assign(out, sectionToParams(section, id, { ...implied, ...fields }));
    }
  };
  numbered(patch.filters, 'filter', 2);
  numbered(patch.envelopes, 'envelope', ENV_COUNT);
  numbered(patch.lfos, 'lfo', LFO_COUNT);
  numbered(patch.chaos, 'chaos', CHAOS_COUNT);
  for (const section of ['sub', 'noise', 'voice']) if (patch[section] !== undefined) Object.assign(out, sectionToParams(section, null, patch[section]));
  if (patch.filterRouting !== undefined) out.filterRoute = patch.filterRouting;
  if (patch.macros !== undefined) listOf(patch.macros, 'macros').slice(0, MACRO_COUNT).forEach((v, i) => { out[`macro${i + 1}`] = v; });
  if (patch.modulation !== undefined) Object.assign(out, routesToParams(patch.modulation));
  if (patch.effects !== undefined) {
    for (const [fx, fields] of Object.entries(patch.effects || {})) {
      if (!['drive', 'chorus', 'delay', 'reverb'].includes(fx)) throw new Error(`Unknown effect "${fx}". Effects: drive, chorus, delay, reverb`);
      Object.assign(out, sectionToParams(fx, null, fields));
    }
  }
  for (const key of Object.keys(out)) if (!ggsParamDef(key)) throw new Error(`Unknown parameter "${key}"`);
  return out;
}

/** Compact reference of every section, field, range and option: what an agent reads before designing a sound. */
export function describeSynth() {
  const field = (key) => {
    const d = ggsParamDef(key);
    // the wavetable and filter menus have their own topics: their options are not spelled out here
    const range = d.type === 'number' ? `${d.min}..${d.max}${d.unit ? ` ${d.unit}` : ''}` : d.type === 'select' ? (d.options.length > 20 ? `one of ${d.options.length} ids` : d.options.join(' | ')) : 'true | false';
    return `${range} (default ${d.default}) — ${d.desc}`;
  };
  const section = (name, id) => Object.fromEntries(Object.keys(PATCH_FIELDS[name]).map((f) => [f, field(sectionKey(name, id, f))]));
  return {
    oscillator: section('oscillator', 'A'),
    sub: section('sub'),
    noise: section('noise'),
    filter: section('filter', 1),
    filterRouting: field('filterRoute'),
    envelope: section('envelope', 2),
    lfo: { ...section('lfo', 1), steps: `a list of 2..${LFO_STEPS} values, each -1..1 — the drawn shape, used by shape "steps" (its length is the number of steps per cycle)` },
    chaos: section('chaos', 1),
    voice: section('voice'),
    effects: { drive: section('drive'), chorus: section('chorus'), delay: section('delay'), reverb: section('reverb') },
    counts: { oscillators: OSC_IDS, filters: 2, envelopes: ENV_COUNT, lfos: LFO_COUNT, chaos: CHAOS_COUNT, macros: MACRO_COUNT, modulationSlots: MOD_SLOTS, params: GGS_PARAMS.length }
  };
}

const r2 = (x) => Math.round(x * 100) / 100;

/** A patch in a few lines of text: what is on, how it is shaped, what moves it. For summaries and tool replies. */
export function summarizePatch(params) {
  const p = { ...ggsDefaults(), ...params };
  const lines = [];
  for (const id of OSC_IDS) {
    if (!p[`osc${id}On`]) continue;
    const o = paramsToSection(p, 'oscillator', id);
    const tune = [o.octave && `${o.octave > 0 ? '+' : ''}${o.octave} oct`, o.semi && `${o.semi > 0 ? '+' : ''}${o.semi} st`, o.fine && `${o.fine > 0 ? '+' : ''}${r2(o.fine)} ct`].filter(Boolean).join(' ');
    lines.push(`Osc ${id}: ${o.table} @ ${r2(o.position)}, level ${r2(o.level)}${tune ? `, ${tune}` : ''}${o.unison > 1 ? `, ${o.unison}× unison (${r2(o.detune)} ct)` : ''}${o.warp !== 'off' ? `, warp ${o.warp} ${r2(o.warpAmount)}` : ''}${o.fmFrom !== 'off' ? `, FM from ${o.fmFrom} ${r2(o.fm)}` : ''} → ${o.to}`);
  }
  if (p.subLevel > 0) lines.push(`Sub: ${p.subWave} ${p.subOct} oct, level ${r2(p.subLevel)} → ${p.subDest}`);
  if (p.noiseLevel > 0) lines.push(`Noise: ${p.noiseType}, level ${r2(p.noiseLevel)} → ${p.noiseDest}`);
  const filters = [1, 2].filter((i) => p[`f${i}On`]).map((i) => `F${i} ${p[`f${i}Type`]} ${Math.round(p[`f${i}Cutoff`])} Hz res ${r2(p[`f${i}Res`])}${p[`f${i}Drive`] ? ` drive ${r2(p[`f${i}Drive`])}` : ''}${p[`f${i}Key`] ? ` key ${r2(p[`f${i}Key`])}` : ''}${FILTER_INFO[p[`f${i}Type`]]?.morph ? ` ${FILTER_INFO[p[`f${i}Type`]].morph.toLowerCase()} ${r2(p[`f${i}Morph`])}` : ''}`);
  if (filters.length) lines.push(`Filters: ${filters.join(' · ')}${filters.length > 1 ? ` (${p.filterRoute})` : ''}`);
  lines.push(`Amp envelope: ${p.env1Delay ? `delay ${r2(p.env1Delay)} ` : ''}A ${r2(p.env1A)} ${p.env1Hold ? `H ${r2(p.env1Hold)} ` : ''}D ${r2(p.env1D)} S ${r2(p.env1S)} R ${r2(p.env1R)} s${p.mono ? `; mono${p.legato ? ' legato' : ''}${p.glide ? `, glide ${r2(p.glide)} s` : ''}` : `; ${p.polyphony} voices`}`);
  const routes = modulationRoutes(p);
  for (let i = 1; i <= CHAOS_COUNT; i++) {
    if (!routes.some((r) => r.source === `chaos${i}` || r.via === `chaos${i}`)) continue;
    const sync = p[`chaos${i}Sync`];
    lines.push(`Chaos ${i}: ${p[`chaos${i}Type`]}, ${sync === 'off' ? `${r2(p[`chaos${i}Rate`])} Hz` : sync}, character ${r2(p[`chaos${i}Char`])}${p[`chaos${i}Type`] === 'turing' ? `, ${p[`chaos${i}Steps`]} steps` : ''}, ${p[`chaos${i}Path`] === 'same' ? 'the same path for every note' : 'its own path per note'}`);
  }
  if (routes.length) {
    lines.push(`Modulation: ${routes.map((r) => `${r.source}${r.via ? `×${r.via}` : ''}→${r.target} ${r.amount > 0 ? '+' : ''}${r2(r.amount)}`).join(', ')}`);
    for (const r of routes) lines.push(`  · ${describeRoute(p, r)}`);
  }
  const fx = [p.driveAmt > 0 && `drive ${p.driveType} ${r2(p.driveAmt)}`, p.chorusMix > 0 && `chorus ${r2(p.chorusMix)}`, p.delayMix > 0 && `delay ${r2(p.delayMix)} (${p.delaySync === 'free' ? `${Math.round(p.delayTime)} ms` : p.delaySync})`, p.reverbMix > 0 && `reverb ${r2(p.reverbMix)} size ${r2(p.reverbSize)}`].filter(Boolean);
  lines.push(`Effects: ${fx.join(', ') || 'none'}; gain ${r2(p.gain)}`);
  return lines.join('\n');
}
