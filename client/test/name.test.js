// The studio is called GGS — in the app, the server, the docs and the packages. The project it is built on is named
// in one place a user sees, the About dialog ("the information section"), and in the LICENSE file, whose copyright
// line the MIT licence requires to stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '../src/lib/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BEFORE = new RegExp(['grean', 'tea', 'dawy'].join(''), 'i');
const SKIP = new Set(['node_modules', 'dist', '.git', 'data', 'uploads', '.venv', 'test-results', 'playwright-report']);
const TEXT = /\.(js|jsx|mjs|json|md|html|css|yml|yaml|py|sh|txt|example)$|^(Dockerfile|LICENSE)$/;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (TEXT.test(entry.name)) yield full;
  }
}

test('the app is GGS, and the project it is built on is named in About and in the licence only', () => {
  assert.equal(APP_NAME, 'GGS');
  assert.match(fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8'), /<title>GGS<\/title>/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name, 'ggs');
  const named = [];
  for (const file of files(ROOT)) if (BEFORE.test(fs.readFileSync(file, 'utf8'))) named.push(path.relative(ROOT, file));
  assert.deepEqual(named.sort(), ['LICENSE', 'client/src/components/About.jsx']);
  // About says where the studio comes from, with the author and a link
  const about = fs.readFileSync(path.join(ROOT, 'client/src/components/About.jsx'), 'utf8');
  assert.match(about, /Built on <a href="https:\/\/github\.com\/vidux\/[A-Za-z]+"[^>]*>[A-Za-z]+<\/a> by Gayan Viduranga and contributors/);
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Gayan Viduranga/);
});
