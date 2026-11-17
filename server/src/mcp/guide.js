export const GUIDE = `# GreanTeaDawy — guide for making music

GreanTeaDawy is an FL Studio-style DAW in the browser. Everything you change appears live in the user's browser.

## Concepts
- **Channels** (Channel Rack) = instruments: synthesized drums (kick, snare, clap, hat, tom, rim, cowbell, cymbal, shaker, perc),
  808 bass (bass808), subtractive synth (synth), FM synth (fm), the GGS Synth (ggs: wavetable/FM hybrid with a
  modulation matrix and per-note expression — see "GGS Synth" below), the engine instruments — analog (two
  band-limited oscillators with hard sync into a ladder filter: basses, sync leads, brass, PWM strings), additive
  (64 partials shaped as one spectrum: organs, glass, choirs, bells) and modal (objects that ring: marimba,
  vibraphone, bells, kalimba, harp, bowed bars) — each with presets (list_instruments kind="analog") and plain
  params set with update_channel; sampler (the user's uploaded audio) and the band
  instruments: grand piano (piano), electric piano (epiano: tine/reed), drawbar organ (organ), guitar (acoustic, nylon,
  electric), bass guitar (bass: finger/pick/slap/upright) and strings (legato, staccato, pizzicato; ensemble or solo).
  World collections: flutes (flute, panflute, recorder, whistle, ocarina), beatbox (bbkick, bbsnare, bbhat, bbbass,
  bbfx), Indian (sitar, tanpura, tabla, bansuri, shehnai, santoor, harmonium) and East Asian (koto, guzheng, pipa,
  shamisen, erhu, shakuhachi, dizi, suona, taiko, gong). Each has presets + params; list_instruments category="indian"
  shows one collection.
- **Patterns** hold notes for any number of channels (reusable building blocks). Default length 1 bar = 16 steps.
- **Playlist** arranges pattern clips (and audio / automation clips) on tracks over time (song mode). A clip longer than its pattern loops it.
- **Mixer**: insert 0 = Master. Each channel routes to an insert (mixerTrack). Inserts have up to 10 effects
  (eq with high/low-pass, filter, compressor (mix < 1 = parallel), delay, reverb, distortion, chorus, phaser, bitcrusher,
  stereo (width + monoBelow), pump (sidechain ducking: source = a channel, or a tempo grid), limiter), output routing and sends.
  The studio effects (list_effects shows all by purpose; list_effects type="…" one in full): maximizer (a look-ahead
  limiter that also holds the peaks BETWEEN the samples: ceiling -1 = -1 dBTP), ott (three-band up/down compression),
  transient (more or less attack / sustain, no threshold), trancegate (a rhythmic gate on the song's grid), algoverb
  (a reverb whose decay knob is its decay time; voicings room/hall/plate/cathedral/cosmic; freeze), shimmer (a reverb
  that climbs in octaves), resonator (five strings tuned to a chord: noise or drums in, a chord out), flanger,
  tremolo (auto-pan with stereo 0.5), ringmod, freqshift (Hz, not semitones: inharmonic; ±1 Hz mixed in = a phaser
  that only rises), disperser (smears a kick's click into a "pew"), lofi (bits, sample rate, wow, hiss), utility
  (gain, pan, width, mono below, polarity, swap, delay, DC).
- **Markers** name song sections above the playlist (arrange_song makes them; set_markers edits them).
- **Automation** clips move a parameter over time (channel volume/pan/pitch/filterCutoff/filterRes, a GGS Synth's
  macro1..macro8, mixer volume/pan, automatable effect params).
- **Expression**: every note can carry its own pitch curve (semitones), pressure curve and slide/timbre curve (0..1)
  and a release velocity — an MPE performance written into the note (set_note_expression).

## Time & notes
- Time unit default is **steps** = 16th notes. 4 steps = 1 beat, 16 steps = 1 bar (4/4). PPQ = 96 ticks/beat, 1 step = 24 ticks.
- Bars and tracks in tools are **1-based** (bar 1 = song start). Steps inside a pattern are **0-based**.
- Notes: names like C4, F#3, Bb2 (C4 = MIDI 60 = middle C) or MIDI numbers. Velocity 0..1 (1 = full) or MIDI 2..127.
- Drum step strings: x = hit, X = accent, o = ghost, 1-9 = velocity 10-90%, - or . = rest. Spaces and | are ignored.
  e.g. kick "x---x---x---x---", snare "----x-------x---", hats "x-x-x-x-x-x-x-x-". Strings longer than the pattern extend it.
- **Note text** — the cheap way to write and read notes (add_notes text, get_pattern format "text"): one note or
  chord per line (or separated by ";"): <start> <pitch[+pitch…]> <duration> [v<velocity>] [r<release velocity>] [p<pan>]
  e.g. "1.1 D3+A3+F4 1/2 v0.7; 1.3 A4 1/8t; > C5 1/8t; > E5 1/8t; 2 A2 1bar".
  Start: bar, bar.beat or bar.beat.sixteenth, all counted from 1 inside the pattern ("1" = its first bar, "2.3" = bar 2
  beat 3, "2.3.2" = one sixteenth later; a fourth number adds ticks, 24 to a sixteenth), or steps with an s ("6s"),
  or beats with a b ("1.5b"). ">" starts right after the line before (runs, triplets), "=" together with it.
  Duration: 1/4, 1/8, 1/16, 1/8t (triplet), 1/4d (dotted), 1/4+1/16 (tied), 2bar, 1.5b (beats), 3s (steps).
  get_pattern format "text" prints the same lines with the note ids in a comment — send them back as they are.
  The same positions and durations work wherever a note's start and length are given (add_notes notes, update_notes,
  add_roll): a number is steps, text is musical ("start": "2.3", "length": "1/8t"). There a bare "2" is refused —
  bar 2 is "2.1", and the number 2 is 2 steps; inside note text "2" is bar 2. A comment (" # …") runs to the end of
  its line: put no ";" in one.
- Melody strings: "C5:2 D5:2 Eb5:4 -:2 G5:6" (note:length — steps, or a note value: "C5:1/8 D5:1/8t E5:1/4d" — "-" =
  rest, "!" suffix = accent, "~" suffix = slide into the next note on mono instruments with glide).
- Chords: symbols (Am7, F, Cmaj9, G7sus4, G7b9, C6/9, C/E — 65 qualities, music_theory action "chord_types") or roman
  numerals in the project key: a degree (upper case = major, lower = minor) and any quality (i, VI, bVII, V7, ii°,
  V7#9, IVmaj7); V7/V applies a chord to another degree, IV/1 puts it over a bass degree, I64 / V65 invert it, N6 is
  the Neapolitan. The degree is the key's own (VI in A minor = F); an accidental moves it unless the key already has
  it (bVII in A minor = G). Scales: 57, by any name ("aeolian", "jazz minor", "phrygian dominant"; music_theory
  action "scales").
- Drum instruments play at their natural pitch at note C4 (60); other notes pitch them up/down.
- 808, bass guitar and synths with mono=true glide (slide) when notes overlap (bass lines: the "~" suffix makes a slide).
- Band instruments: piano, guitar, bass and pizzicato are physical models — a note rings out naturally until its end
  (long notes = sustain pedal; for a natural piano, let chord notes run to the next chord). Write guitar chords in a
  guitar register (octave 3, rhythm style "x--x--x-" strums), bass guitar around E1–G2 (add_bassline octave 1–2), piano
  chords around C3–C5 with the left hand an octave or two below, strings with long notes (legato) or "staccato" /
  "pizzicato" presets for short ones. The organ is barely velocity-sensitive (use drawbars/percussion for colour).
  Band instruments are louder in short bursts than on average (like recordings): judge them with render_mix stems.
- World instruments: sitar, tanpura, santoor, koto, guzheng, pipa and shamisen are physical models like the guitar.
  Sitar, bansuri, shehnai, erhu, shakuhachi, dizi, suona, whistle and bbbass are mono with glide by default: a "~"
  after a note's length in write_melody ("C4:4~ Db4:2") or overlapping notes give meend, slides and bends. Set the
  sitar's sa param to the song's key root so its sympathetic strings ring with the raga (sa "D" in D). Tabla is one channel per bol (presets Na, Tin, Tun, Te, Ge, Ke, Dha,
  Dhin; "Ge Slide" bends up) — e.g. a theka on Dha/Na/Tin/Ge channels; its treble drum plays C at C4, so transpose the
  channel (pitch) to the song's Sa. Tanpura = the drone: long Sa/Pa notes (C3 + G2) restruck every bar or two.
  Taiko and gong follow note pitch like drums. Beatbox: closed and open bbhat in one choke group; bbbass sits around
  C1–C3. Scales: hirajoshi, inSen, iwato, yo (koto/shakuhachi/shamisen); for ragas use the thaats bhairav, todi, purvi,
  marwa (or major/lydian/mixolydian/dorian/minor/phrygian = Bilawal/Kalyan/Khamaj/Kafi/Asavari/Bhairavi) and write
  melodies over the drone rather than triads (music_theory diatonic_chords refuses the thaats).
- **Velocity is a squared curve** (like hardware): 1.0 = 0 dB, 0.8 = -3.9 dB, 0.6 = -8.9 dB, 0.45 (ghost "o") = -14 dB,
  0.3 = -21 dB. Softer notes are also darker (snare, hats, synth filters, FM brightness, sampler cutoff, piano/guitar/bass/e-piano tone). Real grooves
  live on velocity: accents on downbeats, off-beat hats around 0.6–0.7, ghost snares at 0.35–0.5 ("o" = 0.45).
- Swing (update_project, 0–100): MPC/Ableton swing % ≈ 50 + swing/4 (MPC 54% = 16, 58% = 32, 62% = 48, 66% ≈ a
  triplet shuffle = 64; 100 = 75%, dotted). House 15–25, afrobeats 30–40, boom bap 40–55, lo-fi 50–65.

## GGS Synth & per-note expression
- The GGS Synth (instrument "ggs") is the studio's sound-design synth: 3 wavetable oscillators (46 tables; unison of
  up to 16 copies with a detune law — oscAUniLaw "super" is the JP-8000 supersaw's spacing and knob curve — a stack
  (oscAStack "octave" | "fifth" | "octave+fifth") and a table position per copy (oscAUniPos); warp, FM between
  oscillators), sub + noise, 2 filters (serial/parallel; 21 models: clean lp/hp/bp/notch/peak/
  all-pass/morph, analog-style ladder24/ladder12/ladderBp/ladderHp, acid (TB-303 diode ladder), ms20Lp/ms20Hp,
  formant (vowels), phaser, comb/combNeg; drive, key tracking and a per-type "morph"), 4 envelopes (delay, attack,
  hold, decay, sustain, release, each slope with its own curve), 4 LFOs, 2 chaos generators, 8 macros, a 64-route modulation matrix and
  built-in drive (driveOs "4x" / "8x" for bright, hard-driven sounds: less fold-back) /chorus/delay/reverb. 30 presets in six families (pads, leads, bass, keys, sequences, experimental),
  all levelled to about -18 LUFS per note.
- Pick the filter for the job: lp24 = neutral and precise; ladder24 = warm, fat, sings (basses, leads; resonance
  above 0.9 self-oscillates in tune); acid = squelch (resonance 0.75-0.95, a fast envelope on the cutoff, cutoff
  300-600 Hz: it sounds darker than the number); ms20Lp = snarl that keeps its bass; formant = vowels (cutoff 1000,
  keyTrack 0, move f1Morph); comb with keyTrack 1 and a noise burst = plucked string (resonance = ring time,
  morph = damping). set_synth_filter replies with the measured response of what you set.
- describe_synth is the reference (topics: overview, parameters, filters, wavetables, modulation, presets). create_synth_patch
  makes a channel from a preset or from scratch; set_synth_oscillator / set_synth_filter / set_synth_envelope /
  set_synth_lfo / set_synth_chaos / set_synth_modulation / set_synth_effect edit one section each; get_synth_patch reads a patch back
  (format "document" = a portable patch); update_synth_patch applies a document.
- analyze_synth_patch renders a note or chord on the server (no browser needed) and measures pitch, loudness, spectrum
  and envelope — optionally with pressure/slide/pitch curves and macro values. Design by ear-with-numbers: change,
  analyze, compare.
- Modulation amounts are fractions of the target's range: f1Cutoff 0.3 = 3 octaves, oscAPos 0.5 = half the table,
  pitch 0.5 = 12 semitones, pitchFine 0.3 = 0.3 semitones (vibrato). Every reply that shows a patch spells each
  route out in real units ("Filter 1 cutoff 850 Hz → 4.49 kHz as pressure goes 0 → 1"): read them to check a route
  does what you meant. "via" multiplies a route by a second source
  (LFO → pitchFine via pressure = vibrato that grows as the note is pressed).
- set_note_expression writes per-note curves as shapes (bend, scoop, fall, vibrato, swell, ramp, pulse) or points;
  get_note_expression reads them; transform_note_expression scales/inverts/smooths; copy_note_expression moves a
  gesture to other notes. Pitch curves bend ANY instrument, each note alone (bend only the third of a chord).
  Pressure and slide only do something on a GGS Synth, and only where the patch routes them (every preset does:
  describe_synth topic "presets" says what pressure and slide do in each).
- Make lines human: a scoop into important notes (pitch scoop depth 0.5–2), vibrato that starts late on long notes
  (rateHz 5–6, depth 0.15–0.4, delay 0.3), pressure swells on pads (swell peak 0.8), slide ramps to open a sound
  through a phrase, a fall at phrase ends. Less is more: shape the 20% of notes that matter.
- Macros (macro1..macro8) are a patch's performance knobs: set them with set_synth_modulation macros, and automate
  them over the song with add_automation (target channel, param macro1). Presets name and route the first four;
  5-8 are free for your own (route them: macro5 → whatever the part needs to move).
- An LFO can play a shape you write: set_synth_lfo steps [1, 0, 0.5, 0, 1, -1, 0.5, 0] with sync "1bar" is an
  eighth-note pattern (smooth 0 = steps, 1 = a curve through them) — rhythmic gates on "level", sequenced filter
  moves, a custom wobble.
- Chaos (set_synth_chaos, sources chaos1 / chaos2) is movement that never loops: "drift" on pitchFine 0.04-0.08
  with path "note" is analog voice drift (every note a few cents off, differently); "lorenz" or "rossler" slowly on
  a wavetable position or a filter keeps a pad alive without an audible LFO cycle (path "same" moves a chord as
  one); "turing" tempo-synced on a filter or pitch is a generative step pattern (character 0 locks the loop).
  A render is still the same audio every time — a path is fixed by its note.
- evaluate_composition checks the song as written (keys, dynamics, voices, expression that nothing hears, unplaced
  patterns) — run it before render_mix.

## The user's samples
- list_samples / get_sample_info give technical metadata (format, codec, bitrate, sample rate, bit depth, channels, duration, tags)
  and an analysis: loudness (LUFS), peak, spectral balance, onsets, tempo, key, pitch and a guess of what it is (kick, hat, melodic loop...).
- Use one-shots in a sampler channel (add_channel instrument=sampler sampleId=...; root key is set from the detected pitch),
  or place loops/vocals as audio clips (add_audio_clip). Match a loop's tempo/key to the project.
- The library is organised in folders (each sample in one folder, or Unfiled): list_samples takes folder and search words
  ("kick", "vocal 140 bpm", "pad A minor"); sample_folders lists/creates/renames/deletes folders; move_samples files samples
  (a new folder name creates it). Takes the user records land in the "Recordings" folder.
- edit_sample is the wave editor for Claude (it runs in the user's browser): trim, delete, silence, fades, gain, normalize,
  reverse, invert, mono/stereo, remove_dc, trim_silence, speed (turntable), stretch (keeps pitch), pitch_shift (keeps
  length) and pitch_correct (auto-tune a solo voice/instrument to key+scale: amount, speed ms — 0 = robotic, 50-100 natural —
  and flatten for vibrato). Times in seconds. It saves a NEW sample by default; saveAs "replace" changes every project
  that uses the sample (the reply lists them) — only when the user asks. Typical vocal chain: trim_silence, remove_dc,
  pitch_correct in the project's key, normalize to -1, then add_audio_clip.
- delete_sample (only when asked) reports which projects, channels and clips go silent.

## Listening to your work
- render_mix renders the song (or a pattern) in the user's browser and returns a mix analysis: integrated loudness,
  loudness range, sample + true peak, master limiter gain reduction, spectral balance, the strongest low frequency,
  stereo width (and low-end width), loudness per section and per-channel stems (with each bass stem's low note).
  Pass target (streaming, apple-music, club, hip-hop, edm, lo-fi, broadcast, podcast) or targetLufs: the report says
  exactly how many dB to move the master limiter's input gain.
- Every render has an id (r1, r2 …) and is compared with the previous render of the same thing — so the loop is:
  render, change ONE thing, render again, read "Compared with render rN". It says either that the audio is the same
  (the earlier render was subtracted and nothing but rounding is left: your change is not heard — a muted channel, a
  route that goes nowhere, an effect that is bypassed), or what moved: LU, peaks, crest, the bands, width, each stem,
  and the null test's residual (−6 dB = a big change, −40 dB = a subtle one). compareTo "r3" compares with an older
  render (meters only), "none" skips it.
- With stems the report also lists MASKING: pairs of stems that are strong in the same band at the same moment, how
  much of the time, and which one should give way (the one that has less of its sound there) — duck it with a pump
  (source = the other), cut it there with an eq, or move it to another octave. Fix the worst pair, render, compare.
- analyze_sound renders ONE note of a channel and measures it: pitch (+cents), the low-end note, loudness, spectrum,
  attack and decay times. Use it to tune the 808/kick to the key, keep kick and 808 fundamentals apart (≥ 2 semitones,
  or sidechain), and check an 808 tail doesn't run into the next hit.

## Spatial (Dolby Atmos-style) mixing
- set_spatial turns the 3D mix on; place_object makes a mixer insert (or a channel's insert) a 3D object in the room;
  everything else stays in the stereo bed. Coordinates (Atmos/ADM Cartesian): x -1 left wall … 1 right wall,
  y -1 back … 1 front (screen), z 0 ear height … 1 ceiling; or a named spot (front-left, overhead, rear-right…), or
  azimuth (clockwise, 90 = right) / elevation / distance. Only inserts that go straight to the master can be objects.
- A good start: kick, bass/808, the lead vocal/lead and the main drums stay in the bed (or front centre); pads and
  strings wide or overhead (z 0.5–1); guitars/keys wide left/right (x ±0.8, y 0.3–0.6); percussion, FX, delays and
  ear candy around and behind (y -0.5…-1). Move things with move_object (circle, fly-over, rise, left-right,
  points) — sparingly, on transitions. Leave the reverb bus in the bed.
- set_spatial monitor=binaural lets the user hear it on headphones live. export_spatial renders binaural, 5.1, 7.1,
  7.1.4, object stems (+ positions JSON) or an experimental ADM BWF. Objects skip the master limiter in speaker/object
  renders: keep object stems peaking under -1 dBFS (the report lists channel peaks). lfe 0.1–0.3 only for big
  low elements in objects (the bed's low end stays in L/R).

## Exporting
- list_export_formats says what this server can make (WAV always; MP3, AAC, Ogg, Opus, FLAC, ALAC, AIFF with ffmpeg).
  export_audio renders and converts (bitrate for lossy formats, title/artist tags) and returns the download link.
  export_stems gives one WAV per channel; export_spatial the 3D deliverables.

## The user's plugins
- list_plugins shows the instrument, effect and generator plugins the user installed, with their params and presets.
  Use them like built-ins: add_channel instrument="plugin" plugin="<id>" (preset, params), add_effect type="plugin"
  plugin="<id>", update_channel / update_effect for their params (validated against the plugin's ranges).
- run_generator plugin="<id>" pattern channel (params, bars, seed) fills that range of the channel with the
  generator's notes (it runs in the user's browser sandbox; same seed = same notes). Generators with project-read see
  the pattern's other notes — write the melody first, then generate the harmony/counter line.
- You can't install plugins (the user does that in Settings → Plugins after confirming they trust the author). Don't
  ask the user to install plugins you only imagine exist; suggest ones only if they ask.
- Plugins are third-party code: check render_mix after adding one (levels, no INVALID RENDER); a plugin that errors
  is bypassed (effects) or silent (instruments).

## Gain staging & mixing by numbers (do this, don't guess)
- Faders: channel volume 0.78 (default) ≈ -2.2 dB, mixer insert 0.8 (default) ≈ -1.9 dB, master 1.0 (default) = 0 dB.
  set_mixer takes volumeDb.
- Start with the kick: aim its stem peak around -6 dBFS. 808/bass stem LUFS ≈ kick +1…+3 dB (trap/drill) or -2…0 dB
  (house/pop). Snare/clap ≈ kick -1…-3 dB. Hats 8–12 dB under the kick. Pads/chords 10–12 dB under the kick,
  lead/vocal sits on top (≈ kick -2…0 dB). Check with render_mix stems, adjust, render again.
- High-pass everything that isn't kick or bass: eq hpf 100–200 Hz on pads/keys/leads/hats, 60–80 Hz on snares.
- Low end in mono: stereo effect {"monoBelow":120,"width":1} on bass/808/pads (width > 1 only on pads/leads, never
  on a bass).
- Sidechain: pump with params {"source":"Kick"} on the bass/808/pad insert ducks on every real kick (syncopated trap
  kicks too): 808/bass depth 0.3–0.5, shape 0.2–0.3 (just clears the kick); pads/chords depth 0.6–0.8, shape 0.4–0.5
  (audible pump for house/EDM). The grid mode (no source) only suits four-on-the-floor.
- Kick vs 808: a short kick (decay ≤ 0.3 s, e.g. kick preset "Trap") whose fundamental is at least 2 semitones away
  from the 808 notes — check both with analyze_sound and tune the kick (param tune) — and sidechain the 808 to it.
- Space: one shared reverb insert (reverb mix 1.0, decay 1.5–3 s, size 0.4–0.7) fed by sends (set_mixer sends 0.1–0.3)
  instead of a reverb on every channel; delays the same way. The delay already high-passes its repeats.
- Drum bus: route the drum channels' inserts to one insert (set_mixer output) and give it glue — compressor
  {"threshold":-30,"ratio":6,"attack":0.005,"release":0.1,"makeup":12,"mix":0.4} (parallel) — and a touch of
  saturation — distortion {"drive":0.15,"mix":0.3}. The compressor's Makeup knob is the only makeup gain (the
  browser's automatic makeup is removed): raise it until the level matches the bypassed sound, then judge the glue.
  The makeup correction follows the compressor's set threshold/ratio, not their automation.
- Master: limiter ceiling -1 dB for streaming; input gain = target LUFS − measured LUFS (render_mix tells you). Keep the
  master fader at 0 dB (it sits after the limiter, so anything lower wastes headroom). If the limiter reduces more than
  ~6 dB, fix the balance first instead of pushing harder.
  For a release that must not exceed a true-peak figure (streaming services ask for −1 dBTP), put a maximizer after
  the limiter (or instead of it): {"ceiling":-1,"gain":0} holds the peaks between the samples as well, which the
  limiter does not; raise its gain for loudness. It looks ahead 5 ms, which the render compensates.

## Groove, fills and transitions
- apply_groove gives drums a feel in one call (boom-bap, dilla, lo-fi, trap, drill, house, afrobeats, straight): swing,
  per-channel nudge (lazy snares +10…+20 ms), swing share, hat accents, humanizing, optional ghost snares.
  update_channel nudge/swingMix fine-tunes single channels. Swing follows notes that are slightly off the grid too.
- add_fill makes a fill version of a drum pattern (snare_roll, tom_run, hat_roll, stutter, dropout, kick_build):
  play it on the last bar of a section (every 4 or 8 bars).
- add_transition builds risers (filter + volume sweep), downlifters, reverse swells, snare builds, crashes, sub drops and
  impacts that land exactly on a section start. A drop usually wants: riser 4–8 bars + snare_build 2 bars + impact on
  the downbeat + a dropout fill in the bar before.

## Harmony & bass
- harmony is the tool to think with (it changes nothing): action "analyze" says what each chord is in the key — numeral,
  function (tonic = rest, subdominant = departure, dominant = tension), where it comes from, tension 0–1 — and names a
  known progression; give it a pattern to read the chords the notes play and check the key. "suggest" ranks what
  could come next, with the reason, in three groups (in the key / borrowed from parallel modes / chromatic).
  "substitute" offers stand-ins for one chord; "negative" mirrors a progression; "modulate" gives the chords to
  another key; "progressions" searches a library of 82 by words and tags (lo-fi, cinematic, jazz, trap, hopeful…).
  A shape that works: tension low at the start of a section, highest just before it ends, released on the next
  downbeat.
- add_chords progression="<library name>" writes one in the project key. voices=4 voice-leads the whole progression
  (every voice moves as little as it can, parallel fifths and octaves avoided wherever the chords allow;
  bass="smooth" allows inversions).
- add_arpeggio: modes up, down, updown, downup, converge, diverge, pinky, thumb, asplayed, random; rate "1/16",
  octaves, gate (>1 = legato), swing, accentEvery or a velocities pattern. add_drum_groove: sixteen styles written onto
  the drum channels there are (missing ones are made); variation and fill are seeded. write_drums takes Euclidean
  rhythms: "E(5,16)", "E(3,8,2)" started 2 steps later, "E(3,8)x4" repeated. The same seed always gives the same part: change it
  for another take, keep it to get the part you liked again.
- Tuning: set_tuning puts every pitched instrument in just intonation (system "just": beatless major chords on the
  root, its fourth and fifth — chords far from the root pay for it), "just7" (a 4:5:6:7 seventh on the root), "pythagorean",
  "meantone", a well temperament ("werckmeister", "kirnberger", "vallotti", "young"), "harmonic", other equal
  divisions or a custom table, with a root (default: the song's key) and a4. The root never moves. describe_tuning
  shows the exact ratios, cents and Hz, and with chord=… how fast that chord beats there (compare=[…] for other
  systems). Drums, tabla, taiko and gongs are not retuned. Use it for drones, pads and slow harmony in one key; leave fast modulating music
  in equal temperament.
- add_chords voicing: close, open, drop2 (neo-soul/jazz keys), drop3, spread (cinematic), shell (root-3-7, lo-fi
  comping), rootless (3-5-7-9 over a bassline). register keeps the chords around a pitch ("E4" keys, "C5" airy pads).
- add_bassline line speaks degrees: "R:3 R:1 -:2 5:2 R:2~ 8:4 b7:2" (R root, 3/5/7 = the chord's own, 8 octave,
  -5 fifth below, "~:2" tie, "!" accent, "?" ghost, "~" suffix = slide into the next note — 808 glides).

## Delivery
- render_mix save=true keeps a 24-bit WAV (bitDepth 16 = dithered). export_stems writes one WAV per channel (with its
  insert FX and sends, without the master bus) for mixing engineers and collaborators.
- Audio clips: add_audio_clip/update_clips take gainDb, fadeInSteps/fadeOutSteps and fit="repitch" (or rate) to play
  a loop at the project tempo by changing its speed (pitch moves with it, like a turntable).

## Safety nets
- save_version before big changes; restore_version to go back. undo reverts your own last change.
- **batch** runs several editing tools as ONE change: all of them, or — if one fails — none, with the failing call
  named. One undo takes the whole batch back, and the studio updates once. Later calls see earlier ones (create a
  pattern in call 1, fill it by name in call 2). Use it for anything that belongs together: a section (pattern +
  notes + clips), a sound with its effects and sends, a round of mix moves. Rendering, playback, exports, versions and
  samples cannot be in a batch.
- **dryRun: true** on any editing tool (and on batch) checks the call and reports what it would answer and what it
  would change — in the words of diff_versions — without changing anything. Use it before destructive or wide edits
  (remove_channel, clear_notes, transform_notes on a whole pattern, arrange_song over an existing song).
- **diff_versions** says what changed since the last saved version (or between two versions): notes as note text,
  parameters old → new, clips, effects. save_version, work, diff_versions = a review of your own round of changes;
  diff_versions from: <version> shows what restore_version would bring back.
- A wrong call changes nothing and says how to fix it: the argument, what was sent, the valid range and the nearest
  valid value or name ("Did you mean …?"). Unknown arguments are errors, not ignored: fix the name and send again.

## Ranges & rewriting
- Bar ranges are inclusive: copy_bars / remove_clips fromBar 9, toBar 16 = the 8 bars 9–16.
- write_melody, add_chords and add_bassline (replace=true, the default) only clear the range they write, so you can build a
  pattern section by section (start = step offset). Use replace=false to layer on top.
- Ids: tools that create things return their ids [in brackets]; get_project / get_pattern list them.

## Workflow that works well
1. create_project (optionally from a template) or use the active project (get_project to see it). Set key/scale/bpm.
2. add_channel for each sound (kick, snare/clap, hats, 808/bass, chords, lead, pads, fx; or the user's samples).
   Hats: put open & closed hats in the same chokeGroup.
3. create_pattern per part ("Drums", "Drums Fill", "808", "Chords", "Melody"...), then write_drums / add_chords /
   add_bassline / write_melody / add_notes (as note text) / add_roll. Add variation: ghost notes, velocity, fills,
   call-and-response. A part with its pattern, notes and clips is one batch.
4. Feel: apply_groove for the genre; analyze_sound to tune the 808/kick to the key; set_note_expression on leads,
   pads and bass slides (GGS Synth) so lines breathe.
5. arrange_song into sections (intro, verse, pre, hook, bridge, outro) with energy changes between them; add_fill on
   section ends and add_transition into hooks/drops; automation for filter sweeps.
6. Mix by the numbers above: levels, high-passes, sidechain (pump source=Kick), shared reverb/delay sends, master limiter.
7. evaluate_composition (notes, voices, expression) → fix; then render_mix target=<genre/platform> (with stems) →
   read the numbers and the masking → fix one thing → render again and read the comparison → repeat until clean.
8. save_version, play, and explain what you made (diff_versions lists it). export_stems / render_mix save=true when
   the user wants files.
`;

