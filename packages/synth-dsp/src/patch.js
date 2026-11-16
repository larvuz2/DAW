// The structured view of a GGS Synth patch. Inside a project a patch is a flat params object (like every other
// instrument); for people, files and agents the same patch reads better as a document with oscillators, filters,
// envelopes, LFOs and a list of modulation routes. These two functions convert between the forms, and
// PATCH_FIELDS — readable field name → param key suffix — is the one mapping both they and the MCP tools use.
import { GGS_PARAMS, OSC_IDS, ENV_COUNT, LFO_COUNT, MACRO_COUNT, MOD_SLOTS, MOD_SOURCES, MOD_TARGETS, ggsDefaults, ggsParamDef, migrateParams } from './params.js';
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
  lfo: { shape: 'Shape', rate: 'Rate', sync: 'Sync', trigger: 'Trig', fade: 'Fade', phase: 'Phase' },
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
  return suffix;
}

/** { field: value } of one section → { paramKey: value }. Unknown fields throw (with the valid ones). */
export function sectionToParams(section, id, fields) {
  const out = {};
  for (const [field, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    out[sectionKey(section, id, field)] = value;
  }
  return out;
}

/** One section of a flat params object as { field: value }. */
export function paramsToSection(params, section, id) {
  const out = {};
  for (const field of Object.keys(PATCH_FIELDS[section])) out[field] = params[sectionKey(section, id, field)];
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
  releaseVel: 'release velocity', macro1: 'Macro 1', macro2: 'Macro 2', macro3: 'Macro 3', macro4: 'Macro 4'
};
/** Sources that swing both ways (-1..1); the others run 0..1. */
export const BIPOLAR_SOURCES = new Set(['lfo1', 'lfo2', 'lfo3', 'lfo4', 'bend', 'key', 'random']);
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
    return { label: `LFO ${lfo[1]} rate`, kind: 'oct', scale: 4, base: synced ? 1 : p[`lfo${lfo[1]}Rate`], min: 0, max: Infinity, unit: synced ? '×' : 'Hz' };
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
    for (const item of listOf(list, `${section}s`)) {
      const id = Number(item?.id);
      if (!(Number.isInteger(id) && id >= 1 && id <= count)) throw new Error(`Unknown ${section} "${item?.id}": use 1..${count}`);
      const { id: _id, ...fields } = item;
      const implied = section === 'filter' && Object.keys(fields).length && !('on' in fields) ? { on: true } : {};
      if (section === 'envelope' && 'curve' in fields) {
        // a patch file saved before the envelopes had a curve per stage
        Object.assign(out, migrateParams({ [`env${id}Curve`]: fields.curve }));
        delete fields.curve;
      }
      Object.assign(out, sectionToParams(section, id, { ...implied, ...fields }));
    }
  };
  numbered(patch.filters, 'filter', 2);
  numbered(patch.envelopes, 'envelope', ENV_COUNT);
  numbered(patch.lfos, 'lfo', LFO_COUNT);
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
    if (d.type === 'number') return `${d.min}..${d.max}${d.unit ? ` ${d.unit}` : ''} (default ${d.default})`;
    if (d.type === 'select') return `${d.options.join(' | ')} (default ${d.default})`;
    return `true | false (default ${d.default})`;
  };
  const section = (name, id) => Object.fromEntries(Object.keys(PATCH_FIELDS[name]).map((f) => [f, field(sectionKey(name, id, f))]));
  return {
    oscillator: section('oscillator', 'A'),
    sub: section('sub'),
    noise: section('noise'),
    filter: section('filter', 1),
    filterRouting: field('filterRoute'),
    envelope: section('envelope', 2),
    lfo: section('lfo', 1),
    voice: section('voice'),
    effects: { drive: section('drive'), chorus: section('chorus'), delay: section('delay'), reverb: section('reverb') },
    counts: { oscillators: OSC_IDS, filters: 2, envelopes: ENV_COUNT, lfos: LFO_COUNT, macros: MACRO_COUNT, modulationSlots: MOD_SLOTS, params: GGS_PARAMS.length }
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
  if (routes.length) {
    lines.push(`Modulation: ${routes.map((r) => `${r.source}${r.via ? `×${r.via}` : ''}→${r.target} ${r.amount > 0 ? '+' : ''}${r2(r.amount)}`).join(', ')}`);
    for (const r of routes) lines.push(`  · ${describeRoute(p, r)}`);
  }
  const fx = [p.driveAmt > 0 && `drive ${p.driveType} ${r2(p.driveAmt)}`, p.chorusMix > 0 && `chorus ${r2(p.chorusMix)}`, p.delayMix > 0 && `delay ${r2(p.delayMix)} (${p.delaySync === 'free' ? `${Math.round(p.delayTime)} ms` : p.delaySync})`, p.reverbMix > 0 && `reverb ${r2(p.reverbMix)} size ${r2(p.reverbSize)}`].filter(Boolean);
  lines.push(`Effects: ${fx.join(', ') || 'none'}; gain ${r2(p.gain)}`);
  return lines.join('\n');
}
