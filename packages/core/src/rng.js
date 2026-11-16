// A small seeded random source: the same seed gives the same music, on every machine and in every run. Generators
// that vary their output (arpeggios, drum variations, fills) take a seed and draw from this — never Math.random().

/** A 32-bit seed from a number or from text ("verse 2" is as good a seed as 7). */
export function seedOf(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
  let h = 2166136261;
  for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

/** mulberry32: { unit() → [0, 1), below(n) → 0…n−1, pick(list) }. */
export function createRng(seed = 0) {
  let a = seedOf(seed);
  const unit = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n) => Math.floor(unit() * Math.max(1, n));
  return { unit, below, pick: (list) => list[below(list.length)] };
}
