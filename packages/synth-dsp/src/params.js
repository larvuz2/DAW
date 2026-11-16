// Parameter schema of the GGS Synth. One flat list — the same shape as every other instrument's params — so the
// studio's generic machinery (validation, undo, live sync, MCP, presets) works unchanged. Keys are grouped by a
// prefix (oscA…, f1…, env2…, lfo3…, mod7…); `section` and `group` tell editors how to lay them out.
import { WAVETABLE_IDS } from './wavetables.js';

const n = (key, label, min, max, def, extra = {}) => ({ key, label, type: 'number', min, max, default: def, ...extra });
const sel = (key, label, options, def, extra = {}) => ({ key, label, type: 'select', options, default: def, ...extra });
const bool = (key, label, def, extra = {}) => ({ key, label, type: 'bool', default: def, ...extra });

export const OSC_IDS = ['A', 'B', 'C'];
export const WARP_MODES = ['off', 'bend', 'pwm', 'sync', 'mirror', 'fold', 'quantize'];
export const FM_SOURCES = ['off', 'A', 'B', 'C', 'sub', 'noise'];
export const SOURCE_DESTS = ['f1', 'f2', 'both', 'direct'];
export const FILTER_TYPES = ['lp12', 'lp24', 'hp12', 'hp24', 'bp12', 'bp24', 'notch', 'peak', 'comb'];
export const FILTER_ROUTES = ['serial', 'parallel'];
export const SUB_WAVES = ['sine', 'triangle', 'saw', 'square'];
export const NOISE_TYPES = ['white', 'pink', 'brown'];
export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'ramp', 'square', 'sh', 'smooth'];
export const LFO_SYNC = ['off', '8bar', '4bar', '2bar', '1bar', '1/2', '1/4', '1/8', '1/16', '1/32', '1/2t', '1/4t', '1/8t', '1/16t', '1/4d', '1/8d', '1/16d'];
export const LFO_TRIGGERS = ['note', 'free'];
export const DRIVE_TYPES = ['soft', 'hard', 'tube', 'fold'];
export const DELAY_SYNC = ['free', '1/32', '1/16', '1/16d', '1/8t', '1/8', '1/8d', '1/4t', '1/4', '1/4d', '1/2'];
export const QUALITIES = ['eco', 'auto', 'high'];
export const ENV_COUNT = 4;
export const LFO_COUNT = 4;
export const MACRO_COUNT = 4;
export const MOD_SLOTS = 16;

/** Length of a tempo division in beats ("1/8d" = dotted eighth, "2bar" = two 4/4 bars). */
export function syncBeats(div) {
  const bar = /^(\d+)bar$/.exec(div);
  if (bar) return parseInt(bar[1], 10) * 4;
  const m = /^1\/(\d+)([dt]?)$/.exec(div);
  if (!m) return 0;
  let beats = 4 / parseInt(m[1], 10);
  if (m[2] === 'd') beats *= 1.5;
  if (m[2] === 't') beats *= 2 / 3;
  return beats;
}

/**
 * Modulation sources. Envelopes, velocity, pressure, timbre and the macros run 0..1; LFOs, random, key and bend are
 * bipolar (-1..1). All of them are per note except the macros and LFOs set to "free" (shared by every note).
 */
export const MOD_SOURCES = [
  'none', 'env1', 'env2', 'env3', 'env4', 'lfo1', 'lfo2', 'lfo3', 'lfo4',
  'velocity', 'pressure', 'timbre', 'bend', 'key', 'random', 'releaseVel', 'macro1', 'macro2', 'macro3', 'macro4'
];
export const MOD_SOURCE_INFO = {
  none: 'nothing',
  env1: 'envelope 1 (the amp envelope), 0..1', env2: 'envelope 2, 0..1', env3: 'envelope 3, 0..1', env4: 'envelope 4, 0..1',
  lfo1: 'LFO 1, -1..1', lfo2: 'LFO 2, -1..1', lfo3: 'LFO 3, -1..1', lfo4: 'LFO 4, -1..1',
  velocity: 'note velocity, 0..1', pressure: "the note's pressure curve, 0..1", timbre: "the note's slide/timbre curve, 0..1",
  bend: "the note's pitch curve in octaves (-1..1 = ±12 semitones)", key: 'keyboard position, -1..1 around C4 (±5 octaves)',
  random: 'a random value per note, -1..1', releaseVel: 'release velocity, 0 until the note is let go',
  macro1: 'macro 1, 0..1', macro2: 'macro 2, 0..1', macro3: 'macro 3, 0..1', macro4: 'macro 4, 0..1'
};

