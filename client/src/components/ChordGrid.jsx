// The Grid tab of the Harmony window: every chord of the key on one colour-coded grid, the borrowed ones beside it,
// what could come next glowing, and a track of cards to try a progression on — the layout and the harmonic engine of
// Tuple (c0remusic, MIT; packages/chord-grid), in the studio's own controls, playing a channel of the song.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SCALE_INFO, spelledNoteName } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { loadChordGrid, gridSession } from '../lib/chordGrid.js';
import { Select, DragNumber } from './ui/Controls.jsx';
import { Icon } from './ui/Icon.jsx';
import { onFrame } from './ui/frames.js';

const BAR_PX = 76; // a bar of the track is at least this wide (longer loops scroll)
const SNAP = 0.25;
const INVERSIONS = ['Root', '1st', '2nd', '3rd', '4th', '5th'];
const OPTION_TABS = [['subs', 'Instead'], ['next', 'Next'], ['voicings', 'Voicings']];
const OPTION_KINDS = { func: 'same function', qual: 'same degree', bor: 'borrowed', suite: '', voic: '' };

/** A row of choices where one is on (Off / Anchor / Follow). */
function Seg({ label, value, options, onChange }) {
  return (
    <div className="cgrid-seg" role="radiogroup" aria-label={label}>
      <span className="cgrid-seg-label">{label}</span>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} title={o.about || o.label} onClick={() => onChange(o.id)}>{o.short || o.label}</button>
      ))}
    </div>
  );
}

const BLACK = new Set([1, 3, 6, 8, 10]);
/** Five octaves of keys: what sounds is lit, what a hovered chord would play is outlined. */
function Keys({ notes, ghost, low = 36, high = 96 }) {
  const on = new Set(notes);
  const hint = new Set(ghost);
  const whites = [];
  for (let k = low; k <= high; k++) if (!BLACK.has(k % 12)) whites.push(k);
  const w = 100 / whites.length;
  return (
    <div className="cgrid-keys" aria-hidden="true">
      {whites.map((k, i) => <i key={k} className={`w ${on.has(k) ? 'on' : hint.has(k) ? 'hint' : ''}`} style={{ left: `${i * w}%`, width: `${w}%` }} />)}
      {whites.map((k, i) => (BLACK.has((k + 1) % 12) && k + 1 <= high
        ? <i key={`b${k}`} className={`b ${on.has(k + 1) ? 'on' : hint.has(k + 1) ? 'hint' : ''}`} style={{ left: `${(i + 0.68) * w}%`, width: `${w * 0.64}%` }} />
        : null))}
    </div>
  );
}

/** What a suggestion is, for the tooltip. */
const smartTitle = (mod, c) => (c.smart ? ` — suggested: ${mod.SMART_KINDS[c.smart.kind] || c.smart.kind} (${'●'.repeat(c.smart.level)}${'○'.repeat(3 - c.smart.level)})` : '');

