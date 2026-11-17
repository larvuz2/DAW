# GreanTeaDawy — notes for Claude

GreanTeaDawy is a pattern-based browser DAW (channel rack, step sequencer, piano roll, playlist,
mixer, automation) with a wavetable/FM synth (the GGS Synth), per-note expression (MPE-style pitch / pressure / slide
curves) and an MCP server so Claude can produce music in it. Node.js ≥ 20.19 backend, React +
Web Audio frontend, plain ESM JavaScript (no TypeScript), MIT licensed.

## Layout

```
packages/core/   @greanteadawy/core — shared by server AND browser (keep it dependency-light, no Node/DOM APIs)
  src/model.js        project shape, create*/normalizeProject (repairs anything loaded from disk/imports)
  src/ops.js          applyOps/prepareOps: EVERY edit is an op (UI, MCP, REST); describeOps for the activity log
  src/instruments.js  instrument catalog + presets (param defs drive the UI knobs AND MCP validation),
                      INSTRUMENT_CATEGORIES = Browser sections / + Channel submenus
  src/effects.js      effect catalog (same idea); automatable params are backed by AudioParams in the client
  src/spatial.js      3D object coordinates, speaker layouts (5.1/7.1/7.1.4), panning gains, ADM XML
  src/plugins.js      plugin manifest validation, permissions, param values, cleaning generator output
  src/expression.js   per-note curves (pitch / pressure / timbre in normalized note time): sanitize, evaluate, flatten,
                      simplify, transform, makeCurve shapes     src/mpe.js  MPE/MIDI controller decoder
  src/evaluate.js     evaluateComposition: a lint of the song as written (evaluate_composition)
  src/music.js        notes, scales, chords, roman numerals (data: scales.js, chords.js, progressions.js)
  src/harmony.js      a chord in a key: keyContext, readChord, numeralFor (the inverse of romanToChord), functionOf,
                      analyzeChord, chordTension, detectChords, detectKey, chordsFromNotes
  src/chordflow.js    suggestNext, substitutions, neoRiemannian, negativeHarmony, modulationPaths, library search
  src/voicelead.js    voiceLead (Viterbi over voicings)   src/patterns.js  arpeggiate, euclid, drumPattern (16 styles)
  src/rng.js          createRng(seed): generators never use Math.random
  src/tuning.js       tuning systems: normalizeTuning, tuningCents, tunedFrequency, tuningTable, chordPurity
  src/notation.js     step strings ("x---x---"), positions ("5.3.2"), durations ("1/8t"), compact note text
                      (parseNoteText / formatNoteText: "1.1 D3+A3+F4 1/2 v0.7") — one grammar for every tool
  src/diff.js         diffProjects: what changed between two project states, in words (diff_versions, dry runs,
                      the Versions window)      src/suggest.js  nearest / didYouMean for error messages
  src/renders.js      audioFingerprint, nullTest (subtract two renders), maskingReport (Bark bands), compareRenders
  src/av.js           audio → visual bridge: channel slugs, avMap, automation/visual-lane values at a tick, spectrum
                      features, onset detector, avFrameToOsc (the OSC address map: add, never rename), encodeOsc/decodeOsc
  src/builders.js     chord/bass/melody/roll generators
  src/templates.js    genre starter projects: build() + the menu order; each genre is src/templates/<id>.js { label, spec }
  src/analysis.js     LUFS/peak/spectrum/tempo/key/pitch + createLevelMeter (streaming, used for render stems)
  src/audioedit.js    sample edits on clips { sampleRate, channels } (cut/paste/fades/gain/normalize/reverse/speed/stretch…),
                      applyEdit = one named op (what edit_sample sends); every op returns a NEW clip (undo keeps old ones)
  src/autotune.js     YIN pitch tracking, vibrato-proof note segmentation, correction curve, TD-PSOLA, WSOLA, pitch shift
  src/midi.js wav.js (multichannel/extensible + extra chunks) summary.js timeline.js constants.js
packages/synth-dsp/  @greanteadawy/synth-dsp — the GGS Synth engine: plain JS, NO dependencies, no Node/DOM APIs (it runs in
                      an AudioWorklet and in Node). params.js (flat schema, a description per param, migrateParams),
                      voice.js, filters.js (21 models + filterResponse), chaos.js (Lorenz/Rössler/drift/Turing sources),
                      fx.js, wavetables.js (46 tables), presets.js, patch.js (documents, describeRoute, modulationRanges),
                      render.js (headless), util.js (Arena: a voice's memory in one block), unison.js (detune laws, stacks);
                      effects/ (STUDIO_FX: 14 mixer effects as StudioFx classes — base.js has the helpers and the class),
                      engines/ (SYNTH_ENGINES: Analog, Additive, Modal — one SynthEngine instance per note);
                      scripts/bench.mjs, level-presets.mjs
server/src/
  index.js            createServer(): express app, security headers, auth, /api, /mcp, static client, WebSocket hub
  auth/               users.js (scrypt, API tokens gtd_…), sessions.js (cookie gtd_session), http.js, routes.js
  store.js            per-user JSON project store, per-project lock, undo stack for MCP edits, versions
  samples.js          per-user sample library + folders (folders.json), usage scan, replace (rev), WAV analysis in a worker
  hub.js              WebSocket live sync, activity log, transport relay, browser "jobs" (render/analyse/generate)
  api.js              REST routes          backend.js  local/remote backend used by MCP tools
  ffmpeg.js           optional ffmpeg detection + safe conversions (MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF)
  av.js               audio → visual bridge: AV_OSC, the one-tab OSC lock (admins only), UDP sender (hub: 'av', 'subscribe-av')
  plugins.js zip.js sandbox.js   user plugins: store + worklet harness, hardened zip reader, generator sandbox page
  synth-worker.js     renders + analyses GGS notes in a worker thread (analyze_synth_patch: no browser needed)
  mcp/                tools.js (server factory: every call goes through `call` — validation, dryRun, `batch`),
                      validate.js (tool input checked here, with errors that say the fix), session.js (a dry run
                      or a batch: the backend works on a copy and refuses anything but reads and ops),
                      tools/*.js (102 tools; production.js = groove/fills/transitions, export.js, spatial.js,
                      plugins.js, synth.js = GGS patches, expression.js = per-note curves + evaluate_composition,
                      harmony.js = harmony / add_arpeggio / add_drum_groove / set_tuning / describe_tuning),
                      guide.js (what Claude reads: notation + mixing-by-numbers), prompts.js, http.js, stdio.js
client/src/
  state/store.js      zustand store: auth, project (optimistic ops + undo/redo), UI windows/prefs
  state/sync.js       WebSocket client: outbox, acks/rejects, resync, remote ops, jobs, deleted-project recovery
  audio/              engine.js (graph + lookahead Transport), instruments.js, effects.js, render.js (offline),
                      band.js + models.js + modelPool.js/modelWorker.js (physical models pre-rendered in workers),
                      world.js (flutes, beatbox, Indian & East Asian voices; their strings are models.js models),
                      spatial.js (SpatialRig: binaural / speakers / objects), plugins.js (plugin voices & effects),
                      ggs-synth/ (worklet.js = ggs-voice + ggs-fx processors, index.js = GgsChannel + ggsVoice,
                      module.js = the one Vite-specific import of the worklet URL),
                      editWorker.js (slow sample edits, pitch analysis/correction off the main thread)
  lib/                actions.js, jobs.js (browser jobs for MCP), sandbox.js (generator iframe), keyboard.js, hooks.js,
                      avBridge.js (Send to visuals: 60 fps frames from the playing tab; engine.noteTap, side-branch meters),
                      version.js (app name + version from client/package.json, shown in the About dialog),
                      audioEdit.js (decode at native rate, worker calls, WAV save/replace, the sample-edit job),
                      recorder.js (MicSession: getUserMedia → AudioWorklet capture, meter, monitor)
  components/         SampleLibrary.jsx (Samples tab: folders, search, select mode), WaveEditor.jsx + PitchView.jsx,
                      Harmony.jsx (chords that fit, the progression strip, the library, the tuning table),
                      Recorder.jsx, SynthEditor.jsx (GGS Synth, inside Channel settings) + synth/ (EnvelopeEditor,
                      FilterGraph, PresetBrowser, WavetablePicker, ParamTable, SourceBar, StepEditor, modulation.js;
                      SynthPage.jsx = the synth page (the /synth editor's layout and colours, scaled to fit; the
                      classic tabs are the other view), pageModules.jsx = its modules, displays.jsx = the pictures,
                      pageLayout.js = rows of modules as pure data, saved in localStorage),
                      ExpressionLane.jsx (the piano roll's pitch / pressure / slide lane); ui/frames.js = the one
                      animation-frame loop for things that follow the audio thread (live dots, meters)
                      … one file per window (Playlist, ChannelRack, PianoRoll, Mixer, …) + ui/ primitives
client/public/        recorder-worklet.js (served as /recorder-worklet.js: CSP script-src 'self' allows addModule)
e2e/                  Playwright specs (real browser + MCP client acting as Claude)
fixtures/av/          audio → visual test song + a real capture of the bridge (npm run fixture:av / av:replay)
plugins/examples/     example plugins (npm run plugin:pack -- --examples → plugins/dist/*.zip)
skills/               music-production skills for Claude Desktop / claude.ai users (npm run skills:pack)
docs/                 user & developer docs; docs/MCP.md is generated
```

