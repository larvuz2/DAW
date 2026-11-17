// The audio → visual bible: everything GreanTeaDawy can send to a visual engine (TouchDesigner, Blender, Unreal),
// written for the people who build that side. The prose is here; every table is generated from the live catalogs
// (instruments, effects, GGS Synth params, modulation sources and targets, op types, MCP tools), so the document
// stays true when the code changes. Run: npm run docs:av  (E2E_CHROMIUM=/path/to/chromium to use an installed browser)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  INSTRUMENTS, INSTRUMENT_CATEGORIES, EFFECTS, EFFECT_GROUPS, CHANNEL_AUTOMATION_PARAMS, SPATIAL_PARAMS, PPQ, STEP, TUNING_SYSTEMS, SCALES, MIN_BPM, MAX_BPM,
  AV_USER_LANES, AV_BANDS, AV_SPECTRUM_BANDS, AV_FPS, AV_DB_FLOOR, AV_DB_CEIL
} from '../packages/core/src/index.js';
import {
  GGS_PARAMS, MOD_SOURCES, MOD_TARGETS, MOD_SOURCE_INFO, MOD_TARGET_INFO, BIPOLAR_SOURCES, MOD_SLOTS, MACRO_COUNT, modTargetSpec, ggsDefaults, STUDIO_FX
} from '../packages/synth-dsp/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(root, 'docs', 'av-bible.pdf');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v) => (typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : v === undefined ? '' : String(v));
const table = (head, rows, cls = '') => `<table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const code = (s) => `<pre>${esc(s.trim())}</pre>`;
const HOY = '<span class="b hoy">HOY</span>';
const PUENTE = '<span class="b puente">PUENTE</span>';
const OFF = '<span class="b off">OFFLINE</span>';
const PROX = '<span class="b prox">PRÓXIMO</span>';
const range = (p) => (p.type === 'number' ? `${fmt(p.min)} … ${fmt(p.max)}${p.unit ? ` ${esc(p.unit)}` : ''}${p.curve ? ` <i>(${p.curve})</i>` : ''}` : p.type === 'bool' ? 'on / off' : p.type === 'select' ? esc((p.options || []).map((o) => (typeof o === 'object' ? o.value : o)).join(' · ')) : esc(p.type));

// ---- generated catalogs ------------------------------------------------------------------------------------------

const instrumentKinds = Object.keys(INSTRUMENTS);
const effectTypes = Object.keys(EFFECTS);
const sources = MOD_SOURCES.filter((s) => s !== 'none');
const targets = MOD_TARGETS.filter((t) => t !== 'none');
const defaults = ggsDefaults();
const opTypes = [...new Set([...fs.readFileSync(path.join(root, 'packages/core/src/ops.js'), 'utf8').matchAll(/case '([a-z]+\/[a-zA-Z-]+)'/g)].map((m) => m[1]))].sort();
const mcpTools = (() => {
  const md = fs.readFileSync(path.join(root, 'docs/MCP.md'), 'utf8').split('\n');
  const list = [];
  for (let i = 0; i < md.length; i++) {
    const m = /^### `([a-z_]+)`/.exec(md[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < md.length && !md[j].trim()) j++;
    const first = (md[j] || '').replace(/\*\*/g, '').split(/(?<=\.)\s/)[0].slice(0, 170);
    list.push([m[1], first]);
  }
  return list;
})();

/** GGS params with the repeated blocks folded: osc{A,B,C}…, env{1-4}…, mod{1-64}… one row each. */
function foldedGgs() {
  const rules = [
    [/^osc[ABC]/, (k) => k.replace(/^osc[ABC]/, 'osc{A,B,C}')],
    [/^env\d/, (k) => k.replace(/^env\d/, 'env{1-4}')],
    [/^lfo\dS\d+$/, () => 'lfo{1-4}S{1-16}'],
    [/^lfo\d/, (k) => k.replace(/^lfo\d/, 'lfo{1-4}')],
    [/^chaos\d/, (k) => k.replace(/^chaos\d/, 'chaos{1-2}')],
    [/^f[12][A-Z]/, (k) => k.replace(/^f[12]/, 'f{1,2}')],
    [/^macro\d$/, () => 'macro{1-8}'],
    [/^mod\d+/, (k) => k.replace(/^mod\d+/, 'mod{1-64}')]
  ];
  const seen = new Map();
  for (const p of GGS_PARAMS) {
    const rule = rules.find(([re]) => re.test(p.key));
    const name = rule ? rule[1](p.key) : p.key;
    if (!seen.has(name)) seen.set(name, { ...p, name, count: 1 });
    else seen.get(name).count++;
  }
  return [...seen.values()];
}
const folded = foldedGgs();
// the test fixture's capture (fixtures/av, npm run fixture:av): its real numbers, when it is there
const fixture = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'fixtures/av/capture-summary.json'), 'utf8')); } catch { return null; }
})();
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const telemetryRows = [
  ...MOD_SOURCES.map((s, i) => [i, `<code>${s}</code>`, s === 'none' ? '— (siempre 0)' : BIPOLAR_SOURCES.has(s) ? '−1 … 1' : '0 … 1', s === 'none' ? '' : esc(MOD_SOURCE_INFO[s])]),
  ...MOD_TARGETS.map((t, i) => {
    const spec = t === 'none' ? null : modTargetSpec(t, defaults);
    const unit = spec ? (spec.kind === 'oct' ? `octavas × ${spec.scale} → ${spec.unit || ''}` : spec.kind === 'semi' ? `× ${spec.scale} semitonos` : `× ${spec.scale}${spec.min !== undefined ? ` (${spec.min} … ${spec.max})` : ''}`) : '';
    return [MOD_SOURCES.length + i, `<code>${t}</code>`, t === 'none' ? '— (siempre 0)' : `suma de rutas d · ${esc(unit)}`, t === 'none' ? '' : esc(MOD_TARGET_INFO[t])];
  })
];

// ---- the document ------------------------------------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>GreanTeaDawy — Biblia audio → visual</title>
<style>
  @page { size: A4; margin: 18mm 15mm 18mm 15mm; }
  :root { --ink: #161a22; --muted: #5a6273; --line: #d9dde6; --accent: #4f5bd5; --accent-soft: #eef0ff; --code: #f5f6f9; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); font: 10.2pt/1.5 Inter, 'Helvetica Neue', Arial, sans-serif; }
  h1, h2, h3, h4 { font-weight: 700; line-height: 1.2; color: #11131a; }
  h1 { font-size: 22pt; margin: 0 0 10pt; }
  h2 { font-size: 15.5pt; margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 2px solid var(--accent); break-after: avoid; }
  h2.page { break-before: page; margin-top: 0; }
  h3 { font-size: 12pt; margin: 16pt 0 6pt; color: var(--accent); break-after: avoid; }
  h4 { font-size: 10.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  p { margin: 0 0 7pt; }
  ul, ol { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin: 0 0 2.5pt; }
  code { font: 8.6pt/1.4 'JetBrains Mono', Menlo, Consolas, monospace; background: var(--code); padding: 0 3px; border-radius: 3px; }
  pre { font: 8.2pt/1.45 'JetBrains Mono', Menlo, Consolas, monospace; background: var(--code); border: 1px solid var(--line); border-radius: 6px; padding: 8pt 10pt; white-space: pre-wrap; break-inside: avoid; margin: 0 0 9pt; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 10pt; font-size: 8.6pt; line-height: 1.35; }
  th { text-align: left; background: #f0f2f7; color: #2a2f3c; font-weight: 600; padding: 4pt 5pt; border-bottom: 1px solid var(--line); }
  td { padding: 3.5pt 5pt; border-bottom: 1px solid #eceef3; vertical-align: top; }
  tr { break-inside: avoid; }
  table.small { font-size: 7.6pt; }
  table.small td, table.small th { padding: 2.5pt 4pt; }
  .b { display: inline-block; font: 700 7pt/1 Inter, Arial, sans-serif; letter-spacing: .06em; padding: 2.5pt 4.5pt; border-radius: 9pt; vertical-align: 1pt; }
  .hoy { background: #dcf7e8; color: #11733f; }
  .puente { background: #e9e6ff; color: #4b3fc7; }
  .off { background: #fff1d6; color: #915c00; }
  .prox { background: #eceef3; color: #5b6275; }
  .box { border: 1px solid var(--line); border-left: 4px solid var(--accent); background: var(--accent-soft); border-radius: 6px; padding: 8pt 10pt; margin: 0 0 10pt; break-inside: avoid; }
  .box.warn { border-left-color: #d98a00; background: #fff8ea; }
  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; }
  .cover .top { padding-top: 30mm; }
  .cover .kicker { font: 700 9pt Inter, Arial; letter-spacing: .2em; color: var(--accent); text-transform: uppercase; margin-bottom: 10pt; }
  .cover h1 { font-size: 34pt; margin-bottom: 8pt; }
  .cover .sub { font-size: 13pt; color: var(--muted); max-width: 150mm; }
  .cover .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt; margin-top: 18mm; }
  .cover .stat { border: 1px solid var(--line); border-radius: 8px; padding: 8pt; }
  .cover .stat b { display: block; font-size: 19pt; color: var(--accent); }
  .cover .stat span { font-size: 8.5pt; color: var(--muted); }
  .cover .foot { font-size: 8.5pt; color: var(--muted); border-top: 1px solid var(--line); padding-top: 6pt; }
  .toc ol { columns: 2; column-gap: 12mm; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
  .legend td:first-child { width: 70pt; }
  .muted { color: var(--muted); }
</style></head><body>

<section class="cover">
  <div class="top">
    <div class="kicker">GreanTeaDawy · ${version} · ${today}</div>
    <h1>Biblia audio → visual</h1>
    <div class="sub">Todo lo que la estación de audio puede enviar a una interfaz visual — TouchDesigner, Blender, Unreal Engine — para crear experiencias audio‑reactivas: qué variables existen, en qué rango se mueven, cada cuánto cambian y por dónde salen: el puente audio → visual (OSC a 60 cuadros por segundo), el WebSocket y los archivos.</div>
    <div class="stats">
      <div class="stat"><b>${instrumentKinds.length - 1} + 1</b><span>instrumentos + ranura de plugin</span></div>
      <div class="stat"><b>${effectTypes.length}</b><span>tipos de efecto de mezcla</span></div>
      <div class="stat"><b>${GGS_PARAMS.length}</b><span>parámetros del GGS Synth</span></div>
      <div class="stat"><b>${sources.length} → ${targets.length}</b><span>fuentes → destinos de modulación</span></div>
      <div class="stat"><b>${MOD_SLOTS}</b><span>rutas de modulación por sintetizador</span></div>
      <div class="stat"><b>${opTypes.length}</b><span>tipos de edición en vivo (ops)</span></div>
      <div class="stat"><b>${mcpTools.length}</b><span>herramientas MCP</span></div>
      <div class="stat"><b>${PPQ}</b><span>ticks por negra (PPQ)</span></div>
    </div>
  </div>
  <div class="foot">Documento generado desde el código (<code>npm run docs:av</code>): las tablas de los apéndices salen de los catálogos reales del estudio y se regeneran cuando cambian. El texto distingue con cuidado lo que ya existe de lo que se propone.</div>
</section>

<h2 class="page">Cómo leer este documento</h2>
<p>Cada variable lleva una etiqueta que dice <b>por dónde la puede recibir hoy</b> una aplicación visual:</p>
${table(['Etiqueta', 'Significado'], [
  [HOY, 'Disponible ya, desde fuera del navegador: por el WebSocket en vivo (<code>/ws</code>), por la API REST o por las herramientas MCP. No hace falta tocar código del estudio.'],
  [PUENTE, 'Sale en vivo por el <b>puente audio → visual</b> (capítulo 7: fase 1 desde la versión 0.16, fase 2 desde la 0.17): con <i>☰ → Send to visuals</i> encendido, la pestaña que suena la mide y el servidor la envía ~60 veces por segundo como <b>OSC</b> (por defecto a <code>127.0.0.1:7000</code>) y como JSON por WebSocket.'],
  [PROX, 'Existe y se calcula en tiempo real dentro del motor, pero sale en la <b>fase 3</b> del puente (7.7): espacio 3D y expresión por nota en vivo — o no está previsto (forma de onda, espectro completo).'],
  [OFF, 'Se obtiene por render o exportación (WAV, stems, MIDI con expresión MPE, ADM BWF, JSON del proyecto) para trabajos no en vivo: videoclips, renders de Blender, secuencias de Unreal.']
], 'legend')}
<div class="box"><b>Desde la versión 0.16 el estudio emite OSC.</b> El puente audio → visual envía el transporte, cada nota en el instante en que suena, niveles, ${AV_BANDS.length} bandas, un espectro de ${AV_SPECTRUM_BANDS} bandas, el centroide, los ataques, la sección del tema, los valores de automatización y ${AV_USER_LANES} carriles visuales libres (fase 1), y desde la 0.17 dónde está cada control de la mezcla y la modulación viva de cada GGS Synth (fase 2) — todo con las direcciones confirmadas por el lado visual (capítulo 7). Lo que falta (posiciones 3D, expresión viva) está marcado ${PROX}. El estudio <b>no emite MIDI de salida</b>.</div>

<div class="toc"><h3>Contenido</h3><ol>
<li>Arquitectura en una página</li><li>El tiempo: ticks, compases, swing</li><li>Conexión en vivo hoy: WebSocket</li><li>API REST y MCP</li><li>Catálogo de señales (los “endpoints”)</li><li>El GGS Synth para visuales</li><li>El puente audio → visual (OSC, fases 1 y 2)</li><li>Recetas por herramienta (TouchDesigner, Blender, Unreal)</li><li>Apéndices generados desde el código</li></ol></div>

<h2>1. Arquitectura en una página</h2>
<ul>
  <li><b>Servidor</b> (Node.js, puerto <code>3001</code> por defecto): guarda los proyectos (JSON), recibe y valida cada edición (“op”), reparte el estado en vivo por <b>WebSocket</b> (<code>/ws</code>), ofrece la <b>API REST</b> (<code>/api</code>) y el servidor <b>MCP</b> (<code>/mcp</code>) con ${mcpTools.length} herramientas que usa Claude.</li>
  <li><b>Navegador</b> (React + Web Audio): aquí suena todo. El motor (<code>client/src/audio/engine.js</code>) programa notas con anticipación (lookahead), los instrumentos y efectos corren en nodos de Web Audio y en AudioWorklets; el <b>GGS Synth</b> crea un procesador AudioWorklet por nota. Los medidores, el analizador del master, los niveles por canal y la telemetría de modulación del sintetizador viven aquí.</li>
  <li><b>Render offline</b>: el mismo motor en un <code>OfflineAudioContext</code> produce WAV, stems por canal, renders espaciales (ADM BWF) y los análisis (LUFS, pico real, espectro, tempo, tonalidad) que reportan las herramientas MCP.</li>
</ul>
${code(`
App visual ──WebSocket /ws?token=…──► Servidor ◄──ops / transporte──► Navegador (motor de audio)
     │                                   │                                   │
     ├── REST /api/projects/:id ──────────┤                                   ├─ medidores, analizador, notas
     ├── MCP /mcp (render, análisis) ─────┘                                   └─ telemetría GGS (30 Hz)
     └── (propuesto) OSC / WS "av" ◄──────────── puente audio → visual ─────────────┘
