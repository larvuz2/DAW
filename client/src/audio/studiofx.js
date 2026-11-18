// The studio's DSP effects as mixer inserts: an AudioWorklet node per effect (the classes live in
// packages/synth-dsp/src/effects and are bundled with the GGS worklet). Until the worklet is loaded in a context the
// effect passes its input through; offline renders wait for the load before they build their graph.
import { PPQ } from '@ggs/core';
import { STUDIO_FX } from '@ggs/synth-dsp';
import { setParam } from './dsp.js';
import { loadGgsModule, ggsReady } from './ggs-synth/index.js';

/** Where an offline render puts beat 0 on its clock (Transport.startOffline): known before the render starts. */
export const OFFLINE_START = 0.02;

export const usesStudioFx = (project) => project.mixer.some((m) => m.effects.some((e) => STUDIO_FX[e.type]));

/** { input, output, update(params), sync(point), reset(), automation, dispose() } — like every mixer effect. */
export function studioFxNode(ctx, engine, type, effect = null) {
  const Fx = STUDIO_FX[type];
  const defs = Fx.defs;
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);
  let node = null;
  let disposed = false;
  let current = { ...Object.fromEntries(defs.map((d) => [d.key, d.default])), ...(effect?.params || {}) };
  // the song position the processor starts from: a render's is known; a live context learns it when the transport runs
  let point = engine?.realtime === false
    ? { time: OFFLINE_START, beat: 0, bpm: engine.bpm || 120, playing: true }
    : engine?.transport?.playing ? pointOf(engine.transport.syncPoint()) : { time: 0, beat: 0, bpm: engine?.bpm || 120, playing: false };
  const automation = {};
  const self = {
    input, output, automation,
    update(params) {
      current = { ...current, ...params };
      if (!node) return;
      const rest = {};
      for (const d of defs) {
        if (d.type === 'number' && d.automatable) setParam(node.parameters.get(d.key), current[d.key], ctx);
        else rest[d.key] = current[d.key];
      }
      node.port.postMessage({ type: 'params', values: rest });
    },
    /** The transport (re)started, looped or changed tempo: `tick` is at context time `time`. */
    sync(sp) {
      point = pointOf(sp);
      node?.port.postMessage({ type: 'sync', ...point });
    },
    /** The song stopped, or its tempo changed while it stood still: the effect runs on from where it is, at that tempo. */
    halt(bpm) {
      point = { ...point, time: ctx.currentTime, bpm, playing: false };
      node?.port.postMessage({ type: 'sync', ...point });
    },
    /** Switched off: what it still holds (a tail, a delay, a string that rings) is let go of. */
    reset() {
      node?.port.postMessage({ type: 'reset' });
    },
    dispose() {
      disposed = true;
      node?.port.postMessage({ type: 'close' });
      try { node?.disconnect(); } catch { /* ignore */ }
    }
  };
  const attach = () => {
    if (node || disposed) return;
    try {
      node = new AudioWorkletNode(ctx, `gtd-fx-${type}`, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { params: current, ...point },
        // (automated settings start at their value, not at the default on its way there)
        parameterData: Object.fromEntries(defs.filter((d) => d.type === 'number' && d.automatable).map((d) => [d.key, current[d.key]]))
      });
    } catch (err) {
      console.warn(`GGS: the ${type} effect could not be started`, err);
      return;
    }
    for (const d of defs) if (d.type === 'number' && d.automatable) automation[d.key] = node.parameters.get(d.key);
    input.disconnect();
    input.connect(node).connect(output);
  };
  if (ggsReady(ctx)) attach();
  else loadGgsModule(ctx).then((ok) => { if (ok) attach(); });
  return self;
}

const pointOf = ({ time, tick, bpm, playing = true }) => ({ time, beat: tick / PPQ, bpm, playing });
