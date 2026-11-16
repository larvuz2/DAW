// The GGS Synth preset library: 30 original patches in six families. Every preset is a set of overrides on the init
// patch, and every one answers to the performance: pressure and slide (timbre) are routed in the matrix, and the
// four macros are assigned to the moves a player (or an agent) would reach for first — see GGS_PRESET_INFO.
// The output gains were levelled by measurement (scripts/level-presets.mjs): a single note at velocity 0.8 lands
// around -18 LUFS, so swapping presets doesn't upset a mix.

/** Expand [[source, target, amount, via?], …] into the flat mod1…modN params. */
function mods(list) {
  const out = {};
  list.forEach(([src, dst, amt, via], i) => {
    const n = i + 1;
    out[`mod${n}Src`] = src;
    out[`mod${n}Dst`] = dst;
    out[`mod${n}Amt`] = amt;
    if (via) out[`mod${n}Via`] = via;
  });
  return out;
}

const env = (i, a, d, s, r, curve) => ({ [`env${i}A`]: a, [`env${i}D`]: d, [`env${i}S`]: s, [`env${i}R`]: r, ...(curve !== undefined ? { [`env${i}Curve`]: curve } : {}) });
const lfo = (i, shape, rate, o = {}) => ({
  [`lfo${i}Shape`]: shape,
  ...(typeof rate === 'string' ? { [`lfo${i}Sync`]: rate } : { [`lfo${i}Rate`]: rate }),
  ...(o.free ? { [`lfo${i}Trig`]: 'free' } : {}),
  ...(o.fade ? { [`lfo${i}Fade`]: o.fade } : {}),
  ...(o.phase ? { [`lfo${i}Phase`]: o.phase } : {})
});
const osc = (x, o) => Object.fromEntries(Object.entries({ On: true, ...o }).map(([k, v]) => [`osc${x}${k}`, v]));

const P = {};
const INFO = {};
function preset(name, category, description, macros, expression, params, test = {}) {
  P[name] = params;
  INFO[name] = { category, description, macros, expression, test };
}

// ------------------------------------------------------------------------------------------------------- pads

preset('Velvet Pad', 'pad', 'Warm analog-style pad: a soft detuned stack over a slow filter swell.',
  ['Brightness', 'Movement', 'Octave shimmer', 'Width'],
  'Pressure opens the filter; slide moves the oscillators from dark to bright.', {
    ...osc('A', { Table: 'tilt', Pos: 0.38, Level: 0.7, Unison: 5, Detune: 22, Spread: 0.9 }),
    ...osc('B', { Table: 'tilt', Pos: 0.3, Level: 0, Oct: 1, Unison: 3, Detune: 16, Spread: 1 }),
    subLevel: 0.22,
    f1Type: 'lp24', f1Cutoff: 850, f1Res: 0.12, f1Key: 0.3,
    ...env(1, 0.55, 2, 0.85, 1.8), ...env(2, 1.4, 3, 0.5, 2),
    ...lfo(1, 'sine', 0.13, { free: true }), ...lfo(2, 'triangle', 0.21, { free: true, phase: 0.3 }),
    ...mods([
      ['env2', 'f1Cutoff', 0.16], ['pressure', 'f1Cutoff', 0.24], ['timbre', 'oscAPos', 0.4], ['lfo1', 'oscAPos', 0.06],
      ['macro1', 'f1Cutoff', 0.35], ['lfo2', 'f1Cutoff', 0.12, 'macro2'], ['macro3', 'oscBLevel', 0.5], ['macro4', 'oscADetune', 0.25],
      ['velocity', 'f1Cutoff', 0.08]
    ]),
    chorusMix: 0.45, chorusRate: 0.35, reverbMix: 0.34, reverbSize: 0.72, gain: 0.54
  }, { chord: true });

preset('Glass Horizon', 'pad', 'Evolving spectral pad: glassy partials that never sit still.',
  ['Shimmer', 'Air', 'Motion speed', 'Darkness'],
  'Pressure scans the glass table; slide opens the filter.', {
    ...osc('A', { Table: 'glass', Pos: 0.2, Level: 0.75, Unison: 3, Detune: 9, Spread: 0.85 }),
    ...osc('B', { Table: 'airy', Pos: 0.5, Level: 0.4, Unison: 2, Detune: 12, Spread: 1 }),
    f1Type: 'lp12', f1Cutoff: 5200, f1Res: 0.08, f1Key: 0.4,
    ...env(1, 1.2, 2.5, 0.9, 3), ...lfo(1, 'sine', 0.07, { free: true }), ...lfo(2, 'smooth', 0.19, { free: true }),
    ...mods([
      ['lfo1', 'oscAPos', 0.3], ['lfo2', 'oscBPos', 0.35], ['pressure', 'oscAPos', 0.4], ['timbre', 'f1Cutoff', 0.22],
      ['macro1', 'oscAPos', 0.5], ['macro2', 'oscBLevel', 0.5], ['macro3', 'lfo1Rate', 0.6], ['macro4', 'f1Cutoff', -0.3]
    ]),
    chorusMix: 0.3, delayMix: 0.18, delaySync: '1/4d', delayFb: 0.4, reverbMix: 0.5, reverbSize: 0.85, reverbDamp: 0.3, gain: 0.36
  }, { chord: true });

preset('Cinema Atmos', 'pad', 'Cinematic atmosphere: slow vowels, a moving comb and a breath of noise under a long hall.',
  ['Vowel', 'Breath', 'Filter', 'Drift'],
  'Pressure brings in the breath and brightness; slide morphs the vowel.', {
    ...osc('A', { Table: 'formant', Pos: 0.15, Level: 0.7, Unison: 4, Detune: 15, Spread: 0.9 }),
    ...osc('B', { Table: 'comb', Pos: 0.3, Level: 0.4, Oct: -1, Unison: 2, Detune: 10, Spread: 0.8 }),
    noiseLevel: 0.08, noiseType: 'pink', noiseDest: 'f2',
    f1Type: 'lp24', f1Cutoff: 1300, f1Res: 0.15, f1Key: 0.25,
    f2On: true, f2Type: 'bp12', f2Cutoff: 2600, f2Res: 0.25, filterRoute: 'parallel',
    ...env(1, 1.8, 3, 0.9, 4), ...env(2, 3, 4, 0.6, 4), ...lfo(1, 'sine', 0.05, { free: true }), ...lfo(2, 'smooth', 0.09, { free: true }),
    ...mods([
      ['lfo1', 'oscAPos', 0.3], ['lfo2', 'oscBPos', 0.4], ['env2', 'f1Cutoff', 0.15], ['pressure', 'noiseLevel', 0.3], ['pressure', 'f1Cutoff', 0.18],
      ['timbre', 'oscAPos', 0.6], ['macro1', 'oscAPos', 0.7], ['macro2', 'noiseLevel', 0.4], ['macro3', 'f1Cutoff', 0.35], ['macro4', 'oscADetune', 0.3]
    ]),
    chorusMix: 0.25, reverbMix: 0.6, reverbSize: 0.95, reverbDamp: 0.35, gain: 0.61
  }, { chord: true });

