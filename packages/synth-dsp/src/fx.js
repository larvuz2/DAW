// The GGS Synth's own effects: drive → chorus → delay → reverb → output gain. They sit after the voices of a
// channel are summed (one instance per channel), so a patch sounds finished on its own; the mixer's insert effects
// come after. Like the voices: plain JavaScript, no allocation while processing.
import { completeParams, syncBeats } from './params.js';
import { softClip, Interpolator2, Decimator2, clamp, TAU } from './util.js';

const CHUNK = 128;
const tiny = (v) => (v < 1e-30 && v > -1e-30 ? 0 : v);

class DelayLine {
  constructor(samples) {
    this.size = 1 << Math.ceil(Math.log2(Math.max(8, samples + 4)));
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
  }

  write(v) {
    this.buf[this.w] = v;
    this.w = (this.w + 1) & this.mask;
  }

  /** The sample written `delay` samples ago (fractional delays are interpolated). */
  read(delay) {
    const pos = this.w - delay + this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }

  /** The sample written a whole number of samples ago (no interpolation: the fast path). */
  tap(delay) {
    return this.buf[(this.w - delay + this.size) & this.mask];
  }

  clear() {
    this.buf.fill(0);
  }
}

// reverb: delay-line lengths in ms (mutually prime in samples at common rates, so echoes never line up)
const REV_LINES = [29.7, 37.1, 41.1, 43.7, 47.9, 53.3, 59.3, 67.1];
const REV_DIFFUSERS = [4.77, 3.59, 12.73, 9.31];
// wet level at mix 1: a steady sound comes back about as loud as it went in (measured in test/dsp.test.js)
const WET_GAIN = 2.6;

export class GgsFx {
  constructor({ sampleRate, params, bpm = 120 }) {
    this.fs = sampleRate;
    this.bpm = bpm;
    this.up = new Interpolator2();
    this.down = new Decimator2();
    this.upL = new Float32Array(CHUNK * 2);
    this.upR = new Float32Array(CHUNK * 2);
    this.dcL = 0; this.dcR = 0; this.dcXL = 0; this.dcXR = 0;
    this.chorus = [new DelayLine(sampleRate * 0.05), new DelayLine(sampleRate * 0.05)];
    this.chPhase = 0;
    this.delay = [new DelayLine(sampleRate * 2.1), new DelayLine(sampleRate * 2.1)];
    this.delaySamples = 0;
    this.delayLp = [0, 0];
    this.pre = new DelayLine(sampleRate * 0.03);
    this.diff = REV_DIFFUSERS.map((ms) => new DelayLine((ms / 1000) * sampleRate));
    this.lines = REV_LINES.map((ms) => new DelayLine((ms / 1000) * sampleRate * 1.6));
    this.lineLp = new Float64Array(8);
    this.lineOut = new Float64Array(8);
    this.revPhase = 0;
    this.silent = 1e15; // frames of silent input so far (starts at rest: nothing has played yet)
    this.idle = true;
    this.p = completeParams(params);
    this.configure();
  }

  setParams(delta) {
    this.p = completeParams({ ...this.p, ...delta });
    this.configure();
  }

  setTempo(bpm) {
    if (bpm > 0 && bpm !== this.bpm) { this.bpm = bpm; this.configure(); }
  }

  configure() {
    const p = this.p;
    const fs = this.fs;
    this.driveOn = p.driveAmt > 0.001;
    this.chorusOn = p.chorusMix > 0.001;
    this.delayOn = p.delayMix > 0.001;
    this.reverbOn = p.reverbMix > 0.001;
    const seconds = p.delaySync === 'free' ? p.delayTime / 1000 : (syncBeats(p.delaySync) * 60) / this.bpm;
    this.delayTarget = clamp(seconds, 0.001, 2) * fs;
    if (!this.delaySamples) this.delaySamples = this.delayTarget;
    this.delayA = 1 - Math.exp((-TAU * Math.min(p.delayTone, fs * 0.45)) / fs);
    // reverb: decay time 0.4 s … 12 s, the lines stretch a little with size
    const t60 = 0.4 * Math.pow(30, p.reverbSize);
    this.revScale = 0.6 + 0.9 * p.reverbSize;
    this.revGain = REV_LINES.map((ms) => Math.pow(10, (-3 * (ms / 1000) * this.revScale) / t60));
    // a loop with gain g piles a steady sound up to 1 / (1 − g²) of its power: feed the network less by that much,
    // so a held chord is as loud in a long hall as in a small room (a long tail is longer, not louder)
    const g = this.revGain.reduce((a, b) => a + b, 0) / this.revGain.length;
    this.revNorm = Math.sqrt(1 - g * g);
    this.revDamp = 1 - Math.exp((-TAU * (12000 * Math.pow(1500 / 12000, p.reverbDamp))) / fs);
    this.revLen = REV_LINES.map((ms) => Math.round((ms / 1000) * fs * this.revScale));
    this.diffLen = REV_DIFFUSERS.map((ms) => Math.round((ms / 1000) * fs));
    // how long the effects keep ringing after the input stops: past that, processing can rest
    const delayTail = this.delayOn ? Math.min(20, (seconds * Math.log(0.001)) / Math.log(Math.max(0.05, p.delayFb))) : 0;
    this.tail = Math.ceil((0.1 + delayTail + (this.reverbOn ? t60 * 1.3 : 0)) * fs);
  }

