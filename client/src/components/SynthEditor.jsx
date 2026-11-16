// The GGS Synth editor: shown in the Channel window for channels whose instrument is the GGS Synth. Every control is
// one of the synth's flat params (packages/synth-dsp/src/params.js) and every change is a channel/update op, so it
// is undoable, synced live and heard on notes that are already sounding.
import { useCallback, useEffect, useRef, useState } from 'react';
import { sanitizeParams } from '@greanteadawy/core';
import {
  GGS_PARAMS, GGS_PRESET_INFO, OSC_IDS, MOD_SLOTS, MOD_SOURCES, MOD_TARGETS, MOD_SOURCE_INFO, MOD_TARGET_INFO, FILTER_TYPES, FILTER_INFO,
  MACRO_COUNT, CHAOS_COUNT, CHAOS_TYPES, CHAOS_INFO, chaosPreview, macroLabel, macroUsed, modSourceLabel, modTargetLabel,
  ggsParamDef, ggsDefaults, wavetablePreview, wavetableSpectrum, modulationRoutes, describeRoute, paramsToPatch, patchToParams, paramsToSection, sectionToParams, syncBeats
} from '@greanteadawy/synth-dsp';
import { useStore } from '../state/store.js';
import { getEngine, onEngineReady } from '../audio/index.js';
import { Knob } from './ui/Knob.jsx';
import { Select } from './ui/Controls.jsx';
import { download, pickFile } from '../lib/actions.js';
import { EnvelopeEditor } from './synth/EnvelopeEditor.jsx';
import { FilterGraph } from './synth/FilterGraph.jsx';
import { PresetBrowser } from './synth/PresetBrowser.jsx';
import { WavetablePicker } from './synth/WavetablePicker.jsx';
import { ParamTable } from './synth/ParamTable.jsx';
import { SourceBar, SourceMeter } from './synth/SourceBar.jsx';
import { SOURCE_GROUPS, sourceFamily, sourceColor, ringsOf, liveTarget, liveSource } from './synth/modulation.js';

const TABS = [['osc', 'Oscillators'], ['filter', 'Filters'], ['mod', 'Modulators'], ['matrix', 'Matrix'], ['fx', 'Effects'], ['all', 'All parameters']];
const FAMILY_LABEL = { env: 'Envelopes', lfo: 'LFOs', chaos: 'Chaos', note: 'The note (velocity, pressure, slide …)', macro: 'Macros' };
const CHAOS_OPTIONS = CHAOS_TYPES.map((t) => ({ value: t, label: CHAOS_INFO[t].label }));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// the knobs that are also modulation targets: they show rings, take dropped sources and have a modulation menu
const TARGET_KEYS = new Set(MOD_TARGETS.filter((t) => ggsParamDef(t)?.type === 'number'));
const OSC_COLORS = { A: '#46c79a', B: '#5ab8f0', C: '#f59f42' };
const ENV_COLORS = ['#9ad94f', '#f59f42', '#5ab8f0', '#c86be0'];
const DEFAULTS = ggsDefaults();
// the filter menu, grouped by character rather than in catalogue order
const FILTER_GROUPS = [['Clean', ['clean']], ['Analog', ['ladder', 'acid', 'ms20']], ['Special', ['formant', 'phaser', 'comb']]];
const FILTER_OPTIONS = FILTER_GROUPS.flatMap(([group, families]) => FILTER_TYPES.filter((id) => families.includes(FILTER_INFO[id].family)).map((id) => ({ value: id, label: FILTER_INFO[id].label, group })));

/** A canvas that redraws when its inputs change (sized for the device's pixel ratio). */
function Scope({ draw, deps, width = 150, height = 56, title }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = width * dpr;
    cv.height = height * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    draw(g, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <canvas ref={ref} className="ggs-scope" style={{ width, height }} title={title} />;
}

function line(g, pts, color, w = 1.6) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = color;
  g.lineWidth = w;
  g.lineJoin = 'round';
  g.stroke();
}

