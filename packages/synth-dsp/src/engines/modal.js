// Modal engine: a note is an object that rings — up to 32 resonant modes, each with its own frequency, decay time and
// share of the blow — set going by a mallet, a pluck, a burst of noise or a bow. Marimbas and vibraphones, bells and
// chimes, plucked and struck strings, drum heads, bowed bars: the knobs say what the object is made of and where it
// is hit, and the sound follows as it would from the real thing (hit it harder and it is brighter, damp it and the
// high modes go first). Ported from the modal oscillator of the Rust synth (osc-spectral/modal.rs): the mode tables,
// the decay law, the exciters and the way a strike is levelled are the reference's; what a one-note-per-instance
// engine needed on top is marked "not in the reference".
import { SynthEngine, num, choice, clamp, dbToLin, keyHz, TAU } from './base.js';
import { Arena, hash32 } from '../util.js';

export const MAX_MODES = 32;
const N = MAX_MODES;
/** What sets the object ringing. */
export const MODAL_EXCITERS = ['mallet', 'pluck', 'noise', 'bow'];
/** The five sets of mode ratios (`morph` blends from one to the next). */
export const MODAL_STRUCTURES = ['string', 'stiff', 'bar', 'membrane', 'bell'];
/** Peak of a full-velocity strike before the Level knob (−6 dBFS), whatever the object. */
export const STRIKE_PEAK = 0.5;
/** Level (RMS, before the Level knob) a held bow settles at with Drive at 1 and full velocity (−12 dBFS). */
export const BOW_RMS = 0.25;

const MALLET = 0;
const PLUCK = 1;
const NOISE = 2;
const BOW = 3;
/** Steps of the trial run that measures how high a strike will peak (see unitStrikePeak). */
const SIM_STEPS = 1024;
/** The most a strike or a bow may be turned up to reach its level: an object whose modes barely answer the exciter
 * must not be loaded with enormous energy nobody hears until a knob moves. */
const MAX_EXCITER_GAIN = 16;
/** A noise burst's usual peak, as a multiple of the modes' levels summed as powers. */
const BURST_CREST = 1.6;
/** The pluck's bit of noise, relative to its impulse. */
const PLUCK_NOISE = 0.12;
/** Power of the noise (uniform in ±1). */
const NOISE_POWER = 1 / 3;
const LN_1000 = 6.907755278982137;
/** Nothing sounds above this, at any sample rate (so an oversampled note has the modes it has at 48 kHz). */
const MAX_MODE_HZ = 21600;
/** The note is over when what still rings is 80 dB under the loudest it has been (as a power: 1e-8). Not in the
 * reference, which runs until its numbers reach exact zero — as 32-bit floats do, and doubles do not for minutes. */
const SILENCE = 1e-8;
/** The exciter's filter is put to rest below this (−180 dB): what it could still add is far under SILENCE. */
const EXCITER_REST = 1e-9;
/** Where the five groups of modes sit in the stereo field, as a share of Stereo: the lowest mode, then modes
 * 5, 9, 13… / 2, 6, 10… / 3, 7, 11… / 4, 8, 12… */
const PAN = [0, -0.5, -1, 1, 0.5];

// ---- control-rate maths. The reference's short polynomials, kept (rather than Math.sin / Math.pow) because they
// give the same bits in every JavaScript engine: a render in Node and one in a browser are the same note. They work
// on arrays: a number handed to a function, or handed back by one, can end up on the heap, and a note must not
// allocate while it sounds.
const POW2 = Float64Array.from({ length: 241 }, (_, i) => 2 ** (i - 120));
/** 2^a[k] for the first n numbers of an array, in place (relative error under 1e-8). */
function exp2s(a, n) {
  for (let k = 0; k < n; k++) {
    const v = a[k] < -120 ? -120 : a[k] > 120 ? 120 : a[k];
    const i = Math.floor(v + 0.5);
    const z = (v - i) * Math.LN2;
    a[k] = (1 + z * (1 + z * (0.5 + z * (1 / 6 + z * (1 / 24 + z * (1 / 120 + z * (1 / 720 + z * (1 / 5040)))))))) * POW2[i + 120];
  }
}
/** sin and cos of the first n angles of an array — each up to a little over a quarter turn, either way — into s and
 * c (error under 1e-9; s may be the array of angles itself). */
function sinCos(a, s, c, n) {
  for (let k = 0; k < n; k++) {
    const h = a[k];
    const h2 = h * h;
    s[k] = h * (1 + h2 * (-1 / 6 + h2 * (1 / 120 + h2 * (-1 / 5040 + h2 * (1 / 362880 + h2 * (-1 / 39916800 + h2 * (1 / 6227020800)))))));
    c[k] = 1 + h2 * (-0.5 + h2 * (1 / 24 + h2 * (-1 / 720 + h2 * (1 / 40320 + h2 * (-1 / 3628800 + h2 * (1 / 479001600 + h2 * (-1 / 87178291200)))))));
  }
}
// (one number at a time, for what is not the audio path)
const ONE = new Float64Array(1);
const exp2 = (x) => { ONE[0] = x; exp2s(ONE, 1); return ONE[0]; };
const SPARE = new Float64Array(1);
const sinPoly = (h) => { ONE[0] = h; sinCos(ONE, ONE, SPARE, 1); return ONE[0]; };

// ---- the objects: log2 of every mode's frequency ratio, for the five structures (the lowest mode is always 1)
/** A round drum head: the zeros of the Bessel functions, over the first. */
const MEMBRANE = [
  1.0, 1.5933, 2.1355, 2.2954, 2.6531, 2.9173, 3.1555, 3.5001, 3.5985, 3.6475, 4.0589, 4.1317, 4.2304, 4.601, 4.6101, 4.8319,
  4.9033, 5.0836, 5.1308, 5.4121, 5.5404, 5.5531, 5.6508, 5.9765, 6.0194, 6.1526, 6.1631, 6.2087, 6.4827, 6.5286, 6.669, 6.7462
];
/** A bar free at both ends: the roots of cos β · cosh β = 1, then (2k + 1) π / 2. The ratios are their squares. */
const BAR_ROOTS = [4.730040744862704, 7.853204624095838, 10.995607838001671, 14.137165491257464, 17.27875965739948];
const barBeta = (k) => (k < 5 ? BAR_ROOTS[k] : ((2 * (k + 1) + 1) * Math.PI) / 2);
/** A tubular bell: a free tube, f ∝ (2n+1)² / √(1 + α(2n+1)²) from n = 2 — fitted to measured chimes (modes 3, 4, 5
 * stand 2 : 3 : 4, which is where a chime's strike note comes from). */
