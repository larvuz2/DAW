// Song studies (tools/song-analyzer/to-daw.mjs, core templates/blueprint.js): an analysis becomes a blueprint (form,
// chords, grooves, sounds — no melody), the blueprint a template project, and the transcription a study project;
// what the method says not to trust is said in the caveats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PPQ, normalizeProject, createProjectFromBlueprint, specFromBlueprint, playableChord, TEMPLATES } from '@greanteadawy/core';
import { blueprintFromAnalysis, studyProject, studyCard, parseKey, caveatsOf, sectionsOf } from '../../tools/song-analyzer/to-daw.mjs';

const BAR = PPQ * 4;
const item = (value, confidence = 0.9) => ({ value, confidence, source: 'test' });
/** A small analysis the way the analyzer writes it: 8 bars, an intro (pad only) and a drop (everything). */
function analysis(over = {}) {
  const chords = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'].map((chord, i) => ({ bar: i + 1, chord, confidence: i === 5 ? 0.3 : 0.8 }));
  return {
    signal: { file: item({ file: 'my song.mp3', duration_s: 16 }), loudness: item({ integrated_lufs: -9.5, loudness_range_lu: 5 }), levels: item({ true_peak_dbtp: -0.4 }),
      spectral_balance: item({ bands: { sub: { share: 0.2 }, low: { share: 0.5 }, mid: { share: 0.3 } } }), stereo: item({ width: 0.4 }) },
    rhythm: { tempo_bpm: item(119.96), time_signature: item('4/4'), tempo_stability: item('steady (click-tracked or quantized)'),
      swing: item({ level: '16th', ratio: 0.6, feel: 'light swing' }), agreement: { beat_this_vs_madmom_F: 0.98, downbeat_phase_vote_share: 0.9 } },
    harmony: { key: item('A minor', 0.75), tonal_centre: item({ mode: 'A aeolian' }), chords_per_bar: item(chords) },
    structure: { sections: item([
      { label: 'intro', letter: 'A', bar_start: 0, bar_end: 4, bars: 4, energy_rel: -6 },
      { label: 'chorus', letter: 'B', bar_start: 4, bar_end: 8, bars: 4, energy_rel: 3 }
    ]) },
    stems: {
      activity_per_bar: { drums: [0, 0, 0, 0, 1, 1, 1, 1], bass: [0, 0, 0, 0, 1, 1, 1, 1], other: [1, 1, 1, 1, 1, 1, 1, 1], vocals: [0, 0, 0, 0, 1, 1, 0, 0] },
      per_stem: { drums: { integrated_lufs: -14, pan: 'centre', stereo: { width: 0.1 }, bands: {} }, bass: { integrated_lufs: -16, pan: 'centre', stereo: { width: 0 }, bands: { sub: 0.5, low: 0.45 } },
        other: { integrated_lufs: -18, pan: 'centre', stereo: { width: 0.7 }, bands: {} }, piano: { silent: true } }
    },
    instruments: { mix: item([{ label: 'Synthesizer', share_of_song: 0.9 }, { label: 'Violin', share_of_song: 0.05 }]), electronic_vs_acoustic: item({ electronic_share: 0.9 }) },
    notes: { other: item({}), drums: item({ patterns_per_section: [
      { section: 'intro', patterns: { kick: { pattern: '................' }, hat: { pattern: 'x.x.x.x.x.x.x.x.' } } },
      { section: 'chorus', patterns: { kick: { pattern: 'x...x...x...x...' }, snare: { pattern: '....x.......x...' }, hat: { pattern: '..x...x...x...x.' } } }
    ] }) },
    timbre: item({ drums: { kit: { verdict: 'electronic punchy kick (909 / modern)' } }, bass: { spectral: { centroid_hz: 180 }, pumping: { likely_sidechain: true } },
      other: { envelope: { attack_ms: 60 }, reverb_estimate: { amount: 'wet / long release' }, synth_hint: 'sawtooth-like' } }),
    summary: { paragraph: 'A short piece.' }, run: { errors: {}, audio_seconds: 16 },
    ...over
  };
}
const tracks = {
  bass: [0, 6, 8, 14].flatMap((step) => [4, 5, 6, 7].map((bar) => ({ key: 33, start: bar * BAR + step * 24, length: 40, velocity: 0.8 }))),
  other: [{ key: 57, start: 0, length: BAR * 4, velocity: 0.6 }, { key: 60, start: BAR * 4, length: BAR * 9, velocity: 0.6 }],
  vocals: [{ key: 69, start: BAR * 4 + 10, length: 90, velocity: 0.7 }],
  drums: [{ key: 36, start: BAR * 4, length: 12, velocity: 0.9 }, { key: 38, start: BAR * 4 + PPQ, length: 12, velocity: 0.8 }, { key: 42, start: BAR * 4 + 48, length: 12, velocity: 0.5 }, { key: 51, start: 0, length: 12, velocity: 0.5 }]
};

