// The server end of the audio → visual bridge. The studio tab that plays measures the sound and sends a frame about
// 60 times a second over its WebSocket ({ type: 'av', frame }); here each frame becomes OSC messages over UDP to the
// visual app (TouchDesigner, Blender, Unreal…) at AV_OSC, and is passed on as JSON to the WebSocket clients of the same
// account that asked for it ({ type: 'subscribe-av' }). The addresses are in core/av.js and docs/av-bridge.md.
//
// One tab drives the OSC port at a time — the first one that sends, until it has been quiet for a second — so two
// open studios never interleave their frames. Only an admin's tab drives OSC: the port belongs to the computer the
// server runs on, so on a shared server other accounts' music doesn't reach its visuals (they still get WebSocket frames).
import dgram from 'node:dgram';
import { avFrameToOsc, encodeOsc } from '@greanteadawy/core';

export const DEFAULT_AV_OSC = '127.0.0.1:7000';
const OWNER_QUIET_MS = 1000;
const MIN_FRAME_MS = 8; // at most ~120 frames a second per tab
const MAX_FRAME_BYTES = 256 * 1024;

/**
 * AV_OSC: "host:port" ("[::1]:7000" for IPv6), "off", or empty for the default — 127.0.0.1:7000 when the server only
 * listens on this computer, off otherwise (in Docker or on a server, say where the visual app is).
 * Returns { host, port } or null (off). Throws on a value that is neither.
 */
export function parseAvTarget(value, { loopback = true } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return loopback ? parseAvTarget(DEFAULT_AV_OSC) : null;
  if (/^(off|false|0|no|none)$/i.test(v)) return null;
  const m = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+)):(\d{1,5})$/i.exec(v);
  const port = m ? Number(m[3]) : 0;
  if (!m || port < 1 || port > 65535) throw new Error(`AV_OSC must be host:port (e.g. 127.0.0.1:7000) or "off", not "${v}"`);
  return { host: m[1] || m[2], port };
}

export const describeTarget = (t) => (t ? (t.host.includes(':') ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`) : null);

export class AvBridge {
  /** target: { host, port } or null; createSocket for tests. */
  constructor({ target = null, createSocket = (type) => dgram.createSocket(type) } = {}) {
    this.target = target;
    this.createSocket = createSocket;
    this.socket = null;
    this.owner = null; // the hub client whose frames go out over OSC
    this.ownerAt = 0;
    this.sent = 0; // OSC messages sent (status, tests)
  }

  get oscTarget() { return describeTarget(this.target); }

  /** A frame from a tab. Returns { osc: true } when it went out over OSC, { osc: false, reason } when not. */
  frame(client, user, frame, now = Date.now()) {
    if (!this.target) return { osc: false, reason: 'off' };
    if (user?.role !== 'admin') return { osc: false, reason: 'admin' };
    if (this.owner && this.owner !== client && now - this.ownerAt < OWNER_QUIET_MS) return { osc: false, reason: 'busy' };
    if (this.owner === client && now - this.ownerAt < MIN_FRAME_MS && !frame?.final) return { osc: false, reason: 'rate' };
    this.owner = client;
    this.ownerAt = now;
    this.sendOsc(avFrameToOsc(frame));
    if (frame?.final) this.owner = null;
    return { osc: true };
  }

  /** The tab that drove OSC went away: tell the visuals the music stopped. */
  gone(client) {
    if (this.owner !== client) return;
    this.owner = null;
    if (this.target) this.sendOsc([['/gtd/transport/playing', { i: 0 }]]);
  }

  sendOsc(messages) {
    if (!this.target || !messages.length) return;
    if (!this.socket) {
      this.socket = this.createSocket(this.target.host.includes(':') ? 'udp6' : 'udp4');
      // nothing listening is not an error worth a crash (or a log line 60 times a second)
      this.socket.on?.('error', () => {});
      this.socket.unref?.();
    }
    for (const [address, ...args] of messages) {
      try {
        this.socket.send(encodeOsc(address, args), this.target.port, this.target.host);
        this.sent++;
      } catch { /* a closed socket or a bad address: the next frame tries again */ }
    }
  }

  close() {
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
  }
}

export { MAX_FRAME_BYTES };
