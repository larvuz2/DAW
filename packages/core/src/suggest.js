// "Did you mean …?" — the names closest to one that was mistyped, so an error can say what to send instead.

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) cur.push(Math.min(prev[j] + (a[i] !== b[j] ? 1 : 0), prev[j + 1] + 1, cur[j] + 1));
    prev = cur;
  }
  return prev[b.length];
}

const MAX_NAME = 64;

/** A name as an error may repeat it: whatever was sent, at most `max` characters of it come back. */
export function brief(text, max = 60) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The candidates closest to `name`, nearest first (at most `max`). A candidate counts when it is within a few edits
 * of the name — or when one contains the other ("cutoff" finds "f1Cutoff"). Nothing close: an empty list.
 */
export function nearest(name, candidates, max = 3) {
  const wanted = String(name ?? '').trim().toLowerCase();
  // (no real name is this long, and comparing a megabyte of "name" letter by letter would stall whoever is waiting)
  if (!wanted || wanted.length > MAX_NAME) return [];
  const scored = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const text = String(c);
    const lower = text.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    let d = editDistance(wanted, lower);
    // (a part of the name typed right is a strong hint, however much is missing around it)
    if (wanted.length >= 3 && (lower.includes(wanted) || wanted.includes(lower))) d = Math.min(d, 2);
    // (a third of the letters may be wrong: "Led" is "Lead", not "Pad")
    if (d <= Math.max(1, Math.floor(Math.max(lower.length, wanted.length) / 3))) scored.push([d, Math.abs(lower.length - wanted.length), scored.length, text]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  return scored.slice(0, max).map((s) => s[3]);
}

/** ` Did you mean "Lead"?` (with its leading space), or '' when nothing is close. */
export function didYouMean(name, candidates, max = 3) {
  const close = nearest(name, candidates, max);
  if (!close.length) return '';
  const quoted = close.map((c) => `"${c}"`);
  return ` Did you mean ${quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}` : quoted[0]}?`;
}

/** The value of a list of numbers closest to `value` (the lower one on a tie). */
export function nearestNumber(value, numbers) {
  let best = null;
  for (const n of numbers) if (typeof n === 'number' && (best === null || Math.abs(n - value) < Math.abs(best - value))) best = n;
  return best;
}
