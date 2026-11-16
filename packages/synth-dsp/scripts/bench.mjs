// CPU benchmark of the GGS Synth engine: how many voices fit in real time on one core?
//   node packages/synth-dsp/scripts/bench.mjs [seconds]
// "load" is the share of one CPU core a sustained chord of that many voices takes (AudioWorklets run on one core).
import { GgsVoice, GgsFx, GGS_PRESETS } from '../src/index.js';

const seconds = Number(process.argv[2]) || 2;
const BLOCK = 128;

function loadOf(params, voices, fs) {
  const list = Array.from({ length: voices }, (_, i) => new GgsVoice({ sampleRate: fs, params, key: 36 + ((i * 7) % 48), velocity: 0.8, seed: i + 1, bpm: 120 }));
  const fx = new GgsFx({ sampleRate: fs, params, bpm: 120 });
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  const ctl = { pitch: 0, pressure: 0.5, timbre: 0.5, macros: [0, 0, 0, 0], time: 0 };
  const frames = Math.round(seconds * fs);
  const run = () => {
    for (let f = 0; f < frames; f += BLOCK) {
      L.fill(0); R.fill(0);
      ctl.time = f / fs;
      for (const v of list) v.process(L, R, 0, BLOCK, ctl);
      fx.process(L, R, L, R, BLOCK);
    }
  };
  run(); // warm up the JIT and the wavetable cache
  const t = performance.now();
  run();
  return (performance.now() - t) / 1000 / seconds;
}

const patches = [
  ['init (1 saw)', {}],
  ['3 osc', { oscBOn: true, oscCOn: true }],
  ['3 osc × 4 unison, 2 filters', { oscAUnison: 4, oscBOn: true, oscBUnison: 4, oscCOn: true, oscCUnison: 4, f2On: true }],
  ['3 osc × 8 unison (worst case)', { oscAUnison: 8, oscBOn: true, oscBUnison: 8, oscCOn: true, oscCUnison: 8 }],
  ['FM + warp (2× oversampled)', { oscBOn: true, oscAFmFrom: 'B', oscAFm: 0.5, oscBWarp: 'bend', oscBWarpAmt: 0.5, f1Drive: 0.4 }],
  ['ladder filter (2× oversampled)', { f1Type: 'ladder24', f1Cutoff: 1200, f1Res: 0.5 }],
  ['acid filter (2× oversampled)', { f1Type: 'acid', f1Cutoff: 600, f1Res: 0.85, f1Drive: 0.3 }],
  ['MS-20 filter (2× oversampled)', { f1Type: 'ms20Lp', f1Cutoff: 1200, f1Res: 0.6 }],
  ['formant filter', { f1Type: 'formant', f1Cutoff: 1000, f1Res: 0.4, f1Morph: 0.3 }],
  ['phaser, 12 stages', { f1Type: 'phaser', f1Cutoff: 900, f1Res: 0.4, f1Morph: 1 }],
  ['full FX', { chorusMix: 0.5, delayMix: 0.4, reverbMix: 0.4, driveAmt: 0.3 }],
  ...['Glass Horizon', 'Velvet Pad', 'Neuro Bass', 'Acid Line'].filter((n) => GGS_PRESETS[n]).map((n) => [`preset ${n}`, GGS_PRESETS[n]])
];

console.log(`GGS Synth benchmark — ${seconds}s per measurement, node ${process.version}`);
for (const fs of (process.argv[3] ? [Number(process.argv[3])] : [44100, 48000, 96000])) {
  console.log(`\n${fs} Hz`);
  for (const [name, params] of patches) {
    const row = [1, 8, 16, 32].map((v) => `${v}v ${(loadOf(params, v, fs) * 100).toFixed(1).padStart(5)}%`);
    console.log(`  ${name.padEnd(34)} ${row.join('   ')}`);
  }
}
