// Every parameter of the patch in one searchable table: what it is called, where it stands, what it does. For finding
// the one control you need, for seeing at a glance what makes a patch different from the init patch ("Changed"),
// and for typing exact values.
import { useMemo, useState } from 'react';
import { GGS_PARAMS, ggsDefaults } from '@greanteadawy/synth-dsp';
import { Select } from '../ui/Controls.jsx';
import { formatValue } from '../ui/Knob.jsx';

const DEFAULTS = ggsDefaults();
const ROWS = GGS_PARAMS.map((d) => ({ def: d, slot: d.section === 'mod' ? Number(/^mod(\d+)/.exec(d.key)[1]) : 0, text: `${d.key} ${d.group} ${d.label} ${d.desc}`.toLowerCase() }));
const rangeOf = (d) => (d.type === 'number' ? `${d.min} … ${d.max}${d.unit ? ` ${d.unit}` : ''}` : d.type === 'select' ? `${d.options.length} choices` : 'on / off');
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

function NumberCell({ def, value, onSet }) {
  const [text, setText] = useState(null);
  const commit = () => {
    if (text === null) return;
    const v = parseFloat(text);
    setText(null);
    if (!Number.isFinite(v)) return;
    const c = Math.max(def.min, Math.min(def.max, v));
    onSet(def.key, def.step ? Math.round(c) : c);
  };
  return (
    <input type="number" className="ggs-ptable-num" aria-label={`${def.group} ${def.label}`} min={def.min} max={def.max} step={def.step || 'any'}
      value={text ?? String(Math.round(value * 10000) / 10000)} title={formatValue(value, { unit: def.unit, step: def.step })}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } else if (e.key === 'Escape') setText(null); e.stopPropagation(); }} />
  );
}

export function ParamTable({ params, onSet }) {
  const [query, setQuery] = useState('');
  const [changed, setChanged] = useState(false);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const value = (key) => params[key] ?? DEFAULTS[key];
  const rows = useMemo(() => ROWS.filter((r) => {
    if (!words.every((w) => r.text.includes(w))) return false;
    if (changed && same(value(r.def.key), r.def.default)) return false;
    // the 16 matrix slots are four rows each: empty ones only show when searched for
    if (r.slot && !words.length && (value(`mod${r.slot}Src`) === 'none' || value(`mod${r.slot}Dst`) === 'none')) return false;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query, changed, params]);

  return (
    <div className="ggs-ptable">
      <div className="ggs-browser-top">
        <input type="search" value={query} placeholder={`Search ${GGS_PARAMS.length} parameters: name, section or what it does…`} aria-label="Search parameters"
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className={`chip ${changed ? 'on' : ''}`} aria-pressed={changed} onClick={() => setChanged(!changed)} title="Only parameters that differ from the init patch: what makes this patch what it is">Changed</button>
        <span className="ggs-ptable-count">{rows.length} of {GGS_PARAMS.length}</span>
      </div>
      <div className="ggs-ptable-scroll" data-nodrag>
        <table>
          <thead><tr><th>Section</th><th>Parameter</th><th>Value</th><th>Range</th><th>What it does</th></tr></thead>
          <tbody>
            {rows.map(({ def: d }) => {
              const v = value(d.key);
              const isChanged = !same(v, d.default);
              return (
                <tr key={d.key} className={isChanged ? 'changed' : ''}>
                  <td>{d.group}</td>
                  <td><b>{d.label}</b><code>{d.key}</code></td>
                  <td className="ggs-ptable-val">
                    {d.type === 'number' ? <NumberCell def={d} value={v} onSet={onSet} />
                      : d.type === 'select' ? <Select value={v} options={d.options} onChange={(x) => onSet(d.key, x)} />
                        : <button className={`toggle ${v ? 'on' : ''}`} aria-pressed={!!v} aria-label={`${d.group} ${d.label}`} onClick={() => onSet(d.key, !v)}>{v ? 'ON' : 'OFF'}</button>}
                    {isChanged && <button className="tbtn small" onClick={() => onSet(d.key, d.default)} aria-label={`Reset ${d.group} ${d.label}`} title={`Back to ${formatValue(d.default, { unit: d.unit, step: d.step })}`}>↺</button>}
                  </td>
                  <td className="ggs-ptable-range">{rangeOf(d)}</td>
                  <td className="ggs-ptable-desc">{d.desc}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={5} className="ggs-empty">{changed && !query ? 'Nothing differs from the init patch.' : `No parameter matches “${query}”.`}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
