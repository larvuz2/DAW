import { didYouMean } from './suggest.js';
import { SCALE_LIST, SCALE_FAMILIES, CLASSIC_SCALE_IDS } from './scales.js';
import { CHORD_LIST } from './chords.js';
// Music theory helpers: note names, scales and chords.
// Convention: scientific pitch notation, C4 = MIDI 60 (middle C).

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteName(midi) {
  const m = Math.round(midi);
  return SHARP_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** Parse a pitch class like "C", "F#", "Bb", "Ebb" -> 0..11 (or null). */
export function parsePitchClass(str) {
  const m = /^([A-Ga-g])([#b♯♭x]*)$/.exec(String(str).trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'x') pc += 2;
    else pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

/**
 * Parse a note: MIDI number (60), numeric string ("60") or name ("C4", "F#3", "Bb-1").
 * Returns integer MIDI 0..127 or throws.
 */
export function parseNote(input, defaultOctave = 4) {
  if (typeof input === 'number' && Number.isFinite(input)) return clampMidi(Math.round(input));
  const s = String(input).trim();
  if (/^-?\d+$/.test(s)) return clampMidi(parseInt(s, 10));
  const m = /^([A-Ga-g][#b♯♭x]*)(-?\d+)?$/.exec(s);
  if (!m) throw new Error(`Invalid note "${input}". Use names like C4, F#3, Bb2 or MIDI numbers (C4 = 60).`);
  const pc = parsePitchClass(m[1]);
  const octave = m[2] !== undefined ? parseInt(m[2], 10) : defaultOctave;
  // Use the letter's natural octave so that e.g. B#3 = C4 and Cb4 = B3
  const letterPc = LETTER_PC[m[1][0].toUpperCase()];
  const accidental = pc - letterPc;
  const wrap = accidental > 6 ? -12 : accidental < -6 ? 12 : 0;
  return clampMidi((octave + 1) * 12 + letterPc + accidental + wrap);
}

function clampMidi(n) {
  if (n < 0 || n > 127) throw new Error(`Note ${n} is outside MIDI range 0..127`);
  return n;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const SCALE_BY_ID = new Map(SCALE_LIST.map((x) => [x.id, x]));

/** Scale id → semitones above the tonic. The ids of older projects come first, in the order people know. */
export const SCALES = Object.fromEntries(
  [...CLASSIC_SCALE_IDS, ...SCALE_LIST.map((x) => x.id).filter((id) => !CLASSIC_SCALE_IDS.includes(id))].map((id) => [id, SCALE_BY_ID.get(id).intervals])
);

/** Scale id → { id, label, family, intervals, aliases, description }. */
export const SCALE_INFO = Object.fromEntries(SCALE_LIST.map((x) => [x.id, x]));
export { SCALE_FAMILIES };

const loose = (name) => String(name ?? '').toLowerCase().replace(/[\s_-]+/g, '');
const SCALE_NAMES = new Map();
for (const x of SCALE_LIST) for (const name of [x.id, x.label, ...x.aliases]) if (!SCALE_NAMES.has(loose(name))) SCALE_NAMES.set(loose(name), x.id);

/** The id of a scale from any name people use for it ("aeolian", "Phrygian Dominant", "jazz minor"), or null. */
export function resolveScale(name) {
  if (typeof name !== 'string') return null;
  return Object.hasOwn(SCALES, name) ? name : SCALE_NAMES.get(loose(name)) ?? null;
}

/** resolveScale, or an error that names the nearest scales. */
export function requireScale(name) {
  const id = resolveScale(name);
  if (id) return id;
  const names = SCALE_LIST.flatMap((x) => [x.label, ...x.aliases]);
  throw new Error(`Unknown scale "${name}".${didYouMean(String(name), names)} Known: ${SCALE_LIST.map((x) => x.label).join(', ')}`);
}

/** The scales by family, for menus: [{ family, scales: [{ id, label, description }] }]. */
export function scaleGroups() {
  return SCALE_FAMILIES.map((family) => ({ family, scales: SCALE_LIST.filter((x) => x.family === family) }));
}

/** Pitch classes (0..11) in a scale. */
export function scalePitchClasses(root, scale = 'minor') {
  const rootPc = typeof root === 'number' ? ((root % 12) + 12) % 12 : parsePitchClass(root);
  if (rootPc === null || rootPc === undefined) throw new Error(`Invalid key root "${root}"`);
  return SCALES[requireScale(scale)].map((s) => (rootPc + s) % 12);
}

/** MIDI notes of a scale, starting at root in the given octave, spanning N octaves. */
export function scaleNotes(root, scale = 'minor', octave = 4, octaves = 1) {
  const rootPc = parsePitchClass(root);
  if (rootPc === null) throw new Error(`Invalid key root "${root}"`);
  const steps = SCALES[requireScale(scale)];
  const base = (octave + 1) * 12 + rootPc;
  const out = [];
  for (let o = 0; o < octaves; o++) for (const s of steps) out.push(base + o * 12 + s);
  out.push(base + octaves * 12);
  return out.filter((n) => n >= 0 && n <= 127);
}

const CHORD_BY_KEY = new Map();
for (const c of CHORD_LIST) for (const k of [c.symbol, ...c.aliases]) CHORD_BY_KEY.set(k, c);

/** Chord quality (the studio's symbol or any spelling it reads) → semitones above the root. */
export const CHORD_TYPES = Object.fromEntries([...CHORD_BY_KEY].map(([k, c]) => [k, c.intervals]));
/** The chord dictionary: [{ symbol, name, family, rank, intervals, aliases }]. */
export const CHORD_INFO = CHORD_LIST;
/** The symbols the studio writes, one per chord type ("" = major triad). */
export const CHORD_SYMBOLS = CHORD_LIST.map((c) => c.symbol);

/**
 * The dictionary entry of a chord quality as people type it: "m7", "min7", "-7", "Maj7", "M7", "7(b9)", "ø" — or null.
 * Case only matters for a lone "M" (major): everything else is read without it.
 */
export function chordType(quality) {
  const q = String(quality ?? '').trim().replace(/♭/g, 'b').replace(/♯/g, '#');
  const tries = [q, q.replace(/[()\s]/g, '')];
  // "M9#11", "Madd9": a capital M that does not start "Maj"/"Min"/"Mi7" means major
  if (/^M(?!aj|AJ|in|IN|i\d|I\d|a\d|A\d|i$|I$)/.test(q)) tries.push(`maj${q.slice(1)}`, q.slice(1));
  const low = q.toLowerCase();
  tries.push(low, low.replace(/[()\s]/g, ''), low.replace(/^(?:min|mi|-)(?!n)/, 'm'));
  for (const t of tries) {
    const hit = CHORD_BY_KEY.get(t);
    if (hit) return hit;
  }
  return null;
}

/** Named chord shapes offered by the piano-roll chord stamp tool. */
export const STAMP_CHORDS = [
  ['Major', ''], ['Minor', 'm'], ['Dim', 'dim'], ['Aug', 'aug'], ['Sus2', 'sus2'], ['Sus4', 'sus4'],
  ['Power', '5'], ['Maj7', 'maj7'], ['Min7', 'm7'], ['Dom7', '7'], ['m7b5', 'm7b5'], ['Dim7', 'dim7'],
  ['Add9', 'add9'], ['Maj9', 'maj9'], ['Min9', 'm9'], ['Dom9', '9'], ['Min11', 'm11'], ['6th', '6']
];

/**
 * Parse a chord symbol: "Am", "F#m7", "Bbmaj7", "G7b9", "Dsus4", "C6/9", "C/E".
 * Returns { root: pitchClass, intervals: number[], bass: pitchClass|null, quality: the studio's symbol for the type }
 */
export function parseChord(symbol) {
  const s = String(symbol).trim();
  // root letter may be lower case ("am" = Am); a following "b" is a flat ("bbm7" = Bbm7)
  const m = /^([A-Ga-g][#b♯♭]?)(.*)$/.exec(s);
  if (!m) throw new Error(`Invalid chord "${symbol}". Use symbols like Am, F#m7, Bbmaj7, G7, Dsus4, C/E — or roman numerals (i, VI, bVII, V7/V) when the project has a key.`);
  let rest = m[2];
  let bass = null;
  // a slash bass is a note name: the "/9" of C6/9 and the "/maj7" of Cm/maj7 belong to the quality
  const slash = rest.lastIndexOf('/');
  if (slash >= 0 && /^[A-Ga-g][#b♯♭]?$/.test(rest.slice(slash + 1).trim())) {
    bass = parsePitchClass(rest.slice(slash + 1).trim());
    rest = rest.slice(0, slash);
  }
  const type = chordType(rest);
  if (!type) {
    throw new Error(`Unknown chord quality "${rest.trim()}" in "${symbol}".${didYouMean(rest.trim(), CHORD_SYMBOLS.filter(Boolean))} Known: ${CHORD_SYMBOLS.filter(Boolean).join(', ')}`);
  }
  return { root: parsePitchClass(m[1]), intervals: [...type.intervals], bass, quality: type.symbol };
}

/**
 * MIDI notes for a chord symbol. The root is placed in `octave` (C4 = 60).
 * inversion: 0 = root position, 1 = first inversion, ...
 * Slash bass notes are added an octave below the root.
 */
export function chordNotes(symbol, octave = 4, inversion = 0) {
  const { root, intervals, bass } = parseChord(symbol);
  const base = (octave + 1) * 12 + root;
  let notes = intervals.map((i) => base + i);
  for (let i = 0; i < inversion % notes.length; i++) {
    const n = notes.shift();
    notes.push(n + 12);
  }
  if (bass !== null) {
    let b = (octave + 1) * 12 + bass - 12;
    while (b >= notes[0]) b -= 12;
    notes = [b, ...notes];
  }
  return notes.filter((n) => n >= 0 && n <= 127);
}

/** Voice a chord close to a target center pitch, trying all inversions (keeps progressions in one register). */
export function voiceNear(notes, center = 64) {
  if (!notes.length) return notes;
  const sorted = [...notes].sort((a, b) => a - b);
  let best = sorted;
  let bestScore = Infinity;
  let cand = sorted;
  for (let inv = 0; inv < sorted.length; inv++) {
    const avg = cand.reduce((a, b) => a + b, 0) / cand.length;
    const shifted = cand.map((n) => n + Math.round((center - avg) / 12) * 12);
    const sAvg = shifted.reduce((a, b) => a + b, 0) / shifted.length;
    const score = Math.abs(sAvg - center) + (shifted[shifted.length - 1] - shifted[0]) * 0.01;
    if (score < bestScore && shifted.every((n) => n >= 0 && n <= 127)) {
      best = shifted;
      bestScore = score;
    }
    cand = [...cand.slice(1), cand[0] + 12];
  }
  return best;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
// accidental, numeral (N = the Neapolitan), then whatever names the quality
const ROMAN_HEAD = /^([b#♭♯]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i|N)(.*)$/;
// figured bass → [the seventh it implies, the chord tone in the bass]
const FIGURES = { 64: ['', 2], 65: ['7', 1], 43: ['7', 2], 42: ['7', 3] };
const SHARP_SPELLING = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_SPELLING = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// semitones from the relative major's tonic to each mode's tonic
const MODE_OFFSET = { major: 0, majorPentatonic: 0, chromatic: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, minor: 9, harmonicMinor: 9, melodicMinor: 9, minorPentatonic: 9, blues: 9, locrian: 11 };

/** Does this key use sharps (G, D, A, E, B, F# major and their modes) rather than flats? */
function keyUsesSharps(key, scale) {
  const k = String(key).trim();
  if (/^[A-Ga-g]#/.test(k)) return true;
  if (/^[A-Ga-g]b/.test(k)) return false;
  const major = (parsePitchClass(k) - (MODE_OFFSET[scale] ?? MODE_OFFSET[sevenNoteScale(scale)] ?? 0) + 12) % 12;
  return [7, 2, 9, 4, 11, 6].includes(major);
}

/**
 * Read a roman numeral: null when it is not one.
 *   bVII  ii°  V7  IVmaj7  i(add9)  V7#9  — accidental, numeral (case = major/minor), quality
 *   V7/V  vii°7/ii                         — applied to another degree (the part after "/" is a numeral)
 *   IV/1  i/5  V7/b7                       — over a bass note (the part after "/" is a scale degree)
 *   I64  V65  V43  V42  (or V6/5 …)        — figured bass: inversions
 *   N  N6                                  — the Neapolitan (bII major), in root position / first inversion
 */
function parseRoman(text) {
  // "V6/5" is the figure 65, not a V6 over the fifth degree
  let t = String(text ?? '').trim().replace(/6\/4$/, '64').replace(/6\/5$/, '65').replace(/4\/3$/, '43').replace(/4\/2$/, '42');
  let bass = null;
  let applied = null;
  const overDegree = /^(.+)\/([b#♭♯]?)([1-7])$/.exec(t);
  if (overDegree) {
    bass = { acc: flatSharp(overDegree[2]), degree: Number(overDegree[3]) };
    t = overDegree[1];
  }
  const slash = t.lastIndexOf('/');
  if (slash > 0) {
    const target = ROMAN_HEAD.exec(t.slice(slash + 1));
    if (target && !target[3] && target[2] !== 'N') {
      applied = t.slice(slash + 1);
      t = t.slice(0, slash);
    }
  }
  const m = ROMAN_HEAD.exec(t);
  if (!m) return null;
  const neapolitan = m[2] === 'N';
  let suffix = m[3];
  let figure = null;
  if (neapolitan) {
    if (suffix !== '' && suffix !== '6') return null;
    figure = suffix === '6' ? ['', 1] : null;
    suffix = '';
  } else {
    const fig = /^(.*?)(64|65|43|42)$/.exec(suffix);
    if (fig) {
      figure = FIGURES[fig[2]];
      suffix = fig[1] + figure[0];
    }
  }
  const upper = neapolitan || m[2] === m[2].toUpperCase();
  const quality = romanQuality(upper, suffix);
  if (quality === null) return null;
  return {
    acc: neapolitan ? 'b' : flatSharp(m[1]), degree: neapolitan ? 2 : ROMAN[m[2].toLowerCase()], upper, quality, figure, applied, bass,
    // the chord without what was applied to it or put under it, for reading it in another key
    core: `${m[1]}${m[2]}${neapolitan ? '' : suffix}`
  };
}

const flatSharp = (acc) => (acc === '♭' ? 'b' : acc === '♯' ? '#' : acc);

/**
 * The chord quality a numeral's case and suffix name, as the studio's symbol — or null. Upper case takes the suffix as
 * written ("V7#9", "IVmaj7", "VII°"); lower case is minor, so its suffix extends a minor chord ("ii7" = m7,
 * "i(maj7)" = mMaj7) unless it names another kind of chord by itself ("vii°7", "iiø", "vsus4").
 */
function romanQuality(upper, suffix) {
  const plain = suffix.replace(/[()]/g, '');
  if (upper) return (chordType(suffix) || chordType(plain))?.symbol ?? null;
  if (/^(°|o$|o7|ø|dim|aug|\+|sus|5$|q)/.test(plain) || /^m(?!aj)/.test(plain)) return chordType(plain)?.symbol ?? null;
  return CHORD_BY_KEY.get(`m${plain}`)?.symbol ?? CHORD_BY_KEY.get(`m${plain.toLowerCase()}`)?.symbol ?? null;
}

/** "V7", "bVII", "ii°", "IV/1", "N6" — or a secondary chord like "V7/V" or "vii°/ii". */
export function isRomanNumeral(s) {
  return typeof s === 'string' && parseRoman(s) !== null;
}

const PARENT_SCALES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonicMinor', 'melodicMinor'];
// scales with a passing note read their chords in the mode they decorate
const PARENT_OF = { bebopDominant: 'mixolydian', bebopMajor: 'major', bebopMinor: 'dorian' };

/**
 * The 7-note scale roman numerals, diatonic chords and spelling are read in: 5/6-note scales borrow from the first
 * common 7-note scale that contains them.
 */
export function sevenNoteScale(scale) {
  const id = resolveScale(scale);
  const steps = SCALES[id];
  if (!steps) return 'major';
  if (steps.length === 7) return id;
  if (PARENT_OF[id]) return PARENT_OF[id];
  // the first common 7-note scale that holds every note (in-sen → phrygian, iwato → locrian), else major/minor
  return PARENT_SCALES.find((p) => steps.every((x) => SCALES[p].includes(x))) || (steps.includes(3) ? 'minor' : 'major');
}

const LETTERS = 'CDEFGAB';

/**
 * A speller for a key: pitch class -> name. Notes of the (parent) 7-note scale get letter-correct names (F major → Bb,
 * A harmonic minor → G#, F# major → E#); anything else follows the key's sharp/flat preference.
 */
export function scaleSpelling(key = 'C', scale = 'major') {
  const table = keyUsesSharps(key, scale) ? SHARP_SPELLING : FLAT_SPELLING;
  const byPc = new Map();
  const m = /^([A-Ga-g])/.exec(String(key).trim());
  if (m && SCALES[scale] && parsePitchClass(key) !== null) {
    const first = LETTERS.indexOf(m[1].toUpperCase());
    scalePitchClasses(key, sevenNoteScale(scale)).forEach((pc, d) => {
      const letter = LETTERS[(first + d) % 7];
      const diff = ((pc - LETTER_PC[letter] + 18) % 12) - 6;
      // double sharps/flats read badly in a DAW: those degrees fall back to the plain enharmonic
      if (Math.abs(diff) <= 1) byPc.set(pc, letter + (diff === 1 ? '#' : diff === -1 ? 'b' : ''));
    });
  }
  return (pc) => {
    const p = ((Math.round(pc) % 12) + 12) % 12;
    return byPc.get(p) ?? table[p];
  };
}

/** Note name with octave from a scaleSpelling speller (keeps B#3 = MIDI 60 and Cb4 = MIDI 59 right). */
export function spelledNoteName(midi, spell) {
  const n = Math.round(midi);
  const name = spell(n);
  return name + (Math.floor(n / 12) - 1 + (name === 'B#' ? -1 : name === 'Cb' ? 1 : 0));
}

/**
 * Convert a roman numeral to a chord symbol in a key: "i", "VI", "bVII", "ii°", "V7", "IVmaj7", "V7/V", "IV/1", "N6",
 * "I64". Upper case = major, lower case = minor; the suffix is any chord quality the studio knows. The root comes
 * from the scale degree of `scale` (accidentals b/# shift it).
 */
export function romanToChord(numeral, key = 'C', scale = 'major') {
  const r = parseRoman(numeral);
  if (!r) throw new Error(`Invalid roman numeral "${numeral}". Write a degree (I–VII, lower case = minor), then a chord quality: ii7, V7#9, bVII, vii°7, IVmaj7 — "V7/V" applies a chord to another degree, "IV/1" puts it over a bass degree, "I64" inverts it, "N6" is the Neapolitan.`);
  let symbol;
  if (r.applied) {
    // secondary chord: "V7/V" = the V7 of the key whose tonic is this key's V
    const target = parseRoman(r.applied);
    const tonic = chordRootName(romanToChord(r.applied, key, scale));
    symbol = romanToChord(r.core, tonic, target.upper ? 'major' : 'harmonicMinor');
  } else {
    symbol = plainRoman(r, key, scale);
  }
  const root = chordRootName(symbol);
  let under = null;
  if (r.figure) {
    const iv = CHORD_BY_KEY.get(r.quality).intervals[r.figure[1]];
    if (iv === undefined) throw new Error(`"${numeral}" asks for an inversion its chord has no note for`);
    under = chordToneName(root, iv);
  }
  if (r.bass) {
    // a bass degree is a degree of the key the progression is in, also under an applied chord
    const pcs = scalePitchClasses(key, sevenNoteScale(scale));
    const pc = alterDegree(pcs[r.bass.degree - 1], r.bass.degree, r.bass.acc, pcs[0]);
    const sharp = r.bass.acc === '#' || (!r.bass.acc && keyUsesSharps(key, scale));
    under = r.bass.acc ? (sharp ? SHARP_SPELLING : FLAT_SPELLING)[pc] : scaleSpelling(key, scale)(pc);
  }
  return under !== null && parsePitchClass(under) !== parsePitchClass(root) ? `${symbol}/${under}` : symbol;
}

/** A numeral with nothing applied to it and nothing under it, in a key. */
function plainRoman(r, key, scale) {
  const { acc, degree, quality } = r;
  const parent = sevenNoteScale(scale);
  const pcs = scalePitchClasses(key, parent);
  // The degree is the key's own (so "VI" in A minor = F). An accidental moves it — unless the key already has that
  // alteration against major, as pop charts write it: "bVII" in A minor is the same G as "VII", "#IV" in lydian its IV.
  let pc = alterDegree(pcs[degree - 1], degree, acc, pcs[0]);
  // A diminished chord on the lowered 6th or 7th of a minor key is built on the raised degree, as in classical harmony
  // (vii° in C minor = B°, vi° = A°): the lowered degrees carry major chords.
  let raised = false;
  const above = (pc - pcs[0] + 12) % 12;
  if (['dim', 'dim7', 'm7b5'].includes(quality) && !acc && ((degree === 7 && above === 10) || (degree === 6 && above === 8))) {
    pc = (pc + 1) % 12;
    raised = true;
  }
  // spell the root the way the key is written (G# in A minor's vii°, Bb in C major's bVII); a scale with no Western
  // mode twin (the thaats, phrygian dominant…) and the minors with raised degrees spell their own degrees by letter,
  // like their scale does (D bhairav's II = Eb, D harmonic minor's vii° = C#)
  if (!acc && !raised && (MODE_OFFSET[parent] === undefined || BY_LETTER.has(parent))) return `${scaleSpelling(key, scale)(pc)}${quality}`;
  const sharp = acc === '#' || raised || (!acc && keyUsesSharps(key, scale));
  return `${(sharp ? SHARP_SPELLING : FLAT_SPELLING)[pc]}${quality}`;
}

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const BY_LETTER = new Set(['harmonicMinor', 'melodicMinor']);

/** A scale degree (pitch class `pc`, degree 1–7 of a key on `tonic`) with an accidental applied — see plainRoman. */
function alterDegree(pc, degree, acc, tonic) {
  if (!acc) return pc;
  const against = ((pc - tonic - MAJOR_DEGREES[degree - 1] + 18) % 12) - 6; // how the key already alters it: −1 = flat
  if (acc === 'b' && against >= 0) return (pc + 11) % 12;
  if (acc === '#' && against <= 0) return (pc + 1) % 12;
  return pc;
}

/** "F#m7/A" → "F#". */
export function chordRootName(symbol) {
  const m = /^([A-Ga-g])([#b♯♭]?)/.exec(String(symbol).trim());
  if (!m) throw new Error(`Invalid chord "${symbol}"`);
  return m[1].toUpperCase() + flatSharp(m[2]);
}

const LETTER_STEPS = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6]; // interval class → how many letters above the root it is written

/** The name of a chord tone, written by letter from its root: the third of Db is F, of F# is A#, the seventh of G is F. */
export function chordToneName(rootName, interval) {
  const root = chordRootName(rootName);
  const pc = (parsePitchClass(root) + interval) % 12;
  const semis = ((interval % 12) + 12) % 12;
  // a ninth, eleventh or thirteenth is written as the second, fourth or sixth it is
  const steps = interval > 12 && semis === 6 ? 3 : LETTER_STEPS[semis];
  const letter = LETTERS[(LETTERS.indexOf(root[0]) + steps) % 7];
  const diff = ((pc - LETTER_PC[letter] + 18) % 12) - 6;
  if (Math.abs(diff) <= 1) return letter + (diff === 1 ? '#' : diff === -1 ? 'b' : '');
  return (root.includes('b') ? FLAT_SPELLING : SHARP_SPELLING)[pc];
}

/**
 * Diatonic triads/sevenths of a scale, e.g. C major -> C Dm Em F G Am Bdim. 5/6-note scales (pentatonics, blues,
 * hirajoshi…) use the 7-note scale that contains them — the same one roman numerals are read in. The thaats refuse:
 * some of their degrees have no major/minor/diminished/augmented triad.
 */
export function diatonicChords(key = 'C', scale = 'major', { sevenths = false } = {}) {
  const pcs = scalePitchClasses(key, sevenNoteScale(scale));
  if (pcs.length !== 7) throw new Error('Diatonic chords need a 7-note scale');
  const odd = pcs.some((root, d) => {
    const third = (pcs[(d + 2) % 7] - root + 12) % 12;
    const fifth = (pcs[(d + 4) % 7] - root + 12) % 12;
    return !((third === 4 && (fifth === 7 || fifth === 8)) || (third === 3 && (fifth === 7 || fifth === 6)));
  });
  if (odd) throw new Error(`The ${scale} scale has degrees without a major, minor, diminished or augmented triad: it is played melodically (over a drone such as a tanpura), not harmonised in triads. Use action "scale" for its notes.`);
  const spell = scaleSpelling(key, scale);
  const numerals = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
  return pcs.map((root, d) => {
    const third = (pcs[(d + 2) % 7] - root + 12) % 12;
    const fifth = (pcs[(d + 4) % 7] - root + 12) % 12;
    const seventh = (pcs[(d + 6) % 7] - root + 12) % 12;
    let q = third === 4 && fifth === 7 ? '' : third === 3 && fifth === 7 ? 'm' : third === 3 && fifth === 6 ? 'dim' : third === 4 && fifth === 8 ? 'aug' : '';
    if (sevenths) {
      if (q === '') q = seventh === 11 ? 'maj7' : '7';
      else if (q === 'm') q = seventh === 10 ? 'm7' : 'mMaj7';
      else if (q === 'dim') q = seventh === 10 ? 'm7b5' : 'dim7';
    }
    const upper = third === 4;
    const numeral = (upper ? numerals[d].toUpperCase() : numerals[d]) + (q.startsWith('dim') || q === 'm7b5' ? '°' : q === 'aug' ? '+' : '');
    const chord = `${spell(root)}${q}`;
    return { degree: d + 1, numeral, chord, notes: chordNotes(chord, 4).map((n) => spelledNoteName(n, spell)) };
  });
}
