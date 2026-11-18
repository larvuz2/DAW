// MCP tools for the GGS Synth and per-note expression: an agent designs a patch, plays it with pitch / pressure /
// slide curves, measures it on the server, and checks the composition — and every invalid call changes nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { curveValueAt } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool } from './helpers.js';

let srv;
let user;
let client;
let call;
let pid;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'synth', password: 'synth-pass-1' });
  client = await mcpClient(srv.base, (await user.post('/api/me/token')).body.token);
  call = callTool(client);
  await call('create_project', { name: 'GGS', template: 'empty', key: 'C', scale: 'major', bpm: 120 });
  pid = (await user.get('/api/active')).body.projectId;
  await call('create_pattern', { name: 'Lead', bars: 2 });
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const chan = (p, name) => p.channels.find((c) => c.name === name);
const notesOf = (p, channel, pattern = 'Lead') => p.patterns.find((x) => x.name === pattern).notes[chan(p, channel).id] || [];
const fails = (pr, re) => pr.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));

test('the server registers the expression and synth tools, and describes the synth', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['set_note_expression', 'get_note_expression', 'transform_note_expression', 'copy_note_expression', 'evaluate_composition',
    'describe_synth', 'create_synth_patch', 'get_synth_patch', 'update_synth_patch', 'set_synth_oscillator', 'set_synth_filter',
    'set_synth_envelope', 'set_synth_lfo', 'set_synth_chaos', 'set_synth_modulation', 'set_synth_effect', 'analyze_synth_patch']) assert.ok(names.includes(n), n);
  assert.equal(names.length, 104);
  for (const t of tools) assert.ok(t.description, `${t.name} is described`);
  assert.match(await call('describe_synth'), /oscillators A, B, C/);
  assert.match(await call('describe_synth', { topic: 'wavetables' }), /glass\s+Spectral Glass \(12 frames\)/);
  assert.match(await call('describe_synth', { topic: 'modulation' }), /pressure\s+the note's pressure curve[\s\S]*f1Cutoff\s+filter 1 cutoff, 1 = \+10 octaves/);
  assert.match(await call('describe_synth', { topic: 'presets' }), /## Pads[\s\S]*Velvet Pad[\s\S]*macros: Brightness/);
  // every field comes with what it does; the long menus point to their own topics
  const reference = await call('describe_synth', { topic: 'parameters' });
  assert.match(reference, /"cutoff": "20\.\.20000 Hz \(default 20000\) — The frequency the filter works at/);
  assert.match(reference, /"attackCurve": "-1\.\.1 \(default -0\.3\) — Shape of the attack/);
  assert.match(reference, /"hold": "0\.\.5 s \(default 0\) — Time the envelope stays at full/);
  assert.match(reference, /"type": "one of 21 ids \(default lp24\)/);
  const filters = await call('describe_synth', { topic: 'filters' });
  assert.match(filters, /acid\s+Acid \(diode ladder\): TB-303 style/);
  assert.match(filters, /formant\s+Formant \(vowel\) \[morph = vowel\]/);
  assert.equal(filters.split('\n').filter((l) => /^ {2}\w+\s/.test(l)).length, 21);
  assert.match(await call('describe_synth', { topic: 'wavetables' }), /Wavetables \(46\)[\s\S]*vosim\s+VOSIM/);
  // list_instruments stays readable (the synth has 200+ params)
  const listed = await call('list_instruments', { kind: 'ggs' });
  assert.match(listed, /describe_synth/);
  assert.ok(listed.length < 2500, `${listed.length} chars`);
});

test('create_synth_patch: from a preset, from scratch with a patch document, and nothing changes on an invalid call', async () => {
  assert.match(await call('create_synth_patch', { name: 'Pad', preset: 'Velvet Pad' }), /Created GGS Synth "Pad" \[ch_\w+\] \(Velvet Pad\) → mixer insert 1[\s\S]*Macros: 1 Brightness[\s\S]*Expression: Pressure opens the filter/);
  const made = await call('create_synth_patch', {
    name: 'Lead',
    patch: {
      oscillators: [{ id: 'A', table: 'basic', position: 0, phaseRandom: 0 }, { id: 'B', table: 'glass', position: 0.35, level: 0.3, octave: 1, unison: 3, detune: 7 }],
      filters: [{ id: 1, type: 'lp12', cutoff: 1200, resonance: 0.3 }],
      envelopes: [{ id: 1, attack: 0.01, release: 0.2 }],
      modulation: [{ source: 'pressure', target: 'f1Cutoff', amount: 0.4 }, { source: 'timbre', target: 'oscBPos', amount: 0.42 }],
      voice: { polyphony: 8 }
    }
  });
  assert.match(made, /Osc A: basic @ 0[\s\S]*Osc B: glass @ 0\.35[\s\S]*3× unison[\s\S]*F1 lp12 1200 Hz[\s\S]*pressure→f1Cutoff \+0\.4/);
  let p = await project();
  const lead = chan(p, 'Lead');
  assert.equal(lead.instrument.kind, 'ggs');
  assert.equal(lead.instrument.params.oscBOn, true, 'an oscillator described in the document is switched on');
  assert.equal(lead.instrument.params.polyphony, 8);
  assert.equal(p.mixer[lead.mixerTrack].name, 'Lead');
  // invalid values: clear errors, no channel created
  const before = p.channels.length;
  await fails(call('create_synth_patch', { name: 'Bad', patch: { filters: [{ id: 1, cutoff: 99999 }] } }), /"f1Cutoff" must be between 20 and 20000 Hz/);
  await fails(call('create_synth_patch', { name: 'Bad', patch: { oscillators: [{ id: 'A', table: 'serum' }] } }), /"oscATable" must be one of: basic/);
  await fails(call('create_synth_patch', { name: 'Bad', patch: { oscillators: [{ id: 'A', wave: 'saw' }] } }), /Unknown oscillator field "wave". Valid: on, table, position/);
  await fails(call('create_synth_patch', { name: 'Bad', patch: { modulation: [{ source: 'pressure', target: 'cutoff', amount: 0.2 }] } }), /Unknown modulation target "cutoff"/);
  p = await project();
  assert.equal(p.channels.length, before);
});

test('section tools edit one part of a patch; other instruments are refused with a way forward', async () => {
  assert.match(await call('set_synth_oscillator', { channel: 'Lead', oscillator: 'C', table: 'fmbell', position: 0.2, level: 0.25, octave: 1, fmFrom: 'A', fm: 0.2, sub: { level: 0.3, to: 'direct' } }), /Osc C: fmbell @ 0\.2[\s\S]*FM from A 0\.2[\s\S]*Sub: sine -1 oct, level 0\.3 → direct/);
  let ins = chan(await project(), 'Lead').instrument.params;
  assert.equal(ins.oscCOn, true, 'configuring an oscillator turns it on');
  assert.equal(ins.oscCFmFrom, 'A');
  assert.match(await call('set_synth_filter', { channel: 'Lead', filter: 2, type: 'hp12', cutoff: 180, routing: 'parallel' }), /F2 hp12 180 Hz[\s\S]*\(parallel\)/);
  assert.match(await call('set_synth_envelope', { channel: 'Lead', envelope: 2, attack: 0.002, decay: 0.3, sustain: 0.1, release: 0.3 }), /Set envelope 2/);
  assert.match(await call('set_synth_lfo', { channel: 'Lead', lfo: 1, shape: 'sine', rate: 5.5, fade: 0.3 }), /Set LFO 1/);
  assert.match(await call('set_synth_effect', { channel: 'Lead', delay: { mix: 0.2, sync: '1/8d', feedback: 0.3 }, reverb: { mix: 0.25, size: 0.6 }, gain: 0.7 }), /delay 0\.2 \(1\/8d\), reverb 0\.25 size 0\.6; gain 0\.7/);
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.f2On, ins.f2Type, ins.filterRoute, ins.env2D, ins.lfo1Rate, ins.delaySync, ins.gain], [true, 'hp12', 'parallel', 0.3, 5.5, '1/8d', 0.7]);
  // the analog-style and special filters, with their second control; the reply measures what the setting does
  const f1 = chan(await project(), 'Lead').instrument.params;
  const acid = await call('set_synth_filter', { channel: 'Lead', type: 'acid', cutoff: 500, resonance: 0.85, drive: 0.3 });
  assert.match(acid, /F1 acid 500 Hz res 0\.85 drive 0\.3/);
  const measured = /Measured response of filter 1 \(acid\): 50 Hz (-?[\d.]+) dB · 100 Hz (-?[\d.]+) dB · 200 Hz (-?[\d.]+) dB · 500 Hz \+?(-?[\d.]+) dB · 1k Hz (-?[\d.]+) dB · 2k Hz (-?[\d.]+) dB/.exec(acid);
  assert.ok(measured, acid);
  assert.ok(Number(measured[4]) > Number(measured[3]) + 6 && Number(measured[4]) > Number(measured[6]) + 20, 'the resonance peak sits on the cutoff');
  assert.match(await call('set_synth_filter', { channel: 'Lead', type: 'formant', cutoff: 1000, resonance: 0.4, morph: 0.5, keyTrack: 0 }), /F1 formant 1000 Hz res 0\.4 drive 0\.3 vowel 0\.5/);
  assert.equal(chan(await project(), 'Lead').instrument.params.f1Morph, 0.5);
  // a filter that oscillates by itself is reported as that, not as a +116 dB "response"; an off filter reports nothing
  const singing = await call('set_synth_filter', { channel: 'Lead', type: 'ladder24', cutoff: 1000, resonance: 0.95, drive: 0 });
  assert.match(singing, /Filter 1 \(ladder24\) at resonance 0\.95 self-oscillates[^\n]*a tone of its own at about 1000 Hz/);
  assert.doesNotMatch(singing, /Measured response/);
  assert.match(await call('set_synth_filter', { channel: 'Lead', type: 'ladder24', resonance: 0.5 }), /Measured response of filter 1 \(ladder24\): 50 Hz -?[\d.]+ dB/);
  assert.match(await call('set_synth_filter', { channel: 'Lead', type: 'comb', cutoff: 110, resonance: 0.97 }), /Measured response of filter 1 \(comb\)[^\n]*still ringing after a second/);
  const f2 = chan(await project(), 'Lead').instrument.params;
  await call('set_synth_filter', { channel: 'Lead', filter: 2, on: false });
  assert.doesNotMatch(await call('set_synth_filter', { channel: 'Lead', filter: 2, on: false, routing: 'serial' }), /Measured response|self-oscillates/);
  await call('set_synth_filter', { channel: 'Lead', filter: 2, on: f2.f2On, routing: f2.filterRoute });
  await fails(call('set_synth_filter', { channel: 'Lead', type: 'moog' }), /type is "moog": it must be one of "lp12"[^\n]*"ladder24"/);
  await fails(call('set_synth_filter', { channel: 'Lead', morph: 2 }), /morph is 2: the maximum is 1 — nearest valid value: 1/);
  await call('set_synth_filter', { channel: 'Lead', type: f1.f1Type, cutoff: f1.f1Cutoff, resonance: f1.f1Res, drive: f1.f1Drive, keyTrack: f1.f1Key, morph: f1.f1Morph });
  // envelopes: delay and hold stages, a curve per stage; the old single curve still works and means the same shape
  assert.match(await call('set_synth_envelope', { channel: 'Lead', envelope: 1, delay: 0.05, hold: 0.1, attackCurve: 0.4, decayCurve: -0.8 }), /Amp envelope: delay 0\.05 A [\d.]+ H 0\.1 D/);
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.env1Delay, ins.env1Hold, ins.env1ACurve, ins.env1DCurve, ins.env1RCurve], [0.05, 0.1, 0.4, -0.8, -0.5]);
  await call('set_synth_envelope', { channel: 'Lead', envelope: 3, curve: 1, releaseCurve: 0 });
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.env3DCurve, ins.env3RCurve, Math.round(ins.env3ACurve * 1000) / 1000], [-1, 0, -0.495]);
  assert.equal(ins.env3Curve, undefined);
  await fails(call('set_synth_envelope', { channel: 'Lead', envelope: 1, hold: 9 }), /hold is 9: the maximum is 5 — nearest valid value: 5/);
  await call('set_synth_envelope', { channel: 'Lead', envelope: 1, delay: 0, hold: 0, attackCurve: f1.env1ACurve, decayCurve: f1.env1DCurve });
  // chaos: configure a generator, see its path, be told to route it; then route it and the hint is gone
  const chaos = await call('set_synth_chaos', { channel: 'Lead', chaos: 2, type: 'turing', sync: '1/16', character: 0.1, steps: 8, path: 'same' });
  assert.match(chaos, /Chaos 2 \(turing; rate = steps per second\) over 12 cycles: [▁▂▃▄▅▆▇█]{48}/);
  assert.match(chaos, /Not routed yet: add a route with set_synth_modulation \(source chaos2\), e\.g\. chaos2 → f1Cutoff 0\.15/);
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.chaos2Type, ins.chaos2Sync, ins.chaos2Char, ins.chaos2Steps, ins.chaos2Path, ins.chaos1Type], ['turing', '1/16', 0.1, 8, 'same', 'lorenz']);
  await call('set_synth_modulation', { channel: 'Lead', routes: [{ source: 'chaos2', target: 'f1Cutoff', amount: 0.15 }] });
  const routed = await call('set_synth_chaos', { channel: 'Lead', chaos: 2, character: 0 });
  assert.doesNotMatch(routed, /Not routed yet/);
  assert.match(routed, /Chaos 2: turing, 1\/16, character 0, 8 steps, the same path for every note[\s\S]*Filter 1 cutoff [\d.]+ k?Hz ↔ [\d.]+ k?Hz as Chaos 2 swings −1 ↔ 1/);
  await fails(call('set_synth_chaos', { channel: 'Lead', chaos: 3, type: 'drift' }), /chaos is 3: the maximum is 2 — nearest valid value: 2/);
  await fails(call('set_synth_chaos', { channel: 'Lead', chaos: 1, type: 'henon' }), /type is "henon": it must be one of "lorenz", "rossler", "drift", "turing"/);
  await fails(call('set_synth_chaos', { channel: 'Lead', chaos: 1 }), /Nothing to change/);
  await call('set_synth_modulation', { channel: 'Lead', remove: [{ source: 'chaos2', target: 'f1Cutoff' }] });
  assert.match(await call('describe_synth', { topic: 'modulation' }), /64 routes[\s\S]*macro8\s+macro 8[\s\S]*chaos1\s+chaos generator 1[\s\S]*CHAOS \(set_synth_chaos[\s\S]*drift\s+rate = how fast it wanders/);
  // raw params written for the old schema are mapped too, not refused with a list of 500 keys
  assert.match(await call('update_channel', { channel: 'Lead', params: { env2Curve: 1 } }), /Updated/);
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.env2DCurve, ins.env2RCurve, ins.env2Curve], [-1, -1, undefined]);
  await fails(call('update_channel', { channel: 'Lead', params: { env2Curve: 1, nonsense: 3 } }), /Unknown parameter "nonsense"/);
  await call('set_synth_envelope', { channel: 'Lead', envelope: 2, decayCurve: -0.5, releaseCurve: -0.5, attackCurve: -0.3 });
  await fails(call('update_synth_patch', { channel: 'Lead', patch: { envelopes: [{ id: 1, curve: 'x' }] } }), /Envelope 1: "curve" must be a number from -1 to 1 \(got "x"\)/);
  await fails(call('update_synth_patch', { channel: 'Lead', patch: { envelopes: [{ id: 1, curve: 9 }] } }), /must be a number from -1 to 1 \(got 9\)/);
  // a route that cannot do anything says so: a free-running LFO keeps to the clock
  await call('set_synth_lfo', { channel: 'Lead', lfo: 3, trigger: 'free' });
  assert.match(await call('set_synth_modulation', { channel: 'Lead', routes: [{ source: 'macro6', target: 'lfo3Rate', amount: 0.5 }] }), /LFO 3 rate: no effect — LFO 3 is free-running \(trigger "free"\)/);
  await call('set_synth_lfo', { channel: 'Lead', lfo: 3, trigger: 'note' });
  assert.match(await call('get_synth_patch', { channel: 'Lead' }), /LFO 3 rate 1 Hz → 4 Hz as Macro 6 goes 0 → 1/);
  await call('set_synth_modulation', { channel: 'Lead', remove: [{ source: 'macro6', target: 'lfo3Rate' }] });
  // a drawn LFO shape as a list
  assert.match(await call('set_synth_lfo', { channel: 'Lead', lfo: 4, steps: [1, -1, 0.5, 0, 0.25], smooth: 0.3, sync: '1bar' }), /Set LFO 4/);
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.lfo4Shape, ins.lfo4Steps, ins.lfo4S2, ins.lfo4S5, ins.lfo4Smooth], ['steps', 5, -1, 0.25, 0.3]);
  await fails(call('set_synth_lfo', { channel: 'Lead', lfo: 4, steps: [2, 0] }), /steps\[0\] is 2: the maximum is 1/);
  await call('set_synth_lfo', { channel: 'Lead', lfo: 4, shape: 'sine', sync: 'off' });
  // a patch document written before the per-stage curves is still accepted
  await call('update_synth_patch', { channel: 'Lead', patch: { envelopes: [{ id: 4, decay: 0.2, curve: -1 }] } });
  assert.equal(chan(await project(), 'Lead').instrument.params.env4DCurve, -0.25);
  await fails(call('set_synth_oscillator', { channel: 'Lead', table: 'glass' }), /Say which oscillator/);
  await fails(call('set_synth_filter', { channel: 'Lead', resonance: 1.5 }), /resonance is 1\.5: the maximum is 1 — nearest valid value: 1/);
  await call('add_channel', { name: 'Keys', instrument: 'fm' });
  await fails(call('set_synth_filter', { channel: 'Keys', cutoff: 800 }), /"Keys" is a FM Synth, not a GGS Synth. Create one with create_synth_patch/);
});

