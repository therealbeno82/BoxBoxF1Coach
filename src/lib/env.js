// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────
// True only inside the Tauri webview. In a plain browser (`npm run dev`) there
// is no IPC, so callers skip `invoke`/`listen` rather than throw. Single source
// of truth — do not re-declare this probe per file.
export const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

// True in the Android build only. A BUILD-TIME constant (vite.config.js reads
// Tauri's TAURI_ENV_PLATFORM), not a runtime user-agent sniff — so Rollup folds
// the branches and the excluded screens' code can be dropped rather than shipped
// unreachable. Android deliberately leaves out three desktop-only things:
//   • FFB      — drives a wheel over SDL2; no Android counterpart, and the Rust
//                side is already cfg'd out, so the panel would only ever say
//                "WAITING…" at you.
//   • OpenRouter LLM — the between-lap analyst. The deterministic rule-engine
//                coach STAYS; only the cloud call and its API-key UI go.
//   • Trace Calibrator — a mouse-only drag/resize tool (raw onMouseDown, thin
//                edge hit-areas); unusable by touch and not worth porting.
export const isAndroid = __IS_ANDROID__;

// Opens an external URL in the OS browser. Inside the Tauri shell a plain anchor
// does NOT escape the webview — it would navigate the app window away from the
// app — so the click is intercepted and handed to the opener plugin; in a plain
// browser (`npm run dev`) the anchor is left to open a normal new tab.
// Lives here rather than in a screen because it IS the webview boundary, the
// same concern `inTauri` above answers, and three call sites now need it.
export const openExternal = (url) => async (e) => {
  if (!inTauri) return;
  e.preventDefault();
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  openUrl(url);
};

// The donation link. One constant because two chromes point at it: the
// Dashboard's card on desktop, and the nav's Donate entry on a phone, where the
// card's row is too expensive to keep.
export const KOFI_URL = "https://ko-fi.com/rapidbeno";
