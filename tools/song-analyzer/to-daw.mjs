#!/usr/bin/env node
// An analysis (tools/song-analyzer/analyze → analysis.json + midi/) into studio material:
//
//   <analysis>/study/blueprint.json          what is worth keeping and reusing: tempo, feel, key, form, chords, grooves,
//                                            bass rhythm, kinds of sound — no melody, no lyrics, no audio
//   <analysis>/study/preset-preview.gtd.json the project that blueprint opens as (File → Import project file)
//   <analysis>/study/study.gtd.json          the song's skeleton as transcribed: one channel per stem with its notes,
//                                            the sections as markers (private study material: it holds the melody)
//   <analysis>/study/study.md                the study card: what was found, how sure, what could not be determined
//
//   node tools/song-analyzer/to-daw.mjs <analysis dir> [--name "…"] [--key "A minor"] [--redo]
//   node tools/song-analyzer/to-daw.mjs <analysis dir> --save-template <id> [--label "Study: …"]
//
// The first form drafts the files (it keeps a blueprint.json you have edited unless --redo). The second saves the
// blueprint — as edited — into the repository as a template: packages/core/src/templates/studies/<id>.js, listed under
// "New from template", with its study card in docs/studies/<id>.md. See docs/song-studies.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEmptyProject, createChannel, createPattern, createClip, createMarker, createMixerInsert, normalizeProject, parseMidi,
  ticksPerBar, PPQ, MAX_PATTERN_BARS, createProjectFromBlueprint, playableChord, keyContext, readChord, numeralFor, INSTRUMENTS
} from '../../packages/core/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STUDIES_DIR = path.join(ROOT, 'packages/core/src/templates/studies');
const CARDS_DIR = path.join(ROOT, 'docs/studies');
const v = (o, ...keys) => keys.reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

// ---- the blueprint ------------------------------------------------------------------------------------------------

