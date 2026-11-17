// Tuning systems: what frequency each key plays.
//
// Twelve-tone equal temperament makes every key equally (and slightly) out of tune. The systems here trade that
// evenness for purer intervals around a root: just intonation (whole-number ratios), Pythagorean (pure fifths),
// meantone (pure or near-pure thirds), the well temperaments of the 18th century (every key usable, each with its
// own colour), the harmonic series, equal divisions other than 12, and tables of your own.
//
// One rule holds for all of them: A TUNING NEVER MOVES ITS OWN ROOT. The root keeps the frequency it has in equal
// temperament at the chosen A4, and every other note is placed against it. Ratios are exact (kept as fractions
// wherever the system is rational), so a frequency can be taken from here and used somewhere else — a picture, a
// light, another instrument — and still be the same number.
import { parsePitchClass } from './music.js';
import { didYouMean } from './suggest.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const mod = (n, m) => ((n % m) + m) % m;
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const centsOf = (ratio) => 1200 * Math.log2(ratio);

export const A4_MIN = 380;
export const A4_MAX = 500;
export const EDO_MIN = 5;
export const EDO_MAX = 72;

/** [numerator, denominator] in lowest terms. */
const frac = (n, d) => { const g = gcd(n, d) || 1; return [n / g, d / g]; };
/** A power of 3/2 brought into one octave, as an exact fraction: `fifths` may be negative. */
function fifthsRatio(fifths) {
  let n = fifths >= 0 ? 3 ** fifths : 1;
  let d = fifths >= 0 ? 1 : 3 ** -fifths;
  while (n >= 2 * d) d *= 2;
  while (n < d) n *= 2;
  return frac(n, d);
}

