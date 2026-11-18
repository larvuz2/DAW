// The chord grid for Claude: the same palette the Harmony window's Grid tab shows (Tuple's engine,
// packages/chord-grid) — every chord of the key, the borrowed ones, what could follow — and a way to write a
// progression of them with its voicing, voice leading, tensions, strum and humanize.
import { createChordGrid, gridScaleFor, gridScales, VOICINGS, LEADING, TENSIONS, SMART_KINDS, STRUM_CURVES, STRUM_MAX, TUPLE_SOURCE, notesInTicks } from '@ggs/chord-grid';
import { PPQ, STEP, ticksPerBar, uid, findChannel, findPattern, parsePitchClass, scaleSpelling, spelledNoteName, requireScale, SCALES, SCALE_INFO, didYouMean } from '@ggs/core';
import { z, ok, projectIdArg, annotations as A, growPatternOp, assertFitsPattern, normVelocity } from '../util.js';

const VOICING_IDS = VOICINGS.map((v) => v.id);
const LEADING_IDS = LEADING.map((v) => v.id);
const CURVES = STRUM_CURVES.map((c) => c.toLowerCase());
const MAX_BARS = 32;
const NAMES = 'the grid\'s chord names, as chord_grid lists them (Dm9, CM7, G7, Bø7, Eb, Db7, FM13); usual spellings are understood (Cmaj7, Bm7b5, C69)';
const dots = (level) => '●'.repeat(level) + '○'.repeat(3 - level);
const outside = (pt, channelId, lo, hi) => (pt.notes[channelId] || []).filter((n) => n.start < lo || n.start >= hi);

/** A grid in a project's key (or the key given): { grid, key, scale, exact, spell, label }. */
function gridIn(keyName, scaleId, options = {}) {
  const root = parsePitchClass(keyName);
  if (root === null) throw new Error(`"${keyName}" is not a key: use a note name such as C, F#, Bb`);
  const { id, exact } = gridScaleFor(SCALES[scaleId]);
  const spell = scaleSpelling(keyName, scaleId);
  const grid = createChordGrid({ root, scale: id, spell, ...options });
  // (scale names as the studio writes them everywhere else: lower case)
  const shown = gridScales().find((s) => s.id === id).label.toLowerCase();
  return { grid, exact, spell, label: `${grid.view().key.name} ${exact ? SCALE_INFO[scaleId]?.label || shown : shown}`, asked: SCALE_INFO[scaleId]?.label || scaleId, shown };
}

/** Every chord name the grid knows now (for "did you mean"). */
const allNames = (grid) => {
  const cat = grid.catalog();
  return [...new Set([...cat.columns.flatMap((c) => c.cells), ...cat.borrowed, ...cat.mediants, ...cat.tritoneAll, ...cat.ext.flatMap((e) => e.cells)].map((c) => c.label))];
};

/** The cell a name stands for, or an error that says what the key offers instead. */
function cellFor(grid, name, label) {
  const found = grid.find(name);
  if (found) return found;
  const cols = grid.view().columns.filter((c) => c.cells.length).map((c) => c.cells[0].label).join(' ');
  throw new Error(`"${name}" is not a chord the grid can spell in ${label}.${didYouMean(name, allNames(grid))} It reads a root and a quality — triads, 6, 7, M7, m7, ø7, dim7, sus2/sus4, add9, 9, 11, 13 and their alterations (7b9, 7#11, M7#5…). The key's own chords are built on ${cols}; chord_grid lists them all. For anything else (power chords, slash chords, clusters) use add_chords or add_notes.`);
}

