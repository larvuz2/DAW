// Per-note expression: every note can carry its own pitch, pressure and timbre ("slide") curve plus a release
// velocity — the dimensions of an MPE performance, stored with the note so they work without an MPE keyboard.
//
//   note.expression = { pitch: [{ t, v, c? }], pressure: [...], timbre: [...] }
//
// t is normalized note time (0 = note start, 1 = note end), so moving, resizing, duplicating or quantizing a note
// keeps its performance. v is semitones for pitch (-48..48) and 0..1 for pressure and timbre. c is how the curve
// travels to the NEXT point: absent = straight line, 'smooth' = eased (S-curve), 'hold' = stay, then jump.
// A dimension without a curve rests at 0. Before the first point a curve holds its first value, after the last
// point its last value (which is also what a release tail hears).
import { clamp } from './constants.js';
import { didYouMean } from './suggest.js';

export const EXPRESSION_DIMS = ['pitch', 'pressure', 'timbre'];
export const EXPRESSION_RANGE = { pitch: [-48, 48], pressure: [0, 1], timbre: [0, 1] };
export const EXPRESSION_LABELS = { pitch: 'Pitch', pressure: 'Pressure', timbre: 'Slide' };
export const EXPRESSION_UNITS = { pitch: 'st', pressure: '', timbre: '' };
export const CURVE_TYPES = ['linear', 'smooth', 'hold'];
/** Per curve: plenty for a hand-drawn gesture (freehand input is simplified to fit), bounded for the server. */
export const MAX_EXPRESSION_POINTS = 64;
/**
 * The most points of an incoming curve that are looked at: longer input is thinned evenly first. Simplifying is
 * quadratic on adversarial input (a zig-zag), and curves arrive from the network — this bounds the work per curve.
 */
export const MAX_INPUT_POINTS = 512;

const r4 = (x) => Math.round(x * 10000) / 10000;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Clean one curve: finite points, in range, sorted by time (two points may share a time: a jump). Returns null for
 * "no curve" — nothing usable, or every point at the rest value 0 (which is what no curve means).
 */
export function sanitizeCurve(dim, points) {
  const range = EXPRESSION_RANGE[dim];
  if (!range || !Array.isArray(points) || !points.length) return null;
  if (points.length > MAX_INPUT_POINTS) {
    const step = (points.length - 1) / (MAX_INPUT_POINTS - 1);
    points = Array.from({ length: MAX_INPUT_POINTS }, (_, i) => points[Math.round(i * step)]);
  }
  const out = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const t = typeof p.t === 'number' ? p.t : parseFloat(p.t);
    const v = typeof p.v === 'number' ? p.v : parseFloat(p.v);
    if (!finite(t) || !finite(v)) continue;
    const pt = { t: r4(clamp(t, 0, 1)), v: r4(clamp(v, range[0], range[1])) };
    if (p.c === 'smooth' || p.c === 'hold') pt.c = p.c;
    out.push(pt);
  }
  if (!out.length) return null;
  // stable sort: points at the same time keep their order (first = value before the jump, last = after)
  const sorted = out.map((p, i) => [p, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([p]) => p);
  const kept = sorted.length > MAX_EXPRESSION_POINTS ? simplifyCurve(sorted, 0, MAX_EXPRESSION_POINTS) : sorted;
  if (kept.every((p) => p.v === 0)) return null;
  delete kept[kept.length - 1].c; // the last point leads nowhere
  return kept;
}

/** Clean a note's expression object. Returns undefined when nothing is left (the note has no expression). */
export function sanitizeExpression(expr) {
  if (!expr || typeof expr !== 'object') return undefined;
  let out;
  for (const dim of EXPRESSION_DIMS) {
    if (expr[dim] === undefined || expr[dim] === null) continue;
    // { points: [...] } is accepted too (the shape used in patch/expression documents)
    const curve = sanitizeCurve(dim, Array.isArray(expr[dim]) ? expr[dim] : expr[dim]?.points);
    if (curve) (out ||= {})[dim] = curve;
  }
  return out;
}

const ease = (x) => x * x * (3 - 2 * x); // smoothstep: zero slope at both ends, so chained points make a wave

/** Value of a curve at normalized time t. `points` is a sanitized curve; no curve = 0. */
export function curveValueAt(points, t) {
  if (!points?.length) return 0;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (t < b.t) {
      const a = points[i - 1];
      if (a.c === 'hold') return a.v;
      const x = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * (a.c === 'smooth' ? ease(x) : x);
    }
  }
  return points[points.length - 1].v;
}

