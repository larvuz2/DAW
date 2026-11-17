// Shimmer: a reverb whose tail climbs in pitch — the sound Brian Eno and Daniel Lanois made with a reverb and a
// harmoniser feeding each other through a mixer. Here the pitch shifters sit inside the reverb's own feedback loop:
// two directions of the network's sixteen-line state (the two that also feed the left and right outputs) are turned,
// on every trip round the loop, from their plain selves towards their pitch-shifted selves:
//
//   part' = cos(a) · part + sin(a) · shifted(part),   a = amount · 90°
//
// A turn like that adds no energy and the shifter adds none either, so the loop is as stable as the plain reverb —
// and what was shifted once is shifted again on the next trip, which is what makes the tail climb octave by octave
// until the damping takes it. The shifted path is band-limited (nothing below 60 Hz, nothing above Nyquist / ratio),
// so shifting up cannot alias and shifting down cannot pile up as rumble.
//
// A port of GGS Composer's shimmer (Rust: fx-space/shimmer.rs, with the PitchCore of pitch.rs) on the reverberator
// of algoverb.js.
import { StudioFx, num, TAU, onepole, clamp } from './base.js';
import { ReverbCore, SHIMMER_VOICING } from './algoverb.js';

const f32 = Math.fround;
const WINDOW_MS = 90; // how far a tap of the in-loop shifters sweeps
const D_MIN = 2; // the shortest tap delay (the cubic read needs one newer sample)
const SEARCH_S = 0.012; // how far a splice may move from its nominal place to find a matching wave
const CORR_S = 0.008; // how much wave is compared at each candidate place
const TINY = 1e-15; // see algoverb.js: what is written into a delay is silence below this, and never above HUGE
const HUGE = 1e6;

// a tap: seven numbers
const ACTIVE = 0;
const DELAY = 1;
const T = 2; // samples since it started
const HOP = 3; // the other tap starts when T reaches this
const FADE_IN = 4;
const OUT_START = 5; // T when it began to fade out; −1 while it is not fading out
const OUT_LEN = 6;
const TAP = 8;
// io of a PitchCore
const IN_L = 0;
const IN_R = 1;
const RATIO = 2;
const MUTE = 3;
const OUT_L = 4;
const OUT_R = 5;

/**
 * A pitch shifter of the "rotating tape head" kind (the Eventide H910 / H949 line): two taps read a delay line
 * faster or slower than it is written, which transposes; a tap whose delay keeps shrinking (or growing) has to jump
 * back now and then, and the two taps crossfade so that one always sounds while the other jumps.
 *
 * A blind crossfade cancels whenever the two taps meet out of phase — heard as tremolo. So each new tap position is
 * chosen by a short search (the H949's "de-glitch"): the place whose wave best continues the wave of the tap that is
 * leaving. For a steady note the splice lands a whole number of periods away and the level stays steady. Left and
 * right share one decision (taken on their sum), so the stereo image does not wander. The crossfade weights add up
 * to 1, so the shifter never gives out more than it is given: a feedback loop round it stays stable.
 *
 * The shifted signal is late by between 2 samples and the window (half of it on average). The search is about 17 000
 * multiply-adds, once per crossfade.
 *
 * One sample: io[IN_L, IN_R, RATIO, MUTE] in, tick(), io[OUT_L, OUT_R] out. (Numbers cross in an array, not as
 * arguments: nothing is allocated.) MUTE ≠ 0 skips the reads when the output will not be used — the taps move on
 * exactly as they would have.
 */
class PitchCore {
  /** `share`: the tap sweep as a share of windowMs. */
  constructor(sampleRate, windowMs, share) {
    const fs = sampleRate;
    const maxWindow = f32(f32(windowMs * f32(0.001)) * fs);
    this.search = Math.floor(SEARCH_S * fs);
    this.corrLen = Math.floor(CORR_S * fs);
    this.dec = Math.max(1, Math.round(fs / 12000)); // the first pass of the search looks at every dec-th place
    this.reference = new Float32Array(this.corrLen + 1);
    const cap = Math.floor(maxWindow) + this.search + this.corrLen + 16;
    this.size = 1 << Math.ceil(Math.log2(cap + 4));
    this.mask = this.size - 1;
    this.buf = new Float32Array(2 * this.size); // left, then right
    this.w = 0;
    this.tapMax = cap - this.corrLen - 8; // the longest tap delay: room behind it for the search
    this.window = clamp(f32(maxWindow * f32(share)), 64, Math.max(maxWindow, 64));
    this.tap = new Float64Array(2 * TAP);
    this.newest = 0;
    this.io = new Float64Array(6);
    this.pl = new Float64Array(3);
  }

