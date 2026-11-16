// Minimal Standard MIDI File (SMF) writer and reader.
import { PPQ } from './constants.js';
import { INSTRUMENTS } from './instruments.js';
import { allSongNotes } from './timeline.js';
import { EXPRESSION_DIMS, curveValueAt, flattenCurve, sanitizeCurve, simplifyCurve } from './expression.js';
import { MPE_BEND_RANGE, MASTER_BEND_RANGE } from './mpe.js';

const MPE_STEP = 6; // ticks between controller events while a curve moves (a 64th note)

/** Pitch bend bytes for semitones at a ±range. */
function bendBytes(ch, semis, range = MPE_BEND_RANGE) {
  const v = Math.max(0, Math.min(16383, Math.round(8192 + (semis / range) * 8192)));
  return [0xe0 | ch, v & 127, (v >> 7) & 127];
}

/**
 * One channel's notes as an MPE track (lower zone): every note on a member channel of its own (2–16), with its
 * pitch curve as pitch bend (±48), pressure as channel pressure and timbre as CC 74 — what MPE instruments and DAWs
 * read back as per-note expression. Note-off velocity carries the release velocity.
 */
function mpeEvents(list, pitchOffset) {
  const events = [
    // MPE Configuration Message: lower zone, 15 member channels
    { tick: 0, order: 0, bytes: [0xb0, 101, 0] }, { tick: 0, order: 0.01, bytes: [0xb0, 100, 6] }, { tick: 0, order: 0.02, bytes: [0xb0, 6, 15] }
  ];
  for (let ch = 1; ch < 16; ch++) {
    // pitch bend sensitivity of every member channel
    events.push({ tick: 0, order: 0.1, bytes: [0xb0 | ch, 101, 0] }, { tick: 0, order: 0.11, bytes: [0xb0 | ch, 100, 0] }, { tick: 0, order: 0.12, bytes: [0xb0 | ch, 6, MPE_BEND_RANGE] });
  }
  const free = new Array(16).fill(0);
  let last = 0;
  const encode = { pitch: (ch, v) => bendBytes(ch, v), pressure: (ch, v) => [0xd0 | ch, Math.round(v * 127)], timbre: (ch, v) => [0xb0 | ch, 74, Math.round(v * 127)] };
  for (const n of [...list].sort((a, b) => a.start - b.start || a.key - b.key)) {
    // the next member channel that is free (round robin, so a released note's tail isn't bent by the next one);
    // when all 15 are busy, the one that frees first
    let ch = 0;
    for (let k = 1; k <= 15; k++) {
      const c = ((last + k - 1) % 15) + 1;
      if (free[c] <= n.start) { ch = c; break; }
    }
    if (!ch) ch = free.slice(1).reduce((best, t, i) => (t < free[best] ? i + 1 : best), 1);
    last = ch;
    const end = n.start + n.length;
    free[ch] = end;
    const span = n.fullLength ?? n.length; // a note cut by a clip end still plays its curves at their own pace
    const key = Math.max(0, Math.min(127, n.key + pitchOffset));
    for (const dim of EXPRESSION_DIMS) {
      const curve = n.expression?.[dim];
      // the starting value before the note-on (how MPE controllers send it), then every change while it sounds
      events.push({ tick: n.start, order: 1.5, bytes: encode[dim](ch, curve ? curveValueAt(curve, 0) : 0) });
      if (!curve) continue;
      const ticks = new Set(flattenCurve(curve).map((pt) => Math.round(n.start + pt.t * span)));
      for (let t = n.start + MPE_STEP; t < end; t += MPE_STEP) ticks.add(t);
      let prev = encode[dim](ch, curveValueAt(curve, 0)).join();
      for (const t of [...ticks].filter((x) => x > n.start && x < end).sort((a, b) => a - b)) {
        const bytes = encode[dim](ch, curveValueAt(curve, (t - n.start) / span));
        if (bytes.join() !== prev) { events.push({ tick: t, order: 3, bytes }); prev = bytes.join(); }
      }
    }
    events.push({ tick: n.start, order: 2, bytes: [0x90 | ch, key, Math.max(1, Math.min(127, Math.round(n.velocity * 127)))] });
    events.push({ tick: end, order: 1, bytes: [0x80 | ch, key, n.releaseVelocity === undefined ? 64 : Math.max(1, Math.round(n.releaseVelocity * 127))] });
  }
  return events;
}

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function strBytes(s) {
  return Array.from(new TextEncoder().encode(s));
}

