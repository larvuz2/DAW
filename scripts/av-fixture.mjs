/* global window, document */
// Make the audio → visual test fixture (fixtures/av/): a 16-bar song built for testing a visual setup, played by the
// studio in a real (headless) browser with "Send to visuals" on, and what the bridge sent over OSC captured as it
// arrived — plus the project file, the MIDI, and the stems and mix (those go to --stems, default the system's temp
// dir: they are too big for the repository).
//
//   npm run build && npm run fixture:av [-- --stems /some/dir]     (E2E_CHROMIUM=/path/to/chromium for an installed browser)
//
// The song: A minor, 120 bpm, 4/4, 16 bars = 32 s. Intro (pad + hats) → Build (bass and drums come in, the pad's filter
// opens) → Drop (everything, a lead that circles the room) → Outro. Visual lane 1 "Energy" follows the arrangement,
// lane 2 "Strobe" flashes on every beat of the drop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../server/src/index.js';
import { loadConfig } from '../server/src/config.js';
import { decodeOscMessage } from '../packages/core/src/av.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fixtures/av');
const argStems = process.argv.indexOf('--stems');
const STEMS = argStems > 0 ? path.resolve(process.argv[argStems + 1]) : path.join(os.tmpdir(), 'gtd-av-fixture-stems');
const BARS = 16;
const BPM = 120;
const SONG_MS = (BARS * 4 * 60000) / BPM;

if (!fs.existsSync(path.join(ROOT, 'client/dist/index.html'))) {
  console.error('Build the client first: npm run build');
  process.exit(1);
}

// ---- the OSC port the bridge sends to: every message as it arrives
const udp = dgram.createSocket('udp4');
await new Promise((r) => udp.bind(0, '127.0.0.1', r));
// a frame can be hundreds of datagrams at once: the default receive buffer (~200 KB) would drop the end of the
// biggest ones, and the capture would lie about what the bridge sends
try { udp.setRecvBufferSize(4 << 20); } catch { /* the system's limit is lower: the checks below will say */ }
const capture = [];
let t0 = null;
udp.on('message', (buf) => {
  if (t0 === null) return;
  const { address, args } = decodeOscMessage(buf);
  const kinds = args.map((a) => ('i' in a ? 'i' : 'f' in a ? 'f' : 's')).join('');
  const values = args.map((a) => a.i ?? (a.f !== undefined ? Math.round(a.f * 1e5) / 1e5 : a.s));
  capture.push([Math.round((performance.now() - t0) * 10) / 10, address, kinds, ...values]);
});

