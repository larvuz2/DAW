// An envelope you shape by hand: drag the nodes to set the times and the sustain level, drag the small round
// handles in the middle of a slope to bend it. It draws with the same formula the voices render with (envShape),
// so the picture is the sound.
import { useRef, useState } from 'react';
import { envShape, envCurveK, ENV_CURVE_SCALE } from '@greanteadawy/synth-dsp';
import { formatValue } from '../ui/Knob.jsx';

const W = 330;
const H = 108;
const PAD = 9;
const SUSTAIN_W = 44; // the sustain stage has no length of its own: it is drawn as a fixed stretch
const LIMITS = { delay: [0, 5], attack: [0.001, 10], hold: [0, 5], decay: [0.005, 10], release: [0.005, 15] };
const STAGES = ['delay', 'attack', 'hold', 'decay', 'release'];
const CURVE_OF = { attackCurve: 'attack', decayCurve: 'decay', releaseCurve: 'release' };
const NAMES = { delay: 'Delay', attack: 'Attack', hold: 'Hold', decay: 'Decay and sustain', release: 'Release', attackCurve: 'Attack curve', decayCurve: 'Decay curve', releaseCurve: 'Release curve' };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const y = (v) => H - PAD - v * (H - 2 * PAD);

/** Stage widths grow with the square root of their time, so a 5 ms attack and a 4 s release are both grabbable. */
function layout(env, k) {
  const root = Object.fromEntries(STAGES.map((s) => [s, Math.sqrt(Math.max(0, env[s]))]));
  const scale = k ?? (W - 2 * PAD - SUSTAIN_W) / Math.max(0.3, STAGES.reduce((sum, s) => sum + root[s], 0));
  const x = { start: PAD };
  x.delay = x.start + root.delay * scale;
  x.attack = x.delay + root.attack * scale;
  x.hold = x.attack + root.hold * scale;
  x.decay = x.hold + root.decay * scale;
  x.sustain = x.decay + SUSTAIN_W;
  x.release = x.sustain + root.release * scale;
  return { x, scale };
}

/** The curve that puts a stage at fraction `f` of its way after half its time (the inverse of envShape at 0.5). */
function curveThrough(f) {
  const k = -2 * Math.log(1 / clamp(f, 0.012, 0.988) - 1);
  return clamp(-Math.sign(k) * Math.sqrt(Math.abs(k) / ENV_CURVE_SCALE), -1, 1);
}

