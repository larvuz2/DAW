// A library of reference songs: fetch a folder of audio (a Google Drive share link or a local folder), analyse every
// song with `analyze` + `to-daw.mjs` (stems, tempo, key, chords, form, grooves, instruments, sound), and summarise them
// into one reference — per song and across the set — for composing later.
//   node tools/song-analyzer/library.mjs fetch <drive folder or file link | local folder> [--lib uploads/library]
//   node tools/song-analyzer/library.mjs run [--lib …] [--stems local|fal] [--fast] [--only <name>]
//   node tools/song-analyzer/library.mjs summarize [--lib …] [--publish <name>]   (--publish: charts only → docs/references/<name>.md)
//   node tools/song-analyzer/library.mjs status [--lib …]
// Everything stays under the library folder in uploads/ (git-ignored). `run` skips songs already analysed, so it can
// be stopped and started again; one log per song is in <lib>/logs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, copyFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : fallback; };
const LIB = path.resolve(ROOT, opt('--lib', 'uploads/library'));
const AUDIO = path.join(LIB, 'audio');
const OUT = path.join(LIB, 'analysis');
const LOGS = path.join(LIB, 'logs');
const PY = path.join(HERE, '.venv/bin/python');
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/i;
for (const d of [AUDIO, OUT, LOGS]) mkdirSync(d, { recursive: true });

/** A folder name that is safe and stable for a song file. */
const slug = (file) => path.basename(file).replace(AUDIO_EXT, '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'song';
const songs = () => readdirSync(AUDIO).filter((f) => AUDIO_EXT.test(f)).sort();
const done = (f) => existsSync(path.join(OUT, slug(f), 'analysis.json')) && existsSync(path.join(OUT, slug(f), 'study', 'blueprint.json'));
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const durationOf = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout.trim()) || 0;
};

