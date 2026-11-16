import { useRef, useState } from 'react';
import {
  EXPRESSION_RANGE, EXPRESSION_LABELS, curveValueAt, flattenCurve, sanitizeCurve, simplifyCurve, makeCurve, noteName, ticksToSeconds
} from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { capturePointer } from '../lib/hooks.js';
import { gesture } from '../lib/actions.js';
import { getEngine } from '../audio/index.js';

export const PITCH_RANGES = [2, 7, 12, 24, 48];
export const LANE_TOOLS = [['draw', 'Draw', 'Freehand: drag to draw the curve'], ['line', 'Line', 'Drag a straight line'], ['point', 'Points', 'Click to add a point, drag to move it, right-click to delete, Alt-click to change how it travels to the next point']];
export const LANE_SHAPES = [
  ['bend-up', 'Bend up'], ['bend-down', 'Bend down'], ['scoop', 'Scoop in'], ['fall', 'Fall off'], ['vibrato', 'Vibrato'],
  ['swell', 'Swell'], ['ramp-up', 'Ramp up'], ['ramp-down', 'Ramp down'], ['pulse', 'Pulse']
];
const PAD = 5; // px above and below the value range
const HIT = 7; // px: how close a click must be to grab a point

/** The curve a shape button makes for one note (rates in Hz become cycles for the note's length). */
export function shapeCurve(dim, shape, seconds) {
  const pitch = dim === 'pitch';
  switch (shape) {
    case 'bend-up': return makeCurve(dim, 'bend', { from: 0, to: pitch ? 2 : 1, start: 0.1, end: 0.6 });
    case 'bend-down': return makeCurve(dim, 'bend', pitch ? { from: 0, to: -2, start: 0.1, end: 0.6 } : { from: 1, to: 0, start: 0.1, end: 0.6 });
    case 'scoop': return makeCurve(dim, 'scoop', { depth: pitch ? 1 : 0.8, end: 0.2 });
    case 'fall': return makeCurve(dim, 'fall', { depth: pitch ? 3 : 1, start: 0.7 });
    case 'vibrato': return makeCurve(dim, 'vibrato', { depth: pitch ? 0.3 : 0.25, cycles: Math.max(1, 5.5 * seconds * 0.7), delay: 0.3, fade: 0.2 });
    case 'swell': return makeCurve(dim, 'swell', { from: pitch ? 0 : 0.1, peak: pitch ? 1 : 0.9, at: 0.5, to: pitch ? 0 : 0.15 });
    case 'ramp-up': return makeCurve(dim, 'ramp', { from: 0, to: pitch ? 2 : 1 });
    case 'ramp-down': return makeCurve(dim, 'ramp', pitch ? { from: 2, to: 0 } : { from: 1, to: 0 });
    case 'pulse': return makeCurve(dim, 'pulse', { from: 0, to: pitch ? 1 : 1, cycles: 4 });
    default: return null;
  }
}

/**
 * The expression lane under the piano roll: one curve per note for the chosen dimension (pitch, pressure or
 * timbre/"slide"), drawn over the note's own time span. Edits go to the selected notes — or, with nothing
 * selected, to the notes under the pointer — as one notes/expression op per gesture (one undo step).
 */