/**
 * The curve as straight segments only: [{ t, v }] breakpoints that linear ramps reproduce (what the audio engine
 * schedules and the editor draws). Smooth segments are cut into `smoothSteps` pieces; a hold becomes a jump.
 */
export function flattenCurve(points, { smoothSteps = 12 } = {}) {
  if (!points?.length) return [];
  const out = [{ t: points[0].t, v: points[0].v }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.c === 'hold') {
      out.push({ t: b.t, v: a.v });
    } else if (a.c === 'smooth' && b.t > a.t && a.v !== b.v) {
      for (let k = 1; k < smoothSteps; k++) {
        const x = k / smoothSteps;
        out.push({ t: a.t + (b.t - a.t) * x, v: a.v + (b.v - a.v) * ease(x) });
      }
    }
    out.push({ t: b.t, v: b.v });
  }
  return out;
}

/**
 * Reduce a dense polyline (a freehand stroke) to the points that matter: Ramer–Douglas–Peucker with `tolerance`
 * in value units, then — if still over `maxPoints` — the tolerance is raised until it fits.
 */
export function simplifyCurve(points, tolerance = 0.01, maxPoints = MAX_EXPRESSION_POINTS) {
  if (!points || points.length <= 2) return points ? points.map((p) => ({ ...p })) : [];
  const run = (tol) => {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      const a = points[lo];
      const b = points[hi];
      let worst = -1;
      let dist = tol;
      for (let i = lo + 1; i < hi; i++) {
        const p = points[i];
        // vertical distance to the chord: what you'd hear, and stable for the time-sorted points of a curve
        const expect = b.t === a.t ? a.v : a.v + (b.v - a.v) * ((p.t - a.t) / (b.t - a.t));
        const d = Math.abs(p.v - expect);
        if (d > dist) { dist = d; worst = i; }
      }
      if (worst > 0) { keep[worst] = 1; stack.push([lo, worst], [worst, hi]); }
    }
    return points.filter((_, i) => keep[i]);
  };
  let tol = Math.max(0, tolerance);
  let out = run(tol);
  // a few doublings reach any useful tolerance; what still doesn't fit is thinned evenly below
  for (let guard = 0; out.length > maxPoints && guard < 12; guard++) {
    tol = tol > 0 ? tol * 2 : 0.001;
    out = run(tol);
  }
  if (out.length > maxPoints) {
    // pathological input (e.g. alternating extremes): keep an even selection
    const pick = [];
    for (let i = 0; i < maxPoints; i++) pick.push(out[Math.round((i * (out.length - 1)) / (maxPoints - 1))]);
    out = pick;
  }
  return out.map((p) => ({ ...p }));
}

/** The part of a curve between t0 and t1 as a curve of its own (0..1 again): for splitting or trimming notes. */
export function sliceCurve(points, t0, t1) {
  if (!points?.length || !(t1 > t0)) return null;
  const flat = flattenCurve(points);
  const out = [{ t: 0, v: curveValueAt(points, t0) }];
  for (const p of flat) if (p.t > t0 && p.t < t1) out.push({ t: (p.t - t0) / (t1 - t0), v: p.v });
  out.push({ t: 1, v: curveValueAt(points, t1) });
  return out;
}

/**
 * Change a curve as a whole. ops (applied in this order): reverse (in time), invert (mirror: around 0 for pitch,
 * around 0.5 for pressure/timbre), scale (× values), offset (+ values), smooth (0..1: round the corners),
 * timeScale + timeOffset (squeeze/shift inside the note). Returns a sanitized curve or null.
 */