export function EnvelopeEditor({ env, defaults, onChange, color = 'var(--accent-2)', label = 'Envelope' }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const lastDown = useRef({ id: null, at: 0 });
  const [active, setActive] = useState(null);
  const { x, scale } = layout(env, drag.current?.scale);
  const s = env.sustain;
  const half = (curve) => envShape(0.5, envCurveK(curve));

  // the outline: 18 points per slope
  const pts = [[x.start, y(0)], [x.delay, y(0)]];
  for (let i = 1; i <= 18; i++) pts.push([x.delay + (x.attack - x.delay) * (i / 18), y(envShape(i / 18, envCurveK(env.attackCurve)))]);
  pts.push([x.hold, y(1)]);
  for (let i = 1; i <= 18; i++) pts.push([x.hold + (x.decay - x.hold) * (i / 18), y(s + (1 - s) * (1 - envShape(i / 18, envCurveK(env.decayCurve))))]);
  pts.push([x.sustain, y(s)]);
  for (let i = 1; i <= 18; i++) pts.push([x.sustain + (x.release - x.sustain) * (i / 18), y(s * (1 - envShape(i / 18, envCurveK(env.releaseCurve))))]);
  const path = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');

  const nodes = [
    { id: 'delay', cx: x.delay, cy: y(0) },
    { id: 'attack', cx: x.attack, cy: y(1) },
    { id: 'hold', cx: x.hold, cy: y(1) },
    { id: 'decay', cx: x.decay, cy: y(s) },
    { id: 'release', cx: x.release, cy: y(0) }
  ];
  const bends = [
    { id: 'attackCurve', cx: (x.delay + x.attack) / 2, cy: y(half(env.attackCurve)), show: true },
    { id: 'decayCurve', cx: (x.hold + x.decay) / 2, cy: y(s + (1 - s) * (1 - half(env.decayCurve))), show: s < 0.96 },
    { id: 'releaseCurve', cx: (x.sustain + x.release) / 2, cy: y(s * (1 - half(env.releaseCurve))), show: s > 0.04 }
  ];

  const point = (e) => {
    const r = ref.current.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
  };
  const level = (py) => clamp((H - PAD - py) / (H - 2 * PAD), 0, 1);

  const apply = (id, px, py) => {
    const d = drag.current;
    const k = d.scale;
    const time = (stage, from) => {
      const [lo, hi] = LIMITS[stage];
      const w = Math.max(0, px - from) / k;
      return clamp(Math.round(w * w * 10000) / 10000, lo, hi);
    };
    const before = layout(d.env, k).x; // positions of the stages to the left stay where they were when the drag began
    switch (id) {
      case 'delay': onChange({ delay: time('delay', before.start) }); break;
      case 'attack': onChange({ attack: time('attack', before.delay) }); break;
      case 'hold': onChange({ hold: time('hold', before.attack) }); break;
      case 'decay': onChange({ decay: time('decay', before.hold), sustain: Math.round(level(py) * 1000) / 1000 }); break;
      case 'release': onChange({ release: time('release', before.sustain) }); break;
      case 'attackCurve': onChange({ attackCurve: curveThrough(level(py)) }); break;
      case 'decayCurve': onChange({ decayCurve: curveThrough(1 - (level(py) - s) / Math.max(0.001, 1 - s)) }); break;
      case 'releaseCurve': onChange({ releaseCurve: curveThrough(1 - level(py) / Math.max(0.001, s)) }); break;
      default: break;
    }
  };

  const down = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    // a second press on a bend handle right after the first puts its default back (the pointer is captured by the
    // graph while dragging, so the browser's own double-click would not land on the handle)
    const again = lastDown.current.id === id && e.timeStamp - lastDown.current.at < 350;
    lastDown.current = { id, at: e.timeStamp };
    if (again && CURVE_OF[id]) { onChange({ [id]: defaults?.[id] ?? 0 }); return; }
    ref.current.setPointerCapture(e.pointerId);
    const { px, py } = point(e);
    // attack and hold share a spot while the hold is zero: the first move decides (right = add hold)
    const undecided = (id === 'attack' || id === 'hold') && env.hold < 0.0005;
    drag.current = { id: undecided ? null : id, scale, env: { ...env }, x0: px, grab: { dx: 0, dy: 0 } };
    const n = [...nodes, ...bends].find((q) => q.id === id);
    drag.current.grab = { dx: n.cx - px, dy: n.cy - py };
    setActive(id);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const { px, py } = point(e);
    if (!d.id) {
      if (Math.abs(px - d.x0) < 2) return;
      d.id = px > d.x0 ? 'hold' : 'attack';
      setActive(d.id);
    }
    apply(d.id, px + d.grab.dx, py + d.grab.dy);
  };
  const up = () => {
    drag.current = null;
    setActive(null);
  };

  const key = (id) => (e) => {
    const step = e.shiftKey ? 0.25 : 1;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (CURVE_OF[id]) { if (dir[1]) onChange({ [id]: clamp(Math.round((env[id] - dir[1] * 0.05 * step) * 100) / 100, -1, 1) }); return; }
    const out = {};
    if (dir[0]) {
      const [lo, hi] = LIMITS[id];
      // a tenth more or less (and off zero in one press)
      out[id] = clamp(Math.round(Math.max(env[id] * (1 + dir[0] * 0.1 * step), env[id] + dir[0] * 0.002) * 10000) / 10000, lo, hi);
    }
    if (dir[1] && id === 'decay') out.sustain = clamp(Math.round((s + dir[1] * 0.02 * step) * 100) / 100, 0, 1);
    if (Object.keys(out).length) onChange(out);
  };

  const t = (v) => formatValue(v, { unit: 's' });
  // the times and the sustain have knobs underneath; the three bends only live here
  const readout = [['attackCurve', 'attack'], ['decayCurve', 'decay'], ['releaseCurve', 'release']].map(([id, name]) => [id, `${name} ${env[id] > 0 ? '+' : ''}${env[id].toFixed(2)}`]);
  const valueText = (id) => (CURVE_OF[id] ? env[id].toFixed(2) : id === 'decay' ? `${t(env.decay)}, sustain ${s.toFixed(2)}` : t(env[id]));

  return (
    <div className="ggs-envedit" style={{ '--c': color }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${label}: drag the nodes for times and sustain, the round handles to bend a slope`}
        data-nodrag onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <line className="base" x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} />
        <line className="base" x1={PAD} x2={W - PAD} y1={y(1)} y2={y(1)} />
        <rect className="sus" x={x.decay} y={PAD} width={SUSTAIN_W} height={H - 2 * PAD} />
        <path className="fill" d={`${path}L${x.release.toFixed(1)} ${y(0)}L${x.start} ${y(0)}Z`} />
        <path className="line" d={path} />
        {bends.filter((b) => b.show).map((b) => (
          <circle key={b.id} className={`bend ${active === b.id ? 'on' : ''}`} cx={b.cx} cy={b.cy} r={4.5} tabIndex={0} role="slider" aria-label={NAMES[b.id]}
            aria-valuemin={-1} aria-valuemax={1} aria-valuenow={env[b.id]} aria-valuetext={valueText(b.id)} data-node={b.id}
            onPointerDown={down(b.id)} onKeyDown={key(b.id)}>
            <title>{`${NAMES[b.id]} ${env[b.id].toFixed(2)} — drag up or down to bend, double-click to reset`}</title>
          </circle>
        ))}
        {nodes.map((n) => (
          <rect key={n.id} className={`node ${active === n.id ? 'on' : ''}`} x={n.cx - 5} y={n.cy - 5} width={10} height={10} rx={2} tabIndex={0} role="slider"
            aria-label={NAMES[n.id]} aria-valuemin={LIMITS[n.id][0]} aria-valuemax={LIMITS[n.id][1]} aria-valuenow={env[n.id]} aria-valuetext={valueText(n.id)} data-node={n.id}
            onPointerDown={down(n.id)} onKeyDown={key(n.id)}>
            <title>{n.id === 'attack' && env.hold < 0.0005 ? `Attack ${t(env.attack)} — drag left/right; drag right past the peak to add a hold` : `${NAMES[n.id]} ${valueText(n.id)}`}</title>
          </rect>
        ))}
      </svg>
      <div className="ggs-envedit-read" title="Bend of each slope: 0 = straight, negative = fast first, positive = slow first. Drag the round handles; double-click one to reset it.">
        <span>Curves</span>{readout.map(([id, text]) => <span key={id} className={active === id ? 'on' : ''}>{text}</span>)}
      </div>
    </div>
  );
}
