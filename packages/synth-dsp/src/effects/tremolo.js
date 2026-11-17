// Tremolo: the volume rises and falls with an LFO. With the two channels half a cycle apart it is an auto-panner.
//
// The gain is 1 − depth × (1 − u), where u is the LFO's shape from 0 (closed) to 1 (open). Every shape is fully open
// at phase 0, so with sync on the loud point falls on the beat. The shapes are worked out from the phase alone — no
// filter, nothing remembered — so a synced tremolo is an exact function of the song position.
//
// A port of the `tremolo` of GGS Composer's classic effect rack (Rust), with its constants.
import { StudioFx, Smoothed, num, choice, flag, TAU, DIVISIONS } from './base.js';
import { LfoClock, CEILING, beatsOf, settle } from './flanger.js';

const SHAPES = ['sine', 'triangle', 'square', 'ramp'];
/** An edge of the square or the ramp takes at least this long, however sharp it is asked to be: it cannot click. */
const SHORTEST_EDGE = 0.0005; // seconds

export class Tremolo extends StudioFx {
  static type = 'tremolo';
  static label = 'Tremolo / Auto-pan';
  static description = 'Raises and lowers the volume in a steady rhythm. With the two channels in step it is a tremolo — the pulse of a vintage amp, rhythmic chopping, or a sidechain-style pump with the ramp shape. With the stereo phase at 0.5 it is an auto-panner that moves the sound from speaker to speaker. It can lock to the song tempo, and then the loudest point falls exactly on the beat.';
  static defs = [
    num('rate', 'Rate', 0.05, 40, 5, { unit: 'Hz', curve: 'log', automatable: true, description: 'Speed of the pulsing when sync is off. 3–7 Hz is the classic guitar-amp or electric-piano tremolo; above 20 Hz it turns into a buzzy texture.' }),
    flag('sync', 'Sync', false, { description: 'Lock the pulsing to the song tempo, using the division instead of the rate. The loudest point then falls exactly on the grid, and a bar sounds the same every time it is played.' }),
    choice('division', 'Division', DIVISIONS, '1/8', { description: 'Length of one pulse when sync is on, as a note value: 1/4 is one pulse per beat, 1/8 two, 1/16 four; d is dotted, t a triplet; 1/1 is a whole bar of 4/4.' }),
    num('depth', 'Depth', 0, 1, 0.5, { automatable: true, description: 'How far the volume dips on each pulse: 0 does nothing, 0.5 dips to half level, 1 dips to silence.' }),
    choice('shape', 'Shape', SHAPES, 'sine', { description: 'Shape of the volume movement. sine: a smooth, natural swell. triangle: much the same, with a steadier rise and fall. square: on/off chopping, a rhythmic gate. ramp: starts loud and fades through the cycle, like a repeated pluck or a sidechain pump.' }),
    num('stereo', 'Stereo phase', 0, 1, 0, { automatable: true, description: 'Offset of the right channel from the left, as a fraction of a cycle. 0 pulses both sides together; 0.5 (half a cycle, 180°) makes one side loud while the other is quiet: an auto-pan.' }),
    num('smooth', 'Smooth', 0, 1, 0.2, { automatable: true, description: 'Rounds the hard edges of the square and ramp shapes. 0 is the sharpest chop (still half a millisecond, so it never clicks), 1 turns the square into a smooth pulse. Sine and triangle ignore it.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    this.lfo = new LfoClock(); // (not `clock`: that is the method the host calls)
    this.depth = new Smoothed(0, 10, sampleRate);
    this.stereo = new Smoothed(0, 30, sampleRate);
    // (the reference reads this knob once per block; here it glides like the others, so it can be automated)
    this.smooth = new Smoothed(0, 10, sampleRate);
    this.shape = 0;
    // settings given before the first sample are where it starts — nothing glides in from the defaults
    this.fresh = true;
    this.update();
  }

  update() {
    const p = this.p;
    this.lfo.hz = p.rate;
    this.lfo.sync = p.sync;
    this.lfo.beats = beatsOf(p.division);
    this.depth.set(p.depth);
    this.stereo.set(p.stereo);
    this.smooth.set(p.smooth);
    this.shape = SHAPES.indexOf(p.shape);
    if (this.fresh) {
      this.depth.snap(p.depth);
      this.stereo.snap(p.stereo);
      this.smooth.snap(p.smooth);
    }
  }

  reset() {
    this.lfo.reset();
    this.fresh = true;
    this.update();
  }

  process(L, R, n) {
    this.fresh = false;
    const { lfo, depth, stereo, smooth, shape } = this;
    lfo.begin(n, this);
    const start = lfo.start;
    const inc = lfo.inc;
    // the narrowest edge, in cycles: half a millisecond at this speed
    const sharpest = Math.max(inc * this.fs * SHORTEST_EDGE, 1e-4);
    // (the smoothers are stepped by hand: see flanger.js for why nothing is called per sample)
    let amount = depth.value;
    const amountTo = depth.target;
    const amountBy = depth.c;
    let offset = stereo.value;
    const offsetTo = stereo.target;
    const offsetBy = stereo.c;
    let soft = smooth.value;
    const softTo = smooth.target;
    const softBy = smooth.c;
    const top = +CEILING; // (a local: see flanger.js)
    for (let i = 0; i < n; i++) {
      amount += amountBy * (amountTo - amount);
      offset += offsetBy * (offsetTo - offset);
      soft += softBy * (softTo - soft);
      // edge width in cycles: the knob's share of a quarter cycle
      let w = soft * 0.25;
      w = w < sharpest ? sharpest : w > 0.25 ? 0.25 : w;
      const phase = start + inc * i;
      for (let ch = 0; ch < 2; ch++) {
        const io = ch === 0 ? L : R;
        let ph = ch === 0 ? phase : phase + offset;
        ph -= Math.floor(ph);
        if (ph >= 1) ph = 0;
        let u;
        if (shape === 0) u = 0.5 + 0.5 * Math.cos(TAU * ph);
        else if (shape === 1) u = Math.abs(1 - 2 * ph);
        else if (ph >= 1 - w) {
          // square and ramp both end their cycle by rising back to open over the last w of it (a smoothstep), so
          // the square's edges finish on the half-cycle boundaries and it stays open half the time at any width
          const t = (ph - (1 - w)) / w;
          u = t * t * (3 - 2 * t);
        } else if (shape === 3) u = 1 - ph / (1 - w);
        else if (ph < 0.5 - w) u = 1;
        else if (ph < 0.5) {
          const t = (ph - (0.5 - w)) / w;
          u = 1 - t * t * (3 - 2 * t);
        } else u = 0;
        const y = io[i] * (1 - amount * (1 - u));
        io[i] = y > top ? top : y < -top ? -top : y === y ? y : 0;
      }
    }
    depth.value = amount;
    stereo.value = offset;
    smooth.value = soft;
    settle(depth);
    settle(stereo);
    settle(smooth);
  }
}
