// Parameter schema of the GGS Synth. One flat list — the same shape as every other instrument's params — so the
// studio's generic machinery (validation, undo, live sync, MCP, presets) works unchanged. Keys are grouped by a
// prefix (oscA…, f1…, env2…, lfo3…, mod7…); `section` and `group` tell editors how to lay them out.
import { WAVETABLE_IDS } from './wavetables.js';
import { FILTER_TYPES, filterIsNonlinear } from './filters.js';
import { CHAOS_TYPES } from './chaos.js';
import { MAX_UNISON, UNISON_LAWS, UNISON_STACKS } from './unison.js';

export { FILTER_TYPES, CHAOS_TYPES };

const n = (key, label, min, max, def, extra = {}) => ({ key, label, type: 'number', min, max, default: def, ...extra });
const sel = (key, label, options, def, extra = {}) => ({ key, label, type: 'select', options, default: def, ...extra });
const bool = (key, label, def, extra = {}) => ({ key, label, type: 'bool', default: def, ...extra });

export const OSC_IDS = ['A', 'B', 'C'];
export const WARP_MODES = ['off', 'bend', 'pwm', 'sync', 'mirror', 'fold', 'quantize'];
export const FM_SOURCES = ['off', 'A', 'B', 'C', 'sub', 'noise'];
export const SOURCE_DESTS = ['f1', 'f2', 'both', 'direct'];
export const FILTER_ROUTES = ['serial', 'parallel'];
export const SUB_WAVES = ['sine', 'triangle', 'saw', 'square'];
export const NOISE_TYPES = ['white', 'pink', 'brown'];
export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'ramp', 'square', 'sh', 'smooth', 'steps'];
/** The most steps a drawn LFO shape (shape "steps") can have. */
export const LFO_STEPS = 16;
export const LFO_SYNC = ['off', '8bar', '4bar', '2bar', '1bar', '1/2', '1/4', '1/8', '1/16', '1/32', '1/2t', '1/4t', '1/8t', '1/16t', '1/4d', '1/8d', '1/16d'];
export const LFO_TRIGGERS = ['note', 'free'];
export const DRIVE_TYPES = ['soft', 'hard', 'tube', 'fold'];
export const DELAY_SYNC = ['free', '1/32', '1/16', '1/16d', '1/8t', '1/8', '1/8d', '1/4t', '1/4', '1/4d', '1/2'];
export const QUALITIES = ['eco', 'auto', 'high'];
export const ENV_COUNT = 4;
export const LFO_COUNT = 4;
export const MACRO_COUNT = 8;
export const MOD_SLOTS = 64;
export const CHAOS_COUNT = 2;
/** Where a chaos source starts: "note" = every note wanders its own way; "same" = every note replays one path. */
export const CHAOS_PATHS = ['note', 'same'];

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
 * A drawn LFO shape (shape "steps") at phase x = 0..1: each of the `count` steps is held, and glides into the next
 * over the last `smooth` of its length (0 = a step sequencer, 1 = a curve through the steps).
 */
export function stepShape(steps, count, smooth, x) {
  const sx = x * count;
  const k = Math.min(count - 1, sx | 0);
  const v = steps[k];
  const glide = sx - k - (1 - smooth);
  if (glide <= 0) return v;
  const u = glide / smooth;
  return v + (steps[(k + 1) % count] - v) * u * u * (3 - 2 * u);
}

/**
 * Envelope stage shapes. A stage curve c (-1..1) bends a stage: 0 is a straight line, negative moves fastest at the
 * start (the natural shape of a decay, and a punchy attack), positive holds back and then rushes. The exponent grows
 * with c·|c|, so there is fine control near the straight line and room for very sharp plucks at the ends.
 */
export const ENV_CURVE_SCALE = 18.4;
export const envCurveK = (c) => -ENV_CURVE_SCALE * c * Math.abs(c);
/** Progress 0..1 of a stage at x = 0..1 for exponent k: (1 − e^{−kx}) / (1 − e^{−k}); a straight line at k = 0. */
export function envShape(x, k) {
  if (k < 1e-4 && k > -1e-4) return x;
  return (1 - Math.exp(-k * x)) / (1 - Math.exp(-k));
}

