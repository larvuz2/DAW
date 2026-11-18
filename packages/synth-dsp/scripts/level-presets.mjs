// Level the GGS Synth presets by measurement, so that swapping presets never upsets a mix:
//   node packages/synth-dsp/scripts/level-presets.mjs            report the loudness of every preset
//   node packages/synth-dsp/scripts/level-presets.mjs --write    rewrite each preset's `gain` in src/presets.js
// Policy: one note at velocity 0.8 (no pressure, no slide) at the preset's typical pitch peaks at TARGET LUFS
// (loudest 400 ms, K-weighted) unless its sample peak would pass PEAK_CAP dBFS — plucks and other sharp attacks
// are capped by their peak instead, so a four-note chord never lands more than a hair over full scale.
import { readFileSync, writeFileSync } from 'node:fs';
import { GGS_PRESETS, GGS_PRESET_INFO, renderPatch, ggsDefaults } from '../src/index.js';
import { analyzeAudio } from '../../core/src/analysis.js';

const TARGET = -18;
const PEAK_CAP = -9;
const SEEDS = [1, 2, 3, 4];
const write = process.argv.includes('--write');
const file = new URL('../src/presets.js', import.meta.url);
let source = readFileSync(file, 'utf8');

function measure(params, info) {
  const slow = (params.env1A ?? 0.005) > 0.3;
  // (a preset whose loudest layer arrives on another envelope than the amp's says how long to hold: test.hold)
  const duration = info.test?.hold ?? (slow ? 5 : 2);
  // unison stacks and free LFOs beat differently on every take: average a few (the seeds the tests use too)
  let lufs = 0;
  let peak = -200;
  for (const seed of SEEDS) {
    const r = renderPatch({ params, notes: [{ key: info.test?.key ?? 60, velocity: 0.8, start: 0.05, duration, seed }], seconds: duration + 0.6, sampleRate: 48000, bpm: 120 });
    const a = analyzeAudio(r, { lite: true });
    lufs += a.momentaryMaxLufs / SEEDS.length;
    peak = Math.max(peak, a.peakDb);
  }
  return { lufs: Math.round(lufs * 10) / 10, peak };
}

const rows = [];
for (const [name, params] of Object.entries(GGS_PRESETS)) {
  const info = GGS_PRESET_INFO[name];
  const gain = params.gain ?? ggsDefaults().gain;
  const m = measure(params, info);
  // the gain that hits the target, lowered if the peak would then pass the cap
  let next = gain * Math.pow(10, (TARGET - m.lufs) / 20);
  const peakAfter = m.peak + 20 * Math.log10(next / gain);
  if (peakAfter > PEAK_CAP) next *= Math.pow(10, (PEAK_CAP - peakAfter) / 20);
  next = Math.min(2, Math.round(next * 100) / 100);
  rows.push({ name, category: info.category, lufs: m.lufs, peak: m.peak, gain, next });
  if (write && name !== 'Init') {
    const at = source.indexOf(`preset('${name}'`);
    const re = /gain: [\d.]+/g;
    re.lastIndex = at;
    const hit = re.exec(source);
    if (at < 0 || !hit) throw new Error(`gain of preset "${name}" not found`);
    source = source.slice(0, hit.index) + `gain: ${next}` + source.slice(hit.index + hit[0].length);
  }
}
for (const r of rows) console.log(`${r.name.padEnd(18)} ${r.category.padEnd(13)} ${String(r.lufs).padStart(6)} LUFS  peak ${String(r.peak).padStart(6)} dBFS  gain ${r.gain} → ${r.next}`);
if (write) { writeFileSync(file, source); console.log('\nwrote src/presets.js'); }