const bellMode = (k) => { const m = 2 * (k + 2) + 1; return (m * m) / Math.sqrt(1 + 0.000918 * m * m); };
const ANCHORS = new Float64Array(5 * N);
for (let k = 0; k < N; k++) {
  const n = k + 1;
  ANCHORS[k] = Math.log2(n); // string: harmonic
  ANCHORS[N + k] = Math.log2(n * Math.sqrt((1 + 0.002 * n * n) / 1.002)); // stiff string: stretched, as on a piano
  ANCHORS[2 * N + k] = Math.log2((barBeta(k) / barBeta(0)) ** 2);
  ANCHORS[3 * N + k] = Math.log2(MEMBRANE[k]);
  ANCHORS[4 * N + k] = Math.log2(bellMode(k) / bellMode(0));
}

/** Where a structure and its morph stand on the reference's one knob: 0 string … 1 bell, a quarter per structure. */
const structureValue = (p) => clamp((Math.max(0, MODAL_STRUCTURES.indexOf(p.structure)) + p.morph) / 4, 0, 1);
/** log2 of mode k's ratio (k from 0): between two structures the ratios are blended as intervals, not as Hz. */
function structureLog2(structure, k) {
  const s = structure * 4;
  const seg = Math.min(Math.floor(s), 3);
  const from = ANCHORS[seg * N + k];
  return from + (ANCHORS[(seg + 1) * N + k] - from) * (s - seg);
}
/** How much mode k (from 1) is driven at a place along the object: |sin(k π position)|, zero at the mode's nodes. */
function positionWeight(k, position) {
  const h = k * position;
  let f = h - Math.floor(h);
  if (f > 0.5) f = 1 - f;
  return sinPoly(f * Math.PI);
}
/** Seconds for a mode to fall 60 dB: the Decay time, shorter the higher the mode and the more the Damping. */
const modeT60 = (decay, damping, log2r) => Math.max(decay * exp2(-2 * damping * log2r), 0.005);
/** The exciter's low-pass, in octaves above the lowest mode: opened by Brightness and by a harder strike. */
function exciterOctaves(exciter, brightness, velocity) {
  if (exciter === MALLET) return -0.5 + 6.5 * brightness + 2 * (velocity - 1);
  if (exciter === PLUCK) return 2.5 + 5 * brightness + (velocity - 1);
  if (exciter === NOISE) return 1 + 6 * brightness + (velocity - 1);
  return 1 + 5 * brightness;
}

/**
 * What the settings make, for the editor and for measurements: one { ratio, amp, t60 } per mode — its frequency over
 * the lowest mode's, its level right after a full-velocity strike (the loudest mode = 1; for the bow, the level it
 * settles at) and its seconds to fall 60 dB while the key is held. A note's own random detuning (Inharmonic) and the
 * fade of modes near the top of the audible range are not in it.
 */
export function modalSpectrum(params = {}) {
  const p = { ...Object.fromEntries(Modal.defs.map((d) => [d.key, d.default])), ...params };
  const structure = structureValue(p);
  const exciter = Math.max(0, MODAL_EXCITERS.indexOf(p.exciter));
  const position = clamp(p.position, 0.02, 0.98);
  const gamma = 2 * (1 - p.brightness) ** 2;
  const cutoff = exp2(exciterOctaves(exciter, p.brightness, 1));
  const out = [];
  for (let k = 0; k < clamp(Math.round(p.modes), 4, N); k++) {
    const l = structureLog2(structure, k);
    const ratio = exp2(l);
    const t60 = modeT60(p.decay, p.damping, l);
    const x = ratio / cutoff;
    let amp = (positionWeight(k + 1, position) * exp2(-gamma * l)) / (1 + x * x);
    if (exciter === BOW) amp *= Math.sqrt(t60);
    out.push({ ratio, amp, t60 });
  }
  const max = out.reduce((m, v) => Math.max(m, v.amp), 0);
  if (max > 0) for (const v of out) v.amp /= max;
  return out;
}

export class Modal extends SynthEngine {
  static type = 'modal';
  static label = 'Modal';
  static category = 'keys';
  static color = '#e0a45c';
  static description = 'Modal synthesis: each note is an object with up to 32 resonant modes — a string, a stiff string, a bar, a drum head or a tubular bell, or something in between — set ringing by a mallet, a pluck, a burst of noise or a bow. For marimbas, vibraphones, glockenspiels, bells and chimes, harps and struck strings, drums, wood and glass. Harder notes are brighter, as on the real thing; struck notes die away by themselves and the key release damps them (Damper). Per-note pitch curves work.';
  static defs = [
    choice('structure', 'Structure', MODAL_STRUCTURES, 'bar', { group: 'Resonator', description: 'What the object is, which sets how its overtones are spaced. string: harmonic (1, 2, 3…). stiff: a stiff string, overtones stretched a little sharp as on a piano. bar: a metal or wooden bar (1, 2.76, 5.4, 8.9…). membrane: a drum head, dense and unpitched-sounding (1, 1.59, 2.14, 2.3…). bell: a tubular bell or chime (1, 1.94, 3.16, 4.64…).' }),
    num('morph', 'Morph', 0, 1, 0, { group: 'Resonator', description: 'Slides the overtones toward the next structure in the list (string → stiff → bar → membrane → bell), for objects in between: 0.5 on bar is half-way to a drum head. It does nothing on bell, the last one.' }),
    num('modes', 'Modes', 4, N, 24, { group: 'Resonator', step: 1, description: 'How many resonant modes the object has. More is richer and more detailed, and costs more CPU; high notes use fewer by themselves (nothing above the audible range is made).' }),
    num('decay', 'Decay', 0.02, 30, 2, { group: 'Resonator', unit: 's', curve: 'log', description: 'How long the lowest mode rings after the strike (the time to fall 60 dB): 0.1 s is a wood block, 1–2 s a marimba, 5–10 s a vibraphone or a bell.' }),
    num('damping', 'Damping', 0, 1, 0.4, { group: 'Resonator', description: 'How much sooner the high modes die than the low ones: 0 lets them all ring equally long (glass, metal), 0.5 gives each the same number of swings, 1 damps the highs almost at once (wood, nylon, felt).' }),
    num('inharmonic', 'Inharmonic', 0, 1, 0, { group: 'Resonator', description: 'Detunes every mode but the lowest by its own fixed random amount, up to a semitone at 1: an imperfect, hand-made object. The note keeps its pitch; every note is detuned differently.' }),
    choice('exciter', 'Exciter', MODAL_EXCITERS, 'mallet', { group: 'Exciter', description: 'What sets the object ringing. mallet: one soft blow, harder and shorter with Brightness and velocity. pluck: a bright click with a little noise. noise: a 20–60 ms scrape or puff, different on every note. bow: steady noise for as long as the key is held, so the note sustains (its level is Drive).' }),
    num('brightness', 'Brightness', 0, 1, 0.5, { group: 'Exciter', description: 'Hardness of the exciter and level of the high modes: low is a soft felt mallet on a dull object, high a hard stick or a pick on a bright one. Velocity adds to it: harder notes are brighter.' }),
    num('position', 'Position', 0, 1, 0.28, { group: 'Exciter', description: 'Where the object is struck, plucked or bowed, from one end (0) to the other (1). The middle (0.5) removes every second mode for a hollow tone, a third of the way (0.33) every third; near the ends the tone is thin and bright.' }),
    num('drive', 'Drive', 0, 1, 0.5, { group: 'Exciter', description: 'For the bow: how hard it presses, which is the level a held note settles at. For noise: how much breath keeps blowing after the burst while the key is held — 0 leaves only the burst. Mallet and pluck ignore it.' }),
    num('spread', 'Stereo', 0, 1, 0.3, { group: 'Space', description: 'Stereo width: the modes are placed across the stereo field, left and right in turn, while the lowest mode stays in the middle. 0 is mono.' }),
    num('release', 'Damper', 0.01, 30, 0.5, { group: 'Amp', unit: 's', curve: 'log', description: 'How long the object still rings once the key is let go: a damper that stops every mode within this time. Set it as long as Decay (or longer) and the release does nothing: the note rings out by itself, like a bell.' }),
    num('level', 'Level', -36, 6, -6, { group: 'Amp', unit: 'dB', description: 'Output level of the instrument, before the channel fader. A full-velocity strike peaks about 6 dB above this value on the meter.' })
  ];

