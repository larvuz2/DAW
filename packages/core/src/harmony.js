// Harmony, the reading half: what a chord is in a key.
//
// A chord is read by the place of its root in the key (a roman numeral), by what it does there (tonic / subdominant /
// dominant) and by where it comes from (the key itself, a parallel mode, a dominant applied to another degree…).
// chordflow.js builds on this to propose chords. Every weight in these tables is a judgement about how tonal music
// usually behaves, not a law: the functions say why they answer what they answer.
import {
  SCALES, SCALE_INFO, CHORD_INFO, parsePitchClass, parseChord, chordType, chordRootName, romanToChord, isRomanNumeral,
  requireScale, sevenNoteScale, scaleSpelling
} from './music.js';

export const mod12 = (n) => ((Math.round(n) % 12) + 12) % 12;
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const DIMINISHED = new Set(['dim', 'dim7', 'm7b5']);

/** The harmonic functions, in the order of the cadence. */
export const FUNCTIONS = ['tonic', 'subdominant', 'dominant', 'secondary dominant', 'chromatic'];

/**
 * A key as the harmony functions see it. `scale` may be any scale of the dictionary: chords are read in its 7-note
 * parent (a pentatonic borrows the mode that contains it).
 */
export function keyContext(key = 'C', scale = 'major') {
  if (key && typeof key === 'object' && Array.isArray(key.degrees)) return key;
  const id = requireScale(scale);
  const tonic = typeof key === 'number' ? mod12(key) : parsePitchClass(key);
  if (tonic === null) throw new Error(`Invalid key "${key}": use a root note such as C, F#, Bb`);
  const parent = sevenNoteScale(id);
  const degrees = SCALES[parent];
  const name = typeof key === 'number' ? FLAT_NAMES[tonic] : chordRootName(key);
  return {
    key: name, scale: id, parent, tonic, degrees,
    minor: degrees.includes(3) && !degrees.includes(4),
    pcs: new Set(degrees.map((d) => (tonic + d) % 12)),
    label: `${name} ${SCALE_INFO[id].label}`
  };
}

/** A chord from a root, a quality and an optional bass (pitch classes). Names are optional: flats by default. */
export function makeChord(root, quality, bass = null, rootName = null, bassName = null) {
  const type = chordType(quality);
  if (!type) throw new Error(`Unknown chord quality "${quality}"`);
  const r = mod12(root);
  const b = bass === null || mod12(bass) === r ? null : mod12(bass);
  const name = rootName || FLAT_NAMES[r];
  return {
    root: r, quality: type.symbol, intervals: type.intervals, bass: b, rootName: name,
    pcs: [...new Set(type.intervals.map((i) => (r + i) % 12))],
    name: `${name}${type.symbol}${b === null ? '' : `/${bassName || FLAT_NAMES[b]}`}`
  };
}

/** Read a chord symbol ("F#m7", "C/E") — or, with a key, a roman numeral ("bVII", "V7/V"). Chords pass through. */
export function readChord(x, ctx = null) {
  if (x && typeof x === 'object' && Number.isInteger(x.root) && Array.isArray(x.pcs)) return x;
  const text = String(x ?? '').trim();
  const symbol = ctx && isRomanNumeral(text) ? romanToChord(text, ctx.key, ctx.scale) : text;
  const p = parseChord(symbol);
  const slash = symbol.lastIndexOf('/');
  return makeChord(p.root, p.quality, p.bass, chordRootName(symbol), p.bass === null ? null : chordRootName(symbol.slice(slash + 1)));
}

const isDominantQuality = (c) => c.intervals.includes(4) && c.intervals.includes(10);
const minorThird = (c) => c.intervals.includes(3) && !c.intervals.includes(4);
const fits = (chord, pcs) => chord.pcs.every((p) => pcs.has(p));
export { isDominantQuality };

