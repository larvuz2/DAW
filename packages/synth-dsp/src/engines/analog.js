// Analog engine: the classic subtractive voice — two oscillators with hard sync, a sub and noise into a four-pole
// ladder low-pass, an envelope for the filter and one for the level, one LFO.
//
// The oscillators are computed, not read from tables: a naive sawtooth or square has steps, and a step sampled as it
// is folds its endless harmonics back as aliasing. Each step is replaced by a band-limited one (polyBLEP: a
// two-sample polynomial correction around the step; triangle corners get the integrated form, polyBLAMP).
// Hard sync restarts oscillator 2 every time oscillator 1 completes a cycle — the restart is one more step, of
// whatever height the wave had reached, placed between the samples where it really happens, and corrected the same
// way. That is what makes a sync sweep scream without the digital "zipper" of a naive one.
//
// After GGS Composer's analog oscillator (Rust: oscillators/analog.rs — polyBLEP, hard sync, drift); the voice
// around it (filter, envelopes, LFO) is this studio's own, built for one note per instance.
import { SynthEngine, Adsr, num, choice, flag, clamp, dbToLin, velocityGain, keyHz, TAU } from './base.js';
import { hash32 } from '../util.js';

export const ANALOG_WAVES = ['saw', 'square', 'triangle', 'sine'];
const SAW = 0;
const SQUARE = 1;
const TRIANGLE = 2;
/** Envelopes, drift, the LFO and the filter's cutoff move once per this many samples. */
const CONTROL = 16;
/** What the mixer takes off before the filter (headroom for the ladder's soft clip) is given back after it. */
const OUT = 2;
/** Cents an oscillator wanders at Drift 1. */
const DRIFT_CENTS = 9;

