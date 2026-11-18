// Post-classical ambient jazz — "Winter Light". A felt-piano figure grouped 3+3+2 repeats and changes one note every
// two bars over four slow chords coloured with added notes; the piece grows by layers — a left hand, an upright bass
// and a pad, strings and a vibraphone cell on four other chords, a second piano like rain, a shaker and a rim — to a
// peak that is higher and denser but in no new key, then gives the layers back until the figure is alone and the last
// chord rings. The study behind it: docs/styles/post-classical-ambient-jazz.md.
//
// The chords come from the chord grid (Harmony → Grid, add_grid_chords) in E minor, led by its engine ("Follow"): the
// piano plays its Two Hands voicing, strings and pad its Open one. They are written out here as notes — core does not
// carry the engine. One chord is borrowed, and kept for the second half of each phrase: A major, whose C♯ is the only
// note from outside the key.
import { STEP } from '../constants.js';
import { uid } from '../ids.js';
import { createRng } from '../rng.js';
import { makeCurve } from '../expression.js';
import { melodyFromString } from '../builders.js';
import { steps } from './steps.js';

// low = the left hand's note, up = the cluster above it (Two Hands), open = the same chord spread (Open)
const HOME = [
  { name: 'Em9', low: 52, up: [66, 67, 71, 74], open: [52, 55, 59, 62, 66] },
  { name: 'CM9', low: 48, up: [62, 64, 67, 71], open: [52, 59, 60, 62, 67] },
  { name: 'Gadd9', low: 55, up: [62, 69, 71], open: [47, 55, 57, 62] },
  { name: 'Dadd9', low: 50, up: [64, 66, 69], open: [50, 54, 57, 64] }
];
const AWAY = [
  { name: 'Am9', low: 45, up: [60, 64, 67, 71], open: [48, 55, 57, 59, 64] },
  { name: 'CM9', low: 48, up: [62, 64, 67, 71], open: [50, 55, 59, 60, 64] },
  { name: 'Gadd9', low: 55, up: [62, 69, 71], open: [45, 50, 55, 59] },
  { name: 'Aadd9', low: 57, up: [64, 71, 73], open: [47, 52, 57, 61] }
];
// The figure: eight eighths a bar as 3+3+2, by place in the cluster. Each chord lasts two bars, and the second bar
// changes one thing — the order of two notes in the middle group.
const FIGURE = {
  4: [[0, 2, 3, 1, 2, 3, 2, 3], [0, 2, 3, 1, 3, 2, 1, 3]],
  3: [[0, 1, 2, 0, 1, 2, 1, 2], [0, 1, 2, 1, 0, 2, 1, 2]]
};
const EIGHTH = STEP * 2;
const CHORD_BARS = 2;
const note = (key, start, length, velocity) => ({ id: uid('n'), key, start, length, velocity: Math.round(velocity * 100) / 100 });

/**
 * The right hand over four chords (eight bars). `keep`: the eighths of a bar that sound (all of them when left out) —
 * the piece opens and closes on a thinned figure. Notes ring a quarter, into each other, as under a half pedal.
 */
function figure(chords, bar, rng, { keep = null, level = 1 } = {}) {
  const out = [];
  chords.forEach((c, ci) => {
    for (let b = 0; b < CHORD_BARS; b++) {
      FIGURE[c.up.length][b].forEach((place, e) => {
        if (keep && !keep.includes(e)) return;
        const accent = e === 0 || e === 3 || e === 6;
        const top = place === c.up.length - 1;
        // the first of each group leans, the top note sings a little over the rest; no two notes are struck alike
        const v = (accent ? 0.52 : top ? 0.44 : 0.37) * level + (rng() - 0.5) * 0.05;
        const start = (ci * CHORD_BARS + b) * bar + e * EIGHTH;
        // (…but the last note of the phrase stops with it: the pattern repeats, and a note may not run past its end)
        out.push(note(c.up[place], start, Math.min(EIGHTH * 2, chords.length * CHORD_BARS * bar - start), v));
      });
    }
  });
  return out;
}
/**
 * One held chord per two bars from some of its notes. The phrase leans towards its third chord and the top voice
 * is a shade over the others: held notes with one velocity are a keyboard, not players.
 */
