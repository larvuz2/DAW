// The pictures of the synth page: what each part of the patch is doing, drawn from the same maths the engine uses
// (wavetables, unison laws, filter curves) or from what the voices and the channel report while a note sounds.
// All canvas or SVG; a canvas follows its box's size and redraws when an input changes — and, given a `live`
// getter, on every animation frame in which what it shows has moved.
import { useEffect, useMemo, useRef } from 'react';
import { wavetablePreview, getWavetable, unisonCents, stackSemis, UNISON_LAWS, UNISON_STACKS, BIPOLAR_SOURCES, chaosPreview } from '@ggs/synth-dsp';
import { onFrame } from '../ui/frames.js';
import { liveSource } from './modulation.js';

const GRID = 'rgba(255,255,255,0.07)';

// The synth page is drawn at one size and scaled to its window: canvases draw at that scale too, so they stay sharp.
let displayScale = 1;
export const SCALE_EVENT = 'gtd-display-scale';
export function setDisplayScale(s) {
  if (!(s > 0) || Math.abs(s - displayScale) < 0.01) return;
  displayScale = s;
  globalThis.dispatchEvent?.(new Event(SCALE_EVENT));
}
export const pixelRatio = () => Math.min(3, (globalThis.devicePixelRatio || 1) * displayScale);
const DIM = 'rgba(255,255,255,0.32)';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A canvas that fills its box. `draw(g, w, h, now)` paints it; it runs when `deps` change, when the box is resized,
 * and — with `live` — on each frame in which `live()` returns something new (that value is `now`). What does not
 * move with `now` can go in `still(g, w, h)`: it is drawn once into a cached layer (again only when `deps` or the
 * size change), so a live frame only redraws what moved. Nothing is redrawn live while the box is off screen.
 */
export function useCanvas(draw, deps, live = null, still = null) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const paint = useRef(() => {});
  const last = useRef(undefined);
  const layer = useRef({ canvas: null, key: '' });
  const version = useRef(0);
  const visible = useRef(true);
  paint.current = (now) => {
    const cv = canvas.current;
    const box = wrap.current;
    if (!cv || !box) return;
    const w = Math.max(10, box.clientWidth);
    const h = Math.max(10, box.clientHeight);
    const dpr = pixelRatio();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    if (still) {
      const l = layer.current;
      const key = `${version.current}|${cv.width}|${cv.height}`;
      if (l.key !== key) {
        l.canvas = l.canvas || document.createElement('canvas');
        l.canvas.width = cv.width;
        l.canvas.height = cv.height;
        const sg = l.canvas.getContext('2d');
        sg.setTransform(dpr, 0, 0, dpr, 0, 0);
        still(sg, w, h);
        l.key = key;
      }
      g.drawImage(l.canvas, 0, 0);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g, w, h, now);
  };
  useEffect(() => {
    version.current++;
    paint.current(live ? live() : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const box = wrap.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => paint.current(live ? live() : null));
    ro.observe(box);
    if (!live || typeof IntersectionObserver === 'undefined') return () => ro.disconnect();
    const io = new IntersectionObserver(([e]) => {
      visible.current = e.isIntersecting;
      if (e.isIntersecting) paint.current(live());
    });
    io.observe(box);
    return () => { ro.disconnect(); io.disconnect(); };
  }, [live]);
  useEffect(() => {
    const again = () => paint.current(live ? live() : null);
    globalThis.addEventListener?.(SCALE_EVENT, again);
    return () => globalThis.removeEventListener?.(SCALE_EVENT, again);
  }, [live]);
  useEffect(() => {
    if (!live) return undefined;
    return onFrame(() => {
      if (!visible.current) return;
      const v = live();
      const key = Array.isArray(v) || ArrayBuffer.isView(v) ? v : v === null || v === undefined ? null : Math.round(v * 400) / 400;
      if (key === last.current && !ArrayBuffer.isView(key)) return;
      last.current = key;
      paint.current(v);
    });
  }, [live]);
  return { wrap, canvas };
}

/** A box with a canvas in it (the size comes from CSS: `.ovw-display` and its modifiers). */
export function Display({ draw, still, deps, live, className = '', label }) {
  const { wrap, canvas } = useCanvas(draw, deps, live, still);
  return <div ref={wrap} className={`ovw-display ${className}`}><canvas ref={canvas} role="img" aria-label={label} /></div>;
}

