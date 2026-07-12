// ─── COCKPIT DESIGN TOKENS ─────────────────────────────────────────────────
// Single source of truth for the redesigned GUI's palette, fonts and a handful
// of shared style helpers. The handoff (F1 Coach Cockpit.dc.html) hardcodes hex
// throughout; centralising them here keeps the screen components DRY instead of
// re-typing colours in five files. index.html mirrors the structural subset as
// CSS variables for any leftover var()-based markup.
//
// ── Team skins ──────────────────────────────────────────────────────────────
// The *skinnable* tokens below resolve to `var(--token, <default hex>)` rather
// than a literal. The fallback keeps today's look when no skin is applied; when a
// team skin sets those custom properties on <html> (see ./skins.js applySkin),
// every screen that reads C recolours live — no per-component edits. The brand
// blue maps to `--accent`, so nav pills / CTAs / accent bars follow the skin.
//
// Data-semantic colours (reference / driven / sectors / delta / telemetry
// channels) are intentionally FIXED literals — they must read the same in every
// context and must never be reskinned.

export const C = {
  // Surfaces (skinnable)
  bg:          "var(--bg, #0b0e14)",  // app background
  bgRadial:    "radial-gradient(140% 100% at 80% -10%, var(--glow, #131a2b) 0%, var(--bg, #0b0e14) 55%)",
  surface:     "var(--surface, #11151d)",  // primary card
  inset:       "var(--inset, #0d1119)",  // nested tile / well / input
  modal:       "var(--modal, #0e121b)",  // overlay cards
  elevated:    "var(--elevated, #16243f)",  // active / selected (accent-tinted)

  // Borders (skinnable)
  line:        "var(--line, #1c2230)",  // hairline card border
  borderInput: "var(--border-input, #232a3a)",
  borderStrong:"var(--border-strong, #2b3346)",
  borderModal: "var(--border-modal, #262c3a)",

  // Brand accent (skinnable) — CTAs, active nav, accent bars. `blue` is the legacy
  // name kept so existing references pick up the skin automatically; `accent` is a
  // clearer alias for new code.
  blue:        "var(--accent, #3671C6)",
  accent:      "var(--accent, #3671C6)",
  onAccent:    "var(--on-accent, #ffffff)",
  // Accent at fixed alphas — reuse these instead of concatenating a hex suffix
  // onto `blue` (which is now a var() string and can't take a `${blue}44` alpha).
  accentGlow:  "var(--accent-glow, rgba(54,113,198,.33))",
  accent0d:    "var(--accent-0d, rgba(54,113,198,.05))",
  accent1f:    "var(--accent-1f, rgba(54,113,198,.12))",
  accent33:    "var(--accent-33, rgba(54,113,198,.20))",
  accent44:    "var(--accent-44, rgba(54,113,198,.27))",
  accent55:    "var(--accent-55, rgba(54,113,198,.33))",
  // Skin-tinted decorative dots (voice-engine picker). accent1/accent2 are the skin's
  // primary + secondary brand colours (e.g. Ferrari red/yellow, Mercedes teal/silver).
  // Deliberately NOT the global --accent so the Default skin (which sets no --accent-1/2)
  // falls back to the original purple/cyan pair.
  accent1:     "var(--accent-1, #b45bff)",
  accent2:     "var(--accent-2, #34c8ff)",

  // Data-semantic accents (FIXED — never skinned)
  purple:      "#b45bff",  // reference lap, gear, ideal lap, Coach
  cyan:        "#34c8ff",  // driven lap
  teal:        "#2dd4bf",  // speed metric
  yellow:      "#FFC400",  // best lap times, gains
  ersYellow:   "#FFD43B",  // ERS battery / used
  red:         "#ff4d5e",  // brake / alert / ERS mode
  liveRed:     "#e2483a",  // live session dot
  green:       "#2ED573",  // status dots, gains
  orange:      "#FF8A3D",  // throttle channel (coach log)

  // Text (FIXED — neutral text tones read the same across every skin)
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
