// The GGS Synth for agents: read what the synth can do, build a patch section by section (oscillators, filters,
// envelopes, LFOs, modulation, effects), and measure the result — rendered on the server, no browser needed.
import { Worker } from 'node:worker_threads';
import {
  INSTRUMENTS, findChannel, uid, noteName, parseNote, sanitizeParams, flattenCurve, EXPRESSION_DIMS, describeAnalysis
} from '@greanteadawy/core';
import {
  GGS_PARAMS, GGS_PRESETS, GGS_PRESET_INFO, GGS_PRESET_CATEGORIES, OSC_IDS, WARP_MODES, FM_SOURCES, SOURCE_DESTS, FILTER_TYPES, FILTER_ROUTES,
  SUB_WAVES, NOISE_TYPES, LFO_SHAPES, LFO_SYNC, LFO_TRIGGERS, DRIVE_TYPES, DELAY_SYNC, QUALITIES, MOD_SOURCES, MOD_TARGETS, MOD_SOURCE_INFO,
  MOD_TARGET_INFO, MOD_SLOTS, WAVETABLE_IDS, describeWavetables, describeSynth, paramsToPatch, patchToParams, sectionToParams, modulationRoutes,
  routesToParams, checkRoute, summarizePatch, ggsDefaults, releaseTail
} from '@greanteadawy/synth-dsp';
import { z, ok, projectIdArg, annotations as A, uniqueName, normVelocity } from '../util.js';
import { curveArg, buildExpression } from './expression.js';

const channelArg = z.string().describe('A GGS Synth channel (id or name)');
const unit = z.number().min(0).max(1);

const oscFields = {
  on: z.boolean().optional(),
  table: z.enum(WAVETABLE_IDS).optional().describe('Wavetable (describe_synth topic "wavetables" explains each)'),
  position: unit.optional().describe('Where in the table the oscillator reads, 0..1 (modulate it: target oscAPos/oscBPos/oscCPos)'),
  level: unit.optional(),
  pan: z.number().min(-1).max(1).optional(),
  octave: z.number().int().min(-4).max(4).optional(),
  semi: z.number().int().min(-12).max(12).optional(),
  fine: z.number().min(-100).max(100).optional().describe('Cents'),
  unison: z.number().int().min(1).max(8).optional().describe('Stacked detuned voices (CPU grows with it)'),
  detune: z.number().min(0).max(100).optional().describe('Unison spread in cents'),
  blend: unit.optional().describe('Level of the outer unison voices against the middle ones'),
  spread: unit.optional().describe('Stereo width of the unison stack'),
  phase: unit.optional(),
  phaseRandom: unit.optional().describe('1 = every note starts at a random phase (alive); 0 = always the same attack (basses, plucks)'),
  warp: z.enum(WARP_MODES).optional().describe('Phase/shape distortion: bend, pwm, sync, mirror, fold, quantize'),
  warpAmount: unit.optional(),
  fmFrom: z.enum(FM_SOURCES).optional().describe('Phase-modulate this oscillator by another source (its own letter = feedback)'),
  fm: unit.optional().describe('FM amount (0.2 mild … 0.6 aggressive)'),
  to: z.enum(SOURCE_DESTS).optional().describe('Where it goes: f1, f2, both filters, or direct (past the filters)')
};

/** The GGS channel a tool addresses (clear error for other instruments). */
function ggsChannel(p, ref) {
  const ch = findChannel(p, ref);
  if (ch.instrument.kind !== 'ggs') throw new Error(`"${ch.name}" is a ${INSTRUMENTS[ch.instrument.kind]?.label || ch.instrument.kind}, not a GGS Synth. Create one with create_synth_patch (or update_channel instrument "ggs").`);
  return ch;
}

/** Strict validation of flat params against the schema (helpful range errors), returning them cleaned. */
const validate = (params) => sanitizeParams(GGS_PARAMS, params, { strict: true });

