// The audio → visual bridge, the parts shared by the browser (which measures), the server (which sends OSC) and the
// tests: channel slugs, the map of the project for visual scenes, automation and visual-lane values at a tick, the
// effective values of channel, bus and effect controls (phase 2), the GGS Synth's live modulation in real units,
// the positions of 3D objects and the expression of a sounding note (phase 3),
// spectrum features (levels, six bands, 32 log bands, centroid), a small onset detector, and the frame → OSC mapping
// with its encoder. The addresses are the contract with the visual side (docs/av-bible.pdf, chapter 7): add, never
// rename.
import { PPQ, AV_USER_LANES, MAX_VOLUME, MAX_INSERTS, MAX_EFFECTS_PER_INSERT, ticksPerBar } from './constants.js';
import { songAutomationInRange, automationValueAt } from './timeline.js';
import { EFFECTS, normalizeParam } from './effects.js';
import { MACRO_PARAMS } from './model.js';
import { isSpatialObject, spatialToNorm, spatialFromNorm, normalizeInsertSpatial, SPATIAL_PARAMS } from './spatial.js';
import { EXPRESSION_DIMS, EXPRESSION_RANGE, curveValueAt } from './expression.js';
import { MOD_SOURCES, MOD_TARGETS, modTargetSpec, targetValue, ggsDefaults } from '@greanteadawy/synth-dsp';

export const AV_FPS = 60;
export const AV_BANDS = [['sub', 20, 60], ['low', 60, 250], ['lowMid', 250, 500], ['mid', 500, 2000], ['highMid', 2000, 6000], ['high', 6000, 20000]];
export const AV_SPECTRUM_BANDS = 32;
/** dB (of an analyser's spectrum) shown as 0 … 1: −90 dB and below is 0, −20 dB and above is 1. */
export const AV_DB_FLOOR = -90;
export const AV_DB_CEIL = -20;
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const r4 = (v) => Math.round(v * 10000) / 10000;

/** A channel's name as an address part: lower case, anything but a–z and 0–9 becomes "_" ("Lead Synth" → lead_synth). */
export function avSlug(name) {
  const s = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'channel';
}

