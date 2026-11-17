# Changelog

## 0.15.0 — The synth page

**The GGS Synth editor now opens on one page laid out like the /synth editor**, in its colours (deep-space panels,
the violet accent, a colour per family of modulation sources): the header with the preset, eight macros, the voice
and the output; the three oscillators with sub and noise; the filters, the routing and the amp; the envelopes, LFOs
and chaos; the strip of modulation sources; and a dock with the FX rack that opens upwards into the modulation matrix
or the table of every parameter. Knobs show their value while touched; numbers sit in small boxes; captions run down
the side of each cluster.

- **One screen, no scrolling, no overlaps.** The page is drawn at one size (rows of fixed heights, like the
  original) and scaled to fit its window or the screen; a test checks at 1440×900 that no control sits on another,
  on a picture or outside its module.
- **Fewer pages.** The channel's own settings fold into the window's title bar; the classic tabs are behind
  ⋯ → *Classic view* (and *Synth page* brings you back); the choice is remembered.
- **Still modular.** ⋯ → *Arrange modules*: drag modules within and between rows, move them up or down a row,
  resize, hide, add back; six built-in layouts and your own (saved in this browser; 0.14 layouts are converted).
  Full screen for recording a video, with menus and dialogs still on top.
- **Play from the page:** hold the play button in the header; drag up for pressure and sideways for slide. The voice
  count beside it is live.
- The 0.14 *Overview* tab is replaced by the page. The output scope and the touch pad are modules you can add.
- Under the hood: the knob has a panel look (the classic tabs keep theirs), a value box control, pictures that stay
  sharp when the page is scaled, and the engine reports how many notes a GGS channel is sounding.
- After an independent review: drawn LFO steps and envelope nodes follow the pointer whatever the box's shape;
  making a module narrower never makes controls overlap; in a very small window the page shrinks without cutting
  anything off and offers full screen or the classic view; the warp-mode and FM-source menus are menus of their own,
  reachable by keyboard and named for screen readers; the play button and the source chips work from the keyboard;
  popovers near the bottom open upwards; another tab no longer overwrites the layout in use; Esc in a search box
  in full screen closes the box, not full screen; the filter curve stays sharp when the page rescales.
- **Docs:** `docs/av-bible.pdf` — the audio → visual bible (in Spanish): everything the studio can send to
  TouchDesigner, Blender or Unreal, what is available today and what needs a proposed real-time bridge, with every
  variable's range. `npm run docs:av` regenerates it from the catalogs.

## 0.14.0 — The synth on one screen

**New tab in the GGS Synth editor: Overview.** The whole patch on one screen, drawn: each oscillator's wavetable as a
stack of frames with the one being played lit, its unison copies fanned out by their law and stack, the sub and the
noise, both filter curves (drag the handle), the **signal flow** (click a source to send it to another filter or
straight to the amp, click *serial ⇄ parallel*), the amp envelope, the envelopes to shape by hand, the LFOs and chaos
paths moving with the note, every modulation source with a trace of what it just did, the routes with their depths,
the effects as pictures (drive curve, chorus, delay repeats, reverb tail) and a **scope** of the channel's sound
(waveform and spectrum). The knobs are the same controls as in the other tabs (rings, live dots, drop a source on them).

Every part is a **module**: *Arrange* to drag modules to new places, move them one place, make them 2–12 columns
wide, hide them and add them back. Six ready-made layouts (*Whole patch*, *Oscillators*, *Filters, routing &
envelopes*, *Modulation*, *Sound & scope*, *Minimal*) and your own, saved by name in the browser. *Full screen* shows
only the modules over the whole page, for recording a video; menus and dialogs still open above them. The other tabs
have not changed.

- The engine gives the editor an analyser on a channel (`channelAnalyser`): a side branch off the fader, made only
  when the scope asks for it and disconnected when it closes, never in an offline render. Nothing you hear changes.
- After an independent review: full screen covers the page instead of the editor alone (a prompt, a right-click menu
  or a message opened in full screen was invisible); Space on the signal-flow diagram no longer also starts the song;
  the tab works when the browser blocks site data; pictures redraw only what moves and pause off screen; unchanged
  modules are not re-rendered by edits elsewhere; saved layouts are limited to 30 and follow other tabs.

## 0.13.3 — No sign-in on your own computer

- **`NO_LOGIN=1`** (or **`npm run dev:local`**): no login screen, no admin setup, no "super admin" to manage. Every request
  is the one local account — the first admin if the data folder already has one (it keeps all its projects), otherwise
  an account the server makes on first start. The browser, the live socket and MCP all work with no cookie and no token;
  the menu has no *Sign out* or *Manage users*. Off by default.
- **Fix to 0.13.1:** a render for Claude (`render_mix`) that was saved ran 0.5 s longer than one that was not, so two
  renders of the same project could not be compared like for like (the browser test for it failed). Every render of a
  project now has the same tail.
- The server **refuses to start** with `NO_LOGIN` unless `HOST` is a loopback address (`127.0.0.1`), and warns when a
  proxy or a public URL is configured: with no sign-in, whoever can reach the server has everything.

## 0.13.2 — `npm run dev` works again

- **First-run setup, login and every save in `npm run dev` were refused as "Cross-origin request blocked".** Vite's
  proxy rewrote the Host to the server's (`127.0.0.1:3001`) while the browser's Origin was `localhost:5173`, and the
  server compares the two (CSRF protection). The proxy now keeps the browser's Host. A page on another site is
  still refused (checked through the proxy), and a test guards the setting. The production build, which the server
  serves itself, was never affected.
- **`ALLOW_ANY_ORIGIN=1`** switches the Origin check off, for testing on your own machine behind something the server
  does not know — a preview pane, a tunnel. The server says so in its log. Off by default; never on a shared server.

## 0.13.1 — A song that tours the new sounds, and fixes from the review of 0.13.0

**New template: Effects & Engines Tour** — forty bars in A minor (just intonation on A, every chord beatless) that
use the Analog, Additive and Modal instruments, a GGS supersaw of unison copies and all fourteen studio effects.
Menu → *New from template*, or `create_project template="tour"`. Mixed by its numbers (−14 LUFS, true peak
−1.1 dBTP in a browser render); nobody has listened to it yet. A template can now carry a tuning, effects after the
master limiter, and more parts than a new project has inserts.

**Fixed** (an independent review of 0.13.0: nothing critical or high; these, each with a test unless said)
- The first note played by hand on an Analog, Additive or Modal channel was silent (the audio worklet was only
  loaded ahead of time for a GGS Synth).
- A reverb (or any effect that holds sound) switched off and on again played the tail it had held: it now lets go.
- An effect that follows the song (trance gate, synced tremolo and flanger) switched on while the song played ran
  up to 118 ms off the grid until the next start; effects also learn a tempo changed while the song stood still.
  *(No automated test: checked by the reviewer's measurement and by reading.)*
- The Analog's attack depended on how the browser cut the first block of a note (up to −41 dB of difference re
  peak): a note is now the same note at any block size.
- An octave or fifth stack on the very highest keys folded back as a tone that was no note (19 kHz at −6.5 dB on
  key 127): a copy above the reach of the sample rate is left out.
- `list_instruments kind="analog|additive|modal"` left out what each setting does.
- A switch set to `"yes"` or `"on"` through the tools was accepted and stored as off: it must be `true` or `false`.
- Exports ended on a hard cut two seconds after the last bar, whatever still rang: the tail now follows the song
  (2–8 s, from its instruments' releases and its effects' decays) and ends on a 60 ms fade. **Exported files of
  songs with long tails are longer than before.**

**Said in the docs now** — what a note of each instrument costs, that nothing compensates the look-ahead of the
true-peak limiter beside other channels, and that an older version drops what it does not know from a 0.13 project.

## 0.13.0 — Effects and engines

The fifth batch from GGS Composer: fourteen effects and three instruments that run as the studio's own DSP in the
audio thread, and more unison and a cleaner drive for the GGS Synth. Guide and measurements:
[docs/effects-and-instruments.md](docs/effects-and-instruments.md). Nothing here was tuned by ear by a person.

