// Shared helpers for MCP tool modules.
import { z } from 'zod';
import { STEP, ticksPerBar, isRomanNumeral, romanToChord, maxPatternLength, MAX_PATTERN_BARS, toTicks, parsePosition, parseDuration } from '@greanteadawy/core';

export { z };

export const projectIdArg = z.string().optional().describe('Project id. Defaults to the active project (the one open in the browser).');
export const unitArg = z.enum(['steps', 'beats', 'bars', 'ticks']).optional().describe('Unit for start/length given as numbers (default steps = 16th notes)');

/** Where: a number (steps unless `unit` says otherwise) or a musical position as text. */
export const positionArg = z.union([z.number().min(0), z.string().min(1).max(24)]);
/** How long: a number (steps unless `unit` says otherwise) or a duration as text. */
export const durationArg = z.union([z.number().positive(), z.string().min(1).max(24)]);
export const POSITION_WORDS = 'a number (steps from the start, 0-based) or text: "2.1" = bar 2, "2.3" = bar 2 beat 3, "2.3.2" = one sixteenth later, "6s" = 6 steps, "1.5b" = 1.5 beats (a bare "2" is refused: is it bar 2 or the number 2?)';
export const DURATION_WORDS = 'a number (steps) or text: "1/4", "1/8", "1/16", "1/8t" (triplet), "1/4d" (dotted), "2bar", "1.5b" (beats)';

/** A position argument → ticks: text is a musical position, a number counts in `unit`. */
export function positionTicks(value, unit, p) {
  if (typeof value !== 'string') return toTicks(value, unit, p);
  // As a musical position "8" is bar 8 — but a number that arrives as text ("8" for 8) is far more often a slip, and
  // the two are bars apart. Nothing is placed on a guess: the caller says which one it is.
  const bare = /^\s*(\d+)\s*$/.exec(value);
  if (bare) throw new Error(`the position "${bare[1]}" is text, which could mean two things: send the number ${Number(bare[1])} for ${Number(bare[1])} ${unit || 'steps'} from the start, or "${bare[1]}.1" for bar ${bare[1]}`);
  return parsePosition(value, p);
}
/** A duration argument → ticks (at least 1). */
export const durationTicks = (value, unit, p) => (typeof value === 'string' ? parseDuration(value, p) : Math.max(1, toTicks(value, unit, p)));

export const annotations = {
  readOnly: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  edit: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
};

export function ok(text, data) {
  const content = [{ type: 'text', text }];
  if (data !== undefined) content.push({ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  return { content };
}

/** Velocity as 0..1. Values ≤ 1 are already 0..1 (1 = full); 2..127 are MIDI velocities; (1, 2) counts as full. */
export function normVelocity(v, fallback = 0.8) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 1) return Math.max(0, n);
  return n < 2 ? 1 : Math.min(1, n / 127);
}

/** A name not used by any item in `list` yet ("Kick", "Kick 2", "Kick 3", …). */
export function uniqueName(list, name) {
  const taken = new Set(list.map((x) => String(x.name).toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const base = name.replace(/\s+\d+$/, '');
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Throw if another item (not `self`) already uses `name` (case-insensitive) — names are how tools find things. */
export function assertNameFree(list, name, what, self = null) {
  const clash = list.find((x) => x !== self && x.id !== self?.id && String(x.name).toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`A ${what} named "${clash.name}" already exists — names must be unique so tools can find things`);
}

export function pickTrack(p, refId) {
  const existing = p.playlist.clips.find((c) => c.refId === refId);
  if (existing) return existing.track;
  const used = new Set(p.playlist.clips.map((c) => c.track));
  for (let i = 0; i < 500; i++) if (!used.has(i)) return i;
  return 0;
}

export function findEffect(p, insert, ref) {
  const m = p.mixer[insert];
  if (!m) throw new Error(`Mixer insert ${insert} does not exist (0..${p.mixer.length - 1})`);
  const byId = m.effects.find((e) => e.id === ref);
  if (byId) return byId;
  const byType = m.effects.filter((e) => e.type === ref);
  if (byType.length === 1) return byType[0];
  throw new Error(`Effect "${ref}" not found on insert ${insert}. Effects: ${m.effects.map((e) => `${e.type} [${e.id}]`).join(', ') || 'none'}`);
}

/** Throw unless `needed` ticks fit in a pattern — call it BEFORE generating notes, so huge requests cost nothing. */
export function assertFitsPattern(p, pattern, needed) {
  if (!(needed <= maxPatternLength(p))) {
    const bars = Number.isFinite(needed) ? Math.ceil(needed / ticksPerBar(p)) : 'too many';
    throw new Error(`That would make "${pattern.name}" ${bars} bars long; patterns can be at most ${MAX_PATTERN_BARS} bars. Use several patterns and arrange them in the playlist.`);
  }
}

/** Grow a pattern so `needed` ticks fit (whole bars). Returns an op or null; throws past the 64-bar limit. */
export function growPatternOp(p, pattern, needed) {
  assertFitsPattern(p, pattern, needed);
  if (needed <= pattern.length) return null;
  const bar = ticksPerBar(p);
  return { type: 'pattern/update', id: pattern.id, patch: { length: Math.ceil(needed / bar) * bar } };
}

/** Chord list that may contain roman numerals ("i", "VI", "bVII") -> chord symbols in the project key. */
export function resolveChords(chords, project) {
  return chords.map((c) => (c && c !== '-' && isRomanNumeral(c) ? romanToChord(c, project.key || 'C', project.scale || 'minor') : c));
}

export const steps = (ticks) => Math.round((ticks / STEP) * 1000) / 1000;

export function barsOf(p, ticks) {
  return Math.round((ticks / ticksPerBar(p)) * 100) / 100;
}
