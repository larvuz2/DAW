// The Kaleidoscope film: a 36-second piece played on the preset, and everything a picture of it needs to be true to
// the sound — the audio, what every note's layers do sixty times a second (read from the voices while they render,
// not drawn by hand), and each layer's level on its own.
//   node tools/film/kaleidoscope.mjs [--out <folder>]      default: uploads/film/kaleidoscope
// Writes audio.wav (and audio.mp3 when ffmpeg is installed), data.json and index.html: the player with both inside.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPatch, GGS_PRESETS, GGS_PRESET_INFO, MOD_SOURCES, MOD_TARGETS } from '../../packages/synth-dsp/src/index.js';
import { analyzeAudio } from '../../packages/core/src/analysis.js';
import { encodeWav } from '../../packages/core/src/wav.js';
import { noteName } from '../../packages/core/src/music.js';
import { numeralFor } from '../../packages/core/src/harmony.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const OUT = path.resolve(ROOT, arg('--out', 'uploads/film/kaleidoscope'));

const PRESET = 'Kaleidoscope';
const P = GGS_PRESETS[PRESET];
const FS = 48000;
const FPS = 60;
const BPM = 110;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const BARS = 16.5;
const TOTAL = BARS * BAR; // 36 s
const STEP = BEAT / 4;
const STRUM = 0.035; // seconds between the notes of a chord, low to high: every strike is its own moment
const at = (bar, beat = 0) => bar * BAR + beat * BEAT;

// ---------------------------------------------------------------------------------------------------- the piece
// A minor. The chords are voiced so that every voice keeps its note or steps to the next one: a voice is a place in
// the list (low to high), and the sixth is born on the last chord.
const CHORDS = [
  { name: 'C4', title: 'One note', bar: 0, bars: 2, keys: [null, null, null, null, 60, null] },
  { name: 'Am9', bar: 2, bars: 2, keys: [45, 52, 55, 59, 60, null] },
  { name: 'Fmaj9', bar: 4, bars: 2, keys: [41, 52, 55, 57, 60, null], pressure: 0.85 },
  { name: 'Cadd9/E', bar: 6, bars: 2, keys: [40, 52, 55, 60, 62, null] },
  { name: 'G6/9', bar: 8, bars: 2, keys: [43, 52, 57, 59, 62, null], pressure: 0.6 },
  { name: 'Am11', bar: 10, bars: 4, keys: [45, 52, 55, 60, 62, 67], pressure: 0.9, timbre: 0.7 }
];
// single notes over the third section: [beat, key, beats, velocity, slide]
const MELODY = [
  { bar: 6, notes: [[0, 76, 1], [1.5, 79, 0.5], [2, 74, 1.5, 0.75, 0.8], [4, 71, 1], [5.5, 72, 0.5], [6, 76, 2, 0.8, 1]] },
  { bar: 8, notes: [[0, 74, 1], [1.5, 71, 0.5], [2, 69, 1.5, 0.75, 0.8], [4, 71, 1], [5, 74, 1], [6, 79, 2, 0.85, 1]] }
];
// what is played with which macros (Bloom, Pulse, Sparkle, Weight): each section is rendered on its own and the
// renders are added — the effects are linear, so that is the same audio as turning the macros between sections
const SECTIONS = [
  { bar: 0, bars: 2, label: 'One note', macros: [0, P.macro2, 0, 0], chords: [0] },
  { bar: 2, bars: 4, label: 'The preset as it is', macros: [0, P.macro2, 0, 0], chords: [1, 2] },
  { bar: 6, bars: 4, label: 'Bloom, Pulse and Sparkle opened', macros: [0.7, 1, 0.6, 0], chords: [3, 4], melody: true },
  { bar: 10, bars: 6.5, label: 'Everything open', macros: [1, 0.3, 0.4, 0.4], chords: [5] }
];