const held = (chords, bar, pick, velocity) => chords.flatMap((c, ci) => pick(c).map((key, vi, all) => note(key, ci * CHORD_BARS * bar, CHORD_BARS * bar - STEP, velocity + [0, 0.02, 0.05, 0.01][ci] + (vi === all.length - 1 ? 0.03 : vi === 0 ? 0.01 : -0.02))));
/** The pad breathes once a chord: it swells and opens towards the middle of its two bars and falls back (the patch answers to pressure and to slide). */
const breathe = (notes) => notes.map((n) => ({ ...n, expression: { pressure: makeCurve('pressure', 'swell', { from: 0.1, peak: 0.6, at: 0.55, to: 0.2 }), timbre: makeCurve('timbre', 'ramp', { from: 0.15, to: 0.45 }) } }));
/** The left hand: the root, held under the figure. */
const leftHand = (chords, bar) => chords.map((c, ci) => note(c.low, ci * CHORD_BARS * bar, CHORD_BARS * bar - EIGHTH, 0.42));
/**
 * The second piano, heard as two: the two highest notes of each chord an octave up, in quiet sixteenths from the left
 * and the right with some left out — the texture of two felted pianos answering one (Ólafur Arnalds' Stratus),
 * which he likens to rain.
 */
function rain(chords, bar, rng) {
  const out = [];
  chords.forEach((c, ci) => {
    const pair = [c.up[c.up.length - 1] + 12, c.up[c.up.length - 2] + 12];
    for (let s = 0; s < CHORD_BARS * 16; s++) {
      const skip = rng() < 0.28;
      const v = 0.2 + rng() * 0.14;
      // (one note from the left, the next from the right)
      if (!skip) out.push({ ...note(pair[s % 2], ci * CHORD_BARS * bar + s * STEP, STEP * 2, v), pan: s % 2 ? 0.55 : -0.55 });
    }
  });
  return out;
}