/** Where a pitch class sits in a key: { acc: '' | 'b' | '#', degree: 1–7 } — the inverse of how romanToChord reads. */
function degreeOf(pc, ctx, diminished = false) {
  const off = mod12(pc - ctx.tonic);
  const d = ctx.degrees.indexOf(off);
  if (diminished) {
    // the raised 6th and 7th of a minor key carry its diminished chords without an accidental (vii° in A minor = G#°)…
    if (off === 11 && ctx.degrees[6] === 10) return { acc: '', degree: 7 };
    if (off === 9 && ctx.degrees[5] === 8) return { acc: '', degree: 6 };
    // …so a diminished chord on the lowered degree has to say so
    if ((d === 6 && off === 10) || (d === 5 && off === 8)) return { acc: 'b', degree: d + 1 };
  }
  if (d >= 0) return { acc: '', degree: d + 1 };
  // outside the key: the name it has against the major scale (bII, bIII, #IV, bVI, bVII), or the natural degree the
  // key alters (#III in a minor key)
  const natural = MAJOR.indexOf(off);
  const e = natural >= 0 ? natural : { 1: 1, 3: 2, 6: 3, 8: 5, 10: 6 }[off];
  return { acc: off < ctx.degrees[e] ? 'b' : '#', degree: e + 1 };
}

/** The suffix a quality gets after a numeral: lower-case numerals already say "minor". */
function romanSuffix(quality, lower) {
  const pretty = { dim: '°', dim7: '°7', m7b5: 'ø7', aug: '+', aug7: '+7' }[quality];
  if (pretty !== undefined) return pretty;
  if (!lower || !quality.startsWith('m') || quality.startsWith('maj')) return quality;
  const rest = quality.slice(1);
  return /^(Maj|add)/.test(rest) ? `(${rest.toLowerCase()})` : rest;
}

/** The roman numeral of a chord in a key: "vi", "bVII", "V7", "ii°", "IV/1" (over a bass degree). */
export function numeralFor(chordIn, key, scale) {
  const ctx = keyContext(key, scale);
  const chord = readChord(chordIn, ctx);
  const lower = minorThird(chord);
  const { acc, degree } = degreeOf(chord.root, ctx, DIMINISHED.has(chord.quality));
  let suffix = romanSuffix(chord.quality, lower);
  let under = '';
  if (chord.bass !== null) {
    const b = degreeOf(chord.bass, ctx);
    under = `/${b.acc}${b.degree}`;
    // "I6/4" would read as the figure 64: keep an added sixth apart from the bass
    if (/[64]$/.test(suffix)) suffix = `(${suffix})`;
  }
  return `${acc}${lower ? NUMERALS[degree - 1].toLowerCase() : NUMERALS[degree - 1]}${suffix}${under}`;
}

/**
 * What a chord does in a key, from the place of its root: 'tonic' (rest), 'subdominant' (departure, preparation),
 * 'dominant' (tension that wants the tonic) or 'chromatic' (no role: a colour).
 */
export function functionOf(chordIn, key, scale) {
  const ctx = keyContext(key, scale);
  const chord = readChord(chordIn, ctx);
  const off = mod12(chord.root - ctx.tonic);
  // bII: a dominant seventh there is the tritone substitute, anything else the Neapolitan
  if (off === 1) return isDominantQuality(chord) ? 'dominant' : 'subdominant';
  if (off === 6) return DIMINISHED.has(chord.quality) ? 'subdominant' : 'chromatic';
  if (ctx.minor) {
    if (off === 0 || off === 3) return 'tonic';
    if ([2, 5, 8, 9].includes(off)) return 'subdominant';
    return [7, 10, 11].includes(off) ? 'dominant' : 'chromatic';
  }
  if ([0, 3, 4, 9].includes(off)) return 'tonic';
  return [2, 5, 8, 10].includes(off) ? 'subdominant' : 'dominant';
}

