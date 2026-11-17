# Audio → visual test fixture

A 16-bar song made for building and testing a visual setup against GreanTeaDawy, and a capture of what the studio's
audio → visual bridge really sent while it played (see `docs/av-bridge.md` for every address).

| File | What |
|---|---|
| `song.gtd.json` | the project (File → Import project file opens it in the studio) |
| `song.mid` | the notes, one track per channel, 96 ticks per beat |
| `osc-capture.jsonl.gz` | every OSC message the bridge sent, with its arrival time (101017 messages, 2071 frames at 59.8 per second) |
| `capture-summary.json` | how many of each address, the markers with their times — to check a receiver against |
| stems + mix | `01-kick.wav` … `06-lead.wav` and `mix.wav` (16-bit, 44.1 kHz stereo, 35.3 s: the 32 s song + its tail, all starting at bar 1): too big for the repository — make them with `npm run fixture:av` or ask for the zip |

## The song

A minor, 120 bpm, 4/4, 16 bars = 32 s. Every section is 4 bars = 8 s.

| Bars | Marker (tick) | What plays | Visual lanes |
|---|---|---|---|
| 1–4 | Intro (0) | pad (Am F C G, a bar each), 8th-note hats | `/gtd/user/1` Energy 0.1 → 0.2 |
| 5–8 | Build (1536) | + kick, clap, bass; the pad's filter opens (`Pad filter`) | Energy 0.2 → 1 |
| 9–12 | Drop (3072) | + lead, a 3D object circling the room once | Energy 1; `/gtd/user/2` Strobe: 1 for the first half of every beat, else 0 |
| 13–16 | Outro (4608) | pad, hats | Energy 1 → 0 |

Channels (`/gtd/ch/{slug}/…`, mixer insert): `kick` 1, `clap` 2, `hats` 3, `bass` 4 (GGS Analog Bass), `pad` 5 (GGS
Velvet Pad), `lead` 6 (GGS Touch Lead). Notes in the song: kick 32, clap 16, hats 96, bass 32, pad 64 (4-voice chords),
lead 19 — each with its `off`.

Automation (`/gtd/auto/{id}`, 0…1, from the moment its clip starts, held after it):

| id | name | moves |
|---|---|---|
| `auto_s2il5gl79v` | Pad filter | the pad's filter cutoff, bars 5–8 (0 = 20 Hz … 1 = 20 kHz, log) |
| `auto_2u5zjibx4u` | Energy | visual lane 1 (nothing in the sound) |
| `auto_hg069ao2ah` | Strobe | visual lane 2 (nothing in the sound) |
| `auto_szsjnnp534` | Lead 3D X | the lead's position left (0) … right (1), bars 9–12 |
| `auto_v1035i7e8u` | Lead 3D Y | the lead's position back (0) … front (1), bars 9–12 |
| `auto_nep5v6n3m8` | Reverb throw | the pad's reverb mix, bars 13–16 (also /gtd/fx/5/reverb/mix) |

The 3D position isn't a bridge message of its own yet (phase 3); its X/Y automation is: the circle arrives as
`/gtd/auto/auto_szsjnnp534` and `/gtd/auto/auto_v1035i7e8u`.

## Phase 2 in the capture

Every control as it stands, when it changes and all once a second: `/gtd/ch/{kick…lead}/param/…` (the pad's
`filterCutoff` is a channel control: it opens in the build), `/gtd/bus/{0…6}/param/…`, `/gtd/fx/0/limiter/…` and
`/gtd/fx/5/reverb/…` (its `mix` rises in the outro). And the live modulation of the three GGS channels, `bass`, `pad`
and `lead`: `/gtd/ggs/{channel}/voices`, `…/src/env1` (each note's amp envelope), `…/src/lfo1`, `…/src/chaos1`…,
`…/dst/f1Cutoff` (Hz) and `…/dst/f1Cutoff/n` (0…1), and the rest of the 25 sources and 39 targets.

## The capture

Recorded from the real bridge (headless Chromium playing in real time → the studio server → UDP), not simulated.
Gzipped JSON lines: a header, then one line per message, in arrival order:

```
{"format":"gtd-av-capture","version":1,"song":{…},"recorded":"…","line":"[t_ms, address, types, ...values]"}
[111.6,"/gtd/transport/playing","i",0]
[2157.3,"/gtd/ch/pad/note","ifff",45,0.75,2,2.1411]
```

`t` is milliseconds since the capture started: the bridge goes on at 0 (stopped, at bar 1: map, Intro), play is pressed
at ~2 s, the drop arrives at ~18.2 s, stop at ~34 s (the playhead goes back to bar 1, so the Intro marker comes again),
then the bridge goes off. Messages of one frame share a time to within a millisecond.

## Replaying it

```bash
npm run av:replay
```

sends the capture to `127.0.0.1:7000` with its original timing. Options after `--`: `--to host:port`, `--loop`,
`--speed 0.5` (or any other file: `npm run av:replay -- my-capture.jsonl.gz`).

## Making it again

```bash
npm run build
```

```bash
npm run fixture:av -- --stems ~/Desktop/gtd-av-stems
```

`scripts/av-fixture.mjs` builds the song through the MCP tools (as Claude would), plays it in a headless Chromium with
"Send to visuals" on, captures the OSC on a local UDP port and exports the files. Ids, times and measured values
change a little from run to run (the browser's timers and audio thread); the song, the notes and the counts don't.
