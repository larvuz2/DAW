// The frequency response of a filter, measured from the real filter model (filterResponse runs the same code the
// voices do), and a handle on it: drag left/right for the cutoff, up/down for the resonance.
import { useEffect, useMemo, useRef } from 'react';
import { filterResponse } from '@greanteadawy/synth-dsp';
import { formatValue } from '../ui/Knob.jsx';
import { pixelRatio } from './displays.jsx';

const F_MIN = 20;
const F_MAX = 20000;
const DB_TOP = 30;
const DB_BOTTOM = -54;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** `look="page"`: the synth page's colours (violet curve with a gradient under it, labelled grid, glowing handle). */
export function FilterGraph({ type, cutoff, resonance, drive, morph, on = true, onChange, width = 236, height = 96, look }) {
  const page = look === 'page';
  const ref = useRef(null);
  const drag = useRef(null);
  const xOf = (hz) => (Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)) * width;
  const yOf = (db) => ((DB_TOP - clamp(db, DB_BOTTOM, DB_TOP)) / (DB_TOP - DB_BOTTOM)) * height;

  // one point every two pixels, plus the cutoff itself (the handle sits exactly on the curve)
  const curve = useMemo(() => {
    const freqs = [];
    for (let px = 0; px <= width; px += 2) freqs.push(F_MIN * Math.pow(F_MAX / F_MIN, px / width));
    freqs.push(clamp(cutoff, F_MIN, F_MAX));
    return { freqs, db: filterResponse({ type, cutoff, resonance, drive, morph }, freqs) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, Math.round(cutoff * 10), Math.round(resonance * 500), Math.round(drive * 200), Math.round(morph * 200), width]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = pixelRatio();
    cv.width = width * dpr;
    cv.height = height * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    g.globalAlpha = on ? 1 : 0.4;
    if (page) { drawPage(g, width, height, curve, cutoff, on, xOf, yOf); return; }
    // grid: decades and 0 dB
    g.lineWidth = 1;
    g.font = '8.5px ui-monospace, Menlo, monospace';
    g.fillStyle = 'rgba(255,255,255,0.32)';
    for (const [hz, text] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
      const x = Math.round(xOf(hz)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke();
      g.fillText(text, x + 3, height - 3);
    }
    for (const db of [-24, 0, 24]) {
      const y = Math.round(yOf(db)) + 0.5;
      g.strokeStyle = db === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.06)';
      g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke();
    }
    const n = curve.freqs.length - 1;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * 2;
      const y = yOf(curve.db[i]);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = '#f59f42';
    g.lineWidth = 1.8;
    g.lineJoin = 'round';
    g.stroke();
    g.lineTo(width, height); g.lineTo(0, height); g.closePath();
    g.fillStyle = 'rgba(245,159,66,0.13)';
    g.fill();
    // the handle
    const hx = xOf(clamp(cutoff, F_MIN, F_MAX));
    const hy = clamp(yOf(curve.db[n]), 6, height - 6);
    g.beginPath(); g.arc(hx, hy, 5, 0, Math.PI * 2);
    g.fillStyle = '#fff'; g.fill();
    g.strokeStyle = '#f59f42'; g.lineWidth = 2; g.stroke();
  });

  const move = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const px = clamp((e.clientX - d.left) * d.zoom + d.dx, 0, width);
    const hz = F_MIN * Math.pow(F_MAX / F_MIN, px / width);
    onChange({ cutoff: Math.round(hz * 10) / 10, resonance: clamp(Math.round((d.res + ((d.y - e.clientY) * d.zoom) / (height * 0.9)) * 1000) / 1000, 0, 1) });
  };
  const down = (e) => {
    // the left button (or a finger) only, and one pointer at a time
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    // (on a narrow screen the graph is drawn smaller than it is: `zoom` turns screen pixels into its own)
    const zoom = width / r.width;
    // grabbed near the handle: move it from where it is; anywhere else: the cutoff jumps to the pointer
    const hx = xOf(clamp(cutoff, F_MIN, F_MAX));
    const px = (e.clientX - r.left) * zoom;
    // (14 px of the screen around the handle, however small the graph is drawn)
    const near = Math.abs(px - hx) < 14 * zoom;
    drag.current = { pointer: e.pointerId, y: e.clientY, res: resonance, dx: near ? hx - px : 0, left: r.left, zoom };
    // a press on the handle that does not move changes nothing (and so adds no undo step, and rounds nothing)
    if (!near) move(e);
  };
  const up = (e) => { if (drag.current && e.pointerId === drag.current.pointer) drag.current = null; };
  const key = (e) => {
    const step = e.shiftKey ? 0.25 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') onChange({ cutoff: clamp(Math.round(cutoff * Math.pow(2, ((e.key === 'ArrowRight' ? 1 : -1) * step) / 12) * 10) / 10, F_MIN, F_MAX) });
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') onChange({ resonance: clamp(Math.round((resonance + (e.key === 'ArrowUp' ? 0.02 : -0.02) * step) * 1000) / 1000, 0, 1) });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="ggs-fgraph" style={{ width }}>
      <canvas ref={ref} style={{ width, aspectRatio: `${width} / ${height}` }} tabIndex={0} role="application" data-nodrag
        aria-label={`Filter response. Cutoff ${formatValue(cutoff, { unit: 'Hz' })}, resonance ${resonance.toFixed(2)}. Arrow keys: left and right move the cutoff, up and down the resonance.`}
        title="Measured response of this filter, 20 Hz – 20 kHz. Drag: left/right = cutoff, up/down = resonance."
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} />
      <span className="ggs-fgraph-read">{formatValue(cutoff, { unit: 'Hz' })} · res {resonance.toFixed(2)}</span>
    </div>
  );
}

