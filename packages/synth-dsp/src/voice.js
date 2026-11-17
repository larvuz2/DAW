// One note of the GGS Synth: three wavetable oscillators (unison, warp, phase modulation), a sub and a noise source,
// two filters, four envelopes, four LFOs and a modulation matrix — all per note, so every note carries its own
// pitch bend, pressure and timbre. Pure JavaScript with no allocation while rendering: the same class runs inside the
// AudioWorklet (realtime and offline renders) and in Node (tests, headless analysis).
//
// Rendering runs in control blocks of CTRL output samples: modulation is evaluated once per block and every audible
// control (pitch, level, table position, cutoff, amp) is ramped across the block, so nothing steps ("zipper noise").
import { getWavetable, tableLevel, levelFor, FRAME, STRIDE } from './wavetables.js';
import { GGS_PARAMS, LFO_STEPS, stepShape, completeParams, syncBeats, needsOversampling, envCurveK, MOD_SOURCES, MOD_TARGETS, OSC_IDS, ENV_COUNT, LFO_COUNT, MACRO_COUNT, CHAOS_COUNT, CHAOS_TYPES, MOD_SLOTS, SOURCE_DESTS, WARP_MODES, LFO_SHAPES, SUB_WAVES } from './params.js';
import { VoiceFilter, NC, NS } from './filters.js';
import { Chaos } from './chaos.js';
import { MAX_UNISON, UNISON_LAWS, UNISON_STACKS, spreadOf, unisonCents, stackSemis } from './unison.js';
import { Rng, hash32, hashBipolar, Decimator2, DEFAULT_HALFBAND, Arena, clamp, TAU } from './util.js';

export const CTRL = 16;
const MAX_INNER = CTRL * 2; // internal samples per control block at 2× oversampling

const SRC = Object.fromEntries(MOD_SOURCES.map((s, i) => [s, i]));
const DST = Object.fromEntries(MOD_TARGETS.map((s, i) => [s, i]));
const WARP = Object.fromEntries(WARP_MODES.map((s, i) => [s, i]));
const LFO = Object.fromEntries(LFO_SHAPES.map((s, i) => [s, i]));
// the keys of the matrix slots, built once (64 slots × 4 template strings per note would add up)
// Param keys by group and field, built once — K.oscA.Pos === 'oscAPos' — so that starting a note builds no strings.
function keysOf(prefix) {
  const out = {};
  for (const d of GGS_PARAMS) if (d.key.startsWith(prefix)) out[d.key.slice(prefix.length)] = d.key;
  return out;
}
const OSC_K = Object.fromEntries(OSC_IDS.map((x) => [x, keysOf(`osc${x}`)]));
const OSC_BASE = Object.fromEntries(OSC_IDS.map((x) => [x, DST[`osc${x}Pitch`]])); // first of an oscillator's seven targets
const ENV_K = [null, ...[1, 2, 3, 4].map((i) => keysOf(`env${i}`))];
const LFO_K = [null, ...[1, 2, 3, 4].map((i) => keysOf(`lfo${i}`))];
const F_K = [null, keysOf('f1'), keysOf('f2')];
const CHAOS_K = [null, ...Array.from({ length: CHAOS_COUNT }, (_, i) => keysOf(`chaos${i + 1}`))];
// everything a voice keeps in typed arrays over 64 bytes comes out of one block (see Arena)
const VOICE_BYTES = 8 * (5 * (MAX_INNER / 2) + MOD_SOURCES.length + MOD_TARGETS.length + 2 * (3 * NC + NS) + 4 * DEFAULT_HALFBAND.length);
const TURING = CHAOS_TYPES.indexOf('turing');
const STEPS = LFO.steps; // the drawn LFO shape
const LFO_STEP_KEYS = [null, ...[1, 2, 3, 4].map((i) => Array.from({ length: LFO_STEPS }, (_, k) => `lfo${i}S${k + 1}`))];
const MACRO_KEYS = Array.from({ length: MACRO_COUNT }, (_, i) => `macro${i + 1}`);
const SLOT_KEYS = Array.from({ length: MOD_SLOTS }, (_, i) => [`mod${i + 1}Src`, `mod${i + 1}Dst`, `mod${i + 1}Amt`, `mod${i + 1}Via`]);