**Effects** (mixer inserts; *+ Add effect…* now lists every effect by purpose)
- **True-peak Limiter** (`maximizer`): looks ahead, and holds the peaks between the samples — what "−1 dBTP" means.
- **Algorithmic Reverb** (`algoverb`): a 16-line feedback delay network in five voicings (room, hall, plate,
  cathedral, cosmic) whose decay knob is a time, with freeze; **Shimmer Reverb** (`shimmer`): the same with pitch
  shifters in its loop.
- **Multiband (OTT)**, **Transient Shaper**, **Trance Gate** (on the song's grid), **Resonator** (five strings tuned
  to a chord), **Flanger** (also through zero, also synced), **Tremolo / Auto-pan**, **Ring Modulator**,
  **Frequency Shifter**, **Disperser**, **Vintage Lo-fi** and **Utility**.

**Instruments**
- **Analog**: two band-limited oscillators (saw, square with pulse width, triangle, sine) with hard sync, a sub and
  noise, a four-pole ladder filter with its own envelope, an LFO, drift. 12 presets.
- **Additive**: up to 64 partials shaped as one spectrum. 8 presets.
- **Modal**: objects that ring — up to 32 modes of a string, a stiff string, a bar, a drum head or a tubular bell,
  struck, plucked, blown or bowed. 13 presets.

**GGS Synth**
- Unison up to 16 copies per oscillator, with a detune law (linear, super = the JP-8000 supersaw, exp, random), a
  stack (octave, fifth, or both in turn) and a wavetable position per copy.
- Drive at 4x and 8x the sample rate: what folds back falls by 12 dB and more per step on bright, hard-driven sounds.
- Patches made before sound exactly as they did (all 31 presets compared sample for sample).

**For Claude**
- `list_effects` is an overview by purpose, and `list_effects type="…"` shows one effect in full (the whole list had
  grown to 58 KB); `add_effect`'s own description is a line per effect.
- `analog`, `additive` and `modal` for `add_channel`; `set_synth_oscillator` takes `unisonLaw`, `stack`,
  `unisonTable` and `unison` up to 16; `set_synth_effect` takes `drive.oversampling`.

**Found and fixed on the way**
- The frequency shifter, as ported, rang for ever at +5 kHz with short, strong feedback (19 kHz went to half the
  sample rate and came back twice as strong): its loop now has a zero there and at 0 Hz.

**Not in this release** — wavetables from a harmonics list or a formula, a granular instrument, grain cloud and
spectral freeze; meters for the gain reduction of the limiter and the multiband. The two reverbs and the resonator
still allocate a little per block (100–150 bytes). The engine instruments' knobs apply to notes that start after the
change.

## 0.12.1 — Fixes from the review of harmony and tuning

An independent review of 0.12.0 found two serious problems and a list of smaller ones; all are fixed here, each with
a test that failed before.

**Serious**
- A long list of different chords voiced for six voices held the server for seconds (2.4 s for one call, 18 s for a
  batch of eight — and nobody else was answered meanwhile). The search now drops dead ends at once and weighs fewer
  voicings per chord when there are many different chords (the worst case measured is about half a second; a song
  with up to 15 different chord changes is voiced exactly as before), and a `batch` lets other requests through
  between its calls.
- `music_theory action="progression"` no longer split `"I-V-vi-IV"` (a dash before a lower-case `v`), nor
  `"I - V - vi - IV"`. One splitter now reads every way people write a progression.

**Chords and numerals**
- A capital `M` is major and nothing else: `CM7(b5)` was read as Cm7b5, `CM7b9` as C7b9. They are now read as
  written, or refused when the dictionary has no such chord.
- A chord and its numeral are the same thing in every scale, also those with an augmented second (lydian #2,
  hungarian major, ultralocrian), where two notes lie between two degrees: D♭ in C lydian #2 is `#I`.
- A numeral is written in one case: `vI` and `iI` are refused.
- Negative harmony names every mirrored note (Cmaj7 → A♭maj7, not "Cm"); a mirror the dictionary has no name for
  is marked `≈` and its notes are the answer.
- Scales that no seven-note scale contains are read in the closest one, by their third first: the major blues, the
  augmented and the whole-tone scale are no longer read as a minor key.
- Chord tones are named by what they are: the seventh of G♯dim7 is F, the fifth of Caug is G♯, the ♯9 of C7♯9 is D♯.
- A library progression is found by its numerals with their case (`I-V-vi-IV` is not the minor loop `i-v-VI-iv`).

**Tuning**
- `set_tuning` no longer accepts arguments it then ignores: `cents` replace `ratios` (and the other way round), a
  table alone means `system: "custom"`, and `divisions`, `fraction`, `cents` or `ratios` with a system that has no
  use for them are refused with the fix.
- A custom table cannot move its own root (the first value must be 0 cents or 1/1) and every ratio must be within
  two octaves of it. A stored table that starts elsewhere is moved as a whole.
- The tabla, the taiko and gongs keep their pitch, like the other drums (they were retuned).
- A glide starts where the last note really was (in 19 equal steps it began four semitones off).
- The beat rate of a chord is counted between harmonics one can hear (up to the 9th, within 35 cents of meeting):
  a tritone is measured against 7/5 instead of the 45th harmonic, which gave figures like "250 per second".
- In tunings with other than twelve steps, `describe_tuning` calls keys keys instead of the notes they are not.

**Tools**
- `add_drum_groove` only writes onto drum instruments and samplers: a synth called "Kick Bass" or a piano called
  "Top Hat Lead" keeps its part.
- `harmony action="analyze"` no longer suggests changing the key when the notes fit its relative (A minor and
  C major are the same notes).
- A rotated Euclidean rhythm starts later, as its description says: `E(3,8,2)` is now `x-x--x--` (it started
  earlier). **This changes what `E(k,n,r)` writes** for a rotation other than 0.
- Voice leading avoids parallel fifths and octaves more strongly: none are left in three- and four-voice writing
  and five-voice sevenths (measured over random diatonic progressions; five or six voices on plain triads keep
  doubled octaves in close position — the texts now say "wherever the chords allow"). **Voiced chords written
  with `voices` can differ from 0.12.0** by a note here and there.

**Harmony window**
- A second ▶ in the library stops the first, and closing the window stops it too (they overlapped and kept
  playing). Power chords with "Smooth (5 voices)" no longer fail: fewer voices are used.
- "1 bar each" follows the project's metre (it was four beats in 3/4).
- *File → Harmony & tuning…* opens the window where the toolbar button is hidden (phones); substitutes can be used
  with Shift+Enter; the tabs are announced as tabs.

**Not changed** — Space starts the transport also when a button has the focus (it does everywhere in the studio;
Enter presses the button); DSP plugin instruments are still not retuned.

## 0.12.0 — Harmony and tuning

The fourth batch from GGS Composer: what the studio knows about chords, keys and tuning. 102 tools (was 97).
Guide: [docs/harmony-and-tuning.md](docs/harmony-and-tuning.md).

**Harmony window** (the ♪ button in the toolbar, or *Chords* in the piano roll)
- Pads with the chords that could come next, ranked and coloured by what they do (tonic / subdominant / dominant):
  the key's own, chords borrowed from parallel modes, and chromatic ones (secondary dominants, tritone substitute,
  passing diminished, chromatic mediants). Click to hear a chord in place, + to add it; hover for the reason.
- The progression as a strip with roman numerals and a tension curve; it is named when the library knows it. Click
  a chord for what could stand in for it. Read the chords of a pattern, or write the progression into one — voiced
  for 3–5 voices that move as little as they can, held or arpeggiated.
- A library of 82 progressions, searched by words, tags and mood, shown in your key.
- The project's tuning with its table (see below).

**Tuning** — every pitched instrument follows it, in playback, renders and exports; drums are not retuned
- Equal temperament (also 5–72 equal steps), just intonation (5- and 7-limit), Pythagorean, meantone (any share of
  the comma), Werckmeister III, Kirnberger III, Vallotti, Young II, the harmonic series, and tables of your own in
  cents or ratios — with a root and an A4 reference (380–500 Hz).