const JUST_5 = [[1, 1], [16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [9, 5], [15, 8]];
const JUST_7 = [[1, 1], [16, 15], [9, 8], [7, 6], [5, 4], [4, 3], [7, 5], [3, 2], [8, 5], [5, 3], [7, 4], [15, 8]];
const HARMONIC = [16, 17, 18, 19, 20, 21, 22, 24, 26, 27, 28, 30].map((h) => frac(h, 16));
// how many fifths above (or below) the root each of the twelve notes is: Eb–Bb–F–C–G–D–A–E–B–F#–C#–G#
const FIFTH_CHAIN = [0, 7, 2, -3, 4, -1, 6, 1, 8, 3, -2, 5];

const PURE_FIFTH = centsOf(3 / 2);
const PYTHAGOREAN_COMMA = centsOf(3 ** 12 / 2 ** 19); // twelve pure fifths overshoot seven octaves by this
const SYNTONIC_COMMA = centsOf(81 / 80); // four pure fifths overshoot a pure major third (two octaves up) by this
const SCHISMA = PYTHAGOREAN_COMMA - SYNTONIC_COMMA;
// A well temperament is a circle of twelve fifths, some narrowed so that the circle closes. Listed as the amount
// each fifth is narrowed (cents), starting with the fifth on the root and going up by fifths: C–G, G–D, D–A, A–E,
// E–B, B–F#, F#–C#, C#–G#, G#–Eb, Eb–Bb, Bb–F, F–C.
const q = PYTHAGOREAN_COMMA / 4;
const s = PYTHAGOREAN_COMMA / 6;
const WELL = {
  werckmeister: [q, q, q, 0, 0, q, 0, 0, 0, 0, 0, 0],
  kirnberger: [SYNTONIC_COMMA / 4, SYNTONIC_COMMA / 4, SYNTONIC_COMMA / 4, SYNTONIC_COMMA / 4, 0, 0, SCHISMA, 0, 0, 0, 0, 0],
  vallotti: [s, s, s, s, s, 0, 0, 0, 0, 0, 0, s],
  young: [s, s, s, s, s, s, 0, 0, 0, 0, 0, 0]
};

/** Cents above the root of the twelve notes of a circle of fifths narrowed as listed. */
function circleCents(narrowed) {
  const cents = new Array(12).fill(0);
  let at = 0;
  let pc = 0;
  for (let i = 0; i < 11; i++) {
    at += PURE_FIFTH - narrowed[i];
    pc = (pc + 7) % 12;
    cents[pc] = mod(at, 1200);
  }
  return cents;
}

export const TUNING_SYSTEMS = [
  { id: 'equal', label: 'Equal temperament', exact: false, description: 'Twelve equal semitones: every key sounds the same, every third a little wide. The standard. With `divisions` other than 12 each key is one step of that many equal parts of the octave (19, 24, 31, 53…).' },
  { id: 'just', label: 'Just intonation (5-limit)', exact: true, description: 'Whole-number ratios built from 2, 3 and 5: the major chords on the root, its fourth and its fifth are beatless (4:5:6). Chords far from the root are not — the price of purity.' },
  { id: 'just7', label: 'Just intonation (7-limit)', exact: true, description: 'Like 5-limit, with the seventh harmonic: a low, sweet minor seventh (7/4), a septimal minor third (7/6) and tritone (7/5). Barbershop and blues colours.' },
  { id: 'pythagorean', label: 'Pythagorean', exact: true, description: 'Stacked pure fifths (3/2): strong, bright melodies and open fifths; major thirds are wide and restless (81/64). Medieval music, and the tuning of open strings.' },
  { id: 'meantone', label: 'Meantone', exact: false, description: 'Fifths narrowed so that major thirds are pure (quarter-comma, the default) or nearly so. Sweet in the keys near the root; one "wolf" fifth far from it howls. Renaissance and early baroque.' },
  { id: 'werckmeister', label: 'Werckmeister III', exact: false, description: 'A well temperament (1691): four fifths narrowed by a quarter comma. Every key is playable, each with its own character — calm near the root, tense far from it.' },
  { id: 'kirnberger', label: 'Kirnberger III', exact: false, description: 'A well temperament with a pure major third on the root: gentle in the home keys, increasingly bright around the circle.' },
  { id: 'vallotti', label: 'Vallotti', exact: false, description: 'A well temperament (six fifths narrowed by a sixth of a comma): smooth and even, a favourite for baroque keyboard music.' },
  { id: 'young', label: 'Young II', exact: false, description: 'Vallotti moved one fifth along the circle (1800): the purest keys sit on the root itself.' },
  { id: 'harmonic', label: 'Harmonic series', exact: true, description: 'The twelve notes taken from harmonics 16 to 30 of the root: every interval is a ratio of the series, all chords fuse into one tone. Drones, spectral music, overtone singing.' },
  { id: 'custom', label: 'Custom', exact: false, description: 'Your own table: twelve offsets in cents above the root, or twelve ratios ("5/4", 1.25).' }
];
export const TUNING_IDS = TUNING_SYSTEMS.map((t) => t.id);
const SYSTEM = Object.fromEntries(TUNING_SYSTEMS.map((t) => [t.id, t]));

export const DEFAULT_TUNING = Object.freeze({ system: 'equal', root: 'C', a4: 440 });
const CENTS_MAX = 2400;
const RATIO_MIN = 0.25;
const RATIO_MAX = 4;

/**
 * A patch laid over a stored tuning (what `project/update { tuning }` does): what the patch names replaces what was
 * there, and a new table replaces the other kind of table — `cents` sent to a tuning made of `ratios` must not be
 * ignored because the ratios are still there.
 */
export function mergeTuning(current, patch) {
  const merged = { ...(current || {}), ...(patch || {}) };
  if (patch?.cents !== undefined) delete merged.ratios;
  else if (patch?.ratios !== undefined) delete merged.cents;
  return merged;
}

/** "5/4", "1.25" or 1.25 → { value, fraction } (fraction null when it was given as a decimal). */
function readRatio(x) {
  if (typeof x === 'number') return Number.isFinite(x) && x > 0 ? { value: x, fraction: null } : null;
  const m = /^\s*(\d+)\s*[/:]\s*(\d+)\s*$/.exec(String(x));
  if (m && Number(m[2]) > 0 && Number(m[1]) > 0) return { value: Number(m[1]) / Number(m[2]), fraction: frac(Number(m[1]), Number(m[2])) };
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? { value: n, fraction: null } : null;
}

/**
 * A tuning in its stored form: { system, root (note name), a4 } plus what the system needs — divisions (equal),
 * fraction (meantone: the share of the syntonic comma each fifth is narrowed by), cents or ratios (custom).
 * Anything unreadable falls back to the standard; with `strict` it throws an error that says what is valid.
 */
export function normalizeTuning(raw, { strict = false } = {}) {
  const fail = (message) => { if (strict) throw new Error(message); };
  const out = { ...DEFAULT_TUNING };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.system !== undefined) {
    if (SYSTEM[raw.system]) out.system = raw.system;
    else fail(`Unknown tuning system "${raw.system}".${didYouMean(String(raw.system), TUNING_IDS)} Systems: ${TUNING_IDS.join(', ')}`);
  }
  if (raw.root !== undefined) {
    const pc = typeof raw.root === 'number' ? mod(Math.round(raw.root), 12) : parsePitchClass(raw.root);
    if (pc === null || Number.isNaN(pc)) fail(`Invalid tuning root "${raw.root}": use a note name such as C, F#, Bb`);
    else out.root = NOTE_NAMES[pc];
  }
  if (raw.a4 !== undefined) {
    const a4 = Number(raw.a4);
    if (Number.isFinite(a4) && a4 >= A4_MIN && a4 <= A4_MAX) out.a4 = Math.round(a4 * 1000) / 1000;
    else fail(`a4 is ${raw.a4}: the reference pitch must be ${A4_MIN}–${A4_MAX} Hz (440 = concert pitch, 432 and 415 are common alternatives)`);
  }
  if (out.system === 'equal' && raw.divisions !== undefined && raw.divisions !== 12) {
    const n = Number(raw.divisions);
    if (Number.isInteger(n) && n >= EDO_MIN && n <= EDO_MAX) out.divisions = n;
    else fail(`divisions is ${raw.divisions}: an equal division of the octave must be a whole number ${EDO_MIN}–${EDO_MAX} (12 = standard, 19, 24, 31 and 53 are the well-known others)`);
  }
  if (out.system === 'meantone') {
    const f = raw.fraction === undefined ? 0.25 : Number(raw.fraction);
    if (Number.isFinite(f) && f >= 0 && f <= 0.5) out.fraction = Math.round(f * 1e6) / 1e6;
    else { fail(`fraction is ${raw.fraction}: the share of the comma each fifth is narrowed by must be 0–0.5 (0.25 = quarter-comma, 1/3 ≈ 0.333, 1/6 ≈ 0.167; 0 = Pythagorean)`); out.fraction = 0.25; }
  }
  if (out.system === 'custom') {
    const ratios = Array.isArray(raw.ratios) && raw.ratios.length === 12 ? raw.ratios.map((r) => readRatio(r)) : null;
    const cents = Array.isArray(raw.cents) && raw.cents.length === 12 ? raw.cents.map(Number) : null;
    // A tuning never moves its own root, and a note stays within two octaves of where the keyboard has it: a table
    // that says otherwise is a mistake (a ratio of 1000000 is 220 MHz), not a tuning.
    if (ratios && ratios.every((r) => r && r.value >= RATIO_MIN && r.value <= RATIO_MAX) && Math.abs(ratios[0].value - 1) < 1e-9) {
      out.ratios = raw.ratios.map((r) => (typeof r === 'number' ? r : String(r).replace(/\s+/g, '').replace(':', '/')));
    } else if (!ratios && cents && cents.every((c) => Number.isFinite(c) && Math.abs(c) <= CENTS_MAX) && (cents[0] === 0 || !strict)) {
      // (a table loaded from a file that starts elsewhere is moved as a whole, so that its root is where it belongs)
      out.cents = cents.map((c) => Math.round((c - cents[0]) * 1000) / 1000);
    } else {
      if (ratios && ratios.every(Boolean) && Math.abs(ratios[0].value - 1) >= 1e-9) fail(`The first ratio of a custom tuning is the root itself and must be 1/1 (got ${raw.ratios[0]}): a tuning never moves its own root. Divide every ratio by the first one.`);
      if (ratios && ratios.every(Boolean)) fail(`Every ratio of a custom tuning must be between 1/${1 / RATIO_MIN} and ${RATIO_MAX} (two octaves either side of the root): ${raw.ratios.filter((r, i) => ratios[i].value < RATIO_MIN || ratios[i].value > RATIO_MAX).join(', ')} is outside`);
      if (!ratios && cents && cents.every((c) => Number.isFinite(c) && Math.abs(c) <= CENTS_MAX)) fail(`The first of the twelve cents is the root itself and must be 0 (got ${raw.cents[0]}): a tuning never moves its own root. Subtract ${raw.cents[0]} from every value — or change a4 to move the whole tuning.`);
      fail('A custom tuning needs `cents` (twelve numbers: cents above the root, starting with the root itself = 0, e.g. 0, 112, 204…, each within ±2400) or `ratios` (twelve ratios starting with "1/1": "1/1", "16/15", "9/8"…)');
      out.system = 'equal';
    }
  }
  return out;
}

