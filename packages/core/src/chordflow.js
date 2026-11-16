// Harmony, the proposing half: what chord could come next, what could stand in for a chord, how to get to another
// key — and a library of progressions people actually use.
//
// Suggestions rank candidate chords by how tonal progressions usually move. The tables are judgements distilled from
// common practice and pop/jazz usage, not laws; every answer carries its reason, so the choice stays with the writer.
import { SCALES, romanToChord, requireScale, scaleSpelling } from './music.js';
import {
  mod12, keyContext, makeChord, readChord, numeralFor, functionOf, analyzeChord, chordTension, parallelModes, stackedChord, spellInKey,
  isDominantQuality, detectChords, isRest
} from './harmony.js';
import { PROGRESSIONS } from './progressions.js';
import { nearest } from './suggest.js';

const round3 = (x) => Math.round(x * 1000) / 1000;
const DIMINISHED = new Set(['dim', 'dim7', 'm7b5']);

// How readily a chord on one degree moves to a chord on another (row = from, column = to; degrees I…VII).
const MAJOR_FLOW = [
  [0.15, 0.55, 0.45, 0.90, 0.90, 0.75, 0.25],
  [0.35, 0.15, 0.30, 0.40, 1.00, 0.40, 0.55],
  [0.30, 0.45, 0.15, 0.75, 0.35, 0.90, 0.15],
  [0.80, 0.60, 0.35, 0.15, 0.95, 0.50, 0.40],
  [1.00, 0.25, 0.30, 0.50, 0.15, 0.80, 0.20],
  [0.40, 0.85, 0.45, 0.85, 0.65, 0.15, 0.25],
  [0.95, 0.15, 0.60, 0.20, 0.40, 0.45, 0.15]
];
const MINOR_FLOW = [
  [0.15, 0.45, 0.65, 0.85, 0.80, 0.85, 0.80],
  [0.35, 0.15, 0.30, 0.35, 1.00, 0.30, 0.45],
  [0.45, 0.35, 0.15, 0.70, 0.40, 0.85, 0.75],
  [0.80, 0.50, 0.45, 0.15, 0.95, 0.55, 0.70],
  [0.95, 0.20, 0.40, 0.55, 0.15, 0.80, 0.45],
  [0.60, 0.60, 0.75, 0.70, 0.75, 0.15, 0.90],
  [0.85, 0.15, 0.95, 0.40, 0.45, 0.60, 0.15]
];
// …and between functions, for chords whose roots are outside the scale
const FUNCTION_FLOW = {
  tonic: { tonic: 0.55, subdominant: 0.85, dominant: 0.8 },
  subdominant: { tonic: 0.75, subdominant: 0.55, dominant: 0.95 },
  dominant: { tonic: 1.0, subdominant: 0.35, dominant: 0.5 }
};
// How strong a root movement is, by the interval the root rises (5 = up a fourth = down a fifth, the strongest).
const ROOT_MOTION = [0.2, 0.5, 0.7, 0.45, 0.45, 1.0, 0.25, 0.55, 0.6, 0.65, 0.6, 0.55];
const ROOT_WORDS = ['the root stays', 'the root rises a semitone', 'the root steps up', 'roots a minor third apart', 'roots a major third apart', 'the root falls a fifth', 'roots a tritone apart', 'the root rises a fifth', 'roots a major third apart', 'roots a minor third apart', 'the root steps down', 'the root falls a semitone'];
// Where progressions like to begin, by degree.
const START = [1.0, 0.5, 0.35, 0.65, 0.45, 0.7, 0.2];

const TIER = { diatonic: 1, borrowed: 0.9, chromatic: 0.82 };
export const SUGGESTION_POOLS = Object.keys(TIER);

const sameChord = (a, b) => a.root === b.root && a.quality === b.quality;
const triadOf = (c) => (c.intervals.includes(3) && !c.intervals.includes(4) ? (c.intervals.includes(6) && !c.intervals.includes(7) ? 'd' : 'm') : 'M');

/** Semitones the notes of one chord move, on average, to reach the nearest notes of another. */
function movement(a, b) {
  const nearestTo = (pc, pcs) => Math.min(...pcs.map((q) => { const d = mod12(pc - q); return Math.min(d, 12 - d); }));
  const there = b.pcs.reduce((sum, p) => sum + nearestTo(p, a.pcs), 0) / b.pcs.length;
  const back = a.pcs.reduce((sum, p) => sum + nearestTo(p, b.pcs), 0) / a.pcs.length;
  return (there + back) / 2;
}

