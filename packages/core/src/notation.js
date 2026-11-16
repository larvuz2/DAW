// LLM- and human-friendly text notations: step strings, positions, durations, note lists.
import { STEP, PPQ, ticksPerBar, beatsPerBar } from './constants.js';
import { noteName, parseNote } from './music.js';

/**
 * Parse a drum step string into hits.
 *   x = hit (velocity 0.8), X = accent (1.0), o = ghost (0.45), 1-9 = velocity 0.1-0.9
 *   - . _ 0 = rest. Spaces and | are ignored (use them to group beats/bars).
 * Example: "x---|x---|x---|x---" (four-on-the-floor), "--x---x---x---x-"
 */
export function parseStepString(str) {
  const hits = [];
  let step = 0;
  for (const ch of String(str)) {
    if (ch === ' ' || ch === '|' || ch === '\n' || ch === '\t') continue;
    let vel = null;
    if (ch === 'x') vel = 0.8;
    else if (ch === 'X') vel = 1;
    else if (ch === 'o' || ch === 'O') vel = 0.45;
    else if (ch >= '1' && ch <= '9') vel = (ch.charCodeAt(0) - 48) / 10;
    else if (ch === '-' || ch === '.' || ch === '_' || ch === '0') vel = null;
    else throw new Error(`Invalid step character "${ch}". Use x X o 1-9 for hits and - . _ for rests.`);
    if (vel !== null) hits.push({ step, velocity: vel });
    step++;
  }
  return { hits, steps: step };
}

/** Format notes of one channel as a step string (one char per 16th). */
/** barSteps: steps per bar (16 in 4/4, 12 in 3/4 and 6/8) — bars are separated by " | ", beats by spaces. */
export function toStepString(notes, steps, { barSteps = 16, group = barSteps % 4 === 0 ? 4 : barSteps % 3 === 0 ? 3 : barSteps } = {}) {
  const cells = new Array(steps).fill('-');
  for (const n of notes || []) {
    if (n.start % STEP !== 0) continue;
    const s = n.start / STEP;
    if (s >= steps) continue;
    cells[s] = n.velocity >= 0.95 ? 'X' : n.velocity < 0.6 ? 'o' : 'x';
  }
  let out = '';
  for (let i = 0; i < steps; i++) {
    if (i && i % barSteps === 0) out += ' | ';
    else if (i && group && i % group === 0) out += ' ';
    out += cells[i];
  }
  return out;
}

/** True if all notes sit on 16th-step boundaries with one pitch (drum-like data). */
export function isStepLike(notes) {
  if (!notes?.length) return true;
  const key = notes[0].key;
  return notes.every((n) => n.start % STEP === 0 && n.key === key && n.length <= STEP * 2);
}

/** "bar.beat.step" (1-based) for a tick position, as the toolbar's song position display shows it. */
export function formatPosition(ticks, project) {
  const bar = ticksPerBar(project);
  const b = Math.floor(ticks / bar);
  const rem = ticks - b * bar;
  const beat = Math.floor(rem / PPQ);
  const step = Math.floor((rem - beat * PPQ) / STEP);
  return `${b + 1}.${beat + 1}.${step + 1}`;
}

/** Convert a time value with unit into ticks. unit: steps (16ths) | beats | bars | ticks */
export function toTicks(value, unit = 'steps', project) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`Invalid time value "${value}"`);
  switch (unit) {
    case 'ticks': return Math.round(v);
    case 'beats': return Math.round(v * PPQ);
    case 'bars': return Math.round(v * ticksPerBar(project));
    case 'steps':
    default: return Math.round(v * STEP);
  }
}

