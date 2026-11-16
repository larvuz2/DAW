// One note of the GGS Synth: three wavetable oscillators (unison, warp, phase modulation), a sub and a noise source,
// two filters, four envelopes, four LFOs and a modulation matrix — all per note, so every note carries its own
// pitch bend, pressure and timbre. Pure JavaScript with no allocation while rendering: the same class runs inside the
// AudioWorklet (realtime and offline renders) and in Node (tests, headless analysis).
//
// Rendering runs in control blocks of CTRL output samples: modulation is evaluated once per block and every audible
// control (pitch, level, table position, cutoff, amp) is ramped across the block, so nothing steps ("zipper noise").
import { getWavetable, tableLevel, levelFor, FRAME, STRIDE } from './wavetables.js';
import { completeParams, syncBeats, needsOversampling, MOD_SOURCES, MOD_TARGETS, OSC_IDS, ENV_COUNT, LFO_COUNT, MOD_SLOTS, SOURCE_DESTS, WARP_MODES, FILTER_TYPES, LFO_SHAPES, SUB_WAVES } from './params.js';
import { Rng, hash32, hashBipolar, softClip, Decimator2, clamp, TAU } from './util.js';

export const CTRL = 16;
const MAX_UNISON = 8;
const MAX_INNER = CTRL * 2; // internal samples per control block at 2× oversampling

const SRC = Object.fromEntries(MOD_SOURCES.map((s, i) => [s, i]));
const DST = Object.fromEntries(MOD_TARGETS.map((s, i) => [s, i]));
const WARP = Object.fromEntries(WARP_MODES.map((s, i) => [s, i]));
const FTYPE = Object.fromEntries(FILTER_TYPES.map((s, i) => [s, i]));
const LFO = Object.fromEntries(LFO_SHAPES.map((s, i) => [s, i]));

// scratch buffers shared by every voice in a realm (voices render one after another, never interleaved)
const bus = () => new Float32Array(MAX_INNER);
const B1L = bus(), B1R = bus(), B2L = bus(), B2R = bus(), DL = bus(), DR = bus(), TL = bus(), TR = bus(), OL = bus(), OR = bus();

const valueAt = (v, i) => (typeof v === 'number' ? v : v.length > 1 ? v[i] : v[0]);

/**
 * Attack / decay shapes over x = 0..1: rise = (1 − e^{−kx}) / (1 − e^{−k}), fall = (e^{−kx} − e^{−k}) / (1 − e^{−k}).
 * k sets how exponential they are; e^{−k} is computed once per parameter change (see GgsVoice.configure).
 */

class Envelope {
  constructor() {
    this.stage = 0; // 0 idle · 1 attack · 2 decay · 3 sustain · 4 release · 5 done
    this.t = 0;
    this.level = 0;
    this.from = 0;
  }

  /** legato: a note that continues the previous one starts in its sustain stage instead of attacking again. */
  on(legato, sustain) {
    this.t = 0;
    this.from = 0;
    if (legato) { this.stage = 3; this.level = sustain; } else { this.stage = 1; this.level = 0; }
  }

  off() {
    if (this.stage === 5 || this.stage === 4) return;
    this.from = this.level;
    this.stage = 4;
    this.t = 0;
  }

  /** c: the envelope's cached numbers { a, d, s, r, ka, eka, kd, ekd }; rel: release-time scale. */
  advance(dt, c, rel) {
    switch (this.stage) {
      case 1:
        this.t += dt;
        if (this.t >= c.a) { this.level = 1; this.stage = 2; this.t = 0; } else this.level = this.from + (1 - this.from) * ((1 - Math.exp((-c.ka * this.t) / c.a)) / (1 - c.eka));
        break;
      case 2:
        this.t += dt;
        if (this.t >= c.d) { this.level = c.s; this.stage = 3; } else this.level = c.s + (1 - c.s) * ((Math.exp((-c.kd * this.t) / c.d) - c.ekd) / (1 - c.ekd));
        break;
      case 3:
        this.level = c.s;
        break;
      case 4: {
        this.t += dt;
        const r = c.r * rel;
        if (this.t >= r) { this.level = 0; this.stage = 5; } else this.level = this.from * ((Math.exp((-c.kd * this.t) / r) - c.ekd) / (1 - c.ekd));
        break;
      }
      default:
        break;
    }
    return this.level;
  }
}

/** One oscillator's running state. */
class Osc {
  constructor(id) {
    this.id = id;
    this.phase = new Float64Array(MAX_UNISON);
    this.ratio = new Float64Array(MAX_UNISON).fill(1);
    this.gl = new Float64Array(MAX_UNISON);
    this.gr = new Float64Array(MAX_UNISON);
    this.gm = new Float64Array(MAX_UNISON);
    this.fbA = new Float64Array(MAX_UNISON);
    this.fbB = new Float64Array(MAX_UNISON);
    this.mono = new Float32Array(MAX_INNER);
    this.on = false;
    this.table = null;
    this.unison = 0;
    this.detune = -1;
    this.lastPan = NaN;
    this.need = 0;
    this.data = null;
    this.inc = 0;
    this.level = 0;
    this.pos = 0;
    this.warpAmt = 0;
    this.fm = 0;
    this.first = true;
  }
}

class Svf {
  constructor() { this.s = new Float64Array(8); } // two stages × two channels × (ic1, ic2)