export function registerSynthTools({ tool, backend, load }) {
  /** Apply a params delta to a GGS channel and describe the patch afterwards. */
  async function applyParams(p, ch, params, what) {
    const clean = validate(params);
    if (!Object.keys(clean).length) throw new Error('Nothing to change');
    const after = await backend.applyOps(p.id, [{ type: 'channel/update', id: ch.id, patch: { instrument: { params: clean } } }]);
    const now = after.channels.find((c) => c.id === ch.id);
    return ok(`${what} of "${now.name}" [${now.id}]:\n${summarizePatch(now.instrument.params)}`);
  }

  tool('describe_synth', {
    title: 'GGS Synth reference',
    description: 'What the GGS Synth can do, for sound design: its sections and every field with range and default (topic "parameters"), the wavetables and what each sounds like ("wavetables"), modulation sources and targets and what an amount of 1 means ("modulation"), and the preset library with macro assignments ("presets"). Read "overview" first.',
    inputSchema: { topic: z.enum(['overview', 'parameters', 'wavetables', 'modulation', 'presets']).optional().describe('Default: overview') },
    annotations: A.readOnly
  }, async ({ topic = 'overview' }) => {
    if (topic === 'parameters') return ok('GGS Synth fields by section (as used by the set_synth_* tools and patch documents):', describeSynth());
    if (topic === 'wavetables') return ok(`Wavetables (${WAVETABLE_IDS.length}) — "position" scans a table from its first frame (0) to its last (1):\n${describeWavetables().map((t) => `  ${t.id.padEnd(10)} ${t.name} (${t.frames} frames): ${t.description}`).join('\n')}`);
    if (topic === 'modulation') {
      return ok([
        `Modulation matrix: ${MOD_SLOTS} routes, each source → target × amount (-1..1), optionally × a second source ("via": e.g. vibrato depth via pressure).`,
        'An amount of 1 moves the target across its whole range when the source is at 1.',
        '', 'SOURCES:', ...MOD_SOURCES.filter((s) => s !== 'none').map((s) => `  ${s.padEnd(11)} ${MOD_SOURCE_INFO[s]}`),
        '', 'TARGETS:', ...MOD_TARGETS.filter((s) => s !== 'none').map((s) => `  ${s.padEnd(12)} ${MOD_TARGET_INFO[s]}`),
        '', 'Envelope 1 always shapes the level. Pressure, timbre (slide) and bend come from each note (set_note_expression); velocity from the note; macros 1-4 from the channel (automatable: add_automation target channel param macro1..macro4).'
      ].join('\n'));
    }
    if (topic === 'presets') {
      const lines = GGS_PRESET_CATEGORIES.map(([cat, label]) => `## ${label}\n${Object.keys(GGS_PRESETS).filter((n) => GGS_PRESET_INFO[n]?.category === cat).map((n) => `  ${n}: ${GGS_PRESET_INFO[n].description}\n      macros: ${GGS_PRESET_INFO[n].macros.join(' · ')}\n      expression: ${GGS_PRESET_INFO[n].expression}`).join('\n')}`);
      return ok(`GGS Synth presets (create_synth_patch preset "<name>"); "Init" is the blank patch.\n\n${lines.join('\n\n')}`);
    }
    return ok([
      'GGS SYNTH — a wavetable / FM hybrid synthesizer (instrument kind "ggs"). Signal path per note:',
      '  oscillators A, B, C (wavetable, unison, warp, FM from another source) + sub + noise',
      '  → filter 1 / filter 2 (serial or parallel; lp/hp/bp 12 or 24 dB, notch, peak, comb; drive, key tracking)',
      '  → amp (envelope 1 × velocity) → channel effects: drive → chorus → delay → reverb → gain',
      `Movement: 4 envelopes, 4 LFOs (Hz or tempo-synced; per note or free-running), 4 macros and a ${MOD_SLOTS}-route modulation matrix.`,
      'Every note has its own pitch curve, pressure and slide (timbre): route pressure/timbre in the matrix to make them audible (set_note_expression writes the curves).',
      '',
      'Workflow: create_synth_patch (preset or blank) → set_synth_oscillator / set_synth_filter / set_synth_envelope / set_synth_lfo / set_synth_modulation / set_synth_effect → analyze_synth_patch (renders a note or chord here and measures pitch, loudness, spectrum, envelope) → adjust. get_synth_patch reads a patch back; update_synth_patch applies a whole patch document.',
      'Topics: "parameters" (every field and range), "wavetables", "modulation" (sources, targets, amounts), "presets".',
      '',
      'Sound-design starting points:',
      '  pad: 2 oscillators, unison 3-5, detune 10-25 ct, lp24 800-2000 Hz, envelope 1 attack 0.4-1.5 s release 1.5-4 s, slow free LFO → oscillator position, chorus + reverb',
      '  bass: phaseRandom 0, sub level 0.3-0.6 to "direct", lp24 200-800 Hz with envelope 2 → f1Cutoff 0.3-0.45, mono + glide 0.03-0.08 s',
      '  pluck/keys: envelope 1 sustain 0 decay 0.3-3 s, envelope 2 (short) → oscillator position or f1Cutoff, velocity → f1Cutoff 0.15',
      '  lead: mono or poly, pressure → f1Cutoff 0.3, LFO → pitchFine 0.3 via pressure (vibrato you play), timbre → oscAPos',
      '  FM bell: oscillator B (sine: table basic position 0, level 0) as fmFrom of A, fm 0.2-0.4, envelope 2 → oscAFm'
    ].join('\n'));
  });

  tool('create_synth_patch', {
    title: 'Create a GGS Synth channel',
    description: 'Add a GGS Synth channel with its own mixer insert: start from a preset (describe_synth topic "presets") or from the blank Init patch, optionally overlaid with a patch document (any subset of: oscillators [{ id: "A", table, position, … }], sub, noise, filters [{ id: 1, type, cutoff, … }], filterRouting, envelopes, lfos, macros [4 values], modulation [{ source, target, amount, via }], voice, effects { drive, chorus, delay, reverb }). Replies with the channel id and the patch.',
    inputSchema: {
      projectId: projectIdArg,
      name: z.string().min(1).max(64).describe('Channel name, e.g. "Pad", "Lead"'),
      preset: z.enum(Object.keys(GGS_PRESETS)).optional().describe('Default: Init'),
      patch: z.record(z.string(), z.any()).optional().describe('Patch document sections to apply on top of the preset'),
      volume: z.number().min(0).max(1.25).optional(),
      pan: z.number().min(-1).max(1).optional(),
      mixerTrack: z.number().int().min(0).optional().describe('Default: the next free insert'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const params = a.patch ? validate(patchToParams(a.patch)) : {};
    if (a.mixerTrack !== undefined && a.mixerTrack >= p.mixer.length) throw new Error(`Mixer insert ${a.mixerTrack} does not exist (0..${p.mixer.length - 1}); leave mixerTrack out to get a free insert`);
    const id = uid('ch');
    const name = uniqueName(p.channels, a.name);
    const after = await backend.applyOps(p.id, [{
      type: 'channel/add', nameInsert: true,
      channel: { id, name, kind: 'ggs', preset: a.preset || 'Init', params, volume: a.volume, pan: a.pan, mixerTrack: a.mixerTrack ?? 'auto', color: a.color }
    }]);
    const ch = after.channels.find((c) => c.id === id);
    const info = GGS_PRESET_INFO[ch.instrument.preset];
    return ok(`Created GGS Synth "${ch.name}" [${ch.id}] (${ch.instrument.preset}) → mixer insert ${ch.mixerTrack}.${name !== a.name ? ` A channel named "${a.name}" already existed.` : ''}\n${summarizePatch(ch.instrument.params)}${info && ch.instrument.preset !== 'Init' ? `\nMacros: ${info.macros.map((m, i) => `${i + 1} ${m}`).join(' · ')}\nExpression: ${info.expression}` : ''}`);
  });

  tool('get_synth_patch', {
    title: 'Read a GGS Synth patch',
    description: 'The patch of a GGS Synth channel: a readable summary, or the full patch document (format "document") that create_synth_patch / update_synth_patch accept — also how to copy a sound to another channel or project.',
    inputSchema: { projectId: projectIdArg, channel: channelArg, format: z.enum(['summary', 'document']).optional() },
    annotations: A.readOnly
  }, async ({ projectId, channel, format = 'summary' }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const info = GGS_PRESET_INFO[ch.instrument.preset];
    if (format === 'document') return ok(`Patch document of "${ch.name}" [${ch.id}]`, paramsToPatch(ch.instrument.params, { name: ch.name }));
    const routes = modulationRoutes(ch.instrument.params);
    return ok(`GGS Synth "${ch.name}" [${ch.id}] — started from preset ${ch.instrument.preset}\n${summarizePatch(ch.instrument.params)}\nMacros: ${[1, 2, 3, 4].map((i) => `${i}${info ? ` (${info.macros[i - 1]})` : ''} = ${ch.instrument.params[`macro${i}`]}`).join(', ')}\nModulation slots used: ${routes.length}/${MOD_SLOTS}`);
  });

  tool('update_synth_patch', {
    title: 'Apply a patch document',
    description: 'Apply a whole or partial patch document to a GGS Synth channel in one edit: any of oscillators, sub, noise, filters, filterRouting, envelopes, lfos, macros, modulation (replaces ALL routes), voice { level, velocity, releaseVelocity, polyphony, mono, legato, glide, bendRange, quality, gain }, effects. Also loads a preset first when preset is given. Everything is validated before anything changes.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      preset: z.enum(Object.keys(GGS_PRESETS)).optional().describe('Load this preset first (resets the patch)'),
      patch: z.record(z.string(), z.any()).optional().describe('Patch document sections')
    },
    annotations: A.edit
  }, async ({ projectId, channel, preset, patch }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    if (!preset && !patch) throw new Error('Give a preset and/or a patch document');
    const params = patch ? validate(patchToParams(patch)) : undefined;
    const after = await backend.applyOps(p.id, [{ type: 'channel/update', id: ch.id, patch: { instrument: { ...(preset && { preset }), ...(params && { params }) } } }]);
    const now = after.channels.find((c) => c.id === ch.id);
    return ok(`Updated the patch of "${now.name}" [${now.id}]${preset ? ` (preset ${preset})` : ''}:\n${summarizePatch(now.instrument.params)}`);
  });

  tool('set_synth_oscillator', {
    title: 'Set a synth oscillator',
    description: 'Configure oscillator A, B or C of a GGS Synth: wavetable and position, level, pan, tuning, unison, warp and FM (phase modulation from another oscillator, the sub or noise), and which filter it feeds. Also sets the sub oscillator and the noise source. Only the fields you give change.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      oscillator: z.enum(OSC_IDS).optional().describe('Which oscillator the fields below belong to'),
      ...oscFields,
      sub: z.object({ level: unit.optional(), wave: z.enum(SUB_WAVES).optional(), octave: z.number().int().min(-3).max(0).optional(), to: z.enum(SOURCE_DESTS).optional() }).optional().describe('Sub oscillator (below the note; "direct" keeps it clean under a filtered sound)'),
      noise: z.object({ level: unit.optional(), type: z.enum(NOISE_TYPES).optional(), color: z.number().min(-1).max(1).optional().describe('-1 dark … 1 thin'), to: z.enum(SOURCE_DESTS).optional() }).optional()
    },
    annotations: A.edit
  }, async ({ projectId, channel, oscillator, sub, noise, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(given).length && !oscillator) throw new Error('Say which oscillator: "A", "B" or "C"');
    // switching a table on implies the oscillator should sound
    if (oscillator && given.on === undefined && Object.keys(given).length && !ch.instrument.params[`osc${oscillator}On`]) given.on = true;
    const params = { ...(oscillator ? sectionToParams('oscillator', oscillator, given) : {}), ...(sub ? sectionToParams('sub', null, sub) : {}), ...(noise ? sectionToParams('noise', null, noise) : {}) };
    return applyParams(p, ch, params, `Set ${[oscillator && `oscillator ${oscillator}`, sub && 'sub', noise && 'noise'].filter(Boolean).join(', ')}`);
  });

  tool('set_synth_filter', {
    title: 'Set a synth filter',
    description: 'Configure filter 1 or 2 of a GGS Synth (type, cutoff in Hz, resonance, drive, key tracking) and how the two are connected. Types: lp12/lp24 low-pass, hp12/hp24 high-pass, bp12/bp24 band-pass, notch, peak, comb (cutoff = the comb\'s pitch: with keyTrack 1 and cutoff 261.63 it is tuned to the note — plucked and metallic sounds). Sweep a filter per note with set_synth_modulation (target f1Cutoff / f2Cutoff, 1 = 10 octaves).',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      filter: z.union([z.literal(1), z.literal(2)]).optional().describe('Which filter the fields below belong to (default 1)'),
      on: z.boolean().optional(),
      type: z.enum(FILTER_TYPES).optional(),
      cutoff: z.number().min(20).max(20000).optional().describe('Hz'),
      resonance: unit.optional().describe('0 = none, 0.3 = a clear peak, 0.8+ = whistling'),
      drive: unit.optional().describe('Saturation into the filter (adds harmonics and weight)'),
      keyTrack: unit.optional().describe('1 = the cutoff follows the note (and its pitch curve)'),
      routing: z.enum(FILTER_ROUTES).optional().describe('serial: filter 1 → filter 2; parallel: side by side')
    },
    annotations: A.edit
  }, async ({ projectId, channel, filter = 1, routing, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (given.on === undefined && Object.keys(given).length && !ch.instrument.params[`f${filter}On`]) given.on = true;
    return applyParams(p, ch, { ...sectionToParams('filter', filter, given), ...(routing ? { filterRoute: routing } : {}) }, `Set filter ${filter}`);
  });

  tool('set_synth_envelope', {
    title: 'Set a synth envelope',
    description: 'Shape one of the four envelopes of a GGS Synth: attack, decay, release in seconds, sustain 0..1, curve (-1 linear … 1 very exponential). Envelope 1 is the amp envelope (it ends the note); envelopes 2-4 do nothing until routed with set_synth_modulation (e.g. env2 → f1Cutoff).',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      envelope: z.number().int().min(1).max(4).describe('1 = amp envelope'),
      attack: z.number().min(0.001).max(10).optional(),
      decay: z.number().min(0.005).max(10).optional(),
      sustain: unit.optional(),
      release: z.number().min(0.005).max(15).optional(),
      curve: z.number().min(-1).max(1).optional()
    },
    annotations: A.edit
  }, async ({ projectId, channel, envelope, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    return applyParams(p, ch, sectionToParams('envelope', envelope, fields), `Set envelope ${envelope}`);
  });

  tool('set_synth_lfo', {
    title: 'Set a synth LFO',
    description: 'Configure one of the four LFOs of a GGS Synth: shape (sine, triangle, saw, ramp, square, sh = random steps, smooth = random glide), rate in Hz or a tempo division (sync), trigger "note" (restarts with every note: per-note vibrato) or "free" (one clock shared by all notes, repeatable in renders: rhythmic wobbles, slow pad movement), fade-in time and start phase. An LFO does nothing until routed with set_synth_modulation.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      lfo: z.number().int().min(1).max(4),
      shape: z.enum(LFO_SHAPES).optional(),
      rate: z.number().min(0.01).max(50).optional().describe('Hz (used when sync is "off")'),
      sync: z.enum(LFO_SYNC).optional().describe('Tempo-synced length of one cycle, e.g. "1/8", "1/4d", "2bar"; "off" = use rate'),
      trigger: z.enum(LFO_TRIGGERS).optional(),
      fade: z.number().min(0).max(5).optional().describe('Seconds until it reaches full depth (delayed vibrato)'),
      phase: unit.optional()
    },
    annotations: A.edit
  }, async ({ projectId, channel, lfo, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    return applyParams(p, ch, sectionToParams('lfo', lfo, fields), `Set LFO ${lfo}`);
  });

  const routeSchema = z.object({
    source: z.enum(MOD_SOURCES.filter((s) => s !== 'none')),
    target: z.enum(MOD_TARGETS.filter((s) => s !== 'none')),
    amount: z.number().min(-1).max(1).describe('1 = the whole range of the target (see describe_synth topic "modulation")'),
    via: z.enum(MOD_SOURCES.filter((s) => s !== 'none')).optional().describe('Scale the route by a second source, e.g. LFO → pitchFine via pressure')
  });

  tool('set_synth_modulation', {
    title: 'Set synth modulation routes',
    description: 'Connect modulation sources to targets in a GGS Synth\'s matrix (16 routes): envelopes, LFOs, velocity, the note\'s pressure / timbre (slide) / bend curves, key, random, release velocity and the 4 macros → pitch, oscillator position/level/pan/warp/FM/detune, filter cutoff/resonance/drive, level, pan, LFO rates. mode "add" (default) adds routes, updating an existing route with the same source, target and via; "replace" replaces the whole matrix. remove deletes routes by source+target. macros sets the four macro values. This is how per-note expression becomes sound: e.g. pressure → f1Cutoff 0.3, timbre → oscAPos 0.5.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      routes: z.array(routeSchema).max(MOD_SLOTS).optional(),
      mode: z.enum(['add', 'replace']).optional(),
      remove: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
      macros: z.array(unit).max(4).optional().describe('Values of macros 1-4')
    },
    annotations: A.edit
  }, async ({ projectId, channel, routes = [], mode = 'add', remove = [], macros }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    if (!routes.length && !remove.length && !macros && mode !== 'replace') throw new Error('Give routes, remove and/or macros');
    for (const r of routes) checkRoute(r);
    let list = mode === 'replace' ? [] : modulationRoutes(ch.instrument.params).map(({ slot: _slot, ...r }) => r);
    for (const r of remove) {
      const before = list.length;
      list = list.filter((x) => !(x.source === r.source && x.target === r.target));
      if (list.length === before) throw new Error(`No route ${r.source} → ${r.target} to remove. Routes: ${list.map((x) => `${x.source}→${x.target}`).join(', ') || 'none'}`);
    }
    for (const r of routes) {
      const same = list.find((x) => x.source === r.source && x.target === r.target && (x.via || null) === (r.via || null));
      if (same) same.amount = r.amount;
      else list.push({ ...r });
    }
    if (list.length > MOD_SLOTS) throw new Error(`That makes ${list.length} routes; a patch has ${MOD_SLOTS}. Remove some first (get_synth_patch lists them).`);
    const params = { ...routesToParams(list), ...Object.fromEntries((macros || []).map((v, i) => [`macro${i + 1}`, v])) };
    return applyParams(p, ch, params, 'Set the modulation');
  });

  tool('set_synth_effect', {
    title: 'Set synth effects',
    description: 'The GGS Synth\'s built-in effects, after its voices are summed: drive (soft, hard, tube, fold), chorus, tempo-synced delay and reverb — plus the output gain. A mix of 0 turns an effect off. (Mixer insert effects — EQ, compressor, sidechain pump… — are separate: add_effect.)',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      drive: z.object({ amount: unit.optional(), type: z.enum(DRIVE_TYPES).optional() }).optional(),
      chorus: z.object({ mix: unit.optional(), rate: z.number().min(0.05).max(5).optional().describe('Hz'), depth: unit.optional() }).optional(),
      delay: z.object({
        mix: unit.optional(), sync: z.enum(DELAY_SYNC).optional().describe('Tempo division, or "free" to use time'), time: z.number().min(1).max(2000).optional().describe('ms (sync "free")'),
        feedback: z.number().min(0).max(0.95).optional(), tone: z.number().min(200).max(20000).optional().describe('Hz: how dark the repeats get'), pingPong: z.boolean().optional()
      }).optional(),
      reverb: z.object({ mix: unit.optional(), size: unit.optional().describe('0 = small room (0.4 s) … 1 = huge hall (12 s)'), damping: unit.optional() }).optional(),
      gain: z.number().min(0).max(2).optional().describe('Output gain of the patch'),
      quality: z.enum(QUALITIES).optional().describe('auto (default): 2× oversampling only where the patch can alias; high: always; eco: never')
    },
    annotations: A.edit
  }, async ({ projectId, channel, drive, chorus, delay, reverb, gain, quality }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const params = {
      ...(drive ? sectionToParams('drive', null, drive) : {}), ...(chorus ? sectionToParams('chorus', null, chorus) : {}),
      ...(delay ? sectionToParams('delay', null, delay) : {}), ...(reverb ? sectionToParams('reverb', null, reverb) : {}),
      ...(gain !== undefined ? { gain } : {}), ...(quality ? { quality } : {})
    };
    return applyParams(p, ch, params, 'Set the effects');
  });

  tool('analyze_synth_patch', {
    title: 'Analyse a GGS Synth patch',
    description: 'Render a note or chord of a GGS Synth channel right here (no browser needed) and measure it: detected pitch, loudness (LUFS) and peak, spectrum balance and brightness, attack and decay times. Optionally with a performance — pitch / pressure / timbre curves applied to every note — and macro values, to hear what expression does to the sound (compare two calls). Measures the instrument itself, before the channel strip and mixer; use analyze_sound or render_mix for the sound in the mix.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      notes: z.array(z.union([z.string(), z.number()])).min(1).max(8).optional().describe('Notes to play together, e.g. ["C3","G3","E4"] (default: C4, or C2 for a bass preset)'),
      velocity: z.number().min(0).max(127).optional().describe('0..1 or MIDI 2..127 (default 0.8)'),
      noteSeconds: z.number().min(0.05).max(8).optional().describe('How long the notes are held (default 1.5)'),
      seconds: z.number().min(0.2).max(12).optional().describe('How long to render (default: the notes plus their release, at most 12)'),
      pitch: curveArg.optional(), pressure: curveArg.optional(), timbre: curveArg.optional(),
      macros: z.array(unit).max(4).optional().describe('Macro values for this render (default: the patch\'s own)')
    },
    annotations: A.readOnly
  }, async (a) => {
    const p = await load(a.projectId);
    const ch = ggsChannel(p, a.channel);
    const params = { ...ggsDefaults(), ...ch.instrument.params };
    const info = GGS_PRESET_INFO[ch.instrument.preset];
    const keys = (a.notes || [info?.test?.key ?? 60]).map((n) => parseNote(n) + Math.round(ch.pitch || 0));
    const velocity = normVelocity(a.velocity, 0.8);
    if (velocity <= 0) throw new Error('Velocity 0 is silent: use 0.05–1 (or MIDI 2–127)');
    const duration = a.noteSeconds ?? 1.5;
    const curves = buildExpression(a, duration);
    const breakpoints = Object.fromEntries(EXPRESSION_DIMS.filter((d) => curves[d]).map((d) => [d, flattenCurve(curves[d]).map((pt) => ({ t: pt.t * duration, v: pt.v }))]));
    const macros = a.macros ? [0, 1, 2, 3].map((i) => a.macros[i] ?? params[`macro${i + 1}`]) : null;
    const seconds = Math.min(12, a.seconds ?? duration + Math.min(6, releaseTail(params, 0.5)) + 0.6);
    const r = await renderInWorker({
      params, bpm: p.bpm, sampleRate: 44100, seconds, macros,
      notes: keys.map((key, i) => ({ key, velocity, start: 0.02, duration, seed: i + 1, ...breakpoints }))
    });
    const x = r.analysis;
    const b = x.spectrum?.bandsPercent || {};
    const t = (v) => (v === null || v === undefined ? 'longer than the render' : `${v} ms`);
    const lines = [
      `GGS PATCH "${ch.name}" — ${keys.map(noteName).join(' ')} at velocity ${Math.round(velocity * 100) / 100}, held ${duration}s${Object.keys(breakpoints).length ? `, with ${Object.keys(breakpoints).join(' + ')} curve(s)` : ''}${macros ? `, macros ${macros.join('/')}` : ''}`,
      `Level: ${x.lufs} LUFS (loudest 400 ms ${x.momentaryMaxLufs}), peak ${x.peakDb} dBFS, crest ${x.crestDb} dB`,
      x.pitch ? `Pitch: ${x.pitch.note} (${x.pitch.hz} Hz, ${x.pitch.cents > 0 ? '+' : ''}${x.pitch.cents} cents)` : 'Pitch: no single clear pitch (a chord, noise or strong modulation)',
      `Spectrum: ${x.spectrum?.brightness}, ${x.spectrum?.tonality} (centroid ${x.spectrum?.centroidHz} Hz); sub ${b.sub}% · low ${b.low}% · low-mid ${b.lowMid}% · mid ${b.mid}% · high-mid ${b.highMid}% · high ${b.high}%`,
      `Envelope: attack ${t(r.envelope.attackMs)}, -20 dB after ${t(r.envelope.decay20Ms)}, -40 dB after ${t(r.envelope.decay40Ms)}; sound lasts ${Math.round(r.audibleSeconds * 100) / 100}s`,
      x.stereo ? `Stereo width: ${x.stereo.width}` : '',
      describeAnalysis(x)
    ].filter(Boolean);
    if (x.peakDb > -1) lines.push('The patch alone nearly clips: lower its gain (set_synth_effect gain) — presets sit near -18 LUFS per note.');
    return ok(lines.join('\n'), { lufs: x.lufs, momentaryMaxLufs: x.momentaryMaxLufs, peakDb: x.peakDb, pitch: x.pitch, spectrum: x.spectrum, envelope: r.envelope, stereoWidth: x.stereo?.width ?? null });
  });
}

/** Render + analyse in a worker thread (see ../../synth-worker.js). */
function renderInWorker(data, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../synth-worker.js', import.meta.url), { workerData: data });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('The render took too long: fewer notes, a shorter render or quality "eco"')); }, timeoutMs);
    worker.once('message', (m) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.ok) resolve(m);
      else reject(new Error(`Could not render the patch: ${m.error}`));
    });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
