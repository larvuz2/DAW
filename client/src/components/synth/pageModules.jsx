// The modules of the synth page, drawn like the /synth editor: a hairline frame, a 28 px title strip with the
// module's switch and menus, a tight body; knobs in 44 px cells, vertical captions down the side of each cluster,
// numbers in small boxes. Every control is the editor's own (`ed.C`), so a knob here has its rings, its live dot and
// its modulation menu, takes a dropped source and is undone like any other.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SOURCE_DESTS, CHAOS_COUNT, CHAOS_INFO, FILTER_INFO, MACRO_COUNT, MOD_SOURCE_INFO, macroUsed, paramsToSection, sectionToParams, syncBeats } from '@greanteadawy/synth-dsp';
import { useStore } from '../../state/store.js';
import { getEngine } from '../../audio/index.js';
import { onFrame } from '../ui/frames.js';
import { SOURCE_MIME } from '../ui/Knob.jsx';
import { Select } from '../ui/Controls.jsx';
import { EnvelopeEditor } from './EnvelopeEditor.jsx';
import { FilterGraph } from './FilterGraph.jsx';
import { PresetBrowser } from './PresetBrowser.jsx';
import { WavetablePicker } from './WavetablePicker.jsx';
import { StepEditor } from './StepEditor.jsx';
import { sourceFamily, sourceShort, SOURCE_GROUPS } from './modulation.js';
import { WavetableStack, UnisonFan, LfoGraph, ChaosGraph, SourceSpark, OutputScope, SubWave, NoiseView, VelocityCurve, SignalFlow } from './displays.jsx';

/** The /synth editor's colours: surfaces, text, the violet accent and one colour per family of sources. */
export const SP = {
  accent: '#7c8cff', accentHover: '#96a3ff', fg: '#e6e9f0', fg2: '#9aa3b5', fg3: '#5c6578',
  env: '#ffb347', lfo: '#4dd8e6', chaos: '#ff5fa2', macro: '#a8e05f', note: '#b388ff', live: '#3df2b4'
};
export const familyColor = (source) => SP[sourceFamily(source)] || SP.accent;
const ringColor = (ring) => familyColor(ring.source);
/** Where each source of the flow is drawn, and in what colour. */
const FLOW_COLORS = { A: '#7c8cff', B: '#4db8ff', C: '#3ecfcf', sub: '#ffd15c', noise: '#9aa3b5' };
const DEST_LABEL = { f1: 'F1', f2: 'F2', both: 'Both', direct: 'Direct' };

// ---- the frame ---------------------------------------------------------------------------------------------------