/** One cycle of the oscillator at its position, with the harmonic spectrum underneath. */
function WaveView({ table, pos, color, on }) {
  return (
    <Scope width={168} height={64} deps={[table, Math.round(pos * 200), color, on]} title="Waveform (top) and harmonics (bottom) at this position"
      draw={(g, w, h) => {
        const wave = wavetablePreview(table, pos, 160);
        const top = h * 0.62;
        g.globalAlpha = on ? 1 : 0.35;
        g.fillStyle = 'rgba(255,255,255,0.04)';
        g.fillRect(0, 0, w, top);
        let peak = 0.001;
        for (const v of wave) peak = Math.max(peak, Math.abs(v));
        line(g, Array.from(wave, (v, i) => [(i / (wave.length - 1)) * w, top / 2 - (v / peak) * (top / 2 - 3)]), color, 1.8);
        const spec = wavetableSpectrum(table, pos, 32);
        const bw = w / spec.length;
        g.fillStyle = color;
        for (let i = 0; i < spec.length; i++) {
          // 60 dB of range, so quiet upper harmonics still show
          const lvl = Math.max(0, 1 + (20 * Math.log10(spec[i] + 1e-6)) / 60);
          g.fillRect(i * bw + 0.5, h - lvl * (h - top - 3), Math.max(1, bw - 1.5), lvl * (h - top - 3));
        }
      }} />
  );
}

function LfoView({ shape, phase }) {
  return (
    <Scope width={110} height={40} deps={[shape, phase]} title="Two cycles of the LFO"
      draw={(g, w, h) => {
        const rnd = [0.3, -0.7, 0.9, -0.2, 0.6];
        const pts = [];
        for (let i = 0; i <= w; i++) {
          const ph = (i / w) * 2 + phase;
          const x = ph - Math.floor(ph);
          const cyc = Math.floor(ph);
          const v = shape === 'triangle' ? (x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4) : shape === 'saw' ? 1 - 2 * x : shape === 'ramp' ? 2 * x - 1
            : shape === 'square' ? (x < 0.5 ? 1 : -1) : shape === 'sh' ? rnd[cyc % 5] : shape === 'smooth' ? rnd[cyc % 5] + (rnd[(cyc + 1) % 5] - rnd[cyc % 5]) * x * x * (3 - 2 * x) : Math.sin(2 * Math.PI * x);
          pts.push([i, h / 2 - v * (h / 2 - 3)]);
        }
        line(g, pts, '#5ab8f0');
      }} />
  );
}

/** Twelve cycles of a chaos generator: what kind of movement the settings give (every note takes its own path). */
function ChaosView({ type, character, steps }) {
  return (
    <Scope width={220} height={44} deps={[type, Math.round(character * 100), steps]} title="Twelve cycles of this generator. The path is different for every note unless Path is “same”."
      draw={(g, w, h) => {
        const pts = chaosPreview({ type, character, steps }, w, 12, 3);
        g.strokeStyle = 'rgba(255,255,255,0.1)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
        line(g, Array.from(pts, (v, i) => [i, h / 2 - v * (h / 2 - 3)]), '#ef7fb0');
      }} />
  );
}

/**
 * A pad to play the patch with a mouse or finger the way an MPE controller would: holding it plays a note, up/down
 * is pressure and left/right is slide — straight into that note's own pressure and timbre inputs.
 */
function TouchPad({ channel }) {
  const ref = useRef(null);
  const held = useRef(null);
  const pressed = useRef(false); // set and cleared synchronously: audio may unlock only after the pointer is up again
  const [dot, setDot] = useState(null);
  const where = (e) => {
    const r = ref.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) };
  };
  const move = (e) => {
    const p = where(e);
    setDot(p);
    const v = held.current;
    if (!v?.expr) return;
    const now = v.ctx.currentTime;
    v.expr.timbre.setTargetAtTime(p.x, now, 0.015);
    v.expr.pressure.setTargetAtTime(p.y, now, 0.015);
  };
  const down = async (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = where(e);
    setDot(p);
    pressed.current = true;
    const eng = await useStore.getState().unlockAudio();
    if (!eng || held.current || !pressed.current) return;
    const v = eng.noteOn(channel.id, channel.rootKey, 0.8);
    if (!v) return;
    held.current = v;
    v.expr?.timbre.setValueAtTime(p.x, eng.ctx.currentTime);
    v.expr?.pressure.setValueAtTime(p.y, eng.ctx.currentTime);
  };
  const up = () => {
    pressed.current = false;
    const v = held.current;
    held.current = null;
    setDot(null);
    if (v) { v.noteEnd = v.ctx.currentTime; v.release(v.ctx.currentTime); }
  };
  useEffect(() => up, []);
  return (
    <div className="ggs-pad" ref={ref} onPointerDown={down} onPointerMove={(e) => held.current && move(e)} onPointerUp={up} onPointerCancel={up} data-nodrag
      role="application" aria-label="Expression pad: hold to play, up and down is pressure, left and right is slide"
      title="Hold to play the step note. Up/down = pressure, left/right = slide: what this patch does with a touch.">
      <span className="ggs-pad-x">slide →</span>
      <span className="ggs-pad-y">pressure ↑</span>
      {dot && <i style={{ left: `${dot.x * 100}%`, bottom: `${dot.y * 100}%` }} />}
    </div>
  );
}

