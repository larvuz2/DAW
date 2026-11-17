// The audio → visual bridge, in the tab that plays: about 60 times a second it measures what is heard (master levels,
// six bands, a 32-band spectrum, centroid, onsets, every mixer insert and channel), reads where the song is (transport,
// marker, automation, the eight visual lanes) and collects the notes that started or ended — each one in the frame of
// the moment it is heard, with `at` on the AudioContext clock — then sends the frame to the server, which turns it into
// OSC for the visual app (server/src/av.js). Nothing here reaches the sound: the meters are side branches, and the
// engine only calls back when a note starts or a held key is let go.
//
// Timers, not animation frames: requestAnimationFrame stops in a hidden or covered tab, setInterval keeps going (Chrome
// doesn't slow the timers of a tab that is playing sound).
import {
  AV_FPS, PPQ, avMap, channelSlugs, automationValuesAt, markerIndexAt, levelsOf, spectrumFeatures, createOnsetDetector, ticksPerBar, usedInserts,
  effectiveValuesAt, ggsTelemetry, MACRO_PARAMS
} from '@greanteadawy/core';

const MAP_EVERY = 2 * AV_FPS; // the map again every 2 s, for a visual app that starts after the studio
const LATENCY_EVERY = AV_FPS; // the output latency once a second
const FULL_EVERY = AV_FPS; // phase 2 values go out when they change, and all of them once a second
const r4 = (v) => Math.round(v * 10000) / 10000;

export class AvBridge {
  /** send(frame) → false when it could not be sent (the connection is down: the frame is dropped). */
  constructor({ engine, getState, send }) {
    this.engine = engine;
    this.getState = getState;
    this.send = send;
    this.timer = null;
    this.notes = []; // { channelId, key, vel, dur, at } waiting for their moment
    this.offs = []; // { channelId, key, rel, at, start }
    this.held = new Set(); // voices of keys held by hand (their end comes with noteOff)
  }

  get running() { return this.timer !== null; }

  idle() {
    const st = this.getState().avStatus;
    if (!st) return false;
    if (st.state === 'busy') return !this.engine.transport.playing; // (a tab that plays takes over: it must be heard)
    return (st.state === 'off' || st.state === 'admin') && !st.listeners;
  }

  start() {
    if (this.timer) return;
    const { engine } = this;
    this.analyser = engine.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    engine.out.connect(this.analyser);
    this.time = new Float32Array(this.analyser.fftSize);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.meter = new Float32Array(1024);
    this.onset = createOnsetDetector();
    this.frames = 0;
    this.lastMarker = null;
    this.mapKey = null;
    this.mapProject = null;
    this.session = null;
    this.lastDue = -Infinity; // the last frame's horizon: the notes sent so far started before it
    this.sentValues = new Map(); // phase 2: address → the value last sent (only changes go out, all once a second)
    this.watched = new Set(); // GGS channels whose voices report their modulation for us
    engine.noteTap = this;
    // (Chromium runs a 16.67 ms interval every 16 ms: 62.5 frames a second. A frame is due every 1/60 s on average.)
    this.nextAt = 0;
    this.timer = setInterval(() => {
      const t = performance.now();
      if (t < this.nextAt - 8) return;
      this.nextAt = t - this.nextAt < 50 ? this.nextAt + 1000 / AV_FPS : t + 1000 / AV_FPS;
      // nobody to hear it (no OSC for this tab and no listener, or another tab is heard while this one is stopped):
      // two frames a second keep it known, without sending 60 for nothing over a remote connection
      if (this.idle() && ++this.skipped < AV_FPS / 2) return;
      this.skipped = 0;
      this.tick();
    }, 1000 / AV_FPS);
    this.skipped = 0;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    const { engine } = this;
    if (engine.noteTap === this) engine.noteTap = null;
    engine.releaseChannelMeters();
    for (const id of this.watched) engine.watchGgs(id, false, 'av');
    this.watched.clear();
    try { engine.out.disconnect(this.analyser); } catch { /* ignore */ }
    // the visuals hear that the music stopped, and every note they were told about ends (keys still held too);
    // `final` frees the OSC port for another tab
    const st = this.getState();
    const slugs = this.slugs(st.project);
    const sent = (o) => o.start <= this.lastDue; // (notes not yet sent were never heard by the visuals)
    const offs = this.offs.filter(sent).map((o) => this.offOut(o, slugs));
    for (const voice of this.held) {
      if (sent(voice.avNote)) offs.push(this.offOut({ ...voice.avNote, rel: 0.5 }, slugs));
      voice.avNote = null;
    }
    this.send({ playing: 0, bpm: st.project?.bpm ?? 120, tick: 0, ppq: PPQ, offs: offs.filter(Boolean), final: true });
    this.notes = [];
    this.offs = [];
    this.held.clear();
  }

  // ---- the engine calls these (realtime only; offline renders have no tap)

