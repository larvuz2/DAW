// The chord grid in the studio: one grid per project (the engine lives in @greanteadawy/chord-grid, loaded when the
// Grid tab first opens), played through a channel of the song, looped on the audio clock, kept across reloads, and
// written to a pattern as notes.
import { PPQ, ticksPerBar, parsePitchClass, SCALES, scaleSpelling, uid, maxPatternLength } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { ensureEngine, getEngine } from '../audio/index.js';

let lib = null;
/** The engine's module (a separate chunk: 350 KB of harmony that most sessions never open). */
export function loadChordGrid() {
  return (lib ??= import('@greanteadawy/chord-grid'));
}

const STORE = 'gtd.chordGrid.';
const LOOKAHEAD = 0.14; // seconds of the loop scheduled ahead of the audio clock
const TICK_MS = 30;

/** The grid's key for a project: { root, scale, exact, spell } — `exact` false when the grid has no such scale. */
export function gridKeyFor(mod, project) {
  const root = parsePitchClass(project.key || 'C') ?? 0;
  const { id, exact } = mod.gridScaleFor(SCALES[project.scale] || SCALES.major);
  return { root, scale: id, exact, spell: scaleSpelling(project.key || 'C', project.scale) };
}

/** The track as notes of a pattern: { notes: [{ id, key, start, length, velocity }], end (ticks) }. */
export function trackNotes(mod, grid, project) {
  const bar = ticksPerBar(project);
  const made = grid.notes();
  const notes = mod.notesInTicks(made, { barTicks: bar, beatTicks: PPQ }).map(({ card: _card, ...n }) => ({ id: uid('n'), ...n }));
  return { notes, end: Math.round(grid.view().progression.endBars * bar), loop: made.loopBars * bar };
}

/**
 * Plays what the grid sounds on a channel: a strummed chord arrives as notes that are each a few milliseconds late,
 * and a chord let go early takes its late notes with it.
 */
function createPlayer(channelId) {
  const held = new Map(); // pitch → { voice, timer }
  let channel = channelId();
  const stop = (pitch) => {
    const h = held.get(pitch);
    if (!h) return;
    clearTimeout(h.timer);
    if (h.voice) getEngine()?.noteOff(h.voice);
    held.delete(pitch);
  };
  const start = (h, pitch, velocity) => {
    if (held.get(pitch) !== h) return; // let go before it sounded
    const engine = getEngine();
    if (engine && channel) h.voice = engine.noteOn(channel, pitch, velocity / 127);
  };
  return {
    hear(events) {
      const now = channelId();
      if (now !== channel) { for (const p of [...held.keys()]) stop(p); channel = now; }
      const engine = getEngine();
      const ready = engine && engine.ctx.state === 'running' ? null : useStore.getState().unlockAudio().catch(() => ensureEngine());
      for (const n of events) {
        stop(n.pitch);
        if (!n.on) continue;
        const h = { voice: null, timer: null };
        held.set(n.pitch, h);
        const go = () => (ready ? ready.then(() => start(h, n.pitch, n.velocity)) : start(h, n.pitch, n.velocity));
        if (n.delay > 1) h.timer = setTimeout(go, n.delay);
        else go();
      }
    },
    silence() { for (const p of [...held.keys()]) stop(p); }
  };
}

const sessions = new Map();

/**
 * The grid of a project (made on first use, restored from this browser's storage): { grid, key, press, release,
 * playCard, play, stop, playing, position, write, subscribe, setChannel }.
 */
export function gridSession(mod, project) {
  let s = sessions.get(project.id);
  if (!s) {
    s = createSession(mod, project);
    sessions.set(project.id, s);
  }
  s.follow(project);
  return s;
}

