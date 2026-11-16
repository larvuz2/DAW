# GGS Synth recipes

Starting points as patch documents for `create_synth_patch name=… patch={…}`. Adjust by ear-with-numbers
(`analyze_synth_patch`). Wavetable ids: `describe_synth topic="wavetables"`.

## Warm pad

```json
{ "oscillators": [{ "id": "A", "table": "tilt", "position": 0.4, "unison": 5, "detune": 20, "spread": 0.9 },
                  { "id": "B", "table": "tilt", "position": 0.3, "octave": 1, "level": 0.25, "unison": 3 }],
  "sub": { "level": 0.2 },
  "filters": [{ "id": 1, "type": "lp24", "cutoff": 900, "resonance": 0.12, "keyTrack": 0.3 }],
  "envelopes": [{ "id": 1, "attack": 0.6, "decay": 2, "sustain": 0.85, "release": 1.8 }, { "id": 2, "attack": 1.4, "decay": 3, "sustain": 0.5, "release": 2 }],
  "lfos": [{ "id": 1, "shape": "sine", "rate": 0.13, "trigger": "free" }],
  "modulation": [{ "source": "env2", "target": "f1Cutoff", "amount": 0.16 }, { "source": "lfo1", "target": "oscAPos", "amount": 0.06 },
                 { "source": "pressure", "target": "f1Cutoff", "amount": 0.24 }, { "source": "timbre", "target": "oscAPos", "amount": 0.4 }],
  "effects": { "chorus": { "mix": 0.45 }, "reverb": { "mix": 0.35, "size": 0.7 } } }
```

## Sub bass that slides

```json
{ "oscillators": [{ "id": "A", "table": "supersine", "position": 0.12, "phaseRandom": 0 }],
  "sub": { "level": 0.55, "octave": 0, "to": "direct" },
  "filters": [{ "id": 1, "type": "lp24", "cutoff": 320, "keyTrack": 0.6 }],
  "envelopes": [{ "id": 1, "attack": 0.004, "decay": 0.4, "sustain": 0.9, "release": 0.12 }],
  "modulation": [{ "source": "pressure", "target": "oscAPos", "amount": 0.4 }, { "source": "velocity", "target": "f1Cutoff", "amount": 0.12 }],
  "voice": { "mono": true, "legato": true, "glide": 0.04 } }
```
Write overlapping notes ("~" in `write_melody`) to glide. Tune check: `analyze_synth_patch notes=["E1"]`.

## Pluck / keys

```json
{ "oscillators": [{ "id": "A", "table": "resonant", "position": 0.12, "phaseRandom": 0.3 }],
  "filters": [{ "id": 1, "type": "lp12", "cutoff": 3800, "keyTrack": 0.5 }],
  "envelopes": [{ "id": 1, "attack": 0.002, "decay": 0.35, "sustain": 0.1, "release": 0.25 }, { "id": 2, "attack": 0.001, "decay": 0.25, "sustain": 0, "release": 0.2 }],
  "modulation": [{ "source": "env2", "target": "oscAPos", "amount": 0.4 }, { "source": "velocity", "target": "oscAPos", "amount": 0.15 }],
  "effects": { "delay": { "mix": 0.3, "sync": "1/8d", "feedback": 0.45 } } }
```

## FM bell

Oscillator B is the modulator: a sine (`basic` at position 0) with level 0, an octave and a fifth up.

```json
{ "oscillators": [{ "id": "A", "table": "octaves", "position": 0.3, "fmFrom": "B", "fm": 0.3, "phaseRandom": 0 },
                  { "id": "B", "table": "basic", "position": 0, "level": 0, "octave": 1, "semi": 7, "phaseRandom": 0 }],
  "envelopes": [{ "id": 1, "attack": 0.001, "decay": 0.9, "sustain": 0, "release": 0.7 }, { "id": 2, "attack": 0.001, "decay": 0.28, "sustain": 0, "release": 0.3 }],
  "modulation": [{ "source": "env2", "target": "oscAFm", "amount": 0.32 }, { "source": "velocity", "target": "oscAFm", "amount": 0.15 }] }
```

## Expressive lead

```json
{ "oscillators": [{ "id": "A", "table": "tilt", "position": 0.5, "unison": 2, "detune": 7 }, { "id": "B", "table": "basic", "position": 0.75, "level": 0.25, "fine": 4 }],
  "filters": [{ "id": 1, "type": "lp24", "cutoff": 1500, "resonance": 0.22, "keyTrack": 0.6 }],
  "envelopes": [{ "id": 1, "attack": 0.012, "decay": 0.4, "sustain": 0.85, "release": 0.28 }],
  "lfos": [{ "id": 1, "shape": "sine", "rate": 5.6, "fade": 0.25 }],
  "modulation": [{ "source": "pressure", "target": "f1Cutoff", "amount": 0.3 }, { "source": "pressure", "target": "level", "amount": 0.45 },
                 { "source": "lfo1", "target": "pitchFine", "amount": 0.3, "via": "pressure" }, { "source": "timbre", "target": "oscAPos", "amount": 0.45 }],
  "voice": { "level": 0.6 },
  "effects": { "delay": { "mix": 0.2, "sync": "1/8d" }, "reverb": { "mix": 0.2 } } }
```
`voice.level 0.6` + `pressure → level` makes the note swell with pressure. Then perform it: scoops into phrase
starts, vibrato on held notes, a fall at the end.

