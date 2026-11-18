/* global AudioWorkletProcessor, registerProcessor, currentFrame, sampleRate */
// The GGS Synth inside the audio thread. Two processors:
//   ggs-voice  one note. Created when the note is scheduled; everything it needs arrives with it (processorOptions:
//              the patch, the key, where the song stands when it starts) or as AudioParams — gate, kill, the note's
//              pitch / pressure / timbre curves and the channel's macros.
//              Nothing depends on message timing, so an offline render is sample-identical every time.
//   ggs-fx     the channel's drive / chorus / delay / reverb / output gain, after its voices are summed.
// …and one processor per studio effect (gtd-fx-<type>): the mixer's DSP inserts (limiter, reverb, …), see below.
// Messages are only used for edits made while a note sounds (a knob turned in the editor) and tempo changes — and,
// the other way, for what the editor shows while it is open: a watched voice reports where its modulation stands
// about thirty times a second (nothing in the audio depends on it).
import { GgsVoice, GgsFx, prewarmTables, MACRO_COUNT, STUDIO_FX, SYNTH_ENGINES } from '@ggs/synth-dsp/engine';

const MACROS = Array.from({ length: MACRO_COUNT }, (_, i) => `macro${i + 1}`);

const param = (name, defaultValue, minValue, maxValue, automationRate) => ({ name, defaultValue, minValue, maxValue, automationRate });

class GgsVoiceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      param('gate', 1, 0, 1, 'a-rate'),
      param('kill', 0, 0, 1, 'k-rate'),
      param('pitch', 0, -96, 96, 'a-rate'),
      param('pressure', 0, 0, 1, 'a-rate'),
      param('timbre', 0, 0, 1, 'a-rate'),
      // how the note is let go (read on the block where the gate falls: set both at the same time)
      param('release', 0.5, 0, 1, 'k-rate'),
      ...MACROS.map((name) => param(name, 0, 0, 1, 'k-rate'))
    ];
  }

  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.o = o;
    this.startFrame = Math.round((o.start || 0) * sampleRate);
    this.voice = null;
    this.off = false;
    this.done = false;
    this.pending = null; // edits that arrive before the note has started
    this.macros = new Float32Array(MACRO_COUNT);
    this.ctl = { pitch: 0, pressure: 0, timbre: 0, macros: this.macros };
    this.watch = !!o.watch;
    this.report = null; // [sources…, targets…] as last evaluated, copied out for the editor
    this.nextReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m?.type === 'watch') this.watch = !!m.on;
      else if (m?.type === 'params') {
        if (this.voice) this.voice.setParams(m.values);
        else this.pending = { ...(this.pending || {}), ...m.values };
      } else if (m?.type === 'tempo') {
        this.o.bpm = m.bpm;
        this.voice?.setTempo(m.bpm);
      }
    };
  }

  finish() {
    this.done = true;
    this.voice = null;
    this.port.postMessage({ type: 'ended' });
    return false;
  }

  process(inputs, outputs, parameters) {
    if (this.done) return false;
    if (parameters.kill[0] > 0.5) return this.finish();
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    let from = 0;
    if (!this.voice) {
      const at = this.startFrame - currentFrame;
      if (at >= n) return true; // the note starts in a later block
      from = Math.max(0, at);
      const o = this.o;
      // where the song stands on the note's first frame: `beat` is for the moment the note was asked for, and the
      // frame it really starts on is that moment rounded to a sample (or later, if it was asked for too late)
      const late = (currentFrame + from) / sampleRate - (o.start || 0);
      const beat = (o.beat ?? ((o.start || 0) * o.bpm) / 60) + (late * o.bpm) / 60;
      this.voice = new GgsVoice({ sampleRate, params: this.pending ? { ...o.params, ...this.pending } : o.params, key: o.key, tune: o.tune, velocity: o.velocity, seed: o.seed, bpm: o.bpm, beat, glideFrom: o.glideFrom, legato: o.legato });
    }
    const voice = this.voice;
    const ctl = this.ctl;
    ctl.pitch = parameters.pitch;
    ctl.pressure = parameters.pressure;
    ctl.timbre = parameters.timbre;
    for (let i = 0; i < MACRO_COUNT; i++) this.macros[i] = parameters[MACROS[i]][0];

    // note-off on its exact sample: the first frame where the gate has fallen
    let offAt = -1;
    if (!this.off) {
      const gate = parameters.gate;
      if (gate.length === 1) { if (gate[0] < 0.5) offAt = from; } else {
        for (let i = from; i < n; i++) if (gate[i] < 0.5) { offAt = i; break; }
      }
    }
    if (offAt >= 0) {
      if (offAt > from) voice.process(L, R, from, offAt - from, ctl);
      voice.noteOff(parameters.release[0]);
      this.off = true;
      voice.process(L, R, offAt, n - offAt, ctl);
    } else {
      voice.process(L, R, from, n - from, ctl);
    }
    if (this.watch && currentFrame >= this.nextReport) {
      this.nextReport = currentFrame + sampleRate / 30;
      const src = voice.src;
      const dst = voice.dst;
      if (!this.report) this.report = new Float32Array(src.length + dst.length);
      this.report.set(src);
      this.report.set(dst, src.length);
      this.port.postMessage({ type: 'mod', start: this.startFrame, values: this.report });
    }
    return voice.finished ? this.finish() : true;
  }
}

class GgsFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.fx = new GgsFx({ sampleRate, params: o.params, bpm: o.bpm || 120 });
    this.closed = false;
    // the channel's wavetables are built here, when the channel appears or its patch changes — not on a note's
    // first block, where tens of milliseconds of table building would be heard as a dropout
    prewarmTables(o.params);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m?.type === 'params') { this.fx.setParams(m.values); prewarmTables(m.values); }
      else if (m?.type === 'tempo') this.fx.setTempo(m.bpm);
      else if (m?.type === 'close') this.closed = true;
    };
  }

  process(inputs, outputs) {
    if (this.closed) return false;
    const input = inputs[0];
    const L = outputs[0][0];
    const R = outputs[0][1];
    // no voice sounding: the input has no channels — the effects still run, to play out their tails
    if (input.length) {
      L.set(input[0]);
      R.set(input[1] || input[0]);
    }
    this.fx.process(L, R, L, R, L.length);
    return true;
  }
}

registerProcessor('ggs-voice', GgsVoiceProcessor);
registerProcessor('ggs-fx', GgsFxProcessor);

// ---- studio effects (mixer inserts). One processor per effect type, so each has its own automatable settings as
// AudioParams (k-rate: read once per block). Everything else arrives with the node (processorOptions) or, when a knob
// is turned later, as a message. Tempo-synced effects follow the song through a sync point — "beat b is at context
// time t, at this tempo" — which takes effect at t, whenever the message that carries it arrives: an offline render
// starts with its sync point already in the options, so its timing never depends on a message.
for (const [type, Fx] of Object.entries(STUDIO_FX)) {
  const auto = Fx.defs.filter((d) => d.type === 'number' && d.automatable);
  class StudioFxProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return auto.map((d) => param(d.key, d.default, d.min, d.max, 'k-rate'));
    }

    constructor(options) {
      super();
      const o = options.processorOptions || {};
      this.fx = new Fx(sampleRate);
      this.fx.set(o.params || {});
      this.seen = {};
      this.at = { time: o.time || 0, beat: o.beat || 0, bpm: o.bpm || 120, playing: !!o.playing };
      this.next = null;
      this.closed = false;
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m?.type === 'params') this.fx.set(m.values);
        else if (m?.type === 'sync') this.next = { time: m.time, beat: m.beat, bpm: m.bpm, playing: m.playing !== false };
        else if (m?.type === 'reset') this.fx.reset();
        else if (m?.type === 'close') this.closed = true;
      };
    }

    process(inputs, outputs, parameters) {
      if (this.closed) return false;
      const input = inputs[0];
      const L = outputs[0][0];
      const R = outputs[0][1];
      // nothing connected or nothing sounding: the input has no channels — the effect still runs, to play out its tail
      if (input.length) {
        L.set(input[0]);
        R.set(input[1] || input[0]);
      }
      const seen = this.seen;
      let moved = false;
      for (let i = 0; i < auto.length; i++) {
        const key = auto[i].key;
        const v = parameters[key][0];
        if (seen[key] !== v) { seen[key] = v; moved = true; }
      }
      if (moved) this.fx.set(seen);
      const t = currentFrame / sampleRate;
      if (this.next && t >= this.next.time) { this.at = this.next; this.next = null; }
      const at = this.at;
      this.fx.clock(at.beat + ((t - at.time) * at.bpm) / 60, at.bpm, at.playing);
      this.fx.process(L, R, L.length);
      return true;
    }
  }
  registerProcessor(`gtd-fx-${type}`, StudioFxProcessor);
}