/**
 * Level of an envelope `t` seconds into a note whose key is let go after `held` seconds — the same shapes the voices
 * render, as one formula (the editor draws with it, the tests hold the engine to it).
 * env: { delay, attack, hold, decay, sustain, release, attackCurve, decayCurve, releaseCurve }.
 */
export function envelopeAt(env, t, held = Infinity) {
  const down = (time) => {
    let x = time - env.delay;
    if (x < 0) return 0;
    if (x < env.attack) return envShape(x / env.attack, envCurveK(env.attackCurve));
    x -= env.attack;
    if (x < env.hold) return 1;
    x -= env.hold;
    if (x < env.decay) return env.sustain + (1 - env.sustain) * (1 - envShape(x / env.decay, envCurveK(env.decayCurve)));
    return env.sustain;
  };
  if (t < held) return down(t);
  const x = (t - held) / env.release;
  return x >= 1 ? 0 : down(held) * (1 - envShape(x, envCurveK(env.releaseCurve)));
}

/**
 * Patches made before the envelopes had a curve per stage carried one "Curve" (-1..1) for the whole envelope. This
 * gives such a patch the three stage curves that draw exactly the same envelope, and drops the old key.
 */
export function migrateParams(params) {
  if (!params || typeof params !== 'object') return params;
  let out = params;
  for (let i = 1; i <= ENV_COUNT; i++) {
    const old = params[`env${i}Curve`];
    if (old === undefined) continue;
    if (out === params) out = { ...params };
    delete out[`env${i}Curve`];
    if (typeof old !== 'number' || !Number.isFinite(old)) continue;
    const c = old < -1 ? -1 : old > 1 ? 1 : old;
    const attack = -Math.sqrt((1.5 * Math.pow(3, c)) / ENV_CURVE_SCALE);
    const fall = -Math.sqrt((4.6 * Math.pow(4, c)) / ENV_CURVE_SCALE);
    if (out[`env${i}ACurve`] === undefined) out[`env${i}ACurve`] = attack;
    if (out[`env${i}DCurve`] === undefined) out[`env${i}DCurve`] = fall;
    if (out[`env${i}RCurve`] === undefined) out[`env${i}RCurve`] = fall;
  }
  return out;
}

/**
 * Modulation sources. Envelopes, velocity, pressure, timbre and the macros run 0..1; LFOs, chaos, random, key and
 * bend are bipolar (-1..1). All of them are per note except the macros and LFOs set to "free" (shared by every note).
 * (The voice addresses the env, lfo, macro and chaos groups by index: keep each group together and in order.)
 */
export const MOD_SOURCES = [
  'none', 'env1', 'env2', 'env3', 'env4', 'lfo1', 'lfo2', 'lfo3', 'lfo4',
  'velocity', 'pressure', 'timbre', 'bend', 'key', 'random', 'releaseVel',
  'macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8', 'chaos1', 'chaos2'
];
export const MOD_SOURCE_INFO = {
  none: 'nothing',
  env1: 'envelope 1 (the amp envelope), 0..1', env2: 'envelope 2, 0..1', env3: 'envelope 3, 0..1', env4: 'envelope 4, 0..1',
  lfo1: 'LFO 1, -1..1', lfo2: 'LFO 2, -1..1', lfo3: 'LFO 3, -1..1', lfo4: 'LFO 4, -1..1',
  velocity: 'note velocity, 0..1', pressure: "the note's pressure curve, 0..1", timbre: "the note's slide/timbre curve, 0..1",
  bend: "the note's pitch curve in octaves (-1..1 = ±12 semitones)", key: 'keyboard position, -1..1 around C4 (±5 octaves)',
  random: 'a random value per note, -1..1', releaseVel: 'release velocity, 0 until the note is let go',
  ...Object.fromEntries(Array.from({ length: MACRO_COUNT }, (_, i) => [`macro${i + 1}`, `macro ${i + 1}, 0..1`])),
  chaos1: 'chaos generator 1 (Lorenz, Rössler, drift or Turing machine), -1..1', chaos2: 'chaos generator 2, -1..1'
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
  f1Morph: 'filter 1 morph (shape / vowel / stages / damping, by filter type)', f2Morph: 'filter 2 morph',
  lfo1Rate: 'LFO 1 rate, 1 = ×16', lfo2Rate: 'LFO 2 rate, 1 = ×16', lfo3Rate: 'LFO 3 rate, 1 = ×16', lfo4Rate: 'LFO 4 rate, 1 = ×16'
};
export const MOD_TARGETS = Object.keys(MOD_TARGET_INFO);