/** id → slug for every channel; a name used twice gets _2, _3 … in channel order. */
export function channelSlugs(project) {
  const out = new Map();
  const taken = new Set();
  for (const c of project?.channels || []) {
    const base = avSlug(c.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
    taken.add(slug);
    out.set(c.id, slug);
  }
  return out;
}

/**
 * The mixer inserts worth a meter: the master, and every insert that a channel or another insert plays into, that has
 * effects, or that was given a name — not the empty "Insert 7"s of a new project.
 */
export function usedInserts(project) {
  const used = new Set([0]);
  for (const c of project?.channels || []) used.add(c.mixerTrack);
  (project?.mixer || []).forEach((m, i) => {
    if (i === 0) return;
    if (m.effects?.length || !/^Insert \d+$/.test(m.name)) used.add(i);
    if (m.output) used.add(m.output);
    for (const s of m.sends || []) used.add(s.to);
  });
  return [...used].filter((i) => Number.isInteger(i) && i >= 0 && i < (project?.mixer?.length || 1)).sort((a, b) => a - b);
}

/** The effects of one insert by address: their type in lower case, a second one of the same type _2 ("reverb_2"). */
export function effectSlugs(effects) {
  const out = new Map();
  const taken = new Set();
  for (const e of effects || []) {
    const base = avSlug(e.type);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
    taken.add(slug);
    out.set(e.id, slug);
  }
  return out;
}

/** What a visual scene needs to set itself up: channels (slug, id, colour, instrument, mixer insert), buses, markers. */
export function avMap(project) {
  if (!project) return null;
  const slugs = channelSlugs(project);
  return {
    project: project.name, id: project.id, bpm: project.bpm, timeSig: project.timeSig, ppq: PPQ, ticksPerBar: ticksPerBar(project),
    channels: project.channels.map((c) => ({ slug: slugs.get(c.id), id: c.id, name: c.name, color: c.color, kind: c.instrument.kind, insert: c.mixerTrack })),
    buses: usedInserts(project).map((index) => ({ index, name: project.mixer[index].name })),
    effects: usedInserts(project).flatMap((insert) => {
      const fx = project.mixer[insert].effects;
      const slugs = effectSlugs(fx);
      return fx.map((e) => ({ insert, slug: slugs.get(e.id), type: e.type, id: e.id }));
    }),
    // the inserts that are 3D objects (/gtd/spatial/{insert}): none while the project's spatial mix is off
    objects: project.mixer.map((m, insert) => (isSpatialObject(project, insert) ? { insert, name: m.name } : null)).filter(Boolean),
    markers: [...(project.markers || [])].sort((a, b) => a.tick - b.tick).map((m) => ({ name: m.name, tick: m.tick })),
    automations: (project.automations || []).map((a) => ({ id: a.id, name: a.name, target: a.target }))
  };
}

/** One string per automation target (what the engine keys its automated params by). */
export const targetKey = (t) => `${t?.type}|${t?.id ?? ''}|${t?.index ?? ''}|${t?.effectId ?? ''}|${t?.param ?? ''}`;

/**
 * The song's automation clips, once per project state (projects are immutable: an edit makes a new object): each with
 * its automation and target key, in order of start — so a frame looks only at the clips that have started, without
 * searching the automations for every clip.
 */
const clipIndex = new WeakMap();
function automationClips(project) {
  let list = clipIndex.get(project);
  if (!list) {
    const byId = new Map((project.automations || []).map((a) => [a.id, a]));
    list = songAutomationInRange(project, 0, Number.MAX_SAFE_INTEGER, byId)
      .map(({ clip, automation }) => ({ clip, automation, key: targetKey(automation.target), start: clip.start, end: clip.start + clip.length }))
      .sort((a, b) => a.start - b.start);
    clipIndex.set(project, list);
  }
  return list;
}

/** Which of two clips moving one target decides it: the one playing (the later start if both), else the one that ended last. */
const decides = (was, playing, start, end) => !was || (playing && (!was.playing || start > was.start)) || (!playing && !was.playing && end > was.end);

/**
 * What automation does to each target at a song tick, as Transport.chaseAutomation does it: the clip playing, else
 * the one that ended last — its last value is held. (Two clips playing at once on one target both write the param in
 * the engine; the bridge takes the one that started last.) Returns Map targetKey → { v (0 … 1), playing, start, end };
 * pitch is per note: only a clip playing moves it (see effectiveValuesAt). Compute it once per frame and hand it to
 * automationValuesAt and effectiveValuesAt.
 */
export function targetValuesAt(project, tick) {
  const out = new Map();
  for (const { clip, automation, key, start, end } of automationClips(project)) {
    if (start > tick) break;
    const playing = end > tick;
    if (!decides(out.get(key), playing, start, end)) continue;
    const v = automationValueAt(automation, playing ? tick - start + clip.offset : clip.length - 1 + clip.offset);
    out.set(key, { v, playing, start, end });
  }
  return out;
}

/**
 * Every automation's value (0 … 1) at a song tick, the way the engine plays it: inside a clip, the curve at
 * tick − clip.start + clip.offset (looping over the automation's length); after a clip, its last value is held.
 * A visual lane follows the engine's rule for a target several clips move (targetValuesAt).
 * Returns { auto: { [automationId]: v }, user: [8 values, 0 where no lane has played yet] }.
 */
export function automationValuesAt(project, tick, { targets = targetValuesAt(project, tick) } = {}) {
  const auto = {};
  const ended = new Map(); // automation id → the clip that ended last before `tick`
  for (const { clip, automation, start, end } of automationClips(project)) {
    if (start > tick) break;
    if (tick < end) auto[automation.id] = automationValueAt(automation, tick - start + clip.offset);
    else {
      const last = ended.get(automation.id);
      if (!last || end > last.end) ended.set(automation.id, { end, clip, automation });
    }
  }
  for (const [id, { clip, automation }] of ended) if (!(id in auto)) auto[id] = automationValueAt(automation, clip.length - 1 + clip.offset);
  const user = Array.from({ length: AV_USER_LANES }, (_, i) => r4(targets.get(targetKey({ type: 'user', index: i + 1 }))?.v ?? 0));
  for (const k of Object.keys(auto)) auto[k] = r4(auto[k]);
  return { auto, user };
}

const unit = (v) => r4(clamp01(Number.isFinite(v) ? v : 0));
const logUnit = (v, lo, hi) => Math.log(Math.max(lo, v) / lo) / Math.log(hi / lo);

/**
 * Phase 2: where every control stands at a song tick, 0 … 1 of its range — its own setting, or what automation makes
 * it while the song plays (`automated`: playing in song mode; stopped, the engine puts automated controls back to
 * their settings). { param: { [channelSlug]: { volume, pan, filterCutoff, filterRes, pitch, mute, macro1…8 (GGS) } },
 * bus: { [insert]: { volume, pan, mute } } (inserts in use), fx: { [insert]: { [effectSlug]: { enabled, …params } } } }.
 * The same 0 … 1 automation points use: volume 1 = 1.25 (+1.9 dB), filterCutoff log 20 Hz … 20 kHz, filterRes log
 * 0.1 … 20, pitch −24 … +24 semitones (with a playing pitch clip added), mute 1 = the channel is silent (muted, or
 * another one is soloed); effect params by their definitions (log ones log), switches 0 / 1.
 */
export function effectiveValuesAt(project, tick, { automated = true, targets = null } = {}) {
  const autos = automated ? targets || targetValuesAt(project, tick) : new Map();
  const val = (t, own) => unit(autos.get(targetKey(t))?.v ?? own);
  // the master's fader answers to { type: 'master' } and to { type: 'mixer', index: 0 } alike
  const masterVal = (param, own) => {
    const a = autos.get(targetKey({ type: 'master', param }));
    const b = autos.get(targetKey({ type: 'mixer', index: 0, param }));
    const win = a && b ? (decides(a, b.playing, b.start, b.end) ? b : a) : a || b;
    return unit(win?.v ?? own);
  };
  // an insert is silent when muted, or when another one is soloed and it doesn't play into it (engine.syncMixer)
  const mixer = project.mixer;
  const anySoloInsert = mixer.some((m, i) => i > 0 && m.solo);
  const feedsSolo = (i) => {
    const seen = new Set();
    for (let cur = i; cur > 0 && !seen.has(cur); cur = mixer[cur].output || 0) {
      seen.add(cur);
      if (mixer[cur].solo) return true;
    }
    return false;
  };
  const slugs = channelSlugs(project);
  const anySolo = project.channels.some((c) => c.solo);
  const param = {};
  for (const c of project.channels) {
    const t = (p) => ({ type: 'channel', id: c.id, param: p });
    const bend = autos.get(targetKey(t('pitch')));
    const p = {
      volume: val(t('volume'), c.volume / MAX_VOLUME),
      pan: val(t('pan'), (c.pan + 1) / 2),
      filterCutoff: val(t('filterCutoff'), logUnit(c.filterCutoff, 20, 20000)),
      filterRes: val(t('filterRes'), logUnit(c.filterRes, 0.1, 20)),
      pitch: unit((c.pitch + (bend?.playing ? Math.round(bend.v * 48 - 24) : 0) + 24) / 48),
      mute: c.mute || (anySolo && !c.solo) ? 1 : 0
    };
    if (c.instrument.kind === 'ggs') for (const k of MACRO_PARAMS) p[k] = val(t(k), c.instrument.params[k] ?? 0);
    param[slugs.get(c.id)] = p;
  }
  const bus = {};
  const fx = {};
  for (const i of usedInserts(project)) {
    const m = mixer[i];
    const t = (p) => ({ type: 'mixer', index: i, param: p });
    const audible = !m.mute && (i === 0 || !anySoloInsert || m.solo || feedsSolo(i));
    bus[i] = i === 0
      ? { volume: masterVal('volume', m.volume / MAX_VOLUME), pan: masterVal('pan', (m.pan + 1) / 2), mute: m.mute ? 1 : 0 }
      : {
        volume: val(t('volume'), m.volume / MAX_VOLUME),
        // a 3D object ignores its pan knob: in stereo it sits where its x puts it
        pan: isSpatialObject(project, i) ? val(t('spatialX'), spatialToNorm('spatialX', m.spatial?.x ?? 0)) : val(t('pan'), (m.pan + 1) / 2),
        mute: audible ? 0 : 1
      };
    const fxSlugs = effectSlugs(m.effects);
    for (const e of m.effects) {
      const v = { enabled: e.enabled === false ? 0 : 1 };
      // (a plugin's params are its own business: only whether it is on)
      if (e.type !== 'plugin') {
        for (const d of EFFECTS[e.type]?.params || []) {
          if (d.type === 'number') v[d.key] = val({ type: 'effect', index: i, effectId: e.id, param: d.key }, normalizeParam(e.params?.[d.key] ?? d.default, d));
          else if (d.type === 'bool') v[d.key] = (e.params?.[d.key] ?? d.default) ? 1 : 0;
        }
      }
      (fx[i] ||= {})[fxSlugs.get(e.id)] = v;
    }
  }
  return { param, bus, fx };
}

/**
 * Phase 3: where every 3D object stands at a song tick, in room units — x −1 (left) … 1 (right), y −1 (back) … 1
 * (front), z 0 (floor) … 1 (ceiling): its own place, or its spatialX/Y/Z automation while the song plays (the
 * engine's rule, as for every control). { [insert]: [x, y, z] }; empty while the project's spatial mix is off.
 */
export function objectPositionsAt(project, tick, { automated = true, targets = null } = {}) {
  const autos = automated ? targets || targetValuesAt(project, tick) : new Map();
  const out = {};
  project.mixer.forEach((m, i) => {
    if (!isSpatialObject(project, i)) return;
    const own = normalizeInsertSpatial(m.spatial, m.pan);
    out[i] = Object.keys(SPATIAL_PARAMS).map((param) => {
      const a = autos.get(targetKey({ type: 'mixer', index: i, param }));
      return r4(a ? spatialFromNorm(param, a.v) : own[SPATIAL_PARAMS[param].axis] ?? 0);
    });
  });
  return out;
}

/**
 * Phase 3: a note's expression where it stands `elapsed` seconds into it — its curves (pitch in semitones −48 … 48,
 * pressure and timbre 0 … 1) over `seconds`, the length they span (the note's full written length). { pitch?, … }:
 * only the dimensions the note has.
 */
export function expressionAt(curves, elapsed, seconds) {
  const out = {};
  if (!curves) return out;
  const t = seconds > 0 ? Math.min(1, Math.max(0, elapsed / seconds)) : 0;
  for (const dim of EXPRESSION_DIMS) if (curves[dim]?.length) out[dim] = r4(curveValueAt(curves[dim], t));
  return out;
}

/** The GGS Synth's modulation sources and targets as the bridge names them (without "none"). */
export const GGS_SOURCES = MOD_SOURCES.filter((s) => s !== 'none');
export const GGS_TARGETS = MOD_TARGETS.filter((t) => t !== 'none');
const specCache = new WeakMap();
function targetSpecs(params) {
  let specs = specCache.get(params);
  if (!specs) {
    const full = { ...ggsDefaults(), ...params };
    specs = MOD_TARGETS.map((t) => (t === 'none' ? null : modTargetSpec(t, full)));
    specCache.set(params, specs);
  }
  return specs;
}

/** A modulated target as 0 … 1: its place in its control's range, or for an offset with no range (pitch, LFO rate), 0.5 + d / 2. */
function targetUnit(spec, value, d) {
  if (Number.isFinite(spec.min) && Number.isFinite(spec.max) && spec.max > spec.min) {
    if (spec.kind === 'oct' && spec.min > 0) return clamp01(logUnit(value, spec.min, spec.max));
    return clamp01((value - spec.min) / (spec.max - spec.min));
  }
  return clamp01(0.5 + d / 2);
}

/**
 * Phase 2: a GGS channel's live modulation, from what its newest note reports (`live`: [sources…, targets…] as the
 * voices send it, or null when no note sounds). { src: { env1: 0 … 1, lfo1: −1 … 1, … }, dst: { f1Cutoff: [Hz, 0 … 1],
 * … } }: each target in the units of its knob (targetValue) and 0 … 1. Nothing sounding: sources 0 (the macros where
 * `macros` says they stand), targets at rest.
 */
export function ggsTelemetry(params, live, { macros = null } = {}) {
  const src = {};
  const dst = {};
  for (let i = 1; i < MOD_SOURCES.length; i++) src[MOD_SOURCES[i]] = r4(live ? live[i] || 0 : 0);
  // (the macros belong to the channel, not to a note: with nothing sounding they still stand where they are)
  if (!live && macros) MACRO_PARAMS.forEach((k, i) => { src[k] = r4(macros[i] ?? 0); });
  const specs = targetSpecs(params || {});
  for (let j = 1; j < MOD_TARGETS.length; j++) {
    const spec = specs[j];
    if (!spec) continue;
    const d = live ? live[MOD_SOURCES.length + j] || 0 : 0;
    // (a route to the rate of a free-running LFO does nothing: it stays at its knob, unmodulated)
    const value = spec.inert ? spec.base : targetValue(spec, d);
    dst[MOD_TARGETS[j]] = [r4(Number.isFinite(value) ? value : 0), r4(spec.inert ? targetUnit(spec, value, 0) : targetUnit(spec, value, d))];
  }
  return { src, dst };
}

/** The index of the marker whose section `tick` is in (the last one at or before it), or −1. */
export function markerIndexAt(markers, tick) {
  let at = -1;
  for (let i = 0; i < markers.length; i++) if (markers[i].tick <= tick) at = i;
  return at;
}

/** Peak and RMS (linear) of a block of samples. */
export function levelsOf(samples) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak: r4(Math.min(1, peak)), rms: r4(Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)))) };
}