/**
 * Modulation targets and what an amount of 1 means (source at full): the whole range of the control it moves.
 * Targets are the keys of the params they modulate, plus pitch / pitchFine / pan (which have no knob of their own).
 */
export const MOD_TARGET_INFO = {
  none: 'nothing',
  pitch: 'all oscillators, 1 = +24 semitones',
  pitchFine: 'all oscillators, 1 = +1 semitone (vibrato)',
  level: 'voice level, 1 = +100% (set the Level knob to 0 and add pressure for a swell)',
  pan: 'voice pan, 1 = hard right',
  ...Object.fromEntries(OSC_IDS.flatMap((x) => [
    [`osc${x}Pitch`, `oscillator ${x} only, 1 = +24 semitones`],
    [`osc${x}Pos`, `oscillator ${x} wavetable position, 1 = the whole table`],
    [`osc${x}Level`, `oscillator ${x} level, 1 = +100%`],
    [`osc${x}Pan`, `oscillator ${x} pan, 1 = hard right`],
    [`osc${x}WarpAmt`, `oscillator ${x} warp amount, 1 = full`],
    [`osc${x}Fm`, `oscillator ${x} FM amount, 1 = full`],
    [`osc${x}Detune`, `oscillator ${x} unison detune, 1 = +100 cents`]
  ])),
  subLevel: 'sub oscillator level', noiseLevel: 'noise level',
  f1Cutoff: 'filter 1 cutoff, 1 = +10 octaves', f1Res: 'filter 1 resonance', f1Drive: 'filter 1 drive',
  f2Cutoff: 'filter 2 cutoff, 1 = +10 octaves', f2Res: 'filter 2 resonance', f2Drive: 'filter 2 drive',
  lfo1Rate: 'LFO 1 rate, 1 = ×16', lfo2Rate: 'LFO 2 rate, 1 = ×16', lfo3Rate: 'LFO 3 rate, 1 = ×16', lfo4Rate: 'LFO 4 rate, 1 = ×16'
};
export const MOD_TARGETS = Object.keys(MOD_TARGET_INFO);

function oscParams(x, on, level) {
  const g = `Oscillator ${x}`;
  const s = { section: `osc${x}`, group: g };
  return [
    bool(`osc${x}On`, 'On', on, s),
    sel(`osc${x}Table`, 'Wavetable', WAVETABLE_IDS, 'basic', s),
    n(`osc${x}Pos`, 'Position', 0, 1, 0.5, s),
    n(`osc${x}Level`, 'Level', 0, 1, level, s),
    n(`osc${x}Pan`, 'Pan', -1, 1, 0, s),
    n(`osc${x}Oct`, 'Octave', -4, 4, 0, { step: 1, ...s }),
    n(`osc${x}Semi`, 'Semi', -12, 12, 0, { step: 1, ...s }),
    n(`osc${x}Fine`, 'Fine', -100, 100, 0, { unit: 'ct', ...s }),
    n(`osc${x}Unison`, 'Unison', 1, 8, 1, { step: 1, ...s }),
    n(`osc${x}Detune`, 'Detune', 0, 100, 20, { unit: 'ct', ...s }),
    n(`osc${x}Blend`, 'Blend', 0, 1, 0.75, s),
    n(`osc${x}Spread`, 'Stereo', 0, 1, 0.7, s),
    n(`osc${x}Phase`, 'Phase', 0, 1, 0, s),
    n(`osc${x}Rand`, 'Phase rand', 0, 1, 1, s),
    sel(`osc${x}Warp`, 'Warp', WARP_MODES, 'off', s),
    n(`osc${x}WarpAmt`, 'Warp amt', 0, 1, 0, s),
    sel(`osc${x}FmFrom`, 'FM from', FM_SOURCES, 'off', s),
    n(`osc${x}Fm`, 'FM amt', 0, 1, 0, s),
    sel(`osc${x}Dest`, 'To', SOURCE_DESTS, 'f1', s)
  ];
}

function filterParams(i, on) {
  const s = { section: 'filter', group: `Filter ${i}` };
  return [
    bool(`f${i}On`, 'On', on, s),
    sel(`f${i}Type`, 'Type', FILTER_TYPES, 'lp24', s),
    n(`f${i}Cutoff`, 'Cutoff', 20, 20000, 20000, { unit: 'Hz', curve: 'log', ...s }),
    n(`f${i}Res`, 'Resonance', 0, 1, 0.1, s),
    n(`f${i}Drive`, 'Drive', 0, 1, 0, s),
    n(`f${i}Key`, 'Key track', 0, 1, 0, s)
  ];
}

