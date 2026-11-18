// Web MIDI input: play (and record) the selected channel from a hardware MIDI keyboard — including MPE controllers,
// whose per-note pitch bend, pressure and slide reach each note on its own (see core/mpe.js for what is decoded).
import { createMpeDecoder } from '@ggs/core';
import { useStore } from '../state/store.js';

let access = null;
const decoder = createMpeDecoder();
const held = new Map(); // decoder note id → { key, channel } it was started on

function onMessage(e) {
  const st = useStore.getState();
  for (const ev of decoder.message(e.data)) {
    if (ev.type === 'on') {
      const ch = st.selectedChannelId;
      if (!ch) continue;
      held.set(ev.id, { key: ev.key, channel: ch });
      st.liveNoteOn(ev.key, ev.velocity, ch, { pitch: ev.pitch, pressure: ev.pressure, timbre: ev.timbre }, ev.id);
    } else {
      const h = held.get(ev.id);
      if (!h) continue;
      if (ev.type === 'off') {
        held.delete(ev.id);
        st.liveNoteOff(h.key, h.channel, ev.releaseVelocity, ev.id);
      } else {
        st.liveNoteExpression(h.key, ev.dim, ev.value, h.channel, ev.id);
      }
    }
  }
}

function bindInputs() {
  const names = [];
  for (const input of access.inputs.values()) {
    input.onmidimessage = onMessage;
    names.push(input.name);
  }
  useStore.setState({ midiStatus: names.length ? `MIDI: ${names.join(', ')}` : 'MIDI enabled (no devices)' });
}

export async function connectMidi() {
  const st = useStore.getState();
  if (!navigator.requestMIDIAccess) {
    st.toast('Web MIDI is not supported in this browser (try Chrome or Edge)', 'warn');
    return;
  }
  try {
    st.unlockAudio();
    access = await navigator.requestMIDIAccess();
    access.onstatechange = bindInputs;
    bindInputs();
    st.toast(useStore.getState().midiStatus, 'success');
  } catch (e) {
    st.toast(`MIDI access denied: ${e.message}`, 'error');
  }
}

/** Feed raw MIDI bytes as if a controller had sent them (tests, on-screen controllers). */
export function injectMidi(bytes) {
  onMessage({ data: bytes });
}