- A tuning never moves its own root: it keeps its equal-tempered pitch and the other notes are placed against it.
- Ratios are exact (fractions wherever the system is rational), with cents, distance from equal temperament and Hz
  to three decimals — and the beat rate of a chord in each system, so the difference can be read as well as heard.
- Standard tuning costs nothing and changes nothing: no note of an existing project is touched.

**Dictionaries**
- 57 scales (was 21) with descriptions, grouped by family in every picker; any name works ("aeolian", "jazz minor",
  "phrygian dominant").
- 65 chord types (was 37) and every common spelling: `CM7`, `CΔ`, `C-7`, `Cø`, `C7(b9)`, `C6/9`, `C7alt`…
- Roman numerals take any quality (`V7#9`, `i(maj7)`), a bass degree (`IV/1`), inversions (`I64`, `V65`), the
  Neapolitan (`N6`) and applied chords (`V7/V`, `vii°7/ii`).

**New tools for Claude**
- `harmony`: analyze (numeral, function, origin, tension; or the chords and key of a pattern), suggest, substitute,
  negative (negative harmony), modulate (paths to another key), progressions (the library).
- `add_arpeggio` (ten modes, seeded), `add_drum_groove` (sixteen styles onto the drum channels there are, with
  seeded variation and fills), `set_tuning`, `describe_tuning`.
- `add_chords` takes `progression` (a library name) and `voices` (the voice-leading solver); `write_drums` takes
  Euclidean rhythms (`"E(5,16)"`); `music_theory` lists scales and chord types, names the chord notes make, and
  writes Euclidean rhythms.

**Changed**
- An accidental on a roman numeral moves the key's own degree unless the key already has that alteration: `#vi` in a
  minor key is now the raised sixth (F♯ minor in A minor; it was G minor). `vi°` in a minor key is built on the raised
  sixth, like `vii°` on the raised seventh. Chords of harmonic and melodic minor are spelled by letter (`vii°7` in
  D harmonic minor is C♯dim7, not D♭dim7).
- `aug7` is written for what was also accepted as `+7`; `C4` and `C2` are still not chords.
- A project file now carries `tuning`; older files load in standard tuning.

**Not in this release**: adaptive tuning (each chord pure around its own root), tuning for plugin instruments written
as DSP code and in MIDI exports, and the tempo map with ramps from the original list.

Nothing here was tuned by ear: the tables are checked against published values and the engine against measured
pitches, but whether the suggestions are *musical* is for ears to say.

## 0.11.1 — Review of the agent tools

An independent review of 0.11.0 found no critical problem, one serious one and a handful of gaps. Fixed, each with a
test:

- **One call could stall the server for everybody.** A parameter, tool or field name of a megabyte was compared
  letter by letter with every known name (28 s for one request, during which nobody else was answered); thousands of
  unknown arguments produced a 34 MB answer; 200 000 stray fields in one note overflowed the stack. Names longer
  than 64 characters are no longer compared, an error repeats at most 60 characters of what was sent, and eight
  unknown arguments are named — the rest are counted.
- **A number sent as text is no longer taken for a bar.** `"start": "8"` meant bar 8, while `8` means 8 steps —
  bars apart, and with the same friendly answer. As an argument a bare `"8"` is now refused with both spellings
  (`8` for steps, `"8.1"` for the bar). Inside note text `8 C4 1/4` is still bar 8.
- **A batch that cannot be put in place says why**: all calls valid, but the project changed meanwhile (read it
  again and resend) or the change is too large (split it). Nothing was applied in either case, as before.
- **The diff left out things you hear**: a muted or renamed playlist track when the number of tracks also changed
  (each track is now named), and a reordered effect chain when a knob moved too. Wording: "110 notes removed",
  "1 bar", "8.25 steps" (not "8.25s"), audio clips without their sample id; a release velocity of 0.5 is no change
  from none.
- **"The same audio" also looks at single samples.** The null test averaged over the whole render, so a 50 ms click
  at −60 dBFS vanished in four minutes of music. It now also requires that no sample differs by more than two steps
  of 16 bits, and says "a brief difference" when the average is rounding but a moment is not. Two renders of which
  one came back without numbers are no longer "the same by every meter".
- **Spectrum of long audio**: up to twelve minutes every frame is measured (was three); longer audio is thinned at
  scattered frames, not on a regular grid a hi-hat could fall in or out of step with.
- **Note text**: `1.4.3` in 7/8 is past the bar line and says so; a ";" inside a comment is asked back (it could
  end the comment or belong to it); a pitch below MIDI 12 is refused (`60 1 4` is not key 60 at step 1); velocities
  are 0–1 or whole MIDI values 2–127 (`v1.5`, `v0x10` are errors).
- A damaged version file no longer breaks the version list or answers with a server error; the render log keeps
  only plain numbers and short text of what the browser reports; the tab drops remembered renders of other
  projects; the published tool schemas say `additionalProperties: false`; the tempo field has a name for screen
  readers.

Not changed: a `__proto__` argument is dropped by the MCP library before the tools see it (harmless, but silent), and
typing `1,000` in the tempo field reads as 1.0 (the comma is a decimal comma).

## 0.11.0 — Tools built for an agent

The third batch from GGS Composer: what makes working through the MCP tools cheaper, safer and easier to check.
97 tools (was 95).

**Several edits as one change — `batch`** (new)
- Up to 100 editing calls run as ONE change: every call succeeds and the project gets a single update (one undo
  step, one refresh in the studio) — or, if any call fails, nothing is changed and the answer names the call to fix.
- Later calls see what earlier ones did (create a pattern, fill it by name, place it). The ids a batch reports are
  the ids in the project.

**Try before you change — `dryRun`** on every tool that edits the project (55 tools) and on `batch`
- The call is checked and answers with what it would say and what it would change, in words; nothing is touched.
- Tools that do more than edit the project (rendering, playback, exports, versions, samples, creating or opening
  projects) have no dry run and cannot be in a batch — they say so instead of half-doing it.

**Notes as text**
- `add_notes text`: one note or chord per line — `1.1 D3+A3+F4 1/2 v0.7`, `1.3 A4 1/8t`, `> C5 1/8t` (right after
  the line before). `get_pattern format "text"` prints the same lines with the note ids in a comment: about a third
  of the size of the table, and it reads back unchanged.
- Musical positions and durations wherever a note's start and length are given (`add_notes`, `update_notes`,
  `add_roll`): `"2.3"` = bar 2 beat 3, `"2.3.2"` = one sixteenth later, `"6s"` steps, `"1.5b"` beats; `"1/4"`,
  `"1/8t"` triplet, `"1/4d"` dotted, `"1/4+1/16"` tied, `"2bar"`. Numbers still mean steps.
- `write_melody` takes note values as lengths: `C5:1/8 D5:1/8t E5:1/4d`.

**What changed? — `diff_versions`** (new) and **Versions → Changes** in the studio
- What differs between a saved version and now, or between two versions: tempo and key, each channel's sound
  (parameter old → new), notes added / removed / changed as note text, clips, markers, automation, mixer and
  effects. The same music written again (new note ids) is no change.
- The Versions window shows it per version, and follows your edits while it is open.

**Renders you can compare**
- Every `render_mix` gets an id (r1, r2 …) and is compared with the previous render of the same song or pattern:
  what moved in LU, peaks, crest, the bands, width and each stem — or "the same audio" when an edit made no sound.
- "The same audio" is a **null test**: the tab keeps the last render and subtracts it from the new one. The list
  asked for a checksum of every render; in a browser that cannot work — Chromium adds up three or more inputs of a
  node in an order that changes from run to run, so two renders of an untouched project differ in their last bit
  (measured: −111 to −116 dB relative to the mix) and never hash alike. The null test answers the question the
  checksum was for, and says how big a change is.
- **Masking**: with stems, pairs of stems that are strong in the same Bark band at the same moment, how much of
  the time, and which one should give way.
