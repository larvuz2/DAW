# GGS documentation

| Guide | For |
|-------|-----|
| [Getting started](getting-started.md) | Install, first run, create the admin account, make a first beat |
| [User guide](user-guide.md) | Every part of the studio: channel rack, piano roll, playlist, mixer, automation, samples, versions, settings, shortcuts |
| [Making music with Claude (MCP)](claude-mcp.md) | Connect Claude Code / Claude Desktop, API tokens, example sessions, what `render_mix` measures |
| [MCP tool reference](MCP.md) | All 104 tools with their parameters (generated) |
| [GGS Synth](ggs-synth.md) | The wavetable / FM synthesizer: signal path, modulation matrix, wavetables, presets, patch documents, engineering notes |
| [Studio effects and the engine instruments](effects-and-instruments.md) | The fourteen DSP effects (true-peak limiter, reverbs, OTT, shifter, disperser…), the Analog, Additive and Modal instruments, the GGS Synth's unison laws and oversampled drive — with what was measured |
| [The chord grid](chord-grid.md) | Harmony → Grid: every chord of the key, borrowed chords, smart chords, voicings, tensions, the track of cards — Tuple's chord engine in the studio — and Claude's `chord_grid` / `add_grid_chords` |
| [Harmony and tuning](harmony-and-tuning.md) | The Harmony window (chords that fit, progressions, substitutes, the library), tuning systems with exact ratios, and the tools Claude has for both |
| [Style study: post-classical ambient jazz](styles/post-classical-ambient-jazz.md) | What GoGo Penguin, Ólafur Arnalds, Hania Rani, Jakob Bro and others share — instruments, harmony, time, form, sound — with sources, a recipe for making it in the studio, and the template that is its demo piece ("Winter Light") |
| [Per-note expression](expression-engine.md) | Pitch / pressure / slide curves in every note: the model, the piano-roll lane, MPE input and recording, MPE MIDI files |
| [Audio benchmarks](audio-benchmarks.md) | Measured signal quality (tuning, aliasing, zipper noise, repeatability), CPU per voice and the preset loudness policy |
| [Spatial audio](spatial.md) | Atmos-style 3D objects, binaural monitoring, 5.1 / 7.1 / 7.1.4, object stems and ADM BWF exports |
| [Plugins](plugins.md) | Write and install your own instruments, effects and note generators; the plugin sandbox |
| [Docker](docker.md) | The image, docker compose, configuration, HTTPS, backups, upgrades |
| [Deployment](deployment.md) | Docker, reverse proxies, environment variables, backups |
| [Security](security.md) | Accounts, sessions, API tokens, token-less MCP, plugin sandboxing, hardening checklist |
| [Architecture](architecture.md) | How the pieces fit: ops, live sync, browser jobs, audio engine, analysis |
| [REST & WebSocket API](api.md) | Endpoints and socket messages for scripts and integrations |
| [Development](development.md) | Repo layout, scripts, tests, conventions, contributing |
| [Roadmap & product review](roadmap.md) | The music-industry advisor's review, what was done about it, and what's next |

Screenshots used in the README live in [`screenshots/`](screenshots) and are regenerated with `npm run screenshots`.
