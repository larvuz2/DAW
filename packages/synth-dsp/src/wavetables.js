// Wavetables for the GGS Synth: every table is a row of single-cycle frames the oscillator scans with `position`.
//
// A frame is stored as its harmonic series (sine + cosine amplitudes), never as raw samples. From that series the
// engine builds band-limited copies ("mip levels") on demand, three per octave: a note only ever reads a copy whose
// highest harmonic is below Nyquist — no aliasing from the oscillator itself — and never loses more than the top
// third of an octave of brightness to stay there.
// Frames of one table share a phase convention, so cross-fading between neighbours never cancels.
import { fft, TAU } from './util.js';

export const FRAME = 2048; // samples per cycle
export const MAX_HARMONICS = 512; // level 0: the top harmonic still has 4 samples per cycle (clean cubic reads)
export const LEVELS_PER_OCTAVE = 3;
export const LEVELS = 9 * LEVELS_PER_OCTAVE + 1; // 512 harmonics down to 1
/** Harmonics kept by a mip level. */
const LEVEL_HARMONICS = Array.from({ length: LEVELS }, (_, level) => Math.max(1, Math.floor(MAX_HARMONICS * Math.pow(2, -level / LEVELS_PER_OCTAVE) + 1e-9)));
export const levelHarmonics = (level) => LEVEL_HARMONICS[level];
/** Sample data kept in memory at most (a level is rebuilt on demand in about a millisecond). */
const CACHE_BYTES = 48 * 1024 * 1024;
/** Each stored cycle is padded: one sample before and two after, so a 4-point read never wraps. */
export const STRIDE = FRAME + 3;
const TARGET_RMS = 0.32; // every frame is levelled to this (peak capped at 1): scanning doesn't jump in loudness

const H = MAX_HARMONICS;
const zero = () => ({ a: new Float64Array(H + 1), b: new Float64Array(H + 1) });

/** Frame from a harmonic recipe: fn(h) → sine amplitude, or [sine, cosine]. */
function additive(fn) {
  const s = zero();
  for (let h = 1; h <= H; h++) {
    const v = fn(h);
    if (Array.isArray(v)) { s.a[h] = v[0] || 0; s.b[h] = v[1] || 0; } else s.a[h] = v || 0;
  }
  return s;
}

/** Frame from a waveform fn(phase 0..1): sampled 4× finer than the frame, so its own aliases stay out. */
function sampled(fn) {
  const n = FRAME * 4;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = fn(i / n);
  fft(re, im);
  const s = zero();
  for (let h = 1; h <= H; h++) {
    s.b[h] = (2 * re[h]) / n;
    s.a[h] = (-2 * im[h]) / n;
  }
  return s;
}

/** Seeded pseudo-random 0..1 (table recipes must give the same table on every machine). */
function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const lerp = (a, b, x) => a + (b - a) * x;
const gauss = (x, w) => Math.exp(-0.5 * (x / w) * (x / w));
const odd = (h) => h % 2 === 1;
const saw = (h) => 1 / h;

/** Spectral envelope of a set of formants (Hz, bandwidth Hz, gain) for a voice at `f0`. */
const formants = (list, f0) => (h) => {
  let g = 0;
  for (const [f, bw, amp] of list) g += amp * gauss(h * f0 - f, bw);
  return g;
};
const VOWELS = {
  a: [[800, 90, 1], [1150, 100, 0.5], [2900, 140, 0.12], [3900, 160, 0.06]],
  e: [[400, 70, 1], [1800, 110, 0.35], [2600, 130, 0.18], [3600, 160, 0.06]],
  i: [[280, 60, 1], [2250, 110, 0.28], [2950, 130, 0.2], [3500, 150, 0.08]],
  o: [[450, 70, 1], [800, 90, 0.45], [2830, 130, 0.06], [3800, 160, 0.03]],
  u: [[325, 60, 1], [700, 80, 0.3], [2700, 130, 0.04], [3800, 160, 0.02]]
};

// ---------------------------------------------------------------------------------------------------------------
// The bank. frames = how many key frames the recipe makes; x runs 0..1 across them.