## Commands

```bash
npm install
npm run dev          # server :3001 + Vite :5173 (proxy /api /mcp /ws)
npm run dev:local    # the same with NO_LOGIN=1: no sign-in screen, everyone is the one local account (this computer only)
npm test             # core, synth-dsp, server and client unit/integration tests (node:test)
npm run bench:synth  # GGS Synth CPU per voice (compare with docs/audio-benchmarks.md)
npm run lint         # ESLint (must be clean)
npm run test:e2e     # builds the client, runs Playwright against a throwaway server (port 3199);
                     # E2E_CHROMIUM=/path/to/chromium uses an installed browser instead of `playwright install`
npm run screenshots  # regenerates docs/screenshots/*.png
npm run docs:mcp     # regenerates docs/MCP.md from the live tool definitions
npm run docs:av      # regenerates docs/av-bible.pdf (audio → visual bible, Spanish) from the catalogs (needs Chromium)
npm run fixture:av   # rebuilds fixtures/av (test song + a real capture of the bridge's OSC; stems to --stems); needs a build
npm run av:replay    # plays fixtures/av/osc-capture.jsonl.gz to 127.0.0.1:7000 (-- --to host:port --loop --speed 1)
npm run plugin:pack -- <folder> | --examples   # validate + zip a plugin
npm run skills:pack  # zips skills/* for upload to Claude Desktop / claude.ai (skills/dist)
npm start            # production server (serves client/dist)
```

