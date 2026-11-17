// The Overview tab of the GGS Synth editor: the whole patch on one screen, as pictures — the wavetables as stacks of
// frames, the unison copies, the filter curves, the signal flow, the envelopes, the LFOs and chaos moving with the
// note, the sources with their recent movement, the effects and the sound of the channel. Every part is a module
// that can be moved, made wider or narrower, hidden and brought back, and an arrangement can be saved under a name
// (overviewLayout.js) — so a screen can show just what a video needs.
//
// It edits the same params as the other tabs, through the same controls (`ed.C`): a knob here has its rings, its
// live dot, its modulation menu and takes dropped sources exactly as it does there.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SOURCE_DESTS, CHAOS_COUNT, CHAOS_INFO, FILTER_INFO, MACRO_COUNT, MOD_SLOTS, MOD_SOURCE_INFO, describeRoute, modSourceLabel, modTargetLabel, paramsToSection, sectionToParams, syncBeats } from '@greanteadawy/synth-dsp';
import { useStore } from '../../state/store.js';
import { getEngine } from '../../audio/index.js';
import { SOURCE_MIME } from '../ui/Knob.jsx';
import { Select } from '../ui/Controls.jsx';
import { Icon } from '../ui/Icon.jsx';
import { EnvelopeEditor } from './EnvelopeEditor.jsx';
import { FilterGraph } from './FilterGraph.jsx';
import { PresetBrowser } from './PresetBrowser.jsx';
import { WavetablePicker } from './WavetablePicker.jsx';
import { StepEditor } from './StepEditor.jsx';
import { SOURCE_GROUPS, sourceFamily, sourceShort, sourceColor } from './modulation.js';
import {
  WavetableStack, UnisonFan, SubNoiseView, RoutingDiagram, EnvelopeCurve, LfoGraph, ChaosGraph, SourceSpark, DriveCurve, DelayTaps, ReverbTail, ChorusWobble, OutputScope
} from './displays.jsx';
import {
  MODULES, BUILT_IN_LAYOUTS, COLUMNS, STORAGE_KEY, normalizeLayout, hiddenModules, moveModule, nudgeModule, resizeModule, hideModule, showModule, sameItems,
  loadLayouts, storeLayouts, saveAs
} from './overviewLayout.js';

const MODULE_MIME = 'application/x-gtd-module';
const KNOB = 26;