export class Analog extends SynthEngine {
  static type = 'analog';
  static label = 'Analog';
  static category = 'synth';
  static color = '#e06c5c';
  static description = 'A classic analog-style subtractive synth: two oscillators (saw, square with pulse width, triangle, sine) with hard sync, a sub oscillator and noise, into a resonant four-pole ladder low-pass with its own envelope, plus an amp envelope and one LFO. The oscillators are band-limited at every pitch, hard sync included. For basses, sync leads, brass, strings and plucks with the weight of the 70s monosynths and polysynths; lighter on the CPU than the GGS Synth.';
  static defs = [
    choice('wave1', 'Osc 1', ANALOG_WAVES, 'saw', { group: 'Oscillators', description: 'Waveform of oscillator 1: saw is bright and full (every harmonic), square hollow (odd harmonics, shaped by Pulse width), triangle soft, sine pure.' }),
    choice('wave2', 'Osc 2', ANALOG_WAVES, 'saw', { group: 'Oscillators', description: 'Waveform of oscillator 2. With Sync on, this is the wave that is restarted by oscillator 1 — saw and square give the classic tearing sync tone.' }),
    num('semi2', 'Osc 2 semi', -24, 36, 0, { group: 'Oscillators', step: 1, description: 'Pitch of oscillator 2 against oscillator 1, in semitones: 0 with a little Detune for a fat unison, 7 or 12 for a fifth or an octave, and with Sync on the higher it is the brighter and more vocal the tone (the note stays where oscillator 1 has it).' }),
    num('fine2', 'Detune', -100, 100, 7, { group: 'Oscillators', unit: 'ct', description: 'Fine tuning of oscillator 2 in cents. A few cents against oscillator 1 give the slow beating of two analog oscillators; 0 is static.' }),
    flag('sync', 'Sync', false, { group: 'Oscillators', description: 'Hard sync: oscillator 2 restarts every time oscillator 1 completes a cycle, so it always sounds at the pitch of oscillator 1 while its own pitch (Osc 2 semi, and Env → osc 2) shapes the tone. Sweeping that pitch is the classic sync lead.' }),
    num('pw', 'Pulse width', 0.05, 0.95, 0.5, { group: 'Oscillators', description: 'Width of the square waves: 0.5 is a hollow, clarinet-like square, towards 0.05 or 0.95 it thins into a nasal pulse. Move it with the LFO (LFO → width) for the thick chorus of pulse-width modulation.' }),
    num('env2Pitch', 'Env → osc 2', 0, 48, 0, { group: 'Oscillators', unit: 'st', description: 'How far the filter envelope pushes the pitch of oscillator 2 up, in semitones. With Sync on this is the sync sweep: every note tears from bright to dark as the envelope falls.' }),
    num('mix', 'Osc mix', 0, 1, 0.5, { group: 'Mixer', description: 'Balance of the two oscillators: 0 is oscillator 1 alone, 1 oscillator 2 alone (use 1 for a pure sync sound).' }),
    num('sub', 'Sub', 0, 1, 0, { group: 'Mixer', description: 'Level of the sub oscillator: a square one octave below oscillator 1, for weight under basses and leads.' }),
    num('noise', 'Noise', 0, 1, 0, { group: 'Mixer', description: 'Level of white noise into the filter: breath on leads, the hit of a percussive patch, wind and surf with the oscillators down.' }),
    num('cutoff', 'Cutoff', 20, 20000, 2200, { group: 'Filter', unit: 'Hz', curve: 'log', description: 'Cutoff of the four-pole (24 dB per octave) low-pass at middle C, before the envelope, the LFO and key tracking move it: low is dark and round, high is open.' }),
    num('resonance', 'Resonance', 0, 1, 0.2, { group: 'Filter', description: 'Emphasis at the cutoff: a little makes the filter sing, a lot whistles, and near 1 it rings long after every note. The bass thins as it rises, as in the ladder filters this is modelled on.' }),
    num('envAmount', 'Env amount', -6, 6, 2.5, { group: 'Filter', unit: 'oct', description: 'How far the filter envelope opens the cutoff (or closes it, if negative), in octaves. The pluck, the brass swell and the acid squelch are this knob with the filter envelope.' }),
    num('keyTrack', 'Key track', 0, 1, 0.5, { group: 'Filter', description: 'How much the cutoff follows the note: 1 keeps the tone the same all over the keyboard (and lets a resonating filter play in tune), 0 makes high notes darker.' }),
    num('velCutoff', 'Vel → cutoff', 0, 4, 1.5, { group: 'Filter', unit: 'oct', description: 'How much brighter a hard note is than a soft one: the octaves of cutoff between the softest and the hardest note.' }),
    num('fAttack', 'F attack', 0.001, 10, 0.005, { group: 'Filter envelope', unit: 's', curve: 'log', description: 'Time the filter envelope takes to open.' }),
    num('fDecay', 'F decay', 0.005, 20, 0.35, { group: 'Filter envelope', unit: 's', curve: 'log', description: 'Time the filter envelope takes to fall to its sustain level: short for plucks and basses, long for slow sweeps.' }),
    num('fSustain', 'F sustain', 0, 1, 0.25, { group: 'Filter envelope', description: 'Where the filter envelope rests while the key is held, as a share of Env amount.' }),
    num('fRelease', 'F release', 0.005, 20, 0.3, { group: 'Filter envelope', unit: 's', curve: 'log', description: 'Time the filter envelope takes to close after the key is let go.' }),
    num('attack', 'Attack', 0.001, 10, 0.004, { group: 'Amp', unit: 's', curve: 'log', description: 'Time the note takes to reach full level.' }),
    num('decay', 'Decay', 0.005, 20, 0.4, { group: 'Amp', unit: 's', curve: 'log', description: 'Time the level takes to fall to the sustain level.' }),
    num('sustain', 'Sustain', 0, 1, 0.8, { group: 'Amp', description: 'Level while the key is held.' }),
    num('release', 'Release', 0.005, 20, 0.25, { group: 'Amp', unit: 's', curve: 'log', description: 'Time the note takes to fade once the key is let go.' }),
    num('lfoRate', 'LFO rate', 0.05, 30, 5, { group: 'LFO', unit: 'Hz', curve: 'log', description: 'Speed of the LFO (a sine that starts with the note).' }),
    num('lfoPitch', 'LFO → pitch', 0, 100, 0, { group: 'LFO', unit: 'ct', description: 'Vibrato: how far the LFO moves the pitch of both oscillators, in cents either side.' }),
    num('lfoPw', 'LFO → width', 0, 0.45, 0, { group: 'LFO', description: 'Pulse-width modulation: how far the LFO moves the width of the square waves. 0.3 at a rate of 0.5–2 Hz is the thick string-machine sound.' }),
    num('lfoCutoff', 'LFO → cutoff', 0, 4, 0, { group: 'LFO', unit: 'oct', description: 'How far the LFO moves the filter cutoff, in octaves either side: a wobble at low rates, a growl at high ones.' }),
    num('drift', 'Drift', 0, 1, 0.2, { group: 'Character', description: 'The slow, independent wandering of each oscillator\'s pitch (a few cents at most), different for every note: the instability that makes two analog oscillators sound alive. 0 is perfectly steady.' }),
    num('level', 'Level', -36, 6, -9, { group: 'Amp', unit: 'dB', description: 'Output level of the instrument, before the channel fader.' })
  ];