export const INSTRUCTIONS = `GreanTeaDawy lets you produce music in a browser DAW (FL Studio-like: channel rack, patterns, piano roll, playlist, mixer, automation).
Changes appear live in the user's browser. Call get_project first to see the current song. Time is in 16th-note steps
unless a tool says otherwise; bars/tracks are 1-based. Read the greanteadawy://guide resource for notation details.
Use the user's uploaded and recorded samples (list_samples / get_sample_info include folder, bitrate, sample rate, loudness, tempo,
key and pitch; sample_folders / move_samples organise them; edit_sample trims, fades, stretches, pitch-shifts and auto-tunes them).
Use render_mix (with a target) to "hear" the mix as numbers and analyze_sound to measure single sounds; mix by the
numbers in the guide (gain staging, high-passes, kick-triggered sidechain, shared reverb sends). apply_groove, add_fill and
add_transition add feel, fills and risers/impacts in one call. place_object / move_object / export_spatial make
Atmos-style 3D mixes (binaural, 5.1, 7.1.4, ADM); export_audio delivers MP3/AAC/FLAC/… (list_export_formats first).
list_plugins shows the user's own instrument/effect/generator plugins (use them via add_channel/add_effect/run_generator).
The GGS Synth (create_synth_patch, set_synth_*, analyze_synth_patch; describe_synth is its reference) is the instrument for original
sound design, and every note can carry its own pitch / pressure / slide curves (set_note_expression) — use both to make parts expressive.
evaluate_composition checks the notes before you listen.
Write notes as note text (add_notes text: "1.1 D3+A3+F4 1/2; 1.3 A4 1/8t") and read them the same way (get_pattern format "text").
Group edits that belong together in one batch (one change, one undo, all or nothing); dryRun: true tries any edit without making it.
render_mix compares every render with the one before (the same audio or what moved) and reports masking between stems;
diff_versions says what changed since a saved version. A wrong call changes nothing and says what to send instead.
save_version before risky changes.
After building something, call play so the user can hear it, and describe what you made.`;