  reset() { this.s.fill(0); }
}

export class GgsVoice {
  /**
   * opts: { sampleRate, params, key, velocity, seed, bpm, glideFrom (Hz, 0 = none), legato }
   * seed makes the note's random parts (unison phases, noise, random LFOs) repeatable: same seed, same audio.
   */
  constructor(opts) {
    this.fs = opts.sampleRate;
    this.p = completeParams(opts.params);
    // oversampling (fixed for the note's life): "high" always, "auto" where the patch can alias; never above 96 kHz
    const q = this.p.quality;
    this.os = this.fs < 80000 && (q === 'high' || (q === 'auto' && needsOversampling(this.p))) ? 2 : 1;
    this.fsI = this.fs * this.os;
    this.key = opts.key ?? 60;
    this.vel = clamp(opts.velocity ?? 0.8, 0, 1);
    this.bpm = opts.bpm || 120;
    this.seed = hash32((opts.seed | 0) ^ Math.imul(this.key + 1, 0x9e3779b1));
    this.rng = new Rng(this.seed);
    this.noiseRng = new Rng(this.seed ^ 0x5bd1e995);
    this.random = hashBipolar(this.seed, 77);
    this.age = 0;
    this.released = false;
    this.releaseVel = 0;
    this.relScale = 1;
    this.finished = false;
    this.first = true;

    this.oscs = OSC_IDS.map((id) => new Osc(id));
    this.sub = { phase: 0, inc: 0, level: 0, mono: new Float32Array(MAX_INNER), first: true, need: 0, lvl: 0, data: null };
    this.noise = { level: 0, mono: new Float32Array(MAX_INNER), lp: 0, lpR: 0, pink: new Float64Array(6), brown: 0, brownR: 0, first: true };
    this.filters = [new Svf(), new Svf()];
    this.fstate = [{ g: 0, k: 1, drive: 0, first: true, comb: null, combPos: 0, combLp: [0, 0] }, { g: 0, k: 1, drive: 0, first: true, comb: null, combPos: 0, combLp: [0, 0] }];
    this.envs = Array.from({ length: ENV_COUNT }, () => new Envelope());
    this.lfoPhase = new Float64Array(LFO_COUNT);
    this.src = new Float64Array(MOD_SOURCES.length);
    this.dst = new Float64Array(MOD_TARGETS.length);
    this.amp = 0;
    this.panL = Math.SQRT1_2;
    this.panR = Math.SQRT1_2;
    this.dec = this.os === 2 ? new Decimator2() : null;

    const target = 440 * Math.pow(2, (this.key - 69) / 12);
    this.glideSemis = opts.glideFrom > 0 && this.p.glide > 0 ? 12 * Math.log2(opts.glideFrom / target) : 0;
    this.configure();
    for (let i = 0; i < LFO_COUNT; i++) this.lfoPhase[i] = this.p[`lfo${i + 1}Phase`];
    const legato = !!opts.legato && this.p.legato;
    for (let i = 0; i < ENV_COUNT; i++) this.envs[i].on(legato, this.p[`env${i + 1}S`]);
  }

  /** Live edit while the note sounds (a knob turned in the editor). Oversampling is fixed for the note's life. */
  setParams(delta) {
    const quality = this.p.quality;
    this.p = completeParams({ ...this.p, ...delta, quality });
    this.configure();
  }

  setTempo(bpm) {
    if (bpm > 0) this.bpm = bpm;
  }

