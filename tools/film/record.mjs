// Records the film: steps the player through the piece frame by frame in a real browser and hands the pictures to
// ffmpeg, with the audio the piece was rendered to. The player draws any moment from nothing, so the video is the
// same every time and does not depend on how fast this machine is.
//   node tools/film/record.mjs [--dir uploads/film/kaleidoscope] [--fps 60] [--out film.mp4]
//   node tools/film/record.mjs --frame 12.5 [--frame 20 …]      stills only (frame-12.50.png), to look before recording
// E2E_CHROMIUM=/path/to/chromium uses an installed browser.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const one = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const dir = path.resolve(ROOT, one('--dir', 'uploads/film/kaleidoscope'));
const fps = Number(one('--fps', 60));
const stills = all('--frame').map(Number);
const page = path.join(dir, 'index.html');
if (!existsSync(page)) throw new Error(`${page} is not there: run node tools/film/kaleidoscope.mjs first`);

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
try {
  const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  tab.on('pageerror', (e) => errors.push(e.message));
  await tab.goto(`${pathToFileURL(page).href}?record`);
  await tab.evaluate(() => window.__film.ready);
  const total = await tab.evaluate(() => window.__film.total);
  const shot = async (t, type) => {
    await tab.evaluate((time) => window.__film.draw(time), t);
    return tab.screenshot({ type, ...(type === 'jpeg' ? { quality: 97 } : {}), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  };
  if (stills.length) {
    for (const t of stills) {
      const file = path.join(dir, `frame-${t.toFixed(2)}.png`);
      writeFileSync(file, await shot(t, 'png'));
      console.log(path.relative(ROOT, file));
    }
  } else {
    const out = path.resolve(dir, one('--out', 'film.mp4'));
    const audio = path.join(dir, 'audio.wav');
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-i', audio,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', out
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => { ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ended with ${code}`)))); ff.on('error', reject); });
    const frames = Math.round(total * fps);
    const started = Date.now();
    for (let k = 0; k < frames; k++) {
      const jpeg = await shot(k / fps, 'jpeg');
      if (!ff.stdin.write(jpeg)) await new Promise((resolve) => ff.stdin.once('drain', resolve));
      if (k % 240 === 0) console.log(`${String(k).padStart(5)} / ${frames} frames  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
    ff.stdin.end();
    await done;
    console.log(`wrote ${path.relative(ROOT, out)}: ${frames} frames at ${fps} fps, ${total.toFixed(1)} s`);
  }
  if (errors.length) throw new Error(`the page reported errors: ${errors.join(' | ')}`);
} finally {
  await browser.close();
}
