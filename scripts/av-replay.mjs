// Play a capture of the audio → visual bridge to an OSC port with its original timing, so a visual setup
// (TouchDesigner, Blender, Unreal…) can be built and tested without the studio running:
//
//   npm run av:replay                                   fixtures/av/osc-capture.jsonl.gz → 127.0.0.1:7000
//   npm run av:replay -- --to 192.168.1.20:9000 --loop
//   npm run av:replay -- some-capture.jsonl.gz --speed 0.5
//
// A capture is gzipped JSON lines: a header { format: "gtd-av-capture", … }, then one line per OSC message:
// [ms since the start, address, types, ...values] — e.g. [1016.7, "/gtd/ch/kick/note", "ifff", 45, 0.9, 0.12, 2.51].
import fs from 'node:fs';
import zlib from 'node:zlib';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeOsc } from '../packages/core/src/av.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const loop = args.includes('--loop') && args.splice(args.indexOf('--loop'), 1);
const to = flag('--to') || '127.0.0.1:7000';
const speed = Number(flag('--speed') || 1);
const file = args[0] || path.join(ROOT, 'fixtures/av/osc-capture.jsonl.gz');
const m = /^(.+):(\d+)$/.exec(to);
if (!m || !(speed > 0)) {
  console.error('usage: node scripts/av-replay.mjs [capture.jsonl.gz] [--to host:port] [--loop] [--speed 1]');
  process.exit(1);
}
const host = m[1].replace(/^\[|\]$/g, '');
const port = Number(m[2]);

const raw = fs.readFileSync(file);
const lines = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8').split('\n').filter(Boolean);
const header = JSON.parse(lines.shift());
if (header.format !== 'gtd-av-capture') throw new Error(`${file} is not a capture of the audio → visual bridge`);
const messages = lines.map((l) => {
  const [t, address, types, ...values] = JSON.parse(l);
  return { t, bytes: encodeOsc(address, [...types].map((k, i) => ({ [k]: values[i] }))) };
});
const length = messages.at(-1)?.t ?? 0;
console.log(`${header.song?.name || 'capture'}: ${messages.length} messages over ${(length / 1000).toFixed(1)} s → ${host}:${port}${loop ? ' (looping, Ctrl+C to stop)' : ''}`);

const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
socket.on('error', (e) => console.error(e.message));
const stop = () => {
  socket.send(encodeOsc('/gtd/transport/playing', [{ i: 0 }]), port, host, () => process.exit(0));
};
process.on('SIGINT', stop);

for (;;) {
  const t0 = performance.now();
  let i = 0;
  while (i < messages.length) {
    const now = (performance.now() - t0) * speed;
    // everything that is due goes out together (a frame's messages share a time), in order
    while (i < messages.length && messages[i].t <= now) socket.send(messages[i++].bytes, port, host);
    if (i < messages.length) await new Promise((r) => setTimeout(r, Math.max(1, Math.min(8, (messages[i].t - now) / speed))));
  }
  if (!loop) break;
}
await new Promise((r) => setTimeout(r, 50));
stop();
