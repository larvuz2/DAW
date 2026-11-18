# @greanteadawy/chord-grid

The harmonic engine behind the studio's **Chord Grid** (Harmony window → Grid) and the `chord_grid` /
`add_grid_chords` MCP tools: every chord of a key on one grid, the borrowed ones beside it, what could come next,
voicings, voice leading, tensions with avoid notes, strum and humanize, and a track of cards to try a progression on.

It is **[Tuple](https://github.com/c0remusic/tuple)**'s chord engine — a free Max for Live device by c0remusic, MIT
licensed (`LICENSE-tuple.txt`) — unchanged, with a thin layer that lets it run outside Ableton Live:

| File | What it is |
|---|---|
| `src/tuple-engine.js` | **generated**: Tuple's `device/tuple_chord_engine.js` as its authors wrote it (French comments and all), inside a function that hands it what Max would. Never edited by hand, not linted |
| `src/tuple-source.js` | **generated**: the version, commit and hash of that file |
| `src/host.js` | what stands in for Max and Live: outlets collected as events, `Task` on a virtual clock (no timers), a `LiveAPI` that only knows the tempo, a seeded `Math.random` |
| `src/index.js` | `createChordGrid()`: the engine's messages as a plain API (`view`, `press`, `add`, `notes`, `find`, `save`…), note names in the key's own spelling |
| `scripts/vendor-tuple.mjs` | brings a Tuple checkout in, and stops if the engine no longer has something `src/index.js` uses |
| `LICENSE-tuple.txt` | Tuple's MIT licence; the script also writes it to `client/public/licenses/tuple-MIT.txt`, served beside the bundled engine |

Nothing here knows about projects, ticks or audio. No dependencies; runs in a browser and in Node.

## What is Tuple's and what is the studio's

Tuple's: which chords a scale has and what they are called, the borrowed tables and the Tritone / Mediants / Ext
pages, the Smart Chords ranking, the eight voicings and the voice-leading cost, the tension offer and its avoid-note
rules, strum / ramp / humanize, the progression track (placement, lengths, undo, substitutes, re-voicing), and how the
track becomes notes.

The studio's: running it without Max (`host.js`), spelling (`Eb`, not the engine's `D#`, by the key and the chord's
numeral), numerals and names for chords Tuple never has to name, looking a chord up by its name (`find`), listing every
page at once (`catalog`), and the conversion to patterns (in the callers).

## Updating to a newer Tuple

```bash
git clone --depth 1 https://github.com/c0remusic/tuple /tmp/tuple
```

```bash
node packages/chord-grid/scripts/vendor-tuple.mjs /tmp/tuple
```

```bash
npm test -w packages/chord-grid
```

The script fails with the name of whatever `src/index.js` calls or reads that the new engine no longer has. The tests
pin the grid of C major against Tuple's own screenshot, play every cell of the 30 scales, and check that no call uses
a timer or `Math.random`. Listen before releasing: a new version may voice chords differently, and saved tracks keep
the notes they were saved with.