// ---- a throwaway studio on this computer
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-av-fixture-'));
const config = { ...loadConfig({ ...process.env, HOST: '127.0.0.1', NO_LOGIN: '1', AV_OSC: `127.0.0.1:${udp.address().port}` }), dataDir, port: 0 };
const srv = await createServer(config);
await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.server.address().port}`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
const mcp = new Client({ name: 'av-fixture', version: '1.0.0' });
const cleanup = async () => {
  await mcp.close().catch(() => {});
  await browser.close().catch(() => {});
  srv.hub.wss.close();
  srv.server.close();
  udp.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
};

try {
  await page.goto(base);
  await page.locator('.toolbar').waitFor();
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  };

  // ---- the song
  const created = await call('create_project', { name: 'AV fixture', template: 'empty', key: 'A', scale: 'minor', bpm: BPM });
  const projectId = /\[(proj_[\w-]+)\]/.exec(created)?.[1] || (await (await fetch(`${base}/api/status`)).json()).activeProjectId;
  await page.waitForFunction(() => document.title.includes('AV fixture'));
  await call('add_channel', { name: 'Kick', instrument: 'kick' });
  await call('add_channel', { name: 'Clap', instrument: 'clap' });
  await call('add_channel', { name: 'Hats', instrument: 'hat' });
  await call('add_channel', { name: 'Bass', instrument: 'ggs', preset: 'Analog Bass' });
  await call('add_channel', { name: 'Pad', instrument: 'ggs', preset: 'Velvet Pad', volume: 0.6 });
  await call('add_channel', { name: 'Lead', instrument: 'ggs', preset: 'Touch Lead', volume: 0.62 });
  await call('create_pattern', { name: 'Drums', bars: 1 });
  await call('write_drums', { pattern: 'Drums', tracks: { Kick: 'x---x---x---x---', Clap: '----x-------x---', Hats: '--x---x---x---x-' } });
  await call('create_pattern', { name: 'Hats', bars: 1 });
  await call('write_drums', { pattern: 'Hats', tracks: { Hats: 'x-x-x-x-x-x-x-x-' } });
  const chords = ['Am', 'F', 'C', 'G'];
  await call('create_pattern', { name: 'Chords', bars: 4 });
  await call('add_chords', { pattern: 'Chords', channel: 'Pad', chords, octave: 3, voices: 4 });
  await call('create_pattern', { name: 'Bass', bars: 4 });
  await call('add_bassline', { pattern: 'Bass', channel: 'Bass', chords, octave: 2, rhythm: 'x-----x-x-----x-' });
  await call('create_pattern', { name: 'Lead', bars: 4 });
  await call('add_notes', {
    pattern: 'Lead', channel: 'Lead',
    text: '1.1 E5 1/8; 1.1.3 A5 1/8; 1.2 C6 1/4; 1.3.3 B5 1/8; 1.4 A5 1/4; '
      + '2.1 F5 1/8; 2.1.3 A5 1/8; 2.2 C6 1/4; 2.3.3 D6 1/8; 2.4 C6 1/4; '
      + '3.1 E5 1/8; 3.1.3 G5 1/8; 3.2 C6 1/4; 3.3.3 B5 1/8; 3.4 G5 1/4; '
      + '4.1 D5 1/8; 4.1.3 G5 1/8; 4.2 B5 1/4; 4.3 A5 1/2 v0.9'
  });
  await call('place_pattern', { pattern: 'Chords', startBar: 1, bars: 16, track: 1 });
  await call('place_pattern', { pattern: 'Hats', startBar: 1, bars: 4, track: 2 });
  await call('place_pattern', { pattern: 'Drums', startBar: 5, bars: 8, track: 3 });
  await call('place_pattern', { pattern: 'Hats', startBar: 13, bars: 4, track: 2 });
  await call('place_pattern', { pattern: 'Bass', startBar: 5, bars: 8, track: 4 });
  await call('place_pattern', { pattern: 'Lead', startBar: 9, bars: 4, track: 5 });
  await call('set_markers', { add: [{ bar: 1, name: 'Intro' }, { bar: 5, name: 'Build' }, { bar: 9, name: 'Drop' }, { bar: 13, name: 'Outro' }] });
  // the pad opens over the build and stays open (held after its clip)
  await call('add_automation', { name: 'Pad filter', target: { type: 'channel', channel: 'Pad', param: 'filterCutoff' }, points: [{ bar: 0, value: 0.45 }, { bar: 4, value: 0.95 }], startBar: 5, track: 6 });
  // visual lanes: the energy of the arrangement, and a strobe on every beat of the drop
  await call('add_automation', { name: 'Energy', target: { type: 'user', lane: 1 }, points: [{ bar: 0, value: 0.1 }, { bar: 4, value: 0.2 }, { bar: 8, value: 1 }, { bar: 12, value: 1 }, { bar: 16, value: 0 }], startBar: 1, bars: 16, track: 7 });
  const strobe = [];
  for (let b = 0; b < 16; b++) strobe.push({ bar: b / 4, value: 1 }, { bar: b / 4 + 0.12, value: 1 }, { bar: b / 4 + 0.125, value: 0 }, { bar: b / 4 + 0.245, value: 0 });
  await call('add_automation', { name: 'Strobe', target: { type: 'user', lane: 2 }, points: strobe, startBar: 9, bars: 4, track: 8 });
  // the lead is a 3D object that circles the room once during the drop (its x/y also arrive as /gtd/auto/…)
  await call('set_spatial', { enabled: true, monitor: 'stereo' });
  await call('place_object', { insert: 'Lead', position: 'front' });
  await call('move_object', { insert: 'Lead', path: 'circle', startBar: 9, bars: 4, turns: 1 });
  // phase 3: the lead plays expressively — its long last note gets a vibrato and a pressure swell, its first a scoop
  await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', fromStep: 56, pitch: { shape: 'vibrato', depth: 0.4 }, pressure: { shape: 'swell', peak: 1 } });
  await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', toStep: 1, pitch: { shape: 'scoop', depth: 2 } });
  // a reverb throw on the pad in the outro: its mix is a phase 2 value that moves (/gtd/fx/5/reverb/mix)
  await call('add_effect', { insert: 5, type: 'reverb', params: { mix: 0.2, decay: 3 } });
  await call('add_automation', { name: 'Reverb throw', target: { type: 'effect', insert: 5, effectId: 'reverb', param: 'mix' }, points: [{ bar: 0, value: 0.2 }, { bar: 4, value: 0.8 }], startBar: 13, bars: 4, track: 9 });
  await call('save_version', { name: 'AV fixture' });

  // ---- play it with the bridge on, and capture what the bridge sends
  t0 = performance.now();
  await page.evaluate(() => window.greanteadawy.store.getState().setAvBridge(true));
  await page.waitForTimeout(2000); // two seconds stopped: the map, the playhead, the intro marker
  await page.evaluate(() => window.greanteadawy.store.getState().play({ mode: 'song' }));
  await page.waitForTimeout(SONG_MS);
  await page.evaluate(() => window.greanteadawy.store.getState().stop());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.greanteadawy.store.getState().setAvBridge(false));
  await page.waitForTimeout(300);
  t0 = null;

  // ---- the files
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(STEMS, { recursive: true });
  const written = [];
  const download = async (url, file) => {
    const res = await fetch(new URL(url, base));
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  };
  // the portable project file (File → Export project file: no account ids), importable with File → Import project file
  const project = await (await fetch(`${base}/api/projects/${projectId}/export`)).json();
  fs.writeFileSync(path.join(OUT, 'song.gtd.json'), `${JSON.stringify(project, null, 1)}\n`);
  // (the links name the server's public address — a port of 0 here: only the path matters)
  const urls = (text) => [...new Set([...text.matchAll(/\/api\/exports\/[^\s)\]"'`]+/g)].map((m) => m[0]))];
  await download(urls(await call('export_midi', { mode: 'song' }))[0], path.join(OUT, 'song.mid'));
  const stems = urls(await call('export_stems', { mode: 'song', bitDepth: 16 }));
  // "AV_fixture-04-Bass-20261117-212419.wav" → "04-bass.wav"
  for (const u of stems) {
    const name = decodeURIComponent(u.split('/').pop());
    const m = /-(\d+)-(.+)-\d{8}-\d{6}\.wav$/.exec(name);
    const file = m ? `${m[1]}-${m[2].toLowerCase().replace(/[^a-z0-9]+/g, '_')}.wav` : name;
    await download(u, path.join(STEMS, file));
    written.push(file);
  }
  const mix = urls(await call('export_audio', { format: 'wav', mode: 'song', bitDepth: 16 }));
  await download(mix[0], path.join(STEMS, 'mix.wav'));
  written.push('mix.wav');

  const header = {
    format: 'gtd-av-capture', version: 1,
    song: { name: project.name, bpm: BPM, bars: BARS, seconds: SONG_MS / 1000, key: 'A minor', markers: project.markers.map((m) => ({ name: m.name, tick: m.tick })) },
    recorded: 'headless Chromium, realtime, the studio\'s own bridge (client/src/lib/avBridge.js → server/src/av.js); t = ms since the capture started: the bridge goes on at 0, play is pressed at ~2000 ms, stop ~32 s later',
    line: '[t_ms, address, types (i int32, f float32, s string), ...values]'
  };
  const body = [JSON.stringify(header), ...capture.map((m) => JSON.stringify(m))].join('\n');
  fs.writeFileSync(path.join(OUT, 'osc-capture.jsonl.gz'), zlib.gzipSync(body, { level: 9 }));

  // a summary to check a receiver against: how many of each, and the notes per channel
  const count = {};
  for (const [, a] of capture) count[a] = (count[a] || 0) + 1;
  const frames = count['/gtd/transport/tick'] || 0;
  const summary = {
    messages: capture.length, frames, seconds: Math.round(capture.at(-1)[0]) / 1000,
    framesPerSecond: Math.round((frames / (capture.at(-1)[0] / 1000)) * 10) / 10,
    addresses: Object.fromEntries(Object.entries(count).sort(([a], [b]) => a.localeCompare(b))),
    markers: capture.filter(([, a]) => a === '/gtd/marker').map(([t, , , name, tick]) => ({ t, name, tick })),
    stems: written
  };
  // a capture that lost messages is no reference: every frame's transport, the map every 2 s, the latency every second
  const seconds = summary.seconds;
  const problems = [
    (count['/gtd/transport/time'] || 0) < frames - 2 && 'frames without their clock',
    (count['/gtd/map'] || 0) < Math.floor(seconds / 2) && 'maps missing',
    (count['/gtd/latency'] || 0) < Math.floor(seconds) - 1 && 'latency missing',
    !(count['/gtd/spatial/6'] > seconds) && '3D positions missing'
  ].filter(Boolean);
  if (problems.length) throw new Error(`the capture is incomplete (${problems.join(', ')}): the UDP receive buffer (${udp.getRecvBufferSize()} bytes) is too small`);
  fs.writeFileSync(path.join(OUT, 'capture-summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  const MOVES = {
    'Pad filter': "the pad's filter cutoff, bars 5–8 (0 = 20 Hz … 1 = 20 kHz, log)",
    Energy: 'visual lane 1 (nothing in the sound)',
    Strobe: 'visual lane 2 (nothing in the sound)',
    'Lead 3D X': "the lead's position left (0) … right (1), bars 9–12",
    'Lead 3D Y': "the lead's position back (0) … front (1), bars 9–12",
    'Reverb throw': "the pad's reverb mix, bars 13–16 (also /gtd/fx/5/reverb/mix)"
  };
  const autoRows = project.automations.map((a) => `| \`${a.id}\` | ${a.name} | ${MOVES[a.name] || ''} |`).join('\n');
  const autoId = (name) => project.automations.find((a) => a.name === name)?.id;
  const sample = [capture.find(([, a]) => a === '/gtd/transport/playing'), capture.find(([, a]) => a === '/gtd/ch/pad/note')].map((m) => JSON.stringify(m)).join('\n');
  fs.writeFileSync(path.join(OUT, 'README.md'), readme({ summary, autoRows, autoId, sample }));
  console.log(`fixtures/av: ${capture.length} OSC messages, ${frames} frames (${summary.framesPerSecond}/s), markers ${summary.markers.map((m) => m.name).join(' → ')}`);
  console.log(`stems and mix: ${STEMS}`);
} finally {
  await cleanup();
}