  /** Everything that only changes when a parameter changes. */
  configure() {
    const p = this.p;
    for (const o of this.oscs) {
      const x = o.id;
      o.on = p[`osc${x}On`];
      if (!o.on) continue;
      const tableId = p[`osc${x}Table`];
      if (!o.table || o.table.id !== tableId) o.table = getWavetable(tableId);
      const unison = Math.round(p[`osc${x}Unison`]);
      if (unison !== o.unison) {
        // new unison voices start at their own phase so a stack never begins as one loud, phasey spike
        for (let u = o.unison; u < unison; u++) o.phase[u] = (p[`osc${x}Phase`] + p[`osc${x}Rand`] * this.rng.unit()) % 1;
        o.unison = unison;
        o.detune = -1;
        o.lastPan = NaN;
      }
      // numbers the control loop reads every block (string-keyed lookups are far too slow for that)
      o.semis = p[`osc${x}Oct`] * 12 + p[`osc${x}Semi`] + p[`osc${x}Fine`] / 100;
      o.pPos = p[`osc${x}Pos`];
      o.pLevel = p[`osc${x}Level`];
      o.pPan = p[`osc${x}Pan`];
      o.pWarp = p[`osc${x}WarpAmt`];
      o.pFm = p[`osc${x}Fm`];
      o.pDetune = p[`osc${x}Detune`];
      if (p[`osc${x}Blend`] !== o.blend || p[`osc${x}Spread`] !== o.spread) o.lastPan = NaN;
      o.blend = p[`osc${x}Blend`];
      o.spread = p[`osc${x}Spread`];
      o.base = DST[`osc${x}Pitch`];
      o.need = 0;
      o.warp = WARP[p[`osc${x}Warp`]] || 0;
      o.dest = SOURCE_DESTS.indexOf(p[`osc${x}Dest`]);
      const from = p[`osc${x}FmFrom`];
      o.fmSelf = from === x;
      o.fmFrom = from === 'off' || o.fmSelf ? null : from;
    }
    // render order: an oscillator's modulator first when possible (a loop falls back to the previous block)
    const order = [];
    const pending = this.oscs.filter((o) => o.on);
    while (pending.length) {
      let i = pending.findIndex((o) => !o.fmFrom || !OSC_IDS.includes(o.fmFrom) || order.some((d) => d.id === o.fmFrom) || !pending.some((d) => d.id === o.fmFrom));
      if (i < 0) i = 0;
      order.push(pending.splice(i, 1)[0]);
    }
    this.order = order;
    for (const o of this.oscs) o.needMono = this.oscs.some((q) => q.on && q.fmFrom === o.id);

    this.slots = [];
    const used = new Set();
    for (let i = 1; i <= MOD_SLOTS; i++) {
      const s = SRC[p[`mod${i}Src`]] || 0;
      const d = DST[p[`mod${i}Dst`]] || 0;
      const amt = p[`mod${i}Amt`];
      if (!s || !d || !amt) continue;
      const via = SRC[p[`mod${i}Via`]] || 0;
      this.slots.push(s, d, amt, via);
      used.add(s);
      if (via) used.add(via);
    }
    this.slotCount = this.slots.length / 4;
    this.envUsed = [true, used.has(SRC.env2), used.has(SRC.env3), used.has(SRC.env4)];
    this.lfoUsed = [1, 2, 3, 4].map((i) => used.has(SRC[`lfo${i}`]));
    this.envc = [1, 2, 3, 4].map((i) => {
      const curve = p[`env${i}Curve`];
      const ka = 1.5 * Math.pow(3, curve);
      const kd = 4.6 * Math.pow(4, curve);
      return { a: p[`env${i}A`], d: p[`env${i}D`], s: p[`env${i}S`], r: p[`env${i}R`], ka, eka: Math.exp(-ka), kd, ekd: Math.exp(-kd) };
    });
    this.lfoc = [1, 2, 3, 4].map((i) => {
      const sync = p[`lfo${i}Sync`];
      const free = p[`lfo${i}Trig`] === 'free';
      return { shape: LFO[p[`lfo${i}Shape`]] || 0, rate: p[`lfo${i}Rate`], beats: sync === 'off' ? 0 : syncBeats(sync), free, fade: p[`lfo${i}Fade`], phase: p[`lfo${i}Phase`], seed: free ? 1000 + i : this.seed + i };
    });
    this.fc = [1, 2].map((i) => ({ on: p[`f${i}On`], cutoff: p[`f${i}Cutoff`], res: p[`f${i}Res`], drive: p[`f${i}Drive`], key: p[`f${i}Key`] }));
    this.macro = [p.macro1, p.macro2, p.macro3, p.macro4];
    this.glide = p.glide;
    this.level = p.level;
    this.subLevel = p.subLevel;
    this.noiseLevel = p.noiseLevel;
    this.noiseType = p.noiseType === 'pink' ? 1 : p.noiseType === 'brown' ? 2 : 0;
    // noise colour: negative = darker (low-pass down to ~150 Hz), positive = thinner (the low-passed part is removed)
    this.noiseColor = p.noiseColor;
    const nfc = p.noiseColor < 0 ? 18000 * Math.pow(150 / 18000, -p.noiseColor) : 200 * Math.pow(40, p.noiseColor);
    this.noiseA = 1 - Math.exp((-TAU * Math.min(nfc, this.fsI * 0.45)) / this.fsI);
    this.serial = p.filterRoute === 'serial';
    this.lastVoicePan = NaN;
    this.ftype = [FTYPE[p.f1Type] || 0, FTYPE[p.f2Type] || 0];
    this.subFrame = SUB_WAVES.indexOf(p.subWave);
    this.subMult = Math.pow(2, p.subOct);
    this.subDest = SOURCE_DESTS.indexOf(p.subDest);
    this.noiseDest = SOURCE_DESTS.indexOf(p.noiseDest);
    this.subNeedMono = this.oscs.some((q) => q.on && q.fmFrom === 'sub');
    this.velGain = 1 - p.velSens + p.velSens * this.vel * this.vel;
  }

  /** Note-off. releaseVelocity 0..1 (0.5 = neutral) shortens or lengthens every release when relVelSens > 0. */
  noteOff(releaseVelocity = 0.5) {
    if (this.released) return;
    this.released = true;
    this.releaseVel = clamp(releaseVelocity, 0, 1);
    this.relScale = Math.pow(2, (0.5 - this.releaseVel) * 4 * this.p.relVelSens);
    for (const e of this.envs) e.off();
  }

  /**
   * Render `count` frames, ADDING them to outL/outR from index `start`.
   * ctl: { pitch, pressure, timbre, macros[4], time } — pitch (semitones), pressure and timbre (0..1) are numbers or
   * per-frame arrays indexed like the output; macros are 0..1; time is the absolute time (s) of frame `start`.
   */
  process(outL, outR, start, count, ctl) {
    if (this.finished) return;
    const os = this.os;
    let done = 0;
    while (done < count && !this.finished) {
      const m = Math.min(CTRL, count - done);
      const i0 = start + done;
      this.control(m / this.fs, ctl, i0 + m - 1, ctl.time + (done + m) / this.fs);
      const mi = m * os;
      this.renderBlock(mi);
      if (os === 2) this.dec.process(OL, OR, outL, outR, m, true, i0);
      else for (let i = 0; i < m; i++) { outL[i0 + i] += OL[i]; outR[i0 + i] += OR[i]; }
      done += m;
      // over: the amp envelope has closed — or sits at a sustain of zero, where a pluck stays silent for good
      const amp = this.envs[0];
      if (amp.stage === 5 || (amp.stage === 3 && this.p.env1S <= 0)) this.finished = true;
    }
  }