// ---- synth engines (additive, modal, …): one processor per engine, one node per note — the same life as a GGS voice.
// The note arrives whole (processorOptions: settings, key, velocity, tuning, its start time, its seed); the gate, a
// hard stop, the pitch bend and the release velocity are AudioParams, so the key is let go on its exact sample and an
// offline render repeats sample for sample.
for (const [type, Engine] of Object.entries(SYNTH_ENGINES)) {
  class EngineVoiceProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [param('gate', 1, 0, 1, 'a-rate'), param('kill', 0, 0, 1, 'k-rate'), param('pitch', 0, -96, 96, 'k-rate'), param('release', 0.5, 0, 1, 'k-rate')];
    }

    constructor(options) {
      super();
      this.o = options.processorOptions || {};
      this.startFrame = Math.round((this.o.start || 0) * sampleRate);
      this.voice = null;
      this.off = false;
      this.done = false;
      this.pending = null; // a knob turned before the note has started
      this.bl = new Float32Array(128);
      this.br = new Float32Array(128);
      this.port.onmessage = (e) => {
        if (e.data?.type !== 'params') return;
        if (this.voice) this.voice.set(e.data.values);
        else this.pending = { ...(this.pending || {}), ...e.data.values };
      };
    }

    finish() {
      this.done = true;
      this.voice = null;
      this.port.postMessage({ type: 'ended' });
      return false;
    }

    /** n samples of the note into the output from `at` (through the scratch block: no views are made per block). */
    fill(L, R, at, n, bend) {
      const { bl, br } = this;
      this.voice.render(bl, br, n, bend);
      for (let i = 0; i < n; i++) { L[at + i] = bl[i]; R[at + i] = br[i]; }
    }

    process(inputs, outputs, parameters) {
      if (this.done) return false;
      if (parameters.kill[0] > 0.5) return this.finish();
      const L = outputs[0][0];
      const R = outputs[0][1] || L;
      const n = L.length;
      if (n > this.bl.length) { this.bl = new Float32Array(n); this.br = new Float32Array(n); }
      let from = 0;
      if (!this.voice) {
        const at = this.startFrame - currentFrame;
        if (at >= n) return true; // the note starts in a later block
        from = Math.max(0, at);
        const o = this.o;
        this.voice = new Engine(sampleRate, o.seed);
        this.voice.set(this.pending ? { ...o.params, ...this.pending } : o.params || {});
        this.voice.noteOn(o.key ?? 60, o.velocity ?? 0.8, o.tune || 0);
      }
      const bend = parameters.pitch[0];
      let offAt = -1;
      if (!this.off) {
        const gate = parameters.gate;
        if (gate.length === 1) { if (gate[0] < 0.5) offAt = from; } else {
          for (let i = from; i < n; i++) if (gate[i] < 0.5) { offAt = i; break; }
        }
      }
      if (offAt >= 0) {
        if (offAt > from) this.fill(L, R, from, offAt - from, bend);
        this.voice.noteOff(parameters.release[0]);
        this.off = true;
        this.fill(L, R, offAt, n - offAt, bend);
      } else {
        this.fill(L, R, from, n - from, bend);
      }
      return this.voice.finished ? this.finish() : true;
    }
  }
  registerProcessor(`gtd-voice-${type}`, EngineVoiceProcessor);
}