`)}
<p><b>Tres caminos hacia lo visual:</b> (A) <b>estado y ediciones en vivo</b> por WebSocket ${HOY}; (B) <b>señales de audio en tiempo real</b> por el puente (OSC o WebSocket) ${PUENTE}; (C) <b>archivos</b> para trabajo no en vivo ${OFF}. Las tres comparten los mismos nombres de variables, así que una escena visual puede empezar con archivos y pasar a vivo sin renombrar nada.</p>

<h2>2. El tiempo: ticks, compases, swing</h2>
<ul>
  <li><b>Tick</b>: la unidad de tiempo del proyecto. <code>PPQ = ${PPQ}</code> ticks por negra, <code>STEP = ${STEP}</code> ticks por semicorchea (un paso del secuenciador).</li>
  <li><b>Compás</b>: <code>ticksPerBar = PPQ × 4 × num / den</code> según <code>project.timeSig = [num, den]</code> (4/4 → 384 ticks).</li>
  <li><b>Tempo</b>: <code>project.bpm</code> (un solo tempo por proyecto; no hay mapa de tempo). <b>Segundos = ticks / PPQ × 60 / bpm.</b></li>
  <li><b>Swing</b>: <code>project.swing</code> (0…1) retrasa las semicorcheas impares hasta medio paso; cada canal toma una parte (<code>channel.swingMix</code>) y puede adelantarse o atrasarse en ms (<code>channel.nudge</code>, ±50 ms). Fórmula exacta en <code>core/timeline.js → swingTicks</code>.</li>
  <li><b>Fase de pulso</b> útil para visuales: <code>beatPhase = (tick mod PPQ) / PPQ</code>, <code>barPhase = (tick mod ticksPerBar) / ticksPerBar</code>.</li>
  <li><b>Marcadores</b> (<code>project.markers</code>: <code>{ tick, name }</code>, p. ej. “Hook”, “Drop”) marcan secciones: perfectos para cambiar de escena.</li>
</ul>

<h2 class="page">3. Conexión en vivo hoy: WebSocket ${HOY}</h2>
<p>Cualquier programa (Python en TouchDesigner o Blender, C++/Blueprint en Unreal, Node) puede conectarse al mismo canal que usan las pestañas del estudio y recibir <b>el proyecto completo</b> y <b>cada cambio en vivo</b> (una perilla que se gira, una nota que se escribe, un efecto que se añade, una edición de Claude).</p>
<h3>3.1 Conectar</h3>
${table(['Paso', 'Detalle'], [
  ['URL', '<code>ws://HOST:3001/ws?token=gtd_…</code> (con <code>npm run dev</code> también <code>ws://localhost:5173/ws</code> a través del proxy de Vite).'],
  ['Credencial', 'Token personal de API <code>gtd_…</code> (menú del estudio → <i>Connect Claude (API token &amp; MCP)…</i>, o Ajustes → <i>API token &amp; MCP</i>), en el parámetro <code>?token=</code>. Con <code>NO_LOGIN=1</code> (<code>npm run dev:local</code>) no hace falta token desde esta misma computadora.'],
  ['Origen', 'Los clientes que no son navegador no envían <code>Origin</code> y se aceptan; un navegador de otro sitio se rechaza.'],
  ['Al conectar', 'El servidor manda <code>{ type: "welcome", activeProjectId, activity }</code>.'],
  ['Suscribirse', 'Enviar <code>{ "type": "subscribe", "projectId": "…", "makeActive": false }</code> → llega <code>{ type: "project", project }</code> con el JSON completo y, desde entonces, cada cambio.'],
  ['Mantener viva', 'Enviar <code>{ "type": "ping", "t": 123 }</code> → <code>{ type: "pong", t: 123 }</code>.']
])}
<h3>3.2 Mensajes que llegan</h3>
${table(['type', 'Contenido', 'Uso visual'], [
  ['<code>project</code>', 'El proyecto entero (ver apéndice A y capítulo 5).', 'Construir la escena: canales, colores, notas, automatizaciones, mezcla.'],
  ['<code>ops</code>', '<code>{ projectId, ownerId, ops: [...], rev, source: "ui"|"mcp"|"api", clientId, coalesce, descriptions: ["Edited channel Lead", …] }</code>', 'Reaccionar a gestos: una perilla girando llega como una serie de ops <code>channel/update</code> (hasta ~60 por segundo mientras se arrastra).'],
  ['<code>transport</code>', '<code>{ action: "play", mode: "song"|"pattern", patternId, position }</code>, <code>{ action: "stop" }</code>, <code>{ action: "audition", channelId, key, velocity, duration }</code>', 'Arrancar/parar la escena. <b>Ojo:</b> solo llega cuando Claude o la API piden play/stop, no cuando alguien pulsa Play en el navegador — para eso, <code>/gtd/transport/playing</code> del puente (capítulo 7).'],
  ['<code>activity</code>', '<code>{ source: "mcp", projectId, text, time }</code>', 'Mostrar lo que hace Claude (texto en pantalla).'],
  ['<code>open</code>', '<code>{ projectId }</code>: Claude pidió abrir otro proyecto.', 'Cambiar de proyecto/escena.'],
  ['<code>projects-changed</code>, <code>versions-changed</code>, <code>samples-changed</code>', 'Avisos de listas.', '—'],
  ['<code>error</code>, <code>ack</code>, <code>reject</code>, <code>pong</code>, <code>job</code>', 'Protocolo interno.', 'Ignorar (no enviar ops desde la app visual salvo que quiera controlar el estudio).']
], 'small')}
<h3>3.3 Tipos de edición (ops) que pueden llegar</h3>
<p>${opTypes.map((t) => `<code>${t}</code>`).join(' · ')}</p>
<p>Ejemplo real de un mensaje cuando se gira el corte del filtro del sintetizador de un canal:</p>
${code(`
{ "type": "ops", "projectId": "prj_…", "rev": 412, "source": "ui",
  "ops": [{ "type": "channel/update", "id": "ch_lead",
            "patch": { "instrument": { "params": { "f1Cutoff": 1240.5 } } } }],
  "descriptions": ["Edited channel Lead"] }
