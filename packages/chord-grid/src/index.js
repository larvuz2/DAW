// The chord grid: every chord of a key on one grid, the borrowed ones beside it, what could come next, and a track of
// cards to try a progression on — the harmonic engine of Tuple (https://github.com/c0remusic/tuple, MIT), unchanged,
// behind an API the studio can use from a window and from an MCP tool alike.
//
// The engine (src/tuple-engine.js) is Tuple's own script. It talks in messages, as it does to Tuple's screen: this file
// sends them, lets the deferred work run (src/host.js), and keeps what comes back as plain state:
//
//   const grid = createChordGrid({ root: 0, scale: 'major', spell, onNotes });
//   grid.view()                       → { columns, borrowed, settings, progression, sounding, … } (a new object on change)
//   grid.press(cell) / grid.release() → the chord sounds through onNotes([{ on, pitch, velocity, delay }])
//   grid.add(cell, { bars, tensions }) → a card on the track; grid.notes() → what the track plays, to write to a pattern
//
// Nothing here knows about projects, ticks or audio: the callers convert (client/src/lib/chordGrid.js, the MCP tool).
import { createTupleEngine } from './tuple-engine.js';
import { TUPLE_SOURCE } from './tuple-source.js';
import { createHost, seeded } from './host.js';

export { TUPLE_SOURCE, seeded };

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const mod12 = (n) => ((Math.round(n) % 12) + 12) % 12;