preset('Choir of Air', 'pad', 'Breathy synthetic choir with a slow, human vibrato.',
  ['Vowel shift', 'Vibrato', 'Brightness', 'Ensemble'],
  'Pressure swells the choir; slide shifts its vowel.', {
    ...osc('A', { Table: 'airy', Pos: 0.3, Level: 0.75, Unison: 6, Detune: 14, Spread: 1 }),
    ...osc('B', { Table: 'formant', Pos: 0.0, Level: 0.3, Oct: 1, Unison: 2, Detune: 8, Spread: 0.7 }),
    f1Type: 'lp12', f1Cutoff: 3800, f1Res: 0.05, f1Key: 0.3,
    f2On: true, f2Type: 'hp12', f2Cutoff: 180, f2Res: 0,
    level: 0.7,
    ...env(1, 0.45, 1.5, 0.9, 1.6), ...lfo(1, 'sine', 5.1, { fade: 0.9 }), ...lfo(2, 'sine', 0.1, { free: true }),
    ...mods([
      ['lfo1', 'pitchFine', 0.07], ['lfo1', 'pitchFine', 0.12, 'macro2'], ['lfo2', 'oscAPos', 0.2], ['pressure', 'level', 0.3], ['pressure', 'f1Cutoff', 0.15],
      ['timbre', 'oscAPos', 0.5], ['timbre', 'oscBPos', 0.8], ['macro1', 'oscBPos', 0.9], ['macro3', 'f1Cutoff', 0.3], ['macro4', 'oscADetune', 0.25]
    ]),
    chorusMix: 0.35, reverbMix: 0.45, reverbSize: 0.8, gain: 0.6
  }, { chord: true });

preset('Solar Drift', 'pad', 'Bright pulse-width pad, wide and slowly breathing.',
  ['PWM depth', 'Brightness', 'Sub', 'Width'],
  'Pressure brightens; slide narrows the pulse.', {
    ...osc('A', { Table: 'pwm', Pos: 0.25, Level: 0.7, Unison: 4, Detune: 18, Spread: 0.9 }),
    ...osc('B', { Table: 'pwm', Pos: 0.5, Level: 0.4, Oct: -1, Unison: 2, Detune: 10 }),
    f1Type: 'lp12', f1Cutoff: 3200, f1Res: 0.1, f1Key: 0.35,
    ...env(1, 0.35, 1.5, 0.85, 1.4), ...lfo(1, 'triangle', 0.31, { free: true }), ...lfo(2, 'sine', 0.23, { free: true, phase: 0.5 }),
    ...mods([
      ['lfo1', 'oscAPos', 0.22], ['lfo2', 'oscBPos', 0.2], ['pressure', 'f1Cutoff', 0.22], ['timbre', 'oscAPos', 0.45],
      ['macro1', 'oscAPos', 0.3, 'lfo1'], ['macro2', 'f1Cutoff', 0.35], ['macro3', 'subLevel', 0.6], ['velocity', 'f1Cutoff', 0.1], ['macro4', 'oscADetune', 0.3]
    ]),
    chorusMix: 0.6, chorusRate: 0.5, chorusDepth: 0.6, reverbMix: 0.3, reverbSize: 0.65, gain: 0.45
  }, { chord: true });

// ------------------------------------------------------------------------------------------------------ leads

preset('Touch Lead', 'lead', 'Expressive lead built for per-note control: every dimension of a touch does something musical.',
  ['Brightness', 'Vibrato', 'Bite', 'Air'],
  'Pressure opens the filter, swells the level and deepens the vibrato; slide scans the wavetable; pitch curves bend each note alone.', {
    ...osc('A', { Table: 'tilt', Pos: 0.5, Level: 0.75, Unison: 2, Detune: 7, Spread: 0.5 }),
    ...osc('B', { Table: 'basic', Pos: 0.75, Level: 0.25, Fine: 4 }),
    f1Type: 'lp24', f1Cutoff: 1500, f1Res: 0.22, f1Key: 0.6,
    level: 0.6, glide: 0.04,
    ...env(1, 0.012, 0.4, 0.85, 0.28), ...env(2, 0.004, 0.35, 0.3, 0.3), ...lfo(1, 'sine', 5.6, { fade: 0.25 }),
    ...mods([
      ['pressure', 'f1Cutoff', 0.3], ['pressure', 'level', 0.45], ['lfo1', 'pitchFine', 0.3, 'pressure'], ['timbre', 'oscAPos', 0.45], ['timbre', 'oscBLevel', 0.3],
      ['env2', 'f1Cutoff', 0.14], ['velocity', 'f1Cutoff', 0.14], ['macro1', 'f1Cutoff', 0.35], ['lfo1', 'pitchFine', 0.3, 'macro2'], ['macro3', 'f1Drive', 0.7],
      ['macro4', 'noiseLevel', 0.3], ['bend', 'f1Cutoff', 0.05]
    ]),
    delayMix: 0.2, delaySync: '1/8d', delayFb: 0.3, reverbMix: 0.2, reverbSize: 0.55, gain: 0.85
  });