function envParams(i, a, d, sus, r) {
  const s = { section: 'env', group: i === 1 ? 'Envelope 1 (amp)' : `Envelope ${i}` };
  return [
    n(`env${i}A`, 'Attack', 0.001, 10, a, { unit: 's', curve: 'log', ...s }),
    n(`env${i}D`, 'Decay', 0.005, 10, d, { unit: 's', curve: 'log', ...s }),
    n(`env${i}S`, 'Sustain', 0, 1, sus, s),
    n(`env${i}R`, 'Release', 0.005, 15, r, { unit: 's', curve: 'log', ...s }),
    n(`env${i}Curve`, 'Curve', -1, 1, 0, s)
  ];
}

function lfoParams(i) {
  const s = { section: 'lfo', group: `LFO ${i}` };
  return [
    sel(`lfo${i}Shape`, 'Shape', LFO_SHAPES, 'sine', s),
    n(`lfo${i}Rate`, 'Rate', 0.01, 50, i === 1 ? 5 : 1, { unit: 'Hz', curve: 'log', ...s }),
    sel(`lfo${i}Sync`, 'Sync', LFO_SYNC, 'off', s),
    sel(`lfo${i}Trig`, 'Trigger', LFO_TRIGGERS, 'note', s),
    n(`lfo${i}Fade`, 'Fade in', 0, 5, 0, { unit: 's', ...s }),
    n(`lfo${i}Phase`, 'Phase', 0, 1, 0, s)
  ];
}

function modParams(i) {
  const s = { section: 'mod', group: `Mod ${i}` };
  return [
    sel(`mod${i}Src`, 'Source', MOD_SOURCES, 'none', s),
    sel(`mod${i}Dst`, 'Target', MOD_TARGETS, 'none', s),
    n(`mod${i}Amt`, 'Amount', -1, 1, 0, s),
    sel(`mod${i}Via`, 'Via', MOD_SOURCES, 'none', s)
  ];
}

const range = (count) => Array.from({ length: count }, (_, i) => i + 1);

export const GGS_PARAMS = [
  ...oscParams('A', true, 0.8),
  ...oscParams('B', false, 0.6),
  ...oscParams('C', false, 0.5),
  n('subLevel', 'Level', 0, 1, 0, { section: 'sub', group: 'Sub' }),
  sel('subWave', 'Wave', SUB_WAVES, 'sine', { section: 'sub', group: 'Sub' }),
  n('subOct', 'Octave', -3, 0, -1, { step: 1, section: 'sub', group: 'Sub' }),
  sel('subDest', 'To', SOURCE_DESTS, 'direct', { section: 'sub', group: 'Sub' }),
  n('noiseLevel', 'Level', 0, 1, 0, { section: 'noise', group: 'Noise' }),
  sel('noiseType', 'Type', NOISE_TYPES, 'white', { section: 'noise', group: 'Noise' }),
  n('noiseColor', 'Color', -1, 1, 0, { section: 'noise', group: 'Noise' }),
  sel('noiseDest', 'To', SOURCE_DESTS, 'f1', { section: 'noise', group: 'Noise' }),
  ...filterParams(1, true),
  ...filterParams(2, false),
  sel('filterRoute', 'Routing', FILTER_ROUTES, 'serial', { section: 'filter', group: 'Routing' }),
  ...envParams(1, 0.005, 0.3, 1, 0.25),
  ...envParams(2, 0.005, 0.4, 0, 0.3),
  ...envParams(3, 0.005, 0.4, 0, 0.3),
  ...envParams(4, 0.005, 0.4, 0, 0.3),
  ...range(LFO_COUNT).flatMap(lfoParams),
  ...range(MACRO_COUNT).map((i) => n(`macro${i}`, `Macro ${i}`, 0, 1, 0, { section: 'macro', group: 'Macros' })),
  ...range(MOD_SLOTS).flatMap(modParams),
  n('level', 'Level', 0, 1, 1, { section: 'voice', group: 'Voice' }),
  n('velSens', 'Velocity', 0, 1, 1, { section: 'voice', group: 'Voice' }),
  n('relVelSens', 'Rel. velocity', 0, 1, 0, { section: 'voice', group: 'Voice' }),
  n('polyphony', 'Polyphony', 1, 32, 16, { step: 1, section: 'voice', group: 'Voice' }),
  bool('mono', 'Mono', false, { section: 'voice', group: 'Voice' }),
  bool('legato', 'Legato', false, { section: 'voice', group: 'Voice' }),
  n('glide', 'Glide', 0, 2, 0, { unit: 's', section: 'voice', group: 'Voice' }),
  n('bendRange', 'Bend range', 1, 96, 48, { step: 1, unit: 'st', section: 'voice', group: 'Voice' }),
  sel('quality', 'Quality', QUALITIES, 'auto', { section: 'voice', group: 'Voice' }),
  n('gain', 'Gain', 0, 2, 0.55, { section: 'voice', group: 'Voice' }),
  n('driveAmt', 'Amount', 0, 1, 0, { section: 'fx', group: 'Drive' }),
  sel('driveType', 'Type', DRIVE_TYPES, 'soft', { section: 'fx', group: 'Drive' }),
  n('chorusMix', 'Mix', 0, 1, 0, { section: 'fx', group: 'Chorus' }),
  n('chorusRate', 'Rate', 0.05, 5, 0.6, { unit: 'Hz', curve: 'log', section: 'fx', group: 'Chorus' }),
  n('chorusDepth', 'Depth', 0, 1, 0.5, { section: 'fx', group: 'Chorus' }),
  n('delayMix', 'Mix', 0, 1, 0, { section: 'fx', group: 'Delay' }),
  sel('delaySync', 'Time', DELAY_SYNC, '1/8d', { section: 'fx', group: 'Delay' }),
  n('delayTime', 'Free time', 1, 2000, 350, { unit: 'ms', curve: 'log', section: 'fx', group: 'Delay' }),
  n('delayFb', 'Feedback', 0, 0.95, 0.35, { section: 'fx', group: 'Delay' }),
  n('delayTone', 'Tone', 200, 20000, 6000, { unit: 'Hz', curve: 'log', section: 'fx', group: 'Delay' }),
  bool('delayPing', 'Ping-pong', true, { section: 'fx', group: 'Delay' }),
  n('reverbMix', 'Mix', 0, 1, 0, { section: 'fx', group: 'Reverb' }),
  n('reverbSize', 'Size', 0, 1, 0.5, { section: 'fx', group: 'Reverb' }),
  n('reverbDamp', 'Damping', 0, 1, 0.4, { section: 'fx', group: 'Reverb' })
];

