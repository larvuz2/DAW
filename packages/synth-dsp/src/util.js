// Small numeric helpers shared by the GGS Synth engine. Everything here is allocation-free in the audio path.

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Integer hash → uint32 (a bit mixer: equal inputs give equal outputs on every machine, so renders repeat). */
export function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Deterministic value in [-1, 1) for a pair of integers (sample & hold LFOs, per-note random). */
export function hashBipolar(a, b = 0) {
  return hash32(hash32(a | 0) ^ Math.imul(b | 0, 0x9e3779b1)) / 2147483648 - 1;
}

/**
 * One block of zeroed memory, handed out as typed-array views. A typed array over 64 bytes gets its own off-heap
 * allocation — about 2 µs each, and a voice needs seventeen: 35 µs per note, which is heard when a big chord starts
 * inside one audio block. One buffer and seventeen views cost a tenth of that (measured).
 */
export class Arena {
  constructor(bytes) {
    this.buf = new ArrayBuffer(bytes);
    this.at = 0;
  }

  f64(n) {
    const a = new Float64Array(this.buf, this.at, n);
    this.at += n * 8;
    return a;
  }

  f32(n) {
    const a = new Float32Array(this.buf, this.at, n);
    this.at += Math.ceil(n / 2) * 8; // stay aligned for the Float64 views that follow
    return a;
  }
}

/** xorshift32 noise source. `next()` returns white noise in [-1, 1). */
export class Rng {
  constructor(seed = 1) {
    this.s = (hash32(seed) || 0x1234567) | 0;
  }

  next() {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s;
    return s / 2147483648;
  }

  /** Uniform in [0, 1). */
  unit() {
    return this.next() * 0.5 + 0.5;
  }
}

/** tanh-like saturator (Padé 3/2, exact slope 1 at 0, flat beyond ±3): ~10× cheaper than Math.tanh. */
export function softClip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

const fftTables = new Map();
function fftTable(n) {
  let t = fftTables.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((TAU * i) / n);
      sin[i] = Math.sin((TAU * i) / n);
    }
    const rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    fftTables.set(n, (t = { cos, sin, rev }));
  }
  return t;
}

/** In-place radix-2 FFT (forward, unnormalized) of re/im, length a power of two. */
export function fft(re, im) {
  const n = re.length;
  const { cos, sin, rev } = fftTable(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const wr = cos[k];
        const wi = -sin[k];
        const xr = re[j + half] * wr - im[j + half] * wi;
        const xi = re[j + half] * wi + im[j + half] * wr;
        re[j + half] = re[j] - xr;
        im[j + half] = im[j] - xi;
        re[j] += xr;
        im[j] += xi;
      }
    }
  }
}

/**
 * Coefficients of a polyphase IIR half-band filter (two chains of first-order all-passes, after Valenzuela &
 * Constantinides): `count` coefficients, `transition` = width of the transition band as a fraction of the sample
 * rate. Used for 2× oversampling: ~12 multiplies per stereo sample instead of ~100 for an FIR of the same quality.
 */
export function halfbandCoefs(count = 6, transition = 0.08) {
  let k = Math.tan((1 - transition * 2) * Math.PI / 4);
  k *= k;
  const kksqrt = Math.pow(1 - k * k, 0.25);
  const e = 0.5 * (1 - kksqrt) / (1 + kksqrt);
  const e4 = e * e * e * e;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const order = count * 2 + 1;
  const coefs = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const c = index + 1;
    let num = 0;
    for (let i = 0, j = 1; i < 64; i++, j = -j) {
      const term = Math.pow(q, i * (i + 1)) * Math.sin(((i * 2 + 1) * c * Math.PI) / order) * j;
      num += term;
      if (Math.abs(term) < 1e-100) break;
    }
    num *= Math.pow(q, 0.25);
    let den = 0.5;
    for (let i = 1, j = -1; i < 64; i++, j = -j) {
      const term = Math.pow(q, i * i) * Math.cos((i * 2 * c * Math.PI) / order) * j;
      den += term;
      if (Math.abs(term) < 1e-100) break;
    }
    let ww = num / den;
    ww *= ww;
    const x = Math.sqrt((1 - ww * k) * (1 - ww / k)) / (1 + ww);
    coefs[index] = (1 - x) / (1 + x);
  }
  return coefs;
}