  /** Process `n` frames from in to out (the same arrays may be passed for both). */
  process(inL, inR, outL, outR, n) {
    for (let o = 0; o < n; o += CHUNK) this.chunk(inL, inR, outL, outR, o, Math.min(CHUNK, n - o));
  }

  chunk(inL, inR, outL, outR, o, n) {
    const p = this.p;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(inL[o + i]) + Math.abs(inR[o + i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-9) {
      this.silent += n;
      if (this.silent > this.tail) {
        if (!this.idle) this.rest();
        for (let i = 0; i < n; i++) outL[o + i] = outR[o + i] = 0;
        return;
      }
    } else {
      this.silent = 0;
      this.idle = false;
    }
    if (outL !== inL) for (let i = 0; i < n; i++) { outL[o + i] = inL[o + i]; outR[o + i] = inR[o + i]; }

    if (this.driveOn) this.drive(outL, outR, o, n);
    if (this.chorusOn) this.doChorus(outL, outR, o, n);
    if (this.delayOn) this.doDelay(outL, outR, o, n);
    if (this.reverbOn) this.doReverb(outL, outR, o, n);
    const g = p.gain;
    for (let i = 0; i < n; i++) { outL[o + i] *= g; outR[o + i] *= g; }
  }

  /** Clear every tail (called once when the effects fall silent, so nothing stale sounds on the next note). */
  rest() {
    this.idle = true;
    for (const d of [...this.chorus, ...this.delay, this.pre, ...this.diff, ...this.lines]) d.clear();
    this.lineLp.fill(0);
    this.delayLp[0] = this.delayLp[1] = 0;
    this.up.reset();
    this.down.reset();
    this.dcL = this.dcR = this.dcXL = this.dcXR = 0;
  }

  /** Waveshaper at twice the sample rate (its new harmonics would otherwise fold back as aliasing). */
  drive(L, R, o, n) {
    const p = this.p;
    const type = p.driveType;
    const pre = 1 + p.driveAmt * p.driveAmt * 30;
    const post = 1 / Math.pow(pre, 0.6);
    const uL = this.upL;
    const uR = this.upR;
    if (o) { L = L.subarray(o, o + n); R = R.subarray(o, o + n); }
    this.up.process(L, R, uL, uR, n);
    for (let i = 0; i < n * 2; i++) {
      let l = uL[i] * pre;
      let r = uR[i] * pre;
      if (type === 'hard') { l = clamp(l, -1, 1); r = clamp(r, -1, 1); }
      else if (type === 'tube') { l = l > 0 ? softClip(l) : softClip(l * 0.6) / 0.6 * 0.8; r = r > 0 ? softClip(r) : softClip(r * 0.6) / 0.6 * 0.8; }
      else if (type === 'fold') { l = Math.sin(l * 1.2); r = Math.sin(r * 1.2); }
      else { l = softClip(l); r = softClip(r); }
      uL[i] = l * post;
      uR[i] = r * post;
    }
    this.down.process(uL, uR, L, R, n);
    // asymmetric shapes add DC: a 10 Hz high-pass takes it out
    const k = 1 - (TAU * 10) / this.fs;
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      this.dcL = l - this.dcXL + k * this.dcL; this.dcXL = l; L[i] = this.dcL;
      this.dcR = r - this.dcXR + k * this.dcR; this.dcXR = r; R[i] = this.dcR;
    }
    this.dcL = tiny(this.dcL); this.dcR = tiny(this.dcR);
  }

