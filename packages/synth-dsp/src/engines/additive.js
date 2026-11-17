// Additive engine: a note is a stack of up to 64 sine partials, each with its own level — and the knobs shape the
// whole spectrum at once (its slope, the balance of odd and even partials, a movable emphasis, how far the partials
// are stretched away from harmonic). Organs, glass pads, bells, hollow reeds, choirs: sounds no filter makes, because
// nothing is filtered — every partial is simply as loud as the spectrum says.
import { SynthEngine, Adsr, num, clamp, dbToLin, velocityGain, keyHz, TAU } from './base.js';

export const MAX_PARTIALS = 64;
const N = MAX_PARTIALS;
const TICK = 32; // samples between updates of the partials' levels and frequencies (0.7 ms: no step is heard)
const DETUNE_CENTS = 25;
const LOG2K = Float64Array.from({ length: N }, (_, i) => Math.log2(i + 1));
/** The loudness every spectrum is brought to (RMS before the level knob and the envelope). */
const RMS = 0.5;

/**
 * The level of each partial for a set of settings: fills `out` (N long), returns how many partials sound.
 * Slope in dB per octave; odd/even balance (the fundamental is never touched); a window on a log-frequency axis
 * that boosts or cuts the partials inside it; then everything is scaled to the same loudness.
 */
export function additiveSpectrum(p, out, tiltExtra = 0) {
  const n = clamp(Math.round(p.partials), 1, N);
  const tilt = (p.tilt + tiltExtra) / 6.0206;
  const evenGain = 1 + Math.min(0, p.oddEven);
  const oddGain = 1 - Math.max(0, p.oddEven);
  const span = n > 1 ? 1 / LOG2K[n - 1] : 0;
  const half = 1 / (0.03 + 0.97 * p.windowWidth);
  const gain = p.windowGain * 0.1660964; // dB → log2 of the amplitude
  let power = 0;
  for (let i = 0; i < n; i++) {
    let a = Math.pow(2, tilt * LOG2K[i]);
    // (partial 2, 4, 6… are the even ones: index 1, 3, 5)
    if (i > 0) a *= i & 1 ? evenGain : oddGain;
    if (gain !== 0) {
      const d = (LOG2K[i] * span - p.windowCenter) * half;
      const q = 1 - d * d;
      if (q > 0) a *= Math.pow(2, gain * q * q);
    }
    out[i] = a;
    power += a * a;
  }
  const norm = power > 1e-30 ? (RMS * Math.SQRT2) / Math.sqrt(power) : 0;
  for (let i = 0; i < n; i++) out[i] *= norm;
  for (let i = n; i < N; i++) out[i] = 0;
  return n;
}