  static presets = {
    'Saw Bass': { wave1: 'saw', wave2: 'saw', fine2: 9, mix: 0.5, sub: 0.5, cutoff: 300, resonance: 0.25, envAmount: 3.2, fDecay: 0.22, fSustain: 0.1, attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.12, level: -10 },
    'Square Bass': { wave1: 'square', wave2: 'square', semi2: -12, fine2: 4, pw: 0.42, mix: 0.4, cutoff: 220, resonance: 0.35, envAmount: 2.6, fDecay: 0.16, fSustain: 0.05, sustain: 0.85, release: 0.1, level: -11.5 },
    'Sync Lead': { wave1: 'saw', wave2: 'saw', sync: true, semi2: 7, env2Pitch: 19, mix: 1, cutoff: 9000, resonance: 0.1, envAmount: 0.5, fAttack: 0.002, fDecay: 0.9, fSustain: 0.2, fRelease: 0.4, attack: 0.003, sustain: 0.9, release: 0.2, lfoRate: 5.5, lfoPitch: 6, level: -11.5 },
    'Sync Pluck': { wave1: 'square', wave2: 'saw', sync: true, semi2: 12, env2Pitch: 24, mix: 1, cutoff: 5000, envAmount: 1, fDecay: 0.18, fSustain: 0, decay: 0.35, sustain: 0, release: 0.3, level: -8 },
    'PWM Strings': { wave1: 'square', wave2: 'square', fine2: 11, pw: 0.5, lfoPw: 0.32, lfoRate: 0.9, mix: 0.5, cutoff: 3200, resonance: 0.05, envAmount: 0.6, fAttack: 0.4, fDecay: 2, fSustain: 0.8, attack: 0.35, decay: 1, sustain: 0.9, release: 0.9, drift: 0.4, level: -14.5 },
    'Brass': { wave1: 'saw', wave2: 'saw', fine2: -6, mix: 0.5, cutoff: 500, resonance: 0.1, envAmount: 3, fAttack: 0.06, fDecay: 0.5, fSustain: 0.55, fRelease: 0.25, attack: 0.03, decay: 0.3, sustain: 0.9, release: 0.2, velCutoff: 2.5, level: -7.5 },
    'Soft Pad': { wave1: 'triangle', wave2: 'saw', fine2: 8, mix: 0.45, cutoff: 900, resonance: 0.1, envAmount: 1.2, fAttack: 0.9, fDecay: 3, fSustain: 0.7, fRelease: 1.5, attack: 0.7, decay: 2, sustain: 0.9, release: 1.6, drift: 0.5, level: -10 },
    'Fifth Stab': { wave1: 'saw', wave2: 'saw', semi2: 7, fine2: 3, mix: 0.5, cutoff: 1200, resonance: 0.3, envAmount: 3, fDecay: 0.3, fSustain: 0.1, decay: 0.4, sustain: 0.3, release: 0.25, level: -7 },
    'Resonant Pluck': { wave1: 'saw', wave2: 'square', fine2: 5, mix: 0.4, cutoff: 350, resonance: 0.7, envAmount: 4, fDecay: 0.12, fSustain: 0, decay: 0.5, sustain: 0, release: 0.4, keyTrack: 0.8, level: -3.5 },
    'Sine Sub': { wave1: 'sine', wave2: 'sine', semi2: -12, fine2: 0, mix: 0.3, cutoff: 4000, resonance: 0, envAmount: 0, attack: 0.004, decay: 0.2, sustain: 1, release: 0.15, drift: 0, level: -13.5 },
    'Wobble Bass': { wave1: 'saw', wave2: 'square', semi2: -12, fine2: 6, mix: 0.5, sub: 0.3, cutoff: 500, resonance: 0.55, envAmount: 0, lfoRate: 3, lfoCutoff: 2.4, sustain: 1, release: 0.1, level: -12 },
    'Wind': { mix: 0.5, noise: 1, wave1: 'sine', wave2: 'sine', cutoff: 700, resonance: 0.75, envAmount: 1.5, fAttack: 1.5, fDecay: 4, fSustain: 0.4, fRelease: 2, attack: 1, sustain: 0.8, release: 2, lfoRate: 0.15, lfoCutoff: 1.2, keyTrack: 1, level: -10 }
  };