  static presets = {
    Marimba: { structure: 'bar', modes: 12, decay: 1.2, damping: 0.8, exciter: 'mallet', brightness: 0.35, position: 0.42, spread: 0.2, release: 1.5, level: -6 },
    Vibraphone: { structure: 'bar', modes: 16, decay: 6, damping: 0.3, exciter: 'mallet', brightness: 0.4, position: 0.45, spread: 0.5, release: 0.3, level: -6 },
    Glockenspiel: { structure: 'bar', modes: 12, decay: 2.5, damping: 0.2, exciter: 'mallet', brightness: 0.6, position: 0.3, spread: 0.4, release: 2.5, level: -6 },
    'Tubular Bell': { structure: 'bell', modes: 24, decay: 9, damping: 0.25, inharmonic: 0.05, exciter: 'mallet', brightness: 0.55, position: 0.12, spread: 0.5, release: 9, level: -6 },
    Kalimba: { structure: 'bar', modes: 8, decay: 1.6, damping: 0.6, inharmonic: 0.1, exciter: 'pluck', brightness: 0.3, position: 0.2, spread: 0.2, release: 1.6, level: -6 },
    Harp: { structure: 'string', modes: 32, decay: 4, damping: 0.45, exciter: 'pluck', brightness: 0.3, position: 0.35, spread: 0.3, release: 0.8, level: -6 },
    'Hammered Dulcimer': { structure: 'stiff', modes: 32, decay: 3, damping: 0.4, exciter: 'mallet', brightness: 0.55, position: 0.12, spread: 0.4, release: 1, level: -6 },
    'Steel Drum': { structure: 'string', morph: 0.5, modes: 10, decay: 1.2, damping: 0.35, inharmonic: 0.2, exciter: 'mallet', brightness: 0.6, position: 0.3, spread: 0.4, release: 1.2, level: -6 },
    Glass: { structure: 'bar', modes: 6, decay: 3.5, damping: 0.05, inharmonic: 0.15, exciter: 'mallet', brightness: 0.65, position: 0.22, spread: 0.6, release: 3.5, level: -6 },
    'Wood Block': { structure: 'bar', modes: 8, decay: 0.12, damping: 0.6, exciter: 'mallet', brightness: 0.6, position: 0.3, spread: 0.1, release: 0.12, level: -6 },
    'Frame Drum': { structure: 'membrane', modes: 20, decay: 0.7, damping: 0.6, exciter: 'mallet', brightness: 0.45, position: 0.3, spread: 0.2, release: 0.7, level: -6 },
    'Bowed Bars': { structure: 'bar', modes: 8, decay: 1.5, damping: 0.3, exciter: 'bow', brightness: 0.4, position: 0.3, drive: 0.7, spread: 0.5, release: 1.2, level: -6 },
    'Blown Pipe': { structure: 'string', modes: 12, decay: 0.12, damping: 0.3, exciter: 'noise', brightness: 0.35, position: 0.5, drive: 0.6, spread: 0.2, release: 0.2, level: -6 }
  };

  /** After the key is let go: the exciter's last 60 ms and its filter's tail, then 80 dB of the longest mode's decay. */
  static tail(params) {
    return 0.25 + 1.34 * Math.min(params?.decay ?? 2, params?.release ?? 0.5);
  }

