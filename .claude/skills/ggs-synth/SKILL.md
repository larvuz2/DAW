---
name: ggs-synth
description: Work on the GGS Synth (packages/synth-dsp) or per-note expression in GreanTeaDawy — add a param, wavetable, modulation source/target, filter type or preset, change the voice or effects DSP, the AudioWorklet glue, the synth editor, the expression lane or the related MCP tools — without breaking determinism, the measured quality bars or the levelling of the presets.
---

# GGS Synth & expression

## Where things live

| Part | File |
|------|------|
| Param schema (one flat list; drives UI, validation, MCP) | `packages/synth-dsp/src/params.js` |
| Voice: oscillators, filters, envelopes, LFOs, matrix | `packages/synth-dsp/src/voice.js` |
| Channel effects | `packages/synth-dsp/src/fx.js` |
| Wavetables (harmonic recipes → band-limited mip levels) | `packages/synth-dsp/src/wavetables.js` |
| Presets + `GGS_PRESET_INFO` (macros, expression, test note) | `packages/synth-dsp/src/presets.js` |
| Patch documents, `PATCH_FIELDS`, `summarizePatch` | `packages/synth-dsp/src/patch.js` |
| Headless renderer (tests, server) | `packages/synth-dsp/src/render.js` |
| Worklet processors `ggs-voice`, `ggs-fx` | `client/src/audio/ggs-synth/worklet.js` |
| Main-thread glue: module loading, `GgsChannel`, `ggsVoice` | `client/src/audio/ggs-synth/index.js` |
| Filter models, `filterResponse` (measured curve) | `packages/synth-dsp/src/filters.js` |
| Chaos generators (modulation sources chaos1/2) | `packages/synth-dsp/src/chaos.js` |
| Modulation in the editor: rings, live dots, source bar, drawn LFO | `client/src/components/ui/Knob.jsx` (`rings`, `live`, `onAltDrag`, `onDropSource`), `ui/frames.js`, `components/synth/{modulation.js,SourceBar.jsx,StepEditor.jsx}` |
| Live values from the audio thread | `worklet.js` (`watch` → `{type:'mod'}`), `ggs-synth/index.js` (`GgsChannel.setWatch/live`), `engine.watchGgs/ggsLive` |
| Editor | `client/src/components/SynthEditor.jsx` + `components/synth/` (EnvelopeEditor, FilterGraph, PresetBrowser, WavetablePicker, ParamTable) |
| Synth page (the editor's first view) | `components/synth/SynthPage.jsx` (shell: rows, scale-to-fit, dock, arrange, ⋯ menu, full screen), `pageModules.jsx` (modules get `ed`: the editor's own `C` with `look: 'panel' \| 'box' \| 'led'`), `pageLayout.js` (a new module: `MODULES` with its height and width, `RENDER` in SynthPage, a built-in layout; `client/test/pageLayout.test.js`), styles under `.gsp` (the /synth tokens `--sp-*`), `e2e/workflow-synth-page.spec.js` checks overlaps at 1440×900 |
| Expression model / op | `packages/core/src/expression.js`, `ops.js` (`notes/expression`) |
| Expression lane | `client/src/components/ExpressionLane.jsx`, `PianoRoll.jsx` |
| MPE decoder / MIDI files | `packages/core/src/mpe.js`, `midi.js` |
| MCP tools | `server/src/mcp/tools/synth.js`, `expression.js`; worker `server/src/synth-worker.js` |

## Rules

- **`packages/synth-dsp` has no dependencies** and uses no Node or DOM API: it runs in an AudioWorkletGlobalScope.
  The worklet imports `@greanteadawy/synth-dsp/engine` (voice + fx only) to stay small.
- **No allocation and no string-keyed param lookups while rendering.** Everything derived from params is cached as
  numbers in `GgsVoice.configure()`; `control()` and the render loops read fields. (Template-string lookups in the
  control loop cost 3× the whole voice — measured.)
- **No function call that takes numbers inside a per-sample loop.** When V8 decides not to inline a call it boxes
  every number passed and returned (measured: 160 garbage collections per 30 s through one filter). Write the
  maths out in the loop — see the solvers in `filters.js` — and keep the garbage test in `test/filters.test.js`
  green. Calls per control block are tolerated.
- **A voice's memory comes from its `Arena`** (`util.js`): any typed array over 64 bytes that a voice (or something
  it owns) needs is taken as a view — `mem.f64(n)` / `mem.f32(n)` — and counted in `VOICE_BYTES` (`voice.js`).
  A separate `new Float64Array(20)` costs 2 µs; seventeen of them made a note cost 35 µs more to start.
  Starting a note must stay cheap: no template strings in `configure()` (use the key tables `OSC_K`, `ENV_K`, …),
  nothing that walks all ~520 params.
