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
  routesToParams, checkRoute, summarizePatch, ggsDefaults, releaseTail, FILTER_INFO, filterResponse, migrateParams,
  MACRO_COUNT, CHAOS_COUNT, CHAOS_TYPES, CHAOS_INFO, CHAOS_PATHS, chaosPreview, macroLabel, macroUsed, LFO_STEPS
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
    description: 'What the GGS Synth can do, for sound design: its sections and every field with range, default and what it does (topic "parameters"), the 21 filter models and what each sounds like ("filters"), the wavetables ("wavetables"), modulation sources and targets, the chaos generators and what an amount of 1 means ("modulation"), and the preset library with macro assignments ("presets"). Read "overview" first.',
    inputSchema: { topic: z.enum(['overview', 'parameters', 'filters', 'wavetables', 'modulation', 'presets']).optional().describe('Default: overview') },
    annotations: A.readOnly
  }, async ({ topic = 'overview' }) => {
    if (topic === 'parameters') return ok('GGS Synth fields by section (as used by the set_synth_* tools and patch documents):', describeSynth());
    if (topic === 'filters') {
      return ok([
        `Filter models (${FILTER_TYPES.length}) for set_synth_filter "type". cutoff is in Hz, resonance / drive / morph 0..1; "morph" only does something where noted.`,
        'Analog-style models (ladder, acid, ms20) and the combs saturate, so quality "auto" renders them at 2× the sample rate.',
        ...FILTER_TYPES.map((id) => `  ${id.padEnd(9)} ${FILTER_INFO[id].label}${FILTER_INFO[id].morph ? ` [morph = ${FILTER_INFO[id].morph.toLowerCase()}]` : ''}: ${FILTER_INFO[id].desc}`),
        '',
        'set_synth_filter replies with the measured response of the setting, so you can see what a cutoff/resonance really does.'
      ].join('\n'));
    }
    if (topic === 'wavetables') return ok(`Wavetables (${WAVETABLE_IDS.length}) — "position" scans a table from its first frame (0) to its last (1):\n${describeWavetables().map((t) => `  ${t.id.padEnd(10)} ${t.name} (${t.frames} frames): ${t.description}`).join('\n')}`);
    if (topic === 'modulation') {
      return ok([
        `Modulation matrix: ${MOD_SLOTS} routes, each source → target × amount (-1..1), optionally × a second source ("via": e.g. vibrato depth via pressure).`,
        'An amount of 1 moves the target across its whole range when the source is at 1.',
        '', 'SOURCES:', ...MOD_SOURCES.filter((s) => s !== 'none').map((s) => `  ${s.padEnd(11)} ${MOD_SOURCE_INFO[s]}`),
        '', 'TARGETS:', ...MOD_TARGETS.filter((s) => s !== 'none').map((s) => `  ${s.padEnd(12)} ${MOD_TARGET_INFO[s]}`),
        '', `Envelope 1 always shapes the level. Pressure, timbre (slide) and bend come from each note (set_note_expression); velocity from the note; macros 1-${MACRO_COUNT} from the channel (automatable: add_automation target channel param macro1..macro${MACRO_COUNT}).`,
        '', `CHAOS (set_synth_chaos; sources chaos1..chaos${CHAOS_COUNT}) — modulation that never quite repeats. "character" 0..1 means something different for each:`,
        ...CHAOS_TYPES.map((t) => `  ${t.padEnd(8)} rate = ${CHAOS_INFO[t].rate}; character = ${CHAOS_INFO[t].character.toLowerCase()}. ${CHAOS_INFO[t].desc}`),
        '  path "note": every note wanders its own way (voices drift apart, renders still repeat exactly). path "same": every note replays one path from its start (a chord moves together).',
        '  turing + a tempo division (sync) + path "same" is the exception: the pattern is locked to the song. Every note hears the step of that moment, steps fall on the grid, and bar 9 always sounds like bar 9 — in playback and in an export. character 0 = one loop for the whole song; above 0 it mutates as the song goes on (the same way every time).'
      ].join('\n'));
    }
    if (topic === 'presets') {
      const lines = GGS_PRESET_CATEGORIES.map(([cat, label]) => `## ${label}\n${Object.keys(GGS_PRESETS).filter((n) => GGS_PRESET_INFO[n]?.category === cat).map((n) => `  ${n}: ${GGS_PRESET_INFO[n].description}\n      macros: ${GGS_PRESET_INFO[n].macros.join(' · ')}\n      expression: ${GGS_PRESET_INFO[n].expression}`).join('\n')}`);
      return ok(`GGS Synth presets (create_synth_patch preset "<name>"); "Init" is the blank patch.\n\n${lines.join('\n\n')}`);
    }
    return ok([
      'GGS SYNTH — a wavetable / FM hybrid synthesizer (instrument kind "ggs"). Signal path per note:',
      '  oscillators A, B, C (wavetable, unison, warp, FM from another source) + sub + noise',
      `  → filter 1 / filter 2 (serial or parallel; ${FILTER_TYPES.length} models: clean lp/hp/bp 12 or 24 dB, notch, peak, all-pass, morph · analog-style ladder, acid, MS-20 · formant, phaser, combs; drive, key tracking, morph — topic "filters")`,
      '  → amp (envelope 1 × velocity) → channel effects: drive → chorus → delay → reverb → gain',
      `Movement: 4 envelopes (delay, attack, hold, decay, sustain, release, with a curve per stage), 4 LFOs (Hz or tempo-synced; per note or free-running), ${CHAOS_COUNT} chaos generators (Lorenz, Rössler, drift, Turing machine: movement that never loops), ${MACRO_COUNT} macros and a ${MOD_SLOTS}-route modulation matrix.`,
      'Every note has its own pitch curve, pressure and slide (timbre): route pressure/timbre in the matrix to make them audible (set_note_expression writes the curves).',
      '',
      'Workflow: create_synth_patch (preset or blank) → set_synth_oscillator / set_synth_filter / set_synth_envelope / set_synth_lfo / set_synth_chaos / set_synth_modulation / set_synth_effect → analyze_synth_patch (renders a note or chord here and measures pitch, loudness, spectrum, envelope) → adjust. get_synth_patch reads a patch back; update_synth_patch applies a whole patch document.',
      'Topics: "parameters" (every field, its range and what it does), "filters", "wavetables", "modulation" (sources, targets, amounts), "presets".',
      '',
      'Sound-design starting points:',
      '  pad: 2 oscillators, unison 3-5, detune 10-25 ct, lp24 800-2000 Hz, envelope 1 attack 0.4-1.5 s release 1.5-4 s, slow free LFO → oscillator position, chorus + reverb',
      '  bass: phaseRandom 0, sub level 0.3-0.6 to "direct", lp24 or ladder24 200-800 Hz with envelope 2 → f1Cutoff 0.3-0.45, mono + glide 0.03-0.08 s',
      '  acid line: one saw, filter "acid" cutoff 300-600 Hz resonance 0.75-0.95 drive 0.3-0.5, envelope 2 (decay 0.15-0.3 s, decayCurve -0.6) → f1Cutoff 0.3 (more via velocity for accents), mono + legato + glide 0.06 s',
      '  vowels / talking: a saw or pulse into filter "formant" (cutoff 1000, keyTrack 0), timbre or an LFO → f1Morph',
      '  pluck/keys: envelope 1 sustain 0 decay 0.3-3 s, envelope 2 (short) → oscillator position or f1Cutoff, velocity → f1Cutoff 0.15',
      '  lead: mono or poly, pressure → f1Cutoff 0.3, LFO → pitchFine 0.3 via pressure (vibrato you play), timbre → oscAPos',
      '  FM bell: oscillator B (sine: table basic position 0, level 0) as fmFrom of A, fm 0.2-0.4, envelope 2 → oscAFm',
      '  analog life: chaos type "drift" (rate 0.2-0.5, path "note") → pitchFine 0.04-0.08 and → oscADetune 0.05: every voice wanders a few cents on its own',
      '  evolving pad: chaos "lorenz" (rate 0.05-0.2, path "same") → oscAPos 0.2 and → f1Cutoff 0.08: motion that never loops, the chord moving as one'
    ].join('\n'));
  });

  tool('create_synth_patch', {
    title: 'Create a GGS Synth channel',
    description: 'Add a GGS Synth channel with its own mixer insert: start from a preset (describe_synth topic "presets") or from the blank Init patch, optionally overlaid with a patch document (any subset of: oscillators [{ id: "A", table, position, … }], sub, noise, filters [{ id: 1, type, cutoff, … }], filterRouting, envelopes, lfos, chaos [{ id: 1, type, rate, character, … }], macros [up to 8 values], modulation [{ source, target, amount, via }] (up to 64 routes), voice, effects { drive, chorus, delay, reverb }). Replies with the channel id and the patch.',
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
    return ok(`GGS Synth "${ch.name}" [${ch.id}] — started from preset ${ch.instrument.preset}\n${summarizePatch(ch.instrument.params)}\nMacros: ${Array.from({ length: MACRO_COUNT }, (_, k) => k + 1).filter((i) => i <= 4 || macroUsed(ch.instrument.params, i)).map((i) => `${i} (${macroLabel(ch.instrument.params, i, info?.macros)}) = ${ch.instrument.params[`macro${i}`]}`).join(', ')}\nModulation slots used: ${routes.length}/${MOD_SLOTS}`);
  });

  tool('update_synth_patch', {
    title: 'Apply a patch document',
    description: 'Apply a whole or partial patch document to a GGS Synth channel in one edit: any of oscillators, sub, noise, filters, filterRouting, envelopes, lfos, chaos, macros, modulation (replaces ALL routes), voice { level, velocity, releaseVelocity, polyphony, mono, legato, glide, quality, gain }, effects. Also loads a preset first when preset is given. Everything is validated before anything changes.',
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
    description: 'Configure filter 1 or 2 of a GGS Synth (type, cutoff in Hz, resonance, drive, key tracking, morph) and how the two are connected. Types — clean: lp12/lp24, hp12/hp24, bp12/bp24, notch, peak, allpass, morph (morph 0 low-pass → 0.5 band-pass → 1 high-pass); analog-style: ladder24/ladder12/ladderBp/ladderHp (warm, self-oscillates above resonance ~0.9), acid (TB-303 diode ladder), ms20Lp/ms20Hp (screaming, keeps its bass); special: formant (morph = vowel A-E-I-O-U, cutoff 1000 = natural), phaser (morph = stages), comb/combNeg (cutoff = the comb\'s pitch: with keyTrack 1 and cutoff 261.63 it is tuned to the note; resonance = ring time, morph = damping). describe_synth topic "filters" says what each sounds like. The reply includes the measured frequency response of the new setting. Sweep a filter per note with set_synth_modulation (targets f1Cutoff / f2Cutoff, 1 = 10 octaves; f1Morph / f2Morph).',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      filter: z.union([z.literal(1), z.literal(2)]).optional().describe('Which filter the fields below belong to (default 1)'),
      on: z.boolean().optional(),
      type: z.enum(FILTER_TYPES).optional(),
      cutoff: z.number().min(20).max(20000).optional().describe('Hz'),
      resonance: unit.optional().describe('0 = none, 0.3 = a clear peak, 0.8+ = whistling'),
      drive: unit.optional().describe('Saturation into the filter (adds harmonics and weight)'),
      keyTrack: unit.optional().describe('1 = the cutoff follows the note (and its pitch curve)'),
      morph: unit.optional().describe('Second control of morph (shape), formant (vowel), phaser (stages) and the combs (damping); ignored by the other types'),
      routing: z.enum(FILTER_ROUTES).optional().describe('serial: filter 1 → filter 2; parallel: side by side')
    },
    annotations: A.edit
  }, async ({ projectId, channel, filter = 1, routing, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (given.on === undefined && Object.keys(given).length && !ch.instrument.params[`f${filter}On`]) given.on = true;
    const reply = await applyParams(p, ch, { ...sectionToParams('filter', filter, given), ...(routing ? { filterRoute: routing } : {}) }, `Set filter ${filter}`);
    // what the setting does, measured on the filter itself (small signal, at its base cutoff: no modulation, no key tracking)
    const now = { ...ch.instrument.params, ...sectionToParams('filter', filter, given) };
    if (!now[`f${filter}On`]) return reply; // an off filter does nothing: no curve to report
    const type = now[`f${filter}Type`];
    const freqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const info = {};
    const db = filterResponse({ type, cutoff: now[`f${filter}Cutoff`], resonance: now[`f${filter}Res`], drive: now[`f${filter}Drive`], morph: now[`f${filter}Morph`] }, freqs, { maxSeconds: 1, info });
    const hz = Math.round(now[`f${filter}Cutoff`]);
    if (!info.decayed && ['ladder', 'acid', 'ms20'].includes(FILTER_INFO[type].family)) {
      // a filter that oscillates by itself has no frequency response to speak of
      reply.content[0].text += `\nFilter ${filter} (${type}) at resonance ${now[`f${filter}Res`]} self-oscillates (or rings for seconds): it sounds a tone of its own at about ${hz} Hz${now[`f${filter}Key`] >= 0.99 ? ', following the notes' : ' (key track 1 makes it follow the notes)'}. Lower the resonance for a filter that only shapes the sound.`;
    } else {
      reply.content[0].text += `\nMeasured response of filter ${filter} (${type}): ${freqs.map((f, i) => `${f >= 1000 ? `${f / 1000}k` : f} Hz ${db[i] > 0 ? '+' : ''}${Math.max(-99, Math.round(db[i] * 10) / 10)} dB`).join(' · ')}${info.decayed ? '' : ' (still ringing after a second: its peaks are taller and narrower than these numbers)'}`;
    }
    return reply;
  });

  tool('set_synth_envelope', {
    title: 'Set a synth envelope',
    description: 'Shape one of the four envelopes of a GGS Synth: delay, attack, hold, decay, release in seconds, sustain 0..1, and a curve per moving stage (-1..1: 0 = straight line, negative = fastest at the start — a punchy attack, a natural plucky decay —, positive = slow start that rushes at the end). Defaults: attackCurve -0.3, decayCurve and releaseCurve -0.5. Envelope 1 is the amp envelope (it ends the note); envelopes 2-4 do nothing until routed with set_synth_modulation (e.g. env2 → f1Cutoff).',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      envelope: z.number().int().min(1).max(4).describe('1 = amp envelope'),
      delay: z.number().min(0).max(5).optional().describe('Seconds at zero before the attack starts'),
      attack: z.number().min(0.001).max(10).optional(),
      hold: z.number().min(0).max(5).optional().describe('Seconds at full level before the decay (the body of a pluck or kick)'),
      decay: z.number().min(0.005).max(10).optional(),
      sustain: unit.optional(),
      release: z.number().min(0.005).max(15).optional(),
      attackCurve: z.number().min(-1).max(1).optional().describe('0 straight · negative fast first (punchy) · positive slow first (swell)'),
      decayCurve: z.number().min(-1).max(1).optional().describe('0 straight · negative drops fast then settles (pluck; -1 very sharp) · positive holds on, then falls'),
      releaseCurve: z.number().min(-1).max(1).optional().describe('Like decayCurve, for the tail after the key is let go'),
      curve: z.number().min(-1).max(1).optional().describe('Older shorthand for all three curves at once (-1 gentle … 1 very sharp); the per-stage curves win when both are given')
    },
    annotations: A.edit
  }, async ({ projectId, channel, envelope, curve, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const params = { ...(curve !== undefined ? migrateParams({ [`env${envelope}Curve`]: curve }) : {}), ...sectionToParams('envelope', envelope, given) };
    return applyParams(p, ch, params, `Set envelope ${envelope}`);
  });

  tool('set_synth_lfo', {
    title: 'Set a synth LFO',
    description: 'Configure one of the four LFOs of a GGS Synth: shape (sine, triangle, saw, ramp, square, sh = random steps, smooth = random glide, steps = a shape you write as a list of 2-16 heights: a step sequencer, or a drawn curve with smooth > 0), rate in Hz or a tempo division (sync), trigger "note" (restarts with every note: per-note vibrato) or "free" (one clock shared by all notes, repeatable in renders: rhythmic wobbles, slow pad movement), fade-in time and start phase. An LFO does nothing until routed with set_synth_modulation.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      lfo: z.number().int().min(1).max(4),
      shape: z.enum(LFO_SHAPES).optional(),
      rate: z.number().min(0.01).max(50).optional().describe('Hz (used when sync is "off")'),
      sync: z.enum(LFO_SYNC).optional().describe('Tempo-synced length of one cycle, e.g. "1/8", "1/4d", "2bar"; "off" = use rate'),
      trigger: z.enum(LFO_TRIGGERS).optional(),
      fade: z.number().min(0).max(5).optional().describe('Seconds until it reaches full depth (delayed vibrato)'),
      phase: unit.optional(),
      steps: z.array(z.number().min(-1).max(1)).min(2).max(LFO_STEPS).optional().describe('The drawn shape: one cycle plays these heights in order, e.g. [1, 0, 0.5, 0, 1, -1, 0.5, 0] with sync "1bar" is an eighth-note pattern. Giving steps selects shape "steps" unless shape says otherwise'),
      smooth: unit.optional().describe('For shape "steps": 0 = hard steps, 1 = each step glides into the next')
    },
    annotations: A.edit
  }, async ({ projectId, channel, lfo, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (given.steps && !given.shape) given.shape = 'steps';
    return applyParams(p, ch, sectionToParams('lfo', lfo, given), `Set LFO ${lfo}`);
  });

  tool('set_synth_chaos', {
    title: 'Set a synth chaos source',
    description: 'Configure one of the two chaos generators of a GGS Synth — modulation that never quite repeats: "lorenz" (swings between two centres and flips unpredictably), "rossler" (a wobbling loop that lurches), "drift" (a random walk that comes home: analog pitch drift) or "turing" (a looping pattern of steps that mutates — generative sequences). rate in Hz or a tempo division (sync); character 0..1 (lorenz: calm … restless · rossler: nearly periodic … spiky · drift: jittery … smooth · turing: chance that a step mutates, 0 = a locked loop); steps = turing loop length; path "note" (default: every note wanders its own way, like analog voices) or "same" (every note replays one path from its start: chords move together). One exception: "turing" with a tempo division and path "same" is locked to the song instead — every note hears the step of that moment, on the grid, the same in playback and in an export: a step sequence. A chaos source does nothing until routed with set_synth_modulation (source chaos1 / chaos2). Renders repeat exactly: a path is fixed by its note. The reply sketches the path.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      chaos: z.number().int().min(1).max(CHAOS_COUNT),
      type: z.enum(CHAOS_TYPES).optional(),
      rate: z.number().min(0.01).max(50).optional().describe('Hz (used when sync is "off"): swings, orbits or steps per second'),
      sync: z.enum(LFO_SYNC).optional().describe('Tempo-synced length of one swing / orbit / step, e.g. "1/16", "1bar"; "off" = use rate'),
      character: unit.optional().describe('What kind of chaos (see the description); default 0.5'),
      steps: z.number().int().min(2).max(32).optional().describe('turing only: loop length'),
      path: z.enum(CHAOS_PATHS).optional()
    },
    annotations: A.edit
  }, async ({ projectId, channel, chaos, ...fields }) => {
    const p = await load(projectId);
    const ch = ggsChannel(p, channel);
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const reply = await applyParams(p, ch, sectionToParams('chaos', chaos, given), `Set chaos ${chaos}`);
    const now = { ...ch.instrument.params, ...sectionToParams('chaos', chaos, given) };
    const type = now[`chaos${chaos}Type`];
    // twelve cycles of the path as a row of levels, so the shape of the movement can be read
    const sketch = Array.from(chaosPreview({ type, character: now[`chaos${chaos}Char`], steps: now[`chaos${chaos}Steps`] }, 48, 12), (v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v + 1) * 4))]).join('');
    const routed = modulationRoutes(now).some((r) => r.source === `chaos${chaos}` || r.via === `chaos${chaos}`);
    reply.content[0].text += `\nChaos ${chaos} (${type}; rate = ${CHAOS_INFO[type].rate}) over 12 cycles: ${sketch}${routed ? '' : `\nNot routed yet: add a route with set_synth_modulation (source chaos${chaos}), e.g. chaos${chaos} → ${type === 'drift' ? 'pitchFine 0.06' : type === 'turing' ? 'f1Cutoff 0.15' : 'oscAPos 0.2'}.`}`;
    return reply;
  });

  const routeSchema = z.object({
    source: z.enum(MOD_SOURCES.filter((s) => s !== 'none')),
    target: z.enum(MOD_TARGETS.filter((s) => s !== 'none')),
    amount: z.number().min(-1).max(1).describe('1 = the whole range of the target (see describe_synth topic "modulation")'),
    via: z.enum(MOD_SOURCES.filter((s) => s !== 'none')).optional().describe('Scale the route by a second source, e.g. LFO → pitchFine via pressure')
  });

  tool('set_synth_modulation', {
    title: 'Set synth modulation routes',
    description: 'Connect modulation sources to targets in a GGS Synth\'s matrix (64 routes): envelopes, LFOs, chaos generators, velocity, the note\'s pressure / timbre (slide) / bend curves, key, random, release velocity and the 8 macros → pitch, oscillator position/level/pan/warp/FM/detune, filter cutoff/resonance/drive/morph, level, pan, LFO rates. The reply says what every route does in the units of its target (e.g. "Filter 1 cutoff 850 Hz → 4.49 kHz as pressure goes 0 → 1"). mode "add" (default) adds routes, updating an existing route with the same source, target and via; "replace" replaces the whole matrix. remove deletes routes by source+target. macros sets macro values (up to 8, in order). This is how per-note expression becomes sound: e.g. pressure → f1Cutoff 0.3, timbre → oscAPos 0.5.',
    inputSchema: {
      projectId: projectIdArg, channel: channelArg,
      routes: z.array(routeSchema).max(MOD_SLOTS).optional(),
      mode: z.enum(['add', 'replace']).optional(),
      remove: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
      macros: z.array(unit).max(MACRO_COUNT).optional().describe('Values of the macros, from macro 1 (a shorter list leaves the rest alone)')
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
      macros: z.array(unit).max(MACRO_COUNT).optional().describe('Macro values for this render, from macro 1 (default: the patch\'s own)')
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
    const macros = a.macros ? Array.from({ length: MACRO_COUNT }, (_, i) => a.macros[i] ?? params[`macro${i + 1}`]) : null;
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
    // silence has reasons a measurement cannot name by itself
    if (!(x.peakDb > -90)) {
      if (params.env1Delay >= duration) lines.push(`Silent because envelope 1 (the amp envelope) waits ${params.env1Delay} s before it starts and the note is only ${duration} s long: shorten its delay (set_synth_envelope envelope 1 delay) or hold the note longer (noteSeconds).`);
      else if (params.level <= 0 && !modulationRoutes(params).some((r) => r.target === 'level')) lines.push('Silent because the voice level is 0 and nothing is routed to "level".');
      else if (params.gain <= 0) lines.push('Silent because the output gain is 0 (set_synth_effect gain).');
    }
    return ok(lines.join('\n'), { lufs: x.lufs, momentaryMaxLufs: x.momentaryMaxLufs, peakDb: x.peakDb, pitch: x.pitch, spectrum: x.spectrum, envelope: r.envelope, stereoWidth: x.stereo?.width ?? null });
  });
}

let renderQueue = Promise.resolve();
let waiting = 0;
const MAX_WAITING = 6;

/**
 * Render + analyse in a worker thread (see ../../synth-worker.js). One render at a time for the whole server — a
 * heavy patch takes seconds of CPU, and parallel calls must not turn into a thread each — with a short queue.
 */
function renderInWorker(data) {
  if (waiting >= MAX_WAITING) return Promise.reject(new Error('The synth renderer is busy (several analyses are queued): try again in a moment'));
  waiting++;
  const run = renderQueue.catch(() => {}).then(() => runWorker(data)).finally(() => { waiting--; });
  renderQueue = run;
  return run;
}

function runWorker(data, timeoutMs = 60000) {
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