`)}
<h3>3.4 Cliente mínimo (Python, sirve en TouchDesigner y Blender)</h3>
${code(`
import json, websocket                                   # pip install websocket-client
URL = "ws://localhost:3001/ws?token=gtd_TU_TOKEN"
ws = websocket.create_connection(URL)
hello = json.loads(ws.recv())                            # {"type": "welcome", "activeProjectId": ...}
ws.send(json.dumps({"type": "subscribe", "projectId": hello["activeProjectId"], "makeActive": False}))
project = json.loads(ws.recv())["project"]               # el proyecto completo
while True:
    msg = json.loads(ws.recv())
    if msg["type"] == "ops":
        for op in msg["ops"]:
            if op["type"] == "channel/update":
                params = op.get("patch", {}).get("instrument", {}).get("params", {})
                for key, value in params.items():
                    print(op["id"], key, value)          # p. ej. ch_lead f1Cutoff 1240.5
    elif msg["type"] == "transport":
        print("transporte", msg)
`)}
<p class="muted">En TouchDesigner, el <i>WebSocket DAT</i> hace lo mismo sin librerías (callback <code>onReceiveText</code>). En Unreal, el módulo <i>WebSockets</i> de C++ o un plugin de Blueprint.</p>

<h2>4. API REST y MCP ${HOY}</h2>
<p>Con la cabecera <code>Authorization: Bearer gtd_…</code> (o sin nada con <code>NO_LOGIN=1</code> en esta computadora):</p>
${table(['Ruta', 'Qué da'], [
  ['<code>GET /api/projects</code>', 'La lista de proyectos.'],
  ['<code>GET /api/projects/:id</code>', 'El proyecto completo en JSON (igual que el mensaje <code>project</code>).'],
  ['<code>GET /api/projects/:id/summary</code>', 'Un resumen en texto: canales, patrones, arreglo, mezcla.'],
  ['<code>GET /api/projects/:id/midi</code>', 'El arreglo en MIDI (con expresión por nota MPE: pitch bend, presión, slide).'],
  ['<code>GET /api/active</code>', 'El proyecto abierto ahora.'],
  ['<code>POST /api/projects/:id/ops</code>', 'Aplicar ops: <b>la app visual también puede controlar el estudio</b> (p. ej. un gesto en TouchDesigner que mueve una macro).'],
  ['<code>POST /api/broadcast</code>', '<code>{ type: "transport", projectId, command: { action: "play"|"stop", … } }</code>: dar Play/Stop a las pestañas abiertas.'],
  ['<code>GET /api/catalog</code>, <code>/api/templates</code>', 'Los catálogos de instrumentos/efectos y las plantillas.'],
  ['<code>GET /api/exports</code>, <code>/api/exports/:name</code>', 'Archivos exportados (WAV, stems, ADM, MP3…).']
], 'small')}
<p><b>MCP</b> (<code>/mcp</code>, el protocolo de Claude): además de editar, mide. Para visuales son útiles <code>render_mix</code> (render del tema con LUFS integrado, pico real, balance espectral), <code>analyze_sound</code> / <code>analyze_synth_patch</code> (ataque, decaimiento, brillo, tono de un sonido), <code>export_stems</code>, <code>export_midi</code>, <code>export_spatial</code> y <code>evaluate_composition</code>. La lista completa está en el apéndice F.</p>

<h2 class="page">5. Catálogo de señales (los “endpoints”)</h2>
<p>Esta es la lista de todo lo que el estudio sabe y puede contarle a una interfaz visual, agrupada por familia. “Frecuencia” es cada cuánto cambia el valor. Los nombres en <code>monoespaciado</code> son los del JSON del proyecto o del motor; el capítulo 7 da sus direcciones OSC.</p>

<h3>5.1 Transporte y tiempo</h3>
${table(['Variable', 'Rango / unidad', 'Frecuencia', 'Estado', 'Idea visual'], [
  ['<code>playing</code>', 'bool', 'cada cuadro', `${PUENTE} (por el WebSocket del proyecto ${HOY} solo los play/stop de Claude/API)`, 'Arrancar/parar la escena'],
  ['<code>bpm</code>', `${MIN_BPM} … ${MAX_BPM} (<code>project.bpm</code>)`, 'al editar', HOY, 'Velocidad global de animaciones'],
  ['<code>timeSig</code>, <code>swing</code>', '[num, den]; 0 … 1', 'al editar', HOY, 'Cuadrícula de pulso, “bamboleo”'],
  ['<code>tick</code> (posición)', '0 … ∞ ticks', 'continua (cada cuadro)', PUENTE, 'Línea de tiempo, scrubbing'],
  ['<code>beat</code>, <code>bar</code>', 'número de pulso / compás', 'continua', PUENTE, 'Contadores, cortes en el 1'],
  ['<code>beatPhase</code>, <code>barPhase</code>', '0 … 1 (diente de sierra)', 'continua', PUENTE, 'Pulsar escala/brillo con el tempo'],
  ['<code>loop</code>', 'rango en ticks', 'al cambiar', PROX, '—'],
  ['<code>markers[]</code>', '<code>{ tick, name }</code>', 'al editar · al entrar en la sección', `${HOY} · ${PUENTE} (<code>/gtd/marker</code>)`, 'Cambios de escena por sección']
], 'small')}

<h3>5.2 Notas y gestos (eventos)</h3>
<p>Cada nota tiene: <code>key</code> (0…127, MIDI), <code>start</code>, <code>length</code> (ticks), <code>velocity</code> (0…1), <code>pan</code> (−1…1, opcional), <code>releaseVelocity</code> (0…1, opcional) y una <b>expresión por nota</b> opcional con tres curvas en tiempo normalizado de la nota (0…1): <code>pitch</code> (−48…48 semitonos), <code>pressure</code> (0…1) y <code>timbre</code> (0…1, el “slide”). Las notas viven en los patrones (<code>project.patterns[].notes[channelId][]</code>) y los patrones se colocan en la lista de reproducción (<code>project.playlist.clips[]</code>, con <code>start</code>, <code>length</code>, <code>offset</code>, <code>track</code>, <code>mute</code>).</p>
${table(['Variable', 'Rango', 'Frecuencia', 'Estado', 'Idea visual'], [
  ['partitura completa', 'notas + clips', 'al editar', HOY, 'La app visual puede programar sus propios eventos a partir del JSON (mismo tiempo que el audio si conoce el instante de Play)'],
  ['<code>noteOn</code> / <code>noteOff</code> en vivo', 'canal, key, velocity, duración, <code>at</code>', 'por evento, en el cuadro en que <b>suena</b> (el motor la programa 120 ms antes; el puente la retiene)', PUENTE, 'Partículas por nota, flashes por golpe de batería'],
  ['expresión viva: pitch / pressure / timbre', 'st / 0…1 / 0…1', 'continua mientras la nota suena', PROX, 'Deformar una malla con la presión, color con el slide'],
  ['notas tocadas por MIDI/MPE', 'igual', 'por evento', PUENTE, 'Visuales tocados en directo'],
  ['MIDI del arreglo (con MPE)', 'archivo .mid', '—', OFF, 'Importar a Blender/Unreal para animación sincronizada']
], 'small')}

<h3>5.3 Niveles y espectro</h3>
${table(['Variable', 'Rango / unidad', 'Frecuencia', 'Estado', 'Idea visual'], [
  ['pico y RMS del master', '0 … 1 (lineal; 1 = 0 dBFS)', 'cada cuadro', PUENTE, 'Escala global, flashes'],
  ['pico por insert del mezclador en uso (<code>getLevels</code>)', '0 … 1 (lineal, recortado)', 'cada cuadro', PUENTE, 'Un objeto por bus (batería, bajo, voces) que late'],
  ['pico por canal (después de su fader)', '0 … 1', 'cada cuadro', PUENTE, 'Un visual por instrumento'],
  ['forma de onda del master (analizador, 2048 muestras)', '−1 … 1', 'cada cuadro', PROX, 'Osciloscopio, líneas'],
  [`espectro del master en ${AV_SPECTRUM_BANDS} bandas logarítmicas 20 Hz – 20 kHz`, `0 … 1 (= ${AV_DB_FLOOR} … ${AV_DB_CEIL} dB)`, 'cada cuadro', PUENTE, 'Barras, terreno 3D'],
  ['espectro completo (1024 bandas) y onda por canal', 'dB · −1 … 1', 'cada cuadro', PROX, '—'],
  ['voces sonando por canal GGS (<code>ggsVoices</code>)', 'entero', 'al cambiar', PUENTE, 'Densidad de partículas'],
  ['bandas: sub / low / lowMid / mid / highMid / high', `0 … 1 en vivo (= ${AV_DB_FLOOR} … ${AV_DB_CEIL} dB) · % de energía en el análisis`, 'cada cuadro · por análisis', `${PUENTE} · ${OFF}`, 'Colores por banda'],
  ['centroide espectral (brillo)', 'Hz', 'cada cuadro · por análisis', `${PUENTE} · ${OFF}`, 'Temperatura de color'],
  ['onsets (ataques)', 'fuerza 0 … 1 (flujo espectral), máx. uno cada 80 ms', 'por evento · por análisis', `${PUENTE} · ${OFF}`, 'Cortes de cámara'],
  ['tempo detectado', 'bpm + confianza', 'por análisis', OFF, '—'],
  ['LUFS integrado / momentáneo, pico real (dBTP)', 'LUFS, dBTP', 'por render', OFF, 'Intensidad global de la escena'],
  ['tonalidad y nota detectadas', 'key + escala, Hz/MIDI', 'por análisis', OFF, 'Paletas por tonalidad']
], 'small')}

<h3>5.4 Canales (instrumentos)</h3>
<p>Cada canal: <code>id</code>, <code>name</code>, <code>color</code> (¡útil como paleta!), <code>volume</code> (0…1.25), <code>pan</code> (−1…1), <code>pitch</code> (−24…24 st), <code>mute</code>, <code>solo</code>, <code>mixerTrack</code>, <code>rootKey</code>, <code>filterCutoff</code> (20…20000 Hz), <code>filterRes</code> (0.1…20), <code>nudge</code>, <code>swingMix</code> y su instrumento <code>{ kind, preset, params }</code>. Los ${instrumentKinds.length - 1} instrumentos (más la ranura <code>plugin</code>, que toma el instrumento de un plugin del usuario) y sus parámetros están en el apéndice C. Estado: valores fijados ${HOY}; valor de cada automatización en el instante ${PUENTE} (<code>/gtd/auto/{id}</code>); valor efectivo del control 0…1 ${PUENTE} (<code>/gtd/ch/{canal}/param/…</code>, fase 2). Automatizables por canal: ${CHANNEL_AUTOMATION_PARAMS.map((p) => `<code>${p}</code>`).join(', ')} y, en un GGS Synth, <code>macro1…macro${MACRO_COUNT}</code>.</p>

<h3>5.5 Mezclador, efectos y espacio 3D</h3>
<p>Inserts (<code>project.mixer[]</code>, el 0 es el master): <code>volume</code> (0…1.25), <code>pan</code>, <code>mute</code>, <code>solo</code>, <code>output</code>, <code>sends[]</code> y <code>effects[]</code> (<code>{ id, type, enabled, params }</code>). Hay ${effectTypes.length} tipos de efecto (apéndice D; los marcados “auto” se pueden automatizar). ¿Subió la reverb o el eco? Llega como op <code>effect/update</code> con el parámetro (<code>mix</code>, <code>decay</code>, <code>feedback</code>…) ${HOY}; el valor de su automatización instante a instante y su valor efectivo 0…1 ${PUENTE} (<code>/gtd/fx/{n}/{efecto}/{param}</code>, fase 2).</p>
<p><b>Mezcla espacial</b> (estilo Dolby Atmos): con <code>project.spatial.enabled</code>, cada insert con <code>spatial.enabled</code> es un objeto 3D con <code>x</code> (−1 izquierda … 1 derecha), <code>y</code> (−1 atrás … 1 frente), <code>z</code> (0 suelo … 1 techo) y <code>lfe</code> (0…1). Las posiciones se automatizan (${Object.keys(SPATIAL_PARAMS).map((k) => `<code>${k}</code>`).join(', ')}): <b>perfectas para mover objetos en una escena 3D</b> de Unreal o Blender ${HOY} (posición fijada) / ${PUENTE} (sus automatizaciones <code>spatialX/Y/Z</code>, 0…1, como <code>/gtd/auto/{id}</code>) / ${PROX} (<code>/gtd/spatial/{n}</code> con x, y, z reales) / ${OFF} (ADM BWF con trayectorias).</p>

<h3>5.6 Automatización</h3>
<p><code>project.automations[]</code>: <code>{ id, name, color, target, length, points: [{ t (ticks), v (0…1) }] }</code>, colocadas en la lista como clips <code>kind: "automation"</code>. Destinos: <code>{ type: "channel", id, param }</code>, <code>{ type: "mixer"|"master", index, param }</code>, <code>{ type: "effect", index, effectId, param }</code> y <code>{ type: "user", index: 1…${AV_USER_LANES} }</code> — un <b>carril visual</b> que no mueve nada del sonido y sale como <code>/gtd/user/{n}</code> (7.5). El valor es lineal entre puntos y normalizado 0…1 (el motor lo convierte a la unidad del parámetro). Con el JSON ${HOY} una app visual puede evaluar la curva ella misma; el valor en vivo ${PUENTE}: dentro de su clip, la curva; después, el último valor se mantiene (igual que en el motor).</p>

<h3>5.7 Armonía y afinación</h3>
<p><code>project.key</code>, <code>project.scale</code> (${Object.keys(SCALES).length} escalas), <code>project.tuning</code> (${Object.keys(TUNING_SYSTEMS).length} sistemas de afinación: temperado, justa, pitagórica, mesotónica…) ${HOY}. La herramienta MCP <code>harmony</code> detecta los acordes de un tramo y su función (tónica, dominante…) ${HOY}: útil para cambiar paletas con la armonía.</p>

<h2 class="page">6. El GGS Synth para visuales</h2>
<p>El sintetizador del estudio es la fuente más rica de señales “musicales” para lo visual: además de sus ${GGS_PARAMS.length} parámetros (apéndice E), <b>calcula en cada nota ${sources.length} fuentes de modulación y ${targets.length} destinos modulados</b>, y ya sabe reportarlos.</p>
<h3>6.1 Qué tiene dentro</h3>
<ul>
  <li>3 osciladores de wavetable (A, B, C; 46 tablas) con unison (hasta 16 copias), warp, FM; un sub-oscilador; ruido.</li>
  <li>2 filtros (21 modelos) en serie o paralelo; amplificador con envolvente 1.</li>
  <li>4 envolventes DAHDSR, 4 LFOs (formas o pasos dibujados, sincronizables al tempo), 2 generadores de caos (Lorenz, Rössler, deriva, Turing).</li>
  <li>${MACRO_COUNT} macros (perillas maestras que mueven varias cosas a la vez — ideales como “intensidad” para lo visual) y una matriz de ${MOD_SLOTS} rutas fuente → destino.</li>
  <li>Efectos del canal: drive, chorus, delay estéreo, reverb.</li>
</ul>
<h3>6.2 La telemetría en vivo ${PUENTE}</h3>
<p>Mientras el editor está abierto sobre un canal, cada voz envía ~30 veces por segundo un <code>Float32Array</code> de ${MOD_SOURCES.length + MOD_TARGETS.length} valores (<code>engine.ggsLive(channelId)</code>, la nota más reciente): primero las ${MOD_SOURCES.length} fuentes en el orden de <code>MOD_SOURCES</code>, luego los ${MOD_TARGETS.length} destinos en el orden de <code>MOD_TARGETS</code>. Las fuentes llegan en su rango natural; los destinos llegan como la <b>suma de las rutas</b> <code>d</code> que les llegan, que se convierte a la unidad real del parámetro con <code>targetValue(modTargetSpec(target, patch), d)</code> (p. ej. el corte del filtro en Hz). Con el puente encendido, todas las voces de todos los canales GGS informan (no solo el canal que muestra el editor), y la fase 2 publica cada fuente y cada destino en su unidad real y 0…1 (7.4).</p>
${table(['Índice', 'Nombre', 'Rango', 'Qué es'], telemetryRows, 'small')}
<div class="box"><b>Lo más útil para visuales del sintetizador:</b> <code>env1</code> (la forma de volumen de cada nota: ataque → caída), <code>lfo1…4</code> (oscilaciones sincronizadas al tempo: rotaciones, pulsos), <code>chaos1/2</code> (movimiento orgánico que nunca se repite), <code>pressure</code>/<code>timbre</code> (el gesto del intérprete), <code>macro1…8</code> (la “intensidad” que decide el músico), y los destinos <code>f1Cutoff</code> (brillo real del sonido en Hz) y <code>osc{A,B,C}Pos</code> (por dónde va la wavetable).</div>

<h2 class="page">7. El puente audio → visual (fases 1 y 2) ${PUENTE}</h2>
<div class="box">Implementado en la versión 0.16 con las respuestas del lado visual: OSC por UDP a <code>127.0.0.1:7000</code>, ${AV_FPS} cuadros por segundo, los nombres <code>{canal}</code> con su regla, valores 0…1, <code>/gtd/map</code> y ${AV_USER_LANES} carriles libres <code>/gtd/user/1…${AV_USER_LANES}</code>. La fase 2 (0.17) añade dónde está cada control de la mezcla y la modulación viva del GGS Synth (7.4). Referencia técnica en inglés: <code>docs/av-bridge.md</code>.</div>
<h3>7.1 Encenderlo</h3>
<ol>
  <li>Abrir el estudio en la computadora donde corre la app visual (<code>npm run dev:local</code> o <code>npm start</code>).</li>
  <li>Menú <b>☰ → Send to visuals</b>. Se recuerda. Un aviso dice adónde van los cuadros; el menú muestra el puerto (<i>Send to visuals (OSC → 127.0.0.1:7000)</i>).</li>
  <li>Dar Play. Los cuadros salen mientras la pestaña está abierta, suene o no (parado: el cabezal y los niveles de lo que se toque a mano).</li>
</ol>
${table(['Ajuste', 'Detalle'], [
  ['<code>AV_OSC</code> (variable de entorno del servidor)', 'Vacía: <code>127.0.0.1:7000</code> si el servidor solo escucha en esta computadora (lo normal), <b>apagado</b> si escucha en la red (Docker, un servidor). <code>host:puerto</code> lo dirige a otra máquina (<code>192.168.1.20:7000</code>, <code>host.docker.internal:7000</code>); <code>off</code> lo apaga. El servidor lo dice al arrancar y en <code>GET /api/status</code> (<code>av.osc</code>).'],
  ['Una pestaña a la vez', 'Se oye la pestaña que envía, hasta que calla un segundo; pero una pestaña que <b>suena</b> le quita el turno a una que solo está parada con el ajuste encendido. La otra recibe el aviso “Another studio tab is sending to the visuals”. Una pestaña cuyos cuadros no llegan a nadie baja a dos cuadros por segundo.'],
  ['Cuentas', 'En un servidor con varias cuentas solo la pestaña de un <b>admin</b> maneja el OSC (el puerto es de la computadora del servidor) y solo los admins ven su dirección. Los clientes WebSocket de cada cuenta reciben los cuadros de su cuenta, de una pestaña a la vez.'],
  ['Sin el estudio', '<code>npm run av:replay</code> reproduce la captura real de <code>fixtures/av/</code> en <code>127.0.0.1:7000</code> con su ritmo original (7.8).']
])}
<h3>7.2 Convenciones confirmadas</h3>
<ul>
  <li><b>Cuadros:</b> ${AV_FPS} por segundo (medido: ${fixture ? String(fixture.framesPerSecond).replace('.', ',') : '60'} en la captura de prueba). Mensajes OSC <b>sueltos</b> (sin bundles), siempre en este orden: <b>transporte → eventos → valores continuos → latencia → mapa</b>. Dentro de los eventos, los <code>off</code> van antes que las <code>note</code>: una tecla que se vuelve a tocar en el mismo cuadro termina y vuelve a sonar.</li>
  <li><b>Nombres <code>{canal}</code>:</b> el nombre del canal en minúsculas, todo lo que no sea a–z o 0–9 pasa a <code>_</code>, acentos plegados (“Lead Synth” → <code>lead_synth</code>, “Bajo (sub)” → <code>bajo_sub</code>). Un nombre repetido: <code>kick</code>, <code>kick_2</code>. Renombrar un canal cambia sus direcciones; el mapa lo dice al instante.</li>
  <li><b>Valores:</b> 0…1 recortados (niveles lineales, 1 = 0 dBFS; automatización y carriles normalizados). Bandas y espectro: la potencia media de sus bins mostrada 0…1 para ${AV_DB_FLOOR} … ${AV_DB_CEIL} dB. El centroide en Hz.</li>
  <li><b>Notas:</b> salen en el cuadro más cercano al instante en que <b>se oyen</b> (nunca más de medio cuadro antes; el motor las programa 120 ms antes y el puente las retiene). <code>at</code> es ese instante en el <b>reloj del AudioContext</b> (segundos); cada cuadro trae ese reloj en <code>/gtd/transport/time</code>, así que <code>at − time</code> es el desfase dentro del cuadro (medido: −17,6 … +8,3 ms). <b>Ojo:</b> el simulador <code>gtd_bridge_sim.py</code> llena <code>at</code> con segundos de canción; el puente real usa el reloj de audio — la posición musical de una nota es el <code>tick</code> de su cuadro. Una nota cortada por otra (grupo de corte: el hi-hat abierto que cierra el cerrado; un sinte mono; el límite de polifonía) recibe su <code>off</code> al cortarse. Al apagar el puente terminan todas las notas que la app visual recibió, también las teclas sostenidas. <code>at</code> y <code>time</code> son floats de 32 bits: precisos a 1 ms las primeras ~2 horas de la pestaña.</li>
  <li><b>Latencia:</b> <code>/gtd/latency</code> (latencia de salida de la pestaña, s) una vez por segundo, para retrasar la imagen si hace falta.</li>
  <li><b>Secciones:</b> <code>/gtd/marker</code> al entrar en la sección de un marcador, y al encender el puente. Al parar, el cabezal vuelve a su sitio y llega el marcador de allí.</li>
  <li><b>Automatización:</b> cada automatización que ya sonó: dentro de su clip, la curva; después, su último valor (como en el motor). Los carriles visuales valen 0 hasta que suenan; con varios clips en un carril decide el que suena, si no el que terminó último.</li>
  <li><b>Tamaño:</b> <code>/gtd/map</code> mide como mucho 8 KB (macOS rechaza mensajes UDP mayores): uno más grande deja fuera las automatizaciones, luego los marcadores, y si aún no cabe el mapa llega solo como <code>/gtd/map/ch/…</code> (el cuadro por WebSocket siempre lo trae entero).</li>
  <li><b>Compatibilidad:</b> se ignoran las direcciones desconocidas; se agregan direcciones, nunca se renombran.</li>
</ul>
<h3>7.3 Mapa de direcciones (fase 1)</h3>
${table(['Dirección', 'Tipos', 'Contenido', 'Cuándo'], [
  ['<code>/gtd/transport/playing</code>', 'i', '1 sonando · 0 parado', 'cada cuadro'],
  ['<code>/gtd/transport/bpm</code>', 'f', 'tempo', 'cada cuadro'],
  ['<code>/gtd/transport/tick</code>', 'i', `posición en ticks (${PPQ} por negra); en modo canción desde el inicio, en modo patrón desde el inicio del patrón; parado: el cabezal de la lista`, 'cada cuadro'],
  ['<code>/gtd/transport/beat</code> · <code>/bar</code>', 'f · i', `tick / ${PPQ} · compás desde 1 (según el compás del tema)`, 'cada cuadro'],
  ['<code>/gtd/transport/phase/beat</code> · <code>/phase/bar</code>', 'f', '0 … 1 dentro del pulso · del compás', 'cada cuadro'],
  ['<code>/gtd/transport/time</code>', 'f', 'reloj del AudioContext (s) en este cuadro', 'cada cuadro'],
  ['<code>/gtd/marker</code>', 's i', 'nombre y tick de la sección en la que se entra', 'al cambiar'],
  ['<code>/gtd/ch/{canal}/off</code>', 'i f', 'key, velocidad de soltado 0…1 (0,5 si la nota simplemente termina)', 'al terminar'],
  ['<code>/gtd/ch/{canal}/note</code>', 'i f f f', 'key (0…127, con la transposición del canal), velocity 0…1, duración (s; 0 = tecla sostenida a mano: esperar su <code>off</code>), <code>at</code> (s, reloj de audio)', 'al sonar'],
  ['<code>/gtd/master/onset</code>', 'f', 'ataque (flujo espectral), fuerza 0…1; como mucho uno cada 80 ms', 'al ocurrir'],
  ['<code>/gtd/master/peak</code> · <code>/rms</code>', 'f', 'pico · RMS del master, 0…1, ventana de ~46 ms', 'cada cuadro'],
  ['<code>/gtd/master/bands</code>', `f×${AV_BANDS.length}`, AV_BANDS.map(([n, lo, hi]) => `${n} ${lo}–${hi >= 1000 ? `${hi / 1000}k` : hi}`).join(' · ') + ' Hz', 'cada cuadro'],
  ['<code>/gtd/master/spectrum</code>', `f×${AV_SPECTRUM_BANDS}`, `${AV_SPECTRUM_BANDS} bandas logarítmicas 20 Hz – 20 kHz`, 'cada cuadro'],
  ['<code>/gtd/master/centroid</code>', 'f', 'centroide espectral (brillo) en Hz; 0 en silencio', 'cada cuadro'],
  ['<code>/gtd/bus/{n}/peak</code>', 'f', 'pico del insert n en uso (0 = master; los que reciben canales, tienen efectos o nombre)', 'cada cuadro'],
  ['<code>/gtd/ch/{canal}/level</code>', 'f', 'pico del canal después de su fader, ventana de ~23 ms', 'cada cuadro'],
  ['<code>/gtd/auto/{automationId}</code>', 'f', 'valor 0…1 de una automatización (incluidas posiciones 3D <code>spatialX/Y/Z</code>)', 'cada cuadro, desde que suena'],
  [`<code>/gtd/user/1…${AV_USER_LANES}</code>`, 'f', 'los carriles visuales, 0…1 (7.5)', 'cada cuadro'],
  ['<code>/gtd/latency</code>', 'f', 'latencia de salida de la pestaña (s)', 'cada segundo'],
  ['<code>/gtd/map</code>', 's', 'JSON: <code>{ project, id, bpm, timeSig, ppq, ticksPerBar, channels: [{ slug, id, name, color, kind, insert }], buses: [{ index, name }], markers: [{ name, tick }], automations: [{ id, name, target }] }</code>', 'al cambiar el proyecto y cada 2 s'],
  ['<code>/gtd/map/ch/{canal}</code>', 's s s i', 'id, color, tipo de instrumento, insert — el mapa para apps que no leen JSON (el <i>OSC In CHOP</i>)', 'con el mapa'],
  ['<code>/gtd/map/bus/{n}</code>', 's', 'nombre del insert', 'con el mapa']
], 'small')}
<h3>7.4 Fase 2: los controles y el GGS Synth</h3>
<p>Estos valores salen en un cuadro <b>solo cuando cambian</b> (una mezcla quieta no cuesta nada) y <b>todos una vez por segundo</b> (el cuadro JSON lleva <code>"full": 1</code>), para que una app visual que empieza tarde los tenga en menos de un segundo. Van después de los carriles visuales y antes de la latencia.</p>
${table(['Dirección', 'Tipos', 'Contenido'], [
  ['<code>/gtd/ch/{canal}/param/{volume|pan|filterCutoff|filterRes|pitch|mute}</code>', 'f', 'la tira del canal, 0…1: su ajuste, o lo que hace la automatización mientras suena el tema (parado, el motor devuelve los controles automatizados a su ajuste). volume 0,8 = 0 dB; pan 0,5 = centro; filterCutoff log 20 Hz … 20 kHz; filterRes log 0,1 … 20; pitch −24 … +24 semitonos (0,5 = nada; un clip de pitch sonando se suma); mute 1 = no suena (silenciado u otro canal en solo)'],
  [`<code>/gtd/ch/{canal}/param/macro{1…${MACRO_COUNT}}</code>`, 'f', 'las macros de un canal GGS, 0…1'],
  ['<code>/gtd/bus/{n}/param/{volume|pan|mute}</code>', 'f', 'cada insert en uso, igual (0 = master; su 0 dB es 0,8). mute 1 = no suena: silenciado, u otro insert en solo al que no llega. El pan de un objeto 3D es donde lo pone su x (su perilla de pan no hace nada)'],
  ['<code>/gtd/fx/{n}/{efecto}/{param}</code>', 'f', 'cada efecto del insert n: <code>enabled</code> 0/1, cada parámetro numérico 0…1 de su rango (los logarítmicos en escala log, como los dibuja la automatización), interruptores 0/1. <code>{efecto}</code> es su tipo; un segundo del mismo tipo, <code>_2</code> (<code>reverb</code>, <code>reverb_2</code>); el mapa los lista. Un efecto plugin solo manda <code>enabled</code>'],
  ['<code>/gtd/ggs/{canal}/voices</code>', 'i', 'notas sonando en el canal (con sus colas)'],
  ['<code>/gtd/ggs/{canal}/src/{fuente}</code>', 'f', `las ${sources.length} fuentes de la tabla 6.2 en la nota más reciente, en su rango (0…1 o −1…1); sin nada sonando, 0 (las macros donde están)`],
  ['<code>/gtd/ggs/{canal}/dst/{destino}</code>', 'f', `los ${targets.length} destinos donde los lleva la matriz, en la unidad de su perilla (cortes en Hz, pitch en semitonos, posición de wavetable 0…1, LFO rate en Hz o ×tempo); sin nada sonando, su ajuste`],
  ['<code>/gtd/ggs/{canal}/dst/{destino}/n</code>', 'f', 'lo mismo en 0…1 del rango de su control (cortes en log); para un desplazamiento sin rango (pitch, LFO rate) 0,5 + profundidad/2: 0,5 = sin modular']
], 'small')}
<p>Un canal que desaparece (borrado, renombrado, o un GGS que pasa a otro instrumento) recibe un último valor: <code>…/param/mute 1</code>, y <code>/gtd/ggs/{canal}/voices 0</code> con sus fuentes en 0. Un cuadro que no pudo enviarse, o una pestaña que toma el puerto, hace que el siguiente sea completo. Las voces informan unas 30 veces por segundo, así que la telemetría avanza a 30 Hz dentro de los 60 cuadros; sigue al hilo de audio, unos milisegundos por delante de lo que llega a los altavoces (como las notas: ver <code>/gtd/latency</code>). Con el puente encendido y alguien escuchándolo informan todas las voces de todos los canales GGS (como cuando el editor está abierto sobre un canal): cuesta algo de CPU en el hilo de audio y nada en el sonido.</p>
<h3>7.5 Carriles visuales: <code>/gtd/user/1…${AV_USER_LANES}</code></h3>
<p>Automatizaciones que <b>no mueven nada del sonido</b>: una curva para que la siga lo visual (un brillo, una órbita de cámara, un fundido de color). En el estudio: <i>Playlist → Auto + → Visual lanes → Lane n</i>, y se dibuja en el editor de automatización como cualquier otra; vive en la lista como un clip. Claude: <code>add_automation target={ type: "user", lane: n }</code>. Valores 0…1; mantienen su último valor después del clip y valen 0 antes de sonar por primera vez. En el proyecto: <code>{ type: "user", index: n }</code>.</p>
<h3>7.6 Lo mismo por WebSocket (JSON)</h3>
<p>Un programa con el token de la cuenta abre <code>ws://HOST:3001/ws?token=gtd_…</code>, envía <code>{ "type": "subscribe-av" }</code> y recibe cada cuadro como JSON (los mismos campos; <code>avFrameToOsc</code> en <code>core/av.js</code> es la traducción exacta a OSC). Un cuadro real de la captura de prueba, el del “Drop” (recortado con …):</p>
${code(`
{ "type": "av", "frame": {
  "playing": 1, "bpm": 120, "tick": 3073, "ppq": 96, "tpb": 384, "time": 18.1058,
  "marker": { "name": "Drop", "tick": 3072 },
  "offs":  [{ "ch": "pad", "key": 55, "rel": 0.5 }, …],
  "notes": [{ "ch": "kick", "key": 60, "vel": 0.8, "dur": 0.125, "at": 18.1005 },
            { "ch": "lead", "key": 76, "vel": 0.8, "dur": 0.25,  "at": 18.1005 }, …],
  "master": { "peak": 0.2053, "rms": 0.0895, "centroid": 354, "onset": 0,
              "bands": [0.7462, 0.7071, 0.5455, 0.3018, 0.0765, 0], "spectrum": [0.7022, …] },
  "buses": { "0": 0.1114, "1": 0.419, "4": 0.1773, … },
  "ch": { "kick": 0.7407, "bass": 0.2216, "pad": 0.1427, "lead": 0.0298, … },
  "auto": { "auto_…": 1, … }, "user": [1, 1, 0, 0, 0, 0, 0, 0],
  "param": { "pad": { "filterCutoff": 0.9497 } },
  "ggs": { "lead": { "src": { "env1": 0.3489, "env2": 0.779, "velocity": 0.8, … },
                     "dst": { "f1Cutoff": [6943.23, 0.8458], … } },
           "pad":  { "src": { "lfo1": 0.4835, "lfo2": -0.642, … },
                     "dst": { "f1Cutoff": [1293.38, 0.6118], "oscAPos": [0.409, 0.409], … } }, … } } }