  /** Evaluate envelopes, LFOs and the matrix for the end of a block of `dt` seconds; sets the ramp targets. */
  control(dt, ctl, index, timeEnd) {
    const src = this.src;
    const dst = this.dst;
    this.age += dt;
    const bend = valueAt(ctl.pitch ?? 0, index);

    for (let i = 0; i < ENV_COUNT; i++) {
      if (this.envUsed[i]) src[SRC.env1 + i] = this.envs[i].advance(dt, this.envc[i], this.relScale);
    }
    src[SRC.velocity] = this.vel;
    src[SRC.pressure] = clamp(valueAt(ctl.pressure ?? 0, index), 0, 1);
    src[SRC.timbre] = clamp(valueAt(ctl.timbre ?? 0, index), 0, 1);
    src[SRC.bend] = clamp(bend / 12, -4, 4);
    src[SRC.key] = clamp((this.key - 60) / 60, -1, 1);
    src[SRC.random] = this.random;
    src[SRC.releaseVel] = this.released ? this.releaseVel : 0;
    const macros = ctl.macros;
    for (let i = 0; i < 4; i++) src[SRC.macro1 + i] = clamp(macros ? macros[i] : this.macro[i], 0, 1);

    // LFOs read the rate modulation of the previous block (one block late is inaudible, and it breaks the loop
    // "LFO → matrix → LFO rate")
    for (let i = 0; i < LFO_COUNT; i++) {
      if (!this.lfoUsed[i]) continue;
      const c = this.lfoc[i];
      let rate = c.beats ? this.bpm / 60 / c.beats : c.rate;
      let phase;
      if (c.free) {
        phase = timeEnd * rate + c.phase; // tied to the clock: every note hears the same LFO
      } else {
        const mod = dst[DST.lfo1Rate + i];
        if (mod) rate *= Math.pow(2, 4 * mod);
        phase = this.lfoPhase[i] += rate * dt;
      }
      const cyc = Math.floor(phase);
      const x = phase - cyc;
      let v;
      switch (c.shape) {
        case 1: v = x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4; break;
        case 2: v = 1 - 2 * x; break;
        case 3: v = 2 * x - 1; break;
        case 4: v = x < 0.5 ? 1 : -1; break;
        case 5: v = hashBipolar(cyc, c.seed); break;
        case 6: {
          const a = hashBipolar(cyc, c.seed);
          v = a + (hashBipolar(cyc + 1, c.seed) - a) * x * x * (3 - 2 * x);
          break;
        }
        default: v = Math.sin(TAU * x);
      }
      src[SRC.lfo1 + i] = c.fade > 0 && this.age < c.fade ? v * (this.age / c.fade) : v;
    }

    dst.fill(0);
    const slots = this.slots;
    for (let s = 0; s < slots.length; s += 4) {
      const via = slots[s + 3];
      dst[slots[s + 1]] += src[slots[s]] * slots[s + 2] * (via ? src[via] : 1);
    }

    // ---- pitch
    const glide = this.glideSemis && this.age < this.glide ? this.glideSemis * (1 - this.age / this.glide) : 0;
    const pitch = this.key + glide + bend + dst[DST.pitch] * 24 + dst[DST.pitchFine];
    this.pitchNow = pitch;
    // 2^(semitones/12) once for the note; each oscillator multiplies its own (cached) offset in
    if (pitch !== this.lastPitch) { this.lastPitch = pitch; this.baseHz = 440 * Math.pow(2, (pitch - 69) / 12); }
    const baseHz = this.baseHz;
    for (let k = 0; k < 3; k++) {
      const o = this.oscs[k];
      if (!o.on) continue;
      const base = o.base;
      const semis = o.semis + dst[base] * 24;
      if (semis !== o.lastSemis) { o.lastSemis = semis; o.mult = Math.pow(2, semis / 12); }
      o.incTo = Math.min(0.45, (baseHz * o.mult) / this.fsI);
      o.posTo = clamp(o.pPos + dst[base + 1], 0, 1);
      o.levelTo = clamp(o.pLevel + dst[base + 2], 0, 2);
      o.warpTo = clamp(o.pWarp + dst[base + 4], 0, 1);
      o.fmTo = clamp(o.pFm + dst[base + 5], 0, 1);
      const detune = clamp(o.pDetune + dst[base + 6] * 100, 0, 200);
      if (detune !== o.detune) {
        o.detune = detune;
        for (let u = 0; u < o.unison; u++) o.ratio[u] = Math.pow(2, (spreadOf(u, o.unison) * detune) / 1200);
        o.need = 0;
      }
      const pan = clamp(o.pPan + dst[base + 3], -1, 1);
      const blend = o.blend;
      const spread = o.spread;
      if (pan !== o.lastPan) {
        o.lastPan = pan;
        let power = 0;
        for (let u = 0; u < o.unison; u++) {
          const d = spreadOf(u, o.unison);
          const w = Math.abs(d) < 0.34 || o.unison < 3 ? 1 : blend; // the middle voices carry the pitch
          o.gm[u] = w;
          power += w * w;
        }
        const norm = 1 / Math.sqrt(power || 1);
        for (let u = 0; u < o.unison; u++) {
          const a = (clamp(pan + spreadOf(u, o.unison) * spread, -1, 1) + 1) * Math.PI / 4;
          o.gm[u] *= norm;
          o.gl[u] = Math.cos(a) * o.gm[u] * Math.SQRT2;
          o.gr[u] = Math.sin(a) * o.gm[u] * Math.SQRT2;
        }
      }
      if (o.first) { o.inc = o.incTo; o.pos = o.posTo; o.level = o.levelTo; o.warpAmt = o.warpTo; o.fm = o.fmTo; o.first = false; }
    }
    const sub = this.sub;
    sub.levelTo = clamp(this.subLevel + dst[DST.subLevel], 0, 2);
    sub.incTo = Math.min(0.45, (baseHz * this.subMult) / this.fsI);
    if (sub.first) { sub.inc = sub.incTo; sub.level = sub.levelTo; sub.first = false; }
    const noise = this.noise;
    noise.levelTo = clamp(this.noiseLevel + dst[DST.noiseLevel], 0, 2);
    if (noise.first) { noise.level = noise.levelTo; noise.first = false; }

    // ---- filters
    for (let f = 0; f < 2; f++) {
      const c = this.fc[f];
      if (!c.on) continue;
      const st = this.fstate[f];
      const base = DST.f1Cutoff + f * 3;
      const oct = dst[base] * 10 + (c.key * (pitch - 60)) / 12;
      if (oct !== st.lastOct || c.cutoff !== st.lastCutoff) {
        st.lastOct = oct;
        st.lastCutoff = c.cutoff;
        st.fc = clamp(c.cutoff * Math.pow(2, oct), 16, Math.min(21000, this.fsI * 0.45));
        st.gTo = Math.tan((Math.PI * st.fc) / this.fsI);
      }
      const res = clamp(c.res + dst[base + 1], 0, 1);
      if (res !== st.res || this.ftype[f] !== st.lastType) {
        st.res = res;
        st.lastType = this.ftype[f];
        // damping k = 1/Q. 12 dB types: Q 0.707 (flat) … 40. 24 dB types: this is the second stage of a
        // Butterworth pair (Q 1.31 … 40); the first stage stays gentle (see filter())
        const two = st.lastType === 1 || st.lastType === 3 || st.lastType === 5;
        st.kTo = two ? 1 / (1.3066 * Math.pow(30, res)) : 1 / (0.7071 * Math.pow(56, res));
      }
      st.driveTo = clamp(c.drive + dst[base + 2], 0, 1);
      if (st.first) { st.g = st.gTo; st.k = st.kTo; st.drive = st.driveTo; st.first = false; }
    }

    // ---- amp and pan
    this.ampTo = src[SRC.env1] * this.velGain * clamp(this.level + dst[DST.level], 0, 2);
    const vpan = clamp(dst[DST.pan], -1, 1);
    if (vpan !== this.lastVoicePan) {
      this.lastVoicePan = vpan;
      const a = (vpan + 1) * Math.PI / 4;
      this.panLTo = Math.cos(a) * Math.SQRT2;
      this.panRTo = Math.sin(a) * Math.SQRT2;
    }
    if (this.first) { this.amp = this.ampTo; this.panL = this.panLTo; this.panR = this.panRTo; this.first = false; }
  }

