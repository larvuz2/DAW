# The film

A 36-second animated score of a piece played on the GGS Synth preset **Kaleidoscope**: a playhead crosses the voices
of each chord, and every note shows its five layers — the strike, the body, the pulse, the air and the sub — as the
synth actually played them.

```bash
npm run film            # the piece: audio, data and the page that plays it  →  uploads/film/kaleidoscope/
npm run film:record     # the video: film.mp4, 1920×1080 at 60 fps, with the audio (needs ffmpeg and Chromium)
```

`E2E_CHROMIUM=/path/to/chromium` uses an installed browser for the recording, as for the end-to-end tests. Open
`uploads/film/kaleidoscope/index.html` to play it live: **Play** starts the audio and the picture together; a click or
the space bar pauses. `node tools/film/record.mjs --frame 12.5` writes one still instead of the video, to look before
recording (several `--frame` give several). Nothing in `uploads/` is committed.

## Nothing is drawn by hand

- **The piece** (`tools/film/kaleidoscope.mjs`) is A minor at 110 BPM: one note, then Am9 → Fmaj9 → Cadd9/E → G6/9 →
  Am11, voiced so that every voice keeps its note or steps to the next one (a voice is a place in the chord, low to
  high; the sixth is born on the last chord), with single notes above the third and fourth chords. Chords are rolled
  35 ms a note, so every strike is its own moment. Four sections are rendered with their own macros (Bloom, Pulse,
  Sparkle, Weight) and added: the effects are linear, so that is the same audio as turning the macros between them.
- **What the voices do** is read while the audio renders: `renderPatch({ tap })` hands a function every sounding voice
  after each block, and the script keeps, sixty times a second and for every note, the level of each layer (the
  oscillator's level × the note's amp), where the body reads its table (more saws stacked the higher), how far its
  filter is open, where the pulse stands in the stereo field, its twinkle, the vibrato, pressure and slide. The tap
  only looks: a test holds the audio to be the same with and without it.
- **A layer alone** — the five lanes under the score — is the same patch rendered with every other source switched
  off, before the effects (a strike is a strike there, not a strike and its echoes). Each lane is drawn to its own
  peak and as tall as the layer is loud next to the loudest one.
- **One gain** brings the clip to −16 LUFS (or lower if its true peak would pass −1 dBFS): no limiter, no EQ.

## What you see

| On screen | What it is |
|-----------|------------|
| A line per note, eased from chord to chord | the voice leading: flat while a note sounds, travelling to the voice's next note in the 0.6 s before it; a glint rides the curve as the playhead crosses it |
| A star, a flash, a ring, sparks | the **strike** of that note — as bright as its level (velocity, Sparkle), then a comet as long as it rings |
| Seven amber strands | the **body**: the seven saws of the stack, each beating at the rate its detune really gives that pitch; they thicken as the body swells in, spread and whiten as its filter and its table open (Bloom, pressure) |
| Ice-blue beads on the line | the **pulse**: one per sixteenth it sounded, as large as it was loud, above or below the line as it stood left or right; an accent throws sparks and a column of light |
| Dust at the attack | the **air**: the 70 ms breath of noise |
| An ember under the line and under the key an octave below | the **sub** |
| A ripple in the line | vibrato, as deep as the pressure makes it (drawn a third deeper than to scale) |
| Top left | the chord, its numeral in the key (as `numeralFor` gives it), and each voice: held, moved by so many semitones, or new |
| Top right | the four macros, and the pressure and slide of the notes sounding now |

The picture of any moment is a function of that moment alone (`draw(t)` in `tools/film/player.js` remembers nothing),
so the page that plays along with the audio and the recorder that steps through it frame by frame show the same
frames, and the video is the same every time. What has been played is painted once and uncovered up to the playhead;
only what is happening now is drawn per frame.

To make a film of another piece, change `CHORDS`, `MELODY` and `SECTIONS` in `tools/film/kaleidoscope.mjs`: the data,
the lanes, the chord names and the voices follow. The layers are Kaleidoscope's (which oscillator is the strike, the
body, the pulse): another preset needs its own reading of `voice.oscs`.