/** Is this the standard — twelve equal semitones at A4 = 440 Hz — whatever its root? */
export function isStandardTuning(tuning) {
  return !tuning || ((tuning.system ?? 'equal') === 'equal' && (tuning.divisions ?? 12) === 12 && (tuning.a4 ?? 440) === 440);
}

/**
 * The twelve degrees of a tuning above its root: [{ value (the ratio as a number), fraction ([n, d], or null when the
 * ratio is irrational), cents }]. For an equal division other than 12 the list has that many entries.
 */
export function tuningDegrees(tuningIn) {
  const t = normalizeTuning(tuningIn);
  const fromFractions = (list) => list.map(([n, d]) => ({ value: n / d, fraction: [n, d], cents: centsOf(n / d) }));
  const fromCents = (list) => list.map((c) => ({ value: 2 ** (c / 1200), fraction: c === 0 ? [1, 1] : null, cents: c }));
  switch (t.system) {
    case 'just': return fromFractions(JUST_5);
    case 'just7': return fromFractions(JUST_7);
    case 'harmonic': return fromFractions(HARMONIC);
    case 'pythagorean': return fromFractions(FIFTH_CHAIN.map(fifthsRatio));
    case 'meantone': {
      const fifth = PURE_FIFTH - SYNTONIC_COMMA * t.fraction;
      return fromCents(FIFTH_CHAIN.map((k) => mod(k * fifth, 1200)));
    }
    case 'werckmeister': case 'kirnberger': case 'vallotti': case 'young': return fromCents(circleCents(WELL[t.system]));
    case 'custom':
      if (t.ratios) return t.ratios.map((r) => { const x = readRatio(r); return { value: x.value, fraction: x.fraction, cents: centsOf(x.value) }; });
      return fromCents(t.cents);
    default: {
      const n = t.divisions || 12;
      return Array.from({ length: n }, (_, i) => ({ value: 2 ** (i / n), fraction: i === 0 ? [1, 1] : null, cents: (1200 * i) / n }));
    }
  }
}