  reset() {
    this.buf.fill(0);
    this.tap.fill(0);
    this.newest = 0;
    this.w = 0;
  }

  /**
   * The timing of a new tap for the ratio in io → pl: [hop, fade, starting delay]. A tap sounds for hop + fade
   * samples and sweeps its delay by one window in that time.
   */
  plan() {
    const r = this.io[RATIO];
    const slope = Math.abs(1 - r);
    const hopMax = 2 * this.window;
    let hop = slope > 1e-9 ? this.window / (1.5 * slope) : hopMax;
    hop = Math.floor(hop < 32 ? 32 : hop > hopMax ? hopMax : hop);
    const fade = Math.max(Math.floor(0.5 * hop), 8);
    // shifting up, the delay shrinks: start far enough back to last the whole life of the tap
    const nominal = r > 1 ? D_MIN + (r - 1) * (hop + fade) : D_MIN;
    this.pl[0] = hop;
    this.pl[1] = fade;
    this.pl[2] = Math.max(Math.min(Math.floor(nominal), this.tapMax - this.search), D_MIN);
  }

  /** How far (0 … search) to move back from `candidate` so the wave ending there best matches the one ending at `current`. */
  bestOffset(current, candidate) {
    const { buf, size, mask, w, reference, search, dec } = this;
    const m = this.corrLen;
    let energyRef = 0;
    for (let k = 1; k <= m; k++) {
      const at = (w - current - k) & mask;
      reference[k] = buf[at] + buf[size + at];
      energyRef += reference[k] * reference[k];
    }
    if (energyRef < 1e-12) return 0;
    // a coarse pass over every dec-th place (and every dec-th sample), then every place round the best one
    let best = 0;
    let bestScore = -Infinity;
    const coarse = Math.sqrt(dec);
    for (let j = 0; j <= search; j += dec) {
      let corr = 0;
      let energy = 0;
      for (let k = 1; k <= m; k += dec) {
        const at = (w - candidate - j - k) & mask;
        const v = f32(buf[at] + buf[size + at]);
        corr += reference[k] * v;
        energy += v * v;
      }
      const score = (corr / Math.sqrt(energy * energyRef + 1e-20)) * coarse;
      if (score > bestScore + 1e-4) {
        bestScore = score;
        best = j;
      }
    }
    if (dec > 1) {
      const lo = Math.max(0, best - (dec - 1));
      const hi = Math.min(best + dec - 1, search);
      bestScore = -Infinity;
      for (let j = lo; j <= hi; j++) {
        let corr = 0;
        let energy = 0;
        for (let k = 1; k <= m; k++) {
          const at = (w - candidate - j - k) & mask;
          const v = f32(buf[at] + buf[size + at]);
          corr += reference[k] * v;
          energy += v * v;
        }
        const score = corr / Math.sqrt(energy * energyRef + 1e-20);
        if (score > bestScore + 1e-5) {
          bestScore = score;
          best = j;
        }
      }
    }
    return best;
  }

  /** Start the resting tap where the wave matches, and begin to fade the sounding one out. */
  splice() {
    const { tap, pl } = this;
    const n = this.newest * TAP;
    const o = TAP - n;
    this.plan();
    const current = tap[n + DELAY];
    const whole = Math.floor(current);
    const offset = this.bestOffset(whole | 0, pl[2] | 0);
    tap[o + ACTIVE] = 1;
    tap[o + DELAY] = pl[2] + offset + (current - whole); // the same fraction: the two taps stay sample-aligned
    tap[o + T] = 0;
    tap[o + HOP] = pl[0];
    tap[o + FADE_IN] = pl[1];
    tap[o + OUT_START] = -1;
    tap[o + OUT_LEN] = 1;
    tap[n + OUT_START] = tap[n + T];
    tap[n + OUT_LEN] = pl[1];
    this.newest = 1 - this.newest;
  }

