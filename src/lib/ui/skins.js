// ─── TEAM SKINS ─────────────────────────────────────────────────────────────
// Per-skin CSS custom-property maps + the Settings picker metadata. Selecting a
// skin swaps the active token map onto the document root (applySkin); every screen
// reads these through the var()-backed tokens in ./tokens.js, so the whole app
// recolours live with no per-component work.
//
// THEMES values are copied verbatim from the design handoff ("F1 Coach — Team Skin
// System"). `default` is an empty map: it clears every override so the :root
// defaults in index.html (the original dark-navy / blue palette) take over — this
// is the app's original look, kept as the "Default" skin.
//
// Data-semantic colours (sector purple/green/yellow, reference/driven cyan, delta
// green/yellow/purple/red, telemetry-channel colours) are NEVER skinned — they
// carry meaning and live as fixed literals in tokens.js.

export const THEMES = {
  default: {},

  // McLaren — warm anthracite base (graphite & papaya).
  anthra: {
    "--bg": "#16130f", "--glow": "#2a2115", "--surface": "#201b15", "--inset": "#181410", "--modal": "#1b1610", "--line": "#332a20",
    "--hero-border": "#4a3720", "--elevated": "#33240f", "--border-modal": "#3a3024",
    "--accent": "#FF8700", "--on-accent": "#120a02", "--accent-glow": "#FF870066", "--accent-1": "#FF8700", "--accent-2": "#47C7FC",
    "--accent-1f": "rgba(255,135,0,.14)", "--accent-33": "rgba(255,135,0,.22)", "--accent-0d": "rgba(255,135,0,.06)",
    "--accent-44": "rgba(255,135,0,.30)", "--accent-55": "rgba(255,135,0,.42)", "--pb-border": "#5a3810",
    "--mark": "#FF8700", "--num-italic": "italic", "--r-lg": "8px", "--r-md": "8px", "--r-sm": "6px",
    "--stat-1": "#FF8000", "--stat-2": "#47C7FC", "--stat-3": "#FFFFFF",
    "--mark-1": "#FF8000", "--mark-2": "#47C7FC", "--mark-3": "#FFFFFF",
    "--cat-1": "#47C7FC", "--cat-2": "#FFFFFF",
    "--tex-hero": "repeating-linear-gradient(45deg, rgba(255,190,120,.03) 0 3px, transparent 3px 6px), repeating-linear-gradient(-45deg, rgba(255,190,120,.025) 0 3px, transparent 3px 6px)",
  },

  // Scuderia Ferrari 2022 livery — A6051A red / FFEB00 yellow / FFFFFF white / 111111 black.
  ferrari: {
    "--bg": "#0b0909", "--glow": "#280709", "--surface": "#171313", "--inset": "#100c0c", "--modal": "#130f0f", "--line": "#2a1c1c",
    "--hero-border": "#4a1015", "--elevated": "#240a0d", "--border-modal": "#281c1c",
    "--accent": "#A6051A", "--on-accent": "#ffffff", "--accent-glow": "#A6051A66", "--accent-1": "#A6051A", "--accent-2": "#FFEB00",
    "--accent-1f": "rgba(166,5,26,.14)", "--accent-33": "rgba(166,5,26,.22)", "--accent-0d": "rgba(166,5,26,.06)",
    "--accent-44": "rgba(166,5,26,.32)", "--accent-55": "rgba(166,5,26,.45)", "--pb-border": "#4a0f14",
    "--mark": "#A6051A", "--num-italic": "italic", "--r-lg": "8px", "--r-md": "8px", "--r-sm": "6px",
    "--stat-1": "#A6051A", "--stat-2": "#FFEB00", "--stat-3": "#FFFFFF",
    "--mark-1": "#A6051A", "--mark-2": "#FFEB00", "--mark-3": "#FFFFFF",
    "--badge-bg": "#FFEB00", "--badge-fg": "#111111", "--team-swatch": "#FFEB00", "--cat-1": "#A6051A", "--cat-2": "#FFEB00",
    "--tex-hero": "repeating-linear-gradient(45deg, rgba(255,235,0,.03) 0 3px, transparent 3px 6px), repeating-linear-gradient(-45deg, rgba(166,5,26,.05) 0 3px, transparent 3px 6px)",
  },

  // Mercedes-AMG Petronas 2022 livery — 00A19C teal / 80142B red / C6C6C6 silver / 111111 black.
  mercedes: {
    "--bg": "#0a0c0d", "--glow": "#08221f", "--surface": "#121617", "--inset": "#0c1011", "--modal": "#0f1314", "--line": "#242c2c",
    "--hero-border": "#0f4a44", "--elevated": "#0a2624", "--border-modal": "#222a2a",
    "--accent": "#00A19C", "--on-accent": "#042220", "--accent-glow": "#00A19C66", "--accent-1": "#00A19C", "--accent-2": "#C6C6C6",
    "--accent-1f": "rgba(0,161,156,.14)", "--accent-33": "rgba(0,161,156,.22)", "--accent-0d": "rgba(0,161,156,.06)",
    "--accent-44": "rgba(0,161,156,.32)", "--accent-55": "rgba(0,161,156,.45)", "--pb-border": "#0f4038",
    "--mark": "#00A19C", "--num-italic": "normal", "--r-lg": "8px", "--r-md": "8px", "--r-sm": "6px",
    "--stat-1": "#00A19C", "--stat-2": "#C6C6C6", "--stat-3": "#80142B",
    "--mark-1": "#00A19C", "--mark-2": "#C6C6C6", "--mark-3": "#80142B",
    "--badge-bg": "#C6C6C6", "--badge-fg": "#111111", "--team-swatch": "#00A19C", "--cat-1": "#80142B", "--cat-2": "#C6C6C6",
    "--tex-hero": "repeating-linear-gradient(45deg, rgba(198,198,198,.03) 0 3px, transparent 3px 6px), repeating-linear-gradient(-45deg, rgba(0,161,156,.05) 0 3px, transparent 3px 6px)",
  },

  // Oracle Red Bull Racing 2022 (RB18) — 121F45 navy / 223971 blue / CC1E4A red / FFC906 yellow.
  redbull: {
    "--bg": "#0b1330", "--glow": "#1b2c60", "--surface": "#141f47", "--inset": "#0e1838", "--modal": "#111a3f", "--line": "#263468",
    "--hero-border": "#33468a", "--elevated": "#1c2c60", "--border-modal": "#26346a",
    "--accent": "#CC1E4A", "--on-accent": "#ffffff", "--accent-glow": "#CC1E4A66", "--accent-1": "#CC1E4A", "--accent-2": "#FFC906",
    "--accent-1f": "rgba(204,30,74,.14)", "--accent-33": "rgba(204,30,74,.22)", "--accent-0d": "rgba(204,30,74,.06)",
    "--accent-44": "rgba(204,30,74,.32)", "--accent-55": "rgba(204,30,74,.45)", "--pb-border": "#47203a",
    "--mark": "#CC1E4A", "--num-italic": "italic", "--r-lg": "8px", "--r-md": "8px", "--r-sm": "6px",
    "--stat-1": "#CC1E4A", "--stat-2": "#FFC906", "--stat-3": "#6E8AE0",
    "--mark-1": "#223971", "--mark-2": "#CC1E4A", "--mark-3": "#FFC906",
    "--badge-bg": "#FFC906", "--badge-fg": "#111111", "--team-swatch": "#FFC906",
    "--cat-1": "#CC1E4A", "--cat-2": "#FFC906",
    "--cta-bg": "#223971", "--cta-fg": "#FFC906", "--cta-border": "none",
    "--logo-fg": "#FFC906", "--logo-box-bg": "#223971", "--logo-glow": "#CC1E4A99",
    "--tex-hero": "repeating-linear-gradient(45deg, rgba(255,201,6,.028) 0 3px, transparent 3px 6px), repeating-linear-gradient(-45deg, rgba(204,30,74,.05) 0 3px, transparent 3px 6px)",
  },
};