Before finishing any change: `npm run lint && npm test`, and `npm run test:e2e` when the client or the
server↔browser protocol changed. Update docs (and `npm run docs:mcp` for tool changes).

## Core conventions (read before editing)

- **Time**: ticks, `PPQ = 96` per beat, `STEP = 24` (a 16th). Bars come from `ticksPerBar(project)` (time-sig aware).
  MCP tools speak 16th-note *steps* (0-based inside patterns) and *bars/tracks* (1-based); bar ranges are inclusive.
- **Ops are the only way to change a project.** Add a new op type in `core/src/ops.js` (+ `prepareOps` if it creates
  ids, + `describeOps`) rather than mutating projects anywhere else. `applyOps` must be deterministic: random ids/colours
  are filled in by `prepareOps` *before* applying, so the sender, the server and other tabs build identical projects.
- **Normalize at the boundary**: anything loaded from disk, imported or restored goes through `normalizeProject`.
- **Param definitions are the single source of truth** for instruments/effects (ranges, units, automatable).
  Use `sanitizeParams(defs, params, { strict: true })` for validated input (MCP), non-strict to clamp.
- **Ownership**: every project/sample/export belongs to a user. Server code must use `store.getOwned(id, userId)` /
  `samples.get(id, userId)` — never return another user's data, and respond 404 (not 403) for foreign ids.
- **Auth**: browser = `gtd_session` cookie; scripts/MCP = personal API token `gtd_…` (Bearer or `?token=` for MCP/WS).
  Tokens can't use `/admin/*`, `/me/password` or token management (`auth.requireSession`). Token-less MCP only works
  from this computer when the admin allows it (`isLocalRequest` in `mcp/http.js`).