  static tail(params) {
    return (params?.release ?? 0.25) + 0.05;
  }

  constructor(sampleRate, seed = 1) {
    super(sampleRate, seed);
    this.amp = new Adsr(sampleRate / CONTROL);
    this.fenv = new Adsr(sampleRate / CONTROL);
    this.key = 60;
    this.vel = 0.8;
    this.tune = 0;
    // oscillator phases (cycles); the sub runs at half the speed of oscillator 1
    this.p1 = 0; this.p2 = 0; this.ps = 0;
    // each oscillator's sample is held back by one: a step found between two samples corrects both of them
    this.hold1 = 0; this.hold2 = 0;
    // the ladder's four states
    this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0;
    this.noiseState = hash32(this.seed ^ 0x5bd1e995) | 1;
    // drift: two slow sines per oscillator, at rates and phases of this note's own
    const unit = (salt) => hash32(this.seed ^ Math.imul(salt, 0x9e3779b1)) / 4294967296;
    this.driftPhase = [unit(1), unit(2), unit(3), unit(4)];
    this.driftRate = [0.11 + 0.08 * unit(5), 0.31 + 0.2 * unit(6), 0.13 + 0.08 * unit(7), 0.37 + 0.2 * unit(8)];
    this.lfo = 0;
    this.count = 0;
    this.gain = 0; this.gainTo = 0;
    this.inc1 = 0; this.inc2 = 0;
    this.g = 0; this.k = 0;
    this.pwNow = 0.5;
    this.time = 0;
    this.started = false;
    this.update();
  }

  update() {
    const p = this.p;
    const rate = this.fs / CONTROL;
    this.amp.fs = rate;
    this.fenv.fs = rate;
    this.amp.set(p.attack, p.decay, p.sustain, p.release);
    this.fenv.set(p.fAttack, p.fDecay, p.fSustain, p.fRelease);
    this.w1 = ANALOG_WAVES.indexOf(p.wave1);
    this.w2 = ANALOG_WAVES.indexOf(p.wave2);
  }

  noteOn(key, velocity = 0.8, tune = 0) {
    this.key = key;
    this.vel = clamp(velocity, 0, 1);
    this.tune = tune;
    this.started = true;
    this.amp.on();
    this.fenv.on();
    this.count = 0;
  }

  noteOff() {
    this.amp.off();
    this.fenv.off();
  }

  get finished() {
    return this.started && this.amp.idle && this.gain < 1e-5 && this.gainTo < 1e-5;
  }

  /** Once per CONTROL samples: envelopes, LFO, drift → the oscillators' speeds, the pulse width, the filter. */
  control(bend) {
    const p = this.p;
    const fs = this.fs;
    const t = this.time;
    const lfo = Math.sin(TAU * this.lfo);
    this.lfo += (p.lfoRate * CONTROL) / fs;
    this.lfo -= Math.floor(this.lfo);
    const fenv = this.fenv.next();
    const amp = this.amp.next();
    const d = this.driftPhase;
    const r = this.driftRate;
    const drift1 = p.drift * DRIFT_CENTS * (0.6 * Math.sin(TAU * (d[0] + r[0] * t)) + 0.4 * Math.sin(TAU * (d[1] + r[1] * t)));
    const drift2 = p.drift * DRIFT_CENTS * (0.6 * Math.sin(TAU * (d[2] + r[2] * t)) + 0.4 * Math.sin(TAU * (d[3] + r[3] * t)));
    const cents = this.tune + p.lfoPitch * lfo;
    const hz1 = keyHz(this.key + bend) * Math.pow(2, (cents + drift1) / 1200);
    const hz2 = keyHz(this.key + bend + p.semi2 + p.env2Pitch * fenv) * Math.pow(2, (cents + p.fine2 + drift2) / 1200);
    this.inc1 = Math.min(hz1 / fs, 0.45);
    this.inc2 = Math.min(hz2 / fs, 0.45);
    this.pwNow = clamp(p.pw + p.lfoPw * lfo, 0.03, 0.97);
    // the cutoff: the knob at middle C, moved by the key, the velocity, the envelope and the LFO (in octaves)
    const octaves = p.keyTrack * ((this.key + bend - 60) / 12) + p.velCutoff * (this.vel - 0.8) + p.envAmount * fenv + p.lfoCutoff * lfo;
    const fc = clamp(p.cutoff * Math.pow(2, octaves), 16, 0.42 * fs);
    this.g = Math.tan((Math.PI * fc) / fs);
    this.k = 3.96 * p.resonance;
    this.gainTo = amp * velocityGain(this.vel) * dbToLin(p.level);
    this.time += CONTROL / fs;
  }