function flow(last, cand, ctx) {
  // resolutions that work in any key: a dominant seventh to the chord a fifth below, a tritone substitute sliding
  // down a semitone, a diminished chord stepping up into its target
  if (isDominantQuality(last) && mod12(last.root - cand.root) === 7) return 1;
  if (isDominantQuality(last) && mod12(last.root - cand.root) === 1) return 0.95;
  if (DIMINISHED.has(last.quality) && last.quality !== 'm7b5' && mod12(cand.root - last.root) === 1) return 0.95;
  const a = ctx.degrees.indexOf(mod12(last.root - ctx.tonic));
  const b = ctx.degrees.indexOf(mod12(cand.root - ctx.tonic));
  // The tables describe the key's own chords. Another chord on the same degree (Cm or C7 where the key has C), or a
  // chord on a root outside the scale, inherits most of that pull, not all of it.
  const own = cand.pcs.every((p) => ctx.pcs.has(p));
  if (a >= 0 && b >= 0) return (ctx.minor ? MINOR_FLOW : MAJOR_FLOW)[a][b] * (own || home(cand, ctx) ? 1 : FOREIGN);
  return (FUNCTION_FLOW[functionOf(last, ctx)]?.[functionOf(cand, ctx)] ?? 0.45) * FOREIGN;
}

const FOREIGN = 0.75;
/** The major V (and V7) and the leading-tone chord of a minor key: borrowed on paper, at home in every minor piece. */
function home(chord, ctx) {
  if (!ctx.minor) return false;
  const off = mod12(chord.root - ctx.tonic);
  return (off === 7 && chord.intervals.includes(4) && !chord.intervals.includes(11)) || (off === 11 && DIMINISHED.has(chord.quality));
}

/** The chords that could follow in a key, and where each was found: Map "root:quality" → { chord, found, from }. */
function candidates(ctx, last, pools, sevenths) {
  const out = new Map();
  const add = (chord, found, from = null) => {
    const id = `${chord.root}:${chord.quality}`;
    if (!out.has(id)) out.set(id, { chord, found, from });
  };
  const inKey = (c) => c.pcs.every((p) => ctx.pcs.has(p));
  for (let d = 0; d < 7; d++) {
    const triad = stackedChord(ctx, d, sevenths) || stackedChord(ctx, d);
    if (triad) add(triad, 'diatonic');
  }
  const five = (ctx.tonic + 7) % 12;
  const spell = scaleSpelling(ctx.key, ctx.scale);
  // the dominant seventh — in minor keys the one with the leading tone, which every minor piece borrows without a thought
  if (ctx.degrees.includes(7)) {
    if (ctx.minor) add(makeChord(five, '', null, spell(five)), 'diatonic');
    add(makeChord(five, '7', null, spell(five)), 'diatonic');
  }
  if (pools.includes('borrowed')) {
    for (const mode of parallelModes(ctx).common.slice(0, 5)) {
      for (let d = 0; d < 7; d++) {
        const chord = stackedChord(mode, d, sevenths) || stackedChord(mode, d);
        if (!chord || inKey(chord) || chord.quality === 'aug' || chord.quality === '(b5)' || chord.quality === 'maj7#5') continue;
        // of the diminished chords other modes offer, only the ii° of minor and a minor key's leading-tone chord are in use
        if (DIMINISHED.has(chord.quality) && d !== 1 && !home(chord, ctx)) continue;
        add(spellInKey(chord, ctx), 'borrowed', mode.label);
      }
    }
  }
  if (pools.includes('chromatic')) {
    for (let d = 1; d < 7; d++) {
      const target = stackedChord(ctx, d);
      if (!target || (target.quality !== '' && target.quality !== 'm')) continue;
      const dominant = makeChord(target.root + 7, '7');
      if (!inKey(dominant)) add(spellInKey(dominant, ctx), 'chromatic', `V7 of ${numeralFor(target, ctx)}`);
    }
    add(spellInKey(makeChord(ctx.tonic + 1, '7'), ctx), 'chromatic', 'tritone substitute');
    add(spellInKey(makeChord(ctx.tonic + 6, 'dim7'), ctx), 'chromatic', 'passing diminished');
    if (last && (last.quality === '' || last.quality === 'm')) {
      for (const step of [3, 4, 8, 9]) {
        for (const quality of ['', 'm']) {
          const mediant = makeChord(last.root + step, quality);
          if (!inKey(mediant)) add(spellInKey(mediant, ctx), 'chromatic', 'chromatic mediant');
        }
      }
    }
  }
  return out;
}

