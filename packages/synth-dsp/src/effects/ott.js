// Multiband upward/downward compressor: the "OTT" sound. The signal is split into three bands and each band is
// squeezed from both sides — what is loud is pulled down hard, what is quiet is lifted — so every detail, harmonic and
// tail ends up at nearly the same level: dense, bright, forward.
// A port of the multiband effect of the GGS Composer rack (fx-classic/multiband.rs): the same crossover, thresholds,
// slopes, knee, times and make-up gains.
import { StudioFx, Smoothed, num, TAU, clamp, dbToLin, onepole, safe } from './base.js';

// per band: low, mid, high. The times are those of the well-known multiband-dynamics preset the effect is named after.
const ATTACK_MS = [48, 22, 13.5];
const RELEASE_MS = [282, 282, 132];
const MAKEUP_DB = [8, 5, 8];
const DOWN_THRESHOLD_DB = -27; // a band louder than this is pulled back…
const DOWN_SLOPE = 0.95; //       …by 0.95 dB for every dB over (20:1)
const UP_THRESHOLD_DB = -40; //   a band quieter than this is lifted…
const UP_SLOPE = 0.76; //         …by 0.76 dB for every dB under (4.2:1)…
const UP_MAX_DB = 30; //          …but never by more than this (silence would become hiss at full level)
const KNEE_DB = 6; //             both curves bend into their slope over 6 dB instead of turning a corner
const HALF_KNEE = KNEE_DB / 2;

const DB_PER_LN_POWER = 10 / Math.LN10; // 10·log10(x) = this · ln(x)
const LN_PER_DB = Math.LN10 / 20; //       10^(dB / 20) = exp(this · dB)
// a crossover that is told to move glides there (in octaves, a step every few samples): a filter whose frequency
// jumps rings with what it remembers of the old one, and that is a click
const RETUNE_EVERY = 16;
const RETUNE_MS = 30;

/** Let a glide arrive. One that only ever comes closer ends among numbers too small to compute with quickly — and "off" would never be exactly off. */
const land = (s) => { if (s.value !== s.target && s.settled) s.value = s.target; };