function oscParams(x, on, level) {
  const g = `Oscillator ${x}`;
  const s = { section: `osc${x}`, group: g };
  const d = (desc) => ({ ...s, desc });
  return [
    bool(`osc${x}On`, 'On', on, d(`Switches oscillator ${x} on. An oscillator that is off costs no CPU.`)),
    sel(`osc${x}Table`, 'Wavetable', WAVETABLE_IDS, 'basic', d('The wavetable this oscillator reads: a row of single-cycle waves that Position scans through.')),
    n(`osc${x}Pos`, 'Position', 0, 1, 0.5, d('Where in the wavetable the oscillator reads, 0 = first frame, 1 = last; in-between positions blend neighbouring frames. The classic target for an envelope, an LFO or slide.')),
    n(`osc${x}Level`, 'Level', 0, 1, level, d('Volume of this oscillator going into the filters.')),
    n(`osc${x}Pan`, 'Pan', -1, 1, 0, d('Stereo position of this oscillator, -1 = left, 1 = right.')),
    n(`osc${x}Oct`, 'Octave', -4, 4, 0, { step: 1, ...d('Transposes the oscillator in octaves.') }),
    n(`osc${x}Semi`, 'Semi', -12, 12, 0, { step: 1, ...d('Transposes the oscillator in semitones (7 = a fifth up).') }),
    n(`osc${x}Fine`, 'Fine', -100, 100, 0, { unit: 'ct', ...d('Fine tuning in cents. A few cents against another oscillator gives slow beating.') }),
    n(`osc${x}Unison`, 'Unison', 1, MAX_UNISON, 1, { step: 1, ...d('Number of stacked copies of the oscillator (1 = a single voice, up to 16). More copies = wider and thicker, and more CPU.') }),
    n(`osc${x}Detune`, 'Detune', 0, 100, 20, { unit: 'ct', ...d('How far the unison copies are spread in pitch. 10–25 ct is a supersaw; above 50 it turns into a cluster.') }),
    n(`osc${x}Blend`, 'Blend', 0, 1, 0.75, d('Level of the detuned outer unison copies against the centre ones: lower keeps the pitch firm, 1 is the full wall.')),
    n(`osc${x}Spread`, 'Stereo', 0, 1, 0.7, d('How far the unison copies are spread across the stereo field.')),
    sel(`osc${x}UniLaw`, 'Uni law', UNISON_LAWS, 'linear', d('How the unison copies are spaced in pitch. linear: evenly (the classic). super: the spacing and the knob curve of the JP-8000 supersaw — Detune is gentle over most of its travel and runs away at the end, so 40–60 ct is the trance lead. exp: the copies crowd round the centre with a few far out (a firm pitch with a wide halo). random: an uneven spacing, the same for every note.')),
    sel(`osc${x}Stack`, 'Stack', UNISON_STACKS, 'off', d('Tunes some of the unison copies to other notes: going outwards from the centre, every second pair plays an octave up (octave), a fifth up (fifth), or a fifth and an octave in turn — an organ-like stack from one oscillator. Needs Unison at 2 or more; the centre copies keep the note.')),
    n(`osc${x}UniPos`, 'Uni table', 0, 1, 0, d('Spreads the unison copies across the wavetable: each reads its own position around the Position knob, up to half the table either side at 1. On a table that changes along its length the stack becomes a blend of its timbres, left to right. Does nothing with Unison at 1.')),
    n(`osc${x}Phase`, 'Phase', 0, 1, 0, d('Where in its cycle the oscillator starts each note.')),
    n(`osc${x}Rand`, 'Phase rand', 0, 1, 1, d('How much the start phase is randomised per note: 1 = free-running feel, 0 = every note starts identically (tight basses, kicks).')),
    sel(`osc${x}Warp`, 'Warp', WARP_MODES, 'off', d('Reshapes the wave as it is read: bend leans it, pwm changes the pulse width, sync restarts it early (the hard-sync sweep), mirror plays it forward-backward, fold wraps it over itself, quantize steps it (lo-fi).')),
    n(`osc${x}WarpAmt`, 'Warp amt', 0, 1, 0, d('How strongly the warp mode is applied. Modulate it for movement.')),
    sel(`osc${x}FmFrom`, 'FM from', FM_SOURCES, 'off', d(`Which source bends this oscillator's phase (FM): another oscillator, the sub, the noise, or itself (feedback).`)),
    n(`osc${x}Fm`, 'FM amt', 0, 1, 0, d('Depth of the phase modulation: bells and electric pianos at low amounts, metallic and harsh higher up.')),
    sel(`osc${x}Dest`, 'To', SOURCE_DESTS, 'f1', d('Where the oscillator goes: filter 1, filter 2, both, or straight to the output (direct).'))
  ];
}

