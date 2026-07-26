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
//   • f    — LEGACY hand-estimated apex position as a fraction of the lap (0..1).
//
// WHERE POSITIONS COME FROM NOW: not from `f`. Corner positions are measured off
// the centerline we already ship (public/tracks/<slug>.json `apexes`, written by
// scripts/fit-corners.mjs) and numbered at runtime from the real start/finish,
// which src/lib/trackGeometry.js recovers by aligning that centerline to a
// recorded lap. See src/lib/cornerAnchors.js for the numbering step.
//
// The `f` values below were hand-estimated against no fixed reference and are
// wrong by up to ~800 m (Singapore put T1 down a pit straight half that long;
// Monaco put the Grand Hotel hairpin ~340 m late). They survive ONLY as a
// fallback for circuits whose geometry has no `apexes` yet, and should be deleted
// from each track as scripts/fit-corners.mjs covers it. What stays authoritative
// here is the official NUMBERING and the real-world NAMES.
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
  australia: [
    { n: 1, name: "", f: 0.080 }, { n: 2, name: "", f: 0.097 },
    { n: 3, name: "", f: 0.216 }, { n: 4, name: "", f: 0.242 },
    { n: 5, name: "", f: 0.283 }, { n: 6, name: "", f: 0.362 },
    { n: 7, name: "", f: 0.363 }, { n: 8, name: "", f: 0.384 },
    { n: 9, name: "", f: 0.422 }, { n: 10, name: "", f: 0.629 },
    { n: 11, name: "", f: 0.651 }, { n: 12, name: "", f: 0.785 },
    { n: 13, name: "", f: 0.838 }, { n: 14, name: "", f: 0.889 },
    { n: 15, name: "", f: 0.917 },
  ],
  china: [
    { n: 1, name: "", f: 0.032 }, { n: 2, name: "", f: 0.109 },
    { n: 3, name: "", f: 0.154 }, { n: 4, name: "", f: 0.228 },
    { n: 5, name: "", f: 0.259 }, { n: 6, name: "", f: 0.281 },
    { n: 7, name: "", f: 0.301 }, { n: 8, name: "", f: 0.453 },
    { n: 9, name: "", f: 0.507 }, { n: 10, name: "", f: 0.521 },
    { n: 11, name: "", f: 0.765 }, { n: 12, name: "", f: 0.789 },
    { n: 13, name: "", f: 0.807 }, { n: 14, name: "", f: 0.896 },
    { n: 15, name: "", f: 0.916 }, { n: 16, name: "", f: 0.950 },
  ],
  bahrain: [
    { n: 1, name: "", f: 0.134 }, { n: 2, name: "", f: 0.152 },
    { n: 3, name: "", f: 0.173 }, { n: 4, name: "", f: 0.285 },
    { n: 5, name: "", f: 0.331 }, { n: 6, name: "", f: 0.351 },
    { n: 7, name: "", f: 0.371 }, { n: 8, name: "", f: 0.418 },
    { n: 9, name: "", f: 0.489 }, { n: 10, name: "", f: 0.510 },
    { n: 11, name: "", f: 0.644 }, { n: 12, name: "", f: 0.703 },
    { n: 13, name: "", f: 0.754 }, { n: 14, name: "", f: 0.919 },
    { n: 15, name: "", f: 0.935 },
  ],
  hungary: [
    { n: 1, name: "", f: 0.140 }, { n: 2, name: "", f: 0.255 },
    { n: 3, name: "", f: 0.300 }, { n: 4, name: "", f: 0.406 },
    { n: 5, name: "", f: 0.466 }, { n: 6, name: "", f: 0.540 },
    { n: 7, name: "", f: 0.550 }, { n: 8, name: "", f: 0.589 },
    { n: 9, name: "", f: 0.621 }, { n: 10, name: "", f: 0.671 },
    { n: 11, name: "", f: 0.713 }, { n: 12, name: "", f: 0.796 },
    { n: 13, name: "", f: 0.864 }, { n: 14, name: "", f: 0.935 },
  ],
  singapore: [
    { n: 1, name: "", f: 0.163 }, { n: 2, name: "", f: 0.260 },
    { n: 3, name: "", f: 0.272 }, { n: 4, name: "", f: 0.294 },
    { n: 5, name: "", f: 0.355 }, { n: 6, name: "", f: 0.425 },
    { n: 7, name: "", f: 0.481 }, { n: 8, name: "", f: 0.525 },
    { n: 9, name: "", f: 0.546 }, { n: 10, name: "", f: 0.618 },
    { n: 11, name: "", f: 0.641 }, { n: 12, name: "", f: 0.655 },
    { n: 13, name: "", f: 0.704 }, { n: 14, name: "", f: 0.790 },
    { n: 15, name: "", f: 0.838 }, { n: 16, name: "", f: 0.916 },
    { n: 17, name: "", f: 0.927 }, { n: 18, name: "", f: 0.975 },
    { n: 19, name: "", f: 0.992 },
  ],
  usa: [
    { n: 1, name: "", f: 0.045 }, { n: 2, name: "", f: 0.103 },
    { n: 3, name: "", f: 0.169 }, { n: 4, name: "", f: 0.191 },
    { n: 5, name: "", f: 0.233 }, { n: 6, name: "", f: 0.279 },
    { n: 7, name: "", f: 0.398 }, { n: 8, name: "", f: 0.450 },
    { n: 9, name: "", f: 0.469 }, { n: 10, name: "", f: 0.472 },
    { n: 11, name: "", f: 0.474 }, { n: 12, name: "", f: 0.562 },
    { n: 13, name: "", f: 0.672 }, { n: 14, name: "", f: 0.689 },
    { n: 15, name: "", f: 0.695 }, { n: 16, name: "", f: 0.719 },
    { n: 17, name: "", f: 0.725 }, { n: 18, name: "", f: 0.750 },
    { n: 19, name: "", f: 0.866 }, { n: 20, name: "", f: 0.967 },
  ],
  azerbaijan: [
    { n: 1, name: "", f: 0.054 }, { n: 2, name: "", f: 0.107 },
    { n: 3, name: "", f: 0.233 }, { n: 4, name: "", f: 0.313 },
    { n: 5, name: "", f: 0.351 }, { n: 6, name: "", f: 0.368 },
    { n: 7, name: "", f: 0.431 }, { n: 8, name: "", f: 0.449 },
    { n: 9, name: "", f: 0.453 }, { n: 10, name: "", f: 0.455 },
    { n: 11, name: "", f: 0.463 }, { n: 12, name: "", f: 0.472 },
    { n: 13, name: "", f: 0.574 }, { n: 14, name: "", f: 0.606 },
    { n: 15, name: "", f: 0.638 }, { n: 16, name: "", f: 0.689 },
    { n: 17, name: "", f: 0.717 }, { n: 18, name: "", f: 0.784 },
    { n: 19, name: "", f: 0.809 }, { n: 20, name: "", f: 0.864 },
  ],
  saudiarabia: [
    { n: 1, name: "", f: 0.086 }, { n: 2, name: "", f: 0.103 },
    { n: 3, name: "", f: 0.118 }, { n: 4, name: "", f: 0.168 },
    { n: 5, name: "", f: 0.189 }, { n: 6, name: "", f: 0.213 },
    { n: 7, name: "", f: 0.232 }, { n: 8, name: "", f: 0.238 },
    { n: 9, name: "", f: 0.273 }, { n: 10, name: "", f: 0.284 },
    { n: 11, name: "", f: 0.298 }, { n: 12, name: "", f: 0.312 },
    { n: 13, name: "", f: 0.406 }, { n: 14, name: "", f: 0.450 },
    { n: 15, name: "", f: 0.480 }, { n: 16, name: "", f: 0.495 },
    { n: 17, name: "", f: 0.514 }, { n: 18, name: "", f: 0.533 },
    { n: 19, name: "", f: 0.571 }, { n: 20, name: "", f: 0.608 },
    { n: 21, name: "", f: 0.650 }, { n: 22, name: "", f: 0.696 },
    { n: 23, name: "", f: 0.710 }, { n: 24, name: "", f: 0.736 },
    { n: 25, name: "", f: 0.776 }, { n: 26, name: "", f: 0.845 },
    { n: 27, name: "", f: 0.895 },
  ],
  miami: [
    { n: 1, name: "", f: 0.074 }, { n: 2, name: "", f: 0.091 },
    { n: 3, name: "", f: 0.106 }, { n: 4, name: "", f: 0.210 },
    { n: 5, name: "", f: 0.237 }, { n: 6, name: "", f: 0.260 },
    { n: 7, name: "", f: 0.293 }, { n: 8, name: "", f: 0.303 },
    { n: 9, name: "", f: 0.403 }, { n: 10, name: "", f: 0.450 },
    { n: 11, name: "", f: 0.567 }, { n: 12, name: "", f: 0.589 },
    { n: 13, name: "", f: 0.611 }, { n: 14, name: "", f: 0.625 },
    { n: 15, name: "", f: 0.630 }, { n: 16, name: "", f: 0.645 },
    { n: 17, name: "", f: 0.897 }, { n: 18, name: "", f: 0.925 },
    { n: 19, name: "", f: 0.957 },
  ],
  lasvegas: [
    { n: 1, name: "", f: 0.133 }, { n: 2, name: "", f: 0.156 },
    { n: 3, name: "", f: 0.194 }, { n: 4, name: "", f: 0.202 },
    { n: 5, name: "", f: 0.254 }, { n: 6, name: "", f: 0.354 },
    { n: 7, name: "", f: 0.368 }, { n: 8, name: "", f: 0.376 },
    { n: 9, name: "", f: 0.581 }, { n: 10, name: "", f: 0.672 },
    { n: 11, name: "", f: 0.697 }, { n: 12, name: "", f: 0.747 },
    { n: 13, name: "", f: 0.814 }, { n: 14, name: "", f: 0.832 },
    { n: 15, name: "", f: 0.840 }, { n: 16, name: "", f: 0.865 },
    { n: 17, name: "", f: 0.908 },
  ],
  qatar: [
    { n: 1, name: "", f: 0.000 }, { n: 2, name: "", f: 0.008 },
    { n: 3, name: "", f: 0.069 }, { n: 4, name: "", f: 0.174 },
    { n: 5, name: "", f: 0.218 }, { n: 6, name: "", f: 0.298 },
    { n: 7, name: "", f: 0.402 }, { n: 8, name: "", f: 0.454 },
    { n: 9, name: "", f: 0.489 }, { n: 10, name: "", f: 0.547 },
    { n: 11, name: "", f: 0.590 }, { n: 12, name: "", f: 0.706 },
    { n: 13, name: "", f: 0.751 }, { n: 14, name: "", f: 0.806 },
    { n: 15, name: "", f: 0.889 }, { n: 16, name: "", f: 0.999 },
  ],

  // ── Numbered with a handful of real names ───────────────────────────────────
  spain: [
    { n: 1, name: "Elf", f: 0.031 }, { n: 2, name: "", f: 0.046 },
    { n: 3, name: "Renault", f: 0.086 }, { n: 4, name: "", f: 0.135 },
    { n: 5, name: "Seat", f: 0.220 }, { n: 6, name: "", f: 0.335 },
    { n: 7, name: "", f: 0.390 }, { n: 8, name: "", f: 0.409 },
    { n: 9, name: "Campsa", f: 0.647 }, { n: 10, name: "La Caixa", f: 0.707 },
    { n: 11, name: "", f: 0.768 }, { n: 12, name: "", f: 0.803 },
    { n: 13, name: "Banc de Sabadell", f: 0.832 }, { n: 14, name: "", f: 0.960 },
  ],
  canada: [
    { n: 1, name: "", f: 0.053 }, { n: 2, name: "", f: 0.076 },
    { n: 3, name: "", f: 0.182 }, { n: 4, name: "", f: 0.194 },
    { n: 5, name: "", f: 0.244 }, { n: 6, name: "", f: 0.290 },
    { n: 7, name: "", f: 0.313 }, { n: 8, name: "", f: 0.455 },
    { n: 9, name: "", f: 0.467 }, { n: 10, name: "L'Epingle", f: 0.604 },
    { n: 11, name: "", f: 0.631 }, { n: 12, name: "", f: 0.752 },
    { n: 13, name: "Wall of Champions", f: 0.905 }, { n: 14, name: "Wall of Champions", f: 0.912 },
  ],
  austria: [
    { n: 1, name: "Niki Lauda", f: 0.083 }, { n: 2, name: "", f: 0.227 },
    { n: 3, name: "Remus", f: 0.301 }, { n: 4, name: "Schlossgold", f: 0.494 },
    { n: 5, name: "", f: 0.535 }, { n: 6, name: "Rauch", f: 0.616 },
    { n: 7, name: "", f: 0.679 }, { n: 8, name: "", f: 0.722 },
    { n: 9, name: "Red Bull Mobile", f: 0.850 }, { n: 10, name: "", f: 0.903 },
  ],
  mexico: [
    { n: 1, name: "", f: 0.158 }, { n: 2, name: "", f: 0.171 },
    { n: 3, name: "", f: 0.189 }, { n: 4, name: "", f: 0.523 },
    { n: 5, name: "", f: 0.542 }, { n: 6, name: "", f: 0.550 },
    { n: 7, name: "", f: 0.564 }, { n: 8, name: "", f: 0.613 },
    { n: 9, name: "", f: 0.741 }, { n: 10, name: "", f: 0.762 },
    { n: 11, name: "", f: 0.801 }, { n: 12, name: "", f: 0.804 },
    { n: 13, name: "", f: 0.831 }, { n: 14, name: "", f: 0.854 },
    { n: 15, name: "", f: 0.915 }, { n: 16, name: "Peraltada", f: 0.974 },
    { n: 17, name: "", f: 0.985 },
  ],
  netherlands: [
    { n: 1, name: "Tarzan", f: 0.001 }, { n: 2, name: "Gerlach", f: 0.061 },
    { n: 3, name: "Hugenholtz", f: 0.103 }, { n: 4, name: "", f: 0.156 },
    { n: 5, name: "", f: 0.208 }, { n: 6, name: "", f: 0.252 },
    { n: 7, name: "Scheivlak", f: 0.331 }, { n: 8, name: "", f: 0.411 },
    { n: 9, name: "", f: 0.471 }, { n: 10, name: "", f: 0.542 },
    { n: 11, name: "", f: 0.693 }, { n: 12, name: "", f: 0.717 },
    { n: 13, name: "Arie Luyendyk", f: 0.807 }, { n: 14, name: "Arie Luyendyk", f: 0.884 },
  ],
  imola: track(19, { 2: "Tamburello", 4: "Villeneuve", 5: "Tosa", 7: "Piratella", 8: "Acque Minerali", 11: "Variante Alta", 13: "Rivazza", 14: "Rivazza", 15: "Variante Bassa" }),

  // ── Fully named, hand-placed apexes ─────────────────────────────────────────
  // Official 18-corner numbering. Apex fractions derived by registering the F1
  // corner map onto the shipped centerline (public/tracks/silverstone.json) and
  // anchoring on the three long straights (pit→Abbey, Wellington→Brooklands,
  // Hangar→Stowe); T13/T14/T17 are the three corners the 18-scheme adds beyond the
  // 15 traditional names, left unnamed.
  silverstone: [
    { n: 1, name: "Abbey", f: 0.060 }, { n: 2, name: "Farm Curve", f: 0.096 },
    { n: 3, name: "Village", f: 0.138 }, { n: 4, name: "The Loop", f: 0.166 },
    { n: 5, name: "Aintree", f: 0.205 }, { n: 6, name: "Brooklands", f: 0.317 },
    { n: 7, name: "Luffield", f: 0.360 }, { n: 8, name: "Woodcote", f: 0.425 },
    { n: 9, name: "Copse", f: 0.504 }, { n: 10, name: "Maggotts", f: 0.594 },
    { n: 11, name: "Becketts", f: 0.607 }, { n: 12, name: "Chapel", f: 0.634 },
    { n: 13, name: "", f: 0.664 }, { n: 14, name: "", f: 0.687 },
    { n: 15, name: "Stowe", f: 0.835 }, { n: 16, name: "Vale", f: 0.919 },
    { n: 17, name: "", f: 0.930 }, { n: 18, name: "Club", f: 0.966 },
  ],
  // Madring (Madrid, debuts 2026) — 22 numbered corners, no traditional names.
  // Apex fractions extracted from the official SVG track map: each corner's white
  // apex dot snapped to the parsed centre-line path, origin at the start/finish
  // checkerboard. Fully numbered, so every name is left blank.
  madring: [
    { n: 1, name: "", f: 0.034 }, { n: 2, name: "", f: 0.043 },
    { n: 3, name: "", f: 0.067 }, { n: 4, name: "", f: 0.194 },
    { n: 5, name: "", f: 0.236 }, { n: 6, name: "", f: 0.249 },
    { n: 7, name: "", f: 0.275 }, { n: 8, name: "", f: 0.306 },
    { n: 9, name: "", f: 0.320 }, { n: 10, name: "", f: 0.371 },
    { n: 11, name: "", f: 0.391 }, { n: 12, name: "", f: 0.452 },
    { n: 13, name: "", f: 0.564 }, { n: 14, name: "", f: 0.599 },
    { n: 15, name: "", f: 0.642 }, { n: 16, name: "", f: 0.676 },
    { n: 17, name: "", f: 0.689 }, { n: 18, name: "", f: 0.731 },
    { n: 19, name: "", f: 0.768 }, { n: 20, name: "", f: 0.834 },
    { n: 21, name: "", f: 0.863 }, { n: 22, name: "", f: 0.919 },
  ],
  // Yas Marina (Abu Dhabi) — 16-corner layout, no traditional names. Apex fractions
  // traced from the official map: racing line skeletonised into a centre-line, each
  // numbered corner snapped to it, origin at the start/finish line.
  abudhabi: [
    { n: 1, name: "", f: 0.076 }, { n: 2, name: "", f: 0.121 },
    { n: 3, name: "", f: 0.160 }, { n: 4, name: "", f: 0.202 },
    { n: 5, name: "", f: 0.274 }, { n: 6, name: "", f: 0.514 },
    { n: 7, name: "", f: 0.534 }, { n: 8, name: "", f: 0.571 },
    { n: 9, name: "", f: 0.724 }, { n: 10, name: "", f: 0.786 },
    { n: 11, name: "", f: 0.809 }, { n: 12, name: "", f: 0.836 },
    { n: 13, name: "", f: 0.858 }, { n: 14, name: "", f: 0.878 },
    { n: 15, name: "", f: 0.940 }, { n: 16, name: "", f: 0.965 },
  ],
  monaco: [
    { n: 1, name: "Sainte Devote", f: 0.127 }, { n: 2, name: "", f: 0.245 },
    { n: 3, name: "Massenet", f: 0.283 }, { n: 4, name: "Casino", f: 0.324 },
    { n: 5, name: "Mirabeau", f: 0.389 }, { n: 6, name: "Grand Hotel Hairpin", f: 0.424 },
    { n: 7, name: "", f: 0.440 }, { n: 8, name: "Portier", f: 0.472 },
    { n: 9, name: "Tunnel", f: 0.557 }, { n: 10, name: "Nouvelle Chicane", f: 0.660 },
    { n: 11, name: "", f: 0.676 }, { n: 12, name: "Tabac", f: 0.740 },
    { n: 13, name: "Swimming Pool", f: 0.794 }, { n: 14, name: "", f: 0.799 },
    { n: 15, name: "", f: 0.834 }, { n: 16, name: "La Rascasse", f: 0.850 },
    { n: 17, name: "", f: 0.876 }, { n: 18, name: "Anthony Noghes", f: 0.902 },
    { n: 19, name: "", f: 0.926 },
  ],
  belgium: [
    { n: 1, name: "La Source", f: 0.000 }, { n: 2, name: "Eau Rouge", f: 0.061 },
    { n: 3, name: "Raidillon", f: 0.195 }, { n: 4, name: "", f: 0.199 },
    { n: 5, name: "Les Combes", f: 0.225 }, { n: 6, name: "", f: 0.253 },
    { n: 7, name: "Malmedy", f: 0.486 }, { n: 8, name: "Rivage", f: 0.504 },
    { n: 9, name: "No Name", f: 0.530 }, { n: 10, name: "Pouhon", f: 0.604 },
    { n: 11, name: "", f: 0.635 }, { n: 12, name: "Les Fagnes", f: 0.740 },
    { n: 13, name: "Campus", f: 0.780 }, { n: 14, name: "Stavelot", f: 0.783 },
    { n: 15, name: "Curve Paul Frere", f: 0.794 }, { n: 16, name: "Blanchimont", f: 0.911 },
    { n: 17, name: "", f: 0.938 }, { n: 18, name: "Bus Stop", f: 0.985 },
    { n: 19, name: "", f: 0.999 },
  ],
  italy: [
    { n: 1, name: "Rettifilo", f: 0.183 }, { n: 2, name: "", f: 0.192 },
    { n: 3, name: "Curva Grande", f: 0.283 }, { n: 4, name: "Roggia", f: 0.396 },
    { n: 5, name: "", f: 0.406 }, { n: 6, name: "Lesmo 1", f: 0.472 },
    { n: 7, name: "Lesmo 2", f: 0.528 }, { n: 8, name: "Ascari", f: 0.703 },
    { n: 9, name: "", f: 0.719 }, { n: 10, name: "", f: 0.737 },
    { n: 11, name: "Parabolica", f: 0.923 },
  ],
  japan: [
    { n: 1, name: "First Curve", f: 0.125 }, { n: 2, name: "", f: 0.137 },
    { n: 3, name: "S Curves", f: 0.174 }, { n: 4, name: "", f: 0.191 },
    { n: 5, name: "", f: 0.223 }, { n: 6, name: "", f: 0.252 },
    { n: 7, name: "Dunlop", f: 0.295 }, { n: 8, name: "Degner 1", f: 0.382 },
    { n: 9, name: "Degner 2", f: 0.409 }, { n: 10, name: "", f: 0.592 },
    { n: 11, name: "Hairpin", f: 0.624 }, { n: 12, name: "", f: 0.698 },
    { n: 13, name: "Spoon", f: 0.779 }, { n: 14, name: "", f: 0.807 },
    { n: 15, name: "130R", f: 0.860 }, { n: 16, name: "Casio Triangle", f: 0.933 },
    { n: 17, name: "", f: 0.952 }, { n: 18, name: "", f: 0.969 },
  ],
  brazil: [
    { n: 1, name: "Senna S", f: 0.000 }, { n: 2, name: "", f: 0.160 },
    { n: 3, name: "Curva do Sol", f: 0.162 }, { n: 4, name: "Descida do Lago", f: 0.299 },
    { n: 5, name: "", f: 0.402 }, { n: 6, name: "Ferradura", f: 0.443 },
    { n: 7, name: "Laranja", f: 0.571 }, { n: 8, name: "Pinheirinho", f: 0.592 },
    { n: 9, name: "Bico de Pato", f: 0.621 }, { n: 10, name: "Mergulho", f: 0.662 },
    { n: 11, name: "Juncao", f: 0.710 }, { n: 12, name: "Subida dos Boxes", f: 0.753 },
    { n: 13, name: "", f: 0.776 }, { n: 14, name: "", f: 0.821 },
    { n: 15, name: "Arquibancadas", f: 0.885 },
  ],
};

// The official numbering + real-world names per circuit, in corner order. This is
// the half of the table that stays authoritative once a track's positions are
// measured from geometry; cornerAnchors.cornersFrom() reads names from here.
export const CORNER_NAMES = CORNERS_BY_TRACK;

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
