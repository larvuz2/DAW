// Renders GGS Synth notes and analyses them off the main thread (analyze_synth_patch): a few seconds of a heavy patch
// would otherwise hold up every other request while it renders.
import { parentPort, workerData } from 'node:worker_threads';
import { renderPatch } from '@greanteadawy/synth-dsp';
import { analyzeAudio, envelopeTimes } from '@greanteadawy/core';

try {
  const { params, notes, seconds, sampleRate, bpm, macros } = workerData;
  const audio = renderPatch({ params, notes, seconds, sampleRate, bpm, macros });
  // analyse the sound itself, not the silence after it
  let last = 0;
  for (const d of audio.channels) for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > 1e-4) { last = i; break; }
  const audible = Math.max(256, Math.min(audio.channels[0].length, last + Math.round(sampleRate * 0.05)));
  const analysis = analyzeAudio({ channels: audio.channels.map((d) => d.subarray(0, audible)), sampleRate });
  parentPort.postMessage({ ok: true, analysis, envelope: envelopeTimes(audio), seconds: audio.channels[0].length / sampleRate, audibleSeconds: audible / sampleRate });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
