// GGS Synth on the main thread: loading the worklet, the per-channel rig (effects + macro sources) and the voices.
import { ggsDefaults, releaseTail, FX_KEYS, hash32 } from '@greanteadawy/synth-dsp';
import { scheduleCurve } from '../dsp.js';
import { workletUrl } from './module.js';

const modules = new WeakMap(); // AudioContext → Promise<boolean>
const ready = new WeakSet();
let warned = false;

/** Load the worklet into a context (once). Resolves true when GGS voices can be created there. */
export function loadGgsModule(ctx) {
  if (!ctx.audioWorklet) return Promise.resolve(false);
  let p = modules.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(workletUrl).then(() => { ready.add(ctx); return true; }).catch((err) => {
      modules.delete(ctx); // a later attempt may succeed
      if (!warned) { warned = true; console.warn('GGS Synth: the audio worklet could not be loaded', err); }
      return false;
    });
    modules.set(ctx, p);
  }
  return p;
}

export const ggsReady = (ctx) => ready.has(ctx);
export const usesGgs = (project) => project.channels.some((c) => c.instrument.kind === 'ggs');

/** Offline renders wait for this before they start: every GGS channel then has its worklet. */
export function prepareGgs(ctx, project) {
  return usesGgs(project) ? loadGgsModule(ctx) : Promise.resolve(true);
}

const DEFAULTS = ggsDefaults();
const TABLE_KEYS = ['oscATable', 'oscBTable', 'oscCTable'];
const compactCache = new WeakMap();
/**
 * Only what differs from the init patch: a note carries its patch to the audio thread, and ~20 values copy faster
 * than 200. Cached per params object (project state is immutable, so an edit makes a new object).
 */
function compact(params) {
  let c = compactCache.get(params);
  if (!c) {
    c = {};
    for (const key in params) if (params[key] !== DEFAULTS[key] && key in DEFAULTS) c[key] = params[key];
    compactCache.set(params, c);
  }
  return c;
}

/** What changed between two params objects (values only). */
function delta(prev, next) {
  const out = {};
  let any = false;
  for (const key in DEFAULTS) if (prev[key] !== next[key]) { out[key] = next[key] ?? DEFAULTS[key]; any = true; }
  return any ? out : null;
}

/**
 * The part of a GGS channel that outlives its notes: an input the voices play into, the effects processor after
 * it, and four constant sources — the macros — that feed every voice's macro AudioParams (so automation of a macro
 * is sample-accurate and reaches notes that are already sounding).
 */
export class GgsChannel {
  constructor(ctx, dest, params, bpm) {
    this.ctx = ctx;
    this.dest = dest;
    this.params = params;
    this.bpm = bpm;
    this.input = ctx.createGain();
    this.input.connect(dest); // until the effects are in: straight through
    this.fx = null;
    this.voices = new Set();
    this.macros = [1, 2, 3, 4].map((i) => {
      const src = ctx.createConstantSource();
      src.offset.value = params[`macro${i}`] ?? 0;
      src.start();
      return src;
    });
    this.disposed = false;
    if (ggsReady(ctx)) this.attach();
    else loadGgsModule(ctx).then((ok) => { if (ok) this.attach(); });
  }

  attach() {
    if (this.fx || this.disposed) return;
    try {
      this.fx = new AudioWorkletNode(this.ctx, 'ggs-fx', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { params: compact(this.params), bpm: this.bpm }
      });
    } catch (err) {
      console.warn('GGS Synth: effects unavailable', err);
      return;
    }
    this.input.disconnect();
    this.input.connect(this.fx).connect(this.dest);
  }

  /** The channel's patch changed: tell the effects and every sounding note what is different. */
  update(params, automated) {
    const d = delta(this.params, params);
    this.params = params;
    if (!d) return;
    this.macros.forEach((src, i) => {
      const key = `macro${i + 1}`;
      if (key in d && !automated?.(key)) src.offset.setTargetAtTime(d[key], this.ctx.currentTime, 0.01);
    });
    // the effects processor also builds a newly chosen wavetable before any voice needs it
    if (this.fx && (FX_KEYS.some((k) => k in d) || TABLE_KEYS.some((k) => k in d))) this.fx.port.postMessage({ type: 'params', values: d });
    for (const node of this.voices) node.port.postMessage({ type: 'params', values: d });
  }

  /** Automation ended: the macros go back to the patch's own values. */
  resetMacros() {
    this.macros.forEach((src, i) => {
      src.offset.cancelScheduledValues(0);
      src.offset.setValueAtTime(this.params[`macro${i + 1}`] ?? 0, this.ctx.currentTime);
    });
  }

  setTempo(bpm) {
    this.bpm = bpm;
    this.fx?.port.postMessage({ type: 'tempo', bpm });
    for (const node of this.voices) node.port.postMessage({ type: 'tempo', bpm });
  }

  dispose() {
    this.disposed = true;
    for (const src of this.macros) { try { src.stop(); src.disconnect(); } catch { /* ignore */ } }
    this.fx?.port.postMessage({ type: 'close' });
    for (const n of [this.input, this.fx]) { try { n?.disconnect(); } catch { /* ignore */ } }
  }
}

