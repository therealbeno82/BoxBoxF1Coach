// ─── CUE CATEGORIES ──────────────────────────────────────────────────────────
// The coachable categories, as chips: [swatch colour, label, GRANULAR key].
// Each chip is an independent on/off toggle controlling both the map colour AND
// whether that category's voice cue fires — toggle one off and that skill goes
// dark on the map and silent over the headset. "normal" (None) toggles whether
// un-cued track segments are drawn AND gates the ERS-off "None" cue (ersMode 0
// maps to this key — see legendKeyFor in BoxBoxApp).
//
// Shared rather than private to the Live screen because the game overlay shows
// the same seven toggles: the overlay is a different webview with no access to
// BoxBoxApp's tree, and a second hand-written copy of this list would drift the
// moment a category was added — leaving a chip on the HUD that gates nothing, or
// a cue with no way to mute it.
export const LIVE_LEGEND = [
  ["#ff5252", "Brake",  "brake"],
  ["#ffab00", "LiCo",   "lico"],
  ["#ffd54f", "Lift",   "lift"],
  ["#888888", "Medium", "ers1"],  // 6-digit so the chip's `color + "66"` alpha border is valid
  ["#e040fb", "Hotlap", "ers2"],
  ["#2979ff", "Boost",  "ers3"],
  ["#6b7280", "None",   "normal"], // visible neutral grey (was near-black #1e1e1e)
];
