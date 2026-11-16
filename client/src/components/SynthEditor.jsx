// The GGS Synth editor: shown in the Channel window for channels whose instrument is the GGS Synth. Every control is
// one of the synth's flat params (packages/synth-dsp/src/params.js) and every change is a channel/update op, so it
// is undoable, synced live and heard on notes that are already sounding.
import { useEffect, useRef, useState } from 'react';
import { sanitizeParams } from '@greanteadawy/core';
import {
  GGS_PARAMS, GGS_PRESETS, GGS_PRESET_INFO, GGS_PRESET_CATEGORIES, OSC_IDS, MOD_SLOTS, MOD_SOURCES, MOD_TARGETS, MOD_SOURCE_INFO, MOD_TARGET_INFO,
  ggsParamDef, ggsDefaults, wavetablePreview, wavetableSpectrum, describeWavetables, modulationRoutes, paramsToPatch, patchToParams, syncBeats
} from '@greanteadawy/synth-dsp';
import { useStore } from '../state/store.js';
import { Knob } from './ui/Knob.jsx';
import { Select } from './ui/Controls.jsx';
import { download, pickFile } from '../lib/actions.js';

const TABS = [['osc', 'Oscillators'], ['filter', 'Filters'], ['mod', 'Envelopes & LFOs'], ['matrix', 'Matrix'], ['fx', 'Effects']];
const OSC_COLORS = { A: '#46c79a', B: '#5ab8f0', C: '#f59f42' };
const TABLES = describeWavetables();
const DEFAULTS = ggsDefaults();

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

/** Magnitude response of a filter (20 Hz – 20 kHz, ±30 dB), from the same pole pairs the voice uses. */
function FilterView({ type, cutoff, res, on }) {
  return (
    <Scope width={168} height={64} deps={[type, Math.round(cutoff), Math.round(res * 100), on]} title="Frequency response, 20 Hz – 20 kHz"
      draw={(g, w, h) => {
        g.globalAlpha = on ? 1 : 0.35;
        g.fillStyle = 'rgba(255,255,255,0.04)';
        g.fillRect(0, 0, w, h);
        const two = /24$/.test(type);
        const k2 = two ? 1 / (1.3066 * Math.pow(30, res)) : 1 / (0.7071 * Math.pow(56, res));
        const k1 = 1.848 - 0.6 * res;
        const stage = (x, k, mode) => {
          // H(s) of one state-variable stage at s = j·x (x = f / cutoff): |num| / |s² + k·s + 1|
          const den = Math.hypot(1 - x * x, k * x);
          const num = mode === 'lp' ? 1 : mode === 'hp' ? x * x : mode === 'bp' ? k * x : mode === 'notch' ? Math.abs(1 - x * x) : Math.abs(1 + x * x);
          return num / den;
        };
        const mode = type.startsWith('lp') ? 'lp' : type.startsWith('hp') ? 'hp' : type.startsWith('bp') ? 'bp' : type;
        const pts = [];
        for (let i = 0; i <= w; i += 2) {
          const f = 20 * Math.pow(1000, i / w);
          let mag;
          if (type === 'comb') {
            const fb = res * 0.985;
            const ph = (2 * Math.PI * f) / cutoff;
            mag = (1 - 0.45 * res) / Math.hypot(1 - fb * Math.cos(ph), fb * Math.sin(ph));
          } else {
            mag = two ? stage(f / cutoff, k1, mode) * stage(f / cutoff, k2, mode) : stage(f / cutoff, k2, mode);
          }
          const db = Math.max(-30, Math.min(30, 20 * Math.log10(mag + 1e-6)));
          pts.push([i, h / 2 - (db / 30) * (h / 2 - 2)]);
        }
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
        line(g, pts, '#f59f42', 1.8);
      }} />
  );
}