  on(channelId, key, velocity, time, duration, voice) {
    this.followSession(this.engine.ctx.currentTime);
    this.notes.push({ channelId, key, vel: velocity, dur: duration ?? 0, at: time });
    if (duration != null) {
      voice.avOff = { channelId, key, rel: 0.5, at: time + duration, start: time };
      this.offs.push(voice.avOff);
    } else {
      voice.avNote = { channelId, key, start: time }; // held by hand: its end comes with noteOff
      this.held.add(voice);
    }
  }

  off(voice, releaseVelocity) {
    const n = voice.avNote;
    if (!n) return;
    voice.avNote = null;
    this.held.delete(voice);
    this.offs.push({ ...n, rel: releaseVelocity ?? 0.5, at: this.engine.ctx.currentTime });
  }

  /** The engine cut a note short (choke group, mono, polyphony): it ends then, not at its written end. */
  cut(voice, time) {
    if (voice.avOff && voice.avOff.at > time) voice.avOff.at = Math.max(voice.avOff.start, time);
    if (voice.avNote) {
      this.offs.push({ ...voice.avNote, rel: 0.5, at: Math.max(voice.avNote.start, time) });
      voice.avNote = null;
      this.held.delete(voice);
    }
  }

  /**
   * The transport stopped, or started again (a new play replaces its notes): the notes it had scheduled that were never
   * heard are dropped, and the ones sounding end now — the engine cut them all.
   */
  followSession(now) {
    const tr = this.engine.transport;
    const session = tr.playing ? tr.segments : null;
    if (session === this.session) return;
    if (this.session) {
      this.notes = this.notes.filter((n) => n.at <= now || n.dur === 0);
      this.offs = this.offs.filter((o) => o.start <= now);
      for (const o of this.offs) o.at = Math.min(o.at, now);
    }
    this.session = session;
  }

  slugs(project) {
    if (project !== this.slugProject) {
      this.slugProject = project;
      this.slugMap = project ? channelSlugs(project) : new Map();
    }
    return this.slugMap;
  }

  offOut(o, slugs) {
    const ch = slugs.get(o.channelId);
    return ch ? { ch, key: o.key, rel: r4(o.rel) } : null;
  }

  // ---- one frame

  tick() {
    const { engine } = this;
    const st = this.getState();
    const p = st.project;
    if (!p) return;
    const ctx = engine.ctx;
    const now = ctx.currentTime;
    const tr = engine.transport;
    const beat = tr.beatAt(now);
    const playing = beat !== null;
    const song = playing ? tr.mode === 'song' : true;
    const tick = playing ? Math.max(0, beat * PPQ) : st.songStart || 0;
    const slugs = this.slugs(p);
    const frame = { playing: playing ? 1 : 0, bpm: engine.bpm, tick: Math.floor(tick), ppq: PPQ, tpb: ticksPerBar(p), time: r4(now) };

    this.followSession(now);

    // notes at the frame nearest the moment they are heard (half a frame early at most)
    const due = now + 0.5 / AV_FPS;
    if (this.notes.length) {
      const out = [];
      this.notes = this.notes.filter((n) => {
        if (n.at > due) return true;
        const ch = slugs.get(n.channelId);
        if (ch) out.push({ ch, key: n.key, vel: r4(n.vel), dur: r4(n.dur), at: r4(n.at) });
        return false;
      });
      if (out.length) frame.notes = out;
    }
    if (this.offs.length) {
      const out = [];
      this.offs = this.offs.filter((o) => {
        // (an off goes out after its note: one that ends in the frame its note is sent waits for the next frame,
        // because a frame's offs go before its notes)
        if (o.at > due || o.start > this.lastDue) return true;
        const x = this.offOut(o, slugs);
        if (x) out.push(x);
        return false;
      });
      if (out.length) frame.offs = out;
    }
    this.lastDue = due;

    // the section the song is in: sent when it changes
    if (song) {
      const markers = [...(p.markers || [])].sort((a, b) => a.tick - b.tick);
      const i = markerIndexAt(markers, tick);
      const key = i < 0 ? null : `${i}:${markers[i].name}`;
      if (key !== this.lastMarker) {
        this.lastMarker = key;
        if (i >= 0) frame.marker = { name: markers[i].name, tick: markers[i].tick };
      }
    }

    // the sound
    this.analyser.getFloatTimeDomainData(this.time);
    this.analyser.getFloatFrequencyData(this.freq);
    const lv = levelsOf(this.time);
    const sp = spectrumFeatures(this.freq, ctx.sampleRate);
    frame.master = { peak: lv.peak, rms: lv.rms, bands: sp.bands, spectrum: sp.spectrum, centroid: sp.centroid, onset: this.onset(sp.linear, now) };
    const levels = engine.getLevels();
    if (p !== this.busProject) { this.busProject = p; this.busList = usedInserts(p); }
    frame.buses = {};
    for (const i of this.busList) if (i < levels.length) frame.buses[i] = r4(Math.min(1, levels[i]));
    frame.ch = {};
    for (const c of p.channels) {
      const slug = slugs.get(c.id);
      if (slug) frame.ch[slug] = r4(Math.min(1, engine.channelPeak(c.id, this.meter)));
    }

    // automation and the visual lanes, where the song is (the playlist's playhead when it isn't playing)
    const at = song ? Math.floor(tick) : st.songStart || 0;
    if (p !== this.autoProject || at !== this.autoAt) {
      this.autoProject = p;
      this.autoAt = at;
      this.autoValues = automationValuesAt(p, at);
    }
    frame.auto = this.autoValues.auto;
    frame.user = this.autoValues.user;

    if (this.frames % LATENCY_EVERY === 0) frame.latency = r4((ctx.outputLatency || 0) + (ctx.baseLatency || 0));
    // the map when the project's shape changes, and every 2 s for whoever starts listening later
    if (p !== this.mapProject) {
      this.mapProject = p;
      this.map = avMap(p);
      const key = JSON.stringify(this.map);
      if (key !== this.mapKey) { this.mapKey = key; this.frames = 0; }
    }
    if (this.frames % MAP_EVERY === 0) frame.map = this.map;
    this.phase2(frame, p, tick, playing && song, slugs);
    this.frames++;
    this.send(frame);
  }