preset('Crystal Lead', 'lead', 'Crystalline digital lead: bell-like FM over glass partials.',
  ['FM bite', 'Shimmer', 'Vibrato', 'Brightness'],
  'Pressure adds FM bite; slide scans the bell table.', {
    ...osc('A', { Table: 'fmbell', Pos: 0.22, Level: 0.75, FmFrom: 'B', Fm: 0.15 }),
    ...osc('B', { Table: 'glass', Pos: 0.3, Level: 0.3, Oct: 1, Unison: 2, Detune: 6, Spread: 0.8 }),
    f1Type: 'hp12', f1Cutoff: 140, f1Res: 0,
    ...env(1, 0.004, 1.2, 0.55, 0.6), ...env(2, 0.002, 0.5, 0.15, 0.5),
    ...lfo(1, 'sine', 5.2, { fade: 0.4 }),
    ...mods([
      ['env2', 'oscAPos', 0.25], ['pressure', 'oscAFm', 0.3], ['timbre', 'oscAPos', 0.5], ['velocity', 'oscAPos', 0.15], ['lfo1', 'pitchFine', 0.12, 'pressure'],
      ['macro1', 'oscAFm', 0.4], ['macro2', 'oscBLevel', 0.5], ['macro4', 'oscAPos', 0.4], ['lfo1', 'pitchFine', 0.3, 'macro3']
    ]),
    delayMix: 0.28, delaySync: '1/8d', delayFb: 0.42, reverbMix: 0.3, reverbSize: 0.7, gain: 0.57
  });

preset('Mono Titan', 'lead', 'Cinematic mono lead: thick, driven, gliding between overlapping notes.',
  ['Filter', 'Drive', 'Vibrato', 'Sub'],
  'Pressure opens the filter; slide adds drive.', {
    ...osc('A', { Table: 'basic', Pos: 0.5, Level: 0.7, Unison: 3, Detune: 14, Spread: 0.6 }),
    ...osc('B', { Table: 'basic', Pos: 0.75, Level: 0.45, Oct: -1 }),
    subLevel: 0.35, subDest: 'f1',
    f1Type: 'lp24', f1Cutoff: 800, f1Res: 0.3, f1Drive: 0.3, f1Key: 0.5,
    mono: true, legato: true, glide: 0.09,
    ...env(1, 0.006, 0.5, 0.85, 0.22), ...env(2, 0.004, 0.5, 0.3, 0.3), ...lfo(1, 'sine', 5.2, { fade: 0.45 }),
    ...mods([
      ['env2', 'f1Cutoff', 0.32], ['pressure', 'f1Cutoff', 0.28], ['timbre', 'f1Drive', 0.6], ['lfo1', 'pitchFine', 0.14], ['velocity', 'f1Cutoff', 0.12],
      ['macro1', 'f1Cutoff', 0.4], ['macro2', 'f1Drive', 0.6], ['lfo1', 'pitchFine', 0.3, 'macro3'], ['macro4', 'subLevel', 0.5]
    ]),
    driveAmt: 0.22, driveType: 'tube', delayMix: 0.18, delaySync: '1/4', delayFb: 0.3, reverbMix: 0.22, reverbSize: 0.6, gain: 0.34
  });

preset('Sync Razor', 'lead', 'Tearing hard-sync lead: the classic sweep, here on the slide dimension.',
  ['Sync sweep', 'Filter', 'Drive', 'Vibrato'],
  'Slide sweeps the sync; pressure opens the filter and adds vibrato.', {
    ...osc('A', { Table: 'sync', Pos: 0.25, Level: 0.8 }),
    ...osc('B', { Table: 'basic', Pos: 0.5, Level: 0.25, Oct: -1 }),
    f1Type: 'lp12', f1Cutoff: 5200, f1Res: 0.15, f1Key: 0.4,
    mono: true, legato: true, glide: 0.05,
    ...env(1, 0.004, 0.4, 0.85, 0.18), ...env(2, 0.004, 0.45, 0.25, 0.3), ...lfo(1, 'sine', 5.8, { fade: 0.3 }),
    ...mods([
      ['env2', 'oscAPos', 0.35], ['timbre', 'oscAPos', 0.6], ['pressure', 'f1Cutoff', 0.2], ['lfo1', 'pitchFine', 0.25, 'pressure'],
      ['macro1', 'oscAPos', 0.6], ['macro2', 'f1Cutoff', -0.4], ['lfo1', 'pitchFine', 0.3, 'macro4'], ['velocity', 'oscAPos', 0.15], ['macro3', 'f1Drive', 0.7]
    ]),
    driveAmt: 0.18, delayMix: 0.22, delaySync: '1/8d', delayFb: 0.35, reverbMix: 0.15, gain: 0.43
  });

preset('Overtone Flute', 'lead', 'A breathy flute that overblows up its harmonic ladder as you press.',
  ['Overblow', 'Breath', 'Vibrato', 'Air tone'],
  'Pressure overblows to higher harmonics and adds breath; slide brightens the air.', {
    ...osc('A', { Table: 'ladder', Pos: 0, Level: 0.8 }),
    ...osc('B', { Table: 'supersine', Pos: 0.2, Level: 0.3 }),
    noiseLevel: 0.07, noiseType: 'white', noiseDest: 'f2',
    f1Type: 'lp12', f1Cutoff: 4200, f1Res: 0, f1Key: 0.5,
    f2On: true, f2Type: 'bp12', f2Cutoff: 2400, f2Res: 0.3, f2Key: 0.6, filterRoute: 'parallel',
    level: 0.65,
    ...env(1, 0.06, 0.3, 0.9, 0.2), ...env(2, 0.003, 0.09, 0, 0.1), ...lfo(1, 'sine', 5, { fade: 0.5 }),
    ...mods([
      ['pressure', 'oscAPos', 0.22], ['pressure', 'noiseLevel', 0.2], ['pressure', 'level', 0.4], ['env2', 'noiseLevel', 0.25], ['lfo1', 'pitchFine', 0.1],
      ['timbre', 'f2Cutoff', 0.15], ['macro1', 'oscAPos', 0.4], ['macro2', 'noiseLevel', 0.4], ['lfo1', 'pitchFine', 0.25, 'macro3'], ['macro4', 'f2Cutoff', 0.2]
    ]),
    reverbMix: 0.35, reverbSize: 0.65, gain: 0.58
  });

// ------------------------------------------------------------------------------------------------------- bass

