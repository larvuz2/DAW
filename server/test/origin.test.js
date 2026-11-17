// The browser Origin check (CSRF protection) and the switch that turns it off for testing on one's own machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originChecker } from '../src/index.js';
import { loadConfig } from '../src/config.js';

test('origin check: same host passes, another host is blocked, no Origin (MCP clients) passes — unless switched off', () => {
  const check = originChecker('');
  const ok = (r) => !!check(r);
  const req = (origin, host = 'localhost:3001') => ({ headers: { ...(origin ? { origin } : {}), host } });
  assert.equal(ok(req('http://localhost:3001')), true);
  assert.equal(ok(req(null)), true);
  assert.equal(ok(req('http://evil.example')), false);
  // a preview pane or a tunnel: its own address as the Origin, the server's own name as the Host
  assert.equal(ok(req('https://preview.example.dev', '127.0.0.1:3001')), false);
  assert.equal(originChecker('https://studio.example.com')(req('https://studio.example.com')), true);
  // the switch is off unless asked for, and reads the usual spellings
  assert.equal(loadConfig({}).allowAnyOrigin, false);
  assert.equal(loadConfig({ ALLOW_ANY_ORIGIN: '0' }).allowAnyOrigin, false);
  for (const v of ['1', 'true', 'YES', 'on']) assert.equal(loadConfig({ ALLOW_ANY_ORIGIN: v }).allowAnyOrigin, true, v);
});
