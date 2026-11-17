// The audio → visual bridge on the server (src/av.js + the hub): frames from a studio tab go out as OSC over UDP to a
// real socket, in order; one tab at a time; only an admin's tab drives OSC; a visual app on a WebSocket (API token)
// gets its own account's frames; AV_OSC parsing; and the music "stops" for the visuals when the tab goes away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import WebSocket from 'ws';
import { decodeOsc, PPQ } from '@greanteadawy/core';
import { startServer, agent, openSocket, waitFor, mcpClient } from './helpers.js';
import { parseAvTarget, AvBridge } from '../src/av.js';

let srv;
let admin;
let udp;
const received = []; // [address, ...values] in arrival order

before(async () => {
  udp = dgram.createSocket('udp4');
  udp.on('message', (buf) => received.push(decodeOsc(buf)));
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  srv = await startServer({ AV_OSC: `127.0.0.1:${udp.address().port}` });
  admin = agent(srv.base);
  await admin.post('/api/auth/setup', { username: 'tester', password: 'tester-pass' });
});
after(async () => {
  await srv.close();
  udp.close();
});

const frame = (over = {}) => ({
  playing: 1, bpm: 120, tick: PPQ * 4 + PPQ, ppq: PPQ, tpb: PPQ * 4, time: 1.25,
  notes: [{ ch: 'kick', key: 36, vel: 0.8, dur: 0.1, at: 1.24 }],
  master: { peak: 0.5, rms: 0.2, bands: [0, 0.1, 0.2, 0.3, 0.4, 0.5], spectrum: new Array(32).fill(0.25), centroid: 900, onset: 0 },
  buses: { 0: 0.5 }, ch: { kick: 0.6 }, auto: {}, user: [0, 0, 0.75, 0, 0, 0, 0, 0],
  ...over
});
const since = (n) => received.slice(n).map((m) => m[0]);

test('AV_OSC: host:port, IPv6, off, and the default only on this computer', () => {
  assert.deepEqual(parseAvTarget(''), { host: '127.0.0.1', port: 7000 });
  assert.equal(parseAvTarget('', { loopback: false }), null, 'a server other machines reach sends nothing unless told where');
  assert.deepEqual(parseAvTarget('host.docker.internal:9000', { loopback: false }), { host: 'host.docker.internal', port: 9000 });
  assert.deepEqual(parseAvTarget('[::1]:7001'), { host: '::1', port: 7001 });
  for (const off of ['off', 'OFF', 'false', '0', 'none']) assert.equal(parseAvTarget(off), null);
  for (const bad of ['7000', 'host:', 'host:0', 'host:70000', 'a b:1', 'http://x:1']) assert.throws(() => parseAvTarget(bad), /host:port/, bad);
});

test('a playing tab: its frames arrive as OSC, transport first, in the order they were sent', async () => {
  const status = await admin.get('/api/status');
  assert.equal(status.body.av.osc, `127.0.0.1:${udp.address().port}`);
  const tab = openSocket(srv.base, admin.cookie);
  assert.equal(await tab.opened, true);
  const n = received.length;
  tab.ws.send(JSON.stringify({ type: 'av', frame: frame({ map: { channels: [{ slug: 'kick', id: 'ch_1', color: '#f00', kind: 'drums', insert: 1 }], buses: [] } }) }));
  await waitFor(() => since(n).includes('/gtd/map'));
  const got = since(n);
  assert.equal(got[0], '/gtd/transport/playing');
  assert.deepEqual(received.find((m) => m[0] === '/gtd/transport/bar'), ['/gtd/transport/bar', 2]);
  const note = received.find((m) => m[0] === '/gtd/ch/kick/note');
  assert.equal(note[1], 36);
  assert.ok(Math.abs(note[2] - 0.8) < 1e-6 && Math.abs(note[4] - 1.24) < 1e-6);
  assert.ok(Math.abs(received.find((m) => m[0] === '/gtd/user/3')[1] - 0.75) < 1e-6);
  assert.ok(got.indexOf('/gtd/ch/kick/note') < got.indexOf('/gtd/master/peak'));
  assert.ok(got.indexOf('/gtd/master/peak') < got.indexOf('/gtd/map'));
  await waitFor(() => tab.messages.some((m) => m.type === 'av-status'));
  assert.deepEqual(tab.messages.find((m) => m.type === 'av-status'), { type: 'av-status', state: 'osc', osc: status.body.av.osc });

  // a second tab waits while the first one plays, and takes over a second after it went quiet
  const other = openSocket(srv.base, admin.cookie);
  await other.opened;
  const m = received.length;
  other.ws.send(JSON.stringify({ type: 'av', frame: frame({ bpm: 99 }) }));
  await waitFor(() => other.messages.some((x) => x.type === 'av-status'));
  assert.equal(other.messages.find((x) => x.type === 'av-status').state, 'busy');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!received.slice(m).some((x) => x[0] === '/gtd/transport/bpm' && x[1] === 99), 'the waiting tab sent nothing');

  // the first tab switches off (`final`): the port is free at once
  tab.ws.send(JSON.stringify({ type: 'av', frame: { playing: 0, bpm: 120, tick: 0, final: true } }));
  await waitFor(() => received.slice(m).some((x) => x[0] === '/gtd/transport/playing' && x[1] === 0));
  other.ws.send(JSON.stringify({ type: 'av', frame: frame({ bpm: 99 }) }));
  await waitFor(() => received.slice(m).some((x) => x[0] === '/gtd/transport/bpm' && x[1] === 99));

  // the tab that sends goes away: the visuals hear the music stop
  const k = received.length;
  other.ws.close();
  await waitFor(() => received.slice(k).some((x) => x[0] === '/gtd/transport/playing' && x[1] === 0));
  tab.ws.close();
});