export class Additive extends SynthEngine {
  static type = 'additive';
  static label = 'Additive';
  static category = 'synth';
  static color = '#7fd0c4';
  static description = 'Additive synthesis: each note is a stack of up to 64 sine partials whose levels the knobs shape as one spectrum — slope (tilt), odd against even partials, a movable emphasis window, and stretch for bell and metal tones. For organs, glass pads, bells, hollow reeds and choirs. Per-note pitch curves work; it has no filter (nothing needs filtering: set the spectrum).';
  static defs = [
    num('partials', 'Partials', 1, N, 32, { group: 'Spectrum', step: 1, description: 'How many sine partials each note has. More is brighter and denser, and costs more CPU; high notes use fewer by themselves (nothing above the audible range is made).' }),
    num('tilt', 'Tilt', -24, 6, -6, { group: 'Spectrum', unit: 'dB', description: 'Slope of the spectrum in dB per octave: -6 is saw-like, -12 mellow, 0 makes every partial equally loud (buzzy, bright), lower is darker.' }),
    num('oddEven', 'Odd / even', -1, 1, 0, { group: 'Spectrum', description: 'Balance of odd and even partials: -1 keeps only the odd ones (hollow, like a square wave or a clarinet), +1 only the even ones (an octave-up, organ-like tone). The fundamental always stays.' }),
    num('stretch', 'Stretch', -1, 1, 0, { group: 'Spectrum', description: 'Moves the partials away from whole multiples: 0 is harmonic; positive values spread them (bells, metal, piano-like stiffness), negative values squeeze them together (gongs, clusters).' }),
    num('windowCenter', 'Emphasis', 0, 1, 0.5, { group: 'Emphasis', description: 'Where the emphasis window sits across the partials, 0 = the fundamental, 1 = the highest partial. Sweep it (with Emphasis gain up) for vowel- and phaser-like movement.' }),
    num('windowWidth', 'Emph. width', 0, 1, 0.3, { group: 'Emphasis', description: 'How wide the emphasis window is: small picks out a few partials (a resonance), 1 reaches the whole spectrum.' }),
    num('windowGain', 'Emph. gain', -24, 24, 0, { group: 'Emphasis', unit: 'dB', description: 'Boost (positive) or cut (negative) of the partials inside the emphasis window. The overall loudness stays the same, so it changes colour, not level.' }),
    num('shimmer', 'Shimmer', 0, 1, 0, { group: 'Motion', description: 'A slow, independent wander in the level of every partial: the spectrum breathes, like a chorus without detuning. 0 is perfectly still.' }),
    num('spread', 'Stereo', 0, 1, 0.3, { group: 'Motion', description: 'Stereo width: odd partials lean left, even ones right; the fundamental stays in the middle, so the bass stays mono.' }),
    num('detune', 'Detune', 0, 1, 0, { group: 'Motion', description: 'Adds a second copy of the whole stack, the two tuned up to 25 cents apart and panned apart: width and slow beating. Doubles the CPU of the note.' }),
    num('velBright', 'Vel → bright', 0, 1, 0.4, { group: 'Amp', description: 'How much softer notes are also darker (the tilt falls by up to 6 dB per octave at the softest). 0 = velocity only changes the level.' }),
    num('attack', 'Attack', 0.001, 5, 0.01, { group: 'Amp', unit: 's', curve: 'log', description: 'Time for a note to reach its full level: a few ms for organs and bells, half a second or more for pads.' }),
    num('decay', 'Decay', 0.01, 10, 0.8, { group: 'Amp', unit: 's', curve: 'log', description: 'Time to fall from the attack peak to the sustain level.' }),
    num('sustain', 'Sustain', 0, 1, 0.8, { group: 'Amp', description: 'Level a held note settles at, as a share of its peak. 0 makes every note a pluck or a bell that dies away by itself.' }),
    num('release', 'Release', 0.005, 10, 0.4, { group: 'Amp', unit: 's', curve: 'log', description: 'Time for the note to die away after the key is let go.' }),
    num('level', 'Level', -36, 6, -12, { group: 'Amp', unit: 'dB', description: 'Output level of the instrument, before the channel fader.' })
  ];

  static presets = {
    'Glass Pad': { partials: 24, tilt: -9, oddEven: 0, stretch: 0.04, windowCenter: 0.6, windowWidth: 0.35, windowGain: 6, shimmer: 0.6, spread: 0.6, detune: 0.35, attack: 0.5, decay: 2, sustain: 0.8, release: 1.6 },
    'Drawbar Organ': { partials: 9, tilt: -3, oddEven: 0.25, stretch: 0, windowGain: 0, shimmer: 0.05, spread: 0.2, detune: 0.1, velBright: 0, attack: 0.004, decay: 0.05, sustain: 1, release: 0.06 },
    'Hollow Reed': { partials: 20, tilt: -7, oddEven: -0.9, stretch: 0, windowCenter: 0.45, windowWidth: 0.25, windowGain: 8, shimmer: 0.15, spread: 0.2, attack: 0.04, decay: 0.3, sustain: 0.85, release: 0.15 },
    'Bell Tones': { partials: 28, tilt: -5, oddEven: -0.2, stretch: 0.55, windowCenter: 0.7, windowWidth: 0.4, windowGain: 5, shimmer: 0.1, spread: 0.7, detune: 0.15, attack: 0.002, decay: 3.5, sustain: 0, release: 2.5 },
    'Choir Ah': { partials: 30, tilt: -10, oddEven: 0, stretch: 0, windowCenter: 0.52, windowWidth: 0.2, windowGain: 14, shimmer: 0.5, spread: 0.5, detune: 0.3, attack: 0.25, decay: 1, sustain: 0.9, release: 0.7 },
    'Saw Stack': { partials: 64, tilt: -6, oddEven: 0, stretch: 0, windowGain: 0, shimmer: 0, spread: 0.4, detune: 0.5, attack: 0.005, decay: 0.4, sustain: 0.8, release: 0.25 },
    'Soft Sine Keys': { partials: 6, tilt: -14, oddEven: 0, stretch: 0.02, windowGain: 0, shimmer: 0, spread: 0.1, detune: 0, attack: 0.003, decay: 1.4, sustain: 0.25, release: 0.4 },
    'Metal Plate': { partials: 40, tilt: -3, oddEven: 0, stretch: -0.6, windowCenter: 0.5, windowWidth: 0.6, windowGain: 4, shimmer: 0.3, spread: 0.9, detune: 0.2, attack: 0.002, decay: 5, sustain: 0, release: 3 }
  };