function filterParams(i, on) {
  const s = { section: 'filter', group: `Filter ${i}` };
  const d = (desc) => ({ ...s, desc });
  return [
    bool(`f${i}On`, 'On', on, d(`Switches filter ${i} on. Off = the signal passes untouched.`)),
    sel(`f${i}Type`, 'Type', FILTER_TYPES, 'lp24', d('The filter model: clean low/high/band-pass, notch, peak, all-pass and morph; analog-style ladder, acid (diode) and MS-20; formant (vowels), phaser and two combs. describe_synth lists what each sounds like.')),
    n(`f${i}Cutoff`, 'Cutoff', 20, 20000, 20000, { unit: 'Hz', curve: 'log', ...d('The frequency the filter works at: where a low-pass starts to close, the pitch of a comb, the size of the throat for the formant filter (1000 Hz = natural).') }),
    n(`f${i}Res`, 'Resonance', 0, 1, 0.1, d('Emphasis at the cutoff. Ladder and MS-20 self-oscillate near the top; for a comb it is the feedback (ring time), for the formant filter how narrow the vowels are.')),
    n(`f${i}Drive`, 'Drive', 0, 1, 0, d('Saturation in the filter: grit and thickness without a jump in volume. 0 is completely clean.')),
    n(`f${i}Key`, 'Key track', 0, 1, 0, d('How much the cutoff follows the note: 0 = fixed, 1 = moves a full octave per octave (needed for combs and for a self-oscillating filter played as a pitch).')),
    n(`f${i}Morph`, 'Morph', 0, 1, 0, d('A second control whose job depends on the type: shape for morph (low → band → high-pass), vowel for formant (A E I O U), number of stages for the phaser, damping for the combs. Unused by the other types.'))
  ];
}

