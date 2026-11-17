// Trance gate: chops a sustained sound into a pulse that is locked to the song. The gate opens at the start of every
// step (a note length), stays open for a part of it and closes for the rest; the edges are short fades, so it chops
// without clicking.
// A port of the pattern mode of the gate of the GGS Composer rack (fx-classic/gate.rs). The gain is computed from the
// position inside the step and from nothing else — there is no envelope that remembers — so the same bar always gets
// the same gate, a loop restarts in phase and a render that starts anywhere in the song gives the same samples.
import { StudioFx, Smoothed, num, choice, DIVISIONS, divisionBeats, linToDb, safe } from './base.js';

const STEP_BEATS = DIVISIONS.map(divisionBeats); // (looked up here once: nothing is parsed on the audio thread)
const MIN_FADE = 2e-4; // seconds: no edge is shorter than this, whatever the knobs say (a faster one is a click)

/** Let a glide arrive. One that only ever comes closer ends among numbers too small to compute with quickly — and "off" would never be exactly off. */
const land = (s) => { if (s.value !== s.target && s.settled) s.value = s.target; };

export class TranceGate extends StudioFx {
  static type = 'trancegate';
  static label = 'Trance Gate';
  static description = 'Chops a sustained sound — a pad, a chord, a long bass note, a whole bus — into a rhythmic pulse locked to the song: the gate opens at the start of every step, stays open for a part of it and closes for the rest. Step sets the note length (1/16 is the classic trance gate), duty how much of each step is heard, attack and release how hard the edges are. The pulse depends only on the song position, so it is the same every time a bar is played. No latency.';
  static defs = [
    choice('rate', 'Step', DIVISIONS, '1/16', { description: 'Length of one open-and-close step, as a note value: 1/16 is the classic trance gate, 1/8 half as fast (d = dotted, t = triplet). The steps are locked to the song position: one always starts on the bar line.' }),
    num('duty', 'Duty', 0.05, 0.95, 0.5, { automatable: true, description: 'The part of each step during which the gate is open. Small values give short stabs, 0.5 an even on/off, large values leave only brief gaps.' }),
    num('attack', 'Attack', 0.1, 100, 1, { unit: 'ms', curve: 'log', description: 'Length of the fade-in at the start of each step. Around 1 ms is a hard chop that does not click; 10 ms and more turns the pulse into swells.' }),
    num('release', 'Release', 1, 2000, 100, { unit: 'ms', curve: 'log', description: 'Length of the fade-out after the open part of each step. 5–20 ms is a tight chop; a fade longer than the gap between two steps never closes all the way and gives a softer pumping.' }),
    num('depth', 'Depth', 0, 1, 1, { automatable: true, description: 'How far the gate closes: 1 is silence between the steps, 0.7–0.9 lets some of the sound through for a more natural pulse, 0 leaves the signal untouched.' })
  ];

  constructor(sampleRate) {
    super(sampleRate);
    this.depth = new Smoothed(1, 10, sampleRate);
    this.duty = new Smoothed(0.5, 20, sampleRate);
    // The reference reads the two fade lengths as they are set; here they glide too, or a turn of the knob in the
    // middle of a fade would make the gain jump. They glide as ratios (their logarithm is what is smoothed): a fade
    // going from 1 ms to 1 s passes through 30 ms on its way, not straight to "hundreds of milliseconds".
    this.fadeIn = new Smoothed(Math.log(0.001), 20, sampleRate);
    this.fadeOut = new Smoothed(Math.log(0.1), 20, sampleRate);
    this.stepBeats = 0.25;
    this.lowest = 1;
    this.fresh = true; // nothing has been heard yet: settings start where they are put, they do not glide there
    this.update();
  }

  update() {
    const p = this.p;
    this.stepBeats = STEP_BEATS[DIVISIONS.indexOf(p.rate)];
    this.depth.set(p.depth);
    this.duty.set(p.duty);
    this.fadeIn.set(Math.log(Math.max(MIN_FADE, p.attack * 0.001)));
    this.fadeOut.set(Math.log(Math.max(MIN_FADE, p.release * 0.001)));
    if (this.fresh) {
      this.depth.snap(this.depth.target);
      this.duty.snap(this.duty.target);
      this.fadeIn.snap(this.fadeIn.target);
      this.fadeOut.snap(this.fadeOut.target);
    }
  }

  reset() {
    this.lowest = 1;
    this.fresh = true;
    this.update();
  }

  /** The lowest gain of the last block, dB (0 = open all block long, −80 = closed). */
  get meter() { return Math.max(-80, Math.min(0, linToDb(this.lowest))); }

  process(L, R, n) {
    this.fresh = false;
    const { depth, duty, fadeIn, fadeOut, stepBeats } = this;
    const bpm = this.bpm > 1 ? this.bpm : 1;
    const beatsPerSample = bpm / 60 / this.fs;
    const period = (stepBeats * 60) / bpm; // one step, in seconds
    let beat = this.beat;
    if (!(beat > -1e12 && beat < 1e12)) beat = 0;
    let fi = Math.exp(fadeIn.value); // the two fades, in seconds
    let fo = Math.exp(fadeOut.value);
    let lowest = 1;
    for (let i = 0; i < n; i++) {
      // where in its step this sample is, in seconds — from the song position, whether the song plays or not (the
      // clock runs on when it is stopped). Counted from the start of the block and not summed sample by sample: a
      // running sum drifts, and by an amount that depends on how the host cuts the audio into blocks.
      const at = (beat + i * beatsPerSample) / stepBeats;
      const t = (at - Math.floor(at)) * period;
      if (fadeIn.value !== fadeIn.target) fi = Math.exp(fadeIn.next());
      if (fadeOut.value !== fadeOut.target) fo = Math.exp(fadeOut.next());
      const open = duty.next() * period;
      // how open the gate gets before it closes again (all the way, unless the fade-in is longer than the open part)
      let top = open / fi;
      top = top >= 1 ? 1 : top * top * (3 - 2 * top);
      let v;
      if (t < open) {
        // rising — or still falling from the step before, when its fade-out is long: the higher of the two
        let rise = t / fi;
        rise = rise >= 1 ? 1 : rise * rise * (3 - 2 * rise);
        let fall = (t + period - open) / fo;
        fall = fall >= 1 ? 1 : fall * fall * (3 - 2 * fall);
        const tail = top * (1 - fall);
        v = rise > tail ? rise : tail;
      } else {
        let fall = (t - open) / fo;
        fall = fall >= 1 ? 1 : fall * fall * (3 - 2 * fall);
        v = top * (1 - fall);
      }
      const g = 1 - depth.next() * (1 - v);
      if (g < lowest) lowest = g;
      L[i] = safe(L[i] * g);
      R[i] = safe(R[i] * g);
    }
    this.lowest = lowest;
    // a host that does not call clock() before every block still gets a gate that runs on from here
    this.beat = beat + n * beatsPerSample;
    land(depth);
    land(duty);
    land(fadeIn);
    land(fadeOut);
  }
}