  /**
   * Phase 2: every control as it stands (settings, or automation while the song plays) and the GGS Synth's live
   * modulation — only what changed since the last frame, and everything once a second (`full`).
   */
  phase2(frame, p, tick, automated, slugs) {
    const { engine } = this;
    const full = this.frames % FULL_EVERY === 0;
    const sent = this.sentValues;
    if (full) {
      frame.full = 1;
      sent.clear(); // (it fills again with what exists now: nothing of a deleted channel lingers)
    }
    const changed = (key, v) => {
      if (!full && sent.get(key) === v) return false;
      sent.set(key, v);
      return true;
    };
    // (settings only change with an edit: computed again when the project or, while automation plays, the tick does)
    const at = automated ? Math.floor(tick) : -1;
    if (p !== this.effProject || at !== this.effAt) {
      this.effProject = p;
      this.effAt = at;
      this.eff = effectiveValuesAt(p, at, { automated });
    }
    const { param, bus, fx } = this.eff;
    const pick = (prefix, values) => {
      let out = null;
      for (const k in values) if (changed(`${prefix}/${k}`, values[k])) (out ||= {})[k] = values[k];
      return out;
    };
    for (const slug in param) {
      const v = pick(`ch/${slug}`, param[slug]);
      if (v) (frame.param ||= {})[slug] = v;
    }
    for (const n in bus) {
      const v = pick(`bus/${n}`, bus[n]);
      if (v) (frame.busParam ||= {})[n] = v;
    }
    for (const n in fx) {
      for (const slug in fx[n]) {
        const v = pick(`fx/${n}/${slug}`, fx[n][slug]);
        if (v) ((frame.fx ||= {})[n] ||= {})[slug] = v;
      }
    }
    // the GGS Synth: its voices report while we watch (asking again every frame is free, and covers a new rig)
    const ggs = new Set();
    for (const c of p.channels) {
      if (c.instrument.kind !== 'ggs') continue;
      const slug = slugs.get(c.id);
      ggs.add(c.id);
      engine.watchGgs(c.id, true, 'av');
      this.watched.add(c.id);
      const t = ggsTelemetry(c.instrument.params, engine.ggsLive(c.id), { macros: MACRO_PARAMS.map((k) => param[slug]?.[k] ?? 0) });
      const out = {};
      const voices = engine.ggsVoices(c.id) ?? 0;
      if (changed(`ggs/${slug}/voices`, voices)) out.voices = voices;
      const src = pick(`ggs/${slug}/src`, t.src);
      if (src) out.src = src;
      for (const k in t.dst) {
        const [v, n] = t.dst[k];
        const a = changed(`ggs/${slug}/dst/${k}`, v);
        const b = changed(`ggs/${slug}/dst/${k}/n`, n);
        if (a || b) (out.dst ||= {})[k] = t.dst[k];
      }
      if (Object.keys(out).length) (frame.ggs ||= {})[slug] = out;
    }
    for (const id of this.watched) {
      if (ggs.has(id)) continue;
      engine.watchGgs(id, false, 'av');
      this.watched.delete(id);
    }
  }
}

// ---- the one bridge of this tab, switched by the "Send to visuals" setting

let bridge = null;

/** Turn the bridge on or off (needs the audio engine; on again later is fine). */
export function setAvBridge(on, { engine, getState, send }) {
  if (on && engine) {
    if (bridge && bridge.engine !== engine) { bridge.stop(); bridge = null; }
    bridge ??= new AvBridge({ engine, getState, send });
    bridge.start();
  } else if (bridge) {
    bridge.stop();
  }
}

export const avBridgeRunning = () => !!bridge?.running;
