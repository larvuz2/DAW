// A tour of the studio's own DSP in one song: the Analog, Additive and Modal instruments, a GGS supersaw of unison
// copies (the JP-8000 law, an octave stack), every one of the fourteen studio effects doing a job in the mix, a
// progression voiced by the voice-leading solver, seeded arpeggios, a drum style and a Euclidean rhythm — in A
// minor in just intonation on A, with chords chosen so that every one of them is beatless there (Am9, Fmaj9, Cmaj7,
// Em, Dm7, E: no G major, whose fifth is the wolf of this tuning).
import { STEP } from '../constants.js';
import { chordProgressionNotes, bassFromChords, melodyFromString, rollNotes } from '../builders.js';
import { voiceLead } from '../voicelead.js';
import { arpeggiate, drumPattern, euclidString } from '../patterns.js';
import { steps } from './steps.js';

const PROG = ['Am9', 'Fmaj9', 'Cmaj7', 'Em'];
const LIFT = ['Dm7', 'Fmaj7', 'E', 'E'];

/** A supersaw: nine copies under the JP-8000's law with every second pair an octave up, over seven more an octave below. */
const SUPERSAW = {
  oscAUnison: 9, oscADetune: 62, oscAUniLaw: 'super', oscAStack: 'octave', oscABlend: 0.85, oscASpread: 0.9, oscALevel: 0.7,
  oscBOn: true, oscBOct: -1, oscBUnison: 7, oscBDetune: 55, oscBUniLaw: 'super', oscBBlend: 0.8, oscBSpread: 0.6, oscBLevel: 0.45,
  f1Cutoff: 7000, f1Res: 0.12, env1A: 0.012, env1D: 0.6, env1S: 0.85, env1R: 0.32,
  driveAmt: 0.22, driveType: 'soft', driveOs: '4x'
};

/** The chords of a progression as the solver voices them: four voices that move as little as they can. */
const voiced = (chords, low = 55, high = 79) => voiceLead(chords, { voices: 4, low, high, key: 'A', scale: 'minor' }).voicings;
/** Block chords from voicings. */
const held = (chords, bar, opts = {}) => chordProgressionNotes(chords, { chordLength: bar, voicings: voiced(chords, opts.low, opts.high), gate: opts.gate ?? 1, velocity: opts.velocity ?? 0.65, style: opts.style || 'block', rhythm: opts.rhythm });
/** An arpeggio over voicings. */
const arp = (chords, bar, opts) => arpeggiate(voiced(chords, opts.low, opts.high).map((pitches, i) => ({ pitches, start: i * bar, length: bar })), { seed: 'tour', ...opts });
/** A drum style's hits for one role, as notes of a channel. */
const lane = (hits, role) => hits.filter((h) => h.role === role).map((h) => ({ start: h.tick, length: STEP, velocity: h.velocity }));