  /** Render `m` internal samples of the voice into OL/OR. */
  renderBlock(m) {
    B1L.fill(0, 0, m); B1R.fill(0, 0, m); B2L.fill(0, 0, m); B2R.fill(0, 0, m); DL.fill(0, 0, m); DR.fill(0, 0, m);
    if (this.sub.levelTo > 0 || this.sub.level > 0 || this.subNeedMono) this.renderSub(m);
    if (this.noise.levelTo > 0 || this.noise.level > 0) this.renderNoise(m);
    for (const o of this.order) this.renderOsc(o, m);

    OL.fill(0, 0, m); OR.fill(0, 0, m);
    const f1 = this.fc[0].on;
    const f2 = this.fc[1].on;
    if (f1) this.filter(0, B1L, B1R, m);
    if (this.serial && f2) {
      for (let i = 0; i < m; i++) { B2L[i] += B1L[i]; B2R[i] += B1R[i]; }
    } else {
      for (let i = 0; i < m; i++) { OL[i] += B1L[i]; OR[i] += B1R[i]; }
    }
    if (f2) this.filter(1, B2L, B2R, m);
    for (let i = 0; i < m; i++) { OL[i] += B2L[i] + DL[i]; OR[i] += B2R[i] + DR[i]; }

    let amp = this.amp;
    let pl = this.panL;
    let pr = this.panR;
    const da = (this.ampTo - amp) / m;
    const dl = (this.panLTo - pl) / m;
    const dr = (this.panRTo - pr) / m;
    for (let i = 0; i < m; i++) {
      amp += da; pl += dl; pr += dr;
      OL[i] *= amp * pl;
      OR[i] *= amp * pr;
    }
    this.amp = this.ampTo; this.panL = this.panLTo; this.panR = this.panRTo;
  }