const degreeCache = new WeakMap();
function degreesOf(tuning) {
  if (!tuning || typeof tuning !== 'object') return tuningDegrees(tuning);
  let d = degreeCache.get(tuning);
  if (!d) { d = { t: normalizeTuning(tuning) }; d.degrees = tuningDegrees(d.t); degreeCache.set(tuning, d); }
  return d;
}

/** The frequency (Hz) of a MIDI key in a tuning. The root keeps its equal-tempered frequency at the tuning's A4. */
export function tunedFrequency(tuning, midi) {
  const { t, degrees } = degreesOf(tuning ?? DEFAULT_TUNING);
  const key = Math.round(midi);
  const rootPc = parsePitchClass(t.root);
  // the root nearest below (or at) middle C anchors the table; other octaves double and halve from there
  const anchor = 60 + rootPc - (rootPc > 6 ? 12 : 0);
  const anchorHz = t.a4 * 2 ** ((anchor - 69) / 12);
  const steps = key - anchor;
  const n = degrees.length;
  return anchorHz * 2 ** Math.floor(steps / n) * degrees[mod(steps, n)].value;
}

/** How far (cents) a key in a tuning is from the same key in standard tuning (12 equal semitones, A4 = 440 Hz). */
export function tuningCents(tuning, midi) {
  if (isStandardTuning(tuning)) return 0;
  const key = Math.round(midi);
  const cents = centsOf(tunedFrequency(tuning, key) / (440 * 2 ** ((key - 69) / 12)));
  return Math.abs(cents) < 1e-9 ? 0 : cents;
}