export default {
  label: 'Post-classical ambient jazz (108 BPM, E minor: felt piano, upright bass, strings, vibraphone)',
  spec: () => {
    // (a seed, so the piece is the same piece every time the template is opened)
    const rng = createRng('winter light').unit;
    return {
      name: 'Winter Light', bpm: 108, key: 'E', scale: 'minor',
      channels: [
        // close and soft, with the low-mids of the felt held back a little and the hammers let through; tape drift and a
        // trace of hiss — the noises stay in
        { name: 'Piano', kind: 'piano', preset: 'Felt', volume: 1, params: { brightness: 0.3, stereo: 0.9 }, fx: [{ type: 'eq', params: { hpf: 45, mid: -2.5, midFreq: 320, midQ: 1.2, high: 4, highFreq: 5000 } }, { type: 'lofi', params: { bits: 16, rate: 44100, wow: 0.18, flutter: 0.08, tone: 9500, noise: 0.02, mix: 1 } }], sends: { Hall: 0.34 } },
        { name: 'Rain', kind: 'piano', preset: 'Upright', volume: 0.7, params: { brightness: 0.45, hardness: 0.2 }, fx: [{ type: 'eq', params: { hpf: 300 } }], sends: { Hall: 0.55, Echo: 0.2 } },
        { name: 'Bass', kind: 'bass', preset: 'Upright', volume: 0.85, sends: { Hall: 0.06 } },
        { name: 'Pad', kind: 'ggs', preset: 'Velvet Pad', volume: 0.45, fx: [{ type: 'eq', params: { hpf: 180, lpf: 6000 } }], sends: { Hall: 0.4 } },
        // high and soft, over the piano rather than in its way
        { name: 'Strings', kind: 'strings', preset: 'Slow Strings', volume: 0.6, fx: [{ type: 'eq', params: { hpf: 250 } }], sends: { Hall: 0.45 } },
        { name: 'Cello', kind: 'strings', preset: 'Solo Cello', volume: 0.7, pan: -0.2, sends: { Hall: 0.35 } },
        { name: 'Vibes', kind: 'modal', preset: 'Vibraphone', volume: 0.85, pan: 0.15, sends: { Hall: 0.4, Echo: 0.3 } },
        { name: 'Shaker', kind: 'shaker', preset: 'Soft', volume: 0.9, pan: -0.25, sends: { Hall: 0.2 } },
        { name: 'Rim', kind: 'rim', preset: 'Classic', volume: 0.8, pan: 0.1, sends: { Hall: 0.35 } }
      ],
      // one room for everything (long, dark, behind the instruments) and a quiet dotted echo for the vibraphone
      buses: [
        { name: 'Hall', fx: [{ type: 'algoverb', params: { voicing: 'hall', size: 0.8, decay: 4.5, predelay: 30, damping: 5000, lowCut: 220, mix: 1 } }] },
        { name: 'Echo', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.3, tone: 3200, mix: 1 } }] }
      ],
      patterns: [
        {
          // the figure thinned to the first and last note of each group: how the piece begins, and how it leaves
          name: 'Seed', bars: 8, color: '#cfc7b0',
          notes: (bar) => ({ Piano: figure(HOME, bar, rng, { keep: [0, 2, 3, 5, 6], level: 0.92 }) })
        },
        { name: 'Piano home', bars: 8, color: '#e4d9b8', notes: (bar) => ({ Piano: figure(HOME, bar, rng) }) },
        { name: 'Piano away', bars: 8, color: '#d9c9a0', notes: (bar) => ({ Piano: figure(AWAY, bar, rng) }) },
        // (the left hand has its own patterns: it steps back at the peak, where the cello sings in its register)
        { name: 'Left hand home', bars: 8, color: '#c9b98c', notes: (bar) => ({ Piano: leftHand(HOME, bar) }) },
        { name: 'Left hand away', bars: 8, color: '#bfae80', notes: (bar) => ({ Piano: leftHand(AWAY, bar) }) },
        {
          // one long note a chord, and a step into the next
          name: 'Bass home', bars: 8, color: '#7a5c3e',
          notes: () => ({ Bass: melodyFromString('E2:28 -:2 D2:2  C2:28 -:2 F#2:2  G2:28 -:2 E2:2  D2:28 -:2 B1:2', { velocity: 0.62, gate: 0.97 }) })
        },
        {
          name: 'Bass away', bars: 8, color: '#6d5238',
          notes: () => ({ Bass: melodyFromString('A1:28 -:2 B1:2  C2:28 -:2 A1:2  G1:28 -:4  A1:28 -:2 B1:2', { velocity: 0.62, gate: 0.97 }) })
        },
        {
          // the peak: the bass starts to move
          name: 'Bass home, moving', bars: 8, color: '#8a6845',
          notes: () => ({ Bass: melodyFromString('E2:12 B2:4 E2:8 G2:4 D2:4  C2:12 G2:4 C2:8 E2:4 F#2:4  G2:12 D2:4 G2:8 B1:4 E2:4  D2:12 A2:4 D2:8 F#2:4 B1:4', { velocity: 0.66, gate: 0.95 }) })
        },
        {
          name: 'Bass away, moving', bars: 8, color: '#7d5e40',
          notes: () => ({ Bass: melodyFromString('A1:12 E2:4 A1:8 C2:4 B1:4  C2:12 G2:4 C2:8 B1:4 A1:4  G1:12 D2:4 G1:16  A1:12 E2:4 A1:8 C#2:4 B1:4', { velocity: 0.66, gate: 0.95 }) })
        },
        { name: 'Pad home', bars: 8, color: '#8f9bb3', notes: (bar) => ({ Pad: breathe(held(HOME, bar, (c) => c.open.slice(0, 3), 0.42)) }) },
        { name: 'Pad away', bars: 8, color: '#8391ad', notes: (bar) => ({ Pad: breathe(held(AWAY, bar, (c) => c.open.slice(0, 3), 0.42)) }) },
        { name: 'Strings home', bars: 8, color: '#b55e7a', notes: (bar) => ({ Strings: held(HOME, bar, (c) => c.open.slice(-3).map((k) => k + 12), 0.47) }) },
        { name: 'Strings away', bars: 8, color: '#a8546f', notes: (bar) => ({ Strings: held(AWAY, bar, (c) => c.open.slice(-3).map((k) => k + 12), 0.47) }) },
        {
          // the only line that could be called a tune, and it arrives late: long notes that move by step
          name: 'Cello home', bars: 8, color: '#a0785a',
          notes: () => ({ Cello: melodyFromString('E3:16 G3:8 F#3:8  E3:16 D3:8 E3:8  D3:24 B2:8  A2:16 D3:8 F#3:8', { velocity: 0.6, gate: 0.98 }) })
        },
        {
          name: 'Cello away', bars: 8, color: '#946d50',
          notes: () => ({ Cello: melodyFromString('C3:16 E3:8 D3:8  C3:16 B2:8 C3:8  B2:24 D3:8  C#3:16 E3:8 A3:8', { velocity: 0.62, gate: 0.98 }) })
        },
        {
          // a cell of three notes on the figure's own accents (the second and third group, then the next downbeat),
          // and silence after it; on the borrowed chord it takes the C♯ and turns upward
          name: 'Vibes away', bars: 8, color: '#7fc4c0',
          // (each cell is said the same way: the first note placed, the second lighter, the long one the point of it)
          notes: () => ({ Vibes: melodyFromString('-:6 E5:6 D5:4 B4:12 -:4  -:6 D5:6 B4:4 G4:12 -:4  -:6 D5:6 B4:4 A4:12 -:4  -:6 C#5:6 B4:4 E5:12 -:4', { gate: 1 }).map((n, i) => ({ ...n, velocity: [0.5, 0.41, 0.56][i % 3] })) })
        },
        { name: 'Rain home', bars: 8, color: '#b8c4d6', notes: (bar) => ({ Rain: rain(HOME, bar, rng) }) },
        { name: 'Rain away', bars: 8, color: '#aab8cc', notes: (bar) => ({ Rain: rain(AWAY, bar, rng) }) },
        {
          // time kept as colour: a shaker leaning on the figure's 3+3+2, a rim on the third beat only
          name: 'Brushes', bars: 2, color: '#9aa5b1',
          notes: () => ({
            Shaker: steps('X-x-x-X-x-x-X-x- X-x-x-X-x-x-X-x-', undefined, { velocityScale: 0.42 }),
            Rim: steps('--------x------- --------x-----x-', undefined, { velocityScale: 0.5 })
          })
        },
        {
          // the figure thinner still, then the first chord once more, rolled from the bottom and left to ring
          name: 'Last chord', bars: 8, color: '#f1ead6',
          notes: (bar) => ({
            Piano: [
              ...figure(HOME.slice(0, 2), bar, rng, { keep: [0, 2, 5], level: 0.85 }),
              ...[40, 52, 62, 66, 67, 71].map((key, i) => note(key, 4 * bar + i * 36, 4 * bar - i * 36 - STEP, 0.4 + i * 0.02))
            ],
            Pad: HOME[0].open.slice(0, 4).map((key) => ({ ...note(key, 0, 6 * bar, 0.4), expression: { pressure: makeCurve('pressure', 'ramp', { from: 0.45, to: 0.05 }) } }))
          })
        }
      ],
      markers: [
        { bar: 0, name: 'Alone' }, { bar: 8, name: 'Left hand' }, { bar: 16, name: 'Bass and pad' }, { bar: 24, name: 'Other chords' },
        { bar: 32, name: 'Rain' }, { bar: 40, name: 'Peak' }, { bar: 48, name: 'Leaving' }, { bar: 56, name: 'Alone again' }, { bar: 68, name: 'Last chord' }
      ],
      // quiet and dynamic on purpose: a few dB of gain before the limiter, which never has to work
      master: [{ type: 'utility', params: { gain: 6 } }],
      arrangement: [
        { pattern: 'Seed', track: 0, bar: 0, bars: 8, trackName: 'Piano' },
        { pattern: 'Piano home', track: 0, bar: 8, bars: 16 },
        { pattern: 'Piano away', track: 0, bar: 24, bars: 8 },
        { pattern: 'Piano home', track: 0, bar: 32, bars: 8 },
        { pattern: 'Piano away', track: 0, bar: 40, bars: 8 },
        { pattern: 'Piano home', track: 0, bar: 48, bars: 8 },
        { pattern: 'Seed', track: 0, bar: 56, bars: 8 },
        { pattern: 'Last chord', track: 0, bar: 64, bars: 8 },
        { pattern: 'Left hand home', track: 1, bar: 8, bars: 16, trackName: 'Left hand' },
        { pattern: 'Left hand away', track: 1, bar: 24, bars: 8 },
        { pattern: 'Left hand home', track: 1, bar: 48, bars: 8 },
        { pattern: 'Bass home', track: 2, bar: 16, bars: 8, trackName: 'Bass' },
        { pattern: 'Bass away', track: 2, bar: 24, bars: 8 },
        { pattern: 'Bass home, moving', track: 2, bar: 32, bars: 8 },
        { pattern: 'Bass away, moving', track: 2, bar: 40, bars: 8 },
        { pattern: 'Bass home', track: 2, bar: 48, bars: 8 },
        { pattern: 'Pad home', track: 3, bar: 16, bars: 8, trackName: 'Pad' },
        { pattern: 'Pad away', track: 3, bar: 24, bars: 8 },
        { pattern: 'Pad home', track: 3, bar: 32, bars: 8 },
        { pattern: 'Pad away', track: 3, bar: 40, bars: 8 },
        { pattern: 'Pad home', track: 3, bar: 48, bars: 16 },
        { pattern: 'Strings away', track: 4, bar: 24, bars: 8, trackName: 'Strings' },
        { pattern: 'Strings home', track: 4, bar: 32, bars: 8 },
        { pattern: 'Strings away', track: 4, bar: 40, bars: 8 },
        { pattern: 'Strings home', track: 4, bar: 48, bars: 8 },
        { pattern: 'Cello home', track: 5, bar: 32, bars: 8, trackName: 'Cello' },
        { pattern: 'Cello away', track: 5, bar: 40, bars: 8 },
        { pattern: 'Vibes away', track: 6, bar: 24, bars: 8, trackName: 'Vibes' },
        { pattern: 'Vibes away', track: 6, bar: 40, bars: 8 },
        { pattern: 'Rain home', track: 7, bar: 32, bars: 8, trackName: 'Rain' },
        { pattern: 'Rain away', track: 7, bar: 40, bars: 8 },
        { pattern: 'Brushes', track: 8, bar: 32, bars: 16, trackName: 'Brushes' }
      ]
    };
  }
};
