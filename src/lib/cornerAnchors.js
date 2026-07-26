// ─── CORNER ANCHORS ────────────────────────────────────────────────────────────
// Where the start/finish line sits on a circuit's shipped centerline, and whether
// that centerline is stored in the racing direction.
//
// public/tracks/<slug>.json carries `apexes` — where the corners physically are,
// as fractions of the centerline's arc length from point 0 (see
// scripts/fit-corners.mjs). That frame deliberately has no notion of a lap:
//   • point 0 is wherever the upstream GeoJSON way started (the start/finish line
//     at Monza, ~845 m past it at Monaco), and
//   • file order isn't always the racing direction (Singapore's way is traced
//     backwards).
// Both are solved exactly by trackGeometry.solveAlignment the first time a
// recorded lap is fitted on that circuit. This module remembers the answer so the
// SECOND visit doesn't have to wait for a lap: corner numbering is available the
// moment a track loads.
//
// anchor = { sfFrac, reverse }
//   sfFrac  — start/finish as a fraction of the centerline arc length, file order
//   reverse — true when file order runs against the racing direction
//
// Cached in localStorage (a few bytes per circuit). A stale or wrong entry is
// self-correcting: every real fit overwrites it.
import { CORNER_NAMES } from "./cornerData.js";

const KEY = "boxbox.cornerAnchors.v1";

let cache = null;
const listeners = new Set();

function readAll() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }
  catch { cache = {}; }
  return cache;
}

export function getAnchor(slug) {
  if (!slug) return null;
  const a = readAll()[slug];
  return a && typeof a.sfFrac === "number" ? a : null;
}

// Called by trackGeometry whenever a real fit lands. Only writes when the anchor
// actually moved, so we don't churn localStorage (or re-render) every refit.
export function setAnchor(slug, anchor) {
  if (!slug || !anchor || typeof anchor.sfFrac !== "number") return;
  const all = readAll();
  const prev = all[slug];
  const same = prev
    && prev.reverse === !!anchor.reverse
    && Math.abs(prev.sfFrac - anchor.sfFrac) < 0.002;   // ~10 m — not worth a rewrite
  if (same) return;
  all[slug] = { sfFrac: anchor.sfFrac, reverse: !!anchor.reverse };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota — in-memory is enough */ }
  for (const fn of listeners) fn();
}

// Subscribe to anchor changes (a fit landing on a new circuit). Returns unsubscribe.
export function subscribeAnchors(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Apex positions ─────────────────────────────────────────────────────────────
// The physical corner positions shipped alongside the centerline. Cached per slug
// (including misses) so the Live screen can ask on every track change for free.
const apexCache = new Map();

export function loadApexes(slug) {
  if (!slug) return Promise.resolve(null);
  if (apexCache.has(slug)) return apexCache.get(slug);
  const p = fetch(`/tracks/${slug}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (Array.isArray(d?.apexes) && d.apexes.length ? d.apexes : null))
    .catch(() => null);
  apexCache.set(slug, p);
  return p;
}

// ── Corner numbering ───────────────────────────────────────────────────────────
// Turn physical apexes + an anchor into the numbered, named corners the rest of
// the app speaks in: [{ n, name, f }] with f as a LAP fraction from start/finish,
// which is the contract every consumer (labeler, timeline ticks, maps) expects.
export function cornersFrom(slug, apexes, anchor) {
  if (!Array.isArray(apexes) || !apexes.length || !anchor) return [];
  const names = CORNER_NAMES[slug] || [];
  const { sfFrac, reverse } = anchor;
  // Racing direction runs with file order, or against it when the way is reversed.
  const lapF = (f) => (((reverse ? sfFrac - f : f - sfFrac) % 1) + 1) % 1;
  return apexes
    .map((f) => lapF(f))
    .sort((a, b) => a - b)
    .map((f, i) => ({ n: i + 1, name: names[i]?.name || "", f }));
}