/** The width of a box, followed as it changes (for pictures drawn at a size in pixels). */
function useBoxWidth(fallback = 300) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.max(120, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A row of numbered chips that picks one of several (ENV 1–4, LFO 1–4…). */
function Picker({ items, value, onPick, label }) {
  return (
    <div className="ovw-pick" role="tablist" aria-label={label}>
      {items.map(({ id, text, color, dim }) => (
        <button key={id} role="tab" aria-selected={value === id} className={`${value === id ? 'on' : ''} ${dim ? 'dim' : ''}`} style={{ '--c': color }} onClick={() => onPick(id)}>{text}</button>
      ))}
    </div>
  );
}

// ---- the modules -----------------------------------------------------------------------------------------------

function HeaderModule({ ed }) {
  const { C, val, info } = ed;
  return (
    <div className="ovw-header">
      <PresetBrowser preset={ed.channel.instrument.preset} onPick={ed.pickPreset} />
      <div className="ovw-knobs macros">{Array.from({ length: MACRO_COUNT }, (_, k) => ed.macroKnob(k + 1, KNOB + 4))}</div>
      <div className="ovw-knobs">{C('level', { size: KNOB + 4 })}{C('gain', { size: KNOB + 4 })}</div>
      <div className="ovw-voice">
        <b>{val('mono') ? 'mono' : `poly ${val('polyphony')}`}</b>
        <span>glide {Math.round(val('glide') * 1000)} ms</span>
        <span>quality {val('quality')}</span>
      </div>
      <div className="ovw-header-buttons">
        <button className="btn tiny" onClick={ed.exportPatch} title="Save this patch as a .json document">Export</button>
        <button className="btn tiny" onClick={ed.importPatch} title="Load a patch document">Import</button>
      </div>
      <p className="ovw-desc">{info.description} {info.expression && <><b>Touch:</b> {info.expression}</>}</p>
    </div>
  );
}

function OscModule({ ed, x }) {
  const { C, val, set } = ed;
  const color = ed.oscColors[x];
  const on = val(`osc${x}On`);
  const k = (key, opts = {}) => C(key, { color, size: KNOB, ...opts });
  const modulated = ed.routes.some((r) => r.target === `osc${x}Pos`);
  return (
    <div className={`ovw-osc ${on ? '' : 'off'}`} style={{ '--c': color }}>
      <div className="ovw-row">
        {C(`osc${x}On`, { label: 'On' })}
        <WavetablePicker value={val(`osc${x}Table`)} color={color} onPick={(v) => set(`osc${x}Table`, v)} />
        {C(`osc${x}Dest`)}
      </div>
      <WavetableStack table={val(`osc${x}Table`)} pos={val(`osc${x}Pos`)} color={color} on={on} live={modulated ? ed.liveOf(`osc${x}Pos`) : null} />
      <div className="ovw-knobs">{k(`osc${x}Pos`)}{k(`osc${x}Level`)}{k(`osc${x}Pan`)}{k(`osc${x}Oct`)}{k(`osc${x}Semi`)}{k(`osc${x}Fine`)}</div>
      <div className="ovw-sub">Unison</div>
      <UnisonFan unison={val(`osc${x}Unison`)} detune={val(`osc${x}Detune`)} law={val(`osc${x}UniLaw`)} stack={val(`osc${x}Stack`)} blend={val(`osc${x}Blend`)} spread={val(`osc${x}Spread`)} color={color} />
      <div className="ovw-knobs">{k(`osc${x}Unison`, { label: 'Voices' })}{k(`osc${x}Detune`)}{k(`osc${x}Blend`)}{k(`osc${x}Spread`)}{k(`osc${x}UniPos`, { label: 'Uni table' })}</div>
      <div className="ovw-knobs">{C(`osc${x}UniLaw`, { label: 'Law' })}{C(`osc${x}Stack`)}</div>
      <div className="ovw-sub">Shape · FM</div>
      <div className="ovw-knobs">{C(`osc${x}Warp`)}{k(`osc${x}WarpAmt`, { label: 'Warp' })}{C(`osc${x}FmFrom`, { label: 'FM from' })}{k(`osc${x}Fm`, { label: 'FM' })}{k(`osc${x}Phase`)}{k(`osc${x}Rand`, { label: 'Rand' })}</div>
    </div>
  );
}

function SubNoiseModule({ ed }) {
  const { C, val } = ed;
  return (
    <div className="ovw-subnoise">
      <SubNoiseView wave={val('subWave')} subLevel={val('subLevel')} noiseLevel={val('noiseLevel')} noiseColor={val('noiseColor')} />
      <div className="ovw-sub">Sub</div>
      <div className="ovw-knobs">{C('subLevel', { size: KNOB, label: 'Level' })}{C('subWave', { label: 'Wave' })}{C('subOct', { label: 'Octave', size: KNOB })}{C('subDest', { label: 'To' })}</div>
      <div className="ovw-sub">Noise</div>
      <div className="ovw-knobs">{C('noiseLevel', { size: KNOB, label: 'Level' })}{C('noiseType', { label: 'Type' })}{C('noiseColor', { size: KNOB, label: 'Colour' })}{C('noiseDest', { label: 'To' })}</div>
    </div>
  );
}

function FilterModule({ ed, i }) {
  const { C, val } = ed;
  const [box, width] = useBoxWidth(280);
  const type = val(`f${i}Type`);
  const fi = FILTER_INFO[type];
  return (
    <div className={`ovw-filter ${val(`f${i}On`) ? '' : 'off'}`}>
      <div className="ovw-row">{C(`f${i}On`, { label: 'On' })}{C(`f${i}Type`, { options: ed.filterOptions, title: fi.desc })}</div>
      <div ref={box} className="ovw-graph">
        <FilterGraph type={type} cutoff={val(`f${i}Cutoff`)} resonance={val(`f${i}Res`)} drive={val(`f${i}Drive`)} morph={val(`f${i}Morph`)} on={val(`f${i}On`)}
          width={width} height={112} onChange={(f) => ed.setDrag(sectionToParams('filter', i, f), `f${i}:graph`)} />
      </div>
      <div className="ovw-knobs">
        {C(`f${i}Cutoff`, { size: KNOB + 12 })}{C(`f${i}Res`, { size: KNOB + 6 })}{C(`f${i}Drive`, { size: KNOB })}{C(`f${i}Key`, { size: KNOB })}
        {fi.morph && C(`f${i}Morph`, { label: fi.morph, size: KNOB })}
      </div>
    </div>
  );
}

function RoutingModule({ ed }) {
  const { val, set } = ed;
  const next = (d) => SOURCE_DESTS[(SOURCE_DESTS.indexOf(d) + 1) % SOURCE_DESTS.length];
  const sources = [
    ...['A', 'B', 'C'].map((x) => ({ id: `osc${x}`, short: x, label: `Oscillator ${x}`, color: ed.oscColors[x], on: !!val(`osc${x}On`), dest: val(`osc${x}Dest`), key: `osc${x}Dest` })),
    { id: 'sub', short: 'Sub', label: 'Sub', color: '#d9a85c', on: val('subLevel') > 0, dest: val('subDest'), key: 'subDest' },
    { id: 'noise', short: 'Nz', label: 'Noise', color: '#a0a8b8', on: val('noiseLevel') > 0, dest: val('noiseDest'), key: 'noiseDest' }
  ];
  return (
    <div className="ovw-routing-box">
      <RoutingDiagram sources={sources} f1On={!!val('f1On')} f2On={!!val('f2On')} route={val('filterRoute')}
        onCycle={(id) => { const s = sources.find((x) => x.id === id); set(s.key, next(s.dest)); }}
        onRoute={() => set('filterRoute', val('filterRoute') === 'serial' ? 'parallel' : 'serial')} />
    </div>
  );
}

function AmpModule({ ed }) {
  const { C, full } = ed;
  return (
    <div className="ovw-amp">
      <EnvelopeCurve env={paramsToSection(full, 'envelope', 1)} color={ed.envColors[0]} />
      <div className="ovw-knobs">{C('level', { size: KNOB })}{C('velSens', { size: KNOB, label: 'Vel' })}{C('relVelSens', { size: KNOB, label: 'Rel vel' })}{C('glide', { size: KNOB })}{C('polyphony', { size: KNOB, label: 'Poly' })}</div>
      <div className="ovw-knobs">{C('mono')}{C('legato')}{C('quality')}</div>
    </div>
  );
}

function EnvelopesModule({ ed }) {
  const [i, setI] = useState(1);
  const { C, full } = ed;
  const items = [1, 2, 3, 4].map((n) => ({ id: n, text: n === 1 ? 'ENV 1 · amp' : `ENV ${n}`, color: ed.envColors[n - 1], dim: n > 1 && !ed.used(`env${n}`) }));
  return (
    <div className="ovw-env" style={{ '--c': ed.envColors[i - 1] }}>
      <Picker items={items} value={i} onPick={setI} label="Envelope" />
      <EnvelopeEditor env={paramsToSection(full, 'envelope', i)} defaults={paramsToSection(ed.defaults, 'envelope', i)} color={ed.envColors[i - 1]} label={`Envelope ${i}`}
        onChange={(f) => ed.setDrag(sectionToParams('envelope', i, f), `env${i}:${Object.keys(f).sort().join('+')}`)} />
      <div className="ovw-knobs">{C(`env${i}Delay`, { size: KNOB })}{C(`env${i}A`, { label: 'Attack', size: KNOB })}{C(`env${i}Hold`, { size: KNOB })}{C(`env${i}D`, { label: 'Decay', size: KNOB })}{C(`env${i}S`, { label: 'Sustain', size: KNOB })}{C(`env${i}R`, { label: 'Release', size: KNOB })}</div>
    </div>
  );
}

function LfosModule({ ed }) {
  const [i, setI] = useState(1);
  const { C, val } = ed;
  const items = [1, 2, 3, 4].map((n) => ({ id: n, text: `LFO ${n}`, color: '#5ab8f0', dim: !ed.used(`lfo${n}`) }));
  const drawn = val(`lfo${i}Shape`) === 'steps';
  const sync = val(`lfo${i}Sync`);
  const steps = drawn ? Array.from({ length: val(`lfo${i}Steps`) }, (_, k) => val(`lfo${i}S${k + 1}`)) : null;
  return (
    <div className="ovw-lfo">
      <Picker items={items} value={i} onPick={setI} label="LFO" />
      {drawn
        ? <StepEditor steps={steps} smooth={val(`lfo${i}Smooth`)} label={`LFO ${i}`} onDraw={(k, v) => ed.setDrag({ [`lfo${i}S${k + 1}`]: v }, `lfo${i}:draw`)} />
        : <LfoGraph shape={val(`lfo${i}Shape`)} phase={val(`lfo${i}Phase`)} live={ed.live} source={`lfo${i}`} />}
      <div className="ovw-knobs">
        {C(`lfo${i}Shape`)}
        {sync === 'off' ? C(`lfo${i}Rate`, { size: KNOB }) : <div className="ggs-note" title="Tempo-synced">{syncBeats(sync)} beats</div>}
        {C(`lfo${i}Sync`)}{C(`lfo${i}Trig`)}{C(`lfo${i}Fade`, { size: KNOB })}{C(`lfo${i}Phase`, { size: KNOB })}
        {drawn && C(`lfo${i}Steps`, { size: KNOB })}{drawn && C(`lfo${i}Smooth`, { size: KNOB })}
      </div>
    </div>
  );
}

function ChaosModule({ ed }) {
  const [i, setI] = useState(1);
  const { C, val } = ed;
  const type = val(`chaos${i}Type`);
  const kind = CHAOS_INFO[type];
  const sync = val(`chaos${i}Sync`);
  const items = Array.from({ length: CHAOS_COUNT }, (_, k) => ({ id: k + 1, text: `CHAOS ${k + 1}`, color: '#ef7fb0', dim: !ed.used(`chaos${k + 1}`) }));
  return (
    <div className="ovw-chaos">
      <Picker items={items} value={i} onPick={setI} label="Chaos generator" />
      <ChaosGraph type={type} character={val(`chaos${i}Char`)} steps={val(`chaos${i}Steps`)} live={ed.live} source={`chaos${i}`} />
      <div className="ovw-knobs">
        {C(`chaos${i}Type`, { options: ed.chaosOptions })}
        {sync === 'off' ? C(`chaos${i}Rate`, { size: KNOB }) : <div className="ggs-note" title="Tempo-synced">{syncBeats(sync)} beats</div>}
        {C(`chaos${i}Sync`)}{C(`chaos${i}Char`, { label: kind.character, size: KNOB })}{type === 'turing' && C(`chaos${i}Steps`, { size: KNOB })}{C(`chaos${i}Path`)}
      </div>
    </div>
  );
}

function SourcesModule({ ed }) {
  const start = (source) => (e) => {
    e.dataTransfer.setData(SOURCE_MIME, source);
    e.dataTransfer.setData('text/plain', source);
    e.dataTransfer.effectAllowed = 'link';
    document.body.classList.add('ggs-dragging');
  };
  const end = () => document.body.classList.remove('ggs-dragging');
  useEffect(() => end, []);
  const count = (s) => ed.routes.filter((r) => r.source === s || r.via === s).length;
  return (
    <div className="ovw-sources" data-nodrag role="toolbar" aria-label="Modulation sources: drag one onto a knob">
      {SOURCE_GROUPS.map((group) => (
        <div key={group[0]} className="ovw-src-group">
          {group.map((s) => {
            const n = count(s);
            return (
              <button key={s} className={`ovw-src ${sourceFamily(s)} ${n ? 'used' : ''}`} draggable onDragStart={start(s)} onDragEnd={end} onClick={() => ed.showInMatrix(s)}
                style={{ '--c': sourceColor(s) }} data-source={s}
                title={`${ed.sourceName(s)}: ${MOD_SOURCE_INFO[s]}.\nDrag onto a knob to modulate it${n ? ` · ${n} route${n > 1 ? 's' : ''}: click to see them` : ''}`}>
                <span>{sourceShort(s)}{n ? <i>{n}</i> : null}</span>
                <SourceSpark source={s} live={ed.live} color={sourceColor(s)} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function MatrixModule({ ed }) {
  const { routes, full, set } = ed;
  return (
    <div className="ovw-matrix">
      <div className="ovw-row spread">
        <span className="ovw-count">{routes.length} / {MOD_SLOTS} routes</span>
        <button className="btn tiny" onClick={() => ed.showInMatrix('')}>Open the matrix</button>
      </div>
      {!routes.length && <p className="ovw-desc">No modulation yet: drag a source onto a knob.</p>}
      <ul>
        {routes.map((r) => (
          <li key={r.slot} title={describeRoute(full, r)}>
            <i className="ggs-dot" style={{ background: sourceColor(r.source) }} />
            <span className="from" style={{ color: sourceColor(r.source) }}>{ed.sourceName(r.source)}{r.via ? ` × ${modSourceLabel(r.via)}` : ''}</span>
            <span className="to">→ {modTargetLabel(r.target, full)}</span>
            <input type="range" min={-1} max={1} step={0.01} value={r.amount} data-nodrag aria-label={`Amount of ${r.source} to ${r.target}`}
              style={{ '--c': sourceColor(r.source), '--a': `${50 + r.amount * 50}%` }} onChange={(e) => set(`mod${r.slot}Amt`, Number(e.target.value) || 0.01)} />
            <span className="amt">{r.amount > 0 ? '+' : ''}{r.amount.toFixed(2)}</span>
            <button className="tbtn small" onClick={() => ed.removeRoute(r.slot)} aria-label={`Remove route ${r.source} to ${r.target}`} title="Remove">×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FxModule({ ed }) {
  const { C, val } = ed;
  const card = (name, on, picture, knobs) => (
    <div className={`ovw-fx ${on ? 'on' : ''}`} key={name}>
      <div className="ovw-fx-head"><i />{name}</div>
      {picture}
      <div className="ovw-knobs">{knobs}</div>
    </div>
  );
  return (
    <div className="ovw-fxrack">
      {card('Drive', val('driveAmt') > 0, <DriveCurve amount={val('driveAmt')} type={val('driveType')} color="#f59f42" />,
        [C('driveAmt', { label: 'Amount', size: KNOB }), C('driveType', { label: 'Type' }), C('driveOs', { label: 'Rate' })])}
      {card('Chorus', val('chorusMix') > 0, <ChorusWobble mix={val('chorusMix')} rate={val('chorusRate')} depth={val('chorusDepth')} color="#5ab8f0" />,
        [C('chorusMix', { label: 'Mix', size: KNOB }), C('chorusRate', { label: 'Rate', size: KNOB }), C('chorusDepth', { label: 'Depth', size: KNOB })])}
      {card('Delay', val('delayMix') > 0, <DelayTaps mix={val('delayMix')} feedback={val('delayFb')} pingPong={val('delayPing')} color="#9ad94f" />,
        [C('delayMix', { label: 'Mix', size: KNOB }), C('delaySync', { label: 'Time' }), ...(val('delaySync') === 'free' ? [C('delayTime', { size: KNOB })] : []), C('delayFb', { label: 'Feedback', size: KNOB }), C('delayTone', { label: 'Tone', size: KNOB }), C('delayPing', { label: 'Ping-pong' })])}
      {card('Reverb', val('reverbMix') > 0, <ReverbTail mix={val('reverbMix')} size={val('reverbSize')} damp={val('reverbDamp')} color="#c86be0" />,
        [C('reverbMix', { label: 'Mix', size: KNOB }), C('reverbSize', { label: 'Size', size: KNOB }), C('reverbDamp', { label: 'Damping', size: KNOB })])}
    </div>
  );
}

function ScopeModule({ ed }) {
  const id = ed.channel.id;
  const analyser = useCallback(() => getEngine()?.channelAnalyser?.(id) ?? null, [id]);
  const release = useCallback(() => getEngine()?.releaseChannelAnalyser?.(id), [id]);
  return (
    <div className="ovw-scope">
      <OutputScope analyser={analyser} release={release} />
      <p className="ovw-desc">This channel now: its wave (top) and its spectrum (bottom). Hold the pad or play notes.</p>
    </div>
  );
}

function PadModule({ ed }) {
  const { TouchPad } = ed;
  return <div className="ovw-pad"><TouchPad channel={ed.channel} /></div>;
}

const RENDER = {
  header: (ed) => <HeaderModule ed={ed} />,
  oscA: (ed) => <OscModule ed={ed} x="A" />,
  oscB: (ed) => <OscModule ed={ed} x="B" />,
  oscC: (ed) => <OscModule ed={ed} x="C" />,
  subnoise: (ed) => <SubNoiseModule ed={ed} />,
  filter1: (ed) => <FilterModule ed={ed} i={1} />,
  routing: (ed) => <RoutingModule ed={ed} />,
  filter2: (ed) => <FilterModule ed={ed} i={2} />,
  amp: (ed) => <AmpModule ed={ed} />,
  envelopes: (ed) => <EnvelopesModule ed={ed} />,
  lfos: (ed) => <LfosModule ed={ed} />,
  chaos: (ed) => <ChaosModule ed={ed} />,
  sources: (ed) => <SourcesModule ed={ed} />,
  matrix: (ed) => <MatrixModule ed={ed} />,
  fx: (ed) => <FxModule ed={ed} />,
  scope: (ed) => <ScopeModule ed={ed} />,
  pad: (ed) => <PadModule ed={ed} />
};

/**
 * One module's contents. Ops on other channels, the transport or the song re-render the editor; a module only redraws
 * when what it shows can have changed (`ed.stamp`: this channel, the route an Alt-drag edits).
 */
const ModuleBody = memo(function ModuleBody({ id, ed }) {
  return RENDER[id](ed);
}, (a, b) => a.id === b.id && a.ed.stamp === b.ed.stamp);

/** A module's title: its own name, with the oscillator's colour and the filter's type where that helps. */
function titleOf(id, ed) {
  if (id.startsWith('osc')) return <b style={{ color: ed.oscColors[id.slice(3)] }}>{MODULES[id].label}</b>;
  if (id.startsWith('filter')) return <><b>{MODULES[id].label}</b><span>{FILTER_INFO[ed.val(`f${id.slice(6)}Type`)]?.label}</span></>;
  if (id === 'routing') return <><b>Routing</b><span>{ed.val('filterRoute')}</span></>;
  return <b>{MODULES[id].label}</b>;
}

// ---- the tab ---------------------------------------------------------------------------------------------------

export function Overview({ ed }) {
  const st = useStore.getState();
  const [layouts, setLayouts] = useState(() => loadLayouts());
  const [arranging, setArranging] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [solo, setSolo] = useState(false);
  const layout = layouts.current;
  const all = useMemo(() => [...BUILT_IN_LAYOUTS, ...layouts.saved], [layouts.saved]);

  // remembered in this browser; layouts saved in another tab show up here too
  const loaded = useRef(true);
  useEffect(() => {
    if (loaded.current) { loaded.current = false; return; }
    storeLayouts(layouts);
  }, [layouts]);
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return;
      const { saved } = loadLayouts();
      // only when the saved list really changed: two tabs must not keep answering each other
      setLayouts((s) => (JSON.stringify(s.saved) === JSON.stringify(saved) ? s : { ...s, saved }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const change = (fn) => setLayouts((s) => {
    const moved = fn(s.current);
    return sameItems(moved, s.current) ? s : { ...s, current: { ...moved, edited: true } };
  });
  const choose = (name) => {
    const found = all.find((l) => l.name === name);
    if (found) setLayouts((s) => ({ ...s, current: normalizeLayout(found, found.name) }));
  };
  const save = async () => {
    const name = await st.prompt({ title: 'Save this layout', value: layout.builtIn ? '' : layout.name, label: 'Name' });
    if (name === null || name === undefined) return;
    let saved;
    try {
      saved = saveAs(layouts.saved, layout, name);
    } catch (e) {
      st.toast(e.message, 'warn');
      return;
    }
    setLayouts({ saved, current: saved.at(-1) });
    st.toast(`Layout "${saved.at(-1).name}" saved`, 'success', 1800);
  };
  const remove = () => setLayouts((s) => ({ saved: s.saved.filter((l) => l.name !== s.current.name), current: normalizeLayout(BUILT_IN_LAYOUTS[0]) }));
  const isSaved = layouts.saved.some((l) => l.name === layout.name);
  const hidden = hiddenModules(layout);

  // full screen: the modules alone over the whole page (menus, dialogs and messages still show above them), and the
  // browser's full screen around the page when it has one (not every phone does)
  const entered = useRef(false);
  const leave = useCallback(() => {
    setSolo(false);
    if (entered.current && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    entered.current = false;
  }, []);
  const fullScreen = () => {
    if (solo) { leave(); return; }
    document.activeElement?.blur?.(); // the toolbar hides until hovered: it must not stay up because its button has focus
    setSolo(true);
    const page = document.documentElement;
    if (!document.fullscreenElement && page.requestFullscreen) {
      page.requestFullscreen().then(() => { entered.current = true; }).catch(() => {});
    }
  };
  useEffect(() => {
    if (!solo) return undefined;
    const onChange = () => { if (!document.fullscreenElement && entered.current) { entered.current = false; setSolo(false); } };
    const onKey = (e) => {
      const now = useStore.getState();
      if (e.key === 'Escape' && !now.modal && !now.contextMenu) { e.stopPropagation(); leave(); } // a dialog or a menu closes first
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [solo, leave]);
  useEffect(() => () => { if (entered.current && document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }, []);

  // moving modules by dragging their grip onto another module (it goes before it) or onto the end
  const dragStart = (id) => (e) => {
    e.dataTransfer.setData(MODULE_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(id);
  };
  const dragOver = (id) => (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (over !== id) setOver(id);
  };
  const drop = (id) => (e) => {
    e.preventDefault();
    const moved = e.dataTransfer.getData(MODULE_MIME) || dragging;
    if (moved && moved !== id) change((l) => moveModule(l, moved, id));
    setDragging(null);
    setOver(null);
  };

  const options = [
    ...BUILT_IN_LAYOUTS.map((l) => ({ value: l.name, label: l.name, group: 'Built in' })),
    ...layouts.saved.map((l) => ({ value: l.name, label: l.name, group: 'Saved' }))
  ];
  const view = (
    <div className={`ovw ${arranging ? 'arranging' : ''} ${solo ? 'solo' : ''}`} data-nodrag>
      <div className="ovw-bar">
        <span className="ovw-bar-label">Layout</span>
        <Select value={all.some((l) => l.name === layout.name) ? layout.name : ''} options={all.some((l) => l.name === layout.name) ? options : [{ value: '', label: `${layout.name} (changed)` }, ...options]}
          onChange={(v) => v && choose(v)} title="A saved arrangement of the modules" />
        {layout.edited && <span className="ovw-changed" title="Moved, resized or hidden since it was chosen">changed</span>}
        <button className={`btn tiny ${arranging ? 'on' : ''}`} aria-pressed={arranging} onClick={() => setArranging(!arranging)}
          title="Move modules by their grip, make them wider or narrower, hide them or add them back">
          {arranging ? 'Done' : 'Arrange'}
        </button>
        {arranging && hidden.length > 0 && (
          <Select value="" className="ovw-add" title="Add a hidden module at the end"
            options={[{ value: '', label: `+ Add a module (${hidden.length})` }, ...hidden.map((id) => ({ value: id, label: MODULES[id].label }))]}
            onChange={(id) => id && change((l) => showModule(l, id))} />
        )}
        <button className="btn tiny" onClick={save} title="Keep this arrangement under a name (in this browser)">Save as…</button>
        {isSaved && <button className="btn tiny" onClick={remove} title="Forget this saved layout">Delete</button>}
        {layout.edited && all.some((l) => l.name === layout.name) && <button className="btn tiny" onClick={() => choose(layout.name)} title="Back to the layout as it was saved">Revert</button>}
        <span className="ovw-bar-gap" />
        <button className="btn tiny" onClick={fullScreen} aria-pressed={solo}
          title={solo ? 'Back to the editor (Esc)' : 'Show only these modules, on the whole screen (Esc to leave) — for recording a video'}>
          <Icon name={solo ? 'restore' : 'max'} size={12} /> {solo ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>
      <div className="ovw-grid" style={{ '--cols': COLUMNS }}>
        {layout.items.map(({ id, w }, index) => (
          <section key={id} className={`ovw-mod ${over === id && dragging !== id ? 'drop' : ''} ${dragging === id ? 'lifted' : ''}`} data-module={id} style={{ gridColumn: `span ${w}` }}
            onDragOver={dragOver(id)} onDragLeave={() => over === id && setOver(null)} onDrop={drop(id)}>
            <header className="ovw-mod-head">
              {arranging && (
                <span className="ovw-grip" draggable onDragStart={dragStart(id)} onDragEnd={() => { setDragging(null); setOver(null); }} title="Drag to move" aria-hidden="true">⠿</span>
              )}
              {titleOf(id, ed)}
              {arranging && (
                <span className="ovw-mod-tools">
                  <button className="tbtn small" aria-label={`Move ${MODULES[id].label} earlier`} title="Earlier" disabled={index === 0} onClick={() => change((l) => nudgeModule(l, id, -1))}>◀</button>
                  <button className="tbtn small" aria-label={`Move ${MODULES[id].label} later`} title="Later" disabled={index === layout.items.length - 1} onClick={() => change((l) => nudgeModule(l, id, 1))}>▶</button>
                  <span className="ovw-width-tools">
                    <button className="tbtn small" aria-label={`Make ${MODULES[id].label} narrower`} title="Narrower" disabled={w <= 2} onClick={() => change((l) => resizeModule(l, id, -1))}>−</button>
                    <span className="ovw-width" title="Columns of 12">{w}</span>
                    <button className="tbtn small" aria-label={`Make ${MODULES[id].label} wider`} title="Wider" disabled={w >= COLUMNS} onClick={() => change((l) => resizeModule(l, id, 1))}>+</button>
                  </span>
                  <button className="tbtn small" aria-label={`Hide ${MODULES[id].label}`} title="Hide (add it back from “+ Add a module”)" onClick={() => change((l) => hideModule(l, id))}>×</button>
                </span>
              )}
            </header>
            <div className="ovw-body"><ModuleBody id={id} ed={ed} /></div>
          </section>
        ))}
        {arranging && (
          <div className={`ovw-end ${over === '__end' ? 'drop' : ''}`} style={{ gridColumn: `span ${COLUMNS}` }}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver('__end'); } }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); const moved = e.dataTransfer.getData(MODULE_MIME) || dragging; if (moved) change((l) => moveModule(l, moved, null)); setDragging(null); setOver(null); }}>
            Drop here to move a module to the end
          </div>
        )}
        {!layout.items.length && <p className="ovw-empty">Every module is hidden. <button className="btn tiny" onClick={() => setArranging(true)}>Arrange</button> to add some, or pick a layout.</p>}
      </div>
    </div>
  );
  // in full screen the same view is drawn over the page, outside the window (which would clip it and sit under others)
  return solo ? createPortal(view, document.body) : view;
}
