import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PPQ, STEP, ticksPerBar, uid, patternLength, maxPatternLength, chordNotes, SCALE_INFO, keyContext, readChord, analyzeChord,
  tensionCurve, suggestNext, substitutions, findProgressions, progressionTags, identifyProgression, chordsFromNotes, scaleSpelling, voiceLead,
  chordProgressionNotes, arpeggiate, followsTuning, stackedChord, noteName,
  TUNING_SYSTEMS, normalizeTuning, tuningTable, describeTuning, chordPurity, isStandardTuning, A4_MIN, A4_MAX, EDO_MIN, EDO_MAX
} from '@ggs/core';
import { useStore } from '../state/store.js';
import { ensureEngine } from '../audio/index.js';
import { Window } from './ui/Window.jsx';
import { Select, DragNumber } from './ui/Controls.jsx';
import { Icon } from './ui/Icon.jsx';
import { scaleOptions } from '../lib/scales.js';
import { GridTab } from './ChordGrid.jsx';

const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// what was being built, per project: closing the window (or switching projects) does not throw a progression away
const kept = new Map();

const POOLS = [['diatonic', 'In the key'], ['borrowed', 'Borrowed from parallel modes'], ['chromatic', 'Chromatic']];
// how long each chord lasts: in bars of the project's own metre (a bar of 3/4 is three beats, not four)
const SPANS = [['bar', '1 bar', 1], ['half', '½ bar', 0.5], ['two', '2 bars', 2], ['beat', '1 beat', 0]];
const VOICINGS = [['smooth', 'Smooth (4 voices)'], ['smooth3', 'Smooth (3 voices)'], ['smooth5', 'Smooth (5 voices)'], ['close', 'Close'], ['open', 'Open'], ['drop2', 'Drop 2'], ['spread', 'Spread'], ['shell', 'Shell'], ['rootless', 'Rootless']];
const STYLES = [['block', 'Held chords'], ['up', 'Arpeggio up'], ['down', 'Arpeggio down'], ['updown', 'Arpeggio up-down'], ['converge', 'Arpeggio outside-in'], ['pinky', 'Arpeggio, top note between'], ['random', 'Arpeggio random']];

/** The pitches of each chord of a progression in a voicing: [[midi…], …]. */
function voice(chords, voicing) {
  if (!chords.length) return [];
  const voices = { smooth: 4, smooth3: 3, smooth5: 5 }[voicing];
  // A chord of two notes (A5) has no five-voice voicing in this range: use as many voices as the chords allow, and a
  // plain close voicing when even three do not fit — a button here must never fail.
  for (let v = voices; v >= 3; v--) {
    try { return voiceLead(chords, { voices: v, low: 43, high: 79 }).voicings; } catch { /* try with one voice fewer */ }
  }
  const span = PPQ * 4;
  const notes = chordProgressionNotes(chords, { start: 0, chordLength: span, octave: 4, style: 'block', voicing: voices ? 'close' : voicing, gate: 1 });
  return chords.map((_, i) => notes.filter((n) => n.start === i * span).map((n) => n.key).sort((a, b) => a - b));
}

/** Play pitches on a channel now (the engine applies the project's tuning, as for every note). */
async function sound(channelId, pitches, seconds = 1.1) {
  const engine = await useStore.getState().unlockAudio().catch(() => ensureEngine());
  pitches.forEach((key, i) => engine.preview(channelId, key, 0.72 - i * 0.03, seconds));
}