const swell = (seconds, to) => [{ t: 0, v: 0 }, { t: seconds * 0.75, v: to }, { t: seconds, v: to * 0.6 }];
const notes = [];
CHORDS.forEach((chord, c) => {
  let order = 0;
  chord.keys.forEach((key, voice) => {
    if (key === null) return;
    const start = at(chord.bar) + order * STRUM;
    const end = at(chord.bar + chord.bars) - 0.08;
    const seconds = chord.bars * BAR;
    notes.push({
      id: notes.length, key, start, duration: end - start, velocity: 0.74 + 0.03 * (order % 3) + (c === 5 ? 0.04 : 0), seed: 100 * chord.bar + voice,
      role: 'chord', chord: c, voice,
      ...(chord.pressure ? { pressure: swell(seconds, chord.pressure) } : {}), ...(chord.timbre ? { timbre: swell(seconds, chord.timbre) } : {})
    });
    order++;
  });
});
for (const phrase of MELODY) {
  phrase.notes.forEach(([beat, key, beats, velocity = 0.8, slide = 0], i) => {
    notes.push({
      id: notes.length, key, start: at(phrase.bar, beat), duration: beats * BEAT, velocity, seed: 900 + 31 * phrase.bar + i, role: 'melody', voice: 'melody',
      ...(slide ? { timbre: [{ t: 0, v: 0 }, { t: 0.4, v: slide }] } : {})
    });
  });
}
const sectionOf = (note) => SECTIONS.findIndex((s) => (note.role === 'melody' ? s.melody && note.start >= at(s.bar) - 1e-6 && note.start < at(s.bar + s.bars) : s.chords.includes(note.chord)));

// ------------------------------------------------------------------------------------- what the voices do, 60×/s
const SRC = Object.fromEntries(MOD_SOURCES.map((s, i) => [s, i]));
const DST = Object.fromEntries(MOD_TARGETS.map((s, i) => [s, i]));
const FIELDS = ['amp', 'strike', 'body', 'pulse', 'air', 'sub', 'pos', 'cut', 'pan', 'twinkle', 'vib', 'press', 'slide'];
const tele = new Map(notes.map((n) => [n, { k0: -1, ...Object.fromEntries(FIELDS.map((f) => [f, []])), strikePan: 0 }]));
const TICK = FS / FPS;

function tap(frame, count, voices) {
  const k = Math.ceil(frame / TICK);
  if (k * TICK >= frame + count) return; // no sixtieth of a second falls in this block
  for (const { note, voice, killAt } of voices) {
    if (killAt >= 0 && frame >= killAt) continue; // being faded out to make room
    if (k * TICK < note.startFrame) continue;
    const row = tele.get(note.ref);
    if (row.k0 < 0) { row.k0 = k; row.strikePan = voice.dst[DST.oscBPan]; }
    if (row.k0 + row.amp.length !== k) continue; // (one row per sixtieth)
    const amp = voice.ampTo;
    row.amp.push(amp);
    row.body.push(voice.oscs[0].levelTo * amp);
    row.strike.push(voice.oscs[1].levelTo * amp);
    row.pulse.push(voice.oscs[2].levelTo * amp);
    row.air.push(voice.noise.levelTo * amp);
    row.sub.push(voice.sub.levelTo * amp);
    row.pos.push(voice.oscs[0].posTo); // where the body reads its table: more saws stacked the higher it is
    row.cut.push(voice.dst[DST.f1Cutoff] * 10); // octaves the body's filter is open above where it rests
    row.pan.push(voice.dst[DST.oscCPan]); // where the pulse stands, -1 left … 1 right
    row.twinkle.push(voice.oscs[2].posTo);
    row.vib.push(voice.dst[DST.pitchFine]); // semitones
    row.press.push(voice.src[SRC.pressure]);
    row.slide.push(voice.src[SRC.timbre]);
  }
}

// ----------------------------------------------------------------------------------------------------- rendering
const frames = Math.ceil(TOTAL * FS);
const mix = () => [new Float32Array(frames), new Float32Array(frames)];
function renderInto(target, params, withTap, fx = true) {
  SECTIONS.forEach((section, s) => {
    const list = notes.filter((n) => sectionOf(n) === s);
    const r = renderPatch({ params, notes: list, seconds: TOTAL, sampleRate: FS, bpm: BPM, macros: [...section.macros, 0, 0, 0, 0], tap: withTap ? tap : null, fx });
    for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) target[c][i] += r.channels[c][i];
  });
  return target;
}
console.log(`rendering ${notes.length} notes, ${TOTAL.toFixed(2)} s…`);
const full = renderInto(mix(), P, true);

