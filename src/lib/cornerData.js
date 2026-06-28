// ─── CORNER NAMES ─────────────────────────────────────────────────────────────
// A curated database of real-world corner names per circuit, used to label the
// track maps and the telemetry timeline as "T1 – Abbey" (number first, then the
// real name) instead of generic strategy-zone placeholders. The F1 UDP stream
// carries NO corner names — only track id, lap distance and sector times — and
// reference laps don't store them either, so this is the app's own dataset.
//
// Keyed by the SAME track slug used in trackData.js (getTrack().slug).
// Each corner: { n, name, f }
//   • n    — corner number (the "T1", "T2" … the driver thinks in).
//   • name — real-world name, or "" when the corner only has a number.
//   • f    — approximate APEX position as a fraction of the lap (0..1).
//
// NOTE: positions (f) are hand-estimated approximations, good enough to place a
// marker near the right corner. They can be tightened later from telemetry
// braking points without changing this file's shape.
import { getTrack, getTrackByName } from "./trackData.js";

// Build `count` evenly-spaced numbered corners (apex ≈ midpoint of its share of
// the lap), optionally attaching real names by corner number via `names`. Used
// for circuits whose corners are simply numbered, or where only a few carry a
// well-known name.
function track(count, names = {}) {
  const out = [];
  for (let n = 1; n <= count; n++) {
    out.push({ n, name: names[n] || "", f: +(((n - 0.5) / count).toFixed(3)) });
  }
  return out;
}