/** A module: a hairline frame, a title strip (switch, title, menus, actions on the right) and a body. */
export function Module({ id, title, lead, header, actions, off, children, bodyClass = '', tools }) {
  return (
    <section className={`sp-mod ${off ? 'off' : ''}`} data-module={id}>
      <header className="sp-mod-head">
        {lead}
        <h3>{title}</h3>
        {header}
        <div className="sp-mod-actions">{actions}</div>
        {tools}
      </header>
      <div className={`sp-mod-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** A vertical caption for a cluster of controls, read bottom to top like a hardware panel. */
export const Cap = ({ children }) => <div className="sp-cap"><span>{children}</span></div>;
/** One knob-sized cell of a control row. */
export const Cell = ({ children, span = 1 }) => <div className="sp-cell" style={{ width: 44 * span }}>{children}</div>;

/** A modulation source as a chip that can be dragged onto a knob (the title strips of the modulators carry one). */
function SourceChip({ source, ed, className = '' }) {
  const color = familyColor(source);
  const n = ed.routes.filter((r) => r.source === source || r.via === source).length;
  return (
    <span className={`sp-chip ${className}`} draggable role="button" tabIndex={0} data-source={source} style={{ '--c': color }}
      title={`${ed.sourceName(source)}: ${MOD_SOURCE_INFO[source]}.\nDrag onto a knob to modulate it${n ? ` · ${n} route${n > 1 ? 's' : ''}` : ''}`}
      onDragStart={(e) => { e.dataTransfer.setData(SOURCE_MIME, source); e.dataTransfer.setData('text/plain', source); e.dataTransfer.effectAllowed = 'link'; }}
      onClick={() => n && ed.showInMatrix(source)}>
      <i />{ed.sourceName(source).replace(/\s*\(.*\)$/, '').replace(/^Envelope /, 'ENV ').replace(/^Chaos /, 'CHAOS ')}
    </span>
  );
}

/** Tabs in a title strip: ENV 1 · Amp, ENV 2 … — a dot of the family's colour, dim when the source is not routed. */
function ModTabs({ items, value, onPick, color, label }) {
  return (
    <div className="sp-tabs" role="tablist" aria-label={label}>
      {items.map(({ id, text, used }) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={value === id ? 'on' : ''} onClick={() => onPick(id)}>
          <i style={{ background: color, opacity: value === id || used ? 1 : 0.45 }} />{text}
        </button>
      ))}
    </div>
  );
}

// ---- header ------------------------------------------------------------------------------------------------------

/** Hold to play the channel's step note; while held, up/down is pressure and left/right is slide (like the pad). */
function PlayButton({ channel }) {
  const held = useRef(null);
  const from = useRef(null);
  const [down, setDown] = useState(false);
  const stop = () => {
    const v = held.current;
    held.current = null;
    setDown(false);
    if (v) { v.noteEnd = v.ctx.currentTime; v.release(v.ctx.currentTime); }
  };
  useEffect(() => stop, []);
  return (
    <button type="button" className={`sp-play ${down ? 'on' : ''}`} aria-pressed={down} data-nodrag
      aria-label="Hold to play the step note: drag up for pressure, sideways for slide" title="Hold to play the step note — drag up for pressure, sideways for slide"
      onPointerDown={async (e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, y: e.clientY };
        setDown(true);
        const eng = await useStore.getState().unlockAudio();
        if (!eng || held.current || !from.current) return;
        const v = eng.noteOn(channel.id, channel.rootKey, 0.8);
        if (!v) return;
        held.current = v;
        v.expr?.timbre.setValueAtTime(0.5, eng.ctx.currentTime);
        v.expr?.pressure.setValueAtTime(0.5, eng.ctx.currentTime);
      }}
      onPointerMove={(e) => {
        const v = held.current;
        if (!v?.expr || !from.current) return;
        const now = v.ctx.currentTime;
        v.expr.timbre.setTargetAtTime(Math.max(0, Math.min(1, 0.5 + (e.clientX - from.current.x) / 160)), now, 0.015);
        v.expr.pressure.setTargetAtTime(Math.max(0, Math.min(1, 0.5 - (e.clientY - from.current.y) / 120)), now, 0.015);
      }}
      onPointerUp={() => { from.current = null; stop(); }} onPointerCancel={() => { from.current = null; stop(); }}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor" /></svg>
    </button>
  );
}

/** How many notes the channel is sounding, from the engine, without re-rendering. */
function VoiceCount({ channelId }) {
  const led = useRef(null);
  const text = useRef(null);
  useEffect(() => {
    let last = -2;
    return onFrame(() => {
      const n = getEngine()?.ggsVoices?.(channelId);
      const v = n === null || n === undefined ? -1 : n;
      if (v === last) return;
      last = v;
      if (text.current) text.current.textContent = v < 0 ? '—' : String(v);
      if (led.current) led.current.className = v > 0 ? 'on' : '';
    });
  }, [channelId]);
  return (
    <div className="vbox" title="Notes sounding on this channel">
      <span className="vbox-label">Voices</span>
      <span className="vbox-value sp-voices"><i ref={led} /><b ref={text}>—</b></span>
    </div>
  );
}

function Macro({ ed, i }) {
  const key = `macro${i}`;
  const used = macroUsed(ed.full, i);
  const name = ed.macroNames[key];
  return (
    <div className="sp-macro" data-macro={i}>
      {ed.C(key, {
        look: 'panel', color: SP.macro, live: true, menu: ed.macroMenu(i), className: used ? '' : 'unused',
        title: `Macro ${i}${used ? `: ${name}` : ' — free: drag its number onto a knob'}. Right-click to automate it in the playlist.`,
        labelSlot: (
          <span className="sp-macro-label">
            <span className="sp-macro-n" draggable role="button" tabIndex={-1} style={{ opacity: used ? 1 : 0.55 }} data-source={key}
              onDragStart={(e) => { e.dataTransfer.setData(SOURCE_MIME, key); e.dataTransfer.setData('text/plain', key); e.dataTransfer.effectAllowed = 'link'; }}
              title={`Drag onto a knob: macro ${i} moves it`}>{i}</span>
            <span className="sp-macro-name">{name}</span>
          </span>
        )
      })}
    </div>
  );
}

export function HeaderModule({ ed, menu }) {
  const { C, val, setMany, info, channel } = ed;
  const mode = val('mono') ? (val('legato') ? 'legato' : 'mono') : 'poly';
  return (
    <header className="sp-header" data-module="header">
      <div className="sp-title">
        <div className="sp-title-row">
          <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1a1e27" /><path d="M6 20c4 0 4-9 8-9s4 12 8 12 3-6 4-6" fill="none" stroke={SP.accent} strokeWidth="2.75" strokeLinecap="round" /></svg>
          <b title={info.description}>{channel.instrument.preset}</b>
        </div>
        <span className="sp-tags" title={`${info.description}${info.expression ? `\nTouch: ${info.expression}` : ''}`}>{info.description}</span>
      </div>
      <div className="sp-presets"><PresetBrowser preset={channel.instrument.preset} onPick={ed.pickPreset} compact /></div>
      <div className="sp-cluster grow">
        <Cap>Macros</Cap>
        {Array.from({ length: MACRO_COUNT }, (_, k) => <Macro key={k} ed={ed} i={k + 1} />)}
      </div>
      <div className="sp-cluster">
        <Cap>Voice</Cap>
        <label className="sp-sel" style={{ width: 72 }} title="poly: every note its own voice; mono: one voice that every new note retriggers; legato: one voice that glides without retriggering">
          <span className="sp-cap-label">Mode</span>
          <Select value={mode} options={['poly', 'mono', 'legato']} onChange={(v) => setMany({ mono: v !== 'poly', legato: v === 'legato' })} />
        </label>
        {C('polyphony', { look: 'box', label: 'Poly', width: 44 })}
        {C('glide', { look: 'box', label: 'Glide', width: 52 })}
        {C('quality', { look: 'panel', label: 'Quality', width: 60 })}
      </div>
      <div className="sp-cluster">
        <Cap>Out</Cap>
        <PlayButton channel={channel} />
        {C('gain', { look: 'panel', label: 'Master', ringColor })}
        <VoiceCount channelId={channel.id} />
      </div>
      <button type="button" className="sp-menu-btn" aria-label="Patch, layout and view" title="Export / import the patch, layouts, arrange, full screen, classic view" onClick={menu}>⋯</button>
    </header>
  );
}

// ---- sources -----------------------------------------------------------------------------------------------------

export function OscModule({ ed, x, tools }) {
  const { C, val, set } = ed;
  const on = !!val(`osc${x}On`);
  const k = (key, opts = {}) => C(key, { look: 'panel', ringColor, ...opts });
  const warp = val(`osc${x}Warp`);
  const fmFrom = val(`osc${x}FmFrom`);
  const modulated = ed.routes.some((r) => r.target === `osc${x}Pos`);
  return (
    <Module id={`osc${x}`} title={`Osc ${x}`} off={!on} tools={tools}
      lead={C(`osc${x}On`, { look: 'led', label: null })}
      header={<WavetablePicker value={val(`osc${x}Table`)} color={SP.accent} label="" onPick={(v) => set(`osc${x}Table`, v)} />}
      bodyClass="sp-osc">
      <div className="sp-osc-top">
        <div className="sp-screen">
          <WavetableStack table={val(`osc${x}Table`)} pos={val(`osc${x}Pos`)} color={SP.accent} on={on} live={modulated ? ed.liveOf(`osc${x}Pos`) : null} className="fill" />
        </div>
        <div className="sp-boxes">
          {C(`osc${x}Oct`, { look: 'box', label: 'Oct', ringColor })}
          {C(`osc${x}Semi`, { look: 'box', label: 'Semi', ringColor })}
          {C(`osc${x}Fine`, { look: 'box', label: 'Fine', ringColor })}
          {C(`osc${x}Phase`, { look: 'box', label: 'Phase', ringColor })}
          {C(`osc${x}Rand`, { look: 'box', label: 'Rand', ringColor })}
          {C(`osc${x}Dest`, { look: 'box', label: 'To', options: SOURCE_DESTS.map((d) => ({ value: d, label: DEST_LABEL[d] })) })}
        </div>
      </div>
      <div className="sp-row">
        <Cap>Wavetable</Cap>
        <Cell>{k(`osc${x}Pos`, { label: 'Position' })}</Cell>
        <Cell>{k(`osc${x}UniPos`, { label: 'Pos sprd' })}</Cell>
        <Cell>{k(`osc${x}WarpAmt`, { label: 'Warp', labelSlot: <AttachSelect ed={ed} param={`osc${x}Warp`} value={warp} off="Warp off" /> })}</Cell>
        <div className="sp-right">
          <Cap>Mix</Cap>
          <Cell>{k(`osc${x}Level`)}</Cell>
          <Cell>{k(`osc${x}Pan`)}</Cell>
        </div>
      </div>
      <div className="sp-row">
        <Cap>Spread</Cap>
        <div className="sp-screen thin">
          <UnisonFan unison={val(`osc${x}Unison`)} detune={val(`osc${x}Detune`)} law={val(`osc${x}UniLaw`)} stack={val(`osc${x}Stack`)} blend={val(`osc${x}Blend`)} spread={val(`osc${x}Spread`)} color={SP.accent} className="fill" />
        </div>
        <div className="sp-stack">
          {C(`osc${x}UniLaw`, { look: 'panel', label: null, width: 76 })}
          {C(`osc${x}Stack`, { look: 'panel', label: null, width: 76, options: STACK_OPTIONS })}
        </div>
      </div>
      <div className="sp-row">
        <Cap>Unison</Cap>
        <Cell>{k(`osc${x}Unison`, { label: 'Voices' })}</Cell>
        <Cell>{k(`osc${x}Detune`)}</Cell>
        <Cell>{k(`osc${x}Blend`)}</Cell>
        <Cell>{k(`osc${x}Spread`, { label: 'Spread' })}</Cell>
        <div className="sp-right">
          <Cap>FM</Cap>
          <Cell>{k(`osc${x}Fm`, { label: 'FM', labelSlot: <AttachSelect ed={ed} param={`osc${x}FmFrom`} value={fmFrom} off="FM off" /> })}</Cell>
        </div>
      </div>
    </Module>
  );
}
const STACK_OPTIONS = [{ value: 'off', label: 'No stack' }, { value: 'octave', label: 'Octave' }, { value: 'fifth', label: 'Fifth' }, { value: 'octave+fifth', label: 'Oct + 5th' }];

/** The menu under a knob that picks what the knob works on (the warp mode, the FM source) — as small as a label. */
function AttachSelect({ ed, param, value, off }) {
  const d = ed.paramDef(param);
  const options = d.options;
  return (
    <span className="sp-attach">
      <select value={value} aria-label={param} onChange={(e) => ed.set(param, e.target.value)} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} title={d?.desc}>
        {options.map((o) => <option key={o} value={o}>{o === 'off' || o === 'none' ? off : o}</option>)}
      </select>
    </span>
  );
}

export function SubNoiseModule({ ed, tools }) {
  const { C, val } = ed;
  const k = (key, opts = {}) => C(key, { look: 'panel', ringColor, ...opts });
  const route = (key) => C(key, { look: 'box', label: 'To', width: 64, options: SOURCE_DESTS.map((d) => ({ value: d, label: DEST_LABEL[d] })) });
  const subOn = val('subLevel') > 0;
  const noiseOn = val('noiseLevel') > 0;
  return (
    <div className="sp-col" data-module="subnoise">
      <Module id="sub" title="Sub" off={!subOn} tools={tools} header={C('subWave', { look: 'panel', label: null, width: 84 })} bodyClass="sp-small">
        <div className="sp-screen flex"><SubWave wave={val('subWave')} on={subOn} color={SP.accent} /></div>
        <div className="sp-row">
          <div className="sp-boxcell">{C('subOct', { look: 'box', label: 'Oct', width: 48 })}</div>
          <Cell>{k('subLevel', { label: 'Level' })}</Cell>
          <div className="sp-right"><Cap>Route</Cap><div className="sp-boxcell">{route('subDest')}</div></div>
        </div>
      </Module>
      <Module id="noise" title="Noise" off={!noiseOn} header={C('noiseType', { look: 'panel', label: null, width: 84 })} bodyClass="sp-small">
        <div className="sp-screen flex"><NoiseView type={val('noiseType')} colour={val('noiseColor')} on={noiseOn} color={SP.accent} /></div>
        <div className="sp-row">
          <Cell>{k('noiseLevel', { label: 'Level' })}</Cell>
          <Cell>{k('noiseColor', { label: 'Colour' })}</Cell>
          <div className="sp-right"><Cap>Route</Cap><div className="sp-boxcell">{route('noiseDest')}</div></div>
        </div>
      </Module>
    </div>
  );
}

// ---- filters, routing, amp ---------------------------------------------------------------------------------------

/** The width of a box, followed as it changes (pictures drawn at a size in pixels). */
function useWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.max(80, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function FilterModule({ ed, i, tools }) {
  const { C, val } = ed;
  const [box, width] = useWidth(180);
  const type = val(`f${i}Type`);
  const fi = FILTER_INFO[type];
  const on = !!val(`f${i}On`);
  const k = (key, opts = {}) => C(key, { look: 'panel', ringColor, ...opts });
  return (
    <Module id={`filter${i}`} title={`Filter ${i}`} off={!on} tools={tools} lead={C(`f${i}On`, { look: 'led', label: null })}
      header={C(`f${i}Type`, { look: 'panel', label: null, width: 170, options: ed.filterOptions, title: fi.desc })} bodyClass="sp-filter">
      <div ref={box} className="sp-screen">
        <FilterGraph look="page" type={type} cutoff={val(`f${i}Cutoff`)} resonance={val(`f${i}Res`)} drive={val(`f${i}Drive`)} morph={val(`f${i}Morph`)} on={on}
          width={width} height={100} onChange={(f) => ed.setDrag(sectionToParams('filter', i, f), `f${i}:graph`)} />
      </div>
      <div className="sp-big">
        {k(`f${i}Cutoff`, { size: 'md', label: 'Cutoff' })}
        {k(`f${i}Res`, { size: 'md', label: 'Resonance' })}
      </div>
      <div className="sp-grid2">
        <Cell>{k(`f${i}Drive`)}</Cell>
        <Cell>{k(`f${i}Key`, { label: 'Key trk' })}</Cell>
        <Cell>{k(`f${i}Morph`, { label: fi.morph || 'Morph', className: fi.morph ? '' : 'dimmed', title: fi.morph ? undefined : 'Morph does nothing for this filter type' })}</Cell>
      </div>
    </Module>
  );
}

export function RoutingModule({ ed, tools }) {
  const { val, set } = ed;
  const next = (d) => SOURCE_DESTS[(SOURCE_DESTS.indexOf(d) + 1) % SOURCE_DESTS.length];
  const sources = [
    ...['A', 'B', 'C'].map((x) => ({ id: `osc${x}`, short: x, label: `Oscillator ${x}`, color: FLOW_COLORS[x], on: !!val(`osc${x}On`), dest: val(`osc${x}Dest`), key: `osc${x}Dest` })),
    { id: 'sub', short: 'Sub', label: 'Sub', color: FLOW_COLORS.sub, on: val('subLevel') > 0, dest: val('subDest'), key: 'subDest' },
    { id: 'noise', short: 'Nz', label: 'Noise', color: FLOW_COLORS.noise, on: val('noiseLevel') > 0, dest: val('noiseDest'), key: 'noiseDest' }
  ];
  const route = val('filterRoute');
  return (
    <Module id="routing" title="Routing" tools={tools} bodyClass="sp-routing"
      actions={<button type="button" className="sp-route-toggle" onClick={() => set('filterRoute', route === 'serial' ? 'parallel' : 'serial')}
        aria-label={`Filters in ${route}: switch to ${route === 'serial' ? 'parallel' : 'serial'}`} title="Click: filters in series ⇄ side by side">{route} ⇄</button>}>
      <SignalFlow sources={sources} f1On={!!val('f1On')} f2On={!!val('f2On')} route={route}
        onCycle={(id) => { const s = sources.find((x) => x.id === id); set(s.key, next(s.dest)); }} />
    </Module>
  );
}

export function AmpModule({ ed, tools }) {
  const { C, val } = ed;
  const k = (key, opts = {}) => C(key, { look: 'panel', ringColor, ...opts });
  return (
    <Module id="amp" title="Amp" tools={tools} actions={<span className="sp-note env">ENV 1 × velocity</span>} bodyClass="sp-amp">
      <div className="sp-screen sp-vel"><VelocityCurve sens={val('velSens')} level={val('level')} color={SP.env} /></div>
      <Cap>Amp</Cap>
      <Cell>{k('level')}</Cell>
      <Cell>{k('velSens', { label: 'Vel sens' })}</Cell>
      <Cell>{k('relVelSens', { label: 'Rel vel' })}</Cell>
    </Module>
  );
}

// ---- modulators --------------------------------------------------------------------------------------------------

export function EnvelopesModule({ ed, tools }) {
  const [i, setI] = useState(1);
  const { C, full } = ed;
  const k = (key, opts = {}) => C(key, { look: 'panel', color: SP.env, ringColor, ...opts });
  const items = [1, 2, 3, 4].map((n) => ({ id: n, text: n === 1 ? 'ENV 1 · Amp' : `ENV ${n}`, used: n === 1 || ed.used(`env${n}`) }));
  return (
    <Module id="envelopes" title="Envelopes" tools={tools} header={<ModTabs items={items} value={i} onPick={setI} color={SP.env} label="Envelope" />}
      actions={<SourceChip source={`env${i}`} ed={ed} />} bodyClass="sp-env">
      <div className="sp-screen sp-envgraph" style={{ '--c': SP.env }}>
        <EnvelopeEditor env={paramsToSection(full, 'envelope', i)} defaults={paramsToSection(ed.defaults, 'envelope', i)} color={SP.env} label={`Envelope ${i}`}
          onChange={(f) => ed.setDrag(sectionToParams('envelope', i, f), `env${i}:${Object.keys(f).sort().join('+')}`)} />
      </div>
      <div className="sp-grid3">
        <Cell>{k(`env${i}Delay`, { label: 'Delay' })}</Cell>
        <Cell>{k(`env${i}A`, { label: 'Attack' })}</Cell>
        <Cell>{k(`env${i}Hold`, { label: 'Hold' })}</Cell>
        <Cell>{k(`env${i}D`, { label: 'Decay' })}</Cell>
        <Cell>{k(`env${i}S`, { label: 'Sustain' })}</Cell>
        <Cell>{k(`env${i}R`, { label: 'Release' })}</Cell>
      </div>
    </Module>
  );
}

export function LfosModule({ ed, tools }) {
  const [i, setI] = useState(1);
  const { C, val } = ed;
  const k = (key, opts = {}) => C(key, { look: 'panel', color: SP.lfo, ringColor, ...opts });
  const drawn = val(`lfo${i}Shape`) === 'steps';
  const sync = val(`lfo${i}Sync`);
  const rate = sync === 'off' ? `${val(`lfo${i}Rate`) >= 10 ? val(`lfo${i}Rate`).toFixed(1) : val(`lfo${i}Rate`).toFixed(2)} Hz` : `${sync} · ${syncBeats(sync)} beats`;
  const steps = drawn ? Array.from({ length: val(`lfo${i}Steps`) }, (_, n) => val(`lfo${i}S${n + 1}`)) : null;
  const items = [1, 2, 3, 4].map((n) => ({ id: n, text: `LFO ${n}`, used: ed.used(`lfo${n}`) }));
  return (
    <Module id="lfos" title="LFOs" tools={tools} header={<ModTabs items={items} value={i} onPick={setI} color={SP.lfo} label="LFO" />}
      actions={<SourceChip source={`lfo${i}`} ed={ed} />} bodyClass="sp-lfo">
      <div className="sp-screen">
        {drawn
          ? <StepEditor steps={steps} smooth={val(`lfo${i}Smooth`)} color={SP.lfo} label={`LFO ${i}`} onDraw={(n, v) => ed.setDrag({ [`lfo${i}S${n + 1}`]: v }, `lfo${i}:draw`)} />
          : <LfoGraph shape={val(`lfo${i}Shape`)} phase={val(`lfo${i}Phase`)} color={SP.lfo} live={ed.live} source={`lfo${i}`} className="fill" label={rate} />}
      </div>
      <div className="sp-selcol">
        {C(`lfo${i}Shape`, { look: 'panel', label: 'Shape', width: 104 })}
        {C(`lfo${i}Sync`, { look: 'panel', label: 'Sync', width: 104 })}
        {C(`lfo${i}Trig`, { look: 'panel', label: 'Trigger', width: 104 })}
      </div>
      <div className="sp-grid2">
        <Cell>{k(`lfo${i}Rate`, { className: sync === 'off' ? '' : 'dimmed', title: sync === 'off' ? undefined : `Synced to the tempo (${sync}): Rate is not used` })}</Cell>
        <Cell>{drawn ? k(`lfo${i}Steps`) : k(`lfo${i}Phase`)}</Cell>
        <Cell>{k(`lfo${i}Fade`, { label: 'Fade in' })}</Cell>
        <Cell>{k(`lfo${i}Smooth`, { className: drawn ? '' : 'dimmed', title: drawn ? undefined : 'Smooth rounds the steps of a drawn shape' })}</Cell>
      </div>
    </Module>
  );
}

export function ChaosModule({ ed, tools }) {
  const [i, setI] = useState(1);
  const { C, val } = ed;
  const k = (key, opts = {}) => C(key, { look: 'panel', color: SP.chaos, ringColor, ...opts });
  const type = val(`chaos${i}Type`);
  const kind = CHAOS_INFO[type];
  const sync = val(`chaos${i}Sync`);
  const items = Array.from({ length: CHAOS_COUNT }, (_, n) => ({ id: n + 1, text: `CHAOS ${n + 1}`, used: ed.used(`chaos${n + 1}`) }));
  return (
    <Module id="chaos" title="Chaos" tools={tools} header={<ModTabs items={items} value={i} onPick={setI} color={SP.chaos} label="Chaos generator" />}
      actions={<SourceChip source={`chaos${i}`} ed={ed} />} bodyClass="sp-chaos">
      <div className="sp-screen">
        <ChaosGraph type={type} character={val(`chaos${i}Char`)} steps={val(`chaos${i}Steps`)} color={SP.chaos} live={ed.live} source={`chaos${i}`} className="fill" />
      </div>
      <div className="sp-chaos-side">
        <div className="sp-chaos-top">
          {C(`chaos${i}Type`, { look: 'panel', label: 'Type', width: 64, options: ed.chaosOptions })}
          <Cell>{k(`chaos${i}Rate`, { className: sync === 'off' ? '' : 'dimmed' })}</Cell>
          <Cell>{k(`chaos${i}Char`, { label: kind.character })}</Cell>
          <Cell>{k(`chaos${i}Steps`, { className: type === 'turing' ? '' : 'dimmed', title: type === 'turing' ? undefined : 'Steps are used by the turing pattern' })}</Cell>
        </div>
        <div className="sp-chaos-bottom">
          {C(`chaos${i}Sync`, { look: 'panel', label: 'Sync', width: 92 })}
          {C(`chaos${i}Path`, { look: 'panel', label: 'Path', width: 92 })}
        </div>
      </div>
    </Module>
  );
}

// ---- the mod sources strip ---------------------------------------------------------------------------------------

const PAGE_GROUPS = ['env', 'lfo', 'chaos', 'macro', 'note'].map((f) => SOURCE_GROUPS.find((g) => sourceFamily(g[0]) === f) || []);

export function SourcesModule({ ed }) {
  const count = (s) => ed.routes.filter((r) => r.source === s || r.via === s).length;
  return (
    <div className="sp-sources" data-module="sources" data-nodrag>
      <div className="sp-sources-title"><b>Mod sources</b><span>drag onto any knob</span></div>
      <div className="sp-sources-chips">
        {PAGE_GROUPS.map((group) => (
          <div key={group[0]} className="sp-src-group" role="group" aria-label={group[0]}>
            {group.map((s) => {
              const n = count(s);
              const color = familyColor(s);
              return (
                <div key={s} className={`sp-src ${n ? 'used' : ''}`} draggable role="button" tabIndex={0} data-source={s} style={{ '--c': color }}
                  title={`${ed.sourceName(s)}: ${MOD_SOURCE_INFO[s]}.\nDrag onto a knob to modulate it${n ? ` · ${n} route${n > 1 ? 's' : ''}: click to see them` : ''}`}
                  onDragStart={(e) => { e.dataTransfer.setData(SOURCE_MIME, s); e.dataTransfer.setData('text/plain', s); e.dataTransfer.effectAllowed = 'link'; document.body.classList.add('ggs-dragging'); }}
                  onDragEnd={() => document.body.classList.remove('ggs-dragging')}
                  onClick={() => n && ed.showInMatrix(s)}>
                  <span className="sp-src-name">{sourceShort(s).toUpperCase()}{n ? <i>{n}</i> : null}</span>
                  <SourceSpark source={s} live={ed.live} color={color} width={38} height={20} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- the FX rack (the dock's first view) -------------------------------------------------------------------------

export function FxRack({ ed }) {
  const { C, val } = ed;
  const k = (key, opts = {}) => C(key, { look: 'panel', ringColor, ...opts });
  const card = (name, kind, on, children) => (
    <div className={`sp-fx ${on ? 'on' : ''}`} key={name} data-fx={kind}>
      <div className="sp-fx-head"><i />{name}<span>{kind}</span></div>
      <div className="sp-fx-body">{children}</div>
    </div>
  );
  return (
    <div className="sp-rack">
      <div className="sp-rack-in"><span>Voices in</span></div>
      {card('Drive', 'drive', val('driveAmt') > 0, <>
        {C('driveType', { look: 'panel', label: 'Mode', width: 76 })}
        <Cell>{k('driveAmt', { label: 'Amount' })}</Cell>
        {C('driveOs', { look: 'panel', label: 'Rate', width: 56 })}
      </>)}
      {card('Chorus', 'chorus', val('chorusMix') > 0, <>
        <Cell>{k('chorusRate', { label: 'Rate' })}</Cell>
        <Cell>{k('chorusDepth', { label: 'Depth' })}</Cell>
        <Cell>{k('chorusMix', { label: 'Mix' })}</Cell>
      </>)}
      {card('Stereo delay', 'delay', val('delayMix') > 0, <>
        {C('delaySync', { look: 'panel', label: 'Time', width: 70 })}
        {val('delaySync') === 'free' && <Cell>{k('delayTime', { label: 'Time' })}</Cell>}
        <Cell>{k('delayFb', { label: 'Feedbk' })}</Cell>
        <Cell>{k('delayTone', { label: 'Tone' })}</Cell>
        <Cell>{k('delayMix', { label: 'Mix' })}</Cell>
        <div className="sp-ledcell">{C('delayPing', { look: 'led', label: 'Ping' })}</div>
      </>)}
      {card('Reverb', 'reverb', val('reverbMix') > 0, <>
        <Cell>{k('reverbSize', { label: 'Size' })}</Cell>
        <Cell>{k('reverbDamp', { label: 'Damping' })}</Cell>
        <Cell>{k('reverbMix', { label: 'Mix' })}</Cell>
      </>)}
    </div>
  );
}

// ---- optional modules --------------------------------------------------------------------------------------------

export function ScopeModule({ ed, tools }) {
  const id = ed.channel.id;
  const analyser = useCallback(() => getEngine()?.channelAnalyser?.(id) ?? null, [id]);
  const release = useCallback(() => getEngine()?.releaseChannelAnalyser?.(id), [id]);
  return (
    <Module id="scope" title="Output scope" tools={tools} actions={<span className="sp-note">wave · spectrum</span>} bodyClass="sp-scope">
      <div className="sp-screen"><OutputScope analyser={analyser} release={release} color={SP.accent} /></div>
    </Module>
  );
}

export function PadModule({ ed, tools }) {
  const { TouchPad } = ed;
  return (
    <Module id="pad" title="Touch pad" tools={tools} actions={<span className="sp-note">pressure ↑ · slide →</span>} bodyClass="sp-padbody">
      <TouchPad channel={ed.channel} />
    </Module>
  );
}