  static tail(params) { return (params?.release ?? 0.4) + 0.05; }

  constructor(sampleRate, seed = 1) {
    super(sampleRate, seed);
    // two stacks (the second only sounds with Detune): each partial is a point turning on a circle
    this.x = [new Float64Array(N), new Float64Array(N)];
    this.y = [new Float64Array(N), new Float64Array(N)];
    this.cos = [new Float64Array(N), new Float64Array(N)];
    this.sin = [new Float64Array(N), new Float64Array(N)];
    this.amp = [new Float64Array(N), new Float64Array(N)];
    this.dAmp = [new Float64Array(N), new Float64Array(N)];
    this.base = new Float64Array(N); // the spectrum as the knobs set it
    this.ratio = Float64Array.from({ length: N }, (_, i) => i + 1);
    // shimmer: every partial has its own slow wander between random points
    this.shFrom = new Float64Array(N);
    this.shTo = new Float64Array(N);
    this.shPhase = new Float64Array(N);
    this.shRate = new Float64Array(N);
    this.rand = this.seed;
    this.env = new Adsr(sampleRate);
    this.key = 60;
    this.hz = keyHz(60);
    this.vel = 0;
    this.tiltExtra = 0;
    this.count = 0;
    this.tickLeft = 0;
    this.ticks = 0;
    this.started = false;
    this.lastBend = 0;
    this.lastHz = -1;
    this.dirty = true;
    this.gain = 0;
    this.update();
  }

  random() {
    // (xorshift: the same seed gives the same note)
    let s = this.rand;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.rand = s || 1;
    return s / 4294967296;
  }

  update() {
    const p = this.p;
    this.env.set(p.attack, p.decay, p.sustain, p.release);
    const stretch = 1 + 0.25 * p.stretch;
    for (let i = 0; i < N; i++) this.ratio[i] = p.stretch === 0 ? i + 1 : Math.pow(2, stretch * LOG2K[i]);
    this.dirty = true;
    this.lastHz = -1;
  }

