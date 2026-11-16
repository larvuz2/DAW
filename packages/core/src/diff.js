// What changed between two states of a project, in words: for "what would this edit do" (dry runs, batches), for
// "what did I change since that version", and for a person looking at their version list. Pure: no ids are
// invented, nothing is rounded in the data — only in the text.
import { describeTuning } from './tuning.js';
import { ticksPerBar } from './constants.js';
import { songLength } from './model.js';
import { formatNoteText, formatPositionText, formatDuration } from './notation.js';
import { INSTRUMENTS } from './instruments.js';
import { EFFECTS } from './effects.js';

const same = (x, y) => x === y || JSON.stringify(x) === JSON.stringify(y);
const num = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : null);
const show = (v) => {
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  const text = JSON.stringify(v);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
};
const db = (gain) => (gain > 0.0001 ? `${Math.round(200 * Math.log10(gain)) / 10} dB` : '−∞ dB');
const percent = (v) => `${Math.round(v * 100)} %`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byId = (list) => new Map((list || []).map((x) => [x.id, x]));

/** "key a → b" for every key of two flat objects that differs (params), most at `max`, then "+N more". */
function paramChanges(before = {}, after = {}, defs = null, max = 8) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !same(before[k], after[k]));
  const unit = (k) => {
    const u = defs?.find((d) => d.key === k)?.unit;
    return u ? ` ${u}` : '';
  };
  const out = keys.slice(0, max).map((k) => `${k} ${show(before[k])} → ${show(after[k])}${unit(k)}`);
  if (keys.length > max) out.push(`+${keys.length - max} more`);
  return { count: keys.length, text: out.join(', ') };
}

/** Fields of two objects that differ, as "label a → b" — `fields` maps a key to [label, formatter]. */
function fieldChanges(a, b, fields) {
  const out = [];
  for (const [key, [label, format = show]] of Object.entries(fields)) if (!same(a[key], b[key])) out.push(`${label} ${format(a[key])} → ${format(b[key])}`);
  return out;
}

const noteSig = (n) => `${n.key}|${n.start}|${n.length}|${n.velocity}|${n.pan || 0}|${n.releaseVelocity ?? 0.5}|${n.expression ? JSON.stringify(n.expression) : ''}`;

/**
 * Notes of one channel in one pattern: what was added, removed and changed. Notes are matched by id; a tool that
 * rewrote a part gives every note a new id, so what is left is matched by content — the same music is no change.
 */
export function diffNotes(before = [], after = []) {
  const old = byId(before);
  const added = [];
  const changed = [];
  const leftover = [];
  for (const n of after) {
    const was = old.get(n.id);
    if (!was) { leftover.push(n); continue; }
    old.delete(n.id);
    if (noteSig(was) !== noteSig(n)) changed.push([was, n]);
  }
  const pool = new Map();
  for (const n of old.values()) {
    const sig = noteSig(n);
    pool.set(sig, [...(pool.get(sig) || []), n]);
  }
  for (const n of leftover) {
    const twins = pool.get(noteSig(n));
    if (twins?.length) twins.pop();
    else added.push(n);
  }
  const removed = [...pool.values()].flat();
  return { added, removed, changed };
}

function noteChangeText(was, now, project) {
  const what = [];
  if (was.key !== now.key) what.push('pitch');
  if (was.start !== now.start) what.push(now.start > was.start ? 'later' : 'earlier');
  if (was.length !== now.length) what.push(now.length > was.length ? 'longer' : 'shorter');
  if (was.velocity !== now.velocity) what.push(now.velocity > was.velocity ? 'louder' : 'softer');
  if ((was.pan || 0) !== (now.pan || 0)) what.push('pan');
  if ((was.releaseVelocity ?? 0.5) !== (now.releaseVelocity ?? 0.5)) what.push('release');
  if (!same(was.expression, now.expression)) what.push('expression');
  return `${formatNoteText([was], project)} → ${formatNoteText([now], project)} (${what.join(', ')})`;
}