const dbToUnit = (db) => clamp01((db - AV_DB_FLOOR) / (AV_DB_CEIL - AV_DB_FLOOR));
/** Bin ranges for the six bands and the 32 log bands of an analyser (computed once per size and rate). */
const layouts = new Map();
function layout(bins, sampleRate) {
  const key = `${bins}:${sampleRate}`;
  let l = layouts.get(key);
  if (!l) {
    const hzPerBin = sampleRate / 2 / bins;
    const range = (lo, hi) => [Math.max(1, Math.floor(lo / hzPerBin)), Math.max(Math.max(1, Math.floor(lo / hzPerBin)) + 1, Math.min(bins, Math.ceil(hi / hzPerBin)))];
    const edges = Array.from({ length: AV_SPECTRUM_BANDS + 1 }, (_, i) => 20 * Math.pow(1000, i / AV_SPECTRUM_BANDS));
    l = { hzPerBin, bands: AV_BANDS.map(([, lo, hi]) => range(lo, hi)), spectrum: edges.slice(0, -1).map((lo, i) => range(lo, edges[i + 1])) };
    layouts.set(key, l);
  }
  return l;
}

/**
 * From an analyser's spectrum (dB per bin, as getFloatFrequencyData gives it): six bands and 32 log bands from 20 Hz to
 * 20 kHz, each the power average of its bins shown 0 … 1 (AV_DB_FLOOR … AV_DB_CEIL), the spectral centroid in Hz
 * (0 in silence), and the 32 bands' linear magnitudes for onset detection.
 */