/** A sentence on why a chord follows another. */
function reason(last, cand, entry, info, ctx) {
  const bits = [];
  const tonicChord = (c) => c.root === ctx.tonic && functionOf(c, ctx) === 'tonic';
  if (!last) bits.push(tonicChord(cand) ? 'home: the clearest place to start' : `a ${info.function} chord to start away from home`);
  else {
    const up = mod12(cand.root - last.root);
    const from = functionOf(last, ctx);
    const to = info.function;
    const lastOff = mod12(last.root - ctx.tonic);
    const candOff = mod12(cand.root - ctx.tonic);
    if (sameChord(last, cand)) bits.push('the same chord again');
    else if (isDominantQuality(last) && up === 5 && !tonicChord(cand)) bits.push(`${last.name} is its dominant: this is where it resolves`);
    else if (lastOff === 7 && tonicChord(cand)) bits.push('authentic cadence: the dominant resolves home');
    else if (lastOff === 7 && from === 'dominant' && candOff === (ctx.minor ? 8 : 9)) bits.push('deceptive cadence: the dominant lands beside home instead of on it');
    else if (lastOff === 5 && tonicChord(cand)) bits.push('plagal cadence (the "amen"): home without a dominant');
    else if (lastOff === 2 && candOff === 7) bits.push('ii–V: the strongest way into the dominant');
    else if (isDominantQuality(last) && up === 11) bits.push(`${last.name} slides down a semitone into it (tritone-substitute resolution)`);
    else if (DIMINISHED.has(last.quality) && up === 1) bits.push(`${last.name} leads up a semitone into it`);
    else if (from === 'tonic' && to === 'subdominant') bits.push('leaves home for the subdominant side');
    else if (from === 'tonic' && to === 'dominant') bits.push('goes straight from rest to tension');
    else if (from === 'subdominant' && to === 'dominant') bits.push('the subdominant leans into the dominant: the cadence builds');
    else if (from === 'subdominant' && to === 'tonic') bits.push('falls back home without a dominant (plagal motion)');
    else if (from === 'dominant' && to === 'tonic') bits.push('the tension resolves');
    else if (from === 'dominant' && to === 'subdominant') bits.push('backs away from the resolution (a retrogression: softer, rock and blues)');
    else if (from === to) bits.push(`stays on the ${to} side with a new root`);
    if (!sameChord(last, cand) && !bits.some((b) => /cadence|ii–V|semitone/.test(b))) bits.push(ROOT_WORDS[up]);
  }
  if (info.kind === 'secondary dominant') bits.push(`a secondary dominant: expect ${info.secondaryOf} next`);
  else if (info.kind === 'applied diminished') bits.push(entry.from === 'passing diminished' ? 'a passing diminished chord: it climbs into V' : `a leading-tone chord: it climbs into ${info.secondaryOf}`);
  else if (info.kind === 'tritone substitute') bits.push(`a tritone substitute: it slides down a semitone into ${info.secondaryOf}`);
  else if (entry.from === 'chromatic mediant') bits.push('a chromatic mediant: a cinematic shift that keeps a note in common');
  else if (info.kind === 'borrowed' && !home(cand, ctx)) bits.push(`borrowed from ${info.borrowedFrom}`);
  return bits.join('; ');
}

/** The library's progressions as sequences of (root above the tonic, kind of triad), for matching what was written. */
let librarySigs = null;
function signatures() {
  if (!librarySigs) {
    librarySigs = PROGRESSIONS.map((p) => {
      const ctx = keyContext('C', p.scale);
      return { p, minor: ctx.minor, sig: p.numerals.map((n) => { const c = readChord(n, ctx); return `${c.root}${triadOf(c)}`; }) };
    });
  }
  return librarySigs;
}
const sigOf = (chord, ctx) => `${mod12(chord.root - ctx.tonic)}${triadOf(chord)}`;

/** What the library's loops play after the last chords of a progression: Map signature → { name, matched }. */
function continuations(chords, ctx) {
  const out = new Map();
  if (chords.length < 2) return out;
  for (const { p, minor, sig } of signatures()) {
    if (minor !== ctx.minor || sig.length < 3) continue;
    for (let k = Math.min(3, chords.length, sig.length - 1); k >= 2; k--) {
      const tail = chords.slice(-k).map((c) => sigOf(c, ctx));
      for (let i = 0; i < sig.length; i++) {
        if (!tail.every((t, j) => sig[(i + j) % sig.length] === t)) continue;
        const next = sig[(i + k) % sig.length];
        const had = out.get(next);
        if (!had || had.matched < k) out.set(next, { name: p.name, matched: k });
      }
    }
  }
  return out;
}