/** fixtures/av/README.md, with this run's numbers and ids. */
function readme({ summary, autoRows, autoId, sample }) {
  return `# Audio → visual test fixture

A 16-bar song made for building and testing a visual setup against GreanTeaDawy, and a capture of what the studio's
audio → visual bridge really sent while it played (see \`docs/av-bridge.md\` for every address).

| File | What |
|---|---|
| \`song.gtd.json\` | the project (File → Import project file opens it in the studio) |
| \`song.mid\` | the notes, one track per channel, 96 ticks per beat |
| \`osc-capture.jsonl.gz\` | every OSC message the bridge sent, with its arrival time (${summary.messages} messages, ${summary.frames} frames at ${summary.framesPerSecond} per second) |
| \`capture-summary.json\` | how many of each address, the markers with their times — to check a receiver against |
| stems + mix | \`01-kick.wav\` … \`06-lead.wav\` and \`mix.wav\` (16-bit, 44.1 kHz stereo, 35.3 s: the 32 s song + its tail, all starting at bar 1): too big for the repository — make them with \`npm run fixture:av\` or ask for the zip |

## The song

A minor, 120 bpm, 4/4, 16 bars = 32 s. Every section is 4 bars = 8 s.

| Bars | Marker (tick) | What plays | Visual lanes |
|---|---|---|---|
| 1–4 | Intro (0) | pad (Am F C G, a bar each), 8th-note hats | \`/gtd/user/1\` Energy 0.1 → 0.2 |
| 5–8 | Build (1536) | + kick, clap, bass; the pad's filter opens (\`Pad filter\`) | Energy 0.2 → 1 |
| 9–12 | Drop (3072) | + lead, a 3D object circling the room once | Energy 1; \`/gtd/user/2\` Strobe: 1 for the first half of every beat, else 0 |
| 13–16 | Outro (4608) | pad, hats | Energy 1 → 0 |

Channels (\`/gtd/ch/{slug}/…\`, mixer insert): \`kick\` 1, \`clap\` 2, \`hats\` 3, \`bass\` 4 (GGS Analog Bass), \`pad\` 5 (GGS
Velvet Pad), \`lead\` 6 (GGS Touch Lead). Notes in the song: kick 32, clap 16, hats 96, bass 32, pad 64 (4-voice chords),
lead 19 — each with its \`off\`.

Automation (\`/gtd/auto/{id}\`, 0…1, from the moment its clip starts, held after it):

| id | name | moves |
|---|---|---|
${autoRows}

The lead's circle arrives as \`/gtd/spatial/6\` in room units (phase 3, below), and also as its X/Y automation,
0…1: \`/gtd/auto/${autoId('Lead 3D X')}\` and \`/gtd/auto/${autoId('Lead 3D Y')}\`.

## Phase 2 in the capture

Every control as it stands, when it changes and all once a second: \`/gtd/ch/{kick…lead}/param/…\` (the pad's
\`filterCutoff\` is a channel control: it opens in the build), \`/gtd/bus/{0…6}/param/…\`, \`/gtd/fx/0/limiter/…\` and
\`/gtd/fx/5/reverb/…\` (its \`mix\` rises in the outro). And the live modulation of the three GGS channels, \`bass\`, \`pad\`
and \`lead\`: \`/gtd/ggs/{channel}/voices\`, \`…/src/env1\` (each note's amp envelope), \`…/src/lfo1\`, \`…/src/chaos1\`…,
\`…/dst/f1Cutoff\` (Hz) and \`…/dst/f1Cutoff/n\` (0…1), and the rest of the 25 sources and 39 targets.

## Phase 3 in the capture

The lead is a 3D object: \`/gtd/spatial/6\` x, y, z in room units (x −1 left … 1 right, y −1 back … 1 front, z 0 floor
… 1 ceiling) — at the front, then a full circle during the drop. And its notes play expressively:
\`/gtd/ch/lead/expr/pitch\` (semitones) and \`…/expr/pressure\` (0…1) with the note's key — a scoop into its first note
(bar 9), a vibrato and a pressure swell on its long last note (bar 12).

## The capture

Recorded from the real bridge (headless Chromium playing in real time → the studio server → UDP), not simulated.
Gzipped JSON lines: a header, then one line per message, in arrival order:

\`\`\`
{"format":"gtd-av-capture","version":1,"song":{…},"recorded":"…","line":"[t_ms, address, types, ...values]"}
${sample}
\`\`\`

\`t\` is milliseconds since the capture started: the bridge goes on at 0 (stopped, at bar 1: map, Intro), play is pressed
at ~2 s, the drop arrives at ~${(summary.markers.find((m) => m.name === 'Drop').t / 1000).toFixed(1)} s, stop at ~${Math.round((2000 + SONG_MS) / 1000)} s (the playhead goes back to bar 1, so the Intro marker comes again),
then the bridge goes off. Messages of one frame share a time to within a millisecond.

## Replaying it

\`\`\`bash
npm run av:replay
\`\`\`

sends the capture to \`127.0.0.1:7000\` with its original timing. Options after \`--\`: \`--to host:port\`, \`--loop\`,
\`--speed 0.5\` (or any other file: \`npm run av:replay -- my-capture.jsonl.gz\`).

## Making it again

\`\`\`bash
npm run build
\`\`\`

\`\`\`bash
npm run fixture:av -- --stems ~/Desktop/gtd-av-stems
\`\`\`

\`scripts/av-fixture.mjs\` builds the song through the MCP tools (as Claude would), plays it in a headless Chromium with
"Send to visuals" on, captures the OSC on a local UDP port and exports the files. Ids, times and measured values
change a little from run to run (the browser's timers and audio thread); the song, the notes and the counts don't.
`;
}