test('blueprint: tempo, key, swing, form, what plays, chords in the key, grooves, sounds — and nothing of the melody', () => {
  const bp = blueprintFromAnalysis(analysis(), tracks);
  assert.equal(bp.name, 'Study: my song');
  assert.equal(bp.bpm, 120, 'a tempo within 0.15 of a whole number is that number');
  assert.deepEqual([bp.key, bp.scale, bp.timeSig], ['A', 'minor', [4, 4]]);
  assert.equal(bp.swing, 0.4, '16th swing ratio 0.6 on the studio scale (0.5 = straight, 0.75 = full)');
  assert.deepEqual(bp.sections.map((s) => [s.name, s.letter, s.bars, s.play.join('+'), !!s.vocals]), [['Intro', 'A', 4, 'chords', false], ['Chorus', 'B', 4, 'drums+bass+chords', true]]);
  assert.deepEqual(bp.parts.A.chords, ['Am', 'F', 'C', 'G']);
  assert.deepEqual(bp.parts.A.roman, ['i', 'VI', 'III', 'VII']);
  assert.deepEqual(bp.parts.B.chords, ['Am', 'F?', 'C', 'G'], 'an unsure bar keeps its question mark');
  assert.deepEqual(bp.parts.A.drums, { hat: 'x.x.x.x.x.x.x.x.' }, 'an empty row is left out');
  assert.equal(bp.parts.B.bass, 'x-----x-x-----x-', 'the bass rhythm of the section, one bar');
  assert.deepEqual(bp.sounds.bass, { kind: 'synth', preset: 'Sub Bass' });
  assert.deepEqual(bp.sounds.chords, { kind: 'ggs', preset: 'Velvet Pad' }, 'a slow attack on an electronic song: a pad');
  assert.deepEqual([bp.reverb, bp.pump], [{ decay: 3, send: 0.35 }, true]);
  assert.deepEqual(bp.study.instruments, ['Synthesizer'], 'only what is heard through a fifth of the song');
  const text = JSON.stringify(bp);
  assert.ok(!/"key":69|vocals":\[/.test(text) && !text.includes('lyrics'), 'no melody notes, no lyrics');
  // an 8-bar loop of four chords is written once; a key given by hand wins
  const loop = blueprintFromAnalysis(analysis({ structure: { sections: item([{ label: 'verse', letter: 'A', bar_start: 0, bar_end: 8, bars: 8 }]) } }), tracks, { key: 'C major', name: 'Study: X' });
  assert.deepEqual(loop.parts.A.chords, ['Am', 'F', 'C', 'G']);
  assert.deepEqual([loop.key, loop.scale, loop.parts.A.roman[0]], ['C', 'major', 'vi']);
  assert.deepEqual(parseKey('f# Minor'), { key: 'F#', scale: 'minor' });
  assert.equal(parseKey('H dur'), null);
});

test('the blueprint opens as a template project: channels, patterns per section, the arrangement, markers, effects', () => {
  const bp = blueprintFromAnalysis(analysis(), tracks);
  const p = createProjectFromBlueprint(bp);
  assert.deepEqual(p.channels.map((c) => `${c.name}:${c.instrument.kind}`), ['Kick:kick', 'Snare:snare', 'Hat:hat', 'Bass:synth', 'Chords:ggs']);
  assert.deepEqual([p.bpm, p.key, p.scale, p.swing], [120, 'A', 'minor', 0.4]);
  assert.deepEqual(p.markers.map((m) => [m.name, m.tick]), [['Intro', 0], ['Chorus', BAR * 4]]);
  const clip = (name) => p.playlist.clips.filter((c) => p.patterns.find((x) => x.id === c.refId).name === name).map((c) => [c.start / BAR, c.length / BAR]);
  assert.deepEqual(clip('Drums A'), [], 'the intro plays no drums');
  assert.deepEqual(clip('Chords A'), [[0, 4]]);
  assert.deepEqual(clip('Drums B'), [[4, 4]]);
  assert.deepEqual(clip('Bass B'), [[4, 4]]);
  const bass = p.patterns.find((x) => x.name === 'Bass B').notes[p.channels.find((c) => c.name === 'Bass').id];
  assert.deepEqual(bass.slice(0, 4).map((n) => n.start), [0, 144, 192, 336], 'the measured rhythm, on the roots');
  assert.ok(p.mixer.some((m) => m.name === 'Reverb' && m.effects[0].type === 'reverb'));
  assert.ok(p.mixer.find((m) => m.name === 'Bass').effects.some((e) => e.type === 'pump' && e.params.source === p.channels[0].id), 'the bass ducks with the kick');
  assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(p))).channels.length, 5, 'it survives a save and a load');
  // chords the builders cannot read fall back to something playable, or to the bar before
  assert.deepEqual(['Am7?', 'C/E', 'Gsus4add9x', 'N', '', 'H'].map(playableChord), ['Am7', 'C/E', 'G', null, null, null]);
  const odd = specFromBlueprint({ name: 'X', bpm: 90, key: 'C', scale: 'major', parts: { A: { chords: ['N', 'C', 'N', 'G'] } }, sections: [{ name: 'A', letter: 'A', bars: 4 }] });
  assert.equal(odd.patterns.find((x) => x.name === 'Chords A').bars, 4);
  assert.ok(Object.values(TEMPLATES).every((t) => t.label), 'saved studies are listed with the genre templates');
});