/**
 * Chords that could come next, best first.
 * progression: the chords so far (symbols or roman numerals; may be empty).
 * opts.count (8), opts.pools (which kinds: 'diatonic', 'borrowed' = from parallel modes, 'chromatic' = secondary
 * dominants, tritone substitute, passing diminished, chromatic mediants; default all), opts.sevenths (seventh chords
 * instead of triads), opts.smooth (weigh close voice leading above functional movement).
 * → [{ chord, numeral, function, kind, pool, score 0–1, tension, why }]
 *
 * score = (0.50·flow + 0.15·voice + 0.10·common + 0.25·root) × tier × repeat (+ a bonus when a well-known loop
 * continues this way): flow = how readily the last chord's degree or function moves there; voice = how little the
 * notes move; common = shared notes; root = strength of the root movement; tier = 1 in the key, 0.9 borrowed, 0.82
 * chromatic; repeat = 0.25 for the chord just played, 0.85 for one of the two before it.
 */
export function suggestNext(progression, key, scale, { count = 8, pools = SUGGESTION_POOLS, sevenths = false, smooth = false } = {}) {
  const ctx = keyContext(key, scale);
  for (const pool of pools) if (!TIER[pool]) throw new Error(`Unknown pool "${pool}". Use: ${SUGGESTION_POOLS.join(', ')}`);
  const played = (progression || []).filter((c) => !isRest(c)).map((c) => readChord(c, ctx));
  const last = played[played.length - 1] || null;
  const loops = continuations(played, ctx);
  const weights = smooth ? [0.3, 0.4, 0.2, 0.1] : [0.5, 0.15, 0.1, 0.25];
  const scored = [];
  for (const entry of candidates(ctx, last, pools, sevenths).values()) {
    const cand = entry.chord;
    const info = analyzeChord(cand, ctx);
    // a chord counts as what it reads as, wherever it was found (the II of lydian is the dominant of V)
    const pool = info.kind === 'diatonic' || home(cand, ctx) ? 'diatonic' : info.kind === 'borrowed' ? 'borrowed' : 'chromatic';
    if (!pools.includes(pool)) continue;
    const tier = TIER[pool];
    let score;
    if (!last) {
      // a piece rarely opens on a chord from outside its key
      const d = ctx.degrees.indexOf(mod12(cand.root - ctx.tonic));
      score = (d >= 0 ? START[d] : 0.2) * (pool === 'diatonic' ? 1 : 0.6 * tier);
    } else {
      const voice = Math.max(0, 1 - movement(last, cand) / 2);
      const common = cand.pcs.filter((p) => last.pcs.includes(p)).length / Math.min(cand.pcs.length, last.pcs.length);
      const repeat = sameChord(cand, last) ? 0.25 : played.slice(-3, -1).some((c) => sameChord(c, cand)) ? 0.85 : 1;
      score = (weights[0] * flow(last, cand, ctx) + weights[1] * voice + weights[2] * common + weights[3] * ROOT_MOTION[mod12(cand.root - last.root)]) * tier * repeat;
    }
    let why = reason(last, cand, entry, info, ctx);
    const loop = last && !sameChord(cand, last) ? loops.get(sigOf(cand, ctx)) : null;
    if (loop) {
      score = Math.min(1, score + 0.05 * loop.matched);
      why += `; continues "${loop.name}"`;
    }
    scored.push({ chord: cand.name, numeral: info.numeral, function: info.function, kind: info.kind, pool, score: round3(score), tension: chordTension(cand, ctx).tension, why });
  }
  scored.sort((a, b) => b.score - a.score || a.tension - b.tension || a.chord.localeCompare(b.chord));
  return scored.slice(0, Math.max(1, count));
}

// ---------------------------------------------------------------------------------------------------------------
// Substitutions

const NEO = {
  // the three moves that change one note of a triad, and what a major / a minor triad becomes: [root shift, quality]
  P: { '': [0, 'm'], m: [0, ''] },
  R: { '': [9, 'm'], m: [3, ''] },
  L: { '': [4, 'm'], m: [8, ''] }
};

