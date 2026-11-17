// True-peak limiter: a look-ahead brick wall. It sees every peak a few milliseconds before it arrives and has the
// gain down, smoothly, exactly when it does — so nothing is clipped and nothing overshoots. Peaks are measured
// between the samples too (4× oversampled, as a true-peak meter does), because a converter rebuilds the wave
// between the samples and that is where a limiter that only looks at samples lets overs through.
import { StudioFx, DelayLine, Smoothed, num, flag, dbToLin, linToDb, onepole } from './base.js';

const HOLD_MS = 10;
const MAX_LOOKAHEAD_MS = 10;
// the interpolator that estimates the wave between samples: 4 phases × 12 taps, a windowed sinc, centred — so what it
// reports for "now" is the wave six samples ago, and the audio is delayed by those six samples to match
const PHASES = 4;
const TAPS = 12;
const TP_DELAY = TAPS / 2;
const FIR = (() => {
  const n = PHASES * TAPS;
  const out = new Float64Array(n + 1);
  const mid = n / 2;
  for (let i = 0; i <= n; i++) {
    const x = (i - mid) / PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n); // Blackman
    out[i] = sinc * w;
  }
  return out;
})();

/** The mean of the last `len` values (two in a row smooth a step into an S that takes exactly their combined length). */
class Boxcar {
  constructor(capacity) {
    this.ring = new Float32Array(Math.max(1, capacity)).fill(1);
    this.len = 1;
    this.pos = 0;
    this.sum = 1;
  }

  configure(len, fill) {
    this.len = Math.min(this.ring.length, Math.max(1, len));
    this.ring.fill(fill, 0, this.len);
    this.pos = 0;
    this.sum = fill * this.len;
  }

  tick(x) {
    this.sum += x - this.ring[this.pos];
    this.ring[this.pos] = x;
    if (++this.pos === this.len) this.pos = 0;
    return this.sum / this.len;
  }
}

/** The smallest of the last `window` values, in constant time per sample (a queue of candidates that could still be it). */
class SlidingMin {
  constructor(maxWindow) {
    const size = 1 << Math.ceil(Math.log2(maxWindow + 2));
    this.value = new Float32Array(size).fill(1);
    this.index = new Float64Array(size);
    this.mask = size - 1;
    this.head = 0;
    this.count = 0;
    this.now = 0;
    this.window = 1;
  }

  configure(window) {
    this.window = Math.min(this.mask, Math.max(1, window));
    this.head = 0;
    this.count = 0;
    this.now = 0;
  }

  tick(x) {
    while (this.count > 0 && this.value[(this.head + this.count - 1) & this.mask] >= x) this.count--;
    const slot = (this.head + this.count) & this.mask;
    this.value[slot] = x;
    this.index[slot] = this.now;
    this.count++;
    while (this.index[this.head] + this.window <= this.now) {
      this.head = (this.head + 1) & this.mask;
      this.count--;
    }
    this.now++;
    return this.value[this.head];
  }
}

