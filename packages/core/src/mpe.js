// MIDI Polyphonic Expression input: turns the messages of an MPE controller (one note per MIDI channel, each with
// its own pitch bend, pressure and slide) — or of an ordinary keyboard — into note events with per-note expression.
// Pure state machine: feed it message bytes, get events back. The studio plays them live and records them as the
// expression curves of core/expression.js.
//
// Conventions decoded here:
//   pitch bend (per channel)        → the pitch of the notes on that channel, in semitones
//   channel pressure / poly pressure → pressure, 0..1
//   CC 74                            → timbre ("slide"), 0..1;  CC 1 (mod wheel) does the same on ordinary keyboards
//   note-off velocity                → release velocity, 0..1
// Channel 1 is the MPE master channel: its bend, pressure and CC 74 apply to every sounding note. Bend ranges
// follow RPN 0 when the controller sends it; otherwise ±48 semitones on member channels (the MPE default) and ±2
// on channel 1 (what an ordinary keyboard on channel 1 expects).

export const MPE_BEND_RANGE = 48;
export const MASTER_BEND_RANGE = 2;

export function createMpeDecoder({ bendRange = MPE_BEND_RANGE, masterBendRange = MASTER_BEND_RANGE } = {}) {
  const chan = Array.from({ length: 16 }, (_, i) => ({ bend: 0, pressure: 0, timbre: 0, range: i === 0 ? masterBendRange : bendRange, rpnMsb: 127, rpnLsb: 127 }));
  const notes = new Map(); // id → { channel, key, poly }
  const master = chan[0];

  const pitchOf = (n) => (n.channel === 0 ? master.bend : chan[n.channel].bend + master.bend);
  const pressureOf = (n) => Math.max(n.poly, chan[n.channel].pressure, master.pressure);
  const timbreOf = (n) => (n.channel === 0 ? master.timbre : Math.max(chan[n.channel].timbre, master.timbre));
  /** Expression events for every note a channel's controls reach (all notes for the master channel). */
  const changed = (channel, dim, valueOf) => {
    const out = [];
    for (const [id, n] of notes) if (channel === 0 || n.channel === channel) out.push({ type: 'expr', id, key: n.key, dim, value: valueOf(n) });
    return out;
  };

  return {
    /** Decode one MIDI message (status byte first). Returns the resulting events (possibly none). */
    message(bytes) {
      const status = bytes[0] ?? 0;
      const cmd = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = bytes[1] ?? 0;
      const d2 = bytes[2] ?? 0;
      const c = chan[ch];
      if (cmd === 0x90 && d2 > 0) {
        const id = `${ch}:${d1}`;
        const n = { channel: ch, key: d1, poly: 0 };
        notes.set(id, n);
        // an MPE controller sends a note's bend, pressure and slide BEFORE its note-on: the note starts with them
        return [{ type: 'on', id, channel: ch, key: d1, velocity: d2 / 127, pitch: pitchOf(n), pressure: pressureOf(n), timbre: timbreOf(n) }];
      }
      if (cmd === 0x80 || cmd === 0x90) {
        const id = `${ch}:${d1}`;
        if (!notes.delete(id)) return [];
        return [{ type: 'off', id, channel: ch, key: d1, releaseVelocity: cmd === 0x80 ? d2 / 127 : 0.5 }];
      }
      if (cmd === 0xe0) {
        c.bend = (((d2 << 7) | d1) - 8192) / 8192 * c.range;
        return changed(ch, 'pitch', pitchOf);
      }
      if (cmd === 0xd0) {
        c.pressure = d1 / 127;
        return changed(ch, 'pressure', pressureOf);
      }
      if (cmd === 0xa0) {
        const id = `${ch}:${d1}`;
        const n = notes.get(id);
        if (!n) return [];
        n.poly = d2 / 127;
        return [{ type: 'expr', id, key: n.key, dim: 'pressure', value: pressureOf(n) }];
      }
      if (cmd === 0xb0) {
        if (d1 === 74 || d1 === 1) {
          c.timbre = d2 / 127;
          return changed(ch, 'timbre', timbreOf);
        }
        if (d1 === 101) c.rpnMsb = d2;
        else if (d1 === 100) c.rpnLsb = d2;
        else if (d1 === 6 && c.rpnMsb === 0 && c.rpnLsb === 0) {
          // RPN 0 = pitch bend sensitivity in semitones
          c.range = Math.max(1, Math.min(96, d2));
        } else if (d1 === 123 || d1 === 120) {
          // all notes off / all sound off
          const out = [...notes].filter(([, n]) => ch === 0 || n.channel === ch).map(([id, n]) => ({ type: 'off', id, channel: n.channel, key: n.key, releaseVelocity: 0.5 }));
          for (const e of out) notes.delete(e.id);
          return out;
        }
      }
      return [];
    },
    /** Notes currently held: [{ id, channel, key }]. */
    held: () => [...notes].map(([id, n]) => ({ id, channel: n.channel, key: n.key })),
    reset() {
      notes.clear();
      for (const c of chan) { c.bend = 0; c.pressure = 0; c.timbre = 0; }
    }
  };
}