export function spectrumFeatures(db, sampleRate) {
  const bins = db.length;
  const l = layout(bins, sampleRate);
  const power = (lo, hi) => {
    let p = 0;
    for (let k = lo; k < hi; k++) p += Math.pow(10, (db[k] > -200 ? db[k] : -200) / 10);
    return p / Math.max(1, hi - lo);
  };
  const toUnit = (p) => (p > 0 ? dbToUnit(10 * Math.log10(p)) : 0);
  const bands = l.bands.map(([lo, hi]) => r4(toUnit(power(lo, hi))));
  const linear = l.spectrum.map(([lo, hi]) => Math.sqrt(power(lo, hi)));
  const spectrum = linear.map((m) => r4(m > 0 ? dbToUnit(20 * Math.log10(m)) : 0));
  let num = 0;
  let den = 0;
  for (let k = 1; k < bins; k++) {
    const m = db[k] > AV_DB_FLOOR ? Math.pow(10, db[k] / 20) : 0;
    num += k * l.hzPerBin * m;
    den += m;
  }
  return { bands, spectrum, centroid: den > 1e-9 ? Math.round(num / den) : 0, linear };
}

/**
 * Onsets by spectral flux: how much the 32 bands grew since the last frame, against its own recent average. Returns
 * a function (bands' linear magnitudes, time in s) → strength 0 … 1 at an onset, or 0. At most one onset per 80 ms.
 */