test('set_synth_modulation: add, update in place, via, remove, replace, the 16-route limit and macros', async () => {
  await call('set_synth_modulation', { channel: 'Lead', routes: [{ source: 'env2', target: 'f1Cutoff', amount: 0.3 }, { source: 'lfo1', target: 'pitchFine', amount: 0.3, via: 'pressure' }], macros: [0.25, 0, 0, 1] });
  let ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.mod1Src, ins.mod2Src, ins.mod3Src, ins.mod4Src, ins.mod4Via, ins.macro1, ins.macro4], ['pressure', 'timbre', 'env2', 'lfo1', 'pressure', 0.25, 1]);
  // same source + target (+ via): the amount is updated, no new slot
  await call('set_synth_modulation', { channel: 'Lead', routes: [{ source: 'pressure', target: 'f1Cutoff', amount: 0.25 }] });
  ins = chan(await project(), 'Lead').instrument.params;
  assert.equal(ins.mod1Amt, 0.25);
  assert.equal(ins.mod5Src, 'none');
  await call('set_synth_modulation', { channel: 'Lead', remove: [{ source: 'env2', target: 'f1Cutoff' }] });
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.mod3Src, ins.mod4Src], ['lfo1', 'none'], 'routes close up');
  await fails(call('set_synth_modulation', { channel: 'Lead', remove: [{ source: 'env4', target: 'pan' }] }), /No route env4 → pan to remove. Routes: pressure→f1Cutoff/);
  // 64 routes fit; the 65th is refused and nothing changes
  const many = Array.from({ length: 62 }, (_, i) => ({ source: 'key', target: ['pan', 'level', 'pitch', 'f1Res'][i % 4], amount: 0.001 * (i + 1), via: ['velocity', 'random', 'macro1', 'macro2', 'macro5', 'macro6', 'macro7', 'macro8', 'chaos1', 'chaos2', 'env3', 'env4', 'lfo2', 'lfo3', 'lfo4', 'releaseVel'][Math.floor(i / 4)] }));
  await fails(call('set_synth_modulation', { channel: 'Lead', routes: many }), /makes 65 routes; a patch has 64/);
  assert.equal(chan(await project(), 'Lead').instrument.params.mod4Src, 'none', 'nothing changed');
  const full = await call('set_synth_modulation', { channel: 'Lead', routes: many.slice(0, 61), macros: [0.25, 0, 0, 1, 0, 0, 0, 0.5] });
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.mod64Src, ins.mod64Via, ins.macro8, ins.macro4], ['key', 'releaseVel', 0.5, 1]);
  assert.match(full, /Pan 0 ↔ 0 as key position swings −1 ↔ 1, depth scaled by velocity/);
  assert.match(await call('get_synth_patch', { channel: 'Lead' }), /8 \(Pan \+\d+\) = 0\.5[\s\S]*Modulation slots used: 64\/64/);
  await call('set_synth_modulation', { channel: 'Lead', mode: 'replace', routes: [{ source: 'pressure', target: 'f1Cutoff', amount: 0.4 }, { source: 'timbre', target: 'oscBPos', amount: 0.42 }] });
  ins = chan(await project(), 'Lead').instrument.params;
  assert.deepEqual([ins.mod1Src, ins.mod2Src, ins.mod3Src], ['pressure', 'timbre', 'none']);
});

