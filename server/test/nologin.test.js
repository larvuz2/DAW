// NO_LOGIN: the studio on one's own computer with no sign-in. Everyone who reaches it is the one local account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { startServer, agent, mcpClient, callTool } from './helpers.js';

test('NO_LOGIN: no setup screen, no cookie, no token — the browser API, the socket and MCP all work as the local account', async () => {
  const srv = await startServer({ NO_LOGIN: '1' });
  try {
    const anyone = agent(srv.base);
    const status = (await anyone.get('/api/auth/status')).body;
    assert.equal(status.setupRequired, false);
    assert.equal(status.noLogin, true);
    assert.equal(status.user.username, 'local');
    assert.equal(status.user.role, 'admin');
    assert.equal(status.setupCodeRequired, false);
    // a browser with no cookie reads and writes its projects
    const projects = (await anyone.get('/api/projects')).body;
    assert.ok(projects.projects?.length >= 1 || projects.length >= 1, 'the welcome project is there');
    assert.equal((await anyone.post('/api/projects', { name: 'No sign-in', template: 'empty' })).status < 300, true);
    // the account pages that need a session or an admin are open to it too
    assert.equal((await anyone.get('/api/admin/users')).status, 200);
    assert.equal((await anyone.get('/api/me')).status, 200);
    // MCP without a token: the same account, the same projects
    const client = await mcpClient(srv.base);
    const text = await callTool(client)('list_projects');
    assert.match(text, /No sign-in/);
    await client.close();
    // a wrong token does not lock anyone out
    const stale = await fetch(`${srv.base}/api/auth/status`, { headers: { authorization: 'Bearer gtd_nonsense' } });
    assert.equal((await stale.json()).user.username, 'local');
  } finally {
    await srv.close();
  }
});

test('without NO_LOGIN nothing changed: the setup screen, and no account for a stranger', async () => {
  const srv = await startServer({});
  try {
    const status = (await agent(srv.base).get('/api/auth/status')).body;
    assert.deepEqual([status.setupRequired, status.noLogin, status.user], [true, false, null]);
    assert.equal((await agent(srv.base).get('/api/projects')).status, 401);
  } finally {
    await srv.close();
  }
});

test('NO_LOGIN on a data folder that was used with sign-in: the first admin is the local account, with their projects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-nologin-'));
  const dataDir = path.join(root, 'data');
  const open = async (env) => {
    const ctx = await createServer({ ...loadConfig(env), dataDir, port: 0, clientDist: path.join(root, 'none') });
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
    return { ctx, base: `http://127.0.0.1:${ctx.server.address().port}` };
  };
  const shut = async ({ ctx }) => { await ctx.store.flush(); await ctx.sessions.flush(); ctx.hub.wss.close(); ctx.server.close(); };
  try {
    const first = await open({});
    const me = agent(first.base);
    await me.post('/api/auth/setup', { username: 'gustavo', password: 'a-long-password-1' });
    await me.post('/api/projects', { name: 'Made while signing in', template: 'empty' });
    await shut(first);
    const second = await open({ NO_LOGIN: '1' });
    const status = (await agent(second.base).get('/api/auth/status')).body;
    assert.equal(status.user.username, 'gustavo');
    const list = (await agent(second.base).get('/api/projects')).body;
    assert.match(JSON.stringify(list), /Made while signing in/);
    assert.equal((await fs.readdir(dataDir)).length > 0, true);
    await shut(second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('NO_LOGIN is refused where other computers can reach the server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-nologin-'));
  try {
    await assert.rejects(
      createServer({ ...loadConfig({ NO_LOGIN: '1', HOST: '0.0.0.0' }), dataDir: path.join(root, 'data'), port: 0, clientDist: path.join(root, 'none') }),
      /NO_LOGIN switches every sign-in off, so it only runs on this computer/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