// scratch buffers shared by every voice in a realm (voices render one after another, never interleaved)
const bus = () => new Float32Array(MAX_INNER);
const B1L = bus(), B1R = bus(), B2L = bus(), B2R = bus(), DL = bus(), DR = bus(), TL = bus(), TR = bus(), OL = bus(), OR = bus();

const valueAt = (v, i) => (typeof v === 'number' ? v : v.length > 1 ? v[i] : v[0]);

// Changing what a voice is made of while it sounds — an oscillator switched on, another wavetable, a different filter
// model — would click: a wave appears at full level, or a filter's memory suddenly means something else. Such
// changes wait: the part they belong to fades out over FADE seconds, is swapped while silent, and fades back in.
// Units 0–2 are the oscillators (each fades alone), unit 3 is everything on the buses (the whole voice dips).
const FADE = 0.004;
const BUS = 3;
const SWAP_KEYS = [
  ...OSC_IDS.map((x) => ['On', 'Table', 'Warp', 'FmFrom', 'Dest', 'Unison', 'UniLaw', 'Stack'].map((k) => `osc${x}${k}`)),
  ['f1On', 'f1Type', 'f2On', 'f2Type', 'filterRoute', 'subWave', 'subDest', 'noiseType', 'noiseDest']
];

const IDLE = 0, DELAY = 1, ATTACK = 2, HOLD = 3, DECAY = 4, SUSTAIN = 5, RELEASE = 6, DONE = 7;

/**
 * Delay · attack · hold · decay · sustain · release, each moving stage with its own curve. A stage runs along
 * rise(x) = (1 − e^{−kx}) / (1 − e^{−k}) for x = 0..1 (k from the stage's curve, see envCurveK; k = 0 is a straight
 * line); 1 / (1 − e^{−k}) is computed once per parameter change (see GgsVoice.configure).
 */
class Envelope {
  constructor() {
    this.stage = IDLE;
    this.t = 0;
    this.level = 0;
    this.from = 0;
  }

  /** legato: a note that continues the previous one starts in its sustain stage instead of attacking again. */
  on(legato, c) {
    this.t = 0;
    this.from = 0;
    if (legato) { this.stage = SUSTAIN; this.level = c.s; } else { this.stage = c.dl > 0 ? DELAY : ATTACK; this.level = 0; }
  }

  off() {
    if (this.stage === DONE || this.stage === RELEASE) return;
    this.from = this.level;
    this.stage = RELEASE;
    this.t = 0;
  }

  /** c: the envelope's cached numbers (times, sustain, and per stage the exponent k and its normaliser n). */
  advance(dt, c, rel) {
    switch (this.stage) {
      case DELAY:
        this.t += dt;
        if (this.t >= c.dl) { this.stage = ATTACK; this.t = 0; }
        break;
      case ATTACK:
        this.t += dt;
        if (this.t >= c.a) { this.level = 1; this.stage = c.h > 0 ? HOLD : DECAY; this.t = 0; } else this.level = c.na ? (1 - Math.exp((-c.ka * this.t) / c.a)) * c.na : this.t / c.a;
        break;
      case HOLD:
        this.t += dt;
        if (this.t >= c.h) { this.stage = DECAY; this.t = 0; }
        break;
      case DECAY:
        this.t += dt;
        if (this.t >= c.d) { this.level = c.s; this.stage = SUSTAIN; } else this.level = c.s + (1 - c.s) * (1 - (c.nd ? (1 - Math.exp((-c.kd * this.t) / c.d)) * c.nd : this.t / c.d));
        break;
      case SUSTAIN:
        this.level = c.s;
        break;
      case RELEASE: {
        this.t += dt;
        const r = c.r * rel;
        if (this.t >= r) { this.level = 0; this.stage = DONE; } else this.level = this.from * (1 - (c.nr ? (1 - Math.exp((-c.kr * this.t) / r)) * c.nr : this.t / r));
        break;
      }
      default:
        break;
    }
    return this.level;
  }
}

