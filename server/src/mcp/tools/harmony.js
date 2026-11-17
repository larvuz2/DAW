// Harmony and tuning: reading chords in a key, proposing the next ones, the progression library, arpeggios and
// drum grooves by style, and the tuning the project plays in.
import {
  STEP, PPQ, ticksPerBar, uid, findChannel, findPattern, patternLength, parseNote, noteName, chordNotes, chordProgressionNotes, VOICINGS,
  keyContext, readChord, analyzeChord, tensionCurve, detectKey, chordsFromNotes, suggestNext, SUGGESTION_POOLS, substitutions, negativeHarmony,
  modulationPaths, findProgressions, progressionByName, progressionTags, identifyProgression, scaleSpelling, followsTuning, isRest,
  voiceLead, arpeggiate, ARP_MODES, drumPattern, DRUM_STYLES, DRUM_STYLE_INFO,
  TUNING_SYSTEMS, TUNING_IDS, normalizeTuning, mergeTuning, tuningTable, describeTuning, chordPurity, isStandardTuning, A4_MIN, A4_MAX, EDO_MIN, EDO_MAX,
  requireScale, SCALE_INFO, INSTRUMENTS, scalePitchClasses
} from '@greanteadawy/core';
import {
  z, ok, projectIdArg, annotations as A, resolveChords, growPatternOp, assertFitsPattern, normVelocity, uniqueName, durationArg, durationTicks, DURATION_WORDS, steps
} from '../util.js';
import { roleOf } from './production.js';

const chordsArg = z.array(z.string().max(32)).max(256);
const CHORD_WORDS = 'chord symbols (Am, F#m7, G7b9, C/E) or roman numerals in the key (i, bVII, V7/V, IV/1); "-" = a rest';
const seedArg = z.union([z.number(), z.string().max(64)]).optional().describe('The same seed gives the same part again; change it for another take (a number or any text, default 0)');
const sign = (x, digits = 1) => `${x > 0 ? '+' : ''}${x.toFixed(digits)}`;
const pad = (s, n) => String(s).padEnd(n);

/** The chords of a call as block voicings, one list of pitches per chord (null for a rest). */
export function voicedChords(chords, { octave = 4, voicing = 'close', inversion = 0, center = null, voices = null, bass = 'root', low = null, high = null }) {
  if (voices) {
    // the solver places every voice of every chord at once; the register comes from the range
    const lo = low ?? Math.max(24, (octave + 1) * 12 - 20);
    return voiceLead(chords, { voices, low: lo, high: high ?? Math.min(108, lo + 39), bass, style: voicing === 'open' || voicing === 'spread' ? 'open' : 'close' }).voicings;
  }
  const span = PPQ * 4;
  const notes = chordProgressionNotes(chords, { start: 0, chordLength: span, octave, style: 'block', voicing, inversion, center, gate: 1 });
  return chords.map((c, i) => (isRest(c) ? null : notes.filter((n) => n.start === i * span).map((n) => n.key).sort((x, y) => x - y)));
}