export function ExpressionLane({ dim, tool, range, notes, selected, ppt, width, height, color, channel, pattern, bpm }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [preview, setPreview] = useState(null); // Map noteId → curve (or null = removed) while dragging
  const [readout, setReadout] = useState('');
  const [lo, hi] = dim === 'pitch' ? [-range, range] : EXPRESSION_RANGE[dim];
  const H = height - PAD * 2;
  const yOf = (v) => PAD + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * H;
  const vOf = (y) => {
    const v = lo + (1 - (y - PAD) / H) * (hi - lo);
    return Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000;
  };
  const curveOf = (n) => (preview?.has(n.id) ? preview.get(n.id) : n.expression?.[dim]) || null;
  const xOf = (n, t) => (n.start + t * n.length) * ppt;

  const pos = (e) => {
    const r = ref.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, tick: (e.clientX - r.left) / ppt };
  };
  const pool = () => (selected.size ? notes.filter((n) => selected.has(n.id)) : notes);
  const under = (tick) => pool().filter((n) => tick >= n.start && tick <= n.start + n.length);

  /** The note a point edit belongs to: the one whose curve passes closest to the pointer. */
  const nearest = (p) => {
    const cands = under(p.tick);
    if (!cands.length) return null;
    let best = cands[0];
    let dist = Infinity;
    for (const n of cands) {
      const c = curveOf(n);
      const d = Math.abs(yOf(c ? curveValueAt(c, (p.tick - n.start) / n.length) : 0) - p.y);
      if (d < dist) { dist = d; best = n; }
    }
    return best;
  };

  const commit = (map) => {
    const updates = [...map].map(([id, curve]) => ({ id, expression: { [dim]: curve } }));
    if (!updates.length) return;
    useStore.getState().dispatch([{ type: 'notes/expression', patternId: pattern.id, channelId: channel.id, notes: updates }], { coalesce: gesture('pr-expr') });
    // hear it: one edited note is played back with its new performance
    if (updates.length === 1) {
      const n = notes.find((x) => x.id === updates[0].id);
      const eng = getEngine();
      if (n && eng && eng.ctx.state === 'running' && !useStore.getState().playing) {
        const seconds = ticksToSeconds(n.length, bpm);
        setTimeout(() => eng.triggerNote(channel.id, n.key, n.velocity, eng.ctx.currentTime + 0.01, Math.min(seconds, 3), {
          force: true, expression: { ...(n.expression || {}), [dim]: updates[0].expression[dim] || undefined }, exprSeconds: seconds, releaseVelocity: n.releaseVelocity ?? null
        }), 30);
      }
    }
  };

  /** Replace the part of each target note's curve that a stroke covers. stroke: [{ tick, v }] in drawing order. */
  const strokeCurves = (stroke, targets) => {
    const map = new Map();
    const t0 = Math.min(...stroke.map((s) => s.tick));
    const t1 = Math.max(...stroke.map((s) => s.tick));
    const sorted = [...stroke].sort((a, b) => a.tick - b.tick);
    for (const n of targets) {
      const a = Math.max(0, (t0 - n.start) / n.length);
      const b = Math.min(1, (t1 - n.start) / n.length);
      if (b < 0 || a > 1) continue;
      const old = n.expression?.[dim] || [];
      // a note without a curve starts from rest, so drawing its second half makes a ramp, not a jump
      const kept = old.length ? old.filter((p) => p.t < a - 1e-4 || p.t > b + 1e-4) : a > 0.02 ? [{ t: 0, v: 0 }] : [];
      const drawn = sorted.filter((s) => s.tick >= n.start && s.tick <= n.start + n.length).map((s) => ({ t: (s.tick - n.start) / n.length, v: s.v }));
      if (!drawn.length) continue;
      // only the stroke is thinned (to about a pixel of the lane): the curve outside it keeps every point it had
      const stroke = simplifyCurve(drawn, ((hi - lo) / H) * 0.8);
      map.set(n.id, sanitizeCurve(dim, [...kept, ...stroke].sort((p, q) => p.t - q.t)));
    }
    return map;
  };

  const onPointerDown = (e) => {
    if (e.button === 1) return;
    useStore.getState().unlockAudio();
    const p = pos(e);
    capturePointer(e);
    // right-click (any tool): delete the point under the pointer
    if (e.button === 2 || tool === 'point') {
      const n = nearest(p);
      if (!n) return;
      const curve = (n.expression?.[dim] || []).map((x) => ({ ...x }));
      let index = curve.findIndex((pt) => Math.hypot(xOf(n, pt.t) - p.x, yOf(pt.v) - p.y) <= HIT);
      if (e.button === 2) {
        e.preventDefault();
        if (index >= 0) { curve.splice(index, 1); commit(new Map([[n.id, sanitizeCurve(dim, curve)]])); }
        return;
      }
      if (index >= 0 && e.altKey) {
        // how this point travels to the next: straight → eased → hold-then-jump
        const next = { undefined: 'smooth', smooth: 'hold', hold: undefined }[curve[index].c];
        if (next) curve[index].c = next; else delete curve[index].c;
        commit(new Map([[n.id, sanitizeCurve(dim, curve)]]));
        return;
      }
      if (index < 0) {
        const t = Math.max(0, Math.min(1, (p.tick - n.start) / n.length));
        // the first point of a new curve gets a rest point at the note start, so it bends in rather than jumps
        if (!curve.length && t > 0.02) curve.push({ t: 0, v: 0 });
        curve.push({ t: Math.round(t * 1000) / 1000, v: vOf(p.y) });
        curve.sort((x, y) => x.t - y.t);
        index = curve.findIndex((pt) => Math.abs(pt.t - Math.round(t * 1000) / 1000) < 1e-6 && pt.v === vOf(p.y));
      }
      drag.current = { mode: 'point', note: n, curve, index };
      setPreview(new Map([[n.id, curve]]));
      return;
    }
    const targets = selected.size ? pool() : under(p.tick);
    if (!targets.length) return;
    drag.current = { mode: tool, start: { tick: p.tick, v: vOf(p.y) }, stroke: [{ tick: p.tick, v: vOf(p.y) }], targets, sticky: selected.size > 0 };
  };

  const onPointerMove = (e) => {
    const p = pos(e);
    const d = drag.current;
    const hover = nearest(p);
    const v = vOf(p.y);
    setReadout(hover ? `${noteName(hover.key)} · ${dim === 'pitch' ? `${v > 0 ? '+' : ''}${v.toFixed(2)} st` : v.toFixed(2)} @ ${Math.round(Math.max(0, Math.min(1, (p.tick - hover.start) / hover.length)) * 100)}%` : '');
    if (!d) return;
    if (d.mode === 'point') {
      const n = d.note;
      const curve = d.curve.map((x) => ({ ...x }));
      const prev = curve[d.index - 1]?.t ?? 0;
      const next = curve[d.index + 1]?.t ?? 1;
      const t = Math.max(prev, Math.min(next, (p.tick - n.start) / n.length));
      curve[d.index] = { ...curve[d.index], t: Math.round(t * 1000) / 1000, v };
      d.result = curve;
      setPreview(new Map([[n.id, curve]]));
      return;
    }
    if (d.mode === 'line') d.stroke = [d.start, { tick: p.tick, v }];
    else d.stroke.push({ tick: p.tick, v });
    // with nothing selected, a stroke that runs on over the next notes shapes them too (a swell across a phrase)
    if (!d.sticky) for (const n of under(p.tick)) if (!d.targets.includes(n)) d.targets.push(n);
    d.result = strokeCurves(d.stroke, d.targets);
    setPreview(d.result);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setPreview(null);
    if (!d) return;
    if (d.mode === 'point') commit(new Map([[d.note.id, sanitizeCurve(dim, d.result || d.curve)]]));
    else if (d.result) commit(d.result);
  };

  const editable = new Set((selected.size ? pool() : notes).map((n) => n.id));
  const zeroY = yOf(0);
  const guides = dim === 'pitch' ? (range <= 12 ? Array.from({ length: range * 2 + 1 }, (_, i) => i - range) : [-range, -range / 2, 0, range / 2, range]) : [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className={`pr-expr-lane tool-${tool}`} ref={ref} style={{ width, height }} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={() => setReadout('')} onContextMenu={(e) => e.preventDefault()}
      role="application" aria-label={`${EXPRESSION_LABELS[dim]} curves`}>
      <div className="pr-expr-readout">{readout && <span>{readout}</span>}</div>
      <svg width={width} height={height} className="pr-expr-svg">
        {guides.map((g) => <line key={g} x1={0} x2={width} y1={yOf(g)} y2={yOf(g)} className={g === 0 ? 'zero' : 'guide'} />)}
        {notes.map((n) => {
          const curve = curveOf(n);
          const on = editable.has(n.id);
          const x0 = n.start * ppt;
          const x1 = (n.start + n.length) * ppt;
          if (!curve) return <line key={n.id} x1={x0} x2={x1} y1={zeroY} y2={zeroY} className={`span ${on ? 'on' : ''}`} style={on ? { stroke: color } : undefined} />;
          const flat = flattenCurve(curve);
          const pts = [[x0, yOf(flat[0].v)], ...flat.map((p) => [xOf(n, p.t), yOf(p.v)]), [x1, yOf(flat[flat.length - 1].v)]];
          const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
          return (
            <g key={n.id} className={`curve ${on ? 'on' : ''}`} style={{ '--c': color }}>
              <polygon points={`${x0},${zeroY} ${line} ${x1},${zeroY}`} className="fill" />
              <polyline points={line} className="line" />
              {on && (tool === 'point' || selected.has(n.id)) && curve.map((p, i) => (
                p.c === 'hold'
                  ? <rect key={i} x={xOf(n, p.t) - 3} y={yOf(p.v) - 3} width={6} height={6} className="pt" />
                  : <circle key={i} cx={xOf(n, p.t)} cy={yOf(p.v)} r={3.2} className={`pt ${p.c === 'smooth' ? 'smooth' : ''}`} />
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