export function transformCurve(dim, points, { scale = 1, offset = 0, invert = false, reverse = false, smooth = 0, timeScale = 1, timeOffset = 0 } = {}) {
  if (!points?.length) return null;
  let pts = points.map((p) => ({ ...p }));
  if (reverse) {
    // a segment's shape belongs to its first point: after mirroring, to the point that now comes first
    pts = [];
    const last = points.length - 1;
    for (let j = last; j >= 0; j--) {
      const p = points[j];
      const owner = points[j - 1]; // owns the segment that now follows p
      const q = { t: 1 - p.t, v: p.v };
      if (owner?.c === 'hold') {
        // a mirrored hold jumps first, then stays. When what arrives at p is itself a hold (or nothing), p's own
        // value is never heard: one point is enough — a mirrored pulse train keeps its point count
        if (j !== last && p.c !== 'hold') pts.push(q);
        pts.push({ t: q.t, v: owner.v, c: 'hold' });
      } else {
        if (owner?.c === 'smooth') q.c = 'smooth';
        pts.push(q);
      }
    }
  }
  const mid = dim === 'pitch' ? 0 : 0.5;
  for (const p of pts) {
    if (invert) p.v = 2 * mid - p.v;
    p.v = p.v * scale + offset;
  }
  if (timeScale !== 1 || timeOffset !== 0) {
    // re-time on the flattened curve, then cut it at the note's edges: points pushed outside the note must not
    // pile up at 0 or 1 (the release would hear the wrong value)
    const moved = flattenCurve(pts).map((p) => ({ t: p.t * timeScale + timeOffset, v: p.v }));
    const at = (t) => {
      if (t <= moved[0].t) return moved[0].v;
      for (let i = 1; i < moved.length; i++) {
        if (t < moved[i].t) { const a = moved[i - 1]; const b = moved[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1)); }
      }
      return moved[moved.length - 1].v;
    };
    pts = [{ t: Math.max(0, Math.min(1, moved[0].t)), v: at(Math.max(0, moved[0].t)) }, ...moved.filter((p) => p.t > 0 && p.t < 1)];
    const end = moved[moved.length - 1].t;
    pts.push({ t: Math.max(0, Math.min(1, end)), v: at(Math.min(1, end)) });
  }
  if (smooth > 0) {
    // resample, then a moving average whose width grows with `smooth` (up to a quarter of the note)
    const N = 96;
    const src = sanitizeCurve(dim, pts) || [{ t: 0, v: 0 }];
    const raw = Array.from({ length: N + 1 }, (_, i) => curveValueAt(src, i / N));
    const w = Math.max(1, Math.round(clamp(smooth, 0, 1) * N * 0.125));
    const sm = raw.map((_, i) => {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(N, i + w); k++) { s += raw[k]; n++; }
      return { t: i / N, v: s / n };
    });
    const range = EXPRESSION_RANGE[dim];
    pts = simplifyCurve(sm, (range[1] - range[0]) * 0.002);
  }
  return sanitizeCurve(dim, pts);
}

/**
 * Ready-made gestures. Every shape returns a sanitized curve (or null when it would be flat at 0).
 *   bend     from → to between `start` and `end` of the note (eased), holding `to` after
 *   scoop    start `depth` below (pitch) / at 0 and arrive by `end` — how singers and guitarists reach a note
 *   fall     leave the note at `start`, dropping by `depth` at the end
 *   vibrato  `cycles` waves of ±depth (pitch) or depth (0..1 dims, around `center`), fading in after `delay`
 *   swell    rise to `peak` at `at` and fall back to `to`
 *   ramp     straight line from → to over the whole note
 *   pulse    `cycles` on/off steps between from and to (tremolo gates, rhythmic slides)
 */
