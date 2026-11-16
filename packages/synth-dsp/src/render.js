// Headless rendering of GGS Synth notes: the same voices and effects as the AudioWorklet, driven by a plain loop.
// Used by tests, benchmarks and the server (analysing a patch without a browser).
import { GgsVoice } from './voice.js';
import { GgsFx } from './fx.js';
import { completeParams, releaseTail } from './params.js';
import { hash32 } from './util.js';

const BLOCK = 128;
const KILL = 0.012; // seconds: fade of a cut voice (mono retrigger, voice stealing)

/** Value of a breakpoint list [{ t, v }] (t in seconds from the note start) at time t; held before and after. */
export function breakpointValue(points, t) {
  if (!points || !points.length) return 0;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    if (t < points[i].t) {
      const a = points[i - 1];
      const b = points[i];
      return b.t === a.t ? b.v : a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
    }
  }
  return points[points.length - 1].v;
}

/**
 * Render notes through one patch.
 *   params      the patch (flat GGS params; missing ones take their defaults)
 *   notes       [{ key, velocity, start, duration, releaseVelocity, pitch, pressure, timbre, seed }] — start and
 *               duration in seconds; pitch / pressure / timbre are breakpoint lists [{ t, v }] with t in seconds
 *               from the note start (pitch in semitones, the others 0..1)
 *   seconds     length of the render (default: until the last note has rung out, capped at 60 s)
 *   fx          false = voices only (no drive/chorus/delay/reverb/output gain)
 * Returns { sampleRate, channels: [left, right] } (Float32Array).
 */
export function renderPatch({ params, notes = [], sampleRate = 44100, bpm = 120, seconds, fx = true, macros = null }) {
  const p = completeParams(params);
  const fs = sampleRate;
  const list = notes.map((n, i) => ({
    key: n.key ?? 60, velocity: n.velocity ?? 0.8, releaseVelocity: n.releaseVelocity ?? 0.5,
    startFrame: Math.max(0, Math.round((n.start || 0) * fs)),
    endFrame: Math.max(0, Math.round(((n.start || 0) + Math.max(0.005, n.duration ?? 0.5)) * fs)),
    pitch: n.pitch || null, pressure: n.pressure || null, timbre: n.timbre || null,
    seed: n.seed ?? hash32(i * 7919 + 13)
  })).sort((a, b) => a.startFrame - b.startFrame);
  const effects = fx ? new GgsFx({ sampleRate: fs, params: p, bpm }) : null;
  const lastEnd = list.reduce((m, n) => Math.max(m, n.endFrame), 0);
  const auto = lastEnd / fs + releaseTail(p, 0) + (effects ? Math.min(8, effects.tail / fs) : 0) + 0.05;
  const total = Math.ceil(Math.min(600, seconds ?? Math.min(60, auto)) * fs);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const tmpL = new Float32Array(BLOCK);
  const tmpR = new Float32Array(BLOCK);
  const arrays = { pitch: new Float32Array(BLOCK), pressure: new Float32Array(BLOCK), timbre: new Float32Array(BLOCK) };
  const macroValues = macros || [p.macro1, p.macro2, p.macro3, p.macro4];
  const active = [];
  let next = 0;

  const start = (note) => {
    let glideFrom = 0;
    let legato = false;
    if (p.mono) {
      for (const v of active) {
        if (v.killAt >= 0) continue;
        if (v.note.endFrame > note.startFrame) { glideFrom = 440 * Math.pow(2, (v.note.key - 69) / 12); legato = true; }
        v.killAt = note.startFrame;
      }
    }
    const sounding = active.filter((v) => v.killAt < 0);
    for (let i = 0; i <= sounding.length - Math.round(p.polyphony); i++) sounding[i].killAt = note.startFrame;
    active.push({ note, voice: new GgsVoice({ sampleRate: fs, params: p, key: note.key, velocity: note.velocity, seed: note.seed, bpm, glideFrom, legato }), killAt: -1, off: false });
  };

  for (let frame = 0; frame < total; frame += BLOCK) {
    const n = Math.min(BLOCK, total - frame);
    while (next < list.length && list[next].startFrame < frame + n) start(list[next++]);
    for (let a = active.length - 1; a >= 0; a--) {
      const v = active[a];
      const from = Math.max(0, v.note.startFrame - frame);
      if (from >= n) continue;
      const ctl = { macros: macroValues, time: (frame + from) / fs };
      for (const dim of ['pitch', 'pressure', 'timbre']) {
        const pts = v.note[dim];
        if (!pts) { ctl[dim] = 0; continue; }
        const arr = arrays[dim];
        for (let i = from; i < n; i++) arr[i] = breakpointValue(pts, (frame + i - v.note.startFrame) / fs);
        ctl[dim] = arr;
      }
      tmpL.fill(0); tmpR.fill(0);
      // split the block at the note-off so the release starts on its exact sample
      const offAt = v.off ? -1 : v.note.endFrame - frame;
      if (offAt >= from && offAt < n) {
        if (offAt > from) v.voice.process(tmpL, tmpR, from, offAt - from, ctl);
        v.voice.noteOff(v.note.releaseVelocity);
        v.off = true;
        ctl.time = (frame + offAt) / fs;
        v.voice.process(tmpL, tmpR, offAt, n - offAt, ctl);
      } else {
        if (!v.off && offAt < from) { v.voice.noteOff(v.note.releaseVelocity); v.off = true; }
        v.voice.process(tmpL, tmpR, from, n - from, ctl);
      }
      let dead = v.voice.finished;
      for (let i = from; i < n; i++) {
        let g = 1;
        if (v.killAt >= 0) {
          g = 1 - (frame + i - v.killAt) / (KILL * fs);
          if (g <= 0) { dead = true; break; }
          if (g > 1) g = 1;
        }
        L[frame + i] += tmpL[i] * g;
        R[frame + i] += tmpR[i] * g;
      }
      if (dead) active.splice(a, 1);
    }
    if (effects) effects.process(L.subarray(frame, frame + n), R.subarray(frame, frame + n), L.subarray(frame, frame + n), R.subarray(frame, frame + n), n);
  }
  return { sampleRate: fs, channels: [L, R] };
}