`)}
<p class="muted">La fase 2 solo trae lo que cambió en este cuadro (aquí: el corte del pad, que la automatización de la sección Build dejó abierto, y la modulación de los tres GGS); un cuadro con <code>"full": 1</code>, una vez por segundo, los trae todos.</p>
<h3>7.7 Fase siguiente ${PROX}</h3>
${table(['Fase', 'Dirección', 'Tipos', 'Contenido'], [
  ['3', '<code>/gtd/spatial/{n}</code>', 'f f f', 'x, y, z reales del objeto 3D del insert n (hoy: sus automatizaciones como <code>/gtd/auto/…</code>)'],
  ['3', '<code>/gtd/ch/{canal}/expr/{pitch|pressure|timbre}</code>', 'i f', 'key, valor de la expresión viva de esa nota']
], 'small')}
<h3>7.8 La prueba: <code>fixtures/av/</code></h3>
<p>Un tema de 16 compases hecho para probar una escena (La menor, 120 bpm, 32 s: Intro → Build → Drop → Outro, 4 compases cada uno) y la <b>captura real</b> de lo que envió el puente mientras sonaba en un Chromium sin pantalla (${fixture ? `${thousands(fixture.messages)} mensajes, ${thousands(fixture.frames)} cuadros, ${String(fixture.framesPerSecond).replace('.', ',')} por segundo` : 'unos 78 000 mensajes'}). Carriles: <code>/gtd/user/1</code> “Energy” sigue el arreglo; <code>/gtd/user/2</code> “Strobe” destella en cada pulso del Drop; el lead es un objeto 3D que da una vuelta a la sala en el Drop. Archivos: <code>song.gtd.json</code> (se abre con <i>File → Import project file</i>), <code>song.mid</code>, <code>osc-capture.jsonl.gz</code>, <code>capture-summary.json</code> (cuántos mensajes de cada dirección, para comparar un receptor) y un <code>README.md</code> con los ids. Los stems y la mezcla (WAV) se generan con <code>npm run fixture:av</code>. Para reproducir la captura en el puerto 7000: <code>npm run av:replay</code> (<code>-- --loop</code>, <code>-- --to host:puerto</code>, <code>-- --speed 0.5</code>).</p>

<h2 class="page">8. Recetas por herramienta</h2>
<h3>TouchDesigner</h3>
<ul>
  <li><b>Hoy:</b> <i>WebSocket DAT</i> → proyecto y ops (colores de canal para paletas, macros y perillas como CHOPs con un script en <code>onReceiveText</code>).</li>
  <li><b>Offline:</b> stems (<code>export_stems</code>) en <i>Audio File In CHOP</i> + <i>Audio Spectrum CHOP</i>; el MIDI del arreglo para disparos exactos.</li>
  <li><b>Con el puente:</b> <i>OSC In CHOP</i> en el puerto 7000: cada dirección numérica <code>/gtd/…</code> se vuelve un canal CHOP (las de varios valores, como <code>/gtd/master/spectrum</code>, uno por valor). Las notas, el marcador y el mapa (texto) se leen mejor con un <i>OSC In DAT</i>; para probar sin el estudio, <code>npm run av:replay</code>.</li>
</ul>
<h3>Blender</h3>
<ul>
  <li><b>Offline (lo más sólido para renders):</b> stems por canal en el Video Sequencer o con <i>Bake Sound to F-Curves</i> en el Graph Editor; el MIDI con un add-on de importación MIDI; el JSON del proyecto (<code>GET /api/projects/:id</code>) leído con Python para crear keyframes exactos desde notas y automatizaciones (segundos = ticks / ${PPQ} × 60 / bpm).</li>
  <li><b>Hoy en vivo:</b> un hilo de Python con websocket-client (capítulo 3.4) que escribe en propiedades personalizadas.</li>
  <li><b>Con el puente:</b> python-osc (<code>Dispatcher</code> con <code>map("/gtd/*", …)</code>) en un hilo, o un add-on OSC, para recibir <code>/gtd/…</code>; o leer la captura de <code>fixtures/av/</code> para hornear keyframes con los mismos datos.</li>
</ul>
<h3>Unreal Engine</h3>
<ul>
  <li><b>Con el puente:</b> plugin <i>OSC</i> (servidor OSC en Blueprint, puerto 7000) → eventos de nota, bandas y carriles visuales hacia Niagara y materiales (y con la fase 2 las fuentes del GGS: <code>env1</code>, <code>lfo1</code>, <code>chaos1</code>… y el corte del filtro en Hz).</li>
  <li><b>Hoy:</b> WebSockets (C++/plugin) para el estado y las ops.</li>
  <li><b>Offline:</b> stems importados y analizados (por ejemplo con Audio Synesthesia para loudness/onsets no en tiempo real), objetos espaciales desde el ADM BWF (<code>export_spatial</code>) o desde <code>mixer[].spatial</code>.</li>
</ul>

<h2 class="page">Apéndice A — El proyecto en JSON</h2>
${code(`
{ "format": "greanteadawy-project", "version": 1, "id", "name", "rev", "createdAt", "updatedAt",
  "bpm", "timeSig": [4, 4], "swing", "key", "scale", "tuning": { "system", "root", "a4", … } | null,
  "channels":  [{ "id", "name", "color", "volume", "pan", "pitch", "mute", "solo", "mixerTrack", "chokeGroup",
                  "rootKey", "filterCutoff", "filterRes", "nudge", "swingMix",
                  "instrument": { "kind", "preset", "params": { … } } }],
  "patterns":  [{ "id", "name", "color", "length", "notes": { "<channelId>": [{ "id", "key", "start", "length",
                  "velocity", "pan"?, "releaseVelocity"?, "expression"?: { "pitch"|"pressure"|"timbre": [{ "t", "v", "c"? }] } }] } }],
  "playlist":  { "tracks": [{ "id", "name", "color", "mute" }],
                 "clips": [{ "id", "kind": "pattern"|"audio"|"automation", "refId", "track", "start", "length", "offset", "mute",
                             "gain"?, "fadeIn"?, "fadeOut"?, "rate"? }] },
  "markers":   [{ "id", "tick", "name" }],
  "automations": [{ "id", "name", "color", "target", "length", "points": [{ "t", "v" }] }],
  "mixer":     [{ "id", "name", "color", "volume", "pan", "mute", "solo", "output", "sends": [{ "to", "amount" }],
                  "effects": [{ "id", "type", "enabled", "params": { … } }],
                  "spatial": { "enabled", "x", "y", "z", "lfe" } }],
  "spatial":   { "enabled", "monitor" } }
