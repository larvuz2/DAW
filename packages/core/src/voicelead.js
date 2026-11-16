// Voice leading: a whole progression voiced at once so that every voice moves as little as possible.
//
// Each chord gets every admissible voicing in the range (a bass, then the other voices above it); the path through
// them with the least total movement is found with dynamic programming (Viterbi), so a choice made for bar 1 already
// knows what bar 4 needs. Parallel fifths and octaves are penalised, doubled thirds and sevenths too.
import { readChord, mod12, isRest } from './harmony.js';

export const VOICE_LEAD_STYLES = ['close', 'open'];
export const BASS_RULES = ['root', 'smooth'];
const MAX_CANDIDATES = 320;

/** The tones of a chord by how much it needs them: root, third (or sus), seventh, sixth, tensions, fifth. */
function tonesByImportance(chord) {
  const iv = chord.intervals;
  const ordered = [0];
  const add = (x) => { if (x !== undefined && !ordered.includes(x % 12)) ordered.push(x % 12); };
  add(iv.find((i) => i === 3 || i === 4));
  add(iv.find((i) => i === 2 || i === 5));
  add(iv.find((i) => i === 10 || i === 11));
  add(iv.find((i) => i === 9));
  for (const i of [...iv].reverse()) if (i > 12) add(i);
  add(iv.find((i) => i === 7 || i === 6 || i === 8));
  for (const i of iv) add(i);
  return ordered;
}

