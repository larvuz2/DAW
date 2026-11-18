// The GGS Synth page: the whole patch on one screen, arranged and coloured like the /synth editor — the header
// (preset, macros, voice, output), the three oscillators with sub and noise, the filters with the routing and the amp,
// the envelopes, LFOs and chaos, the strip of modulation sources and a dock with the FX rack that opens upwards into
// the modulation matrix or the table of every parameter.
//
// It is drawn at one size (pageLayout.js: rows of modules of fixed heights) and scaled to fit its window, so nothing
// scrolls, nothing overlaps and it looks the same on every screen. The arrangement can be changed (Arrange in the ⋯
// menu): modules move within and between rows, get wider or narrower, are hidden and brought back, and an
// arrangement can be saved by name — a screen can show just what a video needs.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MOD_SLOTS } from '@ggs/synth-dsp';
import { useStore } from '../../state/store.js';
import { Select } from '../ui/Controls.jsx';
import { setDisplayScale } from './displays.jsx';
import {
  HeaderModule, OscModule, SubNoiseModule, FilterModule, RoutingModule, AmpModule, EnvelopesModule, LfosModule, ChaosModule, SourcesModule, FxRack,
  ScopeModule, PadModule
} from './pageModules.jsx';
import {
  MODULES, BUILT_IN_LAYOUTS, STORAGE_KEY, normalizeLayout, hiddenModules, moveModule, nudgeModule, shiftRow, resizeModule, hideModule, showModule,
  sameRows, rowHeight, naturalSize, fitScale, moduleWidth, loadLayouts, storeLayouts, saveAs, GAP, PAD, MIN_W, MAX_W, SMALL_SCALE
} from './pageLayout.js';

const MODULE_MIME = 'application/x-gtd-module';
const DOCK_TABS = [['fx', 'FX rack'], ['matrix', 'Mod matrix'], ['params', 'All parameters']];

function Dock({ ed, tab, setTab, compact }) {
  const counts = { fx: 4, matrix: ed.routes.length, params: Object.keys(ed.full).length };
  return (
    <section className={`sp-dock ${compact ? '' : 'open'}`} data-module="dock" data-dock={tab}>
      <div className="sp-dock-tabs">
        <div role="tablist" aria-label="Editor views" className="sp-dock-tablist">
          {DOCK_TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-dock-tab={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}<span className="sp-badge">{counts[id]}</span>
            </button>
          ))}
        </div>
        {tab !== 'fx' && <button type="button" className="sp-dock-close" aria-label="Back to the FX rack" title="Back to the FX rack" onClick={() => setTab('fx')}>×</button>}
        {tab === 'matrix' && <span className="sp-dock-note">{ed.routes.length} / {MOD_SLOTS} routes</span>}
      </div>
      <div className="sp-dock-body">
        {tab === 'fx' && <FxRack ed={ed} />}
        {tab === 'matrix' && ed.matrixPanel}
        {tab === 'params' && ed.paramsPanel}
      </div>
    </section>
  );
}

const RENDER = {
  header: (ed, x) => <HeaderModule ed={ed} menu={x.menu} />,
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
  dock: (ed, x) => <Dock ed={ed} tab="fx" setTab={x.setDock} compact />,
  scope: (ed) => <ScopeModule ed={ed} />,
  pad: (ed) => <PadModule ed={ed} />
};

/**
 * One module. Ops on other channels, the transport or the song re-render the editor; a module only redraws when what it
 * shows can have changed (`ed.stamp`: this channel, the route an Alt-drag edits).
 */
const ModuleBody = memo(function ModuleBody({ id, ed, x }) {
  return RENDER[id](ed, x);
}, (a, b) => a.id === b.id && a.ed.stamp === b.ed.stamp && a.x === b.x);