export class Maximizer extends StudioFx {
  static type = 'maximizer';
  static label = 'True-peak Limiter';
  static description = 'A look-ahead brick-wall limiter for the master (or any bus): it sees each peak a few milliseconds ahead and has the gain down when it arrives, so nothing clips and nothing overshoots — measured between the samples too (true peak), which is what streaming services check. Raise the input gain to make a mix louder; the ceiling is never exceeded. It delays its signal by the look-ahead (about 5 ms).';
  static defs = [
    num('gain', 'Input gain', -12, 36, 0, { unit: 'dB', automatable: true, description: 'Gain before limiting. Each dB above the point where limiting starts is a dB louder — and a dB more of the peaks shaved off.' }),
    num('ceiling', 'Ceiling', -24, 0, -1, { unit: 'dB', description: 'The level nothing may exceed. -1 dB is safe for a master that will be encoded (MP3, AAC, streaming); 0 dB uses every bit of headroom.' }),
    num('release', 'Release', 1, 1000, 100, { unit: 'ms', curve: 'log', description: 'How quickly the gain comes back after a peak. Short (10–50 ms) is louder but can pump or distort bass; long (200 ms and more) is cleaner and quieter.' }),
    num('lookahead', 'Look-ahead', 1, 10, 5, { unit: 'ms', description: 'How far ahead it sees, which is also how gently it turns down before each peak. Longer is smoother on bass; the signal is delayed by this much.' }),
    flag('truePeak', 'True peak', true, { description: 'Measure peaks between the samples as well (4× oversampled). Off = only the samples themselves: a little louder, but a converter or an encoder may overshoot the ceiling by up to a dB or two.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    const max = Math.ceil(MAX_LOOKAHEAD_MS * 0.001 * sampleRate) + 2;
    const hold = Math.floor(HOLD_MS * 0.001 * sampleRate);
    this.delay = [new DelayLine(max + TP_DELAY + 2), new DelayLine(max + TP_DELAY + 2)];
    this.history = [new Float32Array(TAPS * 2), new Float32Array(TAPS * 2)]; // each sample twice: a window without wrapping
    this.hpos = 0;
    this.min = new SlidingMin(Math.max(max, hold) + 2);
    this.box1 = new Boxcar(max / 2 + 2);
    this.box2 = new Boxcar(max / 2 + 2);
    this.env = 1;
    this.drive = new Smoothed(1, 10, sampleRate);
    this.reduction = 0;
    this.look = 0;
    this.update();
    this.drive.snap(dbToLin(this.p.gain));
  }

  update() {
    const look = Math.max(1, Math.round(this.p.lookahead * 0.001 * this.fs));
    if (look !== this.look) {
      this.look = look;
      this.min.configure(Math.max(look + 1, Math.floor(HOLD_MS * 0.001 * this.fs)));
      this.box1.configure((look >> 1) + 1, this.env);
      this.box2.configure(look - (look >> 1) + 1, this.env);
    }
    // (a ceiling that rounds up as a 32-bit float would be exceeded by the float that is written: take the one below)
    const exact = dbToLin(this.p.ceiling);
    const f = Math.fround(exact);
    this.ceil = f > exact ? f - f * 1.2e-7 : f;
    this.rel = onepole(this.p.release, this.fs);
    this.drive.set(dbToLin(this.p.gain));
  }

  reset() {
    this.delay[0].clear();
    this.delay[1].clear();
    this.history[0].fill(0);
    this.history[1].fill(0);
    this.env = 1;
    this.reduction = 0;
    this.look = 0;
    this.update();
    this.drive.snap(dbToLin(this.p.gain));
  }

  get latency() { return this.look + (this.p.truePeak ? TP_DELAY : 0); }
  /** Gain reduction in the last block, dB (0 = none, −6 = the loudest peak was turned down by half). */
  get meter() { return this.reduction; }

  process(L, R, n) {
    const { ceil, rel, look, min, box1, box2, drive } = this;
    const [dl, dr] = this.delay;
    const [hl, hr] = this.history;
    const tp = this.p.truePeak;
    const wait = look + (tp ? TP_DELAY : 0);
    let env = this.env;
    let hpos = this.hpos;
    let lowest = 1;
    for (let i = 0; i < n; i++) {
      const g = drive.next();
      let xl = L[i] * g;
      let xr = R[i] * g;
      if (xl !== xl || xl > 1e6 || xl < -1e6) xl = 0; // (a NaN or an explosion upstream must not jam the gain at zero)
      if (xr !== xr || xr > 1e6 || xr < -1e6) xr = 0;
      let peak;
      if (tp) {
        // the wave between the samples, estimated at four points per sample
        hl[hpos] = xl; hl[hpos + TAPS] = xl;
        hr[hpos] = xr; hr[hpos + TAPS] = xr;
        hpos = hpos + 1 === TAPS ? 0 : hpos + 1;
        peak = 0;
        for (let ph = 0; ph < PHASES; ph++) {
          let a = 0;
          let b = 0;
          // newest sample first: tap k of this phase weighs the sample k steps back
          for (let k = 0; k < TAPS; k++) {
            const c = FIR[ph + k * PHASES];
            const at = hpos + TAPS - 1 - k;
            a += c * hl[at];
            b += c * hr[at];
          }
          if (a < 0) a = -a;
          if (b < 0) b = -b;
          if (a > peak) peak = a;
          if (b > peak) peak = b;
        }
        // …and the sample itself, six samples ago, exactly (the estimate of it is only nearly it)
        const sl = hl[hpos + TAPS - 1 - TP_DELAY];
        const sr = hr[hpos + TAPS - 1 - TP_DELAY];
        if (sl > peak) peak = sl; else if (-sl > peak) peak = -sl;
        if (sr > peak) peak = sr; else if (-sr > peak) peak = -sr;
      } else {
        peak = xl < 0 ? -xl : xl;
        const b = xr < 0 ? -xr : xr;
        if (b > peak) peak = b;
      }
      // the gain this moment needs; the lowest such gain of the window ahead; down at once, back up slowly;
      // then smoothed over exactly the look-ahead, so the gain is there when the peak leaves the delay
      const held = min.tick(peak > ceil ? ceil / peak : 1);
      env = held < env ? held : env + rel * (held - env);
      const gain = box2.tick(box1.tick(env));
      if (gain < lowest) lowest = gain;
      const yl = dl.tap(wait) * gain;
      const yr = dr.tap(wait) * gain;
      dl.push(xl);
      dr.push(xr);
      L[i] = yl > ceil ? ceil : yl < -ceil ? -ceil : yl;
      R[i] = yr > ceil ? ceil : yr < -ceil ? -ceil : yr;
    }
    this.env = env;
    this.hpos = hpos;
    this.reduction = Math.min(0, linToDb(lowest));
  }
}
