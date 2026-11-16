// Per-note expression: the pitch, pressure and slide (timbre) curve of every note, plus its release velocity.
// These are the dimensions of an MPE performance, stored with the note (core/expression.js).
import {
  findChannel, findPattern, parseNote, noteName, STEP, ticksToSeconds, evaluateComposition, formatEvaluation,
  EXPRESSION_DIMS, EXPRESSION_RANGE, CURVE_SHAPES, MAX_EXPRESSION_POINTS, makeCurve, sanitizeCurve, transformCurve, describeExpression, expressionFields
} from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, steps } from '../util.js';

const pointSchema = z.object({
  at: z.number().min(0).max(1).describe('Position inside the note: 0 = its start, 1 = its end'),
  value: z.number().describe('pitch: semitones (-48..48, 0 = the note itself); pressure/timbre: 0..1'),
  curve: z.enum(['linear', 'smooth', 'hold']).optional().describe('How the curve travels to the NEXT point: linear (default), smooth (eased) or hold (stay, then jump)')
});

/** One curve: either explicit points, or a named shape with its options. null removes the curve. */
export const curveArg = z.object({
  points: z.array(pointSchema).min(1).max(MAX_EXPRESSION_POINTS).optional().describe('Explicit curve points (use this OR shape)'),
  shape: z.enum(CURVE_SHAPES).optional().describe('bend: from → to between start and end, then held · scoop: slide up into the note · fall: drop away at the end · vibrato: waves of ±depth after a delay · swell: rise to peak at "at", back to "to" · ramp: straight from → to · pulse: on/off steps'),
  from: z.number().optional().describe('Start value (bend, ramp, swell, pulse; default 0)'),
  to: z.number().optional().describe('End value (bend, ramp: default +2 st / 1; swell: where it comes back to)'),
  start: z.number().min(0).max(1).optional().describe('bend: where it starts moving (0..1 of the note); fall: where it lets go (default 0.75)'),
  end: z.number().min(0).max(1).optional().describe('bend: where it arrives (default 1); scoop: where it arrives (default 0.2)'),
  depth: z.number().optional().describe('vibrato: ± depth (pitch: semitones, default 0.3; others 0..1); scoop/fall: size'),
  peak: z.number().optional().describe('swell: the top value'),
  at: z.number().min(0).max(1).optional().describe('swell: where the peak sits (default 0.5)'),
  cycles: z.number().positive().max(30).optional().describe('vibrato/pulse: number of waves over the note (or give rateHz)'),
  rateHz: z.number().positive().max(40).optional().describe('vibrato/pulse: speed in Hz — the number of waves is worked out per note from its length and the tempo'),
  delay: z.number().min(0).max(0.95).optional().describe('vibrato: share of the note before it starts (default 0.25)'),
  fade: z.number().min(0).max(1).optional().describe('vibrato: share of the note over which it grows in (default 0.2)'),
  center: z.number().optional().describe('vibrato on pressure/timbre: the value it moves around (default 0.5)'),
  duty: z.number().min(0.05).max(0.95).optional().describe('pulse: on-share of each step (default 0.5)')
}).nullable();

const selectionArgs = {
  noteIds: z.array(z.string()).max(2000).optional().describe('Note ids from get_pattern'),
  note: z.union([z.string(), z.number()]).optional().describe('Or: every note of this pitch (e.g. "E4")'),
  fromStep: z.number().min(0).optional().describe('Or/and: notes starting at or after this step'),
  toStep: z.number().min(0).optional().describe('…and before this step (exclusive)'),
  all: z.boolean().optional().describe('Every note of the channel in the pattern')
};

/** The notes a tool call addresses. Throws when nothing was selected or nothing matched. */
export function selectNotes(list, { noteIds, note, fromStep, toStep, all }, what = 'notes') {
  if (noteIds?.length) {
    const byId = new Map(list.map((n) => [n.id, n]));
    const missing = noteIds.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`Unknown note id(s): ${missing.slice(0, 5).join(', ')} (use get_pattern for ids)`);
    return noteIds.map((id) => byId.get(id));
  }
  const key = note !== undefined ? parseNote(note) : null;
  if (key === null && fromStep === undefined && toStep === undefined && !all) throw new Error(`Say which ${what}: noteIds, a note name, a step range (fromStep/toStep), or all=true`);
  const lo = fromStep !== undefined ? fromStep * STEP : -Infinity;
  const hi = toStep !== undefined ? toStep * STEP : Infinity;
  const hit = list.filter((n) => (key === null || n.key === key) && n.start >= lo && n.start < hi);
  if (!hit.length) throw new Error(`No ${what} matched${key !== null ? ` ${noteName(key)}` : ''}${fromStep !== undefined || toStep !== undefined ? ` in steps ${fromStep ?? 0}..${toStep ?? 'end'}` : ''}. Use get_pattern to see what is there.`);
  return hit;
}