export function createOnsetDetector({ sensitivity = 1.6, minGap = 0.08 } = {}) {
  let prev = null;
  let mean = 0;
  let last = -Infinity;
  return (linear, time) => {
    let flux = 0;
    if (prev) for (let i = 0; i < linear.length; i++) { const d = linear[i] - prev[i]; if (d > 0) flux += d; }
    prev = Float32Array.from(linear);
    const hit = flux > mean * sensitivity + 0.002 && time - last >= minGap;
    mean = mean * 0.92 + flux * 0.08;
    if (!hit) return 0;
    last = time;
    return r4(clamp01((flux - mean) / (mean + 0.01) / 4));
  };
}

// ---- frames → OSC ----------------------------------------------------------------------------------------------

/** The most phase 2 and 3 messages one frame may become (a full frame of a big project is about 1500). */
export const AV_PHASE2_BUDGET = 4096;
const SLUG = /^[a-z0-9_]{1,48}$/;
const ID = /^[\w-]{1,64}$/;
const slugOk = (v) => typeof v === 'string' && SLUG.test(v);
const KEY = /^[A-Za-z0-9_]{1,48}$/;
const INDEX = /^\d{1,3}$/;
const entries = (o, max) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).slice(0, max) : []);
/** OSC strings end at a zero byte: one inside would cut the message. */
const text = (v, max) => String(v ?? '').replace(/\0/g, '').slice(0, max);
/**
 * The largest /gtd/map JSON sent as one OSC message: macOS refuses UDP datagrams over 9216 bytes by default. A bigger
 * map leaves out the automations, then the effects, then the markers; one still too big goes only as /gtd/map/ch/… messages (the
 * WebSocket frame always carries the whole map).
 */