  /** Add the scratch pair TL/TR to the buses a source is routed to. */
  route(dest, m) {
    if (dest === 0 || dest === 2) for (let i = 0; i < m; i++) { B1L[i] += TL[i]; B1R[i] += TR[i]; }
    if (dest === 1 || dest === 2) for (let i = 0; i < m; i++) { B2L[i] += TL[i]; B2R[i] += TR[i]; }
    if (dest === 3) for (let i = 0; i < m; i++) { DL[i] += TL[i]; DR[i] += TR[i]; }
  }

  renderOsc(o, m) {
    const table = o.table;
    const frames = table.frames;
    // table position: cross-fade the two neighbouring frames; a block that crosses a frame finishes at its edge
    const fp0 = o.pos * (frames - 1);
    const f0 = Math.min(frames - 1, Math.floor(fp0));
    const f1 = Math.min(frames - 1, f0 + 1);
    const w = fp0 - f0;
    const wTo = clamp(o.posTo * (frames - 1) - f0, 0, 1);
    const dw = (wTo - w) / m;
    const blendFrames = f1 !== f0 && (w > 0 || wTo > 0);

    const warp = o.warp;
    const warpTo = o.warpTo;
    const wa = o.warpAmt;
    const dwa = (warpTo - wa) / m;
    const fmBuf = o.fmFrom ? this.fmBuffer(o.fmFrom) : null;
    const fmSelf = o.fmSelf;
    const fm = o.fm;
    const dfm = (o.fmTo - fm) / m;
    const fmOn = (fmBuf || fmSelf) && (fm > 0 || o.fmTo > 0);
    // phase modulation depth in cycles: 0..1 → index 0..16 rad
    const FM_DEPTH = 16 / TAU;

    // the richest band-limited copy that stays under Nyquist once unison, warp and FM widen the spectrum
    const maxInc = Math.max(o.inc, o.incTo) * o.ratio[o.unison - 1];
    const amt = Math.max(wa, warpTo);
    const widen = warp === 1 ? 1 + 8 * amt : warp === 2 ? 0.5 / (0.5 - 0.46 * amt) : warp === 3 ? 1 + 7 * amt : warp === 4 ? 1 + amt : warp === 5 ? 1 + 5 * amt : 1;
    const fmWiden = fmOn ? 1 + Math.max(fm, o.fmTo) * Math.max(fm, o.fmTo) * 16 : 1;
    // `* os`: the limit is the OUTPUT rate's Nyquist — nothing the oscillator makes may land in the decimator's
    // transition band, from where it would fold back
    const need = maxInc * this.os * widen * fmWiden;
    if (need !== o.need || o.dataTable !== table || !table.levels[o.lvl]) {
      o.need = need;
      o.dataTable = table;
      o.lvl = levelFor(need);
      o.data = tableLevel(table, o.lvl);
    }
    const data = o.data;
    const b0 = f0 * STRIDE + 1;
    const b1 = f1 * STRIDE + 1;

    TL.fill(0, 0, m); TR.fill(0, 0, m);
    const mono = o.mono;
    const needMono = o.needMono;
    if (needMono) mono.fill(0, 0, m);
    const lv0 = o.level;
    const dlv = (o.levelTo - lv0) / m;
    const dincBase = (o.incTo - o.inc) / m;

    for (let u = 0; u < o.unison; u++) {
      let ph = o.phase[u];
      let inc = o.inc * o.ratio[u];
      const dinc = dincBase * o.ratio[u];
      const gl = o.gl[u];
      const gr = o.gr[u];
      const gm = o.gm[u];
      let lv = lv0;
      let ww = w;
      let a = wa;
      let depth = fm;
      let y1 = o.fbA[u];
      let y2 = o.fbB[u];
      for (let i = 0; i < m; i++) {
        inc += dinc;
        ph += inc;
        if (ph >= 1) ph -= 1;
        let q = ph;
        let win = 1;
        if (warp) {
          a += dwa;
          switch (warp) {
            case 1: q = q / (q + (1 - q) * (1 + 8 * a)); break; // bend: the cycle leans toward its end
            case 2: { const pw = 0.5 - 0.46 * a; q = q < pw ? (0.5 * q) / pw : 0.5 + (0.5 * (q - pw)) / (1 - pw); break; } // pulse-width
            // sync: the cycle restarts early; short fades at both ends keep the restart from clicking
            case 3: win = Math.min(1, q * 48, (1 - q) * 16); q *= 1 + 7 * a; q -= Math.floor(q); break;
            case 4: q += a * (1 - Math.abs(2 * q - 1) - q); break; // mirror: forward, then backward
            case 6: { const steps = 256 * Math.pow(2, -6 * a); q = Math.floor(q * steps) / steps; break; }
            default: break;
          }
        }
        if (fmOn) {
          depth += dfm;
          q += depth * depth * FM_DEPTH * (fmSelf ? 0.5 * (y1 + y2) * 3 : fmBuf[i] * 3);
          q -= Math.floor(q);
        }
        const x = q * FRAME;
        let xi = x | 0;
        let fr = x - xi;
        if (xi >= FRAME) { xi = 0; fr = 0; }
        let j = b0 + xi;
        let ym = data[j - 1];
        let ya = data[j];
        let yb = data[j + 1];
        let yc = data[j + 2];
        let s = ((((0.5 * (yc - ym) + 1.5 * (ya - yb)) * fr + (ym - 2.5 * ya + 2 * yb - 0.5 * yc)) * fr + 0.5 * (yb - ym)) * fr) + ya;
        if (blendFrames) {
          ww += dw;
          j = b1 + xi;
          ym = data[j - 1]; ya = data[j]; yb = data[j + 1]; yc = data[j + 2];
          const s1 = ((((0.5 * (yc - ym) + 1.5 * (ya - yb)) * fr + (ym - 2.5 * ya + 2 * yb - 0.5 * yc)) * fr + 0.5 * (yb - ym)) * fr) + ya;
          s += ww * (s1 - s);
        }
        if (warp === 5) s = Math.sin(s * (1 + 5 * a) * 3.4) * 0.45; // fold
        s *= win;
        y2 = y1;
        y1 = s;
        lv += dlv;
        TL[i] += s * gl * lv;
        TR[i] += s * gr * lv;
        if (needMono) mono[i] += s * gm;
      }
      o.phase[u] = ph;
      o.fbA[u] = y1;
      o.fbB[u] = y2;
    }
    o.inc = o.incTo; o.pos = o.posTo; o.level = o.levelTo; o.warpAmt = warpTo; o.fm = o.fmTo;
    this.route(o.dest, m);
  }