// Parallel modes a chord may be borrowed from, the usual sources first; then the rare ones.
const BORROW_MINOR = ['harmonicMinor', 'melodicMinor', 'dorian', 'major', 'phrygian', 'minor', 'mixolydian', 'lydian'];
const BORROW_MAJOR = ['minor', 'mixolydian', 'dorian', 'lydian', 'phrygian', 'major', 'harmonicMinor', 'melodicMinor', 'harmonicMajor'];
const BORROW_RARE = ['locrian', 'phrygianDominant', 'harmonicMajor', 'lydianDominant', 'mixolydianFlat6'];

/** The parallel modes of a key (same tonic), as key contexts: { common, rare }. */
export function parallelModes(key, scale) {
  const ctx = keyContext(key, scale);
  const common = (ctx.minor ? BORROW_MINOR : BORROW_MAJOR).filter((id) => id !== ctx.parent);
  const rare = BORROW_RARE.filter((id) => id !== ctx.parent && !common.includes(id));
  const build = (ids) => ids.map((id) => keyContext(ctx.key, id));
  return { common: build(common), rare: build(rare) };
}

/** The triad (or, with `sevenths`, the seventh chord) stacked in thirds on a degree (0–6) of a key — null when it has no name. */
export function stackedChord(ctx, d, sevenths = false) {
  const at = (i) => (ctx.degrees[(d + i) % 7] - ctx.degrees[d] + 12) % 12;
  const shape = sevenths ? [0, at(2), at(4), at(6)] : [0, at(2), at(4)];
  const type = CHORD_INFO.find((c) => c.intervals.length === shape.length && c.intervals.every((x, i) => x === shape[i]));
  if (!type) return null;
  const root = (ctx.tonic + ctx.degrees[d]) % 12;
  return makeChord(root, type.symbol, null, scaleSpelling(ctx.key, ctx.scale)(root));
}

/** The diatonic degree a chord could be applied to: root `semis` above the degree's root, the degree a major or minor triad that is not the tonic. */
function appliedTo(chord, ctx, semis) {
  const target = mod12(chord.root - semis);
  const d = ctx.degrees.indexOf(mod12(target - ctx.tonic));
  if (d <= 0) return null;
  const triad = stackedChord(ctx, d);
  return triad && (triad.quality === '' || triad.quality === 'm') ? triad : null;
}

/** A chord spelled the way its numeral reads in the key (F# for #IV, Gb for bV). */
export function spellInKey(chord, ctx) {
  try {
    return readChord(romanToChord(numeralFor(chord, ctx), ctx.key, ctx.scale));
  } catch {
    return chord; // a scale whose degrees the numerals cannot reach: keep the chord as it came
  }
}

/**
 * Read a chord in a key.
 * → { chord, numeral, function, kind, borrowedFrom, secondaryOf, why }
 * kind: 'diatonic' | 'altered dominant' | 'secondary dominant' | 'applied diminished' | 'borrowed' | 'tritone substitute' | 'chromatic'
 */