export const AV_MAP_MAX_BYTES = 8000;
function mapJson(map) {
  const enc = utf8;
  const lean = { automations: [], effects: [] };
  for (const m of [map, { ...map, automations: [] }, { ...map, ...lean }, { ...map, ...lean, markers: [] }]) {
    let json = '';
    try { json = JSON.stringify(m).replace(/\0/g, ''); } catch { return ''; }
    if (enc.encode(json).length <= AV_MAP_MAX_BYTES) return json;
  }
  return '';
}
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/**
 * The OSC messages of one frame, in the order the visual side relies on: transport, then events (marker, note ends,
 * notes, onset), then continuous values (master, buses, channels, automation, visual lanes), then the latency and the
 * map. Each message is [address, ...args] with args as { i } (int32), { f } (float32) or { s } (string). Anything
 * out of shape in the frame is skipped (it comes from a browser tab).
 */
export function avFrameToOsc(frame) {
  const out = [];
  if (!frame || typeof frame !== 'object') return out;
  const f = (v) => ({ f: v });
  const i = (v) => ({ i: Math.round(v) });
  const ppq = num(frame.ppq, 1, 10000, PPQ);
  const tpb = num(frame.tpb, 1, 1e6, ppq * 4);
  const tick = num(frame.tick, 0, 2 ** 31 - 1);
  out.push(['/gtd/transport/playing', i(frame.playing ? 1 : 0)]);
  out.push(['/gtd/transport/bpm', f(num(frame.bpm, 1, 1000, 120))]);
  out.push(['/gtd/transport/tick', i(tick)]);
  out.push(['/gtd/transport/beat', f(tick / ppq)]);
  out.push(['/gtd/transport/bar', i(Math.floor(tick / tpb) + 1)]);
  out.push(['/gtd/transport/phase/beat', f((tick % ppq) / ppq)]);
  out.push(['/gtd/transport/phase/bar', f((tick % tpb) / tpb)]);
  if (typeof frame.time === 'number') out.push(['/gtd/transport/time', f(num(frame.time, 0, 1e9))]);
  if (frame.marker && typeof frame.marker.name === 'string') out.push(['/gtd/marker', { s: text(frame.marker.name, 64) }, i(num(frame.marker.tick, 0, 2 ** 31 - 1))]);
  // the notes that end before the ones that start: a key struck again in the same frame ends, then sounds again
  for (const n of Array.isArray(frame.offs) ? frame.offs.slice(0, 256) : []) {
    if (!slugOk(n?.ch)) continue;
    out.push([`/gtd/ch/${n.ch}/off`, i(num(n.key, 0, 127)), f(num(n.rel, 0, 1, 0.5))]);
  }
  for (const n of Array.isArray(frame.notes) ? frame.notes.slice(0, 256) : []) {
    if (!slugOk(n?.ch)) continue;
    out.push([`/gtd/ch/${n.ch}/note`, i(num(n.key, 0, 127)), f(num(n.vel, 0, 1)), f(num(n.dur, 0, 3600)), f(num(n.at, 0, 1e9))]);
  }
  const m = frame.master || {};
  if (typeof m.onset === 'number' && m.onset > 0) out.push(['/gtd/master/onset', f(num(m.onset, 0, 1))]);
  out.push(['/gtd/master/peak', f(num(m.peak, 0, 1))]);
  out.push(['/gtd/master/rms', f(num(m.rms, 0, 1))]);
  if (Array.isArray(m.bands) && m.bands.length === AV_BANDS.length) out.push(['/gtd/master/bands', ...m.bands.map((v) => f(num(v, 0, 1)))]);
  if (Array.isArray(m.spectrum) && m.spectrum.length === AV_SPECTRUM_BANDS) out.push(['/gtd/master/spectrum', ...m.spectrum.map((v) => f(num(v, 0, 1)))]);
  if (typeof m.centroid === 'number') out.push(['/gtd/master/centroid', f(num(m.centroid, 0, 30000))]);
  for (const [n, v] of Object.entries(frame.buses && typeof frame.buses === 'object' ? frame.buses : {}).slice(0, 128)) {
    if (/^\d{1,3}$/.test(n)) out.push([`/gtd/bus/${Number(n)}/peak`, f(num(v, 0, 1))]);
  }
  for (const [slug, v] of Object.entries(frame.ch && typeof frame.ch === 'object' ? frame.ch : {}).slice(0, 256)) {
    if (slugOk(slug)) out.push([`/gtd/ch/${slug}/level`, f(num(v, 0, 1))]);
  }
  for (const [id, v] of Object.entries(frame.auto && typeof frame.auto === 'object' ? frame.auto : {}).slice(0, 512)) {
    if (ID.test(id)) out.push([`/gtd/auto/${id}`, f(num(v, 0, 1))]);
  }
  (Array.isArray(frame.user) ? frame.user.slice(0, AV_USER_LANES) : []).forEach((v, n) => out.push([`/gtd/user/${n + 1}`, f(num(v, 0, 1))]));
  // phase 2: controls as they stand (only what changed, everything once a second), and the GGS Synth's modulation.
  // A frame comes from a browser: a budget keeps one from turning into tens of thousands of messages.
  const budget = out.length + AV_PHASE2_BUDGET;
  const add = (...msgs) => { if (out.length + msgs.length <= budget) out.push(...msgs); };
  for (const [slug, vals] of entries(frame.param, 256)) {
    if (!slugOk(slug)) continue;
    for (const [k, v] of entries(vals, 24)) if (KEY.test(k)) add([`/gtd/ch/${slug}/param/${k}`, f(num(v, 0, 1))]);
  }
  for (const [n, vals] of entries(frame.busParam, MAX_INSERTS + 1)) {
    if (!INDEX.test(n)) continue;
    for (const [k, v] of entries(vals, 8)) if (KEY.test(k)) add([`/gtd/bus/${Number(n)}/param/${k}`, f(num(v, 0, 1))]);
  }
  for (const [n, effects] of entries(frame.fx, MAX_INSERTS + 1)) {
    if (!INDEX.test(n)) continue;
    for (const [fx, vals] of entries(effects, MAX_EFFECTS_PER_INSERT)) {
      if (!slugOk(fx)) continue;
      for (const [k, v] of entries(vals, 32)) if (KEY.test(k)) add([`/gtd/fx/${Number(n)}/${fx}/${k}`, f(num(v, 0, 1))]);
    }
  }
  for (const [slug, g] of entries(frame.ggs, 64)) {
    if (!slugOk(slug) || !g || typeof g !== 'object') continue;
    if (g.voices !== undefined) add([`/gtd/ggs/${slug}/voices`, i(num(g.voices, 0, 1024))]);
    // (sources are 0 … 1 or −1 … 1, except bend: the note's pitch curve in octaves, up to ±4)
    for (const [k, v] of entries(g.src, 32)) if (KEY.test(k)) add([`/gtd/ggs/${slug}/src/${k}`, f(num(v, -4, 4))]);
    for (const [k, v] of entries(g.dst, 48)) {
      if (!KEY.test(k) || !Array.isArray(v)) continue;
      add([`/gtd/ggs/${slug}/dst/${k}`, f(num(v[0], -1e6, 1e6))], [`/gtd/ggs/${slug}/dst/${k}/n`, f(num(v[1], 0, 1))]);
    }
  }
  // phase 3: 3D objects in room units, and the expression of sounding notes (key, value)
  for (const [n, pos] of entries(frame.spatial, MAX_INSERTS + 1)) {
    if (!INDEX.test(n) || !Array.isArray(pos)) continue;
    add([`/gtd/spatial/${Number(n)}`, f(num(pos[0], -1, 1)), f(num(pos[1], -1, 1)), f(num(pos[2], 0, 1))]);
  }
  for (const e of Array.isArray(frame.expr) ? frame.expr.slice(0, 512) : []) {
    if (!slugOk(e?.ch) || !EXPRESSION_DIMS.includes(e.dim)) continue;
    const [lo, hi] = EXPRESSION_RANGE[e.dim];
    add([`/gtd/ch/${e.ch}/expr/${e.dim}`, i(num(e.key, 0, 127)), f(num(e.v, lo, hi))]);
  }
  if (typeof frame.latency === 'number') out.push(['/gtd/latency', f(num(frame.latency, 0, 10))]);
  if (frame.map && typeof frame.map === 'object' && !Array.isArray(frame.map)) {
    const json = mapJson(frame.map);
    if (json) out.push(['/gtd/map', { s: json }]);
    for (const c of Array.isArray(frame.map.channels) ? frame.map.channels.slice(0, 256) : []) {
      if (!slugOk(c?.slug)) continue;
      out.push([`/gtd/map/ch/${c.slug}`, { s: text(c.id, 64) }, { s: text(c.color, 16) }, { s: text(c.kind, 32) }, i(num(c.insert, 0, 999))]);
    }
    for (const b of Array.isArray(frame.map.buses) ? frame.map.buses.slice(0, 128) : []) out.push([`/gtd/map/bus/${Math.round(num(b?.index, 0, 999))}`, { s: text(b?.name, 64) }]);
  }
  return out;
}