export function fromTicks(ticks, unit = 'steps', project) {
  switch (unit) {
    case 'ticks': return ticks;
    case 'beats': return ticks / PPQ;
    case 'bars': return ticks / ticksPerBar(project);
    default: return ticks / STEP;
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Compact note list: "C4@0+4 v0.8" = note C4 at step 0, 4 steps long. */
export function formatNoteList(notes) {
  return (notes || [])
    .map((n) => `${noteName(n.key)}@${round3(n.start / STEP)}+${round3(n.length / STEP)}${n.velocity !== 0.8 ? ` v${round3(n.velocity)}` : ''}`)
    .join(', ');
}

// ---------------------------------------------------------------- positions, durations and notes as text
// One way to write "where" and "how long" for every tool, in the words a musician uses — far fewer tokens for an
// agent than a JSON object per note, and readable in a chat:
//
//   position   "5"        bar 5                       "5.3"      bar 5, beat 3
//              "5.3.2"    … its 2nd sixteenth (what the toolbar shows)
//              "5.3.2.12" … plus 12 ticks (24 in a sixteenth), for anything finer
//              "70s"      70 steps (sixteenths) from the start, 0-based — "70.5s" works too
//              "17.5b"    17.5 beats from the start, 0-based
//   duration   "1/4" "1/8" "1/16"  note values · "1/8t" triplet · "1/4d" dotted · "1/4+1/16" tied
//              "2bar" bars · "1.5b" beats · "3s" steps
//   note line  <start> <pitch[+pitch…]> <duration> [v<velocity>] [r<release velocity>] [p<pan>]   # comment
//              e.g.  1.1 D3+A3+F4 1/2 v0.7      start may be ">" (right after the line before) or "=" (with it)
//
// Bars and beats are 1-based, as on the toolbar; a beat is a quarter note. Positions count from the start of
// whatever is being written (a pattern's bar 1 is its first bar).

export const POSITION_HINT = 'write a position as "bar", "bar.beat" or "bar.beat.sixteenth" (1-based: "1" = the start, "2.3" = bar 2 beat 3, "2.3.2" = one sixteenth later), as steps from the start with an s ("6s", 0-based), or as beats with a b ("1.5b")';
export const DURATION_HINT = 'write a duration as a note value ("1/4", "1/8", "1/16", "1/8t" triplet, "1/4d" dotted, "1/4+1/16" tied), in bars ("2bar"), beats ("1.5b") or steps ("3s")';
export const NOTE_LINE_HINT = 'one note or chord per line: <start> <pitch[+pitch…]> <duration> [v<velocity>] [r<release velocity>] [p<pan>] — e.g. "1.1 D3+A3+F4 1/2 v0.7", "2.3.3 A4 1/8t", "> C5 1/4" (> = right after the line before)';

const MAX_POSITION = PPQ * 4 * 100000;
const plain = (x) => /^\d+(\.\d+)?$/.test(x);

/** A position (see above) → ticks from the start. A number is steps, as everywhere in the tools. */
export function parsePosition(value, project) {
  const fail = (why) => { throw new Error(`"${value}" is not a position: ${why}. ${POSITION_HINT[0].toUpperCase()}${POSITION_HINT.slice(1)}.`); };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) fail('a number here is steps from the start, 0 or more');
    return Math.round(value * STEP);
  }
  const text = String(value ?? '').trim().toLowerCase();
  let ticks;
  const unit = /^(\d+(?:\.\d+)?)\s*(s|b|steps?|beats?)$/.exec(text);
  if (unit) ticks = Math.round(Number(unit[1]) * (unit[2][0] === 's' ? STEP : PPQ));
  else {
    if (!/^\d+(\.\d+){0,3}$/.test(text)) fail('it is not in one of the accepted forms');
    const [bar, beat = 1, step = 1, tick = 0] = text.split('.').map(Number);
    const beats = beatsPerBar(project);
    const stepsInBeat = PPQ / STEP;
    if (bar < 1) fail('bars start at 1');
    if (beat < 1 || beat > Math.ceil(beats)) fail(`a bar has ${beats} beats here, so the beat is 1–${Math.ceil(beats)}`);
    if (step < 1 || step > stepsInBeat) fail(`the third number is the sixteenth inside the beat, 1–${stepsInBeat} (for finer positions add ticks as a fourth number, 0–${STEP - 1}, or use steps: "2.5s")`);
    if (tick >= STEP) fail(`the fourth number is ticks inside the sixteenth, 0–${STEP - 1}`);
    const inBar = (beat - 1) * PPQ + (step - 1) * STEP + tick;
    // (7/8 has three and a half beats: "1.4.3" would be past the bar line)
    if (inBar >= ticksPerBar(project)) fail(`that is past the end of the bar, which has ${beats} beats here`);
    ticks = (bar - 1) * ticksPerBar(project) + inBar;
  }
  if (!(ticks <= MAX_POSITION)) fail('it is too far away');
  return ticks;
}

/** The shortest text for a tick position: "5" on a bar line, "5.3" on a beat, "5.3.2" on a sixteenth, else with ticks. */
export function formatPositionText(ticks, project) {
  const bar = ticksPerBar(project);
  const b = Math.floor(ticks / bar);
  const rem = ticks - b * bar;
  const beat = Math.floor(rem / PPQ);
  const step = Math.floor((rem - beat * PPQ) / STEP);
  const tick = rem - beat * PPQ - step * STEP;
  if (tick) return `${b + 1}.${beat + 1}.${step + 1}.${tick}`;
  if (step) return `${b + 1}.${beat + 1}.${step + 1}`;
  return beat ? `${b + 1}.${beat + 1}` : `${b + 1}`;
}