/**
 * One GGS note (called from playNote). `rig` is the channel's GgsChannel. Returns null (the voice ends through its
 * release), or t when the worklet isn't loaded in this context yet (the note is skipped; the load is under way).
 * The voice gets `v.expr` = its pitch / pressure / timbre AudioParams, for live MPE input.
 */
export function ggsVoice(v, ctx, instrument, { t, velRaw, key, glideFrom, expr, rig, seed }) {
  if (!ggsReady(ctx)) { loadGgsModule(ctx); return t; }
  const params = instrument.params;
  let releaseVelocity = expr?.releaseVelocity ?? 0.5;
  let node;
  try {
    node = new AudioWorkletNode(ctx, 'ggs-voice', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: {
        params: compact(params), key, velocity: velRaw, start: t, bpm: rig?.bpm || 120,
        // the same note at the same time always gets the same "random" parts: renders repeat exactly
        seed: seed ?? hash32(Math.round(t * ctx.sampleRate) ^ Math.imul(key + 1, 0x85ebca6b)),
        glideFrom: glideFrom || 0, legato: !!glideFrom
      }
    });
  } catch (err) {
    console.warn('GGS Synth: voice failed', err);
    return t;
  }
  const P = node.parameters;
  const gate = P.get('gate');
  const kill = P.get('kill');
  v.freq = 440 * Math.pow(2, (key - 69) / 12);
  const release = P.get('release');
  release.setValueAtTime(releaseVelocity, Math.max(t, ctx.currentTime));
  v.expr = {
    pitch: P.get('pitch'), pressure: P.get('pressure'), timbre: P.get('timbre'),
    // a live note learns its release velocity when the key is let go: it also decides how long the tail may ring
    setReleaseVelocity(velocity) {
      releaseVelocity = velocity;
      release.setValueAtTime(velocity, ctx.currentTime);
    }
  };
  const e = expr?.expression;
  if (e) {
    const seconds = Math.max(0.001, expr.seconds);
    if (e.pitch) scheduleCurve(v.expr.pitch, e.pitch, t, seconds);
    if (e.pressure) scheduleCurve(v.expr.pressure, e.pressure, t, seconds);
    if (e.timbre) scheduleCurve(v.expr.timbre, e.timbre, t, seconds);
  }
  if (rig) {
    rig.macros.forEach((src, i) => src.connect(P.get(`macro${i + 1}`)));
    rig.voices.add(node);
  }
  // a source-like handle for Voice: stop() = hard stop, onended when the processor says the note is over
  const src = {
    onended: null,
    stop(time) { try { kill.setValueAtTime(1, Math.max(time, ctx.currentTime)); } catch { /* ignore */ } }
  };
  node.port.onmessage = (ev) => {
    if (ev.data?.type !== 'ended') return;
    node.port.onmessage = null;
    rig?.voices.delete(node);
    rig?.macros.forEach((m, i) => { try { m.disconnect(P.get(`macro${i + 1}`)); } catch { /* ignore */ } });
    try { node.disconnect(); } catch { /* ignore */ }
    src.onended?.();
  };
  v.add(src);
  node.connect(v.out);
  v.releaseFn = (time) => {
    const off = Math.max(time, t);
    gate.setValueAtTime(0, off);
    return off + releaseTail(params, releaseVelocity) + 0.03;
  };
  return null;
}