/** The nearest fraction to a ratio with a denominator up to `maxDenominator` (continued fractions): [n, d]. */
export function approximateRatio(value, maxDenominator = 64) {
  let [n0, d0, n1, d1] = [0, 1, 1, 0];
  let x = value;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x);
    const [n2, d2] = [a * n1 + n0, a * d1 + d0];
    if (d2 > maxDenominator) break;
    [n0, d0, n1, d1] = [n1, d1, n2, d2];
    if (Math.abs(x - a) < 1e-12) break;
    x = 1 / (x - a);
  }
  return [n1, d1 || 1];
}

/**
 * The table of a tuning, one row per degree, in the octave of the root nearest middle C:
 * [{ degree, note, ratio ("5/4", or null when irrational), near ("≈ 5/4" for irrational degrees close to a simple
 * ratio), value, cents (above the root), deviation (cents from equal temperament at the same A4), hz }]
 */
export function tuningTable(tuningIn) {
  const t = normalizeTuning(tuningIn);
  const degrees = tuningDegrees(t);
  const rootPc = parsePitchClass(t.root);
  const anchor = 60 + rootPc - (rootPc > 6 ? 12 : 0);
  const n = degrees.length;
  return degrees.map((d, i) => {
    // an irrational degree may still sit next to a ratio the ear knows (the 310-cent third of meantone is "about 6/5")
    const [an, ad] = d.fraction ? [0, 1] : SIMPLE.reduce((best, c) => (Math.abs(centsOf(d.value / (c[0] / c[1]))) < Math.abs(centsOf(d.value / (best[0] / best[1]))) ? c : best));
    const close = !d.fraction && n === 12 && Math.abs(centsOf(d.value / (an / ad))) < 8;
    return {
      degree: i,
      note: n === 12 ? NOTE_NAMES[(rootPc + i) % 12] : `step ${i}`,
      ratio: d.fraction ? `${d.fraction[0]}/${d.fraction[1]}` : null,
      near: close ? `${an}/${ad}` : null,
      value: d.value,
      cents: Math.round(d.cents * 1000) / 1000,
      deviation: Math.round((d.cents - (n === 12 ? 100 * i : d.cents)) * 1000) / 1000,
      hz: tunedFrequency(t, anchor + i)
    };
  });
}

// The simple ratios an interval may be heard as, and the pair of harmonics that coincide (and beat) when it is close.
// harmonics up to the 9th are what beats are heard between, and two of them beat when they are within a third of a
// semitone of meeting (equal temperament's harmonic seventh, the widest miss musicians call "out of tune", is 31 c)
const BEAT_LIMIT = 9;
const BEAT_REACH = 35;
const SIMPLE = [[1, 1], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 3], [8, 5], [7, 4], [7, 5], [7, 6], [9, 8], [16, 15], [15, 8], [9, 5], [16, 9], [45, 32]];