  constructor(sampleRate, seed = 1) {
    super(sampleRate, seed);
    const fs = this.fs;
    // nothing above 0.45 of the sample rate (or 21.6 kHz): modes fade out over the last ninth below that limit
    this.limit = Math.min(0.9 * Math.PI, (TAU * MAX_MODE_HZ) / fs);
    this.invWidth = 9 / this.limit;
    // settings, pitch and levels are followed on a grid of 0.67 ms, and glide from one point to the next
    this.tick = clamp(Math.round((fs * 32) / 48000), 8, 256);
    this.tickLeft = 0;
    const mem = new Arena((25 * N + 30 + 7 * this.tick) * 8);
    this.deviation = mem.f64(N); // each mode's own detuning, ±1 (the lowest mode: none)
    this.log2r = mem.f64(N);
    this.ratio = mem.f64(N);
    // the resonators: a point turning on a shrinking circle (x, y), its turn per sample (e, gliding by de) and its
    // shrink per sample (r; d = 1 − r)
    this.x = mem.f64(N);
    this.y = mem.f64(N);
    this.e = mem.f64(N);
    this.de = mem.f64(N);
    this.eTarget = mem.f64(N);
    this.r = mem.f64(N);
    this.d = mem.f64(N);
    this.sqrtR = mem.f64(N);
    this.hs = mem.f64(N); // sin and cos of half the mode's angle per sample
    this.hc = mem.f64(N);
    this.fade = mem.f64(N);
    this.weight = mem.f64(N); // each mode's share of the output (they add up to 1)
    this.a = mem.f64(N); // …as it is applied: gliding by da to target
    this.da = mem.f64(N);
    this.target = mem.f64(N);
    // a second, bare set of resonators for the trial run of a strike
    this.sx = mem.f64(N);
    this.sy = mem.f64(N);
    this.se = mem.f64(N);
    this.sr = mem.f64(N);
    this.sa = mem.f64(N);
    this.tmp = mem.f64(N); // room to work in
    this.tmp2 = mem.f64(N);
    // left and right gain of the five stereo groups
    this.g = mem.f64(10);
    this.dg = mem.f64(10);
    this.gTarget = mem.f64(10);
    this.exc = mem.f64(this.tick); // the exciter's signal for one tick
    this.acc = mem.f64(5 * this.tick); // the five groups' sums, sample by sample
    this.sim = mem.f64(this.tick);
    this.hc.fill(1);
    this.d.fill(1);
    this.g.fill(1);
    this.gTarget.fill(1);
    // (xorshift, started from a scramble of the seed so that seeds 1, 2, 3 are unrelated notes)
    this.rand = (hash32(this.seed) || 0x1234567) | 0;
    for (let k = 1; k < N; k++) this.deviation[k] = this.noise();
    this.nLive = 0; // modes running at the start of the tick / during it / after it
    this.nAct = 0;
    this.nNext = 0;
    this.chirp = false;
    this.ampDirty = false;
    this.panMoving = false;
    this.hz = keyHz(60);
    this.velocity = 1;
    this.strike = false; // a blow is due at the next tick
    this.gate = 0;
    this.gateTarget = 0;
    this.cutoffRatio = 1;
    this.lp = 1;
    this.lpZ1 = 0;
    this.lpZ2 = 0;
    this.pulse = 0;
    this.burstLeft = 0;
    this.burstInvLen = 0;
    this.burstGain = 0;
    this.sustain = 0;
    this.dSustain = 0;
    this.sustainTarget = 0;
    this.noiseOn = false;
    this.exciterAwake = false;
    this.silent = true; // every resonator is at exactly zero
    this.power = 0;
    this.bowGain = 0;
    this.gainsValid = false;
    this.simPeak = 0;
    this.og = 0; // the Level knob as a gain, gliding too
    this.dog = 0;
    this.ogTarget = 0;
    this.snap = true;
    this.prevBend = 0;
    // (what a tick is told goes through fields, not arguments: see the note on numbers and the heap above)
    this.bendNow = 0;
    this.bendUsed = 0;
    this.bendRatio = 1;
    this.hzNow = this.hz;
    this.damper = 1e9;
    this.w0Used = -1;
    this.cutoffUsed = -1;
    // the settings the last tick used (NaN: none yet, so everything is worked out)
    this.lastStructure = NaN;
    this.lastInharmonic = NaN;
    this.lastDecay = NaN;
    this.lastDamping = NaN;
    this.lastDamper = NaN;
    this.lastBrightness = NaN;
    this.lastPosition = NaN;
    this.lastModes = -1;
    this.lastSpread = NaN;
    this.lastExciter = -1;
    this.started = false;
    this.released = false;
    this.top = 0; // the most that has rung in this note (a power)
    this.ending = false;
    this.done = false;
    this.update();
  }

  /** White noise in [−1, 1): the same seed gives the same note. */
  noise() {
    let s = this.rand;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rand = s;
    return s / 2147483648;
  }

  update() {
    const p = this.p;
    this.exciter = Math.max(0, MODAL_EXCITERS.indexOf(p.exciter));
    this.structure = structureValue(p);
    this.modes = clamp(Math.round(p.modes), 4, N);
    // (exactly at an end, no mode would be driven at all)
    this.position = clamp(p.position, 0.02, 0.98);
    this.outGain = dbToLin(p.level);
    this.cutoffRatio = exp2(exciterOctaves(this.exciter, p.brightness, this.velocity));
  }

  /**
   * The blow lands on the first sample of the next render. Resonators that still ring are not cleared: striking a
   * ringing object adds to what it is doing (and retunes it, without a step, if the key is another one).
   */
  noteOn(key, velocity, tune = 0) {
    this.hz = clamp(keyHz(key + tune / 100), 8, 25000) || keyHz(60);
    this.velocity = clamp(velocity, 0, 1) || 0;
    this.strike = true;
    this.gateTarget = 1;
    this.gate = 1;
    this.snap = true;
    this.interruptTick();
    this.started = true;
    this.released = false;
    this.top = 0;
    this.ending = false;
    this.done = false;
    this.update();
  }

  /** The key is let go: the bow lifts (a 5 ms fade) and the damper comes down — see `release`. Not in the reference,
   * where the host's envelope does the damping. */
  noteOff() {
    this.gateTarget = 0;
    this.released = true;
  }

  get finished() { return this.done; }

  /** A new tick starts at the next sample: what was gliding stays where it has got to, so nothing steps. */
  interruptTick() {
    if (this.tickLeft > 0 && this.tickLeft < this.tick) {
      const elapsed = this.tick - this.tickLeft;
      const n = this.nAct;
      if (this.ampDirty) for (let k = 0; k < n; k++) { this.a[k] += this.da[k] * elapsed; this.da[k] = 0; }
      if (this.chirp) {
        for (let k = 0; k < n; k++) {
          this.e[k] += this.de[k] * elapsed;
          this.de[k] = 0;
          // the half-angle the state stands for has to follow, for the retune the next tick may do
          if (this.sqrtR[k] > 0) {
            const hs = clamp((0.5 * this.e[k]) / this.sqrtR[k], 0, 0.999);
            this.hs[k] = hs;
            this.hc[k] = Math.sqrt(1 - hs * hs);
          }
        }
      }
      for (let k = 0; k < 10; k++) { this.g[k] += this.dg[k] * elapsed; this.dg[k] = 0; }
      this.sustain += this.dSustain * elapsed;
      this.dSustain = 0;
      this.og += this.dog * elapsed;
      this.dog = 0;
    }
    this.tickLeft = 0;
  }