function envParams(i, a, dec, sus, r) {
  const s = { section: 'env', group: i === 1 ? 'Envelope 1 (amp)' : `Envelope ${i}` };
  const d = (desc) => ({ ...s, desc });
  const role = i === 1 ? 'Envelope 1 is the amp envelope: it always shapes the volume of the note.' : `Envelope ${i} does nothing until it is routed in the matrix.`;
  return [
    n(`env${i}Delay`, 'Delay', 0, 5, 0, { unit: 's', curve: 'cube', ...d(`Time the envelope waits at zero before its attack starts. ${role}`) }),
    n(`env${i}A`, 'Attack', 0.001, 10, a, { unit: 's', curve: 'log', ...d('Time to rise from zero to full.') }),
    n(`env${i}Hold`, 'Hold', 0, 5, 0, { unit: 's', curve: 'cube', ...d('Time the envelope stays at full before the decay starts: keeps the body of a pluck or a kick.') }),
    n(`env${i}D`, 'Decay', 0.005, 10, dec, { unit: 's', curve: 'log', ...d('Time to fall from full to the sustain level.') }),
    n(`env${i}S`, 'Sustain', 0, 1, sus, d('Level held while the key stays down. 0 = a pluck that dies away by itself.')),
    n(`env${i}R`, 'Release', 0.005, 15, r, { unit: 's', curve: 'log', ...d('Time to fall to zero after the key is let go.') }),
    n(`env${i}ACurve`, 'Attack curve', -1, 1, -0.3, d('Shape of the attack: 0 = straight line, negative = fast at first then easing in (punchy), positive = slow start that rushes at the end (swells, reversed feel).')),
    n(`env${i}DCurve`, 'Decay curve', -1, 1, -0.5, d('Shape of the decay: negative = drops quickly then settles (natural, plucky; -1 is very sharp), 0 = straight line, positive = holds on and then falls away.')),
    n(`env${i}RCurve`, 'Release curve', -1, 1, -0.5, d('Shape of the release, like the decay curve: negative = natural exponential tail, positive = lingers and then cuts.'))
  ];
}

function lfoParams(i) {
  const s = { section: 'lfo', group: `LFO ${i}` };
  const d = (desc) => ({ ...s, desc });
  return [
    sel(`lfo${i}Shape`, 'Shape', LFO_SHAPES, 'sine', d('Waveform of the LFO: sine, triangle, saw (falling), ramp (rising), square, sh (a new random step each cycle), smooth (random, glided) or steps (a shape you draw: up to 16 steps per cycle, hard or glided).')),
    n(`lfo${i}Rate`, 'Rate', 0.01, 50, i === 1 ? 5 : 1, { unit: 'Hz', curve: 'log', ...d('Speed in cycles per second (used when Sync is off).') }),
    sel(`lfo${i}Sync`, 'Sync', LFO_SYNC, 'off', d('Locks the speed to the tempo: one cycle per bar, per quarter note, dotted (d) or triplet (t) values. Off = use Rate.')),
    sel(`lfo${i}Trig`, 'Trigger', LFO_TRIGGERS, 'note', d('note = every note starts its own LFO from Phase; free = one LFO tied to the song clock that all notes share (chords move together).')),
    n(`lfo${i}Fade`, 'Fade in', 0, 5, 0, { unit: 's', ...d('Time for the LFO to grow from nothing to full depth after the note starts — delayed vibrato.') }),
    n(`lfo${i}Phase`, 'Phase', 0, 1, 0, d('Where in its cycle the LFO starts.')),
    n(`lfo${i}Steps`, 'Steps', 2, LFO_STEPS, 8, { step: 1, ...d('Shape "steps": how many steps the drawn shape has. One cycle of the LFO plays them all, so with Sync "1bar" and 16 steps each step is a sixteenth.') }),
    n(`lfo${i}Smooth`, 'Smooth', 0, 1, 0, d('Shape "steps": 0 = hard steps (a step sequencer), 1 = every step glides into the next (a drawn curve).')),
    // (a falling staircase until something else is drawn)
    ...range(LFO_STEPS).map((k) => n(`lfo${i}S${k}`, `Step ${k}`, -1, 1, Math.round((1 - (2 * ((k - 1) % 8)) / 7) * 100) / 100, d(`Shape "steps": the height of step ${k}, -1..1. Draw the steps in the LFO panel.`)))
  ];
}