/**
 * How pure the intervals of a chord are in a tuning. For every pair of notes: the simple ratio it is nearest to, how
 * many cents it is off, and how fast it beats (Hz) — the difference between the two harmonics that should coincide.
 * → { notes: [{ key, hz }], pairs: [{ low, high, ratio, offCents, beatsHz }], worstBeatsHz, ratios (the chord as whole
 * numbers, "4:5:6", when the tuning makes it exact) }
 */
export function chordPurity(tuning, pitches) {
  const keys = [...new Set((pitches || []).map((p) => Math.round(p)))].sort((a, b) => a - b);
  const notes = keys.map((key) => ({ key, hz: tunedFrequency(tuning, key) }));
  const pairs = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const r = notes[j].hz / notes[i].hz;
      const octaves = Math.floor(Math.log2(r));
      const within = r / 2 ** octaves;
      let best = SIMPLE[0];
      for (const c of SIMPLE) if (Math.abs(centsOf(within / (c[0] / c[1]))) < Math.abs(centsOf(within / (best[0] / best[1])))) best = c;
      const [n, d] = frac(best[0] * 2 ** octaves, best[1]);
      // Beats are two low harmonics that nearly meet: harmonic d of the upper note against harmonic n of the lower,
      // equal when the interval is pure. Only ratios of small numbers have harmonics loud enough to hear beating
      // (the 45th harmonic of a tritone's "45/32" does not exist in any instrument), and only when the interval is
      // close to one — so a tritone is measured against 7/5, and a semitone, which is near none, does not beat.
      let near = null;
      for (const c of SIMPLE) {
        if (Math.max(c[0], c[1]) > BEAT_LIMIT) continue;
        const off = Math.abs(centsOf(within / (c[0] / c[1])));
        if (off <= BEAT_REACH && (!near || off < near.off)) near = { c, off };
      }
      const [bn, bd] = near ? frac(near.c[0] * 2 ** octaves, near.c[1]) : [0, 0];
      pairs.push({
        low: keys[i], high: keys[j], ratio: `${n}/${d}`,
        offCents: Math.round(centsOf(r / (n / d)) * 100) / 100,
        beatsHz: Math.round(Math.abs(bd * notes[j].hz - bn * notes[i].hz) * 1000) / 1000
      });
    }
  }
  // the whole chord as one set of whole numbers, when every note is an exact ratio of the lowest
  let ratios = null;
  if (notes.length >= 2) {
    const fr = notes.map((x) => approximateRatio(x.hz / notes[0].hz, 64));
    if (fr.every(([n, d], i) => Math.abs(centsOf(notes[i].hz / notes[0].hz / (n / d))) < 0.01)) {
      const lcm = fr.reduce((l, [, d]) => (l * d) / gcd(l, d), 1);
      if (lcm <= 256) ratios = fr.map(([n, d]) => (n * lcm) / d).join(':');
    }
  }
  return { notes, pairs, worstBeatsHz: pairs.reduce((m, p) => Math.max(m, p.beatsHz), 0), ratios };
}

/** A tuning in a few words: "Just intonation (5-limit) on D, A4 = 432 Hz". */
export function describeTuning(tuningIn) {
  const t = normalizeTuning(tuningIn);
  const name = t.system === 'equal' ? (t.divisions ? `${t.divisions} equal divisions of the octave` : 'Equal temperament')
    : t.system === 'meantone' ? `${meantoneName(t.fraction)} meantone` : SYSTEM[t.system].label;
  const rooted = t.system === 'equal' && !t.divisions ? '' : ` on ${t.root}`;
  return `${name}${rooted}${t.a4 === 440 ? '' : `, A4 = ${t.a4} Hz`}`;
}

function meantoneName(fraction) {
  const [n, d] = approximateRatio(fraction, 12);
  return fraction === 0.25 ? 'Quarter-comma' : n === 1 && Math.abs(fraction - n / d) < 1e-4 ? `1/${d}-comma` : `${fraction}-comma`;
}