- **MCP tools** (`server/src/mcp/tools/*.js`): zod input schemas with `.describe()` on every non-obvious field
  (the description is quoted in validation errors), annotations from `util.js`, errors thrown as `Error` (the wrapper
  turns them into `isError` results with a message that tells Claude how to recover — name the valid values and use
  `didYouMean`), replies that include the ids of created things in `[brackets]`. Validate everything *before* the
  first `backend.applyOps` so a failed call changes nothing.
  A tool that is not read-only and only uses `backend.applyOps` (plus reads) gets `dryRun` and can run inside
  `batch` without any code of its own: its handler runs in an `EditSession` (AsyncLocalStorage), where `applyOps`
  works on a copy. A tool that does more (files, playback, browser jobs, versions, samples, other projects) must be
  listed in `MORE_THAN_EDITS` in `tools.js`; a new backend method must be added to `READS` in `session.js` if it
  only reads, or it is refused inside sessions. Always use the `backend` from the registration context (never a
  captured store): that is what makes the session work. Unknown arguments are errors — never rely on them being
  dropped.
- **Renders are not bit-exact in a browser**: Chromium sums three or more inputs of a node in an order that differs
  from run to run (the last bit of the samples changes, about −110 dB). Never compare renders by hash or by exact
  samples: use `nullTest` (core/renders.js) with a tolerance, as `render_mix` does. In Node (`renderPatch`) renders
  are bit-identical.
- **Browser jobs**: work that needs Web Audio or the plugin sandbox (`render`, `analyze-sample`, `sound`,
  `export-stems`, `spatial`, `generator`; `JOB_KINDS` in `api.js`) runs in the user's tab via `hub.requestJob` → WS
  `job` → `client/src/lib/jobs.js` → `POST /api/jobs/:id/result` (stems upload each file to `/api/jobs/:id/files`
  first). Progress is forwarded to MCP progress notifications.
- **Client state**: subscribe to the narrowest slice (`useStore((s) => s.x)`); never put `useStore.getState()` in a
  hook dependency list (it changes on every update). Panels are memoized in `App.jsx`.
- **Audio engine**: realtime uses a lookahead scheduler; offline render (`audio/render.js`) schedules in chunks with
  `OfflineAudioContext.suspend()` and reaps finished voices — keep both paths in mind when touching `Transport`.
  Velocity → gain is squared (`velocityGain`) and timbre is scaled by `timbre(velRaw, floor)` normalized to 1 at 0.8:
  keep new instruments consistent. Note-driven sidechain: `triggerNote` calls `pump.trigger()` for its source channel.
