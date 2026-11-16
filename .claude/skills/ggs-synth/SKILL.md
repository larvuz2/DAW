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
| Editor | `client/src/components/SynthEditor.jsx` |
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
- **Determinism**: a voice gets everything through its constructor options and its `process()` control inputs.
  Random parts come from the note's `seed`. Never use `Math.random()` or wall-clock time in the engine. In the
  browser nothing may depend on port-message timing: note data travels in `processorOptions` and AudioParams.
- **Ramp, don't step**: a new modulated quantity gets a `…To` target in `control()` and is interpolated per sample.
- **Denormals**: any state that decays toward zero on silence must be flushed (`< 1e-30 → 0`) once per block.
- New harmonics after the oscillator (a new warp, a nonlinear filter) alias: add the case to `needsOversampling`
  and to the mip-level widening in `renderOsc`, and to the oversampling test.
- **Params**: adding a param = one line in `params.js` (+ a control in `SynthEditor.jsx`, a field in `PATCH_FIELDS`,
  a zod field in the matching `set_synth_*` tool). Changing a default changes existing patches: note it in the
  changelog and re-level presets.
- **Mod sources/targets** are index-addressed in the voice: keep the contiguous groups contiguous (`env1..4`,
  `lfo1..4`, `macro1..4`, the seven per-oscillator targets in order, `f1Cutoff/Res/Drive`, `lfo1Rate..4`).
- **Presets**: every preset routes `pressure`, `timbre` and all four macros (a test enforces it) and has honest
  macro labels (≤ 16 chars). After any change that affects level: `node packages/synth-dsp/scripts/level-presets.mjs --write`.
- **Expression**: curves are sanitized at the boundary (`sanitizeNote`); new note-creating code paths must carry
  `expressionFields(n)` (and `pan`) or the performance is lost on copy.

## Checks

```bash
npm test -w packages/synth-dsp        # signal quality (aliasing, tuning, zipper, independence, presets)
npm run bench:synth                   # CPU per voice; compare with docs/audio-benchmarks.md
node packages/synth-dsp/scripts/level-presets.mjs   # loudness of every preset
npm test -w server                    # MCP tools (server/test/ggs.test.js)
E2E_CHROMIUM=… npx playwright test e2e/workflow-ggs.spec.js   # worklet, live notes, offline expression, lane, editor, MPE
```

Update `docs/ggs-synth.md`, `docs/expression-engine.md` and the numbers in `docs/audio-benchmarks.md` when they
change; `npm run docs:mcp` after tool changes; `server/src/mcp/guide.js` and `skills/greanteadawy-sound-design` so
Claude knows.