  tick() {
    const { io, tap, buf, size, mask, tapMax, w } = this;
    const n = this.newest * TAP;
    if (tap[n + ACTIVE] === 0) {
      // the first sample after a reset: one tap, at full level
      this.plan();
      tap[n + ACTIVE] = 1;
      tap[n + DELAY] = this.pl[2];
      tap[n + T] = 0;
      tap[n + HOP] = this.pl[0];
      tap[n + FADE_IN] = 0;
      tap[n + OUT_START] = -1;
      tap[n + OUT_LEN] = 1;
    } else if (tap[n + T] >= tap[n + HOP] && tap[n + OUT_START] < 0 && tap[TAP - n + ACTIVE] === 0) {
      this.splice();
    }
    const slope = 1 - io[RATIO];
    const mute = io[MUTE] !== 0;
    let outL = 0;
    let outR = 0;
    for (let o = 0; o < 2 * TAP; o += TAP) {
      if (tap[o + ACTIVE] === 0) continue;
      const t = tap[o + T];
      let gain = 1;
      if (t < tap[o + FADE_IN]) {
        const u = t / tap[o + FADE_IN];
        gain = u * u * (3 - 2 * u);
      }
      if (tap[o + OUT_START] >= 0) {
        const u = (t - tap[o + OUT_START]) / tap[o + OUT_LEN];
        if (u >= 1) {
          tap[o + ACTIVE] = 0;
          continue;
        }
        gain *= 1 - u * u * (3 - 2 * u);
      }
      let delay = tap[o + DELAY];
      if (!mute) {
        // a cubic through four points, both channels at the same place
        const q = delay | 0;
        const f = delay - q;
        const p = w - q;
        for (let ch = 0; ch <= size; ch += size) {
          const y0 = buf[ch + ((p + 1) & mask)];
          const y1 = buf[ch + (p & mask)];
          const y2 = buf[ch + ((p - 1) & mask)];
          const y3 = buf[ch + ((p - 2) & mask)];
          const c1 = 0.5 * (y2 - y0);
          const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
          const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
          const v = gain * (((c3 * f + c2) * f + c1) * f + y1);
          if (ch) outR += v; else outL += v;
        }
      }
      delay += slope;
      tap[o + T] = t + 1;
      if (delay < D_MIN || delay > tapMax) {
        // out of room (the ratio moved under it): hold the position and splice early
        delay = delay < D_MIN ? D_MIN : tapMax;
        if (tap[o + OUT_START] < 0) tap[o + HOP] = t + 1;
      }
      tap[o + DELAY] = delay;
    }
    let v = io[IN_L];
    let big = Math.abs(v);
    if (!(big > TINY && big < HUGE)) v = big >= HUGE ? (v > 0 ? HUGE : -HUGE) : 0;
    buf[w] = v;
    v = io[IN_R];
    big = Math.abs(v);
    if (!(big > TINY && big < HUGE)) v = big >= HUGE ? (v > 0 ? HUGE : -HUGE) : 0;
    buf[size + w] = v;
    this.w = (w + 1) & mask;
    io[OUT_L] = outL;
    io[OUT_R] = outR;
  }
}

// the smoothed values of the loop
const S_RATIO_A = 0;
const S_RATIO_B = 1;
const S_BLEND = 2;
const S_PLAIN = 3; // cos(amount · 90°) − 1
const S_SHIFTED = 4; // sin(amount · 90°)
const SMOOTHS = 5;

/**
 * What sits in the reverb's feedback loop: two pitch shifters and the filters that band-limit what they are given.
 * The reverb hands over two parts of its state in io[0], io[1], calls tick(), and adds io[2], io[3] back to them.
 */
class ShimmerLoop {
  constructor(sampleRate) {
    const fs = sampleRate;
    this.fs = fs;
    this.io = new Float64Array(4);
    this.a = new PitchCore(fs, WINDOW_MS, 1);
    this.b = new PitchCore(fs, WINDOW_MS, 0.87); // a slightly different window: the two never splice in step
    this.lp = new Float64Array(5); // b0 b1 b2 a1 a2
    this.lpRatio = -1;
    this.hpA = 1 - Math.exp((-TAU * 60) / fs);
    this.z = new Float64Array(6); // low-pass (two numbers) and high-pass (one) of each side
    this.sCur = new Float64Array(SMOOTHS);
    this.sTgt = new Float64Array(SMOOTHS);
    this.sC = Float64Array.of(onepole(20, fs), onepole(20, fs), onepole(20, fs), onepole(30, fs), onepole(30, fs));
    this.sEps = Float64Array.of(1e-6, 1e-6, 1e-5, 1e-5, 1e-5);
  }