## Plucked string (physical)

A comb filter tuned to the note (`keyTrack 1`, `cutoff 261.63` = C4) excited by a burst of noise:

```json
{ "oscillators": [{ "id": "A", "table": "basic", "position": 0.5, "level": 0 }],
  "noise": { "level": 0, "type": "white", "color": -0.25 },
  "filters": [{ "id": 1, "type": "comb", "cutoff": 261.63, "resonance": 0.86, "morph": 0.35, "keyTrack": 1 }, { "id": 2, "type": "lp12", "cutoff": 5200 }],
  "envelopes": [{ "id": 1, "attack": 0.001, "decay": 3, "sustain": 0, "release": 0.5 }, { "id": 2, "attack": 0.001, "decay": 0.045, "sustain": 0, "release": 0.04 }],
  "modulation": [{ "source": "env2", "target": "noiseLevel", "amount": 1 }, { "source": "env2", "target": "oscALevel", "amount": 1 }, { "source": "pressure", "target": "f1Res", "amount": 0.08 }],
  "voice": { "gain": 1.6 } }
```

Resonance is the ring time (0.86 ≈ a second at C4, 0.95 several seconds); `morph` damps the string (0 = bright steel,
0.6 = nylon). `combNeg` instead of `comb` gives a hollow, clarinet-like tube an octave lower.

## Acid line

One saw into the diode ladder, a fast envelope on the cutoff, accents by velocity. Write overlapping notes for slides:

```json
{ "oscillators": [{ "id": "A", "table": "basic", "position": 0.5, "level": 0.8, "phaseRandom": 0 }],
  "filters": [{ "id": 1, "type": "acid", "cutoff": 420, "resonance": 0.82, "drive": 0.4, "keyTrack": 0.3 }],
  "envelopes": [{ "id": 1, "attack": 0.002, "decay": 0.3, "sustain": 0.7, "release": 0.08 }, { "id": 2, "attack": 0.001, "decay": 0.19, "sustain": 0, "release": 0.12, "decayCurve": -0.62 }],
  "modulation": [{ "source": "env2", "target": "f1Cutoff", "amount": 0.32 }, { "source": "env2", "target": "f1Cutoff", "amount": 0.22, "via": "velocity" }, { "source": "timbre", "target": "f1Res", "amount": 0.15 }],
  "voice": { "mono": true, "legato": true, "glide": 0.07, "gain": 0.65 },
  "effects": { "drive": { "amount": 0.25 } } }
```

The acid filter sounds darker than its cutoff (its corner sits well below the resonance), so 300–600 Hz is the
working range. Automate `macro` → `f1Cutoff` over the song for the classic slow opening.

## Ladder bass

```json
{ "oscillators": [{ "id": "A", "table": "basic", "position": 0.5, "level": 0.75, "phaseRandom": 0 }, { "id": "B", "table": "pwm", "position": 0.3, "level": 0.5, "fine": 7, "phaseRandom": 0 }],
  "sub": { "level": 0.3, "to": "direct" },
  "filters": [{ "id": 1, "type": "ladder24", "cutoff": 300, "resonance": 0.45, "drive": 0.35, "keyTrack": 0.4 }],
  "envelopes": [{ "id": 1, "attack": 0.003, "decay": 0.5, "sustain": 0.75, "release": 0.1 }, { "id": 2, "attack": 0.001, "decay": 0.22, "sustain": 0.12, "release": 0.15 }],
  "modulation": [{ "source": "env2", "target": "f1Cutoff", "amount": 0.4 }, { "source": "velocity", "target": "f1Cutoff", "amount": 0.14 }, { "source": "pressure", "target": "f1Cutoff", "amount": 0.25 }],
  "voice": { "mono": true, "glide": 0.02, "gain": 0.9 } }
```

Swap `ladder24` for `ms20Lp` (resonance 0.6) and the same patch snarls instead of singing.

## Talking vowels

A bright source through the formant filter; slide (or an LFO) walks A-E-I-O-U:

```json
{ "oscillators": [{ "id": "A", "table": "basic", "position": 0.5, "level": 0.8, "unison": 2, "detune": 9 }],
  "filters": [{ "id": 1, "type": "formant", "cutoff": 1000, "resonance": 0.3, "keyTrack": 0, "morph": 0 }],
  "envelopes": [{ "id": 1, "attack": 0.05, "decay": 0.4, "sustain": 0.9, "release": 0.3 }],
  "lfos": [{ "id": 1, "shape": "sine", "rate": 5.3, "fade": 0.4 }],
  "modulation": [{ "source": "timbre", "target": "f1Morph", "amount": 1 }, { "source": "pressure", "target": "f1Res", "amount": 0.25 }, { "source": "lfo1", "target": "pitchFine", "amount": 0.3, "via": "pressure" }],
  "voice": { "mono": true, "legato": true, "glide": 0.08, "gain": 1.3 },
  "effects": { "reverb": { "mix": 0.3, "size": 0.65 } } }
```

Then `set_note_expression` a slide ramp on each note (0 → 0.5 says "ah-ee", 0.75 → 1 "oh-oo"). Cutoff 700 makes the
voice bigger and darker, 1400 smaller.
