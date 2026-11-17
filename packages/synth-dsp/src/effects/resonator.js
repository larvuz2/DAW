// Resonator: five tuned strings that ring in a chord with whatever is played through them — drums, noise or speech
// come out as a chord (sympathetic strings, a tuned room, "a chord from noise").
//
// Ported from the Rust reference (fx-space/resonator.rs). Each voice is a feedback comb in the Karplus–Strong
// tradition: a delay line one period long, closed through a one-pole low-pass (the string losing its brightness)
// and a gain (its decay time). It peaks at the note and at every harmonic of it.
//  - Tuning: the loop must be exactly one period long at the note. The delay is read between samples (a cubic
//    through four points), and its length is the period minus the delay of the damping filter and minus the small
//    delay error of the interpolator, both worked out at the note's frequency: the peaks sit within a fraction of
//    a cent of the notes.
//  - Decay: the loop gain makes the note itself fade by 60 dB in the decay time, whatever the note and the
//    damping; the harmonics fade faster as the damping rises.
//  - Level: each voice's input is scaled by √(1 − g²), so broadband sound comes out at about its own level for any
//    decay. A tone that sits exactly on a resonance can still build up far above that, so the loop holds a limiter
//    that does nothing below +9.5 dBFS and never passes +15.5 dBFS.
//  - Notes above 4 kHz (or a tenth of the sample rate) are folded down by octaves.
// Changed from the reference: keys and units only (`root` is a MIDI note number, `detune` is in cents).
import { StudioFx, DelayLine, Biquad, Smoothed, num, choice, safe, dbToLin, TAU } from './base.js';

const CHORDS = ['unison', 'octaves', 'fifth', 'major', 'minor', 'sus2', 'sus4', 'maj7', 'min7', 'stackFifths', 'cluster'];
const VOICES = 5;
/** Semitones of the five voices above the root, for each chord. */
const CHORD_TABLE = {
  unison: [0, 0, 0, 0, 0],
  octaves: [0, -12, 12, 24, 12],
  fifth: [0, 7, 12, 19, 24],
  major: [0, 4, 7, 12, 16],
  minor: [0, 3, 7, 12, 15],
  sus2: [0, 2, 7, 12, 14],
  sus4: [0, 5, 7, 12, 17],
  maj7: [0, 4, 7, 11, 14],
  min7: [0, 3, 7, 10, 14],
  stackFifths: [0, 7, 14, 21, 28],
  cluster: [0, 1, 2, 3, 4]
};
/** Detune of each voice as a fraction of `detune` (the root voice stays put), and its place as a fraction of `spread`. */
const DETUNE_PATTERN = [0, -1, 1, -0.6, 0.6];
const PAN_PATTERN = [0, -1, 1, -0.5, 0.5];
/** Loop gain, damping and tuning correction are worked out once per this many samples. */
const CONTROL = 32;
const MIN_HZ = 15;
/** The limiter in each loop: linear up to this, never beyond twice this. */
const LIMIT = 3;
/** A gain of exp(−LN1000 · t / T60) fades by 60 dB in T60. */
const LN1000 = Math.log(1000);

/** A Smoothed that arrives: within `eps` of its target it is the target (mix 0 is the dry signal, bit for bit). */
class Glide extends Smoothed {
  constructor(value, ms, rate, eps) {
    super(value, ms, rate);
    this.eps = eps;
  }

  next() {
    const d = this.target - this.value;
    this.value = d > this.eps || d < -this.eps ? this.value + this.c * d : this.target;
    return this.value;
  }
}

/** Linear up to ±t, then bending towards ±2t; nothing for what is not a number. An overload stays bounded, a normal level is not touched. */
const guard = (x, t) => {
  const a = x < 0 ? -x : x;
  if (a <= t) return x;
  if (!(a < Infinity)) return 0;
  const over = (a - t) / t;
  return (x < 0 ? -t : t) * (1 + over / (1 + over));
};

/** What goes round a loop: nothing too small to matter (those numbers are slow), nothing absurd. */
const flush = (x) => (x > 1e-15 || x < -1e-15 ? (x > 1e6 ? 1e6 : x < -1e6 ? -1e6 : x) : 0);