/** Exponent and normaliser of a stage curve (normaliser 0 = straight line). */
function stageCurve(curve) {
  const k = envCurveK(curve);
  return k < 1e-4 && k > -1e-4 ? [0, 0] : [k, 1 / (1 - Math.exp(-k))];
}

/** One oscillator's running state. */
class Osc {
  constructor(id, mem) {
    this.id = id;
    this.phase = new Float64Array(MAX_UNISON);
    this.ratio = new Float64Array(MAX_UNISON).fill(1);
    this.gl = new Float64Array(MAX_UNISON);
    this.gr = new Float64Array(MAX_UNISON);
    this.gm = new Float64Array(MAX_UNISON);
    this.fbA = new Float64Array(MAX_UNISON);
    this.fbB = new Float64Array(MAX_UNISON);
    this.mono = mem.f32(MAX_INNER);
    this.on = false;
    this.table = null;
    this.unison = 0;
    this.detune = -1;
    this.lastPan = NaN;
    // the unison law and stack, how far the copies are spread over the table, and the highest pitch among them
    this.law = 0;
    this.stack = 0;
    this.uniPos = 0;
    this.uniNow = 0; // (where the spread over the table stands: it moves to uniPos over a block, as the position does)
    this.maxRatio = 1;
    this.need = 0;
    this.data = null;
    this.inc = 0;
    this.level = 0;
    this.pos = 0;
    this.warpAmt = 0;
    this.fm = 0;
    this.monoGate = 1;
    this.monoTo = 1;
    this.first = true;
  }
}

export class GgsVoice {
  /**
   * opts: { sampleRate, params, key, velocity, seed, bpm, beat, glideFrom (Hz, 0 = none), legato }
   * seed makes the note's random parts (unison phases, noise, random LFOs) repeatable: same seed, same audio.
   * beat is the song position (in beats) of the note's first frame: "free" LFOs and tempo-locked Turing patterns are
   * functions of it, so every note hears them at the same place, and a render hears what playback did.
   */
  constructor(opts) {
    this.fs = opts.sampleRate;
    this.p = completeParams(opts.params);
    // oversampling (fixed for the note's life): "high" always, "auto" where the patch can alias; never above 96 kHz
    const q = this.p.quality;
    this.os = this.fs < 80000 && (q === 'high' || (q === 'auto' && needsOversampling(this.p))) ? 2 : 1;
    this.fsI = this.fs * this.os;
    this.key = opts.key ?? 60;
    // the note's place in the project's tuning: cents away from the equal-tempered key (0 in standard tuning)
    this.tune = Number.isFinite(opts.tune) ? opts.tune / 100 : 0;
    this.vel = clamp(opts.velocity ?? 0.8, 0, 1);
    this.bpm = opts.bpm || 120;
    // the clock that "free" LFOs and tempo-locked patterns follow: where the song stands at this note's first frame,
    // counted on from there in frames (re-anchored when the tempo changes, so it never jumps)
    this.beat0 = Number.isFinite(opts.beat) ? opts.beat : 0;
    this.time0 = (this.beat0 * 60) / this.bpm;
    this.frames = 0;
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

    const mem = new Arena(VOICE_BYTES);
    this.oscs = OSC_IDS.map((id) => new Osc(id, mem));
    this.sub = { phase: 0, inc: 0, level: 0, mono: mem.f32(MAX_INNER), first: true, need: 0, lvl: 0, data: null };
    this.noise = { level: 0, mono: mem.f32(MAX_INNER), lp: 0, lpR: 0, pink: new Float64Array(6), brown: 0, brownR: 0, first: true };
    this.vf = [new VoiceFilter(this.fsI, mem), new VoiceFilter(this.fsI, mem)];
    this.fstate = [{ fc: 1000, lastOct: NaN, lastCutoff: NaN }, { fc: 1000, lastOct: NaN, lastCutoff: NaN }];
    // fades around structural edits (see SWAP_KEYS): how open each unit is, where it is heading, what waits
    this.gate = new Float64Array(4);
    this.gateTo = new Float64Array(4);
    this.open = new Float64Array(4);
    this.swap = [false, false, false, false];
    this.next = null;
    this.envs = Array.from({ length: ENV_COUNT }, () => new Envelope());
    this.lfoPhase = new Float64Array(LFO_COUNT);
    this.macro = new Float64Array(MACRO_COUNT);
    this.chaos = [null, null];
    this.chaosc = Array.from({ length: CHAOS_COUNT }, () => ({ used: false, type: 0, rate: 1, beats: 0, char: 0.5, steps: 16, same: false, built: false, locked: false }));
    this.src = mem.f64(MOD_SOURCES.length);
    this.dst = mem.f64(MOD_TARGETS.length);
    this.amp = 0;
    this.panL = Math.SQRT1_2;
    this.panR = Math.SQRT1_2;
    this.dec = this.os === 2 ? new Decimator2(DEFAULT_HALFBAND, mem) : null;

    const target = 440 * Math.pow(2, (this.key - 69) / 12);
    this.glideSemis = opts.glideFrom > 0 && this.p.glide > 0 ? 12 * Math.log2(opts.glideFrom / target) : 0;
    this.configure();
    for (let i = 0; i < LFO_COUNT; i++) this.lfoPhase[i] = this.p[LFO_K[i + 1].Phase];
    for (let u = 0; u < 4; u++) this.gate[u] = this.gateTo[u] = this.unitOpen(u);
    const legato = !!opts.legato && this.p.legato;
    for (let i = 0; i < ENV_COUNT; i++) this.envs[i].on(legato, this.envc[i]);
  }

