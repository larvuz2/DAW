// What a synth engine is: the sound of ONE note, as a plain class. An engine is made when its note starts (all
// memory is taken then), told its settings, started with noteOn, and asked for stereo blocks until it says it is
// finished. The same class runs in an AudioWorklet (one processor per note, like the GGS Synth's voices) and in Node
// for tests and measurements — so nothing here may touch the DOM, the clock or Math.random (what is random comes from
// the note's seed), and nothing may allocate while rendering.
import { clamp } from '../effects/base.js';

export { num, choice, flag, clamp, dbToLin, linToDb, onepole, tiny, safe, TAU } from '../effects/base.js';

/** How loud a note of a given velocity is: squared, like every instrument of the studio (0.5 is 12 dB down, not 6). */
export const velocityGain = (v) => v * v;
/** How bright: 1 at velocity 0.8, falling to `floor` at velocity 0 and rising a little above 1 at full velocity. */
export const velocityTimbre = (v, floor = 0.4) => floor + (1 - floor) * (v / 0.8);
export const keyHz = (key) => 440 * Math.pow(2, (key - 69) / 12);

/**
 * An amplitude envelope: attack (a line up), decay to the sustain level and release (both exponential, the times are
 * to −60 dB). Sample by sample; `idle` once a released note has died away.
 */
export class Adsr {
  constructor(sampleRate) {
    this.fs = sampleRate;
    this.value = 0;
    this.stage = 0; // 0 idle, 1 attack, 2 decay/sustain, 3 release
    this.set(0.005, 0.3, 0.7, 0.3);
  }

  /** Times in seconds. */
  set(attack, decay, sustain, release) {
    this.up = 1 / Math.max(1, attack * this.fs);
    // an exponential that covers 60 dB in the given time
    this.cDecay = 1 - Math.exp(-6.908 / Math.max(1, decay * this.fs));
    this.cRelease = 1 - Math.exp(-6.908 / Math.max(1, release * this.fs));
    this.sustain = clamp(sustain, 0, 1);
  }

  on() { this.stage = 1; }
  off() { if (this.stage) this.stage = 3; }
  get idle() { return this.stage === 0; }

  next() {
    switch (this.stage) {
      case 1:
        this.value += this.up;
        if (this.value >= 1) { this.value = 1; this.stage = 2; }
        break;
      case 2: this.value += this.cDecay * (this.sustain - this.value); break;
      case 3:
        this.value -= this.cRelease * this.value;
        // (60 dB down is where the release time says the note is over)
        if (this.value < 1e-3) { this.value = 0; this.stage = 0; }
        break;
      default: break;
    }
    return this.value;
  }
}

/**
 * The base of an engine.
 *   new X(sampleRate, seed)        takes its memory; `seed` makes this note's random parts its own, and repeatable
 *   set(values)                    the whole settings object, or a part of it (a knob turned while the note sounds)
 *   noteOn(key, velocity, tune)    key as a MIDI note, velocity 0–1, tune in cents (the project's tuning)
 *   noteOff(releaseVelocity)       the key was let go
 *   render(L, R, n, bend)          write n samples of each Float32Array; bend = semitones of pitch bend for this block
 *   finished                       true once a released (or decayed) note is silent: the note is then thrown away
 *   static tail(params)            seconds a note may still ring after it was let go (the studio's bookkeeping)
 * A subclass gives static type / label / description / defs / presets and reads its settings from this.p — after
 * update(), which is called whenever something in this.p changed.
 */
export class SynthEngine {
  constructor(sampleRate, seed = 1) {
    this.fs = sampleRate;
    this.seed = seed >>> 0 || 1;
    this.p = {};
    for (const d of this.constructor.defs) this.p[d.key] = d.default;
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

  update() {}
  noteOn() {}
  noteOff() {}
  render() {}
  get finished() { return true; }
  static tail() { return 1; }
}