/** The synth page's drawing: grid lines at every octave mark, dB labels, a gradient fill and a glowing cutoff handle. */
function drawPage(g, width, height, curve, cutoff, on, xOf, yOf) {
  const line = 'rgba(42,48,64,';
  g.lineWidth = 1;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(hz)) + 0.5;
    g.strokeStyle = `${line}${hz === 100 || hz === 1000 || hz === 10000 ? 0.9 : 0.4})`;
    g.beginPath(); g.moveTo(x, 4); g.lineTo(x, height - 12); g.stroke();
  }
  for (const db of [24, 12, 0, -12, -24, -36, -48]) {
    const y = Math.round(yOf(db)) + 0.5;
    g.strokeStyle = db === 0 ? 'rgba(58,66,87,0.95)' : `${line}0.45)`;
    g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke();
  }
  g.font = '500 8.5px ui-monospace, Menlo, monospace';
  g.fillStyle = '#5c6578';
  g.textAlign = 'center';
  for (const [hz, text] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(text, xOf(hz), height - 3);
  g.textAlign = 'left';
  g.fillText('+12', 4, yOf(12) - 2);
  g.fillText('0 dB', 4, yOf(0) - 2);
  g.fillText('−24', 4, yOf(-24) - 2);
  const n = curve.freqs.length - 1;
  const trace = () => {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const y = clamp(yOf(curve.db[i]), 2, height - 10);
      if (i) g.lineTo(i * 2, y); else g.moveTo(0, y);
    }
  };
  const tone = on ? '124,140,255' : '92,101,120';
  trace();
  g.lineTo(width, height - 10); g.lineTo(0, height - 10); g.closePath();
  const fill = g.createLinearGradient(0, 4, 0, height - 10);
  fill.addColorStop(0, `rgba(${tone},0.32)`);
  fill.addColorStop(1, `rgba(${tone},0.02)`);
  g.fillStyle = fill;
  g.fill();
  trace();
  g.lineJoin = 'round';
  g.strokeStyle = on ? '#96a3ff' : '#5c6578';
  g.lineWidth = 1.75;
  g.stroke();
  const hx = xOf(clamp(cutoff, F_MIN, F_MAX));
  const hy = clamp(yOf(curve.db[n]), 6, height - 12);
  g.fillStyle = `rgba(${tone},0.3)`;
  g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(hx, hy, 2.5, 0, Math.PI * 2); g.fill();
  g.font = '500 9px ui-monospace, Menlo, monospace';
  g.textAlign = 'right';
  g.fillStyle = '#9aa3b5';
  g.fillText(formatValue(cutoff, { unit: 'Hz' }), width - 4, 12);
}