const DEFS = {
  basic: {
    name: 'Basic Shapes', frames: 5,
    description: 'Sine → triangle → saw → square → narrow pulse. Position 0 sine, 0.25 triangle, 0.5 saw, 0.75 square, 1 pulse.',
    build: (x, i) => [
      () => additive((h) => (h === 1 ? 1 : 0)),
      () => additive((h) => (odd(h) ? ((h - 1) / 2) % 2 ? -1 / (h * h) : 1 / (h * h) : 0)),
      () => additive(saw),
      () => additive((h) => (odd(h) ? 1 / h : 0)),
      () => additive((h) => [(1 - Math.cos(TAU * h * 0.125)) / h, Math.sin(TAU * h * 0.125) / h])
    ][i]()
  },
  tilt: {
    name: 'Dark to Bright', frames: 9,
    description: 'A saw whose brightness tilts: rounded and dark at 0, a plain saw in the middle, thin and buzzy at 1.',
    build: (x) => additive((h) => Math.pow(h, -lerp(2.2, 0.35, x)))
  },
  pwm: {
    name: 'Pulse Width', frames: 16,
    description: 'Pulse wave from 50% (square) at 0 down to a 4% needle at 1 — sweep position for PWM.',
    build: (x) => {
      const d = lerp(0.5, 0.04, x);
      return additive((h) => [(1 - Math.cos(TAU * h * d)) / h, Math.sin(TAU * h * d) / h]);
    }
  },
  resonant: {
    name: 'Resonant Sweep', frames: 24,
    description: 'A saw with a sharp resonance that climbs from the fundamental to the 40th harmonic: scanning sounds like a filter sweep baked into the oscillator.',
    build: (x) => {
      const center = 1 + 39 * x * x;
      return additive((h) => (1 / h) * (1 + 7 * gauss(h - center, 0.6 + center * 0.04)));
    }
  },
  formant: {
    name: 'Vowels', frames: 5,
    description: 'Sung vowels A – E – I – O – U (formants of a low voice). Slow position movement talks.',
    build: (x, i) => {
      const env = formants(VOWELS['aeiou'[i]], 130);
      return additive((h) => env(h) + 0.02 / h);
    }
  },
  glass: {
    name: 'Spectral Glass', frames: 12,
    description: 'Sparse, widely spaced partials that shimmer as the position moves: glassy pads, bells and keys.',
    build: (x) => {
      const set = [1, 4, 7, 11, 16, 22, 29, 37];
      return additive((h) => {
        const k = set.indexOf(h);
        if (k < 0) return 0;
        const focus = x * (set.length - 1);
        return (0.25 + gauss(k - focus, 1.3)) / (1 + k * 0.35);
      });
    }
  },
  fmbell: {
    name: 'FM Bell', frames: 16,
    description: 'Two-operator FM at ratio 1:3 with the index rising 0 → 7: pure at 0, clangorous at 1.',
    build: (x) => sampled((p) => Math.sin(TAU * p + 7 * x * Math.sin(TAU * 3 * p)))
  },
  fmgrowl: {
    name: 'FM Growl', frames: 16,
    description: 'FM at ratios 1:1 and 1:2 with a rising index: from a sine through hollow vowels to a snarl.',
    build: (x) => sampled((p) => Math.sin(TAU * p + 5 * x * Math.sin(TAU * p) + 2.5 * x * x * Math.sin(TAU * 2 * p)))
  },
  drawbar: {
    name: 'Drawbars', frames: 6,
    description: 'Tonewheel organ registrations from a single flute stop to full organ.',
    build: (x, i) => {
      // harmonics 1 2 3 4 5 6 8 = the 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′ drawbars
      const reg = [[8, 0, 0, 0, 0, 0, 0], [8, 6, 0, 0, 0, 0, 0], [8, 8, 6, 0, 0, 0, 0], [8, 6, 8, 5, 0, 0, 3], [8, 8, 8, 6, 4, 4, 5], [8, 8, 8, 8, 8, 8, 8]][i];
      const hs = [1, 2, 3, 4, 5, 6, 8];
      return additive((h) => (hs.includes(h) ? reg[hs.indexOf(h)] / 8 : 0));
    }
  },
  sync: {
    name: 'Sync Sweep', frames: 24,
    description: 'An oscillator hard-synced to the note, its own pitch climbing 1× → 8×: the classic tearing sync lead when scanned.',
    build: (x) => {
      const r = 1 + 7 * x;
      // the slave restarts every cycle; a short window at the end keeps the restart from clicking
      return sampled((p) => Math.sin(TAU * r * p) * Math.min(1, (1 - p) * 12));
    }
  },
  fold: {
    name: 'Wavefolder', frames: 16,
    description: 'A sine pushed through a wavefolder with rising gain: warm at 0, dense west-coast harmonics at 1.',
    build: (x) => sampled((p) => Math.sin((1 + 7 * x) * (Math.PI / 2) * Math.sin(TAU * p)))
  },
  metal: {
    name: 'Metallic', frames: 12,
    description: 'Partials spaced like a struck metal bar; position moves the energy from the low to the high modes.',
    build: (x) => {
      const set = [1, 3, 5, 9, 13, 19, 26, 34, 43];
      return additive((h) => {
        const k = set.indexOf(h);
        if (k < 0) return 0;
        return (0.2 + gauss(k - x * (set.length - 1), 1.6)) * (k % 2 ? -1 : 1);
      });
    }
  },
  airy: {
    name: 'Airy Choir', frames: 8,
    description: 'Breathy, choir-like spectra with soft formants that drift between frames.',
    build: (x) => {
      const r = rnd(7919);
      const ripple = Array.from({ length: H + 1 }, () => [0.4 + 0.6 * r(), 0.4 + 0.6 * r()]);
      const env = formants([[lerp(500, 750, x), 160, 1], [lerp(1100, 1500, x), 220, 0.5], [2800, 300, 0.15]], 130);
      return additive((h) => env(h) * lerp(ripple[h][0], ripple[h][1], x) + 0.05 / (h * h));
    }
  },
  ladder: {
    name: 'Harmonic Ladder', frames: 16,
    description: 'One overtone at a time: frame n is harmonic n over a soft fundamental. Scan it for overtone-flute and throat-singing effects.',
    build: (x, i) => additive((h) => (h === i + 1 ? 1 : h === 1 ? 0.35 : 0))
  },
  primes: {
    name: 'Primes', frames: 8,
    description: 'Only prime-numbered harmonics, more of them as the position rises: hollow, slightly alien.',
    build: (x) => {
      const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
      const count = 2 + x * (primes.length - 2);
      return additive((h) => {
        if (h === 1) return 1;
        const k = primes.indexOf(h);
        return k >= 0 && k < count ? Math.min(1, count - k) * 0.9 / Math.sqrt(k + 1) : 0;
      });
    }
  },
  octaves: {
    name: 'Octave Stack', frames: 6,
    description: 'Octaves piled on a sine: 1, +2, +4, +8, +16, +32. Organ-pure and very stable under FM.',
    build: (x, i) => additive((h) => {
      const k = Math.log2(h);
      return Number.isInteger(k) && k <= i ? 1 / (1 + k * 0.5) : 0;
    })
  },
  comb: {
    name: 'Comb Saw', frames: 16,
    description: 'A saw with comb-filter notches sliding through the spectrum: phaser-like movement without a phaser.',
    build: (x) => additive((h) => (1 / h) * Math.abs(Math.cos(Math.PI * h * lerp(0.02, 0.24, x))))
  },
  staircase: {
    name: 'Staircase', frames: 8,
    description: 'A saw quantized to fewer and fewer steps (256 → 2): clean at 0, 8-bit crunchy at 1.',
    build: (x, i) => {
      const steps = Math.pow(2, 8 - i);
      return sampled((p) => (Math.floor(p * steps) + 0.5) / steps * 2 - 1);
    }
  },
  tine: {
    name: 'Tine', frames: 8,
    description: 'Electric-piano tine: a round fundamental with a bell partial that grows with position (map velocity or pressure to it).',
    build: (x) => additive((h) => (h === 1 ? 1 : h === 2 ? 0.18 + 0.2 * x : 0) + x * 0.5 * gauss(h - 14, 2.2) + 0.03 * x / h)
  },
  bowed: {
    name: 'Bowed String', frames: 8,
    description: 'A saw shaped by body resonances; position is bow pressure, from flautando to a hard, bright bow.',
    build: (x) => additive((h) => Math.pow(h, -lerp(1.7, 0.85, x)) * (1 + 1.2 * gauss(h - 3, 1) + 0.9 * gauss(h - 7, 1.4) + 0.6 * gauss(h - 13, 2.5)) * (h % 2 ? 1 : lerp(0.55, 1, x)))
  },
  reed: {
    name: 'Reed', frames: 8,
    description: 'Odd harmonics (clarinet) at 0, even harmonics joining toward a saxophone-like reed at 1.',
    build: (x) => additive((h) => (odd(h) ? 1 : x) * Math.pow(h, -lerp(1.5, 1.05, x)) * (1 + 0.8 * gauss(h - lerp(5, 9, x), 2)))
  },
  dust: {
    name: 'Digital Dust', frames: 8,
    description: 'Seeded random spectra: gritty, inharmonic-sounding digital textures, a different one at every position.',
    build: (x, i) => {
      const r = rnd(104729 + i * 31);
      return additive((h) => [(r() * 2 - 1) * Math.pow(h, -0.8), (r() * 2 - 1) * Math.pow(h, -0.8)]);
    }
  },
  hollow: {
    name: 'Hollow', frames: 8,
    description: 'A saw with every 2nd, then every 3rd, 4th … harmonic removed: woody, pipe-like tones.',
    build: (x, i) => additive((h) => (h % (i + 2) === 0 ? 0 : 1 / h))
  },
  supersine: {
    name: 'Soft Harmonics', frames: 8,
    description: 'A sine that gently grows its first eight harmonics: sub basses and mellow keys that open up with position.',
    build: (x) => additive((h) => (h === 1 ? 1 : h <= 8 ? x * Math.pow(h, -1.4) : x * x * 0.3 * Math.pow(h, -2)))
  }
};