function text(g, s, x, y, { align = 'left', color = DIM, size = 9 } = {}) {
  g.font = `600 ${size}px Inter, system-ui, sans-serif`;
  g.textAlign = align;
  g.fillStyle = color;
  g.fillText(s, x, y);
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ---- the wavetable as a stack of frames ------------------------------------------------------------------------

const STACK = 18;
const POINTS = 96;
const stacks = new Map();
/** One cycle at each of STACK positions through the table (cached: tables never change). */
function stackOf(table) {
  let s = stacks.get(table);
  if (!s) {
    s = Array.from({ length: STACK }, (_, k) => normalize(wavetablePreview(table, k / (STACK - 1), POINTS)));
    if (stacks.size > 60) stacks.delete(stacks.keys().next().value);
    stacks.set(table, s);
  }
  return s;
}
function normalize(wave) {
  let peak = 1e-6;
  for (const v of wave) peak = Math.max(peak, Math.abs(v));
  return Float32Array.from(wave, (v) => v / peak);
}

/**
 * The wavetable drawn as a waterfall: every frame of the table in perspective, back to front, and the one the
 * oscillator plays now lit in its colour (where the knob is, and — while a note sounds — where modulation took it).
 */
export function WavetableStack({ table, pos, color, on = true, live = null, className = 'tall' }) {
  const frames = useMemo(() => stackOf(table), [table]);
  const count = useMemo(() => getWavetable(table).frames, [table]);
  const geom = (w, h) => {
    const pad = 6;
    const dx = w * 0.2;
    const dy = h * 0.42;
    const fw = w - dx - pad * 2;
    const amp = ((h - dy - pad * 2) / 2) * 0.9;
    const origin = (depth) => [pad + dx * depth, h - pad - amp - dy * depth];
    const trace = (g, frame, depth) => {
      const [ox, oy] = origin(depth);
      g.beginPath();
      for (let i = 0; i < frame.length; i++) {
        const x = ox + (i / (frame.length - 1)) * fw;
        const y = oy - frame[i] * amp;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      return [ox, oy];
    };
    return { pad, fw, amp, origin, trace };
  };
  return (
    <Display className={className} label={`Wavetable ${table} at position ${Math.round(pos * 100)}%`} live={live} deps={[table, Math.round(pos * 400), color, on]}
      still={(g, w, h) => {
        // every frame, back to front (the same picture until the table, the colour or the size changes)
        const { fw, amp, origin, trace } = geom(w, h);
        g.globalAlpha = on ? 1 : 0.4;
        for (let k = STACK - 1; k >= 0; k--) {
          const depth = k / (STACK - 1);
          const [ox, oy] = trace(g, frames[k], depth);
          g.lineTo(ox + fw, oy + amp + 2);
          g.lineTo(ox, oy + amp + 2);
          g.closePath();
          g.fillStyle = 'rgba(18,20,26,0.84)';
          g.fill();
          trace(g, frames[k], depth);
          g.strokeStyle = hexA(color, 0.18 + 0.42 * (1 - depth));
          g.lineWidth = 1;
          g.stroke();
        }
        const [ax, ay] = origin(0);
        const [bx, by] = origin(1);
        g.strokeStyle = GRID;
        g.beginPath();
        g.moveTo(ax + fw + 3, ay + amp);
        g.lineTo(bx + fw + 3, by + amp);
        g.stroke();
        g.globalAlpha = 1;
      }}
      draw={(g, w, h, now) => {
        const { pad, fw, amp, origin, trace } = geom(w, h);
        g.globalAlpha = on ? 1 : 0.4;
        const lit = (p, width, glow, fill) => {
          const frame = normalize(wavetablePreview(table, p, POINTS));
          const [ox, oy] = trace(g, frame, p);
          if (fill) {
            g.lineTo(ox + fw, oy);
            g.lineTo(ox, oy);
            g.closePath();
            g.fillStyle = hexA(color, 0.16);
            g.fill();
            trace(g, frame, p);
          }
          g.shadowColor = glow ? color : 'transparent';
          g.shadowBlur = glow ? 8 : 0;
          g.strokeStyle = glow ? color : hexA(color, 0.55);
          g.lineWidth = width;
          g.stroke();
          g.shadowBlur = 0;
        };
        const at = typeof now === 'number' ? clamp(now, 0, 1) : null;
        if (at !== null && Math.abs(at - pos) > 0.004) {
          lit(pos, 1, false, false);
          lit(at, 1.8, true, true);
        } else lit(pos, 1.8, true, true);
        const [mx, my] = origin(at ?? pos);
        g.fillStyle = color;
        g.beginPath();
        g.arc(mx + fw + 3, my + amp, 2.6, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        text(g, `${Math.round((at ?? pos) * 100)}% · ${count} frames`, w - pad, pad + 8, { align: 'right' });
      }} />
  );
}

// ---- unison: where each copy sits in pitch and in the stereo field ---------------------------------------------

/**
 * Every copy of the oscillator as a line: across, how far it is detuned (the law decides the spacing); up, how
 * loud it is (Blend); a dot underneath where it sits in the stereo field. Copies a stack moves up an octave or a
 * fifth are drawn hollow and labelled.
 */
export function UnisonFan({ unison, detune, law, stack, blend, spread, color, className = 'short' }) {
  return (
    <Display className={className} label={`${unison} unison copies, ${detune} cents, ${law} law${stack !== 'off' ? `, ${stack} stack` : ''}`}
      deps={[unison, Math.round(detune * 10), law, stack, Math.round(blend * 100), Math.round(spread * 100), color]}
      draw={(g, w, h) => {
        const n = Math.max(1, Math.round(unison));
        const li = Math.max(0, UNISON_LAWS.indexOf(law));
        const si = Math.max(0, UNISON_STACKS.indexOf(stack));
        const cents = Array.from({ length: n }, (_, u) => unisonCents(li, u, n, detune));
        const span = Math.max(10, ...cents.map(Math.abs)) * 1.15;
        const mid = w / 2;
        const base = h - 14;
        g.strokeStyle = GRID;
        g.beginPath(); g.moveTo(4, base); g.lineTo(w - 4, base); g.moveTo(mid, 4); g.lineTo(mid, base); g.stroke();
        for (let u = 0; u < n; u++) {
          const d = n < 2 ? 0 : (u / (n - 1)) * 2 - 1;
          const gain = Math.abs(d) < 0.34 || n < 3 ? 1 : blend;
          const x = mid + (cents[u] / span) * (w / 2 - 8);
          const top = base - 6 - gain * (base - 14);
          const semis = stackSemis(si, u, n);
          g.strokeStyle = semis ? hexA(color, 0.75) : color;
          g.lineWidth = 2;
          g.setLineDash(semis ? [3, 2] : []);
          g.beginPath(); g.moveTo(x, base); g.lineTo(x, top); g.stroke();
          g.setLineDash([]);
          if (semis) text(g, `+${semis}`, x, top - 2, { align: 'center', color, size: 8 });
          // the stereo position of this copy, under the line
          const pan = clamp(d * spread, -1, 1);
          g.fillStyle = hexA(color, 0.8);
          g.beginPath(); g.arc(mid + pan * (w / 2 - 8), h - 5, 2, 0, Math.PI * 2); g.fill();
        }
        text(g, n < 2 ? 'one voice' : `±${Math.round(Math.max(...cents.map(Math.abs)))} ct`, 6, 12);
        text(g, `${n}× ${law}`, w - 6, 12, { align: 'right' });
      }} />
  );
}

// ---- a sub oscillator wave and the colour of the noise ----------------------------------------------------------


// ---- the signal flow: sources → filters → amp ------------------------------------------------------------------

// ---- an envelope, small (the amp module) -----------------------------------------------------------------------


// ---- LFO and chaos, with where they stand right now ------------------------------------------------------------

const RND = [0.3, -0.7, 0.9, -0.2, 0.6];
function lfoAt(shape, ph) {
  const x = ph - Math.floor(ph);
  const cyc = Math.floor(ph);
  return shape === 'triangle' ? (x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4) : shape === 'saw' ? 1 - 2 * x : shape === 'ramp' ? 2 * x - 1
    : shape === 'square' ? (x < 0.5 ? 1 : -1) : shape === 'sh' ? RND[((cyc % 5) + 5) % 5] : shape === 'smooth' ? RND[((cyc % 5) + 5) % 5] + (RND[(((cyc + 1) % 5) + 5) % 5] - RND[((cyc % 5) + 5) % 5]) * x * x * (3 - 2 * x)
      : Math.sin(2 * Math.PI * x);
}

/** Two cycles of an LFO, and — while a note sounds — a line at the value it has now. */
export function LfoGraph({ shape, phase, color = '#5ab8f0', live = null, source, className = 'mid', label = '' }) {
  const getter = useMemo(() => (live ? () => liveSource(live(), source) : null), [live, source]);
  return (
    <Display className={className} label={`LFO: ${shape}`} live={getter} deps={[shape, Math.round(phase * 100), color, label]}
      still={(g, w, h) => {
        g.strokeStyle = GRID;
        g.lineWidth = 1;
        for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(Math.round((i / 4) * w) + 0.5, 4); g.lineTo(Math.round((i / 4) * w) + 0.5, h - 4); g.stroke(); }
        g.strokeStyle = 'rgba(255,255,255,0.14)';
        g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
        if (label) text(g, label, w - 6, 12, { align: 'right', color: 'rgba(230,233,240,0.6)' });
        const curve = () => {
          g.beginPath();
          for (let i = 0; i <= Math.round(w); i++) {
            const y = h / 2 - lfoAt(shape, (i / w) * 2 + phase) * (h / 2 - 6);
            if (i) g.lineTo(i, y); else g.moveTo(i, y);
          }
        };
        curve();
        g.lineTo(w, h / 2); g.lineTo(0, h / 2); g.closePath();
        g.fillStyle = hexA(color, 0.12);
        g.fill();
        curve();
        g.strokeStyle = color;
        g.lineWidth = 1.6;
        g.lineJoin = 'round';
        g.stroke();
      }}
      draw={(g, w, h, now) => {
        if (typeof now !== 'number') return;
        const y = h / 2 - clamp(now, -1, 1) * (h / 2 - 6);
        g.strokeStyle = hexA(color, 0.5);
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
        g.setLineDash([]);
        g.fillStyle = color;
        g.shadowColor = color; g.shadowBlur = 8;
        g.beginPath(); g.arc(w - 6, y, 3.5, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
      }} />
  );
}

export function ChaosGraph({ type, character, steps, color = '#ef7fb0', live = null, source, className = 'mid' }) {
  const getter = useMemo(() => (live ? () => liveSource(live(), source) : null), [live, source]);
  return (
    <Display className={className} label={`Chaos: ${type}`} live={getter} deps={[type, Math.round(character * 100), steps]}
      still={(g, w, h) => {
        g.strokeStyle = GRID;
        g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
        const pts = chaosPreview({ type, character, steps }, Math.round(w), 12, 3);
        g.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const y = h / 2 - pts[i] * (h / 2 - 5);
          if (i) g.lineTo(i, y); else g.moveTo(i, y);
        }
        g.strokeStyle = color;
        g.lineWidth = 1.4;
        g.lineJoin = 'round';
        g.stroke();
      }}
      draw={(g, w, h, now) => {
        if (typeof now !== 'number') return;
        const y = h / 2 - clamp(now, -1, 1) * (h / 2 - 5);
        g.fillStyle = color;
        g.shadowColor = color; g.shadowBlur = 8;
        g.beginPath(); g.arc(w - 6, y, 3.5, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
      }} />
  );
}

// ---- a source over the last seconds (the mod sources strip) ----------------------------------------------------

/** A source's value over the last three seconds, scrolling; flat and dim while nothing sounds. */
export function SourceSpark({ source, live, color, width = 40, height = 18 }) {
  const ref = useRef(null);
  const both = BIPOLAR_SOURCES.has(source);
  useEffect(() => {
    const hist = new Float32Array(90);
    let n = 0;
    let at = 0;
    let quiet = true;
    let frames = 0;
    let visible = true;
    let drawnDpr = 0;
    const io = typeof IntersectionObserver === 'undefined' || !ref.current ? null : new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io?.observe(ref.current);
    const stop = onFrame(() => {
      const cv = ref.current;
      if (!cv) return;
      // ~30 points a second is plenty for a line this wide
      if (++frames % 2) return;
      const raw = liveSource(live(), source);
      const nowQuiet = raw === null || raw === undefined;
      const dpr = pixelRatio();
      if (nowQuiet && quiet && n && drawnDpr === dpr) return;
      quiet = nowQuiet;
      hist[at] = nowQuiet ? 0 : clamp(raw, -1, 1);
      at = (at + 1) % hist.length;
      n = Math.min(hist.length, n + 1);
      if (!visible) return; // still recorded, drawn when it is back on screen
      if (cv.width !== Math.round(width * dpr)) { cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr); }
      drawnDpr = dpr;
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, height);
      const pad = 2.5;
      const yOf = (v) => pad + (height - pad * 2) * (1 - clamp(both ? (v + 1) / 2 : v, 0, 1));
      g.strokeStyle = hexA(color, 0.22);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, Math.round(yOf(0)) + 0.5); g.lineTo(width, Math.round(yOf(0)) + 0.5); g.stroke();
      g.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const x = (i / (hist.length - 1)) * (width - 2);
        const y = yOf(hist[(at + i) % hist.length]);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = quiet ? hexA(color, 0.35) : color;
      g.lineWidth = 1.25;
      g.lineJoin = 'round';
      g.stroke();
    });
    return () => { stop(); io?.disconnect(); };
  }, [source, live, color, both, width, height]);
  return <canvas ref={ref} className="ovw-spark" style={{ width, height }} aria-hidden="true" />;
}