export function GridTab({ project, channel, pattern }) {
  const [mod, setMod] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; loadChordGrid().then((m) => { if (live) setMod(m); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, []);
  if (failed) return <p className="empty-hint">The chord grid could not be loaded. Reload the page to try again.</p>;
  if (!mod) return <p className="empty-hint">Loading the chord grid…</p>;
  return <Grid key={project.id} mod={mod} project={project} channel={channel} pattern={pattern} />;
}

function Grid({ mod, project, channel, pattern }) {
  const st = useStore.getState();
  const session = useMemo(() => gridSession(mod, project), [mod, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const grid = session.grid;
  useEffect(() => { session.follow(project); }, [session, project]);
  useEffect(() => { session.setChannel(channel?.id ?? null); }, [session, channel?.id]);
  // closing the window or leaving the tab lets go of what sounds (the loop stops: nobody would see its Stop button)
  useEffect(() => () => { session.stop(); session.release(); session.silence(); }, [session]);
  const view = useSyncExternalStore(grid.subscribe, grid.view);
  const playing = useSyncExternalStore(session.subscribe, () => session.playing);
  const [ghost, setGhost] = useState([]);
  const [showExpr, setShowExpr] = useState(false);
  const [withSong, setWithSong] = useState(false);
  const [optTab, setOptTab] = useState('subs');
  const [carry, setCarry] = useState(null); // a chord being dragged to the track: { label, x, y, bar }
  const [live, setLive] = useState(null); // a card being moved or resized: { i, start, bars }
  const gridEl = useRef(null);
  const trackEl = useRef(null);
  const headEl = useRef(null);
  const press = useRef(null);
  const cardDrag = useRef(null);

  const s = view.settings;
  const prog = view.progression;
  const sel = prog.selected >= 0 ? prog.cards[prog.selected] : null;
  const spell = session.key.spell;
  const names = (notes) => notes.map((n) => spelledNoteName(n, spell)).join(' ');
  const set = (patch) => grid.set(patch);

  // ---- the playhead follows the audio clock (no React render per frame)
  useEffect(() => {
    if (!playing) { if (headEl.current) headEl.current.style.display = 'none'; return undefined; }
    return onFrame(() => {
      const pos = session.position();
      const el = headEl.current;
      if (!el) return;
      el.style.display = pos === null ? 'none' : 'block';
      if (pos !== null) el.style.left = `${(pos / grid.view().progression.loopBars) * 100}%`;
      const now = pos === null ? -1 : grid.view().progression.cards.findIndex((c) => pos >= c.start && pos < c.start + c.bars);
      trackEl.current?.querySelectorAll('.cgrid-card').forEach((n, i) => n.classList.toggle('playing', i === now));
    });
  }, [playing, session, grid]);

  // ---- a cell: press to hear (held until let go); dragged to the track it becomes a card where it is dropped
  const barAt = (x, y) => {
    const r = trackEl.current?.getBoundingClientRect();
    if (!r || x < r.left || x > r.right || y < r.top - 24 || y > r.bottom + 24) return null;
    return Math.max(0, Math.round((((x - r.left) / r.width) * prog.loopBars) / SNAP) * SNAP);
  };
  const cellDown = (e, c) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    session.press(c.id);
    press.current = { label: c.label, x: e.clientX, y: e.clientY, moved: false };
  };
  const cellMove = (e) => {
    const p = press.current;
    if (!p || s.capture) return; // (with Capture on the chord is already on the track)
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return;
    p.moved = true;
    setCarry({ label: p.label, x: e.clientX, y: e.clientY, bar: barAt(e.clientX, e.clientY) });
  };
  const cellUp = (e) => {
    const p = press.current;
    press.current = null;
    session.release();
    if (!p?.moved) return;
    const bar = barAt(e.clientX, e.clientY);
    setCarry(null);
    if (bar !== null && grid.addLast(bar) < 0) st.toast('No room on the track there', 'info', 1800);
  };
  const addLast = () => { if (grid.addLast() < 0) st.toast('The track is full', 'info', 1800); };
  const cellKey = (e, c) => {
    const move = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (move) {
      e.preventDefault();
      e.stopPropagation();
      const [col, row] = [Number(e.currentTarget.dataset.c), Number(e.currentTarget.dataset.r)];
      let to = null;
      // sideways: the nearest column that has cells, at this row or its last one
      for (let k = col + move[0]; !to && k >= 0 && k <= 7; k += move[0] || 9) {
        const cells = gridEl.current.querySelectorAll(`.cgrid-cell[data-c="${k}"]`);
        if (cells.length) to = cells[Math.max(0, Math.min(cells.length - 1, row + move[1]))];
      }
      to?.focus();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) session.press(c.id);
  };
  const cellKeyUp = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    session.release();
    if (e.shiftKey && !s.capture) addLast();
  };
  const cell = (c, col, row) => (
    <button key={c.id} role="gridcell" data-c={col} data-r={row} tabIndex={col === 0 && row === 0 ? 0 : -1}
      className={`cgrid-cell ${view.sounding?.cell === c.id ? 'sounding' : ''} ${view.last?.cell === c.id ? 'last' : ''} ${c.smart ? `smart smart-${c.smart.level}` : ''}`}
      aria-label={`${c.label}${c.roman ? `, ${c.roman}` : ''}${c.smart ? `, suggested ${c.smart.level} of 3` : ''}`}
      title={`${c.label}${c.roman ? ` (${c.roman})` : ''}${c.target ? ` → ${c.target}` : ''}${smartTitle(mod, c)}\nClick to hear · ${s.capture ? 'it goes on the track (Capture is on)' : 'double-click or drag to the track to keep it'}`}
      onPointerDown={(e) => cellDown(e, c)} onPointerMove={cellMove} onPointerUp={cellUp} onPointerCancel={cellUp}
      onDoubleClick={() => { if (!s.capture) addLast(); }}
      onPointerEnter={() => setGhost(grid.preview(c.id))} onPointerLeave={() => setGhost([])}
      onKeyDown={(e) => cellKey(e, c)} onKeyUp={cellKeyUp} onBlur={() => { if (!press.current) session.release(); }}>
      <b>{c.label}</b>
      {c.target ? <span>→ {c.target}</span> : c.kind === 'b' && c.roman ? <span>{c.roman}</span> : null}
    </button>
  );

  // ---- a card: press to hear and select; drag to move, its right edge to make it longer or shorter
  const cardDown = (e, c, mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    grid.select(c.index);
    if (mode === 'move') grid.playCard(c.index);
    cardDrag.current = { i: c.index, mode, x: e.clientX, start: c.start, bars: c.bars, moved: false, width: trackEl.current.getBoundingClientRect().width };
  };
  const cardMove = (e) => {
    const d = cardDrag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 5) return;
    d.moved = true;
    const step = e.altKey ? prog.minBars : SNAP;
    const by = Math.round(((dx / d.width) * prog.loopBars) / step) * step;
    setLive(d.mode === 'move' ? { i: d.i, start: Math.max(0, d.start + by), bars: d.bars } : { i: d.i, start: d.start, bars: Math.max(prog.minBars, d.bars + by) });
  };
  const cardUp = () => {
    const d = cardDrag.current;
    cardDrag.current = null;
    session.release();
    if (d?.moved && live) {
      if (d.mode === 'move') grid.move(d.i, live.start);
      else grid.resize(d.i, live.bars);
    }
    setLive(null);
  };
  const cardKey = (e, c) => {
    const step = e.shiftKey ? 1 : SNAP;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      grid.remove(c.index);
      // the card is gone and the focus with it: it stays on the track, so the next key (Ctrl+Z) is still the track's
      trackEl.current?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const by = e.key === 'ArrowLeft' ? -step : step;
      if (e.altKey) grid.resize(c.index, Math.max(prog.minBars, c.bars + by));
      else grid.move(c.index, Math.max(0, c.start + by));
    } else if (e.key === 'Enter' || e.key === ' ') {
      // (a held key repeats: every repeat is swallowed too, or Space would start and stop the song)
      if (!e.repeat) { grid.select(c.index); grid.playCard(c.index); }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Ctrl/Cmd+Z on the track or on a card's controls undoes the track's own last change (as the wave editor keeps its
  // own history); anywhere else, and when the track has nothing to undo, it is the project's undo as usual.
  const trackUndo = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || !prog.canUndo) return;
    e.preventDefault();
    e.stopPropagation();
    grid.undo();
  };

  const options = useMemo(() => (sel ? grid.options(sel.index, optTab) : []), [grid, view.version, sel?.index, optTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const write = () => {
    try { st.toast(session.write(pattern, channel), 'success', 2400); } catch (err) { st.toast(err.message, 'error'); }
  };
  const loops = [];
  for (let b = prog.blockBars; b <= prog.trackBars; b += prog.blockBars) loops.push({ value: b, label: `${b} bars` });
  const shown = view.sounding || view.last;
  const shownCell = view.sounding?.cell || view.last?.cell;
  const shownCol = shownCell?.startsWith('d:') ? view.columns[Number(shownCell[2])] : null;

  return (
    <div className="cgrid">
      <div className="cgrid-bar">
        <label className="param-select"><Select value={s.voicing} onChange={(v) => set({ voicing: v })} title={`How the notes of a chord are spread — ${mod.VOICINGS.find((v) => v.id === s.voicing)?.about}`} options={mod.VOICINGS.map((v) => ({ value: v.id, label: v.label }))} /><span>Voicing</span></label>
        <Seg label="Leading" value={s.leading} options={mod.LEADING} onChange={(v) => set({ leading: v })} />
        <Seg label="Smart" value={s.smart} options={[{ id: 'off', label: 'Off', about: 'No suggestions' }, { id: 'function', label: 'Function', about: mod.SMART_MODES[1].about }, { id: 'voiceleading', label: 'Smooth', about: mod.SMART_MODES[2].about }]} onChange={(v) => set({ smart: v })} />
        <label className="param-select">
          <DragNumber value={s.octave} min={-2} max={2} step={1} label="Octave" title="Register of the chords, in octaves: drag, or double-click to type" format={(v) => (v > 0 ? `+${v}` : `${v}`)} onChange={(v) => set({ octave: v })} />
          <span>Octave</span>
        </label>
        <button className={`btn tiny ${s.extended ? 'on' : ''}`} aria-pressed={s.extended} title="EXT: richer chords in the Borrowed column (9ths, 13ths, ♯11 on tritone substitutes)" onClick={() => set({ extended: !s.extended })}>EXT</button>
        <button className={`btn tiny ${s.avoidNotes ? 'on' : ''}`} aria-pressed={s.avoidNotes} title="Avoid notes: tensions that clash with a chord (a semitone over its 3rd, say) are not offered" onClick={() => set({ avoidNotes: !s.avoidNotes })}>Avoid</button>
        <button className={`btn tiny ${showExpr || s.strum || s.humanize ? 'on' : ''}`} aria-expanded={showExpr} title="Strum, velocity ramp and humanize" onClick={() => setShowExpr(!showExpr)}>Expression</button>
      </div>
      {showExpr && (
        <div className="cgrid-bar cgrid-expr">
          <label className="param-select"><DragNumber value={s.strum} min={-mod.STRUM_MAX} max={mod.STRUM_MAX} step={1} label="Strum in milliseconds" title="Strum: time between the notes of a chord. Positive = low to high, negative = high to low; above 60 ms it is an arpeggio" format={(v) => (v ? `${v > 0 ? '↑' : '↓'} ${Math.abs(v)} ms` : 'Off')} onChange={(v) => set({ strum: v })} /><span>Strum</span></label>
          <label className="param-select"><DragNumber value={s.strumRamp} min={-100} max={100} step={1} label="Strum velocity ramp" title="Velocity along the strum: positive = crescendo, negative = the first note loudest" format={(v) => `${v > 0 ? '+' : ''}${v}%`} onChange={(v) => set({ strumRamp: v })} /><span>Ramp</span></label>
          <label className="param-select"><Select value={s.strumCurve} onChange={(v) => set({ strumCurve: Number(v) })} title="How the strum is spaced: even, speeding up, or slowing down" options={mod.STRUM_CURVES.map((label, value) => ({ value, label }))} /><span>Curve</span></label>
          <label className="param-select"><DragNumber value={s.humanize} min={0} max={100} step={1} label="Humanize" title="Humanize: small differences in velocity and timing, as hands make them" format={(v) => (v ? `${v}%` : 'Off')} onChange={(v) => set({ humanize: v })} /><span>Humanize</span></label>
          <label className="param-select"><DragNumber value={s.velMin} min={1} max={127} step={1} label="Lowest velocity" title="No note is softer than this" onChange={(v) => set({ velMin: v })} /><span>Vel min</span></label>
          <label className="param-select"><DragNumber value={s.velMax} min={1} max={127} step={1} label="Highest velocity" title="No note is louder than this" onChange={(v) => set({ velMax: v })} /><span>Vel max</span></label>
        </div>
      )}
      {!session.key.exact && (
        <p className="cgrid-note">The grid has no chords for {SCALE_INFO[project.scale]?.label || project.scale}: it shows {view.key.name} {view.key.scaleLabel}, the closest scale it knows.</p>
      )}

      <div className="cgrid-scroll">
        <div className="cgrid-grid" role="grid" aria-label={`Chords of ${view.key.name} ${view.key.scaleLabel}`} ref={gridEl}>
          {view.columns.map((col, c) => (
            <div key={col.degree} role="row" className={`cgrid-col deg-${c} ${col.cells.length ? '' : 'empty'}`}>
              <div className="cgrid-head" role="columnheader" title={`${col.roman} — ${col.name} (${col.root})`}><b>{col.roman}</b><span>{col.name}</span></div>
              {col.cells.map((x, r) => cell(x, c, r))}
            </div>
          ))}
          <div role="row" className="cgrid-col deg-b">
            <div className="cgrid-head" role="columnheader">
              <span className="cgrid-pages" role="tablist" aria-label="Borrowed column">
                {mod.BORROWED_PAGES.map((p) => (
                  <button key={p.id} role="tab" aria-selected={view.borrowed.page === p.id} disabled={!view.borrowed.pages.includes(p.id)}
                    className={view.borrowed.page === p.id ? 'on' : ''} title={`${p.label}: ${p.about}${view.borrowed.pages.includes(p.id) ? '' : ' — not in this scale'}`} aria-label={p.label}
                    onClick={() => grid.setBorrowedPage(p.id)}>{p.short}</button>
                ))}
              </span>
            </div>
            {view.borrowed.cells.map((x, r) => cell(x, 7, r))}
            {!view.borrowed.cells.length && <span className="cgrid-none">Nothing to add here</span>}
          </div>
        </div>
      </div>

      <div className="cgrid-monitor">
        <div className="cgrid-now" aria-live="polite">
          {shown
            ? <><b>{shown.name || view.last?.name}</b><span>{shownCol ? `${shownCol.roman} · ${shownCol.name}` : shownCell?.startsWith('b:') ? 'Borrowed' : ''}</span><i>{names(shown.notes)}</i></>
            : <em className="muted">Click a chord to hear it on {channel ? channel.name : 'a channel'} — hold to sustain.</em>}
        </div>
        <Keys notes={view.sounding?.notes || view.last?.notes || []} ghost={ghost} />
      </div>

      <div className="cgrid-bar cgrid-trackbar">
        <button className={`btn ${s.capture ? 'on rec' : ''}`} aria-pressed={s.capture} title="Capture: every chord you play goes on the track, after the selected card" onClick={() => set({ capture: !s.capture })}><i className="cgrid-dot" /> Capture</button>
        <button className="btn" disabled={!playing && (!prog.cards.length || !channel)} onClick={() => (playing ? session.stop() : session.play({ withSong }))}><Icon name={playing ? 'stop' : 'play'} size={12} /> {playing ? 'Stop' : 'Play'}</button>
        <button className={`btn tiny ${withSong ? 'on' : ''}`} aria-pressed={withSong} title="Play the song's own playback with the track, from the same instant: hear the chords against the beat" onClick={() => setWithSong(!withSong)}>With the song</button>
        <span className="sep" />
        <button className="btn tiny" disabled={prog.cards.length < 2} title="Voice the whole track again as one chain: each chord led from the one before" onClick={() => grid.revoiceAll()}>Re-voice all</button>
        <button className="btn tiny" disabled={!prog.canUndo} title="Undo the last change to the track (Ctrl+Z while the track or a card has the focus)" aria-label="Undo track change" onClick={() => grid.undo()}><Icon name="undo" size={12} /></button>
        <button className="btn tiny" disabled={!prog.cards.length} title="Remove every card" onClick={() => { session.stop(); grid.clear(); }}>Clear</button>
        <Select value={prog.loopBars} onChange={(v) => grid.setLoop(Number(v))} title="Length of the loop" options={loops} />
        <span className="cgrid-spacer" />
        <button className="btn primary" disabled={!prog.cards.length || !pattern || !channel} title={pattern && channel ? `Write these chords as notes for ${channel.name} in ${pattern.name} (one undo step)` : 'Needs a pattern and a pitched channel'} onClick={write}>Write to {pattern ? pattern.name : 'pattern'}</button>
      </div>

      <div className="cgrid-trackwrap" onKeyDown={trackUndo}>
        <div className="cgrid-track" ref={trackEl} tabIndex={-1} style={{ minWidth: `${prog.loopBars * BAR_PX}px` }} role="list" aria-label="Progression track"
          onPointerDown={(e) => { if (e.target === e.currentTarget || e.target.classList.contains('cgrid-ruler')) grid.select(null); }}>
          <div className="cgrid-ruler" aria-hidden="true">
            {Array.from({ length: prog.loopBars }, (_, b) => <i key={b} style={{ left: `${(b / prog.loopBars) * 100}%`, width: `${100 / prog.loopBars}%` }}>{b + 1}</i>)}
          </div>
          {!prog.cards.length && <span className="cgrid-empty muted">{s.capture ? 'Play chords: each lands here.' : 'Turn Capture on and play, or drag chords here.'}</span>}
          {prog.cards.map((c) => {
            const at = live && live.i === c.index ? live : c;
            if (at.start >= prog.loopBars) return null; // (beyond a shortened loop: kept, not played)
            const tone = c.borrowed ? 'deg-b' : `deg-${c.degree}`;
            return (
              <div key={c.uid} role="listitem" tabIndex={0} className={`cgrid-card ${tone} ${prog.selected === c.index ? 'sel' : ''} ${c.offGrid ? 'off' : ''}`}
                style={{ left: `${(at.start / prog.loopBars) * 100}%`, width: `${(Math.min(at.bars, prog.loopBars - at.start) / prog.loopBars) * 100}%` }}
                aria-label={`Card ${c.index + 1}: ${c.name}, ${c.roman}, bar ${c.start + 1}, ${c.bars} ${c.bars === 1 ? 'bar' : 'bars'}`} aria-current={prog.selected === c.index}
                title={`${c.name} (${c.roman}) — ${names(c.notes)}${c.offGrid ? '\nNot a chord of this key any more: it plays as it was' : ''}\nDrag to move, the right edge to resize · arrows move, Alt+arrows resize, Delete removes`}
                onPointerDown={(e) => cardDown(e, c, 'move')} onPointerMove={cardMove} onPointerUp={cardUp} onPointerCancel={cardUp}
                onKeyDown={(e) => cardKey(e, c)} onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') session.release(); }}>
                <span className="cgrid-card-roman">{c.roman}</span>
                <b>{c.name}{c.bass ? <em>/{c.bass}</em> : null}</b>
                <i className="cgrid-card-edge" onPointerDown={(e) => cardDown(e, c, 'resize')} />
              </div>
            );
          })}
          {carry && carry.bar !== null && carry.bar < prog.loopBars && <i className="cgrid-drop" style={{ left: `${(carry.bar / prog.loopBars) * 100}%` }} />}
          <i className="cgrid-playhead" ref={headEl} />
        </div>
      </div>

      {sel && (
        <div className="cgrid-detail" aria-label={`Card ${sel.index + 1}`} onKeyDown={trackUndo}>
          <div className="cgrid-detail-row">
            <b className={sel.borrowed ? 'deg-b' : `deg-${sel.degree}`}>{sel.name}</b>
            <label className="param-select"><Select value={sel.voicingAsked} onChange={(v) => grid.setVoicing(sel.index, v)} title="How this card is voiced" options={mod.VOICINGS.map((v) => ({ value: v.id, label: v.label }))} /><span>Voicing</span></label>
            <span className="cgrid-step" role="group" aria-label="Inversion">
              <button className="cgrid-nudge" aria-label="Lower inversion" onClick={() => grid.setInversion(sel.index, sel.inversion - 1)}>‹</button>
              <span title={sel.pinned ? 'Set by hand: voice leading leaves this card where it is' : 'As voice leading placed it'}>{INVERSIONS[((sel.inversion % sel.notes.length) + sel.notes.length) % sel.notes.length] || sel.inversion}{sel.pinned ? ' •' : ''}</span>
              <button className="cgrid-nudge" aria-label="Higher inversion" onClick={() => grid.setInversion(sel.index, sel.inversion + 1)}>›</button>
              {sel.pinned && <button className="btn tiny" title="Give the card back to voice leading" onClick={() => grid.resetInversion(sel.index)}>Free</button>}
              <span className="cgrid-step-label">Inversion</span>
            </span>
            <span className="cgrid-step" role="group" aria-label="Card octave">
              <button className="cgrid-nudge" aria-label="Octave down" disabled={sel.octave <= -2} onClick={() => grid.setOctave(sel.index, sel.octave - 1)}>‹</button>
              <span>{sel.octave > 0 ? `+${sel.octave}` : sel.octave}</span>
              <button className="cgrid-nudge" aria-label="Octave up" disabled={sel.octave >= 2} onClick={() => grid.setOctave(sel.index, sel.octave + 1)}>›</button>
              <span className="cgrid-step-label">Octave</span>
            </span>
            <span className="cgrid-spacer" />
            <button className="tbtn small danger" aria-label={`Delete ${sel.name}`} title="Remove this card (Delete)" onClick={() => grid.remove(sel.index)}><Icon name="trash" size={12} /></button>
          </div>
          <div className="cgrid-detail-row">
            <span className="cgrid-step-label">Tensions</span>
            <span className="cgrid-tensions" role="group" aria-label="Tensions">
              {sel.offer.map((o) => {
                const on = o.state === 'on' || o.state === 'muted';
                const free = on || o.state === 'off';
                const base = o.state === 'built' ? 'already in the chord' : o.state === 'avoid' ? `avoided: ${o.why}` : o.state === 'muted' ? 'set, but it has no room in this voicing' : o.state === 'none' ? 'this chord has no such note' : o.inScale ? 'in the scale' : 'outside the scale';
                // (the rootless voicing plays the natural 9th where the root was: an altered ninth would sound with it)
                const why = sel.voicing === 'rootless' && (o.name === 'b9' || o.name === '#9') ? `${base} — the Rootless voicing already plays the natural 9th: it will sound with this one` : base;
                return (
                  <button key={o.name} className={`cgrid-tension ${o.state} ${o.inScale ? '' : 'out'}`} aria-pressed={on} disabled={!free} title={`${o.name.replace('b', '♭').replace('#', '♯')} — ${why}`}
                    onClick={() => grid.setTension(sel.index, o.name, !on)}>{o.name.replace('b', '♭').replace('#', '♯')}</button>
                );
              })}
            </span>
            <span className="muted cgrid-notes">{names(sel.notes)}</span>
          </div>
          <div className="cgrid-detail-row cgrid-options">
            <div className="cgrid-seg" role="tablist" aria-label="Options for this card">
              {OPTION_TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={optTab === id} className={optTab === id ? 'on' : ''} onClick={() => setOptTab(id)}>{label}</button>)}
            </div>
            <div className="cgrid-opts">
              {!options.length && <span className="muted">Nothing to offer for this chord.</span>}
              {options.map((o) => (
                <button key={o.k} className={`cgrid-opt ${o.level ? `smart-${o.level}` : ''} ${o.voicing && o.voicing === sel.voicing ? 'on' : ''}`}
                  title={`${o.name}${o.roman ? ` (${o.roman})` : ''}${OPTION_KINDS[o.kind] ? ` — ${OPTION_KINDS[o.kind]}` : ''} · ${names(o.notes)}\nClick to hear · double-click or Shift+Enter to ${optTab === 'next' ? 'add it after this card' : 'use it'}`}
                  onPointerDown={(e) => { if (e.button === 0) grid.auditionOption(sel.index, optTab, o.k); }} onPointerUp={() => session.release()} onPointerLeave={() => session.release()}
                  onDoubleClick={() => { grid.applyOption(sel.index, optTab, o.k); session.release(); }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.repeat) return;
                    if (e.shiftKey) { grid.applyOption(sel.index, optTab, o.k); session.release(); } else grid.auditionOption(sel.index, optTab, o.k);
                  }}
                  onKeyUp={() => session.release()}>
                  <b>{o.name}</b>{o.roman && o.kind !== 'voic' ? <span>{o.roman}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {carry && <div className="cgrid-carry" style={{ left: carry.x + 10, top: carry.y + 10 }}>{carry.label}</div>}
      <p className="cgrid-credit muted">Chord engine: <b>{mod.TUPLE_SOURCE.name} {mod.TUPLE_SOURCE.version}</b> by {mod.TUPLE_SOURCE.author}, used under the <a href="/licenses/tuple-MIT.txt" target="_blank" rel="noreferrer">MIT licence</a> — tuple.live</p>
    </div>
  );
}
