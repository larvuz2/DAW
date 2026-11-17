// Renders as things an agent can reason about: is this the same audio as before (a fingerprint, and the null test),
// what did my change do in numbers (a comparison of two analyses), and which stems fight for the same band at the
// same moment (a masking report). Pure functions on samples and analysis results — nothing here touches audio
// hardware.
//
// Why two answers to "the same audio?": a browser mixes three or more sources into one node in an order that is
// not the same from run to run (measured in Chromium: six oscillators into one gain give a different last bit on
// every render). So two renders of an untouched project agree to about −140 dB, not to the bit, and a fingerprint
// alone would call them different. The null test — subtract one render from the other and measure what is left —
// is the answer that holds.
import { INSTRUMENTS } from './instruments.js';

/** Edges of the 24 critical bands of the Bark scale in Hz (Zwicker 1961; the lowest edge raised to 20 Hz). */
export const BARK_EDGES_HZ = [20, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500];
export const BARK_BANDS = BARK_EDGES_HZ.length - 1;

const mix32 = (h) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/**
 * A fingerprint of rendered audio: 16 hex digits that change when one bit of one sample changes. Two renders with
 * the same fingerprint are the same audio — the way to tell a change that did nothing from one that did.
 * channels: Float32Arrays (the bit patterns are hashed, so 0 and −0 differ, as they should for "identical").
 */
export function audioFingerprint(channels) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (const ch of channels || []) {
    const aligned = ch.byteOffset % 4 === 0 ? ch : new Float32Array(ch);
    const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      a = Math.imul(a ^ w, 0x01000193);
      b = (Math.imul(b + w, 0x9e3779b1) ^ (b >>> 15)) | 0;
    }
    // (the channel boundary is part of the audio: L then R is not R then L, and not one long channel)
    a = Math.imul(a ^ words.length, 0x01000193);
    b = Math.imul(b ^ 0x5bd1e995, 0x9e3779b1);
  }
  return mix32(a).toString(16).padStart(8, '0') + mix32(b ^ a).toString(16).padStart(8, '0');
}

/** A channel as 16-bit integers: how a render is kept for the null test (half the memory of the floats). */
export function toPcm16(channel) {
  const out = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i++) {
    const v = Math.round(channel[i] * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v || 0;
  }
  return out;
}

/** What is left below this, in dB relative to the mix, is rounding and not a change… */
export const SAME_AUDIO_DB = -80;
/** …and no single sample may differ by more than this many steps of 16 bits (the mixer's last bit moves a sample by one). */
const SAME_PEAK_LSB = 2;
/** …and so is anything below the 16-bit floor the earlier render is kept at. */
const FLOOR_DBFS = -96;

/**
 * The null test: subtract an earlier render (kept as 16-bit, see toPcm16) from this one and measure what is left.
 * Returns
 *   residualDb    level of the difference relative to the level of the louder of the two renders
 *                 (about 0 = unrelated audio, −6 = one is 6 dB down, −200 = nothing)
 *   residualDbfs  the same, relative to full scale
 *   peakDb        the largest single difference, dBFS
 *   worstAt       seconds: the middle of the second in which the two differ most (null when they do not)
 *   seconds       how much was compared (the shorter of the two)
 *   lengthDelta   seconds this render is longer (negative: shorter)
 *   same          nothing is left but rounding — on average and at every single sample — and the lengths agree
 */