export function analyzeChord(chordIn, key, scale) {
  const ctx = keyContext(key, scale);
  const chord = readChord(chordIn, ctx);
  const numeral = numeralFor(chord, ctx);
  const fn = functionOf(chord, ctx);
  const out = { chord: chord.name, numeral, function: fn, kind: 'diatonic', borrowedFrom: null, secondaryOf: null, why: '' };
  if (fits(chord, ctx.pcs)) {
    out.why = `${numeral} belongs to ${ctx.label}: a ${fn} chord`;
    return out;
  }
  const { common, rare } = parallelModes(ctx);
  const borrowed = (modes) => {
    const mode = modes.find((m) => fits(chord, m.pcs));
    if (!mode) return false;
    Object.assign(out, { kind: 'borrowed', borrowedFrom: mode.label, why: `${numeral} is borrowed from ${mode.label} (modal mixture): a ${fn} chord with that mode's colour` });
    return true;
  };
  const seventh = chord.intervals.includes(10);
  const dominantShape = chord.intervals.includes(4) && !chord.intervals.includes(11) && (chord.intervals.includes(7) || seventh);
  // without a seventh a chord is more often mixture than an applied chord when a close mode has it (IV in a
  // dorian-coloured minor, vi° from melodic minor)
  if (!seventh && chord.quality !== 'dim7' && borrowed(common.slice(0, 3))) return out;
  const fifthBelow = dominantShape ? appliedTo(chord, ctx, 7) : null;
  if (fifthBelow) {
    const to = numeralFor(fifthBelow, ctx);
    return Object.assign(out, {
      kind: 'secondary dominant', function: 'secondary dominant', secondaryOf: to, numeral: `V${chord.quality}/${to}`,
      why: `the dominant of ${to} (${fifthBelow.name}): it makes ${fifthBelow.name} sound like a momentary home and wants to resolve there`
    });
  }
  const semitoneAbove = DIMINISHED.has(chord.quality) ? appliedTo(chord, ctx, 11) : null;
  if (semitoneAbove) {
    const to = numeralFor(semitoneAbove, ctx);
    return Object.assign(out, {
      kind: 'applied diminished', function: 'secondary dominant', secondaryOf: to, numeral: `vii${romanSuffix(chord.quality, true)}/${to}`,
      why: `the leading-tone chord of ${to} (${semitoneAbove.name}): its root is a semitone below and pulls up into it`
    });
  }
  if (borrowed(common)) return out;
  // the dominant itself with altered fifths or ninths (V7#5#9): still the dominant, just sharper
  if (isDominantQuality(chord) && mod12(chord.root - ctx.tonic) === 7) {
    return Object.assign(out, { kind: 'altered dominant', function: 'dominant', why: `the dominant of ${ctx.label} with altered tensions: more pull toward the tonic than a plain V7` });
  }
  if (isDominantQuality(chord)) {
    const below = mod12(chord.root - 1 - ctx.tonic);
    const d = ctx.degrees.indexOf(below);
    if (d >= 0) {
      const target = stackedChord(ctx, d);
      const to = target ? numeralFor(target, ctx) : NUMERALS[d];
      return Object.assign(out, {
        kind: 'tritone substitute', secondaryOf: to, function: d === 0 ? 'dominant' : 'secondary dominant',
        why: `a tritone substitute: it shares the tritone of the dominant of ${to} and slides down a semitone into ${target ? target.name : to}`
      });
    }
  }
  if (borrowed(rare)) return out;
  return Object.assign(out, { kind: 'chromatic', function: fn === 'dominant' && !isDominantQuality(chord) ? 'chromatic' : fn, why: `${numeral} is outside ${ctx.label} and its usual mixtures: a colour chord` });
}

// How rough each interval class sounds (semitones 0–6 between two notes of a chord), as a share of the roughest.
const ROUGHNESS = [0, 1.0, 0.5, 0.15, 0.10, 0.05, 0.75];
const FUNCTION_TENSION = { tonic: 0.2, subdominant: 0.45, dominant: 0.8, 'secondary dominant': 0.9, chromatic: 1.0 };

/**
 * How tense a chord is in a key, 0–1: 40 % how rough its own intervals are, 35 % how far its function is from rest,
 * 25 % how many of its notes are outside the key. → { tension, roughness, function, outside }
 */
export function chordTension(chordIn, key, scale) {
  const ctx = keyContext(key, scale);
  const chord = readChord(chordIn, ctx);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < chord.pcs.length; i++) {
    for (let j = i + 1; j < chord.pcs.length; j++) {
      const d = mod12(chord.pcs[i] - chord.pcs[j]);
      sum += ROUGHNESS[Math.min(d, 12 - d)];
      pairs++;
    }
  }
  const roughness = Math.min(1, (pairs ? sum / pairs : 0) / 0.45);
  const fn = analyzeChord(chord, ctx).function;
  const functional = fn === 'tonic' && chord.root === ctx.tonic ? 0 : FUNCTION_TENSION[fn];
  const outside = chord.pcs.filter((p) => !ctx.pcs.has(p)).length / chord.pcs.length;
  const round = (x) => Math.round(x * 1000) / 1000;
  return { tension: round(0.4 * roughness + 0.35 * functional + 0.25 * outside), roughness: round(roughness), function: fn, outside: round(outside) };
}