  /** shifts in semitones, blend 0 (A) … 1 (B), amount 0 … 1. */
  set(shiftA, shiftB, blend, amount) {
    const t = this.sTgt;
    // (as 32-bit floats, like the reference: an octave is exactly 2, and the taps move exactly as its taps do)
    t[S_RATIO_A] = f32(Math.pow(2, f32(f32(shiftA) * f32(1 / 12))));
    t[S_RATIO_B] = f32(Math.pow(2, f32(f32(shiftB) * f32(1 / 12))));
    t[S_BLEND] = blend;
    // exact at both ends: amount 0 is the plain reverb
    const angle = clamp(amount, 0, 1) * Math.PI * 0.5;
    t[S_PLAIN] = (amount <= 0 ? 1 : amount >= 1 ? 0 : Math.cos(angle)) - 1;
    t[S_SHIFTED] = amount <= 0 ? 0 : amount >= 1 ? 1 : Math.sin(angle);
    // the low-pass that keeps the larger upward shift from folding back: a Butterworth below Nyquist / ratio
    const top = Math.max(t[S_RATIO_A], t[S_RATIO_B], 1);
    if (Math.abs(top - this.lpRatio) > 1e-4) {
      this.lpRatio = top;
      const w0 = (TAU * Math.min((0.42 * this.fs) / top, 16000)) / this.fs;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const a0 = 1 + alpha;
      this.lp[0] = (1 - cos) / 2 / a0;
      this.lp[1] = (1 - cos) / a0;
      this.lp[2] = this.lp[0];
      this.lp[3] = (-2 * cos) / a0;
      this.lp[4] = (1 - alpha) / a0;
    }
  }

  clear() {
    this.a.reset();
    this.b.reset();
    this.z.fill(0);
  }

  snap() { this.sCur.set(this.sTgt); }

  /** Once per block: numbers that have faded to nothing end their fade (very small numbers are slow on some CPUs). */
  settle() {
    const z = this.z;
    for (let i = 0; i < z.length; i++) if (!(Math.abs(z[i]) > 1e-20)) z[i] = 0;
  }

  tick() {
    const { io, z, lp, sCur, sTgt, sC, sEps, a, b } = this;
    for (let k = 0; k < SMOOTHS; k++) {
      if (sCur[k] === sTgt[k]) continue;
      const e = sTgt[k] - sCur[k];
      sCur[k] = e <= sEps[k] && e >= -sEps[k] ? sTgt[k] : sCur[k] + sC[k] * e;
    }
    const blend = sCur[S_BLEND];
    const plain = sCur[S_PLAIN];
    const shifted = sCur[S_SHIFTED];
    const left = io[0];
    const right = io[1];
    // band-limit what will be shifted
    let y = lp[0] * left + z[0];
    z[0] = lp[1] * left - lp[3] * y + z[1];
    z[1] = lp[2] * left - lp[4] * y;
    z[2] += this.hpA * (y - z[2]);
    const xl = y - z[2];
    y = lp[0] * right + z[3];
    z[3] = lp[1] * right - lp[3] * y + z[4];
    z[4] = lp[2] * right - lp[4] * y;
    z[5] += this.hpA * (y - z[5]);
    const xr = y - z[5];
    // both shifters always run (their taps must be where they would be when the blend moves), but one that will not
    // be heard does not read
    a.io[IN_L] = b.io[IN_L] = xl;
    a.io[IN_R] = b.io[IN_R] = xr;
    a.io[RATIO] = sCur[S_RATIO_A];
    b.io[RATIO] = sCur[S_RATIO_B];
    a.io[MUTE] = shifted === 0 || blend === 1 ? 1 : 0;
    b.io[MUTE] = shifted === 0 || blend === 0 ? 1 : 0;
    a.tick();
    b.tick();
    let ql = a.io[OUT_L] + blend * (b.io[OUT_L] - a.io[OUT_L]);
    let qr = a.io[OUT_R] + blend * (b.io[OUT_R] - a.io[OUT_R]);
    // a safety limiter: exactly linear up to ±4 (+12 dB), then bending towards ±8 — it never touches a normal level
    let big = Math.abs(ql);
    if (!(big <= 4)) ql = big < Infinity ? (ql > 0 ? 4 : -4) * (1 + (big - 4) / big) : 0;
    big = Math.abs(qr);
    if (!(big <= 4)) qr = big < Infinity ? (qr > 0 ? 4 : -4) * (1 + (big - 4) / big) : 0;
    // turn each part towards its shifted self: (cos − 1) · plain + sin · shifted is what has to be added to it
    io[2] = plain * left + shifted * ql;
    io[3] = plain * right + shifted * qr;
  }
}

