// Unison: how the stacked copies of an oscillator are spaced in pitch, and which of them play another note.
// Ported from GGS Composer (Rust: oscillators/unison.rs) — the laws, the supersaw's curve and spacing, the stacks.
//
// A copy stands somewhere between the centre of the stack (0) and its edge (±1): d = −1 … 1, evenly. A law turns
// that place into a share of the detune:
//  - linear: the place itself — evenly spaced copies (the classic, and what every patch made before the laws has);
//  - super:  the JP-8000's supersaw. Its seven saws are not evenly spaced (0.18 : 0.57 : 1 of the outermost, and a
//            touch asymmetric), and its knob is not linear: most of its travel is gentle and the last tenth runs
//            away. Both are Adam Szabo's measurements ("How to Emulate the Super Saw", 2010);
//  - exp:    copies crowd round the centre and a few stand far out;
//  - random: an uneven spacing, fixed for a number of copies (the same for every note, so chords stay chords).
import { hash32 } from './util.js';

export const MAX_UNISON = 16;
export const UNISON_LAWS = ['linear', 'super', 'exp', 'random'];
export const UNISON_STACKS = ['off', 'octave', 'fifth', 'octave+fifth'];
/** Semitones the copies of a stack take in turn, from the centre outwards. */
const STACK_STEPS = [[0], [0, 12], [0, 7], [0, 7, 12]];

/** Where copy u of n stands in the stack: −1 (one edge) … 1 (the other); a single copy is in the middle. */
export function spreadOf(u, unison) {
  return unison < 2 ? 0 : (u / (unison - 1)) * 2 - 1;
}

// The supersaw's detune knob (0–1 → the share of its full detune), a polynomial fitted to the measured curve.
const CURVE = [10028.7312891634, -50818.8652045924, 111363.4808729368, -138150.6761080548, 106649.6679158292, -53046.9642751875, 17019.951858008, -3425.0836591318, 404.2703938388, -24.1878824391, 0.6717417634, 0.0030115596];
function curvePoly(x) {
  let y = 0;
  for (let i = 0; i < CURVE.length; i++) y = y * x + CURVE[i];
  return y;
}
const CURVE_0 = curvePoly(0);
const CURVE_SPAN = curvePoly(1) - CURVE_0;
/** The JP-8000's detune knob: 0–1 in, 0–1 out (0.5 is only 7 % of the way, 0.9 is 37 %). */
export function supersawDetune(x) {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  return (curvePoly(v) - CURVE_0) / CURVE_SPAN;
}

// The measured places of the supersaw's three pairs, as shares of the lower outermost one — the upper side is a
// touch narrower. A smooth curve through the centre and the three places serves any number of copies.
const SPACING_LOW = [0.17745, 0.57156, 1];
const SPACING_HIGH = [0.18098, 0.56502, 0.97664];
function supersawSpacing(a, upper) {
  const y = upper ? SPACING_HIGH : SPACING_LOW;
  // the cubic through (0, 0), (⅓, y0), (⅔, y1), (1, y2) — Lagrange, written out
  const l1 = (a * (a - 2 / 3) * (a - 1)) / ((1 / 3) * (-1 / 3) * (-2 / 3));
  const l2 = (a * (a - 1 / 3) * (a - 1)) / ((2 / 3) * (1 / 3) * (-1 / 3));
  const l3 = (a * (a - 1 / 3) * (a - 2 / 3)) / ((2 / 3) * (1 / 3));
  return y[0] * l1 + y[1] * l2 + y[2] * l3;
}

const EXP_SPAN = Math.exp(2.5) - 1;

/** The random law's share for copy u of n: 0.1–1, the same pair of numbers for the two sides, the largest is 1. */
function randomShare(u, unison) {
  const rank = (i) => Math.round(Math.abs(spreadOf(i, unison)) * (unison - 1));
  const raw = (r) => 0.1 + 0.9 * (hash32(Math.imul(unison, 0x9e3779b1) ^ Math.imul(r + 1, 0x85ebca6b)) / 4294967296);
  let max = 0;
  for (let i = 0; i < unison; i++) if (rank(i) > 0) max = Math.max(max, raw(rank(i)));
  return rank(u) > 0 && max > 0 ? raw(rank(u)) / max : 0;
}

/**
 * Cents copy u of a stack of `unison` is detuned by: law = an index into UNISON_LAWS, detune = the Detune knob in
 * cents (the outermost copies stand that far out — under the super law, as far as its curve lets them).
 */
export function unisonCents(law, u, unison, detune) {
  const d = spreadOf(u, unison);
  if (d === 0) return 0;
  const a = d < 0 ? -d : d;
  const sign = d < 0 ? -1 : 1;
  if (law === 1) {
    // (above 100 cents — only modulation gets there — the knob carries on in a straight line)
    const depth = detune > 100 ? detune : 100 * supersawDetune(detune / 100);
    return sign * supersawSpacing(a, d > 0) * depth;
  }
  if (law === 2) return (sign * detune * (Math.exp(2.5 * a) - 1)) / EXP_SPAN;
  if (law === 3) return sign * detune * randomShare(u, unison);
  return d * detune;
}

/**
 * Semitones copy u plays above the oscillator's note in a stack (an index into UNISON_STACKS): the centre copies
 * keep the note, and the pairs outwards take the stack's notes in turn — the same on both sides, so the stereo
 * field holds the same chord left and right.
 */
export function stackSemis(stack, u, unison) {
  const steps = STACK_STEPS[stack] || STACK_STEPS[0];
  if (steps.length < 2 || unison < 2) return 0;
  const fromCentre = Math.floor((Math.abs(spreadOf(u, unison)) * (unison - 1)) / 2 + 1e-9);
  return steps[fromCentre % steps.length];
}
