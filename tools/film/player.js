// The Kaleidoscope film's player. It draws the piece at any moment from what the synth reported while it rendered
// (tools/film/kaleidoscope.mjs): every note's strike, body, pulse, air and sub sixty times a second. draw(t) is a
// pure function of t — nothing is remembered between frames — so the page that plays along with the audio and the
// recorder that steps through it frame by frame show exactly the same pictures. What has been played does not
// change any more, so the score is painted once (as it is when all of it has been played, and as it is before any
// of it has) and a frame only uncovers it up to the playhead and adds what is happening now.
(() => {
  const FILM = window.FILM;
  const D = FILM.data;
  const RECORD = /[?&]record\b/.test(location.search);
  const W = 1920;
  const H = 1080;
  const TAU = Math.PI * 2;
  const FPS = D.fps;

  // ------------------------------------------------------------------------------------------------- small maths
  const lerp = (a, b, u) => a + (b - a) * u;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const ease = (u) => { const x = clamp(u); return x * x * (3 - 2 * x); };
  const smoother = (u) => { const x = clamp(u); return x * x * x * (x * (6 * x - 15) + 10); };
  const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3);
  const mix = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a).toFixed(3)})`;
  /** A number in 0…1 that is always the same for the same i: every spark and mote has its place without any state. */
  const rnd = (i) => {
    let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  /** A row of the synth's report at a (fractional) frame. */
  const row = (arr, f) => {
    const last = arr.length - 1;
    if (last < 0) return 0;
    if (f <= 0) return arr[0];
    if (f >= last) return arr[last];
    const i = f | 0;
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  };

  // ------------------------------------------------------------------------------------------------------ palette
  const C = {
    night0: [5, 7, 15], night1: [10, 15, 34],
    ink: [244, 233, 210], dim: [143, 134, 114], faint: [200, 212, 255],
    strike: [255, 246, 222], amber: [255, 160, 48], gold: [255, 206, 120], white: [255, 242, 208],
    pulse: [150, 212, 255], pulseHi: [226, 228, 255], air: [226, 234, 252], sub: [206, 88, 44]
  };
  const LAYERS = [['strike', 'STRIKE', C.strike], ['body', 'BODY', C.gold], ['pulse', 'PULSE', C.pulse], ['air', 'AIR', C.air], ['sub', 'SUB', C.sub]];
  const SANS = '"Inter Display", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

  // ------------------------------------------------------------------------------------------------------- layout
  const SX0 = 150; const SX1 = 1860; const SW = SX1 - SX0; // the score, left to right
  const SY0 = 238; const SY1 = 748; // voices
  const LY0 = 770; const LH = 19; const LGAP = 5; // one lane per layer
  const LY1 = LY0 + LAYERS.length * LH + (LAYERS.length - 1) * LGAP;
  const KY0 = 900; const KH = 100; const KEY_FIRST = 36; const KEY_LAST = 84; // the keyboard, C2…C6
  const PITCH_LO = 37; const PITCH_HI = 82;
  const VIB = 13; // pixels per semitone of vibrato
  const WIN = 16; // seconds of the piece on screen: the view moves on at half the playhead's pace
  const yOf = (key) => SY1 - 16 - ((key - PITCH_LO) / (PITCH_HI - PITCH_LO)) * (SY1 - SY0 - 40);
  const PXS = SW / WIN; // pixels per second
  let cam = 0; // the moment at the left edge of the score
  let ox = SX0; // where that moment is drawn
  const xOf = (time) => ox + (time - cam) * PXS;

  // ------------------------------------------------------------------------------------- the piece, made drawable
  const NOTES = D.notes;
  const hz = (key) => 440 * Math.pow(2, (key - 69) / 12);
  const CENTS = [-14.7, -8.4, -2.6, 0, 2.7, 8.3, 14.4]; // the body's seven copies under the supersaw law at this detune
  for (const n of NOTES) {
    n.t0 = n.k0 / FPS;
    n.t1 = (n.k0 + n.frames) / FPS;
    n.y = yOf(n.key);
    n.strikePeak = Math.max(...n.strike);
    n.airPeak = Math.max(...n.air);
    // how fast each copy beats against the centre one, in Hz: the braid moves at the speed the note really beats
    n.beat = CENTS.map((c) => hz(n.key) * (Math.pow(2, c / 1200) - 1));
  }
  const LEAD = 0.62; // seconds before a note in which its voice travels to it
  /** A voice's path through time: [time, key] points, flat on a note and eased from one to the next. */
  function guideOf(list, birth) {
    const pts = [];
    const curve = (tA, kA, tB, kB) => { for (let i = 0; i <= 28; i++) pts.push([lerp(tA, tB, i / 28), lerp(kA, kB, smoother(i / 28))]); };
    if (birth !== null) curve(list[0].start - LEAD, birth, list[0].start, list[0].key);
    list.forEach((n, i) => {
      const next = list[i + 1];
      if (!next) { pts.push([n.start, n.key], [n.t1, n.key]); return; }
      const tA = Math.max(n.start + (next.start - n.start) * 0.45, next.start - LEAD);
      pts.push([n.start, n.key], [tA, n.key]);
      curve(tA, n.key, next.start, next.key);
    });
    return pts;
  }
  const chordNotes = NOTES.filter((n) => n.role === 'chord');
  const melody = NOTES.filter((n) => n.role === 'melody').sort((a, b) => a.start - b.start);
  const top = chordNotes.filter((n) => n.voice === 4).sort((a, b) => a.start - b.start);
  const topKeyAt = (time) => { let k = top[0].key; for (const n of top) if (n.start <= time) k = n.key; return k; };
  const VOICES = [];
  for (let v = 0; v < 6; v++) {
    const list = chordNotes.filter((n) => n.voice === v).sort((a, b) => a.start - b.start);
    if (!list.length) continue;
    // a voice is born out of the one that was there: the four lower ones out of the first note, the sixth out of the melody
    const birth = v === 4 ? null : v === 5 && melody.length ? melody[melody.length - 1].key : topKeyAt(list[0].start - 0.2);
    VOICES.push({ id: v, list, pts: guideOf(list, birth), melody: false });
  }
  if (melody.length) VOICES.push({ id: 'melody', list: melody, pts: guideOf(melody, topKeyAt(melody[0].start - 0.2)), melody: true });
  const guideKey = (pts, time) => {
    if (time <= pts[0][0] || time >= pts[pts.length - 1][0]) return null;
    let lo = 0; let hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= time) lo = m; else hi = m; }
    const a = pts[lo]; const b = pts[hi];
    return b[0] === a[0] ? b[1] : lerp(a[1], b[1], (time - a[0]) / (b[0] - a[0]));
  };
  const chordAt = (time) => { let i = 0; D.chords.forEach((c, k) => { if (c.t0 <= time) i = k; }); return i; };
  const sectionAt = (time) => { let i = 0; D.sections.forEach((s, k) => { if (s.t0 <= time) i = k; }); return i; };
  const ACCENT = D.pattern.map((v) => v >= 0.85);

  // ------------------------------------------------------------------------------------------------------ canvases
  const out = document.getElementById('stage');
  const octx = out.getContext('2d');
  const make = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const lit = make(W, H); // everything that gives light: it is added to the night, and once more blurred (the bloom)
  const litCtx = lit.getContext('2d');
  let ctx = litCtx; // what is being drawn on: the light of this frame, or the score when it is painted once
  const half = make(W / 2, H / 2); const quarter = make(W / 4, H / 4); const eighth = make(W / 8, H / 8);
  // a soft round light, drawn once and stamped wherever something glows
  const GLOW = make(128, 128);
  {
    const g = GLOW.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.12)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  }
  const tinted = new Map();
  /** The round light in a colour (tinted once per colour). */
  function glowOf(c) {
    const key = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
    let s = tinted.get(key);
    if (!s) {
      s = make(128, 128);
      const g = s.getContext('2d');
      g.drawImage(GLOW, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = `rgb(${key})`; g.fillRect(0, 0, 128, 128);
      tinted.set(key, s);
    }
    return s;
  }
  const light = (g, x, y, r, c, a) => { if (a <= 0.003 || r <= 0) return; g.globalAlpha = clamp(a); g.drawImage(glowOf(c), x - r, y - r, r * 2, r * 2); g.globalAlpha = 1; };
  /** Text with air between its letters (canvas letter-spacing is not everywhere yet). */
  function spaced(g, text, x, y, gap, align = 'left') {
    let width = 0;
    for (const ch of text) width += g.measureText(ch).width + gap;
    width -= gap;
    let at = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    g.textAlign = 'left';
    for (const ch of text) { g.fillText(ch, at, y); at += g.measureText(ch).width + gap; }
    return width;
  }

  // ------------------------------------------------------------------------------------------------------ the night
  const sky = make(W, H); const veil = make(W, H);
  function paintNight() {
    const g = sky.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, rgba(C.night0, 1)); bg.addColorStop(0.55, rgba(C.night1, 1)); bg.addColorStop(1, rgba([6, 8, 18], 1));
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // the corners fall away (laid over everything at the end)
    const v = veil.getContext('2d');
    v.clearRect(0, 0, W, H);
    const vig = v.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
    vig.addColorStop(0, 'rgba(2,3,8,0)'); vig.addColorStop(1, 'rgba(2,3,8,0.62)');
    v.fillStyle = vig; v.fillRect(0, 0, W, H);
  }
  function night(t) {
    const g = octx;
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.drawImage(sky, 0, 0);
    // a breath of warmth behind the playhead, as strong as the music is loud
    const loud = (D.lanes.all[Math.min(D.lanes.all.length - 1, Math.max(0, Math.round(t * D.laneHz)))] || 0) / 255;
    g.globalCompositeOperation = 'lighter';
    light(g, xOf(t), (SY0 + SY1) / 2, 640, [255, 150, 60], 0.1 + 0.16 * loud);
    g.globalCompositeOperation = 'source-over';
  }

  function motes(t) {
    for (let i = 0; i < 90; i++) {
      const depth = 0.25 + rnd(i * 7 + 1) * 0.75;
      const x = ((rnd(i * 7 + 2) * (W + 200) - cam * 26 * depth - t * (2 + 5 * rnd(i * 7 + 3))) % (W + 200) + (W + 200)) % (W + 200) - 100;
      const y = 40 + rnd(i * 7 + 4) * (H - 80) + Math.sin(t * (0.1 + 0.2 * rnd(i * 7 + 5)) + i) * 14;
      const tw = 0.5 + 0.5 * Math.sin(t * (0.4 + rnd(i * 7 + 6)) + i * 1.7);
      light(ctx, x, y, 2 + 5 * depth, i % 5 === 0 ? C.pulse : C.gold, (0.04 + 0.1 * tw) * depth);
    }
  }

  function grid(t) {
    const g = ctx;
    const firstBar = Math.max(0, Math.floor((cam - 0.5) / D.bar));
    for (let b = firstBar; b * D.bar < cam + WIN + 0.5; b++) {
      const x = xOf(b * D.bar);
      if (b * D.bar > D.total + 0.01) break;
      g.fillStyle = rgba(C.faint, b % 2 === 0 ? 0.075 : 0.045);
      g.fillRect(x - 0.5, SY0, 1, LY1 - SY0);
      g.font = `300 11px ${MONO}`; g.fillStyle = rgba(C.dim, b * D.bar <= t ? 0.85 : 0.45); g.textAlign = 'left';
      g.fillText(String(b + 1).padStart(2, '0'), x + 6, SY1 + 15);
      for (let q = 1; q < 4; q++) { g.fillStyle = rgba(C.faint, 0.05); g.fillRect(xOf(b * D.bar + q * D.beat) - 0.5, SY1 - 4, 1, 8); }
    }
    // the chords along the way: the ones to come stay in sight
    D.chords.forEach((c, i) => {
      const x = xOf(c.t0);
      if (x < SX0 - 220 || x > SX1 + 40) return;
      const past = c.t0 <= t;
      const flash = past ? Math.exp(-(t - c.t0) / 0.7) : 0;
      const beam = g.createLinearGradient(0, SY0, 0, SY1);
      beam.addColorStop(0, rgba(C.gold, 0)); beam.addColorStop(0.5, rgba(C.gold, 0.07 + 0.3 * flash)); beam.addColorStop(1, rgba(C.gold, 0));
      g.fillStyle = beam; g.fillRect(x - 1 - 3 * flash, SY0, 2 + 6 * flash, SY1 - SY0);
      g.font = `400 15px ${SANS}`; g.textAlign = 'left';
      g.fillStyle = rgba(past ? C.gold : C.dim, i === chordAt(t) ? 0.95 : past ? 0.5 : 0.62);
      g.fillText(c.name, x + 8, SY0 + 16);
    });
  }

  // ------------------------------------------------------------------------------------------------- the voices
  function guides(t) {
    const g = ctx;
    const px = xOf(t);
    for (const v of VOICES) {
      g.beginPath();
      let started = false;
      for (const [time, key] of v.pts) {
        if (time < cam - 1 || time > cam + WIN + 1) { if (started && time > cam + WIN + 1) break; continue; }
        const x = xOf(time); const y = yOf(key);
        if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
      }
      if (!started) continue;
      g.lineCap = 'round'; g.lineJoin = 'round';
      // what is to come: a thread; what has been: the thread a little warmer under the light that was laid on it
      g.save(); g.beginPath(); g.rect(px, 0, W - px, H); g.clip();
      strokeGuide(g, v, v.melody ? 0.3 : 0.24, 1.1);
      g.restore();
      g.save(); g.beginPath(); g.rect(0, 0, px, H); g.clip();
      g.globalCompositeOperation = 'lighter'; strokeGuide(g, v, 0.5, 1.5); g.globalCompositeOperation = 'source-over';
      g.restore();
    }
  }
  function strokeGuide(g, v, alpha, width) {
    g.beginPath();
    let started = false;
    for (const [time, key] of v.pts) {
      if (time < cam - 1) continue;
      if (time > cam + WIN + 1) break;
      const x = xOf(time); const y = yOf(key);
      if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
    }
    g.strokeStyle = rgba(v.melody ? C.strike : C.gold, alpha); g.lineWidth = width; g.stroke();
  }

  /** A colour that changes along a note: stops every fifth of a second from what the synth reported. */
  function along(g, n, f1, t, colour) {
    const xA = xOf(n.t0); const xB = xOf(n.t0 + f1 / FPS);
    if (xB - xA < 0.5) return null;
    const grad = g.createLinearGradient(xA, 0, xB, 0);
    const stops = Math.max(1, Math.ceil(f1 / 10));
    for (let i = 0; i <= stops; i++) {
      const f = (f1 * i) / stops;
      grad.addColorStop(i / stops, colour(f, 1));
    }
    return grad;
  }

  /** A note, whole: its sub, its body and its strike, frame by frame as the synth reported them. */
  function note(n) {
    const g = ctx;
    const t = Infinity;
    const f1 = n.frames - 1;
    if (f1 <= 0) return;
    // the note's line, frame by frame: where it is (pressure brings vibrato) and how much of each layer there is
    const xs = []; const ys = []; const fs = [];
    const first = 0;
    for (let f = first; ; f += 1) {
      const ff = Math.min(f, f1);
      xs.push(xOf(n.t0 + ff / FPS)); ys.push(n.y - row(n.vib, ff) * VIB); fs.push(ff);
      if (ff >= f1) break;
    }
    const count = xs.length;
    if (count < 2) return;
    const ribbon = (value, base, scale, power, dy) => {
      g.beginPath();
      for (let i = 0; i < count; i++) { const w = base + scale * Math.pow(Math.max(0, row(value, fs[i])), power); if (i) g.lineTo(xs[i], ys[i] + dy - w); else g.moveTo(xs[i], ys[i] + dy - w); }
      for (let i = count - 1; i >= 0; i--) { const w = base + scale * Math.pow(Math.max(0, row(value, fs[i])), power); g.lineTo(xs[i], ys[i] + dy + w); }
      g.closePath();
    };
    g.globalCompositeOperation = 'lighter';

    // sub: a low ember under the line
    let grad = along(g, n, f1, t, (f, a) => rgba(C.sub, 0.22 * Math.pow(row(n.sub, f), 0.6) * a));
    if (grad) { ribbon(n.sub, 0.5, 6, 0.8, 9); g.fillStyle = grad; g.fill(); }

    // body: seven strands (the seven saws), each beating at its own rate, spreading and whitening as the body opens
    const open = (f) => clamp(row(n.cut, f) / 7.5);
    const tone = (f) => { const o = open(f); return o < 0.5 ? mix(C.amber, C.gold, o * 2) : mix(C.gold, C.white, o * 2 - 1); };
    grad = along(g, n, f1, t, (f, a) => rgba(tone(f), (0.06 + 0.5 * Math.pow(row(n.body, f), 0.7)) * a * (row(n.body, f) > 0.004 ? 1 : 0)));
    if (grad) { ribbon(n.body, 0.3, 3.6, 0.62, 0); g.fillStyle = grad; g.fill(); }
    const strands = along(g, n, f1, t, (f, a) => rgba(tone(f), Math.pow(row(n.body, f), 0.5) * (0.16 + 0.34 * row(n.pos, f)) * a));
    if (strands) {
      g.strokeStyle = strands; g.lineWidth = 0.9; g.lineJoin = 'round';
      for (let j = 0; j < 7; j++) {
        if (j === 3) continue;
        const side = j - 3;
        g.beginPath();
        for (let i = 0; i < count; i++) {
          const f = fs[i];
          const body = row(n.body, f);
          const spread = (0.9 + 5.4 * row(n.pos, f)) * (0.3 + 0.7 * Math.sqrt(body));
          const y = ys[i] + side * spread + Math.sin(TAU * n.beat[j] * (f / FPS) + j * 1.3) * (0.4 + 0.9 * Math.sqrt(body));
          if (i) g.lineTo(xs[i], y); else g.moveTo(xs[i], y);
        }
        g.globalAlpha = 1 - Math.abs(side) * 0.17;
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // strike: a comet that is brightest where the string was plucked
    grad = along(g, n, Math.min(f1, 80), t, (f, a) => rgba(C.strike, Math.min(0.9, row(n.strike, f) * 1.5) * a));
    if (grad && first < 80) {
      const keep = fs.findIndex((f) => f > 80);
      const upTo = keep < 0 ? count : keep;
      g.beginPath();
      for (let i = 0; i < upTo; i++) { const w = 0.3 + 4.6 * Math.pow(row(n.strike, fs[i]), 0.8); if (i) g.lineTo(xs[i], ys[i] - w); else g.moveTo(xs[i], ys[i] - w); }
      for (let i = upTo - 1; i >= 0; i--) { const w = 0.3 + 4.6 * Math.pow(row(n.strike, fs[i]), 0.8); g.lineTo(xs[i], ys[i] + w); }
      g.closePath(); g.fillStyle = grad; g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  const beadAt = (n, s) => Math.max(n.t0, s * D.step) + D.step * 0.3;
  const beadY = (n, time, pan) => n.y - row(n.vib, (time - n.t0) * FPS) * VIB + pan * 5;
  const beadSize = (level) => 1 + 3.3 * Math.pow(level, 0.75);
  /**
   * The pulse: one bead per sixteenth the layer sounded, as large as it was loud, standing where it stood in the
   * stereo field. `played` = as they are once the playhead has passed; otherwise as they wait: the rhythm can be read ahead.
   */
  function beads(n, played) {
    const g = ctx;
    for (const [s, level, pan, tw] of n.beads) {
      const time = beadAt(n, s);
      const x = xOf(time); const y = beadY(n, time, pan);
      const colour = mix(C.pulse, C.pulseHi, tw);
      if (!played) {
        g.fillStyle = rgba(colour, 0.05 + 0.2 * level);
        g.beginPath(); g.arc(x, y, 0.7 + 1.1 * level, 0, TAU); g.fill();
        continue;
      }
      const a = 0.3 + 0.7 * level;
      g.globalCompositeOperation = 'lighter';
      light(g, x, y, beadSize(level) * 3.8, colour, a * 0.55);
      // (the bead itself is laid over the line, not added to it: on gold, added ice would turn white)
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = rgba(mix(colour, [255, 255, 255], 0.05), Math.min(1, a * 1.25));
      g.beginPath(); g.arc(x, y, beadSize(level), 0, TAU); g.fill();
    }
  }
  /** A bead as the playhead reaches it: it swells, flashes, and on an accent throws a few sparks. */
  function beadsNow(n, t) {
    const g = ctx;
    if (t < n.t0 || t > n.t1 + 0.5) return;
    g.globalCompositeOperation = 'lighter';
    for (const [s, level, pan, tw] of n.beads) {
      const time = beadAt(n, s);
      const since = t - time;
      if (since < 0 || since > 0.45) continue;
      const x = xOf(time); const y = beadY(n, time, pan);
      const colour = mix(C.pulse, C.pulseHi, tw);
      const pop = Math.exp(-since / 0.08);
      const a = 0.3 + 0.7 * level;
      light(g, x, y, beadSize(level) * 3.8 * (1 + 1.3 * pop), colour, a * 0.9 * pop);
      g.fillStyle = rgba(mix(colour, [255, 255, 255], 0.6), a * pop);
      g.beginPath(); g.arc(x, y, beadSize(level) * (1 + 1.3 * pop), 0, TAU); g.fill();
      if (level > 0.45) {
        for (let k = 0; k < 3; k++) {
          const seed = n.id * 4099 + s * 31 + k;
          const ang = TAU * rnd(seed);
          const far = (10 + 26 * rnd(seed + 1)) * (1 - Math.exp(-since * 7)) * level;
          light(g, x + Math.cos(ang) * far, y + Math.sin(ang) * far * 0.8, 3.2, colour, 0.75 * Math.pow(1 - since / 0.45, 2));
        }
      }
    }
    g.globalCompositeOperation = 'source-over';
  }

  const starPath = (g, x, y, size) => {
    g.beginPath();
    g.moveTo(x, y - size); g.quadraticCurveTo(x, y, x + size * 0.62, y); g.quadraticCurveTo(x, y, x, y + size);
    g.quadraticCurveTo(x, y, x - size * 0.62, y); g.quadraticCurveTo(x, y, x, y - size);
  };
  /** Where a string is plucked: a small star and the note's name once it has been, a ring while it waits. */
  function strike(n, played) {
    const g = ctx;
    const x = xOf(n.start); const y = n.y;
    const power = Math.sqrt(n.strikePeak);
    g.globalCompositeOperation = 'lighter';
    if (!played) {
      g.strokeStyle = rgba(C.gold, 0.3); g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, 3.2, 0, TAU); g.stroke();
      g.globalCompositeOperation = 'source-over';
      return;
    }
    light(g, x, y, 10 + 10 * power, C.gold, 0.14);
    g.fillStyle = rgba(C.strike, 0.55);
    starPath(g, x, y, 4.5 + 7.5 * power); g.fill();
    g.globalCompositeOperation = 'source-over';
    g.font = `400 11.5px ${MONO}`; g.textAlign = 'right';
    g.fillStyle = rgba(n.role === 'melody' ? C.strike : C.gold, 0.5);
    g.fillText(n.name, x - 11, y - 7);
  }
  /** The strike as it happens, and the air around it: a flash, a ring that leaves, sparks, and dust lifted by the breath of noise. */
  function strikeNow(n, t) {
    const g = ctx;
    const since = t - n.start;
    if (since < 0 || since > 2.3) return;
    const x = xOf(n.start); const y = n.y;
    const power = Math.sqrt(n.strikePeak);
    const flash = Math.exp(-since / 0.16);
    g.globalCompositeOperation = 'lighter';
    light(g, x, y, (13 + 34 * power) * (0.45 + 0.55 * flash), C.strike, 0.75 * flash * power);
    light(g, x, y, 10 + 10 * power, C.gold, 0.34 * flash);
    if (since < 0.9) {
      g.strokeStyle = rgba(C.strike, 0.55 * Math.pow(1 - since / 0.9, 2) * power); g.lineWidth = 1.2;
      g.beginPath(); g.arc(x, y, 5 + 46 * easeOut(since / 0.9) * power, 0, TAU); g.stroke();
    }
    g.fillStyle = rgba(C.strike, 0.45 * flash);
    starPath(g, x, y, (4.5 + 7.5 * power) * (1 + 0.9 * flash)); g.fill();
    if (since < 1.3) {
      const sparks = 7 + Math.round(15 * power);
      for (let k = 0; k < sparks; k++) {
        const seed = n.id * 977 + k * 13;
        const life = 0.55 + 0.75 * rnd(seed + 2);
        if (since > life) continue;
        const ang = TAU * rnd(seed) + n.strikePan * 0.5;
        const reach = (26 + 96 * rnd(seed + 1)) * power * (1 - Math.exp(-since * 3.2));
        const sx = x + Math.cos(ang) * reach; const sy = y + Math.sin(ang) * reach * 0.72;
        const a = Math.pow(1 - since / life, 1.6);
        g.strokeStyle = rgba(k % 3 ? C.strike : C.gold, 0.8 * a); g.lineWidth = 1.1;
        g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx - Math.cos(ang) * 7 * a, sy - Math.sin(ang) * 5 * a); g.stroke();
        light(g, sx, sy, 4, C.strike, 0.5 * a);
      }
    }
    if (n.airPeak > 0.02) {
      const dust = 6 + Math.round(22 * Math.sqrt(n.airPeak));
      for (let k = 0; k < dust; k++) {
        const seed = n.id * 631 + k * 17 + 5;
        const life = 1 + 1.2 * rnd(seed);
        if (since > life) continue;
        const dx = (rnd(seed + 1) - 0.25) * 70 * (1 - Math.exp(-since * 1.6));
        const dy = -(6 + 30 * rnd(seed + 2)) * since + Math.sin(since * 3 + k) * 3 + (rnd(seed + 3) - 0.5) * 16;
        light(g, x + dx, y + dy, 2.2 + 1.4 * rnd(seed + 4), C.air, 0.55 * Math.sqrt(n.airPeak) * Math.pow(1 - since / life, 1.5));
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.font = `400 11.5px ${MONO}`; g.textAlign = 'right';
    g.fillStyle = rgba(n.role === 'melody' ? C.strike : C.gold, 0.5 * flash);
    g.fillText(n.name, x - 11, y - 7);
  }

  function playhead(t) {
    const g = ctx;
    const x = xOf(t);
    g.globalCompositeOperation = 'lighter';
    const halo = g.createLinearGradient(x - 30, 0, x + 30, 0);
    halo.addColorStop(0, 'rgba(255,200,120,0)'); halo.addColorStop(0.5, 'rgba(255,200,120,0.085)'); halo.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = halo; g.fillRect(x - 30, SY0 - 8, 60, LY1 - SY0 + 16);
    const core = g.createLinearGradient(0, SY0 - 14, 0, LY1 + 10);
    core.addColorStop(0, 'rgba(255,238,200,0)'); core.addColorStop(0.06, 'rgba(255,238,200,0.8)'); core.addColorStop(0.94, 'rgba(255,238,200,0.8)'); core.addColorStop(1, 'rgba(255,238,200,0)');
    g.fillStyle = core; g.fillRect(x - 0.75, SY0 - 14, 1.5, LY1 - SY0 + 24);
    // where it meets a sounding note, the note shows what it is made of right now
    for (const n of NOTES) {
      if (t < n.t0 || t > n.t1) continue;
      const f = (t - n.t0) * FPS;
      const amp = row(n.amp, f);
      if (amp < 0.004) continue;
      const y = n.y - row(n.vib, f) * VIB;
      const s = row(n.strike, f); const b = row(n.body, f); const p = row(n.pulse, f);
      light(g, x, y, 8 + 15 * Math.sqrt(b), C.gold, 0.2 + 0.5 * Math.sqrt(b));
      light(g, x, y, 7 + 15 * Math.sqrt(s), C.strike, Math.min(0.8, s * 1.2));
      light(g, x, y - 1, 6 + 15 * Math.sqrt(p), C.pulse, Math.min(0.9, p * 1.4));
      g.fillStyle = rgba(C.strike, 0.5 + 0.5 * Math.sqrt(amp));
      g.beginPath(); g.arc(x, y, 1.6 + 2.4 * Math.sqrt(amp), 0, TAU); g.fill();
    }
    // a voice on its way to its next note: a glint that travels the curve
    for (const v of VOICES) {
      const key = guideKey(v.pts, t);
      if (key === null) continue;
      const settled = v.list.some((n) => n.start <= t && Math.abs(n.key - key) < 0.02);
      if (settled) continue;
      const y = yOf(key);
      light(g, x, y, 16, C.strike, 0.8);
      g.strokeStyle = rgba(C.strike, 0.9); g.lineWidth = 1.2;
      g.beginPath(); g.arc(x, y, 4, 0, TAU); g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
  }

  /** On an accent of the drawn rhythm, a faint column of ice between the lowest and the highest sounding note. */
  function accents(t) {
    const g = ctx;
    const s0 = Math.floor(t / D.step);
    g.globalCompositeOperation = 'lighter';
    for (let s = s0; s > s0 - 4 && s >= 0; s--) {
      if (!ACCENT[s % 16]) continue;
      const time = s * D.step + D.step * 0.3;
      const since = t - time;
      if (since < 0 || since > 0.4) continue;
      let lo = Infinity; let hi = -Infinity; let power = 0;
      for (const n of NOTES) {
        const bead = n.beads.find((b) => b[0] === s);
        if (!bead) continue;
        lo = Math.min(lo, n.y); hi = Math.max(hi, n.y); power = Math.max(power, bead[1]);
      }
      if (!(power > 0.15)) continue;
      const x = xOf(time);
      const a = 0.28 * power * Math.pow(1 - since / 0.4, 2);
      const col = g.createLinearGradient(0, lo - 30, 0, hi + 30);
      col.addColorStop(0, rgba(C.pulse, 0)); col.addColorStop(0.2, rgba(C.pulse, a)); col.addColorStop(0.8, rgba(C.pulse, a)); col.addColorStop(1, rgba(C.pulse, 0));
      g.fillStyle = col; g.fillRect(x - 1.5, lo - 30, 3, hi - lo + 60);
    }
    g.globalCompositeOperation = 'source-over';
  }

  // -------------------------------------------------------------------------------------------- one lane per layer
  /** Every lane, whole: bright (played) or as a shadow of what is to come. */
  function laneShapes(played) {
    const g = ctx;
    const hzL = D.laneHz;
    LAYERS.forEach(([id, _label, colour], k) => {
      const data = D.lanes[id];
      const mid = LY0 + k * (LH + LGAP) + LH / 2;
      g.beginPath();
      for (let i = 0; i < data.length; i++) { const x = xOf(i / hzL); const h = (data[i] / 255) * (LH / 2) + 0.4; if (i) g.lineTo(x, mid - h); else g.moveTo(x, mid - h); }
      for (let i = data.length - 1; i >= 0; i--) g.lineTo(xOf(i / hzL), mid + (data[i] / 255) * (LH / 2) + 0.4);
      g.closePath();
      g.fillStyle = rgba(colour, played ? 0.78 : 0.2); g.fill();
    });
  }
  /** What every layer is doing at the playhead. */
  function lanesNow(t) {
    const g = ctx;
    const px = xOf(t);
    LAYERS.forEach(([id, _label, colour], k) => {
      const data = D.lanes[id];
      const mid = LY0 + k * (LH + LGAP) + LH / 2;
      g.fillStyle = rgba(C.faint, 0.07); g.fillRect(SX0, mid - 0.5, SW, 1);
      const now = (data[Math.min(data.length - 1, Math.max(0, Math.round(t * D.laneHz)))] || 0) / 255;
      g.globalCompositeOperation = 'lighter';
      light(g, px, mid, 4 + 12 * now, colour, 0.2 + 0.6 * now);
      g.globalCompositeOperation = 'source-over';
    });
  }
  function laneLabels(t) {
    const g = ctx;
    LAYERS.forEach(([id, label, colour], k) => {
      const mid = LY0 + k * (LH + LGAP) + LH / 2;
      const data = D.lanes[id];
      const now = (data[Math.min(data.length - 1, Math.max(0, Math.round(t * D.laneHz)))] || 0) / 255;
      g.font = `400 10.5px ${MONO}`; g.fillStyle = rgba(colour, 0.5 + 0.5 * now);
      spaced(g, label, SX0 - 28, mid + 3.8, 2.2, 'right');
      g.globalCompositeOperation = 'lighter';
      light(g, SX0 - 15, mid, 4 + 9 * now, colour, 0.35 + 0.65 * now);
      g.globalCompositeOperation = 'source-over';
    });
  }

  // ------------------------------------------------------------------------------------------------ the keyboard
  const isBlack = (key) => [1, 3, 6, 8, 10].includes(((key % 12) + 12) % 12);
  const WHITES = []; for (let k = KEY_FIRST; k <= KEY_LAST; k++) if (!isBlack(k)) WHITES.push(k);
  const KW = 44; const KX0 = (W - WHITES.length * KW) / 2; const BW = 26; const BH = 62;
  const keyRect = (key) => {
    if (!isBlack(key)) return { x: KX0 + WHITES.indexOf(key) * KW, y: KY0, w: KW, h: KH, black: false };
    return { x: KX0 + (WHITES.indexOf(key - 1) + 1) * KW - BW / 2, y: KY0, w: BW, h: BH, black: true };
  };
  function keyboardBase(g) {
    for (const key of WHITES) {
      const r = keyRect(key);
      const body = g.createLinearGradient(0, r.y, 0, r.y + r.h);
      body.addColorStop(0, '#141a2e'); body.addColorStop(1, '#1d2540');
      g.fillStyle = body; g.fillRect(r.x + 1, r.y, r.w - 2, r.h);
      g.fillStyle = 'rgba(200,212,255,0.10)'; g.fillRect(r.x + 1, r.y + r.h - 1, r.w - 2, 1);
      if (key % 12 === 0) { g.font = `300 10px ${MONO}`; g.textAlign = 'center'; g.fillStyle = rgba(C.dim, 0.7); g.fillText(`C${key / 12 - 1}`, r.x + r.w / 2, r.y + r.h + 22); }
    }
    for (let key = KEY_FIRST; key <= KEY_LAST; key++) {
      if (!isBlack(key)) continue;
      const r = keyRect(key);
      g.fillStyle = '#04060c'; g.fillRect(r.x, r.y, r.w, r.h);
    }
  }
  function keyboardLight(t) {
    const g = ctx;
    const lightKey = (key, colour, a, part) => {
      if (key < KEY_FIRST || key > KEY_LAST || a <= 0.004) return;
      const r = keyRect(key);
      const y0 = part === 'tip' ? r.y + r.h - 9 : r.y;
      const h = part === 'tip' ? 9 : r.h;
      const fill = g.createLinearGradient(0, r.y, 0, r.y + r.h);
      fill.addColorStop(0, rgba(colour, part === 'tip' ? a : a * 0.25)); fill.addColorStop(1, rgba(colour, a));
      g.fillStyle = fill; g.fillRect(r.x + 1, y0, r.w - 2, h);
    };
    g.globalCompositeOperation = 'lighter';
    const names = [];
    for (const n of NOTES) {
      if (t < n.t0 || t > n.t1) continue;
      const f = (t - n.t0) * FPS;
      const amp = row(n.amp, f);
      if (amp < 0.004) continue;
      const held = t < n.end ? 1 : 0.3;
      lightKey(n.key, C.amber, ((0.14 + 0.5 * Math.pow(row(n.body, f), 0.6)) + 0.1 * Math.sqrt(amp)) * held, 'key');
      lightKey(n.key, C.strike, Math.min(0.85, row(n.strike, f) * 1.2), 'key');
      lightKey(n.key, C.pulse, Math.min(1, row(n.pulse, f) * 1.6) * (held === 1 ? 1 : 0.5), 'tip');
      const r = keyRect(n.key);
      light(g, r.x + r.w / 2, r.y + r.h - 6, 22 + 26 * Math.sqrt(row(n.strike, f)), C.gold, 0.26 * Math.sqrt(amp) * held);
      // the sub sounds an octave below: an ember under that key
      if (n.key - 12 >= KEY_FIRST) {
        const low = keyRect(n.key - 12);
        const ember = 0.9 * Math.pow(row(n.sub, f), 0.6) * held;
        if (ember > 0.01) { g.fillStyle = rgba(C.sub, ember); g.fillRect(low.x + low.w / 2 - 9, KY0 + KH + 5, 18, 2.5); }
      }
      if (t < n.end) names.push(n);
    }
    g.globalCompositeOperation = 'source-over';
    for (const n of names) {
      const r = keyRect(n.key);
      g.font = `400 11px ${MONO}`; g.textAlign = 'center'; g.fillStyle = rgba(r.black ? C.ink : C.night0, 0.95);
      if (r.black) g.fillText(n.name, r.x + r.w / 2, r.y - 7); else g.fillText(n.name, r.x + r.w / 2, r.y + r.h - 16);
    }
  }

  // ----------------------------------------------------------------------------------------------------- the words
  function title(t) {
    const g = ctx;
    const ci = chordAt(t);
    const chord = D.chords[ci];
    const since = t - chord.t0;
    const inn = ci === 0 ? 1 : easeOut((since - 0.16) / 0.7);
    g.textBaseline = 'alphabetic';
    g.font = `500 12.5px ${SANS}`; g.fillStyle = rgba(C.amber, 0.9);
    const w = spaced(g, D.title.toUpperCase(), SX0, 60, 5.2);
    g.font = `400 12.5px ${SANS}`; g.fillStyle = rgba(C.dim, 0.95);
    spaced(g, 'GGS SYNTH  ·  ONE PRESET, FIVE LAYERS  ·  ' + D.key.toUpperCase(), SX0 + w + 22, 60, 2.6);

    // the chord that left
    if (ci > 0 && since < 0.26) {
      const prev = D.chords[ci - 1];
      const u = ease(since / 0.26);
      g.font = `300 100px ${SANS}`; g.textAlign = 'left';
      g.fillStyle = rgba(C.ink, 0.9 * (1 - u) * (1 - u));
      g.fillText(prev.name, SX0 - 4, 164 - 34 * u);
    }
    // the chord that is here: it rises into place with a little light behind it
    g.font = `300 100px ${SANS}`; g.textAlign = 'left';
    const flare = ci === 0 ? 0 : Math.exp(-since / 0.6);
    const nameW = g.measureText(chord.name).width;
    g.globalCompositeOperation = 'lighter';
    light(g, SX0 + nameW / 2, 128, 240, C.gold, 0.22 * flare);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rgba(mix(C.ink, C.white, flare), inn);
    g.fillText(chord.name, SX0 - 4, 164 + 30 * (1 - inn));
    g.font = `300 30px ${SANS}`; g.fillStyle = rgba(C.amber, 0.9 * inn);
    g.fillText(chord.title || chord.numeral, SX0 + nameW + 22, 164 + 30 * (1 - inn));

    // its notes, voice by voice: held, or moved by so many semitones
    let x = SX0;
    chord.voices.forEach((v, i) => {
      if (!v) return;
      const u = easeOut((since - 0.2 - 0.07 * i) / 0.5);
      const a = ci === 0 ? 1 : u;
      g.font = `400 15px ${MONO}`; g.textAlign = 'left';
      g.fillStyle = rgba(C.ink, 0.92 * a);
      g.fillText(v.name, x, 204);
      const nw = g.measureText(v.name).width;
      let mark = ''; let colour = C.dim;
      if (v.from === null) { mark = ci > 1 ? 'new' : ''; colour = C.pulse; }
      else if (v.from === v.key) { mark = 'held'; colour = C.amber; }
      else { mark = `${v.key > v.from ? '↑' : '↓'}${Math.abs(v.key - v.from)}`; colour = C.pulseHi; }
      g.font = `300 12px ${MONO}`; g.fillStyle = rgba(colour, 0.9 * a);
      g.fillText(mark, x + nw + 7, 204);
      x += nw + 7 + g.measureText(mark).width + 30;
    });
    const next = D.chords[ci + 1];
    if (next) {
      g.font = `300 12px ${MONO}`; g.fillStyle = rgba(C.dim, 0.85);
      const lead = clamp((next.t0 - t) / (next.t0 - chord.t0));
      g.fillText(`next  ${next.name}`, x + 18, 204);
      const nx = x + 18 + g.measureText(`next  ${next.name}`).width + 12;
      g.fillStyle = rgba(C.faint, 0.12); g.fillRect(nx, 198, 70, 2);
      g.fillStyle = rgba(C.amber, 0.8); g.fillRect(nx, 198, 70 * (1 - lead), 2);
    }
  }

  /** The four macros and the touch, top right: what is turned up while this is playing. */
  function dials(t) {
    const g = ctx;
    const si = sectionAt(t);
    const section = D.sections[si];
    const prev = D.sections[Math.max(0, si - 1)];
    const u = si === 0 ? 1 : ease((t - section.t0) / 0.9);
    g.textBaseline = 'alphabetic';
    g.font = `400 12.5px ${SANS}`; g.fillStyle = rgba(C.dim, 0.95);
    const label = `${String(si + 1).padStart(2, '0')}  ·  ${section.label.toUpperCase()}`;
    spaced(g, label, SX1, 60, 2.6, 'right');
    // pressure and slide of the notes that sound now
    let press = 0; let slide = 0;
    for (const n of NOTES) {
      if (t < n.t0 || t > n.end) continue;
      press = Math.max(press, row(n.press, (t - n.t0) * FPS));
      slide = Math.max(slide, row(n.slide, (t - n.t0) * FPS));
    }
    const items = [
      ...D.macros.map((name, i) => [name, lerp(prev.macros[i], section.macros[i], u), C.gold]),
      ['Pressure', press, C.pulseHi], ['Slide', slide, C.pulseHi]
    ];
    const R = 22; const gap = 92;
    items.forEach(([name, value, colour], i) => {
      const cx = SX1 - R - (items.length - 1 - i) * gap; const cy = 118;
      g.lineCap = 'round';
      g.strokeStyle = rgba(C.faint, 0.14); g.lineWidth = 2.5;
      g.beginPath(); g.arc(cx, cy, R, Math.PI * 0.75, Math.PI * 2.25); g.stroke();
      if (value > 0.004) {
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = rgba(colour, 0.95); g.lineWidth = 2.5;
        g.beginPath(); g.arc(cx, cy, R, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * clamp(value))); g.stroke();
        const a = Math.PI * (0.75 + 1.5 * clamp(value));
        light(g, cx + Math.cos(a) * R, cy + Math.sin(a) * R, 9, colour, 0.9);
        g.globalCompositeOperation = 'source-over';
      }
      g.font = `300 12px ${MONO}`; g.textAlign = 'center'; g.fillStyle = rgba(C.ink, value > 0.004 ? 0.95 : 0.4);
      g.fillText(Math.round(value * 100), cx, cy + 4.5);
      g.font = `400 11px ${SANS}`; g.fillStyle = rgba(value > 0.004 ? colour : C.dim, 0.9);
      spaced(g, name.toUpperCase(), cx, cy + R + 22, 1.6, 'center');
    });
  }

  function clock(t) {
    const g = ctx;
    const tt = clamp(t, 0, D.total);
    const beats = tt / D.beat;
    g.font = `300 12px ${MONO}`; g.fillStyle = rgba(C.dim, 0.95); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(`BAR ${String(Math.floor(beats / 4) + 1).padStart(2, '0')}  ·  BEAT ${Math.floor(beats % 4) + 1}  ·  ${D.bpm} BPM`, SX0, H - 18);
    g.textAlign = 'right';
    const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    g.fillText(`${mm(tt)} / ${mm(D.total)}`, SX1, H - 18);
    // the whole piece as one thin line, and where we are on it
    g.fillStyle = rgba(C.faint, 0.1); g.fillRect(SX0, H - 40, SW, 1);
    g.fillStyle = rgba(C.amber, 0.85); g.fillRect(SX0, H - 40.5, SW * (tt / D.total), 2);
    for (const c of D.chords) { g.fillStyle = rgba(C.gold, c.t0 <= tt ? 0.9 : 0.35); g.fillRect(SX0 + SW * (c.t0 / D.total) - 0.5, H - 44, 1, 9); }
  }

  // ------------------------------------------------------------------------------------------ the score, painted once
  const PAD = 1; // seconds of room before and after the piece
  const WY0 = SY0 - 44; const WH = SY1 - SY0 + 80; const LANE_Y0 = LY0 - 6; const LANE_H = LY1 - LY0 + 12;
  const WIDE = Math.ceil((D.total + 2 * PAD) * PXS);
  const played = make(WIDE, WH); const ahead = make(WIDE, WH);
  const lanesPlayed = make(WIDE, LANE_H); const lanesAhead = make(WIDE, LANE_H);
  const keys = make(W, H);
  function paintScore() {
    const on = (canvas, y0, paint) => {
      const g = canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); g.translate(0, -y0);
      g.textBaseline = 'alphabetic';
      ctx = g; paint(); ctx = litCtx;
    };
    cam = -PAD; ox = 0; // the whole piece, from a second before it
    on(played, WY0, () => { for (const n of NOTES) note(n); for (const n of NOTES) beads(n, true); for (const n of NOTES) strike(n, true); });
    on(ahead, WY0, () => { for (const n of NOTES) beads(n, false); for (const n of NOTES) strike(n, false); });
    on(lanesPlayed, LANE_Y0, () => laneShapes(true));
    on(lanesAhead, LANE_Y0, () => laneShapes(false));
    ox = SX0;
    const k = keys.getContext('2d'); k.clearRect(0, 0, W, H); keyboardBase(k);
    paintNight();
  }
  /** Uncover a painted strip between two screen positions. */
  function uncover(canvas, y0, from, to) {
    const shift = SX0 - (cam + PAD) * PXS; // where the strip's left edge is on screen
    const a = Math.max(from, shift, 0); const b = Math.min(to, shift + canvas.width, W);
    if (b - a < 0.5) return;
    ctx.drawImage(canvas, a - shift, 0, b - a, canvas.height, a, y0, b - a, canvas.height);
  }

  // ------------------------------------------------------------------------------------------------------ one frame
  function draw(time) {
    const t = clamp(time, 0, D.total);
    cam = (t / D.total) * (D.total - WIN);
    night(t);
    octx.drawImage(keys, 0, 0);
    ctx = litCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    const px = xOf(t);
    // what has been played, and what is to come
    uncover(played, WY0, 0, px); uncover(lanesPlayed, LANE_Y0, 0, px);
    // (what was played a while ago stays, dimmer)
    ctx.globalCompositeOperation = 'destination-out';
    const old = ctx.createLinearGradient(px - 1150, 0, px - 40, 0);
    old.addColorStop(0, 'rgba(0,0,0,0.5)'); old.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = old; ctx.fillRect(0, WY0, px, LANE_Y0 + LANE_H - WY0);
    ctx.globalCompositeOperation = 'source-over';
    uncover(ahead, WY0, px, W); uncover(lanesAhead, LANE_Y0, px, W);

    grid(t);
    guides(t);
    accents(t);
    for (const n of NOTES) beadsNow(n, t);
    for (const n of NOTES) strikeNow(n, t);
    lanesNow(t);
    playhead(t);
    // the score fades at its edges instead of ending
    ctx.globalCompositeOperation = 'destination-out';
    const left = ctx.createLinearGradient(SX0 - 70, 0, SX0 + 26, 0);
    left.addColorStop(0, 'rgba(0,0,0,1)'); left.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = left; ctx.fillRect(0, SY0 - 30, SX0 + 26, LY1 - SY0 + 60);
    const right = ctx.createLinearGradient(SX1 - 30, 0, SX1 + 40, 0);
    right.addColorStop(0, 'rgba(0,0,0,0)'); right.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = right; ctx.fillRect(SX1 - 30, SY0 - 30, W - SX1 + 30, LY1 - SY0 + 60);
    ctx.globalCompositeOperation = 'source-over';

    motes(t);
    laneLabels(t);
    keyboardLight(t);
    title(t);
    dials(t);
    clock(t);

    // light, and the same light once more, soft
    octx.globalCompositeOperation = 'lighter';
    octx.drawImage(lit, 0, 0);
    const h = half.getContext('2d'); h.clearRect(0, 0, half.width, half.height); h.drawImage(lit, 0, 0, half.width, half.height);
    const q = quarter.getContext('2d'); q.clearRect(0, 0, quarter.width, quarter.height); q.drawImage(half, 0, 0, quarter.width, quarter.height);
    const e = eighth.getContext('2d'); e.clearRect(0, 0, eighth.width, eighth.height); e.drawImage(quarter, 0, 0, eighth.width, eighth.height);
    // (the wide halo is added to the narrow one while both are small: one soft layer goes back up to full size)
    q.globalCompositeOperation = 'lighter'; q.globalAlpha = 1; q.drawImage(eighth, 0, 0, quarter.width, quarter.height); q.globalCompositeOperation = 'source-over';
    octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'low';
    octx.globalAlpha = 0.36; octx.drawImage(quarter, 0, 0, W, H);
    octx.globalAlpha = 1; octx.globalCompositeOperation = 'source-over';
    // the corners fall away, and the film opens and closes on the dark
    octx.drawImage(veil, 0, 0);
    const dark = Math.max(1 - ease(time / 0.7), ease((time - (D.total - 1.1)) / 1.1) * 0.8);
    if (dark > 0.002) { octx.fillStyle = `rgba(3,4,10,${dark.toFixed(3)})`; octx.fillRect(0, 0, W, H); }
  }

  // ---------------------------------------------------------------------------------------------------- playing it
  const button = document.getElementById('start');
  let actx = null; let buffer = null; let source = null; let startedAt = 0; let playing = false; let raf = 0;
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  const poster = () => { paintScore(); draw(RECORD ? 0 : 1.2); }; // (before Play: the piece a moment in, so there is something to see)

  async function play() {
    button.hidden = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') await actx.resume();
    if (!buffer) {
      const raw = atob(FILM.audio);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      buffer = await actx.decodeAudioData(bytes.buffer);
    }
    source = actx.createBufferSource();
    source.buffer = buffer; source.connect(actx.destination);
    startedAt = actx.currentTime + 0.12;
    source.start(startedAt);
    playing = true;
    cancelAnimationFrame(raf);
    const frame = () => {
      // (what is heard now left the context a little earlier)
      const t = actx.currentTime - startedAt - (actx.outputLatency || 0);
      draw(Math.max(0, t));
      if (t < D.total + 0.2) raf = requestAnimationFrame(frame);
      else { playing = false; button.hidden = false; button.querySelector('span:nth-child(2)').textContent = 'Play again'; }
    };
    raf = requestAnimationFrame(frame);
  }
  function toggle() {
    if (!actx || !playing) return;
    if (actx.state === 'running') actx.suspend(); else actx.resume();
  }

  window.__film = { draw, total: D.total, fps: FPS, ready: fonts.then(() => { paintScore(); }) };
  if (RECORD) document.body.classList.add('record');
  else {
    button.addEventListener('click', () => { play().catch((err) => { button.hidden = false; console.error(err); }); });
    out.addEventListener('click', () => { if (playing) toggle(); else if (button.hidden === false) button.click(); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); if (playing) toggle(); else button.click(); } });
  }
  poster();
  fonts.then(poster);
})();
