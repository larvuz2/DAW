// The server end of the audio → visual bridge. The studio tab that plays measures the sound and sends a frame about
// 60 times a second over its WebSocket ({ type: 'av', frame }); here each frame becomes OSC messages over UDP to the
// visual app (TouchDesigner, Blender, Unreal…) at AV_OSC, and is passed on as JSON to the WebSocket clients of the same
// account that asked for it ({ type: 'subscribe-av' }). The addresses are in core/av.js and docs/av-bridge.md.
//
// One tab is heard at a time (claimAv): the one sending, until it has been quiet for a second — but a tab that plays
// takes over from one that is only stopped and listening. Only an admin's tab drives OSC: the port belongs to the
// computer the server runs on, so on a shared server other accounts' music doesn't reach its visuals (they still get
// WebSocket frames).
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { avFrameToOsc, encodeOsc } from '@ggs/core';

export const DEFAULT_AV_OSC = '127.0.0.1:7000';
export const OWNER_QUIET_MS = 1000;
export const MIN_FRAME_MS = 8; // at most ~120 frames a second per tab
export const MAX_FRAME_BYTES = 256 * 1024;
const RESOLVE_EVERY_MS = 60000; // a host name is looked up again once a minute (not once per message)

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

/**
 * Which tab is heard: `slot` ({ owner, at, playing }) keeps the one sending. A tab takes it when it is free, when its
 * owner has been quiet for a second, or when it plays and the owner doesn't. Returns whether `client` holds it now.
 */
export function claimAv(slot, client, frame, now) {
  const playing = !!frame?.playing;
  if (slot.owner !== client && slot.owner && now - slot.at < OWNER_QUIET_MS && !(playing && !slot.playing)) return false;
  slot.owner = client;
  slot.at = now;
  slot.playing = playing;
  return true;
}

export class AvBridge {
  /** target: { host, port } or null; createSocket and lookup for tests. */
  constructor({ target = null, createSocket = (type) => dgram.createSocket(type), lookup = dns.lookup } = {}) {
    this.target = target;
    this.createSocket = createSocket;
    this.lookup = lookup;
    this.socket = null;
    this.socketFamily = 0;
    this.slot = { owner: null, at: 0, playing: false }; // the tab whose frames go out over OSC
    this.address = target && net.isIP(target.host) ? { address: target.host, family: net.isIP(target.host) } : null;
    this.resolvedAt = 0;
    this.sent = 0; // OSC messages sent (status, tests)
  }

  get oscTarget() { return describeTarget(this.target); }

  /** A frame from a tab. Returns { osc: true } when it went out over OSC, { osc: false, reason } when not. */
  frame(client, user, frame, now = Date.now()) {
    if (!this.target) return { osc: false, reason: 'off' };
    if (user?.role !== 'admin') return { osc: false, reason: 'admin' };
    if (!claimAv(this.slot, client, frame, now)) return { osc: false, reason: 'busy' };
    this.sendOsc(avFrameToOsc(frame));
    if (frame?.final) this.slot.owner = null;
    return { osc: true };
  }

  /** The tab that drove OSC went away: tell the visuals the music stopped. */
  gone(client) {
    if (this.slot.owner !== client) return;
    this.slot.owner = null;
    if (this.target) this.sendOsc([['/gtd/transport/playing', { i: 0 }]]);
  }

  /** A host name is looked up once a minute in the background: dgram would ask DNS for every message. */
  resolve(now = Date.now()) {
    if (!this.target || net.isIP(this.target.host) || this.resolving || now - this.resolvedAt < RESOLVE_EVERY_MS) return;
    this.resolving = true;
    this.lookup(this.target.host, (err, address, family) => {
      this.resolving = false;
      this.resolvedAt = Date.now();
      if (!err && address) this.address = { address, family: family === 6 ? 6 : 4 };
    });
  }

  sendOsc(messages) {
    if (!this.target || !messages.length) return;
    this.resolve();
    if (!this.address) return; // still looking the host up: these frames are dropped, the next ones go
    if (!this.socket || this.socketFamily !== this.address.family) {
      this.close();
      this.socket = this.createSocket(this.address.family === 6 ? 'udp6' : 'udp4');
      this.socketFamily = this.address.family;
      // nothing listening is not an error worth a crash (or a log line 60 times a second)
      this.socket.on?.('error', () => {});
      this.socket.unref?.();
    }
    for (const [address, ...args] of messages) {
      try {
        this.socket.send(encodeOsc(address, args), this.target.port, this.address.address);
        this.sent++;
      } catch { /* a closed socket or a bad address: the next frame tries again */ }
    }
  }

  close() {
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
  }
}