// a layer alone: the same patch with every other source switched off (and the routes to their levels)
const LAYERS = [['strike', 'B'], ['body', 'A'], ['pulse', 'C'], ['air', 'N'], ['sub', 'S']];
function only(keep) {
  const p = { ...P };
  const silence = (targets) => { for (let i = 1; i <= 64; i++) if (targets.includes(p[`mod${i}Dst`])) p[`mod${i}Amt`] = 0; };
  for (const x of ['A', 'B', 'C']) if (keep !== x) { p[`osc${x}On`] = false; silence([`osc${x}Level`]); }
  if (keep !== 'S') { p.subLevel = 0; silence(['subLevel']); }
  if (keep !== 'N') { p.noiseLevel = 0; silence(['noiseLevel']); }
  return p;
}
const LANE_HZ = 120;
function envelope(channels) {
  const win = FS / LANE_HZ;
  const out = new Float32Array(Math.floor(frames / win));
  for (let k = 0; k < out.length; k++) {
    let sum = 0;
    for (let i = Math.round(k * win); i < Math.round((k + 1) * win); i++) sum += channels[0][i] * channels[0][i] + channels[1][i] * channels[1][i];
    out[k] = Math.sqrt(sum / (2 * win));
  }
  return out;
}
const lanes = {};
// (before the effects: a strike is a strike there, not a strike and its echoes)
for (const [name, keep] of LAYERS) lanes[name] = envelope(renderInto(mix(), only(keep), false, false));
lanes.all = envelope(full);

// one gain for the whole clip (no limiter, no EQ): to -16 LUFS, or lower if the true peak would pass -1 dBFS
const before = analyzeAudio({ sampleRate: FS, channels: full });
let gain = Math.pow(10, (-16 - before.lufs) / 20);
if (before.truePeakDb + 20 * Math.log10(gain) > -1) gain = Math.pow(10, (-1 - before.truePeakDb) / 20);
const fade = Math.round(0.6 * FS);
for (const ch of full) {
  for (let i = 0; i < frames; i++) ch[i] *= gain;
  for (let i = 0; i < fade; i++) ch[frames - 1 - i] *= i / fade;
}
const after = analyzeAudio({ sampleRate: FS, channels: full });

// ------------------------------------------------------------------------------------------------------ the data
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const peakOf = (field) => Math.max(1e-9, ...notes.map((n) => Math.max(0, ...tele.get(n)[field])));
const PEAK = Object.fromEntries(['strike', 'body', 'pulse', 'air', 'sub', 'amp'].map((f) => [f, peakOf(f)]));
// a lane is drawn to its own peak, and as tall as the layer is loud next to the loudest one (36 dB down = a third)
const laneTop = Math.max(...LAYERS.map(([name]) => Math.max(...lanes[name])));
const laneShape = (name) => {
  const peak = Math.max(...lanes[name]);
  const height = name === 'all' ? 1 : Math.max(0.34, Math.min(1, 1 + (20 * Math.log10(peak / laneTop)) / 54));
  return Array.from(lanes[name], (v) => Math.round(255 * height * Math.pow(v / peak, 0.8)));
};