// Ordered list for the Settings picker. `chips` are the two preview swatches shown
// on each row (accent + a defining second colour). `descriptor` is the mono subline.
export const SKINS = [
  { id: "default",  name: "Default · Cockpit",     descriptor: "Dark · blue accent",       chips: ["#3671C6", "#0b0e14"] },
  { id: "anthra",   name: "McLaren · Anthracite",   descriptor: "Papaya · graphite",         chips: ["#FF8700", "#201b15"] },
  { id: "ferrari",  name: "Ferrari · Rosso",        descriptor: "Red · carbon · italic",     chips: ["#A6051A", "#FFEB00"] },
  { id: "mercedes", name: "Mercedes · Petronas",    descriptor: "Teal · silver · upright",   chips: ["#00A19C", "#C6C6C6"] },
  { id: "redbull",  name: "Red Bull · Racing",      descriptor: "Navy · red · yellow",       chips: ["#223971", "#CC1E4A"] },
];

export const SKIN_IDS = SKINS.map((s) => s.id);
export const DEFAULT_SKIN = "default";
export const isSkin = (id) => SKIN_IDS.includes(id);

// Every custom property any theme can set — cleared before applying a new skin so a
// sparse skin (e.g. default, or McLaren without the team --stat-*/--badge-* tokens)
// never inherits a richer skin's leftovers. Mirrors the handoff's applySkin routine.
const ALL_TOKENS = [...new Set(Object.values(THEMES).flatMap((t) => Object.keys(t)))];

// Swap the active skin's token map onto `root` (the <html> element by default).
// Removing all tokens first, then setting the current map, means switching to a
// sparser skin fully reverts to the index.html :root defaults for unset tokens.
export function applySkin(skinId, root = document.documentElement) {
  if (!root) return;
  const theme = THEMES[isSkin(skinId) ? skinId : DEFAULT_SKIN] || {};
  // Fade the recolour: index.html defines the colour transition under
  // `html.reskin` only, so live data-driven colour changes (deltas, gauges,
  // telemetry readouts) stay instant — the class is on solely for the swap.
  root.classList.add("reskin");
  for (const k of ALL_TOKENS) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(theme)) root.style.setProperty(k, v);
  clearTimeout(applySkin._fade);
  applySkin._fade = setTimeout(() => root.classList.remove("reskin"), 240);
}
