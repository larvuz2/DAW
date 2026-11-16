// Pattern generators: an arpeggiator, Euclidean rhythms and drum grooves by style. Everything that varies takes a
// seed and gives the same notes for the same seed — a generator an agent (or a person) can call again and get the
// part it liked.
import { PPQ, STEP } from './constants.js';
import { createRng } from './rng.js';
import { didYouMean } from './suggest.js';

// ---------------------------------------------------------------------------------------------------------------
// Arpeggiator

export const ARP_MODES = ['up', 'down', 'updown', 'downup', 'converge', 'diverge', 'pinky', 'thumb', 'asplayed', 'random'];

/**
 * One cycle of an arpeggio over `pitches`, repeated over `octaves` (1–4):
 * up, down, updown / downup (no repeated end notes), converge (outside in), diverge (inside out), pinky (the top note
 * between all others), thumb (the bottom note between all others), asplayed (the order given), random (returned in
 * rising order: the arpeggiator draws from it).
 */
export function arpCycle(pitches, mode = 'up', octaves = 1) {
  if (!ARP_MODES.includes(mode)) throw new Error(`Unknown arpeggio mode "${mode}".${didYouMean(mode, ARP_MODES)} Use: ${ARP_MODES.join(', ')}`);
  let base = [...new Set(pitches || [])];
  if (mode !== 'asplayed') base.sort((a, b) => a - b);
  const notes = [];
  for (let o = 0; o < Math.min(4, Math.max(1, Math.round(octaves) || 1)); o++) for (const p of base) if (p + 12 * o <= 127) notes.push(p + 12 * o);
  const n = notes.length;
  if (n <= 1) return notes;
  base = notes;
  switch (mode) {
    case 'down': return [...base].reverse();
    case 'updown': return [...base, ...base.slice(1, -1).reverse()];
    case 'downup': return [...[...base].reverse(), ...base.slice(1, -1)];
    case 'converge': {
      const out = [];
      for (let lo = 0, hi = n - 1; lo <= hi; lo++, hi--) {
        out.push(base[lo]);
        if (lo !== hi) out.push(base[hi]);
      }
      return out;
    }
    case 'diverge': {
      const out = [];
      for (let lo = Math.floor((n - 1) / 2), hi = lo + 1; lo >= 0 || hi < n; lo--, hi++) {
        if (lo >= 0) out.push(base[lo]);
        if (hi < n) out.push(base[hi]);
      }
      return out;
    }
    case 'pinky': return base.slice(0, -1).flatMap((p) => [p, base[n - 1]]);
    case 'thumb': return base.slice(1).flatMap((p) => [base[0], p]);
    default: return base;
  }
}

/**
 * Arpeggiate chords. events: [{ pitches, start, length }] (ticks).
 * opts: mode, rate (ticks per note, default an 8th), gate (0.05–2: note length as a share of the rate), octaves,
 * velocity, accentEvery + accent (every n-th note louder by `accent`), velocities (a pattern that overrides both),
 * swing (0–0.95: every second note later by half that share of the rate), seed (for mode random).
 * A gate up to 1 never rings past its chord; above 1 the notes overlap (legato, pads).
 */