/** Every admissible voicing of one chord: [{ notes (ascending), cost }]. */
function candidates(chord, { voices, low, high, style, bass }) {
  const ordered = tonesByImportance(chord);
  const bassPc = chord.bass ?? chord.root;
  const foreignBass = !chord.pcs.includes(bassPc);
  // when there are more tones than voices the least important ones are left out, and none of them may sneak back in
  const slots = bass === 'root' && foreignBass ? voices - 1 : voices;
  const required = ordered.slice(0, slots);
  const allowed = new Set(ordered.length > slots ? required : ordered);
  const [maxGap, maxSpan] = style === 'open' ? [12, 24] : voices >= 6 ? [9, 19] : [9, 12];
  const center = Math.floor((low + high) / 2);
  const rel = (p) => mod12(p - chord.root);
  const out = [];
  const stack = [];
  const emit = () => {
    const rels = stack.map(rel);
    if (!required.every((r) => rels.includes(r))) return;
    let cost = 0;
    for (let i = 0; i < stack.length; i++) {
      // a doubled root costs nothing, a doubled fifth little, a doubled third is heard, a doubled seventh or tension is wrong
      if (rels.filter((r) => r === rels[i]).length > 1) cost += rels[i] === 0 ? 0 : rels[i] >= 6 && rels[i] <= 8 ? 3 : rels[i] === 3 || rels[i] === 4 ? 10 : 30;
      if (i >= 2 && stack[i] - stack[i - 1] > 9) cost += 4;
    }
    if (stack.length >= 2 && stack[1] - stack[0] > 19) cost += 4;
    const mean = Math.trunc(stack.reduce((a, b) => a + b, 0) / stack.length);
    cost += Math.trunc(Math.abs(mean - center) / 2);
    out.push({ notes: [...stack], cost });
  };
  const extend = () => {
    if (stack.length === voices) { emit(); return; }
    const prev = stack[stack.length - 1];
    // the gap above the bass may be wide; the upper voices stay close to each other
    const gap = stack.length === 1 ? 24 : maxGap;
    const ceiling = stack.length >= 2 ? Math.min(stack[1] + maxSpan, high) : high;
    for (let p = prev + 1; p <= Math.min(prev + gap, ceiling); p++) {
      if (!allowed.has(rel(p))) continue;
      stack.push(p);
      extend();
      stack.pop();
    }
  };
  for (let b = low; b <= high; b++) {
    const fits = bass === 'root' ? mod12(b) === bassPc && b <= low + 19 : b <= low + 24 && (allowed.has(rel(b)) || (mod12(b) === bassPc && foreignBass));
    if (!fits) continue;
    stack.length = 0;
    stack.push(b);
    extend();
  }
  if (out.length > MAX_CANDIDATES) {
    // a wide range has thousands: keep the best placed, in the order they were found (so equal paths stay equal)
    const keep = new Set(out.map((c, i) => [c.cost, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).slice(0, MAX_CANDIDATES).map(([, i]) => i));
    return out.filter((_, i) => keep.has(i));
  }
  return out;
}

function transitionCost(a, b, avoidParallels) {
  let cost = 0;
  for (let i = 0; i < a.length; i++) cost += 10 * Math.abs(a[i] - b[i]);
  if (!avoidParallels) return cost;
  for (let i = 0; i < a.length; i++) {
    const moved = b[i] - a[i];
    if (!moved) continue;
    for (let j = i + 1; j < a.length; j++) {
      const before = (a[j] - a[i]) % 12;
      // two voices a fifth or an octave apart that move the same way and stay a fifth or an octave apart
      if ((before === 7 || before === 0) && (b[j] - b[i]) % 12 === before && Math.sign(moved) === Math.sign(b[j] - a[j])) cost += 30;
    }
  }
  return cost;
}

/**
 * Voice a progression with a fixed number of voices so that the voices move as little as possible.
 * chords: symbols or chords ("-" = a rest, which keeps its place in the answer as null).
 * opts: voices 3–6 (4), low/high = the range as MIDI notes (E2–G5), style 'close' (upper voices within an octave) or
 * 'open' (within two), bass 'root' (the bass plays the root or the slash bass) or 'smooth' (any chord tone, if that
 * moves less), avoidParallels (true).
 * → { voicings: [lowest voice first — voice i is the same line in every chord], movement: semitones moved into each
 * chord after the first, total }
 */
export function voiceLead(chords, { voices = 4, low = 40, high = 79, style = 'close', bass = 'root', avoidParallels = true, key = null, scale = null } = {}) {
  if (!Number.isInteger(voices) || voices < 3 || voices > 6) throw new Error(`voices must be 3–6, got ${voices}`);
  if (!VOICE_LEAD_STYLES.includes(style)) throw new Error(`Unknown voice-leading style "${style}". Use: ${VOICE_LEAD_STYLES.join(', ')}`);
  if (!BASS_RULES.includes(bass)) throw new Error(`Unknown bass rule "${bass}". Use: ${BASS_RULES.join(', ')}`);
  if (!(low >= 0 && high <= 127 && high - low >= 12)) throw new Error(`The range ${low}–${high} is too small: give at least an octave between low and high (MIDI 0–127)`);
  const ctx = key ? { key, scale: scale || 'major' } : null;
  const read = (chords || []).map((c) => (isRest(c) ? null : readChord(c, ctx)));
  const sounding = read.filter(Boolean);
  if (!sounding.length) return { voicings: read.map(() => null), movement: [], total: 0 };
  // the same chord has the same candidates, and the same pair of chords the same costs: a loop is solved once
  const layerOf = new Map();
  const layers = sounding.map((chord) => {
    const id = `${chord.root}:${chord.quality}:${chord.bass}`;
    if (!layerOf.has(id)) {
      const list = candidates(chord, { voices, low, high, style, bass });
      if (!list.length) throw new Error(`No ${voices}-voice voicing of ${chord.name} fits between MIDI ${low} and ${high}: widen the range or use fewer voices`);
      layerOf.set(id, { id, list });
    }
    return layerOf.get(id);
  });
  const pairCosts = new Map();
  const costsBetween = (a, b) => {
    const id = `${a.id}>${b.id}`;
    if (!pairCosts.has(id)) {
      const table = new Float64Array(a.list.length * b.list.length);
      for (let i = 0; i < a.list.length; i++) for (let j = 0; j < b.list.length; j++) table[i * b.list.length + j] = transitionCost(a.list[i].notes, b.list[j].notes, avoidParallels);
      pairCosts.set(id, table);
    }
    return pairCosts.get(id);
  };
  let cost = Float64Array.from(layers[0].list, (c) => c.cost * 4);
  const back = [];
  for (let t = 1; t < layers.length; t++) {
    const prev = layers[t - 1].list;
    const cur = layers[t].list;
    const table = costsBetween(layers[t - 1], layers[t]);
    const next = new Float64Array(cur.length).fill(Infinity);
    const from = new Int32Array(cur.length);
    for (let j = 0; j < cur.length; j++) {
      for (let i = 0; i < prev.length; i++) {
        const c = cost[i] + table[i * cur.length + j] + cur[j].cost;
        if (c < next[j]) { next[j] = c; from[j] = i; }
      }
    }
    cost = next;
    back.push(from);
  }
  let index = 0;
  for (let i = 1; i < cost.length; i++) if (cost[i] < cost[index]) index = i;
  const path = [index];
  for (let t = back.length - 1; t >= 0; t--) { index = back[t][index]; path.unshift(index); }
  const solved = path.map((i, t) => layers[t].list[i].notes);
  const movement = solved.slice(1).map((v, t) => v.reduce((sum, p, i) => sum + Math.abs(p - solved[t][i]), 0));
  let k = 0;
  return { voicings: read.map((c) => (c ? solved[k++] : null)), movement, total: movement.reduce((a, b) => a + b, 0) };
}