function chaosParams(i) {
  const s = { section: 'chaos', group: `Chaos ${i}` };
  const d = (desc) => ({ ...s, desc });
  return [
    sel(`chaos${i}Type`, 'Type', CHAOS_TYPES, i === 1 ? 'lorenz' : 'drift', d('The generator: lorenz (swings between two centres, flipping unpredictably), rossler (a wobbling loop that lurches), drift (a random walk that comes home — analog pitch drift), turing (a looping step pattern that mutates).')),
    n(`chaos${i}Rate`, 'Rate', 0.01, 50, i === 1 ? 0.5 : 0.3, { unit: 'Hz', curve: 'log', ...d('Speed when Sync is off: swings (lorenz) or orbits (rossler) per second, how fast drift wanders, steps per second for turing.') }),
    sel(`chaos${i}Sync`, 'Sync', LFO_SYNC, 'off', d('Locks the speed to the tempo: the length of one swing, orbit or step as a note value. Off = use Rate.')),
    n(`chaos${i}Char`, 'Character', 0, 1, 0.5, d('What kind of chaos: lorenz 0 = long stays on one side, 1 = restless · rossler 0 = nearly periodic, 1 = spiky · drift 0 = jittery, 1 = smooth · turing = the chance that a step mutates (0 locks the loop).')),
    n(`chaos${i}Steps`, 'Steps', 2, 32, 16, { step: 1, ...d('Turing only: the length of the looping pattern in steps.') }),
    sel(`chaos${i}Path`, 'Path', CHAOS_PATHS, 'note', d('note = every note gets its own path (voices drift apart, like analog hardware); same = every note replays the same path from its start (notes of a chord move together, and a part sounds the same every time). A tempo-synced turing pattern on "same" is locked to the song instead: every note hears the step of that moment, on the grid, and a bar sounds the same every time it is played or exported.'))
  ];
}

function modParams(i) {
  const s = { section: 'mod', group: `Mod ${i}` };
  const d = (desc) => ({ ...s, desc });
  return [
    sel(`mod${i}Src`, 'Source', MOD_SOURCES, 'none', d(`Modulation slot ${i}: what moves (an envelope, an LFO, velocity, pressure, slide, a macro …).`)),
    sel(`mod${i}Dst`, 'Target', MOD_TARGETS, 'none', d(`Modulation slot ${i}: the control that is moved.`)),
    n(`mod${i}Amt`, 'Amount', -1, 1, 0, d(`Modulation slot ${i}: how far the target moves when the source is at full; 1 = the target's whole range, negative = the other way.`)),
    sel(`mod${i}Via`, 'Via', MOD_SOURCES, 'none', d(`Modulation slot ${i}: an optional second source that scales the amount (e.g. an LFO whose depth follows a macro).`))
  ];
}

const range = (count) => Array.from({ length: count }, (_, i) => i + 1);
const sub = (desc) => ({ section: 'sub', group: 'Sub', desc });
const noise = (desc) => ({ section: 'noise', group: 'Noise', desc });
const voice = (desc) => ({ section: 'voice', group: 'Voice', desc });
const fx = (group, desc) => ({ section: 'fx', group, desc });

