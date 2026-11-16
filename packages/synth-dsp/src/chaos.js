// Chaos generators: slow, organic modulation sources that never quite repeat. Ported from the GGS Composer
// modulators (Rust) to this engine's rules: plain numbers, no allocation while running, and every path fixed by its
// seed — the same note renders the same wander every time.
//
//   lorenz    x of the Lorenz system (σ 10, β 8/3). Swings around one of two lobes and flips to the other at
//             unpredictable moments. Rate = swings per second; character = ρ 26…56 (long stays … restless switching).
//   rossler   x of the Rössler system (a = b = 0.2). A wobbling loop that now and then lurches. Rate = orbits per
//             second; character = c 3…11 (a calm two-turn loop … spiky chaos).
//   drift     a mean-reverting random walk (Ornstein–Uhlenbeck): what an analog oscillator's pitch does. Rate = how
//             fast it wanders; character = smoothness (jittery walk … rounded wander).
//   turing    a Turing-machine shift register (after the Music Thing Modular module): a looping pattern of steps
//             that mutates. Rate = steps per second; character = the chance a recycled bit is replaced by a random
//             one (0 = a locked loop, 1 = always new); steps = loop length.
//
// Each generator is a fixed sequence of states that the rate merely scans, like a tape: the attractors are integrated
// with classic RK4 at a fixed step in their own time (1/96 or 1/128 of a mean cycle), so the integration is equally
// accurate at every rate, and the output is a cubic Hermite interpolation between the two surrounding states using
// the exact derivatives. Only + − × ÷ touch the state, so a trajectory is the same on every machine — which matters,
// because chaos would amplify any rounding difference.
import { Rng, hash32 } from './util.js';
import { tanhFast } from './filters.js';

export const CHAOS_INFO = {
  lorenz: { label: 'Lorenz', rate: 'swings per second', character: 'Restlessness', desc: 'Swings around one of two centres and flips to the other at unpredictable moments. Character: long stays on one side (0) … restless switching (1). Slow, on a filter or a wavetable position: movement that never loops.' },
  rossler: { label: 'Rössler', rate: 'orbits per second', character: 'Spikiness', desc: 'A wobbling loop that now and then lurches. Character: a calm, almost periodic two-turn loop (0) … spiky chaos (1). Feels like an LFO with a mind of its own.' },
  drift: { label: 'Drift', rate: 'how fast it wanders', character: 'Smoothness', desc: 'A random walk that always comes home — what an analog oscillator does. Character: jittery (0) … rounded (1). A little on pitchFine or detune, a different path for every note, is analog voice drift.' },
  turing: { label: 'Turing', rate: 'steps per second', character: 'Mutation', desc: 'A looping pattern of stepped values that mutates (a shift register). Character: the chance that a step is replaced — 0 locks the loop, 1 is always new. Steps sets the loop length. Tempo-sync it for generative sequences on pitch or a filter.' }
};
export const CHAOS_TYPES = Object.keys(CHAOS_INFO);

const SIGMA = 10;
const BETA = 8 / 3;
const LORENZ_STEPS = 96; // integration states per cycle of the rate
const ROSSLER_STEPS = 128;
const ROSSLER_A = 0.2;
const ROSSLER_B = 0.2;
const ROSSLER_PERIOD = 5.8; // mean orbit period in the system's own time (measured 5.7–5.9 over the whole range)
const LORENZ_SLEW = 0.01; // largest change of the character per integration step: a jump must not throw the
const ROSSLER_SLEW = 0.004; // state off the attractor
const DRIFT_STEPS = 32;
const DRIFT_SIGMA = 0.35;
const STEPS_PER_CYCLE = [LORENZ_STEPS, ROSSLER_STEPS, DRIFT_STEPS, 1];
const MAX_STEPS = 4096; // per advance: a stalled clock catching up must not stall the audio

const lorenzRho = (character) => 26 + 30 * character;
/** Swings of x (local maxima) per time unit: a quadratic fit to measurements for ρ in 25…59 (error < 1.5 %). */
function lorenzSwingFreq(rho) {
  const u = (rho - 40) / 15;
  return 1.2866 + 0.256 * u - 0.048 * u * u;
}
const rosslerC = (character) => 3 + 8 * character;

