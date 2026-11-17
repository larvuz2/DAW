# Audio → visual bridge

GreanTeaDawy can send what it plays to a visual app — TouchDesigner, Blender, Unreal, Max, a web page — about 60 times
a second: the transport, every note at the moment it sounds, levels, bands, a spectrum, onsets, the section of the
song, automation values and eight free **visual lanes**. It is phase 1 of the bridge described in the audio → visual
bible (`docs/av-bible.pdf`, chapter 7).

```
studio tab (plays, measures)  ──WebSocket {type:'av', frame}──▶  server  ──OSC/UDP──▶  visual app (AV_OSC, default 127.0.0.1:7000)
                                                                    └──WebSocket {type:'av', frame}──▶  apps that subscribed
```

## Switching it on

1. Start the studio on the computer that runs the visual app (`npm run dev:local`, or `npm start`).
2. In the studio: **☰ menu → Send to visuals**. The setting is remembered. A note says where the frames go.
3. Play. Frames flow while the tab is open, playing or not (stopped, they carry the playhead and the levels of notes
   played by hand).

Only one tab sends OSC at a time: the first one that sends, until it has been quiet for a second (another tab is told
"Another studio tab is sending to the visuals"). On a server with several accounts, only an **admin's** tab drives
OSC — the port belongs to the computer the server runs on.

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
It only ever gets its own account's frames.

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
`off` at once. Muted channels send no notes.

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

### Occasional

| Address | Args | Meaning |
|---|---|---|
| `/gtd/latency` | f | the output latency of the tab (seconds), once a second |
| `/gtd/map` | s | JSON: `{ project, id, bpm, timeSig, ppq, ticksPerBar, channels: [{slug, id, name, color, kind, insert}], buses: [{index, name}], markers: [{name, tick}], automations: [{id, name, target}] }` — when the project's shape changes and every 2 s |
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
lane holds its last value after its clip and is 0 before it ever played.

## Trying it without the studio

`fixtures/av/` holds a 16-bar song made for testing a visual setup, with a capture of what the real bridge sent while
it played. `npm run av:replay` plays that capture to `127.0.0.1:7000` with its original timing (`-- --to host:port`,
`-- --loop`). See `fixtures/av/README.md`.

## Not yet (phases 2 and 3)

The bible's later phases add, in this order: the GGS Synth's live modulation for every channel
(`/gtd/ggs/{channel}/src|dst/…`), effective channel and effect parameters (`/gtd/ch/{channel}/param/…`,
`/gtd/fx/{n}/{type}/{param}`), then 3D object positions (`/gtd/spatial/{n}`) and per-note expression
(`/gtd/ch/{channel}/expr/…`).

## For developers

- `packages/core/src/av.js`: slugs, the map, automation values at a tick, spectrum features, the onset detector, the
  frame → OSC mapping (`avFrameToOsc`) and the OSC 1.0 encoder. Shared by all three sides.
- `client/src/lib/avBridge.js`: the frame builder in the playing tab (timers, not animation frames: those stop in a
  hidden tab; Chrome doesn't slow the timers of a tab playing sound). The engine calls it back on each note
  (`engine.noteTap`); its meters are side branches made only while it runs.
- `server/src/av.js`: `AV_OSC`, the one-tab lock, the UDP socket; `hub.js` cases `av` and `subscribe-av`.
- Tests: `packages/core/test/av.test.js`, `client/test/avBridge.test.js`, `server/test/av.test.js` (a real UDP
  socket), `e2e/workflow-visuals.spec.js` (a real browser playing a song into a UDP socket).
