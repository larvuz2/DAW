// The scale dictionary as menu options: one group per family (modes, harmonic minor family, pentatonics…).
import { scaleGroups } from '@greanteadawy/core';

let options = null;
/** For a grouped <Select>: [{ value: id, label, group: family }]. */
export function scaleOptions() {
  options ??= scaleGroups().flatMap((g) => g.scales.map((s) => ({ value: s.id, label: s.label, group: g.family })));
  return options;
}