export function makeCurve(dim, shape, o = {}) {
  const range = EXPRESSION_RANGE[dim];
  if (!range) throw new Error(`Unknown expression dimension "${dim}". Use ${EXPRESSION_DIMS.join(', ')}`);
  const pitch = dim === 'pitch';
  const n = (x, d) => (finite(x) ? x : d);
  const from = n(o.from, 0);
  const to = n(o.to, pitch ? 2 : 1);
  const start = clamp(n(o.start, 0), 0, 1);
  const end = clamp(n(o.end, 1), start, 1);
  let pts;
  switch (shape) {
    case 'ramp':
      pts = [{ t: 0, v: from }, { t: 1, v: to }];
      break;
    case 'bend':
      pts = [{ t: 0, v: from }, { t: start, v: from, c: 'smooth' }, { t: end, v: to }, { t: 1, v: to }];
      break;
    case 'scoop': {
      const depth = Math.abs(n(o.depth, pitch ? 2 : 1));
      const arrive = clamp(n(o.end, 0.2), 0.01, 1);
      pts = pitch
        ? [{ t: 0, v: -depth, c: 'smooth' }, { t: arrive, v: 0 }]
        : [{ t: 0, v: 0, c: 'smooth' }, { t: arrive, v: depth }];
      break;
    }
    case 'fall': {
      const depth = Math.abs(n(o.depth, pitch ? 3 : 1));
      const leave = clamp(n(o.start, 0.75), 0, 0.99);
      const base = pitch ? 0 : n(o.from, 1);
      pts = [{ t: 0, v: base }, { t: leave, v: base, c: 'smooth' }, { t: 1, v: pitch ? -depth : Math.max(0, base - depth) }];
      break;
    }
    case 'swell': {
      const peak = n(o.peak, pitch ? 1 : 1);
      const at = clamp(n(o.at, 0.5), 0.01, 0.99);
      pts = [{ t: 0, v: from, c: 'smooth' }, { t: at, v: peak, c: 'smooth' }, { t: 1, v: n(o.to, from) }];
      break;
    }
    case 'vibrato': {
      const depth = Math.abs(n(o.depth, pitch ? 0.3 : 0.25));
      // two points per wave (crest, trough) joined by eased segments: close to a sine
      const cycles = clamp(n(o.cycles, 6), 0.5, (MAX_EXPRESSION_POINTS - 4) / 2);
      const delay = clamp(n(o.delay, 0.25), 0, 0.95);
      const fade = clamp(n(o.fade, 0.2), 0, 1 - delay);
      const center = pitch ? n(o.center, 0) : clamp(n(o.center, 0.5), 0, 1);
      pts = [{ t: 0, v: center }];
      if (delay > 0) pts.push({ t: delay, v: center, c: 'smooth' });
      else pts[0].c = 'smooth';
      const half = (1 - delay) / (cycles * 2);
      for (let i = 1; delay + (i - 0.5) * half <= 1.0001; i++) {
        const t = Math.min(1, delay + (i - 0.5) * half);
        const grow = fade > 0 ? Math.min(1, (t - delay) / fade) : 1;
        pts.push({ t, v: center + (i % 2 ? depth : -depth) * grow, c: 'smooth' });
      }
      break;
    }
    case 'pulse': {
      const cycles = Math.round(clamp(n(o.cycles, 4), 1, (MAX_EXPRESSION_POINTS - 2) / 2));
      const duty = clamp(n(o.duty, 0.5), 0.05, 0.95);
      pts = [];
      for (let i = 0; i < cycles; i++) {
        pts.push({ t: i / cycles, v: to, c: 'hold' }, { t: (i + duty) / cycles, v: from, c: 'hold' });
      }
      pts.push({ t: 1, v: from });
      break;
    }
    default:
      throw new Error(`Unknown curve shape "${shape}".${didYouMean(shape, CURVE_SHAPES)} Use ${CURVE_SHAPES.join(', ')}`);
  }
  return sanitizeCurve(dim, pts);
}

export const CURVE_SHAPES = ['bend', 'scoop', 'fall', 'vibrato', 'swell', 'ramp', 'pulse'];

/** Does a note carry any expression (a curve or a release velocity)? */
export function hasExpression(note) {
  return !!note?.expression || (note?.releaseVelocity !== undefined && note?.releaseVelocity !== null);
}

/** The performance fields of a note, for copying onto another note (clipboard, duplicate, paste expression). */
export function expressionFields(note) {
  const out = {};
  if (note?.expression) out.expression = JSON.parse(JSON.stringify(note.expression));
  if (finite(note?.releaseVelocity)) out.releaseVelocity = note.releaseVelocity;
  return out;
}

/** One line per curve for humans and agents: "pitch 0 → +2 st (3 points), pressure peaks 0.85". */
export function describeExpression(note) {
  const parts = [];
  for (const dim of EXPRESSION_DIMS) {
    const c = note?.expression?.[dim];
    if (!c) continue;
    const vs = c.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const f = (v) => (dim === 'pitch' ? `${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}` : `${Math.round(v * 100) / 100}`);
    parts.push(`${dim} ${f(c[0].v)}→${f(c[c.length - 1].v)}${lo !== Math.min(c[0].v, c[c.length - 1].v) || hi !== Math.max(c[0].v, c[c.length - 1].v) ? ` (range ${f(lo)}..${f(hi)})` : ''}${dim === 'pitch' ? ' st' : ''}, ${c.length} pts`);
  }
  if (finite(note?.releaseVelocity)) parts.push(`release velocity ${Math.round(note.releaseVelocity * 100) / 100}`);
  return parts.join('; ');
}