export function registerHarmonyTools({ tool, backend, load }) {
  /** The key a call works in: its own `key`/`scale`, else the project's. */
  async function keyOf(a) {
    let p = null;
    try { p = await load(a.projectId); } catch (e) { if (a.projectId || !(a.key && a.scale)) throw e; }
    const key = a.key || p?.key || 'C';
    const scale = requireScale(a.scale || p?.scale || 'major');
    return { p, ctx: keyContext(key, scale) };
  }

  tool('harmony', {
    title: 'Harmony: analyse, suggest, substitute, modulate, progression library',
    description: `Work with chords in a key (the project's, unless key/scale are given).
- action "analyze": what each chord is — roman numeral, function (tonic / subdominant / dominant), where it comes from (the key, a parallel mode, a secondary dominant, a tritone substitute…), its tension 0–1 — plus the name of the progression if it is a known one. Give chords, or pattern (+ channel) to read the chords the notes play and check the key.
- action "suggest": chords that could come next after chords (may be empty), best first, each with its reason; grouped as in the key / borrowed from parallel modes / chromatic (secondary dominants, tritone substitute, passing diminished, chromatic mediants).
- action "substitute": what could stand in for chord, or go in front of it: tritone substitute, relative, borrowed, neo-Riemannian, chromatic mediants, approach chords, richer extensions.
- action "negative": chords mirrored around the key's axis (negative harmony): G7 → Fm6.
- action "modulate": ways from this key to toKey/toScale with the chords to play: pivot chords, borrowed pivots, dominant preparation, common tone.
- action "progressions": search the library of 82 progressions by words (query), tags (genre and mood: pop, jazz, lo-fi, cinematic, dark, hopeful, epic, trap, house, neo-soul…), scale or mood, length; answers with the chords in this key. Write one with add_chords progression="<name>".
Nothing here changes the project. Chords are ${CHORD_WORDS}.`,
    inputSchema: {
      projectId: projectIdArg,
      action: z.enum(['analyze', 'suggest', 'substitute', 'negative', 'modulate', 'progressions']),
      chords: chordsArg.optional().describe(`The progression: ${CHORD_WORDS}`),
      chord: z.string().max(32).optional().describe('For substitute: the chord to replace or colour'),
      pattern: z.string().optional().describe('For analyze: read the chords from this pattern instead of `chords`'),
      channel: z.string().optional().describe('…from this channel only (default: every pitched channel of the pattern together)'),
      per: z.enum(['bar', 'half', 'beat']).optional().describe('For analyze from a pattern: one chord reading per bar (default), half bar or beat'),
      key: z.string().max(3).optional().describe('Key root, e.g. "A", "F#" (default: the project key)'),
      scale: z.string().max(40).optional().describe('Scale or mode, any name: minor, dorian, "phrygian dominant" (default: the project scale)'),
      toKey: z.string().max(3).optional().describe('For modulate: the key to reach, e.g. "E"'),
      toScale: z.string().max(40).optional().describe('…and its scale (default: major or minor like the key you are in)'),
      pools: z.array(z.enum(SUGGESTION_POOLS)).optional().describe('For suggest: which kinds of chords — diatonic (in the key), borrowed (parallel modes), chromatic. Default all three'),
      sevenths: z.boolean().optional().describe('For suggest: seventh chords instead of triads'),
      smooth: z.boolean().optional().describe('For suggest: prefer chords whose notes move least (voice leading) over the strongest functional move'),
      count: z.number().int().min(1).max(20).optional().describe('How many answers (suggest: per group, default 5; modulate: default 6; progressions: default 10)'),
      query: z.string().max(80).optional().describe('For progressions: words to look for in names, tags and descriptions, e.g. "sad piano", "andalusian"'),
      tags: z.array(z.string().max(30)).max(6).optional().describe('For progressions: tags that must all be there, e.g. ["lo-fi", "jazz"]'),
      mood: z.enum(['major', 'minor']).optional().describe('For progressions: every mode with a major / a minor third'),
      length: z.number().int().min(2).max(16).optional().describe('For progressions: number of chords')
    },
    annotations: A.readOnly
  }, async (a) => {
    const { p, ctx } = await keyOf(a);
    const chordList = () => {
      if (!a.chords?.length) throw new Error(`chords is required for action "${a.action}": ${CHORD_WORDS}`);
      return a.chords.filter((c) => !isRest(c)).map((c) => readChord(c, ctx));
    };
    switch (a.action) {
      case 'analyze': {
        let chords;
        const lines = [];
        if (a.pattern) {
          if (!p) throw new Error('pattern needs a project');
          const pt = findPattern(p, a.pattern);
          const channels = a.channel ? [findChannel(p, a.channel)] : p.channels.filter((c) => followsTuning(c.instrument) && roleOf(c) !== 'bass' && (pt.notes[c.id] || []).length);
          const notes = channels.flatMap((c) => pt.notes[c.id] || []);
          if (!notes.length) throw new Error(`"${pt.name}" has no notes${a.channel ? ` on "${channels[0].name}"` : ' on a pitched channel'} to read chords from`);
          const bar = ticksPerBar(p);
          const segment = a.per === 'beat' ? PPQ : a.per === 'half' ? bar / 2 : bar;
          const read = chordsFromNotes(notes, { segment, end: patternLength(p, pt), spell: scaleSpelling(ctx.key, ctx.scale) });
          chords = read.filter((c) => c.chord).map((c) => readChord(c.chord, ctx));
          lines.push(`Chords of "${pt.name}"${a.channel ? ` (${channels[0].name})` : ''}, one reading per ${a.per || 'bar'}: ${read.map((c) => `${c.chord || (c.pitches.length ? '?' : '–')}${c.length > segment ? ` ×${c.length / segment}` : ''}`).join('  ')}`);
          // (bass notes count for the key, not for naming chords: a walking bass would rename every bar)
          const all = p.channels.filter((c) => followsTuning(c.instrument)).flatMap((c) => pt.notes[c.id] || []);
          const keys = detectKey(all, { count: 3 });
          if (keys.length) {
            const fits = keys.findIndex((k) => k.tonic === ctx.tonic && (k.scale === 'minor') === ctx.minor);
            // A minor and C major (and D dorian) are the same seven notes: counting notes cannot tell them apart, only
            // where the music comes to rest can — so the relative key on top is no reason to change the project's
            const own = new Set(ctx.degrees.map((d) => (ctx.tonic + d) % 12));
            const sameNotes = (k) => { const pcs = scalePitchClasses(k.key, k.scale); return pcs.length === own.size && pcs.every((x) => own.has(x)); };
            const verdict = fits === 0 ? ` — the project key ${ctx.label} fits best`
              : sameNotes(keys[0]) ? ` — ${keys[0].key} ${keys[0].scale} has the same notes as the project key ${ctx.label}: the notes fit it, and which of the two it is depends on where the music rests`
                : fits > 0 ? ` — the project key ${ctx.label} is among them`
                  : ` — the project key is ${ctx.label}: if the first is what you hear, set it with update_project`;
            lines.push(`Key by the notes: ${keys.map((k) => `${k.key} ${k.scale} (${k.score})`).join(', ')}${verdict}`);
          }
          if (!chords.length) return ok(`${lines.join('\n')}\nNo segment names a chord (single notes or clusters): try per="half" or a channel that plays chords.`);
        } else chords = chordList();
        const curve = tensionCurve(chords, ctx);
        lines.push(`${chords.map((c) => c.name).join(' – ')} in ${ctx.label}:`);
        chords.forEach((c, i) => {
          const x = analyzeChord(c, ctx);
          const from = x.kind === 'diatonic' ? '' : x.kind === 'borrowed' ? `borrowed from ${x.borrowedFrom}` : x.secondaryOf ? `${x.kind} of ${x.secondaryOf}` : x.kind;
          lines.push(`${String(i + 1).padStart(2)}. ${pad(c.name, 9)} ${pad(x.numeral, 10)} ${pad(x.function, 18)} tension ${curve[i].tension.toFixed(2)}${from ? `  — ${from}` : ''}`);
        });
        const known = identifyProgression(chords, ctx);
        if (known.length) lines.push(`Known as: ${known.slice(0, 3).map((k) => `"${k.name}"${k.match === 'rotation' ? ' (started on another chord)' : ''}`).join(', ')}`);
        const peak = curve.reduce((m, x, i) => (x.tension > curve[m].tension ? i : m), 0);
        if (curve.length > 1) lines.push(`Tension: ${curve.map((x) => x.tension.toFixed(2)).join(' → ')} — highest on chord ${peak + 1} (${curve[peak].chord}), ${curve[curve.length - 1].tension < 0.2 ? 'and it ends at rest' : curve[curve.length - 1].function === 'dominant' ? 'and it ends on the dominant: it wants to go on (a good loop)' : 'and it ends away from home'}`);
        const next = suggestNext(chords, ctx, undefined, { count: 3 });
        lines.push(`Could go on with: ${next.map((x) => `${x.chord} (${x.numeral})`).join(', ')} — action "suggest" for more and the reasons.`);
        return ok(lines.join('\n'), { key: ctx.key, scale: ctx.scale, chords: curve });
      }
      case 'suggest': {
        const played = (a.chords || []).filter((c) => !isRest(c)).map((c) => readChord(c, ctx));
        const all = suggestNext(played, ctx, undefined, { count: 200, pools: a.pools || SUGGESTION_POOLS, sevenths: !!a.sevenths, smooth: !!a.smooth });
        const per = a.count ?? 5;
        const lines = [`${played.length ? `After ${played.map((c) => c.name).join(' – ')}` : 'To start'} in ${ctx.label}:`];
        const titles = { diatonic: 'In the key', borrowed: 'Borrowed from parallel modes', chromatic: 'Chromatic' };
        for (const pool of SUGGESTION_POOLS) {
          const list = all.filter((x) => x.pool === pool).slice(0, per);
          if (!list.length) continue;
          lines.push(`${titles[pool]}:`);
          for (const x of list) lines.push(`  ${pad(x.chord, 8)} ${pad(x.numeral, 9)} ${x.score.toFixed(2)}  tension ${x.tension.toFixed(2)} — ${x.why}`);
        }
        lines.push('Scores are how readily the progression moves there (1 = the expected move). Write the progression with add_chords.');
        return ok(lines.join('\n'), { key: ctx.key, scale: ctx.scale, suggestions: all.filter((x, i, list) => list.filter((y, j) => j < i && y.pool === x.pool).length < per) });
      }
      case 'substitute': {
        if (!a.chord) throw new Error('chord is required for action "substitute", e.g. chord: "G7"');
        const chord = readChord(a.chord, ctx);
        const subs = substitutions(chord, ctx);
        const here = analyzeChord(chord, ctx);
        const lines = [`${chord.name} is ${here.numeral} in ${ctx.label} (${here.function}). Instead of it, or around it:`];
        for (const kind of [...new Set(subs.map((s) => s.kind))]) {
          lines.push(`${kind[0].toUpperCase()}${kind.slice(1)}:`);
          for (const s of subs.filter((x) => x.kind === kind)) lines.push(`  ${pad(s.chord, 8)} ${pad(s.numeral, 10)} ${s.why}`);
        }
        return ok(lines.join('\n'), { chord: chord.name, substitutions: subs });
      }
      case 'negative': {
        const chords = chordList();
        const mirrored = negativeHarmony(chords, ctx.key, ctx.minor ? 'minor' : 'major');
        return ok(`Negative harmony around the axis of ${ctx.key} (every note mirrored between the tonic and its fifth — major turns minor, the dominant's pull becomes a plagal one):\n${mirrored.map((m) => `  ${pad(m.chord, 9)} → ${pad(`${m.exact ? '' : '≈ '}${m.mirrored}`, 9)} (${m.notes.join(' ')})`).join('\n')}\nMirrored progression: ${mirrored.map((m) => m.mirrored).join(' – ')}${mirrored.some((m) => !m.exact) ? '\n≈ = the closest chord name: the mirror has a note this name does not (the notes in brackets are the mirror itself — write those with add_notes if you want it exactly).' : ''}`, { mirrored });
      }
      case 'modulate': {
        if (!a.toKey) throw new Error('toKey is required for action "modulate", e.g. toKey: "E" (and toScale: "major")');
        const paths = modulationPaths(ctx.key, ctx.scale, a.toKey, a.toScale || (ctx.minor ? 'minor' : 'major'), { count: a.count ?? 6 });
        const to = keyContext(a.toKey, a.toScale || (ctx.minor ? 'minor' : 'major'));
        const lines = [`From ${ctx.label} to ${to.label}, best first:`];
        paths.forEach((path, i) => {
          lines.push(`${i + 1}. ${path.kind} (${path.score.toFixed(2)}): ${path.chords.join(' – ')}`);
          lines.push(`   ${path.why}`);
        });
        lines.push('Write a path with add_chords (the chord symbols as they are), then set the new key with update_project if the song stays there.');
        return ok(lines.join('\n'), { from: ctx.label, to: to.label, paths });
      }
      default: {
        const found = findProgressions({ query: a.query, tags: a.tags, scale: a.scale && !a.mood ? a.scale : null, mood: a.mood, length: a.length, key: ctx.key, limit: a.count ?? 10, prefer: ctx.minor ? 'minor' : 'major' });
        if (!found.length) return ok(`No progression in the library fits that. Tags: ${progressionTags().map((t) => `${t.tag} (${t.count})`).join(', ')}`);
        const lines = [`${found.length} progression${found.length > 1 ? 's' : ''}, written in ${ctx.key} (each in its own mode):`];
        for (const f of found) {
          lines.push(`"${f.name}" — ${SCALE_INFO[f.scale].label}: ${f.numerals.join(' ')}  =  ${f.chords.join(' ')}`);
          lines.push(`   ${f.description} [${f.tags.join(', ')}]`);
        }
        lines.push('Write one with add_chords (progression: "<name>") or add_arpeggio; "harmony analyze" explains its chords.');
        return ok(lines.join('\n'), { progressions: found });
      }
    }
  });

  // ---------------------------------------------------------------- arpeggio

  tool('add_arpeggio', {
    title: 'Add arpeggio',
    description: `Arpeggiate a chord progression into a channel. Modes: ${ARP_MODES.join(', ')} (converge = outside in, diverge = inside out, pinky / thumb = the top / bottom note between all others, asplayed = the order of the voicing, random = seeded). Chords are ${CHORD_WORDS} — or progression = a name from the library (harmony action "progressions"). The pattern grows to fit.`,
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      chords: chordsArg.min(1).optional().describe(`The chords: ${CHORD_WORDS}`),
      progression: z.string().max(80).optional().describe('Instead of chords: a progression of the library by name, e.g. "Axis" or "Andalusian cadence" (played in the project key)'),
      stepsPerChord: z.number().min(1).max(1024).optional().describe('Default 16 (one bar per chord)'),
      mode: z.enum(ARP_MODES).optional().describe('Default up'),
      rate: durationArg.optional().describe(`Time between notes (default "1/8"): ${DURATION_WORDS}`),
      octaves: z.number().int().min(1).max(4).optional().describe('Repeat the cycle over this many octaves (default 1)'),
      gate: z.number().min(0.05).max(2).optional().describe('Note length as a share of the rate (default 0.8; above 1 the notes overlap — legato, pads)'),
      swing: z.number().min(0).max(0.95).optional().describe('Every second note this much later (0–0.95 of half the rate; default 0)'),
      velocity: z.number().min(0).max(127).optional().describe('0..1 (1 = full), or MIDI 2..127 (default 0.75)'),
      accentEvery: z.number().int().min(0).max(64).optional().describe('Every n-th note is accented (0 = none)'),
      accent: z.number().min(0).max(1).optional().describe('How much louder an accented note is (default 0.2)'),
      velocities: z.array(z.number().min(0).max(1)).max(64).optional().describe('A velocity pattern (0..1 per note, repeated) instead of velocity/accent, e.g. [1, 0.5, 0.7, 0.5]'),
      octave: z.number().int().min(0).max(8).optional().describe('Octave of the first chord root (default 4)'),
      voicing: z.enum(VOICINGS).optional().describe('How each chord is spread before it is arpeggiated (default close)'),
      voices: z.number().int().min(3).max(6).optional().describe('Voice the chords with this many voices by the voice-leading solver (smoothest motion between chords) instead of `voicing`'),
      seed: seedArg,
      start: z.number().min(0).optional().describe('Start step (default 0)'),
      replace: z.boolean().optional().describe("Default true: first clear this channel's notes inside the range being written. false = add on top.")
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    if (!!a.chords === !!a.progression) throw new Error('Give either chords (symbols or roman numerals) or progression (a name from the library) — one of the two');
    const named = a.progression ? progressionByName(a.progression, p.key) : null;
    const chords = named ? named.chords : resolveChords(a.chords, p);
    const span = Math.round((a.stepsPerChord ?? 16) * STEP);
    const lo = Math.round((a.start || 0) * STEP);
    const hi = lo + chords.length * span;
    assertFitsPattern(p, pt, hi);
    const rate = a.rate === undefined ? STEP * 2 : durationTicks(a.rate, 'steps', p);
    const voiced = voicedChords(chords, { octave: a.octave ?? 4, voicing: a.voicing || 'close', voices: a.voices });
    const events = voiced.map((pitches, i) => pitches && { pitches, start: lo + i * span, length: span }).filter(Boolean);
    const notes = arpeggiate(events, {
      mode: a.mode || 'up', rate, gate: a.gate ?? 0.8, octaves: a.octaves ?? 1, velocity: normVelocity(a.velocity, 0.75), accentEvery: a.accentEvery ?? 0,
      accent: a.accent ?? 0.2, velocities: a.velocities || [], swing: a.swing ?? 0, seed: a.seed ?? 0
    }).map((n) => ({ id: uid('n'), ...n }));
    if (!notes.length) throw new Error('Nothing to write: every chord is a rest');
    const ops = [a.replace === false
      ? { type: 'notes/add', patternId: pt.id, channelId: ch.id, notes }
      : { type: 'notes/set', patternId: pt.id, channelId: ch.id, notes: [...(pt.notes[ch.id] || []).filter((n) => n.start < lo || n.start >= hi), ...notes] }];
    const grow = growPatternOp(p, pt, hi);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Arpeggiated ${named ? `"${named.name}" = ` : ''}${chords.join(' – ')} (${a.mode || 'up'}, ${notes.length} notes, one every ${steps(rate)} step${steps(rate) === 1 ? '' : 's'}${(a.octaves ?? 1) > 1 ? `, ${a.octaves} octaves` : ''}${a.mode === 'random' ? `, seed ${a.seed ?? 0}` : ''}) on "${ch.name}" in "${pt.name}": ${noteName(Math.min(...notes.map((n) => n.key)))}–${noteName(Math.max(...notes.map((n) => n.key)))}.`);
  });

  // ---------------------------------------------------------------- drum groove

  // role of the groove → which channel plays it: [role as channels are read, instruments in order of preference]
  const PLAYERS = {
    kick: ['kick', ['kick'], 'Kick', 'kick', null], snare: ['snare', ['snare', 'rim', 'clap'], 'Snare', 'snare', null], clap: ['snare', ['clap', 'snare', 'rim'], 'Clap', 'clap', null],
    hat: ['hat', ['hat', 'shaker'], 'Hat', 'hat', 'Closed'], openhat: ['hat', ['hat'], 'Open Hat', 'hat', 'Open'], perc: ['perc', ['perc', 'cowbell', 'tom'], 'Perc', 'perc', null],
    tom: ['perc', ['tom', 'perc'], 'Tom', 'tom', null]
  };
  const isOpen = (c) => /open|oh\b/i.test(c.name) || (c.instrument.kind === 'hat' && (c.instrument.params?.decay ?? 0) >= 0.25);

  tool('add_drum_groove', {
    title: 'Add drum groove by style',
    description: `Write a drum groove in a style onto the project's drum channels (kick, snare/clap, hats, percussion — found by instrument and name; missing ones are created). Styles: ${DRUM_STYLES.map((s) => `${s} (${DRUM_STYLE_INFO[s].label})`).join(', ')}. variation adds seeded ghost notes, dropped hats and small velocity moves; fill turns the last quarter of the last bar into a fill. The same seed gives the same groove. For your own steps use write_drums (which also takes Euclidean rhythms: "E(5,16)").`,
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      style: z.enum(DRUM_STYLES),
      bars: z.number().int().min(1).max(64).optional().describe('How many bars (default: the length of the pattern)'),
      variation: z.number().min(0).max(1).optional().describe('0 = the plain pattern (default), 1 = a lot of ghost notes and changes'),
      fill: z.boolean().optional().describe('A fill in the last quarter of the last bar (the kick stays)'),
      swing: z.number().min(0).max(0.95).optional().describe("Off-beat sixteenths this much later (default: the style's own — boomBap 0.3, twoStep 0.35, lofi 0.25, others 0)"),
      seed: seedArg,
      startBar: z.number().int().min(1).max(64).optional().describe('Bar of the pattern the groove starts on (default 1)'),
      createMissing: z.boolean().optional().describe('Default true: add a channel for a drum the style needs and the project lacks. false = leave those hits out'),
      replace: z.boolean().optional().describe('Default true: first clear the range on the channels the groove writes to. false = add on top')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const bar = ticksPerBar(p);
    if (bar !== PPQ * 4) throw new Error(`The drum styles are written in 4/4 and this project is in ${p.timeSig.join('/')}: write the steps yourself with write_drums (it takes Euclidean rhythms such as "E(5,${Math.round(bar / STEP)})")`);
    const lo = ((a.startBar ?? 1) - 1) * bar;
    if (a.bars === undefined && lo >= patternLength(p, pt)) throw new Error(`startBar ${a.startBar} is past the end of "${pt.name}" (${Math.round(patternLength(p, pt) / bar)} bars): give bars to grow the pattern`);
    const bars = a.bars ?? Math.max(1, Math.round((patternLength(p, pt) - lo) / bar));
    const hi = lo + bars * bar;
    assertFitsPattern(p, pt, hi);
    const hits = drumPattern(a.style, { bars, variation: a.variation ?? 0, fill: !!a.fill, swing: a.swing ?? null, seed: a.seed ?? 0 });
    const ops = [];
    const created = [];
    const missing = [];
    const channelOf = new Map();
    const names = [...p.channels];
    for (const role of [...new Set(hits.map((h) => h.role))]) {
      const [as, kinds, label, kind, preset] = PLAYERS[role];
      // A name alone does not make a drum: a synth called "Kick Bass" or a piano called "Top Hat Lead" plays a part
      // of its own, and the groove would overwrite it. Only drum instruments and samplers can take a drum role.
      const candidates = p.channels.filter((c) => roleOf(c) === as && (!followsTuning(c.instrument) || c.instrument.kind === 'sampler'));
      const rank = (c) => (kinds.indexOf(c.instrument.kind) + 1 || 99) + (as === 'hat' && isOpen(c) !== (role === 'openhat') ? 50 : 0);
      let ch = [...candidates].sort((x, y) => rank(x) - rank(y))[0] || null;
      // an open hat needs its own channel to ring: the closed hat is no stand-in when one can be made
      if (ch && role === 'openhat' && !isOpen(ch) && a.createMissing !== false) ch = null;
      if (!ch && a.createMissing !== false) {
        ch = { id: uid('ch'), name: uniqueName(names, label), kind, ...(preset ? { preset } : {}), mixerTrack: 'auto' };
        names.push(ch);
        ops.push({ type: 'channel/add', nameInsert: true, channel: ch });
        created.push(`${ch.name} [${ch.id}]`);
        ch = { ...ch, rootKey: INSTRUMENTS[kind].defaultKey, fresh: true };
      }
      if (ch) channelOf.set(role, ch);
      else missing.push(role);
    }
    const perChannel = new Map();
    for (const h of hits) {
      const ch = channelOf.get(h.role);
      if (!ch) continue;
      const list = perChannel.get(ch.id) || perChannel.set(ch.id, { ch, at: new Map() }).get(ch.id);
      // two roles on one channel (an open hat on the only hat): one hit per moment, the louder one
      const had = list.at.get(h.tick);
      if (!had || had < h.velocity) list.at.set(h.tick, h.velocity);
    }
    const report = [];
    for (const { ch, at } of perChannel.values()) {
      const ticks = [...at.keys()].sort((x, y) => x - y);
      const notes = ticks.map((t, i) => ({ id: uid('n'), key: ch.rootKey, start: lo + t, length: Math.max(6, Math.min(STEP, (ticks[i + 1] ?? Infinity) - t)), velocity: at.get(t) }));
      const kept = ch.fresh || a.replace === false ? [] : (pt.notes[ch.id] || []).filter((n) => n.start < lo || n.start >= hi);
      ops.push(a.replace === false && !ch.fresh ? { type: 'notes/add', patternId: pt.id, channelId: ch.id, notes } : { type: 'notes/set', patternId: pt.id, channelId: ch.id, notes: [...kept, ...notes] });
      report.push(`${ch.name} ${notes.length}`);
    }
    if (!report.length) throw new Error(`The project has no drum channel for this groove and createMissing is false: add channels first (add_channel instrument kick / snare / hat)`);
    const grow = growPatternOp(p, pt, hi);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    const info = DRUM_STYLE_INFO[a.style];
    return ok(`${info.label} groove, ${bars} bar${bars > 1 ? 's' : ''}${a.variation ? `, variation ${a.variation}` : ''}${a.fill ? ', with a fill' : ''}${a.variation || a.fill ? `, seed ${a.seed ?? 0}` : ''}, in "${pt.name}" — hits: ${report.join(', ')}.${created.length ? ` Created ${created.join(', ')}.` : ''}${missing.length ? ` Left out (no channel): ${missing.join(', ')}.` : ''}${(a.swing ?? info.swing) > 0 ? ` Swing ${a.swing ?? info.swing} is written into the notes.` : ''}`);
  });

  // ---------------------------------------------------------------- tuning

  const tuningArgs = {
    system: z.enum(TUNING_IDS).optional().describe(`The tuning system: ${TUNING_SYSTEMS.map((t) => `${t.id} = ${t.label}`).join('; ')}`),
    root: z.string().max(3).optional().describe('The note the tuning is built on — it keeps its equal-tempered frequency, everything else is placed against it. Usually the key of the song (default: the project key when a system is chosen, C for the well temperaments)'),
    a4: z.number().min(A4_MIN).max(A4_MAX).optional().describe('Reference pitch in Hz (440 = concert pitch; 432 and 415 are common others)'),
    divisions: z.number().int().min(EDO_MIN).max(EDO_MAX).optional().describe('For system "equal": equal steps per octave when not 12 (19, 24, 31, 53…) — every key is then one step, so the piano roll no longer shows semitones'),
    fraction: z.number().min(0).max(0.5).optional().describe('For system "meantone": the share of the comma each fifth is narrowed by (0.25 = quarter-comma, default; 0.333 = third-comma; 0.167 = sixth-comma)'),
    cents: z.array(z.number().min(-2400).max(2400)).length(12).optional().describe('For system "custom": cents above the root for each of the twelve notes, starting with the root (0)'),
    ratios: z.array(z.union([z.string().max(24), z.number().positive()])).length(12).optional().describe('For system "custom": twelve ratios above the root instead of cents, e.g. ["1/1","16/15","9/8",…]')
  };
  const WELL = new Set(['werckmeister', 'kirnberger', 'vallotti', 'young']);
  /** A tuning from the arguments of a call, over what the project has. */
  function tuningFrom(a, p) {
    const patch = {};
    for (const k of ['system', 'root', 'a4', 'divisions', 'fraction', 'cents', 'ratios']) if (a[k] !== undefined) patch[k] = a[k];
    const current = p?.tuning || {};
    if (patch.cents && patch.ratios) throw new Error('Give cents or ratios for a custom tuning, not both');
    // a table is a custom tuning: sending one says so
    if ((patch.cents || patch.ratios) && patch.system === undefined) patch.system = 'custom';
    // an argument the system has no use for would be accepted and change nothing: say where it belongs instead
    const system = patch.system ?? current.system ?? 'equal';
    const belongs = { divisions: 'equal', fraction: 'meantone', cents: 'custom', ratios: 'custom' };
    for (const [field, owner] of Object.entries(belongs)) {
      if (patch[field] !== undefined && system !== owner) throw new Error(`${field} only means something in system "${owner}", and the tuning ${patch.system ? 'you ask for' : 'of the project'} is "${system}": add system: "${owner}", or leave ${field} out`);
    }
    // a system chosen without a root is built on the song's key (the well temperaments on C, as they were designed)
    if (patch.system && patch.root === undefined && patch.system !== 'equal' && (current.system ?? 'equal') === 'equal') patch.root = WELL.has(patch.system) ? 'C' : p?.key || 'C';
    return { patch, tuning: normalizeTuning(mergeTuning(current, patch), { strict: true }) };
  }
  function tableText(tuning) {
    const rows = tuningTable(tuning);
    return rows.map((r) => `  ${pad(r.note, 8)} ${pad(r.ratio || (r.near ? `≈ ${r.near}` : '—'), 11)} ${r.cents.toFixed(1).padStart(7)} c  ${rows.length === 12 ? `${sign(r.deviation).padStart(6)} c  ` : ''}${r.hz.toFixed(3).padStart(9)} Hz`).join('\n');
  }

  tool('set_tuning', {
    title: 'Set the tuning of the project',
    description: `Choose the tuning every pitched instrument of the project plays in (drums, tabla, taiko and gongs are not retuned): ${TUNING_IDS.join(', ')}, a root and the A4 reference. The root keeps its equal-tempered pitch; the other notes move by a few cents to about ±50 (the harmonic series moves its eleventh harmonic by 49). Only what you name changes (a4 alone keeps the system). system "equal" with a4 440 is the standard. Renders, exports and playback all follow. Look before you leap with describe_tuning (chord = how a chord beats in each system).`,
    inputSchema: { projectId: projectIdArg, ...tuningArgs },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const { patch, tuning } = tuningFrom(a, p);
    if (!Object.keys(patch).length) throw new Error('Nothing to set: give system, root, a4 — or use describe_tuning to look at the tuning as it is');
    await backend.applyOps(p.id, [{ type: 'project/update', patch: { tuning: patch } }]);
    const drums = p.channels.filter((c) => !followsTuning(c.instrument)).length;
    return ok(`Tuning: ${describeTuning(tuning)}${isStandardTuning(tuning) ? ' (the standard)' : ''}.${isStandardTuning(tuning) ? '' : `\n${TUNING_SYSTEMS.find((t) => t.id === tuning.system).description}\n  note     ratio        above root   vs equal        in Hz\n${tableText(tuning)}`}${drums ? `\n${drums} drum channel${drums > 1 ? 's are' : ' is'} not retuned.` : ''}`);
  });

  tool('describe_tuning', {
    title: 'Describe a tuning',
    description: 'The table of a tuning — each note\'s exact ratio to the root (as a fraction where the system is rational), cents above the root, cents away from equal temperament, and its frequency in Hz — for the project\'s tuning or for the one given. With chord: how pure that chord is in it (the ratio each interval is near, how many cents it is off and how fast it beats), and with compare the same chord in other systems side by side. Changes nothing.',
    inputSchema: {
      projectId: projectIdArg,
      ...tuningArgs,
      chord: z.string().max(32).optional().describe('A chord to judge in the tuning: a symbol or roman numeral (C, Dm7, V7), played around middle C'),
      notes: z.array(z.union([z.string().max(8), z.number()])).min(2).max(8).optional().describe('…or its exact notes, e.g. ["C4","E4","G4","Bb4"]'),
      compare: z.array(z.enum(TUNING_IDS)).max(8).optional().describe('With chord or notes: also show it in these systems (same root and A4)')
    },
    annotations: A.readOnly
  }, async (a) => {
    let p = null;
    try { p = await load(a.projectId); } catch (e) { if (a.projectId) throw e; }
    const { tuning } = tuningFrom(a, p);
    const lines = [`${describeTuning(tuning)}${isStandardTuning(tuning) ? ' (the standard)' : ''}${p && JSON.stringify(normalizeTuning(p.tuning)) === JSON.stringify(tuning) ? ' — the tuning of this project' : ''}`,
      TUNING_SYSTEMS.find((t) => t.id === tuning.system).description,
      `  note     ratio        above root  ${tuning.divisions ? '' : ' vs equal   '}     in Hz`, tableText(tuning)];
    let purity = null;
    if (a.chord || a.notes) {
      const pitches = a.notes ? a.notes.map((n) => parseNote(n)) : chordNotes(readChord(a.chord, p ? keyContext(p.key, p.scale) : keyContext('C', 'major')).name, 4);
      // with other than twelve steps to the octave a key is one step: the key that is called C5 is not a C
      const label = (t) => (t.divisions ? (k) => `key ${k}` : noteName);
      const judge = (t) => {
        const r = chordPurity(t, pitches);
        const name = label(t);
        return { r, text: `${r.ratios ? `exactly ${r.ratios}, ` : ''}${r.worstBeatsHz < 0.05 ? 'beatless' : `fastest beat ${r.worstBeatsHz.toFixed(1)} per second`} — ${r.pairs.map((x) => `${name(x.low)}–${name(x.high)} ${x.ratio} ${Math.abs(x.offCents) < 0.05 ? 'pure' : `${sign(x.offCents)} c`}`).join(', ')}` };
      };
      const own = judge(tuning);
      purity = own.r;
      lines.push(`${a.chord || 'These notes'} (${tuning.divisions ? `the keys ${pitches.join(' ')} — in ${tuning.divisions} equal steps every key is one step, so these keys are not the notes a keyboard names them` : pitches.map(noteName).join(' ')}) in this tuning: ${own.text}`);
      for (const system of a.compare || []) {
        if (system === 'custom') continue;
        // (seen from the standard, the other systems are built on the song's key — where one would set them)
        const other = normalizeTuning({ system, root: a.root ?? (tuning.system === 'equal' && p ? p.key : tuning.root), a4: tuning.a4 });
        lines.push(`  in ${describeTuning(other)}: ${judge(other).text}`);
      }
      lines.push('A beat is the slow wobble between two harmonics that nearly coincide: 0 is a chord that stands still, 10 a second is the shimmer of an equal-tempered major third.');
    }
    return ok(lines.join('\n'), { tuning, table: tuningTable(tuning), ...(purity ? { chord: purity } : {}) });
  });
}