export function arpeggiate(events, {
  mode = 'up', rate = STEP * 2, gate = 0.8, octaves = 1, velocity = 0.8, accentEvery = 0, accent = 0.2, velocities = [], swing = 0, seed = 0
} = {}) {
  if (!(rate >= 1)) throw new Error('rate must be at least one tick');
  const g = Math.min(2, Math.max(0.05, gate));
  const length = Math.max(1, Math.round(rate * g));
  const late = Math.round(rate * Math.min(0.95, Math.max(0, swing)) * 0.5);
  const rng = createRng(seed);
  const out = [];
  for (const ev of events || []) {
    const cycle = arpCycle(ev.pitches, mode, octaves);
    if (!cycle.length) continue;
    let lastRandom = -1;
    for (let k = 0; k * rate < ev.length; k++) {
      let index = k % cycle.length;
      if (mode === 'random') {
        index = rng.below(cycle.length);
        // (never the same note twice in a row: that reads as a stuck key, not as chance)
        if (cycle.length > 1 && index === lastRandom) index = (index + 1 + rng.below(cycle.length - 1)) % cycle.length;
        lastRandom = index;
      }
      const start = Math.round(ev.start + k * rate + (k % 2 ? late : 0));
      const len = g <= 1 ? Math.max(1, Math.min(length, ev.start + ev.length - start)) : length;
      const v = velocities.length ? velocities[k % velocities.length] : velocity + (accentEvery > 0 && k % accentEvery === 0 ? accent : 0);
      out.push({ key: cycle[index], start, length: len, velocity: Math.round(Math.min(1, Math.max(0.01, v)) * 1000) / 1000 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Euclidean rhythms

/**
 * `pulses` hits spread as evenly as possible over `steps` (Bjorklund's algorithm), turned by `rotation` steps:
 * euclid(8, 3) = x--x--x- (tresillo), euclid(8, 5) = cinquillo, euclid(16, 5) = bossa nova, euclid(12, 7) = a West
 * African bell. → an array of booleans.
 */
export function euclid(steps, pulses, rotation = 0) {
  const n = Math.max(0, Math.round(steps) || 0);
  if (!n) return [];
  const k = Math.min(n, Math.max(0, Math.round(pulses) || 0));
  let a = Array.from({ length: k }, () => [true]);
  let b = Array.from({ length: n - k }, () => [false]);
  while (b.length > 1 && a.length) {
    const m = Math.min(a.length, b.length);
    const merged = [];
    for (let i = 0; i < m; i++) merged.push([...a[i], ...b[i]]);
    const rest = a.length > m ? a.slice(m) : b.slice(m);
    a = merged;
    b = rest;
  }
  const flat = [...a, ...b].flat();
  const r = Math.round(rotation) || 0;
  return flat.map((_, i) => flat[(((i + r) % n) + n) % n]);
}

/** A rhythm as a step string: hits "x" (or "X" on accented steps), rests "-". */
export function euclidString(steps, pulses, rotation = 0, { accentFirst = false } = {}) {
  let first = true;
  return euclid(steps, pulses, rotation).map((hit) => {
    if (!hit) return '-';
    const ch = accentFirst && first ? 'X' : 'x';
    first = false;
    return ch;
  }).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Drum grooves

export const DRUM_ROLES = ['kick', 'snare', 'clap', 'hat', 'openhat', 'perc', 'tom'];

// One bar of 16 steps per lane (two bars where the string is 32 long; shuffle counts 12 steps = triplets).
// X = accent, x = hit, o = ghost. `swing` is the feel the style is known for.
const STYLES = {
  fourOnFloor: { label: 'Four on the floor', swing: 0, lanes: { kick: 'X...X...X...X...', clap: '....X.......X...', hat: '..x...x...x...x.' } },
  house: { label: 'House', swing: 0, lanes: { kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hat: 'xo.oxo.oxo.oxo.o' } },
  techno: { label: 'Techno', swing: 0, lanes: { kick: 'X...X...X...X...', clap: '....x.......x...', openhat: '..x...x...x...x.', hat: 'o.ooo.ooo.ooo.oo', perc: '...x..x...x..x..' } },
  backbeat: { label: 'Backbeat (rock/pop)', swing: 0, lanes: { kick: 'X.......X.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' } },
  halftime: { label: 'Half-time', swing: 0, lanes: { kick: 'X.........x.....', snare: '........X.......', hat: 'x.x.x.x.x.x.x.x.' } },
  breakbeat: { label: 'Breakbeat', swing: 0, lanes: { kick: 'X.x.......xx....', snare: '....X..o.o..X..o', hat: 'x.x.x.x.x.x.x.x.', openhat: '..............x.' } },
  boomBap: { label: 'Boom bap', swing: 0.3, lanes: { kick: 'X......x..x.....', snare: '....X..o....X...', hat: 'x.x.x.x.x.x.x.x.' } },
  trap: { label: 'Trap', swing: 0, lanes: { kick: 'X.....x...x.....', clap: '........X.......', hat: 'x.x.x.x.x.x.x.x.', openhat: '......x.........' } },
  dnb: { label: 'Drum & bass', swing: 0, lanes: { kick: 'X.........x.....', snare: '....X..o.o..X...', hat: 'x.x.x.x.x.x.x.x.' } },
  twoStep: { label: '2-step garage', swing: 0.35, lanes: { kick: 'X......x..x.....', snare: '....X.......X...', hat: '..x...x...x...x.', perc: '.......x.....x..' } },
  shuffle: { label: 'Shuffle (12/8 feel)', swing: 0, steps: 12, lanes: { kick: 'X.....X.....', snare: '...X.....X..', hat: 'x.xx.xx.xx.x' } },
  reggaeton: { label: 'Reggaeton (dembow)', swing: 0, lanes: { kick: 'X...X...X...X...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.' } },
  bossaNova: { label: 'Bossa nova', swing: 0, lanes: { kick: 'X.....x.X.....x.', perc: 'x..x..x...x..x..', hat: 'x.x.x.x.x.x.x.x.' } },
  synthwave: { label: 'Synthwave', swing: 0, lanes: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'XoxoXoxoXoxoXoxo', tom: '..............................xx' } },
  lofi: { label: 'Lo-fi', swing: 0.25, lanes: { kick: 'X.....x...X..x..', snare: '....X..o....X...', hat: 'x.x.x.x.x.x.xox.' } },
  sparseCinematic: { label: 'Sparse cinematic', swing: 0, lanes: { kick: 'X...............X.........x.....', tom: '............................x.x.', perc: '......o.................o.......' } }
};
export const DRUM_STYLES = Object.keys(STYLES);
/** Style id → { label, swing, roles }. */
export const DRUM_STYLE_INFO = Object.fromEntries(Object.entries(STYLES).map(([id, s]) => [id, { label: s.label, swing: s.swing, roles: Object.keys(s.lanes) }]));

const HIT = { X: 1, x: 0.8, o: 0.45 };

/**
 * A drum groove in a style: [{ role, tick, velocity }] for `bars` bars of 4/4, sorted by time.
 * opts: swing (default: the style's own), variation 0–1 (seeded: hats dropped or ghosted in, ghost snares, small
 * velocity moves — 0 is the plain pattern), fill (the last quarter of the last bar becomes a fill; the kick stays),
 * seed. Roles: kick, snare, clap, hat, openhat, perc, tom.
 */
export function drumPattern(style, { bars = 1, swing = null, variation = 0, fill = false, seed = 0 } = {}) {
  const def = STYLES[style];
  if (!def) throw new Error(`Unknown drum style "${style}".${didYouMean(style, DRUM_STYLES)} Styles: ${DRUM_STYLES.join(', ')}`);
  const count = Math.max(1, Math.round(bars) || 1);
  const bar = PPQ * 4;
  const perBar = def.steps || 16;
  const step = bar / perBar;
  const late = Math.round(step * Math.min(0.95, Math.max(0, swing ?? def.swing)) * 0.5);
  const vary = Math.min(1, Math.max(0, variation));
  const rng = createRng(seed);
  const hits = [];
  for (let b = 0; b < count; b++) {
    const lastBar = b === count - 1;
    for (const [role, pattern] of Object.entries(def.lanes)) {
      const offset = (b % Math.max(1, Math.floor(pattern.length / perBar))) * perBar;
      for (let s = 0; s < perBar; s++) {
        if (fill && lastBar && s >= (perBar * 3) / 4 && role !== 'kick') continue;
        let velocity = HIT[pattern[offset + s]] || 0;
        if (vary > 0) {
          const roll = rng.unit();
          const light = role === 'hat' || role === 'perc';
          if (velocity > 0 && light && roll < 0.15 * vary) velocity = 0;
          else if (velocity === 0 && role === 'snare' && roll < 0.1 * vary) velocity = 0.35;
          else if (velocity === 0 && light && roll < 0.08 * vary) velocity = 0.4;
          else if (velocity > 0) velocity = Math.min(1, Math.max(0.2, velocity + (roll - 0.5) * 0.2 * vary));
        }
        if (velocity > 0) hits.push({ role, tick: b * bar + s * step + (s % 2 ? late : 0), velocity });
      }
    }
    if (style === 'trap') {
      // the 32nd-note hat roll into beat 4 that the style is known for, and (seeded) more of them
      const rolls = [10];
      if (vary > 0 && rng.unit() < vary) rolls.push([2, 6, 14][rng.below(3)]);
      for (const start of rolls) {
        if (fill && lastBar && start >= 12) continue;
        for (let i = 1; i < 4; i++) hits.push({ role: 'hat', tick: b * bar + start * step + (i * step) / 2, velocity: 0.5 + 0.08 * i });
      }
    }
    if (fill && lastBar) {
      const shape = rng.below(3);
      const base = (perBar * 3) / 4;
      const n = perBar - base;
      for (let i = 0; i < n; i++) {
        const role = shape === 0 ? 'snare' : shape === 1 ? 'tom' : i < n / 2 ? 'snare' : 'tom';
        hits.push({ role, tick: b * bar + (base + i) * step, velocity: 0.6 + (0.4 * (i + 1)) / n });
      }
    }
  }
  for (const h of hits) {
    h.tick = Math.round(h.tick);
    h.velocity = Math.round(Math.min(1, Math.max(0.01, h.velocity)) * 1000) / 1000;
  }
  return hits.sort((x, y) => x.tick - y.tick || DRUM_ROLES.indexOf(x.role) - DRUM_ROLES.indexOf(y.role));
}