export function nullTest(earlier, current, sampleRate) {
  const chans = Math.min(earlier.length, current.length);
  const n = chans ? Math.min(earlier[0].length, current[0].length) : 0;
  const perSecond = new Float64Array(Math.max(1, Math.ceil(n / sampleRate)));
  let left = 0;
  let level = 0; // of this render
  let before = 0; // of the earlier one
  let peak = 0;
  for (let c = 0; c < chans; c++) {
    const a = earlier[c];
    const b = current[c];
    for (let i = 0; i < n; i++) {
      let q = Math.round(b[i] * 32767);
      q = q > 32767 ? 32767 : q < -32768 ? -32768 : q || 0;
      const d = q - a[i];
      level += q * q;
      before += a[i] * a[i];
      if (!d) continue;
      const sq = d * d;
      left += sq;
      perSecond[(i / sampleRate) | 0] += sq;
      if (sq > peak) peak = sq;
    }
  }
  const count = Math.max(1, n * chans);
  const db = (ms) => (ms > 0 ? Math.round(100 * Math.log10(ms)) / 10 : -200);
  let worst = -1;
  for (let s = 0; s < perSecond.length; s++) if (perSecond[s] > 0 && (worst < 0 || perSecond[s] > perSecond[worst])) worst = s;
  const residualDbfs = db(left / count / (32767 * 32767));
  const reference = Math.max(level, before);
  const residualDb = left === 0 ? -200 : reference > 0 ? db(left / reference) : 0;
  const lengthDelta = chans ? Math.round(((current[0].length - earlier[0].length) / sampleRate) * 1000) / 1000 : 0;
  return {
    residualDb, residualDbfs, peakDb: db(peak / (32767 * 32767)), worstAt: worst < 0 ? null : worst + 0.5, seconds: Math.round((n / sampleRate) * 100) / 100, lengthDelta,
    // (the average alone would let a click pass in a long song: 50 ms at −60 dBFS vanish in four minutes of music)
    same: lengthDelta === 0 && peak <= SAME_PEAK_LSB * SAME_PEAK_LSB && (residualDb <= SAME_AUDIO_DB || residualDbfs <= FLOOR_DBFS)
  };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const powDb = (e) => (e > 1e-12 ? 10 * Math.log10(e) : -120);
const hzText = (hz) => (hz >= 1000 ? `${r1(hz / 1000)} kHz` : `${Math.round(hz)} Hz`);

/** A band must be within this of the stem's loudest band, in the same frame, to carry the body of its sound. */
const STRONG_WITHIN_DB = 12;
/** …and above −50 dBFS. */
const AUDIBLE = 1e-5;
const MIN_SHARE_OF_TIME = 0.05;
const MAX_OVERLAPS = 8;

/**
 * Where stems collide: two stems are both strong in the same band at the same moment.
 *
 * stems: [{ name, frames }] — frames[t] is the energy (mean square re full scale) in each of the 24 Bark bands
 * of frame t; every stem has frames for the same moments (createLevelMeter with { bands: true } makes them).
 * A stem is *strong* in a band of a frame when that band is above −50 dBFS and within 12 dB of the stem's loudest
 * band in that frame. Neighbouring colliding bands of a pair are one range; ranges that collide for less than 5 %
 * of the time are left out. For each range:
 *   shareOfTime  fraction of the frames in which the pair collides there
 *   overlapDb    level of the contested energy (the smaller of the two, summed over the range, averaged over the
 *                colliding frames) — the louder, the worse
 *   yield        the stem that should give way: the one for which the range holds the smaller share of its own
 *                energy (it loses least), with what to do about it
 * Returns { frames, overlaps (worst first, at most 8), stems: [{ name, levelDb }] } — or null with fewer than two
 * stems or four frames.
 */
export function maskingReport(stems) {
  const list = (stems || []).filter((s) => s?.frames?.length);
  const frames = Math.min(...list.map((s) => s.frames.length));
  if (list.length < 2 || !(frames >= 4)) return null;
  const strong = list.map((s) => s.frames.slice(0, frames).map((f) => {
    let top = 0;
    for (let b = 0; b < BARK_BANDS; b++) if (f[b] > top) top = f[b];
    const floor = Math.max(AUDIBLE, top * Math.pow(10, -STRONG_WITHIN_DB / 10));
    let mask = 0;
    for (let b = 0; b < BARK_BANDS; b++) if (f[b] >= floor) mask |= 1 << b;
    return mask;
  }));
  const total = list.map((s) => {
    const sum = new Float64Array(BARK_BANDS);
    for (let t = 0; t < frames; t++) for (let b = 0; b < BARK_BANDS; b++) sum[b] += s.frames[t][b];
    return sum;
  });
  const energyOf = (i, lo, hi) => { let e = 0; for (let b = lo; b <= hi; b++) e += total[i][b]; return e; };
  const all = total.map((t) => t.reduce((x, y) => x + y, 0));

  const overlaps = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const hits = new Int32Array(BARK_BANDS);
      for (let t = 0; t < frames; t++) {
        const both = strong[i][t] & strong[j][t];
        for (let b = 0; both >>> b; b++) if ((both >>> b) & 1) hits[b]++;
      }
      for (let lo = 0; lo < BARK_BANDS; lo++) {
        if (hits[lo] / frames < MIN_SHARE_OF_TIME) continue;
        let hi = lo;
        while (hi + 1 < BARK_BANDS && hits[hi + 1] / frames >= MIN_SHARE_OF_TIME) hi++;
        let colliding = 0;
        let contested = 0;
        const range = ((1 << (hi - lo + 1)) - 1) << lo;
        for (let t = 0; t < frames; t++) {
          const both = strong[i][t] & strong[j][t] & range;
          if (!both) continue;
          colliding++;
          for (let b = lo; b <= hi; b++) contested += Math.min(list[i].frames[t][b], list[j].frames[t][b]);
        }
        const shareI = all[i] > 0 ? energyOf(i, lo, hi) / all[i] : 0;
        const shareJ = all[j] > 0 ? energyOf(j, lo, hi) / all[j] : 0;
        const [loser, keeper, loserShare, keeperShare] = shareI <= shareJ ? [list[i].name, list[j].name, shareI, shareJ] : [list[j].name, list[i].name, shareJ, shareI];
        const lowHz = BARK_EDGES_HZ[lo];
        const highHz = BARK_EDGES_HZ[hi + 1];
        const where = `${hzText(lowHz)}–${hzText(highHz)}`;
        const how = highHz <= 300
          ? `duck "${loser}" under "${keeper}" (a pump effect on "${loser}" with source "${keeper}"), or high-pass / cut "${loser}" below ${hzText(highHz)}`
          : `cut "${loser}" a few dB at ${where} (EQ), or move one of them: another octave, another register, or apart in the stereo field`;
        overlaps.push({
          a: list[i].name, b: list[j].name, lowHz, highHz, shareOfTime: r2(colliding / frames), overlapDb: r1(powDb(contested / Math.max(1, colliding))),
          yield: loser, yieldShare: r2(loserShare), keepShare: r2(keeperShare), suggestion: how, weight: contested
        });
        lo = hi;
      }
    }
  }
  overlaps.sort((x, y) => y.weight - x.weight);
  return {
    frames,
    overlaps: overlaps.slice(0, MAX_OVERLAPS).map(({ weight: _weight, ...o }) => o),
    stems: list.map((s, i) => ({ name: s.name, levelDb: r1(powDb(all[i] / frames)) }))
  };
}