`)}

<h2>Apéndice B — Constantes</h2>
${table(['Nombre', 'Valor'], [
  ['PPQ (ticks por negra)', PPQ], ['STEP (ticks por semicorchea)', STEP], ['Rutas de modulación por GGS', MOD_SLOTS], ['Macros por GGS', MACRO_COUNT],
  ['Fuentes de modulación (sin “none”)', sources.length], ['Destinos de modulación (sin “none”)', targets.length], ['Telemetría GGS (valores por cuadro)', MOD_SOURCES.length + MOD_TARGETS.length],
  ['Efectos DSP de estudio (worklet)', Object.keys(STUDIO_FX).length], ['Escalas', Object.keys(SCALES).length], ['Sistemas de afinación', Object.keys(TUNING_SYSTEMS).length]
])}

<h2 class="page">Apéndice C — Instrumentos (${instrumentKinds.length - 1} + la ranura de plugin)</h2>
<p class="muted">Agrupados por categoría. El GGS Synth tiene su propio apéndice (E). Los rangos son los que aceptan el editor, la API y Claude.</p>
${INSTRUMENT_CATEGORIES.map(([cat, label]) => {
  const kinds = instrumentKinds.filter((k) => INSTRUMENTS[k].category === cat);
  if (!kinds.length) return '';
  return `<h3>${esc(label)}</h3>${kinds.map((k) => {
    const d = INSTRUMENTS[k];
    if (k === 'ggs') return `<h4><code>${k}</code> — ${esc(d.label)}</h4><p>${esc(d.description || '')} Ver apéndice E.</p>`;
    const params = (d.params || []).filter((p) => p.type !== 'sample');
    return `<h4><code>${k}</code> — ${esc(d.label)}</h4><p class="muted">${esc(d.description || '')}</p>${params.length ? table(['Parámetro', 'Nombre', 'Rango', 'Por defecto'], params.map((p) => [`<code>${p.key}</code>`, esc(p.label), range(p), esc(fmt(p.default))]), 'small') : ''}`;
  }).join('')}`;
}).join('')}

<h2 class="page">Apéndice D — Efectos de mezcla (${effectTypes.length})</h2>
<p class="muted">“auto” = automatizable en el tiempo (y por eso candidato a publicarse en vivo con el puente). Grupos: ${EFFECT_GROUPS.map(([g]) => esc(g)).join(', ')}.</p>
${effectTypes.map((t) => {
  const d = EFFECTS[t];
  return `<h4><code>${t}</code> — ${esc(d.label)}</h4><p class="muted">${esc(d.description || '')}</p>${table(['Parámetro', 'Nombre', 'Rango', 'Por defecto', 'auto'], (d.params || []).map((p) => [`<code>${p.key}</code>`, esc(p.label), range(p), esc(fmt(p.default)), p.automatable ? '✓' : '']), 'small')}`;
}).join('')}

<h2 class="page">Apéndice E — Parámetros del GGS Synth (${GGS_PARAMS.length})</h2>
<p class="muted">Los bloques repetidos se muestran una vez: <code>osc{A,B,C}…</code> son tres parámetros, <code>env{1-4}…</code> cuatro, <code>mod{1-64}…</code> sesenta y cuatro. Descripciones tal como están en el código.</p>
${table(['Parámetro', 'Grupo', 'Rango / opciones', 'Por defecto', 'Descripción'], folded.map((p) => [`<code>${esc(p.name)}</code>${p.count > 1 ? ` <span class="muted">×${p.count}</span>` : ''}`, esc(p.group || p.section || ''), range(p), esc(fmt(p.default)), esc(p.desc || '')]), 'small')}

<h2 class="page">Apéndice F — Herramientas MCP (${mcpTools.length})</h2>
${table(['Herramienta', 'Qué hace'], mcpTools.map(([n, d]) => [`<code>${n}</code>`, esc(d)]), 'small')}

</body></html>`;

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font:7.5pt Arial,sans-serif;color:#8a90a0;padding:0 15mm;display:flex;justify-content:space-between"><span>GreanTeaDawy ${version} — Biblia audio → visual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
  });
  if (process.env.AV_HTML) fs.writeFileSync(process.env.AV_HTML, html);
  console.log(`wrote ${path.relative(root, out)}`);
} finally {
  await browser.close();
}
