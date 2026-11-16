// A "lint" for compositions: reads the notes, performance curves, instruments and mixer of a project (no audio) and
// reports what a producer would flag before bouncing — notes outside the key, flat dynamics, chords on a mono patch,
// pressure curves nothing listens to, patterns that were never placed. Each finding says where, what and how to fix.
import { STEP, ticksPerBar } from './constants.js';
import { INSTRUMENTS } from './instruments.js';
import { SCALES, scalePitchClasses, noteName } from './music.js';
import { patternLength, songLength } from './model.js';
import { EXPRESSION_DIMS } from './expression.js';

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pct = (x) => `${Math.round(x * 100)}%`;

/** Does a GGS patch listen to a modulation source (as a source or as a "via")? */
function patchUses(params, source) {
  for (let i = 1; i <= 16; i++) {
    if (!params[`mod${i}Amt`] || params[`mod${i}Dst`] === 'none' || !params[`mod${i}Dst`]) continue;
    if (params[`mod${i}Src`] === source || params[`mod${i}Via`] === source) return true;
  }
  return false;
}

/** The most notes sounding at once in a list. */
function maxPolyphony(notes) {
  const events = [];
  for (const n of notes) events.push([n.start, 1], [n.start + n.length, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let max = 0;
  for (const [, d] of events) { now += d; if (now > max) max = now; }
  return max;
}

/**
 * Evaluate a project. Returns { findings: [{ level: 'issue' | 'warning' | 'info', area, where, message }], counts,
 * stats } — issues are things that will not sound as written, warnings are probably unintended, info is context.
 */
export function evaluateComposition(project) {
  const findings = [];
  const add = (level, area, where, message) => findings.push({ level, area, where, message });
  const bar = ticksPerBar(project);
  const key = project.key || 'C';
  const scale = project.scale || 'minor';
  const scalePcs = new Set(scalePitchClasses(key, scale));
  const placed = new Set(project.playlist.clips.filter((c) => c.kind === 'pattern' && !c.mute).map((c) => c.refId));
  const songBars = songLength(project) / bar;

  // ---- arrangement
  const withNotes = project.patterns.filter((p) => Object.values(p.notes).some((l) => l.length));
  if (!withNotes.length) add('issue', 'arrangement', 'project', 'No pattern has any notes yet.');
  if (!placed.size && withNotes.length) add('warning', 'arrangement', 'playlist', 'Nothing is placed in the playlist: song mode and exports play only the first pattern. Use place_pattern or arrange_song.');
  if (placed.size) {
    for (const p of withNotes) if (!placed.has(p.id)) add('info', 'arrangement', `pattern "${p.name}"`, 'Has notes but is not placed in the playlist (it is never heard in the song).');
    for (const p of project.patterns) if (placed.has(p.id) && !withNotes.includes(p)) add('warning', 'arrangement', `pattern "${p.name}"`, 'Is placed in the playlist but has no notes.');
  }

  // ---- per channel: all its notes across patterns
  const stats = [];
  const pcHistogram = new Array(12).fill(0);
  for (const c of project.channels) {
    const def = INSTRUMENTS[c.instrument.kind];
    const where = `channel "${c.name}"`;
    const perPattern = project.patterns.map((p) => [p, p.notes[c.id] || []]).filter(([, l]) => l.length);
    const notes = perPattern.flatMap(([, l]) => l);
    if (!notes.length) {
      add('info', 'arrangement', where, 'Has no notes in any pattern.');
      continue;
    }
    const keys = notes.map((n) => n.key + Math.round(c.pitch || 0));
    const lo = Math.min(...keys);
    const hi = Math.max(...keys);
    const vels = notes.map((n) => n.velocity);
    const poly = Math.max(...perPattern.map(([, l]) => maxPolyphony(l)));
    const offGrid = notes.filter((n) => n.start % (STEP / 2) !== 0).length / notes.length;
    const stat = { channel: c.name, instrument: `${c.instrument.kind}/${c.instrument.preset}`, notes: notes.length, range: `${noteName(lo)}–${noteName(hi)}`, polyphony: poly, velocity: `${Math.round(Math.min(...vels) * 100) / 100}–${Math.round(Math.max(...vels) * 100) / 100}`, offGrid: pct(offGrid) };
    stats.push(stat);
    if (c.mute) add('info', 'mix', where, 'Is muted.');

    if (def?.melodic) {
      for (const k of keys) pcHistogram[k % 12]++;
      // key
      const out = keys.filter((k) => !scalePcs.has(k % 12));
      if (out.length && scale !== 'chromatic') {
        const share = out.length / keys.length;
        const names = [...new Set(out.map((k) => PC[k % 12]))].slice(0, 5).join(', ');
        if (share > 0.2) add('warning', 'harmony', where, `${pct(share)} of its notes are outside ${key} ${scale} (${names}). If that is not intended, check the key (update_project) or the notes.`);
        else add('info', 'harmony', where, `${out.length} chromatic note(s) outside ${key} ${scale} (${names}).`);
      }
      // dynamics
      if (notes.length >= 8 && Math.max(...vels) - Math.min(...vels) < 0.02) {
        add('warning', 'dynamics', where, `Every note has the same velocity (${vels[0]}): flat, mechanical dynamics. Accent the strong beats or use transform_notes (humanize / randomize_velocity).`);
      }
      // register
      const chordsLow = perPattern.some(([, l]) => {
        const lowNotes = l.filter((n) => n.key + (c.pitch || 0) < 48);
        return maxPolyphony(lowNotes) >= 3;
      });
      if (chordsLow) add('warning', 'harmony', where, 'Plays chords of three or more notes below C3: close voicings that low sound muddy. Move the chord up or keep only root and fifth down there.');
      if (hi > 108) add('info', 'harmony', where, `Reaches ${noteName(hi)}: very high, check that it is not shrill.`);
      // voices
      const p = c.instrument.params || {};
      if (p.mono && poly > 1) {
        const stacked = perPattern.some(([, l]) => {
          const starts = new Map();
          for (const n of l) starts.set(n.start, (starts.get(n.start) || 0) + 1);
          return [...starts.values()].some((v) => v > 1);
        });
        if (stacked) add('issue', 'voices', where, `The patch is mono but ${poly} notes sound at once: only one note of each chord plays. Turn mono off (or use a poly preset), or write a single line.`);
      } else if (c.instrument.kind === 'ggs' && poly > (p.polyphony ?? 16)) {
        add('warning', 'voices', where, `${poly} notes overlap but the patch has ${p.polyphony} voices: the oldest notes are cut. Raise polyphony or shorten the notes.`);
      }
    }

    // performance curves that nothing hears
    const used = Object.fromEntries(EXPRESSION_DIMS.map((d) => [d, notes.filter((n) => n.expression?.[d]).length]));
    const wideBend = notes.some((n) => n.expression?.pitch?.some((pt) => Math.abs(pt.v) > 24));
    if (wideBend) add('info', 'expression', where, 'Has pitch curves wider than two octaves.');
    if (c.instrument.kind === 'ggs') {
      const p = c.instrument.params;
      for (const dim of ['pressure', 'timbre']) {
        const label = dim === 'timbre' ? 'slide (timbre)' : 'pressure';
        if (used[dim] && !patchUses(p, dim)) add('issue', 'expression', where, `${used[dim]} note(s) have a ${label} curve, but the patch does not route ${dim} anywhere: nothing changes. Add a route with set_synth_modulation (e.g. ${dim} → f1Cutoff).`);
        else if (!used[dim] && patchUses(p, dim) && notes.length) add('info', 'expression', where, `The patch responds to ${label}, and no note uses it yet (set_note_expression).`);
      }
    } else if (used.pressure || used.timbre) {
      add('issue', 'expression', where, `${used.pressure + used.timbre} pressure/slide curve(s) on a ${def?.label || c.instrument.kind}: only the GGS Synth responds to pressure and slide (pitch curves work on every instrument).`);
    }
    if (!def?.melodic && used.pitch) add('info', 'expression', where, 'Pitch curves on a drum channel: the drum is repitched while it sounds.');
  }

  // ---- does the project key fit the notes?
  const total = pcHistogram.reduce((a, b) => a + b, 0);
  if (total >= 24 && SCALES[scale] && scale !== 'chromatic') {
    const fit = (root, steps) => steps.reduce((s, st) => s + pcHistogram[(root + st) % 12], 0) / total;
    const own = fit(scalePitchClasses(key, scale)[0], SCALES[scale]);
    let best = { fit: own, name: `${key} ${scale}` };
    for (let r = 0; r < 12; r++) {
      for (const s of ['major', 'minor']) {
        const f = fit(r, SCALES[s]);
        if (f > best.fit + 0.12) best = { fit: f, name: `${PC[r]} ${s}` };
      }
    }
    if (best.name !== `${key} ${scale}`) add('warning', 'harmony', 'project', `The notes fit ${best.name} (${pct(best.fit)} in scale) better than the project key ${key} ${scale} (${pct(own)}). Scale highlighting and roman numerals follow the project key.`);
  }

  // ---- mixer (what can be seen without listening; render_mix measures the rest)
  if (!project.mixer[0].effects.some((e) => e.type === 'limiter' && e.enabled)) add('warning', 'mix', 'master', 'The master has no limiter: peaks above 0 dBFS will clip in an export.');
  const sharing = new Map();
  for (const c of project.channels) if (c.mixerTrack > 0) sharing.set(c.mixerTrack, [...(sharing.get(c.mixerTrack) || []), c.name]);
  for (const [i, names] of sharing) if (names.length > 1) add('info', 'mix', `insert ${i}`, `Shared by ${names.join(', ')}: its effects and fader move them together.`);
  const direct = project.channels.filter((c) => c.mixerTrack === 0).map((c) => c.name);
  if (direct.length) add('info', 'mix', 'master', `${direct.join(', ')} go straight to the master (no insert of their own to EQ or level).`);
  const melodicChannels = project.channels.filter((c) => INSTRUMENTS[c.instrument.kind]?.melodic && !c.mute);
  if (melodicChannels.length >= 5 && melodicChannels.every((c) => Math.abs(c.pan) < 0.05 && Math.abs(project.mixer[c.mixerTrack]?.pan || 0) < 0.05)) {
    add('info', 'mix', 'mixer', `All ${melodicChannels.length} melodic channels are panned to the center: spread a few left and right for width.`);
  }

  const counts = { issue: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  const order = { issue: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    findings, counts, stats,
    overview: { bpm: project.bpm, key: `${key} ${scale}`, songBars: Math.round(songBars * 100) / 100, patterns: project.patterns.length, longestPatternBars: Math.max(...project.patterns.map((p) => patternLength(project, p) / bar)) }
  };
}

/** Plain-text report of evaluateComposition (what the MCP tool returns). */
export function formatEvaluation(e) {
  const lines = [`COMPOSITION CHECK — ${e.overview.bpm} BPM, ${e.overview.key}, song ${e.overview.songBars} bars: ${e.counts.issue} issue(s), ${e.counts.warning} warning(s), ${e.counts.info} note(s)`];
  for (const level of ['issue', 'warning', 'info']) {
    const list = e.findings.filter((f) => f.level === level);
    if (!list.length) continue;
    lines.push('', level === 'issue' ? 'ISSUES (will not sound as written):' : level === 'warning' ? 'WARNINGS (probably not intended):' : 'NOTES:');
    for (const f of list) lines.push(`  [${f.area}] ${f.where}: ${f.message}`);
  }
  if (e.stats.length) {
    lines.push('', 'CHANNELS:');
    for (const s of e.stats) lines.push(`  ${s.channel} (${s.instrument}): ${s.notes} notes, ${s.range}, up to ${s.polyphony} at once, velocity ${s.velocity}, ${s.offGrid} off the 32nd grid`);
  }
  if (!e.counts.issue && !e.counts.warning) lines.push('', 'Nothing to fix in the notes. Listen next: render_mix measures loudness, balance and the limiter.');
  return lines.join('\n');
}
