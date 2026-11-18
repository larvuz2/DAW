# Audio → visual bridge

GGS can send what it plays to a visual app — TouchDesigner, Blender, Unreal, Max, a web page — about 60 times
a second: the transport, every note at the moment it sounds, levels, bands, a spectrum, onsets, the section of the
song, automation values and eight free **visual lanes** (phase 1), plus where every control of the mix stands and the
GGS Synth's live modulation — envelopes, LFOs, chaos, macros, and what they do to the filter, the wavetable, the pitch —
for every GGS channel (phase 2), and where each 3D object stands in the room and how each sounding note bends, presses
and slides (phase 3). The phases are those of the audio → visual bible (`docs/av-bible.pdf`, chapter 7).

```
studio tab (plays, measures)  ──WebSocket {type:'av', frame}──▶  server  ──OSC/UDP──▶  visual app (AV_OSC, default 127.0.0.1:7000)
                                                                    └──WebSocket {type:'av', frame}──▶  apps that subscribed
```

## Switching it on

1. Start the studio on the computer that runs the visual app (`npm run dev:local`, or `npm start`).
2. In the studio: **☰ menu → Send to visuals**. The setting is remembered. A note says where the frames go.
3. Play. Frames flow while the tab is open, playing or not (stopped, they carry the playhead and the levels of notes
   played by hand).