// ---- the effects, each as a picture of what it does ------------------------------------------------------------

// ---- the channel's output: waveform and spectrum ---------------------------------------------------------------

/**
 * The sound of this channel right now, as a waveform and a spectrum, from an analyser on the channel strip (a side
 * branch: what is heard does not change). Quiet when nothing plays.
 */
export function OutputScope({ analyser, release, color = '#f59f42' }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  useEffect(() => {
    const time = new Float32Array(2048);
    const freq = new Float32Array(1024);
    let node = null;
    let frames = 0;
    let quiet = false;
    let drawnW = 0;
    let drawnH = 0;
    let drawnDpr = 0;
    let visible = true;
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    if (wrap.current) io?.observe(wrap.current);
    const stop = onFrame(() => {
      const cv = canvas.current;
      const box = wrap.current;
      node = node || analyser();
      if (!cv || !box || !node || !visible || ++frames % 2) return;
      const w = Math.max(10, box.clientWidth);
      const h = Math.max(10, box.clientHeight);
      node.getFloatTimeDomainData(time);
      let loud = 0;
      for (let i = 0; i < 2048; i += 8) loud = Math.max(loud, Math.abs(time[i]));
      // silence is drawn once, not 30 times a second (unless the box changed size)
      const dpr = pixelRatio();
      if (loud < 1e-4 && quiet && drawnW === w && drawnH === h && drawnDpr === dpr) return;
      quiet = loud < 1e-4;
      drawnW = w;
      drawnH = h;
      drawnDpr = dpr;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = `${w}px`; cv.style.height = `${h}px`; }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const top = h * 0.5;
      // start at a rising zero crossing, so a steady note stands still
      let start = 0;
      for (let i = 1; i < 1024; i++) if (time[i - 1] < 0 && time[i] >= 0) { start = i; break; }
      let peak = 0.02;
      for (let i = 0; i < 1024; i++) peak = Math.max(peak, Math.abs(time[start + i]));
      g.strokeStyle = GRID;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, top / 2); g.lineTo(w, top / 2); g.moveTo(0, top + 1); g.lineTo(w, top + 1); g.stroke();
      const scale = (top / 2 - 4) * Math.min(1, peak * 4) / peak;
      g.beginPath();
      for (let i = 0; i < 1024; i += 2) {
        const x = (i / 1023) * w;
        const y = top / 2 - time[start + i] * scale;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = color;
      g.lineWidth = 1.4;
      g.lineJoin = 'round';
      g.stroke();
      node.getFloatFrequencyData(freq);
      const sr = node.context.sampleRate;
      const bins = freq.length;
      const xOf = (hz) => (Math.log2(hz / 30) / Math.log2(18000 / 30)) * w;
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w; x += 2) {
        const hz = 30 * Math.pow(18000 / 30, x / w);
        const k = Math.min(bins - 1, Math.round((hz / (sr / 2)) * bins));
        const db = clamp(freq[k], -100, -10);
        g.lineTo(x, h - ((db + 100) / 90) * (h - top - 6));
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = hexA(color, 0.25);
      g.fill();
      g.strokeStyle = hexA(color, 0.8);
      g.lineWidth = 1;
      g.stroke();
      for (const hz of [100, 1000, 10000]) text(g, hz >= 1000 ? `${hz / 1000}k` : String(hz), xOf(hz), h - 2, { align: 'center', size: 8 });
    });
    return () => {
      stop();
      io?.disconnect();
      if (node) release?.();
    };
  }, [analyser, release, color]);
  return <div ref={wrap} className="ovw-display scope"><canvas ref={canvas} role="img" aria-label="Output waveform and spectrum of this channel" /></div>;
}

