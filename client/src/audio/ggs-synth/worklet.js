/* global AudioWorkletProcessor, registerProcessor, currentTime, currentFrame, sampleRate */
// The GGS Synth inside the audio thread. Two processors:
//   ggs-voice  one note. Created when the note is scheduled; everything it needs arrives with it (processorOptions)
//              or as AudioParams — gate, kill, the note's pitch / pressure / timbre curves and the channel's macros.
//              Nothing depends on message timing, so an offline render is sample-identical every time.
//   ggs-fx     the channel's drive / chorus / delay / reverb / output gain, after its voices are summed.
// Messages are only used for edits made while a note sounds (a knob turned in the editor) and tempo changes — and,
// the other way, for what the editor shows while it is open: a watched voice reports where its modulation stands
// about thirty times a second (nothing in the audio depends on it).
import { GgsVoice, GgsFx, prewarmTables, MACRO_COUNT } from '@greanteadawy/synth-dsp/engine';

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
    this.ctl = { pitch: 0, pressure: 0, timbre: 0, macros: this.macros, time: 0 };
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
      this.voice = new GgsVoice({ sampleRate, params: this.pending ? { ...o.params, ...this.pending } : o.params, key: o.key, velocity: o.velocity, seed: o.seed, bpm: o.bpm, glideFrom: o.glideFrom, legato: o.legato });
    }
    const voice = this.voice;
    const ctl = this.ctl;
    ctl.pitch = parameters.pitch;
    ctl.pressure = parameters.pressure;
    ctl.timbre = parameters.timbre;
    for (let i = 0; i < MACRO_COUNT; i++) this.macros[i] = parameters[MACROS[i]][0];
    ctl.time = currentTime + from / sampleRate;

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
      ctl.time = currentTime + offAt / sampleRate;
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