  /** Once per tick: where every mode is heading — its turn and shrink per sample, its level, its place — from the
   * settings and the pitch (this.bendNow) at the end of the tick. Only what changed is worked out again. */
  control() {
    const p = this.p;
    const invTick = 1 / this.tick;
    const jump = this.snap;
    const modes = this.modes;
    const { x, y, e, de, a, da, ratio, tmp } = this;

    const ratioDirty = this.structure !== this.lastStructure || p.inharmonic !== this.lastInharmonic;
    if (ratioDirty) this.setRatios();
    if (this.bendNow !== this.bendUsed) {
      this.bendUsed = this.bendNow;
      tmp[0] = this.bendNow / 12;
      exp2s(tmp, 1);
      this.bendRatio = tmp[0];
    }
    let hz = this.hz * this.bendRatio;
    hz = hz < 8 ? 8 : hz > 25000 ? 25000 : hz;
    this.hzNow = hz;
    const w0 = (TAU * hz) / this.fs;
    const pitchDirty = ratioDirty || w0 !== this.w0Used;
    this.w0Used = w0;
    // the damper: once the key is up no mode rings longer than Release (not in the reference)
    this.damper = this.released ? p.release : 1e9;
    const decayDirty = ratioDirty || p.decay !== this.lastDecay || p.damping !== this.lastDamping || this.damper !== this.lastDamper;
    const weightDirty = ratioDirty || p.brightness !== this.lastBrightness || this.position !== this.lastPosition || modes !== this.lastModes;

    // the modes to run: those asked for that lie under the limit, and for this tick those that now fade out
    let nNext = this.nNext;
    if (pitchDirty || modes !== this.lastModes) {
      nNext = 0;
      for (let k = modes - 1; k >= 0; k--) if (w0 * ratio[k] < this.limit) { nNext = k + 1; break; }
    }
    const nLive = this.nLive;
    const nAct = nNext > nLive ? nNext : nLive;
    this.nNext = nNext;
    this.nAct = nAct;
    const grown = nNext > nLive;
    for (let k = nLive; k < nAct; k++) { x[k] = 0; y[k] = 0; a[k] = 0; }

    if (pitchDirty || grown) this.setAngles(jump);
    if (decayDirty || grown) this.setDecays();
    this.chirp = false;
    if (pitchDirty || decayDirty || grown) {
      let chirp = false;
      for (let k = 0; k < nAct; k++) {
        // the turn per sample that puts the poles exactly at r · e^(±jθ): the pitch is exact however low the note
        const eps = 2 * this.sqrtR[k] * this.hs[k];
        this.eTarget[k] = eps;
        if (jump || k >= nLive) {
          e[k] = eps;
          de[k] = 0;
        } else {
          de[k] = (eps - e[k]) * invTick;
          if (de[k] !== 0) chirp = true;
        }
      }
      this.chirp = chirp;
    }
    if (weightDirty) this.setWeights();
    this.ampDirty = weightDirty || pitchDirty || grown || nNext !== nLive;
    if (this.ampDirty) {
      // (with nothing ringing there is no sound to keep whole, and the first samples of a strike must not fade in)
      const snapAmps = this.silent;
      for (let k = 0; k < nAct; k++) {
        // (the resonator's output swings 1 / cos(θ/2) too far: taken out here, so every mode answers a blow alike)
        const t = k < nNext ? this.weight[k] * this.hc[k] * this.fade[k] : 0;
        this.target[k] = t;
        if (snapAmps) { a[k] = t; da[k] = 0; } else da[k] = (t - a[k]) * invTick;
      }
    }
    if (jump || p.spread !== this.lastSpread) this.setPan();
    // the Level knob, and the last tick of a note: a fade to nothing (not in the reference)
    this.ogTarget = this.ending ? 0 : this.outGain;
    if (this.silent) { this.og = this.ogTarget; this.dog = 0; } else this.dog = (this.ogTarget - this.og) * invTick;

    this.controlExciter(pitchDirty || decayDirty || weightDirty || grown || nNext !== nLive);
    this.lastStructure = this.structure;
    this.lastInharmonic = p.inharmonic;
    this.lastDecay = p.decay;
    this.lastDamping = p.damping;
    this.lastDamper = this.damper;
    this.lastBrightness = p.brightness;
    this.lastPosition = this.position;
    this.lastModes = modes;
    this.lastSpread = p.spread;
    this.lastExciter = this.exciter;
    this.snap = false;
  }

  /** Every mode's frequency over the lowest: the structure's, moved by the note's own detuning. */
  setRatios() {
    const { log2r, ratio, deviation } = this;
    const s = this.structure * 4;
    const seg = Math.min(Math.floor(s), 3);
    const t = s - seg;
    const spread = this.p.inharmonic / 12; // up to a semitone
    for (let k = 0; k < N; k++) {
      const from = ANCHORS[seg * N + k];
      log2r[k] = from + (ANCHORS[(seg + 1) * N + k] - from) * t + spread * deviation[k];
      ratio[k] = log2r[k];
    }
    exp2s(ratio, N);
  }

  /** The angle each running mode turns per sample (as sin and cos of its half), and its fade near the top. */
  setAngles(jump) {
    const { x, y, hs, hc, fade, ratio, tmp, tmp2 } = this;
    const n = this.nAct;
    const w0 = this.w0Used;
    const limit = this.limit;
    for (let k = 0; k < n; k++) {
      const theta = w0 * ratio[k] < limit ? w0 * ratio[k] : limit;
      const t = (limit - theta) * this.invWidth;
      fade[k] = t < 1 ? t * t * (3 - 2 * t) : 1;
      tmp[k] = 0.5 * theta;
      // a new note on a ringing object: the state is rewritten for the new frequency, so that the mode keeps its
      // level and its place in the swing (this is the part of the motion a quarter turn from y)
      if (jump) tmp2[k] = (x[k] - y[k] * hs[k]) / hc[k];
    }
    sinCos(tmp, hs, hc, n);
    if (jump) for (let k = 0; k < n; k++) x[k] = tmp2[k] * hc[k] + y[k] * hs[k];
  }

  /** How much each running mode shrinks per sample: 10^(−3 / (T60 · fs)), T60 = Decay · ratio^(−2 · Damping). */
  setDecays() {
    const { r, d, sqrtR, log2r, tmp } = this;
    const n = this.nAct;
    const decay = this.p.decay;
    const slope = -2 * this.p.damping;
    const damper = this.damper;
    const scale = LN_1000 / this.fs;
    for (let k = 0; k < n; k++) tmp[k] = slope * log2r[k];
    exp2s(tmp, n);
    for (let k = 0; k < n; k++) {
      let t60 = decay * tmp[k];
      if (t60 > damper) t60 = damper;
      if (t60 < 0.005) t60 = 0.005;
      // d = 1 − r, worked out so that a tiny d keeps its digits
      const z = scale / t60;
      const dk = z < 0.05 ? z * (1 - z * (0.5 - z * (1 / 6))) : -Math.expm1(-z);
      d[k] = dk;
      r[k] = 1 - dk;
      sqrtR[k] = Math.sqrt(1 - dk);
    }
  }

  /** A mode's share of the output: how much the striking point drives it — |sin(k π position)|, nothing at the
   * mode's nodes — and a tilt against the high modes that Brightness lifts. The shares add up to 1. */
  setWeights() {
    const { weight, log2r, tmp, tmp2 } = this;
    const modes = this.modes;
    const dark = 1 - this.p.brightness;
    const gamma = 2 * dark * dark;
    for (let k = 0; k < modes; k++) {
      weight[k] = -gamma * log2r[k];
      const h = (k + 1) * this.position;
      const f = h - Math.floor(h);
      tmp[k] = (f > 0.5 ? 1 - f : f) * Math.PI;
    }
    exp2s(weight, modes);
    sinCos(tmp, tmp, tmp2, modes);
    let sum = 0;
    for (let k = 0; k < modes; k++) {
      weight[k] *= tmp[k];
      sum += weight[k];
    }
    const norm = sum > 1e-20 ? 1 / sum : 0;
    for (let k = 0; k < modes; k++) weight[k] *= norm;
    for (let k = modes; k < N; k++) weight[k] = 0;
  }

