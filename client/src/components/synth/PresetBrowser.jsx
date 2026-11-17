// The preset library as a browser: categories, a search box that also looks at descriptions, macro names and tags,
// and arrow keys that load as they move — so you can audition with one hand on a keyboard.
import { useEffect, useMemo, useRef, useState } from 'react';
import { GGS_PRESETS, GGS_PRESET_INFO, GGS_PRESET_CATEGORIES, ggsDefaults, FILTER_INFO, OSC_IDS, modulationRoutes } from '@greanteadawy/synth-dsp';

const DEFAULTS = ggsDefaults();
const CATEGORY_LABEL = Object.fromEntries(GGS_PRESET_CATEGORIES);

/** What a patch is made of, as short tags (worked out from its params, so they cannot go stale). */
function tagsOf(name) {
  const p = { ...DEFAULTS, ...GGS_PRESETS[name] };
  const tags = new Set();
  for (const i of [1, 2]) {
    if (!p[`f${i}On`]) continue;
    const family = FILTER_INFO[p[`f${i}Type`]]?.family;
    if (family && family !== 'clean') tags.add(family === 'ms20' ? 'ms-20' : family);
  }
  const oscs = OSC_IDS.filter((x) => p[`osc${x}On`]);
  if (oscs.some((x) => p[`osc${x}FmFrom`] !== 'off')) tags.add('fm');
  if (oscs.some((x) => p[`osc${x}Warp`] !== 'off')) tags.add('warp');
  if (oscs.some((x) => p[`osc${x}Unison`] >= 3)) tags.add('unison');
  if (p.mono) tags.add(p.glide > 0 ? 'mono glide' : 'mono');
  if ([1, 2, 3, 4].some((i) => p[`lfo${i}Sync`] !== 'off')) tags.add('tempo-synced');
  if (modulationRoutes(p).some((r) => /^chaos/.test(r.source) || /^chaos/.test(r.via || ''))) tags.add('chaos');
  if (p.delayMix > 0) tags.add('delay');
  if (p.reverbMix > 0.25) tags.add('reverb');
  return [...tags];
}

const LIBRARY = Object.keys(GGS_PRESETS).map((name) => {
  const info = GGS_PRESET_INFO[name] || {};
  const tags = tagsOf(name);
  return {
    name, category: info.category || 'init', description: info.description || '', macros: info.macros || [], tags,
    text: [name, info.category, info.description, info.expression, ...(info.macros || []), ...tags].join(' ').toLowerCase()
  };
});

export function PresetBrowser({ preset, onPick, compact = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const input = useRef(null);
  const list = useRef(null);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(
    () => LIBRARY.filter((p) => (category === 'all' || p.category === category) && words.every((w) => p.text.includes(w))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category, query]
  );
  const counts = useMemo(() => Object.fromEntries(GGS_PRESET_CATEGORIES.map(([id]) => [id, LIBRARY.filter((p) => p.category === id).length])), []);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { if (open) list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, [open, preset]);

  /** Step through what is listed (the whole library while the browser is closed). */
  const step = (dir) => {
    const pool = open && shown.length ? shown : LIBRARY;
    const at = pool.findIndex((p) => p.name === preset);
    const next = pool[at < 0 ? (dir > 0 ? 0 : pool.length - 1) : (at + dir + pool.length) % pool.length];
    if (next) onPick(next.name);
  };
  const key = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown.length && !shown.some((p) => p.name === preset)) onPick(shown[0].name); setOpen(false); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    e.stopPropagation();
  };

  return (
    <div className={`ggs-presets ${open ? 'open' : ''}`}>
      <div className="ggs-presets-bar">
        <button className="tbtn small" onClick={() => step(-1)} aria-label="Previous preset" title="Previous preset">‹</button>
        <button className="ggs-presets-name" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox" title="Browse presets">
          {compact
            ? <b className="compact">Presets <small>{LIBRARY.findIndex((p) => p.name === preset) + 1 || '–'}/{LIBRARY.length}</small></b>
            : <><b>{preset}</b><span>{CATEGORY_LABEL[GGS_PRESET_INFO[preset]?.category] || 'Preset'} ▾</span></>}
        </button>
        <button className="tbtn small" onClick={() => step(1)} aria-label="Next preset" title="Next preset">›</button>
      </div>
      {open && (
        <div className="ggs-browser" data-nodrag>
          <div className="ggs-browser-top">
            <input ref={input} type="search" value={query} placeholder="Search presets: name, sound, macro, tag…" aria-label="Search presets"
              onChange={(e) => setQuery(e.target.value)} onKeyDown={key} />
            <button className={`chip ${category === 'all' ? 'on' : ''}`} onClick={() => setCategory('all')}>All {LIBRARY.length}</button>
            {GGS_PRESET_CATEGORIES.map(([id, label]) => (
              <button key={id} className={`chip ${category === id ? 'on' : ''}`} onClick={() => setCategory(category === id ? 'all' : id)}>{label} {counts[id]}</button>
            ))}
            <button className="btn tiny" onClick={() => setOpen(false)}>Done</button>
          </div>
          <ul ref={list} role="listbox" aria-label="Presets" tabIndex={0} onKeyDown={key}>
            {shown.map((p) => (
              <li key={p.name} role="option" aria-selected={p.name === preset} className={p.name === preset ? 'on' : ''} onClick={() => onPick(p.name)} onDoubleClick={() => setOpen(false)}>
                <div><b>{p.name}</b>{p.tags.map((t) => <i key={t}>{t}</i>)}</div>
                <p>{p.description}</p>
                {p.macros.length > 0 && <small>{p.macros.join(' · ')}</small>}
              </li>
            ))}
            {!shown.length && <li className="none">Nothing matches “{query}”.</li>}
          </ul>
          <p className="cs-desc">↑ ↓ load the next preset as you go · Enter closes · {shown.length} of {LIBRARY.length}</p>
        </div>
      )}
    </div>
  );
}