/** The tension of each chord of a progression ("-" and "" are rests): [{ chord, numeral, function, kind, tension }]. */
export function tensionCurve(chords, key, scale) {
  const ctx = keyContext(key, scale);
  return chords.filter((c) => !isRest(c)).map((c) => {
    const chord = readChord(c, ctx);
    const a = analyzeChord(chord, ctx);
    return { chord: chord.name, numeral: a.numeral, function: a.function, kind: a.kind, tension: chordTension(chord, ctx).tension };
  });
}

export const isRest = (c) => c === '-' || c === '' || c === null || c === undefined || c === '_';

// ---------------------------------------------------------------------------------------------------------------
// Naming what sounds

/**
 * Name a set of MIDI pitches: up to 8 readings, best first — [{ name, root, quality, bass, inversion, score, missing,
 * extra }] (pitch classes; names in flats unless `spell` is given). Empty when fewer than two different notes sound.
 *
 * Every chord type is tried on every sounding note as root: 1, minus what is missing (a fifth is cheap to leave out,
 * the ninth of an 11th/13th too, any other tone nearly disqualifies), minus 0.3 per note that does not belong, plus a
 * little for the root in the bass and for an exact match, minus a little for rare chord types. When the lowest note is
 * not a chord tone the chord may also be read over it as a slash chord.
 */
export function detectChords(pitches, { spell = null } = {}) {
  const sorted = [...new Set((pitches || []).map((p) => Math.round(p)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const bassPc = mod12(sorted[0]);
  const present = new Array(12).fill(false);
  for (const p of sorted) present[mod12(p)] = true;
  const count = present.filter(Boolean).length;
  if (count < 2) return [];
  const name = (pc, minor) => (spell ? spell(pc) : (minor ? MINOR_TONIC_NAMES : FLAT_NAMES)[pc]);
  const scored = [];
  const evaluate = (root, type, index, slash) => {
    const iv = type.intervals;
    const template = new Set(iv.map((i) => (root + i) % 12));
    const extended = iv.includes(17) || iv.includes(21);
    let penalty = 0;
    const missing = [];
    for (const i of iv) {
      const p = (root + i) % 12;
      if (present[p]) continue;
      penalty += i === 7 ? (iv.length <= 2 ? 1 : iv.length === 3 ? 0.12 : 0.06) : i === 14 && extended ? 0.08 : 0.6;
      missing.push(p);
    }
    const extra = [];
    for (let p = 0; p < 12; p++) if (present[p] && !template.has(p) && !(slash && p === bassPc)) extra.push(p);
    if (extra.length > 2 || missing.length > 2) return;
    const exact = !missing.length && !extra.length;
    const raw = 1 - penalty - 0.3 * extra.length + (bassPc === root ? 0.1 : 0) + (exact ? 0.08 : 0) - 0.006 * type.rank - (slash ? 0.14 : 0);
    if (raw < 0.5) return;
    const minor = iv.includes(3) && !iv.includes(4);
    const chord = makeChord(root, type.symbol, bassPc, name(root, minor), name(bassPc, minor));
    const tone = iv.findIndex((i) => (root + i) % 12 === bassPc);
    scored.push({
      order: [-Math.round(raw * 1e6), type.rank, index, root],
      found: {
        name: chord.name, root, quality: type.symbol, bass: bassPc, inversion: Math.max(0, tone),
        score: Math.round(Math.min(1, Math.max(0, raw / 1.18)) * 1000) / 1000,
        missing: missing.map((p) => name(p, minor)), extra: extra.map((p) => name(p, minor))
      }
    });
  };
  for (let root = 0; root < 12; root++) {
    if (!present[root]) continue;
    CHORD_INFO.forEach((type, index) => {
      evaluate(root, type, index, false);
      if (count >= 3 && !type.intervals.some((i) => (root + i) % 12 === bassPc)) evaluate(root, type, index, true);
    });
  }
  scored.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2] || a.order[3] - b.order[3]);
  const out = [];
  for (const s of scored) {
    if (out.length >= 8) break;
    if (!out.some((c) => c.name === s.found.name)) out.push(s.found);
  }
  return out;
}

// the names minor chords and keys are usually written with (C#m, F#m, G#m rather than Dbm, Gbm, Abm)
const MINOR_TONIC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const MAJOR_TONIC_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// How strongly each degree belongs to a key (Temperley's revision of the Krumhansl–Kessler probe-tone profiles).
const KEY_PROFILES = {
  temperley: { major: [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4], minor: [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4] },
  krumhansl: { major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] }
};