export class Resonator extends StudioFx {
  static type = 'resonator';
  static label = 'Resonator';
  static description = 'Five tuned strings that ring in sympathy with whatever passes through them, so drums, noise, speech or any other sound come out as a chord of your choice. Short decays colour the input with the chord like a tuned body; long decays sustain it like the sympathetic strings of a sitar, or a drone. Set the key with root and chord. Percussive or noisy material excites it most clearly.';
  static defs = [
    num('root', 'Root note', 24, 96, 48, { automatable: true, description: 'Root of the chord as a MIDI note, 60 = middle C (48 = the C below, 69 = A 440 Hz); fractions are allowed for microtuning. The resonators ring at this note and at the other notes of the chord. Changes glide over a few hundredths of a second.' }),
    choice('chord', 'Chord', CHORDS, 'major', { description: 'The notes the five resonators are tuned to, in semitones above the root: unison (all on the root, a chorus of strings), octaves (-12, 0, +12, +24), fifth (0, 7, 12, 19, 24: a power chord), major (0, 4, 7, 12, 16), minor (0, 3, 7, 12, 15), sus2 (0, 2, 7, 12, 14), sus4 (0, 5, 7, 12, 17), maj7 (0, 4, 7, 11, 14), min7 (0, 3, 7, 10, 14), stackFifths (0, 7, 14, 21, 28: open and airy), cluster (five neighbouring semitones: dense and dissonant). Notes above 4 kHz ring an octave (or more) lower.' }),
    num('decay', 'Decay', 0.05, 20, 3, { unit: 's', curve: 'log', description: 'How long each resonator rings after it is excited: the time its note takes to fade by 60 dB. Short (0.05–0.3 s) only colours the input with the chord, like a tuned box; long (2–20 s) sustains like undamped strings or a drone.' }),
    num('damping', 'Damping', 0, 1, 0.3, { description: 'How quickly the high harmonics of each string die away. 0 is bright and metallic (every harmonic rings equally, like a comb filter); 0.3–0.5 is a plucked string; 1 is dull and soft, almost a pure tone.' }),
    num('detune', 'Detune', 0, 50, 3, { description: 'Spreads the tuning of four of the five resonators by up to this many cents (hundredths of a semitone); the root stays exact. A few cents make the chord shimmer and beat slowly like real strings; 20–50 is honky-tonk.' }),
    num('spread', 'Spread', 0, 1, 0.7, { description: 'Where the resonators sit in the stereo field: 0 puts all of them in the centre, 1 fans them out from hard left to hard right.' }),
    num('drive', 'Input drive', 0, 24, 0, { unit: 'dB', description: 'Gain on the signal that excites the resonators, into a soft clipper. Raise it when the input is quiet or percussive and the chord is too faint; high settings add grit and make the strings ring louder and longer above the dry sound.' }),
    num('mix', 'Mix', 0, 1, 0.5, { automatable: true, description: 'Balance between the dry signal (0) and the resonators (1), at equal power: 0.5 is both at −3 dB. Use 1 on a send, or to hear only the chord.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    const controlRate = sampleRate / CONTROL;
    this.lines = [];
    this.period = []; // samples, gliding
    this.panL = [];
    this.panR = [];
    for (let v = 0; v < VOICES; v++) {
      this.lines.push(new DelayLine(Math.floor(sampleRate / MIN_HZ) + 16));
      this.period.push(new Glide(100, 25, sampleRate, 1e-4));
      this.panL.push(new Glide(1, 20, sampleRate, 1e-5));
      this.panR.push(new Glide(1, 20, sampleRate, 1e-5));
    }
    this.offset = new Float64Array(VOICES); // delay-line length minus period: what the filters in the loop delay
    this.lp = new Float64Array(VOICES); // damping filter: its state, its coefficient
    this.lpA = new Float64Array(VOICES).fill(1);
    this.gain = new Float64Array(VOICES);
    this.inGain = new Float64Array(VOICES);
    this.hp = new Biquad();
    this.sDecay = new Glide(3, 30, controlRate, 1e-4);
    this.sDamping = new Glide(0.3, 30, controlRate, 1e-4);
    this.sDrive = new Glide(1, 20, sampleRate, 1e-5);
    this.dry = new Glide(1, 12, sampleRate, 1e-5);
    this.wet = new Glide(0, 12, sampleRate, 1e-5);
    this.update();
    this.reset();
  }

  /** The frequency voice `v` is tuned to. */
  voiceHz(v) {
    const p = this.p;
    const note = p.root + CHORD_TABLE[p.chord][v] + 0.01 * p.detune * DETUNE_PATTERN[v];
    let hz = 440 * Math.pow(2, (note - 69) / 12);
    const top = Math.min(0.1 * this.fs, 4000);
    while (hz > top) hz *= 0.5;
    return Math.max(hz, MIN_HZ);
  }

  update() {
    const p = this.p;
    for (let v = 0; v < VOICES; v++) {
      this.period[v].set(this.fs / this.voiceHz(v));
      // equal power, and a voice in the centre at unity on both sides
      const angle = (PAN_PATTERN[v] * p.spread + 1) * (Math.PI * 0.25);
      this.panL[v].set(Math.SQRT2 * Math.cos(angle));
      this.panR[v].set(Math.SQRT2 * Math.sin(angle));
    }
    this.sDecay.set(p.decay);
    this.sDamping.set(p.damping);
    this.sDrive.set(dbToLin(p.drive));
    const m = p.mix;
    this.dry.set(m <= 0 ? 1 : m >= 1 ? 0 : Math.cos(m * Math.PI * 0.5));
    this.wet.set(m <= 0 ? 0 : m >= 1 ? 1 : Math.sin(m * Math.PI * 0.5));
  }

  reset() {
    for (let v = 0; v < VOICES; v++) this.lines[v].clear();
    this.lp.fill(0);
    this.hp.reset();
    this.hpFreq = -1;
    this.phase = 0;
    this.fresh = true;
  }

  /** Once per CONTROL samples: loop gain, damping filter and tuning correction of every voice. */
  control() {
    const fs = this.fs;
    const decay = Math.max(this.sDecay.next(), 0.01);
    const damping = Math.min(1, Math.max(0, this.sDamping.next()));
    let lowest = Infinity;
    for (let v = 0; v < VOICES; v++) {
      const period = this.period[v].value;
      const hz = fs / period;
      if (hz < lowest) lowest = hz;
      const w = TAU / period;
      // damping: a low-pass from 128× the note (open) down to 1.4× (dull)
      const fc = Math.min(hz * Math.pow(2, 7 - 6.5 * damping), 0.45 * fs);
      const a = 1 - Math.exp((-TAU * fc) / fs);
      // …which delays the note by lpDelay samples and passes lpMag of it (y += a·(x − y), at w)
      const b = 1 - a;
      const lre = 1 - b * Math.cos(w);
      const lim = b * Math.sin(w);
      const lpDelay = Math.atan2(lim, lre) / w;
      const lpMag = a / Math.sqrt(lre * lre + lim * lim);
      // the delay line makes up the rest of the period; read at a fraction t between two samples, the cubic
      // itself is a little off the delay it is asked for (hDelay instead of t) and a little under unity (hMag)
      const wanted = period - lpDelay;
      const t = wanted - Math.floor(wanted);
      const t2 = t * t;
      const t3 = t2 * t;
      // its four taps, at −1, 0, +1 and +2 samples of extra delay
      const h0 = -0.5 * t + t2 - 0.5 * t3;
      const h1 = 1 - 2.5 * t2 + 1.5 * t3;
      const h2 = 0.5 * t + 2 * t2 - 1.5 * t3;
      const h3 = -0.5 * t2 + 0.5 * t3;
      const hre = h0 * Math.cos(w) + h1 + h2 * Math.cos(w) + h3 * Math.cos(2 * w);
      const him = h0 * Math.sin(w) - h2 * Math.sin(w) - h3 * Math.sin(2 * w);
      const hDelay = -Math.atan2(him, hre) / w;
      const hMag = Math.sqrt(hre * hre + him * him);
      // 60 dB in `decay` seconds at the note, after what the two filters lose on their own
      const target = Math.exp(-LN1000 / (hz * decay));
      this.lpA[v] = a;
      this.gain[v] = Math.min(target / (lpMag * hMag), 0.99995);
      this.inGain[v] = Math.sqrt(1 - target * target);
      this.offset[v] = wanted - (hDelay - t) - period;
    }
    // a high-pass on the input well below the lowest string: a comb resonates at 0 Hz too
    const hp = Math.max(0.5 * lowest, MIN_HZ);
    if (Math.abs(hp - this.hpFreq) > 0.01 * hp) {
      this.hpFreq = hp;
      this.hp.design('highpass', fs, hp, Math.SQRT1_2);
    }
  }

  process(L, R, n) {
    const { lines, period, panL, panR, offset, lp, lpA, gain, inGain, hp, sDrive, dry, wet } = this;
    if (this.fresh) {
      // settings made before the first sample are where it starts: there is nothing yet to glide from
      this.fresh = false;
      for (let v = 0; v < VOICES; v++) {
        period[v].snap(period[v].target);
        panL[v].snap(panL[v].target);
        panR[v].snap(panR[v].target);
      }
      this.sDecay.snap(this.sDecay.target);
      this.sDamping.snap(this.sDamping.target);
      sDrive.snap(sDrive.target);
      dry.snap(dry.target);
      wet.snap(wet.target);
    }
    const scale = 1 / Math.sqrt(VOICES);
    const maxDelay = lines[0].max;
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      if (phase === 0) this.control();
      phase = (phase + 1) % CONTROL;
      const xl = safe(L[i]);
      const xr = safe(R[i]);
      // what excites the strings: both channels, high-passed, driven into a soft clipper (linear below ±1)
      const x = guard(sDrive.next() * hp.tick(0.5 * (xl + xr)), 1);
      let wl = 0;
      let wr = 0;
      for (let v = 0; v < VOICES; v++) {
        const length = period[v].next() + offset[v];
        const line = lines[v];
        const d = line.cubic(length < 2 ? 2 : length > maxDelay ? maxDelay : length);
        const z = lp[v] + lpA[v] * (d - lp[v]);
        lp[v] = z > 1e-20 || z < -1e-20 ? z : 0;
        const s = guard(inGain[v] * x + gain[v] * z, LIMIT);
        line.push(flush(s));
        wl += panL[v].next() * s;
        wr += panR[v].next() * s;
      }
      const dg = dry.next();
      const wg = wet.next() * scale;
      L[i] = xl * dg + wl * wg;
      R[i] = xr * dg + wr * wg;
    }
    this.phase = phase;
  }
}