- **Effect params of type `channel`** (e.g. the pump's `source`) hold a channel id; MCP tools accept names and resolve
  them (`resolveEffectParams` in `mcp/tools/mix.js`); the UI shows a channel picker (`ParamControls`).
- **Changing sound defaults changes existing songs** (velocity curve, limiter makeup, reverb IR): keep levels
  comparable (the convolver normalizes every generated room), check a render before/after, and note it in
  `CHANGELOG.md`.
- **Web Audio units**: the Q of low-/high-pass biquads is in **dB** (`FLAT_Q = -3.0103` = Butterworth, no bump);
  peaking/band-pass Q is linear (`FLAT_Q` lives in `audio/dsp.js`). `DynamicsCompressorNode` looks ahead 6 ms, truncated
  to whole frames (264 @ 44.1 kHz): delay parallel dry paths by `Math.floor(0.006 * sampleRate)` frames.
- **Plugins are untrusted code.** The server must never execute them; DSP code is only ever served through
  `workletModule()` (AudioWorklet-only harness), generator code only as text into the sandbox iframe
  (`lib/sandbox.js` ↔ `server/src/sandbox.js`). Everything coming back (audio, notes, params, manifest text) is data
  that gets validated/cleaned (`cleanGeneratedNotes`, `sanitizePluginValues`, harness `clean`). Installing needs a
  browser session and `trust: true`; never add a path that installs or enables a plugin from MCP/API tokens. A
  project must keep working when a plugin is missing (silent channel, pass-through effect, settings kept).
- **Notes carry a performance**: optional `expression` ({ pitch, pressure, timbre } curves in normalized note time)
  and `releaseVelocity`. Edit them with the `notes/expression` op (patches one curve, keeps the others). Any code
  that creates notes from notes (copy, duplicate, paste, import) must carry `expressionFields(n)` and `pan`.
- **GGS Synth** (`ggs`): its ~520 flat params (64 matrix slots × 4, 8 macros, 2 chaos, drawn LFO steps) live in
  `packages/synth-dsp/src/params.js` (the catalog imports them);
  each has a `desc`. A renamed param is mapped in `migrateParams` (the catalog's `migrate` hook runs it on load and on
  ops). Structural changes on a sounding voice fade (`SWAP_KEYS` in `voice.js`) — never swap a table or a filter
  model under a held note without it.
  One AudioWorklet processor per note; the patch travels in `processorOptions`, and gate / kill / pitch / pressure /
  timbre / macros are AudioParams — never make note timing depend on port messages (offline renders must repeat).
  A note is also told where the song stands when it starts (`beat`: the transport's position, or `engine.beatAt`
  for notes played by hand): "free" LFOs and tempo-locked patterns follow that, never the context's clock.
  No allocation or string-keyed lookups in the render path — and no function call that takes numbers per sample
  (an un-inlined call boxes them: write the maths out in the loop); a voice's typed arrays over 64 bytes come from
  its `Arena`. No `Math.random()` in the engine (seeded per note). What the editor shows live (knob rings' dots,
  source meters) is reported by the voices over their port while a channel is watched (`GgsChannel.setWatch`): audio
  must never depend on those messages, and offline renders never send them.
  Presets are levelled by measurement (`scripts/level-presets.mjs --write` after changing one). See the `ggs-synth` skill.
- **Studio effects and engines** (`packages/synth-dsp/src/effects`, `engines`): a class carries its own `type`, label,
  description and param defs (a `description` per param — the catalog, the UI and MCP validation all read them), so
  registering it in `STUDIO_FX` / `SYNTH_ENGINES` is all it takes: the worklet makes a processor per type
  (`gtd-fx-<type>`, `gtd-voice-<type>`), core lists it (`EFFECTS[type].dsp`, `INSTRUMENTS[type].engine`; an effect also
  goes into `EFFECT_GROUPS`). Same rules as the GGS voice: deterministic, seeded, nothing allocated while processing,
  settings glide (a knob under a held note must not click), block size must not matter, a NaN in is not a NaN for
  ever. Every claim in a description is a test (`test/fx-*.test.js`, `engine-*.test.js`; `basicChecks` /
  `engineChecks` are the ones all must pass). An effect that syncs to the song reads the position it is told
  (`clock`), never its own count of samples. See `docs/effects-and-instruments.md`.
- **Audio → visual bridge** (`docs/av-bridge.md`): the OSC addresses are a contract with the visual side — add
  addresses, never rename or change argument types; keep a frame's order (transport → events, offs before notes →
  continuous → latency → map). Notes go out when they sound (the engine calls `noteTap.on/off`; nothing per sample),
  meters exist only while the bridge is on, and nothing in it may change the sound or offline renders. Automation
  `{ type: 'user', index: 1…8 }` is a visual lane: `resolveTarget` ignores it on purpose.
- **Spatial**: an insert with `spatial.enabled` is a 3D object; the `SpatialRig` (not the stereo router) connects it.
  Exports are rendered by the `spatial` job; positions automate `spatialX/Y/Z`. See `docs/spatial.md`.
- **Samples**: a sample's audio can be replaced (wave editor "Replace original", `edit_sample saveAs=replace`): the id stays,
  `rev` goes up. Files are cached as immutable, so always fetch them with `sampleFileUrl(id)` (`?v=rev`), never a bare
  `/api/samples/:id/file`. Folders are per user (`folderId` null = unfiled); bulk endpoints check every id before
  changing anything. Deleting/replacing asks first with `sampleUsage` (which projects, channels, clips).
- **Recording**: needs a secure context (HTTPS or localhost); the take is aligned with `Transport.play({ at })` + output/
  input latency. Long DSP (pitch, stretch, PSOLA) never runs on the main thread — use `runAudioJob` / `editClip`.
- **ffmpeg** is optional: everything must work (WAV) without it, and conversions only ever touch files the server
  wrote itself (`server/src/ffmpeg.js`: argument arrays, `-protocol_whitelist file`, forced `-f wav`, timeout).
