#!/usr/bin/env node
// Everything a song study produced, in one zip to hand over (it is private material: it holds the song's stems and
// transcription — it goes to the person, never into the repository):
//
//   <analysis>/study/<name>-study.zip
//     study.md, report.pdf, blueprint.json            the write-ups and the reusable blueprint
//     preset-preview.gtd.json, study.gtd.json         projects to open with File → Import project file
//     preset-preview.wav                              the preset as the studio renders it (when it was auditioned)
//     midi/*.mid                                      the transcription, one file per stem
//     stems/*.flac                                    the separated stems (16-bit FLAC), to drop into Samples
//     one-shots/kick-1.wav …                          the clearest drum hits cut from the drum stem
//
//   node tools/song-analyzer/bundle.mjs <analysis dir> [--no-stems]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMidi, PPQ } from '../../packages/core/src/index.js';

const args = process.argv.slice(2);
const noStems = args.includes('--no-stems') && args.splice(args.indexOf('--no-stems'), 1);
const dir = args[0] && path.resolve(args[0]);
if (!dir || !fs.existsSync(path.join(dir, 'analysis.json'))) {
  console.error('usage: node tools/song-analyzer/bundle.mjs <analysis dir> [--no-stems]');
  process.exit(1);
}
const study = path.join(dir, 'study');
if (!fs.existsSync(path.join(study, 'blueprint.json'))) {
  console.error(`${study}/blueprint.json not found: run to-daw.mjs first`);
  process.exit(1);
}
const A = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
const bp = JSON.parse(fs.readFileSync(path.join(study, 'blueprint.json'), 'utf8'));
const slug = String(bp.name || 'song').replace(/^Study:\s*/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song';
const stage = path.join(study, 'bundle');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'midi'), { recursive: true });
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const copy = (from, to) => { if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, to)); };

for (const f of ['study.md', 'blueprint.json', 'preset-preview.gtd.json', 'study.gtd.json', 'preset-preview.wav']) copy(path.join(study, f), f);
copy(path.join(dir, 'report.pdf'), 'report.pdf');
for (const f of fs.existsSync(path.join(dir, 'midi')) ? fs.readdirSync(path.join(dir, 'midi')) : []) copy(path.join(dir, 'midi', f), path.join('midi', f));

const stems = fs.existsSync(path.join(dir, 'stems')) ? fs.readdirSync(path.join(dir, 'stems')).filter((f) => f.endsWith('.wav')) : [];
const silent = (name) => A.stems?.per_stem?.[name]?.silent || (A.stems?.per_stem?.[name]?.integrated_lufs ?? 0) < -45;
if (!noStems && stems.length) {
  fs.mkdirSync(path.join(stage, 'stems'), { recursive: true });
  for (const f of stems) {
    const name = f.slice(0, -4);
    if (silent(name)) continue; // (an empty stem — no vocals, no piano — is not worth carrying)
    ffmpeg('-i', path.join(dir, 'stems', f), '-c:a', 'flac', '-sample_fmt', 's16', path.join(stage, 'stems', `${name}.flac`));
  }
}

// drum one-shots: for each of kick, snare and hat, the three loudest hits with the most room before the next hit
const drumStem = path.join(dir, 'stems', 'drums.wav');
const midiFile = path.join(dir, 'midi', 'drums.mid');
const beats = A.rhythm?.beats?.value || [];
if (fs.existsSync(drumStem) && fs.existsSync(midiFile) && beats.length > 1) {
  const hits = parseMidi(fs.readFileSync(midiFile)).tracks.flatMap((t) => t.notes).sort((a, b) => a.start - b.start);
  // the MIDI counts in beats from bar 1: beat b sounds at beats[b] (between beats: in proportion)
  const seconds = (tick) => {
    const b = tick / PPQ;
    const i = Math.max(0, Math.min(beats.length - 2, Math.floor(b)));
    return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
  };
  fs.mkdirSync(path.join(stage, 'one-shots'), { recursive: true });
  for (const [key, name] of [[36, 'kick'], [38, 'snare'], [42, 'hat']]) {
    const mine = hits.map((n, i) => ({ n, room: (hits[i + 1] ? seconds(hits[i + 1].start) : Infinity) - seconds(n.start) })).filter((x) => x.n.key === key && x.room >= 0.12);
    mine.sort((a, b) => (b.n.velocity + Math.min(b.room, 0.6)) - (a.n.velocity + Math.min(a.room, 0.6)));
    mine.slice(0, 3).forEach((x, i) => {
      const at = Math.max(0, seconds(x.n.start) - 0.005);
      const len = Math.max(0.12, Math.min(name === 'hat' ? 0.25 : 0.6, x.room - 0.01));
      ffmpeg('-ss', at.toFixed(4), '-t', len.toFixed(4), '-i', drumStem, '-af', `afade=t=in:d=0.002,afade=t=out:st=${(len - 0.03).toFixed(4)}:d=0.03`, '-c:a', 'pcm_s16le', path.join(stage, 'one-shots', `${name}-${i + 1}.wav`));
    });
  }
}

const zip = path.join(study, `${slug}-study.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });
const list = execFileSync('unzip', ['-Z1', zip]).toString().trim().split('\n').filter((l) => !l.endsWith('/'));
console.log(`${path.relative(process.cwd(), zip)} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB): ${list.join(', ')}`);
console.log(`made by ${path.basename(fileURLToPath(import.meta.url))}; private study material — do not commit it`);
