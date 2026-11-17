// Voice leading: a whole progression voiced at once so that every voice moves as little as possible.
//
// Each chord gets every admissible voicing in the range (a bass, then the other voices above it); the path through
// them with the least total movement is found with dynamic programming (Viterbi), so a choice made for bar 1 already
// knows what bar 4 needs. Parallel fifths and octaves cost a great deal, doubled thirds and sevenths a little.
import { readChord, mod12, isRest } from './harmony.js';

export const VOICE_LEAD_STYLES = ['close', 'open'];
export const BASS_RULES = ['root', 'smooth'];
const MAX_CANDIDATES = 320;
const MIN_CANDIDATES = 32;
// How many pairs of voicings one call may weigh (every pair of neighbouring chords costs candidates² of them). A song
// of up to 15 different chord changes gets every candidate; a longer list of different chords gets fewer per chord,
// so that the search stays a fraction of a second whatever is asked (it runs on the server's only thread).
const PAIR_BUDGET = 1_600_000;
// What a parallel fifth or octave costs, in the currency of movement (10 a semitone): two voices would rather move
// twenty semitones more between them than run in parallel. It is a price, not a ban: measured over random diatonic
// progressions, three- and four-voice writing and five-voice sevenths come out without any, but five or six voices
// on plain triads keep some — in close position four upper voices within an octave must double a note at the
// octave, and two such chords in a row move those two voices together ("open" has the room to avoid it).
const PARALLEL = 200;

/** How many voicings of each chord a search over this many different chord changes weighs (see PAIR_BUDGET). */
export function voicingBudget(changes) {
  return Math.max(MIN_CANDIDATES, Math.min(MAX_CANDIDATES, Math.floor(Math.sqrt(PAIR_BUDGET / Math.max(1, changes)))));
}

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
function candidates(chord, { voices, low, high, style, bass, limit = MAX_CANDIDATES }) {
  const ordered = tonesByImportance(chord);
  const bassPc = chord.bass ?? chord.root;
  const foreignBass = !chord.pcs.includes(bassPc);
  // when there are more tones than voices the least important ones are left out, and none of them may sneak back in
  const slots = bass === 'root' && foreignBass ? voices - 1 : voices;
  const required = ordered.slice(0, slots);
  let allowed = 0;
  for (const r of ordered.length > slots ? required : ordered) allowed |= 1 << r;
  const [maxGap, maxSpan] = style === 'open' ? [12, 24] : voices >= 6 ? [9, 19] : [9, 12];
  const center = Math.floor((low + high) / 2);
  const root = mod12(chord.root);
  const rel = (p) => (p - root + 12) % 12;
  const out = [];
  const stack = [];
  const seen = new Int8Array(12);
  const emit = () => {
    seen.fill(0);
    for (let i = 0; i < stack.length; i++) seen[rel(stack[i])]++;
    let cost = 0;
    for (let i = 0; i < stack.length; i++) {
      const r = rel(stack[i]);
      // a doubled root costs nothing, a doubled fifth little, a doubled third is heard, a doubled seventh or tension is wrong
      if (seen[r] > 1) cost += r === 0 ? 0 : r >= 6 && r <= 8 ? 3 : r === 3 || r === 4 ? 10 : 30;
      if (i >= 2 && stack[i] - stack[i - 1] > 9) cost += 4;
    }
    if (stack.length >= 2 && stack[1] - stack[0] > 19) cost += 4;
    let sum = 0;
    for (let i = 0; i < stack.length; i++) sum += stack[i];
    cost += Math.trunc(Math.abs(Math.trunc(sum / stack.length) - center) / 2);
    out.push({ notes: [...stack], cost });
  };
  // the tones a voicing must have, as bits: a branch that can no longer fit them all in the voices left is dropped
  // at once (without this, a six-voice chord in a wide range walks tens of thousands of dead ends)
  let needed = 0;
  for (const r of required) needed |= 1 << r;
  const extend = (have) => {
    let missing = 0;
    for (let m = needed & ~have; m; m &= m - 1) missing++;
    if (missing > voices - stack.length) return;
    if (stack.length === voices) { emit(); return; }
    const prev = stack[stack.length - 1];
    // the gap above the bass may be wide; the upper voices stay close to each other
    const gap = stack.length === 1 ? 24 : maxGap;
    const ceiling = stack.length >= 2 ? Math.min(stack[1] + maxSpan, high) : high;
    for (let p = prev + 1; p <= Math.min(prev + gap, ceiling); p++) {
      const bit = 1 << ((p - root + 12) % 12);
      if (!(allowed & bit)) continue;
      stack.push(p);
      extend(have | bit);
      stack.pop();
    }
  };
  for (let b = low; b <= high; b++) {
    const fits = bass === 'root' ? mod12(b) === bassPc && b <= low + 19 : b <= low + 24 && ((allowed >> rel(b)) & 1 || (mod12(b) === bassPc && foreignBass));
    if (!fits) continue;
    stack.length = 0;
    stack.push(b);
    extend(1 << rel(b));
  }
  if (out.length > limit) {
    // a wide range has thousands: keep the best placed, in the order they were found (so equal paths stay equal)
    const keep = new Set(out.map((c, i) => [c.cost, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).slice(0, limit).map(([, i]) => i));
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
      if ((before === 7 || before === 0) && (b[j] - b[i]) % 12 === before && Math.sign(moved) === Math.sign(b[j] - a[j])) cost += PARALLEL;
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
  const idOf = (chord) => `${chord.root}:${chord.quality}:${chord.bass}`;
  const changes = new Set();
  for (let t = 1; t < sounding.length; t++) changes.add(`${idOf(sounding[t - 1])}>${idOf(sounding[t])}`);
  const limit = voicingBudget(changes.size);
  const layerOf = new Map();
  const layers = sounding.map((chord) => {
    const id = idOf(chord);
    if (!layerOf.has(id)) {
      const list = candidates(chord, { voices, low, high, style, bass, limit });
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