export const CORNERS_BY_TRACK = {
  // ── Mostly/fully numbered circuits ──────────────────────────────────────────
  australia: track(14),
  china:     track(16),
  bahrain:   track(15),
  hungary:   track(14),
  singapore: track(19),
  abudhabi:  track(16),
  usa:       track(20),
  azerbaijan: track(20),
  saudiarabia: track(27),
  miami:     track(19),
  lasvegas:  track(17),
  qatar:     track(16),

  // ── Numbered with a handful of real names ───────────────────────────────────
  spain: track(14, { 1: "Elf", 3: "Renault", 5: "Seat", 9: "Campsa", 10: "La Caixa", 13: "Banc de Sabadell" }),
  canada: track(14, { 10: "L'Épingle", 13: "Wall of Champions", 14: "Wall of Champions" }),
  austria: track(10, { 1: "Niki Lauda", 3: "Remus", 4: "Schlossgold", 6: "Rauch", 9: "Red Bull Mobile" }),
  mexico: track(17, { 16: "Peraltada" }),
  netherlands: track(14, { 1: "Tarzan", 2: "Gerlach", 3: "Hugenholtz", 7: "Scheivlak", 13: "Arie Luyendyk", 14: "Arie Luyendyk" }),
  imola: track(19, { 2: "Tamburello", 4: "Villeneuve", 5: "Tosa", 7: "Piratella", 8: "Acque Minerali", 11: "Variante Alta", 13: "Rivazza", 14: "Rivazza", 15: "Variante Bassa" }),

  // ── Fully named, hand-placed apexes ─────────────────────────────────────────
  silverstone: [
    { n: 1, name: "Abbey", f: 0.05 }, { n: 2, name: "Farm Curve", f: 0.08 },
    { n: 3, name: "Village", f: 0.14 }, { n: 4, name: "The Loop", f: 0.17 },
    { n: 5, name: "Aintree", f: 0.20 }, { n: 6, name: "Brooklands", f: 0.30 },
    { n: 7, name: "Luffield", f: 0.34 }, { n: 8, name: "Woodcote", f: 0.40 },
    { n: 9, name: "Copse", f: 0.48 }, { n: 10, name: "Maggotts", f: 0.56 },
    { n: 11, name: "Becketts", f: 0.60 }, { n: 12, name: "Chapel", f: 0.64 },
    { n: 13, name: "Stowe", f: 0.76 }, { n: 14, name: "Vale", f: 0.84 },
    { n: 15, name: "Club", f: 0.90 },
  ],
  monaco: [
    { n: 1, name: "Sainte Dévote", f: 0.06 }, { n: 2, name: "", f: 0.10 },
    { n: 3, name: "Massenet", f: 0.15 }, { n: 4, name: "Casino", f: 0.19 },
    { n: 5, name: "Mirabeau", f: 0.27 }, { n: 6, name: "Grand Hotel Hairpin", f: 0.31 },
    { n: 7, name: "", f: 0.35 }, { n: 8, name: "Portier", f: 0.42 },
    { n: 9, name: "Tunnel", f: 0.50 }, { n: 10, name: "Nouvelle Chicane", f: 0.58 },
    { n: 11, name: "", f: 0.61 }, { n: 12, name: "Tabac", f: 0.66 },
    { n: 13, name: "Swimming Pool", f: 0.71 }, { n: 14, name: "", f: 0.74 },
    { n: 15, name: "", f: 0.79 }, { n: 16, name: "La Rascasse", f: 0.84 },
    { n: 17, name: "", f: 0.88 }, { n: 18, name: "Anthony Noghès", f: 0.92 },
    { n: 19, name: "", f: 0.96 },
  ],
  belgium: [
    { n: 1, name: "La Source", f: 0.04 }, { n: 2, name: "Eau Rouge", f: 0.08 },
    { n: 3, name: "Raidillon", f: 0.10 }, { n: 4, name: "", f: 0.16 },
    { n: 5, name: "Les Combes", f: 0.22 }, { n: 6, name: "Malmedy", f: 0.25 },
    { n: 7, name: "Rivage", f: 0.29 }, { n: 8, name: "", f: 0.33 },
    { n: 9, name: "No Name", f: 0.37 }, { n: 10, name: "Pouhon", f: 0.43 },
    { n: 11, name: "Fagnes", f: 0.50 }, { n: 12, name: "", f: 0.53 },
    { n: 13, name: "Campus", f: 0.58 }, { n: 14, name: "Stavelot", f: 0.64 },
    { n: 15, name: "", f: 0.72 }, { n: 16, name: "Blanchimont", f: 0.80 },
    { n: 17, name: "", f: 0.84 }, { n: 18, name: "Bus Stop", f: 0.93 },
    { n: 19, name: "", f: 0.96 },
  ],
  italy: [
    { n: 1, name: "Rettifilo", f: 0.10 }, { n: 2, name: "", f: 0.12 },
    { n: 3, name: "Curva Grande", f: 0.24 }, { n: 4, name: "Roggia", f: 0.34 },
    { n: 5, name: "", f: 0.36 }, { n: 6, name: "Lesmo 1", f: 0.46 },
    { n: 7, name: "Lesmo 2", f: 0.52 }, { n: 8, name: "Ascari", f: 0.66 },
    { n: 9, name: "", f: 0.68 }, { n: 10, name: "", f: 0.70 },
    { n: 11, name: "Parabolica", f: 0.88 },
  ],
  japan: [
    { n: 1, name: "First Curve", f: 0.04 }, { n: 2, name: "", f: 0.07 },
    { n: 3, name: "S Curves", f: 0.11 }, { n: 4, name: "", f: 0.13 },
    { n: 5, name: "", f: 0.15 }, { n: 6, name: "", f: 0.18 },
    { n: 7, name: "Dunlop", f: 0.23 }, { n: 8, name: "Degner 1", f: 0.29 },
    { n: 9, name: "Degner 2", f: 0.33 }, { n: 10, name: "", f: 0.41 },
    { n: 11, name: "Hairpin", f: 0.46 }, { n: 12, name: "", f: 0.52 },
    { n: 13, name: "Spoon", f: 0.59 }, { n: 14, name: "", f: 0.63 },
    { n: 15, name: "130R", f: 0.80 }, { n: 16, name: "Casio Triangle", f: 0.90 },
    { n: 17, name: "", f: 0.92 }, { n: 18, name: "", f: 0.96 },
  ],
  brazil: [
    { n: 1, name: "Senna S", f: 0.05 }, { n: 2, name: "", f: 0.08 },
    { n: 3, name: "Curva do Sol", f: 0.16 }, { n: 4, name: "Descida do Lago", f: 0.26 },
    { n: 5, name: "", f: 0.29 }, { n: 6, name: "Ferradura", f: 0.40 },
    { n: 7, name: "Laranja", f: 0.47 }, { n: 8, name: "Pinheirinho", f: 0.55 },
    { n: 9, name: "Bico de Pato", f: 0.63 }, { n: 10, name: "Mergulho", f: 0.71 },
    { n: 11, name: "Junção", f: 0.80 }, { n: 12, name: "Subida dos Boxes", f: 0.86 },
    { n: 13, name: "", f: 0.90 }, { n: 14, name: "", f: 0.94 },
    { n: 15, name: "Arquibancadas", f: 0.97 },
  ],
};

// Resolve a track reference — an asset slug, a display name ("Silverstone"), or a
// numeric m_trackId — to its slug. Returns null when unknown.
export function resolveSlug(ref) {
  if (ref == null) return null;
  if (typeof ref === "number") return getTrack(ref)?.slug ?? null;
  const s = String(ref).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (CORNERS_BY_TRACK[lower]) return lower;     // already a slug
  return getTrackByName(s)?.slug ?? null;        // a display name
}

// The corner list for a track reference (slug | name | id), or [] when unknown.
export function getCorners(ref) {
  const slug = resolveSlug(ref);
  return (slug && CORNERS_BY_TRACK[slug]) || [];
}

// "T1 – Abbey", or just "T7" when the corner has no real-world name.
export function cornerLabel(c) {
  if (!c || typeof c.n !== "number") return "";
  return c.name ? `T${c.n} – ${c.name}` : `T${c.n}`;
}

// The corner whose apex is closest to a lap fraction, within `maxDist` (fraction
// of the lap). Returns null when none is close enough — callers then fall back to
// sector/zone labels.
export function nearestCorner(corners, frac, maxDist = 0.03) {
  if (!Array.isArray(corners) || !corners.length || typeof frac !== "number") return null;
  let best = null, bestD = Infinity;
  for (const c of corners) {
    const d = Math.abs(c.f - frac);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxDist ? best : null;
}