- The spectral balance of an analysis is now measured on a fixed grid of half-overlapping frames. It used to be
  laid out from the first sample above −60 dB, so the same mix 6 dB quieter landed its frames elsewhere and showed
  another balance (seen in a real render: "sub −8 points" for a fader move). Numbers of `render_mix`,
  `analyze_sound` and sample analysis move slightly (a point or two on transient-heavy material).

**Errors that say the fix**
- Tool input is checked by the server itself: a wrong call answers with the argument, what was sent, what is valid
  and the nearest valid value or name — `notes[0].velocity is 300: the maximum is 127 — nearest valid value: 127`,
  `mode is "sng": it must be one of "song", "pattern". Did you mean "song"?`.
- **Unknown arguments are errors now.** They used to be dropped silently: a mistyped `lenght` quietly became the
  default length. A client that sent stray arguments must stop sending them.
- Channels, patterns, presets, instruments, effects, parameters, versions and tools that are not found suggest the
  nearest name; a parameter out of range says the nearest valid value.

**Fixed in the synth editor** (found by an independent review of the 0.10.0 editor fixes)
- Alt-drag on a knob with several routes changed several of them (each frame picked "the deepest" anew) and left a
  dozen undo steps: it now keeps to one route for the whole drag, counts from where the depth stood (fine drags no
  longer lose their remainder), and is one undo step. A route remembered for a knob is forgotten when another
  preset puts something else in its slot.
- Envelope bends: every value up to ±1 can be reached by hand (the last pixel used to jump from ±0.72 to ±1 — keep
  dragging past the end of the slope); a double press still resets when the second press wobbles; a quick drag
  followed by a click no longer resets what was just set; only the left button edits (right and middle clicks
  changed the curve, and the filter graph); a cancelled touch does nothing; a second finger does not take a drag
  over; bends on different handles are separate undo steps; the arrow keys move a handle the way it is drawn.
- Filter graph: a press on the handle that does not move changes nothing (it used to round the cutoff and add an
  undo step); on a narrow phone the editor's columns shrink instead of scrolling sideways.
- Parameter table: arrow keys step by a hundredth of the range (a 0…1 parameter used to jump to its end), and the
  wheel scrolls the table instead of changing a focused number.
- Number fields take a decimal comma ("0,5").

## 0.10.1 — GGS Synth: what a second review found

An independent review of the 0.10.0 modulation code. Everything it found is fixed here, each with a test that fails
without the fix.

**A tempo-locked pattern follows the song, not the browser's audio clock**
- A tempo-synced Turing pattern on the path *same*, and "free" LFOs, were tied to the audio context's clock — which
  starts at a different moment on every Play and in every export. The pattern started somewhere else each time,
  its steps fell up to a step off the grid (20 ms early even in an export), and playback did not match the export.
  Now a note is told where the song stands when it starts and the pattern is a function of that position: **bar 9
  sounds like bar 9**, in the loop, from the middle of the song and in the export, with the steps on the grid.
  A synced free LFO counts beats, so it also stays on the grid through a tempo change.
- A note that started late used to run every step it had missed, from the first one: the longer the browser tab had
  been open, the longer that took (measured by the review: 6 ms for one note after eight hours — two audio blocks).
  The tape can now be entered at any step; entering costs 1–25 µs wherever in the song the note is.
- A pattern that mutates at all now renews every step of its loop at least once in 256 turns.
- **This changes what a Turing pattern plays** (which steps, not how it sounds): the pattern of a given patch is a
  new one. No factory preset uses it; a song made with 0.10.0 that does will play another pattern of the same kind.
- With the transport stopped, notes played by hand share a clock that starts with the first one after a silence.
- Renders of everything else are unchanged, with one footnote: the phase of a "free" LFO is now summed differently,
  which moves it by one rounding step (Vowel Morph differs from 0.10.0 by 1.5e-8 of full scale). A patch that is
  itself chaotic turns that into a different waveform: Fold Drone, when slide pushes its feedback FM — as it does
  with any change of 1e-13 anywhere (measured on 0.10.0 too). Two renders with the same version are still identical.

**Fixed**
- The live dots on the knobs stayed dark after the Channel window was switched to another GGS channel (until it was
  closed and reopened). The route an Alt-drag changes is no longer remembered across channels either.
- Changing the instrument of a GGS channel while its notes sounded left those notes in the engine's books for good
  (they counted against polyphony checks and kept the engine from seeing silence).
- A chaos *path* chosen while the source was not routed took effect only for later notes.
- A knob whose route cannot do anything (the rate of a free LFO) said "drop a source here"; it now says why the
  route there has no effect.
- On a phone the matrix was wider than the editor (Via and × out of reach): a route now takes two lines.
- `set_synth_chaos` and `describe_synth` say what the path *same* does with a synced Turing pattern; the chaos
  preview no longer breaks on a setting that is not a number; the docs said "four macros" in two places.

## 0.10.0 — GGS Synth: modulation you can see

The second batch from GGS Composer: the modulation system, and the way the editor shows it.

**Rings and live dots on the knobs**
- A knob that something modulates wears a **ring** for every route — coloured by the family of its source — showing
  how far that route takes it from where the knob stands.
- While a note sounds, a **bright dot** shows where the control really is: the voices report their modulation to the
  editor about thirty times a second (only while it is open; nothing in the audio depends on it).
- A **source bar** under the header: every source as a chip with a live meter. **Drag a chip onto a knob** to
  modulate it, **Alt-drag the knob** for the depth, right-click the knob to add, choose, invert or remove a route or
  to find it in the matrix. Click a chip to see its routes.

**Chaos** — two generators of movement that never quite repeats: **Lorenz** (swings between two centres, flipping
unpredictably), **Rössler** (a wobbling loop that lurches), **drift** (a random walk that comes home: analog pitch
drift) and a **Turing machine** (a looping step pattern that mutates). Rate in Hz or tempo-synced, a *character*
per type, and a *path*: every note its own (voices drift apart like hardware) or the same for all (a chord moves as
one; a synced Turing pattern then follows the song clock). Renders still repeat exactly — a path is fixed by its
note. Velvet Pad, Analog Bass and Mono Titan now drift like analog voices; Cinema Atmos and Spectral Motion are
stirred by attractors.

**64 modulation routes** (were 16) with a filter box, source colours and live meters in the matrix, and **8 macros**
(were 4), all automatable. Presets name the first four; a macro you route yourself is named after what it moves.
Macros can now be automated from the studio itself: right-click a macro knob → *Automate in the playlist*, or the
playlist's *Create automation clip → Channels → (a GGS channel)*. (Until now only Claude could create those clips.)

**LFO shapes you draw** — shape *steps*: up to 16 bars drawn with the pointer, hard (a step sequencer) or glided
(a curve), with Random / Invert / Ramp.

**Faster and steadier**
- Starting a note costs 20–30 µs instead of 55–90 µs, with twice as many parameters: a 16-note chord no longer
  spends a third of an audio block being born (see `docs/audio-benchmarks.md`).