/** Apply neo-Riemannian moves to a major or minor triad: "P", "L", "R" or a chain such as "PLR" (applied left to right). */
export function neoRiemannian(chordIn, moves = 'P') {
  let chord = readChord(chordIn);
  for (const move of String(moves).toUpperCase()) {
    const step = NEO[move]?.[chord.quality];
    if (!step) throw new Error(NEO[move] ? `Neo-Riemannian moves work on major and minor triads, not on ${chord.name}` : `Unknown move "${move}": use P (parallel), L (leading-tone exchange) and R (relative), alone or chained`);
    chord = makeChord(chord.root + step[0], step[1]);
  }
  return chord;
}

/**
 * Chords that could stand in for a chord in a key, or colour it:
 * → [{ chord, numeral, kind, why }] — kinds: 'tritone substitute', 'relative', 'borrowed', 'approach' (a chord to put
 * before it), 'neo-riemannian', 'chromatic mediant', 'extension'.
 */
export function substitutions(chordIn, key, scale) {
  const ctx = keyContext(key, scale);
  const chord = readChord(chordIn, ctx);
  const out = [];
  const seen = new Set([`${chord.root}:${chord.quality}`]);
  const add = (c, kind, why) => {
    const id = `${c.root}:${c.quality}`;
    if (seen.has(id)) return;
    seen.add(id);
    const named = spellInKey(c, ctx);
    out.push({ chord: named.name, numeral: analyzeChord(named, ctx).numeral, kind, why });
  };
  const fn = functionOf(chord, ctx);
  if (isDominantQuality(chord)) add(makeChord(chord.root + 6, '7'), 'tritone substitute', `shares the tritone of ${chord.name} (its 3rd and 7th swap roles) and resolves by a semitone instead of a fifth`);
  // same function, two notes in common
  for (let d = 0; d < 7; d++) {
    const other = stackedChord(ctx, d);
    if (!other || other.root === chord.root) continue;
    const shared = other.pcs.filter((p) => chord.pcs.includes(p)).length;
    if (shared >= 2 && functionOf(other, ctx) === fn) add(other, 'relative', `the same ${fn} function with ${shared} notes in common: a softer or darker way to say it`);
  }
  // the same degree in the parallel modes
  for (const mode of parallelModes(ctx).common.slice(0, 4)) {
    for (let d = 0; d < 7; d++) {
      const other = stackedChord(mode, d);
      if (!other || other.quality === 'aug' || other.quality === '(b5)') continue;
      if (other.root === chord.root && other.quality !== chord.quality && !other.pcs.every((p) => ctx.pcs.has(p))) add(other, 'borrowed', `the same degree as ${mode.label} has it (modal mixture)`);
    }
  }
  if (chord.quality === '' || chord.quality === 'm') {
    for (const [move, name] of [['P', 'parallel'], ['R', 'relative'], ['L', 'leading-tone exchange']]) {
      add(neoRiemannian(chord, move), 'neo-riemannian', `${move} (${name}): one note moves by a step, two stay`);
    }
    for (const [moves, name] of [['RLP', 'Nebenverwandt'], ['LPR', 'slide'], ['LPL', 'hexatonic pole']]) {
      add(neoRiemannian(chord, moves), 'neo-riemannian', `${name} (${moves}): a distant triad reached by three single-note moves — film-score colour`);
    }
    for (const step of [3, 4, 8, 9]) add(makeChord(chord.root + step, chord.quality), 'chromatic mediant', 'a third away with the same quality: an unprepared shift of colour');
  }
  // chords to put in front of it
  if (chord.quality === '' || chord.quality === 'm' || chord.intervals.includes(7)) {
    add(makeChord(chord.root + 7, '7'), 'approach', `its own dominant: play it just before ${chord.name} to pull into it`);
    add(makeChord(chord.root + 11, 'dim7'), 'approach', `the diminished chord a semitone below: play it just before ${chord.name} to lead up into it`);
    add(makeChord(chord.root + 1, '7'), 'approach', `the dominant a semitone above: play it just before ${chord.name} to slide down into it`);
  }
  // richer versions of the same chord
  const richer = { '': ['maj7', '6', 'add9', 'sus2', 'sus4'], m: ['m7', 'm9', 'm6', 'madd9', 'm11'], 7: ['9', '13', '7b9', '7#9', '7sus4'], maj7: ['maj9', '6/9', 'maj7#11'], m7: ['m9', 'm11', 'm6'] }[chord.quality] || [];
  for (const quality of richer) {
    const c = makeChord(chord.root, quality, null, chord.rootName);
    const outside = c.pcs.filter((p) => !ctx.pcs.has(p)).length;
    if (!seen.has(`${c.root}:${c.quality}`)) {
      seen.add(`${c.root}:${c.quality}`);
      out.push({ chord: c.name, numeral: numeralFor(c, ctx), kind: 'extension', why: outside ? `the same chord with more colour (${outside} note${outside > 1 ? 's' : ''} from outside the key)` : 'the same chord with more colour, all of it from the key' });
    }
  }
  return out;
}