function chunk(type, data) {
  const len = data.length;
  return [...strBytes(type), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

function trackChunk(events) {
  // events: [{ tick, bytes, order }]
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00);
  return chunk('MTrk', data);
}

/**
 * Export a project to a type-1 MIDI file.
 * mode 'song' renders the playlist; mode 'pattern' renders a single pattern.
 * mpe (default true): a channel whose notes carry expression curves is written as an MPE track (one note per MIDI
 * channel with its own pitch bend, pressure and CC 74); false writes plain notes only.
 */
export function projectToMidi(project, { mode = 'song', patternId, mpe = true } = {}) {
  let notes;
  if (mode === 'pattern' || !project.playlist.clips.some((c) => c.kind === 'pattern')) {
    const p = project.patterns.find((x) => x.id === patternId) || project.patterns[0];
    notes = [];
    for (const [channelId, list] of Object.entries(p?.notes || {})) for (const n of list) notes.push({ ...n, channelId });
  } else {
    notes = allSongNotes(project);
  }
  const tempo = Math.round(60000000 / project.bpm);
  const [num, den] = project.timeSig;
  const meta = [
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(strBytes(project.name).length), ...strBytes(project.name)] },
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] }
  ];
  const tracks = [trackChunk(meta)];
  let melodicChan = 0;
  for (const c of project.channels) {
    const list = notes.filter((n) => n.channelId === c.id);
    if (!list.length) continue;
    const def = INSTRUMENTS[c.instrument.kind];
    const isDrum = !def.melodic && def.gm;
    let ch;
    if (isDrum) ch = 9;
    else {
      ch = melodicChan % 16;
      if (ch === 9) ch = ++melodicChan % 16;
      melodicChan++;
    }
    const events = [{ tick: 0, order: -1, bytes: [0xff, 0x03, ...vlq(strBytes(c.name).length), ...strBytes(c.name)] }];
    if (mpe && !isDrum && list.some((n) => n.expression)) {
      events.push(...mpeEvents(list, Math.round(c.pitch || 0)));
      tracks.push(trackChunk(events));
      continue;
    }
    for (const n of list) {
      let key = isDrum ? def.gm + (n.key - 60) : n.key + Math.round(c.pitch || 0);
      key = Math.max(0, Math.min(127, key));
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      events.push({ tick: n.start, order: 2, bytes: [0x90 | ch, key, vel] });
      events.push({ tick: n.start + n.length, order: 1, bytes: [0x80 | ch, key, 0] });
    }
    tracks.push(trackChunk(events));
  }
  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