preset('Deep Sub', 'bass', 'Clean, deep sub bass with just enough harmonics to be heard on small speakers.',
  ['Harmonics', 'Punch', 'Open', 'Drive'],
  'Pressure adds harmonics; slide opens the filter.', {
    ...osc('A', { Table: 'supersine', Pos: 0.12, Level: 0.8, Rand: 0 }),
    subLevel: 0.55, subOct: 0, subDest: 'direct',
    f1Type: 'lp24', f1Cutoff: 320, f1Res: 0.05, f1Key: 0.6,
    mono: true, legato: true, glide: 0.03,
    ...env(1, 0.004, 0.4, 0.9, 0.12), ...env(2, 0.001, 0.12, 0, 0.1),
    ...mods([
      ['pressure', 'oscAPos', 0.4], ['timbre', 'f1Cutoff', 0.25], ['velocity', 'f1Cutoff', 0.12], ['macro1', 'oscAPos', 0.6],
      ['env2', 'pitch', 0.15, 'macro2'], ['macro3', 'f1Cutoff', 0.3], ['macro4', 'f1Drive', 0.8]
    ]),
    gain: 0.46
  }, { key: 36 });

preset('Analog Bass', 'bass', 'Textured analog bass: saw and pulse into a driven low-pass with a snappy envelope.',
  ['Cutoff', 'Envelope', 'Resonance', 'Drive'],
  'Pressure opens the filter; slide adds resonance.', {
    ...osc('A', { Table: 'basic', Pos: 0.5, Level: 0.75, Rand: 0 }),
    ...osc('B', { Table: 'pwm', Pos: 0.3, Level: 0.5, Fine: 7, Rand: 0 }),
    subLevel: 0.3, subDest: 'direct',
    f1Type: 'lp24', f1Cutoff: 210, f1Res: 0.32, f1Drive: 0.35, f1Key: 0.4,
    mono: true, glide: 0.02,
    ...env(1, 0.003, 0.5, 0.75, 0.1), ...env(2, 0.001, 0.22, 0.12, 0.15),
    ...mods([
      ['env2', 'f1Cutoff', 0.4], ['velocity', 'f1Cutoff', 0.14], ['pressure', 'f1Cutoff', 0.25], ['timbre', 'f1Res', 0.4],
      ['macro1', 'f1Cutoff', 0.4], ['env2', 'f1Cutoff', 0.3, 'macro2'], ['macro3', 'f1Res', 0.5], ['macro4', 'f1Drive', 0.6]
    ]),
    gain: 0.56
  }, { key: 36 });

preset('Neuro Bass', 'bass', 'Aggressive FM bass that growls and talks in time with the song.',
  ['Growl', 'Wobble depth', 'Filter', 'Dirt'],
  'Pressure pushes the FM; slide scans the growl table.', {
    ...osc('A', { Table: 'fmgrowl', Pos: 0.3, Level: 0.8, FmFrom: 'B', Fm: 0.38, Rand: 0 }),
    ...osc('B', { Table: 'basic', Pos: 0, Level: 0, Rand: 0 }),
    subLevel: 0.4, subDest: 'direct',
    f1Type: 'lp24', f1Cutoff: 1600, f1Res: 0.35, f1Drive: 0.5, f1Key: 0.3,
    f2On: true, f2Type: 'notch', f2Cutoff: 900, f2Res: 0.5,
    mono: true, legato: true, glide: 0.04,
    ...env(1, 0.003, 0.3, 0.9, 0.1), ...lfo(1, 'sine', '1/8', { free: true }), ...lfo(2, 'triangle', '1/4d', { free: true }),
    ...mods([
      ['lfo1', 'oscAPos', 0.35], ['lfo2', 'f2Cutoff', 0.22], ['lfo1', 'oscAFm', 0.25], ['pressure', 'oscAFm', 0.3], ['timbre', 'oscAPos', 0.5],
      ['macro1', 'oscAFm', 0.4], ['lfo1', 'f1Cutoff', 0.3, 'macro2'], ['macro3', 'f1Cutoff', 0.3], ['macro4', 'f1Drive', 0.5]
    ]),
    driveAmt: 0.35, driveType: 'hard', gain: 0.37
  }, { key: 36 });

preset('Reese Engine', 'bass', 'Detuned saws beating against each other: the rolling Reese.',
  ['Detune', 'Filter', 'Movement', 'Drive'],
  'Pressure opens the filter; slide widens the detune.', {
    ...osc('A', { Table: 'basic', Pos: 0.5, Level: 0.7, Unison: 2, Detune: 26, Blend: 1, Spread: 0.5 }),
    ...osc('B', { Table: 'basic', Pos: 0.5, Level: 0.6, Fine: -12, Unison: 2, Detune: 18, Blend: 1, Spread: 0.4 }),
    subLevel: 0.3, subDest: 'direct',
    f1Type: 'lp24', f1Cutoff: 650, f1Res: 0.2, f1Drive: 0.2, f1Key: 0.3,
    mono: true, legato: true, glide: 0.06,
    ...env(1, 0.01, 0.4, 0.9, 0.18), ...lfo(1, 'sine', 0.25, { free: true }),
    ...mods([
      ['lfo1', 'f1Cutoff', 0.08], ['pressure', 'f1Cutoff', 0.28], ['timbre', 'oscADetune', 0.3], ['macro1', 'oscADetune', 0.35],
      ['macro2', 'f1Cutoff', 0.4], ['lfo1', 'f1Cutoff', 0.2, 'macro3'], ['macro4', 'f1Drive', 0.6]
    ]),
    driveAmt: 0.18, driveType: 'tube', gain: 0.47
  }, { key: 36 });

preset('Acid Line', 'bass', 'Squelchy resonant bass line: slides on overlapping notes, accents with velocity.',
  ['Cutoff', 'Envelope', 'Resonance', 'Bite'],
  'Pressure opens the filter; slide raises the resonance.', {
    ...osc('A', { Table: 'basic', Pos: 0.5, Level: 0.8, Rand: 0 }),
    f1Type: 'lp24', f1Cutoff: 280, f1Res: 0.8, f1Drive: 0.4, f1Key: 0.3,
    mono: true, legato: true, glide: 0.07,
    ...env(1, 0.002, 0.3, 0.7, 0.08), ...env(2, 0.001, 0.19, 0, 0.12, 0.3),
    ...mods([
      ['env2', 'f1Cutoff', 0.32], ['env2', 'f1Cutoff', 0.22, 'velocity'], ['pressure', 'f1Cutoff', 0.25], ['timbre', 'f1Res', 0.2],
      ['macro1', 'f1Cutoff', 0.4], ['env2', 'f1Cutoff', 0.3, 'macro2'], ['macro3', 'f1Res', 0.2], ['macro4', 'oscAPos', 0.25]
    ]),
    driveAmt: 0.28, delayMix: 0.14, delaySync: '1/8d', delayFb: 0.3, gain: 0.35
  }, { key: 36 });

