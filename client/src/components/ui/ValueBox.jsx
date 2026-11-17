// A number in a small box with its name above it (Oct, Semi, Fine, Poly, Glide on the synth page): drag up or down
// (Shift = fine), wheel, arrow keys, double-click for the default. A bar along the bottom shows where the value sits
// in its range, and one thin bar per modulation route above it. It takes dropped modulation sources like a knob.
import { useRef, useState } from 'react';
import { formatValue, useRafCallback, SOURCE_MIME } from './Knob.jsx';

const toNorm = (v, min, max, curve) => (curve === 'log' && min > 0 ? Math.log(v / min) / Math.log(max / min) : curve === 'cube' ? Math.cbrt((v - min) / (max - min)) : (v - min) / (max - min));
const fromNorm = (n, min, max, curve) => (curve === 'log' && min > 0 ? min * Math.pow(max / min, n) : curve === 'cube' ? min + (max - min) * n * n * n : min + (max - min) * n);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function ValueBox({
  value, min = 0, max = 1, curve, step, def, label, unit, width = 48, onChange, rings, ringColor, onDropSource, onContextMenu,
  title, color = 'var(--sp-accent)', format, disabled = false, className = ''
}) {
  const drag = useRef(null);
  const [over, setOver] = useState(false);
  const emit = useRafCallback((v) => onChange?.(v));
  const n = clamp01(toNorm(value ?? 0, min, max, curve));
  const at = useRef(n);
  at.current = n;
  const setNorm = (nn) => {
    at.current = clamp01(nn);
    let v = fromNorm(at.current, min, max, curve);
    if (step) v = Math.round(v / step) * step;
    emit(Math.max(min, Math.min(max, v)));
  };
  const text = format ? format(value) : formatValue(value, { unit, step });
  const zero = min < 0 ? clamp01(toNorm(0, min, max, curve)) : 0;
  const norm = (v) => clamp01(toNorm(v, min, max, curve));
  return (
    <div className={`vbox ${over ? 'drop' : ''} ${disabled ? 'disabled' : ''} ${className}`} style={{ width }} role="slider" tabIndex={disabled ? -1 : 0}
      title={title || `${label}: ${text}`} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={typeof value === 'number' ? value : undefined} aria-valuetext={text}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, n };
      }}
      onPointerMove={(e) => { if (drag.current) setNorm(drag.current.n + (drag.current.y - e.clientY) / (e.shiftKey ? 900 : 180)); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onWheel={(e) => { if (disabled) return; e.stopPropagation(); setNorm(at.current + (e.deltaY < 0 ? 1 : -1) * (step ? step / (max - min) : e.shiftKey ? 0.005 : 0.03)); }}
      onDoubleClick={() => { if (!disabled && def !== undefined) onChange?.(def); }}
      onKeyDown={(e) => {
        if (disabled) return;
        const unitStep = step ? step / (max - min) : e.shiftKey ? 0.005 : 0.02;
        const moves = { ArrowUp: unitStep, ArrowRight: unitStep, ArrowDown: -unitStep, ArrowLeft: -unitStep };
        if (e.key in moves) setNorm(at.current + moves[e.key]);
        else if ((e.key === 'Delete' || e.key === 'Backspace') && def !== undefined) onChange?.(def);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (!onDropSource || !e.dataTransfer.types.includes(SOURCE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const source = e.dataTransfer.getData(SOURCE_MIME);
        if (!source || !onDropSource) return;
        e.preventDefault();
        onDropSource(source);
      }}>
      {label && <span className="vbox-label">{label}</span>}
      <span className="vbox-value">{text}</span>
      <span className="vbox-track" />
      <span className="vbox-bar" style={{ left: `${Math.min(zero, n) * 100}%`, width: `${Math.max(2, Math.abs(n - zero) * 100)}%`, background: color }} />
      {rings?.slice(0, 3).map((r, i) => {
        const a = norm(r.lo);
        const b = norm(r.hi);
        return <span key={i} className="vbox-route" style={{ bottom: 3 + i * 3, left: `${a * 100}%`, width: `${Math.max(3, (b - a) * 100)}%`, background: ringColor ? ringColor(r) : r.color }} />;
      })}
    </div>
  );
}
