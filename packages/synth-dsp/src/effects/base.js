// What every studio effect is built from. A studio effect is a plain class: made once (all memory is taken then),
// told its settings with set(), and asked to process stereo blocks in place. The same class runs in an AudioWorklet
// as a mixer insert and in Node for tests and measurements — so nothing here may touch the DOM, the clock or
// Math.random, and nothing may allocate while processing.

export const TAU = Math.PI * 2;
export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => (x > 1e-10 ? 20 * Math.log10(x) : -200);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** One-pole coefficient for a time constant in ms: y += c·(target − y) reaches 63 % of a step in that time. */
export const onepole = (ms, fs) => (ms <= 0 ? 1 : 1 - Math.exp(-1 / (ms * 0.001 * fs)));
/** A sample that is safe to pass on: finite, and not so loud that one bug downstream becomes a broken speaker (+24 dB). */
export const safe = (x) => (x > 15.85 ? 15.85 : x < -15.85 ? -15.85 : x === x ? x : 0);
/** Flush denormals: numbers this small cost time on some CPUs and are silence anyway. */
export const tiny = (v) => (v < 1e-30 && v > -1e-30 ? 0 : v);

// ---- parameter definitions (the same shape the instrument and effect catalogs use: they drive the knobs, the
// validation of what Claude sends, and the worklet's AudioParams)
export const num = (key, label, min, max, def, extra = {}) => ({ key, label, type: 'number', min, max, default: def, ...extra });
export const choice = (key, label, options, def, extra = {}) => ({ key, label, type: 'select', options, default: def, ...extra });
export const flag = (key, label, def, extra = {}) => ({ key, label, type: 'bool', default: def, ...extra });

/** Note lengths a tempo-synced effect can follow, and their length in beats. */
export const DIVISIONS = ['1/32', '1/16t', '1/16', '1/16d', '1/8t', '1/8', '1/8d', '1/4t', '1/4', '1/4d', '1/2', '1/1', '2/1'];
export function divisionBeats(div) {
  const m = /^(\d+)\/(\d+)([dt]?)$/.exec(String(div));
  if (!m) return 1;
  const beats = (4 * Number(m[1])) / Number(m[2]);
  return m[3] === 'd' ? beats * 1.5 : m[3] === 't' ? (beats * 2) / 3 : beats;
}

/** A value that glides to its target (one pole), so a knob that moves never clicks. */
export class Smoothed {
  constructor(value = 0, ms = 10, fs = 48000) {
    this.value = value;
    this.target = value;
    this.c = onepole(ms, fs);
  }

  time(ms, fs) { this.c = onepole(ms, fs); }
  set(target) { this.target = target; }
  snap(value) { this.value = value; this.target = value; }
  next() {
    this.value += this.c * (this.target - this.value);
    return this.value;
  }

  get settled() { return Math.abs(this.target - this.value) < 1e-7; }
}

/** A ring buffer read at any (fractional) distance behind the write position. */
export class DelayLine {
  constructor(maxSamples) {
    this.size = 1 << Math.ceil(Math.log2(Math.max(8, Math.ceil(maxSamples) + 4)));
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.max = Math.floor(maxSamples);
  }

  push(v) {
    this.buf[this.w] = v;
    this.w = (this.w + 1) & this.mask;
  }

  /** The sample pushed `delay` samples ago, counted before this sample is pushed (1 = the last one). Whole numbers only. */
  tap(delay) {
    return this.buf[(this.w - delay + this.size) & this.mask];
  }

  /** …at a fractional distance (linear interpolation). */
  read(delay) {
    const pos = this.w - delay + this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }

  /** …with a cubic through four points: for delays that move (chorus, flanger) without the dullness of a line. */
  cubic(delay) {
    const pos = this.w - delay + this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const b = this.buf;
    const m = this.mask;
    const y0 = b[(i - 1) & m];
    const y1 = b[i & m];
    const y2 = b[(i + 1) & m];
    const y3 = b[(i + 2) & m];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  clear() { this.buf.fill(0); }
}

/** A biquad (RBJ cookbook), transposed direct form II. One per channel. */
export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  /** type: lowpass | highpass | bandpass (0 dB peak) | notch | allpass | peaking | lowshelf | highshelf */
  design(type, fs, freq, q = Math.SQRT1_2, gainDb = 0) {
    const w = (TAU * clamp(freq, 1, fs * 0.49)) / fs;
    const cos = Math.cos(w);
    const sin = Math.sin(w);
    const alpha = sin / (2 * Math.max(0.01, q));
    const A = Math.pow(10, gainDb / 40);
    let b0; let b1; let b2; let a0; let a1; let a2;
    switch (type) {
      case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'allpass': b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
        a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
        a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
        break;
      }
      default: b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; // lowpass
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = tiny(this.b1 * x - this.a1 * y + this.z2);
    this.z2 = tiny(this.b2 * x - this.a2 * y);
    return y;
  }

  reset() { this.z1 = 0; this.z2 = 0; }
}

/**
 * The base of a studio effect.
 *   new X(sampleRate)          takes its memory
 *   set(values)                the whole settings object, or a part of it; unknown keys are ignored, numbers are
 *                              clamped to the definition. Cheap enough to call on every block (automation).
 *   clock(beat, bpm, playing)  where the song is at the first sample of the next block (tempo-synced effects)
 *   process(L, R, n)           n samples of each Float32Array, in place
 *   latency                    samples the output is late (look-ahead); 0 for most
 *   meter                      a number the studio shows next to the effect (gain reduction in dB), or null
 *   reset()                    forget everything that still rings
 * A subclass gives `static defs` (its parameter definitions) and reads its settings from this.p — after update(),
 * which is called whenever something in this.p changed.
 */
export class StudioFx {
  constructor(sampleRate) {
    this.fs = sampleRate;
    this.p = {};
    for (const d of this.constructor.defs) this.p[d.key] = d.default;
    this.beat = 0;
    this.bpm = 120;
    this.playing = false;
  }

  set(values) {
    let changed = false;
    for (const d of this.constructor.defs) {
      let v = values[d.key];
      if (v === undefined || v === null) continue;
      if (d.type === 'number') {
        v = Number(v);
        if (v !== v) continue;
        v = clamp(v, d.min, d.max);
      } else if (d.type === 'select') {
        if (!d.options.includes(v)) continue;
      } else v = !!v;
      if (this.p[d.key] !== v) { this.p[d.key] = v; changed = true; }
    }
    if (changed) this.update();
  }

  clock(beat, bpm, playing) {
    this.beat = beat;
    this.bpm = bpm;
    this.playing = playing;
  }

  update() {}
  reset() {}
  process() {}
  get latency() { return 0; }
  get meter() { return null; }
}