function EnvView({ a, d, s, r, curve }) {
  return (
    <Scope width={150} height={48} deps={[a, d, s, r, curve]} title="Envelope shape (the sustain stage is shown as a fixed length)"
      draw={(g, w, h) => {
        const hold = 0.4;
        const total = a + d + hold + r;
        const ka = 1.5 * Math.pow(3, curve);
        const kd = 4.6 * Math.pow(4, curve);
        const rise = (x) => (1 - Math.exp(-ka * x)) / (1 - Math.exp(-ka));
        const fall = (x) => (Math.exp(-kd * x) - Math.exp(-kd)) / (1 - Math.exp(-kd));
        const pts = [];
        const y = (v) => h - 3 - v * (h - 6);
        for (let i = 0; i <= w; i++) {
          const t = (i / w) * total;
          const v = t < a ? rise(t / a) : t < a + d ? s + (1 - s) * fall((t - a) / d) : t < a + d + hold ? s : s * fall((t - a - d - hold) / r);
          pts.push([i, y(v)]);
        }
        line(g, pts, '#9ad94f');
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

/**
 * A pad to play the patch with a mouse or finger the way an MPE controller would: holding it plays a note, up/down
 * is pressure and left/right is slide — straight into that note's own pressure and timbre inputs.
 */
function TouchPad({ channel }) {
  const ref = useRef(null);
  const held = useRef(null);
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
    const eng = await useStore.getState().unlockAudio();
    if (!eng || held.current) return;
    const v = eng.noteOn(channel.id, channel.rootKey, 0.8);
    if (!v) return;
    held.current = v;
    v.expr?.timbre.setValueAtTime(p.x, eng.ctx.currentTime);
    v.expr?.pressure.setValueAtTime(p.y, eng.ctx.currentTime);
  };
  const up = () => {
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
  const st = useStore.getState();
  const p = channel.instrument.params;
  const info = GGS_PRESET_INFO[channel.instrument.preset] || GGS_PRESET_INFO.Init;
  const val = (key) => p[key] ?? DEFAULTS[key];
  const set = (key, value) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { params: { [key]: value } } } }], { coalesce: `ggs:${channel.id}:${key}` });
  const setMany = (params) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { params } } }]);

  /** The control for one param: knob, dropdown or switch, by its definition. */
  const C = (key, opts = {}) => {
    const d = ggsParamDef(key);
    const label = opts.label ?? d.label;
    if (d.type === 'number') {
      return (
        <Knob key={key} value={val(key)} min={d.min} max={d.max} def={d.default} curve={d.curve} step={d.step} label={label} unit={d.unit}
          color={opts.color} showValue size={opts.size || 30} bipolar={d.min < 0} title={opts.title} onChange={(v) => set(key, d.step ? Math.round(v) : Math.round(v * 10000) / 10000)} />
      );
    }
    if (d.type === 'select') {
      return (
        <label key={key} className="param-select" title={opts.title}>
          <Select value={val(key)} options={opts.options || d.options} onChange={(v) => set(key, v)} />
          <span>{label}</span>
        </label>
      );
    }
    return (
      <label key={key} className="param-bool" title={opts.title}>
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

  const routes = modulationRoutes({ ...DEFAULTS, ...p });
  const freeSlot = () => {
    for (let i = 1; i <= MOD_SLOTS; i++) if (val(`mod${i}Src`) === 'none' || val(`mod${i}Dst`) === 'none' || !val(`mod${i}Amt`)) return i;
    return 0;
  };
  const addRoute = (source = 'pressure', target = 'f1Cutoff', amount = 0.3, via = 'none') => {
    const i = freeSlot();
    if (!i) { st.toast(`All ${MOD_SLOTS} modulation slots are in use`, 'warn'); return; }
    setMany({ [`mod${i}Src`]: source, [`mod${i}Dst`]: target, [`mod${i}Amt`]: amount, [`mod${i}Via`]: via });
  };
  const removeRoute = (i) => setMany({ [`mod${i}Src`]: 'none', [`mod${i}Dst`]: 'none', [`mod${i}Amt`]: 0, [`mod${i}Via`]: 'none' });
  const used = (source) => routes.some((r) => r.source === source || r.via === source);

  const oscPanel = (x) => {
    const on = val(`osc${x}On`);
    const color = OSC_COLORS[x];
    const table = TABLES.find((t) => t.id === val(`osc${x}Table`));
    return (
      <fieldset key={x} className={`param-group ggs-osc ${on ? '' : 'off'}`}>
        <legend style={{ color }}>Oscillator {x}</legend>
        <div className="ggs-osc-top">
          <WaveView table={val(`osc${x}Table`)} pos={val(`osc${x}Pos`)} color={color} on={on} />
          <div className="ggs-osc-pick">
            {C(`osc${x}On`, { label: 'Power' })}
            <label className="param-select" title={table?.description}>
              <Select value={val(`osc${x}Table`)} onChange={(v) => set(`osc${x}Table`, v)} options={TABLES.map((t) => ({ value: t.id, label: t.name }))} />
              <span>Wavetable</span>
            </label>
            {C(`osc${x}Dest`, { title: 'Where this oscillator goes: filter 1, filter 2, both, or past the filters' })}
          </div>
        </div>
        <div className="param-row">
          {C(`osc${x}Pos`, { color, title: 'Position in the wavetable' })}{C(`osc${x}Level`, { color })}{C(`osc${x}Pan`, { color })}
          {C(`osc${x}Oct`, { color })}{C(`osc${x}Semi`, { color })}{C(`osc${x}Fine`, { color })}
        </div>
        <div className="param-row">
          {C(`osc${x}Unison`, { color })}{C(`osc${x}Detune`, { color })}{C(`osc${x}Blend`, { color })}{C(`osc${x}Spread`, { color })}
          {C(`osc${x}Phase`, { color })}{C(`osc${x}Rand`, { color, title: '1 = every note starts at a random phase; 0 = always the same attack' })}
        </div>
        <div className="param-row">
          {C(`osc${x}Warp`)}{C(`osc${x}WarpAmt`, { color, label: 'Warp' })}
          {C(`osc${x}FmFrom`, { title: 'Phase modulation from another source (its own letter = feedback)' })}{C(`osc${x}Fm`, { color, label: 'FM' })}
        </div>
      </fieldset>
    );
  };

  const filterPanel = (i) => (
    <fieldset key={i} className={`param-group ggs-filter ${val(`f${i}On`) ? '' : 'off'}`}>
      <legend>Filter {i}</legend>
      <div className="ggs-osc-top">
        <FilterView type={val(`f${i}Type`)} cutoff={val(`f${i}Cutoff`)} res={val(`f${i}Res`)} on={val(`f${i}On`)} />
        <div className="ggs-osc-pick">{C(`f${i}On`, { label: 'Power' })}{C(`f${i}Type`)}</div>
      </div>
      <div className="param-row">{C(`f${i}Cutoff`)}{C(`f${i}Res`)}{C(`f${i}Drive`)}{C(`f${i}Key`, { title: '1 = the cutoff follows the note (and its pitch curve)' })}</div>
    </fieldset>
  );

  const envPanel = (i) => (
    <fieldset key={i} className={`param-group ggs-env ${i === 1 || used(`env${i}`) ? '' : 'idle'}`} title={i > 1 && !used(`env${i}`) ? 'Not routed yet: add a route in the Matrix tab' : undefined}>
      <legend>{i === 1 ? 'Envelope 1 · amp' : `Envelope ${i}`}</legend>
      <EnvView a={val(`env${i}A`)} d={val(`env${i}D`)} s={val(`env${i}S`)} r={val(`env${i}R`)} curve={val(`env${i}Curve`)} />
      <div className="param-row">{C(`env${i}A`, { label: 'A' })}{C(`env${i}D`, { label: 'D' })}{C(`env${i}S`, { label: 'S' })}{C(`env${i}R`, { label: 'R' })}{C(`env${i}Curve`)}</div>
    </fieldset>
  );

  const lfoPanel = (i) => {
    const sync = val(`lfo${i}Sync`);
    return (
      <fieldset key={i} className={`param-group ggs-lfo ${used(`lfo${i}`) ? '' : 'idle'}`} title={used(`lfo${i}`) ? undefined : 'Not routed yet: add a route in the Matrix tab'}>
        <legend>LFO {i}</legend>
        <LfoView shape={val(`lfo${i}Shape`)} phase={val(`lfo${i}Phase`)} />
        <div className="param-row">
          {C(`lfo${i}Shape`)}
          {sync === 'off' ? C(`lfo${i}Rate`) : <div className="ggs-note" title="Tempo-synced">{syncBeats(sync)} beats</div>}
          {C(`lfo${i}Sync`)}{C(`lfo${i}Trig`, { title: 'note: restarts with every note · free: one clock shared by all notes' })}{C(`lfo${i}Fade`)}{C(`lfo${i}Phase`)}
        </div>
      </fieldset>
    );
  };

  return (
    <div className="ggs">
      <fieldset className="param-group ggs-head">
        <legend>GGS Synth</legend>
        <div className="param-row">
          <label className="param-select">
            <Select value={channel.instrument.preset} title={info.description}
              onChange={(preset) => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { instrument: { preset } } }])}
              options={[{ value: 'Init', label: 'Init' }, ...GGS_PRESET_CATEGORIES.flatMap(([cat, group]) => Object.keys(GGS_PRESETS).filter((n) => GGS_PRESET_INFO[n]?.category === cat).map((n) => ({ value: n, label: n, group })))]} />
            <span>Preset</span>
          </label>
          {[1, 2, 3, 4].map((i) => C(`macro${i}`, { label: info.macros[i - 1], color: '#c86be0', size: 34, title: `Macro ${i}: ${info.macros[i - 1]} (automatable)` }))}
          {C('gain')}
          <button className="btn tiny" onClick={exportPatch} title="Save this patch as a .json document">Export</button>
          <button className="btn tiny" onClick={importPatch} title="Load a patch document">Import</button>
        </div>
        <p className="cs-desc">{info.description} <b>Touch:</b> {info.expression}</p>
      </fieldset>

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
              {C('level', { title: 'Level before the envelope. Set it low and route pressure to "level" for a sound that swells with touch' })}{C('velSens')}{C('relVelSens')}
              {C('polyphony')}{C('mono')}{C('legato')}{C('glide')}{C('bendRange')}{C('quality', { title: 'auto: 2× oversampling only where the patch can alias · high: always · eco: never' })}
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
              {C('filterRoute', { title: 'serial: filter 1 feeds filter 2 · parallel: side by side' })}
              <p className="cs-desc">Each oscillator chooses its filter on the Oscillators tab (“To”). Sweep a filter per note in the Matrix: env2, pressure or slide → f1Cutoff.</p>
            </div>
          </fieldset>
        </div>
      )}

      {tab === 'mod' && <div className="ggs-grid">{[1, 2, 3, 4].map(envPanel)}{[1, 2, 3, 4].map(lfoPanel)}</div>}

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
          </div>
          <table>
            <thead><tr><th>Source</th><th>Target</th><th>Amount</th><th>Via</th><th /></tr></thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.slot}>
                  <td><Select value={r.source} title={MOD_SOURCE_INFO[r.source]} options={MOD_SOURCES.filter((x) => x !== 'none')} onChange={(v) => set(`mod${r.slot}Src`, v)} /></td>
                  <td><Select value={r.target} title={MOD_TARGET_INFO[r.target]} options={MOD_TARGETS.filter((x) => x !== 'none')} onChange={(v) => set(`mod${r.slot}Dst`, v)} /></td>
                  <td className="ggs-amt">
                    <input type="range" min={-1} max={1} step={0.01} value={r.amount} aria-label={`Amount of ${r.source} to ${r.target}`} data-nodrag
                      onChange={(e) => set(`mod${r.slot}Amt`, Number(e.target.value) || 0.01)} />
                    <span>{r.amount > 0 ? '+' : ''}{r.amount.toFixed(2)}</span>
                  </td>
                  <td><Select value={r.via || 'none'} title="Scale this route by a second source" options={MOD_SOURCES.map((x) => ({ value: x, label: x === 'none' ? '—' : x }))} onChange={(v) => set(`mod${r.slot}Via`, v)} /></td>
                  <td><button className="tbtn small" onClick={() => removeRoute(r.slot)} aria-label={`Remove route ${r.source} to ${r.target}`} title="Remove">×</button></td>
                </tr>
              ))}
              {!routes.length && <tr><td colSpan={5} className="ggs-empty">No modulation yet. A route connects a source (envelope, LFO, velocity, the note’s pressure / slide / bend, a macro) to a target.</td></tr>}
            </tbody>
          </table>
          <p className="cs-desc">An amount of 1 moves the target across its whole range: f1Cutoff 0.3 = 3 octaves, oscAPos 0.5 = half the table, pitch 0.5 = 12 semitones, pitchFine 0.3 = 0.3 semitones. {routes.length}/{MOD_SLOTS} slots used.</p>
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

      <TouchPad channel={channel} />
    </div>
  );
}