- **Determinism**: a voice gets everything through its constructor options and its `process()` control inputs.
  Random parts come from the note's `seed`. Never use `Math.random()` or wall-clock time in the engine. In the
  browser nothing may depend on port-message timing: note data travels in `processorOptions` and AudioParams.
- **Ramp, don't step**: a new modulated quantity gets a `…To` target in `control()` and is interpolated per sample.
- **Denormals**: any state that decays toward zero on silence must be flushed (`< 1e-30 → 0`) once per block.
- New harmonics after the oscillator (a new warp, a nonlinear filter) alias: add the case to `needsOversampling`
  and to the mip-level widening in `renderOsc`, and to the oversampling test.
- **Filters**: a model is an entry in `FILTER_INFO` (label, family, what Morph does, `nonlinear`, description), a
  case in `VoiceFilter.set` (targets, control rate) and a block method (per-sample ramp, both channels). APPEND new
  types — the first nine are the original clean ones and patches store ids. Add the model to `test/filters.test.js`
  (response, abuse, silence). Never divide by a ramped quantity that can reach zero (drive curvature: guard it).
- **Structural params** (what a voice is made of: on/off, table, warp mode, unison, filter type, routing) are listed
  in `SWAP_KEYS` in `voice.js`; `setParams` holds them back until their unit has faded out. A new param that would
  click when changed under a held note belongs there, and in `test/envelope.test.js`.
- **Every param has a `desc`** (tooltip, All parameters tab, `describe_synth`). A new mod target also needs a case in
  `modTargetSpec` (patch.js) so `describeRoute` can say what a route does in real units.
- **Renaming or replacing a param**: stored projects and patch files still carry the old key. Map it in
  `migrateParams` (params.js) — it runs in `completeParams`, in core's `makeInstrument` and on the op path — and add
  a test that the old value means the same sound.
- **Params**: adding a param = one line in `params.js` (+ a control in `SynthEditor.jsx`, a field in `PATCH_FIELDS`,
  a zod field in the matching `set_synth_*` tool). Changing a default changes existing patches: note it in the
  changelog and re-level presets.
- **Mod sources/targets** are index-addressed in the voice: keep the contiguous groups contiguous (`env1..4`,
  `lfo1..4`, `macro1..8`, `chaos1..2`, the seven per-oscillator targets in order, `f1Cutoff/Res/Drive`,
  `f1Morph/f2Morph`, `lfo1Rate..4`). Never hard-code the number of slots or macros: use `MOD_SLOTS`, `MACRO_COUNT`
  and `modulationRoutes()` (two checks that looped to 16 silently missed routes once the matrix grew).
- **Chaos** must stay a function of its seed: only + − × ÷ on the state, the rate merely scans the sequence. A source
  that all notes share must be a function of the **song position** (`Chaos.at`, like "free" LFOs) — never shared
  state between voices, and never the audio context's clock (it differs on every Play and in every render). A voice
  gets `beat` at its start and counts frames (`beat0` / `time0` / `frames`, re-anchored in `setTempo`); anything
  seekable must answer for any position at a bounded cost (see `seekTuring`) — a note can start at bar 2000.
- **Live values**: a new source or target shows up in the editor by itself (the report is `[sources…, targets…]`);
  a new *kind* of target needs a case in `modTargetSpec` so rings, dots and sentences know its units.
- **Presets**: every preset routes `pressure`, `timbre` and its four named macros (a test enforces it; macros 5–8
  are the player's) and has honest
  macro labels (≤ 16 chars). After any change that affects level: `node packages/synth-dsp/scripts/level-presets.mjs --write`.
- **Expression**: curves are sanitized at the boundary (`sanitizeNote`); new note-creating code paths must carry
  `expressionFields(n)` (and `pan`) or the performance is lost on copy.

## Checks

```bash
npm test -w packages/synth-dsp        # signal quality (aliasing, tuning, zipper, independence, filters, envelopes, presets)
npm run bench:synth                   # CPU per voice; compare with docs/audio-benchmarks.md
node packages/synth-dsp/scripts/level-presets.mjs   # loudness of every preset
npm test -w server                    # MCP tools (server/test/ggs.test.js)
E2E_CHROMIUM=… npx playwright test e2e/workflow-ggs.spec.js   # worklet, live notes, offline expression, lane, editor, MPE
```

Update `docs/ggs-synth.md`, `docs/expression-engine.md` and the numbers in `docs/audio-benchmarks.md` when they
change; `npm run docs:mcp` after tool changes; `server/src/mcp/guide.js` and `skills/greanteadawy-sound-design` so
Claude knows.