  /** How open a fade unit is when nothing is changing: an oscillator that is off stays closed. */
  unitOpen(u) {
    return u === BUS || this.p[OSC_K[OSC_IDS[u]].On] ? 1 : 0;
  }

  /**
   * Live edit while the note sounds (a knob turned in the editor). Oversampling is fixed for the note's life.
   * Knob moves apply at once (and are ramped); structural changes wait for their unit to fade out — see SWAP_KEYS.
   */
  setParams(delta) {
    const quality = this.p.quality;
    const next = completeParams({ ...(this.next || this.p), ...delta, quality });
    const now = { ...next };
    let waiting = false;
    for (let u = 0; u < 4; u++) {
      const keys = SWAP_KEYS[u];
      let differs = false;
      for (const k of keys) if (next[k] !== this.p[k]) { differs = true; break; }
      if (differs) {
        for (const k of keys) now[k] = this.p[k];
        this.swap[u] = true;
        this.gateTo[u] = 0;
        waiting = true;
      } else if (this.swap[u]) {
        // the change was taken back before it happened: just open up again
        this.swap[u] = false;
        this.gateTo[u] = this.unitOpen(u);
      }
    }
    this.next = waiting ? next : null;
    this.p = now;
    this.configure();
  }

  /** Swap in the waiting structure of every unit that has finished fading out. */
  applySwaps() {
    let changed = false;
    let waiting = false;
    for (let u = 0; u < 4; u++) {
      if (!this.swap[u]) continue;
      if (this.gate[u] > 0) { waiting = true; continue; }
      const was1 = this.p.f1On;
      const was2 = this.p.f2On;
      for (const k of SWAP_KEYS[u]) this.p[k] = this.next[k];
      this.swap[u] = false;
      changed = true;
      // a filter that comes (back) on must not replay what it last heard. Only that one: an edit elsewhere on the
      // buses must not cut off a comb that is still ringing. (A new model clears its own memory in setType.)
      if (u === BUS) {
        if (!was1 && this.p.f1On) this.vf[0].reset();
        if (!was2 && this.p.f2On) this.vf[1].reset();
      }
    }
    if (changed) {
      this.configure();
      for (let u = 0; u < 4; u++) if (!this.swap[u]) this.gateTo[u] = this.unitOpen(u);
    }
    if (!waiting) this.next = null;
  }