// ------------------------------------------------------------------------------------------------------- keys

preset('Glass Keys', 'keys', 'Glass-like keys: a bright strike that melts into a soft, clear tone.',
  ['Strike', 'Body', 'Sparkle', 'Brightness'],
  'Velocity is the strike; pressure after the hit brings the sparkle back; slide scans the glass.', {
    ...osc('A', { Table: 'glass', Pos: 0.25, Level: 0.8 }),
    ...osc('B', { Table: 'fmbell', Pos: 0.1, Level: 0.22, Oct: 1 }),
    f1Type: 'lp12', f1Cutoff: 4500, f1Res: 0.05, f1Key: 0.5,
    ...env(1, 0.002, 2.4, 0, 0.9), ...env(2, 0.001, 0.45, 0, 0.4),
    ...mods([
      ['env2', 'oscAPos', 0.25], ['velocity', 'oscAPos', 0.2], ['velocity', 'f1Cutoff', 0.14], ['pressure', 'oscBLevel', 0.4], ['timbre', 'oscAPos', 0.4],
      ['macro1', 'oscAPos', 0.3, 'env2'], ['macro2', 'subLevel', 0.5], ['macro3', 'oscBLevel', 0.5], ['macro4', 'f1Cutoff', 0.3]
    ]),
    chorusMix: 0.22, reverbMix: 0.3, reverbSize: 0.7, gain: 0.62
  });

preset('Tine Electric', 'keys', 'Electric piano: round at soft touch, barking when played hard, with a bell on the attack.',
  ['Bark', 'Bell', 'Tremolo', 'Brightness'],
  'Velocity sets the bark; pressure adds bell; slide brightens.', {
    ...osc('A', { Table: 'tine', Pos: 0.15, Level: 0.8, Rand: 0 }),
    ...osc('B', { Table: 'supersine', Pos: 0.25, Level: 0.35, Rand: 0 }),
    f1Type: 'lp12', f1Cutoff: 3600, f1Res: 0, f1Key: 0.5,
    ...env(1, 0.002, 3.2, 0, 0.3), ...env(2, 0.001, 0.3, 0, 0.3), ...lfo(1, 'sine', 4.8, { free: true }),
    ...mods([
      ['velocity', 'oscAPos', 0.45], ['env2', 'oscAPos', 0.3], ['velocity', 'f1Cutoff', 0.15], ['pressure', 'oscAPos', 0.3], ['timbre', 'f1Cutoff', 0.2],
      ['macro1', 'oscAPos', 0.35], ['macro2', 'oscAPos', 0.4, 'env2'], ['lfo1', 'pan', 0.6, 'macro3'], ['macro4', 'f1Cutoff', 0.3]
    ]),
    chorusMix: 0.18, reverbMix: 0.18, reverbSize: 0.5, gain: 0.57
  });

preset('Pluck Garden', 'keys', 'Plucked string from a modelled resonator: a burst of noise into a comb tuned to the note.',
  ['Pick position', 'Sustain', 'Body', 'Brightness'],
  'Velocity is how hard the string is picked; pressure lets it ring longer; slide brightens the pick.', {
    ...osc('A', { Table: 'basic', Pos: 0.5, Level: 0, Rand: 0.6 }),
    noiseLevel: 0, noiseType: 'white', noiseColor: -0.25,
    f1Type: 'comb', f1Cutoff: 261.63, f1Res: 0.9, f1Key: 1,
    f2On: true, f2Type: 'lp12', f2Cutoff: 5200, f2Res: 0, f2Key: 0.4,
    ...env(1, 0.001, 3, 0, 0.5), ...env(2, 0.001, 0.045, 0, 0.04),
    ...mods([
      ['env2', 'noiseLevel', 0.9], ['env2', 'oscALevel', 0.6], ['velocity', 'f2Cutoff', 0.16], ['pressure', 'f1Res', 0.08], ['timbre', 'f2Cutoff', 0.2],
      ['macro1', 'oscAPos', 0.4], ['macro2', 'f1Res', 0.09], ['macro3', 'subLevel', 0.4, 'env1'], ['macro4', 'f2Cutoff', 0.25]
    ]),
    delayMix: 0.15, delaySync: '1/8d', delayFb: 0.3, reverbMix: 0.25, reverbSize: 0.6, gain: 1.55
  });

preset('Dream EP', 'keys', 'Evolving harmonic keys: a soft tone whose overtones bloom after each note.',
  ['Bloom', 'Organ layer', 'Motion', 'Warmth'],
  'Pressure blooms the overtones; slide brings in the organ layer.', {
    ...osc('A', { Table: 'supersine', Pos: 0.2, Level: 0.8 }),
    ...osc('B', { Table: 'drawbar', Pos: 0.4, Level: 0.2, Oct: 1, Unison: 2, Detune: 6, Spread: 0.8 }),
    f1Type: 'lp12', f1Cutoff: 3000, f1Res: 0, f1Key: 0.5,
    ...env(1, 0.004, 2.8, 0.25, 0.8), ...env(2, 0.5, 1.5, 0.4, 0.8), ...lfo(1, 'sine', 0.3, { free: true }),
    ...mods([
      ['env2', 'oscAPos', 0.35], ['pressure', 'oscAPos', 0.35], ['timbre', 'oscBLevel', 0.5], ['lfo1', 'oscBPos', 0.2], ['velocity', 'f1Cutoff', 0.15],
      ['macro1', 'oscAPos', 0.4], ['macro2', 'oscBLevel', 0.5], ['lfo1', 'oscAPos', 0.2, 'macro3'], ['macro4', 'f1Cutoff', -0.25]
    ]),
    chorusMix: 0.45, delayMix: 0.16, delaySync: '1/4', delayFb: 0.3, reverbMix: 0.32, reverbSize: 0.7, gain: 0.93
  });

