// Choosing a wavetable by looking at it: a grid of every table with its wave drawn at the start, middle and end of
// the table, searchable, with arrow keys that load as they move.
import { useEffect, useRef, useState } from 'react';
import { describeWavetables, wavetablePreview } from '@ggs/synth-dsp';

const TABLES = describeWavetables();
const CELL_W = 78;
const CELL_H = 30;
// drawn once per table and kept: building a table takes a few milliseconds, so the grid fills in over a few frames
const previews = new Map();
function previewOf(id) {
  let p = previews.get(id);
  if (!p) {
    p = [0, 0.5, 1].map((pos) => {
      const wave = wavetablePreview(id, pos, 64);
      let peak = 0.001;
      for (const v of wave) peak = Math.max(peak, Math.abs(v));
      return Array.from(wave, (v) => v / peak);
    });
    previews.set(id, p);
  }
  return p;
}

function Thumb({ id, color, ready }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !ready) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = CELL_W * dpr;
    cv.height = CELL_H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, CELL_W, CELL_H);
    const [first, mid, last] = previewOf(id);
    const draw = (wave, alpha, width) => {
      g.beginPath();
      wave.forEach((v, i) => {
        const x = (i / (wave.length - 1)) * CELL_W;
        const y = CELL_H / 2 - v * (CELL_H / 2 - 3);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke();
    };
    draw(first, 0.3, 1);
    draw(last, 0.3, 1);
    draw(mid, 1, 1.5);
  }, [id, color, ready]);
  return <canvas ref={ref} style={{ width: CELL_W, height: CELL_H }} />;
}

export function WavetablePicker({ value, onPick, color = 'var(--accent)', label = 'Wavetable' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [drawn, setDrawn] = useState(0);
  const grid = useRef(null);
  const input = useRef(null);
  const current = TABLES.find((t) => t.id === value);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = TABLES.filter((t) => words.every((w) => `${t.id} ${t.name} ${t.description}`.toLowerCase().includes(w)));

  // draw four more thumbnails per frame until all are there
  useEffect(() => {
    if (!open || drawn >= TABLES.length) return undefined;
    const id = requestAnimationFrame(() => setDrawn((n) => Math.min(TABLES.length, n + 4)));
    return () => cancelAnimationFrame(id);
  }, [open, drawn]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const key = (e) => {
    // columns of the grid as laid out right now: the cells on the first row
    const cells = [...(grid.current?.children || [])];
    const cols = Math.max(1, cells.filter((c) => c.offsetTop === cells[0].offsetTop).length);
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    // in the search box left and right move the caret; the grid is walked with up and down from there
    if (!delta || (e.target.tagName === 'INPUT' && Math.abs(delta) === 1)) { e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (!shown.length) return;
    const at = shown.findIndex((t) => t.id === value);
    const next = shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + delta))];
    if (next && next.id !== value) onPick(next.id);
  };

  return (
    <div className={`ggs-wt ${open ? 'open' : ''}`} style={{ '--c': color }}>
      <label className="param-select" title={current?.description}>
        <button className="ggs-wt-name" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox">{current?.name || value} ▾</button>
        <span>{label}</span>
      </label>
      {open && (
        <div className="ggs-wt-panel" data-nodrag>
          <div className="ggs-browser-top">
            <input ref={input} type="search" value={query} placeholder={`Search ${TABLES.length} wavetables…`} aria-label="Search wavetables" onChange={(e) => setQuery(e.target.value)} onKeyDown={key} />
            <button className="btn tiny" onClick={() => setOpen(false)}>Done</button>
          </div>
          <div ref={grid} className="ggs-wt-grid" role="listbox" aria-label="Wavetables" tabIndex={0} onKeyDown={key}>
            {shown.map((t) => (
              <button key={t.id} role="option" aria-selected={t.id === value} className={t.id === value ? 'on' : ''} title={`${t.name} — ${t.description} (${t.frames} frames)`} onClick={() => onPick(t.id)} onDoubleClick={() => setOpen(false)}>
                <Thumb id={t.id} color={t.id === value ? '#fff' : '#b9c2cc'} ready={TABLES.indexOf(t) < drawn} />
                <span>{t.name}</span>
              </button>
            ))}
            {!shown.length && <p className="ggs-empty">No wavetable matches “{query}”.</p>}
          </div>
          <p className="cs-desc">{current ? `${current.name}: ${current.description}` : ''}</p>
        </div>
      )}
    </div>
  );
}