function createSession(mod, first) {
  let project = first;
  let channelId = null;
  const player = createPlayer(() => channelId);
  const grid = mod.createChordGrid({ ...gridKeyFor(mod, project), bpm: project.bpm, seed: project.id, onNotes: (events) => player.hear(events) });
  const listeners = new Set();
  const tell = () => { for (const fn of [...listeners]) fn(); };
  let key = gridKeyFor(mod, project);

  // ---- kept across reloads (this browser): the engine's own save, a moment after the last change
  let saveTimer = null;
  const save = () => { try { localStorage.setItem(STORE + project.id, grid.save()); } catch { /* storage full or off: the grid still works */ } };
  let restored = false;
  try { const saved = localStorage.getItem(STORE + project.id); restored = !!saved && grid.load(saved); } catch { /* unreadable: start empty */ }
  // a first visit shows what the grid is for: after a chord, where it could go lights up
  if (!restored) grid.set({ smart: 'function' });
  grid.setKey(key);
  grid.subscribe(() => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); });

  // ---- the loop: the track's notes scheduled a little ahead of the audio clock, again and again
  const loop = { on: false, withSong: false, timer: null, t0: 0, until: 0, voices: [], version: -1, notes: [], seconds: 0, perTick: 0, unsub: null };
  const refresh = () => {
    const bar = ticksPerBar(project);
    const made = grid.notes();
    loop.perTick = 60 / (project.bpm * PPQ);
    loop.seconds = made.loopBars * bar * loop.perTick;
    loop.bars = made.loopBars;
    loop.notes = mod.notesInTicks(made, { barTicks: bar, beatTicks: PPQ }).map((n) => ({ ...n, at: n.start * loop.perTick, len: n.length * loop.perTick }));
    loop.version = grid.view().version;
  };
  const schedule = () => {
    const engine = getEngine();
    if (!engine || !loop.on) return;
    if (loop.version !== grid.view().version) refresh();
    if (!(loop.seconds > 0)) return;
    const horizon = engine.ctx.currentTime + LOOKAHEAD;
    // (notes that ended are forgotten: only what still sounds is cut when the loop stops)
    loop.voices = loop.voices.filter((v) => v.end > engine.ctx.currentTime);
    while (loop.until < horizon) {
      const pass = Math.floor((loop.until - loop.t0) / loop.seconds + 1e-9);
      const base = loop.t0 + pass * loop.seconds;
      const to = Math.min(horizon, base + loop.seconds);
      for (const n of loop.notes) {
        const t = base + n.at;
        if (t < loop.until - 1e-9 || t >= to - 1e-9) continue;
        const voice = channelId ? engine.triggerNote(channelId, n.key, n.velocity, t, Math.max(0.03, n.len - 0.01), { force: true }) : null;
        if (voice) loop.voices.push({ voice, end: t + n.len });
      }
      loop.until = to;
    }
  };
  const stopLoop = (withSong = loop.withSong) => {
    if (!loop.on) return;
    loop.on = false;
    clearInterval(loop.timer);
    loop.unsub?.();
    loop.unsub = null;
    const engine = getEngine();
    if (engine) for (const v of loop.voices) engine.cutVoice(v.voice, engine.ctx.currentTime);
    loop.voices = [];
    if (withSong && useStore.getState().playing) useStore.getState().stop();
    tell();
  };

  const session = {
    grid,
    get key() { return key; },
    get playing() { return loop.on; },
    get withSong() { return loop.withSong; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The project moved (key, scale, tempo): the grid follows; cards are re-keyed by the engine. */
    follow(next) {
      const moved = next.key !== project.key || next.scale !== project.scale;
      const tempo = next.bpm !== project.bpm || ticksPerBar(next) !== ticksPerBar(project);
      project = next;
      if (moved) { key = gridKeyFor(mod, project); grid.setKey(key); }
      if (tempo) {
        grid.setTempo(project.bpm);
        // a loop that is playing starts again at the new tempo (its clock was the old one)
        if (loop.on) { const ws = loop.withSong; stopLoop(false); session.play({ withSong: ws && useStore.getState().playing }); }
      }
    },
    setChannel(id) {
      if (id === channelId) return;
      player.silence();
      grid.release();
      channelId = id;
    },
    press(cell, velocity = 100) { return grid.press(cell, velocity); },
    release() { grid.release(); },
    silence() { player.silence(); },
    /**
     * Loop the track. withSong: the song's own playback starts at the same instant (the pattern or the song, as the
     * transport is set), so the chords are heard against the beat; stopping either stops both.
     */
    async play({ withSong = false } = {}) {
      const st = useStore.getState();
      const engine = await st.unlockAudio().catch(() => ensureEngine());
      if (loop.on) stopLoop(false);
      grid.release();
      player.silence();
      refresh();
      if (!loop.notes.length) return false;
      const at = engine.ctx.currentTime + (withSong ? 0.2 : 0.06);
      loop.on = true;
      loop.withSong = withSong;
      loop.t0 = at;
      loop.until = at;
      if (withSong) {
        await st.play({ at });
        // (the song may have had to wait — for plugins to load, say: the loop starts where the transport really did)
        const tr = getEngine()?.transport;
        if (useStore.getState().playing && tr?.anchor) { loop.t0 = tr.anchor.time; loop.until = tr.anchor.time; } else loop.withSong = false;
        // the transport stopped by the user (or by its own end) takes the loop with it — it has cut every voice
        if (loop.withSong) loop.unsub = useStore.subscribe((s2, prev) => { if (prev.playing && !s2.playing && loop.on) stopLoop(false); });
      }
      schedule();
      loop.timer = setInterval(schedule, TICK_MS);
      tell();
      return true;
    },
    stop() { stopLoop(); },
    /** Where the loop is, in bars from its start (null when it is not playing). */
    position() {
      const engine = getEngine();
      if (!loop.on || !engine || !(loop.seconds > 0)) return null;
      const t = engine.ctx.currentTime - loop.t0;
      return t < 0 ? 0 : ((t % loop.seconds) / loop.seconds) * loop.bars;
    },
    /**
     * Write the track into a pattern on a channel (one undo step): its notes replace what the channel had under the
     * track, the rest of the pattern stays, and the pattern grows to hold it. Answers a sentence, or throws one.
     */
    write(pattern, channel) {
      const st = useStore.getState();
      const { notes, end } = trackNotes(mod, grid, project);
      if (!notes.length) throw new Error('The track is empty: play chords with Capture on, or drag them to the track');
      if (end > maxPatternLength(project)) throw new Error('The track is longer than a pattern can be: shorten it');
      const bar = ticksPerBar(project);
      const ops = [];
      if (end > pattern.length) ops.push({ type: 'pattern/update', id: pattern.id, patch: { length: Math.ceil(end / bar) * bar } });
      ops.push({ type: 'notes/set', patternId: pattern.id, channelId: channel.id, notes: [...(pattern.notes[channel.id] || []).filter((n) => n.start >= end), ...notes] });
      st.dispatch(ops);
      return `${grid.view().progression.cards.map((c) => c.name).join(' – ')} written to ${channel.name} in ${pattern.name}`;
    },
    /** Forget this session (the project was closed for good): stop everything. */
    dispose() {
      stopLoop();
      player.silence();
      clearTimeout(saveTimer);
      save();
    }
  };
  return session;
}

/** For tests and hot reloads: drop every session. */
export function resetGridSessions() {
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
}