  /** The mono signal of another source, as a phase-modulation input. */
  fmBuffer(from) {
    if (from === 'sub') return this.sub.mono;
    if (from === 'noise') return this.noise.mono;
    return this.oscs[OSC_IDS.indexOf(from)].mono;
  }

  renderSub(m) {
    const sub = this.sub;
    const table = getWavetable('basic');
    // the first four frames of "basic" are sine, triangle, saw, square
    const frame = [0, 1, 2, 3][this.subFrame] ?? 0;
    const need = Math.max(sub.inc, sub.incTo) * this.os;
    if (need !== sub.need || !table.levels[sub.lvl]) {
      sub.need = need;
      sub.lvl = levelFor(need);
      sub.data = tableLevel(table, sub.lvl);
    }
    const data = sub.data;
    const b0 = frame * STRIDE + 1;
    let ph = sub.phase;
    let inc = sub.inc;
    const dinc = (sub.incTo - inc) / m;
    let lv = sub.level;
    const dlv = (sub.levelTo - lv) / m;
    const mono = sub.mono;
    for (let i = 0; i < m; i++) {
      inc += dinc;
      ph += inc;
      if (ph >= 1) ph -= 1;
      const x = ph * FRAME;
      const xi = x | 0;
      const fr = x - xi;
      const j = b0 + xi;
      const ym = data[j - 1];
      const ya = data[j];
      const yb = data[j + 1];
      const yc = data[j + 2];
      const s = ((((0.5 * (yc - ym) + 1.5 * (ya - yb)) * fr + (ym - 2.5 * ya + 2 * yb - 0.5 * yc)) * fr + 0.5 * (yb - ym)) * fr) + ya;
      mono[i] = s;
      lv += dlv;
      TL[i] = TR[i] = s * lv * 1.4;
    }
    sub.phase = ph; sub.inc = sub.incTo; sub.level = sub.levelTo;
    this.route(this.subDest, m);
  }

  renderNoise(m) {
    const nz = this.noise;
    const rng = this.noiseRng;
    const type = this.noiseType;
    const color = this.noiseColor;
    const a = this.noiseA;
    let lv = nz.level;
    const dlv = (nz.levelTo - lv) / m;
    const pink = nz.pink;
    for (let i = 0; i < m; i++) {
      let l = rng.next();
      let r = rng.next();
      if (type === 1) {
        // Paul Kellett's economy pink filter, one per side
        pink[0] = 0.99765 * pink[0] + l * 0.099046; pink[1] = 0.963 * pink[1] + l * 0.2965164; pink[2] = 0.57 * pink[2] + l * 1.0526913;
        l = (pink[0] + pink[1] + pink[2] + l * 0.1848) * 0.28;
        pink[3] = 0.99765 * pink[3] + r * 0.099046; pink[4] = 0.963 * pink[4] + r * 0.2965164; pink[5] = 0.57 * pink[5] + r * 1.0526913;
        r = (pink[3] + pink[4] + pink[5] + r * 0.1848) * 0.28;
      } else if (type === 2) {
        nz.brown = (nz.brown + l * 0.04) * 0.996; l = nz.brown * 4;
        nz.brownR = (nz.brownR + r * 0.04) * 0.996; r = nz.brownR * 4;
      }
      if (color !== 0) {
        nz.lp += a * (l - nz.lp);
        nz.lpR += a * (r - nz.lpR);
        if (color < 0) { l = nz.lp; r = nz.lpR; } else { l -= nz.lp; r -= nz.lpR; }
      }
      nz.mono[i] = l;
      lv += dlv;
      TL[i] = l * lv * 0.5;
      TR[i] = r * lv * 0.5;
    }
    nz.level = nz.levelTo;
    this.route(this.noiseDest, m);
  }