  render(L, R, n, bend = 0) {
    const p = this.p;
    const w1 = this.w1;
    const w2 = this.w2;
    const sync = p.sync;
    const mix2 = p.mix;
    const mix1 = 1 - mix2;
    const subLevel = p.sub;
    const noiseLevel = p.noise;
    let { p1, p2, ps, hold1, hold2, s1, s2, s3, s4, gain, count } = this;
    let noise = this.noiseState;
    let inc1 = this.inc1;
    let inc2 = this.inc2;
    let pw = this.pwNow;
    let g = this.g;
    let k = this.k;
    let gainTo = this.gainTo;
    let gainStep = 0;
    for (let i = 0; i < n; i++) {
      if (count === 0) {
        this.control(bend);
        inc1 = this.inc1; inc2 = this.inc2; pw = this.pwNow; g = this.g; k = this.k; gainTo = this.gainTo;
        gainStep = (gainTo - gain) / CONTROL;
        count = CONTROL;
      }
      count--;
      gain += gainStep;

      // ---- oscillator 1: its steps are known from its phase alone (polyBLEP either side of each)
      p1 += inc1;
      let reset = -1; // time since oscillator 1 completed its cycle, in samples (0–1): the moment of a sync
      if (p1 >= 1) { p1 -= 1; reset = p1 / inc1; }
      let v1;
      if (w1 === SAW) {
        v1 = 2 * p1 - 1;
        if (p1 < inc1) { const x = p1 / inc1; v1 -= x + x - x * x - 1; } else if (p1 > 1 - inc1) { const x = (p1 - 1) / inc1; v1 -= x * x + x + x + 1; }
      } else if (w1 === SQUARE) {
        v1 = p1 < pw ? 1 : -1;
        if (p1 < inc1) { const x = p1 / inc1; v1 += x + x - x * x - 1; } else if (p1 > 1 - inc1) { const x = (p1 - 1) / inc1; v1 += x * x + x + x + 1; }
        let q = p1 - pw;
        if (q < 0) q += 1;
        if (q < inc1) { const x = q / inc1; v1 -= x + x - x * x - 1; } else if (q > 1 - inc1) { const x = (q - 1) / inc1; v1 -= x * x + x + x + 1; }
      } else if (w1 === TRIANGLE) {
        v1 = 1 - 4 * Math.abs(p1 - 0.5);
        // its corners (the trough at 0, the peak at ½) are rounded over a sample either side: polyBLAMP
        const c = (8 * inc1) / 6;
        if (p1 < inc1) { const x = 1 - p1 / inc1; v1 += c * x * x * x; } else if (p1 > 1 - inc1) { const x = 1 - (1 - p1) / inc1; v1 += c * x * x * x; }
        const q = Math.abs(p1 - 0.5);
        if (q < inc1) { const x = 1 - q / inc1; v1 -= c * x * x * x; }
      } else v1 = Math.sin(TAU * p1);

      // ---- oscillator 2: a step may come from its own cycle or from a sync, anywhere between two samples — it is
      // found when it has happened, and corrects the sample before it (still held back) and the one after
      let before = 0; // what the held sample gets
      let v2;
      const old = p2;
      p2 += inc2;
      if (sync && reset >= 0) {
        // where the wave had got to when oscillator 1 came round, and the step from there back to its start
        let at = old + (1 - reset) * inc2;
        if (at >= 1) at -= 1;
        const was = w2 === SAW ? 2 * at - 1 : w2 === SQUARE ? (at < pw ? 1 : -1) : w2 === TRIANGLE ? 1 - 4 * Math.abs(at - 0.5) : Math.sin(TAU * at);
        const start = w2 === SAW ? -1 : w2 === SQUARE ? 1 : w2 === TRIANGLE ? -1 : 0;
        const h = start - was;
        p2 = reset * inc2;
        v2 = (w2 === SAW ? 2 * p2 - 1 : w2 === SQUARE ? (p2 < pw ? 1 : -1) : w2 === TRIANGLE ? 1 - 4 * Math.abs(p2 - 0.5) : Math.sin(TAU * p2)) - 0.5 * h * (1 - reset) * (1 - reset);
        before = 0.5 * h * reset * reset;
      } else {
        let h = 0;
        let since = 0; // samples since the step
        if (p2 >= 1) {
          p2 -= 1;
          since = p2 / inc2;
          h = w2 === SAW ? -2 : w2 === SQUARE ? 2 : 0;
        } else if (w2 === SQUARE && old < pw && p2 >= pw) {
          since = (p2 - pw) / inc2;
          h = -2;
        }
        v2 = w2 === SAW ? 2 * p2 - 1 : w2 === SQUARE ? (p2 < pw ? 1 : -1) : w2 === TRIANGLE ? 1 - 4 * Math.abs(p2 - 0.5) : Math.sin(TAU * p2);
        if (h !== 0) {
          v2 -= 0.5 * h * (1 - since) * (1 - since);
          before = 0.5 * h * since * since;
        }
        if (w2 === TRIANGLE) {
          const c = (8 * inc2) / 6;
          if (p2 < inc2) { const x = 1 - p2 / inc2; v2 += c * x * x * x; } else if (p2 > 1 - inc2) { const x = 1 - (1 - p2) / inc2; v2 += c * x * x * x; }
          const q = Math.abs(p2 - 0.5);
          if (q < inc2) { const x = 1 - q / inc2; v2 -= c * x * x * x; }
        }
      }
      const out2 = hold2 + before;
      hold2 = v2;
      const out1 = hold1;
      hold1 = v1;

      // ---- the sub (a square an octave below oscillator 1) and the noise
      let x = mix1 * out1 + mix2 * out2;
      if (subLevel > 0) {
        const incs = 0.5 * inc1;
        ps += incs;
        if (ps >= 1) ps -= 1;
        let sub = ps < 0.5 ? 1 : -1;
        if (ps < incs) { const a = ps / incs; sub += a + a - a * a - 1; } else if (ps > 1 - incs) { const a = (ps - 1) / incs; sub += a * a + a + a + 1; }
        let q = ps - 0.5;
        if (q < 0) q += 1;
        if (q < incs) { const a = q / incs; sub -= a + a - a * a - 1; } else if (q > 1 - incs) { const a = (q - 1) / incs; sub -= a * a + a + a + 1; }
        x += subLevel * sub;
      }
      if (noiseLevel > 0) {
        noise = (Math.imul(noise, 1664525) + 1013904223) | 0;
        x += noiseLevel * (noise / 2147483648);
      }
      x *= 0.5;

      // ---- the ladder: four one-pole low-passes in a loop, solved without a delay in the loop (so the resonance
      // stays in tune up to the top), the loop's input bent by a soft clip as the transistors of a real one do
      const G = g / (1 + g);
      const sigma = (G * G * G * s1 + G * G * s2 + G * s3 + s4) / (1 + g);
      let u = (x * (1 + 0.5 * k) - k * sigma) / (1 + k * G * G * G * G);
      u /= Math.sqrt(1 + 0.25 * u * u); // (unity for small signals, never beyond ±2: it holds a ringing filter at a level)
      let v = (u - s1) * G; let y = v + s1; s1 = y + v;
      v = (y - s2) * G; y = v + s2; s2 = y + v;
      v = (y - s3) * G; y = v + s3; s3 = y + v;
      v = (y - s4) * G; y = v + s4; s4 = y + v;

      const out = y * gain * OUT;
      L[i] = out;
      R[i] = out;
    }
    // numbers on their way to nothing are slow: a state too small to hear is silence
    if (s1 < 1e-20 && s1 > -1e-20) s1 = 0;
    if (s2 < 1e-20 && s2 > -1e-20) s2 = 0;
    if (s3 < 1e-20 && s3 > -1e-20) s3 = 0;
    if (s4 < 1e-20 && s4 > -1e-20) s4 = 0;
    this.p1 = p1; this.p2 = p2; this.ps = ps; this.hold1 = hold1; this.hold2 = hold2;
    this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
    this.gain = gain; this.count = count; this.noiseState = noise;
  }
}