/** The masking report as lines for a mix report (empty when there is nothing to say). */
export function describeMasking(m) {
  if (!m) return [];
  if (!m.overlaps.length) return ['Masking: no two stems are strong in the same band at the same time for more than 5 % of the render.'];
  const lines = ['Masking — stems that are strong in the same band at the same moment (worst first):'];
  for (const o of m.overlaps) {
    lines.push(`  "${o.a}" × "${o.b}"  ${hzText(o.lowHz)}–${hzText(o.highHz)}  ${Math.round(o.shareOfTime * 100)}% of the time, contested energy ${o.overlapDb} dB — that range is ${Math.round(o.yieldShare * 100)}% of "${o.yield}" and ${Math.round(o.keepShare * 100)}% of the other: ${o.suggestion}`);
  }
  return lines;
}

const signed = (x, digits = 1) => `${x > 0 ? '+' : ''}${digits === 2 ? r2(x) : r1(x)}`;
const BAND_LABELS = { sub: 'sub', low: 'low', lowMid: 'low-mid', mid: 'mid', highMid: 'high-mid', high: 'high' };

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * Compare two renders of a project. a = the earlier one, b = this one; each is
 * { hash, mix: an analysis (analyzeAudio), stems: [{ name, lufs }], limiter } — and b may carry
 * nullTest: { against: the hash of the render it was subtracted from, …nullTest() }, which counts when that is a.
 * Returns { identical (to the bit), same (to the bit, or nothing but rounding is left of the difference),
 * lines: what is different about b in words, deltas: b − a for the main numbers, nullTest }.
 * Differences below what a meter can honestly tell apart (0.3 LU, 0.3 dB, 2 points of a band) are not listed.
 */