/** A curve argument → a sanitized curve for one note (null = remove). Validates values strictly. */
export function buildCurve(dim, spec, noteSeconds) {
  if (spec === null) return null;
  const [lo, hi] = EXPRESSION_RANGE[dim];
  const inRange = (v, what) => {
    if (v !== undefined && !(v >= lo && v <= hi)) throw new Error(`${dim} ${what} must be between ${lo} and ${hi}${dim === 'pitch' ? ' semitones' : ''} (got ${v})`);
  };
  if (spec.points && spec.shape) throw new Error(`${dim}: give points OR a shape, not both`);
  if (spec.points) {
    for (const p of spec.points) inRange(p.value, 'values');
    const curve = sanitizeCurve(dim, spec.points.map((p) => ({ t: p.at, v: p.value, ...(p.curve && p.curve !== 'linear' ? { c: p.curve } : {}) })));
    return curve; // null when every point is 0: the same as no curve
  }
  if (!spec.shape) throw new Error(`${dim}: give points or a shape (${CURVE_SHAPES.join(', ')})`);
  for (const k of ['from', 'to', 'peak', 'center']) inRange(spec[k], k);
  if (spec.depth !== undefined && Math.abs(spec.depth) > hi - lo) throw new Error(`${dim} depth is too large (got ${spec.depth})`);
  const o = { ...spec };
  if (spec.rateHz && (spec.shape === 'vibrato' || spec.shape === 'pulse')) {
    const active = spec.shape === 'vibrato' ? 1 - (spec.delay ?? 0.25) : 1;
    o.cycles = Math.max(0.5, spec.rateHz * noteSeconds * active);
  }
  return makeCurve(dim, spec.shape, o);
}

/** { pitch?, pressure?, timbre? } curve arguments → the `expression` patch of a notes/expression op for one note. */
export function buildExpression(curves, noteSeconds) {
  const out = {};
  for (const dim of EXPRESSION_DIMS) if (curves[dim] !== undefined) out[dim] = buildCurve(dim, curves[dim], noteSeconds);
  return out;
}

/** What to tell Claude when a curve was written that nothing will hear. */
export function audibilityNotes(channel, dims) {
  const notes = [];
  const kind = channel.instrument.kind;
  const soft = dims.filter((d) => d !== 'pitch');
  if (kind !== 'ggs') {
    if (soft.length) notes.push(`"${channel.name}" is a ${kind}: only pitch curves are audible on it — pressure and slide need a GGS Synth channel (create_synth_patch).`);
    return notes;
  }
  const p = channel.instrument.params;
  for (const dim of soft) {
    let routed = false;
    for (let i = 1; i <= 16; i++) if (p[`mod${i}Amt`] && p[`mod${i}Dst`] !== 'none' && (p[`mod${i}Src`] === dim || p[`mod${i}Via`] === dim)) routed = true;
    if (!routed) notes.push(`This patch does not route ${dim} anywhere yet, so the curve changes nothing: add a route with set_synth_modulation (e.g. ${dim} → f1Cutoff 0.3).`);
  }
  return notes;
}

const pointsOut = (curve) => curve.map((p) => ({ at: p.t, value: p.v, ...(p.c ? { curve: p.c } : {}) }));