test('only an admin drives OSC; a visual app on a WebSocket gets its own account\'s frames, nobody else\'s', async () => {
  const made = await admin.post('/api/admin/users', { username: 'vjay', password: 'vj-password-1' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const vj = agent(srv.base);
  const login = await vj.post('/api/auth/login', { username: 'vjay', password: 'vj-password-1' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = (await vj.post('/api/me/token')).body.token;
  assert.ok(token);

  // the visual app: no Origin, the account's token, asks for the frames
  const app = new WebSocket(`${srv.base.replace('http', 'ws')}/ws?token=${token}`);
  const appMsgs = [];
  app.on('message', (d) => appMsgs.push(JSON.parse(d.toString())));
  await new Promise((r) => app.on('open', r));
  app.send(JSON.stringify({ type: 'subscribe-av' }));
  await waitFor(() => appMsgs.some((m) => m.type === 'av-status' && m.listening));

  const vjTab = openSocket(srv.base, vj.cookie);
  await vjTab.opened;
  const adminTab = openSocket(srv.base, admin.cookie);
  await adminTab.opened;
  const n = received.length;
  vjTab.ws.send(JSON.stringify({ type: 'av', frame: frame({ bpm: 77 }) }));
  await waitFor(() => appMsgs.some((m) => m.type === 'av' && m.frame.bpm === 77));
  await waitFor(() => vjTab.messages.some((m) => m.type === 'av-status'));
  assert.equal(vjTab.messages.find((m) => m.type === 'av-status').state, 'admin');
  // the admin's frames reach OSC but not the other account's listener
  adminTab.ws.send(JSON.stringify({ type: 'av', frame: frame({ bpm: 133 }) }));
  await waitFor(() => received.slice(n).some((x) => x[0] === '/gtd/transport/bpm' && Math.abs(x[1] - 133) < 1e-3));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!received.slice(n).some((x) => x[0] === '/gtd/transport/bpm' && Math.abs(x[1] - 77) < 1e-3), "a user's tab doesn't drive the server's OSC");
  assert.ok(!appMsgs.some((m) => m.type === 'av' && m.frame.bpm === 133), "another account's frames never reach this listener");
  // junk frames are ignored without an error
  for (const junk of [null, 5, 'x', [1], { notes: 'no', ch: 3 }]) adminTab.ws.send(JSON.stringify({ type: 'av', frame: junk }));
  adminTab.ws.send(JSON.stringify({ type: 'av', frame: { playing: 0, final: true } }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!adminTab.messages.some((m) => m.type === 'error'));
  for (const s of [app, vjTab.ws, adminTab.ws]) s.close();
});

test('the bridge alone: rate limit, no target, sockets made once', () => {
  const sent = [];
  let made = 0;
  const createSocket = () => { made++; return { send: (buf) => sent.push(decodeOsc(buf)[0]), on() {}, unref() {} }; };
  const b = new AvBridge({ target: { host: '127.0.0.1', port: 1 }, createSocket });
  const a = {};
  const adminUser = { role: 'admin' };
  assert.deepEqual(b.frame(a, adminUser, frame(), 1000), { osc: true });
  assert.deepEqual(b.frame(a, adminUser, frame(), 1003), { osc: false, reason: 'rate' }, 'more than ~120 a second');
  assert.deepEqual(b.frame(a, adminUser, frame(), 1020), { osc: true });
  assert.deepEqual(b.frame({}, adminUser, frame(), 1500), { osc: false, reason: 'busy' });
  assert.deepEqual(b.frame({}, adminUser, frame(), 2100), { osc: true }, 'a second of quiet frees the port');
  assert.equal(made, 1);
  assert.ok(sent.length > 20 && sent[0] === '/gtd/transport/playing');
  assert.deepEqual(new AvBridge({ target: null }).frame(a, adminUser, frame()), { osc: false, reason: 'off' });
});

test('Claude draws a visual lane: add_automation target user, lane 1..8, nothing else needed', async () => {
  const token = (await admin.post('/api/me/token')).body.token;
  const client = await mcpClient(srv.base, token);
  const call = (args) => client.callTool({ name: 'add_automation', arguments: args });
  const r = await call({ target: { type: 'user', lane: 3 }, points: [{ bar: 0, value: 0 }, { bar: 4, value: 1 }], startBar: 1 });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /Visual 3/);
  const p = (await admin.get(`/api/projects/${(await admin.get('/api/status')).body.activeProjectId}`)).body;
  assert.deepEqual(p.automations.at(-1).target, { type: 'user', index: 3 });
  const noLane = await call({ target: { type: 'user' }, points: [{ bar: 0, value: 0 }], startBar: 1 });
  assert.ok(noLane.isError && /lane/.test(noLane.content[0].text));
  const noParam = await call({ target: { type: 'master' }, points: [{ bar: 0, value: 0 }], startBar: 1 });
  assert.ok(noParam.isError && /param/.test(noParam.content[0].text));
  const tooHigh = await call({ target: { type: 'user', lane: 9 }, points: [{ bar: 0, value: 0 }], startBar: 1 });
  assert.ok(tooHigh.isError);
  await client.close();
});