  /** Where the five groups sit: constant power, and exactly 1 on both sides in the middle. */
  setPan() {
    const { g, dg, gTarget, tmp, tmp2 } = this;
    const invTick = 1 / this.tick;
    for (let q = 0; q < 5; q++) tmp[q] = PAN[q] * this.p.spread * (Math.PI / 4);
    sinCos(tmp, tmp, tmp2, 5);
    let moving = false;
    for (let q = 0; q < 5; q++) {
      gTarget[2 * q] = tmp2[q] - tmp[q];
      gTarget[2 * q + 1] = tmp2[q] + tmp[q];
    }
    for (let k = 0; k < 10; k++) {
      if (this.silent) { g[k] = gTarget[k]; dg[k] = 0; } else {
        dg[k] = (gTarget[k] - g[k]) * invTick;
        if (dg[k] !== 0) moving = true;
      }
    }
    this.panMoving = moving;
  }

  /** The exciter's part of a tick: its filter, the strike if one is due, and the level of the steady noise. */
  controlExciter(bankChanged) {
    const p = this.p;
    const fs = this.fs;
    const tmp = this.tmp;
    const strike = this.strike;
    this.strike = false;
    const exciter = this.exciter;
    // its low-pass follows the note: so many octaves above the lowest mode (see exciterOctaves)
    let cutoff = this.hzNow * this.cutoffRatio;
    cutoff = cutoff < 30 ? 30 : cutoff > 0.45 * fs ? 0.45 * fs : cutoff;
    const cutoffDirty = cutoff !== this.cutoffUsed;
    if (cutoffDirty) {
      this.cutoffUsed = cutoff;
      tmp[0] = (-TAU * Math.LOG2E * cutoff) / fs;
      exp2s(tmp, 1);
      this.lp = 1 - tmp[0];
    }
    if (bankChanged || cutoffDirty || exciter !== this.lastExciter) this.gainsValid = false;

    // the bow comes on with the note and lifts in 5 ms when the key is let go
    const step = this.tick / (0.005 * fs);
    const gap = this.gateTarget - this.gate;
    this.gate += gap < -step ? -step : gap > step ? step : gap;
    // (velocity is squared at the exciter, not at the output: a second blow must not rescale what already rings)
    const vel = this.velocity * this.velocity;
    const drive = exciter === BOW || exciter === NOISE ? p.drive * this.gate * vel : 0;

    if (strike || (drive > 0 && !this.gainsValid)) {
      this.gainsValid = true;
      // what one unit of impulse leaves in the output, the modes summed as powers — and the power that steady
      // noise of unit variance holds there (a mode that rings longer stores more)
      const a2 = this.lp * this.lp;
      const b = 1 - this.lp;
      let power = 0;
      let steady = 0;
      for (let k = 0; k < this.nNext; k++) {
        const eps0 = 2 * this.hs[k];
        const amp = (this.weight[k] * a2) / (a2 + b * eps0 * eps0);
        power += amp * amp;
        steady += (amp * amp) / (this.d[k] * (2 - this.d[k]));
      }
      this.power = power;
      this.bowGain = steady > 1e-30 ? Math.min(BOW_RMS / Math.sqrt(0.5 * NOISE_POWER * steady), MAX_EXCITER_GAIN) : 0;
      if (strike) this.hit(STRIKE_PEAK * vel);
    }
    this.sustainTarget = drive * this.bowGain;
    this.dSustain = (this.sustainTarget - this.sustain) / this.tick;
    this.noiseOn = this.burstLeft > 0 || this.sustain > 0 || this.sustainTarget > 0;
    if (this.noiseOn || this.pulse !== 0) this.exciterAwake = true;
  }

  /** The blow: an impulse (mallet, pluck) or a burst of noise, as strong as it takes to peak at this.simPeak's cost. */
  hit(vel) {
    const exciter = this.exciter;
    const rms = Math.sqrt(this.power);
    this.pulse = 0;
    let seconds = 0;
    let strength = 0;
    if (exciter === MALLET || exciter === PLUCK) {
      this.unitStrikePeak();
      // (the pluck's noise comes on top, and adds as a power)
      const peak = this.simPeak + (exciter === PLUCK ? 0.5 * PLUCK_NOISE * BURST_CREST * rms : 0);
      this.pulse = peak > 1e-9 ? Math.min(vel / peak, MAX_EXCITER_GAIN) : 0;
      if (exciter === PLUCK) { seconds = 0.003; strength = PLUCK_NOISE * this.pulse; }
    } else if (exciter === NOISE) {
      seconds = 0.06 - 0.04 * this.p.brightness;
      strength = rms > 1e-15 ? Math.min(vel / (BURST_CREST * rms), MAX_EXCITER_GAIN) : 0;
    }
    if (seconds > 0) {
      // a burst of noise that falls as t² (t from 1 to 0) is as strong as an impulse of g · √(σ² · length / 5)
      const len = Math.max(1, Math.floor(seconds * this.fs));
      this.burstLeft = len;
      this.burstInvLen = 1 / len;
      this.burstGain = strength / Math.sqrt(NOISE_POWER * len * 0.2);
    }
  }