export function registerExpressionTools({ tool, backend, load }) {
  tool('evaluate_composition', {
    title: 'Evaluate the composition',
    description: 'Check the song as written (no audio needed): notes outside the key, a project key that does not fit the notes, flat velocities, muddy low chords, chords on a mono patch, more notes than a synth has voices, pressure/slide curves that nothing responds to, patterns never placed in the playlist, a master without a limiter. Each finding says where and how to fix it. Run it after composing and before render_mix (which measures the audio).',
    inputSchema: { projectId: projectIdArg },
    annotations: A.readOnly
  }, async ({ projectId }) => {
    const e = evaluateComposition(await load(projectId));
    return ok(formatEvaluation(e), { counts: e.counts, findings: e.findings });
  });

  tool('set_note_expression', {
    title: 'Set note expression (pitch / pressure / slide curves)',
    description: 'Shape the performance of individual notes: each note has its own pitch curve (semitones), pressure curve (0..1) and slide/timbre curve (0..1), plus a release velocity — like an MPE keyboard, but written into the note. Give each curve as a named shape (bend, scoop, fall, vibrato, swell, ramp, pulse) or as explicit points; null removes a curve; curves you do not mention are kept. Curve time is relative to the note (0 = start, 1 = end), so moving or resizing a note keeps its performance. Pitch curves bend every instrument; pressure and slide drive the GGS Synth through its modulation matrix. Example: bend only the third of a chord → noteIds of that note, pitch { shape: "bend", to: 1, end: 0.4 }.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string().describe('Pattern id or name'),
      channel: z.string().describe('Channel id or name'),
      ...selectionArgs,
      pitch: curveArg.optional().describe('Pitch curve in semitones around the note'),
      pressure: curveArg.optional().describe('Pressure curve, 0..1 (rest = 0)'),
      timbre: curveArg.optional().describe('Slide / timbre curve, 0..1 (rest = 0)'),
      releaseVelocity: z.number().min(0).max(1).nullable().optional().describe('How the note is let go: 0 = slowly, 1 = snapped off (0.5 neutral; GGS "Rel. velocity" scales the release time). null removes it')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const dims = EXPRESSION_DIMS.filter((d) => a[d] !== undefined);
    if (!dims.length && a.releaseVelocity === undefined) throw new Error('Nothing to set: give pitch, pressure, timbre and/or releaseVelocity');
    const notes = selectNotes(pt.notes[ch.id] || [], a);
    const updates = notes.map((n) => ({
      id: n.id,
      ...(dims.length ? { expression: buildExpression(a, ticksToSeconds(n.length, p.bpm)) } : {}),
      ...(a.releaseVelocity !== undefined ? { releaseVelocity: a.releaseVelocity } : {})
    }));
    const after = await backend.applyOps(p.id, [{ type: 'notes/expression', patternId: pt.id, channelId: ch.id, notes: updates }]);
    const list = after.patterns.find((x) => x.id === pt.id).notes[ch.id];
    const shown = notes.slice(0, 6).map((n) => {
      const now = list.find((x) => x.id === n.id);
      return `  ${noteName(n.key)} @ step ${steps(n.start)} [${n.id}]: ${describeExpression(now) || 'no expression'}`;
    });
    const hints = audibilityNotes(after.channels.find((c) => c.id === ch.id), dims.filter((d) => a[d] !== null));
    return ok(`Shaped ${notes.length} note(s) of "${ch.name}" in "${pt.name}":\n${shown.join('\n')}${notes.length > 6 ? `\n  … +${notes.length - 6} more` : ''}${hints.length ? `\n${hints.join('\n')}` : ''}`);
  });

  tool('get_note_expression', {
    title: 'Inspect note expression',
    description: 'Read the performance curves of notes: for each note its pitch / pressure / slide curve points (at 0..1 of the note, value, how it travels to the next point) and release velocity. Without a selection it lists every note of the channel that has expression.',
    inputSchema: { projectId: projectIdArg, pattern: z.string(), channel: z.string(), ...selectionArgs },
    annotations: A.readOnly
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const list = pt.notes[ch.id] || [];
    const anySelector = a.noteIds?.length || a.note !== undefined || a.fromStep !== undefined || a.toStep !== undefined || a.all;
    const notes = anySelector ? selectNotes(list, a) : list.filter((n) => n.expression || n.releaseVelocity !== undefined);
    if (!notes.length) return ok(`No note of "${ch.name}" in "${pt.name}" has expression yet (${list.length} notes). Use set_note_expression.`);
    const data = notes.map((n) => ({
      id: n.id, note: noteName(n.key), startStep: steps(n.start), lengthSteps: steps(n.length), velocity: n.velocity,
      ...(n.releaseVelocity !== undefined ? { releaseVelocity: n.releaseVelocity } : {}),
      ...Object.fromEntries(EXPRESSION_DIMS.filter((d) => n.expression?.[d]).map((d) => [d, pointsOut(n.expression[d])]))
    }));
    const lines = notes.map((n) => `  ${noteName(n.key).padEnd(4)} @ step ${steps(n.start)} [${n.id}]: ${describeExpression(n) || 'no expression'}`);
    return ok(`Expression of ${notes.length} note(s) of "${ch.name}" in "${pt.name}" (pitch in semitones, pressure/timbre 0..1, positions 0..1 of the note):\n${lines.join('\n')}`, data);
  });

  tool('transform_note_expression', {
    title: 'Transform note expression',
    description: 'Change existing curves as a whole: scale (×), offset (+), invert (mirror: pitch around 0, pressure/timbre around 0.5), reverse (in time), smooth (0..1, rounds corners), timeScale/timeOffset (squeeze or shift the curve inside the note). Applies to the chosen dimensions of the selected notes that have a curve. E.g. halve every vibrato: dimensions ["pitch"], scale 0.5.',
    inputSchema: {
      projectId: projectIdArg, pattern: z.string(), channel: z.string(), ...selectionArgs,
      dimensions: z.array(z.enum(EXPRESSION_DIMS)).min(1).optional().describe('Default: every curve the notes have'),
      scale: z.number().min(-8).max(8).optional(),
      offset: z.number().min(-48).max(48).optional(),
      invert: z.boolean().optional(),
      reverse: z.boolean().optional(),
      smooth: z.number().min(0).max(1).optional(),
      timeScale: z.number().min(0.05).max(4).optional(),
      timeOffset: z.number().min(-1).max(1).optional()
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const opts = { scale: a.scale ?? 1, offset: a.offset ?? 0, invert: !!a.invert, reverse: !!a.reverse, smooth: a.smooth ?? 0, timeScale: a.timeScale ?? 1, timeOffset: a.timeOffset ?? 0 };
    if (opts.scale === 1 && !opts.offset && !opts.invert && !opts.reverse && !opts.smooth && opts.timeScale === 1 && !opts.timeOffset) throw new Error('Nothing to do: give scale, offset, invert, reverse, smooth, timeScale or timeOffset');
    const dims = a.dimensions || EXPRESSION_DIMS;
    const updates = [];
    for (const n of selectNotes(pt.notes[ch.id] || [], a)) {
      const expression = {};
      for (const dim of dims) if (n.expression?.[dim]) expression[dim] = transformCurve(dim, n.expression[dim], opts);
      if (Object.keys(expression).length) updates.push({ id: n.id, expression });
    }
    if (!updates.length) throw new Error(`None of the selected notes has a ${dims.join('/')} curve to transform (see get_note_expression)`);
    await backend.applyOps(p.id, [{ type: 'notes/expression', patternId: pt.id, channelId: ch.id, notes: updates }]);
    return ok(`Transformed the ${dims.join(', ')} curve(s) of ${updates.length} note(s) of "${ch.name}" in "${pt.name}".`);
  });

  tool('copy_note_expression', {
    title: 'Copy note expression',
    description: 'Copy the performance (curves and release velocity) of one note onto other notes — in the same channel, or onto notes of another channel/pattern. Because curves are relative to each note, the gesture fits notes of any length.',
    inputSchema: {
      projectId: projectIdArg, pattern: z.string(), channel: z.string(),
      fromNote: z.string().describe('Id of the note to copy from (get_pattern / get_note_expression)'),
      ...selectionArgs,
      toPattern: z.string().optional().describe('Pattern of the target notes (default: the same)'),
      toChannel: z.string().optional().describe('Channel of the target notes (default: the same)'),
      dimensions: z.array(z.enum(EXPRESSION_DIMS)).min(1).optional().describe('Default: all three (a dimension the source lacks is cleared on the targets)')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const source = (pt.notes[ch.id] || []).find((n) => n.id === a.fromNote);
    if (!source) throw new Error(`Note ${a.fromNote} not found in "${ch.name}" / "${pt.name}"`);
    const dpt = a.toPattern ? findPattern(p, a.toPattern) : pt;
    const dch = a.toChannel ? findChannel(p, a.toChannel) : ch;
    const targets = selectNotes(dpt.notes[dch.id] || [], a, 'target notes').filter((n) => !(n.id === source.id && dpt.id === pt.id && dch.id === ch.id));
    if (!targets.length) throw new Error('The only note selected is the source itself');
    const dims = a.dimensions || EXPRESSION_DIMS;
    const fields = expressionFields(source);
    const expression = Object.fromEntries(dims.map((d) => [d, fields.expression?.[d] || null]));
    const updates = targets.map((n) => ({ id: n.id, expression, ...(a.dimensions ? {} : { releaseVelocity: source.releaseVelocity ?? null }) }));
    await backend.applyOps(p.id, [{ type: 'notes/expression', patternId: dpt.id, channelId: dch.id, notes: updates }]);
    const hints = audibilityNotes(dch, dims.filter((d) => source.expression?.[d]));
    return ok(`Copied ${describeExpression(source) || 'an empty performance'} from ${noteName(source.key)} [${source.id}] to ${targets.length} note(s) of "${dch.name}" in "${dpt.name}".${hints.length ? `\n${hints.join('\n')}` : ''}`);
  });
}

/** Notes for add_notes with inline expression: { id, …, expression?, releaseVelocity? }. */
export function withExpression(note, spec, bpm) {
  const out = { ...note };
  if (spec.releaseVelocity !== undefined && spec.releaseVelocity !== null) out.releaseVelocity = spec.releaseVelocity;
  if (spec.expression) {
    const built = buildExpression(spec.expression, ticksToSeconds(note.length, bpm));
    const kept = Object.fromEntries(Object.entries(built).filter(([, c]) => c));
    if (Object.keys(kept).length) out.expression = kept;
  }
  return out;
}