test('the study project: a channel per stem, a pattern per section, the transcribed notes where they were played', () => {
  const A = analysis();
  const bp = blueprintFromAnalysis(A, tracks);
  const p = studyProject(A, tracks, bp);
  assert.deepEqual(p.channels.map((c) => c.name), ['Kick', 'Snare', 'Hat', 'Bass', 'Harmony (other)', 'Melody (vocal)']);
  assert.match(p.name, /transcription/);
  const kick = p.channels[0];
  const kickPattern = p.patterns.find((x) => x.name === 'Kick — Chorus');
  assert.deepEqual(kickPattern.notes[kick.id].map((n) => [n.key, n.start]), [[kick.rootKey, 0]], 'a drum hit plays its channel’s own key');
  // a note that runs past its section is cut at the section's end, not dropped
  const harm = p.patterns.find((x) => x.name === 'Harmony (other) — Chorus');
  assert.equal(harm.notes[p.channels[4].id][0].length, BAR * 4);
  assert.equal(p.playlist.clips.find((c) => c.refId === harm.id).start, BAR * 4);
  assert.deepEqual(p.markers.map((m) => m.name), ['Intro', 'Chorus']);
  assert.equal(p.mixer[4].name, 'Bass');
  // no sections found: one span for the whole song
  const flat = studyProject({ ...A, structure: null }, tracks, bp);
  assert.ok(flat.patterns.some((x) => x.name === 'Bass — Song'));
});

test('what to trust: the caveats follow the method’s checks, and the card says them', () => {
  const sure = caveatsOf(analysis());
  assert.ok(!sure.some((c) => /^Tempo|^Bar lines|^Key/.test(c)), sure.join(' | '));
  assert.ok(sure.some((c) => /^Sections/.test(c)) && sure.some((c) => /^Drums/.test(c)), 'what is never to be trusted blindly is always said');
  const A = analysis({ run: { errors: { lyrics: 'RuntimeError: x' } } });
  A.rhythm.agreement = { beat_this_vs_madmom_F: 0.6, downbeat_phase_vote_share: 0.5 };
  A.rhythm.tempo_stability = item('free / varying');
  A.harmony.key = item('A minor', 0.5);
  A.harmony.chords_per_bar.value.forEach((c) => { c.confidence = 0.3; });
  const unsure = caveatsOf(A);
  for (const re of [/^Tempo/, /^Bar lines.*--downbeat-shift 1…3/, /^Key: only 2 of 4/, /^Chords: 8 of 8/, /lyrics.*failed/]) assert.ok(unsure.some((c) => re.test(c)), String(re));
  A.rhythm.agreement.downbeat_shift_beats = 2;
  assert.ok(!caveatsOf(A).some((c) => /^Bar lines/.test(c)), 'a corrected downbeat is not questioned again');
  const card = studyCard(analysis(), blueprintFromAnalysis(analysis(), tracks));
  for (const part of ['# Study: my song', '| Chorus (B) | 5–8 |', 'i · VI · III · VII', 'kick  x...x...x...x...', 'bass  x-----x-x-----x-', '## What to trust', '-9.5 LUFS']) assert.ok(card.includes(part), part);
  assert.deepEqual(sectionsOf({}).length, 0);
});
