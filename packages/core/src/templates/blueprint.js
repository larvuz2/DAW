// A song blueprint → a template spec. A blueprint is what a song study keeps of a song that is safe and useful to
// reuse: its tempo and feel, key, form (sections and what plays in each), chord progressions, drum grooves, bass
// rhythm and the kind of sounds — not its melody, lyrics or audio. tools/song-analyzer/to-daw.mjs writes blueprints
// from an analysis (docs/song-studies.md); each saved study is a file in templates/studies/ and shows up under
// "New from template" like any genre.
//
// Blueprint (version 1):
//   { name, bpm, timeSig?: [4, 4], key, scale, swing?: 0..1,
//     sounds?: { kick, snare, hat, bass, chords: { kind, preset?, params?, volume? } }, reverb?: { decay, send }, pump?: bool,
//     parts: { [letter]: { drums?: { kick, snare, hat: 'x---…' (one bar of steps) }, chords?: ['Am', 'F', …] (a chord a
//              bar), bass?: 'x-----x-…' (one bar of root rhythm) } },
//     sections: [{ name, letter, bars, play?: ['drums', 'bass', 'chords'] }] }
import { chordProgressionNotes, bassFromChords } from '../builders.js';
import { parseChord } from '../music.js';
import { steps } from './steps.js';

const DEFAULT_SOUNDS = {
  kick: { kind: 'kick', volume: 0.85 },
  snare: { kind: 'snare', volume: 0.7 },
  hat: { kind: 'hat', volume: 0.45 },
  bass: { kind: 'synth', preset: 'Sub Bass', volume: 0.75 },
  chords: { kind: 'epiano', volume: 0.6 }
};
const ROLE_NAMES = { kick: 'Kick', snare: 'Snare', hat: 'Hat', bass: 'Bass', chords: 'Chords' };
const PART_NAMES = { drums: 'Drums', bass: 'Bass', chords: 'Chords' };
const COLORS = { drums: '#e8665a', bass: '#d98c5f', chords: '#3fb5d6' };
const stepString = (s) => String(s || '').replace(/\s/g, '').replace(/\./g, '-');
const hasHits = (s) => /[xXo]/.test(stepString(s));
/** A chord symbol the builders can read: the symbol itself, or its root triad, or null. */
export function playableChord(symbol) {
  const s = String(symbol || '').replace(/\?$/, '').trim();
  if (!s || s === 'N') return null;
  for (const cand of [s, s.split('/')[0], (/^[A-G][#b]?m?/.exec(s) || [''])[0]]) {
    try { if (cand && parseChord(cand)) return cand; } catch { /* try the next, simpler spelling */ }
  }
  return null;
}

export function specFromBlueprint(bp) {
  const sounds = { ...DEFAULT_SOUNDS, ...(bp.sounds || {}) };
  const letters = Object.keys(bp.parts || {});
  const used = (role) => (bp.sections || []).some((s) => {
    const part = bp.parts[s.letter] || {};
    const plays = s.play || ['drums', 'bass', 'chords'];
    if (role === 'bass' || role === 'chords') return plays.includes(role) && (part.chords || []).some(playableChord);
    return plays.includes('drums') && hasHits(part.drums?.[role]);
  });
  const roles = ['kick', 'snare', 'hat', 'bass', 'chords'].filter(used);
  const reverb = bp.reverb && roles.includes('chords') ? bp.reverb : null;
  const channels = roles.map((role) => {
    const snd = sounds[role];
    const c = { name: ROLE_NAMES[role], kind: snd.kind, volume: snd.volume ?? DEFAULT_SOUNDS[role].volume };
    if (snd.preset) c.preset = snd.preset;
    if (snd.params) c.params = snd.params;
    const fx = [];
    if (role === 'chords') fx.push({ type: 'eq', params: { hpf: 180 } });
    if (bp.pump && roles.includes('kick') && (role === 'bass' || role === 'chords')) fx.push({ type: 'pump', params: { source: 'Kick', depth: role === 'bass' ? 0.5 : 0.6 } });
    if (fx.length) c.fx = fx;
    if (reverb && (role === 'chords' || role === 'snare')) c.sends = { Reverb: role === 'chords' ? reverb.send ?? 0.3 : (reverb.send ?? 0.3) / 2 };
    return c;
  });
  const patterns = [];
  const has = {};
  for (const L of letters) {
    const part = bp.parts[L];
    const drumRoles = ['kick', 'snare', 'hat'].filter((r) => roles.includes(r) && hasHits(part.drums?.[r]));
    if (drumRoles.length) {
      patterns.push({ name: `Drums ${L}`, bars: 1, color: COLORS.drums, notes: () => Object.fromEntries(drumRoles.map((r) => [ROLE_NAMES[r], steps(stepString(part.drums[r]))])) });
      has[`drums ${L}`] = true;
    }
    // (a bar without a chord the builders can read repeats the one before it)
    const chords = [];
    for (const c of part.chords || []) chords.push(playableChord(c) || chords.at(-1) || null);
    const first = chords.find(Boolean);
    const filled = chords.map((c) => c || first);
    if (first && roles.includes('chords')) {
      patterns.push({ name: `Chords ${L}`, bars: filled.length, color: COLORS.chords, notes: (bar) => ({ Chords: chordProgressionNotes(filled, { chordLength: bar, octave: 4, gate: 0.95, velocity: 0.7 }) }) });
      has[`chords ${L}`] = filled.length;
    }
    if (first && roles.includes('bass')) {
      const rhythm = hasHits(part.bass) ? stepString(part.bass) : 'x-------x-------';
      patterns.push({ name: `Bass ${L}`, bars: filled.length, color: COLORS.bass, notes: (bar) => ({ Bass: bassFromChords(filled, { chordLength: bar, octave: 2, rhythm, gate: 0.85 }) }) });
      has[`bass ${L}`] = filled.length;
    }
  }
  const arrangement = [];
  const markers = [];
  const tracks = { drums: 0, bass: 1, chords: 2 };
  let bar = 0;
  for (const s of bp.sections || []) {
    markers.push({ bar, name: s.name });
    for (const role of s.play || ['drums', 'bass', 'chords']) {
      if (!has[`${role} ${s.letter}`]) continue;
      arrangement.push({ pattern: `${PART_NAMES[role]} ${s.letter}`, track: tracks[role], bar, bars: s.bars, trackName: PART_NAMES[role] });
    }
    bar += s.bars;
  }
  return {
    name: bp.name, bpm: bp.bpm, key: bp.key, scale: bp.scale, swing: bp.swing || 0, timeSig: bp.timeSig,
    channels,
    buses: reverb ? [{ name: 'Reverb', fx: [{ type: 'reverb', params: { decay: reverb.decay ?? 2.2, mix: 1 } }] }] : [],
    patterns, markers, arrangement
  };
}