- **Harmony** (`core/harmony.js`, `chordflow.js`): numerals are the key's own degrees; an accidental moves a degree
  unless the key already has that alteration (`bVII` in A minor = `VII`). `numeralFor` must stay the exact inverse of
  `romanToChord` (a test round-trips every chord type × root × bass in twelve kinds of key): change one, change both.
  The dictionaries are data files; add a spelling as an alias, never by special-casing a parser. Suggestion and
  tension weights are judgements — say why in the result (`why`), and keep answers deterministic.
- **Seeded generators**: anything that varies (arpeggio `random`, drum variation, fills) draws from `createRng(seed)`
  — never `Math.random()` — so the same call gives the same notes.
- **Tuning**: `project.tuning = { system, root, a4, … }` (`project/update { tuning }` is a patch; `null` = standard).
  `engine.triggerNote` passes `tune = tuningCents(project.tuning, key)` to `playNote`: 0 in standard tuning (no node,
  renders unchanged). GGS voices add it to their pitch in the worklet (`processorOptions.tune`); every other voice
  gets one ConstantSource into the `detune` of its tonal sources (`tuneVoice`), on top of bends and scoops. A tuning
  never moves its own root. `followsTuning(instrument)` decides who is retuned (not drums, not beatbox, not an
  unpitched sampler): a new instrument category that is not a pitch must be added there.
- Comments explain *why*; keep functions small; no new dependencies without a good reason (licence must be
  MIT-compatible — e.g. `audio-decode` was rejected for GPL decoders).

## Gotchas

- `DATA_DIR` defaults to `./data` — tests and e2e always use temp dirs; never point tests at real data.
- `NO_LOGIN=1` (or `npm run dev:local`) makes every request the first admin (`createAuth({ localUser })`): the status route says `noLogin`, MCP needs no token, and the server refuses a non-loopback `HOST`. Tests for it: `server/test/nologin.test.js`.
- On first start with no users the studio shows the admin setup screen; when `HOST` is not loopback a setup code is
  printed in the server log (or set `SETUP_CODE`).
- MCP HTTP responses are SSE (needed for progress) — raw `fetch` tests must send
  `Accept: application/json, text/event-stream` and parse `data:` lines (`readRpc` in `server/test/helpers.js`).
- Playwright in this repo uses `@playwright/test`; install browsers with `npx playwright install chromium`.
- The generator sandbox page has an **opaque origin**: to the browser its own `/sandbox/generator.js` is a
  cross-origin load (it must keep `Cross-Origin-Resource-Policy: cross-origin`), and it can't use cookies or the API.
- An AudioWorklet scope can't re-register a processor name: plugin processors are named with the package hash
  (`pluginProcessorName`), and modules load once per `AudioContext` (offline renders get their own).
- Physical-model notes (piano/guitar/bass/pizz and the world strings) are rendered in workers and cached; offline
  renders wait for the prewarm. Changing a model's rendered params invalidates its cache key — keep
  `MODELS[...].keys` accurate.
- The wave editor keeps its own undo history: its Ctrl+Z only works while it has focus (it re-focuses itself after a
  toolbar edit, `keepFocus`); with focus elsewhere Ctrl+Z undoes the project as usual. Its `busy` state is shared with
  the Pitch tab: claim it only when free and clear it only while it still holds your label; a save records the
  `stateId` it uploads (an edit landing during the upload stays unsaved).
- e2e with a microphone: launch Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`
  (a beeping fake input; see `e2e/workflow-samples.spec.js`). A test that drags in the pitch view finds a note block by
  its colour in the canvas.
- The CSS class `sel` means "selected" (clips, notes, rows); dropdowns are `.ui-select`. Window title bars drag from
  anywhere except real controls (`INTERACTIVE` in `ui/Window.jsx`); a custom control in a toolbar needs
  `data-nodrag` (or a role) so dragging it doesn't move the window.

## Project skills & agents

See `.claude/skills/` (add-instrument, add-effect, add-mcp-tool, add-project-op, spatial-audio, plugin-system,
write-plugin, export-formats, ggs-synth, test-and-qa, docs-and-release) and
`.claude/agents/` (`qa-reviewer` — read-only code review; `music-industry-advisor` — read-only product advice from a
20-year music-industry veteran's perspective). The top-level `skills/` folder is different: skills for *users* making
music with GreanTeaDawy from Claude Desktop / claude.ai (beat making, sound design & expression, mixing by numbers,
spatial, arranging, plugin authoring) — keep them in sync with the MCP tools and `guide.js`.