test('patch documents travel: get_synth_patch → create_synth_patch makes the same sound', async () => {
  assert.match(await call('get_synth_patch', { channel: 'Lead' }), /GGS Synth "Lead"[\s\S]*Modulation slots used: 2\/64/);
  const text = await call('get_synth_patch', { channel: 'Lead', format: 'document' });
  const doc = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(doc.format, 'ggs-synth-patch');
  await call('create_synth_patch', { name: 'Lead copy', patch: doc });
  const p = await project();
  assert.deepEqual(chan(p, 'Lead copy').instrument.params, chan(p, 'Lead').instrument.params);
  await call('update_synth_patch', { channel: 'Lead copy', preset: 'Deep Sub', patch: { voice: { glide: 0.1 } } });
  const sub = chan(await project(), 'Lead copy').instrument;
  assert.deepEqual([sub.preset, sub.params.mono, sub.params.glide, sub.params.subLevel], ['Deep Sub', true, 0.1, 0.55]);
  await call('remove_channel', { channel: 'Lead copy' });
});

test('analyze_synth_patch measures the patch on the server: pitch, level, and what expression does', async () => {
  const plain = await call('analyze_synth_patch', { channel: 'Lead', notes: ['A3'], noteSeconds: 1 });
  assert.match(plain, /GGS PATCH "Lead" — A3 at velocity 0\.8/);
  // the patch has a sub oscillator an octave below: that is the pitch a meter hears
  assert.match(plain, /Pitch: A2 \(1[01]\d(\.\d+)? Hz/);
  const data = (t) => JSON.parse(t.slice(t.indexOf('\n{')));
  const base = data(plain);
  assert.ok(base.lufs < -8 && base.lufs > -40, `${base.lufs} LUFS`);
  // pressure opens the filter (the route added above): the same note is brighter
  const pressed = data(await call('analyze_synth_patch', { channel: 'Lead', notes: ['A3'], noteSeconds: 1, pressure: { points: [{ at: 0, value: 1 }] } }));
  assert.ok(pressed.spectrum.centroidHz > base.spectrum.centroidHz * 1.3, `${base.spectrum.centroidHz} → ${pressed.spectrum.centroidHz} Hz`);
  // a pitch curve held an octave up is measured an octave up
  const bent = await call('analyze_synth_patch', { channel: 'Lead', notes: ['A3'], noteSeconds: 1, pitch: { points: [{ at: 0, value: 12 }] } });
  assert.match(bent, /Pitch: A3 \(2[12]\d/);
  await fails(call('analyze_synth_patch', { channel: 'Lead', velocity: 0 }), /Velocity 0 is silent/);
  await fails(call('analyze_synth_patch', { channel: 'Lead', pitch: { points: [{ at: 0, value: 80 }] } }), /pitch values must be between -48 and 48 semitones/);
});

test('analyze_synth_patch explains silence it can explain', async () => {
  await call('create_synth_patch', { name: 'Late', patch: { envelopes: [{ id: 1, delay: 2.5 }] } });
  assert.match(await call('analyze_synth_patch', { channel: 'Late' }), /Silent because envelope 1 \(the amp envelope\) waits 2\.5 s before it starts and the note is only 1\.5 s long/);
  assert.doesNotMatch(await call('analyze_synth_patch', { channel: 'Late', noteSeconds: 4, seconds: 5 }), /Silent because/);
  await call('remove_channel', { channel: 'Late' });
});

test('set_note_expression: shapes and points per note, selections, removal, and honest hints', async () => {
  await call('add_notes', { pattern: 'Lead', channel: 'Lead', notes: [{ note: 'C4', start: 0, length: 8 }, { note: 'E4', start: 0, length: 8 }, { note: 'G4', start: 0, length: 8 }, { note: 'E4', start: 16, length: 4 }] });
  let p = await project();
  const [c4, e4, g4, e4b] = notesOf(p, 'Lead');
  // bend only the third of the chord
  const out = await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [e4.id], pitch: { shape: 'bend', to: 1, end: 0.4 } });
  assert.match(out, new RegExp(`Shaped 1 note\\(s\\) of "Lead" in "Lead":\\s+E4 @ step 0 \\[${e4.id}\\]: pitch 0→\\+1 st`));
  p = await project();
  let list = notesOf(p, 'Lead');
  assert.equal(list.find((n) => n.id === c4.id).expression, undefined);
  assert.equal(list.find((n) => n.id === g4.id).expression, undefined);
  const bend = list.find((n) => n.id === e4.id).expression.pitch;
  assert.equal(curveValueAt(bend, 0), 0);
  assert.equal(curveValueAt(bend, 0.4), 1);
  assert.equal(curveValueAt(bend, 1), 1);
  // by pitch: both E4s get pressure; the bend of the first is kept
  await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', note: 'E4', pressure: { shape: 'swell', peak: 0.85, at: 0.3, to: 0.2 }, releaseVelocity: 0.42 });
  // explicit points with curve types, on the G; slide on a step range
  await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [g4.id], timbre: { points: [{ at: 0, value: 0.15, curve: 'smooth' }, { at: 1, value: 0.9 }] } });
  await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', fromStep: 16, toStep: 32, pitch: { shape: 'vibrato', rateHz: 6, depth: 0.3, delay: 0.25 } });
  p = await project();
  list = notesOf(p, 'Lead');
  const E = list.find((n) => n.id === e4.id);
  assert.deepEqual(Object.keys(E.expression).sort(), ['pitch', 'pressure']);
  assert.equal(E.releaseVelocity, 0.42);
  assert.ok(Math.abs(curveValueAt(E.expression.pressure, 0.3) - 0.85) < 1e-6);
  assert.equal(list.find((n) => n.id === g4.id).expression.timbre[0].c, 'smooth');
  // 4 steps at 120 BPM = 0.5 s; 6 Hz over the 75% after the delay = 2.25 waves → 4 or 5 turning points
  const vib = list.find((n) => n.id === e4b.id).expression.pitch;
  assert.ok(vib.length >= 5 && vib.length <= 8, `${vib.length} points`);
  assert.ok(Math.max(...vib.map((x) => x.v)) > 0.25);
  // null removes one curve, the rest stays
  await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [e4.id], pitch: null });
  assert.deepEqual(Object.keys(notesOf(await project(), 'Lead').find((n) => n.id === e4.id).expression), ['pressure']);
  // hints: a curve nothing hears
  assert.match(await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [c4.id], timbre: { shape: 'ramp', to: 1 } }), /Shaped 1 note/);
  await call('set_synth_modulation', { channel: 'Lead', remove: [{ source: 'timbre', target: 'oscBPos' }] });
  assert.match(await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [c4.id], timbre: { shape: 'ramp', to: 1 } }), /does not route timbre anywhere yet[\s\S]*set_synth_modulation/);
  await call('add_notes', { pattern: 'Lead', channel: 'Keys', notes: [{ note: 'C3', start: 0, length: 8 }] });
  assert.match(await call('set_note_expression', { pattern: 'Lead', channel: 'Keys', all: true, pressure: { shape: 'ramp', to: 1 }, pitch: { shape: 'scoop', depth: 1 } }), /"Keys" is a fm: only pitch curves are audible/);
  // errors change nothing
  await fails(call('set_note_expression', { pattern: 'Lead', channel: 'Lead', pitch: { shape: 'bend' } }), /Say which notes: noteIds, a note name, a step range/);
  await fails(call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: ['nope'], pitch: { shape: 'bend' } }), /Unknown note id\(s\): nope/);
  await fails(call('set_note_expression', { pattern: 'Lead', channel: 'Lead', all: true, pressure: { points: [{ at: 0, value: 2 }] } }), /pressure values must be between 0 and 1/);
  await fails(call('set_note_expression', { pattern: 'Lead', channel: 'Lead', all: true, pitch: { shape: 'bend', points: [{ at: 0, value: 1 }] } }), /points OR a shape/);
  await fails(call('set_note_expression', { pattern: 'Lead', channel: 'Lead', all: true }), /Nothing to set/);
  await fails(call('set_note_expression', { pattern: 'Lead', channel: 'Lead', note: 'B7', pitch: { shape: 'bend' } }), /No notes matched B7/);
});