export function registerChordGridTools({ tool, backend, load }) {
  /** The key a call works in: its own `key`/`scale`, else the project's. */
  async function keyOf(a) {
    let p = null;
    try { p = await load(a.projectId); } catch (e) { if (a.projectId || !(a.key && a.scale)) throw e; }
    return { p, key: a.key || p?.key || 'C', scale: requireScale(a.scale || p?.scale || 'major') };
  }

  tool('chord_grid', {
    title: 'Chord grid: every chord of the key, borrowed chords, what could follow',
    description: `The chord palette of a key (the project's, unless key/scale are given) — the same grid as the Harmony window's Grid tab, from Tuple's chord engine. Read it before writing harmony: it is where sevenths, ninths, sixths, sus chords, borrowed chords, secondary dominants, tritone substitutes and 11th/13th extensions come from, so a progression is more than plain triads.
- Without arguments: per degree, every chord the scale has there (triad, 7th, 9th, sus, add9, 6, 6/9…); the borrowed column (modal interchange and secondary dominants), chromatic mediants, a tritone substitute for each dominant, and richer forms of each degree (Ext: 13ths, 11ths, added notes).
- after: [chords played so far] adds where the progression could go next, strongest first (by harmonic function, or smart: "voiceleading" for the smoothest moves).
- chord: "G7" explains one chord: its notes in each voicing, the tensions it takes (b9 9 #9 11 #11 b13 13) and the ones it avoids with the reason, what could stand in for it, and what could follow it.
Nothing here changes the project. Write chords from the grid with add_grid_chords. Chord names: ${NAMES}.`,
    inputSchema: {
      projectId: projectIdArg,
      key: z.string().max(3).optional().describe('Key root, e.g. "A", "F#" (default: the project key)'),
      scale: z.string().max(40).optional().describe('Scale or mode (default: the project scale). The grid knows 30: major, minor, the modes, harmonic and melodic minor and their modes, harmonic major and its modes, both pentatonics; another scale shows the closest of these'),
      after: z.array(z.string().max(32)).max(32).optional().describe(`Chords already played, in order: the reply adds what could follow them. ${NAMES}`),
      chord: z.string().max(32).optional().describe('One chord to explain: voicings, tensions, substitutes, what follows'),
      smart: z.enum(['function', 'voiceleading']).optional().describe('How "what could follow" is ranked: by harmonic function (default) or by the smoothest voice leading'),
      extended: z.boolean().optional().describe('true = the borrowed column in its richer forms (9ths, 13ths, #11 on tritone substitutes)')
    },
    annotations: A.readOnly
  }, async (a) => {
    const { key, scale } = await keyOf(a);
    const { grid, exact, spell, label, asked, shown } = gridIn(key, scale);
    grid.set({ smart: a.smart || 'function', extended: !!a.extended, leading: 'follow' });
    const note = exact ? '' : `\nThe grid has no chords for ${asked}: this is ${shown}, the closest scale it knows.`;
    const names = (notes) => notes.map((n) => spelledNoteName(n, spell)).join(' ');
    const played = (a.after || []).map((name) => cellFor(grid, name, label));
    for (const c of played) { grid.press(c.cell); grid.release(); }

    if (a.chord) {
      const c = cellFor(grid, a.chord, label);
      const what = { borrowed: `borrowed (${c.roman})`, mediants: `chromatic mediant (${c.roman})`, tritone: `tritone substitute (${c.roman})`, ext: `an extension of ${c.roman}`, chromatic: `${c.roman}, from outside the grid: no page of it offers this chord in this key, but it is voiced like any other` }[c.group] || `${c.group}, in the key`;
      const lines = [`${c.label} in ${label}: ${what}.${note}`];
      lines.push('Voicings (add_grid_chords voicing):');
      for (const v of VOICINGS) {
        grid.set({ voicing: v.id });
        lines.push(`  ${v.id.padEnd(9)} ${names(grid.preview(c.cell)).padEnd(26)} ${v.label} — ${v.about}`);
      }
      grid.set({ voicing: 'classic' });
      const { index } = grid.add(c.cell);
      const card = grid.view().progression.cards[index];
      const takes = card.offer.filter((o) => o.state === 'off').map((o) => `${o.name}${o.inScale ? '' : ' (outside the scale)'}`);
      const has = card.offer.filter((o) => o.state === 'built').map((o) => o.name);
      const avoids = card.offer.filter((o) => o.state === 'avoid').map((o) => `${o.name} (${o.why})`);
      lines.push(`Tensions it takes: ${takes.join(', ') || 'none'}.${has.length ? ` Already in the chord: ${has.join(', ')}.` : ''}${avoids.length ? ` Avoided: ${avoids.join('; ')}.` : ''}`);
      const subs = grid.options(index, 'subs');
      if (subs.length) lines.push(`Instead of it: ${subs.map((o) => `${o.name}${o.roman && o.roman !== '·' ? ` (${o.roman})` : ''}`).join(', ')}.`);
      const next = grid.options(index, 'next');
      if (next.length) lines.push(`After it: ${next.map((o) => `${o.name} ${dots(o.level || 1)}`).join(', ')}.`);
      return ok(lines.join('\n'), { chord: c.label, id: c.id, roman: c.roman, group: c.group, tensions: card.offer, substitutes: subs.map((o) => o.name), next: next.map((o) => ({ chord: o.name, level: o.level })) });
    }

    const cat = grid.catalog();
    const lines = [`Chord grid of ${label} (engine: ${TUPLE_SOURCE.name} ${TUPLE_SOURCE.version}). M7 = major seventh, ø7 = half-diminished, mMaj7 = minor with a major seventh.${note}`, 'In the key:'];
    for (const col of cat.columns) if (col.cells.length) lines.push(`  ${col.roman.padEnd(5)} ${col.name.padEnd(13)} ${col.cells.map((c) => c.label).join('  ')}`);
    const row = (cells, f = (c) => `${c.label} ${c.roman}`) => cells.map(f).join(' · ');
    if (cat.borrowed.length) lines.push(`Borrowed (modal interchange, secondary dominants${a.extended ? ', richer forms' : ''}): ${row(cat.borrowed)}`);
    if (cat.mediants.length) lines.push(`Chromatic mediants: ${row(cat.mediants)}`);
    if (cat.tritoneAll.length) lines.push(`Tritone substitutes (a dominant a semitone above where it lands): ${row(cat.tritoneAll, (c) => `${c.label} → ${c.target}`)}`);
    const ext = cat.ext.filter((e) => e.cells.length);
    if (ext.length) {
      lines.push('Richer forms of each degree (Ext):');
      for (const e of ext) lines.push(`  ${e.roman.padEnd(5)} ${e.cells.map((c) => c.label).join('  ')}`);
    }
    let next = [];
    if (played.length) {
      // the suggestions of the borrowed column are per page: read each
      const seen = new Map();
      const take = (cells) => { for (const c of cells) if (c.smart && !seen.has(c.id)) seen.set(c.id, c); };
      take(grid.view().columns.flatMap((c) => c.cells.map((x) => ({ ...x, roman: c.roman }))));
      for (const page of grid.view().borrowed.pages) { grid.setBorrowedPage(page); take(grid.view().borrowed.cells); }
      next = [...seen.values()].sort((x, y) => y.smart.level - x.smart.level || y.smart.score - x.smart.score);
      lines.push(`After ${played.map((c) => c.label).join(' – ')}, ${a.smart === 'voiceleading' ? 'smoothest first' : 'strongest first'}:`);
      for (const c of next) lines.push(`  ${dots(c.smart.level)} ${c.label.padEnd(9)} ${String(c.roman || '').padEnd(9)} ${SMART_KINDS[c.smart.kind] || c.smart.kind}`);
      if (!next.length) lines.push('  (nothing stands out: any chord of the key will do)');
    }
    lines.push(`Write them with add_grid_chords (voicing, voice leading, tensions per chord, strum, humanize); chord: "<name>" here explains one chord. A chord that is not listed can still be named (E7 in A minor, Cm7 in C major): the grid spells and voices it. The user sees the same grid in Harmony → Grid.`);
    return ok(lines.join('\n'), {
      key, scale, gridScale: grid.view().key.scale, exact,
      columns: cat.columns.map((c) => ({ roman: c.roman, name: c.name, chords: c.cells.map((x) => x.label) })),
      borrowed: cat.borrowed.map((c) => ({ chord: c.label, roman: c.roman })), mediants: cat.mediants.map((c) => ({ chord: c.label, roman: c.roman })),
      tritone: cat.tritoneAll.map((c) => ({ chord: c.label, to: c.target })), ext: ext.map((e) => ({ roman: e.roman, chords: e.cells.map((c) => c.label) })),
      next: next.map((c) => ({ chord: c.label, roman: c.roman || null, level: c.smart.level, kind: c.smart.kind }))
    });
  });

  const chordArg = z.union([
    z.string().max(32),
    z.strictObject({
      chord: z.string().max(32).describe(`The chord: ${NAMES}; "-" = a rest`),
      bars: z.number().min(0.125).max(16).optional().describe('Length of this chord in bars (default barsPerChord); eighths of a bar: 0.5 = half a bar, 0.25 = a beat in 4/4'),
      tensions: z.array(z.enum(TENSIONS)).max(4).optional().describe('Colours stacked on top of the chord: b9 9 #9 11 #11 b13 13 (chord_grid chord="…" says which it takes). G7 + 13 = G13, G7 + b9 + 13 = G13b9'),
      voicing: z.enum(VOICING_IDS).optional().describe('This chord in another voicing than the rest'),
      inversion: z.number().int().min(-6).max(6).optional().describe('Turn this chord over: 1 = its lowest note an octave up, −1 = its highest an octave down (it then stays where you put it)'),
      octave: z.number().int().min(-2).max(2).optional().describe('This chord an octave (or two) higher or lower than the rest')
    })
  ]);

  tool('add_grid_chords', {
    title: 'Add chords from the chord grid',
    description: `Write a progression of chords from the chord grid (chord_grid) into a channel, voiced by the grid's engine: one voicing style for the part, each chord led from the one before, tensions stacked on top where asked, optionally strummed and humanized. Use it for keys, pads, guitars and any chordal part that should sound played, not stamped — rootless or drop-2 voicings over a bassline, 9ths and 13ths, borrowed chords and tritone substitutes.
Chords are ${NAMES}; a chord the key's grid does not list is spelled from its name all the same (E7 in A minor); "-" is a rest. A chord is a name, or { chord, bars, tensions, voicing, inversion, octave }. The chords follow each other from startBar; bars are the song's own (a bar of 3/4 is three beats). At most ${MAX_BARS} bars a call, six notes a chord.
Voicings: ${VOICINGS.map((v) => `${v.id} (${v.label}: ${v.about})`).join('; ')}.
For slash chords and power chords, or styles like arpeggios and rhythm patterns, use add_chords.`,
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      chords: z.array(chordArg).min(1).max(128).describe('The progression, in order'),
      barsPerChord: z.number().min(0.125).max(16).optional().describe('Length of each chord in bars (default 1); eighths of a bar: 0.5 = two chords a bar'),
      startBar: z.number().int().min(1).max(64).optional().describe('Bar of the pattern the first chord starts on (1-based, default 1)'),
      voicing: z.enum(VOICING_IDS).optional().describe('How the notes are spread (default classic = closed). rootless for keys over a bass (it plays the 9th where the root was), drop2 for a section sound, open for pads, piano for two hands'),
      leading: z.enum(LEADING_IDS).optional().describe('Voice leading: follow (default) = each chord moves as little as possible from the one before; anchor = every chord around the same register, the same chord always the same; off = each on its own'),
      octave: z.number().int().min(-2).max(2).optional().describe('Register, in octaves from the default (around C3–C5)'),
      extended: z.boolean().optional().describe('true = borrowed chords in their richer forms (9ths, 13ths; #11 on tritone substitutes)'),
      avoidNotes: z.boolean().optional().describe('false = allow tensions the grid holds back as avoid notes (the 11th on a major chord, say). Default true'),
      strum: z.number().int().min(-STRUM_MAX).max(STRUM_MAX).optional().describe('Milliseconds between the notes of each chord: positive = low to high, negative = high to low; 15–40 = a hand on keys or guitar, above 60 = a slow arpeggio. Default 0 (together)'),
      strumRamp: z.number().int().min(-100).max(100).optional().describe('Velocity along the strum, in percent: positive = crescendo, negative = the first note loudest'),
      strumCurve: z.enum(CURVES).optional().describe('How the strum is spaced: linear (default), accel (speeding up), decel (slowing down)'),
      humanize: z.number().int().min(0).max(100).optional().describe('Small differences in velocity and timing between notes, in percent (10–25 = a player; default 0). The same call writes the same notes again'),
      velocity: z.union([z.number(), z.string()]).optional().describe('How hard the chords are played, 0–1 (default 0.79)'),
      replace: z.boolean().optional().describe('true (default) = the chords replace what the channel had in those bars; false = they are added to it')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const scale = requireScale(p.scale || 'major');
    const { grid, exact, spell, label, asked, shown } = gridIn(p.key || 'C', scale, { bpm: p.bpm, seed: `${p.id}:${pt.id}:${ch.id}` });
    grid.set({
      voicing: a.voicing || 'classic', leading: a.leading || 'follow', octave: a.octave ?? 0, extended: !!a.extended, avoidNotes: a.avoidNotes !== false,
      strum: a.strum ?? 0, strumRamp: a.strumRamp ?? 0, strumCurve: a.strumCurve ? CURVES.indexOf(a.strumCurve) : 0, humanize: a.humanize ?? 0
    });
    const each = a.barsPerChord ?? 1;
    const eighths = (bars, what) => { if (Math.abs(bars * 8 - Math.round(bars * 8)) > 1e-9) throw new Error(`${what} is ${bars} bars: lengths are in eighths of a bar (0.125, 0.25, 0.5, 0.75, 1, 1.5 …)`); return bars; };
    eighths(each, 'barsPerChord');
    // everything is worked out on the grid first: a chord it does not have, or a tension a chord does not take, stops
    // the call before the project is touched
    let at = 0;
    const written = [];
    for (const [i, item] of a.chords.entries()) {
      const c = typeof item === 'string' ? { chord: item } : item;
      const bars = eighths(c.bars ?? each, `The length of chord ${i + 1} ("${c.chord}")`);
      if (at + bars > MAX_BARS + 1e-9) throw new Error(`Chord ${i + 1} ("${c.chord}") would end after bar ${MAX_BARS}: one call writes at most ${MAX_BARS} bars. Write the rest with another call (startBar: ${(a.startBar ?? 1) + Math.floor(at)}).`);
      if (c.chord === '-' || c.chord === '_' || c.chord === '') { at += bars; continue; }
      const cell = cellFor(grid, c.chord, label);
      // The rootless voicing plays the natural 9th where the root was — and the engine would stack an altered ninth on
      // top of it all the same: both at once is a cluster nobody asked for.
      const clash = (c.voicing || a.voicing) === 'rootless' && (c.tensions || []).find((t) => t === 'b9' || t === '#9');
      if (clash) throw new Error(`Chord ${i + 1}: ${cell.label} with the tension ${clash} in the rootless voicing would sound its natural 9th and the ${clash} together (rootless puts the 9th where the root was). Give this chord another voicing — { chord: "${cell.label}", tensions: [...], voicing: "drop2" } — or use the tensions 9 and 13.`);
      const { index, refused } = grid.add(cell.cell, { at, bars, tensions: c.tensions || [], voicing: c.voicing || null, inversion: c.inversion || null, octave: c.octave || null });
      // (a card that could not go exactly where it was asked would be written somewhere else: that is "no room" too)
      if (index < 0 || Math.abs(grid.view().progression.cards[index].start - at) > 1e-9) throw new Error(`The grid's track has no room for chord ${i + 1} ("${c.chord}") at bar ${at + 1}.`);
      if (refused.length) {
        const r = refused[0];
        const why = r.state === 'avoid' ? `the grid avoids it: ${r.why}. Leave it out, choose another, or pass avoidNotes: false to have it anyway` : r.state === 'none' ? 'the chord has no such note to add' : 'it does not fit this voicing';
        throw new Error(`Chord ${i + 1}: ${cell.label} does not take the tension ${r.tension} — ${why}. chord_grid chord="${cell.label}" lists the tensions it takes.`);
      }
      written.push(index);
      at += bars;
    }
    const cards = grid.view().progression.cards;
    if (!cards.length) throw new Error('chords has only rests: give at least one chord');
    const bar = ticksPerBar(p);
    const lo = ((a.startBar ?? 1) - 1) * bar;
    const hi = lo + Math.round(at * bar);
    assertFitsPattern(p, pt, hi);
    const gain = normVelocity(a.velocity, 100 / 127) / (100 / 127);
    const notes = notesInTicks(grid.notes(), { barTicks: bar, beatTicks: PPQ }).map((n) => ({ id: uid('n'), key: n.key, start: lo + n.start, length: n.length, velocity: Math.max(0.01, Math.min(1, Math.round(n.velocity * gain * 1000) / 1000)) }));
    const ops = [a.replace === false
      ? { type: 'notes/add', patternId: pt.id, channelId: ch.id, notes }
      : { type: 'notes/set', patternId: pt.id, channelId: ch.id, notes: [...outside(pt, ch.id, lo, hi), ...notes] }];
    const grow = growPatternOp(p, pt, hi);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    const names = (ns) => ns.map((n) => spelledNoteName(n, spell)).join(' ');
    const style = VOICINGS.find((v) => v.id === (a.voicing || 'classic'));
    const how = [`${style.label.toLowerCase()} voicing`, `voice leading ${a.leading || 'follow'}`, a.strum ? `strummed ${Math.abs(a.strum)} ms ${a.strum > 0 ? 'upward' : 'downward'}` : null, a.humanize ? `humanized ${a.humanize}%` : null].filter(Boolean).join(', ');
    const lines = [`Wrote ${cards.map((c) => c.name).join(' – ')} (${cards.map((c) => c.roman).join(' – ')}) to "${ch.name}" in "${pt.name}", bars ${a.startBar ?? 1}–${(a.startBar ?? 1) + Math.ceil(at - 1e-9) - 1}: ${notes.length} notes, ${how}.${exact ? '' : ` The grid has no ${asked}: it used ${shown}.`}`];
    for (const c of cards) lines.push(`  bar ${Math.round((c.start + (a.startBar ?? 1)) * 1000) / 1000}${c.bars === 1 ? '' : ` (${c.bars} bars)`}: ${c.name.padEnd(10)} ${names(c.notes)}`);
    return ok(lines.join('\n'), { chords: cards.map((c) => ({ chord: c.name, roman: c.roman, bar: c.start + (a.startBar ?? 1), bars: c.bars, notes: c.notes, tensions: c.tensions })), steps: [lo / STEP, hi / STEP] });
  });
}