  /**
   * How high one unit of impulse through the exciter's filter would peak with the modes as they are now (left in
   * this.simPeak) — found by running a bare copy of the resonators over the attack: the lowest mode's first period,
   * 4 ms at least. No formula does it: the peak depends on how the modes' first swings fall together (a drum head's
   * do, a bar's do not) and, for a soft mallet, on how the object is pushed by the blow itself. At most 1024 steps,
   * at 44–88 kHz whatever the sample rate: about what 20 ms of the note costs, once per strike. (Modes that are not
   * harmonic can drift back together later and pass this peak by a decibel or two.)
   */
  unitStrikePeak() {
    const n = this.nNext;
    this.simPeak = 0;
    if (n === 0) return;
    const { sx, sy, se, sr, sa, exc, sim, tmp } = this;
    const dec = Math.max(1, Math.min(32, Math.floor(this.fs / 44000)));
    const rate = this.fs / dec;
    const seconds = Math.max(1 / this.hzNow, 0.004) + 1 / (Math.PI * this.cutoffUsed);
    const steps = Math.max(8, Math.min(SIM_STEPS, Math.floor(seconds * rate)));
    for (let k = 0; k < n; k++) sx[k] = 0.5 * Math.min(this.w0Used * this.ratio[k] * dec, 0.9 * Math.PI);
    sinCos(sx, se, sa, n);
    for (let k = 0; k < n; k++) {
      const rk = dec === 1 ? this.r[k] : Math.pow(this.r[k], dec);
      sx[k] = 0;
      sy[k] = 0;
      sr[k] = rk;
      se[k] *= 2 * Math.sqrt(rk);
      sa[k] *= this.weight[k] * this.fade[k];
    }
    tmp[0] = (-TAU * Math.LOG2E * Math.min(this.cutoffUsed, 0.45 * rate)) / rate;
    exp2s(tmp, 1);
    const lp = 1 - tmp[0];
    let z1 = 0;
    let z2 = 0;
    let u = 1;
    let peak = 0;
    for (let done = 0; done < steps;) {
      const len = Math.min(steps - done, this.tick);
      for (let i = 0; i < len; i++) {
        z1 += lp * (u - z1);
        z2 += lp * (z1 - z2);
        u = 0;
        exc[i] = z2;
        sim[i] = 0;
      }
      for (let k = 0; k < n; k++) {
        let xk = sx[k];
        let yk = sy[k];
        const ek = se[k];
        const rk = sr[k];
        const ak = sa[k];
        for (let i = 0; i < len; i++) {
          xk = rk * xk - ek * yk + exc[i];
          yk = rk * yk + ek * xk;
          sim[i] += ak * yk;
        }
        sx[k] = xk;
        sy[k] = yk;
      }
      for (let i = 0; i < len; i++) {
        const v = sim[i] < 0 ? -sim[i] : sim[i];
        if (v > peak) peak = v;
      }
      done += len;
    }
    this.simPeak = peak;
  }

  /** The end of a tick: every glide lands on its target, modes that faded out are retired, numbers too small to be
   * sound are cleared — and the note is told over once it has rung out. */
  endTick() {
    const n = this.nAct;
    const { x, y, a, hs, hc } = this;
    if (this.ampDirty) for (let k = 0; k < n; k++) { a[k] = this.target[k]; this.da[k] = 0; }
    if (this.chirp) for (let k = 0; k < n; k++) { this.e[k] = this.eTarget[k]; this.de[k] = 0; }
    for (let k = this.nNext; k < n; k++) {
      x[k] = 0;
      y[k] = 0;
      this.e[k] = 0;
      this.de[k] = 0;
      this.r[k] = 0;
      a[k] = 0;
      this.da[k] = 0;
    }
    this.nLive = this.nNext;
    for (let k = 0; k < 10; k++) { this.g[k] = this.gTarget[k]; this.dg[k] = 0; }
    this.panMoving = false;
    this.og = this.ogTarget;
    this.dog = 0;

    let energy = 0;
    let ring = 0;
    for (let k = 0; k < this.nLive; k++) {
      // (also what makes a NaN from anywhere a silence instead of a note that is broken for good)
      if (!(x[k] > 1e-20 || x[k] < -1e-20)) x[k] = 0;
      if (!(y[k] > 1e-20 || y[k] < -1e-20)) y[k] = 0;
      energy += (x[k] < 0 ? -x[k] : x[k]) + (y[k] < 0 ? -y[k] : y[k]);
      // the mode's level as it is heard, whatever the place in its swing
      const u = (x[k] - y[k] * hs[k]) / hc[k];
      ring += a[k] * a[k] * (y[k] * y[k] + u * u);
    }
    this.silent = energy === 0;

    this.sustain = this.sustainTarget;
    this.dSustain = 0;
    if (this.exciterAwake && this.pulse === 0 && this.burstLeft === 0 && this.sustain === 0
      && !(this.lpZ1 > EXCITER_REST || this.lpZ1 < -EXCITER_REST) && !(this.lpZ2 > EXCITER_REST || this.lpZ2 < -EXCITER_REST)) {
      this.exciterAwake = false;
      this.lpZ1 = 0;
      this.lpZ2 = 0;
    }

    // over: nothing excites it any more and what rings is 80 dB under the most it has rung. One more tick fades that
    // remainder out, so the note ends at zero and not on a step.
    if (ring > this.top) this.top = ring;
    if (this.ending) this.done = true;
    else if (!this.exciterAwake && !this.strike && ring <= SILENCE * this.top) this.ending = true;
  }

  /** The exciter's signal for a stretch of the tick: the blow and the noise, through two one-pole low-passes — a
   * single impulse comes out as a smooth push, t · e^(−t/τ), the shorter the brighter. */
  excite(offset, n) {
    const exc = this.exc;
    const lp = this.lp;
    let z1 = this.lpZ1;
    let z2 = this.lpZ2;
    let u = this.pulse;
    this.pulse = 0;
    if (this.noiseOn) {
      const sustain = this.sustain;
      const dSustain = this.dSustain;
      const invLen = this.burstInvLen;
      const burstGain = this.burstGain;
      let left = this.burstLeft;
      let s = this.rand;
      for (let i = 0; i < n; i++) {
        let level = sustain + dSustain * (offset + i);
        if (left > 0) {
          const t = left * invLen;
          level += burstGain * t * t;
          left--;
        }
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        u += (s / 2147483648) * level;
        z1 += lp * (u - z1);
        z2 += lp * (z1 - z2);
        exc[i] = z2;
        u = 0;
      }
      this.burstLeft = left;
      this.rand = s;
    } else {
      for (let i = 0; i < n; i++) {
        z1 += lp * (u - z1);
        z2 += lp * (z1 - z2);
        exc[i] = z2;
        u = 0;
      }
    }
    this.lpZ1 = z1;
    this.lpZ2 = z2;
  }

