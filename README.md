# ◆ GGS

**A pattern-based browser DAW — with Claude as your co-producer.**

GGS is an open-source, self-hosted beat-making studio: channel rack and step sequencer, piano roll, playlist,
mixer with effects, automation, sampler and audio clips, all running in the browser with a Node.js backend. Its
built-in [MCP](https://modelcontextprotocol.io) server gives Claude 104 music-production tools, so you can say
*"make a dark trap beat at 145 BPM and mix it for streaming"* and watch every edit appear live in your studio.

[![MIT licence](https://img.shields.io/badge/licence-MIT-green.svg)](LICENSE)
![Node 20.19+](https://img.shields.io/badge/node-%E2%89%A520.19-339933)
![React 19](https://img.shields.io/badge/react-19-61dafb)
![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-orange)

[![The studio: playlist, channel rack and piano roll](docs/screenshots/studio.png)](docs/screenshots/studio.png)

> GGS is an independent experimental project. It is not affiliated with or endorsed by a Music Software company.

## Contents

- [Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [Make music with Claude](#make-music-with-claude)
- [Configuration](#configuration) · [Docker](#docker) · [Documentation](#documentation) · [Development](#development)
- [Security](#security) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Licence](#licence)

## Features

**Studio**

- **Channel rack & step sequencer** — per-channel volume/pan/mute/solo, swing, pattern length, fills, randomize,
  choke groups, per-channel groove (nudge in ms, swing share), mini piano-roll previews for melodic channels.
- **Expressive velocity** — a hardware-style squared curve, and softer notes are darker (drums, filters, FM, sampler,
  piano/guitar/bass tone).
- **GGS Synth** — an original wavetable / FM hybrid synthesizer: 3 wavetable oscillators (46 band-limited tables,
  unison, warp, FM), sub + noise, 2 routable filters with 21 models (clean, ladder, acid, MS-20, formant, phaser,
  combs), 4 envelopes with delay, hold and a curve per slope, 4 LFOs (with shapes you draw), 2 chaos generators
  (Lorenz, Rössler, drift, Turing machine), 8 macros, a 64-route modulation matrix and built-in drive / chorus /
  delay / reverb. Its editor is hands-on: drag a source onto a knob and it wears a ring; a dot on the ring shows
  where the control really is while a note sounds. Drag the nodes of an envelope, the handle on a filter's measured
  response; browse presets and wavetables by search and sight; read every route in real units. It opens on the
  **synth page**: the whole patch on one screen, laid out and coloured like the /synth editor and scaled to fit any
  window, in modules you can rearrange, resize, hide and save as layouts — full screen for recording a video; the
  classic tabs are one click away. 31 presets levelled by measurement. → [docs/ggs-synth.md](docs/ggs-synth.md)
- **Per-note expression (MPE-style)** — every note has its own pitch, pressure and slide curve and a release
  velocity: draw them in the piano roll's expression lane, play them in from an MPE controller (or any keyboard),
  have Claude write them. Bend one note of a chord; pitch curves work on every instrument.
  → [docs/expression-engine.md](docs/expression-engine.md)
- **Instruments** — synthesized kick, snare, clap, hats, toms, rim, cowbell, cymbal, shaker, perc; 808 bass with glide
  and distortion; 3-oscillator subtractive synth; FM synth; the **GGS Synth**; **sampler** for your own audio; and a GarageBand-style
  band: modelled **grand piano**, **electric piano** (tine/reed), **drawbar organ** (percussion, rotary), **guitar**
  (acoustic/nylon/electric), **bass guitar** (finger/pick/slap/upright) and **strings** (ensemble or solo; legato,
  staccato, pizzicato). Four world collections: **flutes** (concert, pan, recorder, tin whistle, ocarina),
  **beatbox** (mouth kick, snares, hats, bass, scratch/click-roll FX), **Indian** (sitar with jawari and sympathetic
  strings, tanpura, tabla bols, bansuri, shehnai, santoor, harmonium) and **East Asian** (koto, guzheng, pipa,
  shamisen, erhu, shakuhachi, dizi, suona, taiko, gong): 48 instruments, about 230 presets, plus Japanese
  pentatonic and Indian thaat scales.
- **Piano roll** — draw/select/erase tools, chord stamp, snap, quantize, legato, humanize, scale highlighting, ghost
  notes, velocity lane, copy/paste/duplicate, keyboard nudging.
- **Chord grid** — every chord of the key on one colour-coded grid, with borrowed chords, tritone substitutes and
  extensions beside it, suggestions that light up after each chord, eight voicings, voice leading, tensions with
  avoid notes, strum and humanize, and a track of cards that loops against the song and writes to a pattern. The
  harmonic engine is [Tuple](https://github.com/c0remusic/tuple)'s (MIT). See [The chord grid](docs/chord-grid.md).
- **Harmony & tuning** — a Harmony window with the chords that fit the key and what could follow them (ranked,
  coloured by function, each with its reason), the progression with its tension curve, substitutes for any chord,
  a library of 82 progressions and voice-led writing into a pattern; 57 scales and 65 chord types; and the project's
  **tuning**: just intonation, Pythagorean, meantone, well temperaments, the harmonic series, other equal divisions
  or your own table, with exact ratios and any A4. See [Harmony and tuning](docs/harmony-and-tuning.md).
- **Playlist** — pattern, audio and automation clips on up to 200 tracks; section markers; audio clip gain, fades and
  repitch-to-tempo; loop region; song/pattern mode.
- **Mixer** — inserts with faders, pan, routing and sends; EQ with high/low-pass, filter, compressor (with parallel
  mix), delay, reverb (room size, frequency-dependent decay), distortion, chorus, phaser, bitcrusher, stereo width with
  mono bass, **kick-triggered sidechain**, and a limiter with a −1 dB default ceiling and an oversampled clip stage.
  Automation for any automatable param.
- **Studio effects** — fourteen more, as the studio's own DSP in the audio thread: a **true-peak look-ahead
  limiter**, multiband OTT, transient shaper, trance gate, an **algorithmic reverb** (16-line network, five voicings,
  freeze) and a **shimmer reverb**, resonator, flanger, tremolo / auto-pan, ring modulator, frequency shifter,
  disperser, vintage lo-fi and a utility — each measured by its own tests.
  See [Studio effects and the engine instruments](docs/effects-and-instruments.md).
- **Analog, Additive and Modal** — three more instruments: a subtractive synth with band-limited oscillators and
  **hard sync**, a 64-partial additive synth, and a modal synth of objects that ring (marimba, vibraphone, bells,
  harp, bowed bars).
- **Spatial (Dolby Atmos-style) mixing** — make inserts 3D objects in a room (x/y/height, LFE send), move them with
  automation, monitor **binaurally** on headphones, and export binaural, **5.1 / 7.1 / 7.1.4** WAVs, object stems with
  position data or an experimental **ADM BWF** ([docs/spatial.md](docs/spatial.md)).
- **Send to visuals** — what the studio plays, as **OSC** for TouchDesigner, Blender, Unreal (to `127.0.0.1:7000`,
  ~60 times a second): transport, every note as it sounds, levels, bands, spectrum, onsets, sections, automation,
  eight **visual lanes** you draw like automation, every control of the mix, the GGS Synth's live envelopes, LFOs
  and filter sweeps, where each 3D object stands in the room, and how each note bends and presses while it sounds. A recorded test song replays without the studio
  (`npm run av:replay`) — [docs/av-bridge.md](docs/av-bridge.md).
- **Song studies** — upload a song you like in a Claude session: it is analysed there (stems, tempo, key, chords,
  form, grooves, sounds, mix) and comes into the studio as a template with a study card
  ([docs/song-studies.md](docs/song-studies.md)).
- **Export formats** — WAV (16/24-bit), and with ffmpeg on the server MP3, AAC, Ogg Vorbis, Opus, FLAC, Apple
  Lossless, AIFF (Settings → Audio export shows what's available).
- **Plugins** — add your own **instruments** (DSP code or multisampled), **effects** and **note generators** as `.zip`
  packages. They run sandboxed in the browser (audio worklet / an isolated, network-less iframe), ask for explicit
  permissions and are only installed after you confirm you trust the author ([docs/plugins.md](docs/plugins.md),
  examples in [`plugins/`](plugins)).
- **Recording** — notes from the computer keyboard or a MIDI keyboard (Web MIDI), metronome, tap tempo; and **audio
  from a microphone**, alone or over the song/pattern with count-in, metronome and latency compensation: every take is
  saved as a sample and placed on the playlist where you recorded it.
- **Sample library** — upload or record WAV/MP3/OGG/FLAC/AIFF/M4A/WebM; **folders** (drag to file, bulk move/delete),
  **search** by name, folder, key or tempo; codec, sample rate, bit depth, bitrate, channels, tags plus an analysis
  (LUFS, peak, spectrum, tempo, key, pitch, one-shot vs loop). Deleting a sample in use says which projects it leaves
  silent.
- **Wave editor** — select (zero-crossing snap), cut/copy/paste, trim, fades, gain, normalise, reverse, invert, DC
  removal, speed, **time stretch**, **pitch shift**, undo/redo; save as a new sample or replace the original everywhere
  (with a warning that lists every project using it).
- **Pitch correction** — auto-tune a voice or solo instrument to the project's key and scale with amount, speed and
  flatten (natural to robotic), see the sung and corrected pitch, and drag single notes up or down by hand.
- **Projects** — 21 templates, from trap, drill and afrobeats to bossa nova, cinematic, a felt-piano post-classical piece and a beatbox jam (with
  shared FX buses and sidechain), plus two tours: *Expressive Synths* and *Effects & Engines Tour*; versions (named snapshots), undo/redo,
  16-bit (dithered) or 24-bit WAV, **stems**, MIDI and project export, MIDI import.
- **Live sync** across tabs and devices, mobile-friendly layout, keyboard-accessible controls.

**Claude integration (MCP)**

- **Streamable HTTP** (`/mcp`) and **stdio** (for Claude Desktop) transports.
- 104 tools: projects, sounds, drums, chords (symbols or roman numerals, jazz/neo-soul voicings), basslines (degree
  lines with 808 slides), melodies, rolls, transforms, arrangement with markers, automation, mixer and effects,
  samples, versions, undo, play/stop, MIDI and stem export.
- **The chord grid** — `chord_grid` shows every chord the key offers (7ths, 9ths, sus, 6/9, borrowed chords,
  secondary dominants, tritone substitutes, 11th and 13th forms), where a progression could go next and which
  tensions a chord takes; `add_grid_chords` writes them voiced and voice-led by the engine of the Harmony window's
  Grid tab, with strum and humanize — so Claude's progressions are more than four triads. See
  [The chord grid](docs/chord-grid.md).
- **Harmony and tuning** — `harmony` reads chords in the key (numeral, function, tension), suggests what could come
  next with reasons, finds substitutes and ways to another key, and searches a library of 82 progressions;
  `add_chords` voice-leads a whole progression; `add_arpeggio`, `add_drum_groove` (16 styles) and Euclidean rhythms
  are seeded; `set_tuning` puts the project in just intonation, Pythagorean, meantone, a well temperament or a table
  of your own, and `describe_tuning` gives the exact ratios. See [Harmony and tuning](docs/harmony-and-tuning.md).
- **Built for an agent** — `batch` makes several edits one change (all or nothing, one undo); `dryRun` on every
  editing tool shows what a call would change without changing it; notes are written and read as compact text
  (`1.1 D3+A3+F4 1/2 v0.7`); `diff_versions` says what changed since a saved version; a wrong call answers with the
  valid range and the nearest valid value or name.
- **Sound design & expression** — `create_synth_patch`, `set_synth_oscillator` / `_filter` / `_envelope` / `_lfo` /
  `_modulation` / `_effect` build a GGS Synth patch section by section; `analyze_synth_patch` renders and measures
  it on the server (no browser needed); `set_note_expression` writes per-note pitch / pressure / slide curves
  (bend, scoop, vibrato, swell…); `evaluate_composition` checks the song as written before you listen.
- **Production tools** — `apply_groove` (boom bap, Dilla, lo-fi, trap, drill, house, afrobeats feels), `add_fill`
  (snare rolls, tom runs, hat rolls, drop-outs…), `add_transition` (risers, swells, snare builds, impacts on the
  downbeat).
- **`render_mix`** — Claude renders the mix in your browser and reads it like a mastering engineer: integrated LUFS,
  loudness range, true peak, limiter gain reduction, spectral balance, low-end note and width, loudness per section and
  per-channel stems — against a delivery target (streaming, club, hip-hop, EDM, broadcast…) with exact fixes.
- **`analyze_sound`** — measures one note of a channel (pitch, low-end note, envelope) so Claude tunes 808s and kicks.
- Sample metadata and analysis so Claude picks, tunes and tempo-matches your sounds correctly; it searches and files
  them in folders and edits them with **`edit_sample`** (trim, fades, stretch, pitch shift, **pitch correction**) —
  saved as new samples unless you ask it to replace one.
- Your **plugins**: `list_plugins`, plugin channels and effects, `run_generator` (Claude can use them, never install them).
- Prompts: `make_beat`, `mix_review`, `use_my_samples`, `spatial_mix`.
- **Skills** for Claude Desktop / claude.ai / Claude Code in [`skills/`](skills): beat making, arranging, mixing by
  the numbers, spatial mixing and plugin authoring (`npm run skills:pack` makes uploadable zips).

**Accounts & security**

- User accounts (first-run admin setup, optional registration, admin user management), private projects per user.
- Personal **API tokens** for MCP — generate, regenerate or delete in *Settings → API & MCP*. Optional on your own
  computer, required over the network.
- scrypt passwords, hashed sessions and tokens, CSRF/origin and host checks, CSP, rate limits, setup code for exposed
  servers, sandboxed plugins. See [docs/security.md](docs/security.md).

## Screenshots

| | |
|---|---|
| [![Studio](docs/screenshots/studio.png)](docs/screenshots/studio.png) **Studio** — playlist, channel rack, piano roll | [![Mixer](docs/screenshots/mixer.png)](docs/screenshots/mixer.png) **Mixer** — inserts, effects, sends |
| [![Piano roll](docs/screenshots/piano-roll.png)](docs/screenshots/piano-roll.png) **Piano roll** — scale highlight, velocity lane | [![Samples](docs/screenshots/samples.png)](docs/screenshots/samples.png) **Sample library** — folders, search, metadata & analysis |
| [![Claude activity](docs/screenshots/claude-activity.png)](docs/screenshots/claude-activity.png) **Claude** — live activity log | [![API & MCP settings](docs/screenshots/settings-api.png)](docs/screenshots/settings-api.png) **Settings → API & MCP** — tokens & setup |
| [![Spatial mixer](docs/screenshots/spatial.png)](docs/screenshots/spatial.png) **Spatial (3D)** — objects around and above the listener | [![Plugin install](docs/screenshots/settings-plugins.png)](docs/screenshots/settings-plugins.png) **Plugins** — review & trust before installing |
| [![Audio export settings](docs/screenshots/settings-export.png)](docs/screenshots/settings-export.png) **Settings → Audio export** — ffmpeg & formats | [![Phone](docs/screenshots/mobile.png)](docs/screenshots/mobile.png) **Phone layout** |
| [![World collections](docs/screenshots/world.png)](docs/screenshots/world.png) **World collections** — the Indian Fusion template, sitar settings | [![Sign in](docs/screenshots/login.png)](docs/screenshots/login.png) **Sign in** |
| [![Wave editor](docs/screenshots/wave-editor.png)](docs/screenshots/wave-editor.png) **Wave editor** — select, cut, fade, stretch, pitch shift | [![Pitch correction](docs/screenshots/pitch-correction.png)](docs/screenshots/pitch-correction.png) **Pitch correction** — auto-tune and notes moved by hand |
| [![Recorder](docs/screenshots/recorder.png)](docs/screenshots/recorder.png) **Recorder** — takes over the song, placed on the playlist | [![About](docs/screenshots/about.png)](docs/screenshots/about.png) **About** — app name and version (ⓘ, top right) |
| [![GGS Synth](docs/screenshots/ggs-synth.png)](docs/screenshots/ggs-synth.png) **GGS Synth** — wavetable oscillators, modulation rings with live dots, the source bar, eight macros, touch pad | [![Expression](docs/screenshots/expression.png)](docs/screenshots/expression.png) **Per-note expression** — pitch curves over the notes, the expression lane |
| [![GGS Synth page](docs/screenshots/ggs-page.png)](docs/screenshots/ggs-page.png) **GGS Synth page** — the whole patch on one screen, modules you arrange | |

## Quick start

Requirements: **Node.js 20.19+** (22 LTS recommended) and a modern browser.

```bash
git clone <repo-url> ggs && cd ggs
npm install
npm run build
npm start                 # → http://127.0.0.1:3001
```

1. Open http://127.0.0.1:3001 and **create the admin account** (first run).
2. A **Welcome Trap Beat** project is ready — click once to enable audio and press **Space**.
3. Read the [user guide](docs/user-guide.md) or jump straight to Claude below.

Development mode with hot reload: `npm run dev` → http://localhost:5173.

## Make music with Claude

Keep the studio open in your browser, then connect a client. *Settings → API & MCP* shows these commands with your
URL and token filled in.

**Claude Code**

```bash
claude mcp add --transport http ggs http://localhost:3001/mcp \
  --header "Authorization: Bearer <your gtd_ token>"
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ggs": {
      "command": "node",
      "args": ["/absolute/path/to/ggs/server/src/mcp/stdio.js"],
      "env": { "GGS_URL": "http://127.0.0.1:3001", "GGS_TOKEN": "<your gtd_ token>" }
    }
  }
}
```

The token is optional on your own computer (an admin setting allows local token-less access) and required for anything
reaching the server over a network. Then try:

> *Make a lo-fi beat at 80 BPM in F major with jazzy 7th chords, dusty drums with swing and a warm bass.
> Arrange intro/verse/hook/outro, mix it to around −14 LUFS, save a version and play it.*

More: [Making music with Claude](docs/claude-mcp.md) · [MCP tool reference](docs/MCP.md).

## Configuration

Environment variables (or a `.env` file — see [`.env.example`](.env.example)):

| Variable | Default | |
|----------|---------|---|
| `PORT` / `HOST` | `3001` / `127.0.0.1` | where to listen (`0.0.0.0` for Docker/LAN) |
| `DATA_DIR` | `./data` | projects, samples, exports, accounts |
| `PUBLIC_URL` | — | external URL (links for Claude, allowed origin) |
| `ALLOWED_HOSTS` | localhost on loopback | Host header allow-list |
| `TRUST_PROXY` | off | set behind a reverse proxy (hop count) |
| `SESSION_TTL_DAYS` | `30` | sign-in lifetime |
| `SETUP_CODE` | random, in the log | first-run admin setup code (remote or proxied setup) |
| `MCP_TOKEN` | — | legacy shared MCP token (disables token-less MCP) |
| `MAX_UPLOAD_MB` | `50` | sample upload limit |
| `FFMPEG_PATH` | `ffmpeg` on the PATH | MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF export (`off` disables) |
| `PLUGINS_ENABLED` | `true` | allow users to install their own plugins (also an admin setting) |
| `GGS_URL` / `GGS_TOKEN` | — | for the stdio bridge |

Full details: [docs/deployment.md](docs/deployment.md).

## Docker

```bash
cp .env.example .env               # optional settings
docker compose up -d --build       # studio on http://localhost:3001 (ffmpeg included)
docker compose logs ggs   # first run: the setup code for the admin account
```

Add HTTPS for other computers with the bundled Caddy profile (`docker compose --profile proxy up -d` after setting
`DOMAIN`, `PUBLIC_URL`, `ALLOWED_HOSTS`, `TRUST_PROXY=1`). Configuration, backups, upgrades and hardening:
[docs/docker.md](docs/docker.md); other reverse proxies and systemd: [docs/deployment.md](docs/deployment.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | install, first run, first beat |
| [User guide](docs/user-guide.md) | every window, tool and shortcut |
| [Making music with Claude](docs/claude-mcp.md) | connecting, tokens, `render_mix`, tips |
| [MCP reference](docs/MCP.md) | all tools and parameters (generated) |
| [GGS Synth](docs/ggs-synth.md) | the wavetable/FM synth: signal path, modulation, presets, patch documents |
| [Song studies](docs/song-studies.md) | understanding a song you upload and taking it into the studio as a preset; the method: [song-analysis-method.pdf](docs/song-analysis-method.pdf) |
| [Audio → visual bridge](docs/av-bridge.md) | *Send to visuals*: every OSC address, `AV_OSC`, the WebSocket feed, visual lanes, the test fixture and replay |
| [Audio → visual bible](docs/av-bible.pdf) (PDF, Spanish) | everything the studio can send to TouchDesigner / Blender / Unreal: the OSC bridge, live WebSocket, REST, exports, every variable with its range (`npm run docs:av` regenerates it) |
| [Per-note expression](docs/expression-engine.md) | pitch / pressure / slide curves, the expression lane, MPE input, MIDI |
| [Audio benchmarks](docs/audio-benchmarks.md) | measured aliasing, tuning, CPU and the loudness policy of the synth |
| [Spatial mixing](docs/spatial.md) | 3D objects, binaural, 5.1 / 7.1.4, ADM |
| [Studio effects and instruments](docs/effects-and-instruments.md) | the fourteen DSP effects, Analog / Additive / Modal, unison laws and the oversampled drive — with measurements |
| [Plugins](docs/plugins.md) | write, pack and install instruments, effects, generators |
| [Docker](docs/docker.md) | image, compose, HTTPS, backups |
| [Deployment](docs/deployment.md) | Docker, proxies, env vars, backups |
| [Security](docs/security.md) | auth model and hardening checklist |
| [Architecture](docs/architecture.md) | ops, live sync, browser jobs, audio engine |
| [REST & WebSocket API](docs/api.md) | for scripts and integrations |
| [Development](docs/development.md) | layout, scripts, tests, conventions |
| [Roadmap & product review](docs/roadmap.md) | music-industry review, done & next |

## Development

```bash
npm run dev          # server + client with hot reload
npm run lint         # ESLint
npm test             # unit & integration tests
npm run test:e2e     # Playwright end-to-end (npx playwright install chromium once)
npm run docs:mcp     # regenerate docs/MCP.md
npm run screenshots  # regenerate README screenshots
npm run plugin:pack -- <folder> | --examples   # validate + zip a plugin
```

```
packages/core   shared model, ops, music theory, MIDI, audio analysis
server          Express + WebSocket hub + MCP server + accounts
client          React UI + Web Audio engine
e2e             Playwright tests (a real browser plus an MCP client playing "Claude")
plugins         example plugins (npm run plugin:pack -- --examples → plugins/dist/*.zip)
skills          music-production skills for Claude users (npm run skills:pack → skills/dist/*.zip)
docs            documentation
.claude         skills & agents for developing GGS with Claude Code (see CLAUDE.md)
```

Working on the code with Claude Code? Start with [CLAUDE.md](CLAUDE.md); recipes for common changes are in
`.claude/skills/`, and `.claude/agents/` has a QA reviewer and a music-industry advisor.

## Security

Private by default: listens on `127.0.0.1`, every account's data is private, tokens and sessions are stored hashed.
Before exposing it to a network read [docs/security.md](docs/security.md) (HTTPS, `PUBLIC_URL`, `ALLOWED_HOSTS`,
`TRUST_PROXY`, tokens for every MCP client) — behind a reverse proxy, always set `PUBLIC_URL`. Please report
vulnerabilities privately.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No sound | Click anywhere once (browsers need a gesture), check master volume and mutes. |
| Claude: "No studio is open in a browser" | Keep the studio open, signed in as the token's account. |
| Claude: 401 on `/mcp` | Create a token in Settings → API & MCP; token-less access is local-only and can be disabled. |
| Forgot the admin password | Stop the server and run `npm run reset-password -- <username>`. |
| Port in use | `PORT=3002 npm start` |

## Contributing

Issues and pull requests are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first. Please run
`npm run lint && npm test && npm run test:e2e` and update the docs with your change; the repo layout and conventions are
in [docs/development.md](docs/development.md).

## Licence

[MIT](LICENSE). The licence file carries the copyright notice of the project GGS is built on, which the app credits in
**About**.

The chord grid runs the chord engine of [Tuple](https://github.com/c0remusic/tuple) © 2026 c0remusic, used under the
MIT licence ([`packages/chord-grid/LICENSE-tuple.txt`](packages/chord-grid/LICENSE-tuple.txt)).