function correlation(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / 12;
  const mb = b.reduce((x, y) => x + y, 0) / 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da <= 0 || db <= 0 ? 0 : num / Math.sqrt(da * db);
}

/**
 * The key of a set of notes ({ key, length }): the major and minor keys whose profile fits how long each pitch class
 * sounds, best first — [{ key, scale, tonic, score (correlation, −1…1), relative }]. Empty without notes.
 */
export function detectKey(notes, { profile = 'temperley', count = 5 } = {}) {
  const weights = new Array(12).fill(0);
  for (const n of notes || []) if (Number.isFinite(n?.key)) weights[mod12(n.key)] += Math.max(1, Number(n.length) || 1);
  if (weights.every((w) => w <= 0)) return [];
  const profiles = KEY_PROFILES[profile] || KEY_PROFILES.temperley;
  const scored = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const scale of ['major', 'minor']) {
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[(i + tonic) % 12] = profiles[scale][i];
      scored.push({ tonic, scale, r: correlation(weights, rotated) });
    }
  }
  scored.sort((a, b) => b.r - a.r || a.tonic - b.tonic);
  return scored.slice(0, count).map(({ tonic, scale, r }) => {
    const minor = scale === 'minor';
    const rel = minor ? (tonic + 3) % 12 : (tonic + 9) % 12;
    return {
      key: (minor ? MINOR_TONIC_NAMES : MAJOR_TONIC_NAMES)[tonic], scale, tonic, score: Math.round(r * 1000) / 1000,
      relative: `${(minor ? MAJOR_TONIC_NAMES : MINOR_TONIC_NAMES)[rel]} ${minor ? 'major' : 'minor'}`
    };
  });
}

/**
 * The chords a set of notes ({ key, start, length } in ticks) plays, one reading per `segment` ticks: a note counts in
 * a segment when it sounds for a quarter of it (or for its whole length, if it is shorter). Segments that name the
 * same chord are joined. → [{ start, length, chord (null when nothing names it), pitches }]
 */
export function chordsFromNotes(notes, { segment, start = 0, end = null, spell = null } = {}) {
  if (!(segment > 0)) throw new Error('segment must be a positive number of ticks');
  const list = (notes || []).filter((n) => Number.isFinite(n?.key) && n.length > 0);
  const last = end ?? list.reduce((m, n) => Math.max(m, n.start + n.length), 0);
  const out = [];
  for (let t = start; t < last; t += segment) {
    const pitches = [];
    for (const n of list) {
      const overlap = Math.min(n.start + n.length, t + segment) - Math.max(n.start, t);
      if (overlap > 0 && overlap >= Math.min(segment / 4, n.length)) pitches.push(n.key);
    }
    const best = detectChords(pitches, { spell })[0];
    const chord = best ? best.name : null;
    const prev = out[out.length - 1];
    if (prev && prev.chord === chord && (chord !== null || !pitches.length === !prev.pitches.length)) prev.length += segment;
    else out.push({ start: t, length: segment, chord, pitches: [...new Set(pitches)].sort((a, b) => a - b) });
  }
  return out;
}
