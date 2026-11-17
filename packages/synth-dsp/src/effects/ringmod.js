// Ring modulator: the input multiplied by an oscillator of its own (the carrier).
//
// Multiplying by a sine of frequency fc replaces every partial f of the input by the pair f − fc and f + fc, each at
// half the level, and removes the original: that is what makes the result inharmonic — bells, robots, radios. Below
// about 20 Hz the carrier is a tremolo that also flips the polarity.
//
// The triangle and square carriers are band-limited (two-point polyBLAMP / polyBLEP corrections at their corners and
// edges). The product itself is not oversampled, so sums above half the sample rate fold back: with a carrier of a
// few kHz, bright inputs alias, as they do in every digital ring modulator — low-pass the input first if it matters.
//
// A port of the `ring_mod` of GGS Composer's classic effect rack (Rust), with its constants.
import { StudioFx, Smoothed, num, choice, TAU } from './base.js';
import { LfoClock, DryWet, CEILING, settle } from './flanger.js';

const SHAPES = ['sine', 'triangle', 'square'];
/** The carrier never moves more than this many cycles per sample (it would pass half the sample rate). */
const FASTEST = 0.45;

export class RingMod extends StudioFx {
  static type = 'ringmod';
  static label = 'Ring Modulator';
  static description = 'Multiplies the sound by an oscillator of its own, which replaces every frequency in the input with the sum and the difference of it and the carrier. The result is inharmonic: metallic, bell-like, robotic or radio-like, depending on the carrier frequency. At very low carrier frequencies it becomes a tremolo. Reach for it for sci-fi voices, clangorous percussion, dissonant textures and special effects.';
  static defs = [
    num('freq', 'Frequency', 0.1, 8000, 220, { unit: 'Hz', curve: 'log', automatable: true, description: 'Carrier frequency: every partial of the input is moved up and down by this much. Below 20 Hz it is a throbbing tremolo; 50–500 Hz gives metallic, bell-like or robotic tones; kHz values give thin, clangorous, radio-like sounds. Tune it to the key of the song for more musical results.' }),
    choice('shape', 'Shape', SHAPES, 'sine', { description: 'Carrier waveform. sine is the pure, classic ring modulator (two sidebands per partial); triangle adds a few softer ones; square adds many, for a harsh, buzzy, chopped sound.' }),
    num('lfoRate', 'LFO rate', 0.01, 20, 1, { unit: 'Hz', curve: 'log', automatable: true, description: 'Speed of the LFO that sweeps the carrier frequency up and down. It only does something once the LFO depth is above 0.' }),
    num('lfoDepth', 'LFO depth', 0, 2, 0, { automatable: true, description: 'How far the LFO moves the carrier frequency, in octaves either side. 0 keeps the carrier steady; a little adds shimmer, a lot gives sci-fi sweeps.' }),
    num('stereo', 'Stereo offset', 0, 1, 0, { automatable: true, description: 'Phase of the right channel\'s carrier ahead of the left one, as a fraction of a cycle. 0 is mono-compatible; 0.25 gives a wide, decorrelated image; 0.5 inverts one side.' }),
    num('mix', 'Mix', 0, 1, 1, { automatable: true, description: 'Blend between the dry input (0) and the ring-modulated signal (1). Some dry signal keeps the original pitch under the inharmonic sidebands.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    this.phase = 0; // of the carrier, in cycles
    this.lfo = new LfoClock(); // (not `clock`: that is the method the host calls)
    this.freq = new Smoothed(220, 10, sampleRate);
    this.depth = new Smoothed(0, 10, sampleRate);
    this.stereo = new Smoothed(0, 30, sampleRate);
    this.mix = new DryWet(sampleRate);
    this.shape = 0;
    // settings given before the first sample are where it starts — nothing glides in from the defaults
    this.fresh = true;
    this.update();
  }

  update() {
    const p = this.p;
    this.lfo.hz = p.lfoRate;
    this.freq.set(p.freq);
    this.depth.set(p.lfoDepth);
    this.stereo.set(p.stereo);
    this.mix.set(p.mix);
    this.shape = SHAPES.indexOf(p.shape);
    if (this.fresh) {
      this.freq.snap(p.freq);
      this.depth.snap(p.lfoDepth);
      this.stereo.snap(p.stereo);
      this.mix.snap(p.mix);
    }
  }

  reset() {
    this.phase = 0;
    this.lfo.reset();
    this.fresh = true;
    this.update();
  }

  process(L, R, n) {
    this.fresh = false;
    const { lfo, freq, depth, stereo, mix, shape, fs } = this;
    lfo.begin(n, this);
    const start = lfo.start;
    const inc = lfo.inc;
    let phase = this.phase;
    // (the smoothers are stepped by hand: see flanger.js for why nothing is called per sample)
    let hz = freq.value;
    const hzTo = freq.target;
    const hzBy = freq.c;
    let octaves = depth.value;
    const octavesTo = depth.target;
    const octavesBy = depth.c;
    let offset = stereo.value;
    const offsetTo = stereo.target;
    const offsetBy = stereo.c;
    let dryGain = mix.dry.value;
    const dryTo = mix.dry.target;
    let wetGain = mix.wet.value;
    const wetTo = mix.wet.target;
    const mixBy = mix.dry.c;
    const top = +CEILING; // (a local: see flanger.js)
    for (let i = 0; i < n; i++) {
      hz += hzBy * (hzTo - hz);
      octaves += octavesBy * (octavesTo - octaves);
      offset += offsetBy * (offsetTo - offset);
      dryGain += mixBy * (dryTo - dryGain);
      wetGain += mixBy * (wetTo - wetGain);
      let f = hz;
      if (octaves !== 0) {
        let sweep = start + inc * i;
        sweep -= Math.floor(sweep);
        // 2^(octaves × sine), as exp: several times cheaper than Math.pow here, and the same to 16 digits
        f *= Math.exp(Math.LN2 * octaves * Math.sin(TAU * sweep));
      }
      let step = f / fs;
      if (step > FASTEST) step = FASTEST;
      // the width of the rounded corners and edges: one sample of the carrier's own movement
      const dt = step < 1e-6 ? 1e-6 : step;
      let c = 0;
      for (let ch = 0; ch < 2; ch++) {
        // (with no offset the right channel uses the left one's carrier: the two are the same to the last bit)
        if (ch === 0 || offset !== 0) {
          let ph = ch === 0 ? phase : phase + offset;
          ph -= Math.floor(ph);
          if (shape === 0) c = Math.sin(TAU * ph);
          else if (shape === 1) {
            // a triangle with the zero crossings of the sine; its corners (the peak at ¼, the trough at ¾) are
            // rounded over one sample either side — the polyBLAMP residual, written out
            let t = ph + 0.25;
            t -= Math.floor(t);
            c = 1 - 4 * Math.abs(t - 0.5);
            t = ph + 0.75;
            t -= Math.floor(t);
            if (t < dt) {
              const a = t / dt - 1;
              c += (4 * dt * a * a * a) / 3;
            } else if (t > 1 - dt) {
              const a = (t - 1) / dt + 1;
              c -= (4 * dt * a * a * a) / 3;
            }
            t = ph + 0.25;
            t -= Math.floor(t);
            if (t < dt) {
              const a = t / dt - 1;
              c -= (4 * dt * a * a * a) / 3;
            } else if (t > 1 - dt) {
              const a = (t - 1) / dt + 1;
              c += (4 * dt * a * a * a) / 3;
            }
          } else {
            // a square whose two edges (up at 0, down at ½) are each spread over two samples — polyBLEP
            c = ph < 0.5 ? 1 : -1;
            if (ph < dt) {
              const a = ph / dt;
              c += a + a - a * a - 1;
            } else if (ph > 1 - dt) {
              const a = (ph - 1) / dt;
              c += a * a + a + a + 1;
            }
            let t = ph + 0.5;
            t -= Math.floor(t);
            if (t < dt) {
              const a = t / dt;
              c -= a + a - a * a - 1;
            } else if (t > 1 - dt) {
              const a = (t - 1) / dt;
              c -= a * a + a + a + 1;
            }
          }
        }
        const io = ch === 0 ? L : R;
        const x = io[i];
        const y = x * dryGain + x * c * wetGain;
        io[i] = y > top ? top : y < -top ? -top : y === y ? y : 0;
      }
      phase += step;
      if (phase >= 1) phase -= 1;
    }
    this.phase = phase;
    freq.value = hz;
    depth.value = octaves;
    stereo.value = offset;
    mix.dry.value = dryGain;
    mix.wet.value = wetGain;
    settle(freq);
    settle(depth);
    settle(stereo);
    mix.settle();
  }
}