/** "C major" / "A minor" → { key, scale }. */
export function parseKey(text) {
  const m = /^([A-G][#b]?)\s*(major|minor|maj|min|m)?$/i.exec(String(text || '').trim());
  if (!m) return null;
  return { key: m[1][0].toUpperCase() + m[1].slice(1), scale: /^(minor|min|m)$/i.test(m[2] || '') ? 'minor' : 'major' };
}

/** The sections of the song with names a person would use: "Verse", "Verse 2" … and what plays in each. */
export function sectionsOf(A) {
  const secs = v(A, 'structure', 'sections', 'value') || [];
  const act = v(A, 'stems', 'activity_per_bar') || {};
  const seen = {};
  const share = (name, a, b) => {
    const row = (act[name] || []).slice(a, b);
    return row.length ? row.filter(Boolean).length / row.length : 0;
  };
  return secs.map((s, i) => {
    const label = cap(s.label || 'section');
    seen[label] = (seen[label] || 0) + 1;
    const [a, b] = [s.bar_start, s.bar_end];
    const play = [];
    if (share('drums', a, b) >= 0.5) play.push('drums');
    if (share('bass', a, b) >= 0.5) play.push('bass');
    if (['other', 'piano', 'guitar'].some((n) => share(n, a, b) >= 0.5)) play.push('chords');
    return {
      index: i, name: seen[label] > 1 ? `${label} ${seen[label]}` : label, letter: s.letter || String.fromCharCode(65 + i), barStart: a, bars: b - a,
      energy: s.energy_rel ?? null, play, vocals: share('vocals', a, b) >= 0.3
    };
  });
}

/** One bar of bass rhythm (16th steps) from the transcribed bass notes of a section: the steps hit in 40 % of its bars. */
function bassRhythm(notes, barStart, bars, barTicks) {
  const steps = Math.round(barTicks / (PPQ / 4));
  const hits = new Array(steps).fill(0);
  for (const n of notes) {
    const bar = Math.floor(n.start / barTicks);
    if (bar < barStart || bar >= barStart + bars) continue;
    hits[Math.min(steps - 1, Math.round((n.start % barTicks) / (PPQ / 4)) % steps)]++;
  }
  const need = Math.max(1, bars * 0.4);
  const out = hits.map((h) => (h >= need ? 'x' : '-')).join('');
  return out.includes('x') ? out : null;
}

function soundsOf(A) {
  const T = v(A, 'timbre', 'value') || {};
  const per = v(A, 'stems', 'per_stem') || {};
  const electronic = (v(A, 'instruments', 'electronic_vs_acoustic', 'value', 'electronic_share') ?? 0.5) >= 0.5;
  const kit = v(T, 'drums', 'kit', 'verdict') || '';
  const sounds = {
    kick: { kind: 'kick', preset: /808/.test(kit) ? 'Deep' : /acoustic/.test(kit) ? 'Punchy' : 'Hard' },
    snare: { kind: 'snare', preset: electronic ? 'Tight' : 'Fat' },
    hat: { kind: 'hat', preset: 'Closed' }
  };
  const bassBands = v(per, 'bass', 'bands') || {};
  if (!electronic) sounds.bass = { kind: 'bass', preset: 'Finger' };
  else if (/808/.test(kit)) sounds.bass = { kind: 'bass808', preset: 'Classic' };
  else sounds.bass = (bassBands.sub ?? 0) + (bassBands.low ?? 0) > 0.9 && (v(T, 'bass', 'spectral', 'centroid_hz') ?? 999) < 250
    ? { kind: 'synth', preset: 'Sub Bass' } : { kind: 'ggs', preset: 'Analog Bass' };
  // the harmony part: the loudest of the piano, guitar and "other" stems decides what it is played on
  const loud = (n) => (per[n] && !per[n].silent ? per[n].integrated_lufs ?? -99 : -99);
  const lead = ['piano', 'guitar', 'other'].sort((a, b) => loud(b) - loud(a))[0];
  const attack = v(T, lead, 'envelope', 'attack_ms') ?? 20;
  if (lead === 'piano' && loud('piano') > -40) sounds.chords = { kind: 'piano', preset: 'Grand' };
  else if (lead === 'guitar' && loud('guitar') > -40) sounds.chords = { kind: 'guitar', preset: electronic ? 'Clean Electric' : 'Acoustic' };
  else if (!electronic) sounds.chords = { kind: 'epiano', preset: 'Suitcase' };
  else sounds.chords = attack > 30 ? { kind: 'ggs', preset: 'Velvet Pad' } : { kind: 'synth', preset: 'Chord Stab' };
  for (const s of Object.values(sounds)) if (!INSTRUMENTS[s.kind]?.presets?.[s.preset]) delete s.preset;
  const wet = ['other', 'piano', 'guitar', 'vocals'].map((n) => v(T, n, 'reverb_estimate', 'amount')).filter(Boolean);
  const reverb = wet.some((w) => w !== 'dry') ? { decay: wet.some((w) => /wet/.test(w)) ? 3 : 2, send: wet.some((w) => /wet/.test(w)) ? 0.35 : 0.2 } : null;
  const pump = Object.values(T).some((t) => t?.pumping?.likely_sidechain);
  return { sounds, reverb, pump };
}

/** What can be trusted, by the method's own checks (docs/song-studies.md, "Before you state anything"). */
export function caveatsOf(A) {
  const out = [];
  const agree = v(A, 'rhythm', 'agreement') || {};
  const stab = v(A, 'rhythm', 'tempo_stability', 'value') || '';
  if ((agree.beat_this_vs_madmom_F ?? 1) < 0.9 || !/steady/.test(stab)) out.push(`Tempo: the trackers agree ${agree.beat_this_vs_madmom_F} and the tempo is "${stab}" — bars are approximate; check the half and double tempo.`);
  if ((agree.downbeat_phase_vote_share ?? 1) < 0.7 && !agree.downbeat_shift_beats) out.push(`Bar lines: the downbeat vote was only ${agree.downbeat_phase_vote_share} — if chords change mid-bar, re-run the analysis with --downbeat-shift 1…${(parseInt(v(A, 'rhythm', 'time_signature', 'value'), 10) || 4) - 1} (and --reuse-stems).`);
  const key = v(A, 'harmony', 'key') || {};
  if ((key.confidence ?? 1) < 0.75) out.push(`Key: only ${Math.round((key.confidence ?? 0) * 4)} of 4 estimators said ${key.value} — read the tonal centre (${v(A, 'harmony', 'tonal_centre', 'value', 'mode') || '?'}) and the relative key.`);
  const chords = v(A, 'harmony', 'chords_per_bar', 'value') || [];
  const unsure = chords.filter((c) => (c.confidence ?? 1) <= 0.4).length;
  if (chords.length && unsure / chords.length > 0.25) out.push(`Chords: ${unsure} of ${chords.length} bars are uncertain (marked ?) — trust the roots more than the qualities.`);
  out.push('Sections: the boundaries are measured, the names (verse, chorus…) are the model\'s guess — rename them by ear.');
  out.push('Drums: kick and hats are reliable, the snare row is not (soft or rim snares are missed or mistaken for kicks).');
  if (v(A, 'notes', 'other')) out.push('Notes of mixed parts ("other") are a sketch (reverb and leakage come out as notes); bass and melody lines are better.');
  for (const [stage, err] of Object.entries(v(A, 'run', 'errors') || {})) out.push(`Stage "${stage}" failed: ${err}`);
  return out;
}

export function blueprintFromAnalysis(A, tracks = {}, opts = {}) {
  const bpmRaw = v(A, 'rhythm', 'tempo_bpm', 'value') || 120;
  const bpm = Math.abs(bpmRaw - Math.round(bpmRaw)) < 0.15 ? Math.round(bpmRaw) : round(bpmRaw, 1);
  const ts = /^(\d+)\/(\d+)$/.exec(v(A, 'rhythm', 'time_signature', 'value') || '4/4') || [0, 4, 4];
  const timeSig = [Number(ts[1]), Number(ts[2])];
  const barTicks = (PPQ * 4 * timeSig[0]) / timeSig[1];
  const key = parseKey(opts.key) || parseKey(v(A, 'harmony', 'key', 'value')) || { key: 'C', scale: 'major' };
  const sw = v(A, 'rhythm', 'swing', 'value') || {};
  const swing = sw.level === '16th' && sw.ratio > 0.54 ? round(Math.min(1, (sw.ratio - 0.5) / 0.25)) : 0;
  const sections = sectionsOf(A);
  const chordsByBar = new Map((v(A, 'harmony', 'chords_per_bar', 'value') || []).map((c) => [c.bar, c]));
  const drumSecs = v(A, 'notes', 'drums', 'value', 'patterns_per_section') || [];
  const ctx = keyContext(key.key, key.scale);
  const parts = {};
  for (const s of sections) {
    if (parts[s.letter]) continue;
    const chords = [];
    for (let b = s.barStart + 1; b <= s.barStart + s.bars; b++) {
      const c = chordsByBar.get(b);
      chords.push(c ? `${c.chord}${(c.confidence ?? 1) <= 0.4 ? '?' : ''}` : 'N');
    }
    // a progression that repeats inside the section is written once
    let loop = chords;
    for (const len of [1, 2, 4, 8]) {
      if (chords.length > len && chords.length % len === 0 && chords.every((c, i) => c.replace('?', '') === chords[i % len].replace('?', ''))) { loop = chords.slice(0, len); break; }
    }
    const roman = loop.map((c) => {
      const sym = playableChord(c);
      try { return sym ? numeralFor(readChord(sym), ctx) : '?'; } catch { return '?'; }
    });
    const d = drumSecs[s.index]?.patterns || {};
    const drums = Object.fromEntries(['kick', 'snare', 'hat'].map((r) => [r, d[r]?.pattern || '']).filter(([, p]) => /x/.test(p)));
    parts[s.letter] = {
      chords: loop, roman, ...(Object.keys(drums).length ? { drums } : {}),
      ...(tracks.bass ? { bass: bassRhythm(tracks.bass, s.barStart, s.bars, barTicks) || undefined } : {})
    };
  }
  const { sounds, reverb, pump } = soundsOf(A);
  const file = v(A, 'signal', 'file', 'value') || {};
  return {
    version: 1, name: opts.name || `Study: ${String(file.file || 'song').replace(/\.[a-z0-9]+$/i, '')}`,
    bpm, timeSig, key: key.key, scale: key.scale, swing, sounds, reverb, pump,
    parts,
    sections: sections.map((s) => ({ name: s.name, letter: s.letter, bars: s.bars, play: s.play, energy: s.energy, ...(s.vocals ? { vocals: true } : {}) })),
    study: {
      duration_s: file.duration_s ?? v(A, 'run', 'audio_seconds'), tempo_bpm_measured: bpmRaw, tempo_stability: v(A, 'rhythm', 'tempo_stability', 'value'),
      feel: sw.feel, key_confidence: v(A, 'harmony', 'key', 'confidence'), tonal_centre: v(A, 'harmony', 'tonal_centre', 'value', 'mode'),
      loudness: v(A, 'signal', 'loudness', 'value'), true_peak_dbtp: v(A, 'signal', 'levels', 'value', 'true_peak_dbtp'),
      bands: Object.fromEntries(Object.entries(v(A, 'signal', 'spectral_balance', 'value', 'bands') || {}).map(([k, b]) => [k, b.share])),
      stereo_width: v(A, 'signal', 'stereo', 'value', 'width'),
      instruments: (v(A, 'instruments', 'mix', 'value') || []).filter((r) => r.share_of_song >= 0.2).map((r) => r.label).slice(0, 8),
      stems: Object.fromEntries(Object.entries(v(A, 'stems', 'per_stem') || {}).filter(([, s]) => !s.silent).map(([n, s]) => [n, {
        lufs: s.integrated_lufs, pan: s.pan, width: v(s, 'stereo', 'width'), hint: v(A, 'timbre', 'value', n, 'synth_hint') || null,
        reverb: v(A, 'timbre', 'value', n, 'reverb_estimate', 'amount') || null, sidechain: !!v(A, 'timbre', 'value', n, 'pumping', 'likely_sidechain')
      }])),
      caveats: caveatsOf(A)
    }
  };
}

// ---- the transcription project -----------------------------------------------------------------------------------

const DRUM_KEYS = { 36: 'Kick', 38: 'Snare', 42: 'Hat' };
const PART_SOUND = { vocals: { name: 'Melody (vocal)', kind: 'ggs', preset: 'Touch Lead' }, piano: { name: 'Piano', kind: 'piano', preset: 'Grand' }, guitar: { name: 'Guitar', kind: 'guitar', preset: 'Clean Electric' } };

/** The song's skeleton as transcribed: a channel per stem (drums split in three), a pattern per section and stem. */
export function studyProject(A, tracks, bp) {
  const p = createEmptyProject({ name: bp.name.replace(/^Study: /, 'Study (transcription): '), bpm: bp.bpm, key: bp.key, scale: bp.scale });
  p.timeSig = bp.timeSig;
  const bar = ticksPerBar(p);
  const parts = []; // { name, kind, preset, notes }
  if (tracks.drums) {
    for (const [key, name] of Object.entries(DRUM_KEYS)) {
      const notes = tracks.drums.filter((n) => n.key === Number(key));
      if (notes.length) parts.push({ name, ...bp.sounds[name.toLowerCase()], notes, drum: true });
    }
  }
  if (tracks.bass?.length) parts.push({ name: 'Bass', ...bp.sounds.bass, notes: tracks.bass });
  for (const stem of ['other', 'piano', 'guitar', 'vocals']) {
    if (!tracks[stem]?.length) continue;
    parts.push({ ...(PART_SOUND[stem] || { name: 'Harmony (other)', ...bp.sounds.chords }), notes: tracks[stem] });
  }
  while (p.mixer.length <= parts.length) p.mixer.push(createMixerInsert(p.mixer.length));
  const sections = sectionsOf(A);
  const spans = sections.length ? sections : [{ name: 'Song', barStart: 0, bars: Math.ceil(Math.max(1, ...parts.flatMap((x) => x.notes.map((n) => n.start + n.length))) / bar) }];
  parts.forEach((part, i) => {
    const ch = createChannel({ name: part.name, kind: part.kind, preset: part.preset, mixerTrack: i + 1 });
    p.channels.push(ch);
    p.mixer[i + 1].name = part.name;
    p.playlist.tracks[i].name = part.name;
    for (const s of spans) {
      // (a pattern holds 64 bars at most: a longer section is cut in pieces)
      for (let off = 0; off < s.bars; off += MAX_PATTERN_BARS) {
        const len = Math.min(MAX_PATTERN_BARS, s.bars - off);
        const from = (s.barStart + off) * bar;
        const to = from + len * bar;
        const notes = part.notes.filter((n) => n.start >= from && n.start < to).map((n) => ({
          key: part.drum ? ch.rootKey : n.key, start: n.start - from, length: Math.max(6, Math.min(n.length, to - n.start)), velocity: round(n.velocity ?? 0.8)
        }));
        if (!notes.length) continue;
        const pt = createPattern({ name: `${part.name} — ${s.name}${off ? ` (${off / MAX_PATTERN_BARS + 1})` : ''}`, length: len * bar });
        pt.notes[ch.id] = notes;
        p.patterns.push(pt);
        p.playlist.clips.push(createClip({ kind: 'pattern', refId: pt.id, track: i, start: from, length: len * bar }));
      }
    }
  });
  p.markers = sections.map((s) => createMarker({ tick: s.barStart * bar, name: s.name }));
  if (!p.patterns.length) p.patterns = [createPattern({ name: 'Pattern 1' })];
  return normalizeProject(p);
}

// ---- the study card -----------------------------------------------------------------------------------------------

export function studyCard(A, bp) {
  const s = bp.study;
  const lines = [`# ${bp.name}`, '', v(A, 'summary', 'paragraph') || '', ''];
  lines.push(`| | |`, `|---|---|`,
    `| Tempo | ${bp.bpm} BPM (measured ${s.tempo_bpm_measured}; ${s.tempo_stability || '?'}${s.feel ? `, ${s.feel} feel` : ''}) |`,
    `| Meter | ${bp.timeSig.join('/')} |`,
    `| Key | ${bp.key} ${bp.scale} (confidence ${s.key_confidence ?? '?'}${s.tonal_centre ? `; tonal centre ${s.tonal_centre}` : ''}) |`,
    `| Loudness | ${s.loudness?.integrated_lufs} LUFS integrated, range ${s.loudness?.loudness_range_lu} LU, true peak ${s.true_peak_dbtp} dBTP |`,
    `| Frequency balance | ${Object.entries(s.bands || {}).map(([k, x]) => `${k} ${Math.round(x * 100)}%`).join(', ')} |`,
    `| Heard | ${(s.instruments || []).join(', ') || 'unclear'} |`, '');
  lines.push('## Form', '', '| Section | Bars | Plays | Chords | In the key | Energy |', '|---|---|---|---|---|---|');
  let bar = 1;
  for (const sec of bp.sections) {
    const part = bp.parts[sec.letter] || {};
    lines.push(`| ${sec.name} (${sec.letter}) | ${bar}–${bar + sec.bars - 1} | ${[...sec.play, ...(sec.vocals ? ['vocals'] : [])].join(', ') || '—'} | ${(part.chords || []).join(' · ')} | ${(part.roman || []).join(' · ')} | ${sec.energy ?? ''} |`);
    bar += sec.bars;
  }
  lines.push('', '## Grooves', '');
  for (const [L, part] of Object.entries(bp.parts)) {
    if (!part.drums && !part.bass) continue;
    lines.push(`**${L}**`, '', '```', ...Object.entries(part.drums || {}).map(([r, pat]) => `${r.padEnd(6)}${pat}`), ...(part.bass ? [`bass  ${part.bass}`] : []), '```', '');
  }
  lines.push('## Sounds and mix', '', '| Stem | Level | Pan / width | Reverb | Ducks with the kick | Rebuild hint |', '|---|---|---|---|---|---|');
  for (const [n, st] of Object.entries(s.stems || {})) lines.push(`| ${n} | ${st.lufs} LUFS | ${st.pan} / ${st.width} | ${st.reverb || '—'} | ${st.sidechain ? 'yes' : 'no'} | ${st.hint || '—'} |`);
  lines.push('', `Preset sounds chosen: ${Object.entries(bp.sounds).map(([r, x]) => `${r} → ${x.kind}${x.preset ? ` "${x.preset}"` : ''}`).join('; ')}${bp.reverb ? `; shared reverb (decay ${bp.reverb.decay} s)` : ''}${bp.pump ? '; kick-triggered pump on bass and chords' : ''}.`);
  lines.push('', '## What to trust', '', ...s.caveats.map((c) => `- ${c}`), '');
  return lines.join('\n');
}

// ---- command line -------------------------------------------------------------------------------------------------

function saveTemplate(dir, id, label) {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(id)) throw new Error(`A template id is lower case letters, digits and "_" (e.g. midnight_drive), not "${id}"`);
  const file = path.join(dir, 'study', 'blueprint.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found: run to-daw.mjs on the analysis first`);
  const bp = JSON.parse(fs.readFileSync(file, 'utf8'));
  createProjectFromBlueprint(bp); // (a blueprint that doesn't build is not saved)
  // the template keeps the music, not the measurements
  const { study: _study, ...keep } = bp;
  const text = `// A song study saved as a template by tools/song-analyzer/to-daw.mjs (docs/song-studies.md): the form, chords,
// grooves and kinds of sound of a song — not its melody, lyrics or audio.
import { specFromBlueprint } from '../blueprint.js';

const BLUEPRINT = ${JSON.stringify(keep, null, 2)};

export default { label: ${JSON.stringify(label || bp.name)}, spec: () => specFromBlueprint(BLUEPRINT) };
`;
  fs.mkdirSync(STUDIES_DIR, { recursive: true });
  fs.writeFileSync(path.join(STUDIES_DIR, `${id}.js`), text);
  const ids = fs.readdirSync(STUDIES_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js').map((f) => f.slice(0, -3)).sort();
  fs.writeFileSync(path.join(STUDIES_DIR, 'index.js'), `// Song studies saved as templates ("New from template" → Study: …). Written by tools/song-analyzer/to-daw.mjs
// --save-template <id>: one file per study next to this one, and this list regenerated from the folder. See
// docs/song-studies.md.
${ids.map((x) => `import ${x} from './${x}.js';`).join('\n')}

export const STUDIES = { ${ids.join(', ')} };
`);
  // the study card goes with it: what was learned from the song, for people and for later sessions
  const card = path.join(dir, 'study', 'study.md');
  if (fs.existsSync(card)) {
    fs.mkdirSync(CARDS_DIR, { recursive: true });
    fs.copyFileSync(card, path.join(CARDS_DIR, `${id}.md`));
  }
  return path.join(STUDIES_DIR, `${id}.js`);
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const has = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const [name, key, save, label] = [flag('--name'), flag('--key'), flag('--save-template'), flag('--label')];
  const redo = has('--redo');
  const dir = args[0] && path.resolve(args[0]);
  if (!dir || !fs.existsSync(path.join(dir, 'analysis.json'))) {
    console.error('usage: node tools/song-analyzer/to-daw.mjs <analysis dir> [--name "…"] [--key "A minor"] [--redo] | --save-template <id> [--label "…"]');
    process.exit(1);
  }
  if (save) {
    console.log(`saved ${path.relative(ROOT, saveTemplate(dir, save, label))} and docs/studies/${save}.md — the template is listed under "New from template"; run npm run lint && npm test, then commit.`);
    return;
  }
  const A = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
  const tracks = {};
  const midi = path.join(dir, 'midi', 'all.mid');
  if (fs.existsSync(midi)) for (const t of parseMidi(fs.readFileSync(midi)).tracks) if (t.notes.length) tracks[t.name] = t.notes;
  const out = path.join(dir, 'study');
  fs.mkdirSync(out, { recursive: true });
  const bpFile = path.join(out, 'blueprint.json');
  let bp;
  if (fs.existsSync(bpFile) && !redo) {
    bp = JSON.parse(fs.readFileSync(bpFile, 'utf8'));
    console.log('kept the existing blueprint.json (edited by hand?); --redo drafts it again from the analysis');
  } else {
    bp = blueprintFromAnalysis(A, tracks, { name, key });
    fs.writeFileSync(bpFile, `${JSON.stringify(bp, null, 1)}\n`);
  }
  fs.writeFileSync(path.join(out, 'preset-preview.gtd.json'), `${JSON.stringify(createProjectFromBlueprint(bp), null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'study.gtd.json'), `${JSON.stringify(studyProject(A, tracks, bp), null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'study.md'), studyCard(A, bp));
  console.log(`${path.relative(process.cwd(), out)}: blueprint.json, preset-preview.gtd.json, study.gtd.json, study.md`);
  for (const c of bp.study?.caveats || []) console.log(`  ! ${c}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
