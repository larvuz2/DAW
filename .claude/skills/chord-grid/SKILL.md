---
name: chord-grid
description: Work on GreanTeaDawy's chord grid (Harmony → Grid, chord_grid / add_grid_chords) — update the vendored Tuple chord engine, change the adapter in packages/chord-grid, the Grid tab, the session that plays and writes it, or the MCP tools — without editing the engine or letting the studio's copy of its rules drift.
---

# The chord grid

Read `docs/chord-grid.md` (what it does) and `packages/chord-grid/README.md` (what is Tuple's and what is ours) first.

## Rules

- **Never edit `packages/chord-grid/src/tuple-engine.js`.** It is generated: Tuple's `device/tuple_chord_engine.js`
  as written (ES5, French comments), inside `createTupleEngine(host)`. It is not linted. A wrong chord, name or
  voicing that comes from the engine is Tuple's: report it upstream (github.com/c0remusic/tuple), work around it in
  the adapter only when it hurts (as with the Rootless voicing and altered ninths), and say so in the docs.
- **Ask the engine, do not copy its rules.** Which chords a scale has, what a tension is called, how a voicing is
  spread: call it. Core's `harmony.js` / `chordflow.js` are a different system (the Chords tab, `harmony`,
  `add_chords`); do not merge the two.
- **The adapter restores what it borrows.** `find`, `catalog`, `add`, `options` switch the borrowed page, EXT,
  capture, the selection or `_extDeg` to look something up: each puts it back (`try/finally`), and none may leave
  notes sounding.
- **No timers, no `Math.random`** in the package: `Task` runs on the host's virtual clock, drained after every call;
  a strummed chord comes back as notes with a `delay`. Tests fail if either is used.
- **Its MIT notice travels with the copy**: `LICENSE-tuple.txt`, the header of the generated file, the README's
  Licence section, and — because a bundler drops comments from the chunk the browser gets —
  `client/public/licenses/tuple-MIT.txt`, linked from the credit line in the tab (the vendoring script writes it).
- **A chord name must mean its chord.** `find()` answers exact names first (pages, then types spelled out), then
  the same name without brackets; a type is only in the table under a name the engine gives it rightly. The test
  "a chord name means its chord in every key" holds the table of what each name means: add to it with any new
  spelling, and prefer not finding a name to answering it with another chord.
- **Cards are not project state.** They live in `localStorage` per project; only `write()` (ops) and
  `add_grid_chords` change the project. Do not add an op for cards without deciding how Claude and other tabs see them.

## Updating Tuple

```bash
git clone --depth 1 https://github.com/c0remusic/tuple /tmp/tuple
```

```bash
node packages/chord-grid/scripts/vendor-tuple.mjs /tmp/tuple
```

```bash
npm test -w packages/chord-grid && node --test server/test/chordgrid.test.js
```

The script reads `src/index.js` for every `fns.x`, `send('x')`, `act('x')`, `eng.get('x')`, `eng.set('x')` and stops
with the name of whatever the new engine no longer has; fix the adapter, not the engine. Then run
`e2e/workflow-chordgrid.spec.js`, read Tuple's changelog for changes of sound, listen, and note the new version in
`CHANGELOG.md` (saved tracks keep the notes they were saved with).

## Where things are

| Change | File |
|---|---|
| A new thing the engine can do, exposed to the studio | `packages/chord-grid/src/index.js` (+ a test in `test/grid.test.js`) |
| How Max is stood in for | `packages/chord-grid/src/host.js` |
| The tab | `client/src/components/ChordGrid.jsx`, `.cgrid*` in `client/src/styles.css` |
| Playing, looping, storage, writing to a pattern | `client/src/lib/chordGrid.js` |
| Claude's tools | `server/src/mcp/tools/chordgrid.js` (+ `server/test/chordgrid.test.js`, `npm run docs:mcp`, `guide.js`, the beat-making skill) |

Checks: `npm run lint && npm test`, and `E2E_CHROMIUM=… npx playwright test e2e/workflow-chordgrid.spec.js` for the tab.