export function SynthPage({ ed }) {
  const st = useStore.getState();
  const [layouts, setLayouts] = useState(() => loadLayouts());
  const [arranging, setArranging] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [solo, setSolo] = useState(false);
  const [dock, setDock] = useState('fx');
  const [box, setBox] = useState({ w: 0, h: 0 });
  const outer = useRef(null);
  const layout = layouts.current;
  const all = useMemo(() => [...BUILT_IN_LAYOUTS, ...layouts.saved], [layouts.saved]);

  // ---- the size of the page and the scale it is drawn at
  useEffect(() => {
    const el = outer.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [solo]);
  const natural = naturalSize(layout);
  const scale = box.w > 0 ? fitScale(layout, box.w, box.h) : 1;
  const width = box.w > 0 ? box.w / scale : natural.width;
  const height = box.h > 0 ? box.h / scale : natural.height;
  useEffect(() => { setDisplayScale(scale); }, [scale]);
  useEffect(() => () => setDisplayScale(1), []);

  // ---- remembered in this browser; layouts saved in another tab show up here too
  // (what came from storage — this page's start, another tab's save — is not written back: another tab's current
  // layout must not be overwritten by this one's)
  const fromStorage = useRef(true);
  useEffect(() => {
    if (fromStorage.current) { fromStorage.current = false; return; }
    storeLayouts(layouts);
  }, [layouts]);
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return;
      const { saved } = loadLayouts();
      setLayouts((s) => {
        if (JSON.stringify(s.saved) === JSON.stringify(saved)) return s;
        fromStorage.current = true;
        return { ...s, saved };
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // the editor asks for the matrix (a knob's "Show in the matrix", a source chip)
  const handled = useRef(ed.dockRequest?.n);
  useEffect(() => {
    if (!ed.dockRequest || ed.dockRequest.n === handled.current) return;
    handled.current = ed.dockRequest.n;
    setDock(ed.dockRequest.tab);
  }, [ed.dockRequest]);

  const change = (fn) => setLayouts((s) => {
    const next = fn(s.current);
    return sameRows(next, s.current) ? s : { ...s, current: { ...next, edited: true } };
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

  // ---- full screen: the page alone over the whole window (menus, dialogs and messages still show above it), and the
  // browser's full screen around the page where it has one
  const entered = useRef(false);
  const leave = useCallback(() => {
    setSolo(false);
    if (entered.current && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    entered.current = false;
  }, []);
  const fullScreen = () => {
    if (solo) { leave(); return; }
    document.activeElement?.blur?.();
    setSolo(true);
    const page = document.documentElement;
    if (!document.fullscreenElement && page.requestFullscreen) page.requestFullscreen().then(() => { entered.current = true; }).catch(() => {});
  };
  useEffect(() => {
    if (!solo) return undefined;
    const onChange = () => { if (!document.fullscreenElement && entered.current) { entered.current = false; setSolo(false); } };
    const onKey = (e) => {
      const now = useStore.getState();
      if (e.key !== 'Escape' || now.modal || now.contextMenu) return;
      if (e.target?.closest?.('input, textarea, select, .ggs-browser, .ggs-wt-panel, .sp-dock-over')) return;
      e.stopPropagation();
      leave();
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('fullscreenchange', onChange); window.removeEventListener('keydown', onKey, true); };
  }, [solo, leave]);
  useEffect(() => () => { if (entered.current && document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }, []);

  // ---- the ⋯ menu: the patch, the layouts, arranging, full screen, the classic tabs
  const menuNow = useRef(null);
  menuNow.current = (e) => st.showContextMenu(e, [
    { header: 'Patch' },
    { label: 'Export patch…', onClick: ed.exportPatch },
    { label: 'Import patch…', onClick: ed.importPatch },
    '-',
    { header: 'Layout' },
    ...BUILT_IN_LAYOUTS.map((l) => ({ label: l.name, checked: layout.name === l.name, onClick: () => choose(l.name) })),
    ...(layouts.saved.length ? [{ label: 'Saved', submenu: layouts.saved.map((l) => ({ label: l.name, checked: layout.name === l.name, onClick: () => choose(l.name) })) }] : []),
    { label: arranging ? 'Done arranging' : 'Arrange modules…', onClick: () => setArranging(!arranging) },
    { label: 'Save layout as…', onClick: save },
    ...(isSaved ? [{ label: `Delete "${layout.name}"`, danger: true, onClick: remove }] : []),
    ...(layout.edited && all.some((l) => l.name === layout.name) ? [{ label: `Revert to "${layout.name}"`, onClick: () => choose(layout.name) }] : []),
    '-',
    { label: 'Mod matrix', onClick: () => setDock('matrix') },
    { label: 'All parameters', onClick: () => setDock('params') },
    { label: solo ? 'Exit full screen' : 'Full screen', onClick: fullScreen },
    { label: 'Classic view (tabs)', onClick: () => ed.setView('classic') }
  ]);
  const menu = useCallback((e) => menuNow.current(e), []);
  const extra = useMemo(() => ({ menu, setDock }), [menu]);

  // ---- arranging: drag a module by its grip onto another (it goes before it), onto a row's end, or below the rows
  const dropAt = (target) => (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const moved = e.dataTransfer.getData(MODULE_MIME) || dragging;
    if (moved && moved !== target.before) change((l) => moveModule(l, moved, target));
    setDragging(null);
    setOver(null);
  };
  const overAt = (key) => (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (over !== key) setOver(key);
  };
  const tools = (id, it, r, i) => (
    <div className="gsp-tools" data-nodrag>
      <span className="gsp-grip" draggable title={`Drag ${MODULES[id].label} to move it`} aria-hidden="true"
        onDragStart={(e) => { e.dataTransfer.setData(MODULE_MIME, id); e.dataTransfer.effectAllowed = 'move'; setDragging(id); }}
        onDragEnd={() => { setDragging(null); setOver(null); }}>⠿</span>
      <button type="button" aria-label={`Move ${MODULES[id].label} earlier`} title="Earlier in its row" disabled={i === 0} onClick={() => change((l) => nudgeModule(l, id, -1))}>◀</button>
      <button type="button" aria-label={`Move ${MODULES[id].label} later`} title="Later in its row" disabled={i === layout.rows[r].length - 1} onClick={() => change((l) => nudgeModule(l, id, 1))}>▶</button>
      <button type="button" aria-label={`Move ${MODULES[id].label} up`} title="To the row above" disabled={r === 0} onClick={() => change((l) => shiftRow(l, id, -1))}>▲</button>
      <button type="button" aria-label={`Move ${MODULES[id].label} down`} title="To the row below (a new row under the last)" disabled={r === layout.rows.length - 1 && layout.rows[r].length === 1} onClick={() => change((l) => shiftRow(l, id, 1))}>▼</button>
      <button type="button" aria-label={`Make ${MODULES[id].label} narrower`} title="Narrower" disabled={it.w <= MIN_W} onClick={() => change((l) => resizeModule(l, id, -0.25))}>−</button>
      <button type="button" aria-label={`Make ${MODULES[id].label} wider`} title="Wider" disabled={it.w >= MAX_W} onClick={() => change((l) => resizeModule(l, id, 0.25))}>+</button>
      <button type="button" aria-label={`Hide ${MODULES[id].label}`} title="Hide (add it back from the bar above)" onClick={() => change((l) => hideModule(l, id))}>×</button>
    </div>
  );

  const hasDock = layout.rows.some((row) => row.some((it) => it.id === 'dock'));
  const rowStyle = (row) => {
    const h = rowHeight(row);
    if (row.some((it) => it.id === 'dock')) return { flex: '1 1 auto', minHeight: h };
    return hasDock ? { flex: `0 0 ${h}px`, height: h } : { flex: `${h} 1 ${h}px`, minHeight: h };
  };
  const slotStyle = (it) => {
    const w = moduleWidth(it);
    return w.px ? { flex: `0 0 ${w.px}px`, width: w.px } : { flex: `${w.grow} 1 0`, minWidth: w.min };
  };

  const view = (
    <div className={`gsp ${solo ? 'solo' : ''} ${arranging ? 'arranging' : ''}`} ref={outer} data-nodrag>
      <div className="gsp-page" style={{ width, height, transform: `scale(${scale})`, padding: PAD, gap: GAP }} data-scale={scale.toFixed(3)}>
        {arranging && (
          <div className="gsp-arrange-bar">
            <b>Arrange</b>
            <span>Drag a module by ⠿ onto another, or below the rows; ◀ ▶ ▲ ▼ move it, − + resize, × hides.</span>
            {hidden.length > 0 && (
              <Select value="" className="gsp-add" title="Bring a hidden module back"
                options={[{ value: '', label: `+ Add a module (${hidden.length})` }, ...hidden.map((id) => ({ value: id, label: MODULES[id].label }))]}
                onChange={(id) => id && change((l) => showModule(l, id))} />
            )}
            <button type="button" className="sp-btn" onClick={save}>Save as…</button>
            <button type="button" className="sp-btn on" onClick={() => setArranging(false)}>Done</button>
          </div>
        )}
        {layout.rows.map((row, r) => (
          <div key={r} className="gsp-row" style={{ ...rowStyle(row), gap: GAP }} data-row={r}>
            {row.map((it, i) => (
              <div key={it.id} className={`gsp-slot ${over === it.id && dragging !== it.id ? 'drop' : ''} ${dragging === it.id ? 'lifted' : ''}`} style={slotStyle(it)} data-slot={it.id}
                data-low={r > 0 && r >= layout.rows.length / 2 ? '' : undefined}
                onDragOver={overAt(it.id)} onDragLeave={() => over === it.id && setOver(null)} onDrop={dropAt({ before: it.id })}>
                <ModuleBody id={it.id} ed={ed} x={extra} />
                {arranging && tools(it.id, it, r, i)}
              </div>
            ))}
            {arranging && dragging && <div className={`gsp-row-end ${over === `row${r}` ? 'drop' : ''}`} onDragOver={overAt(`row${r}`)} onDragLeave={() => setOver(null)} onDrop={dropAt({ row: r })} title="Drop: at the end of this row" />}
          </div>
        ))}
        {arranging && dragging && (
          <div className={`gsp-newrow ${over === 'new' ? 'drop' : ''}`} onDragOver={overAt('new')} onDragLeave={() => setOver(null)} onDrop={dropAt({ row: layout.rows.length })}>
            Drop here: a new row
          </div>
        )}
        {!layout.rows.length && <p className="gsp-empty">Every module is hidden. Open ⋯ → Arrange modules to add some, or pick a layout.</p>}
        {!layout.rows.some((row) => row.some((it) => it.id === 'header')) && (
          <button type="button" className="sp-menu-btn floating" aria-label="Patch, layout and view" title="Layouts, arrange, full screen, classic view" onClick={menu}>⋯</button>
        )}
        {scale < SMALL_SCALE && (
          <div className="gsp-small" role="status" style={{ transform: `scale(${1 / scale})` }}>
            This window is small for the synth page.
            <button type="button" className="sp-btn" onClick={fullScreen}>Full screen</button>
            <button type="button" className="sp-btn" onClick={() => ed.setView('classic')}>Classic view</button>
          </div>
        )}
        {dock !== 'fx' && (
          <div className="sp-dock-over">
            <Dock ed={ed} tab={dock} setTab={setDock} />
          </div>
        )}
      </div>
    </div>
  );
  // in full screen the same view is drawn over the page, outside the window (which would clip it and sit under others)
  return solo ? createPortal(view, document.body) : view;
}