const data = {
  title: PRESET,
  description: GGS_PRESET_INFO[PRESET].description,
  macros: GGS_PRESET_INFO[PRESET].macros,
  key: 'A minor', bpm: BPM, beat: BEAT, bar: BAR, step: STEP, total: TOTAL, fps: FPS, laneHz: LANE_HZ, strum: STRUM,
  pattern: Array.from({ length: 16 }, (_, k) => P[`lfo2S${k + 1}`]),
  loudness: { lufs: after.lufs, truePeakDb: after.truePeakDb },
  sections: SECTIONS.map((s) => ({ t0: at(s.bar), t1: at(s.bar + s.bars), label: s.label, macros: s.macros.map((v) => round(v, 2)) })),
  chords: CHORDS.map((c, i) => {
    const prev = i > 1 ? CHORDS[i - 1] : null;
    let numeral = '';
    if (i > 0) { try { numeral = numeralFor(c.name, 'A', 'minor'); } catch { numeral = ''; } }
    return {
      name: c.name, title: c.title || '', numeral, t0: at(c.bar), t1: at(c.bar + c.bars),
      voices: c.keys.map((key, v) => (key === null ? null : { key, name: noteName(key), from: prev && prev.keys[v] !== null ? prev.keys[v] : null }))
    };
  }),
  notes: notes.map((n) => {
    const row = tele.get(n);
    if (row.k0 < 0) throw new Error(`note ${n.id} was never heard`);
    // the pulse per sixteenth of the song: its level, where it stands, how it twinkles
    const beads = [];
    const first = Math.floor((row.k0 / FPS) / STEP);
    const last = Math.floor(((row.k0 + row.pulse.length) / FPS) / STEP);
    for (let s = first; s <= last; s++) {
      let level = 0; let pan = 0; let tw = 0; let count = 0;
      for (let k = Math.max(row.k0, Math.ceil(s * STEP * FPS)); k < Math.min(row.k0 + row.pulse.length, (s + 1) * STEP * FPS); k++) {
        level += row.pulse[k - row.k0]; pan += row.pan[k - row.k0]; tw += row.twinkle[k - row.k0]; count++;
      }
      if (count && level / count / PEAK.pulse > 0.012) beads.push([s, round(level / count / PEAK.pulse), round(pan / count, 2), round(tw / count, 2)]);
    }
    return {
      id: n.id, key: n.key, name: noteName(n.key), start: round(n.start, 4), end: round(n.start + n.duration, 4), velocity: round(n.velocity, 2),
      role: n.role, chord: n.chord ?? -1, voice: n.voice, section: sectionOf(n), k0: row.k0, frames: row.amp.length, strikePan: round(row.strikePan, 2),
      ...Object.fromEntries(['strike', 'body', 'pulse', 'air', 'sub', 'amp'].map((f) => [f, row[f].map((v) => round(v / PEAK[f]))])),
      pos: row.pos.map((v) => round(v, 2)), cut: row.cut.map((v) => round(v, 2)), vib: row.vib.map((v) => round(v, 3)), press: row.press.map((v) => round(v, 2)), slide: row.slide.map((v) => round(v, 2)),
      beads
    };
  }),
  lanes: Object.fromEntries(Object.keys(lanes).map((name) => [name, laneShape(name)]))
};

// --------------------------------------------------------------------------------------------------------- files
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'audio.wav'), Buffer.from(encodeWav(full, FS, { bitDepth: 24 })));
const json = JSON.stringify(data);
writeFileSync(path.join(OUT, 'data.json'), json);
let audio = null;
const mp3 = path.join(OUT, 'audio.mp3');
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, 'audio.wav'), '-codec:a', 'libmp3lame', '-b:a', '192k', mp3]);
if (ff.status === 0 && existsSync(mp3)) audio = { type: 'audio/mpeg', bytes: readFileSync(mp3) };
else audio = { type: 'audio/wav', bytes: Buffer.from(encodeWav(full, FS, { bitDepth: 16 })) }; // (no ffmpeg: the page carries the WAV)
const page = readFileSync(path.join(HERE, 'player.html'), 'utf8')
  .replace('/*__PLAYER__*/', () => readFileSync(path.join(HERE, 'player.js'), 'utf8'))
  .replace('"__DATA__"', () => json.replace(/</g, '\\u003c'))
  .replace('__AUDIO_TYPE__', audio.type)
  .replace('__AUDIO__', () => audio.bytes.toString('base64'));
writeFileSync(path.join(OUT, 'index.html'), page);

const live = notes.map((n) => tele.get(n).amp.length / FPS);
console.log(`${after.duration.toFixed(1)} s · ${after.lufs} LUFS · true peak ${after.truePeakDb} dBTP (one gain of ${(20 * Math.log10(gain)).toFixed(1)} dB)`);
console.log(`${notes.length} notes, ${data.notes.reduce((a, n) => a + n.beads.length, 0)} pulses, the longest note sounds ${Math.max(...live).toFixed(1)} s`);
console.log(`layers at their loudest (dB under the mix): ${LAYERS.map(([name]) => `${name} ${(20 * Math.log10(Math.max(...lanes[name]) / Math.max(...lanes.all))).toFixed(1)}`).join(' · ')}`);
console.log(`chords: ${data.chords.map((c) => `${c.name}${c.numeral ? ` (${c.numeral})` : ''}`).join(' → ')}`);
console.log(`wrote ${path.relative(ROOT, OUT)}/{audio.wav, ${audio.type === 'audio/mpeg' ? 'audio.mp3, ' : ''}data.json, index.html} (data ${(json.length / 1024).toFixed(0)} KB, page ${(page.length / 1024 / 1024).toFixed(2)} MB)`);