function TensionLine({ curve }) {
  if (curve.length < 2) return null;
  const w = 100;
  const pts = curve.map((c, i) => `${(i / (curve.length - 1)) * w},${26 - c.tension * 24}`).join(' ');
  return (
    <svg className="harmony-tension" viewBox={`0 0 ${w} 28`} preserveAspectRatio="none" role="img" aria-label={`Tension: ${curve.map((c) => c.tension.toFixed(2)).join(', ')}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ChordsTab({ project, ctx, channel, pattern }) {
  const st = useStore.getState();
  const saved = kept.get(project.id);
  const [chords, setChordsRaw] = useState(saved?.chords || []);
  const [selected, setSelected] = useState(null);
  const [sevenths, setSevenths] = useState(false);
  const [each, setEach] = useState('bar');
  const span = each === 'beat' ? PPQ : Math.round(ticksPerBar(project) * SPANS.find(([id]) => id === each)[2]);
  const [voicing, setVoicing] = useState('smooth');
  const [style, setStyle] = useState('block');
  const [playing, setPlaying] = useState(-1);
  const timers = useRef([]);
  const setChords = (next) => { kept.set(project.id, { chords: next }); setChordsRaw(next); };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  // a library progression chosen in the other tab lands here
  const incoming = useStore((s) => s.harmonyLoad);
  useEffect(() => {
    if (!incoming || incoming.projectId !== project.id) return;
    setChords(incoming.chords);
    setSelected(null);
    useStore.setState({ harmonyLoad: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  // chords that no longer read (the key changed under a roman numeral, say) are dropped rather than break the window
  const read = useMemo(() => chords.map((c) => { try { return readChord(c, ctx); } catch { return null; } }).filter(Boolean), [chords, ctx]);
  const curve = useMemo(() => tensionCurve(read, ctx), [read, ctx]);
  const known = useMemo(() => identifyProgression(read, ctx), [read, ctx]);
  const next = useMemo(() => suggestNext(read, ctx, undefined, { count: 200, sevenths }), [read, ctx, sevenths]);
  const diatonic = useMemo(() => {
    const byName = new Map(next.filter((x) => x.pool === 'diatonic').map((x) => [x.chord, x]));
    const own = [0, 1, 2, 3, 4, 5, 6].map((d) => stackedChord(ctx, d, sevenths) || stackedChord(ctx, d)).filter(Boolean).map((c) => byName.get(c.name)).filter(Boolean);
    return [...own, ...next.filter((x) => x.pool === 'diatonic' && !own.includes(x))];
  }, [next, ctx, sevenths]);
  const rows = { diatonic, borrowed: next.filter((x) => x.pool === 'borrowed').slice(0, 8), chromatic: next.filter((x) => x.pool === 'chromatic').slice(0, 8) };
  const sel = selected !== null && read[selected] ? read[selected] : null;
  const subs = useMemo(() => (sel ? substitutions(sel, ctx) : []), [sel, ctx]);

  const names = read.map((c) => c.name);
  const hear = (name, after = names) => {
    if (!channel) return;
    // voiced next to what is already there, so it sounds the way it would in the progression
    const all = voice([...after, name], voicing);
    sound(channel.id, all[all.length - 1]);
  };
  const add = (name) => { setChords([...names, name]); hear(name); };
  const stop = () => { timers.current.forEach(clearTimeout); timers.current = []; setPlaying(-1); };
  const play = () => {
    stop();
    if (!channel || !names.length) return;
    const voiced = voice(names, voicing);
    const seconds = Math.max(0.35, (span / PPQ) * (60 / project.bpm));
    voiced.forEach((pitches, i) => timers.current.push(setTimeout(() => { setPlaying(i); sound(channel.id, pitches, seconds * 0.95); }, i * seconds * 1000)));
    timers.current.push(setTimeout(() => setPlaying(-1), voiced.length * seconds * 1000));
  };
  const fromPattern = () => {
    if (!pattern || !channel) return;
    const notes = pattern.notes[channel.id] || [];
    const found = chordsFromNotes(notes, { segment: span, end: patternLength(project, pattern), spell: scaleSpelling(ctx.key, ctx.scale) }).filter((c) => c.chord);
    if (!found.length) { st.toast(`No chords found on ${channel.name} in ${pattern.name}`, 'info', 2200); return; }
    // an inversion is how a chord was voiced, not another chord: the strip shows G, not G/D (a bass from outside the chord stays)
    const plain = (name) => { const c = readChord(name, ctx); return c.bass !== null && c.pcs.includes(c.bass) ? `${c.rootName}${c.quality}` : c.name; };
    setChords(found.flatMap((c) => Array.from({ length: Math.round(c.length / span) }, () => plain(c.chord))));
    setSelected(null);
  };
  const write = () => {
    if (!pattern || !channel || !names.length) return;
    const end = names.length * span;
    if (end > maxPatternLength(project)) { st.toast('That is longer than a pattern can be: use fewer chords or shorter ones', 'error'); return; }
    const voiced = voice(names, voicing);
    const notes = style === 'block'
      ? voiced.flatMap((pitches, i) => pitches.map((key) => ({ id: uid('n'), key, start: i * span, length: span, velocity: 0.75 })))
      : arpeggiate(voiced.map((pitches, i) => ({ pitches, start: i * span, length: span })), { mode: style, rate: STEP * 2, velocity: 0.75, seed: names.join(' ') }).map((n) => ({ id: uid('n'), ...n }));
    const ops = [];
    const bar = ticksPerBar(project);
    if (end > pattern.length) ops.push({ type: 'pattern/update', id: pattern.id, patch: { length: Math.ceil(end / bar) * bar } });
    ops.push({ type: 'notes/set', patternId: pattern.id, channelId: channel.id, notes: [...(pattern.notes[channel.id] || []).filter((n) => n.start >= end), ...notes] });
    st.dispatch(ops);
    st.toast(`${names.join(' – ')} written to ${channel.name} in ${pattern.name}`, 'success', 2200);
  };

  return (
    <div className="harmony-chords">
      <div className="harmony-strip" role="list" aria-label="Progression">
        {!read.length && <span className="muted">Pick chords below to build a progression — click one to hear it, + to add it.</span>}
        {read.map((c, i) => {
          const a = curve[i];
          return (
            <div key={i} role="listitem" className={`harmony-chip fn-${a.function.replace(' ', '-')} ${selected === i ? 'sel' : ''} ${playing === i ? 'playing' : ''}`}>
              <button className="harmony-chip-main" title={`${analyzeChord(c, ctx).why} — tension ${a.tension.toFixed(2)}`} onClick={() => { setSelected(selected === i ? null : i); hear(c.name, names.slice(0, i)); }}>
                <b>{c.name}</b><span>{a.numeral}</span>
                <i style={{ height: `${Math.round(3 + a.tension * 15)}px` }} />
              </button>
              <button className="harmony-chip-x" aria-label={`Remove ${c.name}`} title="Remove" onClick={() => { setChords(names.filter((_, j) => j !== i)); setSelected(null); }}><Icon name="close" size={10} /></button>
            </div>
          );
        })}
      </div>
      {read.length > 1 && (
        <div className="harmony-meta">
          <TensionLine curve={curve} />
          <span className="muted">
            {known.length ? <>Known as <b>{known[0].name}</b>{known[0].match === 'rotation' ? ' (started on another chord)' : ''}. </> : null}
            Tension {curve.map((x) => x.tension.toFixed(2)).join(' → ')}
          </span>
        </div>
      )}
      <div className="row harmony-actions">
        <button className="btn" onClick={playing >= 0 ? stop : play} disabled={!names.length || !channel}><Icon name={playing >= 0 ? 'stop' : 'play'} size={12} /> {playing >= 0 ? 'Stop' : 'Play'}</button>
        <button className="btn" onClick={() => { stop(); setChords([]); setSelected(null); }} disabled={!names.length}>Clear</button>
        <button className="btn" onClick={fromPattern} disabled={!pattern || !channel} title={pattern && channel ? `Read the chords ${channel.name} plays in ${pattern.name}` : ''}>Read from pattern</button>
        <button className={`btn ${sevenths ? 'on' : ''}`} aria-pressed={sevenths} onClick={() => setSevenths(!sevenths)} title="Suggest seventh chords instead of triads">7ths</button>
      </div>

      {sel && (
        <div className="harmony-detail">
          <div><b>{sel.name}</b> — {analyzeChord(sel, ctx).why}.</div>
          <div className="harmony-subs">
            {subs.map((s) => (
              <button key={`${s.kind}${s.chord}`} className="harmony-sub" title={s.why} onClick={() => { hear(s.chord, names.slice(0, selected)); }}
                onDoubleClick={() => setChords(names.map((n, j) => (j === selected ? s.chord : n)))}
                onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); setChords(names.map((n, j) => (j === selected ? s.chord : n))); } }}>
                <b>{s.chord}</b><span>{s.kind}</span>
              </button>
            ))}
          </div>
          <div className="muted">Click a substitute to hear it in place, double-click (or Shift+Enter) to use it. Approach chords go in front of {sel.name}.</div>
        </div>
      )}

      {POOLS.map(([pool, title]) => rows[pool].length > 0 && (
        <div key={pool} className="harmony-pool">
          <h4>{read.length ? `Next — ${title.toLowerCase()}` : title}</h4>
          <div className="harmony-pads">
            {rows[pool].map((x) => (
              <div key={x.chord} className={`harmony-pad fn-${x.function.replace(' ', '-')}`} style={{ '--fit': Math.round(x.score * 100) / 100 }}>
                <button className="harmony-pad-main" title={`${x.why} (fits ${x.score.toFixed(2)}, tension ${x.tension.toFixed(2)})`} onClick={() => hear(x.chord)} onDoubleClick={() => setChords([...names, x.chord])}>
                  <span>{x.numeral}</span><b>{x.chord}</b>
                  <i style={{ width: `${Math.round(x.score * 100)}%` }} />
                </button>
                <button className="harmony-pad-add" aria-label={`Add ${x.chord}`} title={`Add ${x.chord} to the progression`} onClick={() => add(x.chord)}><Icon name="plus" size={11} /></button>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="row harmony-write">
        <Select value={each} onChange={setEach} title="Length of each chord" options={SPANS.map(([value, label]) => ({ value, label: `${label} each` }))} />
        <Select value={voicing} onChange={setVoicing} title="How the chords are voiced" options={VOICINGS.map(([value, label]) => ({ value, label }))} />
        <Select value={style} onChange={setStyle} title="How the chords are played" options={STYLES.map(([value, label]) => ({ value, label }))} />
        <button className="btn primary" onClick={write} disabled={!names.length || !pattern || !channel}>Write to {pattern ? pattern.name : 'pattern'}</button>
      </div>
    </div>
  );
}

function LibraryTab({ project, ctx, channel, onLoad }) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState(null);
  const [mood, setMood] = useState(ctx.minor ? 'minor' : 'major');
  const tags = useMemo(() => progressionTags().slice(0, 28), []);
  const found = useMemo(() => {
    try { return findProgressions({ query, tags: tag ? [tag] : [], mood: mood === 'any' ? null : mood, key: ctx.key, limit: 100 }); } catch { return []; }
  }, [query, tag, mood, ctx.key]);
  // one progression is heard at a time: the next ▶ (or the same one again, or closing the window) stops the last
  const timers = useRef([]);
  const [hearing, setHearing] = useState(null);
  const stop = () => { timers.current.forEach(clearTimeout); timers.current = []; setHearing(null); };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const hear = (p) => {
    const was = hearing;
    stop();
    if (was === p.name) return;
    const voiced = voice(p.chords, 'smooth');
    const each = Math.max(0.4, (60 / project.bpm) * 2);
    timers.current = voiced.map((pitches, i) => setTimeout(() => sound(channel.id, pitches, each * 0.95), i * each * 1000));
    timers.current.push(setTimeout(() => setHearing(null), voiced.length * each * 1000));
    setHearing(p.name);
  };
  return (
    <div className="harmony-library">
      <div className="row">
        <input className="input" type="search" placeholder="Search 82 progressions: sad piano, andalusian, ii-V…" aria-label="Search progressions" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <Select value={mood} onChange={setMood} title="Major or minor progressions" options={[{ value: 'minor', label: 'Minor modes' }, { value: 'major', label: 'Major modes' }, { value: 'any', label: 'All' }]} />
      </div>
      <div className="harmony-tags">
        {tags.map((t) => <button key={t.tag} className={`harmony-tag ${tag === t.tag ? 'on' : ''}`} aria-pressed={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)}>{t.tag}</button>)}
      </div>
      <div className="harmony-list">
        {!found.length && <p className="empty-hint">Nothing fits. Try fewer words, another tag or “All”.</p>}
        {found.map((p) => (
          <div key={p.name} className="harmony-prog">
            <button className="tbtn small" aria-label={hearing === p.name ? `Stop ${p.name}` : `Hear ${p.name}`} title={hearing === p.name ? 'Stop' : 'Hear it'} aria-pressed={hearing === p.name} disabled={!channel} onClick={() => hear(p)}><Icon name={hearing === p.name ? 'stop' : 'play'} size={11} /></button>
            <button className="harmony-prog-main" title="Use this progression" onClick={() => onLoad(p.chords)}>
              <span className="harmony-prog-name"><b>{p.name}</b> <i>{SCALE_INFO[p.scale].label}</i></span>
              <span className="harmony-prog-chords">{p.chords.join('  ')}</span>
              <span className="muted">{p.description}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const WELL = new Set(['werckmeister', 'kirnberger', 'vallotti', 'young']);
const COMMAS = [[0.25, '¼ comma'], [0.2857, '²⁄₇ comma'], [0.3333, '⅓ comma'], [0.2, '⅕ comma'], [0.1667, '⅙ comma']];

function TuningTab({ project, ctx, channel }) {
  const st = useStore.getState();
  const tuning = useMemo(() => normalizeTuning(project.tuning), [project.tuning]);
  const table = useMemo(() => tuningTable(tuning), [tuning]);
  const system = TUNING_SYSTEMS.find((t) => t.id === tuning.system);
  const set = (patch, coalesce = null) => st.dispatch([{ type: 'project/update', patch: { tuning: patch } }], coalesce ? { coalesce } : undefined);
  const choose = (id) => {
    // a system chosen from the standard is built on the song's key (the well temperaments on C, as they were designed)
    const fresh = tuning.system === 'equal' && !tuning.divisions && id !== 'equal';
    set({ system: id, ...(fresh ? { root: WELL.has(id) ? 'C' : project.key } : {}) });
  };
  // the tonic chord, and how it stands in this tuning and in the others
  const tonic = useMemo(() => chordNotes((stackedChord(ctx, 0) || readChord(ctx.key)).name, 4), [ctx]);
  const purity = useMemo(() => chordPurity(tuning, tonic), [tuning, tonic]);
  const others = useMemo(() => ['equal', 'just', 'pythagorean', 'meantone', 'werckmeister'].filter((id) => id !== tuning.system).map((id) => {
    const t = normalizeTuning({ system: id, root: tuning.root, a4: tuning.a4 });
    return { id, label: TUNING_SYSTEMS.find((x) => x.id === id).label, beats: chordPurity(t, tonic).worstBeatsHz };
  }), [tuning, tonic]);
  const twelve = table.length === 12;
  const custom = tuning.system === 'custom';
  return (
    <div className="harmony-tuning">
      <div className="row">
        <label className="param-select"><Select value={tuning.system} onChange={choose} title="Tuning system" options={TUNING_SYSTEMS.filter((t) => t.id !== 'custom' || custom).map((t) => ({ value: t.id, label: t.label }))} /><span>System</span></label>
        <label className="param-select"><Select value={tuning.root} onChange={(v) => set({ root: v })} title="The note the tuning is built on: it keeps its equal-tempered pitch" options={PC_NAMES} disabled={tuning.system === 'equal' && !tuning.divisions} /><span>Root</span></label>
        <label className="param-select">
          <DragNumber value={tuning.a4} min={A4_MIN} max={A4_MAX} step={1} label="A4 in hertz" title="Reference pitch: drag, or double-click to type (440 = concert pitch)" format={(v) => `${Number(v).toFixed(v % 1 ? 1 : 0)} Hz`} onChange={(v) => set({ a4: v }, 'tuning-a4')} />
          <span>A4</span>
        </label>
        {tuning.system === 'meantone' && (
          <label className="param-select"><Select value={COMMAS.reduce((best, c) => (Math.abs(c[0] - tuning.fraction) < Math.abs(best[0] - tuning.fraction) ? c : best))[0]} onChange={(v) => set({ fraction: Number(v) })} title="How much each fifth is narrowed" options={COMMAS.map(([value, label]) => ({ value, label }))} /><span>Fifths narrowed by</span></label>
        )}
        {tuning.system === 'equal' && (
          <label className="param-select"><DragNumber value={tuning.divisions || 12} min={EDO_MIN} max={EDO_MAX} step={1} label="Equal steps per octave" title="Equal steps per octave (12 = standard). With another number every key is one step." onChange={(v) => set({ divisions: v }, 'tuning-edo')} /><span>Steps / octave</span></label>
        )}
        <button className="btn" onClick={() => set(null)} disabled={isStandardTuning(tuning)} title="Twelve equal semitones at A4 = 440 Hz">Standard</button>
      </div>
      <p className="harmony-about"><b>{describeTuning(tuning)}.</b> {system.description}</p>
      <div className="row">
        <button className="btn" disabled={!channel} onClick={() => sound(channel.id, tonic, 2.4)}><Icon name="play" size={12} /> Tonic chord</button>
        <button className="btn" disabled={!channel} onClick={() => tonic.forEach((key, i) => setTimeout(() => sound(channel.id, [key], 0.5), i * 320))}><Icon name="play" size={12} /> One note at a time</button>
        <span className="muted">
          {tonic.map(noteName).join(' ')}: {purity.ratios ? <>exactly <b>{purity.ratios}</b>, </> : null}{purity.worstBeatsHz < 0.05 ? 'beatless' : `beats ${purity.worstBeatsHz.toFixed(1)} times a second`}
          {twelve ? <>. Elsewhere it beats: {others.map((o) => `${o.label.split(' (')[0]} ${o.beats < 0.05 ? '0' : o.beats.toFixed(1)}/s`).join(', ')}</> : null}
        </span>
      </div>
      <div className="harmony-table" role="table" aria-label="Tuning table">
        <div className="harmony-tr head" role="row"><span role="columnheader">Note</span><span role="columnheader">Ratio</span><span role="columnheader">Cents</span><span role="columnheader">{twelve ? 'From equal' : ''}</span><span role="columnheader">Hz</span></div>
        {table.map((r) => (
          <div key={r.degree} className="harmony-tr" role="row">
            <span role="cell"><b>{r.note}</b></span>
            <span role="cell" className="mono">{r.ratio || (r.near ? `≈ ${r.near}` : '—')}</span>
            <span role="cell" className="mono">{r.cents.toFixed(1)}</span>
            <span role="cell" className="harmony-dev">
              {twelve && <><i style={{ left: `${50 + Math.max(-50, Math.min(50, r.deviation))}%` }} className={Math.abs(r.deviation) < 0.05 ? 'zero' : ''} /><em className="mono">{r.deviation > 0 ? '+' : ''}{r.deviation.toFixed(1)}</em></>}
            </span>
            <span role="cell" className="mono">{r.hz.toFixed(3)}</span>
          </div>
        ))}
      </div>
      <p className="muted">Every pitched instrument follows the tuning — in playback, renders and exports. Drums are not retuned. The root keeps its equal-tempered pitch; the other notes are placed against it.</p>
    </div>
  );
}

/** Harmony: the chord grid, chords that fit the key and what could follow them, a library of progressions, and the project's tuning. */
export function Harmony() {
  const project = useStore((s) => s.project);
  const open = useStore((s) => s.windows.harmony?.open);
  const patternId = useStore((s) => s.selectedPatternId);
  const preferred = useStore((s) => s.pianoRollChannelId || s.selectedChannelId);
  const [tab, setTab] = useState('grid');
  const [channelId, setChannelId] = useState(null);
  const ctx = useMemo(() => (project ? keyContext(project.key, project.scale) : null), [project?.key, project?.scale]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!project || !open) return <Window name="harmony" title="Harmony" icon="music" />;
  const st = useStore.getState();
  const pitched = project.channels.filter((c) => followsTuning(c.instrument));
  const channel = pitched.find((c) => c.id === channelId) || pitched.find((c) => c.id === preferred) || pitched[0] || null;
  const pattern = project.patterns.find((p) => p.id === patternId) || project.patterns[0] || null;
  return (
    <Window name="harmony" title="Harmony" icon="music" minW={380} minH={300} className="harmony"
      toolbar={(
        <>
          <Select value={project.key || 'C'} title="Key" onChange={(v) => st.dispatch([{ type: 'project/update', patch: { key: v } }])} options={PC_NAMES} />
          <Select value={project.scale} title={`Scale — ${SCALE_INFO[project.scale]?.description || ''}`} onChange={(v) => st.dispatch([{ type: 'project/update', patch: { scale: v } }])} options={scaleOptions()} />
          <span className="sep" />
          {pitched.length ? <Select value={channel.id} title="The channel that plays and receives the chords" onChange={setChannelId} options={pitched.map((c) => ({ value: c.id, label: c.name }))} /> : <span className="muted">No pitched channel</span>}
        </>
      )}>
      <div className="harmony-body">
        <div className="ggs-tabs" role="tablist">
          {[['grid', 'Grid'], ['chords', 'Chords'], ['library', 'Library'], ['tuning', 'Tuning']].map(([id, label]) => (
            <button key={id} role="tab" id={`harmony-tab-${id}`} aria-controls="harmony-pane" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{id === 'tuning' && !isStandardTuning(project.tuning) ? ' •' : ''}</button>
          ))}
        </div>
        <div className="harmony-pane" id="harmony-pane" role="tabpanel" aria-labelledby={`harmony-tab-${tab}`}>
          {tab === 'grid' && <GridTab project={project} channel={channel} pattern={pattern} />}
          {tab === 'chords' && <ChordsTab key={project.id} project={project} ctx={ctx} channel={channel} pattern={pattern} />}
          {tab === 'library' && <LibraryTab project={project} ctx={ctx} channel={channel} onLoad={(chords) => { kept.set(project.id, { chords }); useStore.setState({ harmonyLoad: { projectId: project.id, chords } }); setTab('chords'); }} />}
          {tab === 'tuning' && <TuningTab project={project} ctx={ctx} channel={channel} />}
        </div>
      </div>
    </Window>
  );
}
