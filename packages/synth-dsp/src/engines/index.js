// The studio's synth engines beside the GGS Synth: each class is the sound of one note (see base.js), hosted per note
// in the audio worklet and usable in Node. SYNTH_ENGINES is the registry: instrument kind → class.
import { Additive } from './additive.js';

export { SynthEngine, Adsr, velocityGain, velocityTimbre, keyHz } from './base.js';
export { Additive };

export const SYNTH_ENGINES = Object.fromEntries([Additive].map((e) => [e.type, e]));

/**
 * Render notes of an engine in Node: { channels: [L, R] }.
 * notes: [{ key, velocity, start, duration (seconds), bend?, tune? }] — blocks of 128, as the worklet does.
 */
export function renderEngine(type, params, notes, { sampleRate = 48000, seconds = null } = {}) {
  const Engine = SYNTH_ENGINES[type];
  if (!Engine) throw new Error(`Unknown synth engine "${type}"`);
  const tail = Engine.tail(params || {});
  const end = seconds ?? notes.reduce((m, n) => Math.max(m, (n.start || 0) + (n.duration ?? 0.5)), 0) + tail + 0.1;
  const total = Math.ceil(end * sampleRate);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  notes.forEach((note, index) => {
    const voice = new Engine(sampleRate, (index + 1) * 2654435761);
    voice.set(params || {});
    const from = Math.round((note.start || 0) * sampleRate);
    const off = from + Math.round((note.duration ?? 0.5) * sampleRate);
    voice.noteOn(note.key ?? 60, note.velocity ?? 0.8, note.tune || 0);
    let released = false;
    for (let at = from; at < total && !voice.finished; at += 128) {
      const n = Math.min(128, total - at);
      if (!released && at >= off) { voice.noteOff(0.5); released = true; }
      voice.render(bl, br, n, note.bend || 0);
      for (let i = 0; i < n; i++) { L[at + i] += bl[i]; R[at + i] += br[i]; }
    }
  });
  return { channels: [L, R], sampleRate };
}
