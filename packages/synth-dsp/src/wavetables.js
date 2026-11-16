// Wavetables for the GGS Synth: every table is a row of single-cycle frames the oscillator scans with `position`.
//
// A frame is stored as its harmonic series (sine + cosine amplitudes), never as raw samples. From that series the
// engine builds band-limited copies ("mip levels") on demand, three per octave: a note only ever reads a copy whose
// highest harmonic is below Nyquist — no aliasing from the oscillator itself — and never loses more than the top
// third of an octave of brightness to stay there.
// Frames of one table share a phase convention, so cross-fading between neighbours never cancels.
import { fft, clamp, hashBipolar, TAU } from './util.js';

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

// Helpers of the recipes that came from the Rust synth (the tables after `supersine`).

const fract = (x) => x - Math.floor(x);
/** Seeded 0..1 for harmonic h: the same in every frame of a table, so random phases never cancel in a cross-fade. */
const hash01 = (h, salt) => hashBipolar(h, salt) * 0.5 + 0.5;
/** [sine, cosine] amplitudes of a partial turned by `cycles` (0.25 makes a sine a cosine). */
const turned = (amp, cycles) => [amp * Math.cos(TAU * cycles), amp * Math.sin(TAU * cycles)];

/** Smooth seeded noise -1..1 along x: random values at the whole numbers, eased in between. */
function valueNoise(x) {
  const i = Math.floor(x);
  const t = x - i;
  return lerp(hashBipolar(i, 131), hashBipolar(i + 1, 131), t * t * (3 - 2 * t));
}

/** Like formants(), with the long skirts of a real resonance (Lorentzian peaks; bandwidth = width at half height). */
const resonances = (list, f0) => (h) => {
  let g = 0;
  for (const [f, bw, amp] of list) {
    const d = (h * f0 - f) / (0.5 * bw);
    g += amp / (1 + d * d);
  }
  return g;
};
/** First three formants (Hz) of spoken vowels (Peterson & Barney). */
const SPOKEN = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010], o: [570, 840, 2410], u: [300, 870, 2240] };
/** The three formants at x (0..1) along a path of vowels such as 'oae': each glides in log frequency. */
function vowelGlide(path, x) {
  const at = clamp(x, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(at));
  const to = SPOKEN[path[i + 1]];
  return SPOKEN[path[i]].map((f, n) => f * Math.pow(to[n] / f, at - i));
}

/** A frame pushed through a waveshaper fn(v), v = its wave with the peak at ±1 (4× finer than the frame, like sampled). */
function shaped(s, fn) {
  const n = FRAME * 4;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let h = 1; h <= H; h++) { re[h] = s.b[h]; im[h] = s.a[h]; } // the inverse transform of synthesize()
  fft(re, im);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]));
  if (peak < 1e-9) return s;
  return sampled((p) => fn(re[Math.round(p * n)] / peak));
}