export class Ott extends StudioFx {
  static type = 'ott';
  static label = 'Multiband (OTT)';
  static description = 'Three-band upward and downward compression — the famous OTT sound. In the low, mid and high bands separately it squashes what is loud and lifts what is quiet, so every detail, harmonic and tail is pushed forward and the spectrum ends up flat, bright and dense. Depth sets how extreme it is: 0.2–0.4 adds polish and brightness, 1 is the hyper-compressed sound of modern basses, leads, plucks and drums. It also raises noise and reverb tails, and the first instant of a sound that starts from silence comes through louder than the rest. No latency.';
  static defs = [
    num('depth', 'Depth', 0, 1, 0.5, { automatable: true, description: 'Overall amount of multiband compression. 0 leaves every level as it is; 0.2–0.4 adds density and brightness; 1 is the full, hyper-compressed OTT sound where quiet details, noise and reverb tails are pulled right up.' }),
    num('time', 'Time', 0.1, 10, 1, { curve: 'log', description: 'Scales the attack and release times of all three bands (1 = the classic times). Below 1 it reacts faster: aggressive, gritty, almost distorted. Above 1 it is slower and smoother, and more of the punch gets through.' }),
    num('lowMid', 'Low/mid split', 40, 1000, 120, { unit: 'Hz', curve: 'log', description: 'Where the low band ends and the mid band begins. 120 Hz keeps the sub and the kick\'s weight in a band of their own; raise it to treat the whole bass as one.' }),
    num('midHigh', 'Mid/high split', 1000, 12000, 2500, { unit: 'Hz', curve: 'log', description: 'Where the mid band ends and the high band begins. 2.5 kHz is the classic setting; higher leaves only the air and the fizz to the high band.' }),
    num('lowGain', 'Low gain', -24, 24, 0, { unit: 'dB', automatable: true, description: 'Level of the low band after compression. Use it to put back, or take away, bass weight.' }),
    num('midGain', 'Mid gain', -24, 24, 0, { unit: 'dB', automatable: true, description: 'Level of the mid band after compression. Use it to rebalance body and presence.' }),
    num('highGain', 'High gain', -24, 24, 0, { unit: 'dB', automatable: true, description: 'Level of the high band after compression. Lower it when the result is too bright or fizzy.' }),
    num('upward', 'Upward', 0, 1, 1, { automatable: true, description: 'Amount of upward compression: how much quiet material (below −40 dB in a band) is lifted. This is what brings out detail, sustain and noise; lower it to keep tails and the background quiet.' }),
    num('downward', 'Downward', 0, 1, 1, { automatable: true, description: 'Amount of downward compression: how much loud material (above −27 dB in a band) is squashed. This is what flattens peaks and evens out the spectrum.' }),
    num('output', 'Output', -24, 24, 0, { unit: 'dB', automatable: true, description: 'Level of the compressed signal. At full depth a mix comes out several dB hotter or quieter than it went in: match it here.' }),
    num('mix', 'Mix', 0, 1, 1, { automatable: true, description: 'Blend between the untouched signal (0) and the compressed one (1), for parallel multiband compression: 0.3–0.5 keeps the punch of the original with the density of the effect underneath.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    // Each channel is split by three 24 dB/oct Linkwitz-Riley crossovers (two Butterworth filters in a row), eight
    // numbers of filter memory each: the lower split, the upper split of what is above it — and the upper split
    // again on the low band, both halves summed. That last one is an all-pass: it turns the phase of the low band the
    // way the upper split turns the other two, so the three bands add up to the input with every frequency at its
    // level (only the phase is turned: a second-order all-pass at each crossover).
    this.memory = new Float64Array(48);
    this.k = new Float64Array(8); // per crossover: low-pass b0, high-pass b0, a1, a2 (the two share their poles)
    this.band = new Float64Array(6);
    this.env = new Float64Array(3); // each band's power, followed
    this.att = new Float64Array(3);
    this.rel = new Float64Array(3);
    this.depth = new Smoothed(0, 10, sampleRate);
    this.up = new Smoothed(0, 10, sampleRate);
    this.down = new Smoothed(0, 10, sampleRate);
    this.trim = [new Smoothed(0, 10, sampleRate), new Smoothed(0, 10, sampleRate), new Smoothed(0, 10, sampleRate)];
    this.out = new Smoothed(1, 10, sampleRate);
    this.dry = new Smoothed(0, 10, sampleRate);
    this.wet = new Smoothed(1, 10, sampleRate);
    this.viaSplit = new Smoothed(1, 5, sampleRate); // 1 = the dry signal goes through the crossover too, 0 = it is the input itself
    this.cTune = onepole(RETUNE_MS, sampleRate / RETUNE_EVERY);
    this.lo = 0;
    this.hi = 0;
    this.moving = false;
    this.wait = 0;
    this.reduction = 0;
    this.fresh = true; // nothing has been heard yet: settings start where they are put, they do not glide there
    this.update();
  }

  update() {
    const p = this.p;
    this.depth.set(p.depth);
    this.up.set(p.upward);
    this.down.set(p.downward);
    this.trim[0].set(p.lowGain);
    this.trim[1].set(p.midGain);
    this.trim[2].set(p.highGain);
    this.out.set(dbToLin(p.output));
    this.dry.set(1 - p.mix);
    this.wet.set(p.mix);
    // The dry part of a mix goes through the crossover as well: its phase is then turned like that of the bands, and
    // the blend cannot comb. Only at a mix of exactly 0 is it the input itself, so that "0" is the input bit for bit.
    this.viaSplit.set(p.mix > 0 ? 1 : 0);
    for (let b = 0; b < 3; b++) {
      this.att[b] = onepole(ATTACK_MS[b] * p.time, this.fs);
      this.rel[b] = onepole(RELEASE_MS[b] * p.time, this.fs);
    }
    if (this.fresh) {
      this.depth.snap(this.depth.target);
      this.up.snap(this.up.target);
      this.down.snap(this.down.target);
      for (let b = 0; b < 3; b++) this.trim[b].snap(this.trim[b].target);
      this.out.snap(this.out.target);
      this.dry.snap(this.dry.target);
      this.wet.snap(this.wet.target);
      this.viaSplit.snap(this.viaSplit.target);
      this.lo = p.lowMid;
      this.hi = p.midHigh;
      this.moving = false;
      this.tune();
    } else if (this.lo !== p.lowMid || this.hi !== p.midHigh) this.moving = true;
  }

  /** The crossover filters for where the two splits are now. */
  tune() {
    const { k, fs } = this;
    // (as the reference: the upper split stays above the lower one, and both well below half the sample rate)
    const lo = clamp(this.lo, 20, fs * 0.4);
    const hi = clamp(this.hi, lo * 1.01, fs * 0.45);
    for (let x = 0; x < 2; x++) {
      // RBJ low-pass and high-pass at Q = 1/√2 (Butterworth): two of each in a row are a Linkwitz-Riley split
      const w = (TAU * (x === 0 ? lo : hi)) / fs;
      const cos = Math.cos(w);
      const alpha = Math.sin(w) * Math.SQRT1_2;
      const a0 = 1 + alpha;
      k[x * 4] = (1 - cos) / (2 * a0);
      k[x * 4 + 1] = (1 + cos) / (2 * a0);
      k[x * 4 + 2] = (-2 * cos) / a0;
      k[x * 4 + 3] = (1 - alpha) / a0;
    }
  }

  /** One step of the splits towards where the knobs are. */
  retune() {
    const p = this.p;
    let lo = this.lo * Math.pow(p.lowMid / this.lo, this.cTune);
    let hi = this.hi * Math.pow(p.midHigh / this.hi, this.cTune);
    if (Math.abs(lo / p.lowMid - 1) < 1e-3) lo = p.lowMid;
    if (Math.abs(hi / p.midHigh - 1) < 1e-3) hi = p.midHigh;
    this.lo = lo;
    this.hi = hi;
    this.moving = lo !== p.lowMid || hi !== p.midHigh;
    this.tune();
  }

  reset() {
    this.memory.fill(0);
    this.env.fill(0);
    this.reduction = 0;
    this.wait = 0;
    this.fresh = true;
    this.update();
  }

  /** The deepest downward gain reduction of the last block, dB (0 = no band was over its threshold). */
  get meter() { return this.reduction; }

  process(L, R, n) {
    this.fresh = false;
    const { memory: s, k, band, env, att, rel, trim, depth, up, down, out, dry, wet, viaSplit } = this;
    let deepest = 0;
    for (let i = 0; i < n; i++) {
      if (this.moving && --this.wait <= 0) {
        this.wait = RETUNE_EVERY;
        this.retune();
      }
      // (a NaN or an explosion upstream must not get into the filters and the followers: it would stay there)
      const xl = safe(L[i]);
      const xr = safe(R[i]);
      for (let ch = 0; ch < 2; ch++) {
        let low = 0;
        let rest = 0;
        // the three crossovers of this channel: the input at the lower split; what is above it at the upper split;
        // what is below it at the upper split too, summed again (the all-pass that keeps the bands in step)
        for (let x = 0; x < 3; x++) {
          const u = x === 0 ? (ch === 0 ? xl : xr) : x === 1 ? rest : low;
          const c = x === 0 ? 0 : 4;
          const m = ch * 24 + x * 8;
          const lb = k[c];
          const hb = k[c + 1];
          const a1 = k[c + 2];
          const a2 = k[c + 3];
          // two low-pass sections in a row (transposed direct form II; b1 = 2·b0, b2 = b0)…
          let y = lb * u + s[m];
          s[m] = 2 * lb * u - a1 * y + s[m + 1];
          s[m + 1] = lb * u - a2 * y;
          const lp = lb * y + s[m + 2];
          s[m + 2] = 2 * lb * y - a1 * lp + s[m + 3];
          s[m + 3] = lb * y - a2 * lp;
          // …and two high-pass sections (b1 = −2·b0, b2 = b0)
          y = hb * u + s[m + 4];
          s[m + 4] = -2 * hb * u - a1 * y + s[m + 5];
          s[m + 5] = hb * u - a2 * y;
          const hp = hb * y + s[m + 6];
          s[m + 6] = -2 * hb * y - a1 * hp + s[m + 7];
          s[m + 7] = hb * y - a2 * hp;
          if (x === 0) {
            low = lp;
            rest = hp;
          } else if (x === 1) {
            band[ch * 3 + 1] = lp;
            band[ch * 3 + 2] = hp;
          } else band[ch * 3] = lp + hp;
        }
      }

      const amount = depth.next();
      const upAmount = up.next();
      const downAmount = down.next();
      let wl = 0;
      let wr = 0;
      for (let b = 0; b < 3; b++) {
        const bl = band[b];
        const br = band[3 + b];
        // one follower for both channels (the louder one counts), so the stereo image does not move with the gain
        const pl = bl * bl;
        const pr = br * br;
        const power = pl > pr ? pl : pr;
        let e = env[b];
        e += (power > e ? att[b] : rel[b]) * (power - e);
        env[b] = e;
        const level = DB_PER_LN_POWER * Math.log(e + 1e-12);
        // how far over the upper threshold, how far under the lower one — each through its soft knee
        let over = level - DOWN_THRESHOLD_DB;
        over = over <= -HALF_KNEE ? 0 : over < HALF_KNEE ? ((over + HALF_KNEE) * (over + HALF_KNEE)) / (2 * KNEE_DB) : over;
        let under = UP_THRESHOLD_DB - level;
        under = under <= -HALF_KNEE ? 0 : under < HALF_KNEE ? ((under + HALF_KNEE) * (under + HALF_KNEE)) / (2 * KNEE_DB) : under;
        const cut = DOWN_SLOPE * over * downAmount;
        let lift = UP_SLOPE * under;
        if (lift > UP_MAX_DB) lift = UP_MAX_DB;
        lift *= upAmount;
        if (cut * amount > deepest) deepest = cut * amount;
        // depth scales the whole change in dB, so depth 0 is a gain of exactly 1 in every band
        const g = Math.exp(LN_PER_DB * (amount * (lift - cut + MAKEUP_DB[b]) + trim[b].next()));
        wl += bl * g;
        wr += br * g;
      }

      const via = viaSplit.next();
      const dryGain = dry.next();
      const wetGain = out.next() * wet.next();
      const dl = xl + via * (band[0] + band[1] + band[2] - xl);
      const dr = xr + via * (band[3] + band[4] + band[5] - xr);
      L[i] = safe(dl * dryGain + wl * wetGain);
      R[i] = safe(dr * dryGain + wr * wetGain);
    }
    this.reduction = deepest > 0 ? -deepest : 0;
    // once a block: what has faded to nothing is nothing (numbers that small are slow on some CPUs)
    for (let j = 0; j < 48; j++) if (!(s[j] > 1e-30 || s[j] < -1e-30)) s[j] = 0;
    for (let b = 0; b < 3; b++) {
      if (!(env[b] > 1e-30)) env[b] = 0;
      land(trim[b]);
    }
    land(depth);
    land(up);
    land(down);
    land(out);
    land(dry);
    land(wet);
    land(viaSplit);
  }
}
