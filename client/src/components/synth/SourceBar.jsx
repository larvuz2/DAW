// Every modulation source as a chip that shows what it is doing right now, and that can be dragged onto a knob to
// modulate it. Click a chip to see its routes in the matrix.
import { useEffect, useRef } from 'react';
import { MOD_SOURCE_INFO, BIPOLAR_SOURCES, modSourceLabel } from '@greanteadawy/synth-dsp';
import { onFrame } from '../ui/frames.js';
import { SOURCE_MIME } from '../ui/Knob.jsx';
import { SOURCE_GROUPS, sourceFamily, sourceShort, sourceColor, liveSource } from './modulation.js';

/** A thin meter that follows a source: from the middle for sources that swing both ways. */
export function SourceMeter({ source, live, className = '' }) {
  const ref = useRef(null);
  const both = BIPOLAR_SOURCES.has(source);
  useEffect(() => {
    let shown = NaN;
    return onFrame(() => {
      const el = ref.current;
      if (!el) return;
      const raw = liveSource(live(), source);
      const v = raw === null || raw === undefined ? 0 : Math.round(Math.max(-1, Math.min(1, raw)) * 100) / 100;
      if (v === shown) return;
      shown = v;
      el.style.left = both ? `${50 + Math.min(0, v) * 50}%` : '0';
      el.style.width = `${Math.abs(v) * (both ? 50 : 100)}%`;
    });
  }, [source, live, both]);
  return <span className={`ggs-meter ${both ? 'both' : ''} ${className}`} aria-hidden="true"><i ref={ref} style={{ background: sourceColor(source) }} /></span>;
}

export function SourceBar({ used, live, names = {}, onPick }) {
  const start = (source) => (e) => {
    e.dataTransfer.setData(SOURCE_MIME, source);
    e.dataTransfer.setData('text/plain', source);
    e.dataTransfer.effectAllowed = 'link';
    document.body.classList.add('ggs-dragging'); // every knob that can take a source lights up
  };
  const end = () => document.body.classList.remove('ggs-dragging');
  useEffect(() => end, []);
  return (
    <div className="ggs-sources" data-nodrag role="toolbar" aria-label="Modulation sources: drag one onto a knob, or click it to see its routes">
      <span className="ggs-sources-label">Sources</span>
      {SOURCE_GROUPS.map((group) => (
        <div key={group[0]} className="ggs-src-group">
          {group.map((s) => (
            <button key={s} className={`ggs-src ${sourceFamily(s)} ${used.has(s) ? 'used' : ''}`} draggable onDragStart={start(s)} onDragEnd={end} onClick={() => onPick(s)}
              style={{ '--c': sourceColor(s) }} data-source={s}
              title={`${names[s] || modSourceLabel(s)}: ${MOD_SOURCE_INFO[s]}.\nDrag onto a knob to modulate it${used.has(s) ? ' · click to see its routes' : ' · not routed yet'}`}>
              {sourceShort(s)}
              <SourceMeter source={s} live={live} />
            </button>
          ))}
        </div>
      ))}
      <span className="ggs-sources-hint">drag onto a knob · Alt-drag a knob for the depth</span>
    </div>
  );
}