export const WAVETABLE_IDS = Object.keys(DEFS);

/** What an agent or a menu needs to pick a table. */
export function describeWavetables() {
  return WAVETABLE_IDS.map((id) => ({ id, name: DEFS[id].name, frames: DEFS[id].frames, description: DEFS[id].description }));
}

const cache = new Map();
const built = []; // [table, level] in the order they were built or last noticed, oldest first
let cachedBytes = 0;
let clock = 0;
const scratchRe = new Float64Array(FRAME);
const scratchIm = new Float64Array(FRAME);

/** Write one cycle of a harmonic series (first `harmonics` only) into re[]. */
function synthesize(spec, harmonics) {
  scratchRe.fill(0);
  scratchIm.fill(0);
  const hmax = Math.min(harmonics, H);
  // x[n] = Σ a·sin + b·cos = Re(Σ (b − ja)·e^{+jθ}); an inverse transform is a forward one of the conjugate
  for (let h = 1; h <= hmax; h++) {
    scratchRe[h] = spec.b[h];
    scratchIm[h] = spec.a[h];
  }
  fft(scratchRe, scratchIm);
  return scratchRe;
}

/** The table `id` (built once per JS realm): { id, frames, spectra, levels[] }. Unknown ids fall back to `basic`. */
export function getWavetable(id) {
  let t = cache.get(id);
  if (t) return t;
  const def = DEFS[id] || DEFS.basic;
  const spectra = [];
  for (let i = 0; i < def.frames; i++) {
    const s = def.build(def.frames > 1 ? i / (def.frames - 1) : 0, i);
    s.a[0] = s.b[0] = 0; // no DC
    let power = 0;
    for (let h = 1; h <= H; h++) power += s.a[h] * s.a[h] + s.b[h] * s.b[h];
    const rms = Math.sqrt(power / 2) || 1;
    const wave = synthesize(s, H);
    let peak = 0;
    for (let n = 0; n < FRAME; n++) peak = Math.max(peak, Math.abs(wave[n]));
    const gain = Math.min(TARGET_RMS / rms, 1 / (peak || 1));
    for (let h = 1; h <= H; h++) { s.a[h] *= gain; s.b[h] *= gain; }
    spectra.push(s);
  }
  t = { id: DEFS[id] ? id : 'basic', frames: def.frames, spectra, levels: new Array(LEVELS).fill(null), used: new Float64Array(LEVELS) };
  cache.set(id, t);
  return t;
}

