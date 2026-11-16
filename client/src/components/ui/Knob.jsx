import { useRef, useCallback, useEffect, useState } from 'react';
import { onFrame } from './frames.js';

// 'log' needs min > 0; 'cube' is for ranges that start at zero (times): fine steps near the bottom, coarse at the top
function toNorm(v, min, max, curve) {
  if (curve === 'log' && min > 0) return Math.log(v / min) / Math.log(max / min);
  if (curve === 'cube') return Math.cbrt((v - min) / (max - min));
  return (v - min) / (max - min);
}
function fromNorm(n, min, max, curve) {
  if (curve === 'log' && min > 0) return min * Math.pow(max / min, n);
  if (curve === 'cube') return min + (max - min) * n * n * n;
  return min + (max - min) * n;
}

export function formatValue(v, { unit, step } = {}) {
  if (typeof v !== 'number') return String(v);
  let s;
  if (unit === 'Hz' && v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz`;
  if (unit === 's' && v < 1) return `${Math.round(v * 1000)} ms`;
  if (step && step >= 1) s = String(Math.round(v));
  else if (Math.abs(v) >= 100) s = v.toFixed(0);
  else if (Math.abs(v) >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

/** Hook: throttle a callback to one call per animation frame (last value wins). */
export function useRafCallback(fn) {
  const pending = useRef(null);
  const frame = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return useCallback((...args) => {
    pending.current = args;
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const a = pending.current;
        pending.current = null;
        if (a) fnRef.current(...a);
      });
    }
  }, []);
}

/** What a dragged modulation source carries (see the synth editor's source bar). */
export const SOURCE_MIME = 'application/x-ggs-source';

/**
 * Rotary knob. Drag up/down (Shift = fine), wheel to nudge, double-click to reset.
 *
 * A knob that something modulates can show it:
 *   rings      [{ lo, hi, color }] in the knob's own units — one thin arc per modulation route, outside the track
 *   live       () => value | null, asked every animation frame — a bright dot where the control really is right now
 *   onAltDrag  (delta) — Alt + drag changes a modulation depth instead of the value (delta in knob travel, 0..1)
 *   onDropSource (id)  — a modulation source was dropped on the knob
 *   onContextMenu
 */
export function Knob({
  value, min = 0, max = 1, curve, def, step, onChange, size = 30, label, unit, color = 'var(--accent)',
  bipolar = false, title, disabled = false, showValue = false, rings, live, onAltDrag, onDropSource, onContextMenu, className = ''
}) {
  const ref = useRef(null);
  const drag = useRef(null);
  const dot = useRef(null);
  const altMove = useRef(0);
  const [over, setOver] = useState(false);
  const emit = useRafCallback((v) => onChange?.(v));
  const emitAlt = useRafCallback(() => { const d = altMove.current; altMove.current = 0; if (d) onAltDrag?.(d); });
  const n = Math.max(0, Math.min(1, toNorm(value ?? 0, min, max, curve)));

  const setNorm = (nn) => {
    let v = fromNorm(Math.max(0, Math.min(1, nn)), min, max, curve);
    if (step) v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    emit(v);
  };

  const onPointerDown = (e) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, n, alt: e.altKey && !!onAltDrag };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    if (drag.current.alt) {
      altMove.current += (drag.current.y - e.clientY) / (e.shiftKey ? 800 : 160);
      drag.current.y = e.clientY;
      emitAlt();
      return;
    }
    const dy = drag.current.y - e.clientY;
    setNorm(drag.current.n + dy / (e.shiftKey ? 800 : 160));
  };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e) => {
    if (disabled) return;
    e.stopPropagation();
    setNorm(n + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.03));
  };
  const onDoubleClick = () => {
    if (!disabled && def !== undefined) onChange?.(def);
  };
  const onKeyDown = (e) => {
    if (disabled) return;
    const fine = e.shiftKey ? 0.005 : 0.02;
    const moves = { ArrowUp: fine, ArrowRight: fine, ArrowDown: -fine, ArrowLeft: -fine, PageUp: 0.1, PageDown: -0.1 };
    if (e.key in moves) setNorm(n + moves[e.key]);
    else if (e.key === 'Home') setNorm(0);
    else if (e.key === 'End') setNorm(1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && def !== undefined) onChange?.(def);
    else return;
    e.preventDefault();
    e.stopPropagation(); // don't trigger studio shortcuts while adjusting a control
  };

  const r = size / 2 - 3;
  const c = size / 2;
  const a0 = 135;
  const sweep = 270;
  const angle = a0 + sweep * n;
  const pt = (deg, rad = r) => [c + rad * Math.cos((deg * Math.PI) / 180), c + rad * Math.sin((deg * Math.PI) / 180)];
  const arc = (from, to) => {
    if (Math.abs(to - from) < 0.01) return '';
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweepFlag = to > from ? 1 : 0;
    return `M${x1} ${y1} A${r} ${r} 0 ${large} ${sweepFlag} ${x2} ${y2}`;
  };
  const centerA = a0 + sweep / 2;
  const valueArc = bipolar ? (angle >= centerA ? arc(centerA, angle) : arc(angle, centerA)) : arc(a0, angle);
  const [px, py] = pt(angle, r - 3);
  const tip = title || `${label ? `${label}: ` : ''}${formatValue(value, { unit, step })}`;
  const angleOf = (v) => a0 + sweep * Math.max(0, Math.min(1, toNorm(v, min, max, curve)));
  /** An arc on its own radius (the modulation rings sit outside the track). */
  const ringPath = (rad, from, to) => {
    if (to - from < 3) { const mid = (from + to) / 2; from = mid - 1.5; to = mid + 1.5; } // a clipped range still shows as a tick
    const [x1, y1] = pt(from, rad);
    const [x2, y2] = pt(to, rad);
    return `M${x1} ${y1} A${rad} ${rad} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };

  // the live dot follows the audio thread without re-rendering: one attribute write per frame, when it moved
  useEffect(() => {
    if (!live) return undefined;
    let shown = null;
    return onFrame(() => {
      const el = dot.current;
      if (!el) return;
      const v = live();
      const at = v === null || v === undefined || Number.isNaN(v) ? null : Math.round(Math.max(0, Math.min(1, toNorm(v, min, max, curve))) * 500) / 500;
      if (at === shown) return;
      shown = at;
      if (at === null) { el.style.display = 'none'; return; }
      const deg = ((a0 + sweep * at) * Math.PI) / 180;
      el.setAttribute('cx', c + r * Math.cos(deg));
      el.setAttribute('cy', c + r * Math.sin(deg));
      el.style.display = '';
    });
  }, [live, min, max, curve, c, r]);

  const dragOver = (e) => {
    if (!onDropSource || disabled || !e.dataTransfer.types.includes(SOURCE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    if (!over) setOver(true);
  };
  const dropped = (e) => {
    setOver(false);
    const source = e.dataTransfer.getData(SOURCE_MIME);
    if (!source || !onDropSource || disabled) return;
    e.preventDefault();
    onDropSource(source);
  };

  return (
    <div className={`knob ${disabled ? 'disabled' : ''} ${onDropSource ? 'assignable' : ''} ${over ? 'drop' : ''} ${rings?.length ? 'modulated' : ''} ${className}`} title={tip} role="slider" tabIndex={disabled ? -1 : 0}
      aria-label={label || title || 'Knob'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={typeof value === 'number' ? value : undefined}
      aria-valuetext={formatValue(value, { unit, step })} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}
      onContextMenu={onContextMenu} onDragOver={dragOver} onDragLeave={() => setOver(false)} onDrop={dropped}>
      <svg ref={ref} width={size} height={size} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} onDoubleClick={onDoubleClick}>
        <path d={arc(a0, a0 + sweep)} stroke="var(--knob-track)" strokeWidth="3" fill="none" strokeLinecap="round" />
        {valueArc && <path d={valueArc} stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />}
        <circle cx={c} cy={c} r={r - 4} fill="var(--knob-face)" />
        <line x1={c} y1={c} x2={px} y2={py} stroke="var(--knob-pointer)" strokeWidth="2" strokeLinecap="round" />
        {rings?.slice(0, 3).map((ring, i) => (
          <path key={i} className="knob-ring" d={ringPath(r + 3.6 + i * 2.6, angleOf(ring.lo), angleOf(ring.hi))} stroke={ring.color} strokeWidth="1.7" fill="none" strokeLinecap="round" />
        ))}
        {live && <circle ref={dot} className="knob-live" r="2.3" style={{ display: 'none' }} />}
      </svg>
      {label && <div className="knob-label">{label}</div>}
      {showValue && <div className="knob-value">{formatValue(value, { unit, step })}</div>}
    </div>
  );
}