test('inspect, transform and copy expression; get_pattern and the project summary show it', async () => {
  const p = await project();
  const [c4, e4, g4] = notesOf(p, 'Lead');
  const seen = await call('get_note_expression', { pattern: 'Lead', channel: 'Lead' });
  assert.match(seen, /Expression of 4 note\(s\)/);
  const data = JSON.parse(seen.slice(seen.indexOf('\n[')));
  const g = data.find((n) => n.id === g4.id);
  assert.deepEqual(g.timbre, [{ at: 0, value: 0.15, curve: 'smooth' }, { at: 1, value: 0.9 }]);
  assert.equal(data.find((n) => n.id === e4.id).releaseVelocity, 0.42);
  assert.match(await call('get_pattern', { pattern: 'Lead', channel: 'Lead' }), new RegExp(`${g4.id}\\s+G4\\s+start 0\\s+len 8\\s+vel 0\\.8\\s+expr: timbre 0\\.15→0\\.9, 2 pts`));
  assert.match(await call('get_project'), /Lead\s+4 notes[^\n]*— 4 with expression curves/);
  // halve and invert the slide of the G
  await call('transform_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [g4.id], dimensions: ['timbre'], invert: true });
  let G = notesOf(await project(), 'Lead').find((n) => n.id === g4.id);
  assert.deepEqual(G.expression.timbre.map((x) => x.v), [0.85, 0.1]);
  await fails(call('transform_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [g4.id], dimensions: ['pitch'], scale: 2 }), /has a pitch curve to transform/);
  await fails(call('transform_note_expression', { pattern: 'Lead', channel: 'Lead', all: true }), /Nothing to do/);
  // copy the E's performance onto the C and the G
  assert.match(await call('copy_note_expression', { pattern: 'Lead', channel: 'Lead', fromNote: e4.id, noteIds: [c4.id, g4.id] }), /Copied pressure[\s\S]*to 2 note\(s\)/);
  const list = notesOf(await project(), 'Lead');
  const E = list.find((n) => n.id === e4.id);
  for (const id of [c4.id, g4.id]) {
    const n = list.find((x) => x.id === id);
    assert.deepEqual(n.expression, E.expression);
    assert.equal(n.releaseVelocity, 0.42);
  }
  G = list.find((n) => n.id === g4.id);
  assert.equal(G.expression.timbre, undefined, 'the copy replaces the whole performance');
  // undo is one step back, like any other edit by Claude
  await call('undo');
  assert.ok(notesOf(await project(), 'Lead').find((n) => n.id === g4.id).expression.timbre);
});

test('add_notes writes notes with their performance in one call', async () => {
  await call('create_pattern', { name: 'Phrase', bars: 1 });
  await call('add_notes', {
    pattern: 'Phrase', channel: 'Lead',
    notes: [
      { note: 'D4', start: 0, length: 4, expression: { pitch: { shape: 'scoop', depth: 2 } } },
      { note: 'F4', start: 4, length: 8, releaseVelocity: 0.9, expression: { pressure: { shape: 'swell', peak: 0.9 }, timbre: { points: [{ at: 0, value: 0 }, { at: 1, value: 1 }] } } },
      { note: 'A4', start: 12, length: 4 }
    ]
  });
  const [d, f, a] = notesOf(await project(), 'Lead', 'Phrase');
  assert.equal(d.expression.pitch[0].v, -2);
  assert.deepEqual(Object.keys(f.expression).sort(), ['pressure', 'timbre']);
  assert.equal(f.releaseVelocity, 0.9);
  assert.equal(a.expression, undefined);
  await fails(call('add_notes', { pattern: 'Phrase', channel: 'Lead', notes: [{ note: 'C4', start: 0, expression: { pitch: { shape: 'bend', to: 99 } } }] }), /pitch to must be between -48 and 48/);
  assert.equal(notesOf(await project(), 'Lead', 'Phrase').length, 3, 'a failed call adds nothing');
});

test('macros automate on a GGS channel only, and go when the channel stops being one', async () => {
  await call('place_pattern', { pattern: 'Lead', startBar: 1 });
  assert.match(await call('add_automation', { name: 'Open up', target: { type: 'channel', channel: 'Pad', param: 'macro1' }, startBar: 1, bars: 2, points: [{ bar: 0, value: 0 }, { bar: 2, value: 1 }] }), /Added automation "Open up" \[auto_/);
  await fails(call('add_automation', { target: { type: 'channel', channel: 'Keys', param: 'macro1' }, startBar: 1, points: [{ bar: 0, value: 0 }] }), /macro1\.\.macro8 only on a GGS Synth channel/);
  assert.match(await call('add_automation', { name: 'Eighth', target: { type: 'channel', channel: 'Pad', param: 'macro8' }, startBar: 3, bars: 1, points: [{ bar: 0, value: 1 }] }), /Added automation "Eighth"/);
  await fails(call('add_automation', { target: { type: 'channel', channel: 'Pad', param: 'macro9' }, startBar: 1, points: [{ bar: 0, value: 0 }] }), /macro1\.\.macro8/);
  await call('update_channel', { channel: 'Pad', instrument: 'synth' });
  const p = await project();
  assert.equal(p.automations.length, 0);
  assert.ok(!p.playlist.clips.some((c) => c.kind === 'automation'));
  await call('update_channel', { channel: 'Pad', instrument: 'ggs', preset: 'Velvet Pad' });
});

test('evaluate_composition flags what will not sound as written', async () => {
  // a chord on a mono patch, a slide curve on a patch that ignores it, pressure on an FM synth, flat velocities
  await call('create_synth_patch', { name: 'Bass', preset: 'Deep Sub' });
  await call('add_notes', { pattern: 'Lead', channel: 'Bass', notes: [{ note: 'C2', start: 0, length: 8 }, { note: 'G2', start: 0, length: 8 }, { note: 'F#2', start: 8, length: 8 }] });
  await call('set_synth_modulation', { channel: 'Lead', mode: 'replace', routes: [{ source: 'pressure', target: 'f1Cutoff', amount: 0.4 }] });
  // a route far down the matrix counts too (both checks once only looked at the first 16 slots)
  const slide = /channel "Lead": \d+ note\(s\) have a slide \(timbre\) curve, but the patch does not route timbre anywhere/;
  const g = notesOf(await project(), 'Lead').find((n) => n.expression?.timbre);
  await call('update_channel', { channel: 'Lead', params: { mod40Src: 'timbre', mod40Dst: 'oscAPos', mod40Amt: 0.2 } });
  assert.doesNotMatch(await call('evaluate_composition'), slide);
  assert.doesNotMatch(await call('set_note_expression', { pattern: 'Lead', channel: 'Lead', noteIds: [g.id], timbre: g.expression.timbre.length ? { points: g.expression.timbre.map((pt) => ({ at: pt.t, value: pt.v })) } : null }), /does not route timbre/);
  await call('update_channel', { channel: 'Lead', params: { mod40Src: 'none', mod40Dst: 'none', mod40Amt: 0 } });
  const report = await call('evaluate_composition');
  assert.match(report, /COMPOSITION CHECK — 120 BPM, C major/);
  assert.match(report, /\[voices\] channel "Bass": The patch is mono but 2 notes sound at once/);
  assert.match(report, /\[expression\] channel "Lead": \d+ note\(s\) have a slide \(timbre\) curve, but the patch does not route timbre anywhere/);
  assert.match(report, /\[expression\] channel "Keys": 1 pressure\/slide curve\(s\) on a FM Synth: only the GGS Synth responds/);
  assert.match(report, /\[harmony\] channel "Bass": 33% of its notes are outside C major \(F#\)/);
  assert.match(report, /pattern "Phrase"[^\n]*not placed in the playlist/);
  assert.match(report, /CHANNELS:[\s\S]*Lead \(ggs\/Init\): 7 notes, C4–A4, up to 3 at once/);
  const data = JSON.parse(report.slice(report.indexOf('\n{')));
  assert.ok(data.counts.issue >= 3);
  // fix them, and the issues are gone
  await call('set_synth_modulation', { channel: 'Lead', routes: [{ source: 'timbre', target: 'oscBPos', amount: 0.4 }] });
  await call('update_synth_patch', { channel: 'Bass', patch: { voice: { mono: false } } });
  await call('set_note_expression', { pattern: 'Lead', channel: 'Keys', all: true, pressure: null });
  const clean = JSON.parse((await call('evaluate_composition')).split('\n{').pop().replace(/^/, '{'));
  assert.equal(clean.counts.issue, 0);
});

test('a vibrato too long for one curve says so instead of silently slowing down', async () => {
  await call('create_pattern', { name: 'Long', bars: 8 });
  await call('add_notes', { pattern: 'Long', channel: 'Lead', notes: [{ note: 'C4', start: 0, length: 120 }, { note: 'E4', start: 0, length: 8 }] });
  // 120 steps at 120 BPM = 15 s: 6 Hz would need 67 waves, a curve holds 30
  const out = await call('set_note_expression', { pattern: 'Long', channel: 'Lead', all: true, pitch: { shape: 'vibrato', rateHz: 6, depth: 0.3 } });
  assert.match(out, /Shaped 2 note\(s\)/);
  assert.match(out, /at most 30 waves, so 6 Hz vibrato is slower than asked on notes longer than 6\.7 s[\s\S]*LFO routed to pitchFine/);
  assert.doesNotMatch(await call('set_note_expression', { pattern: 'Long', channel: 'Lead', note: 'E4', pitch: { shape: 'vibrato', rateHz: 6, depth: 0.3 } }), /slower than asked/);
});

test('the sound-design skill teaches recipes the tools accept', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../../skills/greanteadawy-sound-design/recipes.md', import.meta.url), 'utf8');
  const recipes = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(recipes.length >= 6);
  for (const [i, patch] of recipes.entries()) {
    const out = await call('create_synth_patch', { name: `Recipe ${i + 1}`, patch });
    assert.match(out, /Created GGS Synth/, `recipe ${i + 1}`);
    // every recipe sounds: a note of it has a level
    const data = JSON.parse((await call('analyze_synth_patch', { channel: `Recipe ${i + 1}`, noteSeconds: 0.6 })).split('\n{').pop().replace(/^/, '{'));
    assert.ok(data.lufs > -45 && data.peakDb < 0, `recipe ${i + 1}: ${data.lufs} LUFS, peak ${data.peakDb} dBFS`);
  }
});