const BY_KEY = new Map(GGS_PARAMS.map((p) => [p.key, p]));
export const ggsParamDef = (key) => BY_KEY.get(key) || null;

const DEFAULTS = Object.freeze(Object.fromEntries(GGS_PARAMS.map((p) => [p.key, p.default])));
/** A fresh copy of the init patch (one saw through an open filter). */
export const ggsDefaults = () => ({ ...DEFAULTS });

/** Params of the effects section (they live in the channel's FX processor, not in the voices). */
export const FX_KEYS = GGS_PARAMS.filter((p) => p.section === 'fx').map((p) => p.key).concat(['gain']);

/** Fill a (possibly partial or damaged) params object with defaults; values of the wrong type fall back. */
export function completeParams(params) {
  const out = { ...DEFAULTS };
  if (!params || typeof params !== 'object') return out;
  for (const def of GGS_PARAMS) {
    const v = params[def.key];
    if (v === undefined || v === null) continue;
    if (def.type === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[def.key] = v < def.min ? def.min : v > def.max ? def.max : v;
    } else if (def.type === 'select') {
      if (def.options.includes(v)) out[def.key] = v;
    } else out[def.key] = v === true;
  }
  return out;
}

/**
 * Does a patch make new harmonics after the oscillators (phase modulation, warping, filter drive)? Those can alias,
 * so quality "auto" runs such patches at twice the sample rate — and plain patches, which can't alias, at 1×.
 */
export function needsOversampling(p) {
  for (const x of OSC_IDS) {
    if (!p[`osc${x}On`]) continue;
    if (p[`osc${x}Warp`] !== 'off') return true;
    if (p[`osc${x}FmFrom`] !== 'off') return true;
  }
  if ((p.f1On && (p.f1Drive > 0 || p.f1Type === 'comb')) || (p.f2On && (p.f2Drive > 0 || p.f2Type === 'comb'))) return true;
  for (let i = 1; i <= MOD_SLOTS; i++) {
    if (p[`mod${i}Src`] !== 'none' && p[`mod${i}Amt`] && /(Fm|WarpAmt|Drive)$/.test(p[`mod${i}Dst`])) return true;
  }
  return false;
}

/**
 * The longest a note can ring after its note-off, in seconds: the amp envelope's release (stretched by release
 * velocity at most 4×) plus the closing fade. The audio engine uses it to know when a voice is finished.
 */
export function releaseTail(params, releaseVelocity = 0.5) {
  const r = typeof params?.env1R === 'number' ? params.env1R : DEFAULTS.env1R;
  const sens = typeof params?.relVelSens === 'number' ? params.relVelSens : 0;
  return r * Math.pow(2, (0.5 - releaseVelocity) * 4 * sens) + 0.02;
}