- The ladder, acid and MS-20 filters no longer allocate memory for every sample (found by review: 40–160 garbage
  collections per 30 s of audio; now none beyond the engine's baseline).

**Fixed** (found by an independent review of 0.9.0)
- Editing an oscillator that is another one's FM source clicked, and switching it off left its last 16 samples
  modulating for the rest of the note.
- An unrelated edit on the buses (the sub's wave, the noise type, the routing) silenced a comb that was still ringing.
- The comb's delay line never reached zero after a note (denormal numbers).
- The envelope bend handles could only reach ±0.69 of their ±1 range and jumped on a sideways touch; they now cover
  the range, and the three curves also have numbers under the graph.
- Delay and Hold knobs could not leave zero with the arrow keys; Enter in the parameter table sent the value twice;
  on a phone the tab row and the filter graph stuck out of the editor.
- Two checks only looked at the first 16 matrix slots (`evaluate_composition`, the `set_note_expression` hint).

**Claude (MCP)** — 95 tools
- New: `set_synth_chaos` (its reply sketches the path it sets).
- `set_synth_modulation`: 64 routes, sources `chaos1`/`chaos2` and `macro5`–`macro8`, `macros` up to 8 values.
  `add_automation`: `macro1`…`macro8`. `set_synth_lfo`: `steps: [...]` and `smooth` for a drawn shape.
- `set_synth_filter` says "self-oscillates" for a setting that does, instead of a +116 dB "response", and reports
  nothing for a filter that is off. `update_channel` accepts params from the previous schema. A route to the rate of
  a free-running LFO says it has no effect. `analyze_synth_patch` explains a silent result when it can.

## 0.9.0 — GGS Synth: analog-style filters, hands-on editor

The first batch of ideas brought over from GGS Composer (the author's earlier Rust synth), translated into this
engine — plain JavaScript in `packages/synth-dsp` — and into this interface.

**Filters: 9 → 21 models** (`packages/synth-dsp/src/filters.js`)
- **Ladder** (transistor, Moog style) as 24 dB and 12 dB low-pass, band-pass and high-pass; **Acid** (TB-303 diode
  ladder); **MS-20** low- and high-pass (Sallen-Key with the resonance clipped in the loop); **Formant** (five vowel
  resonances, A-E-I-O-U); **Phaser** (2–12 stages, per note); **Morph** (low-pass → band-pass → high-pass);
  **All-pass**; **Comb −** (inverted feedback: hollow, odd harmonics).
- The delay-free loops are solved per sample, so the ladder **self-oscillates within 0.1 cent of the cutoff** at the
  doubled rate it runs at by default (within a cent up to 12 kHz without oversampling). These models saturate, so
  quality "auto" renders them at 2×.
- A new **Morph** control per filter (vowel, stages, damping or shape — it is named after what it does for the model)
  and two new modulation targets, `f1Morph` / `f2Morph`.
- The **comb** is now the tuned, damped model: its fundamental stays in tune for any damping (within about 2 cents
  up to 4 kHz),
  resonance maps to ring time (up to several seconds) and Morph damps it. *Patches that used the comb ring longer and
  brighter than in 0.8.0* — lower the resonance (0.9 → about 0.6) and raise Morph (about 0.35) for the old character.
  The eight other original filter types are unchanged.

**Wavetables: 24 → 46** — odd/even, lo-fi, phase distortion, Chebyshev, plucked string, saw stack, pitched hiss,
ensemble drift, aurora, brass, reese, acid, overdrive, vowel bass, crystal, bit logic, formant sweep, whisper,
ring mod, triangle folder, VOSIM, dark matter. The original 24 are untouched.

**Envelopes** gain a **delay** and a **hold** stage and **a curve for each slope** (attack, decay, release: 0 is a
straight line, negative is fast first, positive is slow first). Projects and patch files from 0.8.0, whose envelopes
had one "Curve", are converted to the three curves that draw exactly the same shape. (The default attack curve is
−0.3, a hair sharper than before.)

**No clicks when a patch is edited under a held note**: switching an oscillator on or off, changing its wavetable,
warp mode or unison count, changing a filter's model or the routing now fades that part of the voice (4 ms) instead
of stepping. Measured at the edit: from 0.05–0.15 of full scale down to under 0.002.

**The synth editor**
- **Envelope editor**: drag the nodes (delay, attack, hold, decay + sustain, release); round handles bend each slope.
- **Filter curve**: the measured response of the real filter model, with a handle — left/right is the cutoff, up/down
  the resonance.
- **Preset browser**: categories, search across names, descriptions, macro names and tags derived from each patch;
  ↑ ↓ load as they move.
- **Wavetable picker**: a searchable grid of all 46 tables, drawn.
- **Matrix in words**: every route says what it does in the units of its target — "Filter 1 cutoff 850 Hz → 4.49 kHz
  as pressure goes 0 → 1".
- **All parameters**: every parameter with its value, range and description in one searchable table, with a
  *Changed* filter. Every control has a tooltip from the same descriptions. A drag on a graph is one undo step.

**Presets** — *Acid Line* now runs through the acid filter, *Analog Bass* and *Mono Titan* through the ladder, *Neuro
Bass* through the MS-20, *Vowel Morph* through the formant filter, *Solar Drift* has a phaser in every note, and the
two comb presets use the new comb. All 30 are re-levelled; the others measure the same as before (±0.1 dB).

**Claude (MCP)**
- `set_synth_filter`: the 12 new types and `morph`; the reply includes the **measured response** of the setting.
- `set_synth_envelope`: `delay`, `hold`, `attackCurve`, `decayCurve`, `releaseCurve` (the old `curve` still works).
- `describe_synth`: a new topic "filters"; "parameters" now says what every field does.
- Every patch summary lists the modulation routes in real units. The guide and the sound-design skill know which
  filter is for what (recipes: acid line, ladder bass, talking vowels).

**Under the hood** — `filterResponse()` (measured magnitude response of any setting), `envelopeAt()` (the envelope as
a formula: the editor draws with it, the tests hold the engine to it), `describeRoute()`, `migrateParams()` and a
`migrate` hook on instrument definitions. 71 new engine tests (filters, envelopes, wavetables).

Not in this release, still on the list: drawable LFO shapes, wavetables from a harmonics list or a formula, modulation
rings on the knobs.

## 0.8.0 — GGS Synth, per-note expression, MPE

**GGS Synth** — a new instrument (Browser → Synths), built from scratch in `packages/synth-dsp`
- Three wavetable oscillators (24 band-limited tables, unison up to 8, six warp modes, FM between oscillators), a sub
  and a noise source, two routable filters (low/high/band-pass at 12 or 24 dB, notch, peak, a tuned comb; drive and
  key tracking), four envelopes, four LFOs (free or tempo-synced, per note or shared), four macros and a 16-route
  modulation matrix; built-in drive, chorus, delay and reverb.
- **30 presets** in six families (pads, leads, bass, keys, sequences, experimental), each with four named macros and
  a stated response to pressure and slide, levelled by measurement to −18 LUFS per note.
- An **editor** in the Channel window: waveform and spectrum of every oscillator, filter response curves, envelope and
  LFO shapes, the matrix, effects, patch export/import, and a touch pad that plays pressure and slide with the pointer.
- Runs in an AudioWorklet, one processor per note; realtime and offline renders share one deterministic path. Selective
  2× oversampling (only for patches that can alias). Measured: tuning within 0.1 cent, oscillator aliasing below
  −80 dB, 32 voices × 3 oscillators in under a fifth of a core — see `docs/audio-benchmarks.md`.
- A new project template, **Expressive synths**: a 24-bar piece on six GGS patches with a full performance in the notes.

**Per-note expression**
- Every note can carry its own **pitch**, **pressure** and **slide** (timbre) curve and a **release velocity**. Curves
  live in normalized note time, so moving, resizing, duplicating and quantizing notes keeps them.
- The piano roll's bottom lane edits them: freehand, line and point tools, ready-made shapes (bend, scoop, fall,
  vibrato, swell, ramp, pulse); pitch curves are drawn over the notes; copies keep their performance.
- Pitch curves bend **every** instrument, each note alone; pressure and slide drive the GGS Synth's matrix.
- **MPE input**: each finger of an MPE controller moves its own note, live and recorded into the note's curves;
  ordinary keyboards map pitch wheel, aftertouch and mod wheel the same way.
- **MIDI files**: channels with curves export as MPE tracks and import back into curves.
- A new op, `notes/expression`, patches one curve without touching the others (undoable, synced live).

**Claude (MCP)** — 16 new tools, 94 in all
- `describe_synth`, `create_synth_patch`, `get_synth_patch`, `update_synth_patch`, `set_synth_oscillator`,
  `set_synth_filter`, `set_synth_envelope`, `set_synth_lfo`, `set_synth_modulation`, `set_synth_effect`.
- `analyze_synth_patch` renders a note or chord **on the server** (no browser) and measures it.
- `set_note_expression`, `get_note_expression`, `transform_note_expression`, `copy_note_expression`; `add_notes` takes
  expression inline; `get_pattern` and the project summary show it.
- `evaluate_composition`: a check of the song as written — notes outside the key, flat velocities, chords on a mono
  patch, curves nothing responds to, unplaced patterns.
- `add_automation` can target a GGS channel's `macro1`…`macro4`.

**Notes for existing projects**
- Nothing changes in how existing projects sound: the new note fields are optional and the legacy instruments are
  untouched. The project format version stays 1.
- `npm test` now also runs `packages/synth-dsp`. E2E: set `E2E_CHROMIUM=/path/to/chromium` to use an installed browser.

## 0.7.1 — ten new genre templates

- Ten new genre templates, each pre-mixed with shared reverb/delay buses and (where there is a kick) kick-keyed
  sidechain: **UK Drill** (sliding 808, 3-3-2 hats, dark piano over strings), **Afrobeats** (tresillo kick, congas,
  highlife guitar, finger bass), **Reggaeton** (dembow, nylon-guitar arpeggios, plucked hook), **Liquid Drum & Bass**
  (two-step at 174, reese bass, Rhodes), **Synthwave** (big-room snare, tom runs, FM bass, arp, saw lead), **Disco
  Funk** (slap bass, muted 16th guitar, brass stabs, strings), **Neo-Soul** (lazy swung beat, Rhodes in rootless
  voicings, organ), **Bossa Nova** (batida guitar, upright bass, clave, breathy flute), **Cinematic** (felt piano,
  solo cello, staccato strings, taiko, a reverse swell into a tam-tam) and **Beatbox Jam** (the beatbox collection
  with a lip bass and a hummed hook). 18 templates in all.

## 0.7.0 — sample library folders, wave editor, pitch correction, audio recording

**Sample library** (Browser → Samples)
- **Folders**: every sample lives in one folder or *Unfiled*. Create, rename and delete folders (deleting keeps the
  samples), drag a sample onto a folder or use ⋯ → *Move to folder*, drop audio files on a folder to upload into it,
  fold folders away (remembered per browser).
- **Search** by name, folder, tags and analysis words (`kick`, `vocal 140 bpm`, `pad A minor`).
- A ⋯ menu on every sample (sampler channel, edit, move, rename, details, analyse, delete) and a **select mode** to move
  or delete several at once.
- **Deleting a sample that is in use** first says which projects, channels and clips will go silent. A sample open in
  the wave editor with edits stays there (marked deleted) so the edits can still be saved as a new sample.
- The sampler's sample picker lists samples by folder and has an ✎ button to open the sample in the wave editor.

**Wave editor** (⋯ → *Edit in wave editor*)
- Waveform with zoom, overview strip and ruler; selections that snap to zero crossings; play / loop the selection.
- Cut, copy, paste (also between samples), delete, trim to selection, fade in/out, gain, normalise, reverse, invert,
  silence, remove DC, trim silence, mono/stereo, **speed** (turntable, band-limited, never clips), **time stretch**
  (WSOLA, keeps the pitch) and **pitch shift** (TD-PSOLA for voices and solo instruments below ~1 kHz, keeps formants
  and never clips; band-limited resample + stretch for everything else). Edits that would empty a sample or make it
  longer than 20 minutes are refused.
- Its own undo/redo history; slow processing runs in a worker so the studio keeps playing.
- **Save as new** keeps the original; **Replace original** overwrites the audio everywhere after a warning that lists
  every project, channel and clip using it. Replaced samples keep their id, get a new revision, and every open studio
  reloads them.

**Pitch correction** (the editor's *Pitch* tab)
- Finds the melody of a voice or solo instrument (YIN pitch tracking, note segmentation that ignores vibrato) and
  shows the sung pitch, the notes and the corrected pitch.
- Auto-tune to the project's key and scale (or chromatic) with **Amount**, **Speed** (0 ms = robotic … natural glides)
  and **Flatten** (vibrato and drift), presets *Natural*, *Tight*, *Robotic*.
- Move notes by hand: drag up/down (semitone snap, Alt/Shift fine), ↑/↓, double-click back to the scale, bypass, keep
  as sung, octave moves, and split or join notes the detection got wrong. Preview, then Apply as one undo step and
  save.
- Note detection keeps a regular vibrato (3.5–8 Hz, ±0.3–1.2 semitones), scoops and falls inside their note, and
  still separates legato singing with 20–60 ms slides between notes, wide leaps between short notes with vibrato and
  fast runs of notes from about 100 ms, also with a jittery pitch track. A very slow, uneven wobble can come out as several notes, a semitone trill sung with slow
  slides as one, and a short passing note right after a note with a wide vibrato can be missed: split or join them by
  hand. Only the stretch that is corrected is
  resynthesised (with a crossfade at each end), so the rest of the take stays bit-identical; audio that starts or ends
  on a sung note is corrected right to its edge.

**Recording audio** (🎙 in the toolbar, or *Record* in the Samples tab)
- Record from a microphone alone, or over the song or the current pattern with a count-in and metronome.
- Latency compensation (the browser's output + input latency, plus a manual offset); echo cancellation, noise
  suppression and auto gain are off by default.
- Every take is saved as a WAV sample in a "Recordings" folder and, over the song, placed on the playlist on a free
  track at the bar where recording started (the song plays on past its end instead of looping while you record). A
  take that can't be saved (connection, upload limit) stays in the list with Retry and Download.
- Space or the studio's Stop ends a take; recording over a pattern puts the SONG/PAT mode back afterwards. Signing out
  or leaving the page asks first while a take is being recorded or saved, or one couldn't be saved yet.
- Level meter with peak hold and clip warning, optional monitoring, take list with play / edit / tune / delete.

**Claude**
- New tools: `sample_folders` (list/create/rename/delete), `move_samples` (a new folder name creates the folder) and
  `edit_sample` (any of the editor's operations plus `pitch_correct` with key/scale/amount/speed/flatten, run in the
  user's browser; saves a new sample unless asked to replace — then it lists the projects that changed). 78 tools.
- `list_samples` groups by folder and takes `folder` and search words; `get_sample_info` shows the folder;
  `delete_sample` takes several ids and reports what goes silent. The guide, the `use_my_samples` prompt and the
  beat-making skill explain the vocal clean-up chain.

**Other**
- REST: sample folders, bulk move/delete, usage, `PUT /api/samples/:id/file`, `folderId`/`name` on upload,
  `maxUploadMb` in `/api/status`. Uploads and replacements must contain playable audio (checked before anything is
  written: also a header that promises audio the file doesn't have — FLAC, MP3, AIFF, WAV — is refused); sample and folder names are cleaned (Unicode NFC, no control or invisible format characters, at least one
  visible character, joiners only between visible characters, bounded size) and a joiner or a different case doesn't
  make a folder name new; a browser analysis of audio that was replaced meanwhile is refused (409).
- `Permissions-Policy` header: the microphone for the studio page only; no camera, location, payment, USB, serial, HID.
- The toolbar fits one row at 1440 px again with the new 🎙 button (slightly narrower scope display); on phones it never
  makes the page scroll sideways (below 400 px the song position is left to the playlist).
- Clicking another window (or the empty workspace) takes the keyboard along: Space and Ctrl+Z no longer stay with a
  control in the window you left; a click on the wave editor's or the recorder's title bar gives them the keys back.

## 0.6.1 — About dialog

- **About** (ⓘ at the top right of the toolbar, or ◆ → *About GreanTeaDawy…*): a dialog box with the app name and
  version, the server's version (with a hint to reload when the open tab runs an older build), the built-in sounds and
  the licence. The version comes from `client/package.json` at build time.
- Wording: the studio, README, docs and skills no longer describe GreanTeaDawy in terms of another DAW; only the MCP
  introduction Claude reads keeps that comparison. The subtractive synth is labelled *Subtractive Synth* (the
  instrument kind is still `synth`, so projects and Claude's calls are unchanged).
- Dialogs: one at a time — a dialog opened over another answers the first with "cancel" instead of leaving it
  waiting — and focus goes back to the button that opened them. On phones the toolbar's small buttons are 28 px.

## 0.6.0 — flute, beatbox, Indian and East Asian collections; selection and window fixes

**New instrument collections** (Browser sections *Flutes*, *Beatbox*, *Indian*, *East Asian*; 27 instruments, 106
presets; `list_instruments category=…` for Claude)
- **Flutes**: Flute (Concert, Breathy, Lo-fi, Trap, Alto, Piccolo), Pan Flute, Recorder, Tin Whistle, Ocarina — one
  breath engine (per-kind harmonic recipe, pitched breath noise, tongued chiff, attack scoop, delayed vibrato,
  velocity overblowing, mono slurs).
- **Beatbox**: mouth Kick ("B" lip burst), Snare (Pf, Psh spit, inward K, Kch), Hat (t, ts, inward, tch), Bass (lip /
  throat buzz through "oo/oh/ah/mm" vowel formants, growl, wobble) and FX (click roll, vocal scratch, laser zap,
  siren).
- **Indian**: modelled **sitar** (jawari bridge buzz that lasts the whole note, sympathetic strings tuned to the
  major scale of *Sa*, meend via mono glide), **tanpura** (blooming jawari drone), **tabla** (bols na, tin, tun, te,
  ge, ke, dha, dhin; palm-glide bend on ge), **bansuri**, **shehnai**, modelled **santoor** (mallet-struck courses
  that beat and ring) and **harmonium** (bass/male/female reed banks, shared bellows pulse).
- **East Asian**: modelled **koto**, **guzheng**, **pipa** and **shamisen** (bachi skin "thwack" and sawari),
  **erhu**, **shakuhachi**, **dizi** (membrane buzz), **suona**, **taiko** (odaiko, chudaiko, shime, kara) and
  **gong** (tam-tam bloom, opera gongs that bend down/up, temple bell).
- The world strings are physical models rendered in the background workers like the guitar. Their Karplus–Strong
  loop holds the requested T60 on high notes too and is tuned with exact phase delays (±2 cents up to C7).
- New templates **Indian Fusion** (keherwa theka, tanpura, sitar alap with meend, harmonium, bansuri) and
  **East Asian Lo-fi** (koto in D hirajoshi, shakuhachi, taiko, temple bell). The tabla follows a template's key.
- New scales: hirajoshi, inSen, iwato, yo, and the thaats bhairav, todi, purvi, marwa. Pentatonics take their chords
  and spelling from the 7-note scale that contains them; `music_theory diatonic_chords` explains that a thaat is
  played over a drone instead of returning misleading triads.
- **+ Channel** is now collection → instrument → preset; the channel settings *Type* list is grouped by collection.
- Levels: every new sound was measured with `analyze_sound` against the existing ones (sustained leads ≈ −21 LUFS
  for a held C5, plucked models −23…−27, beatbox kick ≈ −18, snares ≈ −22).

**Also new**
- `write_melody` (and melody strings everywhere): a `~` after a note's length slides into the next note — meend,
  slurs and bends on mono instruments with glide (`"C4:4~ Db4:2"`). The note overlaps the next by up to half a step,
  like bass-line slides, so swing can't open a gap. A length with junk after it (`"C4:4x"`) is now refused instead of
  silently read as 4.
- `add_transition reverse_swell` plays the tonic chord of the project's scale (sus2/sus4 for scales without a third,
  the scale's own fifth for locrian and iwato) instead of guessing minor/major from the scale's name.
- Roman numerals in the thaats are spelled like the scale (D bhairav's II = Eb).

**Fixes**
- A **velocity-0 note** (allowed by MCP and imports) no longer throws inside the clap, cowbell or click-roll
  envelopes; any note the Web Audio API refuses is now dropped on its own instead of making the scheduler retry the
  same range and stack the other notes on top of each other.
- **Selecting a playlist clip shrank it** (it looked collapsed): the dropdown control's CSS class was `.sel`, the
  same class that marks selected clips, notes, velocity bars and spatial rows, so a selected clip was capped at
  180 px and padded (long selected notes in the piano roll too). Dropdowns are now `.ui-select`.
- **Windows didn't move when dragged by the middle of the title bar**: the toolbar strip swallowed the pointer. The
  whole bar drags now, except its real controls; the drag numbers (BPM, Steps) are marked as controls and gained
  arrow-key support.
- QA round on the new instruments: the siren's wobble stops with the note (live notes leaked a running oscillator);
  the scratch and zap sweeps start at the note (offline renders swept early); slurred flute/reed/erhu notes carry
  their vibrato on (in phase) instead of restarting it; high world-string notes (from about A#5–G6 up,
  depending on sustain) now ring for the sustain they ask for, and C7–C8 no longer click;
  the Indian Fusion template retunes the sitar's sympathetic strings (`sa`) and the tabla to the chosen key;
  `list_instruments` with both `kind` and `category` shows the instrument.

## 0.5.0 — band instruments, spatial audio, ffmpeg export, plugins, Docker

**New instruments (GarageBand-style band)**
- **Grand Piano** (`piano`): modelled — inharmonic partials, hammer hardness and spectrum follow velocity, prompt +
  aftersound decay, beating unison strings, no dampers above G6. Presets Grand, Bright, Upright, Felt, Honky Tonk.
- **Electric Piano** (`epiano`): FM tine or reed model with bark, bell and tremolo that stays in phase across notes.
  Presets Suitcase, Mellow, Bright Tines, Tremolo, Wurli.
- **Drawbar Organ** (`organ`): nine drawbars, percussion, key click, overdrive, slow/fast rotary. Presets Jazz, Gospel,
  Rock, Soft, Church.
- **Guitar** (`guitar`): Karplus–Strong string with fractional-delay tuning, acoustic/nylon/electric body, pluck
  point, palm mute, amp drive. Presets Acoustic, Nylon, Clean Electric, Muted, Overdrive.
- **Bass Guitar** (`bass`): finger, pick, slap, upright; pickup comb, mono glide. Presets Finger, Pick, Slap, Muted,
  Upright.
- **String Ensemble** (`strings`): 1–8 players, delayed vibrato, legato/staccato/pizzicato. Presets Ensemble, Slow
  Strings, Solo Cello, Solo Violin, Staccato, Pizzicato.
- Physical-model notes are rendered per pitch and velocity layer in background Web Workers (prewarmed from the
  project's notes, cached with an LRU budget that spares the open project's notes); offline renders wait for the
  prewarm, playback doesn't have to. A live note that isn't rendered yet plays a rendered neighbour (within a fifth)
  repitched while it renders, and selecting or playing a modelled channel prewarms the octave around it — only a
  note with no neighbour at all is rendered on the spot.
- New **Pop Band** template (piano, bass guitar, acoustic guitar, strings, drums).
- The FM synth now blocks the DC offset that integer ratios produce (inaudible, but it skewed meters).

**Spatial (Dolby Atmos-style) mixing**
- Mixer inserts can be **3D objects** (x/y/height + LFE send) around and above the listener; the rest is the stereo
  bed. Project setting: spatial mix on/off and monitoring (stereo fold-down or **binaural** HRTF on headphones).
- New **Spatial window** (toolbar cube): room view with draggable objects, height/LFE knobs, quick positions, speaker
  layout; mixer strips show **3D** for objects; right-click → *Make 3D object…*.
- Position automation (`spatialX/Y/Z` of an insert) — objects move over time; after a clip they stay put.
- Exports (48 kHz / 24-bit): **binaural**, **5.1**, **7.1**, **7.1.4** (WAVE_FORMAT_EXTENSIBLE with channel masks;
  constant-power pairwise panning + height crossfade; room positions map onto the layout like an object renderer:
  front corners = L/R, sides = side surrounds, rear corners = rear surrounds), **object stems** + positions JSON, and an experimental
  **ADM BWF** (bext + chna + axml, ITU-R BS.2076 timed Cartesian positions; not Dolby-certified).
- MCP: `set_spatial`, `place_object`, `move_object`, `export_spatial`, prompt `spatial_mix`; `get_project` shows
  objects. Binaural monitoring/export is level-matched to the stereo mix (−3.5 dB HRTF trim on objects); ADM
  blocks glide between positions sampled every 32nd note (holds use `jumpPosition`) and cover the render's tail; exports that would exceed the 4 GB WAV
  limit are refused before rendering, and render uploads may now be up to 4 GB. Core: `encodeWav` writes multichannel/extensible WAVs with extra chunks and pads odd data sizes.

**Docker**
- Image with ffmpeg, a non-root user, `tini` and a health check; `docker-compose.yml` with a read-only root
  filesystem, dropped capabilities, memory limit, localhost-only port and an optional Caddy HTTPS profile
  (`deploy/Caddyfile`); `docs/docker.md` (configuration, HTTPS, backups, upgrades, password reset, troubleshooting).
- `/api/health` answers to any Host name (container health checks) — every other route still checks `ALLOWED_HOSTS`.
- The startup banner shows `PUBLIC_URL` when it is set.

**Export formats (ffmpeg)**
- File → **Export song as…** MP3, AAC (.m4a), Ogg Vorbis, Opus, FLAC, Apple Lossless (.m4a) and AIFF (bitrate choice
  for lossy formats, 24-bit lossless, title/artist tags): rendered in the browser, converted by ffmpeg on the server.
- **Settings → Audio export** shows whether ffmpeg is installed (version, encoders, every format's status); admins can
  re-check. `FFMPEG_PATH`, `FFMPEG_TIMEOUT_SEC`, `FFMPEG_MAX_JOBS`.
- MCP: `list_export_formats` (what can be exported here, bitrates) and `export_audio` (render + convert, returns the URL).
- REST: `GET /api/exports/formats`, `GET /api/system/ffmpeg`, `POST /api/system/ffmpeg/refresh` (admin),
  `POST /api/exports/:name/convert`. Exports lists and downloads now include the new formats.
- Hardening: only PCM/float WAVs are converted, with the PCM decoder forced; per-format channel limits with a clear
  message (MP3 stereo, Ogg ≤ 6, Apple Lossless ≤ 7, AAC/Opus/FLAC ≤ 8 channels; lossy formats need speaker
  positions, so ADM/object renders convert to lossless only); conversion failures and timeouts are reported (422/504)
  instead of "Server error"; at most 3 conversions per user queued, output names reserved only when a conversion
  starts; invalid numeric environment values fall back to their defaults.

**Plugins (your own instruments, effects and note generators)**
- Plugins are `.zip` packages with a `plugin.json` manifest: **DSP instruments** and **effects** (one JavaScript file
  run in the browser's AudioWorklet through a generated harness), **sample instruments** (multisampled key/velocity
  zones, no code) and **generators** (write notes into a pattern; run in a sandboxed, network-less iframe worker with a
  2 s limit). Five MIT examples in `plugins/examples` (Chiptune, Kalimba, Tape Wobble, Euclidean Rhythms, Counter
  Melody); `npm run plugin:pack` validates and zips a plugin folder. Guide: `docs/plugins.md`.
- **Settings → Plugins**: install with a review dialog (author, type, permissions, files, SHA-256) and a trust warning
  that must be confirmed; updates, enable/disable, remove, plugin errors. Plugins are per user; admins can turn them off
  (Settings → Server → *Allow plugins*, or `PLUGINS_ENABLED=false`). Open studios pick up installs, updates and the
  admin switch without a reload.
- Instrument plugins in the Browser and Channel settings, effect plugins in every insert (automatable params can be
  automated), **Generate** window (piano roll → *Gen*).
- Explicit permissions (`audio-processing`, `samples`, `generator`, `project-read`); network, storage, files, account
  and similar are never granted. Hardened zip reader; code may not `import`/`importScripts`; DSP output is cleaned
  (NaN/∞/runaway values), crashing effects are bypassed, voices are capped by the manifest's polyphony and end ≤ 10 s
  after note-off; generated notes are validated and clamped. Projects that use a missing or disabled plugin still open
  (silent channel, pass-through effect, settings kept). Details in `docs/security.md#plugins`.
- MCP: `list_plugins`, `run_generator`; `add_channel`/`update_channel` and `add_effect`/`update_effect` take plugins
  with validated params. Claude can't install plugins (API tokens get 403 on install).
- REST: `/api/plugins` (list, inspect, install with `trust: true`, enable/disable, remove, worklet/code/samples),
  `/sandbox/generator.html`; WebSocket hint `plugins-changed`; browser job kind `generator`.

**Skills**
- `skills/`: music-production skills for Claude Desktop / claude.ai / Claude Code users — `greanteadawy-beatmaking`
  (workflow + genre recipes and sound palette), `greanteadawy-arranging`, `greanteadawy-mixing` (mixing by the
  numbers with `render_mix`, report → fix table), `greanteadawy-spatial-mix` and `greanteadawy-plugin-author` (plugin
  templates and a Python packer that ports the studio's install checks). `npm run skills:pack` checks them and writes
  uploadable zips to `skills/dist/`.
- Developer skills in `.claude/skills/`: `spatial-audio`, `plugin-system` (the security invariants), `write-plugin`,
  `export-formats`.

## 0.4.0 — production & sound quality (music-industry review)

**Sound — existing songs will sound a little different**
- Velocity now follows a squared curve (1.0 = 0 dB, 0.8 = −3.9 dB, 0.45 = −14 dB) and softer notes are darker. Notes at
  the default velocity are about 2 dB quieter than before; ghost notes are much quieter (as intended).
- The master limiter now really reaches its ceiling: its compressor's automatic makeup is removed exactly (replicating
  the browser's algorithm), its threshold sits 1.5 dB under the ceiling and an oversampled soft clip takes the last bit.
  Driven masters come out ~1.5–2.5 dB louder at the same settings (new projects another ~1.9 dB from the 0 dB master
  fader); new projects get a −1 dB ceiling. Every effect parameter now starts at its value instead of gliding into it
  at the start of playback/renders.
- **Compressor**: the browser's hidden automatic makeup gain (≈ +7 dB at the defaults) is removed — the Makeup knob is
  the only makeup now. Songs that use a compressor get quieter on that insert; raise Makeup to taste.
- New projects have the master fader at 0 dB (it sits after the limiter); existing projects keep theirs.
- Reverb rooms are generated anew (early reflections, highs decaying faster, independent left/right); the convolver
  normalizes their level. The reverb's damping/low-cut and the delay's tone filter are now flat Butterworth filters
  (before, a ~1 dB-Q bump coloured them slightly), and the delay repeats are high-passed at 120 Hz.
- The sampler fades the last 4 ms of a (trimmed) sample, and audio clips get 3 ms edge ramps, so cuts no longer click.
- `render_mix` ignores solos left on in the studio (Claude always hears the whole mix).

**New**
- Kick-triggered sidechain (`pump` with a trigger channel), EQ high/low-pass, parallel compression (`mix`), stereo
  `monoBelow`, reverb `size`, delay repeats high-passed.
- Per-channel groove (nudge in ms, swing share); swing follows slightly off-grid notes.
- Markers above the playlist; audio clip gain, fades and repitch-to-tempo; sampler trim, sustain loop and cutoff.
- 24-bit and dithered 16-bit WAV export, stem export (File menu and `export_stems`).
- MCP: `apply_groove`, `add_fill`, `add_transition`, `set_markers`, `analyze_sound`, `export_stems`; voicings and register
  for `add_chords`; degree bass lines with slides for `add_bassline`; `render_mix` targets, true peak, loudness range,
  limiter gain reduction, low-end note and width; gain/fade/repitch options for audio clips; a guide with mixing numbers.
- Presets: Lo-fi Keys, Strings, Riser Noise, Reverse Swell (subtractive synth), Felt Piano (FM), Sub Drop (808), Trap kick (short,
  above the 808). Templates use shared reverb/delay buses, high-passes and kick sidechain; the stereo shaper defaults to
  width 1.
- Groove presets humanize in milliseconds (a few ms, not tens), keep accented hats at normal velocities so presets can
  be re-applied, and write ghost snares at 0.4; the guide explains swing vs MPC percentages, sidechain depths per
  role and a drum-bus recipe.

## 0.3.0

Accounts and API tokens, documentation, Claude Code skills and agents, three QA rounds of fixes.