/**
 * Parse a MIDI file into tracks of notes (ticks converted to PPQ 96). Per-channel pitch bend, channel pressure and
 * CC 74 that move while a note sounds become that note's expression curves (MPE files: one note per channel; a
 * plain file's pitch wheel bends every note on its channel the same way).
 */
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  const read32 = () => { const v = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]; pos += 4; return v >>> 0; };
  const read16 = () => { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; };
  const readStr = (len) => { const s = new TextDecoder().decode(bytes.slice(pos, pos + len)); pos += len; return s; };
  const readVlq = () => { let v = 0; let b; do { b = bytes[pos++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && pos < bytes.length); return v; };

  if (readStr(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = read32();
  const format = read16();
  const ntracks = read16();
  const division = read16();
  pos += hlen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const scale = PPQ / division;
  let bpm = null;
  let timeSig = null;
  const tracks = [];
  for (let t = 0; t < ntracks && pos < bytes.length; t++) {
    const type = readStr(4);
    const len = read32();
    const end = pos + len;
    if (type !== 'MTrk') { pos = end; continue; }
    let tick = 0;
    let status = 0;
    let name = '';
    const open = new Map();
    const notes = [];
    let program = null;
    let channel = null;
    // per MIDI channel: the controller values now, and what moved while notes were held (→ per-note expression)
    const ctl = Array.from({ length: 16 }, () => ({ pitch: 0, pressure: 0, timbre: 0, log: [], range: null, rpn: [127, 127] }));
    let zone = false; // an MPE Configuration Message was seen
    const moved = (ch, dim, v) => { ctl[ch][dim] = v; ctl[ch].log.push({ tick, dim, v }); };
    const curvesOf = (ch, on, endTick) => {
      const range = ctl[ch].range ?? (zone && ch > 0 ? MPE_BEND_RANGE : MASTER_BEND_RANGE);
      const span = Math.max(1, endTick - on.start);
      const out = {};
      for (const dim of EXPRESSION_DIMS) {
        const scale = dim === 'pitch' ? range : 1;
        const pts = [{ t: 0, v: on.ctl[dim] * scale }];
        for (const e of ctl[ch].log) if (e.dim === dim && e.tick > on.start && e.tick <= endTick) pts.push({ t: (e.tick - on.start) / span, v: e.v * scale });
        if (pts.every((pt) => pt.v === 0)) continue;
        // controller steps are a staircase of the gesture: keep its shape, drop the stairs
        const curve = sanitizeCurve(dim, simplifyCurve(pts, dim === 'pitch' ? 0.02 : 0.012));
        if (curve) out[dim] = curve;
      }
      return Object.keys(out).length ? out : null;
    };
    while (pos < end) {
      tick += readVlq();
      const b = bytes[pos];
      if (b & 0x80) { status = b; pos++; } else if (!status) { pos++; continue; }
      const hi = status & 0xf0;
      if (status === 0xff) {
        const mtype = bytes[pos++];
        const mlen = readVlq();
        if (mtype === 0x03 && !name) name = new TextDecoder().decode(bytes.slice(pos, pos + mlen));
        if (mtype === 0x51 && bpm === null) bpm = Math.round(60000000 / ((bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2]) * 100) / 100;
        if (mtype === 0x58 && !timeSig) timeSig = [bytes[pos], Math.pow(2, bytes[pos + 1])];
        pos += mlen;
        status = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVlq();
        status = 0;
      } else if (hi === 0x90 || hi === 0x80) {
        const key = bytes[pos++];
        const vel = bytes[pos++];
        const ch = status & 0x0f;
        channel = channel ?? ch;
        const k = `${ch}:${key}`;
        if (hi === 0x90 && vel > 0) {
          if (!open.has(k)) open.set(k, []);
          open.get(k).push({ start: tick, vel, ctl: { pitch: ctl[ch].pitch, pressure: ctl[ch].pressure, timbre: ctl[ch].timbre } });
        } else {
          const stack = open.get(k);
          const on = stack?.shift();
          if (on) {
            const note = { key, start: Math.round(on.start * scale), length: Math.max(1, Math.round((tick - on.start) * scale)), velocity: Math.round((on.vel / 127) * 100) / 100, channel: ch };
            const expression = curvesOf(ch, on, tick);
            if (expression) note.expression = expression;
            // 64 (and the 0 of a running-status note-off) mean "nothing said about the release"
            if (hi === 0x80 && vel > 0 && vel !== 64) note.releaseVelocity = Math.round((vel / 127) * 100) / 100;
            notes.push(note);
          }
        }
      } else if (hi === 0xc0) {
        program = bytes[pos++];
      } else if (hi === 0xd0) {
        moved(status & 0x0f, 'pressure', bytes[pos++] / 127);
      } else if (hi === 0xe0) {
        const v = (((bytes[pos + 1] << 7) | bytes[pos]) - 8192) / 8192;
        pos += 2;
        moved(status & 0x0f, 'pitch', v);
      } else if (hi === 0xb0) {
        const ch = status & 0x0f;
        const cc = bytes[pos++];
        const v = bytes[pos++];
        if (cc === 74) moved(ch, 'timbre', v / 127);
        else if (cc === 101) ctl[ch].rpn[0] = v;
        else if (cc === 100) ctl[ch].rpn[1] = v;
        else if (cc === 6 && ctl[ch].rpn[0] === 0 && ctl[ch].rpn[1] === 0) ctl[ch].range = Math.max(1, Math.min(96, v));
        else if (cc === 6 && ctl[ch].rpn[0] === 0 && ctl[ch].rpn[1] === 6 && ch === 0) zone = v > 0;
      } else {
        pos += 2; // 0xA0 (poly pressure)
      }
    }
    pos = end;
    if (notes.length) {
      notes.sort((a, b) => a.start - b.start || a.key - b.key);
      tracks.push({ name: name || `Track ${tracks.length + 1}`, notes, program, channel, isDrum: channel === 9 && !zone, mpe: zone });
    }
  }
  return { format, bpm, timeSig, tracks };
}