  noteOn(key, velocity, tune = 0) {
    this.key = key;
    this.hz = keyHz(key + tune / 100);
    this.vel = clamp(velocity, 0, 1);
    this.tiltExtra = -6 * this.p.velBright * (1 - Math.min(1, this.vel / 0.8));
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < N; i++) {
        // every partial starts at a zero crossing going up — a click-free start, the same for every note — and the
        // second stack a little apart so the two do not cancel at the start
        const a = s ? 0.25 * TAU * this.random() : 0;
        this.x[s][i] = Math.cos(a);
        this.y[s][i] = Math.sin(a);
        this.amp[s][i] = 0;
      }
    }
    for (let i = 0; i < N; i++) {
      this.shFrom[i] = this.random() * 2 - 1;
      this.shTo[i] = this.random() * 2 - 1;
      this.shPhase[i] = this.random();
      this.shRate[i] = (0.25 + 1.75 * this.random()) * (TICK / this.fs); // 0.25–2 Hz, in phase per tick
    }
    this.env.on();
    this.started = true;
    this.tickLeft = 0;
    this.ticks = 0;
    this.dirty = true;
    this.lastHz = -1;
    this.gain = velocityGain(this.vel) * dbToLin(this.p.level);
  }

  noteOff() { this.env.off(); }
  get finished() { return this.started && this.env.idle; }

  /** Once per tick: where every partial is heading — its level (spectrum × shimmer × fade near the top) and its turn per sample. */
  control(bend) {
    const p = this.p;
    if (this.dirty) {
      this.count = additiveSpectrum(p, this.base, this.tiltExtra);
      this.dirty = false;
    }
    const stacks = p.detune > 0 ? 2 : 1;
    const hz = this.hz * (bend ? Math.pow(2, bend / 12) : 1);
    const retune = hz !== this.lastHz || (this.ticks & 63) === 0;
    this.lastHz = hz;
    const up = Math.pow(2, (p.detune * DETUNE_CENTS) / 1200);
    const inv = 1 / TICK;
    const shimmer = p.shimmer;
    for (let s = 0; s < stacks; s++) {
      const w = (TAU * hz * (stacks === 1 ? 1 : s ? up : 1 / up)) / this.fs;
      const x = this.x[s];
      const y = this.y[s];
      const amp = this.amp[s];
      const dAmp = this.dAmp[s];
      const cos = this.cos[s];
      const sin = this.sin[s];
      for (let i = 0; i < this.count; i++) {
        const theta = w * this.ratio[i];
        // nothing above the audible range: partials fade out between 0.40 and 0.45 of the sample rate
        const top = theta >= 0.45 * TAU ? 0 : theta <= 0.4 * TAU ? 1 : (0.45 * TAU - theta) / (0.05 * TAU);
        let target = this.base[i] * top;
        if (shimmer > 0 && s === 0) {
          let ph = this.shPhase[i] + this.shRate[i];
          if (ph >= 1) { ph -= 1; this.shFrom[i] = this.shTo[i]; this.shTo[i] = this.random() * 2 - 1; }
          this.shPhase[i] = ph;
        }
        if (shimmer > 0) {
          const t = this.shPhase[i];
          const e = t * t * (3 - 2 * t);
          target *= 1 + 0.7 * shimmer * (this.shFrom[i] + (this.shTo[i] - this.shFrom[i]) * e) * (s ? -1 : 1);
        }
        dAmp[i] = (target - amp[i]) * inv;
        if (retune) {
          cos[i] = Math.cos(theta);
          sin[i] = Math.sin(theta);
          // rounding slowly changes the radius of the circle: pull it back to 1
          const m = x[i] * x[i] + y[i] * y[i];
          const g = 1.5 - 0.5 * m;
          x[i] *= g;
          y[i] *= g;
        }
      }
    }
    this.ticks++;
  }

  render(L, R, n, bend = 0) {
    if (!this.started) { L.fill(0, 0, n); R.fill(0, 0, n); return; }
    const p = this.p;
    const stacks = p.detune > 0 ? 2 : 1;
    const env = this.env;
    const count = this.count || clamp(Math.round(p.partials), 1, N);
    // even partials lean right, odd ones left, by `spread` (constant power: both gains are 1 in the middle, and one
    // side reaches √2 as the other falls to 0); the fundamental stays in the middle
    const a = ((1 - p.spread) * Math.PI) / 4;
    const near = Math.cos(a) * Math.SQRT2;
    const far = Math.sin(a) * Math.SQRT2;
    const stackGain = stacks === 2 ? Math.SQRT1_2 : 1;
    let done = 0;
    while (done < n) {
      if (this.tickLeft === 0) { this.control(bend); this.tickLeft = TICK; }
      const m = Math.min(n - done, this.tickLeft);
      for (let i = done; i < done + m; i++) { L[i] = 0; R[i] = 0; }
      for (let s = 0; s < stacks; s++) {
        const x = this.x[s];
        const y = this.y[s];
        const amp = this.amp[s];
        const dAmp = this.dAmp[s];
        const cos = this.cos[s];
        const sin = this.sin[s];
        // the side this stack leans to (only with two stacks)
        const sl = stacks === 2 ? (s ? 1 - 0.6 * p.detune : 1) : 1;
        const sr = stacks === 2 ? (s ? 1 : 1 - 0.6 * p.detune) : 1;
        const kMax = this.count || count;
        for (let i = done; i < done + m; i++) {
          let centre = 0;
          let left = 0;
          let right = 0;
          // the fundamental
          {
            const nx = x[0] * cos[0] - y[0] * sin[0];
            y[0] = x[0] * sin[0] + y[0] * cos[0];
            x[0] = nx;
            amp[0] += dAmp[0];
            centre = y[0] * amp[0];
          }
          // partials 2, 4, 6… (to the right), then 3, 5, 7… (to the left)
          for (let k = 1; k < kMax; k += 2) {
            const nx = x[k] * cos[k] - y[k] * sin[k];
            y[k] = x[k] * sin[k] + y[k] * cos[k];
            x[k] = nx;
            amp[k] += dAmp[k];
            right += y[k] * amp[k];
          }
          for (let k = 2; k < kMax; k += 2) {
            const nx = x[k] * cos[k] - y[k] * sin[k];
            y[k] = x[k] * sin[k] + y[k] * cos[k];
            x[k] = nx;
            amp[k] += dAmp[k];
            left += y[k] * amp[k];
          }
          L[i] += (centre + left * near + right * far) * stackGain * sl;
          R[i] += (centre + right * near + left * far) * stackGain * sr;
        }
      }
      const g = this.gain;
      for (let i = done; i < done + m; i++) {
        const e = env.next() * g;
        L[i] *= e;
        R[i] *= e;
      }
      this.tickLeft -= m;
      done += m;
    }
    this.lastBend = bend;
  }
}