export function SynthEditor({ channel }) {
  const [tab, setTab] = useState('osc');
  const [matrixFilter, setMatrixFilter] = useState('');
  const [active, setActive] = useState({}); // target → the slot whose depth Alt-drag changes there
  const st = useStore.getState();
  const p = channel.instrument.params;
  const info = GGS_PRESET_INFO[channel.instrument.preset] || GGS_PRESET_INFO.Init;
  const val = (key) => p[key] ?? DEFAULTS[key];
  const set = (key, value) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { params: { [key]: value } } } }], { coalesce: `ggs:${channel.id}:${key}` });
  const setMany = (params) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { params } } }]);
  /** Several params moved together by one drag (a node of the envelope, the handle on the filter curve): one undo step. */
  const setDrag = (params, what) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { params } } }], { coalesce: `ggs:${channel.id}:${what}` });
  const pickPreset = (preset) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { preset } } }]);

  const full = { ...DEFAULTS, ...p };
  const routes = modulationRoutes(full);
  const freeSlot = () => {
    for (let i = 1; i <= MOD_SLOTS; i++) if (val(`mod${i}Src`) === 'none' || val(`mod${i}Dst`) === 'none' || !val(`mod${i}Amt`)) return i;
    return 0;
  };
  const addRoute = (source = 'pressure', target = 'f1Cutoff', amount = 0.3, via = 'none') => {
    const i = freeSlot();
    if (!i) { st.toast(`All ${MOD_SLOTS} modulation slots are in use`, 'warn'); return 0; }
    setMany({ [`mod${i}Src`]: source, [`mod${i}Dst`]: target, [`mod${i}Amt`]: amount, [`mod${i}Via`]: via });
    return i;
  };
  const removeRoute = (i) => setMany({ [`mod${i}Src`]: 'none', [`mod${i}Dst`]: 'none', [`mod${i}Amt`]: 0, [`mod${i}Via`]: 'none' });
  const usedSources = new Set(routes.flatMap((r) => (r.via ? [r.source, r.via] : [r.source])));
  const used = (source) => usedSources.has(source);
  const macroNames = Object.fromEntries(Array.from({ length: MACRO_COUNT }, (_, k) => [`macro${k + 1}`, macroLabel(full, k + 1, info.macros)]));
  const sourceName = (s) => (macroNames[s] && macroNames[s] !== modSourceLabel(s) ? `${modSourceLabel(s)} · ${macroNames[s]}` : modSourceLabel(s));

  // ---- live modulation: while the editor is open the channel's voices report where their modulation stands
  const live = useCallback(() => getEngine()?.ggsLive(channel.id) ?? null, [channel.id]);
  useEffect(() => {
    // (the engine only exists after the first click; the rig of a new channel a moment after the channel)
    const watch = (on) => getEngine()?.watchGgs(channel.id, on);
    const off = onEngineReady(() => watch(true));
    const again = setInterval(() => watch(true), 1000);
    return () => { off(); clearInterval(again); watch(false); };
  }, [channel.id]);
  const latest = useRef(full);
  latest.current = full;
  const liveFns = useRef(new Map());
  /** A stable function per knob that says where its control really is right now (null: no note sounding). */
  const liveOf = (key) => {
    let fn = liveFns.current.get(key);
    if (!fn) {
      fn = /^macro\d$/.test(key) ? () => liveSource(live(), key) : () => liveTarget(live(), key, latest.current);
      liveFns.current.set(key, fn);
    }
    return fn;
  };

  // ---- modulating from the knobs: drop a source on a knob or right-click it; Alt-drag sets the depth
  /** The route Alt-drag changes on a knob: the one last added or chosen there, else the deepest. */
  const activeRoute = (target) => {
    const here = routes.filter((r) => r.target === target);
    return here.find((r) => r.slot === active[target]) || here.sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount))[0] || null;
  };
  const modulate = (source, target) => {
    const same = routes.find((r) => r.source === source && r.target === target && !r.via);
    const slot = same ? same.slot : addRoute(source, target, 0.25);
    if (slot) setActive((m) => ({ ...m, [target]: slot }));
  };
  const changeDepth = (target, delta) => {
    const r = activeRoute(target);
    if (!r) return;
    const now = latest.current[`mod${r.slot}Amt`] ?? r.amount;
    // (a depth of exactly 0 would switch the route off and make it vanish from the matrix mid-drag)
    set(`mod${r.slot}Amt`, clamp(Math.round((now + delta) * 1000) / 1000, -1, 1) || (delta < 0 ? -0.005 : 0.005));
  };
  const showInMatrix = (text) => { setMatrixFilter(text); setTab('matrix'); };
  const knobMenu = (key, d) => (e) => {
    const here = routes.filter((r) => r.target === key);
    const chosen = activeRoute(key);
    st.showContextMenu(e, [
      { header: modTargetLabel(key, full) },
      {
        label: 'Modulate with',
        submenu: SOURCE_GROUPS.map((group) => ({
          label: FAMILY_LABEL[sourceFamily(group[0])],
          submenu: group.map((src) => ({ label: sourceName(src), checked: here.some((r) => r.source === src), onClick: () => modulate(src, key) }))
        }))
      },
      ...(here.length ? ['-'] : []),
      ...here.map((r) => ({
        label: `${sourceName(r.source)}${r.via ? ` × ${modSourceLabel(r.via)}` : ''}  ${r.amount > 0 ? '+' : ''}${r.amount.toFixed(2)}`,
        submenu: [
          { label: 'Alt-drag sets this depth', checked: chosen?.slot === r.slot, onClick: () => setActive((m) => ({ ...m, [key]: r.slot })) },
          { label: 'Invert', onClick: () => set(`mod${r.slot}Amt`, -r.amount) },
          { label: 'Remove', danger: true, onClick: () => removeRoute(r.slot) }
        ]
      })),
      ...(here.length ? [{ label: 'Show in the matrix', onClick: () => showInMatrix(key) }] : []),
      '-',
      { label: 'Reset to default', onClick: () => set(key, d.default) }
    ]);
  };

  /** The control for one param: knob, dropdown or switch, by its definition. */
  const C = (key, opts = {}) => {
    const d = ggsParamDef(key);
    const label = opts.label ?? d.label;
    // every control explains itself on hover (the same text as the All parameters tab)
    let title = opts.title || d.desc;
    if (d.type === 'number') {
      const target = TARGET_KEYS.has(key);
      const rings = target ? ringsOf(routes, key, full) : null;
      if (target) {
        const chosen = rings.length ? activeRoute(key) : null;
        title += rings.length
          ? `\nModulated by ${rings.map((r) => sourceName(r.source)).join(', ')}. Alt-drag: depth of ${sourceName(chosen.source)}. Right-click for more.`
          : '\nDrop a source here, or right-click, to modulate it.';
      }
      return (
        <Knob key={key} value={val(key)} min={d.min} max={d.max} def={d.default} curve={d.curve} step={d.step} label={label} unit={d.unit}
          color={opts.color} showValue size={opts.size || 30} bipolar={d.min < 0} title={title} className={opts.className}
          rings={rings} live={rings?.length || opts.live ? liveOf(key) : undefined}
          onAltDrag={target && rings.length ? (delta) => changeDepth(key, delta) : undefined}
          onDropSource={target ? (src) => MOD_SOURCES.includes(src) && src !== 'none' && modulate(src, key) : undefined}
          onContextMenu={target ? knobMenu(key, d) : undefined}
          onChange={(v) => set(key, d.step ? Math.round(v) : Math.round(v * 10000) / 10000)} />
      );
    }
    if (d.type === 'select') {
      return (
        <label key={key} className="param-select" title={title}>
          <Select value={val(key)} options={opts.options || d.options} onChange={(v) => set(key, v)} />
          <span>{label}</span>
        </label>
      );
    }
    return (
      <label key={key} className="param-bool" title={title}>
        <button className={`toggle ${val(key) ? 'on' : ''}`} onClick={() => set(key, !val(key))} aria-pressed={!!val(key)}>{val(key) ? 'ON' : 'OFF'}</button>
        <span>{label}</span>
      </label>
    );
  };

  const exportPatch = () => download(new Blob([JSON.stringify(paramsToPatch(p, { name: channel.name }), null, 2)], { type: 'application/json' }), `${channel.name.replace(/[^\w-]+/g, '_')}.ggs-patch.json`);
  const importPatch = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      // a document replaces the patch: start from the init patch, then what the file says (values are clamped)
      const params = { ...DEFAULTS, ...sanitizeParams(GGS_PARAMS, patchToParams(JSON.parse(await file.text()))) };
      setMany(params);
      st.toast(`Loaded patch "${file.name}"`, 'success');
    } catch (e) {
      st.toast(`Not a GGS patch: ${e.message}`, 'error');
    }
  };

  const oscPanel = (x) => {
    const on = val(`osc${x}On`);
    const color = OSC_COLORS[x];
    return (
      <fieldset key={x} className={`param-group ggs-osc ${on ? '' : 'off'}`}>
        <legend style={{ color }}>Oscillator {x}</legend>
        <div className="ggs-osc-top">
          <WaveView table={val(`osc${x}Table`)} pos={val(`osc${x}Pos`)} color={color} on={on} />
          <div className="ggs-osc-pick">
            {C(`osc${x}On`, { label: 'Power' })}
            {C(`osc${x}Dest`)}
          </div>
        </div>
        <WavetablePicker value={val(`osc${x}Table`)} color={color} onPick={(v) => set(`osc${x}Table`, v)} />
        <div className="param-row">
          {C(`osc${x}Pos`, { color })}{C(`osc${x}Level`, { color })}{C(`osc${x}Pan`, { color })}
          {C(`osc${x}Oct`, { color })}{C(`osc${x}Semi`, { color })}{C(`osc${x}Fine`, { color })}
        </div>
        <div className="param-row">
          {C(`osc${x}Unison`, { color })}{C(`osc${x}Detune`, { color })}{C(`osc${x}Blend`, { color })}{C(`osc${x}Spread`, { color })}
          {C(`osc${x}Phase`, { color })}{C(`osc${x}Rand`, { color })}
        </div>
        <div className="param-row">
          {C(`osc${x}Warp`)}{C(`osc${x}WarpAmt`, { color, label: 'Warp' })}
          {C(`osc${x}FmFrom`)}{C(`osc${x}Fm`, { color, label: 'FM' })}
        </div>
      </fieldset>
    );
  };

  const filterPanel = (i) => {
    const type = val(`f${i}Type`);
    const info = FILTER_INFO[type];
    return (
      <fieldset key={i} className={`param-group ggs-filter ${val(`f${i}On`) ? '' : 'off'}`}>
        <legend>Filter {i}</legend>
        <div className="ggs-filter-top">{C(`f${i}On`, { label: 'Power' })}{C(`f${i}Type`, { options: FILTER_OPTIONS, title: info.desc })}</div>
        <FilterGraph type={type} cutoff={val(`f${i}Cutoff`)} resonance={val(`f${i}Res`)} drive={val(`f${i}Drive`)} morph={val(`f${i}Morph`)} on={val(`f${i}On`)}
          width={308} height={100} onChange={(f) => setDrag(sectionToParams('filter', i, f), `f${i}:graph`)} />
        <div className="param-row">
          {C(`f${i}Cutoff`)}{C(`f${i}Res`)}{C(`f${i}Drive`)}{C(`f${i}Key`)}
          {info.morph && C(`f${i}Morph`, { label: info.morph })}
        </div>
        <p className="cs-desc ggs-filter-desc">{info.desc}</p>
      </fieldset>
    );
  };

  const envPanel = (i) => (
    <fieldset key={i} className={`param-group ggs-env ${i === 1 || used(`env${i}`) ? '' : 'idle'}`} title={i > 1 && !used(`env${i}`) ? 'Not routed yet: add a route in the Matrix tab' : undefined}>
      <legend>{i === 1 ? 'Envelope 1 · amp' : `Envelope ${i}`}<SourceMeter source={`env${i}`} live={live} className="in-legend" /></legend>
      <EnvelopeEditor env={paramsToSection({ ...DEFAULTS, ...p }, 'envelope', i)} defaults={paramsToSection(DEFAULTS, 'envelope', i)} color={ENV_COLORS[i - 1]} label={`Envelope ${i}`}
        onChange={(f) => setDrag(sectionToParams('envelope', i, f), `env${i}:graph`)} />
      <div className="param-row">{C(`env${i}Delay`)}{C(`env${i}A`, { label: 'A' })}{C(`env${i}Hold`)}{C(`env${i}D`, { label: 'D' })}{C(`env${i}S`, { label: 'S' })}{C(`env${i}R`, { label: 'R' })}</div>
    </fieldset>
  );

  const lfoPanel = (i) => {
    const sync = val(`lfo${i}Sync`);
    return (
      <fieldset key={i} className={`param-group ggs-lfo ${used(`lfo${i}`) ? '' : 'idle'}`} title={used(`lfo${i}`) ? undefined : 'Not routed yet: add a route in the Matrix tab'}>
        <legend>LFO {i}<SourceMeter source={`lfo${i}`} live={live} className="in-legend" /></legend>
        <LfoView shape={val(`lfo${i}Shape`)} phase={val(`lfo${i}Phase`)} />
        <div className="param-row">
          {C(`lfo${i}Shape`)}
          {sync === 'off' ? C(`lfo${i}Rate`) : <div className="ggs-note" title="Tempo-synced">{syncBeats(sync)} beats</div>}
          {C(`lfo${i}Sync`)}{C(`lfo${i}Trig`)}{C(`lfo${i}Fade`)}{C(`lfo${i}Phase`)}
        </div>
      </fieldset>
    );
  };

  const chaosPanel = (i) => {
    const type = val(`chaos${i}Type`);
    const kind = CHAOS_INFO[type];
    const sync = val(`chaos${i}Sync`);
    return (
      <fieldset key={`chaos${i}`} className={`param-group ggs-chaos ${used(`chaos${i}`) ? '' : 'idle'}`} title={used(`chaos${i}`) ? undefined : 'Not routed yet: drag its chip from the source bar onto a knob, or add a route in the Matrix tab'}>
        <legend>Chaos {i}<SourceMeter source={`chaos${i}`} live={live} className="in-legend" /></legend>
        <ChaosView type={type} character={val(`chaos${i}Char`)} steps={val(`chaos${i}Steps`)} />
        <div className="param-row">
          {C(`chaos${i}Type`, { options: CHAOS_OPTIONS })}
          {sync === 'off' ? C(`chaos${i}Rate`) : <div className="ggs-note" title="Tempo-synced">{syncBeats(sync)} beats</div>}
          {C(`chaos${i}Sync`)}{C(`chaos${i}Char`, { label: kind.character })}{type === 'turing' && C(`chaos${i}Steps`)}{C(`chaos${i}Path`)}
        </div>
        <p className="cs-desc ggs-filter-desc">{kind.desc}</p>
      </fieldset>
    );
  };

  const words = matrixFilter.toLowerCase().split(/\s+/).filter(Boolean);
  const shownRoutes = routes.map((r) => ({ ...r, says: describeRoute(full, r) }))
    .filter((r) => words.every((w) => `${r.source} ${r.target} ${r.via || ''} ${sourceName(r.source)} ${r.says}`.toLowerCase().includes(w)));

  return (
    <div className="ggs">
      <fieldset className="param-group ggs-head">
        <legend>GGS Synth</legend>
        <div className="param-row">
          <PresetBrowser preset={channel.instrument.preset} onPick={pickPreset} />
          {Array.from({ length: MACRO_COUNT }, (_, k) => k + 1).map((i) => C(`macro${i}`, {
            label: macroNames[`macro${i}`], color: '#c86be0', size: 32, live: true, className: macroUsed(full, i) ? '' : 'unused',
            title: `Macro ${i}${macroUsed(full, i) ? `: ${macroNames[`macro${i}`]}` : ' — free: drag its chip (M' + i + ') from the source bar onto a knob'}. Automate it in the playlist; the dot shows where automation has it.`
          }))}
          {C('gain')}
          <button className="btn tiny" onClick={exportPatch} title="Save this patch as a .json document">Export</button>
          <button className="btn tiny" onClick={importPatch} title="Load a patch document">Import</button>
        </div>
        <p className="cs-desc">{info.description} <b>Touch:</b> {info.expression}</p>
      </fieldset>

      <SourceBar used={usedSources} live={live} names={Object.fromEntries(Object.keys(macroNames).map((k) => [k, sourceName(k)]))} onPick={showInMatrix} />

      <div className="ggs-tabs" role="tablist">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{id === 'matrix' ? ` (${routes.length})` : ''}</button>)}
      </div>

      {tab === 'osc' && (
        <div className="ggs-grid">
          {OSC_IDS.map(oscPanel)}
          <fieldset className="param-group">
            <legend>Sub</legend>
            <div className="param-row">{C('subLevel')}{C('subWave')}{C('subOct')}{C('subDest')}</div>
          </fieldset>
          <fieldset className="param-group">
            <legend>Noise</legend>
            <div className="param-row">{C('noiseLevel')}{C('noiseType')}{C('noiseColor')}{C('noiseDest')}</div>
          </fieldset>
          <fieldset className="param-group">
            <legend>Voice</legend>
            <div className="param-row">
              {C('level')}{C('velSens')}{C('relVelSens')}
              {C('polyphony')}{C('mono')}{C('legato')}{C('glide')}{C('quality')}
            </div>
          </fieldset>
        </div>
      )}

      {tab === 'filter' && (
        <div className="ggs-grid">
          {filterPanel(1)}{filterPanel(2)}
          <fieldset className="param-group">
            <legend>Routing</legend>
            <div className="param-row">
              {C('filterRoute')}
              <p className="cs-desc">Each oscillator chooses its filter on the Oscillators tab (“To”). The curve is the filter’s measured response: drag its handle for cutoff and resonance. Sweep a filter per note in the Matrix: env2, pressure or slide → f1Cutoff.</p>
            </div>
          </fieldset>
        </div>
      )}

      {tab === 'mod' && <div className="ggs-grid">{[1, 2, 3, 4].map(envPanel)}{[1, 2, 3, 4].map(lfoPanel)}{Array.from({ length: CHAOS_COUNT }, (_, k) => chaosPanel(k + 1))}</div>}

      {tab === 'matrix' && (
        <div className="ggs-matrix">
          <div className="ggs-matrix-quick">
            <span>Add:</span>
            <button className="btn tiny" onClick={() => addRoute('pressure', 'f1Cutoff', 0.3)}>Pressure → cutoff</button>
            <button className="btn tiny" onClick={() => addRoute('timbre', 'oscAPos', 0.5)}>Slide → position</button>
            <button className="btn tiny" onClick={() => addRoute('lfo1', 'pitchFine', 0.3, 'pressure')}>Vibrato by pressure</button>
            <button className="btn tiny" onClick={() => addRoute('env2', 'f1Cutoff', 0.35)}>Env 2 → cutoff</button>
            <button className="btn tiny" onClick={() => addRoute('velocity', 'f1Cutoff', 0.15)}>Velocity → cutoff</button>
            <button className="btn tiny" onClick={() => addRoute('macro1', 'f1Cutoff', 0.4)}>Macro 1 → cutoff</button>
            <button className="btn tiny" onClick={() => addRoute('timbre', 'f1Morph', 1)} title="For the morph, formant, phaser and comb filters">Slide → filter morph</button>
            <button className="btn tiny" onClick={() => addRoute('chaos2', 'pitchFine', 0.06)} title="Chaos 2 (drift) on the pitch: every note a few cents off, each in its own way">Analog drift</button>
          </div>
          <div className="ggs-browser-top">
            <input type="search" value={matrixFilter} placeholder="Filter routes: a source, a target, a word…" aria-label="Filter routes" onChange={(e) => setMatrixFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <span className="ggs-ptable-count">{shownRoutes.length === routes.length ? `${routes.length} routes` : `${shownRoutes.length} of ${routes.length} routes`} · {routes.length}/{MOD_SLOTS} slots</span>
          </div>
          <table>
            <thead><tr><th>Source</th><th>Target</th><th>Amount</th><th>Via</th><th /></tr></thead>
            <tbody>
              {shownRoutes.flatMap((r) => [
                <tr key={r.slot}>
                  <td><i className="ggs-dot" style={{ background: sourceColor(r.source) }} /><Select value={r.source} title={MOD_SOURCE_INFO[r.source]} options={MOD_SOURCES.filter((x) => x !== 'none')} onChange={(v) => set(`mod${r.slot}Src`, v)} /></td>
                  <td><Select value={r.target} title={MOD_TARGET_INFO[r.target]} options={MOD_TARGETS.filter((x) => x !== 'none')} onChange={(v) => set(`mod${r.slot}Dst`, v)} /></td>
                  <td className="ggs-amt">
                    <input type="range" min={-1} max={1} step={0.01} value={r.amount} aria-label={`Amount of ${r.source} to ${r.target}`} data-nodrag
                      onChange={(e) => set(`mod${r.slot}Amt`, Number(e.target.value) || 0.01)} />
                    <span>{r.amount > 0 ? '+' : ''}{r.amount.toFixed(2)}</span>
                  </td>
                  <td><Select value={r.via || 'none'} title="Scale this route by a second source" options={MOD_SOURCES.map((x) => ({ value: x, label: x === 'none' ? '—' : x }))} onChange={(v) => set(`mod${r.slot}Via`, v)} /></td>
                  <td><button className="tbtn small" onClick={() => removeRoute(r.slot)} aria-label={`Remove route ${r.source} to ${r.target}`} title="Remove">×</button></td>
                </tr>,
                // what the route does, in the units of its target
                <tr key={`${r.slot}-says`} className="ggs-route-says"><td colSpan={5}><SourceMeter source={r.source} live={live} />{r.says}</td></tr>
              ])}
              {routes.length > 0 && !shownRoutes.length && <tr><td colSpan={5} className="ggs-empty">No route matches “{matrixFilter}”. <button className="btn tiny" onClick={() => setMatrixFilter('')}>Show all</button></td></tr>}
              {!routes.length && <tr><td colSpan={5} className="ggs-empty">No modulation yet. A route connects a source (envelope, LFO, velocity, the note’s pressure / slide / bend, chaos, a macro) to a target. Drag a chip from the source bar onto any knob, or use the buttons above.</td></tr>}
            </tbody>
          </table>
          <p className="cs-desc">Under each route: where it takes its target, from the knob’s position, with this route alone. An amount of 1 is the target’s whole range (cutoff: 10 octaves; pitch: 24 semitones; pitchFine: 1 semitone). {routes.length}/{MOD_SLOTS} slots used.</p>
        </div>
      )}

      {tab === 'fx' && (
        <div className="ggs-grid">
          <fieldset className="param-group"><legend>Drive</legend><div className="param-row">{C('driveAmt')}{C('driveType')}</div></fieldset>
          <fieldset className="param-group"><legend>Chorus</legend><div className="param-row">{C('chorusMix')}{C('chorusRate')}{C('chorusDepth')}</div></fieldset>
          <fieldset className="param-group">
            <legend>Delay</legend>
            <div className="param-row">{C('delayMix')}{C('delaySync')}{val('delaySync') === 'free' && C('delayTime')}{C('delayFb')}{C('delayTone')}{C('delayPing')}</div>
          </fieldset>
          <fieldset className="param-group"><legend>Reverb</legend><div className="param-row">{C('reverbMix')}{C('reverbSize')}{C('reverbDamp')}</div></fieldset>
        </div>
      )}

      {tab === 'all' && <ParamTable params={full} onSet={set} />}

      <TouchPad channel={channel} />
    </div>
  );
}