/** Band-limited sample data of one mip level: frames × STRIDE floats (built on first use). */
export function tableLevel(table, level) {
  let data = table.levels[level];
  table.used[level] = ++clock;
  if (data) return data;
  data = new Float32Array(table.frames * STRIDE);
  const harmonics = levelHarmonics(level);
  for (let f = 0; f < table.frames; f++) {
    const wave = synthesize(table.spectra[f], harmonics);
    const o = f * STRIDE;
    data[o] = wave[FRAME - 1];
    for (let n = 0; n < FRAME; n++) data[o + 1 + n] = wave[n];
    data[o + 1 + FRAME] = wave[0];
    data[o + 2 + FRAME] = wave[1];
  }
  table.levels[level] = data;
  built.push([table, level]);
  cachedBytes += data.byteLength;
  // over budget: forget the copies that haven't been read for the longest time (never the one just built)
  while (cachedBytes > CACHE_BYTES && built.length > 1) {
    let oldest = 0;
    for (let i = 1; i < built.length - 1; i++) if (built[i][0].used[built[i][1]] < built[oldest][0].used[built[oldest][1]]) oldest = i;
    const [t, l] = built.splice(oldest, 1)[0];
    cachedBytes -= t.levels[l].byteLength;
    t.levels[l] = null;
  }
  return data;
}