preset('Hollow Mallet', 'keys', 'Wooden mallet: a hollow bar tone with a knock on the attack.',
  ['Hardness', 'Metal', 'Tone', 'Resonance'],
  'Velocity sets the mallet hardness; pressure adds a metallic ring; slide brightens.', {
    ...osc('A', { Table: 'hollow', Pos: 0.15, Level: 0.8, Rand: 0 }),
    ...osc('B', { Table: 'metal', Pos: 0.2, Level: 0, Oct: 1, Rand: 0 }),
    f1Type: 'lp12', f1Cutoff: 2600, f1Res: 0.1, f1Key: 0.7,
    ...env(1, 0.001, 1.1, 0, 0.5, 0.3), ...env(2, 0.001, 0.06, 0, 0.05), ...env(3, 0.001, 0.5, 0, 0.4),
    ...mods([
      ['env2', 'pitch', 0.08], ['env2', 'f1Cutoff', 0.25], ['velocity', 'f1Cutoff', 0.2], ['env3', 'oscBLevel', 0.25], ['pressure', 'oscBLevel', 0.4],
      ['timbre', 'f1Cutoff', 0.2], ['macro1', 'f1Cutoff', 0.3, 'env2'], ['macro2', 'oscBLevel', 0.5, 'env3'], ['macro3', 'oscAPos', 0.6], ['macro4', 'f1Res', 0.5]
    ]),
    reverbMix: 0.28, reverbSize: 0.6, gain: 1.05
  });

// -------------------------------------------------------------------------------------------------- sequences

preset('Arp Prism', 'sequence', 'Rhythmic wavetable pluck whose colour evolves over two bars — made for arpeggios.',
  ['Sweep depth', 'Octave', 'Evolution', 'Brightness'],
  'Slide scans the resonance; pressure lengthens and brightens the notes.', {
    ...osc('A', { Table: 'resonant', Pos: 0.12, Level: 0.8, Rand: 0.3 }),
    ...osc('B', { Table: 'basic', Pos: 0.75, Level: 0.25, Oct: 1, Fine: 5 }),
    f1Type: 'lp12', f1Cutoff: 3800, f1Res: 0.1, f1Key: 0.5,
    ...env(1, 0.002, 0.35, 0.12, 0.25), ...env(2, 0.001, 0.25, 0, 0.2), ...lfo(1, 'triangle', '2bar', { free: true }),
    ...mods([
      ['env2', 'oscAPos', 0.4], ['lfo1', 'oscAPos', 0.22], ['velocity', 'oscAPos', 0.15], ['timbre', 'oscAPos', 0.4], ['pressure', 'f1Cutoff', 0.2],
      ['macro1', 'oscAPos', 0.3, 'env2'], ['macro3', 'oscAPos', 0.3, 'lfo1'], ['macro4', 'f1Cutoff', 0.3], ['macro2', 'oscBLevel', 0.5]
    ]),
    delayMix: 0.32, delaySync: '1/8d', delayFb: 0.45, reverbMix: 0.22, reverbSize: 0.6, gain: 0.69
  });

preset('Pulse Runner', 'sequence', 'Tight pulse sequence sound with a filter that snaps on every note.',
  ['Snap', 'Pulse width', 'Resonance', 'Octave'],
  'Pressure opens the filter; slide moves the pulse width.', {
    ...osc('A', { Table: 'pwm', Pos: 0.35, Level: 0.75, Rand: 0.2 }),
    ...osc('B', { Table: 'basic', Pos: 0.75, Level: 0.4, Oct: -1, Rand: 0.2 }),
    f1Type: 'lp24', f1Cutoff: 900, f1Res: 0.35, f1Key: 0.5,
    ...env(1, 0.002, 0.22, 0.2, 0.12), ...env(2, 0.001, 0.14, 0, 0.12), ...lfo(1, 'triangle', '1bar', { free: true }),
    ...mods([
      ['env2', 'f1Cutoff', 0.32], ['lfo1', 'oscAPos', 0.25], ['velocity', 'f1Cutoff', 0.14], ['pressure', 'f1Cutoff', 0.22], ['timbre', 'oscAPos', 0.4],
      ['macro1', 'f1Cutoff', 0.3, 'env2'], ['macro2', 'oscAPos', 0.4], ['macro3', 'f1Res', 0.4], ['macro4', 'oscBLevel', -0.4]
    ]),
    delayMix: 0.24, delaySync: '1/16d', delayFb: 0.4, reverbMix: 0.12, gain: 0.94
  });

preset('Poly Rhythm', 'sequence', 'Hold a chord and it plays itself: three clocks (triplets, sixteenths, dotted) cross inside every note.',
  ['Gate depth', 'Filter rhythm', 'Scan rhythm', 'Brightness'],
  'Pressure deepens the rhythm; slide brightens.', {
    ...osc('A', { Table: 'comb', Pos: 0.3, Level: 0.75, Unison: 2, Detune: 10, Spread: 0.8 }),
    ...osc('B', { Table: 'octaves', Pos: 0.4, Level: 0.35, Oct: 1 }),
    f1Type: 'lp24', f1Cutoff: 700, f1Res: 0.3, f1Key: 0.4,
    ...env(1, 0.01, 0.5, 0.9, 0.3),
    ...lfo(1, 'saw', '1/8t', { free: true }), ...lfo(2, 'saw', '1/16', { free: true }), ...lfo(3, 'triangle', '1/4d', { free: true }),
    ...mods([
      ['lfo1', 'f1Cutoff', 0.22], ['lfo2', 'level', 0.3], ['lfo3', 'oscAPos', 0.3], ['pressure', 'f1Cutoff', 0.2], ['timbre', 'f1Cutoff', 0.2],
      ['lfo2', 'level', 0.3, 'macro1'], ['lfo1', 'f1Cutoff', 0.2, 'macro2'], ['lfo3', 'oscBPos', 0.5, 'macro3'], ['macro4', 'f1Cutoff', 0.3]
    ]),
    level: 0.7, delayMix: 0.25, delaySync: '1/8d', delayFb: 0.4, reverbMix: 0.25, reverbSize: 0.65, gain: 0.53
  }, { chord: true });

