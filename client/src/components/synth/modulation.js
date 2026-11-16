// What the synth editor needs to show modulation: a colour per family of sources, the rings of a knob (one per
// route to its target) and where a source or a target stands right now, read from what the voices report.
import { MOD_SOURCES, MOD_TARGETS, BIPOLAR_SOURCES, modTargetSpec, routeValue, targetValue } from '@greanteadawy/synth-dsp';

export const FAMILY_COLOR = { env: '#9ad94f', lfo: '#5ab8f0', chaos: '#ef7fb0', macro: '#c86be0', note: '#f0d24a' };
export const sourceFamily = (s) => (s.startsWith('env') ? 'env' : s.startsWith('lfo') ? 'lfo' : s.startsWith('chaos') ? 'chaos' : s.startsWith('macro') ? 'macro' : 'note');
export const sourceColor = (s) => FAMILY_COLOR[sourceFamily(s)];

const SHORT = { velocity: 'Vel', pressure: 'Press', timbre: 'Slide', bend: 'Bend', key: 'Key', random: 'Rand', releaseVel: 'Rel' };
/** A source's name on a chip: E2, L1, C1, M5, Press … */
export const sourceShort = (s) => SHORT[s] || `${s[0].toUpperCase()}${s.slice(-1)}`;
/** The sources in the order and groups the source bar shows them. */
export const SOURCE_GROUPS = ['env', 'lfo', 'chaos', 'note', 'macro'].map((family) => MOD_SOURCES.filter((s) => s !== 'none' && sourceFamily(s) === family));

// a voice reports [sources…, targets…] (see the worklet)
const SOURCE_AT = Object.fromEntries(MOD_SOURCES.map((s, i) => [s, i]));
const TARGET_AT = Object.fromEntries(MOD_TARGETS.map((t, i) => [t, MOD_SOURCES.length + i]));

/** Where a source stands right now (-1..1 or 0..1), or null when no note is sounding. */
export const liveSource = (values, source) => (values ? values[SOURCE_AT[source]] : null);

/** Where the matrix has taken a target right now, in the units of its knob — or null when no note is sounding. */
export function liveTarget(values, target, params) {
  if (!values) return null;
  const spec = modTargetSpec(target, params);
  return spec ? targetValue(spec, values[TARGET_AT[target]]) : null;
}

/**
 * The rings of a knob: one per route to its target, the deepest first — { lo, hi (the knob's units), color, source,
 * slot, amount }. A one-way source draws from the knob's position outwards, a two-way source on both sides of it.
 */
export function ringsOf(routes, target, params) {
  const spec = modTargetSpec(target, params);
  if (!spec) return [];
  return routes.filter((r) => r.target === target).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).map((r) => {
    const both = BIPOLAR_SOURCES.has(r.source) || (r.via && BIPOLAR_SOURCES.has(r.via));
    const a = routeValue(spec, r.amount, both ? -1 : 0).value;
    const b = routeValue(spec, r.amount, 1).value;
    return { lo: Math.min(a, b), hi: Math.max(a, b), color: sourceColor(r.source), source: r.source, slot: r.slot, amount: r.amount };
  });
}