  setTempo(bpm) {
    if (!(bpm > 0) || bpm === this.bpm) return;
    // the clock carries on from where it stands, at the new speed
    const t = this.frames / this.fs;
    this.beat0 += (t * this.bpm) / 60;
    this.time0 += t;
    this.frames = 0;
    this.bpm = bpm;
  }

  /** Everything that only changes when a parameter changes. */
  configure() {
    const p = this.p;
    for (const o of this.oscs) {
      const x = o.id;
      const k = OSC_K[x];
      o.on = p[k.On];
      if (!o.on) continue;
      const tableId = p[k.Table];
      if (!o.table || o.table.id !== tableId) o.table = getWavetable(tableId);
      const unison = Math.round(p[k.Unison]);
      if (unison !== o.unison) {
        // new unison voices start at their own phase so a stack never begins as one loud, phasey spike
        for (let u = o.unison; u < unison; u++) o.phase[u] = (p[k.Phase] + p[k.Rand] * this.rng.unit()) % 1;
        o.unison = unison;
        o.detune = -1;
        o.lastPan = NaN;
      }
      // numbers the control loop reads every block (string-keyed lookups are far too slow for that)
      o.semis = p[k.Oct] * 12 + p[k.Semi] + p[k.Fine] / 100;
      o.pPos = p[k.Pos];
      o.pLevel = p[k.Level];
      o.pPan = p[k.Pan];
      o.pWarp = p[k.WarpAmt];
      o.pFm = p[k.Fm];
      o.pDetune = p[k.Detune];
      if (p[k.Blend] !== o.blend || p[k.Spread] !== o.spread) o.lastPan = NaN;
      const law = UNISON_LAWS.indexOf(p[k.UniLaw]);
      const stack = UNISON_STACKS.indexOf(p[k.Stack]);
      if (law !== o.law || stack !== o.stack) { o.law = law; o.stack = stack; o.detune = -1; }
      o.uniPos = p[k.UniPos];
      o.blend = p[k.Blend];
      o.spread = p[k.Spread];
      o.base = OSC_BASE[x];
      o.need = 0;
      o.warp = WARP[p[k.Warp]] || 0;
      o.dest = SOURCE_DESTS.indexOf(p[k.Dest]);
      const from = p[k.FmFrom];
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
    for (let i = 0; i < MOD_SLOTS; i++) {
      const keys = SLOT_KEYS[i];
      const s = SRC[p[keys[0]]] || 0;
      if (!s) continue;
      const d = DST[p[keys[1]]] || 0;
      const amt = p[keys[2]];
      if (!d || !amt) continue;
      const via = SRC[p[keys[3]]] || 0;
      this.slots.push(s, d, amt, via);
      used.add(s);
      if (via) used.add(via);
    }
    this.slotCount = this.slots.length / 4;
    this.envUsed = [true, used.has(SRC.env2), used.has(SRC.env3), used.has(SRC.env4)];
    this.lfoUsed = [1, 2, 3, 4].map((i) => used.has(SRC.lfo1 + i - 1));
    // chaos sources cost nothing until they are routed; a generator is made the first time one is
    for (let i = 0; i < CHAOS_COUNT; i++) {
      const n = i + 1;
      const sync = p[CHAOS_K[n].Sync];
      const same = p[CHAOS_K[n].Path] === 'same';
      const c = this.chaosc[i];
      c.used = used.has(SRC.chaos1 + i);
      c.type = Math.max(0, CHAOS_TYPES.indexOf(p[CHAOS_K[n].Type]));
      c.rate = p[CHAOS_K[n].Rate];
      c.beats = sync === 'off' ? 0 : syncBeats(sync);
      c.char = p[CHAOS_K[n].Char];
      c.steps = p[CHAOS_K[n].Steps];
      // (`built`: the path the generator was made for — the setting may change while the source is not routed)
      if (c.used && (!this.chaos[i] || c.built !== same)) {
        this.chaos[i] = new Chaos(same ? 0xc4a05 + i : hash32(this.seed ^ Math.imul(i + 1, 0x632be5ab)));
        c.built = same;
      }
      c.same = same;
      c.locked = same && c.beats > 0 && c.type === TURING;
    }
    this.envc = [1, 2, 3, 4].map((i) => {
      const [ka, na] = stageCurve(p[ENV_K[i].ACurve]);
      const [kd, nd] = stageCurve(p[ENV_K[i].DCurve]);
      const [kr, nr] = stageCurve(p[ENV_K[i].RCurve]);
      return { dl: p[ENV_K[i].Delay], a: p[ENV_K[i].A], h: p[ENV_K[i].Hold], d: p[ENV_K[i].D], s: p[ENV_K[i].S], r: p[ENV_K[i].R], ka, na, kd, nd, kr, nr };
    });
    this.lfoc = [1, 2, 3, 4].map((i) => {
      const sync = p[LFO_K[i].Sync];
      const free = p[LFO_K[i].Trig] === 'free';
      const shape = LFO[p[LFO_K[i].Shape]] || 0;
      const c = { shape, rate: p[LFO_K[i].Rate], beats: sync === 'off' ? 0 : syncBeats(sync), free, fade: p[LFO_K[i].Fade], phase: p[LFO_K[i].Phase], seed: free ? 1000 + i : this.seed + i, steps: null, count: 0, smooth: 0 };
      if (shape === STEPS) {
        c.count = Math.round(p[LFO_K[i].Steps]);
        c.smooth = p[LFO_K[i].Smooth];
        c.steps = LFO_STEP_KEYS[i].map((key) => p[key]);
      }
      return c;
    });
    this.fc = [1, 2].map((i) => ({ on: p[F_K[i].On], cutoff: p[F_K[i].Cutoff], res: p[F_K[i].Res], drive: p[F_K[i].Drive], key: p[F_K[i].Key], morph: p[F_K[i].Morph] }));
    this.vf[0].setType(p.f1Type);
    this.vf[1].setType(p.f2Type);
    for (let i = 0; i < MACRO_COUNT; i++) this.macro[i] = p[MACRO_KEYS[i]];
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
    this.subFrame = SUB_WAVES.indexOf(p.subWave);
    this.subMult = Math.pow(2, p.subOct);
    this.subDest = SOURCE_DESTS.indexOf(p.subDest);
    this.noiseDest = SOURCE_DESTS.indexOf(p.noiseDest);
    this.subNeedMono = this.oscs.some((q) => q.on && q.fmFrom === 'sub');
    this.noiseNeedMono = this.oscs.some((q) => q.on && q.fmFrom === 'noise');
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
   * ctl: { pitch, pressure, timbre, macros[8] } — pitch (semitones), pressure and timbre (0..1) are numbers or
   * per-frame arrays indexed like the output; macros are 0..1 (missing ones take the patch's own values).
   */
  process(outL, outR, start, count, ctl) {
    if (this.finished) return;
    const os = this.os;
    let done = 0;
    while (done < count && !this.finished) {
      const m = Math.min(CTRL, count - done);
      const i0 = start + done;
      this.frames += m;
      this.control(m / this.fs, ctl, i0 + m - 1);
      const mi = m * os;
      this.renderBlock(mi);
      if (os === 2) this.dec.process(OL, OR, outL, outR, m, true, i0);
      else for (let i = 0; i < m; i++) { outL[i0 + i] += OL[i]; outR[i0 + i] += OR[i]; }
      done += m;
      // over: the amp envelope has closed — or sits at a sustain of zero, where a pluck stays silent for good
      const amp = this.envs[0];
      if (amp.stage === DONE || (amp.stage === SUSTAIN && this.p.env1S <= 0)) this.finished = true;
    }
  }

  /** Evaluate envelopes, LFOs and the matrix for the end of a block of `dt` seconds; sets the ramp targets. */
  control(dt, ctl, index) {
    const src = this.src;
    const dst = this.dst;
    this.age += dt;
    const sinceAnchor = this.frames / this.fs;
    const timeEnd = this.time0 + sinceAnchor;
    const beatEnd = this.beat0 + (sinceAnchor * this.bpm) / 60;
    if (this.next) this.applySwaps();
    const gate = this.gate;
    for (let u = 0; u < 4; u++) {
      const to = this.gateTo[u];
      if (gate[u] !== to) gate[u] = gate[u] < to ? Math.min(to, gate[u] + dt / FADE) : Math.max(to, gate[u] - dt / FADE);
      // an S-shaped fade: no corner where it starts or ends
      this.open[u] = gate[u] * gate[u] * (3 - 2 * gate[u]);
    }
    const open = this.open;
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
    const given = macros ? macros.length : 0;
    for (let i = 0; i < MACRO_COUNT; i++) src[SRC.macro1 + i] = clamp(i < given ? macros[i] : this.macro[i], 0, 1);
    for (let i = 0; i < CHAOS_COUNT; i++) {
      const c = this.chaosc[i];
      if (!c.used) continue;
      // a tempo-synced Turing pattern on the shared path follows the song, like a "free" LFO: every note hears the
      // same step at the same moment, on the grid
      src[SRC.chaos1 + i] = c.locked ? this.chaos[i].at(beatEnd / c.beats, c.char, c.steps) : this.chaos[i].advance(dt, c.type, c.beats ? this.bpm / 60 / c.beats : c.rate, c.char, c.steps);
    }

    // LFOs read the rate modulation of the previous block (one block late is inaudible, and it breaks the loop
    // "LFO → matrix → LFO rate")
    for (let i = 0; i < LFO_COUNT; i++) {
      if (!this.lfoUsed[i]) continue;
      const c = this.lfoc[i];
      let rate = c.beats ? this.bpm / 60 / c.beats : c.rate;
      let phase;
      if (c.free) {
        // tied to the song: every note hears the same LFO (a synced one counts beats, so it stays on the grid
        // through a tempo change)
        phase = (c.beats ? beatEnd / c.beats : timeEnd * rate) + c.phase;
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
        case 7: v = stepShape(c.steps, c.count, c.smooth, x); break; // a drawn shape
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
    const pitch = this.key + this.tune + glide + bend + dst[DST.pitch] * 24 + dst[DST.pitchFine];
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
      o.levelTo = clamp(o.pLevel + dst[base + 2], 0, 2) * open[k];
      o.warpTo = clamp(o.pWarp + dst[base + 4], 0, 1);
      o.fmTo = clamp(o.pFm + dst[base + 5], 0, 1);
      const detune = clamp(o.pDetune + dst[base + 6] * 100, 0, 200);
      if (detune !== o.detune) {
        o.detune = detune;
        let top = 1;
        for (let u = 0; u < o.unison; u++) {
          const ratio = Math.pow(2, unisonCents(o.law, u, o.unison, detune) / 1200 + stackSemis(o.stack, u, o.unison) / 12);
          o.ratio[u] = ratio;
          if (ratio > top) top = ratio;
        }
        o.maxRatio = top;
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
      // (an oscillator switched on while the note sounds starts from silence and fades in)
      // what other oscillators hear of this one as an FM source fades with it too (it does not pass the level knob)
      o.monoTo = open[k];
      if (o.first) { o.inc = o.incTo; o.pos = o.posTo; o.uniNow = o.uniPos * 0.5; o.level = gate[k] < 1 ? 0 : o.levelTo; o.monoGate = gate[k] < 1 ? 0 : 1; o.warpAmt = o.warpTo; o.fm = o.fmTo; o.first = false; }
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
      }
      this.vf[f].set(st.fc, clamp(c.res + dst[base + 1], 0, 1), clamp(c.drive + dst[base + 2], 0, 1), clamp(c.morph + dst[DST.f1Morph + f], 0, 1));
    }

    // ---- amp and pan
    this.ampTo = src[SRC.env1] * this.velGain * clamp(this.level + dst[DST.level], 0, 2) * open[BUS];
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
    // (a source used as an FM modulator is rendered even at level 0: it is heard through the oscillator it bends)
    if (this.noise.levelTo > 0 || this.noise.level > 0 || this.noiseNeedMono) this.renderNoise(m);
    for (const o of this.order) this.renderOsc(o, m);

    OL.fill(0, 0, m); OR.fill(0, 0, m);
    const f1 = this.fc[0].on;
    const f2 = this.fc[1].on;
    if (f1) this.vf[0].process(B1L, B1R, m);
    if (this.serial && f2) {
      for (let i = 0; i < m; i++) { B2L[i] += B1L[i]; B2R[i] += B1R[i]; }
    } else {
      for (let i = 0; i < m; i++) { OL[i] += B1L[i]; OR[i] += B1R[i]; }
    }
    if (f2) this.vf[1].process(B2L, B2R, m);
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
    // (the table position is worked out per unison copy, below: each may read its own)
    const uniFrom = o.unison > 1 ? o.uniNow : 0;
    const uniTo = o.unison > 1 ? o.uniPos * 0.5 : 0;
    o.uniNow = uniTo;

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
    const maxInc = Math.max(o.inc, o.incTo) * o.maxRatio;
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

    TL.fill(0, 0, m); TR.fill(0, 0, m);
    const mono = o.mono;
    const needMono = o.needMono;
    if (needMono) mono.fill(0, 0, m);
    const mg0 = o.monoGate;
    const dmg = (o.monoTo - mg0) / m;
    const lv0 = o.level;
    const dlv = (o.levelTo - lv0) / m;
    const dincBase = (o.incTo - o.inc) / m;

    for (let u = 0; u < o.unison; u++) {
      // table position: cross-fade the two neighbouring frames; a block that crosses a frame finishes at its edge.
      // With "Uni table" the copies stand at their own places around the Position knob (the stack spans the table).
      const place = uniFrom || uniTo ? spreadOf(u, o.unison) : 0;
      const fp0 = (place ? clamp(o.pos + place * uniFrom, 0, 1) : o.pos) * (frames - 1);
      const f0 = Math.min(frames - 1, Math.floor(fp0));
      const f1 = Math.min(frames - 1, f0 + 1);
      const w = fp0 - f0;
      const wTo = clamp((place ? clamp(o.posTo + place * uniTo, 0, 1) : o.posTo) * (frames - 1) - f0, 0, 1);
      const dw = (wTo - w) / m;
      const blendFrames = f1 !== f0 && (w > 0 || wTo > 0);
      const b0 = f0 * STRIDE + 1;
      const b1 = f1 * STRIDE + 1;
      let ph = o.phase[u];
      let inc = o.inc * o.ratio[u];
      const dinc = dincBase * o.ratio[u];
      // A copy whose own pitch is beyond what the sample rate carries (an octave stack on the very highest keys)
      // is left out for the block: it would fold back as a tone that is no note. Its phase moves on.
      if (maxInc > 0.46 / this.os && Math.max(o.inc, o.incTo) * o.ratio[u] * this.os > 0.46) {
        ph += (inc + 0.5 * dinc * m) * m;
        o.phase[u] = ph - Math.floor(ph);
        continue;
      }
      const gl = o.gl[u];
      const gr = o.gr[u];
      const gm = o.gm[u];
      let lv = lv0;
      let mg = mg0;
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
        if (needMono) { mg += dmg; mono[i] += s * gm * mg; }
      }
      o.phase[u] = ph;
      o.fbA[u] = y1;
      o.fbB[u] = y2;
    }
    o.inc = o.incTo; o.pos = o.posTo; o.level = o.levelTo; o.monoGate = o.monoTo; o.warpAmt = warpTo; o.fm = o.fmTo;
    this.route(o.dest, m);
  }

  /** The mono signal of another source, as a phase-modulation input. */
  fmBuffer(from) {
    if (from === 'sub') return this.sub.mono;
    if (from === 'noise') return this.noise.mono;
    // (an oscillator that is off renders nothing: its buffer would be the last block it made, looping for ever)
    const src = this.oscs[OSC_IDS.indexOf(from)];
    return src.on ? src.mono : null;
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
}

/** Position of unison voice u in the stack, -1..1 (a lone voice sits in the middle). */
