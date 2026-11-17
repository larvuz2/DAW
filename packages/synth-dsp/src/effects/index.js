// The studio's own DSP effects: every class here can be a mixer insert (it runs in the audio worklet) and can be
// run in Node. STUDIO_FX is the registry: type → class. The class carries its label, description and parameter
// definitions, which the effect catalog (core/effects.js) and the worklet both read.
import { Maximizer } from './maximizer.js';
import { AlgoVerb } from './algoverb.js';
import { Shimmer } from './shimmer.js';
import { Ott } from './ott.js';
import { TransientShaper } from './transient.js';
import { TranceGate } from './trancegate.js';
import { Disperser } from './disperser.js';
import { FreqShifter } from './freqshift.js';
import { Resonator } from './resonator.js';
import { Lofi } from './lofi.js';
import { Tremolo } from './tremolo.js';
import { RingMod } from './ringmod.js';
import { Flanger } from './flanger.js';
import { Utility } from './utility.js';

export * from './base.js';
export { Maximizer, AlgoVerb, Shimmer, Ott, TransientShaper, TranceGate, Disperser, FreqShifter, Resonator, Lofi, Tremolo, RingMod, Flanger, Utility };

/** In the order the mixer's effect menu shows them: dynamics, space, modulation, colour, tools. */
const ALL = [Maximizer, Ott, TransientShaper, TranceGate, AlgoVerb, Shimmer, Resonator, Flanger, Tremolo, RingMod, FreqShifter, Disperser, Lofi, Utility];
export const STUDIO_FX = Object.fromEntries(ALL.map((fx) => [fx.type, fx]));

/** Run an effect over stereo audio in Node: { channels: [L, R], latency } (blocks of 128, as a worklet would). */
export function renderEffect(type, params, [L, R], sampleRate, { bpm = 120, beat = 0, playing = true, tail = 0 } = {}) {
  const Fx = STUDIO_FX[type];
  if (!Fx) throw new Error(`Unknown studio effect "${type}"`);
  const fx = new Fx(sampleRate);
  fx.set(params || {});
  const extra = Math.round(tail * sampleRate);
  const outL = new Float32Array(L.length + extra);
  const outR = new Float32Array(L.length + extra);
  outL.set(L);
  outR.set(R || L);
  for (let at = 0; at < outL.length; at += 128) {
    const n = Math.min(128, outL.length - at);
    fx.clock(beat + (at / sampleRate) * (bpm / 60), bpm, playing);
    fx.process(outL.subarray(at, at + n), outR.subarray(at, at + n), n);
  }
  return { channels: [outL, outR], latency: fx.latency, meter: fx.meter };
}
