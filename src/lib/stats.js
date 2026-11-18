// ─── SMALL STATS HELPERS ───────────────────────────────────────────────────────
// The few numeric helpers more than one module needs. Each used to be re-typed
// per file — quantile and median in both lapBuckets.js and lapHistory.js,
// hasTime in both driverStats.js and lapBuckets.js — which is how two copies of
// "the same" rule end up answering differently. Pure; no imports.

// Ascending copy.
export const asc = (nums) => [...nums].sort((a, b) => a - b);

// Linearly-interpolated quantile of an ALREADY ascending array; null when empty.
export function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// Median of any (unsorted) list; null when empty.
export const median = (nums) => quantile(asc(nums), 0.5);

// A lap with a usable lap time.
export const hasTime = (l) => typeof l?.lapTime === "number" && l.lapTime > 0;