export default {
  label: 'Effects & Engines Tour (122 BPM, A minor in just intonation: Analog, Additive, Modal, a supersaw, all 14 studio effects)',
  spec: () => {
    const groove = drumPattern('house', { bars: 4, variation: 0.35, fill: true, seed: 21 });
    return {
      name: 'Effects & Engines Tour', bpm: 122, key: 'A', scale: 'minor',
      // every pitched instrument plays in it; the chords of this song are whole-number ratios there
      tuning: { system: 'just', root: 'A' },
      channels: [
        // the kick's click is pulled into a short "pew" by the disperser; the shaper gives it back its front
        { name: 'Kick', kind: 'kick', preset: 'House Thump', volume: 0.55, fx: [{ type: 'disperser', params: { freq: 110, amount: 0.4, pinch: 1 } }, { type: 'transient', params: { attack: 0.2 } }] },
        { name: 'Clap', kind: 'clap', preset: 'Big', volume: 0.6, fx: [{ type: 'transient', params: { attack: 0.4, sustain: -0.3 } }], sends: { Plate: 0.2, Strings: 0.3 } },
        { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.85, pan: 0.15, sends: { Strings: 0.2 } },
        { name: 'Open Hat', kind: 'hat', preset: 'Open', volume: 0.7, pan: -0.15, params: { decay: 0.22 }, sends: { Strings: 0.25 } },
        // a conga through the ring modulator: a metal drum
        { name: 'Perc', kind: 'perc', preset: 'Conga', volume: 0.62, pan: 0.3, fx: [{ type: 'ringmod', params: { freq: 420, mix: 0.6 } }], sends: { Plate: 0.2 } },
        { name: 'Bass', kind: 'analog', preset: 'Saw Bass', params: { level: -6, sub: 0.25, cutoff: 420 }, volume: 0.95, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.55 } }] },
        // the pad drifts from side to side (auto-pan) and through a phaser that only ever rises (a shift of 0.4 Hz)
        {
          name: 'Glass', kind: 'additive', preset: 'Glass Pad', volume: 1.1,
          fx: [{ type: 'eq', params: { hpf: 180 } }, { type: 'tremolo', params: { sync: true, division: '1/2', depth: 0.55, stereo: 0.5, shape: 'sine' } }, { type: 'freqshift', params: { range: '10', amount: 0.04, mix: 0.5 } }],
          sends: { Hall: 0.35 }
        },
        // the same supersaw twice: chopped on the song's grid for the build…
        { name: 'Gate Pad', kind: 'ggs', preset: 'Init', params: SUPERSAW, volume: 0.5, fx: [{ type: 'eq', params: { hpf: 220 } }, { type: 'trancegate', params: { rate: '1/16', depth: 0.9, duty: 0.55 } }], sends: { Hall: 0.25 } },
        // …and whole for the drop: squeezed by the multiband, widened, ducked by the kick
        {
          name: 'Supersaw', kind: 'ggs', preset: 'Init', params: SUPERSAW, volume: 0.55,
          fx: [{ type: 'eq', params: { hpf: 180, high: 3 } }, { type: 'ott', params: { depth: 0.35, mix: 0.7 } }, { type: 'utility', params: { width: 1.3 } }, { type: 'pump', params: { source: 'Kick', depth: 0.6 } }],
          sends: { Hall: 0.2 }
        },
        { name: 'Lead', kind: 'analog', preset: 'Sync Lead', volume: 0.85, fx: [{ type: 'eq', params: { hpf: 250 } }, { type: 'flanger', params: { rate: 0.15, depth: 0.5, feedback: 0.35, mix: 0.3 } }], sends: { Plate: 0.25, Hall: 0.1 } },
        { name: 'Marimba', kind: 'modal', preset: 'Marimba', volume: 0.55, pan: -0.2, sends: { Plate: 0.2 } },
        // a vibraphone has a motor: that is a tremolo
        { name: 'Vibes', kind: 'modal', preset: 'Vibraphone', volume: 1, pan: 0.2, fx: [{ type: 'tremolo', params: { rate: 5.5, depth: 0.35, stereo: 0.25 } }], sends: { Hall: 0.3 } },
        // …and the kalimba comes off an old tape
        { name: 'Kalimba', kind: 'modal', preset: 'Kalimba', volume: 1, pan: -0.3, fx: [{ type: 'lofi', params: { bits: 10, rate: 14000, wow: 0.5, flutter: 0.3, noise: 0.06, tone: 6000 } }], sends: { Plate: 0.25 } },
        { name: 'Bell', kind: 'modal', preset: 'Tubular Bell', volume: 0.95, sends: { Shimmer: 0.6 } }
      ],
      buses: [
        { name: 'Hall', fx: [{ type: 'algoverb', params: { voicing: 'hall', decay: 3.2, predelay: 20, damping: 5500, mix: 1 } }] },
        { name: 'Plate', fx: [{ type: 'algoverb', params: { voicing: 'plate', decay: 1.5, mix: 1 } }] },
        { name: 'Shimmer', fx: [{ type: 'shimmer', params: { amount: 0.55, decay: 7, shiftA: 12, mix: 1 } }] },
        // five strings tuned to A minor: the hats and the clap come back as a chord
        { name: 'Strings', volume: 0.6, fx: [{ type: 'resonator', params: { root: 45, chord: 'minor', decay: 2.2, damping: 0.35, mix: 1 } }, { type: 'eq', params: { hpf: 200 } }] }
      ],
      // after the limiter: the peaks between the samples stay under −1 dBTP (a ceiling of −1.2 leaves room for the encoder)
      masterEnd: [{ type: 'maximizer', params: { gain: 1.5, ceiling: -1.2 } }],
      patterns: [
        { name: 'Drums Build', bars: 1, color: '#e8665a', notes: () => ({ Kick: steps('x---x---x---x---'), Hat: steps('--x---x---x---x-') }) },
        { name: 'Clap', bars: 1, color: '#e8665a', notes: () => ({ Clap: steps('----x-------x---') }) },
        { name: 'Roll', bars: 1, color: '#e8665a', notes: (bar) => ({ Clap: [...steps('----x---'), ...rollNotes({ start: bar / 2, span: bar / 2, count: 12, from: 0.35, to: 0.95 })] }) },
        {
          // the house style, with a little seeded variation and a fill at the end of its fourth bar
          name: 'Drums', bars: 4, color: '#e8665a',
          notes: () => ({ Kick: lane(groove, 'kick'), Clap: lane(groove, 'clap'), Hat: lane(groove, 'hat'), 'Open Hat': lane(groove, 'openhat') })
        },
        // five hits spread evenly over sixteen steps, started three steps later: E(5,16,3)
        { name: 'Perc', bars: 1, color: '#d98c5f', notes: () => ({ Perc: steps(euclidString(16, 5, 3)) }) },
        { name: 'Bass Build', bars: 4, color: '#d98c5f', notes: (bar) => ({ Bass: bassFromChords(PROG, { octave: 2, chordLength: bar, rhythm: 'X-------x-----o-', gate: 0.85 }) }) },
        { name: 'Bass Lift', bars: 4, color: '#d98c5f', notes: (bar) => ({ Bass: bassFromChords(LIFT, { octave: 2, chordLength: bar, rhythm: 'X---x---X---x-o-', gate: 0.8 }) }) },
        { name: 'Bass', bars: 4, color: '#d98c5f', notes: (bar) => ({ Bass: bassFromChords(PROG, { octave: 2, chordLength: bar, rhythm: '--X-x-o---X-x-ox', gate: 0.7 }) }) },
        { name: 'Glass', bars: 4, color: '#3fb5d6', notes: (bar) => ({ Glass: held(PROG, bar, { velocity: 0.6 }) }) },
        { name: 'Glass Lift', bars: 4, color: '#3fb5d6', notes: (bar) => ({ Glass: held(LIFT, bar, { velocity: 0.65 }) }) },
        { name: 'Gate', bars: 4, color: '#8f6cf0', notes: (bar) => ({ 'Gate Pad': held(PROG, bar, { velocity: 0.7 }) }) },
        { name: 'Gate Lift', bars: 4, color: '#8f6cf0', notes: (bar) => ({ 'Gate Pad': held(LIFT, bar, { velocity: 0.8 }) }) },
        { name: 'Supersaw', bars: 4, color: '#8f6cf0', notes: (bar) => ({ Supersaw: held(PROG, bar, { style: 'rhythm', rhythm: 'X--x--o---X--x--', gate: 0.8, velocity: 0.8 }) }) },
        {
          name: 'Lead A', bars: 8, color: '#f2a03d',
          notes: () => ({ Lead: melodyFromString('E5:4 A5:4 G5:2 E5:6  F5:4 A5:4 C6:6 A5:2  G5:4 E5:4 G5:2 B5:6  B5:8 G5:4 E5:4  A5:4 C6:4 E6:6 D6:2  C6:6 A5:2 G5:4 F5:4  E5:4 G5:4 C6:4 B5:4  B5:12 -:4', { velocity: 0.8, gate: 0.92 }) })
        },
        {
          name: 'Lead B', bars: 8, color: '#f2a03d',
          notes: () => ({ Lead: melodyFromString('A5:2 C6:2 E6:4 A6:4 G6:4  F6:6 E6:2 C6:4 A5:4  G5:2 C6:2 E6:4 G6:6 E6:2  E6:4 B5:4 G5:4 E5:4  A5:4 E6:4 A6:8  G6:2 F6:2 E6:4 C6:4 A5:4  G5:4 C6:4 E6:4 B5:4  B5:8 E6:8', { velocity: 0.85, gate: 0.92 }) })
        },
        { name: 'Marimba', bars: 4, color: '#46c79a', notes: (bar) => ({ Marimba: arp(PROG, bar, { mode: 'updown', rate: STEP, gate: 0.9, velocity: 0.62, accentEvery: 4, accent: 0.25, low: 60, high: 84 }) }) },
        { name: 'Marimba Lift', bars: 4, color: '#46c79a', notes: (bar) => ({ Marimba: arp(LIFT, bar, { mode: 'up', rate: STEP, gate: 0.9, velocity: 0.68, accentEvery: 4, accent: 0.25, low: 60, high: 84 }) }) },
        {
          name: 'Vibes', bars: 4, color: '#46c79a',
          notes: () => ({ Vibes: melodyFromString('E5:6 -:2 A5:8  C6:6 -:2 A5:8  G5:6 -:2 E5:8  B4:8 E5:8', { velocity: 0.6, gate: 1 }) })
        },
        { name: 'Kalimba', bars: 4, color: '#46c79a', notes: (bar) => ({ Kalimba: arp(PROG, bar, { mode: 'converge', rate: STEP * 2, gate: 1, velocity: 0.55, accentEvery: 4, accent: 0.2, low: 64, high: 88 }) }) },
        { name: 'Bell', bars: 4, color: '#c9a227', notes: (bar) => ({ Bell: [{ key: 57, start: 0, length: bar * 2, velocity: 0.7 }, { key: 64, start: bar * 2, length: bar * 2, velocity: 0.55 }] }) },
        {
          // the last chord, held: nothing in it beats
          name: 'Outro', bars: 4, color: '#9aa5b1',
          notes: (bar) => ({
            Glass: held(['Am9'], bar * 4, { velocity: 0.55 }),
            Vibes: melodyFromString('E5:8 A5:8  C6:16  B5:8 A5:8  A5:16', { velocity: 0.5, gate: 1 }),
            Bell: [{ key: 45, start: 0, length: bar * 4, velocity: 0.75 }, { key: 69, start: bar * 2, length: bar * 2, velocity: 0.45 }],
            Bass: [{ key: 45, start: 0, length: bar * 2, velocity: 0.7 }]
          })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 8, name: 'Build' }, { bar: 12, name: 'Lift' }, { bar: 16, name: 'Drop' }, { bar: 24, name: 'Drop 2' }, { bar: 32, name: 'Outro' }],
      arrangement: [
        { pattern: 'Glass', track: 0, bar: 0, bars: 12, trackName: 'Glass' },
        { pattern: 'Glass Lift', track: 0, bar: 12, bars: 4 },
        { pattern: 'Glass', track: 0, bar: 32, bars: 4 },
        { pattern: 'Outro', track: 0, bar: 36, bars: 4 },
        { pattern: 'Bell', track: 1, bar: 0, bars: 8, trackName: 'Bell' },
        { pattern: 'Bell', track: 1, bar: 16, bars: 20 },
        { pattern: 'Vibes', track: 2, bar: 4, bars: 4, trackName: 'Vibes' },
        { pattern: 'Vibes', track: 2, bar: 32, bars: 4 },
        { pattern: 'Kalimba', track: 3, bar: 4, bars: 12, trackName: 'Kalimba' },
        { pattern: 'Kalimba', track: 3, bar: 32, bars: 4 },
        { pattern: 'Drums Build', track: 4, bar: 8, bars: 8, trackName: 'Drums' },
        { pattern: 'Drums', track: 4, bar: 16, bars: 16 },
        { pattern: 'Clap', track: 5, bar: 12, bars: 3, trackName: 'Clap / Perc' },
        { pattern: 'Roll', track: 5, bar: 15, bars: 1 },
        { pattern: 'Perc', track: 5, bar: 16, bars: 16 },
        { pattern: 'Bass Build', track: 6, bar: 8, bars: 4, trackName: 'Bass' },
        { pattern: 'Bass Lift', track: 6, bar: 12, bars: 4 },
        { pattern: 'Bass', track: 6, bar: 16, bars: 16 },
        { pattern: 'Gate', track: 7, bar: 8, bars: 4, trackName: 'Supersaw' },
        { pattern: 'Gate Lift', track: 7, bar: 12, bars: 4 },
        { pattern: 'Supersaw', track: 7, bar: 16, bars: 16 },
        { pattern: 'Marimba', track: 8, bar: 8, bars: 4, trackName: 'Marimba' },
        { pattern: 'Marimba Lift', track: 8, bar: 12, bars: 4 },
        { pattern: 'Marimba', track: 8, bar: 16, bars: 16 },
        { pattern: 'Lead A', track: 9, bar: 16, bars: 8, trackName: 'Lead' },
        { pattern: 'Lead B', track: 9, bar: 24, bars: 8 }
      ]
    };
  }
};