/**
 * Compare two project states. Returns
 *   changed   whether anything differs (ids, colours and timestamps aside)
 *   lines     what changed, in reading order: project, channels, patterns and notes, playlist, automation, mixer —
 *             at most opts.maxLines, the rest counted in the last line
 *   counts    { channels, patterns, notesAdded, notesRemoved, notesChanged, clips, automations, effects, mixer, project }
 *   summary   one sentence built from the counts
 * opts.maxNotes: how many notes are spelled out per channel and pattern (the others are counted).
 * opts.ids: name new things with their ids in [brackets] (for an agent, which addresses them by id) — false for people.
 */
export function diffProjects(a, b, { maxLines = 60, maxNotes = 10, ids = true } = {}) {
  const tag = (id) => (ids ? ` [${id}]` : '');
  const lines = [];
  const counts = { project: 0, channels: 0, patterns: 0, notesAdded: 0, notesRemoved: 0, notesChanged: 0, clips: 0, markers: 0, automations: 0, mixer: 0, effects: 0 };
  const bar = ticksPerBar(b);
  const barsOf = (ticks) => Math.round((ticks / bar) * 100) / 100;
  /** A length the way one says it: "2 bars", else a note value or steps. */
  // ("8.25s" is 8.25 steps in note text; in a sentence it would read as seconds)
  const span = (ticks, project = b) => { const whole = ticksPerBar(project); return ticks >= whole && ticks % whole === 0 ? plural(ticks / whole, 'bar') : formatDuration(ticks, project).replace(/^([\d.]+)s$/, '$1 steps'); };

  // ---- the project itself
  const head = [];
  if (a.name !== b.name) head.push(`name ${show(a.name)} → ${show(b.name)}`);
  if (a.bpm !== b.bpm) head.push(`tempo ${num(a.bpm)} → ${num(b.bpm)} BPM`);
  if (!same(a.timeSig, b.timeSig)) head.push(`time signature ${a.timeSig.join('/')} → ${b.timeSig.join('/')}`);
  if (a.key !== b.key || a.scale !== b.scale) head.push(`key ${a.key} ${a.scale} → ${b.key} ${b.scale}`);
  if (!same(a.tuning, b.tuning)) head.push(`tuning ${describeTuning(a.tuning)} → ${describeTuning(b.tuning)}`);
  if (a.swing !== b.swing) head.push(`swing ${percent(a.swing)} → ${percent(b.swing)}`);
  if (!same(a.spatial, b.spatial)) head.push(a.spatial?.enabled !== b.spatial?.enabled ? `spatial mix ${b.spatial?.enabled ? 'on' : 'off'}` : 'spatial settings changed');
  counts.project = head.length;
  if (head.length) lines.push(`Project: ${head.join(', ')}`);

  // ---- channels
  const chanName = (id) => b.channels.find((c) => c.id === id)?.name || a.channels.find((c) => c.id === id)?.name || id;
  const oldChans = byId(a.channels);
  const newChans = byId(b.channels);
  for (const c of b.channels) {
    const was = oldChans.get(c.id);
    if (!was) {
      counts.channels++;
      lines.push(`+ Channel "${c.name}"${tag(c.id)}: ${c.instrument.kind}${c.instrument.preset ? ` / ${c.instrument.preset}` : ''}, insert ${c.mixerTrack}`);
      continue;
    }
    const what = fieldChanges(was, c, {
      name: ['name'], volume: ['volume', percent], pan: ['pan'], pitch: ['pitch'], mute: ['mute'], solo: ['solo'], mixerTrack: ['insert'],
      chokeGroup: ['choke group'], rootKey: ['step note'], filterCutoff: ['filter cutoff'], filterRes: ['filter resonance'], nudge: ['nudge (ms)'], swingMix: ['swing share', percent]
    });
    if (was.instrument.kind !== c.instrument.kind) what.push(`instrument ${was.instrument.kind} → ${c.instrument.kind}`);
    else {
      if ((was.instrument.preset || '') !== (c.instrument.preset || '')) what.push(`preset ${show(was.instrument.preset || 'none')} → ${show(c.instrument.preset || 'none')}`);
      const params = paramChanges(was.instrument.params, c.instrument.params, INSTRUMENTS[c.instrument.kind]?.params);
      if (params.count) what.push(`sound: ${params.text}`);
    }
    if (what.length) {
      counts.channels++;
      lines.push(`~ Channel "${c.name}": ${what.join('; ')}`);
    }
  }
  for (const c of a.channels) {
    if (newChans.has(c.id)) continue;
    counts.channels++;
    lines.push(`− Channel "${c.name}" (${c.instrument.kind})`);
  }
  const kept = (list, other) => list.filter((x) => other.has(x.id)).map((x) => x.id);
  if (!same(kept(a.channels, newChans), kept(b.channels, oldChans))) lines.push('~ Channel order changed');

  // ---- patterns and their notes
  const oldPats = byId(a.patterns);
  const newPats = byId(b.patterns);
  const noteLines = (label, list, project) => {
    const text = formatNoteText(list.slice(0, maxNotes), project).split('\n').filter(Boolean);
    return [...text.map((t) => `    ${label} ${t}`), ...(list.length > maxNotes ? [`    ${label} … ${list.length - maxNotes} more`] : [])];
  };
  for (const pt of b.patterns) {
    const was = oldPats.get(pt.id);
    if (!was) {
      counts.patterns++;
      const total = Object.values(pt.notes || {}).reduce((n, list) => n + list.length, 0);
      counts.notesAdded += total;
      const parts = Object.entries(pt.notes || {}).filter(([, list]) => list.length).map(([cid, list]) => `${chanName(cid)} ${list.length}`);
      lines.push(`+ Pattern "${pt.name}"${tag(pt.id)}: ${barsOf(pt.length)} bars${total ? `, ${plural(total, 'note')} (${parts.join(', ')})` : ', empty'}`);
      continue;
    }
    const what = fieldChanges(was, pt, { name: ['name'], length: ['length', (t) => plural(barsOf(t), 'bar')] });
    const detail = [];
    for (const cid of new Set([...Object.keys(was.notes || {}), ...Object.keys(pt.notes || {})])) {
      const d = diffNotes(was.notes?.[cid], pt.notes?.[cid]);
      if (!d.added.length && !d.removed.length && !d.changed.length) continue;
      counts.notesAdded += d.added.length;
      counts.notesRemoved += d.removed.length;
      counts.notesChanged += d.changed.length;
      const tally = [d.added.length && `+${d.added.length}`, d.removed.length && `−${d.removed.length}`, d.changed.length && `${d.changed.length} changed`].filter(Boolean).join(', ');
      detail.push(`  ${chanName(cid)}: ${tally} ${d.added.length + d.removed.length + d.changed.length === 1 ? 'note' : 'notes'}`);
      detail.push(...noteLines('+', d.added, b), ...noteLines('−', d.removed, a));
      detail.push(...d.changed.slice(0, maxNotes).map(([x, y]) => `    ~ ${noteChangeText(x, y, b)}`));
      if (d.changed.length > maxNotes) detail.push(`    ~ … ${d.changed.length - maxNotes} more`);
    }
    if (what.length || detail.length) {
      counts.patterns++;
      lines.push(`~ Pattern "${pt.name}"${what.length ? `: ${what.join(', ')}` : ''}`, ...detail);
    }
  }
  for (const pt of a.patterns) {
    if (newPats.has(pt.id)) continue;
    counts.patterns++;
    const total = Object.values(pt.notes || {}).reduce((n, list) => n + list.length, 0);
    counts.notesRemoved += total;
    lines.push(`− Pattern "${pt.name}" (${barsOf(pt.length)} bars, ${plural(total, 'note')})`);
  }

  // ---- playlist: clips, markers, tracks
  const refName = (project, clip) => (clip.kind === 'pattern' ? project.patterns.find((x) => x.id === clip.refId)?.name
    : clip.kind === 'automation' ? project.automations.find((x) => x.id === clip.refId)?.name : null) || clip.refId;
  // (an audio clip has no name of its own, and the id of its sample says nothing to a person)
  const clipLabel = (project, c) => (c.kind === 'audio' ? `audio clip${ids ? ` of sample ${c.refId}` : ''}` : `${c.kind === 'pattern' ? '' : `${c.kind} `}clip "${refName(project, c)}"`);
  const clipText = (project, c) => `${clipLabel(project, c)} at bar ${formatPositionText(c.start, project)}, ${span(c.length, project)}, track ${c.track + 1}`;
  const oldClips = byId(a.playlist.clips);
  const clipLines = [];
  for (const c of b.playlist.clips) {
    const was = oldClips.get(c.id);
    if (!was) { clipLines.push(`+ ${clipText(b, c)}`); continue; }
    oldClips.delete(c.id);
    const what = fieldChanges(was, c, {
      start: ['start', (t) => `bar ${formatPositionText(t, b)}`], length: ['length', (t) => span(t)], track: ['track', (t) => t + 1], offset: ['offset', (t) => (t ? span(t) : 'none')],
      mute: ['mute'], refId: ['content'], gain: ['gain'], fadeIn: ['fade in'], fadeOut: ['fade out'], rate: ['rate']
    });
    if (what.length) clipLines.push(`~ ${clipLabel(b, c)} (bar ${formatPositionText(was.start, a)}): ${what.join(', ')}`);
  }
  for (const c of oldClips.values()) clipLines.push(`− ${clipText(a, c)}`);
  counts.clips = clipLines.length;
  if (clipLines.length > 12) {
    const tally = (sign) => clipLines.filter((l) => l[0] === sign).length;
    lines.push(`Playlist: ${plural(tally('+'), 'clip')} added, ${tally('−')} removed, ${tally('~')} changed`, ...clipLines.slice(0, 8).map((l) => `  ${l}`), `  … ${clipLines.length - 8} more`);
  } else lines.push(...clipLines);
  const lenA = songLength(a);
  const lenB = songLength(b);
  if (lenA !== lenB) lines.push(`Song length ${barsOf(lenA)} → ${plural(barsOf(lenB), 'bar')}`);
  const oldMarks = byId(a.markers);
  for (const m of b.markers || []) {
    const was = oldMarks.get(m.id);
    oldMarks.delete(m.id);
    if (!was) lines.push(`+ Marker "${m.name}" at bar ${formatPositionText(m.tick, b)}`);
    else if (was.name !== m.name || was.tick !== m.tick) lines.push(`~ Marker "${was.name}"${was.name !== m.name ? ` → "${m.name}"` : ''}${was.tick !== m.tick ? `: bar ${formatPositionText(was.tick, a)} → ${formatPositionText(m.tick, b)}` : ''}`);
    else continue;
    counts.markers++;
  }
  for (const m of oldMarks.values()) { counts.markers++; lines.push(`− Marker "${m.name}"`); }
  if ((a.playlist.tracks?.length || 0) !== (b.playlist.tracks?.length || 0)) lines.push(`Playlist tracks ${a.playlist.tracks?.length || 0} → ${b.playlist.tracks?.length || 0}`);
  // a muted track is heard (or rather not): each one is named, whatever else happened to the playlist
  (b.playlist.tracks || []).forEach((t, i) => {
    const was = a.playlist.tracks?.[i];
    if (!was) return;
    const bits = [];
    if (was.name !== t.name) bits.push(`renamed "${was.name}" → "${t.name}"`);
    if (!!was.mute !== !!t.mute) bits.push(t.mute ? 'muted' : 'unmuted');
    if (bits.length) lines.push(`~ Playlist track ${i + 1}${was.name === t.name && t.name ? ` "${t.name}"` : ''}: ${bits.join(', ')}`);
  });

  // ---- automation
  const targetText = (project, t) => {
    if (!t) return 'nothing';
    if (t.type === 'channel') return `${project.channels.find((c) => c.id === t.id)?.name || t.id} ${t.param}`;
    if (t.type === 'mixer') return `insert ${t.index} ${t.param}`;
    if (t.type === 'effect') return `insert ${t.index} effect ${t.param}`;
    return `${t.type} ${t.param || ''}`.trim();
  };
  const oldAutos = byId(a.automations);
  for (const au of b.automations || []) {
    const was = oldAutos.get(au.id);
    oldAutos.delete(au.id);
    if (!was) lines.push(`+ Automation "${au.name}"${tag(au.id)} of ${targetText(b, au.target)}: ${span(au.length)}, ${plural(au.points.length, 'point')}`);
    else {
      const what = fieldChanges(was, au, { name: ['name'], length: ['length', (t) => span(t)] });
      if (!same(was.target, au.target)) what.push(`target ${targetText(a, was.target)} → ${targetText(b, au.target)}`);
      if (!same(was.points, au.points)) what.push(`curve changed (${was.points.length} → ${plural(au.points.length, 'point')})`);
      if (!what.length) continue;
      lines.push(`~ Automation "${au.name}": ${what.join(', ')}`);
    }
    counts.automations++;
  }
  for (const au of oldAutos.values()) { counts.automations++; lines.push(`− Automation "${au.name}"`); }

  // ---- mixer
  const oldIns = byId(a.mixer);
  const insertLabel = (project, m) => { const i = project.mixer.indexOf(m); return i === 0 ? 'Master' : `Insert ${i}${m.name && m.name !== `Insert ${i}` ? ` "${m.name}"` : ''}`; };
  for (const m of b.mixer) {
    const was = oldIns.get(m.id);
    oldIns.delete(m.id);
    if (!was) { counts.mixer++; lines.push(`+ ${insertLabel(b, m)}`); continue; }
    const what = fieldChanges(was, m, { name: ['name'], volume: ['volume', db], pan: ['pan'], mute: ['mute'], solo: ['solo'], output: ['output'] });
    if (!same(was.sends, m.sends)) what.push('sends changed');
    if (!same(was.spatial, m.spatial)) {
      const at = (s) => (s?.enabled ? `(${num(s.x)}, ${num(s.y)}, ${num(s.z)})` : 'off');
      what.push(`3D position ${at(was.spatial)} → ${at(m.spatial)}`);
    }
    const oldFx = byId(was.effects);
    const fx = [];
    for (const e of m.effects) {
      const before = oldFx.get(e.id);
      oldFx.delete(e.id);
      if (!before) { fx.push(`+ ${e.type}${tag(e.id)}`); continue; }
      const bits = [];
      if (before.enabled !== e.enabled) bits.push(e.enabled ? 'switched on' : 'bypassed');
      const params = paramChanges(before.params, e.params, EFFECTS[e.type]?.params);
      if (params.count) bits.push(params.text);
      if (bits.length) fx.push(`~ ${e.type}: ${bits.join('; ')}`);
    }
    for (const e of oldFx.values()) fx.push(`− ${e.type}`);
    const order = (list, other) => list.filter((e) => other.some((x) => x.id === e.id)).map((e) => e.id);
    // (the order of a chain is heard — a compressor before or after a reverb — so it is said next to any other change)
    if (!same(order(was.effects, m.effects), order(m.effects, was.effects))) fx.push(`order now ${m.effects.map((e) => e.type).join(' → ')}`);
    counts.effects += fx.length;
    if (what.length || fx.length) {
      counts.mixer++;
      lines.push(`~ ${insertLabel(b, m)}${what.length ? `: ${what.join(', ')}` : ''}${fx.length ? `${what.length ? ';' : ':'} effects ${fx.join(', ')}` : ''}`);
    }
  }
  for (const m of oldIns.values()) { counts.mixer++; lines.push(`− ${insertLabel(a, m)}`); }

  const changed = lines.length > 0;
  // "3 notes added, 110 removed" — and "110 notes removed" when that is all there is
  const notes = [[counts.notesAdded, 'added'], [counts.notesRemoved, 'removed'], [counts.notesChanged, 'changed']].filter(([n]) => n)
    .map(([n, verb], i) => `${i ? n : plural(n, 'note')} ${verb}`).join(', ');
  const parts = [
    counts.project && 'project settings', counts.channels && plural(counts.channels, 'channel'), counts.patterns && plural(counts.patterns, 'pattern'), notes,
    counts.clips && plural(counts.clips, 'clip'), counts.markers && plural(counts.markers, 'marker'), counts.automations && plural(counts.automations, 'automation'),
    counts.mixer && `${plural(counts.mixer, 'mixer insert')}${counts.effects ? ` (${plural(counts.effects, 'effect change')})` : ''}`
  ].filter(Boolean);
  const shown = lines.length > maxLines ? [...lines.slice(0, maxLines), `… and ${lines.length - maxLines} more lines`] : lines;
  return { changed, lines: shown, counts, summary: changed ? `Changed: ${parts.join('; ') || 'details below'}.` : 'No difference.' };
}