export class Shimmer extends StudioFx {
  static type = 'shimmer';
  static label = 'Shimmer Reverb';
  static description = 'A reverb whose tail keeps being pitch-shifted as it circulates, so it climbs in octaves (or fifths, or sinks) into a glowing, choir- or organ-like halo above the dry sound: the classic ethereal ambient-guitar and pad sound. Reach for it when a part should bloom into something angelic or otherworldly; it wants slow, sparse material and several seconds of decay.';
  static defs = [
    num('shiftA', 'Shift A', -24, 24, 12, { unit: 'st', automatable: true, description: 'The interval of the first pitch shifter in the reverb\'s feedback loop. +12 is the classic octave-up shimmer; -12 makes the tail sink; +0.1 to 0.3 gives a slowly detuning chorus tail.' }),
    num('shiftB', 'Shift B', -24, 24, 7, { unit: 'st', automatable: true, description: 'The interval of the second pitch shifter. +7 (a fifth) with shift A at +12 builds organ-like stacked fifths; +19 or +24 adds a glassy top. Heard as far as the blend lets it in.' }),
    num('blend', 'Blend A/B', 0, 1, 0, { automatable: true, description: 'Which shifter feeds the tail: 0 is only shift A, 1 only shift B, 0.5 both equally.' }),
    num('amount', 'Shimmer', 0, 1, 0.5, { automatable: true, description: 'How much of the sound circulating in the reverb is pitch-shifted on each pass. 0 is a plain reverb; 0.3–0.6 lets shifted layers bloom over a few seconds; 1 makes the tail race upward (or downward) and die away sooner, because everything keeps leaving the audible range.' }),
    num('decay', 'Decay', 0.5, 60, 6, { unit: 's', curve: 'log', automatable: true, description: 'The reverberation time of the unshifted tail: the seconds it takes to fade by 60 dB in the mid range (exact when the shimmer amount is 0). Shimmer needs time to build: 4–12 s is typical, 30 s or more for endless swells.' }),
    num('size', 'Size', 0, 1, 0.6, { automatable: true, description: 'The size of the space, from half (0) to double (1) its natural size. Larger spaces put the pitch steps further apart in time, so the climb is slower and smoother.' }),
    num('damping', 'Damping', 500, 20000, 7000, { unit: 'Hz', curve: 'log', automatable: true, description: 'Frequencies above this fade about twice as fast — which also decides how high the shimmer can climb before it disappears. 3–5 kHz is soft and choir-like; 10 kHz and above is icy and bright.' }),
    num('modDepth', 'Mod depth', 0, 1, 0.4, { automatable: true, description: 'Slow chorusing of the tail. It blurs the stepped character of the pitch shifting into a smooth pad; 0 leaves the octave steps exact and more organ-like.' }),
    num('predelay', 'Pre-delay', 0, 250, 20, { unit: 'ms', automatable: true, description: 'The gap between the dry sound and the start of the reverb. It keeps the attack of the source clear of the swell.' }),
    num('mix', 'Mix', 0, 1, 0.35, { automatable: true, description: 'The balance between the dry signal (0) and the shimmer reverb (1), at equal power. 0.2–0.4 on an insert, 1 on a send.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    this.core = new ReverbCore(sampleRate);
    // the space is fixed: its own voicing, a little low cut, dense, slowly chorused, quiet early reflections
    this.core.voicing = SHIMMER_VOICING;
    this.core.lowCut = 100;
    this.core.diffusion = 0.9;
    this.core.modRate = 0.4;
    this.core.early = 0.25;
    this.core.width = 1;
    this.loop = new ShimmerLoop(sampleRate);
    this.fresh = true; // nothing has sounded yet: settings take hold at once instead of gliding
    this.update();
  }

  update() {
    const { p, core } = this;
    this.loop.set(p.shiftA, p.shiftB, p.blend, p.amount);
    core.size = p.size;
    core.decay = p.decay;
    core.predelay = p.predelay;
    core.damping = p.damping;
    core.modDepth = p.modDepth;
    core.setMix(p.mix);
  }

  reset() {
    this.core.clear();
    this.loop.clear();
    this.fresh = true;
  }

  /** Seconds the tail may still be heard after its input stops (an upper estimate). */
  get tail() { return this.core.tail; }

  process(L, R, n) {
    if (this.fresh) {
      this.core.snap();
      this.loop.snap();
      this.fresh = false;
    }
    this.core.process(L, R, n, this.loop);
    this.loop.settle();
  }
}
