// Transient shaper: makes the hit of each note louder or softer, and its tail longer or shorter, without a threshold —
// it works the same on a loud drum and a quiet one. The principle is that of the SPL Transient Designer: envelopes
// that follow the level at different speeds are compared, and only their ratio (in dB) drives the gain.
// A port of the transient effect of the GGS Composer rack (fx-classic/transient.rs), with the same time constants and
// ranges.
import { StudioFx, Smoothed, num, onepole, safe } from './base.js';

const ATTACK_RANGE_DB = 12; // the most the hit is raised or lowered
const SUSTAIN_RANGE_DB = 24; // the most the tail is raised or lowered
const FLOOR = 1e-3; // (−60 dB) added to the levels before they are compared, so that silence does not read as a transient
const PEAK_RELEASE_MS = 10; // the level is first made into a peak envelope without the ripple of the wave itself
const FAST_MS = 0.3; // rise of the envelope that is "the level now"
const SLOW_MS = 25; // rise of the one that lags behind when a note starts
const RELEASE_MS = 80; // fall of both
const LONG_MS = 400; // fall of the one that hangs on while a note dies away
const BASELINE_MS = 250; // the average of the onset signal: what a held low note reads all the time is not an onset
const GAIN_MS = 0.5; // the gain itself moves this smoothly (no look-ahead: this much of a hit passes before it reacts)

const DB_PER_LN = 20 / Math.LN10; // 20·log10(x) = this · ln(x)
const LN_PER_DB = Math.LN10 / 20;

/** Let a glide arrive. One that only ever comes closer ends among numbers too small to compute with quickly — and "off" would never be exactly off. */
const land = (s) => { if (s.value !== s.target && s.settled) s.value = s.target; };
/** What has faded to nothing is nothing (and a NaN is nothing too). */
const flush = (v) => (v > 1e-30 || v < -1e-30 ? v : 0);

export class TransientShaper extends StudioFx {
  static type = 'transient';
  static label = 'Transient Shaper';
  static description = 'Changes the balance between the hit and the tail of each note, without a threshold — so it works the same at any level. Attack makes onsets punchier or softer; sustain makes tails longer and roomier, or shorter and tighter. Reach for it on drums, percussion, plucks and bass to add snap, tame clicks, tighten boomy decays or bring out the room. Both controls at 0 change nothing. No latency (so the first third of a millisecond of a hit passes before the gain reacts).';
  static defs = [
    num('attack', 'Attack', -1, 1, 0, { automatable: true, description: 'Emphasis of the start of each note, whatever its level. Positive values (up to +12 dB on the hit) make drums and plucks punchier and more forward; negative values soften the hit and push the sound back. 0 is neutral.' }),
    num('sustain', 'Sustain', -1, 1, 0, { automatable: true, description: 'Emphasis of the part of each note that dies away (up to ±24 dB). Positive values lengthen tails and bring up room sound and body; negative values shorten and dry the sound, tightening drums like a gate. 0 is neutral.' }),
    num('output', 'Output', -24, 24, 0, { unit: 'dB', automatable: true, description: 'Output level, to make up for what the shaping does to the loudness: more attack is louder peaks, less sustain is a quieter sound.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    this.cFast = onepole(FAST_MS, sampleRate);
    this.cSlow = onepole(SLOW_MS, sampleRate);
    this.cRel = onepole(RELEASE_MS, sampleRate);
    this.cLong = onepole(LONG_MS, sampleRate);
    this.cGain = onepole(GAIN_MS, sampleRate);
    this.cBase = onepole(BASELINE_MS, sampleRate);
    this.peakDecay = 1 - onepole(PEAK_RELEASE_MS, sampleRate);
    this.attack = new Smoothed(0, 10, sampleRate);
    this.sustain = new Smoothed(0, 10, sampleRate);
    this.output = new Smoothed(0, 10, sampleRate); // in dB
    this.peak = 0;
    this.fast = 0;
    this.slow = 0;
    this.long = 0;
    this.baseline = 0;
    this.gainDb = 0;
    this.fresh = true; // nothing has been heard yet: settings start where they are put, they do not glide there
    this.update();
  }

  update() {
    this.attack.set(this.p.attack);
    this.sustain.set(this.p.sustain);
    this.output.set(this.p.output);
    if (this.fresh) {
      this.attack.snap(this.p.attack);
      this.sustain.snap(this.p.sustain);
      this.output.snap(this.p.output);
    }
  }

  reset() {
    this.peak = 0;
    this.fast = 0;
    this.slow = 0;
    this.long = 0;
    this.baseline = 0;
    this.gainDb = 0;
    this.fresh = true;
    this.update();
  }

  process(L, R, n) {
    this.fresh = false;
    const { cFast, cSlow, cRel, cLong, cGain, cBase, peakDecay, attack, sustain, output } = this;
    let { peak, fast, slow, long, baseline, gainDb } = this;
    for (let i = 0; i < n; i++) {
      const xl = safe(L[i]); // (a NaN must not get into the followers: it would stay there)
      const xr = safe(R[i]);
      // one level for both channels (the louder one), so the stereo image does not move with the gain
      const al = xl < 0 ? -xl : xl;
      const ar = xr < 0 ? -xr : xr;
      const held = peak * peakDecay;
      const now = al > ar ? al : ar;
      peak = now > held ? now : held;
      fast += (peak > fast ? cFast : cRel) * (peak - fast);
      slow += (peak > slow ? cSlow : cRel) * (peak - slow);
      long += (peak > long ? cFast : cLong) * (peak - long);

      // fast over slow is above 1 only while a note starts; long over fast only while it dies away. In dB, and with
      // the level they share divided out, they say "onset" and "tail" the same for a loud note and a quiet one.
      // The reference stops following the baseline while attack is exactly 0; here it is always followed, so that
      // an attack automated up from 0 during a held note does not start from a stale average.
      const onset = DB_PER_LN * Math.log((fast + FLOOR) / (slow + FLOOR));
      baseline += cBase * (onset - baseline);
      let rise = onset - baseline;
      rise = rise < 0 ? 0 : rise > ATTACK_RANGE_DB ? ATTACK_RANGE_DB : rise;
      let fall = DB_PER_LN * Math.log((long + FLOOR) / (fast + FLOOR));
      fall = fall < 0 ? 0 : fall > SUSTAIN_RANGE_DB ? SUSTAIN_RANGE_DB : fall;
      gainDb += cGain * (attack.next() * rise + sustain.next() * fall - gainDb);

      const shaped = gainDb > 24 ? 24 : gainDb < -24 ? -24 : gainDb;
      const g = Math.exp(LN_PER_DB * (shaped + output.next()));
      L[i] = safe(xl * g);
      R[i] = safe(xr * g);
    }
    // once a block: what has faded to nothing is nothing (numbers that small are slow on some CPUs)
    this.peak = flush(peak);
    this.fast = flush(fast);
    this.slow = flush(slow);
    this.long = flush(long);
    this.baseline = flush(baseline);
    this.gainDb = flush(gainDb);
    land(attack);
    land(sustain);
    land(output);
  }
}