/** A duration (see above) → ticks, at least 1. A number is steps. */
export function parseDuration(value, project) {
  const fail = (why) => { throw new Error(`"${value}" is not a duration: ${why}. ${DURATION_HINT[0].toUpperCase()}${DURATION_HINT.slice(1)}.`); };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) fail('a number here is steps, more than 0');
    return Math.max(1, Math.round(value * STEP));
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) fail('it is empty');
  let total = 0;
  for (const part of text.split('+')) {
    const piece = part.trim();
    const frac = /^(\d+)\/(\d+)(t|d)?$/.exec(piece);
    const unit = /^(\d+(?:\.\d+)?)\s*(bars?|b|beats?|s|steps?)$/.exec(piece);
    if (frac) {
      const [, n, d, mod] = frac;
      if (!Number(n) || !Number(d)) fail('a note value needs numbers above zero');
      total += ((Number(n) / Number(d)) * PPQ * 4) * (mod === 't' ? 2 / 3 : mod === 'd' ? 1.5 : 1);
    } else if (unit) {
      const k = unit[2].startsWith('bar') ? ticksPerBar(project) : unit[2][0] === 'b' ? PPQ : STEP;
      total += Number(unit[1]) * k;
    } else if (plain(piece)) total += Number(piece) * STEP;
    else fail(`"${piece}" is not in one of the accepted forms`);
  }
  if (!(total > 0) || total > MAX_POSITION) fail(total > 0 ? 'it is too long' : 'it is zero');
  return Math.max(1, Math.round(total));
}

const NOTE_VALUES = [[1, 1], [1, 2], [1, 4], [1, 8], [1, 16], [1, 32], [1, 64]];
/** The most readable text for a length in ticks: bars, a note value (plain, dotted or triplet), else steps. */
export function formatDuration(ticks, project) {
  const bar = ticksPerBar(project);
  if (ticks >= bar && ticks % bar === 0) return `${ticks / bar}bar`;
  for (const [n, d] of NOTE_VALUES) {
    const base = (PPQ * 4 * n) / d;
    if (ticks === base) return `${n}/${d}`;
    if (ticks === base * 1.5) return `${n}/${d}d`;
    if (ticks * 3 === base * 2) return `${n}/${d}t`;
  }
  return `${round3(ticks / STEP)}s`;
}

/** 0..1 as it is; a whole number 2..127 is a MIDI velocity. Anything else (1.5, 0x10, 200) is refused, not guessed. */
function velocityOf(text, line) {
  const v = /^\d+(\.\d+)?$|^\.\d+$/.test(text) ? Number(text) : NaN;
  if (!(v >= 0 && v <= 1) && !(Number.isInteger(v) && v >= 2 && v <= 127)) throw new Error(`${line}: velocity "v${text}" must be 0–1 (1 = full) or a MIDI velocity 2–127`);
  return v <= 1 ? v : v / 127;
}

/**
 * Compact note text → notes ({ key, start, length, velocity, pan?, releaseVelocity? }, ticks from the start).
 * Lines are separated by newlines or ";"; " #" starts a comment; a chord is pitches joined by "+".
 * opts.velocity: the velocity of lines that give none (default 0.8).
 */