/** Identity up to ±0.75, a tanh knee above, never beyond ±1. */
function softLimit(x) {
  const a = x < 0 ? -x : x;
  if (a <= 0.75) return x;
  const y = 0.75 + 0.25 * tanhFast((a - 0.75) / 0.25);
  return x < 0 ? -y : y;
}

/** Two consecutive states of an attractor and what is needed to interpolate x between them. */
class Orbit {
  constructor() {
    this.s = new Float64Array(3); // the newer state
    this.fromX = 0;
    this.d0 = 0; // dx/dt at the older and the newer state
    this.d1 = 0;
    this.dt = 0;
    this.character = 0.5; // the (slewed) character the last step was integrated with
    this.centre = 0; // output mapping: (x − centre) · scale is about −1…1
    this.scale = 1;
  }

  /** A seed-dependent state on the Lorenz attractor that belongs to `character`. */
  lorenz(seed, character) {
    const rng = new Rng(hash32(seed ^ 0x10fe52));
    const rho = lorenzRho(character);
    const c = Math.sqrt(BETA * (rho - 1));
    const side = rng.next() < 0 ? -1 : 1;
    const s = this.s;
    // somewhere around one of the two lobe centres (±c, ±c, ρ − 1)
    s[0] = side * c * (1 + 0.7 * rng.next());
    s[1] = side * c * (1 + 0.7 * rng.next());
    s[2] = (rho - 1) * (1 + 0.3 * rng.next());
    this.character = character;
    // off-attractor components contract quickly: about one time unit of warm-up puts the state on the attractor
    for (let i = 0; i < 128; i++) this.stepLorenz(character);
  }

  rossler(seed, character) {
    const rng = new Rng(hash32(seed ^ 0x2055e7));
    const half = this.rosslerRange(rosslerC(character));
    const side = rng.next() < 0 ? -1 : 1;
    const s = this.s;
    s[0] = side * half * (0.625 + 0.175 * rng.next());
    s[1] = half * 0.3 * rng.next();
    s[2] = 0.03;
    this.character = character;
    for (let i = 0; i < 256; i++) this.stepRossler(character);
  }

  /** Half-width of the range of x on the Rössler attractor (quadratic fits to the measured extremes); sets centre. */
  rosslerRange(c) {
    const u = (c - 7.5) / 5;
    const hi = 14.793 + 9.387 * u - 0.672 * u * u;
    const lo = -11.929 - 7.945 * u + 0.277 * u * u;
    this.centre = 0.5 * (hi + lo);
    return 0.5 * (hi - lo);
  }

  stepLorenz(target) {
    const move = target - this.character;
    this.character += move > LORENZ_SLEW ? LORENZ_SLEW : move < -LORENZ_SLEW ? -LORENZ_SLEW : move;
    const rho = lorenzRho(this.character);
    const dt = 1 / (lorenzSwingFreq(rho) * LORENZ_STEPS);
    const s = this.s;
    const x = s[0], y = s[1], z = s[2];
    const h = 0.5 * dt;
    const k1x = SIGMA * (y - x), k1y = x * (rho - z) - y, k1z = x * y - BETA * z;
    let ax = x + k1x * h, ay = y + k1y * h, az = z + k1z * h;
    const k2x = SIGMA * (ay - ax), k2y = ax * (rho - az) - ay, k2z = ax * ay - BETA * az;
    ax = x + k2x * h; ay = y + k2y * h; az = z + k2z * h;
    const k3x = SIGMA * (ay - ax), k3y = ax * (rho - az) - ay, k3z = ax * ay - BETA * az;
    ax = x + k3x * dt; ay = y + k3y * dt; az = z + k3z * dt;
    const k4x = SIGMA * (ay - ax), k4y = ax * (rho - az) - ay, k4z = ax * ay - BETA * az;
    const w = dt / 6;
    this.fromX = x;
    this.d0 = k1x;
    s[0] = x + w * (k1x + 2 * k2x + 2 * k3x + k4x);
    s[1] = y + w * (k1y + 2 * k2y + 2 * k3y + k4y);
    s[2] = z + w * (k1z + 2 * k2z + 2 * k3z + k4z);
    this.d1 = SIGMA * (s[1] - s[0]);
    this.dt = dt;
    this.centre = 0;
    // x reaches about ±2.25–2.5 times the fixed-point distance √(β(ρ − 1))
    this.scale = 1 / (2.25 * Math.sqrt(BETA * (rho - 1)));
  }