  /** n samples from `offset` samples into the tick, written to L and R from `at`. */
  process(offset, L, R, at, n) {
    if (this.silent && !this.exciterAwake) { L.fill(0, at, at + n); R.fill(0, at, at + n); return; }
    const driven = this.exciterAwake;
    if (driven) this.excite(offset, n);
    const nAct = this.nAct;
    if (nAct === 0) { L.fill(0, at, at + n); R.fill(0, at, at + n); return; }
    const { x, y, e, de, r, a, da, exc, acc } = this;
    acc.fill(0, 0, 5 * n);
    const gliding = this.chirp || this.ampDirty;
    if (gliding && !driven) exc.fill(0, 0, n);
    // Four modes at a time: each resonator's next sample waits for its last, so one alone leaves the processor idle
    // most of the time — four side by side cost little more than one. (Slots past the last mode hold zeros.)
    for (let k = 0; k < nAct; k += 4) {
      let x0 = x[k];
      let x1 = x[k + 1];
      let x2 = x[k + 2];
      let x3 = x[k + 3];
      let y0 = y[k];
      let y1 = y[k + 1];
      let y2 = y[k + 2];
      let y3 = y[k + 3];
      const r0 = r[k];
      const r1 = r[k + 1];
      const r2 = r[k + 2];
      const r3 = r[k + 3];
      const e0 = e[k];
      const e1 = e[k + 1];
      const e2 = e[k + 2];
      const e3 = e[k + 3];
      const a0 = a[k];
      const a1 = a[k + 1];
      const a2 = a[k + 2];
      const a3 = a[k + 3];
      // the lowest mode has a group to itself (it stays in the middle); the others take the four sides in turn
      let j = k === 0 ? 0 : 1;
      const j1 = k === 0 ? 2 : 1;
      if (gliding) {
        // the pitch or the levels are moving: the turn per sample and the weights glide too
        const de0 = de[k];
        const de1 = de[k + 1];
        const de2 = de[k + 2];
        const de3 = de[k + 3];
        const da0 = da[k];
        const da1 = da[k + 1];
        const da2 = da[k + 2];
        const da3 = da[k + 3];
        for (let i = 0; i < n; i++, j += 5) {
          const fi = offset + i;
          const u = exc[i];
          const c0 = e0 + de0 * (fi + 1);
          const c1 = e1 + de1 * (fi + 1);
          const c2 = e2 + de2 * (fi + 1);
          const c3 = e3 + de3 * (fi + 1);
          x0 = r0 * x0 - c0 * y0 + u;
          x1 = r1 * x1 - c1 * y1 + u;
          x2 = r2 * x2 - c2 * y2 + u;
          x3 = r3 * x3 - c3 * y3 + u;
          y0 = r0 * y0 + c0 * x0;
          y1 = r1 * y1 + c1 * x1;
          y2 = r2 * y2 + c2 * x2;
          y3 = r3 * y3 + c3 * x3;
          acc[j] += (a0 + da0 * fi) * y0;
          acc[j + j1] += (a1 + da1 * fi) * y1;
          acc[j + j1 + 1] += (a2 + da2 * fi) * y2;
          acc[j + j1 + 2] += (a3 + da3 * fi) * y3;
        }
      } else if (driven) {
        for (let i = 0; i < n; i++, j += 5) {
          const u = exc[i];
          x0 = r0 * x0 - e0 * y0 + u;
          x1 = r1 * x1 - e1 * y1 + u;
          x2 = r2 * x2 - e2 * y2 + u;
          x3 = r3 * x3 - e3 * y3 + u;
          y0 = r0 * y0 + e0 * x0;
          y1 = r1 * y1 + e1 * x1;
          y2 = r2 * y2 + e2 * x2;
          y3 = r3 * y3 + e3 * x3;
          acc[j] += a0 * y0;
          acc[j + j1] += a1 * y1;
          acc[j + j1 + 1] += a2 * y2;
          acc[j + j1 + 2] += a3 * y3;
        }
      } else {
        // most of a struck note's life: nothing drives it, it only rings
        for (let i = 0; i < n; i++, j += 5) {
          x0 = r0 * x0 - e0 * y0;
          x1 = r1 * x1 - e1 * y1;
          x2 = r2 * x2 - e2 * y2;
          x3 = r3 * x3 - e3 * y3;
          y0 = r0 * y0 + e0 * x0;
          y1 = r1 * y1 + e1 * x1;
          y2 = r2 * y2 + e2 * x2;
          y3 = r3 * y3 + e3 * x3;
          acc[j] += a0 * y0;
          acc[j + j1] += a1 * y1;
          acc[j + j1 + 1] += a2 * y2;
          acc[j + j1 + 2] += a3 * y3;
        }
      }
      x[k] = x0;
      x[k + 1] = x1;
      x[k + 2] = x2;
      x[k + 3] = x3;
      y[k] = y0;
      y[k + 1] = y1;
      y[k + 2] = y2;
      y[k + 3] = y3;
    }
    const g = this.g;
    const og = this.og;
    const dog = this.dog;
    if (this.panMoving) {
      const dg = this.dg;
      for (let i = 0, j = 0; i < n; i++, j += 5) {
        const fi = offset + i;
        const gain = og + dog * fi;
        L[at + i] = (acc[j] * (g[0] + dg[0] * fi) + acc[j + 1] * (g[2] + dg[2] * fi) + acc[j + 2] * (g[4] + dg[4] * fi) + acc[j + 3] * (g[6] + dg[6] * fi) + acc[j + 4] * (g[8] + dg[8] * fi)) * gain;
        R[at + i] = (acc[j] * (g[1] + dg[1] * fi) + acc[j + 1] * (g[3] + dg[3] * fi) + acc[j + 2] * (g[5] + dg[5] * fi) + acc[j + 3] * (g[7] + dg[7] * fi) + acc[j + 4] * (g[9] + dg[9] * fi)) * gain;
      }
    } else {
      const l0 = g[0];
      const l1 = g[2];
      const l2 = g[4];
      const l3 = g[6];
      const l4 = g[8];
      const r0 = g[1];
      const r1 = g[3];
      const r2 = g[5];
      const r3 = g[7];
      const r4 = g[9];
      for (let i = 0, j = 0; i < n; i++, j += 5) {
        const gain = og + dog * (offset + i);
        L[at + i] = (acc[j] * l0 + acc[j + 1] * l1 + acc[j + 2] * l2 + acc[j + 3] * l3 + acc[j + 4] * l4) * gain;
        R[at + i] = (acc[j] * r0 + acc[j + 1] * r1 + acc[j + 2] * r2 + acc[j + 3] * r3 + acc[j + 4] * r4) * gain;
      }
    }
  }

  render(L, R, n, bend = 0) {
    if (!this.started || this.done) { L.fill(0, 0, n); R.fill(0, 0, n); return; }
    // (a bend from anywhere: not a number is no bend, and ten octaves is far enough)
    bend = bend > -120 && bend < 120 ? +bend : 0;
    // the bend is where the pitch should be at the end of this block: it glides there from where the last block
    // left it, tick by tick (and inside a tick sample by sample), so a bend never steps
    const from = this.snap ? bend : this.prevBend;
    let done = 0;
    while (done < n) {
      if (this.tickLeft === 0) {
        const t = Math.min(1, (done + this.tick) / n);
        this.bendNow = from + (bend - from) * t;
        this.control();
        this.tickLeft = this.tick;
      }
      const m = Math.min(n - done, this.tickLeft);
      this.process(this.tick - this.tickLeft, L, R, done, m);
      this.tickLeft -= m;
      done += m;
      if (this.tickLeft === 0) {
        this.endTick();
        if (this.done) { L.fill(0, done, n); R.fill(0, done, n); break; }
      }
    }
    this.prevBend = bend;
  }
}
