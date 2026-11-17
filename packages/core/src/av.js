// The audio → visual bridge, the parts shared by the browser (which measures), the server (which sends OSC) and the
// tests: channel slugs, the map of the project for visual scenes, automation and visual-lane values at a tick,
// spectrum features (levels, six bands, 32 log bands, centroid), a small onset detector, and the frame → OSC mapping
// with its encoder. The addresses are the contract with the visual side (docs/av-bible.pdf, chapter 7): add, never
// rename.
import { PPQ, AV_USER_LANES, ticksPerBar } from './constants.js';
import { songAutomationInRange, automationValueAt } from './timeline.js';

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

/** What a visual scene needs to set itself up: channels (slug, id, colour, instrument, mixer insert), buses, markers. */
export function avMap(project) {
  if (!project) return null;
  const slugs = channelSlugs(project);
  return {
    project: project.name, id: project.id, bpm: project.bpm, timeSig: project.timeSig, ppq: PPQ, ticksPerBar: ticksPerBar(project),
    channels: project.channels.map((c) => ({ slug: slugs.get(c.id), id: c.id, name: c.name, color: c.color, kind: c.instrument.kind, insert: c.mixerTrack })),
    buses: usedInserts(project).map((index) => ({ index, name: project.mixer[index].name })),
    markers: [...(project.markers || [])].sort((a, b) => a.tick - b.tick).map((m) => ({ name: m.name, tick: m.tick })),
    automations: (project.automations || []).map((a) => ({ id: a.id, name: a.name, target: a.target }))
  };
}

/**
 * Every automation's value (0 … 1) at a song tick, the way the engine plays it: inside a clip, the curve at
 * tick − clip.start + clip.offset (looping over the automation's length); after a clip, its last value is held.
 * A visual lane follows the engine's rule for a target several clips move: the clip playing (the one that started
 * last, if two overlap), else the one that ended last.
 * Returns { auto: { [automationId]: v }, user: [8 values, 0 where no lane has played yet] }.
 */
export function automationValuesAt(project, tick) {
  const auto = {};
  const ended = new Map(); // automation id → the clip that ended last before `tick`
  const lanes = new Map(); // lane → { playing, start, end, v } of the clip that decides it
  for (const { clip, automation } of songAutomationInRange(project, 0, Number.MAX_SAFE_INTEGER)) {
    const end = clip.start + clip.length;
    let v = null;
    if (tick >= clip.start && tick < end) {
      v = automationValueAt(automation, tick - clip.start + clip.offset);
      auto[automation.id] = v;
    } else if (end <= tick) {
      const last = ended.get(automation.id);
      if (!last || end > last.end) ended.set(automation.id, { end, v: automationValueAt(automation, clip.length - 1 + clip.offset) });
      v = automationValueAt(automation, clip.length - 1 + clip.offset);
    }
    const t = automation.target;
    if (v === null || t?.type !== 'user') continue;
    const playing = end > tick;
    const was = lanes.get(t.index);
    const wins = !was || (playing && (!was.playing || clip.start > was.start)) || (!playing && !was.playing && end > was.end);
    if (wins) lanes.set(t.index, { playing, start: clip.start, end, v });
  }
  for (const [id, { v }] of ended) if (!(id in auto)) auto[id] = v;
  const user = new Array(AV_USER_LANES).fill(0);
  for (const [lane, { v }] of lanes) if (lane >= 1 && lane <= AV_USER_LANES) user[lane - 1] = v;
  for (const k of Object.keys(auto)) auto[k] = r4(auto[k]);
  return { auto, user: user.map(r4) };
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

const SLUG = /^[a-z0-9_]{1,48}$/;
const ID = /^[\w-]{1,64}$/;
const slugOk = (v) => typeof v === 'string' && SLUG.test(v);
/** OSC strings end at a zero byte: one inside would cut the message. */
const text = (v, max) => String(v ?? '').replace(/\0/g, '').slice(0, max);
/**
 * The largest /gtd/map JSON sent as one OSC message: macOS refuses UDP datagrams over 9216 bytes by default. A bigger
 * map leaves out the automations, then the markers; one still too big goes only as /gtd/map/ch/… messages (the
 * WebSocket frame always carries the whole map).
 */
export const AV_MAP_MAX_BYTES = 8000;
function mapJson(map) {
  const enc = new TextEncoder();
  for (const m of [map, { ...map, automations: [] }, { ...map, automations: [], markers: [] }]) {
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
export function encodeOsc(address, args = []) {
  const enc = new TextEncoder();
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
    const s = new TextDecoder().decode(b.subarray(at, end));
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
