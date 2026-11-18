// The studio's synth engines (additive, modal…) on the main thread: one AudioWorklet node per note, like a GGS voice
// but simpler — the engine's classes live in packages/synth-dsp/src/engines and are bundled with the GGS worklet.
import { SYNTH_ENGINES, hash32 } from '@ggs/synth-dsp';
import { scheduleCurve } from './dsp.js';
import { loadGgsModule, ggsReady } from './ggs-synth/index.js';

export const isEngine = (kind) => Object.hasOwn(SYNTH_ENGINES, kind);

/**
 * One note of an engine instrument (called from playNote). Returns null (the voice ends through its release), or t
 * when the worklet isn't loaded in this context yet (the note is skipped; the load is under way).
 * The voice gets `v.expr.pitch` — its bend, in semitones — for per-note pitch curves and live MPE input.
 * `tune`: cents from the equal-tempered key (the project's tuning).
 */
export function engineVoice(v, ctx, instrument, { t, velRaw, key, expr, tune, seed }) {
  if (!ggsReady(ctx)) { loadGgsModule(ctx); return t; }
  const Engine = SYNTH_ENGINES[instrument.kind];
  let node;
  try {
    node = new AudioWorkletNode(ctx, `gtd-voice-${instrument.kind}`, {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: {
        params: instrument.params, key, velocity: velRaw, start: t, tune: tune || 0,
        // the same note at the same time always gets the same "random" parts: renders repeat exactly
        seed: seed ?? hash32(Math.round(t * ctx.sampleRate) ^ Math.imul(key + 1, 0x85ebca6b))
      }
    });
  } catch (err) {
    console.warn(`GGS: a ${instrument.kind} voice failed`, err);
    return t;
  }
  const P = node.parameters;
  const gate = P.get('gate');
  const kill = P.get('kill');
  const release = P.get('release');
  v.freq = 440 * Math.pow(2, (key - 69) / 12);
  release.setValueAtTime(expr?.releaseVelocity ?? 0.5, Math.max(t, ctx.currentTime));
  v.expr = {
    pitch: P.get('pitch'),
    setReleaseVelocity(velocity) { release.setValueAtTime(velocity, ctx.currentTime); }
  };
  if (expr?.expression?.pitch) scheduleCurve(v.expr.pitch, expr.expression.pitch, t, Math.max(0.001, expr.seconds));
  // a source-like handle for Voice: stop() = hard stop, onended when the processor says the note is over
  const src = {
    onended: null,
    stop(time) { try { kill.setValueAtTime(1, Math.max(time, ctx.currentTime)); } catch { /* ignore */ } }
  };
  let over = false;
  node.port.onmessage = (ev) => {
    if (ev.data?.type !== 'ended' || over) return;
    over = true;
    node.port.onmessage = null;
    try { node.disconnect(); } catch { /* ignore */ }
    src.onended?.();
  };
  v.add(src);
  node.connect(v.out);
  v.releaseFn = (time) => {
    const off = Math.max(time, t);
    gate.setValueAtTime(0, off);
    return off + Engine.tail(instrument.params) + 0.03;
  };
  return null;
}