/**
 * The mip level for a phase increment (cycles per sample at the rate whose Nyquist must not be crossed): the
 * richest copy whose top harmonic still fits under it.
 */
export function levelFor(inc) {
  const allowed = 0.5 / inc;
  let l = Math.ceil(LEVELS_PER_OCTAVE * Math.log2(MAX_HARMONICS / allowed));
  if (l < 0) return 0;
  if (l >= LEVELS) return LEVELS - 1;
  // levels hold whole numbers of harmonics: settle on the richest one that really fits
  if (l >= LEVELS) return LEVELS - 1;
  if (LEVEL_HARMONICS[l] > allowed) l++;
  while (l > 0 && l < LEVELS && LEVEL_HARMONICS[l - 1] <= allowed) l--;
  return l >= LEVELS ? LEVELS - 1 : l;
}

/** One cycle of a table at a position, as `points` samples (for drawing; uses a mid-bandwidth copy). */
export function wavetablePreview(id, position = 0, points = 128) {
  const t = getWavetable(id);
  const data = tableLevel(t, 3 * LEVELS_PER_OCTAVE);
  const fp = Math.max(0, Math.min(1, position)) * (t.frames - 1);
  const f0 = Math.floor(fp);
  const f1 = Math.min(t.frames - 1, f0 + 1);
  const w = fp - f0;
  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const n = Math.floor((i / points) * FRAME);
    out[i] = lerp(data[f0 * STRIDE + 1 + n], data[f1 * STRIDE + 1 + n], w);
  }
  return out;
}

/** Harmonic amplitudes (first `count`) of a table at a position, 0..1 relative to the loudest: for spectrum views. */
export function wavetableSpectrum(id, position = 0, count = 64) {
  const t = getWavetable(id);
  const fp = Math.max(0, Math.min(1, position)) * (t.frames - 1);
  const f0 = Math.floor(fp);
  const f1 = Math.min(t.frames - 1, f0 + 1);
  const w = fp - f0;
  const out = new Float32Array(count);
  let max = 1e-9;
  for (let h = 1; h <= count; h++) {
    const a = lerp(t.spectra[f0].a[h], t.spectra[f1].a[h], w);
    const b = lerp(t.spectra[f0].b[h], t.spectra[f1].b[h], w);
    out[h - 1] = Math.hypot(a, b);
    if (out[h - 1] > max) max = out[h - 1];
  }
  for (let i = 0; i < count; i++) out[i] /= max;
  return out;
}

/**
 * Build the wavetables a patch uses (and the sub oscillator's) ahead of its first note. Building one takes tens of
 * milliseconds — far longer than an audio block — so it must not happen when a note starts: the channel's effects
 * processor calls this when it is created and when the patch changes.
 */
export function prewarmTables(params) {
  getWavetable('basic');
  for (const x of ['A', 'B', 'C']) {
    const id = params?.[`osc${x}Table`];
    if (typeof id === 'string' && DEFS[id]) getWavetable(id);
  }
}
