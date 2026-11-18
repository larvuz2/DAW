/* global document */
// Render a project file in a throwaway studio on this machine (headless Chromium, no account, nothing kept) and
// report its loudness, peaks and band balance — measured by the same meter as the original song (measure.mjs), so the
// two compare like for like — and optionally keep the WAV to listen to.
//
//   npm run build                                                    (once: the studio's client)
//   node tools/song-analyzer/audition.mjs <project.gtd.json> [--wav out.wav] [--compare <analysis dir>]
//
// Used in a song study to hear and measure a preset before saving it (docs/song-studies.md).
// E2E_CHROMIUM=/path/to/chromium uses an installed browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../../server/src/index.js';
import { loadConfig } from '../../server/src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const wavOut = flag('--wav');
const compare = flag('--compare');
const file = args[0];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node tools/song-analyzer/audition.mjs <project.gtd.json> [--wav out.wav] [--compare <analysis dir>]');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'client/dist/index.html'))) {
  console.error('Build the client first: npm run build');
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-audition-'));
const srv = await createServer({ ...loadConfig({ ...process.env, HOST: '127.0.0.1', NO_LOGIN: '1', AV_OSC: 'off' }), dataDir, port: 0 });
await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.server.address().port}`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}) });
const mcp = new Client({ name: 'song-audition', version: '1.0.0' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(base);
  await page.locator('.toolbar').waitFor();
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  const made = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) })).json();
  if (!made.id) throw new Error(`the studio refused the project: ${JSON.stringify(made).slice(0, 300)}`);
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name, a = {}) => {
    const r = await mcp.callTool({ name, arguments: a }, undefined, { timeout: 600000 });
    const text = r.content.map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  await call('open_project', { projectId: made.id });
  await page.waitForFunction((name) => document.title.includes(name), project.name, { timeout: 15000 }).catch(() => {});
  console.log(await call('render_mix', { projectId: made.id, mode: 'song', compareTo: 'none' }));
  if (wavOut || compare) {
    const link = /\/api\/exports\/[^\s)\]"'`]+/.exec(await call('export_audio', { projectId: made.id, format: 'wav', mode: 'song', bitDepth: 16 }));
    if (!link) throw new Error('the export gave no file');
    const wav = wavOut ? path.resolve(wavOut) : path.join(dataDir, 'audition.wav');
    fs.writeFileSync(wav, Buffer.from(await (await fetch(new URL(link[0], base))).arrayBuffer()));
    if (wavOut) console.log(`\nWAV: ${wav}`);
    if (compare) {
      const mine = JSON.parse(execFileSync('node', [path.join(HERE, 'measure.mjs'), wav], { maxBuffer: 1 << 26 }).toString()).report;
      const A = JSON.parse(fs.readFileSync(path.join(compare, 'analysis.json'), 'utf8'));
      const theirs = { lufs: A.signal?.loudness?.value?.integrated_lufs, lra: A.signal?.loudness?.value?.loudness_range_lu, tp: A.signal?.levels?.value?.true_peak_dbtp, bands: A.signal?.spectral_balance?.value?.bands || {} };
      const pct = (b) => `${Math.round((b?.share ?? 0) * 100)}%`;
      console.log('\nAgainst the original (same meter):');
      console.log(`  loudness     ${mine.loudness.integrated_lufs} LUFS   (original ${theirs.lufs})`);
      console.log(`  range        ${mine.loudness.loudness_range_lu} LU     (original ${theirs.lra})`);
      console.log(`  true peak    ${mine.levels.true_peak_dbtp} dBTP   (original ${theirs.tp})`);
      for (const k of Object.keys(mine.spectrum.bands)) console.log(`  ${k.padEnd(12)} ${pct(mine.spectrum.bands[k]).padEnd(5)}        (original ${pct(theirs.bands[k])})`);
    }
  }
} finally {
  await mcp.close().catch(() => {});
  await browser.close().catch(() => {});
  srv.hub.wss.close();
  srv.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