export function parseNoteText(text, project, { velocity = 0.8 } = {}) {
  const notes = [];
  let prevStart = 0;
  let prevEnd = 0;
  let count = 0;
  // A comment starts at a "#" that stands alone or begins a word (the one in "F#3" is a sharp) and runs to the end of
  // its line. A ";" inside one could be the end of the comment or part of it — notes added or notes lost — so that
  // is asked back, not guessed.
  const lines = String(text ?? '').split('\n').flatMap((line) => {
    const comment = /(^|\s)#.*$/.exec(line);
    if (comment && comment[0].includes(';')) throw new Error(`The comment "${comment[0].trim().slice(0, 40)}" holds a ";": a comment runs to the end of its line, so put what follows the ";" on a line of its own (or drop the ";" from the comment)`);
    return (comment ? line.slice(0, comment.index) : line).split(';');
  });
  lines.forEach((raw, i) => {
    const body = raw.trim();
    if (!body) return;
    const where = `Line ${i + 1} ("${body.length > 40 ? `${body.slice(0, 37)}…` : body}")`;
    const tokens = body.split(/\s+/);
    if (tokens.length < 3) throw new Error(`${where}: a note line needs a start, a pitch and a duration — ${NOTE_LINE_HINT}`);
    const [startText, pitchText, lengthText, ...flags] = tokens;
    let start;
    let length;
    let keys;
    try {
      if (startText === '>' || startText === '=') {
        if (!count) throw new Error(`"${startText}" refers to the line before, and this is the first line`);
        start = startText === '>' ? prevEnd : prevStart;
      } else start = parsePosition(startText, project);
      keys = pitchText.split('+').map((k) => {
        if (!k) throw new Error(`"${pitchText}" has an empty pitch (pitches of a chord are joined by "+", e.g. C4+E4+G4)`);
        // ("60 1 4" is not key 60 at step 1: the order is start, pitch, duration — and nobody writes MIDI note 1)
        if (/^\d+$/.test(k) && Number(k) < 12) throw new Error(`the pitch "${k}" would be MIDI note ${k}, below anything a speaker plays: a line is <start> <pitch> <duration>, the pitch a name such as C4 or a MIDI number from 12`);
        return parseNote(k);
      });
      length = parseDuration(lengthText, project);
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
    const extra = { velocity };
    for (const flag of flags) {
      const value = flag.slice(1);
      const n = Number(value);
      if (flag[0] === 'v' && value) extra.velocity = velocityOf(value, where);
      else if (flag[0] === 'r' && value) {
        if (!(n >= 0 && n <= 1)) throw new Error(`${where}: release velocity "${flag}" must be 0–1 (0 = let go slowly, 1 = snapped off)`);
        extra.releaseVelocity = n;
      } else if (flag[0] === 'p' && value) {
        if (!(n >= -1 && n <= 1)) throw new Error(`${where}: pan "${flag}" must be −1 (left) … 1 (right)`);
        if (n) extra.pan = n;
      } else throw new Error(`${where}: "${flag}" is not understood — after the duration come v<velocity>, r<release velocity> and p<pan>, e.g. "v0.7 p-0.3". ${NOTE_LINE_HINT}`);
    }
    for (const key of keys) notes.push({ key, start, length, ...extra });
    prevStart = start;
    prevEnd = start + length;
    count++;
  });
  if (!notes.length) throw new Error(`The text holds no notes. ${NOTE_LINE_HINT[0].toUpperCase()}${NOTE_LINE_HINT.slice(1)}.`);
  return notes;
}

/**
 * Notes → compact note text, in playing order. Notes that start together with the same length and touch are one
 * chord line; a note off the sixteenth grid that follows the line before starts with ">". opts.ids adds each line's note ids as a comment (the parser ignores comments, so the text can be sent
 * back as it is); opts.tag(note) may add a word to that comment (e.g. that a note carries expression curves).
 */
export function formatNoteText(notes, project, { ids = false, tag = null } = {}) {
  const sorted = [...(notes || [])].sort((a, b) => a.start - b.start || a.key - b.key);
  const lines = [];
  const groups = new Map();
  for (const n of sorted) {
    const sig = `${n.start}|${n.length}|${round3(n.velocity)}|${n.pan || 0}|${n.releaseVelocity ?? ''}|${tag ? tag(n) : ''}`;
    let g = groups.get(sig);
    if (!g) { g = { first: n, list: [] }; groups.set(sig, g); lines.push(g); }
    g.list.push(n);
  }
  let prevEnd = -1;
  return lines.map(({ first: n, list }) => {
    // off the sixteenth grid (a triplet run, a nudged note) and right behind the line before: ">" says it better
    const start = n.start % STEP && n.start === prevEnd ? '>' : formatPositionText(n.start, project);
    prevEnd = n.start + n.length;
    let line = `${start} ${list.map((x) => noteName(x.key)).join('+')} ${formatDuration(n.length, project)}`;
    if (round3(n.velocity) !== 0.8) line += ` v${round3(n.velocity)}`;
    if (n.releaseVelocity !== undefined && n.releaseVelocity !== null && round3(n.releaseVelocity) !== 0.5) line += ` r${round3(n.releaseVelocity)}`;
    if (n.pan) line += ` p${round3(n.pan)}`;
    const notes_ = [ids ? list.map((x) => x.id).join(',') : '', tag ? tag(n) : ''].filter(Boolean).join(' ');
    return notes_ ? `${line}  # ${notes_}` : line;
  }).join('\n');
}

export function barsLabel(ticks, project) {
  return round3(ticks / ticksPerBar(project));
}

export { beatsPerBar };
