// Loudness, true peak, stereo and band balance of a WAV file, measured with the studio's own meter
// (packages/core/src/analysis.js: ITU-R BS.1770 / EBU R128 loudness with gating, 4x-oversampled true peak, EBU
// loudness range) — the same one render_mix reports, so a song and its rebuild in the studio compare like for like.
//
//   node tools/song-analyzer/measure.mjs <file.wav>      → JSON on stdout
//
// The Python analyzer calls it for the mix and for each stem (songanalyzer/common.py measure_call).
import fs from 'node:fs';
import { decodeWav } from '../../packages/core/src/wav.js';
import { analyzeAudio, createTruePeakMeter } from '../../packages/core/src/analysis.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/song-analyzer/measure.mjs <file.wav>');
  process.exit(1);
}
const wav = decodeWav(fs.readFileSync(file));
// lite: no tempo, pitch or key here (the analyzer has better estimators for those); 1 s blocks for the loudness curve
const a = analyzeAudio({ channels: wav.channels, sampleRate: wav.sampleRate }, { lite: true, segmentSeconds: 1 });
// (the lite analysis leaves the inter-sample peak out: measured here)
const tp = createTruePeakMeter();
tp.push(wav.channels.slice(0, 2));
const truePeak = Math.max(tp.peak(), 10 ** (a.peakDb / 20));
a.truePeakDb = truePeak > 1e-10 ? Math.round(200 * Math.log10(truePeak)) / 10 : -200;
const perSecond = a.loudnessPerSegment?.lufs || [];
const energy = (lufs) => (lufs > -150 ? 10 ** ((lufs + 0.691) / 10) : 0);
// short-term loudness: the mean of three 1 s K-weighted blocks, read every second
const timeline = perSecond.map((_, i) => {
  const w = perSecond.slice(Math.max(0, i - 2), i + 1).map(energy);
  const z = w.reduce((s, v) => s + v, 0) / w.length;
  return { t_s: i + 1, lufs_short: z > 0 ? Math.round((-0.691 + 10 * Math.log10(z)) * 10) / 10 : -120 };
});
const silent = perSecond.filter((v) => v < -60).length;
const bands = Object.fromEntries(Object.entries(a.spectrum?.bandsPercent || {}).map(([k, v]) => [k, { share: Math.round(v * 10) / 1000 }]));
const findings = [];
if (a.truePeakDb > -0.1) findings.push({ message: `true peak ${a.truePeakDb} dBTP: over a −1 dBTP streaming ceiling` });
if (a.clipping?.samples > 0) findings.push({ message: `${a.clipping.samples} samples at full scale` });
if (Math.abs(a.dcOffset) > 0.002) findings.push({ message: `DC offset ${a.dcOffset}` });
if (a.stereo && a.stereo.lowWidth > 0.5) findings.push({ message: `wide low end (side/mid below 150 Hz = ${a.stereo.lowWidth})` });

process.stdout.write(JSON.stringify({
  report: {
    levels: {
      true_peak_dbtp: a.truePeakDb, peak_dbfs: a.peakDb, rms_dbfs: a.rmsDb, crest_factor_db: a.crestDb, dc_offset: a.dcOffset,
      clipped_samples: a.clipping?.samples ?? 0
    },
    loudness: {
      integrated_lufs: a.lufs, loudness_range_lu: a.loudnessRangeLu, short_term_max_lufs: a.shortTermMaxLufs,
      momentary_max_lufs: a.momentaryMaxLufs
    },
    stereo: a.stereo
      ? { correlation: a.stereo.correlation, width: a.stereo.width, low_width: a.stereo.lowWidth, balance_db: a.stereo.balanceDb }
      : { correlation: 1, width: 0, low_width: 0, balance_db: 0 },
    time: {
      timeline,
      silence: {
        leading_s: Math.round((a.silence?.headMs ?? 0) / 10) / 100, trailing_s: Math.round((a.silence?.tailMs ?? 0) / 10) / 100,
        silent_fraction: perSecond.length ? Math.round((silent / perSecond.length) * 1000) / 1000 : 0
      }
    },
    spectrum: { bands, centroid_hz: a.spectrum?.centroidHz ?? null, flatness: a.spectrum?.flatness ?? null },
    findings
  }
}));
