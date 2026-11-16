// An LFO shape you draw: up to sixteen bars, dragged with the pointer (drag across them to draw a line of steps).
// The curve on top is what the LFO will do with the current smoothing — the engine's own formula.
import { useRef } from 'react';
import { stepShape } from '@greanteadawy/synth-dsp';

const W = 300;
const H = 64;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const y = (v) => H / 2 - v * (H / 2 - 3);

export function StepEditor({ steps, smooth, onDraw, color = '#5ab8f0', label = 'LFO' }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const n = steps.length;
  const bw = W / n;
  const at = (e) => {
    const r = ref.current.getBoundingClientRect();
    const k = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
    const v = clamp(1 - (2 * (e.clientY - r.top)) / r.height, -1, 1);
    // (a little snap to the middle: a step of exactly 0 is hard to hit otherwise)
    return [k, Math.abs(v) < 0.04 ? 0 : Math.round(v * 100) / 100];
  };
  const down = (e) => {
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    drawing.current = true;
    onDraw(...at(e));
  };
  const move = (e) => { if (drawing.current) onDraw(...at(e)); };
  const up = () => { drawing.current = false; };
  const key = (k) => (e) => {
    const d = { ArrowUp: 0.05, ArrowDown: -0.05, PageUp: 0.25, PageDown: -0.25 }[e.key];
    if (d) onDraw(k, clamp(Math.round((steps[k] + d) * 100) / 100, -1, 1));
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') ref.current.querySelectorAll('rect.bar')[clamp(k + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1)]?.focus();
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '0') onDraw(k, 0);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const curve = Array.from({ length: 151 }, (_, i) => `${i ? 'L' : 'M'}${((i / 150) * W).toFixed(1)} ${y(stepShape(steps, n, smooth, Math.min(0.99999, i / 150))).toFixed(1)}`).join('');
  return (
    <svg ref={ref} className="ggs-steps" viewBox={`0 0 ${W} ${H}`} style={{ '--c': color }} data-nodrag role="group"
      aria-label={`${label}: the drawn shape, ${n} steps. Drag to draw; arrow keys change the focused step.`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <line className="zero" x1="0" x2={W} y1={H / 2} y2={H / 2} />
      {steps.map((v, k) => (
        <rect key={k} className="bar" x={k * bw + 1} width={Math.max(1, bw - 2)} y={Math.min(y(v), H / 2)} height={Math.max(1.5, Math.abs(y(v) - H / 2))} rx="1"
          tabIndex={0} role="slider" aria-label={`Step ${k + 1}`} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={v} onKeyDown={key(k)}>
          <title>{`Step ${k + 1}: ${v > 0 ? '+' : ''}${v.toFixed(2)}`}</title>
        </rect>
      ))}
      <path className="shape" d={curve} />
    </svg>
  );
}