  /** Filter `f` in place on a stereo bus. Topology-preserving state-variable filter: stable at any cutoff sweep. */
  filter(f, L, R, m) {
    const st = this.fstate[f];
    const type = this.ftype[f];
    if (type === 8) { this.comb(f, L, R, m); return; }
    const s = this.filters[f].s;
    let g = st.g;
    let k = st.k;
    let drive = st.drive;
    const dg = (st.gTo - g) / m;
    const dk = (st.kTo - k) / m;
    const dd = (st.driveTo - drive) / m;
    const driven = drive > 0.001 || st.driveTo > 0.001;
    const two = type === 1 || type === 3 || type === 5; // 24 dB types: two stages
    // 24 dB: the first stage stays gentle (Q 0.54 … 0.8), the second carries the resonance — at zero resonance the
    // pair is a 4-pole Butterworth
    const k1 = 1.848 - 0.6 * st.res;
    let a1L = s[0], a2L = s[1], a1R = s[2], a2R = s[3], b1L = s[4], b2L = s[5], b1R = s[6], b2R = s[7];
    const mode = type >> 1; // 0 lp · 1 hp · 2 bp · 3 notch(6)/peak(7)
    for (let i = 0; i < m; i++) {
      g += dg; k += dk;
      let xl = L[i];
      let xr = R[i];
      if (driven) {
        drive += dd;
        const pre = 1 + drive * 7;
        const post = 1 / Math.sqrt(pre);
        xl = softClip(xl * pre) * post;
        xr = softClip(xr * pre) * post;
      }
      const kk = two ? k1 : k;
      let c1 = 1 / (1 + g * (g + kk));
      let c2 = g * c1;
      let c3 = g * c2;
      let v3 = xl - a2L;
      let v1 = c1 * a1L + c2 * v3;
      let v2 = a2L + c2 * a1L + c3 * v3;
      a1L = 2 * v1 - a1L; a2L = 2 * v2 - a2L;
      let yl = mode === 0 ? v2 : mode === 1 ? xl - kk * v1 - v2 : mode === 2 ? kk * v1 : type === 6 ? xl - kk * v1 : 2 * v2 - xl + kk * v1;
      v3 = xr - a2R;
      v1 = c1 * a1R + c2 * v3;
      v2 = a2R + c2 * a1R + c3 * v3;
      a1R = 2 * v1 - a1R; a2R = 2 * v2 - a2R;
      let yr = mode === 0 ? v2 : mode === 1 ? xr - kk * v1 - v2 : mode === 2 ? kk * v1 : type === 6 ? xr - kk * v1 : 2 * v2 - xr + kk * v1;
      if (two) {
        c1 = 1 / (1 + g * (g + k));
        c2 = g * c1;
        c3 = g * c2;
        v3 = yl - b2L;
        v1 = c1 * b1L + c2 * v3;
        v2 = b2L + c2 * b1L + c3 * v3;
        b1L = 2 * v1 - b1L; b2L = 2 * v2 - b2L;
        yl = mode === 0 ? v2 : mode === 1 ? yl - k * v1 - v2 : k * v1;
        v3 = yr - b2R;
        v1 = c1 * b1R + c2 * v3;
        v2 = b2R + c2 * b1R + c3 * v3;
        b1R = 2 * v1 - b1R; b2R = 2 * v2 - b2R;
        yr = mode === 0 ? v2 : mode === 1 ? yr - k * v1 - v2 : k * v1;
      }
      L[i] = yl;
      R[i] = yr;
    }
    s[0] = a1L; s[1] = a2L; s[2] = a1R; s[3] = a2R; s[4] = b1L; s[5] = b2L; s[6] = b1R; s[7] = b2R;
    // a filter fed with silence decays into denormal numbers, which are many times slower to compute: stop there
    for (let i = 0; i < 8; i++) if (s[i] < 1e-30 && s[i] > -1e-30) s[i] = 0;
    st.g = st.gTo; st.k = st.kTo; st.drive = st.driveTo;
  }

  /** Feedback comb: cutoff is the pitch of the comb, resonance its feedback (metallic, flanged, plucked tones). */
  comb(f, L, R, m) {
    const st = this.fstate[f];
    if (!st.comb) {
      const size = 1 << Math.ceil(Math.log2(this.fsI / 16 + 4));
      st.comb = [new Float32Array(size), new Float32Array(size)];
    }
    const size = st.comb[0].length;
    const mask = size - 1;
    const delay = clamp(this.fsI / st.fc, 2, size - 2);
    const fb = st.res * 0.985;
    const damp = 0.25 + 0.5 * (1 - st.res);
    let pos = st.combPos;
    for (let ch = 0; ch < 2; ch++) {
      const buf = st.comb[ch];
      const io = ch ? R : L;
      let lp = st.combLp[ch];
      let w = st.combPos;
      for (let i = 0; i < m; i++) {
        const rd = w - delay + size;
        const ri = Math.floor(rd);
        const fr = rd - ri;
        const d = buf[ri & mask] + (buf[(ri + 1) & mask] - buf[ri & mask]) * fr;
        lp += damp * (d - lp);
        const y = io[i] + softClip(lp * fb);
        buf[w & mask] = y;
        io[i] = y * (1 - 0.45 * st.res);
        w++;
      }
      st.combLp[ch] = lp < 1e-30 && lp > -1e-30 ? 0 : lp;
      pos = w & mask;
    }
    st.combPos = pos;
    st.g = st.gTo; st.k = st.kTo; st.drive = st.driveTo;
  }
}

/** Position of unison voice u in the stack, -1..1 (a lone voice sits in the middle). */
function spreadOf(u, unison) {
  return unison < 2 ? 0 : (u / (unison - 1)) * 2 - 1;
}