preset('Bell Sequence', 'sequence', 'Crystalline FM arpeggio voice: glassy, short, with an attack that rings.',
  ['FM amount', 'Body', 'Ratio shimmer', 'Brightness'],
  'Velocity and pressure add FM; slide scans the octave stack.', {
    ...osc('A', { Table: 'octaves', Pos: 0.3, Level: 0.8, FmFrom: 'B', Fm: 0.3, Rand: 0 }),
    ...osc('B', { Table: 'basic', Pos: 0, Level: 0, Oct: 1, Semi: 7, Rand: 0 }),
    ...osc('C', { Table: 'glass', Pos: 0.5, Level: 0.15, Oct: 2, Rand: 0.5 }),
    f1Type: 'lp12', f1Cutoff: 9000, f1Res: 0, f1Key: 0.3,
    ...env(1, 0.001, 0.9, 0, 0.7), ...env(2, 0.001, 0.28, 0, 0.3), ...env(3, 0.001, 1.5, 0, 0.8),
    ...mods([
      ['env2', 'oscAFm', 0.32], ['velocity', 'oscAFm', 0.15], ['pressure', 'oscAFm', 0.25], ['timbre', 'oscAPos', 0.5], ['env3', 'oscCLevel', 0.2],
      ['macro1', 'oscAFm', 0.3], ['macro3', 'oscCLevel', 0.4, 'env3'], ['macro4', 'f1Cutoff', -0.35], ['macro2', 'subLevel', 0.5]
    ]),
    delayMix: 0.3, delaySync: '1/8d', delayFb: 0.5, delayTone: 4500, reverbMix: 0.3, reverbSize: 0.75, gain: 0.89
  });

preset('Chip Stepper', 'sequence', 'Generative chip-tune voice: the waveform steps to a new shape every sixteenth.',
  ['Step depth', 'Crush', 'Octave blip', 'Darkness'],
  'Slide crushes the wave; pressure deepens the stepping.', {
    ...osc('A', { Table: 'staircase', Pos: 0.5, Level: 0.7, Warp: 'quantize', WarpAmt: 0.2, Rand: 0 }),
    subLevel: 0.25, subWave: 'square', subDest: 'f1',
    f1Type: 'lp12', f1Cutoff: 6500, f1Res: 0, f1Key: 0.2,
    quality: 'eco',
    ...env(1, 0.001, 0.3, 0.35, 0.08), ...env(2, 0.001, 0.05, 0, 0.05), ...lfo(1, 'sh', '1/16', { free: true }),
    ...mods([
      ['lfo1', 'oscAPos', 0.35], ['timbre', 'oscAWarpAmt', 0.6], ['pressure', 'oscAPos', 0.3, 'lfo1'], ['macro1', 'oscAPos', 0.4, 'lfo1'],
      ['macro2', 'oscAWarpAmt', 0.6], ['env2', 'pitch', 0.5, 'macro3'], ['velocity', 'f1Cutoff', 0.1], ['macro4', 'f1Cutoff', -0.4]
    ]),
    delayMix: 0.18, delaySync: '1/16d', delayFb: 0.35, gain: 1.12
  });

// ----------------------------------------------------------------------------------------------- experimental

preset('Spectral Motion', 'experimental', 'Two digital spectra modulating each other under a wandering band-pass: constant, unrepeatable motion.',
  ['Chaos', 'Focus', 'Speed', 'Cross-mod'],
  'Pressure adds cross-modulation; slide moves the band-pass.', {
    ...osc('A', { Table: 'dust', Pos: 0.2, Level: 0.7, FmFrom: 'B', Fm: 0.12, Unison: 2, Detune: 8, Spread: 1 }),
    ...osc('B', { Table: 'primes', Pos: 0.4, Level: 0.45, Oct: -1 }),
    f1Type: 'bp12', f1Cutoff: 1400, f1Res: 0.3, f1Key: 0.3,
    f2On: true, f2Type: 'lp12', f2Cutoff: 7000, filterRoute: 'parallel', oscBDest: 'f2',
    ...env(1, 0.8, 2, 0.9, 3),
    ...lfo(1, 'smooth', 0.23, { free: true }), ...lfo(2, 'smooth', 0.37, { free: true }), ...lfo(3, 'sine', 0.08, { free: true }),
    ...mods([
      ['lfo1', 'oscAPos', 0.45], ['lfo2', 'oscBPos', 0.5], ['lfo3', 'f1Cutoff', 0.2], ['pressure', 'oscAFm', 0.3], ['timbre', 'f1Cutoff', 0.3],
      ['macro1', 'oscAFm', 0.3], ['macro2', 'f1Res', 0.5], ['macro3', 'lfo1Rate', 0.7], ['macro3', 'lfo2Rate', 0.7], ['macro4', 'oscAFm', 0.25, 'lfo2']
    ]),
    delayMix: 0.22, delaySync: '1/4d', delayFb: 0.5, reverbMix: 0.55, reverbSize: 0.9, gain: 0.61
  }, { chord: true });

preset('Metal Resonator', 'experimental', 'Struck metal ringing through a tuned comb: gongs, pipes and bowed steel.',
  ['Ring', 'Strike noise', 'Mode', 'Bow'],
  'Pressure bows the resonator (it keeps ringing); slide moves the energy up the modes.', {
    ...osc('A', { Table: 'metal', Pos: 0.25, Level: 0.6 }),
    noiseLevel: 0, noiseType: 'pink',
    f1Type: 'lp12', f1Cutoff: 5000, f1Key: 0.3,
    f2On: true, f2Type: 'comb', f2Cutoff: 261.63, f2Res: 0.88, f2Key: 1, filterRoute: 'serial',
    ...env(1, 0.002, 4, 0, 2), ...env(2, 0.001, 0.08, 0, 0.08), ...lfo(1, 'sine', 0.4, { free: true }),
    ...mods([
      ['env2', 'noiseLevel', 0.7], ['pressure', 'noiseLevel', 0.25], ['pressure', 'level', 0.5], ['timbre', 'oscAPos', 0.6], ['lfo1', 'f2Cutoff', 0.004],
      ['macro1', 'f2Res', 0.1], ['macro2', 'noiseLevel', 0.5, 'env2'], ['macro3', 'oscAPos', 0.6], ['macro4', 'noiseLevel', 0.3]
    ]),
    level: 0.7, reverbMix: 0.45, reverbSize: 0.85, gain: 0.63
  });