export const GGS_PARAMS = [
  ...oscParams('A', true, 0.8),
  ...oscParams('B', false, 0.6),
  ...oscParams('C', false, 0.5),
  n('subLevel', 'Level', 0, 1, 0, sub('Volume of the sub oscillator: a plain wave below the note for weight.')),
  sel('subWave', 'Wave', SUB_WAVES, 'sine', sub('Shape of the sub: sine is pure weight, triangle and square add a little presence, saw is a second oscillator.')),
  n('subOct', 'Octave', -3, 0, -1, { step: 1, ...sub('How many octaves below the note the sub plays.') }),
  sel('subDest', 'To', SOURCE_DESTS, 'direct', sub('Where the sub goes. direct keeps it clean and full under a filtered sound.')),
  n('noiseLevel', 'Level', 0, 1, 0, noise('Volume of the noise source: breath, air, the attack of a pluck, or the exciter for a comb filter.')),
  sel('noiseType', 'Type', NOISE_TYPES, 'white', noise('white = bright hiss, pink = balanced, brown = a low rumble.')),
  n('noiseColor', 'Color', -1, 1, 0, noise('Tilts the noise: negative = darker, positive = thinner and brighter.')),
  sel('noiseDest', 'To', SOURCE_DESTS, 'f1', noise('Where the noise goes: filter 1, filter 2, both, or straight to the output.')),
  ...filterParams(1, true),
  ...filterParams(2, false),
  sel('filterRoute', 'Routing', FILTER_ROUTES, 'serial', { section: 'filter', group: 'Routing', desc: 'serial = filter 1 feeds filter 2; parallel = both filter their own inputs side by side and are summed.' }),
  ...envParams(1, 0.005, 0.3, 1, 0.25),
  ...envParams(2, 0.005, 0.4, 0, 0.3),
  ...envParams(3, 0.005, 0.4, 0, 0.3),
  ...envParams(4, 0.005, 0.4, 0, 0.3),
  ...range(LFO_COUNT).flatMap(lfoParams),
  ...range(CHAOS_COUNT).flatMap(chaosParams),
  ...range(MACRO_COUNT).map((i) => n(`macro${i}`, `Macro ${i}`, 0, 1, 0, { section: 'macro', group: 'Macros', desc: `Macro ${i}: one knob for the whole channel that can drive any number of targets through the matrix. It can be automated in the playlist.` })),
  ...range(MOD_SLOTS).flatMap(modParams),
  n('level', 'Level', 0, 1, 1, voice('Volume of each note before the effects. Set it to 0 and route pressure to Level for a sound that only speaks when pressed.')),
  n('velSens', 'Velocity', 0, 1, 1, voice('How much velocity changes the volume: 1 = full dynamics, 0 = every note equally loud.')),
  n('relVelSens', 'Rel. velocity', 0, 1, 0, voice('How much the release velocity changes the release time: a fast lift shortens the tail, a slow one lengthens it.')),
  n('polyphony', 'Polyphony', 1, 32, 16, { step: 1, ...voice('The most notes that can sound at once; the oldest is faded out when the limit is reached.') }),
  bool('mono', 'Mono', false, voice('One note at a time: a new note cuts the previous one (leads and basses).')),
  bool('legato', 'Legato', false, voice('With Mono: overlapping notes continue the envelopes instead of restarting them.')),
  n('glide', 'Glide', 0, 2, 0, { unit: 's', ...voice('Time to slide from the previous note to the new one (mono patches).') }),
  sel('quality', 'Quality', QUALITIES, 'auto', voice('Oversampling: auto runs patches that could alias (FM, warp, drive, analog-style filters) at twice the rate, high always does, eco never.')),
  n('gain', 'Gain', 0, 2, 0.55, voice('Output level of the channel after the effects. Presets are levelled with it so that swapping them does not upset a mix.')),
  n('driveAmt', 'Amount', 0, 1, 0, fx('Drive', 'Distortion on the whole channel (all notes together, so chords intermodulate).')),
  sel('driveType', 'Type', DRIVE_TYPES, 'soft', fx('Drive', 'soft = warm saturation, hard = clipping, tube = asymmetric and thick, fold = wave folding (metallic).')),
  n('chorusMix', 'Mix', 0, 1, 0, fx('Chorus', 'Amount of chorus: width and shimmer from slowly detuned copies.')),
  n('chorusRate', 'Rate', 0.05, 5, 0.6, { unit: 'Hz', curve: 'log', ...fx('Chorus', 'Speed of the chorus movement.') }),
  n('chorusDepth', 'Depth', 0, 1, 0.5, fx('Chorus', 'How far the chorus copies are detuned.')),
  n('delayMix', 'Mix', 0, 1, 0, fx('Delay', 'Amount of echo.')),
  sel('delaySync', 'Time', DELAY_SYNC, '1/8d', fx('Delay', 'Echo time as a note value locked to the tempo; free = use Free time.')),
  n('delayTime', 'Free time', 1, 2000, 350, { unit: 'ms', curve: 'log', ...fx('Delay', 'Echo time in milliseconds when Time is free.') }),
  n('delayFb', 'Feedback', 0, 0.95, 0.35, fx('Delay', 'How much of each echo is fed back: more = more repeats.')),
  n('delayTone', 'Tone', 200, 20000, 6000, { unit: 'Hz', curve: 'log', ...fx('Delay', 'Low-pass on the repeats: lower = each echo darker than the last.') }),
  bool('delayPing', 'Ping-pong', true, fx('Delay', 'Echoes alternate between left and right.')),
  n('reverbMix', 'Mix', 0, 1, 0, fx('Reverb', 'Amount of reverb.')),
  n('reverbSize', 'Size', 0, 1, 0.5, fx('Reverb', 'Size of the space and length of its tail.')),
  n('reverbDamp', 'Damping', 0, 1, 0.4, fx('Reverb', 'How quickly the highs die in the tail: more = warmer, darker room.'))
];