function fetch(src) {
  if (!src) throw new Error('fetch needs a Google Drive link or a local folder');
  if (existsSync(src)) { // a local folder or file
    const files = statSync(src).isDirectory() ? walk(src) : [src];
    let n = 0;
    for (const f of files.filter((x) => AUDIO_EXT.test(x))) { copyFileSync(f, path.join(AUDIO, path.basename(f))); n++; }
    console.log(`copied ${n} audio files into ${path.relative(ROOT, AUDIO)}`);
    return;
  }
  if (!/^https:\/\/(drive|docs)\.google\.com\//.test(src)) throw new Error('only Google Drive links (drive.google.com) or local folders');
  // downloaded files are untrusted data: they go into their own folder, and only audio files are kept
  const inbox = path.join(LIB, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const folder = /\/folders\//.test(src);
  const code = folder
    ? 'import sys, gdown; gdown.download_folder(url=sys.argv[1], output=sys.argv[2], quiet=False, remaining_ok=True)'
    : 'import sys, gdown; gdown.download(url=sys.argv[1], output=sys.argv[2] + "/", quiet=False, fuzzy=True)';
  const r = spawnSync(PY, ['-I', '-c', code, src, inbox], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('the download failed: is the link shared as "Anyone with the link"? (a folder of more than 50 files needs its sub-folders shared, or the files sent in parts)');
  const files = walk(inbox).filter((x) => AUDIO_EXT.test(x));
  for (const f of files) renameSync(f, path.join(AUDIO, path.basename(f)));
  const skipped = walk(inbox).length;
  console.log(`${files.length} audio files are in ${path.relative(ROOT, AUDIO)}${skipped ? ` (${skipped} other files left in ${path.relative(ROOT, inbox)}, not used)` : ''}`);
  status();
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function status() {
  const list = songs();
  let todo = 0;
  for (const f of list) { const d = durationOf(path.join(AUDIO, f)); if (!done(f)) todo += d; console.log(`${done(f) ? '✓' : '·'} ${fmtTime(d).padStart(6)}  ${f}`); }
  const left = list.filter((f) => !done(f)).length;
  console.log(`\n${list.length} songs, ${list.length - left} analysed, ${left} to go (${fmtTime(todo)} of audio ≈ ${Math.round((todo * 4.7) / 60)} min with local stems)`);
}

function run() {
  const stems = opt('--stems', 'local');
  const only = opt('--only', null);
  const list = songs().filter((f) => !done(f) && (!only || f.includes(only)));
  console.log(`${list.length} songs to analyse`);
  for (const [i, f] of list.entries()) {
    const out = path.join(OUT, slug(f));
    const log = path.join(LOGS, `${slug(f)}.log`);
    const t0 = Date.now();
    console.log(`[${i + 1}/${list.length}] ${f} (${fmtTime(durationOf(path.join(AUDIO, f)))}) …`);
    const a = ['--out', out, '--stems', stems, ...(args.includes('--fast') ? ['--fast'] : []), ...(existsSync(path.join(out, 'stems')) ? ['--reuse-stems'] : [])];
    const r1 = spawnSync(path.join(HERE, 'analyze'), [path.join(AUDIO, f), ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
    writeFileSync(log, (r1.stdout || '') + (r1.stderr || ''));
    if (r1.status !== 0) { console.log(`   failed (see ${path.relative(ROOT, log)})`); continue; }
    const r2 = spawnSync('node', [path.join(HERE, 'to-daw.mjs'), out, '--name', `Study: ${path.basename(f).replace(AUDIO_EXT, '')}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
    writeFileSync(log, readFileSync(log, 'utf8') + (r2.stdout || '') + (r2.stderr || ''));
    console.log(`   ${r2.status === 0 ? 'done' : 'analysed, but the study draft failed'} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
  summarize();
}

// ------------------------------------------------------------------------------------------------- the summary
const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const round = (v, d = 1) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);
/** Collapse repeats (a chord held for two bars is one step of the progression), drop the "?" marks. */
const steps = (list) => list.map((c) => String(c).replace(/\?$/, '')).filter((c, i, a) => c && c !== 'N' && c !== a[i - 1]);

function record(file) {
  const dir = path.join(OUT, slug(file));
  const a = JSON.parse(readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
  const bp = existsSync(path.join(dir, 'study/blueprint.json')) ? JSON.parse(readFileSync(path.join(dir, 'study/blueprint.json'), 'utf8')) : null;
  const sig = a.signal || {};
  const tempo = a.rhythm?.tempo_bpm || {};
  const key = a.harmony?.key || {};
  const sections = (val(a.structure?.sections) || []).map((x) => ({ name: x.label, letter: x.letter, bars: x.bars, range: x.bar_range, energy: x.energy_rel }));
  const parts = bp ? Object.fromEntries(Object.entries(bp.parts || {}).map(([k, v]) => [k, { chords: v.chords, roman: v.roman, drums: v.drums, bass: v.bass }])) : {};
  const mix = (val(a.instruments?.mix) || []).filter((x) => x.mean_prob >= 0.06).slice(0, 8).map((x) => ({ label: x.label, share: x.share_of_song, p: x.mean_prob }));
  const stems = Object.entries(a.stems?.per_stem || {}).filter(([, v]) => !v.silent).map(([k, v]) => ({ stem: k, lufs: v.integrated_lufs, pan: v.pan }));
  const bands = val(sig.spectral_balance)?.bands || {};
  return {
    file, slug: slug(file), duration_s: round(val(sig.file)?.duration_s, 1),
    bpm: round(val(tempo), 1), bpm_confidence: round(tempo.confidence, 2), bpm_alternatives: tempo.alternatives || null,
    tempo_stability: val(a.rhythm?.tempo_stability), time_signature: val(a.rhythm?.time_signature), swing: val(a.rhythm?.swing),
    key: val(key), key_confidence: round(key.confidence, 2), key_votes: key.votes ? Object.values(key.votes).map((v) => v.key) : [],
    tonal_centre: val(a.harmony?.tonal_centre)?.mode || null, harmonic_rhythm: val(a.harmony?.harmonic_rhythm)?.typical || null,
    chords_per_bar: (val(a.harmony?.chords_per_bar) || []).map((c) => (c.confidence < 0.45 ? `${c.chord}?` : c.chord)),
    sections, parts, form: sections.map((x) => `${x.name}(${x.bars})`).join(' – '),
    energy_events: a.structure?.energy_events || [],
    instruments: mix, genre_hints: (val(a.instruments?.genre_hints) || []).slice(0, 4).map((x) => x.label),
    electronic_vs_acoustic: val(a.instruments?.electronic_vs_acoustic)?.verdict || null, stems,
    loudness_lufs: val(sig.loudness)?.integrated_lufs, true_peak_dbtp: val(sig.levels)?.true_peak_dbtp, crest_db: val(sig.levels)?.crest_factor_db,
    bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, round(v.share * 100, 0)])), stereo: val(sig.stereo),
    sounds: bp?.sounds || null, reverb: bp?.reverb || null, pump: bp?.pump ?? null,
    summary: a.summary?.paragraph || '', caveats: bp?.study?.caveats || []
  };
}

function count(list) { const m = new Map(); for (const x of list) if (x != null && x !== '') m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); }
function median(xs) { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; }

function summarize() {
  const recs = songs().filter(done).map(record);
  if (!recs.length) { console.log('nothing analysed yet'); return; }
  // progressions in numerals (so songs in different keys compare): every four-step loop of every part
  const loops = [];
  for (const r of recs) for (const part of Object.values(r.parts)) {
    const st = steps(part.roman || []);
    for (let i = 0; i + 4 <= st.length; i++) loops.push(st.slice(i, i + 4).join(' – '));
  }
  const vocab = count(recs.flatMap((r) => steps(Object.values(r.parts).flatMap((p) => p.roman || []))));
  const lib = {
    songs: recs.length, minutes: round(recs.reduce((t, r) => t + (r.duration_s || 0), 0) / 60, 1),
    tempo: { median: median(recs.map((r) => r.bpm)), list: recs.map((r) => r.bpm).sort((a, b) => a - b) },
    keys: count(recs.map((r) => r.key)), modes: count(recs.map((r) => (r.key || '').split(' ')[1])),
    progressions: count(loops).slice(0, 25), numerals: vocab.slice(0, 30),
    instruments: count(recs.flatMap((r) => r.instruments.map((i) => i.label))).slice(0, 25),
    genres: count(recs.flatMap((r) => r.genre_hints)).slice(0, 15),
    forms: count(recs.map((r) => r.sections.map((x) => x.name).join(' – '))).slice(0, 10),
    swing: count(recs.map((r) => r.swing?.feel)),
    loudness_median: median(recs.map((r) => r.loudness_lufs)),
    bands_median: Object.fromEntries(['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'].map((b) => [b, median(recs.map((r) => r.bands[b]))]))
  };
  writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({ library: lib, songs: recs }, null, 1));
  const md = reference(lib, recs, true);
  writeFileSync(path.join(LIB, 'library.md'), md);
  const pub = opt('--publish', null);
  if (pub) { // a chart of each song, without audio, melody or lyrics: what a musician writes down after listening
    const dest = path.join(ROOT, 'docs/references', `${pub}.md`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, reference(lib, recs, false));
    console.log(`wrote ${path.relative(ROOT, dest)} (charts only: commit it to keep the reference)`);
  }
  console.log(`${recs.length} songs summarised → ${path.relative(ROOT, path.join(LIB, 'library.md'))}, library.json`);
}

function reference(lib, recs, full) {
  const pct = (n) => `${Math.round((100 * n) / recs.length)} %`;
  const L = [];
  L.push(`# Reference library (${lib.songs} songs, ${lib.minutes} min)`, '');
  L.push('Measured by tools/song-analyzer (see docs/song-studies.md for how far each measurement can be trusted). Numerals are in each song\'s own key, so songs in different keys compare.', '');
  L.push('## Across the library', '');
  L.push(`- **Tempo**: median ${lib.tempo.median} BPM; all: ${lib.tempo.list.join(', ')} (a slow song can be read at half its tempo, a fast one at double: see each song's alternatives)`);
  L.push(`- **Keys**: ${lib.keys.map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  L.push(`- **Feel**: ${lib.swing.map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  L.push(`- **Loudness**: median ${lib.loudness_median} LUFS; median band balance ${Object.entries(lib.bands_median).map(([k, v]) => `${k} ${v} %`).join(' · ')}`);
  L.push('', '### Progressions that recur (four steps, in numerals)', '', '| Progression | Times |', '|---|---|', ...lib.progressions.map(([p, n]) => `| ${p} | ${n} |`));
  L.push('', '### Chord vocabulary (numerals by how often they appear)', '', lib.numerals.map(([k, n]) => `${k} (${n})`).join(' · '));
  L.push('', '### Instruments heard', '', '| Instrument | Songs |', '|---|---|', ...lib.instruments.map(([k, n]) => `| ${k} | ${n} (${pct(n)}) |`));
  L.push('', `### Genre hints\n\n${lib.genres.map(([k, n]) => `${k} (${n})`).join(' · ')}`);
  L.push('', '### Forms', '', ...lib.forms.map(([f, n]) => `- ${f} ×${n}`));
  L.push('', '## Song by song', '');
  for (const r of recs) {
    L.push(`### ${r.file.replace(AUDIO_EXT, '')}`, '');
    L.push(`- ${r.duration_s ? fmtTime(r.duration_s) : '?'} · **${r.bpm} BPM** (confidence ${r.bpm_confidence}${r.bpm_alternatives ? `; half ${round(r.bpm_alternatives.half)}, double ${round(r.bpm_alternatives.double)}` : ''}) · ${r.time_signature} · ${r.tempo_stability} · ${r.swing?.feel || ''}`);
    L.push(`- **Key** ${r.key} (confidence ${r.key_confidence}; votes ${r.key_votes.join(', ')}); centre ${r.tonal_centre}; ${r.harmonic_rhythm || ''}`);
    L.push(`- **Form**: ${r.form}`);
    for (const [letter, p] of Object.entries(r.parts)) {
      L.push(`- **Part ${letter}**: ${(p.chords || []).join(' | ')}  →  ${(p.roman || []).join(' | ')}`);
      if (p.drums) L.push(`  - drums: ${Object.entries(p.drums).map(([k, v]) => `${k} \`${v}\``).join(' · ')}${p.bass ? ` · bass rhythm \`${p.bass}\`` : ''}`);
    }
    L.push(`- **Instruments**: ${r.instruments.map((i) => i.label).join(', ') || '—'} · ${r.electronic_vs_acoustic || ''} · stems with sound: ${r.stems.map((x) => x.stem).join(', ')}`);
    L.push(`- **Sound**: ${r.loudness_lufs} LUFS, true peak ${r.true_peak_dbtp} dBTP, crest ${r.crest_db} dB, bands ${Object.entries(r.bands).map(([k, v]) => `${k} ${v}`).join('/')}, width ${r.stereo?.width}${r.pump ? ', kick ducking' : ''}`);
    if (r.sounds) L.push(`- **Rebuild in GGS**: ${Object.entries(r.sounds).map(([k, v]) => `${k} → ${v.preset || v.kind}`).join(', ')}`);
    if (full && r.summary) L.push(`- ${r.summary}`);
    if (r.caveats.length) L.push(`- *Check*: ${r.caveats.join(' ')}`);
    L.push('');
  }
  return L.join('\n');
}

export { slug, songs, done };
if (cmd === 'fetch') fetch(args[1]);
else if (cmd === 'run') run();
else if (cmd === 'status') status();
else if (cmd === 'summarize') summarize();
else { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 9).join('\n')); process.exit(cmd ? 1 : 0); }