/**
 * Negative harmony: every note mirrored around the axis between the tonic and its fifth (in C: between Eb and E),
 * which turns major into minor and a dominant pull into a plagal one. → [{ chord, mirrored, notes }]
 */
export function negativeHarmony(chords, key, scale = 'major') {
  const ctx = keyContext(key, scale);
  const axis = 2 * ctx.tonic + 7;
  const spell = scaleSpelling(ctx.key, ctx.minor ? 'major' : 'minor');
  return (chords || []).filter((c) => !isRest(c)).map((c) => {
    const chord = readChord(c, ctx);
    const pcs = chord.pcs.map((p) => mod12(axis - p));
    // The mirror turns a chord upside down: its fifth becomes the root of the new chord (G7 → Fm6, not the Dm7b5 the
    // same notes also spell). Name the mirrored notes over that root; failing that, the best reading in root position.
    const fifth = chord.intervals.find((i) => i === 7) ?? chord.intervals.find((i) => i === 6 || i === 8);
    const wanted = fifth === undefined ? null : mod12(axis - (chord.root + fifth));
    let best = null;
    for (const bass of pcs) {
      const pitches = [48 + bass, ...pcs.filter((p) => p !== bass).map((p) => 60 + p)];
      const found = detectChords(pitches, { spell }).find((x) => x.bass === x.root);
      if (!found) continue;
      const prefer = (x) => (x.root === wanted ? 1 : 0);
      if (!best || prefer(found) > prefer(best) || (prefer(found) === prefer(best) && found.score > best.score)) best = found;
    }
    return { chord: chord.name, mirrored: best ? best.name : pcs.map(spell).join(' '), notes: pcs.map(spell) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Modulation

/**
 * Ways from one key to another, best first: [{ kind, chords, roles, pivot, why, score }].
 * kinds: 'pivot chord' (a triad both keys have, then V7–I of the new key), 'borrowed pivot' (in one key, a mixture
 * chord of the other — what connects distant keys), 'dominant preparation' (the new V7, or ii–V, straight in),
 * 'common tone' (hold a shared note between the two tonic chords), 'leading-tone diminished', 'direct'.
 */
export function modulationPaths(fromKey, fromScale, toKey, toScale, { count = 6 } = {}) {
  const from = keyContext(fromKey, fromScale);
  const to = keyContext(toKey, toScale);
  if (from.tonic === to.tonic && from.parent === to.parent) throw new Error(`${from.label} and ${to.label} are the same key: give two different keys, e.g. C major and E major`);
  const tonic = (ctx) => makeChord(ctx.tonic, ctx.minor ? 'm' : '', null, ctx.key);
  const old = tonic(from);
  const home = tonic(to);
  const toSpell = scaleSpelling(to.key, to.scale);
  const dominant = makeChord(to.tonic + 7, '7', null, toSpell((to.tonic + 7) % 12));
  const paths = [];
  const roleOld = `${numeralFor(old, from)} in ${from.label} (the old home)`;
  const roleNew = `${numeralFor(home, to)} in ${to.label} (the new home)`;
  const roleDom = `V7 in ${to.label}`;
  for (let d = 1; d < 7; d++) {
    const chord = stackedChord(from, d);
    if (!chord || !chord.intervals.includes(7) || sameChord(chord, home)) continue;
    const reading = analyzeChord(chord, to);
    if (reading.kind !== 'diatonic' && reading.kind !== 'borrowed') continue;
    const byFunction = reading.function === 'subdominant' ? 0.9 : reading.function === 'tonic' ? 0.8 : 0.65;
    const mixture = reading.kind === 'diatonic' ? 1 : /(major|minor)$/.test(reading.borrowedFrom) ? 0.85 : 0.75;
    const how = reading.borrowedFrom ? ` (borrowed from ${reading.borrowedFrom})` : '';
    const inOld = numeralFor(chord, from);
    const isDominant = chord.root === dominant.root && chord.intervals.includes(4);
    paths.push({
      kind: reading.kind === 'diatonic' ? 'pivot chord' : 'borrowed pivot', pivot: chord.name, score: round3(byFunction * mixture),
      chords: [old.name, chord.name, ...(isDominant ? [] : [dominant.name]), home.name],
      roles: [roleOld, `${inOld} in ${from.label} = ${reading.numeral} in ${to.label}${how} (the pivot)`, ...(isDominant ? [] : [roleDom]), roleNew],
      why: `${chord.name} is ${inOld} in ${from.label} and ${reading.numeral} in ${to.label}${how}: it is heard in the old key and left in the new one, then ${dominant.name} → ${home.name} confirms ${to.label}`
    });
  }
  // a mixture chord of the old key that the new key simply has
  for (const mode of parallelModes(from).common.slice(0, 3)) {
    for (let d = 0; d < 7; d++) {
      const raw = stackedChord(mode, d);
      if (!raw || !raw.intervals.includes(7) || raw.pcs.every((p) => from.pcs.has(p)) || !raw.pcs.every((p) => to.pcs.has(p)) || sameChord(raw, home)) continue;
      const chord = makeChord(raw.root, raw.quality, null, toSpell(raw.root));
      if (paths.some((p) => p.pivot === chord.name)) continue;
      const inNew = numeralFor(chord, to);
      const fn = functionOf(chord, to);
      paths.push({
        kind: 'borrowed pivot', pivot: chord.name, score: fn === 'subdominant' ? 0.72 : fn === 'tonic' ? 0.64 : 0.5,
        chords: [old.name, chord.name, dominant.name, home.name],
        roles: [roleOld, `${numeralFor(chord, from)} in ${from.label} (borrowed from ${mode.label}) = ${inNew} in ${to.label} (the pivot)`, roleDom, roleNew],
        why: `${chord.name} is a mixture chord in ${from.label} (from ${mode.label}) and ${inNew} in ${to.label}: mixture in the old key opens the door, then ${dominant.name} → ${home.name} confirms ${to.label}`
      });
    }
  }
  const domInOld = analyzeChord(dominant, from).numeral;
  paths.push({
    kind: 'dominant preparation', pivot: null, score: 0.6, chords: [old.name, dominant.name, home.name], roles: [roleOld, `${roleDom} (${domInOld} in ${from.label})`, roleNew],
    why: `direct: ${dominant.name}, the dominant seventh of ${to.label}, is heard as ${domInOld} in ${from.label} and resolves to the new home ${home.name}`
  });
  const two = makeChord(to.tonic + 2, to.minor ? 'm7b5' : 'm7', null, toSpell((to.tonic + 2) % 12));
  paths.push({
    kind: 'dominant preparation', pivot: null, score: 0.58, chords: [old.name, two.name, dominant.name, home.name], roles: [roleOld, `${numeralFor(two, to)} in ${to.label}`, roleDom, roleNew],
    why: `ii–V–I in the new key: ${two.name} → ${dominant.name} → ${home.name} sets up ${to.label} without a shared chord`
  });
  const shared = old.pcs.filter((p) => home.pcs.includes(p)).map(toSpell);
  if (shared.length) {
    paths.push({
      kind: 'common tone', pivot: null, score: round3(0.4 + 0.08 * shared.length), chords: [old.name, home.name], roles: [roleOld, roleNew],
      why: `hold ${shared.join(' and ')} while the other voices move by step from ${old.name} to ${home.name}`
    });
  } else {
    paths.push({
      kind: 'direct', pivot: null, score: 0.3, chords: [old.name, home.name], roles: [roleOld, roleNew],
      why: `no note in common between ${old.name} and ${home.name}: an abrupt shift (a "truck driver" modulation) — strongest at a section change`
    });
  }
  const leading = makeChord(to.tonic + 11, 'dim7', null, toSpell((to.tonic + 11) % 12));
  paths.push({
    kind: 'leading-tone diminished', pivot: null, score: 0.5, chords: [old.name, leading.name, home.name], roles: [roleOld, `vii°7 in ${to.label}`, roleNew],
    why: `${leading.name}, the diminished seventh on the leading tone of ${to.label}, belongs to no key in particular and leads up a semitone into ${home.name}`
  });
  return paths.sort((a, b) => b.score - a.score).slice(0, Math.max(1, count));
}

// ---------------------------------------------------------------------------------------------------------------
// The library

/** Every tag of the library, the most used first. */
export function progressionTags() {
  const counts = new Map();
  for (const p of PROGRESSIONS) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
}

/** A library progression as chords in a key: { name, scale, numerals, chords, tags, description }. */
export function progressionInKey(p, key = 'C') {
  return { name: p.name, scale: p.scale, numerals: [...p.numerals], chords: p.numerals.map((n) => romanToChord(n, key, p.scale)), tags: [...p.tags], description: p.description };
}

/**
 * Search the library. query: words looked for in names, tags and descriptions ("sad piano", "andalusian");
 * tags: all of them must be on the progression; scale: its mode ("minor", "dorian"…) — or mood: 'major' / 'minor'
 * for every mode with that third; length: number of chords. Returned in `key`, best match first.
 */
export function findProgressions({ query = '', tags = [], scale = null, mood = null, length = null, key = 'C', limit = 20 } = {}) {
  const words = String(query || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const wantTags = (tags || []).map((t) => String(t).toLowerCase());
  const known = progressionTags().map((t) => t.tag);
  for (const t of wantTags) {
    if (!known.includes(t)) {
      const close = nearest(t, known);
      throw new Error(`No progression is tagged "${t}".${close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(' or ')}?` : ''} Tags: ${known.join(', ')}`);
    }
  }
  const mode = scale ? requireScale(scale) : null;
  const scored = [];
  for (const p of PROGRESSIONS) {
    if (mode && p.scale !== mode) continue;
    if (mood && (SCALES[p.scale].includes(3) && !SCALES[p.scale].includes(4) ? 'minor' : 'major') !== mood) continue;
    if (length && p.numerals.length !== length) continue;
    if (!wantTags.every((t) => p.tags.includes(t))) continue;
    let score = 0;
    const name = p.name.toLowerCase();
    const text = p.description.toLowerCase();
    let all = true;
    for (const w of words) {
      const hit = (name.includes(w) ? 3 : 0) + (p.tags.some((t) => t === w) ? 3 : p.tags.some((t) => t.includes(w)) ? 2 : 0) + (text.includes(w) ? 1 : 0) + (p.numerals.join('-').toLowerCase() === w.toLowerCase() ? 4 : 0);
      if (!hit) all = false;
      score += hit;
    }
    if (words.length && !all) continue;
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ p }) => progressionInKey(p, key));
}

/** The library progression of this name (any spelling close to it), or an error that names the nearest. */
export function progressionByName(name, key = 'C') {
  const wanted = String(name ?? '').trim().toLowerCase();
  const exact = PROGRESSIONS.find((p) => p.name.toLowerCase() === wanted) || PROGRESSIONS.find((p) => p.name.toLowerCase().replace(/\s*\(.*\)$/, '') === wanted);
  const found = exact || PROGRESSIONS.filter((p) => p.name.toLowerCase().includes(wanted) && wanted.length >= 3);
  if (found && !Array.isArray(found)) return progressionInKey(found, key);
  if (found.length === 1) return progressionInKey(found[0], key);
  const close = found.length ? found.map((p) => p.name) : nearest(wanted, PROGRESSIONS.map((p) => p.name), 4);
  throw new Error(`${found.length ? `"${name}" fits ${found.length} progressions` : `No progression is called "${name}"`}.${close.length ? ` ${found.length ? 'They are' : 'Did you mean'}: ${close.slice(0, 6).map((c) => `"${c}"`).join(', ')}${found.length ? '.' : '?'}` : ''} Search the library with words or tags (find_progressions).`);
}

/**
 * Which library progressions a chord sequence is (in this key): the same roots and triads, from the same chord
 * ('exact') or starting somewhere else in the loop ('rotation'). → [{ name, scale, match, numerals }]
 */
export function identifyProgression(chords, key, scale) {
  const ctx = keyContext(key, scale);
  const sig = (chords || []).filter((c) => !isRest(c)).map((c) => sigOf(readChord(c, ctx), ctx));
  if (sig.length < 2) return [];
  const out = [];
  for (const { p, minor, sig: lib } of signatures()) {
    if (minor !== ctx.minor || lib.length !== sig.length) continue;
    const at = lib.findIndex((_, i) => sig.every((s, j) => lib[(i + j) % lib.length] === s));
    if (at >= 0) out.push({ name: p.name, scale: p.scale, match: at === 0 ? 'exact' : 'rotation', numerals: [...p.numerals] });
  }
  return out.sort((a, b) => (a.match === 'exact' ? 0 : 1) - (b.match === 'exact' ? 0 : 1));
}