export function compareRenders(a, b) {
  const x = a?.mix || {};
  const y = b?.mix || {};
  const d = (key) => (Number.isFinite(x[key]) && Number.isFinite(y[key]) ? y[key] - x[key] : null);
  const tpA = x.truePeakDb ?? x.peakDb;
  const tpB = y.truePeakDb ?? y.peakDb;
  const deltas = {
    seconds: d('duration'), lufs: d('lufs'), truePeakDb: Number.isFinite(tpA) && Number.isFinite(tpB) ? tpB - tpA : null, crestDb: d('crestDb'),
    loudnessRangeLu: d('loudnessRangeLu'),
    width: Number.isFinite(x.stereo?.width) && Number.isFinite(y.stereo?.width) ? y.stereo.width - x.stereo.width : null,
    centroidHz: Number.isFinite(x.spectrum?.centroidHz) && Number.isFinite(y.spectrum?.centroidHz) ? y.spectrum.centroidHz - x.spectrum.centroidHz : null
  };
  for (const k of Object.keys(deltas)) deltas[k] = deltas[k] === null ? null : r2(deltas[k]);
  const identical = !!a?.hash && a.hash === b?.hash;
  const nulled = b?.nullTest && a?.hash && b.nullTest.against === a.hash ? b.nullTest : null;
  if (identical) return { identical, same: true, lines: ['Bit-identical: the same audio, sample for sample. Whatever changed in between is not heard in this render.'], deltas, nullTest: nulled };
  // (no numbers on one side is not "no difference")
  if (!Number.isFinite(x.lufs) || !Number.isFinite(y.lufs)) {
    if (!nulled?.same) return { identical, same: false, lines: [`${Number.isFinite(y.lufs) ? 'the earlier render' : 'this render'} came back without its analysis: there is nothing to compare — render again`], deltas, nullTest: nulled };
  }
  if (nulled?.same) {
    const left = nulled.residualDb <= -200 ? 'nothing at 16 bits' : `${nulled.residualDb} dB relative to the mix`;
    return { identical, same: true, lines: [`The same audio: subtracting the earlier render leaves ${left} — the last bit of a browser's mixer, which is not the same from run to run, and nothing more. Whatever changed in between is not heard in this render.`], deltas, nullTest: nulled };
  }

  const lines = [];
  if (Math.abs(deltas.seconds ?? 0) >= 0.01) lines.push(`${r2(Math.abs(deltas.seconds))} s ${deltas.seconds > 0 ? 'longer' : 'shorter'}`);
  if (Math.abs(deltas.lufs ?? 0) >= 0.3) lines.push(`${r1(Math.abs(deltas.lufs))} LU ${deltas.lufs > 0 ? 'louder' : 'quieter'} (${x.lufs} → ${y.lufs} LUFS)`);
  if (Math.abs(deltas.truePeakDb ?? 0) >= 0.3) lines.push(`peaks ${r1(Math.abs(deltas.truePeakDb))} dB ${deltas.truePeakDb > 0 ? 'higher' : 'lower'} (true peak ${tpA} → ${tpB} dBTP)`);
  const clipA = x.clipping?.samples || 0;
  const clipB = y.clipping?.samples || 0;
  if (!clipA && clipB) lines.push(`now CLIPS (${clipB} samples); the earlier render did not`);
  else if (clipA && !clipB) lines.push('no longer clips');
  if (Math.abs(deltas.crestDb ?? 0) >= 0.8) lines.push(`${deltas.crestDb > 0 ? 'more dynamic' : 'more compressed'} (crest factor ${x.crestDb} → ${y.crestDb} dB)`);
  if (Math.abs(deltas.loudnessRangeLu ?? 0) >= 1) lines.push(`loudness range ${x.loudnessRangeLu} → ${y.loudnessRangeLu} LU`);
  const bandsA = x.spectrum?.bandsPercent || {};
  const bandsB = y.spectrum?.bandsPercent || {};
  const bands = Object.keys(BAND_LABELS).filter((k) => Number.isFinite(bandsA[k]) && Number.isFinite(bandsB[k]) && Math.abs(bandsB[k] - bandsA[k]) >= 2)
    .map((k) => `${BAND_LABELS[k]} ${signed(bandsB[k] - bandsA[k])} pts (${bandsA[k]} → ${bandsB[k]}%)`);
  if (bands.length) lines.push(`spectrum: ${bands.join(', ')}`);
  if (deltas.centroidHz !== null && x.spectrum.centroidHz > 0 && Math.abs(deltas.centroidHz) / x.spectrum.centroidHz >= 0.08) lines.push(`${deltas.centroidHz > 0 ? 'brighter' : 'darker'} (centroid ${x.spectrum.centroidHz} → ${y.spectrum.centroidHz} Hz)`);
  if (Math.abs(deltas.width ?? 0) >= 0.05) lines.push(`${deltas.width > 0 ? 'wider' : 'narrower'} (stereo width ${x.stereo.width} → ${y.stereo.width})`);
  const corr = Number.isFinite(x.stereo?.correlation) && Number.isFinite(y.stereo?.correlation) ? y.stereo.correlation - x.stereo.correlation : 0;
  if (Math.abs(corr) >= 0.1) lines.push(`stereo correlation ${x.stereo.correlation} → ${y.stereo.correlation}`);
  const lowW = Number.isFinite(x.stereo?.lowWidth) && Number.isFinite(y.stereo?.lowWidth) ? y.stereo.lowWidth - x.stereo.lowWidth : 0;
  if (Math.abs(lowW) >= 0.1) lines.push(`low end ${lowW > 0 ? 'wider' : 'more mono'} (width below 150 Hz ${x.stereo.lowWidth} → ${y.stereo.lowWidth})`);
  if (a?.limiter && b?.limiter && Math.abs(b.limiter.maxDb - a.limiter.maxDb) >= 1) lines.push(`master limiter works ${b.limiter.maxDb < a.limiter.maxDb ? 'harder' : 'less'} (max gain reduction ${a.limiter.maxDb} → ${b.limiter.maxDb} dB)`);

  const stemsA = new Map((a?.stems || []).map((s) => [s.name, s]));
  const stemsB = new Map((b?.stems || []).map((s) => [s.name, s]));
  const moved = [];
  for (const [name, s] of stemsB) {
    const was = stemsA.get(name);
    if (!was) moved.push(`"${name}" is new (${s.lufs} LUFS)`);
    else if (Number.isFinite(s.lufs) && Number.isFinite(was.lufs) && Math.abs(s.lufs - was.lufs) >= 1 && Math.max(s.lufs, was.lufs) > -60) moved.push(`"${name}" ${signed(s.lufs - was.lufs)} LU`);
  }
  for (const name of stemsA.keys()) if (!stemsB.has(name)) moved.push(`"${name}" is gone`);
  if (moved.length) lines.push(`stems: ${moved.join(', ')}`);
  const still = `loudness ${signed(deltas.lufs ?? 0, 2)} LU, true peak ${signed(deltas.truePeakDb ?? 0, 2)} dB, no band moved by 2 points`;
  if (nulled) {
    const where = nulled.worstAt === null ? '' : `, most of it around ${clock(nulled.worstAt)}`;
    const size = nulled.residualDb > -30 ? 'a clear change' : nulled.residualDb > -50 ? 'a moderate change' : 'a very small change';
    if (!lines.length) lines.push(`no meter moved (${still})`);
    // on average nothing is left, yet single samples differ: something short changed (a click, one hit, the end of a tail)
    if (nulled.residualDb <= SAME_AUDIO_DB && nulled.lengthDelta === 0) lines.push(`null test: a brief difference — averaged over the render what is left is at ${nulled.residualDb} dB (rounding), but single samples differ by up to ${nulled.peakDb} dBFS${where}: something short changed`);
    else lines.push(`null test: ${size} — what is left after subtracting the earlier render is at ${nulled.residualDb} dB relative to the mix (0 dB would be unrelated audio; below ${SAME_AUDIO_DB} dB is rounding)${where}`);
  } else if (!lines.length) {
    // (without the earlier render's samples there is no telling a change this small from the mixer's rounding)
    lines.push(`the same by every meter (${still}). Not bit-identical — but a browser sums its mixer in a different order from run to run, so that alone is not a change; a render straight after this one is null-tested against it and settles it`);
  }
  return { identical, same: false, lines, deltas, nullTest: nulled };
}