// What Tuple's screen calls things (its labels live in its HTML, which is not part of the engine).
const SCALE_LABELS = {
  major: 'Major', minor: 'Minor', dorian: 'Dorian', phrygian: 'Phrygian', lydian: 'Lydian', mixolydian: 'Mixolydian', harmminor: 'Harmonic minor',
  melminor: 'Melodic minor', locrian: 'Locrian', pentamaj: 'Major pentatonic', pentamin: 'Minor pentatonic', lydiandom: 'Lydian dominant',
  dorianb2: 'Dorian ♭2', lydianaug: 'Lydian augmented', mixob6: 'Mixolydian ♭6', locrians2: 'Locrian ♮2', altered: 'Altered',
  locrians6: 'Locrian ♮6', ionians5: 'Ionian ♯5', dorians4: 'Dorian ♯4', phrygdom: 'Phrygian dominant', lydians2: 'Lydian ♯2', ultralocrian: 'Ultralocrian',
  harmmajor: 'Harmonic major', dorianb5: 'Dorian ♭5', phrygianb4: 'Phrygian ♭4', lydianb3: 'Lydian ♭3', mixob2: 'Mixolydian ♭2', lydianaugs2: 'Lydian augmented ♯2', locrianbb7: 'Locrian ♭♭7'
};
/** The voicing styles, in the order Tuple shows them: what a chord's notes are spread like. */
export const VOICINGS = [
  { id: 'root', label: 'Default', about: 'every note where it falls, in order: root, 3rd, 5th, 7th, then the extensions — no styling, and voice leading does not move it' },
  { id: 'classic', label: 'Closed', about: 'close position: no chord note fits between two neighbours' },
  { id: 'clear', label: 'Clear', about: 'closed, thinned where notes would rub in the low register' },
  { id: 'open', label: 'Open', about: 'the second voice raised an octave: wider, for pads' },
  { id: 'drop2', label: 'Section', about: 'drop 2: the second voice from the top an octave down — horn sections, neo-soul keys' },
  { id: 'drop3', label: 'Chord Melody', about: 'drop 3: the third voice from the top an octave down, root in the bass — guitar chord melody' },
  { id: 'piano', label: 'Two Hands', about: 'a low root in the left hand, the rest grouped above' },
  { id: 'rootless', label: 'Rootless', about: 'no root (the bass has it), 3rd and 7th with the colours on top — jazz and modern keys' }
];
export const LEADING = [
  { id: 'off', label: 'Off', about: 'every chord near the middle of the register, on its own' },
  { id: 'anchor', label: 'Anchor', about: 'each chord re-centred on a fixed register: the same chord always sounds the same — stable loops' },
  { id: 'follow', label: 'Follow', about: 'each chord follows the one before: least movement, common tones kept' }
];
export const SMART_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'function', label: 'By function', about: 'where harmony expects to go next (the strongest moves glow most)' },
  { id: 'voiceleading', label: 'By voice leading', about: 'the same candidates, the smoothest to reach glowing most' }
];
export const TENSIONS = ['b9', '9', '#9', '11', '#11', 'b13', '13'];
export const BORROWED_PAGES = [
  { id: 0, label: 'Borrowed', short: '♭', about: 'modal interchange and secondary dominants' },
  { id: 1, label: 'Tritone', short: 'TRI', about: 'tritone substitutes of the dominants around what you just played' },
  { id: 2, label: 'Mediants', short: 'MED', about: 'chromatic mediants (major and minor keys only)' },
  { id: 3, label: 'Ext', short: 'EXT', about: 'richer forms of the degree you just played: 13ths, 11ths, added notes' }
];
export const STRUM_CURVES = ['Linear', 'Accel', 'Decel'];
export const STRUM_MAX = 250;
/** What a suggestion is, in words (Tuple's transition kinds). */
export const SMART_KINDS = {
  resolution: 'comes to rest', predominant: 'sets up the dominant', dominant: 'builds tension', deceptive: 'the deceptive turn (V → vi)', color: 'a colour from outside the key'
};
const DEGREE_NAMES = ['Tonic', 'Supertonic', 'Mediant', 'Subdominant', 'Dominant', 'Submediant', 'Leading tone'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const QUALITY = ['maj', 'min', 'dim', 'aug'];
const OPTION_MODES = { subs: 0, next: 1, voicings: 2 };
// why the engine holds a tension back (its avoid-note rules), in words
const AVOID_WHY = {
  '4th': 'it rubs against the 4th of a sus chord', sus: 'on a dominant the 11th makes it a 7sus4 — choose that chord instead', '3rd': 'a semitone above the major 3rd',
  major: 'not a colour of a major chord', minor: 'not a colour of a minor chord', hdim: 'not a colour of a half-diminished chord', '5th': 'a semitone below the perfect 5th'
};

/**
 * A chord name split for comparing: { pc, suffix } with the many ways to write a quality brought to the grid's own
 * ("Cmaj7" = "CM7", "Bm7b5" = "Bø7", "C69" = "C6/9", "Cm(maj7)" = "CmMaj7", "Db" = "C#"), or null if it has no root.
 * Case matters where it must: M7 is major, m7 minor.
 */
export function chordKey(text) {
  const t = String(text ?? '').trim().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s+/g, '');
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(t);
  if (!m) return null;
  const pc = mod12('C D EF G A B'.indexOf(m[1].toUpperCase()) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0));
  let q = m[3];
  q = q.replace(/^(?:maj|Maj|MAJ|ma|Δ)(?=\d|$|#|b|\()/, 'M').replace(/^M$/, '');
  q = q.replace(/^(?:min|mi|-)(?!aj)/, 'm');
  q = q.replace(/^m\(?(?:maj|Maj|M)(7|9)\)?/, 'mMaj$1');
  q = q.replace(/^(?:m7\(?b5\)?|ø7?|min7b5)/, 'ø7');
  q = q.replace(/^(?:°|o)7/, 'dim7').replace(/^(?:°|o)$/, 'dim').replace(/^\+$/, 'aug');
  q = q.replace(/^(m?)69/, '$16/9');
  q = q.replace(/sus(?![24])/, 'sus4');
  q = q.replace(/[()]/g, '');
  return { pc, suffix: q };
}

let catalog = null;
/** The scales the grid knows: [{ id, label, intervals (seven, from the tonic), notes (the pitch classes really in the scale) }]. */
export function gridScales() {
  if (catalog) return catalog;
  const eng = createTupleEngine(createHost());
  const all = eng.get('SCALES');
  const masks = eng.get('SCALE_VALID_DEGREES');
  catalog = eng.get('SCALE_NAMES_ARR').map((id) => {
    const intervals = all[id].slice();
    const notes = masks[id] ? intervals.filter((_, d) => masks[id][d]) : intervals;
    return { id, label: SCALE_LABELS[id] || id, intervals, notes };
  });
  return catalog;
}

/**
 * The grid's scale for a set of intervals from the tonic (any scale of the studio): { id, exact }.
 * Not exact = the grid has no such scale: the closest one that has seven notes is given (most notes shared, fewest
 * foreign ones) so there is always a grid to play.
 */
export function gridScaleFor(intervals) {
  const want = [...new Set((intervals || []).map(mod12))].sort((a, b) => a - b);
  const scales = gridScales();
  const same = scales.find((s) => s.notes.length === want.length && s.notes.every((n, i) => n === want[i]));
  if (same) return { id: same.id, exact: true };
  let best = null;
  for (const s of scales) {
    if (s.notes.length !== 7) continue;
    const shared = want.filter((n) => s.notes.includes(n)).length;
    const score = shared - (7 - shared) * 0.01;
    if (!best || score > best.score + 1e-9) best = { id: s.id, score };
  }
  return { id: best ? best.id : 'major', exact: false };
}

const cellId = (c) => (c.kind === 'b' ? `b:${c.semis}:${c.type}` : `d:${c.degree}:${c.fn}`);

/** A cell from its id ("d:1:nine", "b:3:maj"), or null. */
export function cellFromId(id) {
  const m = /^(d):(\d):([a-z0-9]+)$/.exec(String(id)) || /^(b):(\d{1,2}):(.+)$/.exec(String(id));
  if (!m) return null;
  return m[1] === 'd' ? { kind: 'd', degree: Number(m[2]), fn: m[3] } : { kind: 'b', semis: Number(m[2]), type: m[3] };
}

/**
 * One chord grid: an engine of its own, in a key.
 *   root      tonic pitch class 0–11
 *   scale     a gridScales() id
 *   spell     (pitchClass) => note name, for labels in the key's own spelling (default: sharps)
 *   seed      for humanize (the same seed repeats the same take)
 *   bpm       strum times are milliseconds: the tempo turns them into beats when the track becomes notes
 *   onNotes   ([{ on, pitch, velocity 1–127, delay ms }]) — what sounds: a pressed chord, a released one
 */
export function createChordGrid({ root = 0, scale = 'major', spell = null, seed = 0, bpm = 120, onNotes = null } = {}) {
  const host = createHost({ seed, bpm });
  const eng = createTupleEngine(host);
  const fns = eng.fns;
  const listeners = new Set();
  // what the engine last said, as its screen would hold it
  const ui = {
    root: 0, scale: 0, columns: [[], [], [], [], [], [], []], bor: [], qualities: [0, 0, 0, 0, 0, 0, 0], smart: new Map(), smartBor: new Map(),
    active: null, notes: [], monitor: null, last: null, preview: [],
    octave: 0, voicing: 'classic', vl: false, vlmode: 'anchored', extended: false, avoidNotes: true, smartOn: false, smartMode: 'function',
    strum: 0, strumRamp: 0, strumCurve: 0, humanize: 0, velMin: 1, velMax: 127, capture: false, borPage: 0, loop: 4
  };
  let draft = null;
  let draftSmart = null;
  let velocity = 0;
  let sounds = [];
  let full = false;
  let version = 0;
  let cached = null;
  let speller = spell;

  const HANDLERS = {
    gridclear() { draft = { columns: [[], [], [], [], [], [], []], bor: [] }; },
    gridcell(d, fn, label) { draft?.columns[d]?.push({ fn: String(fn), label: String(label) }); },
    gridbor(i, label, semis, type, roman, target) { if (draft) draft.bor[i] = { label: String(label), semis: Number(semis), type: String(type), roman: String(roman ?? ''), target: target === undefined ? null : String(target) }; },
    qualities(...q) { ui.qualities = q.map(Number); },
    griddone() { if (draft) { ui.columns = draft.columns; ui.bor = draft.bor.filter(Boolean); draft = null; } },
    smartclear() { draftSmart = { cells: new Map(), bor: new Map() }; },
    smartcell(d, fn, level, kind, score) { draftSmart?.cells.set(`d:${d}:${fn}`, { level: Number(level), kind: String(kind), score: Number(score) }); },
    smartbor(index, level, kind, score) { draftSmart?.bor.set(Number(index), { level: Number(level), kind: String(kind), score: Number(score) }); },
    smartdone() { if (draftSmart) { ui.smart = draftSmart.cells; ui.smartBor = draftSmart.bor; draftSmart = null; } },
    active(fn, deg, type) { ui.active = fn === 'color' ? `b:${deg}:${type}` : `d:${deg}:${fn}`; ui.monitor = null; },
    notes(...n) { ui.notes = n.map(Number); ui.last = { cell: ui.active, name: ui.monitor?.name ?? null, degree: ui.monitor?.degree ?? null, notes: ui.notes }; },
    clearnotes() { ui.notes = []; ui.active = null; ui.monitor = null; },
    monitor(name, deg) { ui.monitor = { name: String(name), degree: Number(deg) }; },
    previewnotes(...n) { ui.preview = n.map(Number); },
    root(v) { ui.root = Number(v); },
    scale(v) { ui.scale = Number(v); },
    octave(v) { ui.octave = Number(v); },
    voicingkey(v) { ui.voicing = String(v); },
    vl(v) { ui.vl = Number(v) === 1; },
    vlmode(v) { ui.vlmode = String(v); },
    extended(v) { ui.extended = Number(v) === 1; },
    avoidnotes(v) { ui.avoidNotes = Number(v) === 1; },
    smart(v) { ui.smartOn = Number(v) === 1; },
    smartmode(v) { ui.smartMode = String(v); },
    strumms(v) { ui.strum = Number(v); },
    strumramp(v) { ui.strumRamp = Number(v); },
    strumcurve(v) { ui.strumCurve = Number(v); },
    humanize(v) { ui.humanize = Number(v); },
    velmin(v) { ui.velMin = Number(v); },
    velmax(v) { ui.velMax = Number(v); },
    capture(v) { ui.capture = Number(v) === 1; },
    borpage(v) { ui.borPage = Number(v); },
    progloop(v) { ui.loop = Number(v); },
    progfull() { full = true; }
  };

  /** Read what the engine sent since the last call: screen state, and the notes that sound. */
  function absorb() {
    const events = host.events.splice(0);
    for (const [outlet, at, ...atoms] of events) {
      if (outlet === 0) velocity = Number(atoms[0]) || 0;
      else if (outlet >= 1 && outlet <= 6) sounds.push(velocity > 0 ? { on: true, pitch: Number(atoms[0]), velocity, delay: at } : { on: false, pitch: Number(atoms[0]), delay: at });
      else if (outlet === 7) HANDLERS[atoms[0]]?.(...atoms.slice(1));
    }
    if (events.length) { version++; cached = null; }
  }

  /** One message to the engine, then everything it deferred. Answers what the call returned. */
  function send(name, ...args) {
    const fn = fns[name];
    if (typeof fn !== 'function') throw new Error(`chord-grid: the engine has no message "${name}"`);
    let result;
    try {
      result = fn(...args);
      host.drain();
    } finally {
      absorb();
    }
    return result;
  }
  /** Tell whoever listens: the notes first (they are what was asked for), then that the state moved. */
  function flush(before) {
    const out = sounds;
    sounds = [];
    if (out.length && onNotes) onNotes(out);
    if (version !== before) for (const fn of [...listeners]) fn();
    return out;
  }
  function act(name, ...args) {
    const before = version;
    const result = send(name, ...args);
    flush(before);
    return result;
  }

  const scaleNotes = () => { const s = gridScales()[ui.scale]; return new Set((s ? s.notes : []).map((n) => mod12(ui.root + n))); };
  /** A note name for a chord root: the key's own spelling inside the scale; outside it the numeral says flat or sharp. */
  function rootName(pc, hint, inScale) {
    if (!speller) return hint && /^(b|sub)/.test(hint) && !inScale.has(pc) ? FLAT[pc] : SHARP[pc];
    if (inScale.has(pc)) return speller(pc);
    if (hint && /^(b|sub)/.test(hint)) return FLAT[pc];
    if (hint && /^#/.test(hint)) return SHARP[pc];
    return speller(pc);
  }
  /** "D#M9" → "EbM9" where the key spells it so (the engine names every root with sharps). */
  function respell(label, hint, inScale) {
    const m = /^([A-G]#?)(.*)$/.exec(String(label));
    if (!m) return String(label);
    return rootName(SHARP.indexOf(m[1]), hint, inScale) + m[2];
  }
  const pcName = (pc, inScale) => rootName(mod12(pc), null, inScale);
  /**
   * Name and numeral of a chord of the borrowed column that may not be on the page showing (a substitute, a card kept
   * from another page): the engine's own recipe for the name; the numeral from the key's table where it has one.
   */
  /** The engine's suffix for a borrowed-column type; it leaves two altered dominants unnamed (it never shows them). */
  function colorSuffix(semis, type) {
    const suffix = fns._borSuffix(semis, type);
    const x = suffix === '' ? fns._xParse(type) : null;
    if (x && x.t === 4 && x.s === 10 && (x.f === 6 || x.f === 8)) return x.f === 6 ? '7b5' : '7#5';
    return suffix;
  }
  function colorLabel(semis, type, inScale) {
    const s = mod12(semis);
    const sc = gridScales()[ui.scale];
    const row = fns.borrowedTableDeGamme().find((x) => x.semis === s && x.type === type);
    const dyn = fns._dynRoman(s, type);
    let roman = row ? row.roman : dyn !== '·' ? dyn : '';
    if (!roman && type !== 'maj' && type !== 'min') {
      // a dominant or a diminished seventh that leads to a degree of the key: V7 of it, vii° of it
      const to = sc.intervals.findIndex((iv, d) => fns._degValid(d) && iv === mod12(s + (type === 'dim7' ? 1 : 5)));
      const lead = type === 'dim7' ? 'vii°' : 'V';
      if (to >= 0 && (type === 'dim7' || fns._colorIvs(type).includes(10))) roman = to === 0 ? `${lead}7` : `${lead}/${fns._romanOf(to)}`;
    }
    // outside the scale and without a numeral: a diminished seventh is a leading tone (sharp), the rest are flat degrees
    const hint = roman || (type === 'dim7' ? '#' : 'b');
    return { label: respell(SHARP[mod12(ui.root + s)] + colorSuffix(s, type), hint, inScale), roman: roman || '·' };
  }

  function cardView(p, i, inScale) {
    const offer = fns._tensOffer(p).map((o) => {
      const [state, reason] = String(o.state).split(':');
      return { name: o.t, state, reason: reason || null, why: reason ? AVOID_WHY[reason] || reason : null, inScale: !!o.diat };
    });
    const sorted = p.notes.slice().sort((a, b) => a - b);
    const spec = fns._vl2_specFor(p.fn, p.deg, p.colorSemis, p.colorType);
    const bassPc = sorted.length ? mod12(sorted[0]) : null;
    const slash = spec && bassPc !== null && bassPc !== mod12(spec.rootPc) ? pcName(bassPc, inScale) : null;
    // (a chord taken from a page that was not showing has no numeral of its own: the key's table gives it one)
    const known = p.roman && p.roman !== '·';
    const roman = known || p.fn !== 'color' ? p.roman || '·' : colorLabel(p.colorSemis, p.colorType, inScale).roman;
    const hint = roman !== '·' ? roman : p.fn === 'color' ? (p.colorType === 'dim7' ? '#' : 'b') : null;
    return {
      index: i, uid: p.uid ?? i,
      name: respell(p.name, hint, inScale), baseName: respell(p.baseName || p.name, hint, inScale), roman,
      degree: p.deg, borrowed: p.fn === 'color', cell: p.fn === 'color' ? `b:${p.colorSemis}:${p.colorType}` : `d:${p.deg}:${p.fn}`,
      start: fns._entryStart(i), bars: fns._entryBars(p), notes: sorted,
      voicing: fns._isVoicingName(p.voicingResolved) ? p.voicingResolved : p.voicing || 'classic', voicingAsked: p.voicing || 'classic',
      inversion: Number(p.inv) || 0, pinned: p.vlMode === 'pinned', octave: Number(p.oct) || 0,
      tensions: (p.tensions || []).slice(), offer, bass: slash,
      // a card keeps playing after the key moved away from it; the grid no longer has its cell
      offGrid: p.fn !== 'color' && !fns.gridTypeValid(p.deg, p.fn)
    };
  }

  function build() {
    const inScale = scaleNotes();
    const scales = gridScales();
    const sc = scales[ui.scale] || scales[0];
    const columns = ui.columns.map((cells, d) => {
      const q = ui.qualities[d] ?? 0;
      const numeral = q === 1 ? ROMAN[d].toLowerCase() : q === 2 ? `${ROMAN[d].toLowerCase()}°` : q === 3 ? `${ROMAN[d]}+` : ROMAN[d];
      // a seventh a whole tone under the tonic does not lead: it is the subtonic
      const name = d === 6 && sc.intervals[6] !== 11 ? 'Subtonic' : DEGREE_NAMES[d];
      return {
        degree: d, roman: numeral, name, quality: QUALITY[q] || 'maj', root: pcName(ui.root + sc.intervals[d], inScale),
        cells: cells.map((c) => {
          const id = `d:${d}:${c.fn}`;
          return { id, kind: 'd', degree: d, fn: c.fn, label: respell(c.label, null, inScale), smart: ui.smart.get(id) || null };
        })
      };
    });
    const borrowed = {
      page: ui.borPage, pages: fns.borPagesDispo(),
      cells: ui.bor.map((c, index) => ({
        id: `b:${c.semis}:${c.type}`, kind: 'b', index, semis: c.semis, type: c.type, label: respell(c.label, c.roman, inScale), roman: c.roman,
        target: c.target ? respell(c.target, null, inScale) : null, smart: ui.smartBor.get(index) || null
      }))
    };
    const labelOf = (id) => columns.flatMap((c) => c.cells).find((c) => c.id === id)?.label ?? borrowed.cells.find((c) => c.id === id)?.label ?? null;
    const progression = eng.get('progression');
    const cards = progression.map((p, i) => cardView(p, i, inScale));
    const selected = eng.get('progSel');
    const last = ui.last && { cell: ui.last.cell, name: ui.last.name ? respell(ui.last.name, null, inScale) : labelOf(ui.last.cell), notes: ui.last.notes.slice().sort((a, b) => a - b) };
    return {
      version,
      key: { root: ui.root, name: pcName(ui.root, inScale), scale: sc.id, scaleLabel: sc.label, notes: [...inScale] },
      columns, borrowed,
      sounding: ui.active || ui.notes.length ? { cell: ui.active, notes: ui.notes.slice().sort((a, b) => a - b) } : null,
      last,
      settings: {
        voicing: ui.voicing, leading: !ui.vl ? 'off' : ui.vlmode === 'flow' ? 'follow' : 'anchor', smart: !ui.smartOn ? 'off' : ui.smartMode === 'voiceleading' ? 'voiceleading' : 'function',
        extended: ui.extended, avoidNotes: ui.avoidNotes, octave: ui.octave, strum: ui.strum, strumRamp: ui.strumRamp, strumCurve: ui.strumCurve,
        humanize: ui.humanize, velMin: ui.velMin, velMax: ui.velMax, capture: ui.capture
      },
      progression: {
        cards, selected: selected >= 0 && selected < cards.length ? selected : -1, loopBars: fns._loopBars(), endBars: fns._progEnd(), canUndo: eng.get('_undo').length > 0,
        minBars: eng.get('PROG_BARS_MIN'), maxBars: eng.get('PROG_BARS_MAX'), trackBars: eng.get('PROG_TRACK_BARS'), blockBars: eng.get('PROG_BLOC_BARS')
      }
    };
  }

  const cardIndex = (i) => {
    const n = eng.get('progression').length;
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`chord-grid: no card ${i} (the track has ${n})`);
    return i;
  };
  const cellOf = (cell) => {
    const c = typeof cell === 'string' ? cellFromId(cell) : cell;
    if (!c || (c.kind !== 'd' && c.kind !== 'b')) throw new Error(`chord-grid: not a cell: ${JSON.stringify(cell)}`);
    return c;
  };
  /** Is this cell on the grid as it stands (a diatonic cell of the key, or a chord of the borrowed column's page)? */
  const onGrid = (c) => (c.kind === 'd' ? !!ui.columns[c.degree]?.some((x) => x.fn === c.fn) : ui.bor.some((x) => x.semis === c.semis && x.type === c.type));
  // A chord of the borrowed column plays from any page (its type carries its notes): a card keeps a chord of a page
  // that has since moved on, and a caller may name one that is not showing. Its type must be one the engine reads.
  const COLOR_TYPES = ['maj', 'min', 'dim7', 'maj7', 'dom7', 'sub7'];
  const playable = (c) => onGrid(c) || (c.kind === 'b' && Number.isInteger(c.semis) && c.semis >= 0 && c.semis < 12 && (COLOR_TYPES.includes(c.type) || !!fns._xParse(c.type)));
  /** The engine's own name of a cell (sharps), as a card keeps it. */
  const rawLabel = (c) => (c.kind === 'd' ? fns.gridLabel(c.degree, c.fn) : ui.bor.find((x) => x.semis === c.semis && x.type === c.type)?.label ?? SHARP[mod12(ui.root + c.semis)] + colorSuffix(c.semis, c.type));

  const SETTERS = {
    voicing: (v) => { if (!VOICINGS.some((x) => x.id === v)) throw new Error(`chord-grid: unknown voicing "${v}" (${VOICINGS.map((x) => x.id).join(', ')})`); send('voicingkey', v); },
    leading: (v) => {
      if (!LEADING.some((x) => x.id === v)) throw new Error(`chord-grid: unknown leading "${v}" (off, anchor, follow)`);
      if (v !== 'off') send('vlmode', v === 'follow' ? 'flow' : 'anchored');
      send('voiceleading', v === 'off' ? 0 : 1);
    },
    smart: (v) => {
      if (!SMART_MODES.some((x) => x.id === v)) throw new Error(`chord-grid: unknown smart mode "${v}" (off, function, voiceleading)`);
      if (v !== 'off') send('smartmode', v);
      send('smart', v === 'off' ? 0 : 1);
    },
    extended: (v) => send('extended', v ? 1 : 0),
    avoidNotes: (v) => send('avoidnotes', v ? 1 : 0),
    octave: (v) => send('octave', Math.round(v)),
    strum: (v) => send('strumms', Math.round(v)),
    strumRamp: (v) => send('strumramp', Math.round(v)),
    strumCurve: (v) => send('strumcurve', Math.round(v)),
    humanize: (v) => send('humanizeamt', Math.round(v)),
    velMin: (v) => send('velmin', Math.round(v)),
    velMax: (v) => send('velmax', Math.round(v)),
    capture: (v) => send('capture', v ? 1 : 0)
  };

  const grid = {
    /** The grid as it stands: a new object whenever something changed (compare by identity, or by `version`). */
    view() { return cached || (cached = build()); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The engine's console since it started: lines it logged when it refused something. */
    log: host.log,

    /** Change the key: the tonic (pitch class) and/or the scale (a gridScales() id). Cards on the track follow. */
    setKey({ root: r, scale: s, spell: sp } = {}) {
      const before = version;
      if (sp !== undefined) { speller = sp; version++; cached = null; }
      if (s !== undefined && s !== gridScales()[ui.scale]?.id) {
        const i = gridScales().findIndex((x) => x.id === s);
        if (i < 0) throw new Error(`chord-grid: unknown scale "${s}"`);
        send('scaleidx', i);
      }
      if (r !== undefined && mod12(r) !== ui.root) send('rootidx', mod12(r));
      flush(before);
    },
    /** Change settings: { voicing, leading, smart, extended, avoidNotes, octave, strum, strumRamp, strumCurve, humanize, velMin, velMax, capture }. */
    set(patch = {}) {
      const before = version;
      for (const [k, v] of Object.entries(patch)) {
        if (!SETTERS[k]) throw new Error(`chord-grid: unknown setting "${k}" (${Object.keys(SETTERS).join(', ')})`);
        if (v !== undefined && v !== grid.view().settings[k]) SETTERS[k](v);
      }
      flush(before);
    },
    setTempo(next) { if (next > 0) host.tempo = next; },
    reseed(next) { host.reseed(next); },
    /** Show a page of the borrowed column (0 Borrowed, 1 Tritone, 2 Mediants, 3 Ext); a page the key does not have falls back to 0. */
    setBorrowedPage(page) { act('borpage', page); },

    /** Play a cell until release(). False if the cell is not on the grid as it stands. */
    press(cell, vel = 100) {
      const c = cellOf(cell);
      if (!playable(c)) return false;
      eng.set('currentVelocity', Math.max(1, Math.min(127, Math.round(vel))));
      act('playFlatCell', c);
      return true;
    },
    release() { act('release'); },
    /** The notes a cell would play now (voicing, voice leading and all), without playing it or moving anything. */
    preview(cell) {
      const c = cellOf(cell);
      const notes = c.kind === 'b' ? fns._vl2_previewNotes('color', 0, c.semis, c.type) : fns._vl2_previewNotes(c.fn, c.degree, 0, '');
      return (notes || []).slice().sort((a, b) => a - b);
    },

    /**
     * Every chord the grid offers in this key, not only the page showing:
     *   { columns, borrowed, mediants, tritone, tritoneAll, ext: [{ degree, roman, cells }] }
     * tritone = the four the Tritone page shows now (they follow what was just played); tritoneAll = the substitute of
     * each degree's dominant; ext = the Ext page of every degree. Cells are as in view() (plus `group`).
     */
    catalog() {
      const inScale = scaleNotes();
      const keepPage = ui.borPage;
      const pageCells = (p, group) => {
        if (!fns.borPagesDispo().includes(p)) return [];
        if (ui.borPage !== p) send('borpage', p);
        return grid.view().borrowed.cells.map((c) => ({ ...c, group }));
      };
      const colour = (c, group, extra = {}) => ({ id: `b:${c.semis}:${c.type}`, kind: 'b', semis: c.semis, type: c.type, roman: c.roman, group, ...extra, label: respell(SHARP[mod12(ui.root + c.semis)] + colorSuffix(c.semis, c.type), c.roman, inScale) });
      const out = {
        columns: grid.view().columns.map((col) => ({ ...col, cells: col.cells.map((c) => ({ ...c, group: col.roman })) })),
        borrowed: pageCells(0, 'borrowed'), tritone: pageCells(1, 'tritone'), mediants: pageCells(2, 'mediants'), tritoneAll: [], ext: []
      };
      if (ui.borPage !== keepPage) send('borpage', keepPage);
      const sc = gridScales()[ui.scale];
      const wasDeg = eng.get('_extDeg');
      for (let d = 0; d < 7; d++) {
        if (!fns._degValid(d)) continue;
        const target = respell(fns.gridLabel(d, 'triad'), null, inScale);
        // (a diminished or augmented chord is not tonicised: no substitute dominant leads to it)
        if (fns.chordQuality(d) < 2) out.tritoneAll.push(colour({ semis: mod12(sc.intervals[d] + 1), type: 'sub7', roman: d === 0 ? 'subV7' : `subV7/${fns._romanOf(d)}` }, 'tritone', { target }));
        eng.set('_extDeg', d);
        out.ext.push({ degree: d, roman: fns._romanOf(d), cells: fns._extTable().map((c) => colour(c, 'ext', { degree: d })) });
      }
      eng.set('_extDeg', wasDeg);
      sounds = [];
      cached = null;
      return out;
    },
    /**
     * The cell a chord name stands for in this key ("Dm9", "Cmaj7", "Eb", "Db7", "FM13"), or null:
     * { cell, id, label, roman, group }. Looked for in the key's own columns first, then the borrowed column's pages
     * (as it shows them, then its other face: the names with EXT off or on), then the Ext page of each degree.
     */
    find(text) {
      const want = chordKey(text);
      if (!want) return null;
      const is = (c) => { const k = chordKey(c.label); return k && k.pc === want.pc && k.suffix === want.suffix; };
      const search = () => {
        const cat = grid.catalog();
        return [...cat.columns.flatMap((c) => c.cells), ...cat.borrowed, ...cat.mediants, ...cat.tritone, ...cat.tritoneAll, ...cat.ext.flatMap((e) => e.cells)].find(is) || null;
      };
      let hit = search();
      if (!hit) {
        // the borrowed column has two faces: plain, and enriched under EXT ("Eb" / "EbM9")
        const was = ui.extended;
        send('extended', was ? 0 : 1);
        try { hit = search(); } finally { send('extended', was ? 1 : 0); sounds = []; cached = null; }
      }
      return hit && { cell: cellFromId(hit.id), id: hit.id, label: hit.label, roman: hit.roman ?? null, group: hit.group };
    },

    // ------------------------------------------------------------------ the track

    /**
     * Put a cell on the track as a card: played once (it sounds, and leads the voices of what follows), then placed at
     * `at` (bars from the start; default: after the selected card, else at the end) for `bars`, with its tensions.
     * Answers { index, refused } — index −1 when the track has no room; refused = tensions the chord would not take.
     */
    add(cell, { at = null, bars = null, tensions = [], voicing = null, inversion = null, octave = null, velocity: vel = 100 } = {}) {
      const c = cellOf(cell);
      const before = version;
      if (!playable(c)) throw new Error(`chord-grid: the cell ${cellId(c)} is not on the grid in this key`);
      eng.set('currentVelocity', Math.max(1, Math.min(127, Math.round(vel))));
      const was = eng.get('captureMode');
      eng.set('captureMode', false);
      full = false;
      let index = -1;
      const refused = [];
      try {
        send('playFlatCell', c);
        send('release');
        const known = new Set(eng.get('progression'));
        send('captureone', rawLabel(c), at === null ? -1 : at);
        index = eng.get('progression').findIndex((p) => !known.has(p));
        if (index >= 0 && !full) {
          if (bars !== null) send('progbars', index, bars);
          if (voicing) send('progvoicing', index, voicing);
          if (octave) send('setoct', index, octave);
          if (inversion) send('setinv', index, inversion);
          for (const t of tensions) {
            send('settension', index, t, 1);
            const o = fns._tensOffer(eng.get('progression')[index]).find((x) => x.t === t);
            if (!o || (o.state !== 'on' && o.state !== 'built')) refused.push({ tension: t, state: o ? String(o.state).split(':')[0] : 'none', why: o ? AVOID_WHY[String(o.state).split(':')[1]] || null : null });
          }
        } else index = -1;
      } finally {
        eng.set('captureMode', was);
        flush(before);
      }
      return { index, refused };
    },
    /** The last chord played becomes a card (at `at` bars, or after the selection): what dropping a cell on the track does. */
    addLast(at = null) {
      const last = ui.last;
      if (!last || !eng.get('lastChordNotes').length) return -1;
      full = false;
      const known = new Set(eng.get('progression'));
      const cell = last.cell && cellFromId(last.cell);
      act('captureone', (cell && rawLabel(cell)) || last.name || '?', at === null ? -1 : at);
      return full ? -1 : eng.get('progression').findIndex((p) => !known.has(p));
    },
    select(i) { const before = version; eng.set('progSel', i === null || i < 0 ? -1 : cardIndex(i)); version++; cached = null; flush(before); },
    /** Hear a card (held until release()). */
    playCard(i) { act('playprog', cardIndex(i)); },
    remove(i) { act('removeat', cardIndex(i)); },
    /** Move a card to a bar (eighths of a bar); dropped inside another card it lands before or after it. */
    move(i, bar) { act('progplace', cardIndex(i), bar); },
    /** A card's length in bars (1/8 … 16): it takes the room of the cards it grows over. */
    resize(i, bars) { act('progbars', cardIndex(i), bars); },
    /** Move a card's start, its end staying where it is. */
    trim(i, bar) { act('progtrim', cardIndex(i), bar); },
    setVoicing(i, v) { if (!VOICINGS.some((x) => x.id === v)) throw new Error(`chord-grid: unknown voicing "${v}"`); act('progvoicing', cardIndex(i), v); },
    /** Inversion of one card (0 = as voiced; it pins the card: voice leading no longer moves it). */
    setInversion(i, inv) { act('setinv', cardIndex(i), inv); },
    /** Give the card back to voice leading. */
    resetInversion(i) { act('resetinv', cardIndex(i)); },
    setOctave(i, n) { act('setoct', cardIndex(i), n); },
    /** Add or remove a tension ('b9' '9' '#9' '11' '#11' 'b13' '13'). False when the chord does not take it (see the card's offer). */
    setTension(i, t, on = true) {
      if (!TENSIONS.includes(t)) throw new Error(`chord-grid: unknown tension "${t}" (${TENSIONS.join(' ')})`);
      act('settension', cardIndex(i), t, on ? 1 : 0);
      return (eng.get('progression')[i].tensions || []).includes(t) === !!on;
    },
    /** Voice the whole track again as one chain, each card led from the one before. */
    revoiceAll() { act('voiceleadall'); },
    undo() { act('progundo'); },
    clear() { act('clearprog'); },
    /** Length of the loop in bars (blocks of four; never shorter than one block). */
    setLoop(bars) { act('progloop', bars); },

    /**
     * What could stand in for a card ('subs'), follow it ('next'), or how else it could be voiced ('voicings'):
     * [{ k, name, kind, level, notes }] — `k` is what applyOption/auditionOption take.
     */
    options(i, mode = 'subs') {
      if (!(mode in OPTION_MODES)) throw new Error(`chord-grid: unknown options "${mode}" (subs, next, voicings)`);
      cardIndex(i);
      const inScale = scaleNotes();
      const was = eng.get('progMode');
      eng.set('progMode', OPTION_MODES[mode]);
      try {
        return fns._progOptions(i).map((o, k) => ({
          k, kind: o.kind, level: o.lvl ?? null, rank: o.rang ?? null,
          name: o.kind === 'voic' ? VOICINGS.find((v) => v.id === o.voicing)?.label || o.voicing : o.fn === 'color' ? colorLabel(o.colorSemis, o.colorType, inScale).label : respell(fns.gridLabel(o.deg, o.fn), null, inScale),
          roman: o.kind === 'voic' ? null : o.fn === 'color' ? colorLabel(o.colorSemis, o.colorType, inScale).roman : fns._romanOf(o.deg),
          voicing: o.voicing || null,
          notes: (fns._realizeOption(i, o) || []).slice().sort((a, b) => a - b)
        }));
      } finally { eng.set('progMode', was); }
    },
    /** Use an option: a substitute or a voicing replaces the card, a "next" chord goes in after it. It sounds. */
    applyOption(i, mode, k) { return option(i, mode, k, true); },
    /** Hear an option without changing the track (held until release()). */
    auditionOption(i, mode, k) { return option(i, mode, k, false); },

    /**
     * What the track plays, card by card: { loopBars, notes: [{ card, pitch, bar, bars, offset, velocity }] }.
     * bar/bars = the card's place and length in bars; offset = how late the note starts, in beats (strum and humanize,
     * from milliseconds at the tempo); velocity 1–127. A note ends with its card.
     */
    notes() {
      const made = fns._progToNotes();
      const loopBars = fns._loopBars();
      if (!made) return { loopBars, notes: [] };
      const per = made.barLen;
      const out = [];
      let k = 0;
      eng.get('progression').forEach((p, i) => {
        const at = fns._entryStart(i) * per;
        if (at >= made.total - 1e-9) return;
        for (let j = 0; j < p.notes.length; j++) {
          const n = made.notes[k++];
          const offset = n.start - at;
          out.push({ card: i, pitch: n.pitch, bar: at / per, bars: (n.dur + offset) / per, offset, velocity: n.vel });
        }
      });
      if (k !== made.notes.length) throw new Error('chord-grid: the engine wrote its notes in an order this adapter does not know');
      return { loopBars, notes: out };
    },

    /** Everything needed to come back to this grid later: a string (the engine's own format for the track, plus the settings). */
    save() {
      const v = grid.view();
      return JSON.stringify({ chordGrid: 1, tuple: TUPLE_SOURCE.version, settings: v.settings, page: v.borrowed.page, track: fns._persistTexte() });
    },
    /** Restore what save() gave. False if it does not read (nothing is changed then). */
    load(text) {
      let d;
      try { d = JSON.parse(text); } catch { return false; }
      if (!d || d.chordGrid !== 1 || typeof d.track !== 'string') return false;
      let track;
      try { track = JSON.parse(d.track); } catch { return false; }
      if (!track || track.v !== 1 || !Array.isArray(track.cards)) return false;
      const before = version;
      const { capture: _c, ...settings } = d.settings || {};
      for (const [k, v] of Object.entries(settings)) { try { if (SETTERS[k] && v !== undefined) SETTERS[k](v); } catch { /* a setting a newer version wrote: skipped */ } }
      // the engine takes its track in the pieces Live would hand back; an empty track is restored as "nothing"
      send('persist', track.cards.length ? encodeURIComponent(d.track) : '');
      if (Number.isInteger(d.page)) send('borpage', d.page);
      flush(before);
      return true;
    }
  };

  function option(i, mode, k, commit) {
    if (!(mode in OPTION_MODES)) throw new Error(`chord-grid: unknown options "${mode}" (subs, next, voicings)`);
    cardIndex(i);
    const before = version;
    const was = { mode: eng.get('progMode'), capture: eng.get('captureMode'), sel: eng.get('progSel') };
    const known = new Set(eng.get('progression'));
    eng.set('progMode', OPTION_MODES[mode]);
    eng.set('captureMode', commit);
    eng.set('progSel', i);
    full = false;
    try { send('selopt', k); } finally {
      eng.set('progMode', was.mode);
      eng.set('captureMode', was.capture);
      if (!commit) eng.set('progSel', was.sel);
      version++; cached = null;
      flush(before);
    }
    if (!commit) return i;
    const fresh = eng.get('progression').findIndex((p) => !known.has(p));
    return full ? -1 : fresh >= 0 ? fresh : i;
  }

  // start: let the engine's own start-up run, then put it in the key asked for
  host.drain();
  absorb();
  send('requeststate');
  sounds = [];
  grid.setKey({ root, scale });
  return grid;
}