  stepRossler(target) {
    const move = target - this.character;
    this.character += move > ROSSLER_SLEW ? ROSSLER_SLEW : move < -ROSSLER_SLEW ? -ROSSLER_SLEW : move;
    const c = rosslerC(this.character);
    const dt = ROSSLER_PERIOD / ROSSLER_STEPS;
    const s = this.s;
    const x = s[0], y = s[1], z = s[2];
    const h = 0.5 * dt;
    const k1x = -y - z, k1y = x + ROSSLER_A * y, k1z = ROSSLER_B + z * (x - c);
    let ax = x + k1x * h, ay = y + k1y * h, az = z + k1z * h;
    const k2x = -ay - az, k2y = ax + ROSSLER_A * ay, k2z = ROSSLER_B + az * (ax - c);
    ax = x + k2x * h; ay = y + k2y * h; az = z + k2z * h;
    const k3x = -ay - az, k3y = ax + ROSSLER_A * ay, k3z = ROSSLER_B + az * (ax - c);
    ax = x + k3x * dt; ay = y + k3y * dt; az = z + k3z * dt;
    const k4x = -ay - az, k4y = ax + ROSSLER_A * ay, k4z = ROSSLER_B + az * (ax - c);
    const w = dt / 6;
    this.fromX = x;
    this.d0 = k1x;
    s[0] = x + w * (k1x + 2 * k2x + 2 * k3x + k4x);
    s[1] = y + w * (k1y + 2 * k2y + 2 * k3y + k4y);
    s[2] = z + w * (k1z + 2 * k2z + 2 * k3z + k4z);
    this.d1 = -s[1] - s[2];
    this.dt = dt;
    this.scale = 1 / this.rosslerRange(c);
  }

  /** The state has left any plausible neighbourhood of the attractor (or is not finite). */
  escaped() {
    const s = this.s;
    return !(s[0] > -1e3 && s[0] < 1e3 && s[1] > -1e3 && s[1] < 1e3 && s[2] > -1e3 && s[2] < 1e3);
  }

  /** Normalised x at fraction f of the way from the older state to the newer (cubic Hermite). */
  at(f) {
    const f2 = f * f;
    const f3 = f2 * f;
    const x = (2 * f3 - 3 * f2 + 1) * this.fromX + (f3 - 2 * f2 + f) * this.dt * this.d0 + (-2 * f3 + 3 * f2) * this.s[0] + (f3 - f2) * this.dt * this.d1;
    return (x - this.centre) * this.scale;
  }
}