/**
 * 2:1 decimator built on halfbandCoefs. `process(inL, inR, outL, outR, n)` reads 2n input frames and writes n.
 * Keeps its own state, so one instance per stereo stream.
 */
export class Decimator2 {
  /** mem: an Arena to take the state from (see Arena) — or none, for a decimator of its own. */
  constructor(coefs = DEFAULT_HALFBAND, mem = null) {
    this.c = coefs;
    const n = coefs.length;
    this.x = mem ? mem.f64(n * 2) : new Float64Array(n * 2);
    this.y = mem ? mem.f64(n * 2) : new Float64Array(n * 2);
  }

  reset() {
    this.x.fill(0);
    this.y.fill(0);
  }

  /** outOffset: where in outL/outR the n frames go; add: mix into the output instead of overwriting it. */
  process(inL, inR, outL, outR, n, add = false, outOffset = 0) {
    const c = this.c;
    const nc = c.length;
    const x = this.x;
    const y = this.y;
    for (let i = 0; i < n; i++) {
      const oi = outOffset + i;
      for (let ch = 0; ch < 2; ch++) {
        const src = ch ? inR : inL;
        const o = ch * nc;
        // even coefficients filter the later sample of the pair, odd ones the earlier: the two all-pass paths
        let s0 = src[2 * i + 1];
        let s1 = src[2 * i];
        for (let j = 0; j < nc; j += 2) {
          const t0 = (s0 - y[o + j]) * c[j] + x[o + j];
          x[o + j] = s0;
          y[o + j] = t0;
          s0 = t0;
          if (j + 1 < nc) {
            const t1 = (s1 - y[o + j + 1]) * c[j + 1] + x[o + j + 1];
            x[o + j + 1] = s1;
            y[o + j + 1] = t1;
            s1 = t1;
          }
        }
        const v = 0.5 * (s0 + s1);
        if (ch) { if (add) outR[oi] += v; else outR[oi] = v; } else if (add) outL[oi] += v; else outL[oi] = v;
      }
    }
    // after silence the all-pass states decay into denormal numbers (slow to compute): end the decay there
    for (let i = 0; i < y.length; i++) if (y[i] < 1e-30 && y[i] > -1e-30) y[i] = 0;
  }
}

/** 1:2 interpolator (the same half-band, run the other way). Writes 2n frames. */
export class Interpolator2 {
  constructor(coefs = DEFAULT_HALFBAND) {
    this.c = coefs;
    const n = coefs.length;
    this.x = new Float64Array(n * 2);
    this.y = new Float64Array(n * 2);
  }

  reset() {
    this.x.fill(0);
    this.y.fill(0);
  }

  process(inL, inR, outL, outR, n) {
    const c = this.c;
    const nc = c.length;
    const x = this.x;
    const y = this.y;
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const v = ch ? inR[i] : inL[i];
        const out = ch ? outR : outL;
        const o = ch * nc;
        let s0 = v;
        let s1 = v;
        for (let j = 0; j < nc; j += 2) {
          const t0 = (s0 - y[o + j]) * c[j] + x[o + j];
          x[o + j] = s0;
          y[o + j] = t0;
          s0 = t0;
          if (j + 1 < nc) {
            const t1 = (s1 - y[o + j + 1]) * c[j + 1] + x[o + j + 1];
            x[o + j + 1] = s1;
            y[o + j + 1] = t1;
            s1 = t1;
          }
        }
        out[2 * i] = s0;
        out[2 * i + 1] = s1;
      }
    }
  }
}

// 6 coefficients, transition 0.08·fs: at 2×44.1 kHz the pass band reaches 18.5 kHz and everything above 25.6 kHz
// (which would fold back below 18.5 kHz) is rejected by > 80 dB — measured in test/dsp.test.js
export const DEFAULT_HALFBAND = halfbandCoefs(6, 0.08);
