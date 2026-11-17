// `npm run dev` puts Vite in front of the server. The server refuses a state-changing request whose Origin is not its
// own Host (CSRF protection), so the proxy must pass the browser's Host on: with Vite's default (the string shorthand,
// which rewrites it to the target's) every login, save and first-run setup was answered "Cross-origin request blocked".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../vite.config.js';

test('the dev proxy keeps the Host the browser used, for every route it forwards', () => {
  const proxy = config.server.proxy;
  assert.deepEqual(Object.keys(proxy).sort(), ['/api', '/mcp', '/sandbox', '/ws']);
  for (const [path, entry] of Object.entries(proxy)) {
    assert.equal(typeof entry, 'object', `${path}: a string target would be rewritten`);
    assert.equal(entry.changeOrigin, false, `${path}: changeOrigin must stay false`);
  }
  assert.equal(proxy['/ws'].ws, true);
});