const BY_KEY = new Map(GGS_PARAMS.map((p) => [p.key, p]));
export const ggsParamDef = (key) => BY_KEY.get(key) || null;

// (not frozen: spreading a frozen object takes V8's slow path — 40 µs instead of 1, on every note. Nobody writes to it.)
const DEFAULTS = Object.fromEntries(GGS_PARAMS.map((p) => [p.key, p.default]));
/** A fresh copy of the init patch (one saw through an open filter). */
export const ggsDefaults = () => ({ ...DEFAULTS });

/** Params of the effects section (they live in the channel's FX processor, not in the voices). */
export const FX_KEYS = GGS_PARAMS.filter((p) => p.section === 'fx').map((p) => p.key).concat(['gain']);

/** Fill a (possibly partial or damaged) params object with defaults; values of the wrong type fall back. */
export function completeParams(params) {
  const out = { ...DEFAULTS };
  if (!params || typeof params !== 'object') return out;
  params = migrateParams(params);
  // (walks what was given, not the whole schema: a note brings only what differs from the init patch)
  for (const key in params) {
    const def = BY_KEY.get(key);
    const v = params[key];
    if (!def || v === undefined || v === null) continue;
    if (def.type === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[def.key] = v < def.min ? def.min : v > def.max ? def.max : v;
    } else if (def.type === 'select') {
      if (def.options.includes(v)) out[def.key] = v;
    } else out[def.key] = v === true;
  }
  return out;
}

/**
 * Does a patch make new harmonics after the oscillators (phase modulation, warping, filter drive, the analog-style
 * filters whose loops saturate)? Those can alias,
 * so quality "auto" runs such patches at twice the sample rate — and plain patches, which can't alias, at 1×.
 */
export function needsOversampling(p) {
  for (const k of OSC_CHECKS) {
    if (!p[k.on]) continue;
    if (p[k.warp] !== 'off') return true;
    if (p[k.fmFrom] !== 'off') return true;
  }
  if ((p.f1On && (p.f1Drive > 0 || filterIsNonlinear(p.f1Type))) || (p.f2On && (p.f2Drive > 0 || filterIsNonlinear(p.f2Type)))) return true;
  for (const k of SLOT_CHECKS) {
    if (p[k.src] !== 'none' && p[k.amt] && HARMONIC_TARGETS.has(p[k.dst])) return true;
  }
  return false;
}
// (key names built once: this runs for every note)
const OSC_CHECKS = OSC_IDS.map((x) => ({ on: `osc${x}On`, warp: `osc${x}Warp`, fmFrom: `osc${x}FmFrom` }));
const SLOT_CHECKS = range(MOD_SLOTS).map((i) => ({ src: `mod${i}Src`, amt: `mod${i}Amt`, dst: `mod${i}Dst` }));
const HARMONIC_TARGETS = new Set(MOD_TARGETS.filter((t) => /(Fm|WarpAmt|Drive)$/.test(t)));

/**
 * The longest a note can ring after its note-off, in seconds: the amp envelope's release (stretched by release
 * velocity at most 4×) plus the closing fade. The audio engine uses it to know when a voice is finished.
 */
export function releaseTail(params, releaseVelocity = 0.5) {
  const r = typeof params?.env1R === 'number' ? params.env1R : DEFAULTS.env1R;
  const sens = typeof params?.relVelSens === 'number' ? params.relVelSens : 0;
  return r * Math.pow(2, (0.5 - releaseVelocity) * 4 * sens) + 0.02;
}