/** One OSC 1.0 message as bytes (big-endian, every part padded to 4 bytes). */
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
export function encodeOsc(address, args = []) {
  const enc = utf8;
  const pad = (bytes) => {
    const out = new Uint8Array(Math.ceil((bytes.length + 1) / 4) * 4);
    out.set(bytes);
    return out;
  };
  const addr = pad(enc.encode(address));
  const tags = pad(enc.encode(`,${args.map((a) => ('i' in a ? 'i' : 'f' in a ? 'f' : 's')).join('')}`));
  const parts = args.map((a) => {
    if ('s' in a) return pad(enc.encode(String(a.s).replace(/\0/g, '')));
    const b = new Uint8Array(4);
    const view = new DataView(b.buffer);
    if ('i' in a) view.setInt32(0, a.i | 0);
    else view.setFloat32(0, a.f);
    return b;
  });
  const total = addr.length + tags.length + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of [addr, tags, ...parts]) { out.set(p, at); at += p.length; }
  return out;
}

/** Bytes back to [address, ...values] (for tests and for debugging a receiver). */
export function decodeOsc(bytes) {
  const { address, args } = decodeOscMessage(bytes);
  return [address, ...args.map((a) => a.i ?? a.f ?? a.s)];
}

/** Bytes back to { address, args: [{ i } | { f } | { s }] }: what encodeOsc takes (a capture can be sent again). */
export function decodeOscMessage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const str = () => {
    let end = at;
    while (end < b.length && b[end] !== 0) end++;
    const s = utf8Decoder.decode(b.subarray(at, end));
    at = Math.ceil((end + 1) / 4) * 4;
    return s;
  };
  const address = str();
  const tags = str().slice(1);
  const args = [];
  for (const t of tags) {
    if (t === 'i') { args.push({ i: view.getInt32(at) }); at += 4; } else if (t === 'f') { args.push({ f: view.getFloat32(at) }); at += 4; } else if (t === 's') args.push({ s: str() });
  }
  return { address, args };
}