export class Chaos {
  /** Every seed gives a different, repeatable sequence for each type. */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.orbit = new Orbit();
    this.rng = new Rng(1);
    this.pts = new Float64Array(4); // drift: the last four points; the output runs between pts[1] and pts[2]
    this.y1 = 0;
    this.y2 = 0;
    this.a = 1 - Math.exp((-2 * Math.PI) / DRIFT_STEPS);
    this.b = 1;
    this.gain = 1;
    this.coefFor = -1;
    this.reg = 0; // turing: bit 0 is the newest bit, bits 0…steps−1 are the loop
    this.type = -1;
    this.pos = 0; // cycles since the start
    this.lastStep = 0;
    this.value = 0;
  }

  /** Start the generator `type` from its seed (also the way back after a type change). */
  start(type, character) {
    this.type = type;
    this.lastStep = Math.floor(this.pos * STEPS_PER_CYCLE[type]);
    if (type === 0) this.orbit.lorenz(this.seed, character);
    else if (type === 1) this.orbit.rossler(this.seed, character);
    else if (type === 2) {
      this.rng = new Rng(hash32(this.seed ^ 0xd21f7));
      this.y1 = this.y2 = 0;
      this.pts.fill(0);
      this.coefFor = -1;
      // reach the stationary distribution before the first output
      for (let i = 0; i < 64; i++) this.stepDrift(0.5);
    } else {
      this.rng = new Rng(hash32(this.seed ^ 0x7021c6));
      // bits 0 and 1 differ, so even a 2-step loop is not stuck on one value
      this.reg = ((this.u32() & ~3) | (this.rng.next() < 0 ? 1 : 2)) >>> 0;
    }
  }

  u32() {
    this.rng.next();
    return this.rng.s >>> 0;
  }

  /** White noise through two one-poles: the mean reversion, then a smoother whose corner `character` moves. */
  stepDrift(character) {
    if (character !== this.coefFor) {
      this.coefFor = character;
      // second corner: 16× the first at character 0, equal to it at 1
      const ratio = Math.pow(2, 4 * (1 - character));
      this.b = 1 - Math.exp((-2 * Math.PI * ratio) / DRIFT_STEPS);
      // variance of unit white noise through both filters (poles p and q), so the output level does not depend on it
      const p = 1 - this.a;
      const q = 1 - this.b;
      const variance = (this.a * this.a * this.b * this.b * (1 + p * q)) / ((1 - p * p) * (1 - q * q) * (1 - p * q));
      this.gain = DRIFT_SIGMA / Math.sqrt(variance);
    }
    const rng = this.rng;
    // four uniform numbers summed are close enough to a bell curve, and use nothing but additions
    const w = (rng.next() + rng.next() + rng.next() + rng.next()) * 0.8660254037844386;
    this.y1 += this.a * (w - this.y1);
    this.y2 += this.b * (this.y1 - this.y2);
    const pts = this.pts;
    pts[0] = pts[1]; pts[1] = pts[2]; pts[2] = pts[3]; pts[3] = this.y2 * this.gain;
  }

  stepTuring(len, character) {
    const recycled = (this.reg >>> (len - 1)) & 1;
    // both draws happen on every step, so the pattern does not depend on when the character was changed
    const replace = this.rng.unit() < character;
    const random = this.u32() >>> 31;
    this.reg = ((this.reg << 1) | (replace ? random : recycled)) >>> 0;
  }

  /**
   * Advance by dt seconds and return the value there, −1…1.
   * type: index into CHAOS_TYPES · rate: cycles (or steps) per second · character 0…1 · steps: turing loop length.
   */
  advance(dt, type, rate, character, steps) {
    if (type !== this.type) this.start(type, character);
    this.pos += rate * dt;
    const sp = this.pos * STEPS_PER_CYCLE[type];
    const step = Math.floor(sp);
    const f = sp - step;
    let n = step - this.lastStep;
    if (n > MAX_STEPS) n = MAX_STEPS;
    this.lastStep = step;
    let v;
    if (type === 0) {
      const o = this.orbit;
      for (let i = 0; i < n; i++) { o.stepLorenz(character); if (o.escaped()) o.lorenz(this.seed, character); }
      v = softLimit(o.at(f));
    } else if (type === 1) {
      const o = this.orbit;
      for (let i = 0; i < n; i++) { o.stepRossler(character); if (o.escaped()) o.rossler(this.seed, character); }
      v = softLimit(o.at(f));
    } else if (type === 2) {
      for (let i = 0; i < n; i++) this.stepDrift(character);
      // Catmull-Rom through the points
      const p = this.pts;
      const c1 = 0.5 * (p[2] - p[0]);
      const c2 = p[0] - 2.5 * p[1] + 2 * p[2] - 0.5 * p[3];
      const c3 = 0.5 * (p[3] - p[0]) + 1.5 * (p[1] - p[2]);
      v = softLimit(((c3 * f + c2) * f + c1) * f + p[1]);
    } else {
      const len = steps < 2 ? 2 : steps > 32 ? 32 : steps | 0;
      for (let i = 0; i < n; i++) this.stepTuring(len, character);
      // an 8-bit DAC over the newest bits of the loop (wrapping round loops shorter than 8)
      let byte = 0;
      let bit = 0;
      for (let i = 0; i < 8; i++) {
        byte = (byte << 1) | ((this.reg >>> bit) & 1);
        if (++bit === len) bit = 0;
      }
      v = (byte * 2) / 255 - 1;
    }
    this.value = v > -1 ? (v < 1 ? v : 1) : v === v ? -1 : 0;
    return this.value;
  }
}

/**
 * `points` values of a generator over `cycles` cycles of its rate (for drawing, and for agents that want to see a
 * setting). settings: { type, character, steps }.
 */
export function chaosPreview(settings, points = 240, cycles = 12, seed = 1) {
  const type = Math.max(0, CHAOS_TYPES.indexOf(settings.type));
  const c = new Chaos(seed);
  const out = new Float32Array(points);
  const character = Math.max(0, Math.min(1, settings.character ?? 0.5));
  for (let i = 0; i < points; i++) out[i] = c.advance(cycles / points, type, 1, character, settings.steps ?? 16);
  return out;
}
