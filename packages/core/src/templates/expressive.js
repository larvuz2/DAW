// expressive synths: six GGS Synth patches and a performance written into the notes — pads that swell with
// pressure, a sub bass that slides, an FM arp that opens with slide, and a lead whose notes scoop, bend and shake
// on their own (i–VI–III–VII in D minor, a iv–v tension and a long resolve)
import { STEP } from '../constants.js';
import { chordProgressionNotes, melodyFromString } from '../builders.js';
import { makeCurve } from '../expression.js';

/** Give the notes at `index` positions (or all, with a function) their curves. */
const perform = (notes, shape) => notes.map((n, i) => {
  const expression = typeof shape === 'function' ? shape(n, i) : shape[i];
  return expression ? { ...n, expression } : n;
});
const flat = (v) => [{ t: 0, v }];

export default {
  label: 'Expressive synths (84 BPM, D minor: GGS Synth pads, FM arp, a lead with per-note bends)',
  spec: () => {
    const prog = ['Dm9', 'Bbmaj7', 'Fmaj7', 'C'];
    const tension = ['Gm9', 'A7sus4', 'A7sus4', 'Dm9'];
    const swell = (peak, at = 0.5, to = 0.1) => ({ pressure: makeCurve('pressure', 'swell', { from: 0.05, peak, at, to }) });
    const vibrato = (depth = 0.25, delay = 0.35) => makeCurve('pitch', 'vibrato', { depth, cycles: 5, delay, fade: 0.25 });
    return {
      name: 'Expressive Synths', bpm: 84, key: 'D', scale: 'minor',
      channels: [
        { name: 'Pad', kind: 'ggs', preset: 'Velvet Pad', volume: 0.7, fx: [{ type: 'eq', params: { hpf: 150 } }] },
        { name: 'Atmos', kind: 'ggs', preset: 'Glass Horizon', volume: 0.45, pan: 0.15, fx: [{ type: 'eq', params: { hpf: 300 } }] },
        { name: 'Bass', kind: 'ggs', preset: 'Deep Sub', volume: 0.9, fx: [{ type: 'stereo', params: { monoBelow: 120, width: 1 } }] },
        { name: 'Arp', kind: 'ggs', preset: 'Bell Sequence', volume: 0.55, pan: -0.25, fx: [{ type: 'eq', params: { hpf: 250 } }] },
        { name: 'Pluck', kind: 'ggs', preset: 'Pluck Garden', volume: 0.5, pan: 0.3, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Hall: 0.2 } },
        { name: 'Lead', kind: 'ggs', preset: 'Touch Lead', volume: 0.8, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Hall: 0.18 } }
      ],
      buses: [{ name: 'Hall', fx: [{ type: 'reverb', params: { decay: 4, size: 0.85, predelay: 0.03, mix: 1 } }] }],
      patterns: [
        {
          // every chord leans in: its notes swell with pressure (Velvet Pad opens its filter with it)
          name: 'Pad', bars: 4, color: '#46c79a',
          notes: (bar) => ({ Pad: perform(chordProgressionNotes(prog, { chordLength: bar, octave: 3, gate: 1, velocity: 0.6, voicing: 'open', center: 60 }), () => swell(0.7)) })
        },
        {
          name: 'Pad Tension', bars: 4, color: '#f2a03d',
          notes: (bar) => ({ Pad: perform(chordProgressionNotes(tension, { chordLength: bar, octave: 3, gate: 1, velocity: 0.65, voicing: 'open', center: 60 }), (n) => swell(n.start < bar * 3 ? 0.9 : 0.5, 0.7)) })
        },
        {
          // two long notes whose slide rises: Glass Horizon opens as they ring
          name: 'Atmos', bars: 4, color: '#3fb5d6',
          notes: (bar) => ({
            Atmos: perform([
              { key: 74, start: 0, length: bar * 2, velocity: 0.55 }, { key: 81, start: 0, length: bar * 2, velocity: 0.5 },
              { key: 77, start: bar * 2, length: bar * 2, velocity: 0.55 }, { key: 84, start: bar * 2, length: bar * 2, velocity: 0.45 }
            ], (n, i) => ({ timbre: makeCurve('timbre', 'ramp', { from: 0.1, to: i % 2 ? 0.8 : 0.5 }), pressure: makeCurve('pressure', 'swell', { from: 0, peak: 0.6, at: 0.6, to: 0.2 }) }))
          })
        },
        {
          // a mono sub: overlapping notes ("~") glide, the long ones grow harmonics with pressure
          name: 'Bass', bars: 4, color: '#d98c5f',
          notes: () => ({
            Bass: perform(melodyFromString('D2:8~ D2:4 A1:4~  Bb1:8 Bb1:4 D2:4~  F2:8 F2:4 C2:4~  C2:8 C2:4 E2:4', { velocity: 0.85, gate: 0.92 }), (n) => (n.length > STEP * 6 ? swell(0.6, 0.6, 0.2) : null))
          })
        },
        {
          name: 'Bass Tension', bars: 4, color: '#d98c5f',
          notes: () => ({
            Bass: perform(melodyFromString('G1:8 G1:4 Bb1:4~  A1:8 A1:8  A1:8 E2:8~  D2:16', { velocity: 0.88, gate: 0.94 }), (n, i) => (i === 6 ? { pitch: makeCurve('pitch', 'scoop', { depth: 2, end: 0.12 }), ...swell(0.8, 0.3, 0.3) } : swell(0.5, 0.5, 0.2)))
          })
        },
        {
          // the slide of each note is a little higher than the last: the arp brightens through the phrase
          name: 'Arp', bars: 4, color: '#f5d547',
          notes: (bar) => {
            const notes = chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'arp-up', rate: STEP, gate: 0.8, velocity: 0.6 });
            return { Arp: notes.map((n, i) => ({ ...n, velocity: i % 4 === 0 ? 0.8 : 0.5 + (i % 3) * 0.06, expression: { timbre: flat(Math.round((0.1 + 0.7 * (i / notes.length)) * 100) / 100) } })) };
          }
        },
        {
          name: 'Arp Tension', bars: 4, color: '#f5d547',
          notes: (bar) => {
            const notes = chordProgressionNotes(tension, { chordLength: bar, octave: 4, style: 'arp-updown', rate: STEP, gate: 0.8, velocity: 0.62 });
            return { Arp: notes.map((n, i) => ({ ...n, velocity: i % 4 === 0 ? 0.85 : 0.55, expression: { timbre: flat(0.8), pressure: flat(Math.round(Math.min(1, n.start / (bar * 3)) * 100) / 100) } })) };
          }
        },
        {
          // the last stab of every bar is pressed (the string rings longer) and picked brighter
          name: 'Pluck', bars: 4, color: '#8bd65b',
          notes: (bar) => ({
            Pluck: perform(chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'rhythm', rhythm: '--x--x--x---x-x-', gate: 0.5, velocity: 0.7 })
              .map((n) => ({ ...n, velocity: { 2: 0.75, 5: 0.6, 8: 0.7, 12: 0.55, 14: 0.85 }[(n.start % bar) / STEP] ?? 0.7 })),
            (n) => (n.start % bar === 14 * STEP ? { pressure: flat(0.9), timbre: flat(0.7) } : null))
          })
        },
        {
          // the lead: scoops into phrase starts, vibrato that arrives late on held notes (deeper where it is
          // pressed), a bend up to the high point and a fall at the end of the phrase
          name: 'Lead', bars: 8, color: '#8f6cf0',
          notes: () => ({
            Lead: perform(melodyFromString('A4:6 D5:2 F5:4 E5:4  D5:8 -:2 C5:2 D5:4  A5:6 G5:2 F5:4 E5:4  G5:10 -:6  F5:4 A5:4 C6:6 Bb5:2  A5:8 -:2 G5:2 A5:4  F5:6 E5:2 D5:4 C5:4  D5:12 -:4', { velocity: 0.78, gate: 0.94 }), {
              0: { pitch: makeCurve('pitch', 'scoop', { depth: 1, end: 0.15 }), ...swell(0.6, 0.6) },
              4: { pitch: vibrato(0.25), ...swell(0.85, 0.6, 0.3), timbre: makeCurve('timbre', 'ramp', { from: 0.1, to: 0.6 }) },
              7: { pitch: makeCurve('pitch', 'bend', { from: -2, to: 0, start: 0, end: 0.3 }), ...swell(0.9, 0.5, 0.4) },
              11: { pitch: makeCurve('pitch', 'fall', { depth: 3, start: 0.8 }), ...swell(0.8, 0.3, 0.1), timbre: makeCurve('timbre', 'ramp', { from: 0.7, to: 0.1 }) },
              14: { pitch: makeCurve('pitch', 'scoop', { depth: 2, end: 0.2 }), ...swell(0.9, 0.5, 0.5), timbre: flat(0.6) },
              16: { pitch: vibrato(0.3), ...swell(0.8, 0.5, 0.3) },
              23: { pitch: vibrato(0.3, 0.3), ...swell(0.7, 0.4, 0), timbre: makeCurve('timbre', 'ramp', { from: 0.5, to: 0 }) }
            })
          })
        },
        {
          name: 'Lead Tension', bars: 4, color: '#8f6cf0',
          notes: () => ({
            Lead: perform(melodyFromString('G5:4 Bb5:4 D6:8  E6:6 D6:2 C6:4 A5:4  E6:12 -:4  D6:16', { velocity: 0.85, gate: 0.95 }), {
              2: { pitch: vibrato(0.25), ...swell(0.8, 0.6, 0.4) },
              3: { pitch: makeCurve('pitch', 'scoop', { depth: 2, end: 0.2 }), ...swell(0.9, 0.5, 0.5) },
              7: { pitch: makeCurve('pitch', 'vibrato', { depth: 0.4, cycles: 7, delay: 0.25, fade: 0.3 }), ...swell(1, 0.6, 0.6), timbre: makeCurve('timbre', 'ramp', { from: 0.3, to: 1 }) },
              8: { pitch: vibrato(0.3, 0.4), pressure: makeCurve('pressure', 'ramp', { from: 0.8, to: 0 }), timbre: makeCurve('timbre', 'ramp', { from: 0.8, to: 0 }) }
            })
          })
        },
        {
          // the resolve: one chord held, pressure and slide letting go
          name: 'Resolve', bars: 4, color: '#9aa5b1',
          notes: (bar) => ({
            Pad: perform(chordProgressionNotes(['Dm9'], { chordLength: bar * 4, octave: 3, gate: 1, velocity: 0.55, voicing: 'open', center: 60 }), () => ({ pressure: makeCurve('pressure', 'ramp', { from: 0.6, to: 0 }) })),
            Atmos: perform([{ key: 74, start: 0, length: bar * 4, velocity: 0.5 }, { key: 81, start: 0, length: bar * 4, velocity: 0.45 }, { key: 88, start: bar, length: bar * 3, velocity: 0.4 }], () => ({ timbre: makeCurve('timbre', 'ramp', { from: 0.7, to: 0 }) })),
            Bass: perform([{ key: 38, start: 0, length: bar * 2, velocity: 0.8 }], () => ({ pitch: makeCurve('pitch', 'fall', { depth: 12, start: 0.7 }), pressure: makeCurve('pressure', 'ramp', { from: 0.4, to: 0 }) }))
          })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Build' }, { bar: 8, name: 'Theme' }, { bar: 16, name: 'Tension' }, { bar: 20, name: 'Resolve' }],
      arrangement: [
        { pattern: 'Pad', track: 0, bar: 0, bars: 16, trackName: 'Pad' },
        { pattern: 'Atmos', track: 1, bar: 0, bars: 20, trackName: 'Atmos' },
        { pattern: 'Arp', track: 2, bar: 4, bars: 12, trackName: 'Arp' },
        { pattern: 'Bass', track: 3, bar: 4, bars: 12, trackName: 'Bass' },
        { pattern: 'Pluck', track: 4, bar: 8, bars: 8, trackName: 'Pluck' },
        { pattern: 'Lead', track: 5, bar: 8, bars: 8, trackName: 'Lead' },
        { pattern: 'Pad Tension', track: 0, bar: 16, bars: 4 },
        { pattern: 'Arp Tension', track: 2, bar: 16, bars: 4 },
        { pattern: 'Bass Tension', track: 3, bar: 16, bars: 4 },
        { pattern: 'Lead Tension', track: 5, bar: 16, bars: 4 },
        { pattern: 'Resolve', track: 0, bar: 20, bars: 4 }
      ]
    };
  }
};