/** Seconds an effect of this type goes on sounding after its input has stopped (0 for those that do not). */
const EFFECT_TAILS = {
  reverb: (p) => p.decay ?? 2, algoverb: (p) => (p.freeze ? 0 : p.decay ?? 2.5), shimmer: (p) => p.decay ?? 6, resonator: (p) => p.decay ?? 3,
  delay: () => 3
};

/**
 * How long a song goes on sounding after its last bar, in seconds — what an export leaves room for instead of
 * cutting a bell or a hall off. The longest release among the instruments that play, plus most of the longest decay
 * among the effects that are on (a decay time is to −60 dB: two thirds of it reach −40 dB, where the export's final
 * fade takes over). Never under 2 s, never over 8 s.
 */
export function songTail(project) {
  let release = 0;
  for (const c of project?.channels || []) {
    const def = INSTRUMENTS[c.instrument?.kind];
    const params = c.instrument?.params || {};
    const seconds = def?.tail ? def.tail(params) : c.instrument?.kind === 'ggs' ? (params.env1R ?? 0.25) + (params.reverbMix > 0 ? 1.5 : 0) + (params.delayMix > 0 ? 1 : 0) : 0;
    if (seconds > release) release = seconds;
  }
  let decay = 0;
  for (const m of project?.mixer || []) {
    for (const fx of m.effects || []) {
      const seconds = fx.enabled !== false && EFFECT_TAILS[fx.type] ? Number(EFFECT_TAILS[fx.type](fx.params || {})) || 0 : 0;
      if (seconds > decay) decay = seconds;
    }
  }
  // (the longer of the two, and half of the other: a long release into a long hall is not both in full)
  const fx = 0.67 * decay;
  return Math.max(2, Math.min(8, Math.max(release, fx) + 0.5 * Math.min(release, fx)));
}