One tab is heard at a time: the one sending, until it has been quiet for a second — but a tab that **plays** takes
over from one that is only stopped with the setting on (another tab is told "Another studio tab is sending to the
visuals"). On a server with several accounts, only an **admin's** tab drives OSC — the port belongs to the computer
the server runs on — and only admins are shown its address. A tab whose frames reach nobody (OSC off for it and no
WebSocket listener, or another tab heard while it is stopped) slows down to two frames a second.

### Where the OSC goes: `AV_OSC`

| `AV_OSC` | Meaning |
|---|---|
| *(unset)* | `127.0.0.1:7000` when `HOST` is this computer (the default), **off** when the server listens on the network (Docker, a server) |
| `host:port` | e.g. `192.168.1.20:7000`, `host.docker.internal:7000` (Docker → the host), `[::1]:7000` |
| `off` | no OSC (WebSocket subscribers still get frames) |

The server prints where it sends at start-up, and `GET /api/status` says it (`av.osc`).

### On a WebSocket instead of OSC

A program with the account's API token (☰ → Connect Claude) can open `ws://host:3001/ws?token=gtd_…`, send
`{"type":"subscribe-av"}`, and receive `{"type":"av","frame":{…}}` messages: the same frames as JSON (fields below).
It only ever gets its own account's frames, from one tab at a time (the same rule as OSC); a listener that can't keep
up loses frames rather than queueing them.

A frame's fields, and the OSC they become (`avFrameToOsc` in `packages/core/src/av.js` is the exact translation):
`playing bpm tick ppq tpb time` (transport), `marker {name, tick}`, `offs [{ch, key, rel}]`, `notes [{ch, key, vel,
dur, at}]`, `master {peak, rms, bands, spectrum, centroid, onset}`, `buses {n: peak}`, `ch {slug: level}`, `auto {id:
v}`, `user [8]`, then phase 2: `param {slug: {key: v}}`, `busParam {n: {key: v}}`, `fx {n: {effect: {key: v}}}`,
`ggs {slug: {voices, src: {key: v}, dst: {key: [value, n]}}}`, phase 3: `spatial {n: [x, y, z]}`, `expr [{ch, key,
dim, v}]`, and `latency`, `map`, `full`, `final` (the last frame of a tab that switches off).

### Receiving OSC: give the socket room

A frame is up to a few hundred UDP messages sent at once (the first frame, with every control, is the biggest). A
receiver whose socket buffer is small drops the end of a burst — that is where the map and the latency sit. Enlarge
it: in Python `sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)` (python-osc: on the server's
`socket`), in Node `socket.setRecvBufferSize(4 << 20)`; TouchDesigner's and Unreal's OSC receivers read on their own
thread and keep up at these rates. On Linux the system caps it at `net.core.rmem_max`, on macOS at
`kern.ipc.maxsockbuf`.

## The messages

Every frame is a run of individual OSC messages (no bundles), always in this order: **transport → events →
continuous values → latency → map**. Ignore addresses you don't know: new ones are added, existing ones never change.
Values marked 0…1 are clamped to that range.

### Transport (every frame)

| Address | Args | Meaning |
|---|---|---|
| `/gtd/transport/playing` | i | 1 while playing, 0 stopped |
| `/gtd/transport/bpm` | f | tempo |
| `/gtd/transport/tick` | i | position in ticks (96 per beat). Song mode: from the song start; pattern mode: from the pattern start. Stopped: the playlist's playhead |
| `/gtd/transport/beat` | f | tick / 96 |
| `/gtd/transport/bar` | i | 1-based bar (time signature aware) |
| `/gtd/transport/phase/beat` | f | 0…1 inside the beat |
| `/gtd/transport/phase/bar` | f | 0…1 inside the bar |
| `/gtd/transport/time` | f | the AudioContext clock (seconds) at this frame — the clock `at` is on |

### Events (only in the frame where they happen)

| Address | Args | Meaning |
|---|---|---|
| `/gtd/marker` | s i | name, tick: the song entered the section of this marker (also sent when the bridge starts) |
| `/gtd/ch/{channel}/note` | i f f f | key (0–127, after the channel's transpose), velocity 0…1, duration in seconds (0 = a key held by hand: wait for its `off`), `at` = when it sounds on the AudioContext clock |
| `/gtd/ch/{channel}/off` | i f | key, release velocity 0…1 (0.5 when the note just ends) |
| `/gtd/master/onset` | f | an onset (spectral flux), strength 0…1; at most one per 80 ms |

A note goes out in the frame nearest the moment it is **heard** (never more than half a frame early), not when the
studio schedules it 120 ms ahead — so a visual can react on arrival. `at − /gtd/transport/time` says how far from
that frame it really sounds: within ±8 ms, at most about one frame (−17 ms) when the browser's timer skips a beat
(measured over the fixture's 32 s: −17.6 … +8.3 ms). When playback stops, notes that never sounded are dropped and the ones sounding get their
`off` at once. A note cut short by another — a choke group (an open hat closed by the closed one), a mono synth,
the polyphony limit — gets its `off` when it is cut. Switching the bridge off ends every note the visuals were told
about, keys held by hand included. Muted channels send no notes.

`at` and `/gtd/transport/time` are 32-bit floats on a clock that starts when the tab first makes sound: they stay
within 1 ms for the first ~2 hours, 2 ms up to ~9 hours (reload the studio before a very long show).

### Continuous values (every frame)

| Address | Args | Meaning |
|---|---|---|
| `/gtd/master/peak` | f | master peak 0…1 (linear) over the last ~43 ms |
| `/gtd/master/rms` | f | master RMS 0…1 over the same window |
| `/gtd/master/bands` | f×6 | sub 20–60 Hz, low 60–250, lowMid 250–500, mid 500–2k, highMid 2k–6k, high 6k–20k: power average shown 0…1 for −90 … −20 dB |
| `/gtd/master/spectrum` | f×32 | 32 log-spaced bands, 20 Hz–20 kHz, same 0…1 scale |
| `/gtd/master/centroid` | f | spectral centroid in Hz ("brightness"; 0 in silence) |
| `/gtd/bus/{n}/peak` | f | peak of mixer insert n (0 = master) — only inserts in use (channels play into them, effects, a name) |
| `/gtd/ch/{channel}/level` | f | peak of the channel after its fader, ~21 ms window |
| `/gtd/auto/{automationId}` | f | every automation that has played: its value 0…1 inside its clip, held after it |
| `/gtd/user/{1…8}` | f | the eight visual lanes, 0…1 (0 until a lane has played; held after its clip) |

Automation and visual lanes follow the song position (in pattern mode and while stopped, the playlist's playhead).

### Controls and the GGS Synth (phase 2: when they change, and each again once a second)

These go out in a frame only when their value changed since the last frame — so a still mix costs nothing — and each
one again once a second, in its own frame of the second (a few in every frame, never all in one: one burst of
hundreds of UDP messages is what a receiver drops), so a visual app that starts late has them all within a second.
A frame marked `"full": 1` (WebSocket) carries every value at once: the first frame, and the next one after a frame
that could not be sent, a takeover of the OSC port, or a change in the project's names (a renamed channel). They come
after the visual lanes and before the latency.

| Address | Args | Meaning |
|---|---|---|
| `/gtd/ch/{channel}/param/{volume\|pan\|filterCutoff\|filterRes\|pitch\|mute}` | f | the channel strip, 0…1: its setting, or what automation makes it while the song plays (stopped, the engine puts automated controls back to their settings). volume 1 = +1.9 dB (0.8 = 0 dB), pan 0.5 = centre, filterCutoff log 20 Hz … 20 kHz, filterRes log 0.1 … 20, pitch −24 … +24 semitones (0.5 = none; a playing pitch clip adds to it), mute 1 = silent (muted, or another channel soloed) |
| `/gtd/ch/{channel}/param/macro{1…8}` | f | a GGS channel's macros, 0…1 (setting or automation) |
| `/gtd/bus/{n}/param/{volume\|pan\|mute}` | f | each mixer insert in use, the same way (0 = master; its 0 dB is 0.8; automation saved as insert 0 counts for it). mute 1 = silent: muted, or another insert soloed that it doesn't play into. A 3D object's pan is where its x puts it (its pan knob does nothing) |
| `/gtd/fx/{n}/{effect}/{param}` | f | every effect on insert n: `enabled` 0/1, each number param 0…1 of its range (log params on a log scale, as automation draws them), switches 0/1. `{effect}` is its type, a second one of the same type `_2` (`reverb`, `reverb_2`); the map lists them. A plugin effect sends `enabled` only |
| `/gtd/ggs/{channel}/voices` | i | how many notes the channel is sounding (releases included) |
| `/gtd/ggs/{channel}/src/{source}` | f | its 25 modulation sources as the newest note has them: `env1…4` 0…1, `lfo1…4` −1…1, `velocity`, `pressure`, `timbre` 0…1, `bend` −4…4 (octaves: ±1 = ±12 semitones), `key`, `random` −1…1, `releaseVel` 0…1, `macro1…8` 0…1, `chaos1…2` −1…1. Nothing sounding: 0 (the macros where they stand) |
| `/gtd/ggs/{channel}/dst/{target}` | f | its 39 modulation targets where the matrix has taken them, in the unit of their knob: `f1Cutoff`/`f2Cutoff` Hz, `pitch`/`osc{A,B,C}Pitch` semitones, `osc{A,B,C}Pos` 0…1 of the wavetable, `level`, `pan`, `lfo{1…4}Rate` Hz or ×tempo… Nothing sounding: their settings |
| `/gtd/ggs/{channel}/dst/{target}/n` | f | the same as 0…1 of its control's range (cutoffs on a log scale); for an offset without a range (pitch, LFO rate) 0.5 + depth/2, so 0.5 = unmodulated (a route to a free-running LFO's rate does nothing: 0.5) |

The sources and targets are the GGS Synth's own (the bible's table 6.2 describes each). A voice reports them about 30
times a second, so they step at 30 Hz inside 60 frames; they follow the audio thread, a few ms ahead of what reaches
the speakers (like the notes: see `/gtd/latency`). While the bridge is on and someone hears it, every GGS channel's
voices report — as when the synth editor is open on a channel — which costs a little CPU on the audio thread and
nothing in the sound.

A channel that goes away (deleted, renamed, or a GGS channel turned into another instrument) gets a last value once:
`/gtd/ch/{channel}/param/mute 1`, and `/gtd/ggs/{channel}/voices 0` with its sources at 0. One frame becomes at most
4096 phase 2 and 3 messages (a whole big project is about 1500).

### 3D objects and note expression (phase 3)

The same way as phase 2 — when they move, and each again once a second — after the GGS values:

| Address | Args | Meaning |
|---|---|---|
| `/gtd/spatial/{n}` | f f f | where 3D object n (a mixer insert) stands, in room units: x −1 (left) … 1 (right), y −1 (back) … 1 (front), z 0 (floor) … 1 (ceiling) — its place, or its `spatialX/Y/Z` automation while the song plays. Only while the project's spatial mix is on; the map lists the objects (`objects: [{insert, name}]`) |
| `/gtd/ch/{channel}/expr/{pitch\|pressure\|timbre}` | i f | key, value: a sounding note's expression as it moves — its written curves (pitch in semitones −48…48, pressure and timbre 0…1), or a finger on an MPE controller. Only notes that have them, from the frame of their `note` to the frame before their `off` (a cut note stops at the cut). The key is the one its `note` gave; two notes on one key at once share the address. Pressure and timbre are sent as the performance says them, whatever the instrument does with them (the GGS Synth plays all three; the other instruments follow the pitch) |

### Occasional

| Address | Args | Meaning |
|---|---|---|
| `/gtd/latency` | f | the output latency of the tab (seconds), once a second |
| `/gtd/map` | s | JSON: `{ project, id, bpm, timeSig, ppq, ticksPerBar, channels: [{slug, id, name, color, kind, insert}], buses: [{index, name}], effects: [{insert, slug, type, id}], objects: [{insert, name}], markers: [{name, tick}], automations: [{id, name, target}] }` — when the project's shape changes and every 2 s. At most 8 KB (macOS refuses bigger UDP messages): a bigger map leaves out `automations`, then `effects`, then `markers`, and if still too big only the `/gtd/map/ch/…` messages carry it (the WebSocket frame always has all of it) |
| `/gtd/map/ch/{channel}` | s s s i | id, colour, instrument kind, mixer insert — the map for apps that can't parse JSON |
| `/gtd/map/bus/{n}` | s | insert name |

### Names: `{channel}`

The channel's name in lower case with anything but a–z and 0–9 turned into `_` (accents folded): "Lead Synth" →
`lead_synth`, "Bajo (sub)" → `bajo_sub`. The same name twice: `kick`, `kick_2`. Renaming a channel renames its
addresses (the map says so at once).

## Visual lanes: `/gtd/user/1…8`

Automation that moves nothing in the sound: a curve for the visuals to follow (a glow, a camera orbit, a colour
fade). In the studio: **Playlist → Auto + → Visual lanes → Lane n**, then draw it in the automation editor like any
automation; it lives in the playlist as a clip. Claude: `add_automation target={type:"user", lane:n}`. Values 0…1; a
lane holds its last value after its clip and is 0 before it ever played. Several clips on one lane: the one playing
decides, else the one that ended last (the engine's rule for any automated parameter).

## Trying it without the studio

`fixtures/av/` holds a 16-bar song made for testing a visual setup, with a capture of what the real bridge sent while
it played. `npm run av:replay` plays that capture to `127.0.0.1:7000` with its original timing (`-- --to host:port`,
`-- --loop`). See `fixtures/av/README.md`.

## Not sent

The master's waveform and its full 1024-bin spectrum, per-channel spectra, and the loop range: ask if a scene needs
them (the bible lists what the engine has).

## For developers

- `packages/core/src/av.js`: slugs, the map, automation values at a tick (`targetValuesAt`: the engine's rule per
  target), the effective values of every control (`effectiveValuesAt`), the GGS telemetry in units (`ggsTelemetry`),
  3D positions (`objectPositionsAt`), a note's expression at a moment (`expressionAt`),
  spectrum features, the onset detector, the frame → OSC mapping (`avFrameToOsc`) and the OSC 1.0 encoder. Shared by
  all three sides. `normalizeParam` / `denormalizeParam` (core `effects.js`) are the one 0…1 ↔ range mapping, used by
  the engine's automation and by the bridge.
- GGS telemetry: `GgsChannel.setWatch(on, who)` — the synth editor (`'editor'`) and the bridge (`'av'`) each watch;
  the voices report while anyone does.
- Expression: `engine.triggerNote` hands the tap a note's curves (`noteTap.on(…, { curves, seconds })`) and
  `setVoiceExpression` reports a finger's moves (`noteTap.expr`); the bridge evaluates curves on the AudioContext
  clock, never per sample.
- `client/src/lib/avBridge.js`: the frame builder in the playing tab (timers, not animation frames: those stop in a
  hidden tab; Chrome doesn't slow the timers of a tab playing sound). The engine calls it back on each note
  (`engine.noteTap`); its meters are side branches made only while it runs.
- `server/src/av.js`: `AV_OSC`, the one-tab lock, the UDP socket; `hub.js` cases `av` and `subscribe-av`.
- Tests: `packages/core/test/av.test.js`, `client/test/avBridge.test.js`, `server/test/av.test.js` (a real UDP
  socket), `e2e/workflow-visuals.spec.js` (a real browser playing a song into a UDP socket).