// ---- the synth page's small pictures -----------------------------------------------------------------------------

/** Two cycles of the sub oscillator's wave, as a line across its box. */
export function SubWave({ wave, on = true, color = '#7c8cff' }) {
  const d = useMemo(() => {
    const shape = (x) => (wave === 'square' ? (x < 0.5 ? 1 : -1) : wave === 'triangle' ? 1 - 4 * Math.abs(x - 0.5) : wave === 'saw' ? 1 - 2 * x : Math.sin(2 * Math.PI * x));
    let path = '';
    for (let i = 0; i <= 96; i++) {
      const x = i / 96;
      path += `${i ? 'L' : 'M'}${(x * 120).toFixed(2)} ${(15 - shape((x * 2) % 1) * 11).toFixed(2)}`;
    }
    return path;
  }, [wave]);
  return (
    <svg viewBox="0 0 120 30" preserveAspectRatio="none" className="sp-svg" role="img" aria-label={`Sub ${wave} wave`}>
      <path d={d} fill="none" stroke={on ? color : 'var(--sp-fg3)'} strokeWidth="1.3" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** The noise's spectrum: flat (white), falling 3 dB (pink) or 6 dB (brown) an octave, tilted by Colour. */
export function NoiseView({ type, colour = 0, on = true, color = '#7c8cff' }) {
  const d = useMemo(() => {
    const slope = type === 'brown' ? 1 : type === 'pink' ? 0.5 : 0;
    let path = '';
    for (let i = 0; i <= 120; i++) {
      const f = i / 120;
      const jitter = Math.sin(i * 12.9898) * 43758.5453;
      const r = (jitter - Math.floor(jitter)) * 2 - 1;
      const level = 0.55 - (slope + colour * 0.5) * (f - 0.5) * 0.9 + r * 0.06;
      path += `${i ? 'L' : 'M'}${i} ${(28 - clamp(level, 0.03, 0.97) * 26).toFixed(2)}`;
    }
    return path;
  }, [type, colour]);
  return (
    <svg viewBox="0 0 120 30" preserveAspectRatio="none" className="sp-svg" role="img" aria-label={`${type} noise spectrum`}>
      <path d={d} fill="none" stroke={on ? color : 'var(--sp-fg3)'} strokeWidth="1" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Velocity → loudness for the current sensitivity (the voice: level × (1 − s + s·v²)). */
export function VelocityCurve({ sens, level = 1, color = '#ffb347' }) {
  const d = useMemo(() => {
    let path = '';
    for (let i = 0; i <= 24; i++) {
      const v = i / 24;
      const g = (1 - sens + sens * v * v) * Math.min(1, level / 0.8);
      path += `${i ? 'L' : 'M'}${(3 + v * 50).toFixed(1)} ${(41 - clamp(g, 0, 1) * 36).toFixed(1)}`;
    }
    return path;
  }, [sens, level]);
  return (
    <svg viewBox="0 0 56 46" className="sp-svg" role="img" aria-label="Velocity response">
      <rect x="3" y="5" width="50" height="36" fill="none" stroke="var(--sp-line)" strokeWidth="1" />
      <path d="M3 41 L53 5" stroke="var(--sp-line)" strokeWidth="1" strokeDasharray="2 3" />
      <path d={`${d}L53 41L3 41Z`} fill={hexA(color, 0.14)} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The signal flow, small: each source wired to filter 1, filter 2, both or straight to the amp, and the two filters in
 * series or side by side. Click (or Enter on) a source to send it to the next place.
 */
export function SignalFlow({ sources, f1On, f2On, route, onCycle }) {
  const serial = route === 'serial';
  const F1 = [104, 26];
  const F2 = [104, 74];
  const AMP = [172, 50];
  const ys = sources.map((_, i) => 10 + i * (80 / Math.max(1, sources.length - 1)));
  const curve = (x1, y1, x2, y2) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
  const wire = (on) => ({ stroke: 'var(--sp-accent-hover)', strokeOpacity: on ? 1 : 0.15, strokeWidth: on ? 1.6 : 1 });
  const node = ([x, y], text, on) => (
    <g key={text}>
      <rect x={x - 15} y={y - 9} width={30} height={18} rx={4} fill={on ? 'var(--sp-control)' : 'var(--sp-panel)'} stroke={on ? 'var(--sp-accent)' : 'var(--sp-line)'} />
      <text x={x} y={y + 3} textAnchor="middle" className="sp-flow-text" fill={on ? 'var(--sp-fg)' : 'var(--sp-fg3)'}>{text}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 196 100" className="sp-svg sp-flow" role="group" aria-label={`Signal flow: filters in ${route}`}>
      <g fill="none" strokeLinecap="round">
        {sources.map((s, i) => {
          if (!s.on) return null;
          const to = s.dest === 'f1' ? [F1] : s.dest === 'f2' ? [F2] : s.dest === 'both' ? [F1, F2] : [AMP];
          return to.map(([x, y]) => <path key={`${s.id}${x}${y}`} d={curve(34, ys[i], x === AMP[0] ? AMP[0] - 12 : x - 15, y)} stroke={s.color} strokeOpacity={0.85} strokeWidth={1.3} />);
        })}
        {serial ? <path d={`M${F1[0]} ${F1[1] + 9} L${F2[0]} ${F2[1] - 9}`} {...wire(true)} /> : <path d={curve(F1[0] + 15, F1[1], AMP[0] - 12, AMP[1])} {...wire(true)} />}
        {serial && <path d={`M${F2[0] - 3.5} ${F2[1] - 13.5} L${F2[0]} ${F2[1] - 9} L${F2[0] + 3.5} ${F2[1] - 13.5}`} {...wire(true)} />}
        <path d={curve(F2[0] + 15, F2[1], AMP[0] - 12, AMP[1])} {...wire(true)} />
      </g>
      {sources.map((s, i) => (
        <g key={s.id} className={`sp-flow-src ${s.on ? '' : 'off'}`} data-source={s.id} role="button" tabIndex={0} onClick={() => onCycle(s.id)}
          aria-label={`${s.label} goes to ${s.dest === 'direct' ? 'the amp' : s.dest === 'both' ? 'both filters' : s.dest === 'f1' ? 'filter 1' : 'filter 2'}: change`}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCycle(s.id); } }}>
          <title>{`${s.label} → ${s.dest === 'direct' ? 'straight to the amp' : s.dest === 'both' ? 'both filters' : s.dest === 'f1' ? 'filter 1' : 'filter 2'} (click to send it elsewhere)`}</title>
          <rect x={4} y={ys[i] - 7} width={30} height={14} rx={3} fill="var(--sp-control)" stroke={s.on ? s.color : 'var(--sp-line)'} />
          <text x={19} y={ys[i] + 3} textAnchor="middle" className="sp-flow-text" fill={s.on ? s.color : 'var(--sp-fg3)'}>{s.short}</text>
        </g>
      ))}
      {node(F1, 'F1', f1On)}
      {node(F2, 'F2', f2On)}
      <path d={`M${AMP[0] - 12} ${AMP[1] - 9} L${AMP[0] + 6} ${AMP[1]} L${AMP[0] - 12} ${AMP[1] + 9} Z`} fill="var(--sp-control)" stroke="var(--sp-accent)" strokeLinejoin="round" />
      <text x={AMP[0] - 3} y={AMP[1] + 21} textAnchor="middle" className="sp-flow-text small" fill="var(--sp-fg3)">AMP</text>
    </svg>
  );
}