preset('Nova Stack', 'experimental', 'Three octaves of unison saws: the biggest sound in the box (and the heaviest on the CPU).',
  ['Detune', 'Filter', 'Top octave', 'Sub'],
  'Pressure opens the filter; slide widens the stack.', {
    ...osc('A', { Table: 'basic', Pos: 0.5, Level: 0.7, Unison: 8, Detune: 34, Blend: 0.9, Spread: 1 }),
    ...osc('B', { Table: 'basic', Pos: 0.5, Level: 0.4, Oct: 1, Unison: 6, Detune: 28, Spread: 1 }),
    ...osc('C', { Table: 'basic', Pos: 0.5, Level: 0.45, Oct: -1, Unison: 4, Detune: 20, Spread: 0.7 }),
    subLevel: 0.25,
    f1Type: 'lp12', f1Cutoff: 7500, f1Res: 0.05, f1Key: 0.3,
    polyphony: 8,
    ...env(1, 0.012, 0.6, 0.85, 0.5), ...env(2, 0.005, 0.8, 0.4, 0.5),
    ...mods([
      ['env2', 'f1Cutoff', 0.1], ['pressure', 'f1Cutoff', 0.18], ['timbre', 'oscADetune', 0.3], ['macro1', 'oscADetune', 0.4], ['macro1', 'oscBDetune', 0.3],
      ['macro2', 'f1Cutoff', -0.45], ['macro3', 'oscBLevel', 0.5], ['velocity', 'f1Cutoff', 0.08], ['macro4', 'subLevel', 0.5]
    ]),
    chorusMix: 0.25, reverbMix: 0.3, reverbSize: 0.7, gain: 0.46
  }, { chord: true });

preset('Vowel Morph', 'experimental', 'A synthetic voice that speaks with your slide: vowels under your fingers.',
  ['Vowel', 'Formant drive', 'Vibrato', 'Breath'],
  'Slide morphs A-E-I-O-U; pressure swells and adds vibrato.', {
    ...osc('A', { Table: 'formant', Pos: 0, Level: 0.8, Unison: 2, Detune: 9, Spread: 0.6 }),
    ...osc('B', { Table: 'reed', Pos: 0.3, Level: 0.25, Oct: -1 }),
    noiseLevel: 0.03, noiseType: 'pink', noiseDest: 'direct', noiseColor: 0.4,
    f1Type: 'lp12', f1Cutoff: 4200, f1Res: 0.1, f1Key: 0.3,
    level: 0.6, mono: true, legato: true, glide: 0.08,
    ...env(1, 0.05, 0.4, 0.9, 0.3), ...lfo(1, 'sine', 5.3, { fade: 0.4 }), ...lfo(2, 'sine', 0.2, { free: true }),
    ...mods([
      ['timbre', 'oscAPos', 1], ['pressure', 'level', 0.45], ['lfo1', 'pitchFine', 0.3, 'pressure'], ['lfo2', 'oscAPos', 0.08], ['pressure', 'f1Cutoff', 0.15],
      ['macro1', 'oscAPos', 1], ['macro2', 'f1Drive', 0.7], ['lfo1', 'pitchFine', 0.3, 'macro3'], ['macro4', 'noiseLevel', 0.3]
    ]),
    reverbMix: 0.3, reverbSize: 0.65, delayMix: 0.12, gain: 0.73
  });

preset('Fold Drone', 'experimental', 'Wavefolded drone a fifth apart, folding harder as you lean in: slow, heavy, alive.',
  ['Fold', 'Fifth', 'Feedback', 'Darkness'],
  'Pressure folds the wave harder; slide adds self-modulation.', {
    ...osc('A', { Table: 'fold', Pos: 0.2, Level: 0.7, Warp: 'fold', WarpAmt: 0.1, FmFrom: 'A', Fm: 0.05, Unison: 2, Detune: 6, Spread: 0.7 }),
    ...osc('B', { Table: 'fold', Pos: 0.35, Level: 0.4, Oct: -1, Semi: 7, Unison: 2, Detune: 9, Spread: 1 }),
    subLevel: 0.3, subOct: -1,
    f1Type: 'lp24', f1Cutoff: 2400, f1Res: 0.15, f1Drive: 0.2, f1Key: 0.2,
    ...env(1, 1.5, 3, 0.9, 4), ...lfo(1, 'sine', 0.06, { free: true }), ...lfo(2, 'smooth', 0.13, { free: true }),
    ...mods([
      ['lfo1', 'oscAPos', 0.3], ['lfo2', 'oscBPos', 0.3], ['pressure', 'oscAWarpAmt', 0.5], ['pressure', 'oscAPos', 0.25], ['timbre', 'oscAFm', 0.3],
      ['macro1', 'oscAWarpAmt', 0.6], ['macro2', 'oscBLevel', 0.5], ['macro3', 'oscAFm', 0.35], ['macro4', 'f1Cutoff', -0.35]
    ]),
    driveAmt: 0.15, driveType: 'tube', reverbMix: 0.5, reverbSize: 0.92, reverbDamp: 0.5, gain: 0.21
  }, { chord: true, key: 36 });

/** Preset name → param overrides on the init patch. "Init" (first, the default) is the bare patch. */
export const GGS_PRESETS = { Init: {}, ...P };

/** Preset name → { category, description, macros: [4 labels], expression: what pressure/slide do }. */
export const GGS_PRESET_INFO = {
  Init: { category: 'init', description: 'One saw through an open filter: the blank page.', macros: ['Macro 1', 'Macro 2', 'Macro 3', 'Macro 4'], expression: 'Pitch curves bend each note; pressure and slide do nothing until you route them in the matrix.', test: {} },
  ...INFO
};

export const GGS_PRESET_CATEGORIES = [['pad', 'Pads'], ['lead', 'Leads'], ['bass', 'Bass'], ['keys', 'Keys'], ['sequence', 'Sequences'], ['experimental', 'Experimental']];
