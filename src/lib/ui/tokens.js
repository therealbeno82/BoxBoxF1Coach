// ─── COCKPIT DESIGN TOKENS ─────────────────────────────────────────────────
// Single source of truth for the redesigned GUI's palette, fonts and a handful
// of shared style helpers. The handoff (F1 Coach Cockpit.dc.html) hardcodes hex
// throughout; centralising them here keeps the screen components DRY instead of
// re-typing colours in five files. index.html mirrors the structural subset as
// CSS variables for any leftover var()-based markup.
//
// Data-semantic colours (reference / driven / sectors / telemetry channels) are
// intentionally fixed — they must read the same in every context.

export const C = {
  // Surfaces
  bg:          "#0b0e14",  // app background
  bgRadial:    "radial-gradient(140% 100% at 80% -10%, #131a2b 0%, #0b0e14 55%)",
  surface:     "#11151d",  // primary card
  inset:       "#0d1119",  // nested tile / well / input
  modal:       "#0e121b",  // overlay cards
  elevated:    "#16243f",  // active / selected (blue-tinted)

  // Borders
  line:        "#1c2230",  // hairline card border
  borderInput: "#232a3a",
  borderStrong:"#2b3346",
  borderModal: "#262c3a",

  // Brand + accents
  blue:        "#3671C6",  // CTAs, active nav, car dot, accent bars
  purple:      "#b45bff",  // reference lap, gear, ideal lap, Coach
  cyan:        "#34c8ff",  // driven lap
  teal:        "#2dd4bf",  // speed metric
  yellow:      "#FFC400",  // best lap times, gains
  ersYellow:   "#FFD43B",  // ERS battery / used
  red:         "#ff4d5e",  // brake / alert / ERS mode
  liveRed:     "#e2483a",  // live session dot
  green:       "#2ED573",  // status dots, gains
  orange:      "#FF8A3D",  // throttle channel (coach log)

  // Text
  text:        "#ffffff",
  textHi:      "#e8ecf5",
  textBody:    "#d6dbe8",
  textBody2:   "#cfd6e6",
  textMid:     "#aeb6c6",
  textMuted:   "#8b94a8",
  textDim:     "#6b7488",
  textFaint:   "#5b6478",
  textFaintest:"#3a4252",
};

// Sector / matrix colours (purple = session best, green = gain, yellow = loss).
export const SECTOR_COLORS = ["#3671C6", "#b45bff", "#2ED573"]; // S1 / S2 / S3 tiles
export const GAIN = "#2ED573";
export const LOSS = "#FFC400";
export const BEST = "#b45bff";

// Driver livery swatches offered at sign-up (handoff signupColors).
export const LIVERY_COLORS = ["#3671C6", "#b45bff", "#2ED573", "#FFC400", "#ff4d5e", "#2dd4bf"];

export const FONT = {
  ui:   "'Archivo', system-ui, sans-serif",
  mono: "'JetBrains Mono', monospace",
  cond: "'Saira Condensed', sans-serif",
};

// ─── Shared style helpers ───────────────────────────────────────────────────
// Small objects spread into inline styles. Keep these minimal — screens compose
// them with their own layout props.

export const card = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 12,
  padding: "16px 18px",
};

export const inset = {
  background: C.inset,
  border: `1px solid ${C.line}`,
  borderRadius: 9,
};

// Uppercase letter-spaced eyebrow label used above most sections.
export const eyebrow = {
  fontSize: 10,
  letterSpacing: 2,
  color: C.textMuted,
  textTransform: "uppercase",
  fontWeight: 600,
};

// Monospace numeric readout base (size/weight/colour set by caller).
export const mono = { fontFamily: FONT.mono, fontWeight: 800 };

// 5×42 rounded accent bar that leads every screen's top-bar title.
export const accentBar = (color = C.blue, h = 42) => ({
  width: 5, height: h, borderRadius: 3, background: color, flex: "none",
});

// Status dot (optionally glowing / blinking).
export const dot = (color, { glow = true, blink = false } = {}) => ({
  width: 7, height: 7, borderRadius: "50%", background: color,
  boxShadow: glow ? `0 0 8px ${color}` : "none",
  animation: blink ? "blink 1.6s infinite" : "none",
});

// Delta colour: faster (negative) is good. Mirrors the handoff's dcol().
export const deltaColor = (v) =>
  v <= -0.10 ? C.purple : v < 0 ? C.green : v < 0.10 ? C.yellow : C.red;

// Format a signed delta in seconds, e.g. +0.198 / −0.005 (true minus sign).
export const fmtDelta = (v) =>
  (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(3);
