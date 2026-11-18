// ─── TRACK FILE LOADER ─────────────────────────────────────────────────────────
// One fetch-and-parse per circuit for public/tracks/<slug>.json, shared by the
// two readers: the geometry fitter (lib/trackGeometry.js) and the apex loader
// (lib/cornerAnchors.js).
//
// Each used to fetch on its own, and the fitter fetched AGAIN on every refit:
// comparing against the live lap re-keys its model cache every 64 recorded
// samples, and each re-key re-downloaded and re-parsed the same ~50 KB of JSON
// before solving the alignment. The file is static for the life of the app, so
// the parsed object is cached per slug. Readers must treat it as read-only (both
// do — the fitter copies before it reverses anything).
//
// A missing file (a 404, or a non-JSON body) is cached as null so it isn't
// re-requested; a NETWORK failure is evicted instead, or one offline moment would
// pin legacy corner names and the heuristic road until the app restarts.

const cache = new Map();

export function loadTrackFile(slug) {
  if (!slug) return Promise.resolve(null);
  if (cache.has(slug)) return cache.get(slug);
  const p = fetch(`/tracks/${slug}.json`)
    .then((r) => (r.ok ? r.json().catch(() => null) : null))
    .catch((e) => { cache.delete(slug); throw e; });
  cache.set(slug, p);
  return p;
}