  doChorus(L, R, o, n) {
    const p = this.p;
    const fs = this.fs;
    const [dl, dr] = this.chorus;
    const base = 0.012 * fs;
    const depth = (0.0006 + 0.004 * p.chorusDepth) * fs;
    const inc = p.chorusRate / fs;
    const mix = p.chorusMix;
    let ph = this.chPhase;
    for (let i = 0; i < n; i++) {
      const l = L[o + i];
      const r = R[o + i];
      dl.write(l);
      dr.write(r);
      ph += inc;
      if (ph >= 1) ph -= 1;
      // two voices per side, a quarter cycle apart between left and right: wide, never seasick
      const a = Math.sin(TAU * ph);
      const b = Math.sin(TAU * (ph + 0.25));
      const c = Math.sin(TAU * (ph * 1.37 + 0.5));
      const wl = 0.5 * (dl.read(base + depth * a) + dr.read(base * 1.45 + depth * c));
      const wr = 0.5 * (dr.read(base + depth * b) + dl.read(base * 1.45 - depth * c));
      L[o + i] = l * (1 - 0.3 * mix) + wl * mix;
      R[o + i] = r * (1 - 0.3 * mix) + wr * mix;
    }
    this.chPhase = ph;
  }

  doDelay(L, R, o, n) {
    const p = this.p;
    const [dl, dr] = this.delay;
    const fb = p.delayFb;
    const a = this.delayA;
    const mix = p.delayMix;
    let lpL = this.delayLp[0];
    let lpR = this.delayLp[1];
    let d = this.delaySamples;
    const target = this.delayTarget;
    for (let i = 0; i < n; i++) {
      d += (target - d) * 0.0005; // a time change glides (like tape) instead of clicking
      const l = L[o + i];
      const r = R[o + i];
      const tl = dl.read(d);
      const tr = dr.read(d);
      lpL += a * (tl - lpL);
      lpR += a * (tr - lpR);
      if (p.delayPing) {
        // the echo bounces: input → left → right → left …
        dl.write(0.5 * (l + r) + lpR * fb);
        dr.write(lpL);
      } else {
        dl.write(l + lpL * fb);
        dr.write(r + lpR * fb);
      }
      L[o + i] = l + tl * mix;
      R[o + i] = r + tr * mix;
    }
    this.delayLp[0] = tiny(lpL);
    this.delayLp[1] = tiny(lpR);
    this.delaySamples = d;
  }

  /** Feedback delay network: 8 lines mixed by a Hadamard matrix, with diffusion in front and damping in the loop. */
  doReverb(L, R, o, n) {
    const p = this.p;
    const fs = this.fs;
    const lines = this.lines;
    const out = this.lineOut;
    const lp = this.lineLp;
    const gains = this.revGain;
    const len = this.revLen;
    const damp = this.revDamp;
    const mix = p.reverbMix;
    const dry = 1 - mix * mix * 0.85;
    const wet = mix * WET_GAIN;
    const norm = this.revNorm;
    const preLen = Math.round(0.012 * fs);
    const diffLen = this.diffLen;
    let ph = this.revPhase;
    const phInc = 0.31 / fs;
    for (let i = 0; i < n; i++) {
      const l = L[o + i];
      const r = R[o + i];
      this.pre.write(0.5 * (l + r));
      let x = this.pre.tap(preLen);
      for (let k = 0; k < 4; k++) {
        const dline = this.diff[k];
        const delayed = dline.tap(diffLen[k]);
        const v = x + delayed * 0.6;
        dline.write(v);
        x = delayed - v * 0.6;
      }
      ph += phInc;
      if (ph >= 1) ph -= 1;
      const wob = Math.sin(TAU * ph) * 0.0004 * fs; // two lines drift slightly: the tail never rings on one pitch
      for (let k = 0; k < 8; k++) {
        const v = k === 0 ? lines[0].read(len[0] + wob) : k === 4 ? lines[4].read(len[4] - wob) : lines[k].tap(len[k]);
        lp[k] += damp * (v - lp[k]);
        out[k] = lp[k] * gains[k];
      }
      // fast Hadamard transform: every line feeds every other, energy preserved (× 1/√8)
      for (let h = 1; h < 8; h <<= 1) {
        for (let k = 0; k < 8; k += h << 1) {
          for (let j = k; j < k + h; j++) {
            const a = out[j];
            const b = out[j + h];
            out[j] = a + b;
            out[j + h] = a - b;
          }
        }
      }
      let wl = 0;
      let wr = 0;
      for (let k = 0; k < 8; k++) {
        lines[k].write(x * norm * (k & 1 ? -1 : 1) + out[k] * 0.35355339);
        if (k & 1) wr += lp[k]; else wl += lp[k];
      }
      L[o + i] = l * dry + wl * wet * 0.5;
      R[o + i] = r * dry + wr * wet * 0.5;
    }
    this.revPhase = ph;
    for (let k = 0; k < 8; k++) lp[k] = tiny(lp[k]);
  }
}