/** The FM growl under every frame of `vowelbass`: analysed on the first frame, instead of once per frame. */
let growl = null;

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
  },

  // -------------------------------------------------------------------------------------------------------------
  // Ported from the factory set of the Rust synth (crates/oscillators/src/factory.rs there): the tables this bank
  // had no equivalent of, in that set's order. The recipes are the same; the sizes are this bank's — 512 harmonics
  // instead of 1024 and 8–24 frames instead of 48–64, so a sweep of a narrow peak or a moving edge is coarser here.
  // Random levels and phases come from hash01 (one value per harmonic, kept through the frames).
  oddeven: {
    name: 'Odd / Even', frames: 9,
    description: 'A saw with an odd/even balance: only odd harmonics (square-like, hollow) at 0, a full saw at 0.5, mostly even ones at 1 — a saw an octave up over its fundamental.',
    build: (x) => {
      const odds = x <= 0.5 ? 1 : 1 - 1.8 * (x - 0.5);
      const evens = Math.min(1, 2 * x);
      return additive((h) => (h === 1 ? 1 : odd(h) ? odds : evens) / h);
    }
  },
  lofi: {
    name: 'Lo-Fi Sine', frames: 16,
    description: 'A sine that is sample-held and bit-crushed harder and harder: nearly clean at 0, a coarse, stepped chiptune buzz at 1.',
    build: (x) => {
      const levels = Math.pow(2, lerp(5, 1.2, x));
      const steps = Math.pow(2, lerp(7, 2.6, x));
      return sampled((p) => {
        const v = Math.sin(TAU * (Math.floor(p * steps) + 0.5) / steps) * levels;
        return Math.sign(v) * Math.round(Math.abs(v)) / levels; // halves round away from zero: both sides crush alike
      });
    }
  },
  phasedist: {
    name: 'Phase Distortion', frames: 16,
    description: 'CZ-style phase distortion: a cosine read faster and faster through its first half. A sine at 0, a bright saw with a glassy digital edge at 1.',
    build: (x) => {
      const knee = 0.5 - 0.48 * x;
      return sampled((p) => -Math.cos(TAU * (p < knee ? 0.5 * p / knee : 0.5 + 0.5 * (p - knee) / (1 - knee))));
    }
  },
  cheby: {
    name: 'Chebyshev', frames: 24,
    description: 'Cosine harmonics added one per frame (what Chebyshev waveshaping of a cosine gives): a sine at 0, a buzzy 24-harmonic pulse at 1, like opening a brick-wall filter.',
    build: (x, i) => additive((h) => [0, h <= i + 1 ? 1 / h : 0])
  },
  pluck: {
    name: 'Plucked String', frames: 16,
    description: 'The spectrum of a plucked string as it rings out: the bright attack at 0, the mellow, nearly sine tail at 1. Sweep position with an envelope for plucks.',
    build: (x) => {
      const damping = lerp(0.0005, 0.6, Math.pow(x, 1.5));
      // plucked at 18% of its length; the higher a harmonic, the faster it dies
      return additive((h) => Math.sin(Math.PI * h * 0.18) / h * Math.exp(-damping * Math.pow(h, 1.3)));
    }
  },
  sawstack: {
    name: 'Saw Stack', frames: 12,
    description: 'Saws stacked in octaves and fifths (1× 2× 3× 4× 6× 8×), one more layer for every 0.18 of position: a single saw at 0, a thick organ of saws from 0.9 on.',
    build: (x) => {
      // [pitch, level, phase offset]: the offsets keep the edges of the layers apart
      const saws = [[1, 1, 0], [2, 0.8, 0.37], [3, 0.6, 0.71], [4, 0.5, 0.13], [6, 0.35, 0.59], [8, 0.3, 0.83]];
      return additive((h) => {
        const sum = [0, 0];
        saws.forEach(([pitch, level, offset], j) => {
          if (h % pitch) return;
          const n = h / pitch;
          const [s, c] = turned((j ? level * clamp(x * 5.5 - (j - 1), 0, 1) : 1) / n, n * offset);
          sum[0] += s;
          sum[1] += c;
        });
        return sum;
      });
    }
  },
  hiss: {
    name: 'Pitched Hiss', frames: 16,
    description: 'Pitched noise: harmonics with random levels and phases over a clean fundamental. Dark and almost a pure tone at 0, a bright, hissy buzz at 1.',
    build: (x) => additive((h) => (h === 1 ? 1 : turned((0.3 + 0.7 * hash01(h, 41)) * Math.pow(h, -lerp(2, 0, x)), hash01(h, 43))))
  },
  drift: {
    name: 'Ensemble Drift', frames: 24,
    description: 'A warm saw whose harmonics turn in phase at different speeds: sweeping position (it loops, 1 is 0 again) moves like a chorus from a single oscillator.',
    build: (x) => additive((h) => {
      if (h > 256) return 0;
      // whole turns (-2 … 2) across the table, so the last frame is the first again
      const turns = h === 1 ? 0 : Math.floor(hash01(h, 53) * 5) - 2;
      return turned(gauss(h, 140) / h, (h === 1 ? 0 : hash01(h, 59)) + turns * x);
    })
  },
  aurora: {
    name: 'Aurora', frames: 24,
    description: 'Three soft spectral peaks that drift in opposite directions and cross each other as position moves: an airy, slowly shifting pad.',
    build: (x) => {
      // where the peaks sit, in octaves above the fundamental: one climbs, one falls, one swings up and back
      const c1 = Math.log2(2 * Math.pow(4, x));
      const c2 = Math.log2(24 * Math.pow(3, -x));
      const c3 = Math.log2(6 + 30 * Math.pow(Math.sin(Math.PI * x), 2));
      return additive((h) => {
        if (h > 128) return 0;
        const l = Math.log2(h);
        const peaks = (gauss(l - c1, 0.35) + 0.8 * gauss(l - c2, 0.35) + 0.6 * gauss(l - c3, 0.3)) / Math.sqrt(h);
        return h === 1 ? 0.8 + peaks : turned(peaks, hash01(h, 61));
      });
    }
  },
  brass: {
    name: 'Brass Swell', frames: 16,
    description: 'A brass section whose brightness follows position: a muted, round horn at 0, a blaring fortissimo at 1. Drive position with an envelope for swells and stabs.',
    build: (x) => {
      const cutoff = 1.5 * Math.pow(40 / 1.5, x);
      return additive((h) => {
        const r = h / cutoff;
        // a saw through three low-pass poles (level and phase), with the horn's formant around the 7th harmonic
        return turned(Math.pow(1 + r * r, -1.5) * (1 + 0.8 * gauss(h - 7, 2.5)) / h, -3 * Math.atan(r) / TAU);
      });
    }
  },
  reese: {
    name: 'Reese Bass', frames: 24,
    description: 'Three saturated saws caught at one instant of their beating: sweep position (it loops, 1 is 0 again) for the hollow, phasing movement of a detuned Reese bass.',
    // a still saw and two that slide past it (one turn forward, two turns back). Harmonic h of a sliding saw turns h
    // times across the table and the frames only carry a few turns, so the sliding saws are low-passed
    build: (x) => shaped(additive((h) => {
      if (h > 64) return 1 / h;
      const one = turned(1 / (h * (1 + Math.pow(h / 8, 4))), h * x);
      const two = turned(0.6 / (h * (1 + Math.pow(h / 4, 4))), h * (0.31 - 2 * x));
      return [1 / h + one[0] + two[0], one[1] + two[1]];
    }), (v) => Math.tanh(1.6 * v))
  },
  acid: {
    name: 'Acid', frames: 24,
    description: 'An overdriven square through a screaming resonant low-pass, 303 style: position opens the cutoff from a rubbery thud at 0 to a squeal at 1.',
    build: (x) => {
      const cutoff = 1.5 * Math.pow(40, x);
      // the filter (Q 8) only as its level curve: the phase turn of a real one would differ from frame to frame around
      // the resonance, and the cross-fade between frames would dip there
      const lowpass = (r) => 1 / Math.hypot(1 - r * r, r / 8);
      return shaped(additive((h) => (odd(h) ? lowpass(h / cutoff) / h : 0)), (v) => Math.tanh(2.2 * v));
    }
  },
  overdrive: {
    name: 'Overdrive', frames: 8,
    description: 'A sine driven into lopsided saturation, gain 1× → 40×: a round sub at 0, warm tube-like grit in the middle, a hard-clipped fuzzy square at 1.',
    build: (x) => {
      const gain = Math.pow(40, x);
      return sampled((p) => Math.tanh(gain * (Math.sin(TAU * p) + 0.25 * x * Math.sin(2 * TAU * p + 0.5))));
    }
  },
  vowelbass: {
    name: 'Vowel Bass', frames: 24,
    description: 'A distorted FM bass through narrow vowel formants: the mouth goes from "oh" at 0 through "ah" at 0.5 to "eh" at 1, for talking growls.',
    build: (x) => {
      const [f1, f2, f3] = vowelGlide('oae', x);
      const mouth = resonances([[f1, 70, 1], [f2, 90, 0.8], [f3, 160, 0.4]], 80);
      if (!growl) growl = sampled((p) => Math.sin(TAU * p + 4 * Math.sin(2 * TAU * p + 1.5 * Math.sin(TAU * p))));
      const s = zero();
      for (let h = 1; h <= 200; h++) {
        const g = 0.12 + mouth(h);
        s.a[h] = growl.a[h] * g;
        s.b[h] = growl.b[h] * g;
      }
      return shaped(s, (v) => Math.tanh(2.5 * v));
    }
  },
  crystal: {
    name: 'Crystal', frames: 16,
    description: 'Icy partials at octaves and their fifths only. Position moves the energy upward while single partials twinkle: music boxes and glass pads.',
    build: (x) => additive((h) => {
      const octave = h % 3 ? h : h / 3;
      if (octave & (octave - 1)) return 0; // only 1 2 4 8 … and 3 6 12 24 …
      // each partial swells and fades one to three times across the table
      const twinkle = h === 1 ? 1 : 0.6 + 0.4 * Math.cos(TAU * ((1 + Math.floor(hash01(h, 71) * 3)) * x + hash01(h, 73)));
      return turned(twinkle * Math.pow(h, -lerp(1.6, 0.25, x)), hash01(h, 79));
    })
  },
  bitlogic: {
    name: 'Bit Logic', frames: 24,
    description: 'A square wave mixed with its XOR against a second, faster square whose pitch climbs 1× → 8×: robotic, glitchy pulse patterns.',
    build: (x) => {
      const ratio = Math.pow(8, x);
      const sq = (p) => (fract(p) < 0.5 ? 1 : -1);
      // the fast square is anchored at the middle of the cycle: its edges move half as far per frame as from the start
      return sampled((p) => 0.6 * sq(p) + 0.4 * sq(p) * sq((p - 0.5) * ratio + 0.25));
    }
  },
  talkbox: {
    name: 'Formant Sweep', frames: 24,
    description: 'A pulse train through one sharp resonance that climbs from the 2nd to the 48th harmonic: "wow" and talk-box sweeps.',
    build: (x) => {
      const centre = 2 * Math.pow(24, x);
      const width = 0.1 * centre + 0.5;
      return additive((h) => {
        if (h > 256) return 0;
        const d = (h - centre) / width;
        return turned((0.03 + 1 / (1 + d * d)) / Math.sqrt(h), 0.25 - Math.atan(d) / TAU);
      });
    }
  },
  whisper: {
    name: 'Whisper', frames: 8,
    description: 'A whispered voice: mostly noise-like high partials shaped by vowel formants, over a faint fundamental. A bright "ah" at 0, a darker "oh" at 1.',
    build: (x) => {
      const [f1, f2, f3] = vowelGlide('ao', x);
      const mouth = resonances([[f1, 300, 1], [f2, 380, 0.8], [f3, 600, 0.5]], 150);
      return additive((h) => {
        if (h > 400) return 0;
        const air = Math.pow(h, -0.6) * (0.05 + mouth(h)) * gauss(h, 260);
        return h === 1 ? 0.35 + air : turned(air * (0.5 + hash01(h, 83)), hash01(h, 89));
      });
    }
  },
  ringmod: {
    name: 'Ring Mod', frames: 12,
    description: 'A sine ring-modulated by a second sine, one ratio per frame from 1× to 12× the pitch: clean bell and robot tones that step through the harmonics.',
    build: (x, i) => sampled((p) => Math.sin(TAU * p) * (0.3 + 0.7 * Math.sin(TAU * (i + 1) * p + 0.7)))
  },
  trifold: {
    name: 'Triangle Folder', frames: 24,
    description: 'A triangle through a hard, mirroring wavefolder, gain 1× → 10×: a plain triangle at 0, a bright, nasal, many-cornered wave at 1.',
    build: (x) => {
      const tri = (p) => 1 - 4 * Math.abs(fract(p + 0.25) - 0.5);
      return sampled((p) => tri(0.25 * (1 + 9 * x) * tri(p)));
    }
  },
  vosim: {
    name: 'VOSIM', frames: 23,
    description: 'A sine burst under a smooth window (a formant oscillator), the burst climbing from 1× to 12× the pitch: one clean, moving vocal formant without the ring of a filter. High positions have no fundamental, so the top octaves thin out there.',
    // the burst is anchored at the middle of the window: its spectrum is a bump that slides along the harmonics
    // without turning their phases, so neighbouring frames only differ in level. 23 frames: every second one sits
    // on a whole ratio, where the bump is just three harmonics
    build: (x) => sampled((p) => Math.cos(TAU * (1 + 11 * x) * (p - 0.5)) * (0.5 - 0.5 * Math.cos(TAU * p)))
  },
  darkmatter: {
    name: 'Dark Matter', frames: 12,
    description: 'A dark drone whose low overtones (none above the 48th) swell and fade irregularly as position moves, like slowly turning a prism. Never bright, always shifting.',
    build: (x) => additive((h) => {
      if (h === 1) return 1;
      if (h > 48) return 0;
      // every frame is another slice of one smooth noise landscape
      const field = 0.5 + 0.5 * valueNoise(h * 0.61 + x * 3 + 17);
      return turned(field * field * Math.pow(h, -1.1), hash01(h, 97));
    })
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
